"""Real HTTP handler and snapshot, isolated in a subprocess with a fake home."""
from contextlib import ExitStack
from html.parser import HTMLParser
import http.client
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch


ACCESS = "sk-ant-oat01-FAKEFAKE"
REFRESH = "sk-ant-ort01-FAKEREFRESH"


def serve_fixture():
    # The parent provides all four overrides BEFORE this process imports office.
    from office import config, seats, server, snapshot

    config.ensure_dirs()
    root = config.HOME / ".claude2"
    root.mkdir(parents=True)
    (root / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {
        "accessToken": ACCESS, "refreshToken": REFRESH, "expiresAt": 4102444800000,
        "subscriptionType": "max", "rateLimitTier": "default_claude_max_5x"}}))
    (root / ".claude.json").write_text(json.dumps({"oauthAccount": {
        "emailAddress": "fake@example.invalid", "displayName": "Fake account"}}))
    canned = {"data": {"five_hour": {"pct": 12, "resets_at": 4102444800},
                       "weekly": {"pct": 23, "resets_at": 4102444800}, "scoped": []}}
    with ExitStack() as stack:
        fetch = stack.enter_context(patch.object(seats.UsagePoller, "_fetch", return_value=canned))
        stack.enter_context(patch.object(snapshot, "list_units", return_value=[]))
        stack.enter_context(patch("subprocess.run", side_effect=AssertionError("No systemd or commands")))
        stack.enter_context(patch("subprocess.Popen", side_effect=AssertionError("No child agents")))
        stack.enter_context(patch("urllib.request.urlopen", side_effect=AssertionError("No network usage calls")))
        stack.enter_context(patch.object(snapshot, "read_codex_seat",
                                        side_effect=AssertionError("No real Codex home reads")))
        office = snapshot.Office()
        office.usage.tick()
        office.build()
        fetch.assert_called_once()
        assert office.codex_meta is None
        assert office.get()["seats"][0]["config_dir"] == str(root)

        class TestHandler(server.Handler):
            pass

        TestHandler.office = office
        TestHandler.token = config.api_token()
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        httpd.daemon_threads = True
        TestHandler.port = httpd.server_port
        thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": .05})
        thread.start()
        try:
            print(json.dumps({"port": httpd.server_port, "token": TestHandler.token}), flush=True)
            sys.stdin.read()  # Parent closes stdin to shut down; no background poller needed.
        finally:
            office.stop.set()
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)


class MetaParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta":
            self.meta[attrs.get("name")] = attrs.get("content")


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temp.cleanup)
        cls.root = Path(temp.name)
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        for key, name in (("CLAUDE_OFFICE_HOME", "home"), ("CLAUDE_OFFICE_CONFIG", "config"),
                          ("CLAUDE_OFFICE_STATE", "state"), ("CLAUDE_OFFICE_DATA", "data")):
            env[key] = str(cls.root / name)
        repo = Path(__file__).resolve().parents[1]
        env["PYTHONPATH"] = str(repo)
        child = cls.child = subprocess.Popen([sys.executable, "-B", str(Path(__file__).resolve()),
                                              "--serve-fixture"], cwd=repo, env=env,
                                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                             stderr=subprocess.PIPE, text=True)

        def cleanup():
            child.stdin.close()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
            finally:
                child.stdout.close()
                child.stderr.close()
        cls.addClassCleanup(cleanup)
        ready = queue.Queue()
        reader = threading.Thread(target=lambda: ready.put(child.stdout.readline()), daemon=True)
        reader.start()
        try:
            line = ready.get(timeout=15)
        except queue.Empty:
            raise AssertionError("HTTP fixture did not start within 15 seconds")
        if not line:
            raise AssertionError("HTTP fixture failed: " + child.stderr.read())
        info = json.loads(line)
        cls.port, cls.token = info["port"], info["token"]

    def request(self, method="GET", path="/api/state", headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def post(self, headers=None, body="{}", path="/api/divider/preview"):
        base = {"Content-Type": "application/json", "X-Office-Token": self.token}
        if headers:
            base.update(headers)
        return self.request("POST", path, base, body)

    def test_non_loopback_host_is_forbidden(self):
        for host in ("attacker.example", f"attacker.example:{self.port}",
                     f"127.0.0.1.attacker.example:{self.port}", "127.0.0.1:1"):
            with self.subTest(host=host):
                self.assertEqual(self.request(headers={"Host": host})[0], 403)

    def test_loopback_host_gets_real_snapshot_with_canned_usage(self):
        status, headers, body = self.request(headers={"Host": f"127.0.0.1:{self.port}"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json")
        state = json.loads(body)
        self.assertEqual(len(state["seats"]), 1)
        seat = state["seats"][0]
        self.assertEqual(seat["id"], "claude2")
        self.assertEqual(seat["health"]["state"], "ok")
        self.assertEqual(seat["account"]["email"], "fake@example.invalid")
        self.assertEqual(seat["usage"]["five_hour"]["pct"], 12)
        self.assertEqual(seat["usage"]["weekly"]["pct"], 23)

    def test_full_state_never_contains_credential_values_or_keys(self):
        status, _, body = self.request()
        self.assertEqual(status, 200)
        for forbidden in (ACCESS, REFRESH, "accessToken", "refreshToken"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden.encode(), body)

    def test_post_without_token_is_forbidden(self):
        status, _, _ = self.request("POST", "/api/divider/preview",
                                    {"Content-Type": "application/json"}, "{}")
        self.assertEqual(status, 403)

    def test_post_with_wrong_token_is_forbidden(self):
        self.assertEqual(self.post({"X-Office-Token": "wrong-token"})[0], 403)

    def test_foreign_origin_is_forbidden_even_with_valid_token(self):
        for origin in ("https://attacker.example", "null", "http://localhost:1"):
            with self.subTest(origin=origin):
                self.assertEqual(self.post({"Origin": origin})[0], 403)
                self.assertEqual(self.request(headers={"Origin": origin})[0], 403)

    def test_valid_token_requires_json_content_type(self):
        for content_type in ("text/plain", "application/x-www-form-urlencoded", ""):
            with self.subTest(content_type=content_type):
                self.assertEqual(self.post({"Content-Type": content_type})[0], 415)

    def test_valid_same_origin_post_works(self):
        status, _, body = self.post({"Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])
        self.assertEqual(json.loads(body)["next_pick"]["seat"], "claude2")

    def test_malformed_or_non_object_json_is_rejected(self):
        for body in ("{", "[]", "null", '"string"'):
            with self.subTest(body=body):
                status, _, data = self.post(body=body)
                self.assertEqual(status, 400)
                self.assertIn("error", json.loads(data))

    def test_static_traversal_is_not_found(self):
        for path in ("/static/../office/config.py", "/static/%2e%2e/office/config.py"):
            with self.subTest(path=path):
                # http.client sends the literal path; no client-side dot-segment normalization.
                status, _, body = self.request(path=path)
                self.assertEqual(status, 404)
                self.assertNotIn(b"CLAUDE_OFFICE_HOME", body)
        self.assertEqual(self.request(path="/static/app.js")[0], 200)

    def test_lane_id_traversal_does_not_read_outside_lanes(self):
        for value in ("../outside", "%2e%2e%2foutside", "%2Fetc%2Fpasswd"):
            with self.subTest(value=value):
                status, _, body = self.request(path="/api/lane?id=" + value)
                self.assertEqual(status, 400)
                self.assertEqual(json.loads(body)["error"], "No such lane")

    def test_index_injects_token_and_security_headers(self):
        status, headers, body = self.request(path="/")
        self.assertEqual(status, 200)
        parser = MetaParser()
        parser.feed(body.decode())
        self.assertEqual(parser.meta["office-token"], self.token)
        self.assertEqual(parser.meta["office-demo"], "0")
        self.assertNotIn(b"{{TOKEN}}", body)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_usage_cache_contains_no_credentials(self):
        body = (self.root / "state/usage-cache.json").read_text()
        for forbidden in (ACCESS, REFRESH, "accessToken", "refreshToken"):
            self.assertNotIn(forbidden, body)


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve-fixture"]:
        serve_fixture()
    else:
        unittest.main()

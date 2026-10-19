import copy
import http.client
import json
import socket
import threading
import time
import unittest
from unittest.mock import patch

from office.demo import DemoOffice
from office.server import Handler, ThreadingHTTPServer


class StreamTests(unittest.TestCase):
    def setUp(self):
        self.office = DemoOffice()
        self.office.build()
        class TestHandler(Handler):
            pass
        self.handler = TestHandler
        TestHandler.office, TestHandler.token, TestHandler.demo = self.office, "demo", True
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        TestHandler.port = self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        self.thread.start()
        self.connections = []
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for conn, response in self.connections:
            response.close()
            conn.close()
        self.office.stop.set()
        with self.office.condition:
            self.office.condition.notify_all()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def open(self, path="/api/stream", headers=None, method="GET", body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request(method, path, headers=headers or {}, body=body)
        response = conn.getresponse()
        self.connections.append((conn, response))
        return response

    def event(self, response):
        kind = response.fp.readline().decode().strip()
        data = response.fp.readline().decode().strip()
        self.assertEqual(response.fp.readline(), b"\n")
        return kind, json.loads(data.removeprefix("data: "))

    def wait_slots(self, expected):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            with self.office.condition:
                if len(self.office._streams) == expected:
                    return
            time.sleep(.02)
        self.fail(f"Expected {expected} streams, got {len(self.office._streams)}")

    def test_first_state_headers_redaction_and_now_only_dedup(self):
        state = copy.deepcopy(self.office.get())
        secret = "sk-ant-" + "x" * 30
        state["seats"][0]["label"] = secret
        state["accessToken"] = "do-not-show"
        self.office.publish(state)
        response = self.open()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "text/event-stream")
        self.assertEqual(response.getheader("Cache-Control"), "no-store")
        self.assertEqual(response.getheader("X-Accel-Buffering"), "no")
        self.assertIsNone(response.getheader("Content-Length"))
        kind, data = self.event(response)
        self.assertEqual(kind, "event: state")
        self.assertNotIn(secret, json.dumps(data))
        self.assertNotIn("accessToken", data)
        old_hash = self.office._state_hash
        state["now"] += 4
        self.office.publish(state)
        self.assertEqual(old_hash, self.office._state_hash)
        # News arrives before any redundant state event, even after the state throttle period.
        time.sleep(1.55)
        self.office.emit("report", "Finished", "claude2", "good")
        kind, data = self.event(response)
        self.assertEqual(kind, "event: news")
        self.assertEqual(data["kind"], "report")

    def test_changed_state_is_throttled_and_latest_wins_news_is_immediate(self):
        response = self.open()
        self.event(response)
        start = time.monotonic()
        state = copy.deepcopy(self.office.get())
        state["office"]["name"] = "First"
        self.office.publish(state)
        state["office"]["name"] = "Latest"
        self.office.publish(state)
        self.office.emit("report", "Finished", "claude2", "good")
        kind, news = self.event(response)
        self.assertEqual(kind, "event: news")
        self.assertLess(time.monotonic() - start, 1)
        kind, data = self.event(response)
        self.assertEqual(kind, "event: state")
        self.assertEqual(data["office"]["name"], "Latest")
        self.assertGreaterEqual(time.monotonic() - start, 1.4)
        self.assertEqual(self.open("/api/state").status, 200)

    def test_eight_slots_ninth_503_and_disconnect_releases_slot(self):
        responses = [self.open() for _ in range(8)]
        for response in responses:
            self.assertEqual(response.status, 200)
            self.event(response)
        denied = self.open()
        self.assertEqual(denied.status, 503)
        self.assertIn("error", json.loads(denied.read()))
        responses[0].close()
        self.wait_slots(7)
        replacement = self.open()
        self.assertEqual(replacement.status, 200)
        self.event(replacement)
        self.wait_slots(8)

    def test_reset_connection_releases_slot(self):
        import struct
        response = self.open()
        self.event(response)
        sock = response.fp.raw._sock
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        response.close()
        self.office.emit("report", "Finished")
        self.wait_slots(0)

    def test_host_and_origin_checks_cover_all_new_gets(self):
        for path in ("/api/stream", "/api/history", "/api/stats", "/api/settings", "/api/week", "/api/tokens", "/api/status.txt"):
            for header in ({"Host": "attacker.example"}, {"Origin": "http://attacker.example"}):
                self.assertEqual(self.open(path, header).status, 403)
        self.wait_slots(0)

    def test_history_stats_settings_contract_queries_and_demo_post(self):
        for path, keys in (("/api/history", {"now", "from", "step", "seats", "sessions", "markers"}),
                           ("/api/stats", {"day", "seats", "office", "mvp", "digest"}),
                           ("/api/settings", {"office_name", "ceo_name", "seats", "voice", "voice_available"})):
            response = self.open(path)
            self.assertEqual(response.status, 200)
            self.assertLessEqual(keys, json.loads(response.read()).keys())
        for path in ("/api/history?hours=0", "/api/history?hours=25", "/api/history?hours=no", "/api/history?hours=1.5", "/api/stats?day=no",
                     "/api/week?days=0", "/api/week?days=91", "/api/week?days=-1", "/api/week?days=1.5", "/api/week?days=x",
                     "/api/week?days=%C2%B2", "/api/week?days=%EF%BC%97", "/api/week?days=%D9%A3", "/api/history?hours=%EF%BC%96"):
            response = self.open(path)
            self.assertEqual(response.status, 400, path)
            self.assertRegex(json.loads(response.read())["error"], r"must be an integer from 1 to (24|90)|day must be YYYY-MM-DD")
        week = json.loads(self.open("/api/week?days=14").read())["days"]
        self.assertEqual(len(week), 14)
        self.assertEqual(set(week[0]), {"day", "reports", "sessions", "active_min", "tool_calls", "limits", "lanes_hired", "mvp", "limited_min", "avail_min", "busy_min", "all_out_min"})
        self.assertEqual(week, sorted(week, key=lambda d: d["day"]))
        self.assertGreater(sum(d["reports"] for d in week[:-1]), 0)   # the demo carries made-up earlier days
        headers = {"Content-Type": "application/json"}
        self.assertEqual(self.open("/api/settings", headers, "POST", "{}").status, 403)
        headers["X-Office-Token"] = "demo"
        before = copy.deepcopy(self.office.cfg)
        with patch("office.settings.save", side_effect=AssertionError("Demo must not write")):
            response = self.open("/api/settings", headers, "POST", '{"office_name":"Changed"}')
            self.assertEqual(json.loads(response.read()), {"ok": True, "demo": True})
        self.assertEqual(before, self.office.cfg)

    def test_idle_ping(self):
        # Only the handler's clock is accelerated; the actual Condition/socket remain real.
        import office.server as server
        real_monotonic = time.monotonic
        clock = type("Clock", (), {"monotonic": staticmethod(lambda: real_monotonic() * 100)})
        with patch.object(server, "time", clock):
            response = self.open()
            self.event(response)
            self.assertEqual(response.fp.readline(), b": ping\n")
            self.assertEqual(response.fp.readline(), b"\n")

    def test_demo_build_publishes_and_never_announces(self):
        before = self.office.get()["office"]["started_at"]
        with patch("office.voice.Announcer.announce", side_effect=AssertionError("No voice in demo")):
            self.office.emit("report", "Demo report")
            self.office.build()
        self.assertEqual(self.office.get()["office"]["started_at"], before)
        self.assertEqual(self.office.get()["office"]["version"], "3.136.0")


class StatusLineTests(unittest.TestCase):
    def test_one_line_for_a_status_bar(self):
        from office.server import status_line
        snap = {"attention": [{"seat": "a"}], "seats": [
            {"id": "a", "label": "claude", "status": "working", "tokens_1h_all": 2_500_000, "usage": {"five_hour": {"pct": 60}, "weekly": {"pct": 20}},
             "sessions": [{"state": "working"}, {"state": "idle"}]},
            {"id": "b", "label": "claude2", "status": "benched", "usage": {"five_hour": {"pct": 99}}, "sessions": []}]}
        self.assertEqual(status_line(snap), "⚙ 1 working · ⚠ 1 needs you · 🔥 2.5M/h · ▁ claude 40% left")
        self.assertEqual(status_line(snap, "plain"), "work 1 working · ! 1 needs you · burn 2.5M/h · low claude 40% left")
        self.assertEqual(status_line({"seats": []}), "⚙ 0 working")


class LoginExpiryTests(unittest.TestCase):
    def test_a_login_lapsing_within_three_days_needs_you(self):
        from office.snapshot import Office
        now = 1_000_000.0
        seat = lambda sid, left: {"id": sid, "label": sid, "status": "idle", "sessions": [], "lanes": 0, "usage": {}, "forecast": {},
                                  "health": {"state": "ok", "refresh_expires_at": now + left if left else None}}
        snap = {"now": now, "lanes": [], "units": [], "seats": [seat("a", 20 * 86400), seat("b", 2.5 * 86400), seat("c", 6 * 3600), seat("d", None)]}
        items = {i["seat"]: i for i in Office._attention(snap) if "login" in i["text"]}
        self.assertEqual(set(items), {"b", "c"})
        self.assertEqual(items["b"]["level"], "warn")
        self.assertIn("lapses in 2 days", items["b"]["text"])
        self.assertIn("lapses in 6 hours", items["c"]["text"])
        self.assertEqual(items["c"]["level"], "bad")
        self.assertEqual(items["c"]["lapses_at"], now + 6 * 3600)
        self.assertNotIn("resets_at", items["c"])                    # a lapse is not a usage reset
        for left, words in ((1000, "17 min"), (20, "1 min"), (3600, "1 hour"), (5000, "1 hour"), (5500, "2 hours")):
            snap["seats"] = [seat("e", left)]
            self.assertIn(f"lapses in {words}:", Office._attention(snap)[0]["text"])

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from office import codex_seat as codex


class CodexSeatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / ".codex"
        self.sessions = self.root / "sessions/2026/10/16"
        self.sessions.mkdir(parents=True)
        self.now = 1792180000.0
        codex._CACHE.clear()
        mock = patch.object(codex, "_scan_processes", return_value=[])
        self.processes = mock.start()
        self.addCleanup(mock.stop)

    def record(self, kind, payload, timestamp=None):
        return {"type": kind, "payload": payload,
                "timestamp": self.now if timestamp is None else timestamp}

    def rollout(self, name="one", records=None, age=0):
        path = self.sessions / f"rollout-{name}.jsonl"
        if records is None:
            records = [self.record("session_meta", {"id": name, "cwd": "/work"})]
        path.write_text("".join(json.dumps(record) + "\n" for record in records))
        os.utime(path, (self.now - age, self.now - age))
        return path

    def read(self, **kwargs):
        return codex.read_codex_seat(str(self.home), self.now, **kwargs)

    def rate(self, pct, timestamp=None):
        return self.record("event_msg", {"type": "token_count", "rate_limits": {
            "primary": {"used_percent": pct, "resets_at": self.now + 50, "window_minutes": 300},
            "secondary": {"used_percent": 16, "window_minutes": 10080, "resets_at": None}}}, timestamp)

    def live(self, path, pid=123):
        return {"pid": pid, "ppid": 1, "unit": "codex.scope", "rollouts": [str(path)]}

    def test_missing_home(self):
        seat = codex.read_codex_seat(str(self.home / "missing"), self.now)
        self.assertEqual(seat, {"id": "astra", "kind": "codex", "available": False,
                               "model": None, "usage": None, "sessions": []})

    def test_newest_rate_limit_and_config(self):
        (self.root / "config.toml").write_text('model = "gpt-example" # comment\n[profiles.other]\nmodel="wrong"\n')
        self.rollout("old", [self.rate(90)], age=10)
        self.rollout("new", [self.rate(10, self.now - 2), self.rate(20, self.now - 1)])
        seat = self.read()
        self.assertEqual(seat["model"], "gpt-example")
        self.assertEqual(seat["usage"], {"five_hour": {"pct": 20.0, "resets_at": self.now + 50,
                                                      "window_min": 300},
                                          "weekly": {"pct": 16.0, "resets_at": None, "window_min": 10080},
                                          "observed_at": self.now - 1})

    def test_first_real_task_and_function_activity(self):
        records = [self.record("response_item", {"type": "message", "role": role,
                    "content": [{"type": "input_text", "text": text}]}) for role, text in (
                        ("developer", "Do not show this"), ("system", "System"),
                        ("user", "<environment_context>private</environment_context>"),
                        ("user", "# AGENTS.md instructions for /work\nInstructions"),
                        ("user", "Fix the parser " + "x" * 400), ("user", "Followup"))]
        records.append(self.record("response_item", {"type": "function_call", "name": "exec_command",
                                                     "arguments": json.dumps({"cmd": "pytest -q"})}))
        self.rollout(records=records)
        session = self.read()["sessions"][0]
        self.assertEqual(session["task"], ("Fix the parser " + "x" * 400)[:300])
        self.assertEqual(session["activity"], "Running: pytest -q")

    def test_live_idle_done_and_old_open_file(self):
        done = self.rollout("done", [self.record("event_msg", {"type": "task_complete", "last_agent_message": "Done"})])
        live = self.rollout("live", [self.record("event_msg", {"type": "task_complete"})], age=1)
        idle = self.rollout("idle", [self.record("session_meta", {"id": "idle"}, self.now - 120)], age=90000)
        outside = self.home / "rollout-outside.jsonl"
        outside.write_text("{}\n")
        self.processes.return_value = [self.live(live), self.live(idle, 456), self.live(outside, 789)]
        sessions = self.read()["sessions"]
        self.assertEqual([s["state"] for s in sessions], ["working", "idle", "done"])
        self.assertEqual(sessions[0]["pid"], 123)
        self.assertEqual(sessions[0]["unit"], "codex.scope")
        self.assertEqual(sessions[2]["rollout"], str(done))
        self.processes.return_value = []
        self.assertTrue(all(s["state"] == "done" for s in self.read()["sessions"]))

    def test_incremental_and_unchanged_cache(self):
        path = self.rollout()
        with patch.object(codex, "_record", wraps=codex._record) as records:
            first = self.read()
            self.assertEqual(records.call_count, 1)
            first["sessions"][0]["tokens"]["total"] = 999
            self.assertEqual(self.read()["sessions"][0]["tokens"]["total"], 0)
            self.assertEqual(records.call_count, 1)
            old_size = path.stat().st_size
            with path.open("a") as stream:
                stream.write(json.dumps(self.record("response_item", {"type": "reasoning"})) + "\n")
            # Verify the actual file read starts at the previously consumed byte.
            original_open = Path.open
            positions = []
            class Reader:
                def __init__(self, stream): self.stream = stream
                def __enter__(self): return self
                def __exit__(self, *args): self.stream.close()
                def seek(self, offset): positions.append(offset); return self.stream.seek(offset)
                def read(self, size): return self.stream.read(size)
            def tracked_open(candidate, *args, **kwargs):
                stream = original_open(candidate, *args, **kwargs)
                return Reader(stream) if candidate == path and args == ("rb",) else stream
            with patch.object(Path, "open", tracked_open):
                self.assertEqual(self.read()["sessions"][0]["activity"], "Thinking")
            self.assertEqual(positions, [old_size])
            self.assertEqual(records.call_count, 2)

    def test_truncated_line_completed_later(self):
        path = self.rollout()
        line = json.dumps(self.record("response_item", {"type": "message", "role": "assistant",
                                                      "content": [{"text": "All fixed"}]})).encode()
        with path.open("ab") as stream:
            stream.write(line[:40])
        self.assertIsNone(self.read()["sessions"][0]["last_message"])
        with path.open("ab") as stream:
            stream.write(line[40:] + b"\n")
        session = self.read()["sessions"][0]
        self.assertEqual(session["last_message"], "All fixed")
        self.assertEqual(session["activity"], "Replied: All fixed")

    def test_replacement_and_truncation(self):
        path = self.rollout(records=[self.record("session_meta", {"id": "original"})])
        self.read()
        path.write_text(json.dumps(self.record("session_meta", {"id": "new"})) + "\n")
        self.assertEqual(self.read()["sessions"][0]["id"], "new")
        replacement = path.with_suffix(".tmp")
        replacement.write_text(json.dumps(self.record("session_meta", {"id": "replacement"})) + "\n")
        replacement.replace(path)
        self.assertEqual(self.read()["sessions"][0]["id"], "replacement")

    def test_real_shapes_models_tokens_and_messages(self):
        self.rollout(records=[
            self.record("session_meta", {"id": "session", "cwd": "/first", "timestamp": "2026-10-16T00:00:00Z"}),
            self.record("turn_context", {"cwd": "/second", "model": "initial"}),
            self.record("world_state", {"state": {"collaboration_mode": {"model": "latest"}}}),
            self.record("event_msg", {"type": "item_completed", "item": {"type": "UserMessage", "content": [{"text": "Test it"}]}}),
            self.record("token_usage_record", {"usage": {"input_tokens": 1}, "thread_token_usage": {
                "input_tokens": 20, "output_tokens": 5, "cached_input_tokens": 8, "total_tokens": 25}}),
            self.record("event_msg", {"type": "item_completed", "item": {"type": "AgentMessage", "content": [{"text": "x" * 500}]}}),
        ])
        session = self.read()["sessions"][0]
        self.assertEqual(session["model"], "latest")
        self.assertEqual(session["cwd"], "/second")
        self.assertEqual(session["task"], "Test it")
        self.assertEqual(len(session["last_message"]), 400)
        self.assertEqual(session["tokens"], {"input": 20, "output": 5, "cached": 8, "total": 25})
        self.assertIsInstance(session["started_at"], float)

    def test_token_count_totals_and_partial_rate(self):
        self.rollout(records=[self.record("event_msg", {"type": "token_count", "info": {
            "total_token_usage": {"input_tokens": 11, "output_tokens": 2, "cached_input_tokens": 4, "total_tokens": 13}},
            "rate_limits": {"primary": {"used_percent": 0}}})])
        seat = self.read()
        self.assertEqual(seat["sessions"][0]["tokens"]["total"], 13)
        self.assertEqual(seat["usage"]["five_hour"]["pct"], 0.0)
        self.assertIsNone(seat["usage"]["weekly"]["resets_at"])

    def test_activity_variants(self):
        cases = [
            ("response_item", {"type": "custom_tool_call", "name": "apply_patch", "input": "*** Begin Patch\n*** Update File: app.py\n"}, "Editing app.py"),
            ("event_msg", {"type": "exec_command_begin", "command": ["python3", "-m", "unittest"]}, "Running: python3 -m unittest"),
            ("event_msg", {"type": "item_completed", "item": {"type": "CommandExecution", "command": ["ls"]}}, "Running: ls"),
            ("event_msg", {"type": "agent_message", "message": "Finished"}, "Replied: Finished"),
            ("event_msg", {"type": "item_completed", "item": {"type": "Reasoning"}}, "Thinking"),
        ]
        for index, (kind, payload, expected) in enumerate(cases):
            with self.subTest(expected=expected):
                path = self.rollout(str(index), [self.record(kind, payload)])
                self.assertEqual(codex._parse(path)["session"]["activity"], expected)

    def test_unknown_malformed_and_oversized_records(self):
        path = self.rollout(records=[None, [], {"payload": []}, self.record("unknown", None),
                                     self.record("response_item", {"type": "function_call", "arguments": "bad json"})])
        with patch.object(codex, "_MAX_LINE", 256):
            with path.open("ab") as stream:
                stream.write(b"bad json\n" + b"x" * 600)
            self.read()
            self.assertLessEqual(len(codex._CACHE[str(path)]["pending"]), 256)
            with path.open("ab") as stream:
                stream.write(b"\n" + json.dumps(self.record("response_item", {"type": "reasoning"})).encode() + b"\n")
            self.assertEqual(self.read()["sessions"][0]["activity"], "Thinking")

    def test_recent_limit_live_priority_and_rate_search_stops(self):
        self.rollout("expired", age=90000)
        old_live = self.rollout("old-live", age=80000)
        self.processes.return_value = [self.live(old_live)]
        for index in range(12):
            self.rollout(f"recent-{index}", [self.rate(index)], age=index)
        with patch.object(codex, "_parse", wraps=codex._parse) as parsed:
            seat = self.read()
        self.assertEqual(len(seat["sessions"]), 8)
        self.assertTrue(seat["sessions"][0]["live"])
        self.assertEqual(seat["usage"]["five_hour"]["pct"], 0)
        self.assertEqual(parsed.call_count, 9)
        self.assertNotIn("expired", [s["id"] for s in seat["sessions"]])

    def test_rate_search_beyond_display_limit_and_bounded_cache(self):
        for index in range(10):
            self.rollout(str(index), [self.rate(42)] if index == 9 else None, age=index)
        with patch.object(codex, "_CACHE_LIMIT", 4):
            seat = self.read()
            self.assertEqual(seat["usage"]["five_hour"]["pct"], 42)
            self.assertLessEqual(len(codex._CACHE), 4)
        self.assertEqual(len(seat["sessions"]), 8)


class ProcessScanTests(unittest.TestCase):
    def test_binary_match_parent_unit_and_fd(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            rollout = root / "rollout-example.jsonl"
            rollout.write_text("")
            def process(pid, exe, argv):
                path = root / str(pid)
                (path / "fd").mkdir(parents=True)
                (path / "exe").symlink_to(exe)
                (path / "cmdline").write_bytes(argv)
                (path / "stat").write_text(f"{pid} (a name ) with spaces) S 42 0 0")
                (path / "cgroup").write_text("0::/user.slice/app.scope/nested\n")
                (path / "fd/1").symlink_to(rollout)
                (path / "fd/2").symlink_to(root / "unrelated.log")
                return path
            process(101, "/bin/bash", b"bash\0-c\0codex --help\0")
            process(102, "/usr/lib/chatgpt/resources/codex", b"other\0")
            process(103, "/bin/other", b"/custom/bin/codex\0")
            inaccessible = process(104, "/bin/codex", b"codex\0")
            (inaccessible / "stat").unlink()
            (inaccessible / "cgroup").unlink()
            (inaccessible / "fd/1").unlink()
            (inaccessible / "fd/2").unlink()
            (inaccessible / "fd").rmdir()
            found = {p["pid"]: p for p in codex._scan_processes(root)}
            self.assertEqual(set(found), {102, 103, 104})
            self.assertEqual(found[102]["ppid"], 42)
            self.assertEqual(found[102]["unit"], "app.scope")
            self.assertEqual(found[103]["rollouts"], [str(rollout)])
            self.assertEqual(found[104]["rollouts"], [])


if __name__ == "__main__":
    unittest.main()

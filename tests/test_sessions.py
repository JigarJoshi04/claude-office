"""Synthetic transcript and process fixtures; known parser defects remain visible."""
import builtins
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from office import sessions


class SessionHelpersTests(unittest.TestCase):
    def test_project_dir_name(self):
        for value, expected in (("/home/me/my_project.v2", "-home-me-my-project-v2"),
                                ("C:\\Work\\a b", "C--Work-a-b"), ("/é/猫", "----"),
                                ("a--b_1", "a--b-1"), ("", "")):
            with self.subTest(value=value):
                self.assertEqual(sessions.project_dir_name(value), expected)

    def test_describe_every_tool_family(self):
        cases = [
            ("Bash", {"description": "Run tests", "command": "ignored"}, "Run tests", "type"),
            ("Bash", {"command": "python3 -m unittest"}, "python3 -m unittest", "type"),
            ("Bash", None, "Running a command", "type"),
            ("Edit", {"file_path": "/work/a.py"}, "Editing a.py", "type"),
            ("MultiEdit", {"file_path": "/work/a.py"}, "Editing a.py", "type"),
            ("NotebookEdit", {"notebook_path": "/work/a.ipynb"}, "Editing a.ipynb", "type"),
            ("Write", {"file_path": "/work/a.py"}, "Writing a.py", "type"),
            ("Read", {"file_path": "/work/a.py"}, "Reading a.py", "read"),
            ("Grep", {"pattern": "needle"}, "Searching needle", "read"),
            ("Glob", {"pattern": "*.py"}, "Searching *.py", "read"),
            ("Agent", {"description": "Review"}, "Delegating: Review", "delegate"),
            ("Task", {"prompt": "Check tests"}, "Delegating: Check tests", "delegate"),
            ("WebFetch", {}, "Browsing the web", "read"),
            ("WebSearch", {}, "Browsing the web", "read"),
            ("TodoWrite", {}, "Updating the plan", "think"),
            ("TaskCreate", {}, "Updating the plan", "think"),
            ("TaskUpdate", {}, "Updating the plan", "think"),
            ("Skill", {"skill": "review"}, "Using skill review", "think"),
            ("Monitor", {}, "Waiting on a background job", "wait"),
            ("ScheduleWakeup", {}, "Waiting on a background job", "wait"),
            ("Artifact", {}, "Publishing a page", "type"),
            ("ToolSearch", {}, "Loading tools", "think"),
            ("mcp__claude_ai_github__get_issue", {}, "github: get issue", "read"),
            ("NewTool", [], "NewTool", "type"),
        ]
        for name, inp, text, kind in cases:
            with self.subTest(name=name, inp=inp):
                self.assertEqual(sessions.describe_tool(name, inp), (text, kind))
        text, _ = sessions.describe_tool("Bash", {"command": "x" * 100})
        self.assertEqual(text, "x" * 69 + "…")

    def test_user_text_filters_harness_notices_and_tool_results(self):
        for content in (None, {}, 4, "", "  ", " <system>notice</system>",
                        "[SYSTEM NOTICE] restarted", "Caveat: command output", [],
                        [{"type": "tool_result", "content": "secret"}],
                        [{"type": "text", "text": "ignore too"}, {"type": "tool_result"}],
                        [{"type": "text", "text": "<notice>"}]):
            with self.subTest(content=content):
                self.assertIsNone(sessions._user_text(content))
        self.assertEqual(sessions._user_text("  Fix the parser\n "), "Fix the parser")
        self.assertEqual(sessions._user_text([None, {"type": "image"},
                                             {"type": "text", "text": "Fix"},
                                             {"type": "text", "text": "tests"}]), "Fix tests")


class TranscriptTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.path = self.root / "session.jsonl"
        self.cache = sessions.TranscriptCache()
        self.now = 1792180000.0
        patcher = patch.object(sessions.time, "time", return_value=self.now)
        patcher.start()
        self.addCleanup(patcher.stop)

    def record(self, kind="assistant", text="Hello", mid="message-1", **fields):
        message = {"content": [{"type": "text", "text": text}]}
        if kind == "assistant":
            message.update(id=mid, model="claude-test", usage={"input_tokens": 10, "output_tokens": 3,
                           "cache_creation_input_tokens": 2, "cache_read_input_tokens": 40})
        return dict(type=kind, timestamp=datetime.fromtimestamp(self.now, timezone.utc).isoformat(),
                    message=message, **fields)

    def encoded(self, record):
        return json.dumps(record, ensure_ascii=False).encode() + b"\n"

    def write(self, *records):
        self.path.write_bytes(b"".join(map(self.encoded, records)))

    def append(self, data):
        with self.path.open("ab") as stream:
            stream.write(data)

    def test_incremental_append_and_unchanged_file_do_not_reparse(self):
        self.write(self.record("user", "Fix parser"), self.record())
        first = self.cache.read(self.path)
        self.assertEqual(first.first_prompt, "Fix parser")
        self.assertEqual(first.tokens(self.now - 1), {"fresh": 15, "cached": 40, "turns": 1})
        with patch.object(sessions.TranscriptState, "feed_line", side_effect=AssertionError("reparsed")):
            with patch("builtins.open", side_effect=AssertionError("reread unchanged transcript")):
                self.assertIs(self.cache.read(self.path), first)
        old_size = self.path.stat().st_size
        self.append(self.encoded(self.record(text="Finished", mid="message-2")))
        real_open = builtins.open
        positions = []

        class Reader:
            def __init__(self, stream):
                self.stream = stream
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def seek(self, offset):
                positions.append(offset)
                return self.stream.seek(offset)
            def read(self):
                return self.stream.read()

        def tracked_open(path, *args, **kwargs):
            stream = real_open(path, *args, **kwargs)
            return Reader(stream) if Path(path) == self.path and args == ("rb",) else stream

        with patch("builtins.open", tracked_open):
            result = self.cache.read(self.path)
        self.assertEqual(positions, [old_size])
        self.assertEqual(result.last_text, "Finished")
        self.assertEqual(result.tokens(self.now - 1), {"fresh": 30, "cached": 80, "turns": 2})

    def test_partial_last_line_is_not_consumed_early(self):
        line = self.encoded(self.record(text="Finished café"))
        self.path.write_bytes(line[:-5])
        state = self.cache.read(self.path)
        self.assertIsNone(state.last_text)
        self.assertEqual(state.partial, line[:-5])
        self.assertEqual(state.tokens(0)["turns"], 0)

    def test_partial_last_line_is_completed_once_on_append(self):
        line = self.encoded(self.record(text="Finished café"))
        split = line.index("é".encode()) + 1
        self.path.write_bytes(line[:split])
        self.cache.read(self.path)
        self.append(line[split:])
        state = self.cache.read(self.path)
        self.assertEqual(state.last_text, "Finished café")
        self.assertEqual(state.tokens(0)["turns"], 1)

    def test_truncation_and_shorter_replacement_reset_state(self):
        for replace in (False, True):
            with self.subTest(replace=replace):
                self.write(self.record("user", "old " * 100), self.record())
                self.cache.read(self.path)
                data = self.encoded(self.record("user", "new"))
                if replace:
                    new = self.root / "replacement"
                    new.write_bytes(data)
                    new.replace(self.path)
                else:
                    self.path.write_bytes(data)
                state = self.cache.read(self.path)
                self.assertEqual(state.first_prompt, "new")
                self.assertIsNone(state.last_text)
                self.assertEqual(state.tokens(0)["turns"], 0)

    def test_same_size_replacement_is_detected_even_with_preserved_mtime(self):
        self.write(self.record("user", "old"))
        self.cache.read(self.path)
        stat = self.path.stat()
        new = self.root / "replacement"
        new.write_bytes(self.encoded(self.record("user", "new")))
        os.utime(new, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        new.replace(self.path)
        self.assertEqual(self.cache.read(self.path).first_prompt, "new")

    def test_larger_replacement_resets_first_prompt(self):
        self.write(self.record("user", "old"))
        self.cache.read(self.path)
        new = self.root / "replacement"
        new.write_bytes(self.encoded(self.record("user", "a longer replacement prompt")))
        new.replace(self.path)
        self.assertEqual(self.cache.read(self.path).first_prompt, "a longer replacement prompt")

    def test_big_file_reads_head_and_tail_skipping_middle(self):
        head = self.encoded(self.record("user", "Original task"))
        tail = self.encoded(self.record(text="Latest response", mid="tail"))
        middle = self.encoded(self.record(text="Must not parse middle", mid="middle"))
        self.path.write_bytes(head + b"\n" * sessions.HEAD_BYTES + middle +
                              b"\n" * sessions.TAIL_BYTES + tail)
        original = sessions.TranscriptState.feed_line
        parsed = []

        def track(state, line):
            if line:
                parsed.append(line)
            return original(state, line)

        with patch.object(sessions.TranscriptState, "feed_line", track):
            state = self.cache.read(self.path)
        self.assertEqual(parsed, [head.rstrip(b"\n"), tail.rstrip(b"\n")])
        self.assertEqual(state.first_prompt, "Original task")
        self.assertEqual(state.last_text, "Latest response")
        self.assertEqual(state.tokens(0), {"fresh": 15, "cached": 40, "turns": 1})
        self.assertEqual(state.offset, self.path.stat().st_size)

    def test_token_ledger_counts_each_assistant_id_only_once(self):
        self.write(self.record(mid="one"), self.record(mid="one"), self.record(mid="two"))
        state = self.cache.read(self.path)
        self.append(self.encoded(self.record(mid="one")))
        state = self.cache.read(self.path)
        self.assertEqual(state.tokens(self.now - 1), {"fresh": 30, "cached": 80, "turns": 2})
        self.assertEqual(state.tokens(self.now + 1), {"fresh": 0, "cached": 0, "turns": 0})

    def test_synthetic_limit_marks_limited_then_real_user_clears_it(self):
        record = self.record(text="You've hit your session limit · resets 3am (Asia/Kolkata)")
        record["message"]["model"] = "<synthetic>"
        self.write(record)
        state = self.cache.read(self.path)
        self.assertEqual(state.limited_at, self.now)
        self.assertIn("session limit", state.limit_text)
        self.assertEqual(state.activity_kind, "sleep")
        self.assertEqual(state.tokens(0)["turns"], 0)
        self.append(self.encoded(self.record("user", "Please continue")))
        self.assertIsNone(self.cache.read(self.path).limited_at)

    def test_missing_file_invalid_json_and_forget(self):
        self.assertIsNone(self.cache.read(self.path).first_prompt)
        self.path.write_bytes(b"not json\n" + self.encoded(self.record("user", "Valid task")))
        old = self.cache.read(self.path)
        self.assertEqual(old.first_prompt, "Valid task")
        self.cache.forget_except({str(self.path)})
        self.assertIs(self.cache.read(self.path), old)
        self.cache.forget_except(set())
        self.assertIsNot(self.cache.read(self.path), old)


class ListSessionsTests(unittest.TestCase):
    def test_dead_and_recycled_pids_are_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / ".claude2"
            (root / "sessions").mkdir(parents=True)
            for pid, start in ((101, "dead"), (102, "old-start"), (103, "current")):
                (root / "sessions" / f"{pid}.json").write_text(json.dumps({
                    "pid": pid, "procStart": start, "sessionId": f"s{pid}",
                    "cwd": tmp, "updatedAt": 1000000, "startedAt": 900000, "name": "Test lane"}))
            (root / "sessions/broken.json").write_text("broken")
            (root / "sessions/missing-pid.json").write_text("{}")
            with patch.object(sessions, "proc_start_ticks", side_effect={
                    101: None, 102: "new-start", 103: "current"}.get), \
                 patch.object(sessions, "proc_argv", return_value=["claude", "-p", "Do work"]) as argv, \
                 patch.object(sessions, "proc_unit", return_value="office-lane-test.service") as unit, \
                 patch.object(sessions, "proc_cpu_seconds", return_value=2.5) as cpu:
                result = sessions.list_sessions({"id": "claude2", "config_dir": str(root)},
                                                sessions.TranscriptCache(), now=1010)
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0]["pid"], 103)
            self.assertEqual(result[0]["kind"], "lane")
            self.assertEqual(result[0]["task"], "Do work")
            self.assertEqual(result[0]["state"], "working")
            self.assertEqual(result[0]["cpu_s"], 2.5)
            self.assertEqual(result[0]["unit"], "office-lane-test.service")
            for mock in (argv, unit, cpu):
                mock.assert_called_once_with(103)
            self.assertEqual(sessions.list_sessions({"id": "absent", "config_dir": str(root / "missing")},
                                                    sessions.TranscriptCache(), now=1010), [])


if __name__ == "__main__":
    unittest.main()

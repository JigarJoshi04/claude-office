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

    def test_cumulative_fresh_tokens_survive_trim_and_old_duplicates(self):
        state = sessions.TranscriptState(self.path)
        for i in range(4002):
            state.feed_line(self.encoded(self.record(mid=f"m{i}")))
        state.trim(self.now + sessions.LEDGER_SECONDS + 1)
        self.assertEqual(state.tokens(0)["fresh"], 0)
        self.assertEqual(state.fresh_total, 4002 * 15)
        state.feed_line(self.encoded(self.record(mid="m0")))
        self.assertEqual(state.fresh_total, 4002 * 15)
        record = self.record(mid="without-timestamp")
        del record["timestamp"]
        state.feed_line(self.encoded(record))
        state.feed_line(self.encoded(record))
        self.assertEqual(state.fresh_total, 4003 * 15)

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
            self.assertEqual(result[0]["tokens_total"], 0)
            for mock in (argv, unit, cpu):
                mock.assert_called_once_with(103)
            self.assertEqual(sessions.list_sessions({"id": "absent", "config_dir": str(root / "missing")},
                                                    sessions.TranscriptCache(), now=1010), [])


if __name__ == "__main__":
    unittest.main()


class PromptCacheTests(unittest.TestCase):
    def test_the_main_chain_sets_how_long_the_cache_stays_warm(self):
        import json
        st = sessions.TranscriptState(Path("/x.jsonl"))
        line = lambda mid, ts, w5=0, w1=0, side=False: json.dumps({"type": "assistant", "timestamp": ts, "isSidechain": side, "message": {
            "id": mid, "model": "claude-opus-5-5", "content": [], "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 400_000,
            "cache_creation_input_tokens": w5 + w1, "cache_creation": {"ephemeral_5m_input_tokens": w5, "ephemeral_1h_input_tokens": w1}}}}).encode()
        self.assertIsNone(sessions.cache_view(st))
        st.feed_line(line("m1", "2026-10-18T10:00:00Z", w5=2000))
        c = sessions.cache_view(st)
        start = sessions._ts("2026-10-18T10:00:00Z")
        self.assertEqual((c["until"], c["ttl"], c["context"]), (start + 300, 300, 402_010))
        self.assertAlmostEqual(c["saves_usd"], round(402_010 * (5 - 0.2) / 1e6, 2))
        st.feed_line(line("m2", "2026-10-18T10:20:00Z", side=True))             # a helper's response leaves it alone
        self.assertEqual(sessions.cache_view(st)["until"], start + 300)
        st.feed_line(line("m3", "2026-10-18T10:01:00Z", w1=3000))               # 1-hour writes: an hour from the last use
        c = sessions.cache_view(st)
        self.assertEqual((c["until"], c["ttl"]), (start + 60 + 3600, 3600))
        self.assertAlmostEqual(c["saves_usd"], round(403_010 * (8 - 0.2) / 1e6, 2))


class TaskListTests(unittest.TestCase):
    def test_task_create_update_and_todo_write(self):
        import json
        st = sessions.TranscriptState(Path("/x.jsonl"))
        use = lambda tid, name, inp, side=False: json.dumps({"type": "assistant", "isSidechain": side, "timestamp": "2026-10-18T10:00:00Z",
                                                             "message": {"id": "m" + tid, "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}).encode()
        res = lambda tid, text: json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": text}]}}).encode()
        self.assertIsNone(sessions.task_view(st))
        for i, subject in enumerate(["Read the code", "Fix the bug", "Open the PR"], 1):
            st.feed_line(use(f"t{i}", "TaskCreate", {"subject": subject, "activeForm": subject.replace("Read", "Reading")}))
            st.feed_line(res(f"t{i}", f"Task #{i} created successfully: {subject}"))
        st.feed_line(use("u1", "TaskUpdate", {"taskId": "1", "status": "completed"}))
        st.feed_line(use("u2", "TaskUpdate", {"taskId": "2", "status": "in_progress"}))
        st.feed_line(use("h1", "TaskCreate", {"subject": "A helper's own task"}, side=True))   # helpers keep their own lists
        v = sessions.task_view(st)
        self.assertEqual((v["done"], v["total"], v["now"]), (1, 3, "Fix the bug"))
        self.assertEqual([x["status"] for x in v["items"]], ["completed", "in_progress", "pending"])
        st.feed_line(use("u3", "TaskUpdate", {"taskId": "3", "status": "deleted"}))
        self.assertEqual(sessions.task_view(st)["total"], 2)
        st.feed_line(use("w1", "TodoWrite", {"todos": [{"content": "Old style", "status": "completed", "activeForm": "Old"}, {"content": "Next", "status": "pending"}]}))
        v = sessions.task_view(st)
        self.assertEqual((v["done"], v["total"], v["now"]), (1, 2, None))


class BigTranscriptTaskTests(unittest.TestCase):
    def test_task_updates_in_the_skipped_middle_still_count(self):
        import json
        import tempfile
        use = lambda tid, name, inp: json.dumps({"type": "assistant", "timestamp": "2026-10-18T10:00:00Z",
                                                 "message": {"id": "m" + tid, "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}) + "\n"
        res = lambda tid, text: json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": text}]}}) + "\n"
        filler = json.dumps({"type": "user", "message": {"content": "x" * 2000}}) + "\n"
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "big.jsonl"
            with open(p, "w") as fh:
                for i in (1, 2, 3):
                    fh.write(use(f"c{i}", "TaskCreate", {"subject": f"Step {i}"}) + res(f"c{i}", f"Task #{i} created successfully: Step {i}"))
                fh.write(filler * 200)                                              # past the head
                for i in (1, 2, 3):
                    fh.write(use(f"u{i}", "TaskUpdate", {"taskId": str(i), "status": "completed"}))
                fh.write(filler * (sessions.TAIL_BYTES // 2000 + 50))             # and well before the tail
            st = sessions.TranscriptCache().read(p)
            v = sessions.task_view(st)
            self.assertEqual((v["done"], v["total"]), (3, 3))


class HelperTests(unittest.TestCase):
    def test_helpers_in_the_foreground_and_the_background(self):
        import json
        st = sessions.TranscriptState(Path("/x.jsonl"))
        use = lambda tid, bg: json.dumps({"type": "assistant", "timestamp": "2026-10-18T10:00:00Z", "message": {"id": "m" + tid, "content": [
            {"type": "tool_use", "id": tid, "name": "Agent", "input": {"description": "Review the diff", "prompt": "…", "run_in_background": bg}}]}}).encode()
        res = lambda tid, text: json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": text}]}}).encode()
        note = lambda tid: json.dumps({"type": "user", "message": {"content": f"<task-notification>\n<task-id>x</task-id>\n<tool-use-id>{tid}</tool-use-id>\n<status>completed</status>"}}).encode()
        st.feed_line(use("t1", False)); st.feed_line(use("t2", True))
        self.assertEqual(len(st.helpers), 2)
        st.feed_line(res("t1", "Here is the review."))                       # a foreground helper is done with its result
        st.feed_line(res("t2", "Async agent launched successfully."))        # a background one has only started
        self.assertEqual((list(st.helpers), st.helpers_done), (["t2"], 1))
        st.feed_line(note("t2"))
        self.assertEqual((st.helpers, st.helpers_done), ({}, 2))


class LoopTests(unittest.TestCase):
    def test_the_same_call_again_and_again(self):
        import json
        st = sessions.TranscriptState(Path("/x.jsonl"))
        use = lambda i, name, inp: json.dumps({"type": "assistant", "timestamp": "2026-10-18T10:00:00Z", "message": {"id": f"m{i}", "content": [
            {"type": "tool_use", "id": f"t{i}", "name": name, "input": inp}]}}).encode()
        for i in range(9):
            st.feed_line(use(i, "Bash", {"command": "npm test", "description": "Run the tests"}))
        self.assertEqual(st.repeat[1:3], [9, "Run the tests"])
        st.feed_line(use(20, "Bash", {"command": "npm test -- --watch=false"}))     # something else breaks the run
        self.assertEqual(st.repeat[1], 1)
        for i in range(30, 40):
            st.feed_line(use(i, "Monitor", {"until": "done"}))                       # polling is not a loop
        self.assertEqual(st.repeat[1], 1)
        for i in range(40, 46):
            st.feed_line(use(i, "Edit", {"file_path": "/a.py", "old_string": f"x{i}", "new_string": "y"}))   # different edits
        self.assertEqual(st.repeat[1], 1)


class ScreenTests(unittest.TestCase):
    def test_screens_follow_the_tool_and_tests_light_the_desk(self):
        import json
        f = sessions.screen_for
        self.assertEqual([f("Bash", {"command": c}) for c in ("cd x && pytest -q", "TZ=UTC python3 -m unittest t 2>&1 | tail -1", "npm run test:unit",
                                                             "grep pytest notes.md", "echo pytestify", "git push")],
                         ["test", "test", "test", "shell", "shell", "shell"])
        self.assertEqual([f("WebSearch", {}), f("mcp__slack__post", {}), f("Artifact", {}), f("Read", {})], ["web", "mcp", "publish", None])
        st = sessions.TranscriptState(Path("/x.jsonl"))
        use = lambda tid, name, inp, side=False: json.dumps({"type": "assistant", "isSidechain": side, "timestamp": "2026-10-18T10:00:00Z",
                                                             "message": {"id": "m" + tid, "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}).encode()
        res = lambda tid, err: json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": "x", "is_error": err}]}}).encode()
        st.feed_line(use("t1", "Bash", {"command": "pytest"}))
        self.assertEqual((st.screen, st.test_ok), ("test", None))
        st.feed_line(res("t1", True))
        self.assertIs(st.test_ok, False)                                       # failed: the desk's light goes red
        st.feed_line(use("h1", "WebSearch", {}, side=True))                    # a helper's call leaves the desk's screen alone
        self.assertEqual(st.screen, "test")
        st.feed_line(use("t2", "Bash", {"command": "npm test"}))
        st.feed_line(res("t2", False))
        self.assertIs(st.test_ok, True)
        st.feed_line(use("r1", "Read", {"file_path": "/a"}))
        self.assertIsNone(st.screen)
        self.assertIs(st.test_ok, True)                                        # the light stays until the next run


class TestFlaskTests(unittest.TestCase):
    def test_a_piped_run_that_failed_is_red_and_quoted_words_are_not_runs(self):
        import json
        f = sessions.screen_for
        self.assertEqual(f("Bash", {"command": 'git commit -m "chore(pytest): bump"'}), "shell")
        self.assertEqual(f("Bash", {"command": "cat <<EOF > x.sh\npytest\nEOF"}), "shell")
        st = sessions.TranscriptState(Path("/x.jsonl"))
        use = json.dumps({"type": "assistant", "timestamp": "2026-10-18T10:00:00Z", "message": {"id": "m1", "content": [
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "pytest -q 2>&1 | tail -3"}}]}}).encode()
        res = json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "2 failed, 40 passed in 3.1s", "is_error": False}]}}).encode()
        st.feed_line(use); st.feed_line(res)
        self.assertIs(st.test_ok, False)


class PhaseTests(unittest.TestCase):
    """A session's phase from its last steps (sessions.step_kind / phase_of): no AI, just what it did."""

    def test_steps(self):
        from office.sessions import step_kind
        cases = [("Bash", {"command": "cd x && git push origin HEAD"}, None, "ship"), ("Bash", {"command": "git log --oneline | head"}, None, "look"),
                 ("Bash", {"command": "npm install"}, None, "run"), ("Write", {"file_path": "/l/REPORT.md"}, None, "ship"),
                 ("Edit", {"file_path": "/l/STATE.md"}, None, None), ("Edit", {"file_path": "/w/app.py"}, None, "edit"),
                 ("Read", {"file_path": "a"}, None, "look"), ("Bash", {"command": "pytest -q"}, "test", "test"),
                 ("Bash", {"command": 'git commit -m "x"'}, None, "ship"), ("TodoWrite", {}, None, None), ("Bash", None, None, "run")]
        for name, inp, screen, want in cases:
            self.assertEqual(step_kind(name, inp, screen), want, (name, inp))

    def test_phases(self):
        from office.sessions import phase_of
        self.assertIsNone(phase_of([], None))
        self.assertEqual(phase_of(["look", "look", "edit", "edit"], None), "building")
        self.assertEqual(phase_of(["edit", "test"], None), "testing")
        self.assertEqual(phase_of(["test", "edit", "look"], False), "debugging")
        self.assertEqual(phase_of(["test", "edit", "look"], True), "building")              # a tie goes to building
        self.assertEqual(phase_of(["edit", "ship", "look"], False), "wrapping up")
        self.assertEqual(phase_of(["look", "look", "look", "run"], None), "exploring")


class HeredocTests(unittest.TestCase):
    """strip_heredocs: one pass, however many `<<` a long command has (a backtracking regex took minutes)."""

    def test_bodies_go_and_a_lone_shift_stays(self):
        from office.sessions import strip_heredocs
        self.assertEqual(strip_heredocs("cat <<'EOF' > f\nrm -rf /\nEOF\necho done"), "cat \necho done")
        self.assertEqual(strip_heredocs("cat <<A\n1\nA\ncat <<-B\n2\n\tB\nend"), "cat \ncat \nend")
        self.assertEqual(strip_heredocs("python3 -c 'x << 2'"), "python3 -c 'x << 2'")
        self.assertEqual(strip_heredocs("cat <<EOF\nnever closed"), "cat <<EOF\nnever closed")

    def test_a_long_cpp_echo_is_fast(self):
        import time as _t
        from office.sessions import screen_for
        from office.risk import check
        cmd = "echo '" + "\n".join(f'std::cout << "line {i}" << std::endl;' for i in range(3000)) + "' > t.cpp"
        t = _t.time()
        screen_for("Bash", {"command": cmd})
        check("Bash", {"command": cmd})
        self.assertLess(_t.time() - t, 1.0)

    def test_passing_runs_are_not_failures(self):
        from office.sessions import _TEST_FAILED
        for ok in ("OK (expected failures=1)", "2 failed attempts to connect"):
            self.assertIsNone(_TEST_FAILED.search(ok), ok)
        for bad in ("=== 1 failed, 40 passed in 3s", "1 failed in 0.1s", "3 failing", "FAILED (failures=2)"):
            self.assertIsNotNone(_TEST_FAILED.search(bad), bad)


class CollisionTests(unittest.TestCase):
    """The same-repo collision alarm: two live sessions writing in one working tree within 15 minutes."""

    def test_work_roots_and_touch(self):
        import tempfile, os as _os
        from unittest.mock import patch as _patch
        from office import sessions as _s
        from office.sessions import work_root, touch_of
        real = _os.path.exists
        with tempfile.TemporaryDirectory() as tmp, _patch.object(_s.os.path, "exists", lambda q: q.startswith(tmp) and real(q)):   # nothing above tmp counts
            repo = _os.path.join(tmp, "repo"); _os.makedirs(_os.path.join(repo, ".git")); _os.makedirs(_os.path.join(repo, "src", "deep"))
            Path(repo, ".git", "HEAD").write_text("ref: refs/heads/main\n")
            wt = _os.path.join(tmp, "wt"); _os.makedirs(wt); Path(wt, ".git").write_text("gitdir: /x/.git/worktrees/wt\n")
            stray = _os.path.join(tmp, "stray"); _os.makedirs(_os.path.join(stray, ".git", "empty"))
            work_root.cache_clear()
            self.assertEqual(work_root(_os.path.join(repo, "src", "deep")), repo)
            self.assertIsNone(work_root(tmp))
            self.assertEqual(work_root(wt), wt)                                              # a worktree's .git file
            self.assertIsNone(work_root(_os.path.join(stray, ".git", "empty")))               # an empty .git folder is not a repo
            t = touch_of({_os.path.join(repo, "src", "a.py"): 1000.0, _os.path.join(tmp, "loose.txt"): 1000.0, _os.path.join(repo, "old.py"): 1.0}, 1100.0)
            self.assertEqual(t["roots"], {repo: 1000.0})
            self.assertEqual(len(t["files"]), 2)                                              # hashed, never paths
            self.assertTrue(all("/" not in k for k in t["files"]))
        work_root.cache_clear()

    def test_two_sessions_in_one_tree_need_you(self):
        from office.snapshot import Office, attention_key, collisions
        sess = lambda sid, files: {"id": sid, "name": sid, "state": "working", "kind": "lane", "live": True,
                                   "touch": {"roots": {"/w/apollo": 100.0}, "files": {f: 100.0 for f in files}}}
        snap = {"now": 200.0, "asks": [], "lanes": [], "units": [], "office": {},
                "seats": [{"id": "c", "label": "claude", "kind": "claude", "status": "ok", "usage": {}, "sessions": [sess("a", ["f1"]), sess("b", ["f2"])]}]}
        items = [x for x in Office._attention(snap) if x.get("collision")]
        self.assertEqual((items[0]["level"], items[0]["text"]), ("warn", "a on claude and b on claude are both editing apollo right now"))
        self.assertEqual(attention_key(items[0]), "collision:/w/apollo")
        snap["seats"][0]["sessions"][1] = sess("b", ["f1"])
        self.assertTrue(collisions(snap)[0]["same_file"])
        self.assertEqual([x for x in Office._attention(snap) if x.get("collision")][0]["level"], "bad")
        snap["seats"][0]["sessions"][1]["live"] = False
        self.assertEqual(collisions(snap), [])

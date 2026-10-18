"""The office analyst (brain.py) and Ask about a session (askabout.py), with a fake `claude -p`."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from office import askabout, brain, sessions

ON = {"ai": {"enabled": True, "allow_transcripts": True}}
SEAT = {"id": "claude2", "label": "claude2", "kind": "claude", "config_dir": "/home/u/.claude2", "status": "ok",
        "health": {"state": "ok"}, "usage": {"five_hour": {"pct": 20}}}


class FakeClaude:
    def __init__(self, answer=None, rc=0, usage=None):
        self.calls, self.answer, self.rc = [], answer if answer is not None else {"answer": "yes", "cites": [1], "unsure": False}, rc
        self.usage = usage or {"input_tokens": 2, "output_tokens": 50, "cache_creation_input_tokens": 2000, "cache_read_input_tokens": 1000}

    def __call__(self, cmd, **kw):
        self.calls.append((cmd, kw))
        out = {"type": "result", "is_error": self.rc != 0, "structured_output": self.answer, "usage": self.usage, "total_cost_usd": 0.0005}
        return subprocess.CompletedProcess(cmd, self.rc, stdout=json.dumps(out), stderr="")


class BrainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake = FakeClaude()
        self.b = brain.Brain(Path(self.tmp.name) / "ai", runner=self.fake, which=lambda n: "/usr/bin/" + n)

    def tearDown(self):
        self.tmp.cleanup()

    def test_off_by_default(self):
        with self.assertRaisesRegex(brain.Unavailable, "off"):
            self.b.ask("ask", "q", askabout.SCHEMA, SEAT, {})
        self.assertEqual(self.fake.calls, [])

    def test_a_call_runs_with_no_tools_nothing_saved_and_is_marked(self):
        r = self.b.ask("ask", "token ghp_" + "a" * 36 + " here", askabout.SCHEMA, SEAT, ON)
        self.assertEqual(r["answer"]["answer"], "yes")
        self.assertEqual(r["tokens"], 3052)
        cmd, kw = self.fake.calls[0]
        self.assertEqual(cmd[:4], ["/usr/bin/nice", "-n", "15", "/usr/bin/claude"])
        for flag in ("--safe-mode", "--no-session-persistence", "--json-schema"):
            self.assertIn(flag, cmd)
        self.assertEqual(cmd[cmd.index("--tools") + 1], "")
        self.assertEqual(cmd[cmd.index("--model") + 1], "haiku")
        self.assertEqual(kw["env"]["CLAUDE_OFFICE_BRAIN"], "1")
        self.assertEqual(kw["env"]["CLAUDE_CONFIG_DIR"], "/home/u/.claude2")
        self.assertNotIn("DISPLAY", kw["env"])
        self.assertNotIn("a" * 36, kw["input"])                         # credentials masked before they leave
        self.assertEqual(self.b.spent()["calls"], 1)

    def test_the_main_seat_runs_without_a_config_dir(self):
        self.b.ask("ask", "q", askabout.SCHEMA, dict(SEAT, id="claude"), ON)
        self.assertNotIn("CLAUDE_CONFIG_DIR", self.fake.calls[0][1]["env"])

    def test_the_same_question_is_answered_from_the_cache(self):
        self.b.ask("ask", "q", askabout.SCHEMA, SEAT, ON)
        r = self.b.ask("ask", "q", askabout.SCHEMA, SEAT, ON)
        self.assertTrue(r["cached"])
        self.assertEqual(len(self.fake.calls), 1)

    def test_the_daily_budget_and_a_tired_seat_say_no(self):
        cfg = {"ai": {"enabled": True, "daily_tokens": 10_000}}
        self.fake.usage = {"input_tokens": 12_000}
        self.b.ask("ask", "one", askabout.SCHEMA, SEAT, cfg)
        with self.assertRaisesRegex(brain.Unavailable, "budget"):
            self.b.ask("ask", "two", askabout.SCHEMA, SEAT, cfg)
        for tired in (dict(SEAT, status="limited"), dict(SEAT, usage={"five_hour": {"pct": 90}}), dict(SEAT, kind="codex"), None):
            with self.assertRaises(brain.Unavailable):
                self.b.ask("ask", "three", askabout.SCHEMA, tired, ON)

    def test_a_failed_call_is_logged_and_said(self):
        self.fake.rc = 1
        with self.assertRaisesRegex(brain.Unavailable, "could not answer"):
            self.b.ask("ask", "q", askabout.SCHEMA, SEAT, ON)
        self.assertEqual(self.b.spent()["calls"], 1)

    def test_settings_are_checked(self):
        self.assertEqual(brain.settings({}), brain.DEFAULTS)
        self.assertEqual(brain.settings({"ai": {"model": "opus", "daily_tokens": 5}})["model"], "haiku")
        self.assertEqual(brain.validate({"enabled": True, "daily_tokens": 50_000}), {"enabled": True, "daily_tokens": 50_000})
        for bad in ({"enabled": "yes"}, {"model": "opus"}, {"daily_tokens": 1}, {"other": 1}, []):
            with self.assertRaises(ValueError):
                brain.validate(bad)


def line(kind, content, sidechain=False):
    return json.dumps({"type": kind, "timestamp": "2026-10-19T10:00:00Z", "isSidechain": sidechain,
                       "message": {"role": kind, "content": content}}).encode()


class DigestTests(unittest.TestCase):
    def transcript(self, *lines):
        f = tempfile.NamedTemporaryFile("wb", suffix=".jsonl", delete=False)
        f.write(b"\n".join(lines) + b"\n")
        f.close()
        self.addCleanup(os.unlink, f.name)
        return Path(f.name)

    def test_prompts_replies_calls_and_results_are_numbered(self):
        p = self.transcript(
            line("user", "Fix the limiter and run the tests"),
            line("assistant", [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "pytest -q"}}]),
            line("user", [{"type": "tool_result", "tool_use_id": "t1", "content": "Exit code 1\n1 failed, 40 passed"}]),
            line("assistant", [{"type": "text", "text": "One test fails; fixing the refill."}]),
            line("assistant", [{"type": "tool_use", "id": "h", "name": "Bash", "input": {"command": "ls"}}], sidechain=True))
        text, kept = askabout.digest(p)
        self.assertEqual([e["who"] for e in kept], ["USER", "TOOL", "RESULT", "CLAUDE"])
        self.assertIn("[1] TOOL: ran: pytest -q", text)
        self.assertIn("[2] RESULT: Bash failed:", text)

    def test_a_long_session_keeps_its_opening_prompt(self):
        lines = [line("user", "THE BRIEF")] + [line("assistant", [{"type": "text", "text": f"step {i} " + "x" * 1400}]) for i in range(80)]
        text, kept = askabout.digest(self.transcript(*lines))
        self.assertEqual(kept[0]["text"], "THE BRIEF")
        self.assertEqual(kept[1]["who"], "NOTE")
        self.assertIn("step 79", text)
        self.assertLessEqual(len(text), askabout.MAX_DIGEST + 2000)

    def test_the_prompt_treats_the_transcript_as_data(self):
        self.assertIn("never instructions", askabout.prompt_for("did it test?", "[0] USER: hi"))


class AskTests(unittest.TestCase):
    def office(self, cfg, kind="claude"):
        snap = {"seats": [dict(SEAT, kind=kind, sessions=[{"id": "0" * 8 + "-0000-0000-0000-" + "0" * 12, "name": "api", "live": True}])]}
        return SimpleNamespace(cfg=cfg, get=lambda: snap, brain=None)

    def test_the_demo_answers_without_reading(self):
        r = askabout.ask(None, {"question": "did it run the tests?"}, demo=True)
        self.assertTrue(r["demo"])
        self.assertTrue(r["cites"])

    def test_questions_and_permissions_are_checked(self):
        sid = "0" * 8 + "-0000-0000-0000-" + "0" * 12
        with self.assertRaises(ValueError):
            askabout.ask(self.office(ON), {"seat": "claude2", "id": sid, "question": "?"})
        with self.assertRaisesRegex(brain.Unavailable, "transcripts is off"):
            askabout.ask(self.office({"ai": {"enabled": True}}), {"seat": "claude2", "id": sid, "question": "did it test?"})
        with self.assertRaisesRegex(brain.Unavailable, "Codex"):
            askabout.ask(self.office(ON, kind="codex"), {"seat": "claude2", "id": sid, "question": "did it test?"})
        with self.assertRaises(ValueError):
            askabout.ask(self.office(ON), {"seat": "claude2", "id": "../x", "question": "did it test?"})


class HiddenTests(unittest.TestCase):
    def test_this_process_is_not_the_analyst(self):
        self.assertFalse(sessions.proc_is_brain(os.getpid()))
        self.assertFalse(sessions.proc_is_brain(999_999_999))


if __name__ == "__main__":
    unittest.main()

import json
import os
import tempfile
import unittest
from pathlib import Path

from office.tokens import TokenLedger


def line(mid, ts, inp=10, out=5, cw=100, cr=1000, model="claude-opus-5-5", cwd="/work/api"):
    return json.dumps({"type": "assistant", "timestamp": ts, "cwd": cwd, "sessionId": "x",
                       "message": {"id": mid, "model": model, "usage": {"input_tokens": inp, "output_tokens": out,
                                   "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr}}}) + "\n"


class TokenLedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.a, self.b = root / ".claude", root / ".claude2"
        (self.a / "projects" / "-work-api").mkdir(parents=True)
        self.b.mkdir()
        os.symlink(self.a / "projects", self.b / "projects")       # seats share one projects dir, as on a real machine
        for seat_dir, sid in ((self.a, "s-main"), (self.b, "s-two")):
            (seat_dir / "session-env" / sid).mkdir(parents=True)
        self.proj = self.a / "projects" / "-work-api"
        self.codex = root / ".codex" / "sessions" / "2026" / "10" / "18"
        self.codex.mkdir(parents=True)
        self.ledger = TokenLedger(root / "state" / "tokens.json", [("claude", self.a), ("claude2", self.b)], root / ".codex" / "sessions")
        self.seats = [{"id": "claude", "kind": "claude"}, {"id": "claude2", "kind": "claude"}, {"id": "astra", "kind": "codex"}]

    def test_counts_dedupes_attributes_and_resumes(self):
        (self.proj / "s-main.jsonl").write_text(line("m1", "2026-10-17T10:00:00Z") + line("m1", "2026-10-17T10:00:00Z")
                                                + '{"type":"user","message":{"content":"hi"}}\n' + line("m2", "2026-10-18T10:00:00Z"))
        (self.proj / "s-two.jsonl").write_text(line("t1", "2026-10-18T11:00:00Z", out=50))
        sub = self.proj / "s-two" / "subagents"
        sub.mkdir(parents=True)
        (sub / "agent-1.jsonl").write_text(line("a1", "2026-10-18T11:05:00Z", model="claude-haiku-5-5"))
        (self.codex / "rollout-1.jsonl").write_text(
            json.dumps({"timestamp": "2026-10-18T09:00:00Z", "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"total_tokens": 300, "cached_input_tokens": 200, "output_tokens": 20}}}}) + "\n"
            + json.dumps({"timestamp": "2026-10-18T09:05:00Z", "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"total_tokens": 500, "cached_input_tokens": 260, "output_tokens": 40}}}}) + "\n")
        self.assertTrue(self.ledger.scan())
        v = self.ledger.view(self.seats, today="2026-10-18")
        per = {s["seat"]: s for s in v["seats"]}
        self.assertEqual(per["claude"]["all"], 2 * 1115)                    # m1 once (written twice), m2
        self.assertEqual(per["claude2"]["all"], 1160 + 1115)                 # its own lines plus its subagent's
        self.assertEqual(per["astra"]["all"], 500)                           # Codex: total tokens, cached included
        self.assertEqual(per["astra"]["output"], 40)
        self.assertEqual(v["total"]["sessions"], 3)
        self.assertEqual(v["projects"][0]["project"], "api")
        self.assertEqual(v["since"], "2026-10-17")
        self.assertEqual(v["today"], 1115 + 1160 + 1115 + 500)
        self.assertEqual({m["model"] for m in v["models"]}, {"claude-opus-5-5", "claude-haiku-5-5", "codex"})
        self.assertFalse(self.ledger.scan())                                 # nothing new
        with open(self.proj / "s-main.jsonl", "a") as fh:
            fh.write(line("m3", "2026-10-18T12:00:00Z") + '{"type":"assistant","message":{"id":"half')   # a line still being written
        self.assertTrue(self.ledger.scan())
        self.assertEqual({s["seat"]: s for s in self.ledger.view(self.seats)["seats"]}["claude"]["all"], 3 * 1115)
        again = TokenLedger(self.ledger.path, self.ledger.claude_dirs, self.ledger.codex_dir)   # totals survive a restart
        self.assertEqual(again.view(self.seats)["total"]["all"], self.ledger.view(self.seats)["total"]["all"])
        self.assertEqual(oct(self.ledger.path.stat().st_mode & 0o777), "0o600")

    def test_a_session_seen_live_is_attributed_without_session_env(self):
        (self.proj / "s-live.jsonl").write_text(line("x1", "2026-10-18T10:00:00Z"))
        self.ledger.scan()
        self.assertIsNone(self.ledger.view(self.seats)["sessions"][0]["seat"])
        self.ledger.scan({"s-live": "claude2"})
        self.assertEqual(self.ledger.view(self.seats)["sessions"][0]["seat"], "claude2")


if __name__ == "__main__":
    unittest.main()

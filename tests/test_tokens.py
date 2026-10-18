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


class ShippingTests(unittest.TestCase):
    def test_commands_and_results(self):
        from office.tokens import ship_kinds, shipped
        self.assertEqual(ship_kinds("git add -A && git commit -q -m x && git push -q origin main"), {"commit", "push"})
        self.assertEqual(ship_kinds("cd /r && git -C /repo commit -m y"), {"commit"})
        self.assertEqual(ship_kinds("echo git commit; grep 'git push' log"), set())
        self.assertEqual(ship_kinds("gh pr create --fill && gh pr merge 3 --squash"), {"pr_open", "pr_merge"})
        self.assertEqual(shipped({"commit"}, "[main abc1234] msg\n 3 files changed, 20 insertions(+), 4 deletions(-)"), [1, 0, 0, 0, 20, 4])
        self.assertEqual(shipped({"commit"}, "nothing to commit, working tree clean"), [0] * 6)
        self.assertEqual(shipped({"commit", "push"}, ""), [1, 1, 0, 0, 0, 0])             # -q prints nothing
        self.assertEqual(shipped({"push"}, "Everything up-to-date"), [0] * 6)
        self.assertEqual(shipped({"pr_open"}, "https://github.com/a/b/pull/42"), [0, 0, 1, 0, 0, 0])

    def test_scan_counts_successful_commands_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proj = root / ".claude" / "projects" / "-w"
            proj.mkdir(parents=True)
            (root / ".claude" / "session-env" / "s1").mkdir(parents=True)
            use = lambda i, cmd: json.dumps({"type": "assistant", "timestamp": "2026-10-18T10:00:00Z", "message": {"id": "m" + i, "content": [
                {"type": "tool_use", "id": "t" + i, "name": "Bash", "input": {"command": cmd}}]}}) + "\n"
            res = lambda i, out, err=False: json.dumps({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t" + i, "content": out, "is_error": err}]}}) + "\n"
            (proj / "s1.jsonl").write_text(use("1", "git commit -m a") + res("1", "[main 1234567] a\n 1 file changed, 5 insertions(+)")
                                           + use("2", "git push") + res("2", "fatal: rejected", True)
                                           + use("3", "gh pr create --fill") + res("3", "https://github.com/x/y/pull/7"))
            led = TokenLedger(root / "tokens.json", [("claude", root / ".claude")])
            led.scan(); led.scan()
            v = led.view([{"id": "claude", "kind": "claude"}], today="2026-10-18")
            self.assertEqual(v["shipped"], {"commits": 1, "pushes": 0, "prs_opened": 1, "prs_merged": 0, "insertions": 5, "deletions": 0})
            self.assertEqual(led.take_events(), [])                                       # the first read never makes news


class TokenViewTests(unittest.TestCase):
    def test_ranges_seats_previous_ranks_and_v1_migration(self):
        from office.demo import _demo_token_ledger
        led = _demo_token_ledger()
        seats = [{"id": i, "kind": "codex" if i == "astra" else "claude"} for i in ("claude", "claude2", "claude3", "claude4", "astra")]
        all_time, month, week = (led.view(seats, rng=r) for r in ("all", "30", "7"))
        self.assertGreater(all_time["total"]["all"], month["total"]["all"])
        self.assertGreater(month["total"]["all"], week["total"]["all"])
        self.assertEqual(len(week["days"]), 7)
        self.assertTrue(all(b.get("prev_rank") is not None for b in month["seats"]))
        self.assertNotIn("prev_rank", all_time["seats"][0])
        self.assertEqual(sum(b["all"] for b in month["seats"]), month["total"]["all"])
        mine = led.view(seats, rng="30", seat="claude3")
        self.assertTrue(all(s["seat"] == "claude3" for s in mine["sessions"]))
        self.assertEqual(mine["total"]["all"], next(b["all"] for b in month["seats"] if b["seat"] == "claude3"))
        self.assertEqual(len(led.view(seats, rng="all", all_sessions=True)["sessions"]), len(led.data["sessions"]))
        self.assertTrue(set(all_time["heat"]) <= {f"{d}-{h}" for d in range(7) for h in range(24)})
        self.assertIn("biggest_day", all_time["records"])

    def test_v1_sessions_without_transcripts_keep_their_totals(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "tokens.json"
            p.write_text(json.dumps({"v": 1, "files": {}, "codex": {}, "days": {"2026-10-01": {"f": 30, "c": 70, "o": 3, "n": 2}},
                                     "models": {}, "sessions": {"gone": {"p": "old", "s": "claude", "f": 30, "c": 70, "o": 3, "n": 2,
                                     "m": {"claude-opus-5": 100}, "d": {"2026-10-01": 60, "2026-10-02": 40}}}}))
            led = TokenLedger(p, [])
            led.scan()
            v = led.view([{"id": "claude", "kind": "claude"}])
            self.assertEqual(v["total"]["all"], 100)
            self.assertEqual(v["seats"][0]["all"], 100)
            self.assertEqual(json.loads(p.read_text())["v"], 2)
            self.assertTrue(json.loads(p.read_text())["sessions"]["gone"]["legacy"])

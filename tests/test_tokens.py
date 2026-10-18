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
        self.assertEqual(ship_kinds("git add -A && git commit -q -m x && git push -q origin main"), {"commit", "commit_q", "push", "push_q"})
        self.assertEqual(ship_kinds("cd /r && git -C /repo commit -m y"), {"commit"})
        self.assertEqual(ship_kinds("echo git commit; grep 'git push' log"), set())
        self.assertEqual(ship_kinds("gh pr create --fill && gh pr merge 3 --squash"), {"pr_open", "pr_merge"})
        self.assertEqual(shipped({"commit"}, "[main abc1234] msg\n 3 files changed, 20 insertions(+), 4 deletions(-)"), [1, 0, 0, 0, 20, 4])
        self.assertEqual(shipped({"commit"}, "nothing to commit, working tree clean"), [0] * 6)
        self.assertEqual(shipped({"commit", "commit_q", "push", "push_q"}, ""), [1, 1, 0, 0, 0, 0])             # -q prints nothing
        self.assertEqual(shipped({"push"}, "Everything up-to-date"), [0] * 6)
        self.assertEqual(shipped({"pr_open"}, "https://github.com/a/b/pull/42"), [0, 0, 1, 0, 0, 0])

    def test_merges_pushes_and_commits_read_the_right_words(self):
        from office.tokens import ship_kinds, shipped, pr_number, short_id
        self.assertEqual(ship_kinds("GH_TOKEN=x gh pr create --fill"), {"pr_open"})
        self.assertEqual(ship_kinds("gh pr merge 44 --squash --auto"), {"pr_merge", "pr_auto"})
        self.assertEqual(ship_kinds("gh pr merge 44 --disable-auto"), set())
        merge, auto = {"pr_merge"}, {"pr_merge", "pr_auto"}
        self.assertEqual(shipped(merge, "")[3], 1)                                             # no terminal: gh prints nothing
        self.assertEqual(shipped(merge, "✓ Squashed and merged pull request o/r#43 (Retry failed uploads)")[3], 1)
        self.assertEqual(shipped(merge, "failed to delete local branch fix-1: failed to run git: error: cannot delete branch\n{\"state\":\"MERGED\"}")[3], 1)
        self.assertEqual(shipped(merge, "failed to run git: fatal: 'main' is already used by worktree at '/w'")[3], 1)
        self.assertEqual(shipped(auto, "✓ Pull request o/r#44 will be automatically merged via squash when all requirements are met")[3], 0)
        self.assertEqual(shipped(auto, "")[3], 0)
        self.assertEqual(shipped(auto, "MERGED\tabc123")[3], 1)                              # merged right away, and shown
        self.assertEqual(shipped(merge, "X Pull request o/r#12 is not mergeable: the merge commit cannot be cleanly created")[3], 0)
        self.assertEqual(shipped(merge, "! Pull request o/r#12 was already merged")[3], 0)
        self.assertEqual(shipped(merge, "GraphQL: Base branch was modified")[3], 0)
        self.assertEqual(shipped({"push"}, "To github.com:a/b.git\n   07f8f8d..88b4ddb  fix-rejected-uploads -> fix-rejected-uploads")[1], 1)
        self.assertEqual(shipped({"push"}, " ! [rejected]        main -> main (fetch first)")[1], 0)
        self.assertEqual(shipped({"commit"}, "[main abc1234] say nothing to commit when clean\n 1 file changed, 2 insertions(+)")[0], 1)
        self.assertEqual(shipped({"commit"}, "On branch main\nnothing added to commit but untracked files present")[0], 0)
        self.assertEqual(shipped({"commit", "commit_q"}, "Ran 3556 tests\nerror: script \"test\" exited with code 1")[0], 1)    # a later command's error
        self.assertEqual(pr_number(merge, "gh pr merge 1710 --squash --admin", ""), 1710)
        self.assertEqual(pr_number(merge, "gh pr merge --squash", "✓ Squashed and merged pull request o/r#43 (x)"), 43)
        self.assertEqual(pr_number({"pr_open"}, "gh pr create --fill", "https://github.com/a/b/pull/42"), 42)
        self.assertIsNone(pr_number(merge, "gh pr merge --squash", ""))
        self.assertEqual(short_id("codex:rollout-2026-09-08T15-00-44-01a0805b-07db-7a50-a1bb-2b9283ee4e3c"), "83ee4e3c")
        self.assertEqual(short_id("6be0cfa4-fe3c-4861-be8f-f0573597b48f"), "6be0cfa4")

    def test_fresh_merges_make_news_with_their_number(self):
        import time
        from datetime import datetime, timezone
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proj = root / ".claude" / "projects" / "-w"
            proj.mkdir(parents=True)
            ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            compact = lambda d: json.dumps(d, separators=(",", ":")) + "\n"                 # as Claude Code writes them
            use = lambda i, cmd: compact({"type": "assistant", "timestamp": ts, "message": {"id": "m" + i, "content": [
                {"type": "tool_use", "id": "t" + i, "name": "Bash", "input": {"command": cmd}}]}})
            res = lambda i, out: compact({"type": "user", "timestamp": ts, "message": {"content": [{"type": "tool_result", "tool_use_id": "t" + i, "content": out}]}})
            led = TokenLedger(root / "tokens.json", [("claude", root / ".claude")])
            (proj / "s1.jsonl").write_text("")
            led.scan()
            with open(proj / "s1.jsonl", "a") as fh:
                fh.write(use("1", "gh pr merge 1710 --squash --admin --delete-branch") + res("1", "failed to delete local branch b: cannot delete"))
            led.scan()
            ev = led.take_events()
            self.assertEqual([(e["kind"], e["pr"]) for e in ev], [("pr_merged", 1710)])
            self.assertLess(abs(ev[0]["at"] - time.time()), 60)

    def test_new_rules_recount_shipped_work_and_keep_what_is_gone(self):
        from office.tokens import VERSION
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "tokens.json"
            p.write_text(json.dumps({"v": VERSION, "sr": 0, "files": {"/x.jsonl": [10, None]}, "files_out": {"/x.jsonl": 10}, "codex": {},
                                     "days": {"2026-10-01": {"f": 1, "c": 1, "o": 1}}, "models": {},
                                     "sessions": {"s": {"p": "a", "s": "claude", "d": {"2026-10-01": [1, 1, 1]}, "g": {"2026-10-01": [9, 0, 0, 0, 0, 0]}, "$": {"2026-10-01": 5}}}}))
            led = TokenLedger(p, [])
            self.assertEqual(led.data["files_out"], {})
            self.assertNotIn("g", led.data["sessions"]["s"])                                  # to be counted again…
            self.assertEqual(led.view([{"id": "claude", "kind": "claude"}])["shipped"]["commits"], 9)   # …while the old shows
            self.assertTrue(led.view([{"id": "claude", "kind": "claude"}])["rebuilding"])
            led.scan()                                                                        # its transcript is gone: it keeps them
            self.assertEqual(led.data["sessions"]["s"]["g"], {"2026-10-01": [9, 0, 0, 0, 0, 0]})
            self.assertFalse(led.view([{"id": "claude", "kind": "claude"}])["rebuilding"])
            self.assertEqual(led.data["files"], {"/x.jsonl": [10, None]})                     # token counts are kept


class MultiLineResponseTests(unittest.TestCase):
    def test_a_response_counts_by_its_final_usage_and_a_fork_counts_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proj = root / ".claude" / "projects" / "-w"
            (proj / "s1" / "subagents").mkdir(parents=True)
            (root / ".claude" / "session-env" / "s1").mkdir(parents=True)
            u = lambda out: {"input_tokens": 2, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 50_000, "output_tokens": out,
                             "cache_creation": {"ephemeral_5m_input_tokens": 1000, "ephemeral_1h_input_tokens": 0}}
            ln = lambda mid, out: json.dumps({"type": "assistant", "timestamp": "2026-10-18T10:00:00Z",
                                              "message": {"id": mid, "model": "claude-opus-5-5", "usage": u(out), "content": []}}, separators=(",", ":")) + "\n"
            (proj / "s1.jsonl").write_text(ln("m1", 8) + ln("m1", 300) + ln("m1", 519))          # one response, three lines
            led = TokenLedger(root / "tokens.json", [("claude", root / ".claude")])
            led.scan()
            seats = [{"id": "claude", "kind": "claude"}]
            v = led.view(seats, today="2026-10-18")
            self.assertEqual((v["total"]["output"], v["total"]["fresh"], v["total"]["cache"]), (519, 1521, 50_000))
            self.assertEqual(v["total"]["messages"], 1)
            from office import prices
            cost = lambda: sum(sum(r.get("$", {}).values()) for r in led.data["sessions"].values())     # micro-dollars
            self.assertEqual(cost(), prices.response_cost("claude-opus-5-5", u(519)))
            with open(proj / "s1.jsonl", "a") as fh:                                              # the next line, in a later scan
                fh.write(ln("m1", 600))
            led.scan()
            self.assertEqual(led.view(seats, today="2026-10-18")["total"]["output"], 600)
            (proj / "s1" / "subagents" / "agent-fork.jsonl").write_text(ln("m1", 600) + ln("m2", 40))   # a fork copies its parent
            led.scan()
            v = led.view(seats, today="2026-10-18")
            self.assertEqual((v["total"]["output"], v["total"]["messages"]), (640, 2))
            self.assertEqual(cost(), prices.response_cost("claude-opus-5-5", u(600)) + prices.response_cost("claude-opus-5-5", u(40)))

    def test_a_version_2_file_is_rebuilt_and_keeps_sessions_without_transcripts(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "tokens.json"
            p.write_text(json.dumps({"v": 2, "sr": 4, "files": {}, "files_out": {}, "codex": {}, "days": {"2026-10-01": {"f": 30, "c": 70, "o": 3, "n": 2}}, "models": {},
                                     "sessions": {"gone": {"p": "old", "s": "claude", "f": 30, "c": 70, "o": 3, "n": 2, "m": {"claude-opus-5": 100},
                                                           "d": {"2026-10-01": [30, 70, 3]}, "h": {}, "g": {"2026-10-01": [2, 1, 0, 0, 5, 1]}, "$": {"2026-10-01": 7_700_000}}}}))
            led = TokenLedger(p, [])
            seats = [{"id": "claude", "kind": "claude"}]
            self.assertEqual(led.view(seats)["total"]["all"], 100)                           # the old numbers show meanwhile
            led.scan()
            v = led.view(seats)
            self.assertEqual((v["total"]["all"], v["shipped"]["commits"]), (100, 2))
            self.assertAlmostEqual(v["total"]["usd"], 7.7)
            self.assertTrue(led.data["sessions"]["gone"]["legacy"])


class ShippingRuleTests(unittest.TestCase):
    def test_heredocs_backgrounds_forced_pushes_and_hooks(self):
        from office.tokens import ship_kinds, shipped
        script = "cat > merge.sh <<'EOF'\ngit commit -qam wip\ngh pr merge \"$1\" --squash --admin\nEOF\nchmod +x merge.sh"
        self.assertEqual(ship_kinds(script), set())                                         # writing a script is not running it
        self.assertEqual(ship_kinds("cat > x <<EOF\nhi\nEOF\ngit push -q"), {"push", "push_q"})
        self.assertEqual(shipped({"commit", "commit_q"}, "Command did not complete within its 120s timeout and was moved to the background (ID: x)"), [0] * 6)
        self.assertEqual(shipped({"push"}, "To github.com:a/b.git\n + a88016eab...ca062163a b -> b (forced update)")[1], 1)
        self.assertEqual(shipped({"push", "push_q"}, "(Bash completed with no output)")[1], 1)
        self.assertEqual(shipped({"push", "push_q"}, "https://github.com/a/b/pull/9")[1], 1)                 # quiet push, then gh
        self.assertEqual(shipped({"push", "push_q"}, " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs")[1], 0)
        self.assertEqual(shipped({"commit"}, "black....................................................................Failed\n- hook id: black")[0], 0)
        self.assertEqual(shipped({"commit", "commit_q"}, "black.......Failed\n- hook id: black\n- exit code: 1")[0], 0)
        self.assertEqual(shipped({"commit"}, "(Bash completed with no output)")[0], 0)                  # not quiet: it would have said


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

    def test_every_range_keeps_its_days_and_the_calendar_starts_on_a_monday(self):
        from datetime import date, timedelta
        from office.demo import _demo_token_ledger
        led = _demo_token_ledger()
        seats = [{"id": i, "kind": "codex" if i == "astra" else "claude"} for i in ("claude", "claude2", "claude3", "claude4", "astra")]
        for rng, n in (("today", 7), ("7", 7), ("30", 30), ("90", 90)):
            v = led.view(seats, rng=rng)
            self.assertEqual(len(v["days"]), n, rng)                       # not cut short by a week's commit count
            self.assertEqual(v["days"][-1]["day"], date.today().isoformat())
        today = date.today()
        old = (today - timedelta(days=300)).isoformat()
        led.data["sessions"]["old"] = {"p": "x", "s": "claude", "d": {old: [1, 1, 1]}, "h": {}, "m": {}}
        led.data["days"][old] = {"f": 1, "c": 1, "o": 1}
        for back in range(7 * 27):
            d = (today - timedelta(days=back)).isoformat()
            led.data["days"].setdefault(d, {"f": 1, "c": 0, "o": 0})
        cal = led.view(seats)["calendar"]
        self.assertEqual(date.fromisoformat(cal[0]["day"]).weekday(), 0)
        self.assertEqual(len({(date.fromisoformat(d["day"]) - date.fromisoformat(cal[0]["day"])).days // 7 for d in cal}), 26)

    def test_a_period_before_the_first_transcript_is_marked_partial(self):
        from office.demo import _demo_token_ledger
        led = _demo_token_ledger()                                      # about 120 days on record
        seats = [{"id": "claude", "kind": "claude"}]
        self.assertFalse(led.view(seats, rng="30")["prev_partial"])
        self.assertTrue(led.view(seats, rng="90")["prev_partial"])     # 91 to 180 days back: only partly on record
        self.assertFalse(led.view(seats, rng="all")["prev_partial"])

    def test_today_by_measure(self):
        from office.demo import _demo_token_ledger
        led = _demo_token_ledger()
        v = led.view([{"id": "claude2", "kind": "claude"}], rng="30")
        self.assertEqual(v["today_by"]["all"], v["today"])
        self.assertLess(v["today_by"]["output"], v["today_by"]["fresh"])
        b = v["seats"][0]
        self.assertEqual(b["today_by"]["all"], b["today"])

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
            self.assertEqual(json.loads(p.read_text())["v"], 3)
            self.assertTrue(json.loads(p.read_text())["sessions"]["gone"]["legacy"])


class MonthRangeTests(unittest.TestCase):
    def test_a_calendar_month_against_the_one_before(self):
        from office.demo import _demo_token_ledger
        led = _demo_token_ledger()
        seats = [{"id": i, "kind": "codex" if i == "astra" else "claude"} for i in ("claude", "claude2", "claude3", "claude4", "astra")]
        v = led.view(seats, rng="m:2026-09")
        self.assertEqual(len(v["days"]), 30)
        self.assertEqual((v["days"][0]["day"], v["days"][-1]["day"]), ("2026-09-01", "2026-09-30"))
        self.assertEqual(sum(d["all"] for d in v["days"]), v["total"]["all"])
        self.assertIsNotNone(v["prev_total"])
        self.assertEqual(len(led.view(seats, rng="m:2026-02")["days"]), 28)

import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from office.tokens import TokenLedger


def line(mid, ts, inp=10, out=5, cw=100, cr=1000, model="claude-opus-5-5", cwd="/work/api"):
    return json.dumps({"type": "assistant", "timestamp": ts, "cwd": cwd, "sessionId": "x",
                       "message": {"id": mid, "model": model, "usage": {"input_tokens": inp, "output_tokens": out,
                                   "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr}}}) + "\n"


def in_utc(tc: unittest.TestCase) -> None:
    """Read the test's dates (UTC days) in UTC wherever it runs, and put the zone back afterwards."""
    old = os.environ.get("TZ")
    os.environ["TZ"] = "UTC"; time.tzset()
    def back():
        if old is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = old
        time.tzset()
    tc.addCleanup(back)


class TokenLedgerTests(unittest.TestCase):
    def setUp(self):
        in_utc(self)
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

    def test_cold_cache_rebuilds_after_the_cache_expired(self):
        one_hour = lambda mid, ts, cw: json.dumps({"type": "assistant", "timestamp": ts, "cwd": "/work/api", "sessionId": "x",
            "message": {"id": mid, "model": "claude-opus-5-5", "usage": {"input_tokens": 5, "output_tokens": 5, "cache_creation_input_tokens": cw,
                        "cache_read_input_tokens": 0, "cache_creation": {"ephemeral_1h_input_tokens": cw}}}}) + "\n"
        (self.proj / "s-main.jsonl").write_text(
            line("r1", "2026-10-18T10:00:00Z", cw=80_000)            # the first write: nothing to rebuild
            + line("r2", "2026-10-18T10:02:00Z", cw=60_000)          # 2 minutes on: still warm
            + line("r3", "2026-10-18T10:30:00Z", cw=90_000)          # 28 minutes on a 5-minute cache: a rebuild
            + line("r4", "2026-10-18T10:45:00Z", cw=5_000)           # small: not counted
            + one_hour("r5", "2026-10-18T11:20:00Z", 70_000)        # 35 minutes on a 1-hour cache: still warm
            + one_hour("r6", "2026-10-18T13:00:00Z", 70_000))       # 100 minutes on: a rebuild
        sub = self.proj / "s-main" / "subagents"
        sub.mkdir(parents=True)
        (sub / "agent-1.jsonl").write_text(line("h1", "2026-10-18T12:50:00Z", cw=90_000))   # a helper's write is not the main conversation's
        self.ledger.scan()
        v = self.ledger.view(self.seats, today="2026-10-18")
        self.assertEqual((v["where"]["rebuilds"], v["where"]["rebuild_tokens"]), (2, 160_000))
        self.assertGreater(v["where"]["rebuild_usd"], 0)
        self.assertEqual({s["seat"]: s["rebuilds"] for s in v["seats"]}.get("claude"), 2)

    def test_where_the_time_goes_by_tool(self):
        use = lambda ts, tid, name: json.dumps({"type": "assistant", "timestamp": ts, "message": {"role": "assistant", "content": [{"type": "tool_use", "id": tid, "name": name, "input": {}}]}}) + "\n"
        res = lambda ts, tid: json.dumps({"type": "user", "timestamp": ts, "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": "ok"}]}}) + "\n"
        (self.proj / "s-main.jsonl").write_text(
            line("m1", "2026-10-18T10:00:00Z")
            + use("2026-10-18T10:00:01Z", "t1", "Bash") + res("2026-10-18T10:00:31Z", "t1")              # 30 s
            + use("2026-10-18T10:01:00Z", "t2", "Bash") + res("2026-10-18T10:01:10Z", "t2")              # 10 s
            + use("2026-10-18T10:02:00Z", "t3", "mcp__docs__search") + res("2026-10-18T10:02:04Z", "t3")
            + use("2026-10-18T10:03:00Z", "t4", "Read") + res("2026-10-18T16:00:00Z", "t4")             # left open for hours: not counted
            + use("2026-10-18T10:04:00Z", "t5", "Grep"))                                                  # no result yet
        self.ledger.scan()
        tools = {t["tool"]: t for t in self.ledger.view(self.seats, today="2026-10-18")["tools"]}
        self.assertEqual((tools["Bash"]["calls"], tools["Bash"]["seconds"], tools["Bash"]["avg"], tools["Bash"]["max"]), (2, 40, 20.0, 30))
        self.assertEqual(tools["MCP: docs"]["seconds"], 4)
        self.assertNotIn("Read", tools)
        self.assertNotIn("Grep", tools)

    def test_start_up_weight_is_the_first_prompt(self):
        (self.proj / "s-main.jsonl").write_text(line("f1", "2026-10-18T10:00:00Z", inp=4, cw=30_000, cr=12_000)
                                                + line("f2", "2026-10-18T10:01:00Z", inp=4, cw=2_000, cr=42_000))
        (self.proj / "s-two.jsonl").write_text(line("g1", "2026-10-18T11:00:00Z", inp=6, cw=50_000, cr=0))
        self.ledger.scan()
        su = self.ledger.view(self.seats, today="2026-10-18")["startup"]
        self.assertEqual((su["sessions"], su["tokens"]), (2, 42_004 + 50_006))
        per = {e["seat"]: e["median"] for e in su["seats"]}
        self.assertEqual(per, {"claude": 42_004, "claude2": 50_006})

    def test_the_connections_weather(self):
        now = time.time()
        iso = lambda ago: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - ago))
        err = lambda ago, kind, text: json.dumps({"type": "assistant", "timestamp": iso(ago), "isApiErrorMessage": True, "error": kind,
                                                 "message": {"content": [{"type": "text", "text": text}]}}) + "\n"
        (self.proj / "s-main.jsonl").write_text(line("m1", iso(3000)) + err(600, "server_error", "API Error: 529 Overloaded")
                                                + err(500, "server_error", "API Error: Can't reach the API server") + err(400, "x", "API Error: 500")
                                                + err(300, "rate_limit", "You've hit your session limit") + err(200, "authentication_failed", "Failed to authenticate"))
        self.ledger.scan()
        w = self.ledger.weather(now)
        self.assertEqual((w["sky"], w["errors"], w["by_kind"]), ("stormy", 3, {"server": 2, "connection": 1}))   # limits and logins left out
        self.assertEqual(self.ledger.weather(now + 3600)["sky"], "clear")
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        v = self.ledger.view(self.seats, today=day, rng="7")
        self.assertEqual(v["api_errors"]["by_kind"], {"server": 2, "connection": 1, "login": 1, "other": 0})

    def test_the_steering_log(self):
        u = lambda ts, text: json.dumps({"type": "user", "timestamp": ts, "message": {"role": "user", "content": [{"type": "text", "text": text}]}}) + "\n"
        refuse = json.dumps({"type": "assistant", "timestamp": "2026-10-18T10:05:00Z", "message": {"id": "r1", "stop_reason": "refusal", "content": []}}) + "\n"
        (self.proj / "s-main.jsonl").write_text(line("m1", "2026-10-18T10:00:00Z") + u("2026-10-18T10:01:00Z", "[Request interrupted by user]")
                                                + u("2026-10-18T10:02:00Z", "[Request interrupted by user for tool use]")
                                                + json.dumps({"type": "system", "subtype": "compact_boundary", "timestamp": "2026-10-18T10:03:00Z"}) + "\n"
                                                + refuse + refuse)
        self.ledger.scan()
        st = self.ledger.view(self.seats, today="2026-10-18")["steering"]
        self.assertEqual((st["interruptions"], st["compactions"], st["refusals"]), (2, 1, 1))   # one refusal, however many lines
        self.assertEqual(st["seats"][0]["seat"], "claude")

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
            from office.tokens import VERSION
            self.assertEqual(json.loads(p.read_text())["v"], VERSION)
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


class SpentTests(unittest.TestCase):
    def test_what_sessions_have_cost(self):
        from office.demo import _demo_token_ledger
        led = _demo_token_ledger()
        sid, r = next(iter(led.data["sessions"].items()))
        s = led.spent([sid])
        self.assertEqual(s["tokens"], r["f"] + r["c"])
        self.assertAlmostEqual(s["usd"], round(sum(r["$"].values()) / 1e6, 2))
        self.assertIsNone(led.spent(["nobody"]))


class WhereTests(unittest.TestCase):
    def test_helpers_thinking_and_web(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proj = root / ".claude" / "projects" / "-w"
            (proj / "s1" / "subagents").mkdir(parents=True)
            u = lambda out, think=0, ws=0: {"input_tokens": 10, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 90, "output_tokens": out,
                                             "output_tokens_details": {"thinking_tokens": think}, "server_tool_use": {"web_search_requests": ws, "web_fetch_requests": 0}}
            ln = lambda mid, usage: json.dumps({"type": "assistant", "timestamp": "2026-10-18T10:00:00Z", "message": {"id": mid, "model": "claude-opus-5-5", "usage": usage}}) + "\n"
            web = lambda mid, tid, name: json.dumps({"type": "assistant", "timestamp": "2026-10-18T10:00:00Z", "message": {"id": mid, "model": "claude-opus-5-5",
                                                       "content": [{"type": "tool_use", "id": tid, "name": name, "input": {}}]}}) + "\n"
            (proj / "s1.jsonl").write_text(ln("m1", u(5, 2)) + ln("m1", u(50, 30, 1))         # thinking grows with the lines
                                           + web("m2", "t1", "WebSearch") + web("m2", "t1", "WebSearch") + web("m3", "t2", "WebFetch"))   # searches: the calls, once each
            (proj / "s1" / "subagents" / "agent-a.jsonl").write_text(ln("h1", u(20)))
            led = TokenLedger(root / "tokens.json", [("claude", root / ".claude")])
            led.scan()
            w = led.view([{"id": "claude", "kind": "claude"}], today="2026-10-18")["where"]
            self.assertEqual((w["helpers"], w["thinking"], w["searches"], w["fetches"], w["output"]), (120, 30, 1, 1, 70))
            self.assertEqual(w["main"], 150)


class ShippedForTests(unittest.TestCase):
    def test_what_sessions_shipped(self):
        from office.demo import _demo_token_ledger
        led = _demo_token_ledger()
        sid, r = next((k, v) for k, v in led.data["sessions"].items() if any(g[0] for g in v["g"].values()))
        out = led.shipped_for([sid])
        self.assertEqual(out["commits"], sum(g[0] for g in r["g"].values()))
        self.assertIsNone(led.shipped_for(["nobody"]))


class ShippedOnTests(unittest.TestCase):
    def test_one_days_commits_prs_and_merges(self):
        led = TokenLedger(None, [])
        led.data["sessions"] = {
            "a": {"s": "claude2", "g": {"2026-10-19": [3, 1, 1, 0, 40, 2], "2026-10-18": [9, 0, 0, 0, 0, 0]}},
            "b": {"s": "claude2", "g": {"2026-10-19": [2, 0, 0, 1, 0, 0]}},
            "c": {"s": "@codex", "g": {"2026-10-19": [1, 0, 0, 0, 0, 0]}},
            "d": {"s": "gone", "g": {"2026-10-19": [4, 0, 0, 0, 0, 0]}},       # a seat no longer here: in the total only
            "e": {"s": "claude3", "g": {"2026-10-19": [0, 2, 0, 0, 0, 0]}},    # pushes alone are not on the board
        }
        led.scanned_at = 1.0
        out = led.shipped_on("2026-10-19", {"claude2", "astra"}, "astra")
        self.assertEqual((out["commits"], out["prs_opened"], out["prs_merged"]), (10, 1, 1))
        self.assertEqual(out["seats"], {"claude2": [5, 1, 1], "astra": [1, 0, 0]})
        self.assertIs(led.shipped_on("2026-10-19", {"claude2", "astra"}, "astra"), out)   # cached until the next read
        led.scanned_at = 2.0
        self.assertEqual(led.shipped_on("2026-10-17", {"claude2"})["commits"], 0)


class WaitTests(unittest.TestCase):
    def test_waits_on_a_person_from_turn_end_to_typed_prompt(self):
        from office.tokens import wait_median
        in_utc(self)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proj = root / ".claude" / "projects" / "-w"
            (proj / "s1" / "subagents").mkdir(parents=True)
            ts = lambda m: f"2026-10-18T10:{m:02d}:00Z" if m < 60 else f"2026-10-18T{10 + m // 60}:{m % 60:02d}:00Z"
            usage = {"input_tokens": 1, "output_tokens": 1}
            asst = lambda m, stop, side=False: json.dumps({"type": "assistant", "isSidechain": side, "timestamp": ts(m), "message": {"id": f"m{m}", "model": "claude-opus-5-5", "usage": usage, "stop_reason": stop}}) + "\n"
            user = lambda m, src, side=False: json.dumps({"type": "user", "isSidechain": side, "timestamp": ts(m), "promptSource": src, "message": {"role": "user", "content": "go"}}) + "\n"
            tool = lambda m: json.dumps({"type": "user", "timestamp": ts(m), "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "ok"}]}}) + "\n"
            lines = [asst(0, "end_turn"), user(5, "typed"),                 # waited 5 minutes
                     asst(6, "tool_use"), tool(7), user(8, "typed"),          # typed while it worked: no wait
                     asst(9, None), asst(10, "end_turn"), user(11, "system"), # a finished helper woke it: not waiting
                     asst(12, "end_turn"), asst(13, "end_turn", side=True), user(14, "typed", side=True), user(13, "typed"),   # a side chain is not the person
                     asst(20, "end_turn"), user(200, "typed")]                # three hours: away, not waiting
            (proj / "s1.jsonl").write_text("".join(lines[:7]))
            (proj / "s1" / "subagents" / "agent-a.jsonl").write_text(asst(0, "end_turn") + user(30, "typed"))
            led = TokenLedger(root / "tokens.json", [("claude", root / ".claude")])
            led.scan()
            with open(proj / "s1.jsonl", "a") as fh:                         # the rest arrives later: the turn's end is remembered
                fh.write("".join(lines[7:]))
            led.scan()
            w = led.data["sessions"]["s1"]["w"]["2026-10-18"]
            self.assertEqual((w[0], w[1], w[2], w[3]), (360, 2, 300, 1))
            v = led.view([{"id": "claude", "kind": "claude"}], today="2026-10-18", rng="today")["waits"]
            self.assertEqual((v["seconds"], v["replies"], v["away"]), (360, 2, 1))
            self.assertEqual(v["longest"][0]["wait_s"], 300)
            self.assertTrue(60 <= v["median_s"] <= 300)
        self.assertEqual(wait_median([0, 0, 2, 0]), 25)
        self.assertIsNone(wait_median([0, 0, 0]))


class ProjectViewTests(unittest.TestCase):
    def test_one_projects_days_seats_models_and_sessions(self):
        led = TokenLedger(None, [])
        led.data["sessions"] = {
            "s1": {"p": "api", "s": "claude2", "fi": 1.0, "l": 5.0, "m": {"claude-opus-5-5": 1100}, "f": 100, "c": 1000,
                   "d": {"2026-10-18": [60, 600, 6], "2026-10-19": [40, 400, 4]}, "$": {"2026-10-18": 2_000_000, "2026-10-19": 1_000_000},
                   "g": {"2026-10-19": [2, 1, 1, 1, 10, 2]}},
            "s2": {"p": "api", "s": "@codex", "fi": 2.0, "l": 3.0, "m": {"codex": 50}, "f": 50, "c": 0, "d": {"2026-09-01": [50, 0, 5]}},
            "s3": {"p": "web", "s": "claude2", "m": {}, "f": 9, "c": 9, "d": {"2026-10-19": [9, 9, 0]}},
        }
        seats = [{"id": "claude2", "kind": "claude"}, {"id": "astra", "kind": "codex"}]
        v = led.view_project("api", seats, today="2026-10-19", days=7)
        self.assertEqual(len(v["days"]), 7)
        self.assertEqual(v["days"][-1], {"day": "2026-10-19", "all": 440, "fresh": 40, "output": 4, "usd": 1.0})
        self.assertEqual((v["total"]["all"], v["total"]["usd"], v["total"]["sessions"]), (1100, 3.0, 1))   # s2 is outside the week
        self.assertEqual((v["all_time"]["all"], v["all_time"]["sessions"], v["all_time"]["first"]), (1150, 2, 1.0))
        self.assertEqual(v["seats"], [{"seat": "claude2", "all": 1100, "usd": 3.0, "sessions": 1}])
        self.assertEqual(v["models"], [{"model": "claude-opus-5-5", "all": 1100}])
        self.assertEqual((v["sessions"][0]["seat"], v["shipped"]["commits"], v["shipped"]["prs_merged"]), ("claude2", 2, 1))
        self.assertEqual(led.view_project("nothing", seats, today="2026-10-19")["all_time"]["sessions"], 0)


class ShipItemsTests(unittest.TestCase):
    """What shipped, item by item: each commit's subject, a PR opened with its title, a PR merged."""

    def test_items_from_command_output(self):
        from office.tokens import ship_items, ship_kinds, shipped
        cmd = 'git add -A && git commit -qm "Fix it" && git push'
        text = "[main 7e416a1] 3.126.0: utilities\n[main 1b2c3d4] Second one\n 2 files changed, 3 insertions(+)\n"
        k = ship_kinds(cmd)
        items = ship_items(k, cmd, text, shipped(k, text))
        self.assertEqual([(i["k"], i["sha"], i["sub"], i["b"]) for i in items], [("c", "7e416a1", "3.126.0: utilities", "main"), ("c", "1b2c3d4", "Second one", "main")])
        quiet = 'git commit -qm "Fix the limiter" && git push -q'
        k = ship_kinds(quiet)
        self.assertEqual(ship_items(k, quiet, "", shipped(k, "")), [{"k": "c", "sha": None, "sub": "Fix the limiter"}])   # -q prints nothing
        mixed = "cat >> t.py <<'EOF'\nx = 'git commit -qm \"Not this\"'\nEOF\ngit add -A && git commit -q -m \"The real one\" && git push -q"
        k = ship_kinds(mixed)
        self.assertEqual(ship_items(k, mixed, "", shipped(k, ""))[0]["sub"], "The real one")                    # not text in a heredoc
        body = 'git commit -q -m "3.74.0: Lounge posters\n\nUnlock something, and more lines" && git push -q'
        k = ship_kinds(body)
        self.assertEqual(ship_items(k, body, "", shipped(k, ""))[0]["sub"], "3.74.0: Lounge posters")          # the subject line only
        cc = "git commit -q -m \"$(cat <<'EOF'\nAdd the brief coach\n\nLonger body here.\nEOF\n)\" && git push -q"
        k = ship_kinds(cc)
        self.assertEqual(ship_items(k, cc, "", shipped(k, ""))[0]["sub"], "Add the brief coach")               # Claude Code's own form
        leak = 'git commit -qm "Use ghp_abcdefghijklmnopqrstuvwxyz0123 for CI" && git push -q'
        k = ship_kinds(leak)
        self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz0123", ship_items(k, leak, "", shipped(k, ""))[0]["sub"])
        cmd = "gh pr create --title 'Smooth bursts' --body x"
        k = ship_kinds(cmd)
        self.assertEqual(ship_items(k, cmd, "https://github.com/a/b/pull/482\n", shipped(k, "https://github.com/a/b/pull/482\n")),
                         [{"k": "po", "n": 482, "sub": "Smooth bursts"}])

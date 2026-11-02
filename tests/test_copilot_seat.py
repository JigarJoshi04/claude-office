import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from office import config, copilot_seat as cop, divider, lanes

BODY = {  # the shape of `gh api copilot_internal/user`, with the fields the office must never keep
    "login": "someone", "id": 42, "analytics_tracking_id": "abc", "endpoints": {"api": "https://example.invalid"},
    "copilot_plan": "business", "quota_reset_date": "2026-12-01", "quota_reset_date_utc": "2026-12-01T00:00:00.000Z",
    "organization_login_list": ["an-org"], "token_based_billing": True,
    "quota_snapshots": {
        "premium_interactions": {"unlimited": True, "entitlement": 0, "remaining": 0, "percent_remaining": 100.0,
                                 "overage_permitted": True, "token_based_billing": True, "credits_used": 2521,
                                 "overage_count": 0, "quota_id": "premium", "timestamp_utc": "2026-11-02T08:31:33Z"},
        "chat": {"unlimited": True, "entitlement": 0, "remaining": 0, "percent_remaining": 100.0, "overage_permitted": False,
                 "token_based_billing": True, "credits_used": 0},
    },
}
RESET = 1796083200.0          # 2026-12-01T00:00:00Z
NOW = 1793608000.0            # 2026-11-02, about 32.4 hours into the month


class QuotaTests(unittest.TestCase):
    def test_keeps_only_the_plan_and_quota_fields(self):
        q = cop.parse_quota(BODY)
        self.assertEqual(set(q), {"plan", "reset_date", "reset_at", "premium_interactions", "chat"})
        self.assertEqual(q["plan"], "business")
        self.assertEqual(q["reset_at"], RESET)
        self.assertEqual(set(q["premium_interactions"]), set(cop.QUOTA_FIELDS))
        self.assertEqual(q["premium_interactions"]["credits_used"], 2521)
        self.assertIs(q["premium_interactions"]["overage_permitted"], True)
        text = json.dumps(q)
        for secret in ("someone", "abc", "example.invalid", "an-org", "quota_id", "timestamp_utc"):
            self.assertNotIn(secret, text)

    def test_bad_answers(self):
        self.assertIsNone(cop.parse_quota(None))
        self.assertIsNone(cop.parse_quota({"copilot_plan": "business"}))                 # no premium quota
        q = cop.parse_quota({"quota_snapshots": {"premium_interactions": {"credits_used": "lots", "unlimited": "yes",
                                                                          "entitlement": float("inf")}},
                             "quota_reset_date": "soon"})
        self.assertIsNone(q["premium_interactions"]["credits_used"])
        self.assertIsNone(q["premium_interactions"]["unlimited"])
        self.assertIsNone(q["premium_interactions"]["entitlement"])
        self.assertIsNone(q["reset_date"])

    def test_credits_view_money(self):
        poll = {"reading": cop.parse_quota(BODY), "fetched_at": NOW - 30, "error": None,
                "history": [[NOW - 7200, 1500.0], [NOW - 2430, 2238.0], [NOW - 1230, 2400.0], [NOW - 30, 2521.0]]}
        v = cop.credits_view(poll, {"credit_usd": 0.01, "included_credits": 1900}, NOW)
        self.assertEqual(v["usd"], 25.21)
        self.assertEqual(v["overage_credits"], 621)
        self.assertEqual(v["overage_usd"], 6.21)
        self.assertAlmostEqual(v["included_pct"], 132.7)
        self.assertIsNone(v["percent_remaining"])                 # "unlimited" reads 100% left forever: not shown
        self.assertIsNone(v["entitlement"])
        self.assertTrue(v["overage_permitted"])
        self.assertEqual(v["burn"]["minutes"], 40)                 # the readings of the last hour (the 2-hour-old one is out)
        self.assertAlmostEqual(v["burn"]["credits_per_hour"], 283 / 2400 * 3600, places=0)
        self.assertAlmostEqual(v["burn"]["usd_per_hour"], 283 / 2400 * 36, places=2)
        p = v["projection"]
        start = RESET - 30 * 86400                                 # November 1st
        month = 2521 + 2521 / (NOW - start) * (RESET - NOW)
        self.assertAlmostEqual(p["month_credits"], round(month))
        self.assertAlmostEqual(p["month_usd"], round(month * 0.01, 2))
        self.assertGreater(p["hour_usd"], p["month_usd"])
        # the settings, not magic numbers: another rate and allowance change every figure
        w = cop.credits_view(poll, {"credit_usd": 0.04, "included_credits": 3000}, NOW)
        self.assertEqual(w["usd"], 100.84)
        self.assertEqual(w["overage_credits"], 0)
        self.assertEqual(w["overage_usd"], 0)

    def test_finite_entitlement_and_no_reading(self):
        body = json.loads(json.dumps(BODY))
        body["quota_snapshots"]["premium_interactions"].update(unlimited=False, entitlement=300, percent_remaining=42.5)
        v = cop.credits_view({"reading": cop.parse_quota(body), "fetched_at": NOW, "history": []}, {}, NOW)
        self.assertEqual(v["entitlement"], 300)
        self.assertEqual(v["percent_remaining"], 42.5)
        self.assertIsNone(v["burn"])                               # one reading is no rate
        self.assertIsNone(cop.credits_view(None, {}, NOW))
        self.assertEqual(cop.credits_view({"error": "gh api exited 1"}, {}, NOW)["error"], "gh api exited 1")

    def test_burn_restarts_at_a_new_month_and_needs_two_readings(self):
        self.assertIsNone(cop.burn([[NOW - 100, 5.0], [NOW, 9.0]], NOW))          # minutes apart: one run's lump, no rate
        self.assertIsNone(cop.burn([[NOW - 1100, 5.0], [NOW, 900.0]], NOW))       # under 20 minutes of readings
        self.assertIsNone(cop.burn([[NOW - 7200, 5.0], [NOW, 9.0]], NOW))         # the older one is out of the hour
        b = cop.burn([[NOW - 1800, 2900.0], [NOW - 1200, 10.0], [NOW, 70.0]], NOW)   # the month reset in between
        self.assertAlmostEqual(b["per_hour"], 180.0)


class PollerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "copilot-usage.json"

    def test_reads_stores_and_backs_off(self):
        answers = [cop.parse_quota(BODY), RuntimeError("gh api exited 1: HTTP 401"), RuntimeError("offline")]

        def reader():
            a = answers.pop(0)
            if isinstance(a, Exception):
                raise a
            return a
        p = cop.CreditPoller(self.path, every=300, reader=reader)
        self.assertTrue(p.tick(NOW))
        self.assertFalse(p.tick(NOW + 10))                          # not due yet
        stored = json.loads(self.path.read_text())
        self.assertEqual(stored["history"], [[NOW, 2521.0]])
        self.assertNotIn("login", json.dumps(stored))
        self.assertFalse(p.tick(NOW + 300))                         # a failure keeps the last reading
        d = p.get()
        self.assertEqual(d["reading"]["premium_interactions"]["credits_used"], 2521)
        self.assertIn("401", d["error"])
        self.assertEqual(d["next_at"], NOW + 300 + 600)             # 2 × 5 minutes
        p.tick(NOW + 900)
        self.assertEqual(p.get()["next_at"], NOW + 900 + 1200)      # then 4 ×
        again = cop.CreditPoller(self.path, every=300, reader=reader)   # a restart keeps the readings
        self.assertEqual(again.get()["history"], [[NOW, 2521.0]])
        self.assertEqual(again.get()["failures"], 2)


class LocalRunsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.state = self.home / ".copilot" / "session-state"
        self.state.mkdir(parents=True)
        cop._CACHE.clear()
        cop._LOGS.clear()

    def session(self, sid, events, pid=None, age=0):
        d = self.state / sid
        d.mkdir()
        (d / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
        if pid:
            (d / f"inuse.{pid}.lock").write_text(str(pid))
        t = NOW - age
        os.utime(d / "events.jsonl", (t, t))
        return d

    def ev(self, kind, data, ts="2026-11-02T08:27:07.407Z"):
        return {"type": kind, "data": data, "id": "x", "timestamp": ts, "parentId": None}

    def test_a_live_lane_and_a_finished_run(self):
        sid, done = "5f0c2a7e-91d4-4b1a-8c3e-2d6f7a9b0c11", "7d3e9b20-4c1f-4e8a-9b2d-6a5c3f1e0d22"
        log = self.home / "L12.log"
        log.write_text("=== start\n● Read the brief\nAI Credits 3.38 (4s)\nTokens ↑ 20.5k\n=== exit rc=0\n=== start\n")
        self.session(sid, [
            self.ev("session.start", {"sessionId": sid, "selectedModel": "claude-opus-5.5", "reasoningEffort": "high",
                                      "context": {"cwd": "/work/wt-limiter"}}),
            self.ev("user.message", {"content": "You are lane L12. Read the brief."}),
            self.ev("tool.execution_start", {"toolName": "bash", "toolCallId": "c1",
                                             "arguments": {"command": "git push --force origin main"}}),
        ], pid=111)
        self.session(done, [
            self.ev("session.start", {"selectedModel": "claude-opus-5.5", "reasoningEffort": "low", "context": {"cwd": "/tmp/x"}}),
            self.ev("assistant.message", {"content": "OK", "model": "claude-opus-5.5"}),
            self.ev("session.shutdown", {"totalNanoAiu": 3382940000, "currentModel": "claude-opus-5.5",
                                         "tokenDetails": {"input": {"tokenCount": 4}, "cache_read": {"tokenCount": 14342},
                                                          "cache_write": {"tokenCount": 6173}, "output": {"tokenCount": 4}}}),
        ], pid=222, age=600)                                         # its lock is stale: pid 222 is no copilot process
        self.session("old-0000", [self.ev("session.start", {})], age=10 * 3600)
        procs = [{"pid": 111, "ppid": 100, "unit": "apollo-lane-l12-1.service", "cwd": "/work/wt-limiter", "log": str(log), "prompt": True}]
        with patch.object(cop, "scan_processes", return_value=procs):
            seat = cop.read_copilot_seat(home=str(self.home), now=cop._epoch("2026-11-02T08:27:30Z"))
        rows = {s["id"]: s for s in seat["sessions"]}
        self.assertEqual(set(rows), {sid, done})                     # the ten-hour-old one is left out
        a = rows[sid]
        self.assertTrue(a["live"])
        self.assertEqual((a["state"], a["pid"], a["unit"], a["cwd"]), ("waiting", 111, "apollo-lane-l12-1.service", "/work/wt-limiter"))
        self.assertEqual((a["model"], a["effort"]), ("claude-opus-5.5", "high"))
        self.assertTrue(a["activity"].startswith("Running: git push --force"))
        self.assertEqual(a["risks"][0]["rule"], "force_push")
        self.assertEqual(a["lane_credits"], {"credits": 3.38, "runs": 1})
        b = rows[done]
        self.assertFalse(b["live"])
        self.assertEqual(b["state"], "done")
        self.assertEqual(b["credits"], 3.38)
        self.assertEqual(b["tokens"]["total"], 4 + 14342 + 6173 + 4)
        self.assertEqual(seat["sessions"][0]["id"], sid)             # live first

    def test_a_headless_run_works_until_it_exits(self):
        sid = "1a2b3c4d-0000-4000-8000-00000000000a"
        self.session(sid, [
            self.ev("session.start", {"context": {"cwd": "/work"}}, ts="2026-11-02T08:00:00Z"),
            self.ev("assistant.turn_start", {}, ts="2026-11-02T08:00:01Z"),
            self.ev("tool.execution_start", {"toolName": "bash", "toolCallId": "t1", "arguments": {"command": "sleep 900"}},
                    ts="2026-11-02T08:00:02Z"),
        ], pid=5)
        proc = {"pid": 5, "ppid": 1, "unit": None, "cwd": "/work", "log": None, "prompt": False}
        late = cop._epoch("2026-11-02T08:20:00Z")                    # quiet for 20 minutes, but its tool still runs
        with patch.object(cop, "scan_processes", return_value=[proc]):
            self.assertEqual(cop.read_copilot_seat(home=str(self.home), now=late)["sessions"][0]["state"], "waiting")
        with (self.state / sid / "events.jsonl").open("a") as f:
            f.write(json.dumps(self.ev("tool.execution_complete", {"toolCallId": "t1"}, ts="2026-11-02T08:15:00Z")) + "\n")
            f.write(json.dumps(self.ev("assistant.turn_end", {}, ts="2026-11-02T08:15:01Z")) + "\n")
        with patch.object(cop, "scan_processes", return_value=[proc]):           # an interactive run between turns
            self.assertEqual(cop.read_copilot_seat(home=str(self.home), now=late)["sessions"][0]["state"], "idle")
        with patch.object(cop, "scan_processes", return_value=[dict(proc, prompt=True)]):   # a -p run never waits for anyone
            self.assertEqual(cop.read_copilot_seat(home=str(self.home), now=late)["sessions"][0]["state"], "working")

    def test_log_credits_reads_only_what_was_added(self):
        log = self.home / "lane.log"
        log.write_text("AI Credits 1,203.5 (2m 4s)\nAI Cred")
        self.assertEqual(cop.log_credits(log), {"credits": 1203.5, "runs": 1})
        with log.open("a") as f:
            f.write("its 2.25 (3s)\nnothing\nAI Credits 0.5 (1s)\n")
        self.assertEqual(cop.log_credits(log), {"credits": 1206.25, "runs": 3})
        log.write_text("AI Credits 7 (1s)\n")                       # rewritten: counted again from the start
        self.assertEqual(cop.log_credits(log), {"credits": 7.0, "runs": 1})
        self.assertIsNone(cop.log_credits(self.home / "missing.log"))

    def test_process_scan_matches_the_binary_only(self):
        proc = self.home / "proc"

        def fake(pid, exe, argv, ppid, cgroup="0::/user.slice/app.slice/apollo-lane-l13-1.service"):
            d = proc / str(pid)
            (d / "fd").mkdir(parents=True)
            os.symlink(exe, d / "exe")
            (d / "cmdline").write_bytes(b"\0".join(a.encode() for a in argv) + b"\0")
            (d / "stat").write_text(f"{pid} (MainThread) S {ppid} 1 1")
            (d / "cgroup").write_text(cgroup + "\n")
            os.symlink(str(self.home), d / "cwd")
        bin_ = "/opt/@github/copilot-linux-x64/copilot"
        fake(10, "/usr/bin/node", ["node", "/home/u/.local/bin/copilot", "-p", "a copilot task"], 1)   # the node wrapper
        fake(11, bin_ + " (deleted)", [bin_, "-p", "You are lane L13 of copilot"], 10)                  # the run
        fake(12, bin_, [bin_, "--server"], 11)                                                         # its helper
        fake(13, "/usr/bin/bash", ["bash", "-c", "copilot -p hi"], 1)                                   # mentions it
        fake(14, "/usr/bin/vim", ["vim", "copilot.md"], 1)
        found = cop.scan_processes(str(proc))
        self.assertEqual([p["pid"] for p in found], [11])
        self.assertEqual(found[0]["unit"], "apollo-lane-l13-1.service")
        self.assertTrue(found[0]["prompt"])


class SeatAndLaneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        patcher = patch.object(config, "HOME", self.home)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_discovery_needs_the_cli_and_its_folder(self):
        cfg = config.DEFAULTS
        with patch.object(config.shutil, "which", return_value=None):
            self.assertIsNone(config.copilot_seat_meta(cfg))                 # neither
            (self.home / ".copilot").mkdir()
            self.assertIsNone(config.copilot_seat_meta(cfg))                 # the folder, no CLI
            (self.home / ".local" / "bin").mkdir(parents=True)
            (self.home / ".local" / "bin" / "copilot").write_text("#!/bin/sh\n")
            meta = config.copilot_seat_meta(cfg)
        self.assertEqual((meta["id"], meta["kind"], meta["label"]), ("copilot", "copilot", "Copilot"))
        self.assertEqual(meta["color"], config.COPILOT_COLOR)
        self.assertNotIn(config.COPILOT_COLOR, config.PALETTE[:5] + [config.ASTRA_COLOR])   # no other default seat has it
        self.assertEqual(meta["look"], config.COPILOT_LOOK)
        self.assertEqual((meta["model"], meta["effort"]), ("claude-opus-5.5", "high"))
        with patch.object(config.shutil, "which", return_value="/usr/bin/copilot"):
            over = dict(cfg, seats={"copilot": {"nickname": "Pilot", "color": "#123456", "look": {"style": 1}}})
            m = config.copilot_seat_meta(over)
            self.assertEqual((m["nickname"], m["color"], m["look"]), ("Pilot", "#123456", {"style": 1}))
            self.assertIsNone(config.copilot_seat_meta(dict(cfg, seats={"copilot": {"hidden": True}})))
            self.assertIsNone(config.copilot_seat_meta(dict(cfg, copilot={"enabled": False})))

    def test_settings_are_checked(self):
        st = config.copilot_settings({"copilot": {"model": "claude-sonnet-5.5", "effort": "medium", "credit_usd": 0.02,
                                                  "included_credits": 3000, "poll_seconds": 3600}})
        self.assertEqual(st, {"model": "claude-sonnet-5.5", "effort": "medium", "poll_seconds": 300.0,
                              "credit_usd": 0.02, "included_credits": 3000.0})
        bad = config.copilot_settings({"copilot": {"model": "x; rm -rf /", "effort": "max", "credit_usd": -1,
                                                   "included_credits": True}})
        self.assertEqual(bad, config.copilot_settings({}))
        self.assertEqual(bad["credit_usd"], 0.01)
        self.assertEqual(bad["included_credits"], 1900)

    def test_divider_starts_the_seat_small(self):
        with patch.object(divider, "path", return_value=self.home / "none.json"):
            d = divider.load(["claude2", "copilot"], {"copilot": "copilot"})
        self.assertEqual(d["seats"]["claude2"]["weight"], 25)
        self.assertEqual({k: d["seats"]["copilot"][k] for k in ("enabled", "weight", "max_lanes")},
                         {"enabled": True, "weight": 10, "max_lanes": 1})

    def lane(self, **kw):
        d = self.home / "lane"
        d.mkdir(exist_ok=True)
        (d / "brief.md").write_text("Answer the CEO.\n")
        return dict({"id": "1102-140000-x", "workdir": str(self.home), "permission_mode": "bypassPermissions",
                     "model": "opus", "copilot_session": "0cb916db-26aa-40f2-86b5-1ba81b225fd2"}, **kw), d

    def test_command_for_a_new_lane(self):
        cfg = dict(config.DEFAULTS, copilot={"model": "claude-sonnet-5.5", "effort": "medium"})
        seat = {"id": "copilot", "kind": "copilot"}
        lane, d = self.lane()
        with patch.object(config, "copilot_binary", return_value="/usr/bin/copilot"):
            cmd, env = lanes._command(lane, seat, "THE PROMPT", d, cfg)
        self.assertEqual(cmd, ["/usr/bin/copilot", "--session-id=0cb916db-26aa-40f2-86b5-1ba81b225fd2", "-p", "THE PROMPT",
                               "--model", "claude-sonnet-5.5", "--reasoning-effort", "medium", "--no-color",
                               "--allow-all-tools", "--allow-all-paths"])
        self.assertEqual([k for k in env if k in ("DISPLAY", "WAYLAND_DISPLAY") or k.startswith("CLAUDE")], [])
        lane, d = self.lane(permission_mode="acceptEdits")         # without full trust: its folders only
        cfg = dict(config.DEFAULTS, lane_defaults=dict(config.DEFAULTS["lane_defaults"], add_dirs=["/data/shared"]))
        with patch.object(config, "copilot_binary", return_value="/usr/bin/copilot"):
            cmd, _ = lanes._command(lane, seat, "P", d, cfg)
        self.assertNotIn("--allow-all-paths", cmd)
        self.assertEqual(cmd[-4:], ["--add-dir", str(d), "--add-dir", "/data/shared"])
        self.assertEqual(cmd[cmd.index("--model") + 1], "claude-opus-5.5")   # the defaults: Opus 5.5, high effort
        self.assertEqual(cmd[cmd.index("--reasoning-effort") + 1], "high")

    def test_command_for_a_follow_up_and_without_the_cli(self):
        seat = {"id": "copilot", "kind": "copilot"}
        lane, d = self.lane(resume_session="7d3e9b20-4c1f-4e8a-9b2d-6a5c3f1e0d22", copilot_session=None)
        with patch.object(config, "copilot_binary", return_value="/usr/bin/copilot"):
            cmd, _ = lanes._command(lane, seat, "ignored", d, config.DEFAULTS)
        self.assertEqual(cmd[:3], ["/usr/bin/copilot", "--resume=7d3e9b20-4c1f-4e8a-9b2d-6a5c3f1e0d22", "-p"])
        self.assertTrue(cmd[3].endswith("Answer the CEO.\n"))
        self.assertTrue(cmd[3].startswith("Message from the CEO"))
        with patch.object(config, "copilot_binary", return_value=None):
            with self.assertRaises(ValueError):
                lanes._command(lane, seat, "x", d, config.DEFAULTS)
        with self.assertRaises(ValueError):                          # a follow-up never goes to Codex
            lanes._command(lane, {"id": "astra", "kind": "codex"}, "x", d, config.DEFAULTS)


if __name__ == "__main__":
    unittest.main()

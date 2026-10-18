"""Lane filesystem tests. All output is temporary and process launches are forbidden."""
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from office import config, lanes


class LaneTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for key, name in (("HOME", "home"), ("CONFIG_DIR", "config"),
                          ("STATE_DIR", "state"), ("DATA_DIR", "data")):
            path = self.root / name
            path.mkdir()
            patcher = patch.object(config, key, path)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.workdir = self.root / "working folder"
        self.workdir.mkdir()
        self.cfg = deepcopy(config.DEFAULTS)
        self.cfg["default_workdir"] = str(self.workdir)
        for name in ("start_unit", "unit_active"):
            patcher = patch.object(lanes, name, side_effect=AssertionError("No systemd in tests"))
            mock = patcher.start()
            self.addCleanup(patcher.stop)
            self.addCleanup(mock.assert_not_called)
        patcher = patch.object(lanes.subprocess, "Popen", side_effect=AssertionError("No child agents"))
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(lanes.subprocess, "run", side_effect=AssertionError("No external commands"))
        self.command = patcher.start()
        self.addCleanup(patcher.stop)

    def create(self, **overrides):
        args = dict(title="Test lane", brief="Do the work", workdir=str(self.workdir), seat="auto",
                    model="opus", permission_mode="acceptEdits", seat_ids=["claude2", "astra"],
                    cfg=self.cfg, launch=False)
        args.update(overrides)
        return lanes.create_lane(**args)

    def test_create_rejects_invalid_inputs_before_writing(self):
        cases = [(dict(title=" \n "), "title and a brief"),
                 (dict(brief="\t\n"), "title and a brief"),
                 (dict(workdir=str(self.root / "missing")), "does not exist"),
                 (dict(seat="stranger"), "Unknown seat"),
                 (dict(model="opus; touch /tmp/no"), "Model must be"),
                 (dict(permission_mode="anything"), "Permission mode must be")]
        for kwargs, message in cases:
            with self.subTest(kwargs=kwargs):
                with self.assertRaisesRegex(ValueError, message):
                    self.create(**kwargs)
                self.assertFalse(lanes.lanes_dir().exists())

    def test_create_writes_only_brief_state_and_metadata(self):
        lane = self.create(title="  A   tidy\n title  ", brief="  first line\nsecond line  ", seat="claude2")
        directory = lanes.lane_dir(lane["id"])
        self.assertEqual({p.name for p in directory.iterdir()}, {"brief.md", "STATE.md", "lane.json"})
        self.assertEqual((directory / "brief.md").read_text(), "first line\nsecond line\n")
        self.assertEqual((directory / "STATE.md").read_text(), "")
        self.assertEqual(json.loads((directory / "lane.json").read_text()), lane)
        self.assertEqual(lane["title"], "A tidy title")
        self.assertEqual(lane["status"], "queued")
        self.assertEqual(lane["runs"], [])
        self.assertIsNone(lane["seat"])
        self.assertEqual(lane["seat_pref"], "claude2")
        self.assertEqual(lane["workdir"], str(self.workdir.resolve()))
        self.assertEqual(lane["unit"], "office-lane-" + lane["id"])
        self.assertRegex(lane["id"], lanes.LANE_ID)

    def test_empty_workdir_uses_configured_default_and_title_is_bounded(self):
        lane = self.create(workdir="", title="t" * 100)
        self.assertEqual(lane["workdir"], str(self.workdir))
        self.assertEqual(len(lane["title"]), 80)

    def test_build_prompt_names_state_report_and_brief(self):
        lane = self.create()
        prompt = lanes.build_prompt(lane, "claude2", self.cfg)
        directory = lanes.lane_dir(lane["id"])
        for text in (str(directory / "STATE.md"), str(directory / "REPORT.md"),
                     "read it FIRST", "Do the work", "claude2", str(self.workdir),
                     self.cfg["lane_defaults"]["preamble"]):
            self.assertIn(text, prompt)

    def test_lane_ids_reject_traversal_and_shell_characters(self):
        for lane_id in ("", "..", "../outside", "/absolute", "a/b", "a;id", "a$(id)", "x" * 42):
            with self.subTest(lane_id=lane_id):
                with self.assertRaises(ValueError):
                    lanes.lane_dir(lane_id)

    def test_read_limits_discards_expired_and_non_numeric_values(self):
        lanes.limits_path().write_text(json.dumps({"future": 1001, "fractional": 1000.5,
                                                  "expired": 999, "boundary": 1000,
                                                  "string": "2000", "null": None, "object": {}}))
        with patch.object(lanes.time, "time", return_value=1000):
            self.assertEqual(lanes.read_limits(), {"future": 1001, "fractional": 1000.5})
        lanes.limits_path().write_text("broken json")
        self.assertEqual(lanes.read_limits(), {})
        lanes.limits_path().unlink()
        self.assertEqual(lanes.read_limits(), {})

    def test_parse_reset_passes_explicit_timezone_and_adds_grace(self):
        self.command.side_effect = None
        self.command.return_value = subprocess.CompletedProcess([], 0, stdout="2000\n", stderr="")
        self.assertEqual(lanes.parse_reset("resets 3am (Asia/Kolkata)", now=1000), 2120)
        args, kwargs = self.command.call_args
        self.assertEqual(args[0], ["date", "-d", "3am", "+%s"])
        self.assertEqual(kwargs["env"]["TZ"], "Asia/Kolkata")
        self.assertEqual(kwargs["timeout"], 5)

    def test_parse_reset_local_time_rolls_to_tomorrow_when_past(self):
        self.command.side_effect = None
        self.command.return_value = subprocess.CompletedProcess([], 0, stdout="900\n", stderr="")
        self.assertEqual(lanes.parse_reset("resets 9:40pm", now=1000), 900 + 86400 + 120)
        self.assertEqual(self.command.call_args.args[0], ["date", "-d", "9:40pm", "+%s"])
        self.assertIsNone(self.command.call_args.kwargs["env"])

    def test_parse_reset_garbage_and_date_failure_fall_back_30_minutes(self):
        for text in (None, "", "garbage"):
            with self.subTest(text=text):
                self.assertEqual(lanes.parse_reset(text, now=1000), 2800)
        self.command.assert_not_called()
        for failure in (OSError("missing date"), subprocess.TimeoutExpired("date", 5)):
            self.command.side_effect = failure
            self.assertEqual(lanes.parse_reset("resets nonsense", now=1000), 2800)
        self.command.side_effect = None
        self.command.return_value = subprocess.CompletedProcess([], 1, stdout="", stderr="invalid date")
        self.assertEqual(lanes.parse_reset("resets nonsense", now=1000), 2800)


if __name__ == "__main__":
    unittest.main()


class ChainTests(unittest.TestCase):
    def test_presets_validation_and_the_next_stage(self):
        import tempfile
        from pathlib import Path
        from unittest import mock
        from office import lanes
        self.assertEqual([x["title"] for x in lanes.chain_from("fix-review", "Flaky export test")], ["Fix: Flaky export test", "Review: Flaky export test"])
        self.assertEqual(lanes.chain_from("", "x"), [])
        self.assertEqual(lanes.chain_from("second-opinion", "Export")[0]["seat_kind"], "codex")
        for bad in ("nope", [{"title": "a"}], [{"title": "a", "brief": "b"}] * 5, [{"title": " ", "brief": "b"}]):
            with self.assertRaises(ValueError):
                lanes.chain_from(bad, "x")
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp) / "work"; work.mkdir()
            cfg = {"default_workdir": str(work), "lane_defaults": {"model": "opus", "permission_mode": "acceptEdits"}}
            with mock.patch.object(lanes, "lanes_dir", return_value=Path(tmp) / "lanes"), \
                 mock.patch.object(lanes.config, "discover_claude_seats", return_value=[{"id": "claude"}]), \
                 mock.patch.object(lanes.config, "codex_seat_meta", return_value=None):
                (Path(tmp) / "lanes").mkdir()
                first = lanes.create_lane("Investigate", "Find out why", str(work), "auto", "opus", "acceptEdits", ["claude"], cfg,
                                          launch=False, chain=lanes.chain_from("fix-review", "Export"))
                self.assertEqual(first["chain_of"]["of"], 3)
                (lanes.lane_dir(first["id"]) / "REPORT.md").write_text("STATUS: DONE - the cache key ignores the locale\n")
                with mock.patch.object(lanes, "start_unit"):
                    first["status"] = "done"
                    lanes._next_stage(first, cfg)
                second = lanes.load_lane(lanes.load_lane(first["id"])["chain_next"])
                self.assertEqual((second["title"], second["chain_of"]["step"], len(second["chain"])), ("Fix: Export", 2, 1))
                brief = (lanes.lane_dir(second["id"]) / "brief.md").read_text()
                self.assertIn("the cache key ignores the locale", brief)
                self.assertIn("stage 2 of 3", brief)
                blocked = dict(second, status="blocked")
                lanes._next_stage(blocked, cfg)                       # a blocked stage stops the chain
                self.assertNotIn("chain_next", lanes.load_lane(second["id"]))



class ScheduleTests(unittest.TestCase):
    def test_when_a_scheduled_lane_starts(self):
        from office import lanes
        now = 1_000_000.0
        self.assertIsNone(lanes.schedule_from(None))
        self.assertEqual(lanes.schedule_from({"at": now + 3600}, now), {"at": now + 3600})
        self.assertEqual(lanes.schedule_from({"left": 30}, now), {"left": 30})
        for bad in ({"at": now + 8 * 86400}, {"at": True}, {"left": 2}, {"left": "30"}, {"when": 1}, "soon"):
            with self.assertRaises(ValueError):
                lanes.schedule_from(bad, now)
        seat = lambda five, status="idle", week=10: {"kind": "claude", "status": status, "usage": {"five_hour": {"pct": five}, "weekly": {"pct": week}}}
        self.assertFalse(lanes.due({"schedule": {"at": now + 60}}, [], now))
        self.assertTrue(lanes.due({"schedule": {"at": now - 1}}, [], now))
        self.assertFalse(lanes.due({"schedule": {"left": 30}}, [seat(80), seat(95, "limited")], now))
        self.assertTrue(lanes.due({"schedule": {"left": 30}}, [seat(80), seat(60)], now))
        self.assertFalse(lanes.due({"schedule": {"left": 30}}, [seat(10, week=99)], now))      # out of its week


class LanePolicyTests(unittest.TestCase):
    """lane_policy: where unattended lanes may work, whether they get full trust, and their systemd caps."""

    def test_the_policy_reads_safely(self):
        p = lanes.policy({"lane_policy": {"roots": ["~/work", 3, ""], "memory_max": "8G; rm -rf /", "tasks_max": True}})
        self.assertEqual(p["roots"], [os.path.realpath(os.path.expanduser("~/work"))])
        self.assertIsNone(p["memory_max"])
        self.assertIsNone(p["tasks_max"])
        self.assertTrue(p["allow_full_trust"])
        self.assertEqual(lanes.policy({})["roots"], [])
        self.assertEqual(lanes.unit_limits({"lane_policy": {"memory_max": "50%", "tasks_max": 4096}}),
                         ["-p", "MemoryMax=50%", "-p", "TasksMax=4096"])
        self.assertEqual(lanes.unit_limits({"lane_policy": {"memory_max": "", "tasks_max": 0}}), [])

    def test_full_trust_is_never_given_in_home_or_root(self):
        cfg = {"lane_policy": {}}
        home = os.path.realpath(str(lanes.config.HOME))
        for wd in ("/", home):
            with self.assertRaisesRegex(ValueError, "never given"):
                lanes.check_policy(wd, "bypassPermissions", cfg)
            lanes.check_policy(wd, "acceptEdits", cfg)                      # edits only: allowed
        lanes.check_policy(os.path.join(home, "proj"), "bypassPermissions", cfg)

    def test_roots_and_the_full_trust_switch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.realpath(tmp)
            cfg = {"lane_policy": {"roots": [root], "allow_full_trust": False}}
            lanes.check_policy(root, "acceptEdits", cfg)
            lanes.check_policy(os.path.join(root, "a", "b"), "acceptEdits", cfg)
            with self.assertRaisesRegex(ValueError, "outside"):
                lanes.check_policy(root + "-evil", "acceptEdits", cfg)       # a sibling with the same prefix
            with self.assertRaisesRegex(ValueError, "Full trust is off"):
                lanes.check_policy(root, "bypassPermissions", cfg)

    def test_create_lane_refuses_what_the_policy_forbids_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(lanes, "lanes_dir", return_value=Path(tmp) / "lanes"):
            cfg = {"default_workdir": tmp, "lane_policy": {"roots": [os.path.join(tmp, "only")]}, "lane_defaults": {}}
            with self.assertRaisesRegex(ValueError, "outside"):
                lanes.create_lane("t", "b", tmp, "auto", "opus", "acceptEdits", ["c"], cfg, launch=False)
            self.assertFalse((Path(tmp) / "lanes").exists() and any((Path(tmp) / "lanes").iterdir()))


class LongBacklogTests(unittest.TestCase):
    def test_older_unfinished_lanes_stay_listed_with_their_place_in_line(self):
        import time as _t
        with tempfile.TemporaryDirectory() as tmp, patch.object(lanes, "lanes_dir", return_value=Path(tmp)), \
                patch.object(lanes, "active_lane_units", return_value=set()):
            for i in range(20):                           # the backlog, made first (oldest files)
                d = Path(tmp) / f"b{i:02d}"; d.mkdir()
                (d / "lane.json").write_text(json.dumps({"id": f"b{i:02d}", "title": "b", "status": "scheduled", "created_at": i,
                                                         "schedule": {"backlog": True, "order": i}}))
            _t.sleep(0.02)
            for i in range(45):                           # then 45 finished lanes, changed more recently
                d = Path(tmp) / f"d{i:02d}"; d.mkdir()
                (d / "lane.json").write_text(json.dumps({"id": f"d{i:02d}", "title": "d", "status": "done", "created_at": 100 + i}))
            listed = {l["id"]: l for l in lanes.list_lanes()}
            self.assertTrue(all(f"b{i:02d}" in listed for i in range(20)))
            self.assertEqual(listed["b00"]["backlog_pos"], 0)
            self.assertEqual(listed["b19"]["backlog_pos"], 19)


class MemoryCapTests(unittest.TestCase):
    def test_memory_caps_read_as_systemd_takes_them(self):
        self.assertEqual([lanes._mem(x) for x in ("8G", "8g", "0", "0%", "512m", "50%", "abc", "", "1.5G")],
                         ["8G", "8G", None, None, "512M", "50%", None, None, "1.5G"])
        self.assertEqual(lanes.unit_limits({"lane_policy": {"memory_max": "0", "tasks_max": 0}}), [])


class BakeoffTests(unittest.TestCase):
    def test_two_contenders_one_brief_and_a_verdict(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(lanes, "lanes_dir", return_value=Path(tmp) / "lanes"):
            cfg = {"default_workdir": tmp, "lane_policy": {}, "lane_defaults": {"model": "opus"}}
            with patch.object(lanes, "start_unit") as su:
                a, b = lanes.hire_bakeoff("Cache the table", "Make it fast.", tmp, {"A": {"seat": "c1", "model": "opus"}, "B": {"seat": "c2", "model": "sonnet"}},
                                          "acceptEdits", ["c1", "c2"], cfg)
            self.assertEqual(su.call_count, 2)
            self.assertEqual((a["title"], b["title"]), ("Cache the table · A", "Cache the table · B"))
            self.assertEqual((a["seat_pref"], b["model"]), ("c1", "sonnet"))
            bid = a["bakeoff"]["id"]
            self.assertEqual(b["bakeoff"], {"id": bid, "side": "B"})
            brief = (lanes.lane_dir(a["id"]) / "brief.md").read_text()
            self.assertIn(f"bakeoff/{bid}-a", brief)
            self.assertIn("contender A", brief)
            with self.assertRaises(ValueError):
                lanes.judge_bakeoff(bid, "C")
            lanes.judge_bakeoff(bid, "B")
            self.assertEqual({lanes.load_lane(x["id"])["bakeoff"]["winner"] for x in (a, b)}, {"B"})
            with self.assertRaises(ValueError):
                lanes.judge_bakeoff("nope", "A")

    def test_ready_to_judge_needs_you_once_both_finish(self):
        from office.snapshot import Office, attention_key
        pair = [{"id": "x-a", "title": "T · A", "status": "done", "bakeoff": {"id": "b1", "side": "A"}},
                {"id": "x-b", "title": "T · B", "status": "running", "bakeoff": {"id": "b1", "side": "B"}}]
        snap = {"now": 1.0, "asks": [], "units": [], "office": {}, "seats": [], "lanes": pair}
        self.assertFalse([a for a in Office._attention(snap) if a.get("bakeoff")])
        pair[1]["status"] = "blocked"
        items = [a for a in Office._attention(snap) if a.get("bakeoff")]
        self.assertEqual(items[0]["text"], "Bake-off 'T' is ready to judge: A done, B blocked")
        self.assertEqual(attention_key(items[0]), "bakeoff:b1")
        pair[0]["bakeoff"]["winner"] = "A"
        self.assertFalse([a for a in Office._attention(snap) if a.get("bakeoff")])

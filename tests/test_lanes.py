"""Lane filesystem tests. All output is temporary and process launches are forbidden."""
from copy import deepcopy
import json
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

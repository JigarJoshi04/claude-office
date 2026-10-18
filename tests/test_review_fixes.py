"""Regression tests for the adversarial review findings."""
import json
import tempfile
import unittest
from pathlib import Path

from unittest.mock import patch

from office import config, divider, lanes, sessions


def seat(sid, lanes=0, p5=50.0, pw=50.0):
    return {"id": sid, "kind": "claude", "lanes": lanes, "health": {"state": "ok"},
            "usage": {"five_hour": {"pct": p5}, "weekly": {"pct": pw}}}


class DividerFixes(unittest.TestCase):
    def test_headroom_mode_keeps_relative_weights_when_headroom_is_equal(self):
        cfg = divider.validate({"mode": "headroom", "global_max_lanes": 9,
                                "seats": {"a": {"weight": 80, "max_lanes": 9}, "b": {"weight": 20, "max_lanes": 9}}},
                               ["a", "b"])
        fixed = dict(cfg, mode="fixed")
        seats = [seat("a", lanes=1), seat("b", lanes=0)]
        self.assertEqual(divider.evaluate(seats, cfg)["pick"], divider.evaluate(seats, fixed)["pick"])

    def test_headroom_still_shifts_work_off_a_spent_seat(self):
        cfg = divider.validate({"mode": "headroom", "global_max_lanes": 9,
                                "seats": {"a": {"weight": 50, "max_lanes": 9}, "b": {"weight": 50, "max_lanes": 9}}},
                               ["a", "b"])
        self.assertEqual(divider.evaluate([seat("a", p5=85), seat("b", p5=10)], cfg)["pick"], "b")

    def test_validate_survives_wrong_shapes_and_infinity(self):
        for body in ({"seats": ["bad"]}, {"seats": {"a": "bad"}}, {"global_max_lanes": float("inf")},
                     {"seats": {"a": {"weight": float("inf"), "max_lanes": float("nan")}}}, ["not", "a", "dict"],
                     {"five_hour_guard": True}):
            out = divider.validate(body, ["a"])
            self.assertIn("a", out["seats"])
            self.assertIsInstance(out["seats"]["a"]["weight"], int)
            json.dumps(out)


class TranscriptFixes(unittest.TestCase):
    def test_odd_json_records_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "t.jsonl"
            good = {"type": "assistant", "timestamp": "2026-10-16T10:00:00Z",
                    "message": {"id": "m1", "model": "claude-opus-5-5", "usage": {"input_tokens": 1, "output_tokens": 2},
                                "content": [{"type": "text", "text": "still alive"}]}}
            lines = ["null", "[]", "42", '"text"', json.dumps({"type": "assistant", "message": None}),
                     json.dumps({"type": "assistant", "message": {"content": "not a list", "usage": []}}),
                     json.dumps({"type": "user", "message": {"content": None}}), json.dumps(good)]
            p.write_text("\n".join(lines) + "\n")
            st = sessions.TranscriptCache().read(p)
            self.assertEqual(st.last_text, "still alive")

    def test_secrets_are_masked_before_reaching_the_page(self):
        fake = "sk-ant-oat01-" + "A" * 40
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "t.jsonl"
            rec = {"type": "assistant", "timestamp": "2026-10-16T10:00:00Z",
                   "message": {"id": "m1", "model": "claude-opus-5-5", "usage": {},
                               "content": [{"type": "text", "text": f"the key is {fake} ok"},
                                           {"type": "tool_use", "name": "Bash",
                                            "input": {"command": "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123'"}}]}}
            p.write_text(json.dumps(rec) + "\n")
            st = sessions.TranscriptCache().read(p)
            blob = json.dumps([st.last_text, st.activity, st.recent])
            self.assertNotIn(fake, blob)
            self.assertNotIn("abcdefghijklmnopqrstuvwxyz123", blob)

    def test_redact_leaves_ordinary_ids_alone(self):
        sha = "4bd433658" + "0" * 31
        self.assertEqual(sessions.redact(f"merged {sha} in PR #1630"), f"merged {sha} in PR #1630")
        self.assertIn("[hidden]", sessions.redact("password=hunter2hunter2"))
        self.assertIn("[hidden]", sessions.redact("ghp_" + "x" * 36))


class LaunchFixes(unittest.TestCase):
    def test_runner_never_imports_code_from_the_lane_workdir(self):
        # `python -m office` imports from its current directory first. A lane whose workdir holds an `office/`
        # package (any checkout of this repo, or a hostile folder) must not get to run that code as the runner.
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp) / "work"
            (work / "office").mkdir(parents=True)
            lane = {"id": "x", "workdir": str(work)}
            ran = []
            done = type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            with patch.object(lanes, "load_lane", return_value=lane), patch.object(lanes, "save_lane"), \
                 patch.object(lanes, "unit_active", return_value=False), \
                 patch.object(lanes.subprocess, "run", side_effect=lambda cmd, **k: ran.append(cmd) or done):
                lanes.start_unit("x")
            wd = [a for a in ran[0] if a.startswith("--working-directory=")]
            self.assertEqual(wd, [f"--working-directory={config.REPO_DIR}"])
            self.assertEqual(ran[0][-4:], ["-m", "office", "run-lane", "x"])


if __name__ == "__main__":
    unittest.main()


class Qa16Fixes(unittest.TestCase):
    """The review of 3.45–3.62."""

    def test_blocked_means_a_blocked_status_not_the_word(self):
        for line in ("STATUS: BLOCKED - need creds", "**Status:** blocked on review", "BLOCKED: no access", "# STATUS: BLOCKED"):
            self.assertTrue(sessions.report_blocked(line), line)
        for line in ("STATUS: DONE - unblocked the release pipeline", "STATUS: DONE", "Status: done, not blocked", None, ""):
            self.assertFalse(sessions.report_blocked(line), line)

    def test_helpers_dock_when_they_finish_while_the_session_is_busy(self):
        st = sessions.TranscriptState(Path("/x.jsonl"))
        use = json.dumps({"type": "assistant", "timestamp": "2026-10-18T10:00:00Z", "message": {"id": "m1", "content": [
            {"type": "tool_use", "id": "toolu_A", "name": "Agent", "input": {"description": "look", "run_in_background": True}}]}}).encode()
        launched = json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_A", "content": "Async agent launched successfully."}]}}).encode()
        queued = json.dumps({"type": "attachment", "attachment": {"type": "queued_command", "prompt":
            "<task-notification>\n<task-id>x</task-id>\n<tool-use-id>toolu_A</tool-use-id>\n<status>completed</status>\n</task-notification>"}}).encode()
        for line in (use, launched):
            st.feed_line(line)
        self.assertEqual((len(st.helpers), st.helpers_done), (1, 0))
        st.feed_line(queued)
        self.assertEqual((len(st.helpers), st.helpers_done), (0, 1))

    def test_a_state_file_that_is_not_utf8_is_set_aside(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "career.json"
            p.write_bytes(b'{"a": "\xff"}')
            self.assertIsNone(config.read_state(p))
            self.assertFalse(p.exists())
            self.assertEqual(len(list(Path(tmp).glob("career.json.broken-*"))), 1)

    def test_a_hand_edited_quiet_file_never_stops_the_office(self):
        from office.snapshot import Quiet
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "quiet.json"
            for bad in ({"dnd_until": "x"}, {"snoozed": ["a"]}, {"dnd_until": True, "snoozed": {"k": "soon", "j": 5.0}}):
                p.write_text(json.dumps(bad))
                q = Quiet(p).get()
                self.assertIsInstance(q["dnd_until"], float)
                self.assertTrue(all(isinstance(v, float) for v in q["snoozed"].values()))

    def test_waiting_and_failed_are_two_things_to_snooze(self):
        from office.snapshot import attention_key
        self.assertNotEqual(attention_key({"lane": "l1", "status": "waiting"}), attention_key({"lane": "l1", "status": "failed"}))

    def test_a_left_schedule_ignores_seats_that_cannot_work(self):
        s = lambda **k: dict({"kind": "claude", "status": "idle", "usage": {"five_hour": {"pct": 10}, "weekly": {"pct": 10}}}, **k)
        lane = {"schedule": {"left": 30}}
        self.assertTrue(lanes.due(lane, [s()], 0))
        for out in (s(status="benched"), s(status="offline"), s(divider={"enabled": False}), s(health={"state": "login"})):
            self.assertFalse(lanes.due(lane, [out], 0), out)

    def test_old_scheduled_lanes_start_and_an_early_start_leaves_the_schedule(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "lanes"
            root.mkdir()
            for i in range(45):                                       # more lanes than the list shows
                (root / f"l{i}").mkdir()
                (root / f"l{i}" / "lane.json").write_text(json.dumps({"id": f"l{i}", "status": "scheduled" if i == 0 else "done",
                                                                      "schedule": {"at": 1.0}, "title": "t"}))
            with patch.object(lanes, "lanes_dir", return_value=root), patch.object(lanes, "start_unit") as start, \
                    patch.object(lanes, "active_lane_units", return_value=set()):
                self.assertEqual([l["id"] for l in lanes.unfinished_lanes()], ["l0"])
                started = lanes.start_scheduled([], now=10.0)
                self.assertEqual([l["id"] for l in started], ["l0"])
                start.assert_called_once_with("l0")
                (root / "l1" / "lane.json").write_text(json.dumps({"id": "l1", "status": "scheduled", "schedule": {"at": 9e9}, "title": "t"}))
                lanes.resume_lane("l1", None, [])
                self.assertEqual(lanes.load_lane("l1")["status"], "queued")

    def test_a_finished_stage_run_again_does_not_start_its_next_stage_twice(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "lanes"
            (root / "l1").mkdir(parents=True)
            (root / "l1" / "lane.json").write_text(json.dumps({"id": "l1", "status": "done", "title": "t", "chain": [{"title": "b", "brief": "x"}],
                                                              "chain_next": "l2"}))
            (root / "l1" / "REPORT.md").write_text("STATUS: DONE - unblocked it\n")
            with patch.object(lanes, "lanes_dir", return_value=root), patch.object(lanes.config, "load_config", return_value={}), \
                    patch.object(lanes, "_next_stage") as nxt:
                self.assertEqual(lanes.run_lane("l1"), 0)
                nxt.assert_not_called()
                self.assertEqual(lanes.load_lane("l1")["status"], "done")

    def test_the_week_of_merged_prs_is_fetched_whole(self):
        from office import prs
        calls = []
        def run(cmd, **kw):
            calls.append(cmd)
            state = cmd[cmd.index("--state") + 1]
            out = {"open": [{"number": 1, "state": "OPEN"}], "all": [{"number": 1, "state": "OPEN"}, {"number": 2, "state": "MERGED"}],
                   "merged": [{"number": n, "state": "MERGED", "mergedAt": "2026-10-18T10:00:00Z"} for n in range(2, 300)]}[state]
            return type("R", (), {"returncode": 0, "stdout": json.dumps(out)})()
        with patch.object(prs.shutil, "which", return_value="/usr/bin/gh"), patch.object(prs.subprocess, "run", side_effect=run):
            got = prs.fetch("acme/rocket")
        self.assertEqual(len(got), 299)                                # 1 open + 298 merged, each once
        merged_call = next(c for c in calls if c[c.index("--state") + 1] == "merged")
        self.assertIn("--search", merged_call)
        self.assertTrue(merged_call[merged_call.index("--search") + 1].startswith("merged:>="))


class RebootRecoveryTests(unittest.TestCase):
    def _lanes(self, tmp, **lane):
        root = Path(tmp) / "lanes"
        (root / "l1").mkdir(parents=True)
        (root / "l1" / "lane.json").write_text(json.dumps(dict({"id": "l1", "title": "Migrate", "status": "running", "created_at": 1.0}, **lane)))
        return root

    def test_a_lane_whose_unit_vanished_is_interrupted_and_kept(self):
        import time
        with tempfile.TemporaryDirectory() as tmp:
            root = self._lanes(tmp, unit_started_at=time.time() - 600, boot_id="old-boot")
            with patch.object(lanes, "lanes_dir", return_value=root), patch.object(lanes, "boot_id", return_value="new-boot"):
                with patch.object(lanes, "active_lane_units", return_value=None):      # systemd could not be asked: no change
                    self.assertEqual(lanes.list_lanes()[0]["status"], "running")
                with patch.object(lanes, "active_lane_units", return_value=set()):
                    l = lanes.list_lanes()[0]
                self.assertEqual((l["status"], l["reboot"]), ("interrupted", True))
                saved = lanes.load_lane("l1")
                self.assertEqual(saved["status"], "interrupted")                       # kept, not only shown
                self.assertNotIn("unit_active", saved)
                self.assertEqual([x["id"] for x in lanes.interrupted_lanes()], ["l1"])
                with patch.object(lanes, "start_unit") as start:
                    self.assertEqual(lanes.resume_interrupted(["claude"], gap=0), ["l1"])
                    start.assert_called_once_with("l1")

    def test_just_started_or_stopped_lanes_are_not_interrupted(self):
        import time
        for extra in ({"unit_started_at": time.time() - 5}, {"unit_started_at": time.time() - 600, "stop_requested": 1.0}, {}):
            with tempfile.TemporaryDirectory() as tmp:
                root = self._lanes(tmp, **extra)
                with patch.object(lanes, "lanes_dir", return_value=root), patch.object(lanes, "active_lane_units", return_value=set()):
                    self.assertEqual(lanes.list_lanes()[0]["status"], "stopped", extra)
                    self.assertEqual(lanes.load_lane("l1")["status"], "running")      # shown as stopped, file untouched

    def test_one_needs_you_item_for_every_lane_cut_off(self):
        from office.snapshot import Office, attention_key
        snap = {"now": 1000.0, "seats": [], "units": [], "asks": [], "lanes": [
            {"id": "a", "title": "A", "status": "interrupted", "reboot": True, "interrupted_at": 900.0},
            {"id": "b", "title": "B", "status": "interrupted", "interrupted_at": 950.0}]}
        items = [a for a in Office._attention(snap) if a.get("interrupted")]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["interrupted"], ["a", "b"])
        self.assertIn("2 office lanes were cut off by a restart", items[0]["text"])
        self.assertEqual(attention_key(items[0]), "interrupted:")

    def test_the_hourly_checkpoint_never_writes_over_one_with_sessions(self):
        from office import checkpoint
        with tempfile.TemporaryDirectory() as tmp:
            cfg = {"checkpoint_dir": tmp}
            empty = {"now": 1.0, "seats": [{"id": "c", "label": "c", "kind": "claude", "config_dir": "/c", "sessions": []}]}
            self.assertIsNone(checkpoint.write_latest(empty, cfg))
            live = {"now": 2.0, "seats": [{"id": "c", "label": "c", "kind": "claude", "config_dir": "/c", "sessions": [
                {"id": "s1", "name": "api", "kind": "desk", "live": True, "cwd": "/w/api", "git": {"branch": "main"}}]}]}
            path = checkpoint.write_latest(live, cfg)
            self.assertTrue(path.endswith("resume-latest.sh"))
            self.assertIn("claude --resume s1", Path(path).read_text())
            self.assertEqual(Path(path).stat().st_mode & 0o777, 0o700)
            self.assertIsNone(checkpoint.write_latest(empty, cfg))                    # after a restart: still there
            self.assertIn("s1", Path(path).read_text())

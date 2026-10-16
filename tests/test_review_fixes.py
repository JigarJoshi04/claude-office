"""Regression tests for the adversarial review findings."""
import json
import tempfile
import time
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

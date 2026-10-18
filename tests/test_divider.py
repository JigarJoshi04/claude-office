"""Pure divider tests: no account discovery, credentials, or external services."""
import time
import unittest
from unittest.mock import patch

from office import divider


def seat(sid, lanes=0, pct=0, **overrides):
    return dict(dict(id=sid, kind="claude", lanes=lanes, health={"state": "ok"},
                     usage={"five_hour": {"pct": pct}, "weekly": {"pct": 0}}), **overrides)


class DividerTests(unittest.TestCase):
    def cfg(self, ids=("a", "b"), **body):
        return divider.validate(body, list(ids))

    def test_validate_clamps_and_drops_unknown_keys(self):
        with patch.object(divider.time, "time", return_value=1234):
            cfg = self.cfg(mode="junk", global_max_lanes=100, five_hour_guard=-1,
                           weekly_guard=101, unknown="drop", seats={
                               "a": {"enabled": False, "weight": -1, "max_lanes": 99,
                                     "note": "x" * 300, "secret": "drop"},
                               "b": {"weight": 101, "max_lanes": -1}, "unknown": {}})
        self.assertEqual(set(cfg), set(divider.DEFAULTS))
        self.assertEqual(cfg["mode"], "headroom")
        self.assertEqual(cfg["global_max_lanes"], 32)
        self.assertEqual(cfg["five_hour_guard"], 10)
        self.assertEqual(cfg["weekly_guard"], 100)
        self.assertEqual(cfg["updated_at"], 1234)
        self.assertEqual(set(cfg["seats"]), {"a", "b"})
        self.assertEqual(cfg["seats"]["a"], {
            "enabled": False, "weight": 0, "max_lanes": 16, "note": "x" * 200, "free_hours": None})
        self.assertEqual(cfg["seats"]["b"]["weight"], 100)
        self.assertEqual(cfg["seats"]["b"]["max_lanes"], 0)

    def test_validate_defaults_for_bad_numeric_values_and_null_seats(self):
        for junk in (None, "junk", [], {}):
            with self.subTest(junk=junk):
                cfg = self.cfg(global_max_lanes=junk, five_hour_guard=junk, weekly_guard=junk,
                               seats={"a": {"weight": junk, "max_lanes": junk}, "b": None})
                for key in ("global_max_lanes", "five_hour_guard", "weekly_guard"):
                    self.assertEqual(cfg[key], divider.DEFAULTS[key])
                self.assertEqual(cfg["seats"]["a"], divider.DEFAULT_SEAT)
                self.assertEqual(cfg["seats"]["b"], divider.DEFAULT_SEAT)
        self.assertEqual(self.cfg(seats=None)["seats"]["a"], divider.DEFAULT_SEAT)
        self.assertEqual(self.cfg(global_max_lanes=-1)["global_max_lanes"], 0)
        self.assertEqual(self.cfg(seats={"a": {"weight": "42"}})["seats"]["a"]["weight"], 42)

    def test_picks_seat_furthest_below_weighted_share(self):
        cfg = self.cfg(mode="fixed", seats={"a": {"weight": 75, "max_lanes": 4},
                                            "b": {"weight": 25, "max_lanes": 4}})
        ev = divider.evaluate([seat("a", 2), seat("b")], cfg)
        self.assertEqual(ev["pick"], "b")
        scores = {r["seat"]: r["score"] for r in ev["ranking"]}
        self.assertEqual(scores, {"a": .25, "b": .75})
        self.assertIn("b: target share 25%", ev["why"])
        self.assertEqual(divider.evaluate([seat("a"), seat("b", 1)], cfg)["pick"], "a")

    def test_each_blocker_prevents_assignment_and_explains_why(self):
        cases = [
            ({"enabled": False}, {}, {}, "benched"),
            ({"weight": 0}, {}, {}, "weight 0"),
            ({"max_lanes": 1}, {"lanes": 1}, {}, "at its cap"),
            ({"max_lanes": 0}, {}, {}, "at its cap"),
            ({}, {"usage": {"five_hour": {"pct": 90}}}, {}, "5-hour window at 90%"),
            ({}, {"usage": {"weekly": {"pct": 90}}}, {}, "weekly at 90%"),
            ({}, {"health": {"state": "login"}}, {}, "needs /login"),
            ({}, {}, {"exclude": ("a",)}, "excluded"),
            ({}, {}, {"kind": "codex"}, "not a codex seat"),
            ({}, {}, {"limited_until": {"a": 1001}}, "hit its limit, resting until"),
        ]
        for options, fields, kwargs, reason in cases:
            with self.subTest(reason=reason):
                cfg = self.cfg(ids=("a",), seats={"a": options})
                ev = divider.evaluate([seat("a", **fields)], cfg, now=1000, **kwargs)
                self.assertIsNone(ev["pick"])
                self.assertFalse(ev["ranking"][0]["eligible"])
                self.assertIn(reason, ev["why"])
                self.assertTrue(ev["why"].startswith("No seat can take a lane:"))

    def test_global_cap_counts_all_kinds_and_disabled_seats(self):
        cfg = self.cfg(global_max_lanes=1, seats={"a": {"enabled": False}})
        ev = divider.evaluate([seat("a", 1, kind="codex"), seat("b")], cfg, kind="claude")
        self.assertIsNone(ev["pick"])
        self.assertIn("office at its lane cap (1/1)", ev["why"])
        self.assertIsNone(divider.evaluate([seat("a")], self.cfg(global_max_lanes=0))["pick"])

    def test_expired_limit_and_usage_below_guards_are_eligible(self):
        for until in (999, 1000):
            with self.subTest(until=until):
                ev = divider.evaluate([seat("a", pct=89, health={"state": "stale"})],
                                      self.cfg(ids=("a",)), now=1000, limited_until={"a": until})
                self.assertEqual(ev["pick"], "a")

    def test_kind_and_exclude_leave_the_correct_candidate(self):
        seats = [seat("a"), seat("b", kind="codex"), seat("c", kind="codex")]
        ev = divider.evaluate(seats, self.cfg(ids=("a", "b", "c")), kind="codex", exclude=("b",))
        self.assertEqual(ev["pick"], "c")

    def test_fixed_vs_headroom_changes_the_pick(self):
        seats = [seat("a", pct=80), seat("b", pct=0)]
        weights = {"a": {"weight": 75}, "b": {"weight": 25}}
        self.assertEqual(divider.evaluate(seats, self.cfg(mode="fixed", seats=weights))["pick"], "a")
        self.assertEqual(divider.evaluate(seats, self.cfg(mode="headroom", seats=weights))["pick"], "b")

    def test_empty_seats_and_missing_usage(self):
        ev = divider.evaluate([], self.cfg(ids=()))
        self.assertIsNone(ev["pick"])
        self.assertEqual(ev["ranking"], [])
        self.assertIn("No seat can take a lane", ev["why"])
        for usage in (None, {}, {"five_hour": None, "weekly": {"pct": None}}):
            with self.subTest(usage=usage):
                ev = divider.evaluate([seat("a", usage=usage, health=None)], self.cfg(ids=("a",)))
                self.assertEqual(ev["pick"], "a")
                self.assertEqual(ev["ranking"][0]["headroom"], .5)

    def test_headroom_uses_tightest_window_and_returns_next_reset(self):
        seats = [seat("a", usage={"five_hour": {"pct": 10, "resets_at": 2000},
                                  "weekly": {"pct": 70}}),
                 seat("b", usage={"five_hour": {"pct": 120, "resets_at": 1500}})]
        self.assertAlmostEqual(divider.headroom(seats[0]), .3)
        self.assertEqual(divider.headroom(seats[1]), 0)
        self.assertEqual(divider.evaluate(seats, self.cfg())["next_reset"], 1500)

    def test_suggest_sums_to_100_and_gives_benched_and_logged_out_zero(self):
        seats = [seat(sid) for sid in "abcde"]
        seats[-1]["health"] = {"state": "login"}
        cfg = self.cfg(ids=tuple("abcde"), seats={"d": {"enabled": False}})
        suggested = divider.suggest(seats, cfg)
        self.assertEqual(sum(suggested.values()), 100)
        self.assertEqual(suggested["d"], 0)
        self.assertEqual(suggested["e"], 0)
        self.assertEqual(sorted(suggested[s] for s in "abc"), [33, 33, 34])
        self.assertEqual(divider.suggest([], self.cfg(ids=())), {})
        self.assertEqual(divider.suggest([seat("a", pct=100)], self.cfg(ids=("a",))), {"a": 0})


if __name__ == "__main__":
    unittest.main()


class PaceModeTests(unittest.TestCase):
    """Divider v2: spend each seat's week evenly, keep seats free in chosen hours, mind a model's own weekly cap."""
    NOW = 1_800_000_000.0

    def seat(self, sid, pw, days_left, p5=10.0, scoped=()):
        return {"id": sid, "kind": "claude", "lanes": 0, "health": {"state": "ok"},
                "usage": {"five_hour": {"pct": p5, "resets_at": self.NOW + 3600},
                          "weekly": {"pct": pw, "resets_at": self.NOW + days_left * 86400}, "scoped": list(scoped)}}

    def cfg(self, mode="pace", **seats):
        c = divider.validate({"mode": mode, "seats": {k: dict({"weight": 50}, **v) for k, v in seats.items()}}, list(seats))
        return c

    def test_pace_is_plan_left_per_share_of_the_week_left(self):
        self.assertAlmostEqual(divider.pace(self.seat("a", 50, 3.5), self.NOW), 1.0)
        self.assertAlmostEqual(divider.pace(self.seat("a", 40, 1), self.NOW), 3.0)          # 60% left, a day to go: capped
        self.assertAlmostEqual(divider.pace(self.seat("a", 80, 5), self.NOW), 0.28, places=2)
        self.assertIsNone(divider.pace({"id": "x", "usage": {}}, self.NOW))
        self.assertEqual(divider.pace(self.seat("a", 100, 2), self.NOW), 0.0)

    def test_pace_mode_sends_the_lane_to_the_seat_behind_its_week(self):
        seats = [self.seat("ahead", 70, 5), self.seat("behind", 50, 1.5)]
        headroom = divider.evaluate(seats, self.cfg("headroom", ahead={}, behind={}), now=self.NOW)
        paced = divider.evaluate(seats, self.cfg("pace", ahead={}, behind={}), now=self.NOW)
        self.assertEqual(paced["pick"], "behind")
        self.assertIn("behind its week", paced["why"])
        self.assertGreater(next(r["target"] for r in paced["ranking"] if r["seat"] == "behind"),
                           next(r["target"] for r in headroom["ranking"] if r["seat"] == "behind"))

    def test_free_hours_block_inside_them_and_wrap_past_midnight(self):
        lt = time.localtime(self.NOW)
        h = lt.tm_hour
        inside = [h, (h + 2) % 24 or 24]
        outside = [(h + 2) % 24, (h + 4) % 24 or 24]
        self.assertIsNotNone(divider.kept_free(inside, self.NOW))
        self.assertIsNone(divider.kept_free(outside, self.NOW))
        self.assertIsNotNone(divider.kept_free([0, 24], self.NOW))
        self.assertIsNotNone(divider.kept_free([(h - 1) % 24, (h + 1) % 24 or 24], self.NOW))   # wraps when h is 0
        ev = divider.evaluate([self.seat("a", 10, 3)], self.cfg(a={"free_hours": inside}), now=self.NOW)
        self.assertIsNone(ev["pick"])
        self.assertTrue(any("kept free for you until" in b for b in ev["ranking"][0]["blockers"]))

    def test_free_hours_are_checked(self):
        for bad in ([9], [9, 9], [25, 3], ["9", "18"], [True, 18], "9-18", [0, 0]):
            self.assertIsNone(divider._hours(bad), bad)
        self.assertEqual(divider._hours([22, 6]), [22, 6])
        self.assertEqual(divider._hours([0, 24]), [0, 24])

    def test_a_model_whose_week_is_spent_keeps_the_lane_off_that_seat(self):
        seats = [self.seat("a", 20, 3, scoped=[{"label": "Opus", "pct": 96.0}]), self.seat("b", 60, 3)]
        cfg = self.cfg("headroom", a={}, b={})
        self.assertEqual(divider.evaluate(seats, cfg, now=self.NOW)["pick"], "a")
        ev = divider.evaluate(seats, cfg, now=self.NOW, model="claude-opus-5-5")
        self.assertEqual(ev["pick"], "b")
        self.assertIn("its Opus week at 96%", next(r for r in ev["ranking"] if r["seat"] == "a")["blockers"])
        self.assertEqual(divider.evaluate(seats, cfg, now=self.NOW, model="sonnet")["pick"], "a")

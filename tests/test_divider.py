"""Pure divider tests: no account discovery, credentials, or external services."""
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
            "enabled": False, "weight": 0, "max_lanes": 16, "note": "x" * 200})
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

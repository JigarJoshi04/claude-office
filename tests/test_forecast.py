"""The next seven days of plan (office/forecast.py)."""
import unittest

from office.forecast import capacity, seat_capacity, WEEK


def seat(sid, pct, resets, status="working", enabled=True):
    return {"id": sid, "kind": "claude", "status": status, "divider": {"enabled": enabled}, "usage": {"weekly": {"pct": pct, "resets_at": resets}}}


class ForecastTests(unittest.TestCase):
    def test_run_dry_at_this_weeks_pace(self):
        now = 1_000_000.0
        start = now - 2 * 86400                                       # two days into the week, 40% used: 20% a day
        c = seat_capacity(seat("a", 40, start + WEEK), now, guard=90)
        self.assertAlmostEqual(c["out_at"], start + 2 * 86400 * 90 / 40)   # 4.5 days in
        self.assertFalse(c["out_now"])
        self.assertIsNone(seat_capacity(seat("b", 10, start + WEEK), now, 90)["out_at"])   # lasts the week
        self.assertEqual(seat_capacity(seat("c", 96, start + WEEK), now, 90)["out_at"], now)   # out already
        self.assertIsNone(seat_capacity({"id": "x", "kind": "codex"}, now))

    def test_dry_spells_only_when_every_seat_on_duty_is_out(self):
        now, start = 1_000_000.0, 1_000_000.0 - 2 * 86400
        a, b = seat("a", 40, start + WEEK), seat("b", 45, start + WEEK + 86400)
        cap = capacity([a, b], now, guard=90)
        lo = max(x["out_at"] for x in cap["seats"])
        self.assertEqual(cap["dry"], [[lo, start + WEEK]])               # from the last to run out to the first reset
        self.assertEqual(capacity([a, b, seat("c", 5, start + WEEK)], now, 90)["dry"], [])   # one seat lasts: never dry
        self.assertEqual(capacity([a, b, seat("c", 5, start + WEEK, enabled=False)], now, 90)["dry"], cap["dry"])   # holiday seats do not count

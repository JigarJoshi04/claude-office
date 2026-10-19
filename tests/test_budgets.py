"""Budgets (budgets.py): checked settings, and the sums for a day, a week from Monday and a month, per seat or office."""
import unittest
from datetime import date

from office import budgets

PER = {("2026-10-19", "c2"): [1_000_000, 0, 0, 30.0], ("2026-10-19", "c3"): [500_000, 0, 0, 10.0],
       ("2026-10-18", "c2"): [2_000_000, 0, 0, 50.0],                # Sunday: last week
       ("2026-10-05", "c2"): [9_000_000, 0, 0, 100.0], ("2026-09-30", "c2"): [1, 0, 0, 999.0], ("2026-10-19", None): [7, 0, 0, 1.0]}


class BudgetTests(unittest.TestCase):
    def test_validate(self):
        ok = budgets.validate([{"scope": "office", "period": "week", "usd": 100}, {"scope": "seat:c2", "period": "day", "tokens": 5_000_000}], {"c2"})
        self.assertEqual(ok[0], {"scope": "office", "period": "week", "usd": 100.0})
        for bad in ([{"scope": "team", "period": "week", "usd": 1}], [{"scope": "seat:nope", "period": "day", "usd": 1}], [{"scope": "office", "period": "year", "usd": 1}],
                    [{"scope": "office", "period": "day"}], [{"scope": "office", "period": "day", "usd": 1, "tokens": 1}], [{"scope": "office", "period": "day", "usd": -5}],
                    [{"scope": "office", "period": "day", "tokens": 1.5}], "x", [{}] * 13):
            with self.subTest(bad=str(bad)[:40]), self.assertRaises(ValueError):
                budgets.validate(bad, {"c2"})

    def test_sums_per_period_and_scope(self):
        items = [{"scope": "office", "period": "day", "usd": 50}, {"scope": "seat:c2", "period": "week", "usd": 25},
                 {"scope": "office", "period": "month", "tokens": 10_000_000}]
        v = budgets.evaluate(items, PER, date(2026, 10, 19), {"c2": "Atlas"})
        self.assertEqual([(b["label"], b["used"], b["pct"], b["state"]) for b in v],
                         [("The office, today", 41.0, 82.0, "warn"), ("Atlas, this week", 30.0, 120.0, "over"),
                          ("The office, this month", 12_500_007, 125.0, "over")])
        self.assertEqual(v[1]["since"], "2026-10-19")                   # a Monday: the week starts today


if __name__ == "__main__":
    unittest.main()

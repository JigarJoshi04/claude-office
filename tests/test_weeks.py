"""Par for the week: weekly windows scored like golf (office/weeks.py)."""
import json
import tempfile
import unittest
from pathlib import Path

from office.weeks import Weeks, grade, seed_from_history, WEEK


def seat(pct, resets, status="working", enabled=True, sid="a"):
    return {"id": sid, "kind": "claude", "status": status, "divider": {"enabled": enabled},
            "usage": {"weekly": {"pct": pct, "resets_at": resets}}}


class GradeTests(unittest.TestCase):
    def test_scores(self):
        self.assertEqual([grade(p)["name"] for p in (98, 92, 75, 45, 12, 2)], ["Eagle", "Birdie", "Par", "Bogey", "Double bogey", "Rest week"])
        self.assertEqual([grade(p)["score"] for p in (98, 92, 75, 45, 12, 2)], [-2, -1, 0, 1, 2, None])
        self.assertEqual(grade(100, 1, 30)["name"], "Bogey")                  # ran out of the week
        self.assertEqual(grade(100, 1, 7 * 60)["name"], "Double bogey")       # and waited a long time
        self.assertEqual(grade(20, benched=True)["name"], "Rest week")         # on holiday: not scored
        self.assertEqual(grade(80, benched=True)["name"], "Par")


class WeeksTests(unittest.TestCase):
    def test_a_window_is_followed_closed_and_scored(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "weeks.json"
            w, t0, ends = Weeks(path), 1_000_000.0, 1_000_000.0 + 3 * 86400
            self.assertEqual(w.observe([seat(40, ends)], t0), [])
            w.observe([seat(93, ends + 600)], t0 + 3600)                     # resets_at jitters: the same window
            w.observe([seat(100, ends, "limited")], t0 + 7200)                # 5-hour wall? no: the week is out (pct 100)
            w.observe([seat(100, ends, "limited")], t0 + 7200 + 240)
            w.observe([seat(97, ends, "working")], t0 + 7200 + 480)
            card = w.card("a", None, t0 + 7200 + 500)
            self.assertEqual((card["now"]["peak"], card["now"]["name"]), (100, "Bogey"))
            closed = w.observe([seat(3, ends + WEEK)], ends + 60)             # the reset passed: a new window
            self.assertEqual([(s, x["name"]) for s, x in closed], [("a", "Bogey")])
            again = Weeks(path)                                               # kept on disk
            self.assertEqual(again.closed["a"][-1]["name"], "Bogey")
            self.assertEqual(again.open["a"]["peak"], 3)

    def test_five_hour_walls_are_noted_not_scored(self):
        w, t0, ends = Weeks(None), 1_000_000.0, 1_000_000.0 + 86400
        w.observe([seat(70, ends)], t0)
        w.observe([seat(72, ends, "limited")], t0 + 60)                       # limited by the 5-hour window
        w.observe([seat(75, ends)], t0 + 120)
        done = w.observe([seat(1, ends + WEEK)], ends + 10)[0][1]
        self.assertEqual((done["name"], done["five_hour_walls"], done["limits"]), ("Par", 1, 0))

    def test_a_reset_that_passed_while_the_office_was_down_closes_on_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "weeks.json"
            w = Weeks(path)
            w.observe([seat(91, 2_000_000.0)], 1_900_000.0)
            w._save(1_900_000.0)
            closed = Weeks(path).observe([], 2_100_000.0)
            self.assertEqual([x["name"] for _, x in closed], ["Birdie"])

    def test_pace_and_holiday(self):
        w, ends = Weeks(None), 1_000_000.0 + 4 * 86400                       # three days into the week
        w.observe([seat(30, ends)], 1_000_000.0)
        self.assertEqual(w.card("a", None, 1_000_000.0)["now"]["heading"], "Par")      # 30% at 3/7 of the week: about 70%
        w.observe([seat(60, ends)], 1_000_100.0)
        self.assertEqual(w.card("a", None, 1_000_100.0)["now"]["heading"], "Bogey")    # on pace to run out
        h = Weeks(None)
        h.observe([seat(1, ends + 86400 * 6.5)], 1_000_000.0)
        self.assertIsNone(h.card("a", None, 1_000_000.0)["now"]["heading"])            # half a day in: too early
        b = Weeks(None)
        b.observe([seat(10, ends, enabled=False)], 1_000_000.0)
        n = b.card("a", None, 1_000_000.0)["now"]
        self.assertEqual((n["name"], n["benched"], n["heading"]), ("Rest week", True, None))

    def test_seed_from_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "history.jsonl"
            p.write_text("\n".join(json.dumps({"ts": ts, "seats": {"a": [0, pw, 0, 0, 0]}}) for ts, pw in ((10, 40), (20, 55), (30, 50))) + "\nnot json\n")
            self.assertEqual(seed_from_history(p)("a", 0, 25), 55)
            self.assertIsNone(seed_from_history(p)("b", 0, 25))
            self.assertIsNone(seed_from_history(Path(tmp) / "missing")("a", 0, 99))

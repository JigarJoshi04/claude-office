import json
from pathlib import Path
import tempfile
import unittest

from office.history import DayLedger


def snap(ts, tools=2):
    return {"now": ts, "seats": [{"id": "a", "label": "A", "color": "#123456", "usage": {"five_hour": {"pct": 20}, "weekly": {"pct": None}},
            "tokens_1h": 8, "sessions": [{"id": "one", "name": "one", "kind": "lane", "state": "working", "live": True, "title": None,
                                          "report_status": None, "tokens_total": 10, "tool_calls": tools, "started_at": None}]}], "lanes": []}


def day_stats(day, reports=3, mins=90, calls=400, sessions=4):
    return {"day": day, "seats": {"a": {"active_min": mins, "sessions": sessions, "lanes": 1, "reports": reports, "limits": 0,
                                        "tokens_fresh": 1000, "tool_calls": calls, "peak_p5": 20.0}},
            "office": {"sessions": sessions, "reports": reports, "limits": 0, "lanes_hired": 1, "busiest_seat": "a",
                       "longest_session": None, "first_activity": None, "last_activity": None},
            "mvp": {"seat": "a", "why": "x"}, "digest": ["a did the most work"]}


class LedgerTests(unittest.TestCase):
    def test_note_week_persist_and_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "days.json"
            led = DayLedger(path)
            led.note(day_stats("2026-10-16", reports=5))
            led.note(day_stats("2026-10-18", reports=2, mins=30))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            again = DayLedger(path)
            self.assertEqual(again.get("2026-10-16")["office"]["reports"], 5)
            week = again.week("2026-10-18", 3)
            self.assertEqual([d["day"] for d in week], ["2026-10-16", "2026-10-17", "2026-10-18"])
            self.assertEqual([d["reports"] for d in week], [5, 0, 2])
            self.assertEqual(week[2]["active_min"], 30)
            self.assertEqual(week[1], {"day": "2026-10-17", "reports": 0, "sessions": 0, "active_min": 0, "tool_calls": 0,
                                       "limits": 0, "lanes_hired": 0, "mvp": None, "limited_min": {}, "avail_min": 0, "busy_min": 0, "all_out_min": 0, "per_seat": {}})

    def test_empty_days_are_not_kept_and_old_days_age_out(self):
        led = DayLedger(None, keep_days=3)
        led.note(day_stats("2026-10-10", reports=0, mins=0, calls=0, sessions=0))
        self.assertIsNone(led.get("2026-10-10"))
        for d in ("2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"):
            led.note(day_stats(d))
        self.assertIsNone(led.get("2026-10-11"))
        self.assertIsNotNone(led.get("2026-10-14"))

    def test_corrupt_file_and_bad_input_are_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "days.json"
            path.write_text("{not json")
            led = DayLedger(path)
            self.assertEqual(led.week("2026-10-18", 2)[1]["reports"], 0)
            led.note({"day": "yesterday"})
            led.note(None)
            path.write_text(json.dumps({"2026-10-17": "nope", "bad": {}}))
            self.assertIsNone(DayLedger(path).get("2026-10-17"))
            with self.assertRaises(ValueError):
                led.week("18-10-2026", 7)
            with self.assertRaises(ValueError):
                led.week("2026-10-18", 0)


if __name__ == "__main__":
    unittest.main()


class StoreLedgerTests(unittest.TestCase):
    def test_today_is_noted_and_past_days_come_from_the_ledger(self):
        from datetime import datetime
        from office.history import HistoryStore
        start = datetime(2026, 10, 16).timestamp()
        clock = [start + 600]
        led = DayLedger(None)
        h = HistoryStore(clock=lambda: clock[0], ledger=led)
        for i in range(5):
            h.record(snap(start + i * 60, tools=2 + i))
        today = h.stats(snap(start + 300, tools=7))
        self.assertEqual(today["day"], "2026-10-16")
        self.assertEqual(led.get("2026-10-16")["seats"]["a"]["active_min"], today["seats"]["a"]["active_min"])
        led.note(day_stats("2026-10-15", reports=9))
        self.assertEqual(h.stats(snap(start + 300), "2026-10-15")["office"]["reports"], 9)
        self.assertEqual(h.week(snap(start + 300), 2)[0]["reports"], 9)
        self.assertEqual(h.week(snap(start + 300), 2)[1]["day"], "2026-10-16")

    def test_yesterday_is_backfilled_from_history_when_the_ledger_lacks_it(self):
        from datetime import datetime
        from office.history import HistoryStore
        start = datetime(2026, 10, 16).timestamp()
        clock = [start + 6 * 3600]
        h = HistoryStore(clock=lambda: clock[0], ledger=DayLedger(None))
        for i in range(10):                         # ten working minutes late on the 15th
            h.record(snap(start - 3600 + i * 60, tools=2 + i))
        h.record(snap(start + 3600))
        week = h.week(snap(start + 6 * 3600), 2)
        self.assertEqual(week[0]["day"], "2026-10-15")
        self.assertGreater(week[0]["active_min"], 0)

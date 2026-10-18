"""Reminders without a calendar (office/reminders.py)."""
import tempfile
import unittest
from pathlib import Path

from office.reminders import Reminders, trigger_from, KEEP_S


class ReminderTests(unittest.TestCase):
    def test_triggers_are_checked(self):
        now = 1_000_000.0
        self.assertEqual(trigger_from({"kind": "at", "at": now + 60}, now), {"kind": "at", "at": now + 60})
        self.assertEqual(trigger_from({"kind": "pr_merged", "ref": "#482"}, now), {"kind": "pr_merged", "ref": "482"})
        for bad in (None, {"kind": "soon"}, {"kind": "at", "at": now + KEEP_S + 10}, {"kind": "at", "at": True}, {"kind": "lane_end"}, {"kind": "pr_merged", "ref": "abc"}):
            with self.assertRaises(ValueError):
                trigger_from(bad, now)

    def test_each_trigger_fires_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = Reminders(Path(tmp) / "reminders.json")
            now = 1_000_000.0
            r.add("stand up", {"kind": "at", "at": now + 60}, now=now)
            r.add("plan back", {"kind": "seat_reset", "ref": "c2"}, seat="c2", due=now + 120, now=now)
            r.add("done?", {"kind": "session_end", "ref": "s1"}, now=now)
            r.add("lane", {"kind": "lane_end", "ref": "l1"}, now=now)
            r.add("merged", {"kind": "pr_merged", "ref": "482"}, now=now)
            snap = lambda live, lane: {"seats": [{"id": "c2", "status": "limited", "sessions": [{"id": x, "live": True} for x in live]}],
                                       "lanes": [{"id": "l1", "status": lane}]}
            self.assertEqual(r.check(snap(["s1"], "running"), now + 10), [])
            fired = r.check(snap(["s1"], "running"), now + 70)
            self.assertEqual([x["text"] for x in fired], ["stand up"])
            fired = r.check(snap([], "done"), now + 600, [{"kind": "shipped", "text": "api: PR #482 merged"}])
            self.assertEqual(sorted(x["text"] for x in fired), ["done?", "lane", "merged", "plan back"])
            self.assertTrue(next(x for x in fired if x["text"] == "plan back")["late"])          # the office was not looking at the time
            self.assertEqual(r.view(), [])
            self.assertEqual(r.check(snap([], "done"), now + 700, [{"kind": "shipped", "text": "api: PR #482 merged"}]), [])   # once
            self.assertEqual(len(Reminders(Path(tmp) / "reminders.json").items), 5)              # kept on disk a day after firing

    def test_a_session_never_seen_does_not_fire_and_old_ones_go(self):
        r, now = Reminders(None), 1_000_000.0
        r.add("x", {"kind": "session_end", "ref": "ghost"}, now=now)
        self.assertEqual(r.check({"seats": [], "lanes": []}, now + 10), [])
        r.check({"seats": [], "lanes": []}, now + KEEP_S + 1)
        self.assertEqual(r.items, [])
        with self.assertRaises(ValueError):
            r.add("   ", {"kind": "at", "at": now}, now=now)

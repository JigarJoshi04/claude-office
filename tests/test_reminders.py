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
            snap = lambda live, lane, st="limited": {"seats": [{"id": "c2", "status": st, "sessions": [{"id": x, "live": True} for x in live]}],
                                                     "lanes": [{"id": "l1", "status": lane}]}
            self.assertEqual(r.check(snap(["s1"], "running"), now + 10), [])
            fired = r.check(snap(["s1"], "running"), now + 70)
            self.assertEqual([x["text"] for x in fired], ["stand up"])
            fired = r.check(snap([], "done", "idle"), now + 600, [{"kind": "shipped", "text": "api: PR #482 merged"}])   # the seat is back
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


class ReminderFixTests(unittest.TestCase):
    def test_session_and_seat_reminders_survive_a_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, now = Path(tmp) / "reminders.json", 1_000_000.0
            r = Reminders(path)
            r.add("done?", {"kind": "session_end", "ref": "s1"}, now=now, seen=True)          # the server saw it live
            r.add("back", {"kind": "seat_reset", "ref": "c2"}, seat="c2", due=None, now=now, was_limited=True)
            again = Reminders(path)                                                       # the office restarts
            fired = again.check({"seats": [{"id": "c2", "status": "idle", "sessions": []}], "lanes": []}, now + 600)
            self.assertEqual(sorted(x["text"] for x in fired), ["back", "done?"])

    def test_a_seat_reminder_waits_until_the_seat_is_really_back(self):
        r, now = Reminders(None), 1_000_000.0
        r.add("back", {"kind": "seat_reset", "ref": "c2"}, seat="c2", due=now + 60, now=now)
        out = lambda st: {"seats": [{"id": "c2", "status": st, "sessions": []}], "lanes": []}
        self.assertEqual(r.check(out("limited"), now + 120), [])                         # its 5-hour reset passed, still out
        self.assertEqual([x["text"] for x in r.check(out("idle"), now + 180)], ["back"])

    def test_a_pr_seen_merged_on_the_shelf_fires(self):
        r, now = Reminders(None), 1_000_000.0
        r.add("merged", {"kind": "pr_merged", "ref": "482"}, now=now)
        self.assertEqual([x["text"] for x in r.check({"seats": [], "lanes": []}, now + 5, [], [482])], ["merged"])

    def test_an_old_merge_of_the_same_number_does_not_fire(self):
        r, now = Reminders(None), 1_000_000.0
        r.add("merged", {"kind": "pr_merged", "ref": "12"}, now=now)
        self.assertEqual(r.check({"seats": [], "lanes": []}, now + 5, [], [(12, now - 86400)]), [])    # another repo's #12, last week
        self.assertEqual([x["text"] for x in r.check({"seats": [], "lanes": []}, now + 9, [], [(12, now - 86400), (12, now + 8)])], ["merged"])

    def test_a_reminder_for_one_repository_waits_for_that_repository(self):
        self.assertEqual(trigger_from({"kind": "pr_merged", "ref": "acme/api#12"}), {"kind": "pr_merged", "ref": "acme/api#12"})
        r, now = Reminders(None), 1_000_000.0
        r.add("api merged", {"kind": "pr_merged", "ref": "acme/api#12"}, now=now)
        self.assertEqual(r.check({"seats": [], "lanes": []}, now + 5, [], [(12, now + 4, "acme/web")]), [])     # web's #12
        self.assertEqual([x["text"] for x in r.check({"seats": [], "lanes": []}, now + 9, [], [(12, now + 8, "acme/api")])], ["api merged"])

"""Careers: XP, levels and achievements from snapshots."""
import tempfile
import unittest
from pathlib import Path

from office import career


def snap(now, tools=0, state="working", status="working", report=None, sid="s1", tokens=0, extra=()):
    sessions = [{"id": sid, "live": True, "state": state, "tool_calls": tools, "tokens_total": tokens,
                 "report_status": report}] + list(extra)
    return {"now": now, "seats": [{"id": "a", "label": "a", "status": status, "sessions": sessions}]}


class CareerTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "career.json"

    def test_levels_and_titles(self):
        self.assertEqual([career.level_for(x) for x in (0, 99, 100, 399, 400, 8100)], [1, 1, 2, 2, 3, 10])
        self.assertEqual(career.xp_for(3), 400)
        self.assertEqual([career.title_for(n) for n in (1, 3, 9, 10, 50)], ["Intern", "Junior", "Engineer", "Senior", "Legend"])

    def test_first_look_credits_quietly_then_work_earns_xp_and_news(self):
        c = career.Career(self.path, clock=lambda: 1000.0)
        self.assertEqual(c.observe(snap(1000, tools=1200)), [])      # no flood of news on the first look
        v = c.view("a")
        self.assertEqual(v["xp"], career.XP_SESSION + 1200)
        self.assertIn("hands_1k", v["unlocked"])
        news = c.observe(snap(1010, tools=1700, report="STATUS: DONE - ok"))
        self.assertEqual(c.view("a")["xp"], 1210 + 500 + career.XP_REPORT)
        self.assertIn(("a", "achievement", "a unlocked Signed off"), news)
        self.assertTrue(any(k == "levelup" for _, k, _ in news))   # 1210 -> 1810 XP crosses level 4 -> 5

    def test_counters_rebaseline_instead_of_double_counting(self):
        c = career.Career(None)
        c.observe(snap(0, tools=500))
        c.observe(snap(5, tools=200))       # the office re-read a shorter tail: no negative, no credit
        c.observe(snap(10, tools=210))
        self.assertEqual(c.view("a")["stats"]["tool_calls"], 510)

    def test_blocked_reports_earn_nothing_and_reports_count_once(self):
        c = career.Career(None)
        c.observe(snap(0))
        c.observe(snap(5, report="STATUS: BLOCKED - no access"))
        c.observe(snap(10, report="STATUS: BLOCKED - no access"))
        self.assertEqual(c.view("a")["stats"]["reports"], 0)

    def test_minutes_at_work_and_limits(self):
        c = career.Career(None)
        for t in range(0, 125, 5):
            c.observe(snap(t))
        self.assertEqual(c.view("a")["xp"], career.XP_SESSION + 2 * career.XP_MINUTE)
        news = c.observe(snap(130, status="limited", state="limited"))
        self.assertIn(("a", "achievement", "a unlocked Hit the wall"), news)
        self.assertEqual(c.view("a")["stats"]["limits"], 1)
        c.observe(snap(140, status="working"))
        self.assertIn(("a", "achievement", "a unlocked Comeback"), c.observe(snap(150)))

    def test_juggler_needs_four_working_at_once(self):
        c = career.Career(None)
        more = [{"id": f"x{i}", "live": True, "state": "working", "tool_calls": 0} for i in range(3)]
        c.observe(snap(0))
        self.assertIn(("a", "achievement", "a unlocked Juggler"), c.observe(snap(5, extra=more)))

    def test_career_survives_a_restart(self):
        c = career.Career(self.path)
        c.observe(snap(0, tools=50))
        c.flush()
        again = career.Career(self.path)
        self.assertEqual(again.view("a")["xp"], 60)
        again.observe(snap(100, tools=50))   # the same session again: no second credit
        self.assertEqual(again.view("a")["xp"], 60)

    def test_shipped_work_earns_xp_and_achievements(self):
        c = career.Career(self.path, clock=lambda: 1000.0)
        self.assertEqual(c.credit_shipped("a", "Atlas", [2, 1, 0, 0]), [])          # 2 commits and a push
        self.assertEqual(c.view("a")["xp"], 2 * 25 + 5)
        news = c.credit_shipped("a", "Atlas", [0, 0, 1, 1])                         # a PR opened and merged: level 2
        self.assertEqual(c.view("a")["xp"], 55 + 50 + 150)
        self.assertEqual(news, [("a", "levelup", "Atlas reached level 2: Intern")])
        self.assertEqual(c.shipped_totals({"a": (120, 3)}, {"a": "Atlas"}), [])     # history unlocks quietly
        self.assertTrue({"first_commit", "commits_100", "first_merge"} <= set(c.view("a")["unlocked"]))
        self.assertNotIn("commits_1k", c.view("a")["unlocked"])
        news = c.shipped_totals({"a": (1000, 3)}, {"a": "Atlas"})
        self.assertEqual(news, [("a", "achievement", "Atlas unlocked Prolific")])
        self.assertEqual(c.shipped_totals({"a": (1001, 3)}, {"a": "Atlas"}), [])    # once

    def test_chains_and_secrets(self):
        cat = {a["id"]: a for a in career.CATALOGUE}
        self.assertEqual((cat["paper_200"]["chain"], cat["paper_200"]["tier"]), ("paper", 4))
        self.assertTrue(cat["speed_run"]["hidden"] and not cat["paper_50"]["hidden"])
        c = career.Career(self.path, clock=lambda: 1000.0)
        c.observe(snap(1000))                                                   # the first look is quiet
        start = {"id": "s2", "live": True, "state": "working", "tool_calls": 0, "tokens_total": 0, "report_status": None, "started_at": 1000}
        c.observe({"now": 1100, "seats": [{"id": "a", "label": "a", "status": "working", "sessions": [start]}]})
        news = c.observe({"now": 1400, "seats": [{"id": "a", "label": "a", "status": "working", "sessions": [dict(start, report_status="STATUS: DONE - ok")]}]})
        self.assertIn(("a", "achievement", "a unlocked Speedrun"), news)            # a report 400 s after its start

    def test_catalogue_icons_and_names_are_complete(self):
        self.assertEqual(len({a["id"] for a in career.CATALOGUE}), len(career.CATALOGUE))
        icons = Path(__file__).resolve().parent.parent.joinpath("web/ui/icons.js").read_text()
        for a in career.CATALOGUE:
            self.assertIn(f"  {a['icon']}: '", icons, a["id"])


if __name__ == "__main__":
    unittest.main()

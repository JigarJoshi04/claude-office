"""The brief coach (coach.py): similar past lanes by shared words, the size estimate, and the analyst's read."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from office import brain, coach, config, lanes

SEAT = {"id": "claude2", "label": "claude2", "kind": "claude", "config_dir": "/home/u/.claude2", "status": "ok",
        "health": {"state": "ok"}, "usage": {"five_hour": {"pct": 20}}}
ANSWER = {"findings": [{"kind": "missing", "text": "No way to check it."}, {"kind": "weird", "text": "x"}, {"kind": "good"}],
          "rewrite": "Fix the export test. Done when it passes 20 runs.", "model": "sonnet", "model_why": "A bounded fix."}


class FakeBrain:
    def __init__(self, answer=None, fail=None):
        self.calls, self.answer, self.fail = [], answer, fail

    def ask(self, kind, prompt, schema, seat, cfg, about=""):
        self.calls.append((kind, prompt, seat))
        if self.fail:
            raise brain.Unavailable(self.fail)
        return {"answer": self.answer, "cached": False, "tokens": 1234, "seat": seat["id"]}


class CoachTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        p = patch.object(config, "DATA_DIR", Path(temp.name))
        p.start()
        self.addCleanup(p.stop)

    def lane(self, lid, title, brief, status="done", report=None, model="opus", runs=None):
        d = lanes.lanes_dir() / lid
        d.mkdir(parents=True)
        (d / "brief.md").write_text(brief)
        if report:
            (d / "REPORT.md").write_text(report + "\n")
        (d / "lane.json").write_text(json.dumps({"id": lid, "title": title, "status": status, "model": model,
                                                 "runs": runs or [{"started_at": 1000, "ended_at": 1000 + 1800, "session_id": "s-" + lid}]}))

    def office(self, b, spent=None):
        return SimpleNamespace(brain=b, cfg={}, get=lambda: {"seats": [SEAT], "next_pick": {"seat": "claude2"}},
                               tokens=SimpleNamespace(spent=spent or (lambda sids: {"tokens": 2_000_000})))

    def test_words_drop_common_words_and_keep_short_telling_ones(self):
        self.assertEqual(coach.words("Fix the flaky export tests in export.py, and make sure it passes"),
                         {"fix", "flaky", "export", "test", "py", "pass"})
        self.assertEqual(coach.words("QA the UI before the PR"), {"qa", "ui", "pr"})
        self.assertEqual(coach.words("retries fixes runs status"), {"retry", "fix", "run", "status"})
        self.assertEqual(coach.score(set(), {"a"}, {}, 1.0), 0.0)

    def test_similar_ranks_by_shared_words_and_skips_unfinished(self):
        self.lane("1018-000001-a", "Fix the flaky export test", "The export test fails one run in five. Fix the flake.", report="STATUS: DONE - fixed")
        self.lane("1018-000002-b", "Write the docs", "Write the onboarding docs for the billing page.")
        self.lane("1018-000003-c", "Export test flake again", "export test flaky fails", status="running")
        self.lane("1018-000004-d", "Flaky export retries", "Export retries flaky; fix them.", report="STATUS: BLOCKED - no repro", model="haiku")
        got = coach.similar("Fix the flaky export test", "The export test is flaky: fix it and prove it with 20 runs.", lambda s: {"tokens": 5})
        self.assertEqual([r["id"] for r in got], ["1018-000001-a", "1018-000004-d"])
        self.assertEqual(got[0]["outcome"], "done")
        self.assertEqual(got[1]["outcome"], "blocked")
        self.assertEqual((got[0]["minutes"], got[0]["tokens"]), (30, 5))
        self.assertEqual(coach.similar("x", "nothing in common whatsoever here"), [])

    def test_a_long_past_brief_does_not_outrank_the_same_kind_of_job(self):
        filler = " ".join(f"word{i}" for i in range(300))
        self.lane("1018-000001-long", "QA pass of the v3 UI", "Office smoke check start page load report " + filler, report="STATUS: DONE - ok")
        self.lane("1018-000002-smoke", "Office smoke test", "Start the office and check the page loads.", report="STATUS: DONE - ok")
        got = coach.similar("Smoke test", "Run a smoke test of the office: start it, check the page loads, report.")
        self.assertEqual(got[0]["id"], "1018-000002-smoke")
        self.assertEqual(coach.score({"a", "b"}, {"a", "b"}, {}, 1.0), 0.0)               # fewer than three shared words

    def test_estimate_needs_three_and_uses_medians(self):
        rows = [{"minutes": 10, "tokens": 1, "outcome": "done", "model": "opus"}, {"minutes": 30, "tokens": 3, "outcome": "blocked", "model": "opus"}]
        self.assertIsNone(coach.estimate(rows))
        rows.append({"minutes": None, "tokens": 9, "outcome": "done", "model": "sonnet"})
        e = coach.estimate(rows)
        self.assertEqual((e["n"], e["minutes"], e["tokens"], e["done"]), (3, None, 3, 2))      # two runtimes are not enough for a median
        rows[2]["minutes"] = 50
        self.assertEqual(coach.estimate(rows)["minutes"], 30)
        self.assertEqual(e["models"][0], {"model": "opus", "n": 2, "done": 1})

    def test_a_report_that_does_not_claim_done_is_not_done(self):
        self.assertEqual(coach.outcome({"status": "stopped", "report_status": "Notes so far: half the tables"}), "stopped")
        self.assertEqual(coach.outcome({"status": "done", "report_status": "STATUS: DONE - all of it"}), "done")
        self.assertNotIn("file", coach.words("Edit the files"))                                 # a plural of a stop word is one too

    def test_the_price_tag(self):
        office = SimpleNamespace(get=lambda: {"next_pick": {"seat": "claude2"}}, samples=SimpleNamespace(exchange=lambda snap, sid: {"five_hour": 1000, "weekly": 10000}))
        self.assertEqual(coach.price_tag(office, {"fresh": 50_000}, None), {"seat": "claude2", "five_hour": 50, "weekly": 5})
        self.assertEqual(coach.price_tag(office, {"fresh": 50_000}, "claude4")["seat"], "claude4")
        self.assertIsNone(coach.price_tag(office, {"fresh": None}, None))
        office.samples = SimpleNamespace(exchange=lambda snap, sid: {"five_hour": None, "weekly": None})
        self.assertIsNone(coach.price_tag(office, {"fresh": 50_000}, None))

    def test_brief_length_is_checked(self):
        with self.assertRaisesRegex(ValueError, "20 to"):
            coach.coach(self.office(FakeBrain()), {"brief": "too short"})
        with self.assertRaisesRegex(ValueError, "20 to"):
            coach.coach(self.office(FakeBrain()), {"brief": "x" * 9000})

    def test_analyst_off_still_gives_the_past_lanes(self):
        self.lane("1018-000001-a", "Fix the flaky export test", "export test flaky fix", report="STATUS: DONE - fixed")
        r = coach.coach(self.office(FakeBrain(fail="The office analyst is off.")), {"title": "Fix flaky export test", "brief": "Fix the flaky export test for good."})
        self.assertEqual(len(r["similar"]), 1)
        self.assertIsNone(r["coach"])
        self.assertIn("off", r["unavailable"])

    def test_the_analysts_read_is_cleaned(self):
        fb = FakeBrain(ANSWER)
        self.lane("1018-000001-a", "Fix the flaky export test", "export test flaky fix", report="STATUS: DONE - fixed")
        r = coach.coach(self.office(fb), {"title": "Fix flaky export test", "brief": "Fix the flaky export test for good.", "model": "opus"})
        c = r["coach"]
        self.assertEqual([f["kind"] for f in c["findings"]], ["missing", "vague"])     # unknown kind becomes vague; no text dropped
        self.assertEqual(c["model"], "sonnet")
        self.assertEqual(c["tokens"], 1234)
        kind, prompt, seat = fb.calls[0]
        self.assertEqual((kind, seat["id"]), ("coach", "claude2"))
        self.assertIn("Chosen model: opus", prompt)
        self.assertIn('"Fix the flaky export test" on opus: done', prompt)
        self.assertNotIn("export test flaky fix", prompt)                              # a past lane's brief is never sent

    def test_past_lanes_only_skips_the_analyst(self):
        fb = FakeBrain(ANSWER)
        r = coach.coach(self.office(fb), {"brief": "Fix the flaky export test for good.", "ai": False})
        self.assertEqual(fb.calls, [])
        self.assertIsNone(r["coach"])

    def test_demo(self):
        r = coach.coach(None, {"brief": "Fix the flaky export test for good."}, demo=True)
        self.assertTrue(r["demo"])
        self.assertEqual(r["estimate"]["n"], 3)
        self.assertTrue(r["coach"]["rewrite"])


if __name__ == "__main__":
    unittest.main()

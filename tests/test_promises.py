"""Promises (promises.py): kept by a lane's DONE report in time, broken when the time passes first."""
import tempfile
import unittest
from pathlib import Path

from office import promises
from office.snapshot import Office, attention_key

NOW = 1_800_000_000


def lane(lid, status="running", finished=None, chain=None, nxt=None, title="Fix it"):
    return {"id": lid, "title": title, "status": status, "seat": "claude2", "finished_at": finished, "chain": chain or [], "chain_next": nxt,
            "runs": [{"started_at": NOW - 100, "ended_at": finished}] if finished else []}


class PromiseTests(unittest.TestCase):
    def setUp(self):
        self.lanes = {"l1": lane("l1")}
        self.p = promises.Promises(None)
        self.load = lambda lid: self.lanes.get(lid)

    def make(self, lid="l1", due=NOW + 7200):
        return self.p.make(lid, due, NOW, load=self.load)

    def test_kept_by_a_done_report_in_time(self):
        self.make()
        self.assertEqual(self.p.evaluate([], NOW + 60, self.load), [])
        self.lanes["l1"] = lane("l1", "done", finished=NOW + 3600)
        kept = self.p.evaluate([], NOW + 3700, self.load)
        self.assertEqual((kept[0]["status"], kept[0]["early_s"]), ("kept", 3600))
        v = self.p.view(NOW + 3700)
        self.assertEqual((v["kept"], v["broken"], v["streak"], v["open"]), (1, 0, 1, []))

    def test_broken_when_the_time_passes_first(self):
        self.make()
        self.lanes["l1"] = lane("l1", "blocked", finished=NOW + 600)            # blocked: there is still time to resume
        self.assertEqual(self.p.evaluate([], NOW + 700, self.load), [])
        out = self.p.evaluate([], NOW + 7300, self.load)
        self.assertEqual(out[0]["status"], "broken")
        self.lanes["l2"] = lane("l2")
        self.make("l2")
        self.lanes["l2"] = lane("l2", "done", finished=NOW + 8000)              # done, but after the time
        self.assertEqual(self.p.evaluate([], NOW + 8100, self.load)[0]["why"], "it finished late")

    def test_a_chain_is_kept_by_its_last_stage(self):
        self.make()
        self.lanes["l1"] = lane("l1", "done", finished=NOW + 600, chain=[{"title": "review"}])   # more stages to come
        self.assertEqual(self.p.evaluate([], NOW + 700, self.load), [])
        self.lanes["l1"] = lane("l1", "done", finished=NOW + 600, nxt="l1b")
        self.lanes["l1b"] = lane("l1b", "running")
        self.assertEqual(self.p.evaluate([], NOW + 800, self.load), [])
        self.lanes["l1b"] = lane("l1b", "done", finished=NOW + 1800)
        self.assertEqual(self.p.evaluate([], NOW + 1900, self.load)[0]["done_at"], NOW + 1800)

    def test_making_and_dropping(self):
        with self.assertRaises(ValueError):
            self.p.make("l1", NOW + 60, NOW, load=self.load)                      # too soon
        with self.assertRaises(ValueError):
            self.p.make("nope", NOW + 7200, NOW, load=self.load)
        self.lanes["l3"] = lane("l3", "done", finished=NOW - 10)
        with self.assertRaises(ValueError):
            self.p.make("l3", NOW + 7200, NOW, load=self.load)                    # already finished
        a = self.make()
        b = self.make(due=NOW + 9000)                                            # a new time replaces the old
        self.assertEqual((a["id"], b["due"], len(self.p.view(NOW)["open"])), (b["id"], NOW + 9000, 1))
        self.p.drop(a["id"])
        self.assertEqual(self.p.view(NOW)["open"], [])
        with self.assertRaises(ValueError):
            self.p.drop(a["id"])

    def test_due_soon_needs_you_and_survives_a_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "promises.json"
            p = promises.Promises(path)
            p.make("l1", NOW + 3600, NOW, load=self.load)
            items = promises.Promises(path).attention(NOW)
            self.assertEqual(len(items), 1)
            self.assertTrue(items[0]["text"].startswith("Promise due in 1 h 00: 'Fix it'"))
            snap = {"now": NOW, "seats": [], "lanes": [], "units": [], "asks": [], "office": {}, "promise_due": items}
            got = [a for a in Office._attention(snap) if a.get("promise")]
            self.assertEqual(attention_key(got[0]), "promise:" + items[0]["promise"])
            self.assertEqual(promises.Promises(path).attention(NOW - 86400), [])   # a day before: not yet


if __name__ == "__main__":
    unittest.main()

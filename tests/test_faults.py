"""Office problems (faults.py): a failure is said once, then at most every 10 minutes with its count, and once more
when it works again; the same failure with a changing number is one problem, a different failure is another."""
import unittest
from unittest.mock import patch

from office import faults


class FaultTests(unittest.TestCase):
    def setUp(self):
        self.said = []
        self.f = faults.Faults(lambda kind, text, seat, level: self.said.append((level, text, seat)))
        self.now = 1_800_000_000.0
        p = patch.object(faults.time, "time", side_effect=lambda: self.now)
        p.start(); self.addCleanup(p.stop)

    def test_once_then_every_ten_minutes_then_recovered(self):
        for i in range(150):                                   # every 4 s for 10 minutes
            self.f.fault("The refresh", OSError(f"read {i} bytes failed"))
            self.now += 4
        self.assertEqual([t for _, t, _ in self.said], ["The refresh failed: OSError: read 0 bytes failed"])
        self.f.fault("The refresh", OSError("read 999 bytes failed"))
        self.assertEqual(len(self.said), 2)
        self.assertIn("still failing (151 times since", self.said[1][1])
        self.assertEqual(self.f.view()[0]["count"], 151)
        self.f.ok("The refresh")                               # it works: over once it has worked for a minute
        self.assertEqual(len(self.said), 2)
        self.now += 61
        self.f.ok("The refresh"); self.f.ok("The refresh")
        self.assertEqual(self.said[2][:2], ("good", "The refresh works again, after 11 minutes"))
        self.assertEqual((len(self.said), self.f.view()), (3, []))

    def test_different_failures_and_parts_are_apart(self):
        self.f.fault("Reading claude2", PermissionError("denied"), "claude2")
        self.f.fault("Reading claude2", ValueError("bad json"), "claude2")
        self.f.fault("Plan readings", TimeoutError("slow"))
        self.assertEqual(len(self.said), 3)
        self.assertEqual(self.said[0][2], "claude2")
        self.f.ok("Plan readings"); self.now += 61; self.f.ok("Plan readings")
        self.assertEqual({v["part"] for v in self.f.view()}, {"Reading claude2"})
        self.f.ok("Reading claude2"); self.now += 61; self.f.ok("Reading claude2")
        self.assertEqual(sum(1 for lv, _, _ in self.said if lv == "good"), 2)   # one recovery line per part

    def test_flapping_is_one_problem_and_gone_parts_are_forgotten(self):
        for i in range(30):                                    # fails every other refresh for two minutes
            self.f.fault("The beacon file", OSError("disk full")) if i % 2 else self.f.ok("The beacon file")
            self.now += 4
        self.assertEqual([t for _, t, _ in self.said], ["The beacon file failed: OSError: disk full"])
        self.f.forget(lambda part: part != "The beacon file")  # taken out of the config
        self.assertEqual(self.f.view(), [])
        self.assertEqual(len(self.said), 1)                     # quietly

    def test_ok_without_a_problem_says_nothing(self):
        self.f.ok("The token ledger")
        self.assertEqual(self.said, [])


if __name__ == "__main__":
    unittest.main()

"""egress.py: the office's own outbound calls, counted by kind."""
import tempfile
import unittest
from pathlib import Path

from office import egress


class EgressTests(unittest.TestCase):
    def test_calls_are_counted_by_kind_for_a_day(self):
        egress.init(None)
        egress.note("usage"); egress.note("usage", ok=False); egress.note("github")
        v = {e["kind"]: e for e in egress.view()}
        self.assertEqual((v["usage"]["calls"], v["usage"]["failed"], v["usage"]["host"]), (2, 1, "api.anthropic.com"))
        self.assertEqual(v["github"]["calls"], 1)
        self.assertEqual(egress.view(now=10**12), [])                    # a day later: gone

    def test_a_busy_day_is_counted_whole_and_kept_across_a_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "egress.json"
            egress.init(path)
            t = 1_800_000_000
            for i in range(6000):                                        # more than the old cap of 5,000
                egress.note("github", now=t + i * 10)
            egress.init(path)                                            # a restart reads what was kept
            v = {e["kind"]: e for e in egress.view(now=t + 60_000)}
            self.assertGreaterEqual(v["github"]["calls"], 5990)          # kept to the last minute's save
            egress.init(None)


if __name__ == "__main__":
    unittest.main()

"""egress.py: the office's own outbound calls, counted by kind."""
import unittest

from office import egress


class EgressTests(unittest.TestCase):
    def test_calls_are_counted_by_kind_for_a_day(self):
        egress._LOG.clear()
        egress.note("usage"); egress.note("usage", ok=False); egress.note("github")
        v = {e["kind"]: e for e in egress.view()}
        self.assertEqual((v["usage"]["calls"], v["usage"]["failed"], v["usage"]["host"]), (2, 1, "api.anthropic.com"))
        self.assertEqual(v["github"]["calls"], 1)
        self.assertEqual(egress.view(now=10**12), [])                    # a day later: gone


if __name__ == "__main__":
    unittest.main()

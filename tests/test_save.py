"""save.py: the CEO's game save, kept by the office."""
import tempfile
import time
import unittest
from pathlib import Path

from office.save import Save


class SaveTests(unittest.TestCase):
    def test_keys_newest_wins_and_survive_a_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = Save(Path(tmp) / "save.json")
            now = time.time() * 1000
            s.put("album", {"duck": {"n": 1}}, now)
            self.assertEqual(s.put("album", {"old": 1}, now - 5000)["kept"], "newer")         # an older write is ignored
            s.put("squashBest", 41, now)
            again = Save(Path(tmp) / "save.json").view()
            self.assertEqual(again["keys"]["album"]["v"], {"duck": {"n": 1}})
            self.assertEqual(again["keys"]["squashBest"]["v"], 41)

    def test_bad_writes_are_refused(self):
        s, now = Save(None), time.time() * 1000
        for key, value, at in (("../x", 1, now), ("", 1, now), ("ok", 1, "soon"), ("ok", 1, now * 10), ("ok", "x" * 300_000, now)):
            with self.assertRaises(ValueError):
                s.put(key, value, at)


if __name__ == "__main__":
    unittest.main()

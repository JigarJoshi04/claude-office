"""The CEO's announcements (announce.py): checked, expiring, taken down, the last 20 kept across a restart."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from office import announce


class AnnounceTests(unittest.TestCase):
    def test_post_expire_clear_and_keep(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "announcements.json"
            an = announce.Announcements(path)
            a = an.post("  Merge   freeze" + chr(10) + "until 5 pm ", 2)
            self.assertEqual(a["text"], "Merge freeze until 5 pm")             # one line, spaces tidied
            self.assertEqual([x["id"] for x in an.active()], [a["id"]])
            self.assertEqual(an.active(a["until"] + 1), [])                  # gone once it runs out
            self.assertEqual(announce.Announcements(path).active()[0]["text"], a["text"])   # kept across a restart
            self.assertTrue(an.clear(a["id"])); self.assertFalse(an.clear(a["id"]))
            for i in range(25):
                an.post(f"note {i}", 1)
            self.assertEqual(len(json.loads(path.read_text())), announce.KEEP)
            self.assertEqual(an.active()[0]["text"], "note 24")              # the newest first

    def test_bad_notes_are_refused(self):
        an = announce.Announcements(None)
        for text, hours in (("", 1), ("x" * 281, 1), ("ok", 0), ("ok", 100), ("ok", "4"), ("ok", True)):
            with self.subTest(text=text[:5], hours=hours), self.assertRaises(ValueError):
                an.post(text, hours)


if __name__ == "__main__":
    unittest.main()

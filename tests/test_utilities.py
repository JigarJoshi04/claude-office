"""utilities.py: the AI team's disk and memory, read only."""
import os
import tempfile
import unittest
from pathlib import Path

from office import utilities


class UtilitiesTests(unittest.TestCase):
    def test_disk_counts_linked_seats_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / ".claude" / "projects" / "p").mkdir(parents=True)
            (home / ".claude" / "projects" / "p" / "a.jsonl").write_bytes(b"x" * 1000)
            (home / ".claude2").mkdir()
            os.symlink(home / ".claude" / "projects", home / ".claude2" / "projects")       # seats share one folder
            (home / ".codex" / "sessions").mkdir(parents=True)
            (home / ".codex" / "sessions" / "r.jsonl").write_bytes(b"y" * 500)
            d = utilities.disk(home, [])
            parts = {p["key"]: p for p in d["parts"]}
            self.assertEqual(parts["projects"]["bytes"], 1000)
            self.assertEqual(parts["codex"]["bytes"], 500)
            self.assertEqual(d["bytes"], 1500)

    def test_growth_is_per_calendar_day(self):
        u = utilities.Utilities(None)
        u.history = {"2026-09-29": 1_000_000_000, "2026-10-19": 3_000_000_000}            # 20 days apart, nothing between
        self.assertEqual(u.view()["per_day"], 100_000_000)
        u.history = {"2026-10-19": 5}
        self.assertIsNone(u.view()["per_day"])

    def test_memory_of_this_process_tree(self):
        kids = utilities.children_map()
        self.assertGreater(utilities.tree_rss(os.getpid(), kids), 0)
        self.assertEqual(utilities.tree_rss(999_999_999, kids), 0)
        self.assertGreater((utilities.machine_memory() or {}).get("total_mb", 1), 0)


if __name__ == "__main__":
    unittest.main()

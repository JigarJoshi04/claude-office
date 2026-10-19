"""Team templates (teamtpl.py): lane briefs from a folder, checked, capped and masked; bad files are named, not fatal."""
import json
import tempfile
import unittest
from pathlib import Path

from office import teamtpl


class TeamTemplateTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    def put(self, name, data):
        (self.dir / name).write_text(data if isinstance(data, str) else json.dumps(data))

    def test_one_or_a_list_per_file_and_bad_files_named(self):
        self.put("a.json", {"name": " Release notes ", "title": "Notes", "brief": "Write them.", "permission_mode": "bypassPermissions"})
        self.put("b.json", [{"name": "Deps", "title": "Bump", "brief": "Bump them."}, {"name": "Release notes", "title": "Dup", "brief": "Dup."}])
        self.put("c.json", "{not json")
        self.put("d.json", {"name": "No brief", "title": "x"})
        self.put("e.json", {"name": "Big", "title": "x", "brief": "b" * 20001})
        self.put("notes.txt", "not a template")
        self.put("f.json", "x" * (teamtpl.MAX_BYTES + 1))
        out = teamtpl.load(self.dir)
        self.assertEqual([(t["name"], t["file"]) for t in out["templates"]], [("Release notes", "a.json"), ("Deps", "b.json")])   # first of a name wins
        self.assertEqual(set(out["templates"][0]), {"name", "title", "brief", "file"})                          # nothing else gets through
        self.assertEqual({s["file"] for s in out["skipped"]}, {"c.json", "d.json", "e.json", "f.json"})
        self.assertIn("over 32 KB", next(s["why"] for s in out["skipped"] if s["file"] == "f.json"))

    def test_keys_are_masked_and_a_missing_folder_is_empty(self):
        self.put("k.json", {"name": "Deploy", "title": "Deploy", "brief": "Use token ghp_abcdefghijklmnopqrstuvwxyz123456 to push."})
        brief = teamtpl.load(self.dir)["templates"][0]["brief"]
        self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz123456", brief)
        self.assertIn("[hidden]", brief)
        self.assertEqual(teamtpl.load(self.dir / "nope")["templates"], [])

    def test_only_so_many_files(self):
        for i in range(teamtpl.MAX_FILES + 3):
            self.put(f"t{i:03}.json", {"name": f"T{i}", "title": "x", "brief": "y"})
        out = teamtpl.load(self.dir)
        self.assertEqual(len(out["templates"]), teamtpl.MAX_FILES)
        self.assertIn("3 more files", out["skipped"][0]["file"])


if __name__ == "__main__":
    unittest.main()

import json
import tempfile
import unittest
from pathlib import Path

from office import cabinet


class CabinetTests(unittest.TestCase):
    def test_titles_prompts_and_search(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "projects"
            (root / "-work-api").mkdir(parents=True)
            lines = [{"type": "user", "cwd": "/work/api", "message": {"content": [{"type": "text", "text": "Add  rate limits\\nper key"}]}},
                     {"type": "user", "message": {"content": [{"type": "tool_result", "content": "x"}]}},
                     {"type": "ai-title", "aiTitle": "Rate limits per API key"}]
            (root / "-work-api" / "s1.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines))
            (root / "-work-api" / "s2.jsonl").write_text(json.dumps({"type": "user", "cwd": "/work/api", "message": {"content": "Fix the login page"}}) + "\n")
            c = cabinet.Cabinet()
            c._build([root])
            self.assertEqual(c.index["s1"]["title"], "Rate limits per API key")
            self.assertTrue(c.index["s1"]["prompt"].startswith("Add rate limits"))
            seats = [{"id": "claude", "kind": "claude", "config_dir": "/home/me/.claude"}]
            ledger = {"s1": {"p": "api", "s": "claude", "fi": 1, "l": 200, "f": 10, "c": 90, "n": 3, "$": {"2026-10-01": 2_500_000}},
                      "s2": {"p": "api", "s": "claude", "fi": 1, "l": 300, "f": 5, "c": 5, "n": 1}}
            r = c.search(ledger, seats, "")
            self.assertEqual([x["id"] for x in r["rows"]], ["s2", "s1"])                    # newest first
            r = c.search(ledger, seats, "RATE key")
            self.assertEqual([x["id"] for x in r["rows"]], ["s1"])                          # every word, any case
            row = r["rows"][0]
            self.assertEqual((row["tokens"], row["usd"], row["has_transcript"]), (100, 2.5, True))
            self.assertEqual(row["resume"], 'cd "/work/api" && CLAUDE_CONFIG_DIR=/home/me/.claude claude --resume s1')
            self.assertEqual(c.search(ledger, seats, "", seat="nobody")["total"], 0)


if __name__ == "__main__":
    unittest.main()

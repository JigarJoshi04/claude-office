"""The morning standup (office/standup.py): every line from the office's records."""
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from office import standup


class StandupTests(unittest.TestCase):
    def test_yesterday_today_and_blockers(self):
        now = datetime(2026, 10, 19, 9, 0).timestamp()
        y0, y1 = standup.day_bounds(standup.yesterday_of(now))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "events.jsonl"
            rows = [{"ts": y0 + 10, "kind": "report", "level": "good", "text": "api filed its report: STATUS: DONE - fixed"},
                    {"ts": y0 + 20, "kind": "report", "level": "warn", "text": "web filed its report: STATUS: BLOCKED - creds"},
                    {"ts": y0 + 30, "kind": "shipped", "level": "good", "text": "api: PR #7 merged"},
                    {"ts": y0 + 40, "kind": "shipped", "level": "good", "text": "api: PR #8 opened"},
                    {"ts": y1 + 5, "kind": "report", "level": "good", "text": "today's report"}]
            path.write_text("\n".join(json.dumps(r) for r in rows) + "\nnot json\n")
            ev = standup.events_between(path, y0, y1)
        self.assertEqual(len(ev), 4)
        snap = {"seats": [{"id": "c2", "label": "claude2", "sessions": [{"name": "api", "kind": "desk", "state": "working", "title": "Rate limiter"}]}],
                "lanes": [{"title": "Docs", "status": "running", "seat": "c2"}, {"title": "Notes", "status": "scheduled", "schedule": {"at": now + 3600}}],
                "attention": [{"level": "warn", "ask": "a1", "text": "api asks: ship it?"}, {"level": "info", "text": "fyi"}]}
        out = standup.build(snap, ev, {"commits": 3, "prs_opened": 1, "prs_merged": 1}, now)
        self.assertEqual(out["yesterday"], ["api filed its report: STATUS: DONE - fixed", "api: PR #7 merged", "3 commits, 1 PR opened, 1 merged"])
        self.assertEqual(out["today"][0], "Lane 'Docs' is running on claude2")
        self.assertTrue(out["today"][1].startswith("Lane 'Notes' starts 10:00"))
        self.assertEqual(out["today"][2], "api on claude2: Rate limiter")
        self.assertEqual(out["blockers"], ["api asks: ship it?"])
        self.assertTrue(out["text"].startswith("*Standup, Mon 19 Oct*"))
        empty = standup.build({}, [], None, now)
        self.assertIn("• A quiet day", empty["text"]); self.assertIn("• None", empty["text"])

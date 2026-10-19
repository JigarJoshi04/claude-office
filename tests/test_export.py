"""Exports (export.py): rows per kind, CSV that a spreadsheet cannot run, and the month's report."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from office import export, lanes

SEATS = [{"id": "claude2", "label": "claude2", "nickname": "Atlas", "kind": "claude", "career": {"level": 5, "title": "Senior", "xp": 9000, "unlocked": {"a": 1}, "since": 1_800_000_000}},
         {"id": "astra", "label": "astra", "kind": "codex"}]
DAYS = {"2026-10-14": {"seats": {"claude2": {"active_min": 120, "sessions": 3, "reports": 2, "limits": 1, "tool_calls": 300, "tokens_fresh": 9000}}, "mvp": {"seat": "claude2"}},
        "2026-10-15": {"seats": {"claude2": {"active_min": 60, "sessions": 1, "reports": 5}}, "mvp": {"seat": "claude2"}},
        "2026-09-30": {"seats": {"claude2": {"active_min": 600, "reports": 9}}}}


class Tokens:
    def per_day_seat(self, known, codex=None):
        return {("2026-10-14", "claude2"): [1_000_000, 9_000_000, 50_000, 12.5, 4, 1, 1], ("2026-10-15", None): [10, 0, 0, 0.0, 0, 0, 0]}


class ExportTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        ev = Path(tmp.name) / "events.jsonl"
        ev.write_text(json.dumps({"ts": 1_800_000_000, "kind": "report", "seat": "claude2", "level": "good", "text": "=HYPERLINK(evil) filed"}) + "\n")
        lanes_now = [{"id": "l1", "title": "Fix it", "status": "done", "created_at": 1_800_000_000, "finished_at": 1_792_000_000, "runs": [{}],
                      "report_status": "STATUS: DONE - fixed"}]
        self.office = SimpleNamespace(get=lambda: {"seats": SEATS, "office": {"name": "Test Office"}, "promises": {"recent": []}, "lanes": lanes_now},
                                      samples=SimpleNamespace(ledger=SimpleNamespace(days=DAYS)), tokens=Tokens(), _events_path=ev)
        p = patch.object(lanes, "list_lanes", side_effect=AssertionError("the export reads the snapshot's lanes"))
        p.start(); self.addCleanup(p.stop)
        self.lanes_dir = Path(tmp.name) / "lanes"
        self.lanes_dir.mkdir()
        p = patch.object(lanes, "lanes_dir", return_value=self.lanes_dir)
        p.start(); self.addCleanup(p.stop)

    def test_rows_per_kind(self):
        days = export.rows(self.office, "days")
        self.assertEqual([(r["day"], r["name"], r["mvp"]) for r in days][:2], [("2026-09-30", "Atlas", 0), ("2026-10-14", "Atlas", 1)])
        self.assertEqual(export.rows(self.office, "careers")[0]["trophies"], 1)
        self.assertEqual(export.rows(self.office, "tokens")[0]["usd"], 12.5)
        self.assertEqual(export.rows(self.office, "lanes", private=True)[0]["title"], "")       # share-safe: no titles or reports
        self.assertEqual(export.rows(self.office, "events", private=True)[0]["text"], "")
        with self.assertRaises(ValueError):
            export.rows(self.office, "secrets")

    def test_lanes_older_than_the_snapshots_come_from_disk_and_share_safe_hides_the_title_in_the_id(self):
        old = self.lanes_dir / "0901-090000-acquire-initech"
        old.mkdir()
        (old / "lane.json").write_text(json.dumps({"id": old.name, "title": "Acquire Initech", "status": "done", "created_at": 1_788_000_000, "finished_at": 1_788_003_600}))
        (old / "REPORT.md").write_text("STATUS: DONE - bought\n")
        rows = export.rows(self.office, "lanes")
        self.assertEqual([r["id"] for r in rows], [old.name, "l1"])
        self.assertEqual(rows[0]["report"], "STATUS: DONE - bought")
        safe = export.rows(self.office, "lanes", private=True)
        self.assertNotIn("initech", json.dumps(safe).lower())
        self.assertRegex(safe[0]["id"], r"^lane-[0-9a-f]{8}$")
        self.assertIn("'\t=1+1", export.render([{"a": "\t=1+1"}], "csv")[0].decode())

    def test_csv_cannot_run_a_formula(self):
        body, ctype = export.render(export.rows(self.office, "events"), "csv")
        self.assertIn("'=HYPERLINK(evil) filed", body.decode())
        self.assertEqual(ctype, "text/csv; charset=utf-8")
        self.assertEqual(json.loads(export.render([{"a": 1}], "json")[0]), [{"a": 1}])
        with self.assertRaises(ValueError):
            export.render([], "xml")

    def test_the_months_report(self):
        md = export.report(self.office, "2026-10")
        self.assertIn("# Test Office · October 2026", md)
        self.assertIn("**7 reports** filed, **3.0 h** of agent work across **4 session-days**", md)   # September's day left out
        self.assertIn("worth **$12** at API list prices", md)
        self.assertIn("| Atlas | 3.0 | 7 | 4 | 2 |", md)
        self.assertIn("Usage limits hit: 1.", md)
        self.assertIn("Nothing on record", export.report(self.office, "2025-01"))
        with self.assertRaises(ValueError):
            export.report(self.office, "Oct")
        self.assertIn("| Hercules | 3.0 |", export.report(self.office, "2026-10", names=export.names_from('{"claude2": "Hercules", "x": 5}')))
        self.assertEqual(export.names_from("not json"), {})


class MarkdownTests(unittest.TestCase):
    def test_a_conversation_with_its_steps(self):
        items = [{"ts": 1_800_000_000, "role": "brief", "title": "Fix it", "text": "Fix the export."},
                 {"ts": 1_800_000_060, "role": "assistant", "text": "On it."}, {"ts": 1, "role": "step", "text": "Run `pytest`"},
                 {"ts": 1, "role": "step", "text": "Editing a.py"}, {"ts": 1_800_000_120, "role": "user", "text": "Thanks"},
                 {"ts": 1, "role": "notice", "text": "Earlier messages are not shown."}]
        md = export.conversation_md(items, "api", "Atlas")
        self.assertTrue(md.startswith("# api · Atlas"))
        self.assertIn("**Brief: Fix it**", md)
        self.assertIn("- `Run 'pytest'`\n- `Editing a.py`", md)
        self.assertIn("**You** ·", md)
        self.assertIn("*Earlier messages are not shown.*", md)

    def test_a_lanes_handoff_pack(self):
        lane = {"id": "l1", "title": "Fix it", "status": "done", "seat": "claude2", "model": "opus", "created_at": 1_800_000_000, "workdir": "/w",
                "worktree": {"branch": "lane/l1"}, "spent": {"tokens": 1234567, "usd": 3.5}, "shipped": {"commits": 2, "prs_opened": 1, "prs_merged": 0},
                "trust": {"level": "verified", "why": "its tests passed"}, "runs": [{"seat": "claude2", "started_at": 1_800_000_000, "ended_at": 1_800_000_600, "ended_by": "limit"}]}
        md = export.lane_pack(lane, "The brief.", "STATUS: DONE - fixed", "10:00 started", {"claude2": "Atlas"})
        for want in ("# Fix it", "verified: its tests passed", "Atlas, opus", "`lane/l1`", "1,234,567", "2 commits", "## The report", "ended by its limit"):
            self.assertIn(want, md)


if __name__ == "__main__":
    unittest.main()

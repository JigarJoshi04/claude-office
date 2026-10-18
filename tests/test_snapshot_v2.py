import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from office import config, sessions
from office.snapshot import Office, _codex_seat


class SnapshotV2Tests(unittest.TestCase):
    def test_codex_total_comes_from_rollout(self):
        with patch("office.snapshot.read_codex_seat", return_value={"sessions": [{
                "id": "test", "cwd": "/work", "live": True, "tokens": {"total": 12345}}]}):
            result = _codex_seat({"id": "astra"}, 100000)
        self.assertEqual(result["sessions"][0]["tokens_total"], 12345)

    def test_claude_session_exposes_fresh_total(self):
        with tempfile.TemporaryDirectory() as tmp:
            import json
            root = Path(tmp)
            (root / "sessions").mkdir()
            (root / "sessions/123.json").write_text(json.dumps({"pid": 123, "sessionId": "one", "cwd": "/work"}))
            tr = sessions.TranscriptState(root / "transcript")
            tr.fresh_total = 1234
            cache = Mock()
            cache.read.return_value = tr
            with patch.object(sessions, "proc_start_ticks", return_value="valid"), \
                 patch.object(sessions, "proc_argv", return_value=[]), \
                 patch.object(sessions, "proc_unit", return_value=None), \
                 patch.object(sessions, "proc_cpu_seconds", return_value=0), \
                 patch.object(sessions, "find_transcript", return_value=tr.path):
                result = sessions.list_sessions({"id": "a", "config_dir": tmp}, cache, now=100000)
            self.assertEqual(result[0]["tokens_total"], 1234)

    def test_report_is_emitted_once_even_if_report_temporarily_disappears(self):
        office = Office.__new__(Office)
        office._reported = set()
        office.emit = Mock()
        before = {"seats": [{"id": "a", "label": "A", "sessions": [{"id": "s", "name": "Test",
                   "kind": "lane", "state": "working", "report_status": None}]}]}
        after = copy.deepcopy(before)
        after["seats"][0]["sessions"][0]["report_status"] = "STATUS: DONE"
        office._diff(before, after)
        office._diff(after, after)
        office._diff(after, before)
        office._diff(before, after)
        office.emit.assert_called_once_with("report", "Test filed its report: STATUS: DONE", "a", "good")

    def test_emit_persists_and_fans_out_and_invokes_announcer(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(config, "HOME", Path(tmp)), \
             patch.object(config, "CONFIG_DIR", Path(tmp)/"cfg"), \
             patch.object(config, "STATE_DIR", Path(tmp)/"state"), \
             patch.object(config, "DATA_DIR", Path(tmp)/"data"):
            office = Office()
            office.announcer = Mock()
            client, _, _ = office.subscribe()
            other, _, _ = office.subscribe()
            office.emit("report", "Test report", "a", "good", ts=0)
            self.assertEqual(office.events[-1]["ts"], 0)
            self.assertEqual(len(client.news), 1)
            self.assertEqual(list(other.news), list(client.news))
            self.assertIn('"kind": "report"', (Path(tmp)/"state/events.jsonl").read_text())
            office.announcer.announce.assert_called_once_with(office.events[-1], office.cfg, demo=False)


class GhostUseTests(unittest.TestCase):
    def test_plan_use_this_machine_did_not_make(self):
        from office.snapshot import ghost_use
        now = 100_000.0
        rows = [[now - 2400 + i * 300, 40 + i, 10] for i in range(9)]          # +1% every 5 minutes for 40 minutes
        g = ghost_use(rows, last_local=now - 3 * 3600, working=False, now=now)
        self.assertEqual((g["rise"], g["minutes"]), (8, 40))
        self.assertIsNone(ghost_use(rows, last_local=now - 3 * 3600, working=True, now=now))     # a session here is at it
        self.assertIsNone(ghost_use(rows, last_local=now - 60, working=False, now=now))          # a call here explains it
        late = ghost_use(rows, last_local=now - 1500, working=False, now=now)                      # only what came after
        self.assertEqual(late["rise"], 4)
        flat = [[now - 2400 + i * 300, 40, 10] for i in range(9)]
        self.assertIsNone(ghost_use(flat, None, False, now))
        reset = [[now - 2400, 95, 10], [now - 2100, 97, 10], [now - 1800, 2, 10], [now - 1500, 4, 10]]
        self.assertIsNone(ghost_use(reset, None, False, now))                                    # a reset is not use
        self.assertIsNone(ghost_use([[now - 300, None, 1], [now, None, 2]], None, False, now))

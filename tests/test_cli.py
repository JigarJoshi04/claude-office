"""The terminal commands (events, token) and the start-up lock-down of the office's files."""
import argparse
import io
import json
import os
import stat
import tempfile
import time
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest.mock import patch

from office import __main__ as cli, config, export


class EventsTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name)
        p = patch.object(config, "STATE_DIR", self.state)
        p.start(); self.addCleanup(p.stop)

    def run_events(self, **kw):
        args = argparse.Namespace(**{"follow": False, "lines": 20, "kind": None, "json": False, **kw})
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.cmd_events(args)
        return code, out.getvalue(), err.getvalue()

    def test_the_last_lines_filtered_by_kind(self):
        rows = [{"ts": 1_800_000_000 + i, "kind": "report" if i % 2 else "limit", "seat": "claude2", "text": f"news {i}"} for i in range(6)]
        (self.state / "events.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\nnot json\n[1]\n")
        code, out, _ = self.run_events(lines=4)
        self.assertEqual(code, 0)
        self.assertEqual([l.split()[-1] for l in out.splitlines()], ["2", "3", "4", "5"])   # the last 4 events; junk lines are no events
        code, out, _ = self.run_events(kind="report", json=True)
        self.assertEqual([json.loads(l)["text"] for l in out.splitlines()], ["news 1", "news 3", "news 5"])
        self.assertEqual(self.run_events(kind="limit", lines=2)[1].count("\n"), 2)        # the kind first, then the last N
        self.assertEqual(self.run_events(lines=0)[1], "")
        self.assertEqual(self.run_events(lines=-3)[0], 2)

    def test_odd_records_and_terminal_escapes(self):
        rows = [{"ts": "soon", "kind": None, "text": "deploy \x1b]0;pwned\x07 done"}, {"ts": 1e20, "kind": {"a": 1}, "text": 5}, {"ts": float("nan"), "kind": "x"}]
        (self.state / "events.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n\xff\n")
        code, out, _ = self.run_events()
        self.assertEqual((code, len(out.splitlines())), (0, 3))
        self.assertNotIn("\x1b", out); self.assertNotIn("\x07", out)
        code, out, _ = self.run_events(json=True)
        for line in out.splitlines():
            json.loads(line)                                                       # NaN is written as null

    def test_no_news_yet(self):
        code, out, err = self.run_events()
        self.assertEqual((code, out), (1, ""))
        self.assertIn("No news yet", err)


class TokenTests(unittest.TestCase):
    def test_rotate_makes_a_new_private_token(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(config, "CONFIG_DIR", Path(tmp)):
            old = config.api_token()
            path = Path(tmp) / "token"
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with redirect_stdout(io.StringIO()) as out:
                cli.cmd_token(argparse.Namespace(rotate=False))
            self.assertNotIn(old, out.getvalue())                    # where it is kept, never the token itself
            self.assertEqual(config.api_token(), old)
            with redirect_stdout(io.StringIO()) as out:
                cli.cmd_token(argparse.Namespace(rotate=True))
            new = config.api_token()
            self.assertNotEqual(new, old)
            self.assertNotIn(new, out.getvalue())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)


class TokenFollowTests(unittest.TestCase):
    def test_the_server_follows_a_rotated_token_and_an_empty_file_is_made_again(self):
        from office import server
        with tempfile.TemporaryDirectory() as tmp, patch.object(config, "CONFIG_DIR", Path(tmp)):
            class H(server.Handler):
                pass
            H.demo, H.token, H._token_key = False, config.api_token(), None
            h = H.__new__(H)
            first = h._token()
            with redirect_stdout(io.StringIO()):
                cli.cmd_token(argparse.Namespace(rotate=True))
            self.assertNotEqual(h._token(), first)                   # no restart needed
            self.assertEqual(h._token(), (Path(tmp) / "token").read_text().strip())
            (Path(tmp) / "token").write_text("")
            self.assertEqual(config.api_token(), "")                 # just made, perhaps still being written: left alone
            os.utime(Path(tmp) / "token", (time.time() - 60, time.time() - 60))
            self.assertTrue(config.api_token())                      # an old empty token file is made again


class LockDownTests(unittest.TestCase):
    def test_folders_and_files_made_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg, state, data = root / "cfg", root / "state", root / "data"
            for d in (cfg, state, data):
                d.mkdir(); d.chmod(0o755)
            (cfg / "token").write_text("x"); (cfg / "token").chmod(0o644)
            (state / "save.json").write_text("{}"); (state / "save.json").chmod(0o640)
            (state / "ok.json").write_text("{}"); (state / "ok.json").chmod(0o600)
            (data / "lane.md").write_text("brief"); (data / "lane.md").chmod(0o644)
            outside = root / "outside.txt"; outside.write_text("x"); outside.chmod(0o644)
            (state / "link").symlink_to(outside)
            with patch.object(config, "CONFIG_DIR", cfg), patch.object(config, "STATE_DIR", state), patch.object(config, "DATA_DIR", data):
                self.assertEqual(config.lock_down(), 5)              # 3 folders, the token and the save
                self.assertEqual(config.lock_down(), 0)              # nothing left to do
            mode = lambda p: stat.S_IMODE(p.stat().st_mode)
            self.assertEqual([mode(d) for d in (cfg, state, data)], [0o700] * 3)
            self.assertEqual((mode(cfg / "token"), mode(state / "save.json")), (0o600, 0o600))
            self.assertEqual(mode(data / "lane.md"), 0o644)          # the data folder's files: only the folder is closed
            self.assertEqual(mode(outside), 0o644)                   # a link is never followed

    def test_missing_folders_are_fine(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(config, "CONFIG_DIR", Path(tmp) / "a"), \
                patch.object(config, "STATE_DIR", Path(tmp) / "b"), patch.object(config, "DATA_DIR", Path(tmp) / "c"):
            self.assertEqual(config.lock_down(), 0)
            self.assertFalse((Path(tmp) / "a").exists())


class CalendarTests(unittest.TestCase):
    def test_resets_and_run_outs_within_the_week(self):
        now = time.time()
        seats = [{"id": "claude2", "kind": "claude", "nickname": "Atlas; the, first",
                  "usage": {"five_hour": {"resets_at": now + 3600}, "weekly": {"resets_at": now + 30 * 86400}},
                  "forecast": {"five_hour": {"state": "runs_out", "out_at": now + 1800, "per_hour": 40.5},
                               "weekly": {"state": "runs_out", "out_at": now + 2 * 86400, "per_hour": 1.0}}},
                 {"id": "claude3", "kind": "claude", "usage": {"five_hour": {"resets_at": now - 60}}, "forecast": {"five_hour": {"state": "lasts"}}},
                 {"id": "astra", "kind": "codex", "usage": {"five_hour": {"resets_at": now + 60}}}]
        ics = export.plan_calendar({"seats": seats})
        self.assertTrue(ics.startswith("BEGIN:VCALENDAR\r\n") and ics.endswith("END:VCALENDAR\r\n"))
        self.assertEqual(ics.count("BEGIN:VEVENT"), 3)       # 5-hour reset, 5-hour run-out, the week's run-out (its reset is past 8 days)
        self.assertIn("SUMMARY:Atlas\\; the\\, first: 5-hour window resets", ics)
        self.assertNotIn("claude3", ics); self.assertNotIn("astra", ics)
        self.assertTrue(all(len(l.encode()) <= 75 for l in ics.split("\r\n")))
        unfolded = ics.replace("\r\n ", "")
        self.assertIn("At 40.5% an hour Atlas\\; the\\, first's 5-hour window runs out before it resets.", unfolded)
        self.assertIn("SUMMARY:Hera: week runs out", export.plan_calendar({"seats": seats}, {"claude2": "Hera"}).replace("\r\n ", ""))

    def test_fold_keeps_characters_whole(self):
        line = "DESCRIPTION:" + "é" * 80
        folded = export._fold(line)
        self.assertEqual(folded.replace("\r\n ", ""), line)
        self.assertTrue(all(len(l.encode()) <= 75 for l in folded.split("\r\n")))


if __name__ == "__main__":
    unittest.main()

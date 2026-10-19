"""Open in… (opener.py): the folder comes from the office, the program is a list of arguments, a finished lane's terminal
resumes its conversation, and nothing runs in a test."""
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from office import lanes, opener

SID = "00000000-0000-4000-8000-000000000001"


class OpenerTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.snap = {"seats": [{"id": "c2", "kind": "claude", "config_dir": "/home/u/.claude2",
                                "sessions": [{"id": "s1", "cwd": self.dir, "live": True}, {"id": "gone", "cwd": self.dir, "live": False}]}]}
        self.office = SimpleNamespace(get=lambda: self.snap, cfg={})
        self.have = {"xdg-open", "code", "ptyxis"}
        opener._last[0] = 0

    def cmd(self, **body):
        return opener.command(self.office, body, which=lambda n: n in self.have)

    def test_folder_editor_and_terminal_for_a_live_session(self):
        self.assertEqual(self.cmd(what="folder", seat="c2", id="s1"), ["xdg-open", self.dir])
        self.assertEqual(self.cmd(what="editor", seat="c2", id="s1"), ["code", self.dir])
        self.assertEqual(self.cmd(what="terminal", seat="c2", id="s1"), ["ptyxis", "--new-window", f"--working-directory={self.dir}"])
        self.have = {"xdg-open", "konsole"}
        self.assertEqual(self.cmd(what="terminal", seat="c2", id="s1")[:2], ["konsole", "--workdir"])
        with self.assertRaisesRegex(ValueError, "No editor"):
            self.cmd(what="editor", seat="c2", id="s1")

    def test_refusals(self):
        for body, why in (({"what": "shell", "seat": "c2", "id": "s1"}, "Open what"), ({"what": "folder", "seat": "c2", "id": "gone"}, "not running"),
                          ({"what": "folder", "seat": "nope", "id": "s1"}, "not running")):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, why):
                self.cmd(**body)
        self.snap["seats"][0]["sessions"][0]["cwd"] = self.dir + "/missing"
        with self.assertRaisesRegex(ValueError, "not there"):
            self.cmd(what="folder", seat="c2", id="s1")

    def test_a_finished_lane_carries_on_in_its_terminal(self):
        lane = {"id": "l1", "workdir": self.dir, "seat": "c2", "status": "done", "last_session_id": SID}
        with patch.object(lanes, "load_lane", return_value=lane):
            argv = self.cmd(what="terminal", lane="l1")
            self.assertEqual(argv[-3:-1], ["bash", "-lc"])
            self.assertIn(f"claude --resume {SID}", argv[-1])
            self.assertIn("CLAUDE_CONFIG_DIR=/home/u/.claude2", argv[-1])
            lane["status"] = "running"
            self.assertNotIn("bash", self.cmd(what="terminal", lane="l1"))      # a running lane: just a terminal there
            lane.update(status="done", last_session_id="; rm -rf ~")
            self.assertNotIn("bash", self.cmd(what="terminal", lane="l1"))      # an id that is not one is never run

    def test_your_own_programs_and_one_a_second(self):
        self.office.cfg = {"open": {"editor": ["nvim-qt", "{dir}"], "folder": "not a list"}}
        self.assertEqual(self.cmd(what="editor", seat="c2", id="s1"), ["nvim-qt", self.dir])
        self.assertEqual(self.cmd(what="folder", seat="c2", id="s1"), ["xdg-open", self.dir])
        ran = []
        with patch.object(opener.shutil, "which", side_effect=lambda n: n in self.have):
            r = opener.open_target(self.office, {"what": "folder", "seat": "c2", "id": "s1"}, popen=lambda argv, **kw: ran.append((argv, kw)))
            self.assertEqual((r["program"], ran[0][0], ran[0][1]["start_new_session"]), ("xdg-open", ["xdg-open", self.dir], True))
            with self.assertRaisesRegex(ValueError, "One moment"):
                opener.open_target(self.office, {"what": "folder", "seat": "c2", "id": "s1"}, popen=lambda argv, **kw: ran.append(argv))


if __name__ == "__main__":
    unittest.main()

"""The public view (public.py): an allow-list, so a snapshot full of private things gives none of them away; its
Prometheus form; and the beacon file other programs read."""
import json
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path

from office import public

PRIVATE = ["Fix the secret billing bug", "/home/someone/work/billing", "uds:/run/user/1000/cc.sock", "claude --resume 1234",
           "/home/someone/.claude2", "someone@example.invalid", "Editing payments.py", "Refund customer #8812", "ghp_abcdefghijklmnopqrstuvwxyz1234"]


def snap():
    now = time.time()
    x = {"id": "00000000-0000-4000-8000-000000000001", "name": PRIVATE[0], "title": PRIVATE[0], "cwd": PRIVATE[1], "socket": PRIVATE[2],
         "resume_cmd": PRIVATE[3], "activity": PRIVATE[6], "task": PRIVATE[7], "last_prompt": PRIVATE[8], "state": "working", "kind": "lane", "live": True}
    return {"now": now - 3, "office": {"name": "Demo office", "version": "9.9.9", "faults": [{"part": "x", "what": PRIVATE[1]}]},
            "seats": [{"id": "c2", "label": "claude2", "nickname": "Atlas", "kind": "claude", "status": "working", "config_dir": PRIVATE[4],
                       "account": {"email": PRIVATE[5]}, "usage": {"five_hour": {"pct": 40, "resets_at": now + 600}, "weekly": {"pct": None}},
                       "career": {"xp": 6400, "level": 9}, "tokens_1h": 1200, "sessions": [x, dict(x, state="stuck", kind="desk"), dict(x, live=False)]},
                      {"id": 'we"ird\\seat', "kind": "codex", "sessions": []}],
            "totals": {"sessions": 2, "working": 1, "lanes": 1, "tokens_1h": 1200}, "attention": [{"text": PRIVATE[7]}],
            "lanes": [{"status": "running", "title": PRIVATE[0]}, {"status": "running"}, {"status": "done"}]}


class PublicViewTests(unittest.TestCase):
    def test_nothing_private_gets_out(self):
        v = public.view(snap())
        blob = json.dumps(v) + public.metrics(snap())
        for p in PRIVATE:
            self.assertNotIn(p, blob)
        s = v["seats"][0]
        self.assertEqual((s["name"], s["sessions"], s["working"], s["stuck"], s["lanes"]), ("Atlas", 2, 1, 1, 1))
        self.assertEqual((s["five_hour"]["used_pct"], s["weekly"]), (40, None))
        self.assertEqual((v["office"]["level"], v["totals"]["needs_you"], v["totals"]["problems"], v["lanes"]), (5, 1, 1, {"running": 2}))   # lanes still to finish (all in the snapshot)

    def test_metrics_lines_and_label_escaping(self):
        text = public.metrics(snap(), {"builds": 3, "p50_ms": 20.0, "p95_ms": 900.0})
        self.assertIn('claude_office_plan_used_percent{seat="c2",window="five_hour"} 40', text)
        self.assertNotIn('window="weekly"} None', text)                       # no reading, no series
        self.assertIn('claude_office_lanes{status="running"} 2', text)
        self.assertIn('seat="we\\"ird\\\\seat"', text)
        self.assertIn('claude_office_refresh_seconds{quantile="0.95"} 0.9', text)
        self.assertIn("claude_office_office_level 5", text)
        for line in text.splitlines():                                       # every line is a comment or "name{labels} number"
            self.assertRegex(line, r'^(# (HELP|TYPE) claude_office_\w+ .+|claude_office_\w+(\{.*\})? -?[0-9.e+]+)$')

    def test_the_beacon_file_is_whole_and_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = os.umask(0o077)
            try:
                dest = public.write_beacon(snap(), os.path.join(tmp, "sub", "beacon.json"))
            finally:
                os.umask(old)
            self.assertEqual(stat.S_IMODE(dest.stat().st_mode), 0o644)
            self.assertEqual(json.loads(dest.read_text())["schema"], public.SCHEMA)
            self.assertEqual([p.name for p in dest.parent.iterdir()], ["beacon.json"])   # no temp file left behind


if __name__ == "__main__":
    unittest.main()

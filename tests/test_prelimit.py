"""Pre-limit save (prelimit.py): lanes on a seat about to run out are asked to write their notes, once per window."""
import tempfile
import unittest
from pathlib import Path

from office import prelimit, settings

ON = {"automation": {"prelimit_save": True, "lead_min": 10}}
NOW = 1_800_000_000


def seat(pct=60, out_in=None, status="working", sessions=None, weekly=40, kind="claude"):
    fc = {"five_hour": {"state": "runs_out", "out_at": NOW + out_in} if out_in is not None else {"state": "lasts"}}
    return {"id": "claude2", "label": "claude2", "nickname": "Atlas", "kind": kind, "status": status,
            "usage": {"five_hour": {"pct": pct, "resets_at": NOW + 3600}, "weekly": {"pct": weekly, "resets_at": NOW + 86400}}, "forecast": fc,
            "sessions": sessions if sessions is not None else [{"id": "s1", "name": "api lane", "talk": "direct", "live": True},
                                                               {"id": "s2", "name": "a terminal", "talk": "review", "live": True}]}


class PreLimitTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.p = prelimit.PreLimit(None)

    def send(self, s, x, text):
        self.sent.append((s["id"], x["id"], text))

    def test_off_by_default(self):
        self.assertEqual(self.p.run([seat(out_in=300)], {}, NOW, self.send), [])
        self.assertEqual(self.sent, [])

    def test_lanes_are_asked_once_per_window_and_terminals_never(self):
        news = self.p.run([seat(out_in=300)], ON, NOW, self.send)
        self.assertEqual(news, [("claude2", "5-hour window", ["api lane"])])
        self.assertEqual([x for _, x, _ in self.sent], ["s1"])
        self.assertIn("Atlas is about to run out of its 5-hour window (about 5 min left at this pace)", self.sent[0][2])
        self.assertEqual(self.p.run([seat(out_in=200)], ON, NOW + 60, self.send), [])      # the same window: not again
        self.assertEqual(len(self.sent), 1)

    def test_when_it_is_due(self):
        self.assertIsNone(prelimit.due(seat(out_in=3600), NOW, 600))                        # an hour away: not yet
        self.assertEqual(prelimit.due(seat(pct=96), NOW, 600)["when"], "96% used")           # nearly full, whatever the pace
        self.assertEqual(prelimit.due(seat(weekly=99), NOW, 600)["key"], "weekly")
        self.assertIsNone(prelimit.due(seat(pct=100), NOW, 600))                            # already out
        for s in (seat(out_in=300, status="limited"), seat(out_in=300, kind="codex"), seat(out_in=300, sessions=[])):
            self.assertEqual(self.p.run([s], ON, NOW, self.send), [])

    def test_a_failed_send_is_tried_again(self):
        def fail(*a):
            raise OSError("socket gone")
        self.assertEqual(self.p.run([seat(out_in=300)], ON, NOW, fail), [])
        self.assertEqual(len(self.p.run([seat(out_in=300)], ON, NOW + 30, self.send)), 1)

    def test_kept_across_a_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prelimit.json"
            prelimit.PreLimit(path).run([seat(out_in=300)], ON, NOW, self.send)
            self.assertEqual(prelimit.PreLimit(path).run([seat(out_in=300)], ON, NOW + 60, self.send), [])

    def test_settings(self):
        self.assertEqual(prelimit.settings({}), {"prelimit_save": False, "lead_min": 10})
        self.assertEqual(settings.validate({"automation": {"prelimit_save": True, "lead_min": 20}})["automation"], {"prelimit_save": True, "lead_min": 20})
        for bad in ({"prelimit_save": "yes"}, {"lead_min": 7}, {"lead_min": True}, {"other": 1}, []):
            with self.assertRaises(ValueError):
                settings.validate({"automation": bad})


if __name__ == "__main__":
    unittest.main()

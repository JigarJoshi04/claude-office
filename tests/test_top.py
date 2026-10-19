"""claude-office top: the office as text rows (top.lines is pure)."""
import unittest

from office import top

SNAP = {"now": 1_800_000_000, "office": {"version": "3.112.0"}, "totals": {"tokens_1h": 2_500_000},
        "attention": [{"level": "warn", "ask": "a1", "text": "api on claude2 asks: ship it?"}, {"level": "bad", "text": "billing on claude3: Force-pushed"}],
        "seats": [{"id": "claude2", "nickname": "Atlas", "status": "working", "usage": {"five_hour": {"pct": 64}, "weekly": {"pct": 48}},
                   "sessions": [{"id": "s1", "name": "api", "kind": "lane", "state": "working", "phase": "testing", "activity": "Running pytest", "live": True},
                                {"id": "s2", "name": "notes", "kind": "desk", "state": "idle", "activity": "Reading secret plans", "live": True}]}],
        "lanes": [{"id": "l1", "title": "Docs", "status": "waiting"}, {"id": "l2", "title": "Old", "status": "done"}],
        "events": [{"ts": 1_800_000_000, "kind": "report", "level": "good", "text": "api filed its report: STATUS: DONE"}]}


class TopTests(unittest.TestCase):
    def test_the_screen(self):
        text = "\n".join(t for t, _ in top.lines(SNAP, 100))
        self.assertIn("1 at work · 2 need you · 2.5M tokens/h", text)
        self.assertIn("Atlas", text)
        self.assertIn(" 36%", text)                                   # 5-hour left
        self.assertIn("[testing] Running pytest", text)
        self.assertIn("Docs", text)
        self.assertNotIn("Old", text)                                 # finished lanes are not out
        self.assertIn("api filed its report", text)

    def test_share_safe_hides_words(self):
        text = "\n".join(t for t, _ in top.lines(SNAP, 100, private=True))
        self.assertIn("An agent asks you a question", text)
        self.assertNotIn("ship it?", text)
        self.assertNotIn("Reading secret plans", text)                 # a desk's activity
        self.assertNotIn("STATUS: DONE", text)
        self.assertIn("report news", text)
        snap = dict(SNAP, attention=[{"level": "warn", "bakeoff": "b1", "text": "Bake-off 'Secret pricing' is ready to judge: A done"},
                                     {"level": "warn", "collision": "/w/secret-repo", "seat": "claude2", "text": "api and web are both editing secret-repo"}])
        text = "\n".join(t for t, _ in top.lines(snap, 100, private=True))
        self.assertNotIn("Secret pricing", text)
        self.assertNotIn("secret-repo", text)
        self.assertIn("Two sessions share a working tree on Atlas", text)          # the nickname, not the seat id
        self.assertNotIn("Docs", text)                                 # a lane's title
        snap = dict(SNAP, attention=[{"level": "warn", "stuck": True, "seat": "claude2", "text": "secret-lane on claude2 quiet for 20 min"},
                                     {"level": "warn", "seat": "claude2", "text": "secret-desk is blocked: needs the prod key"}])
        text = "\n".join(t for t, _ in top.lines(snap, 100, private=True))
        self.assertNotIn("secret", text)

    def test_narrow_and_empty(self):
        rows = top.lines({"seats": [], "office": {}}, 20)
        self.assertTrue(all(len(t) <= 40 for t, _ in rows))
        self.assertIn("All clear.", [t.strip() for t, _ in rows])


if __name__ == "__main__":
    unittest.main()

"""One message to a group (talk.broadcast): who is in each group, the page's picks, the count it saw, the cap,
placeholders per target, macros; and the `message` command."""
import argparse
import io
import unittest
from contextlib import redirect_stdout, redirect_stderr
from types import SimpleNamespace
from unittest.mock import patch

from office import __main__ as cli, talk

U = lambda n: f"00000000-0000-4000-8000-{n:012d}"


def snap():
    lane = lambda n, **kw: dict({"id": U(n), "kind": "lane", "name": f"lane{n}", "talk": "direct", "state": "working"}, **kw)
    return {"seats": [
        {"id": "c2", "kind": "claude", "nickname": "Atlas", "usage": {"five_hour": {"resets_at": 1_800_000_000}}, "sessions": [
            lane(1, programme={"key": "apollo"}), lane(2, state="stuck"), lane(3, talk="followup"),
            {"id": U(4), "kind": "desk", "name": "term", "talk": "review", "state": "working"}]},
        {"id": "c3", "kind": "claude", "label": "claude3", "sessions": [lane(5, loop={"count": 9}), lane(6, programme={"key": "apollo"})]},
        {"id": "astra", "kind": "codex", "sessions": [lane(7)]},
    ]}


class BroadcastTests(unittest.TestCase):
    def setUp(self):
        self.office = SimpleNamespace(get=snap, cfg={"message_macros": [{"name": "Mine", "text": "Hi {{seat}}"}, {"name": "", "text": "x"}, "junk"]})
        self.sent = []
        p = patch.object(talk, "send", side_effect=lambda office, body, ids: self.sent.append(body) or {"ok": True, "delivery": "review" if body["id"] == U(4) else "direct"})
        p.start(); self.addCleanup(p.stop)

    def ids(self, **body):
        return [t["id"][-1] for t in talk.broadcast(self.office, dict(body, dry=True), [])["targets"]]

    def test_who_is_in_each_group(self):
        self.assertEqual(self.ids(group="lanes"), ["1", "2", "5", "6"])               # no follow-ups, no Codex, no terminals
        self.assertEqual(self.ids(group="lanes", terminals=True), ["1", "2", "4", "5", "6"])
        self.assertEqual(self.ids(group="stuck"), ["2", "5"])                         # stuck, or a loop of 8 or more
        self.assertEqual(self.ids(group="seat", value="c3"), ["5", "6"])
        self.assertEqual(self.ids(group="programme", value="apollo"), ["1", "6"])
        self.assertEqual(self.ids(group="lanes", only=[U(1), U(6), "nope"]), ["1", "6"])
        with self.assertRaisesRegex(ValueError, "Pick who"):
            self.ids(group="everyone")

    def test_the_count_the_page_saw_must_match(self):
        with self.assertRaisesRegex(ValueError, "changed: 4 now"):
            talk.broadcast(self.office, {"group": "lanes", "text": "hi", "expect": 3}, [])
        self.assertEqual(self.sent, [])
        r = talk.broadcast(self.office, {"group": "lanes", "terminals": True, "text": "Notes, {{seat}}: {{lane_title}} at {{reset_time}}", "expect": 5}, [])
        self.assertEqual((r["sent"], r["held"], r["failed"]), (4, 1, 0))
        self.assertTrue(self.sent[0]["text"].startswith("Notes, Atlas: lane1 at "))
        self.assertIn("claude3: lane5 at its next reset", self.sent[3]["text"])        # no reading: no time made up
        with self.assertRaisesRegex(ValueError, "Write a message"):
            talk.broadcast(self.office, {"group": "lanes", "text": " ", "expect": 4}, [])

    def test_a_failure_is_counted_not_fatal_and_the_cap_holds(self):
        with patch.object(talk, "send", side_effect=[{"delivery": "direct"}, ValueError("gone"), {"delivery": "direct"}, {"delivery": "direct"}]):
            r = talk.broadcast(self.office, {"group": "lanes", "text": "hi", "expect": 4}, [])
        self.assertEqual((r["sent"], r["failed"]), (3, 1))
        self.assertEqual(r["results"][1]["error"], "gone")
        with patch.object(talk, "BROADCAST_MAX", 3), self.assertRaisesRegex(ValueError, "at most 3"):
            talk.broadcast(self.office, {"group": "lanes", "text": "hi", "expect": 4}, [])

    def test_macros_mine_first_bad_ones_left_out(self):
        names = [m["name"] for m in talk.macros(self.office.cfg)]
        self.assertEqual(names[0], "Mine")
        self.assertEqual(len(names), 1 + len(talk.MACROS))


class MessageCommandTests(unittest.TestCase):
    def test_lists_then_sends_with_the_count(self):
        calls = []
        def post(path, body, port):
            calls.append(body)
            if body.get("dry"):
                return 200, {"targets": [{"seat": "c2", "id": U(1), "kind": "lane", "name": "lane1", "talk": "direct"}], "count": 1}
            return 200, {"ok": True, "sent": 1, "held": 0, "failed": 0}
        args = argparse.Namespace(text="hi", stuck=False, all=False, seat=None, programme="apollo", terminals=False, dry=False, port=None)
        with patch.object(cli, "_post", side_effect=post), redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cli.cmd_message(args), 0)
        self.assertEqual(calls[1], {"group": "programme", "value": "apollo", "terminals": False, "text": "hi", "expect": 1})
        self.assertIn("Sent to 1.", out.getvalue())
        with patch.object(cli, "_post", side_effect=post), redirect_stdout(io.StringIO()):
            calls.clear(); self.assertEqual(cli.cmd_message(argparse.Namespace(**dict(vars(args), dry=True))), 0)
        self.assertEqual(len(calls), 1)                                               # --dry never sends


if __name__ == "__main__":
    unittest.main()

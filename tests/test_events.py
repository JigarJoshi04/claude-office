import unittest

from office import server


class InboundEventTests(unittest.TestCase):
    def test_a_scripts_news_is_checked(self):
        ok = server.inbound_event({"text": "  Prod   deploy done ", "level": "good", "seat": "claude", "source": "deploy", "banner": True}, ["claude"])
        self.assertEqual(ok, {"text": "Prod deploy done", "level": "good", "seat": "claude", "source": "deploy", "banner": True})
        self.assertEqual(server.inbound_event({"text": "x"}, [])["level"], "info")
        for bad in ({"text": ""}, {"text": "x" * 141}, {"text": "x", "level": "loud"}, {"text": "x", "seat": "nobody"},
                    {"text": "x", "source": "<script>"}, {"text": "x", "banner": "yes"}, {"text": 3}, []):
            with self.assertRaises(ValueError, msg=bad):
                server.inbound_event(bad, ["claude"])

    def test_at_most_thirty_a_minute(self):
        server._EVENTS.clear()
        self.assertTrue(all(server._event_budget(now=1000 + i) for i in range(30)))
        self.assertFalse(server._event_budget(now=1031))
        self.assertTrue(server._event_budget(now=1061))                       # the first ones have aged out
        server._EVENTS.clear()


if __name__ == "__main__":
    unittest.main()


class PullRequestTests(unittest.TestCase):
    def test_checks_and_summary(self):
        from office import prs
        self.assertIsNone(prs.checks([]))
        self.assertEqual(prs.checks([{"conclusion": "SUCCESS"}, {"state": "SUCCESS"}]), "pass")
        self.assertEqual(prs.checks([{"conclusion": "SUCCESS"}, {"status": "IN_PROGRESS", "conclusion": ""}]), "pending")
        self.assertEqual(prs.checks([{"conclusion": "FAILURE"}, {"status": "IN_PROGRESS"}]), "fail")
        p = prs.summarize({"number": 7, "title": "t", "state": "OPEN", "isDraft": True, "headRefName": "b", "reviewDecision": "APPROVED",
                           "statusCheckRollup": [{"conclusion": "SUCCESS"}], "author": {"login": "me"}})
        self.assertEqual((p["state"], p["review"], p["checks"], p["author"]), ("draft", "approved", "pass", "me"))

    def test_github_repo_from_git_config(self):
        import tempfile
        from pathlib import Path
        from office import prs
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / ".git").mkdir()
            (Path(tmp) / ".git" / "config").write_text('[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/rocket.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')
            self.assertEqual(prs.github_repo(tmp), "acme/rocket")
            (Path(tmp) / ".git" / "config").write_text('[remote "origin"]\n\turl = https://gitlab.com/acme/rocket.git\n')
            self.assertIsNone(prs.github_repo(tmp))


class AskTests(unittest.TestCase):
    def test_questions_find_their_session_and_answers_go_back(self):
        import os
        import tempfile
        from pathlib import Path
        from office import asks
        from office.server import answer_question, ask_question

        class FakeOffice:
            def __init__(self):
                self.asks = asks.Asks(Path(tempfile.mkdtemp()) / "asks.json")
                self.events, self.sent = [], []
                self.snap = {"seats": [{"id": "claude2", "label": "claude2", "kind": "claude", "sessions": [
                    {"id": "11111111-2222-3333-4444-555555555555", "pid": 4242, "name": "api-rate-limits", "cwd": "/w/api", "live": True}]}]}
            def get(self):
                return self.snap
            def emit(self, kind, text, seat=None, level="info", ts=None, extra=None):
                self.events.append((kind, text, seat, extra))
            def build(self):
                return self.snap
        office = FakeOffice()
        r = ask_question(office, {"text": "Ship behind a flag?", "pids": [99, 4242, 1], "cwd": "/elsewhere"})
        self.assertTrue(r["found_session"])
        item = office.asks.get(r["id"])
        self.assertEqual((item["seat"], item["session"], item["status"]), ("claude2", "11111111-2222-3333-4444-555555555555", "open"))
        self.assertEqual(office.events[-1][:3], ("ask", "api-rate-limits on claude2 asks: Ship behind a flag?", "claude2"))
        self.assertEqual(asks.session_for(office.snap, [], "/w/api")[0], "claude2")              # by folder, when it is the only one
        self.assertEqual(asks.session_for(office.snap, [], "/nowhere"), (None, None, None))
        import office.server as srv
        real = srv.talk.send
        srv.talk.send = lambda off, body, ids: office.sent.append(body) or {"ok": True, "delivery": "direct"}
        try:
            done = answer_question(office, {"id": r["id"], "text": "Yes, behind a flag."}, False, False)
        finally:
            srv.talk.send = real
        self.assertEqual(done["delivery"], "direct")
        self.assertIn("Yes, behind a flag.", office.sent[0]["text"])
        self.assertEqual(office.asks.get(r["id"])["status"], "answered")
        with self.assertRaises(ValueError):
            answer_question(office, {"id": r["id"], "text": "again"}, False, False)              # closed
        for bad in ({"text": ""}, {"text": "x" * 1001}, {"text": "x", "pids": "1"}, {"text": "x", "pids": [1.5]}):
            with self.assertRaises(ValueError):
                ask_question(office, bad)
        r2 = ask_question(office, {"text": "Nobody knows me"})
        self.assertFalse(r2["found_session"])
        answer_question(office, {"id": r2["id"]}, True, False)
        self.assertEqual(office.asks.get(r2["id"])["status"], "dismissed")
        self.assertEqual([a["status"] for a in asks.Asks(office.asks.path).view()][:2], ["dismissed", "answered"])   # kept on disk

    def test_parent_pids_walks_up(self):
        import os
        from office.asks import parent_pids
        self.assertEqual(parent_pids()[0], os.getppid())


class AnswerSafetyTests(unittest.TestCase):
    def test_a_failed_delivery_keeps_the_question_open_and_answers_go_once(self):
        import tempfile
        from pathlib import Path
        from office import asks
        import office.server as srv

        class Office:
            def __init__(self):
                self.asks = asks.Asks(Path(tempfile.mkdtemp()) / "a.json")
                self.snap = {"seats": [{"id": "c", "label": "c", "sessions": []}]}
            def get(self):
                return self.snap
            def emit(self, *a, **k):
                pass
            def build(self):
                return self.snap
        o = Office()
        q = o.asks.add("Ship it?", "c", "11111111-2222-3333-4444-555555555555", "lane", "/w")
        real = srv.talk.send
        try:
            def refuse(off, body, ids):
                raise ValueError("That running session cannot receive messages right now")
            srv.talk.send = refuse
            with self.assertRaises(ValueError):
                srv.answer_question(o, {"id": q["id"], "text": "Yes"}, False, False)
            self.assertEqual(o.asks.get(q["id"])["status"], "open")                  # still open: try again later
            srv.talk.send = lambda off, body, ids: {"delivery": "followup"}
            r = srv.answer_question(o, {"id": q["id"], "text": "Yes"}, False, False)
            self.assertIn("follow-up lane", r["note"])
        finally:
            srv.talk.send = real
        q2 = o.asks.add("Again?", "c", None, None, None)
        self.assertTrue(o.asks.claim(q2["id"]))
        self.assertIsNone(o.asks.claim(q2["id"]))                                   # a second answer cannot go out
        q3 = o.asks.add("Demo?", "c", None, None, None)
        self.assertEqual(srv.answer_question(o, {"id": q3["id"], "text": "x"}, False, True), {"ok": True, "demo": True})
        self.assertEqual(o.asks.get(q3["id"])["status"], "open")
        srv._ASKS.clear()
        self.assertTrue(all(srv._event_budget(now=100 + i, limit=10, bucket=srv._ASKS) for i in range(10)))
        self.assertFalse(srv._event_budget(now=111, limit=10, bucket=srv._ASKS))
        srv._ASKS.clear()

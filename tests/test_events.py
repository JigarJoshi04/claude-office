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

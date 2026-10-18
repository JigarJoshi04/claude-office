"""The review-comment watcher: a desk's PR's unresolved review threads become one Needs-you item."""
import json
import subprocess
import time
import unittest
from unittest.mock import patch

from office import prs


def graphql(threads):
    return json.dumps({"data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": threads}}}}})


def thread(resolved, *comments):
    return {"isResolved": resolved, "comments": {"nodes": [{"author": {"login": a}, "body": b, "path": "api/x.py", "line": 7} for a, b in comments]}}


class FetchReviewsTests(unittest.TestCase):
    def run_with(self, stdout, code=0):
        done = subprocess.CompletedProcess([], code, stdout=stdout, stderr="")
        with patch.object(prs.shutil, "which", return_value="/usr/bin/gh"), patch.object(prs.subprocess, "run", return_value=done) as run:
            return prs.fetch_reviews("acme/api", 12), run

    def test_only_unresolved_threads_with_the_first_comment_and_a_reply_count(self):
        got, run = self.run_with(graphql([thread(True, ("ann", "done")), thread(False, ("bo", "Refill  from\nelapsed time"), ("me", "ok"))]))
        self.assertEqual(got, [{"path": "api/x.py", "line": 7, "author": "bo", "body": "Refill from elapsed time", "replies": 1}])
        argv = run.call_args[0][0]
        self.assertIn("o=acme", argv); self.assertIn("n=api", argv); self.assertIn("p=12", argv)

    def test_a_secret_in_a_comment_is_masked_and_long_comments_cut(self):
        got, _ = self.run_with(graphql([thread(False, ("bo", "use ghp_" + "a" * 36 + " here " + "x" * 600))]))
        self.assertNotIn("a" * 36, got[0]["body"])
        self.assertLessEqual(len(got[0]["body"]), 400)

    def test_failures_read_as_nothing_known(self):
        self.assertIsNone(self.run_with("", code=1)[0])
        self.assertIsNone(self.run_with("not json")[0])
        self.assertEqual(self.run_with(json.dumps({"data": {"repository": None}}))[0], [])
        with patch.object(prs.shutil, "which", return_value=None):
            self.assertIsNone(prs.fetch_reviews("acme/api", 12))
        self.assertIsNone(prs.fetch_reviews("noslash", 12))


class ReviewsCacheTests(unittest.TestCase):
    def test_read_in_the_background_then_served_from_the_cache(self):
        p = prs.PullRequests()
        p.available = True
        calls = []
        with patch.object(prs, "fetch_reviews", side_effect=lambda r, n: calls.append((r, n)) or [{"body": "x"}]):
            self.assertEqual(p.reviews_for("acme/api", 3), [])          # nothing known yet: the read starts
            for _ in range(100):
                if not p._reviewing:
                    break
                time.sleep(0.01)
            self.assertEqual(p.reviews_for("acme/api", 3), [{"body": "x"}])
            self.assertEqual(calls, [("acme/api", 3)])                   # fresh: not read again

    def test_without_gh_nothing_is_read(self):
        p = prs.PullRequests()
        p.available = False
        with patch.object(prs, "fetch_reviews") as f:
            self.assertEqual(p.reviews_for("acme/api", 3), [])
        f.assert_not_called()


class ReviewAttentionTests(unittest.TestCase):
    def snap(self, *sessions):
        return {"now": 1000.0, "asks": [], "lanes": [], "units": [],
                "seats": [{"id": "c", "label": "claude", "kind": "claude", "status": "ok", "usage": {}, "sessions": list(sessions)}]}

    def test_one_item_per_pr_and_none_for_a_gone_session(self):
        from office.snapshot import Office, attention_key
        ci = {"number": 9, "checks": "pass", "threads": [{"body": "a"}, {"body": "b"}]}
        snap = self.snap({"id": "s1", "state": "working", "kind": "desk", "name": "api", "live": True, "ci": ci}, {"id": "s2", "state": "working", "kind": "desk", "name": "api 2", "live": True, "ci": ci},
                         {"id": "s3", "state": "working", "kind": "desk", "name": "old", "live": False, "ci": {**ci, "number": 10}})
        items = [a for a in Office._attention(snap) if a.get("review")]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["session"], "s1")
        self.assertEqual(items[0]["text"], "PR #9 has 2 unresolved review comments: api on claude")
        self.assertTrue(attention_key(items[0]).startswith("review:"))

    def test_no_threads_no_item(self):
        from office.snapshot import Office
        snap = self.snap({"id": "s1", "state": "working", "kind": "desk", "live": True, "ci": {"number": 9, "checks": "pass", "threads": []}})
        self.assertFalse([a for a in Office._attention(snap) if a.get("review")])


if __name__ == "__main__":
    unittest.main()

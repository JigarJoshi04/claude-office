import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from office import loose


class ParseTests(unittest.TestCase):
    def test_status_lines(self):
        s = loose.parse_status("## main...origin/main [ahead 2, behind 1]\n M a.py\n?? b.txt\n")
        self.assertEqual((s["files"], s["upstream"], s["ahead"], s["behind"], s["detached"]), (2, "origin/main", 2, 1, False))
        self.assertEqual(loose.parse_status("## fix-x...origin/fix-x [gone]\n")["upstream"], "gone")
        self.assertIsNone(loose.parse_status("## spike\n")["upstream"])
        self.assertTrue(loose.parse_status("## HEAD (no branch)\n")["detached"])

    def test_merged_by_name_ignores_generic_subjects(self):
        main = {"fix(api): retry the upload when the token expires", "wip", "address review"}
        self.assertTrue(loose.merged_by_name(["address review", "fix(api): retry the upload when the token expires"], main))
        self.assertFalse(loose.merged_by_name(["wip", "address review"], main))
        self.assertFalse(loose.merged_by_name(["fix(api): something else entirely"], main))


@unittest.skipUnless(shutil.which("git"), "git is not installed")
class SweepTests(unittest.TestCase):
    def test_a_repository_with_every_kind_of_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            t = Path(tmp)
            env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@x",
                   "GIT_CONFIG_GLOBAL": str(t / "gitconfig"), "GIT_CONFIG_NOSYSTEM": "1"}
            git = lambda *a, cwd=t: subprocess.run(["git", *a], cwd=cwd, env=env, check=True, capture_output=True)
            git("init", "-q", "--bare", "-b", "main", "remote.git")
            git("clone", "-q", "remote.git", "repo")
            repo = t / "repo"
            (repo / "a.txt").write_text("a\n"); git("add", ".", cwd=repo); git("commit", "-qm", "first", cwd=repo); git("push", "-q", "origin", "main", cwd=repo)
            git("worktree", "add", "-q", "-b", "clean", str(t / "wt-clean"), cwd=repo)                       # nothing new: safe
            git("worktree", "add", "-q", "-b", "dirty", str(t / "wt-dirty"), cwd=repo)
            (t / "wt-dirty" / "new.txt").write_text("x\n")                                                  # untracked: work
            git("worktree", "add", "-q", "-b", "spike", str(t / "wt-spike"), cwd=repo)
            (t / "wt-spike" / "b.txt").write_text("b\n"); git("add", ".", cwd=t / "wt-spike"); git("commit", "-qm", "spike: a graph layout experiment", cwd=t / "wt-spike")
            git("worktree", "add", "-q", "-b", "squashed", str(t / "wt-squashed"), cwd=repo)
            (t / "wt-squashed" / "c.txt").write_text("c\n"); git("add", ".", cwd=t / "wt-squashed"); git("commit", "-qm", "feat: retry uploads when the token expires", cwd=t / "wt-squashed")
            (repo / "c.txt").write_text("c\n"); git("add", ".", cwd=repo); git("commit", "-qm", "feat: retry uploads when the token expires (#12)", cwd=repo)
            git("push", "-q", "origin", "main", cwd=repo); git("fetch", "-q", cwd=repo)
            git("worktree", "add", "-q", "-b", "gone", str(t / "wt-gone"), cwd=repo)
            shutil.rmtree(t / "wt-gone")                                                                    # its folder is gone
            self.assertEqual(loose.repo_root(str(t / "wt-spike")), repo.resolve())
            res = loose.sweep([repo.resolve()], {str(t / "wt-dirty")})
            r = res["repos"][0]
            work = {w["name"]: w for w in r["work"]}
            self.assertEqual(set(work), {"wt-dirty", "wt-spike"})
            self.assertEqual((work["wt-dirty"]["files"], work["wt-dirty"]["live"]), (1, True))
            self.assertEqual(work["wt-spike"]["unpushed"], 1)
            self.assertEqual({w["name"]: w["merged"] for w in r["safe"]}, {"wt-clean": False, "wt-squashed": True})
            self.assertEqual(r["gone"], 1)
            self.assertTrue(all(c.startswith("git -C ") and " worktree remove " in c for c in r["remove_cmds"]))
            self.assertEqual(res["totals"]["work"], 2)


if __name__ == "__main__":
    unittest.main()

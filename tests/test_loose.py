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
        self.assertTrue(loose.merged_by_name(["fix(api): retry the upload when the token expires"], main))
        self.assertFalse(loose.merged_by_name(["address review", "fix(api): retry the upload when the token expires"], main))   # every commit
        self.assertFalse(loose.merged_by_name(["wip", "address review"], main))
        self.assertFalse(loose.merged_by_name([], main))
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
            # a detached HEAD with one commit on main by name and one nowhere else is work, never safe
            git("worktree", "add", "-q", "--detach", str(t / "wt-det"), "HEAD", cwd=repo)
            for subject in ("feat: retry uploads when the token expires", "brand new follow-up work only here"):
                (t / "wt-det" / (subject[:4] + ".txt")).write_text(subject); git("add", ".", cwd=t / "wt-det"); git("commit", "-qm", subject, cwd=t / "wt-det")
            (t / "wt-clean" / "build.log").write_text("x")                                          # an ignored file
            (t / "wt-clean" / ".gitignore").write_text("build.log\n"); git("add", ".gitignore", cwd=t / "wt-clean"); git("commit", "-qm", "ignore build logs", cwd=t / "wt-clean")
            git("push", "-q", "origin", "clean", cwd=t / "wt-clean")
            r = loose.sweep([repo.resolve()], set())["repos"][0]
            self.assertIn("wt-det", {w["name"] for w in r["work"]})
            clean = next(w for w in r["safe"] if w["name"] == "wt-clean")
            self.assertEqual(clean["ignored"], ["build.log"])
            # a count git could not make is never "safe"
            real = loose._git
            loose._git = lambda args, cwd, timeout=20: None if args[0] == "rev-list" else real(args, cwd, timeout)
            try:
                r = loose.sweep([repo.resolve()], set())["repos"][0]
            finally:
                loose._git = real
            self.assertEqual(r["safe"], [])
            self.assertTrue(all(w["unknown"] for w in r["work"] if not w["files"]))
            # a folder git cannot read is an error, not an all-clear
            bad = t / "empty"; (bad / ".git").mkdir(parents=True)
            res = loose.sweep([bad], set())
            self.assertTrue(res["repos"][0]["error"])
            self.assertEqual(res["totals"]["repos"], 0)
            # a submodule's .git file leads into its parent's .git/modules: not a checkout to sweep
            sub = t / "parent" / "lib"; sub.mkdir(parents=True)
            (sub / ".git").write_text("gitdir: ../.git/modules/lib\n")
            (t / "parent" / ".git" / "modules" / "lib").mkdir(parents=True)
            self.assertIsNone(loose.repo_root(str(sub)))


if __name__ == "__main__":
    unittest.main()

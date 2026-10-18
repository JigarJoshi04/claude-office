"""Pull requests: the shelf of PRs in the repositories the office's sessions use, and a CI lamp for each desk.

Read with the GitHub CLI (`gh pr list`), when it is installed and signed in, every few minutes in the background; the
office never comments, merges or changes anything. A PR belongs to a session when its branch is the branch that
session has checked out.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

from .sessions import redact

FIELDS = "number,title,state,isDraft,url,headRefName,updatedAt,mergedAt,reviewDecision,statusCheckRollup,author,isCrossRepository"
MERGED_FIELDS = "number,title,state,isDraft,url,headRefName,updatedAt,mergedAt,author,isCrossRepository"   # no checks: light
STALE_S = 180
_GH_REMOTE = re.compile(r"github\.com[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$")


def github_repo(root: str | Path) -> str | None:
    """owner/name of a checkout's origin on GitHub, read from .git/config (no git, no network)."""
    try:
        text = (Path(root) / ".git" / "config").read_text(errors="replace")
    except OSError:
        return None
    m = re.search(r'\[remote "origin"\][^\[]*?url\s*=\s*(\S+)', text)
    g = _GH_REMOTE.search(m.group(1)) if m else None
    return f"{g.group(1)}/{g.group(2)}" if g else None


def checks(rollup) -> str | None:
    """One word for a PR's checks: fail, pending or pass (None when it has none)."""
    if not rollup:
        return None
    states = []
    for c in rollup:
        if not isinstance(c, dict):
            continue
        s = (c.get("conclusion") or c.get("state") or c.get("status") or "").upper()
        states.append(s)
    if any(s in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE") for s in states):
        return "fail"
    if any(s in ("PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED", "") for s in states):
        return "pending"
    return "pass"


def summarize(pr: dict) -> dict:
    state = "draft" if pr.get("isDraft") and pr.get("state") == "OPEN" else (pr.get("state") or "").lower()
    return {"number": pr.get("number"), "title": pr.get("title") or "", "state": state, "url": pr.get("url"),
            "branch": pr.get("headRefName"), "updated": pr.get("updatedAt"), "merged": pr.get("mergedAt"),
            "review": (pr.get("reviewDecision") or "").lower() or None, "checks": checks(pr.get("statusCheckRollup")),
            "author": ((pr.get("author") or {}).get("login")), "fork": bool(pr.get("isCrossRepository"))}


def _list(gh: str, repo: str, state: str, limit: int, search: str | None = None, fields: str = FIELDS) -> list[dict] | None:
    try:
        r = subprocess.run([gh, "pr", "list", "-R", repo, "--state", state, "--limit", str(limit), "--json", fields]
                           + (["--search", search] if search else []),
                           capture_output=True, text=True, timeout=30, env={**os.environ, "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1"})
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    try:
        return [summarize(p) for p in json.loads(r.stdout or "[]")]
    except (ValueError, TypeError):
        return None


def fetch(repo: str, limit: int = 40) -> list[dict] | None:
    """Every open PR (old ones too: a busy repository's last 40 can all be closed), the most recent of the rest, and
    every PR merged in the last week (a busy repository merges far more than 40)."""
    gh = shutil.which("gh")
    if not gh:
        return None
    since = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 8 * 86400))
    opened, recent = _list(gh, repo, "open", 200), _list(gh, repo, "all", limit)
    if opened is None and recent is None:
        return None
    week = _list(gh, repo, "merged", 500, f"merged:>={since}", MERGED_FIELDS) or []
    seen, out = set(), []
    for p in (opened or []) + (recent or []) + week:
        if p["number"] not in seen:
            seen.add(p["number"]); out.append(p)
    return out


REVIEW_STALE_S = 300
_REVIEW_Q = ("query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:50)"
             "{nodes{isResolved comments(first:3){nodes{author{login} body path line}}}}}}}")


def fetch_reviews(repo: str, number: int) -> list[dict] | None:
    """The unresolved review threads on a PR: [{path, line, author, body, replies}] (first comment of each), or None."""
    gh = shutil.which("gh")
    if not gh or "/" not in repo:
        return None
    owner, name = repo.split("/", 1)
    try:
        r = subprocess.run([gh, "api", "graphql", "-f", f"query={_REVIEW_Q}", "-f", f"o={owner}", "-f", f"n={name}", "-F", f"p={int(number)}"],
                           capture_output=True, text=True, timeout=30, env={**os.environ, "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1"})
        if r.returncode != 0:
            return None
        nodes = (((json.loads(r.stdout or "{}").get("data") or {}).get("repository") or {}).get("pullRequest") or {}).get("reviewThreads", {}).get("nodes") or []
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, AttributeError):
        return None
    out = []
    for t in nodes:
        cs = ((t or {}).get("comments") or {}).get("nodes") or []
        if t.get("isResolved") or not cs:
            continue
        c = cs[0]
        out.append({"path": c.get("path"), "line": c.get("line"), "author": ((c.get("author") or {}).get("login")),
                    "body": redact(" ".join(str(c.get("body") or "").split()))[:400], "replies": len(cs) - 1})
    return out


class PullRequests:
    """The last fetch per repository, refreshed in the background when asked for and stale."""

    def __init__(self):
        self.lock = threading.Lock()
        self.data: dict = {}             # owner/name -> {"at", "prs": [...], "error"}
        self.running = False
        self.available = shutil.which("gh") is not None
        self.reviews: dict = {}          # (owner/name, number) -> {"at", "threads"}: unresolved review threads
        self._want: set = set()
        self._reviewing = False

    def view(self, roots: list) -> dict:
        repos = sorted({r for r in (github_repo(x) for x in roots) if r})
        with self.lock:
            stale = [r for r in repos if not self.data.get(r) or time.time() - self.data[r]["at"] > STALE_S]
            if stale and not self.running and self.available:
                self.running = True
                threading.Thread(target=self._run, args=(stale,), daemon=True, name="pull-requests").start()
            return {"available": self.available, "scanning": self.running,
                    "repos": [{"repo": r, **self.data[r]} for r in repos if r in self.data]}

    def _run(self, repos):
        try:
            for r in repos:
                prs = fetch(r)
                with self.lock:
                    self.data[r] = {"at": time.time(), "prs": prs or [], "error": prs is None}
        finally:
            with self.lock:
                self.running = False

    def reviews_for(self, repo: str, number: int) -> list[dict]:
        """A desk's PR's unresolved review threads as last read (refreshed in the background every few minutes)."""
        key = (repo, number)
        with self.lock:
            got = self.reviews.get(key)
            if self.available and (not got or time.time() - got["at"] > REVIEW_STALE_S):
                self._want.add(key)
                if not self._reviewing:
                    self._reviewing = True
                    threading.Thread(target=self._read_reviews, daemon=True, name="pr-reviews").start()
            return list(got["threads"]) if got else []

    def _read_reviews(self):
        try:
            while True:
                with self.lock:
                    if not self._want:
                        return
                    key = self._want.pop()
                threads = fetch_reviews(*key)
                with self.lock:                          # a failed read keeps what was known (and tries again later)
                    old = self.reviews.get(key)
                    self.reviews[key] = {"at": time.time(), "threads": threads if threads is not None else (old["threads"] if old else [])}
                    if len(self.reviews) > 40:
                        self.reviews.pop(next(iter(self.reviews)))
        finally:
            with self.lock:
                self._reviewing = False

    def by_branch(self) -> dict:
        """(owner/name, branch) -> the newest open PR on it, for the desks' CI lamps. A fork's PR, or one whose head is
        the default branch, says nothing about the desks on that branch here."""
        out = {}
        with self.lock:
            for repo, d in self.data.items():
                for p in d.get("prs") or []:
                    if p["state"] in ("open", "draft") and p.get("branch") and not p.get("fork") and p["branch"] not in ("main", "master"):
                        out.setdefault((repo, p["branch"]), p)
        return out

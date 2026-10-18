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

FIELDS = "number,title,state,isDraft,url,headRefName,updatedAt,mergedAt,reviewDecision,statusCheckRollup,author,isCrossRepository"
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


def _list(gh: str, repo: str, state: str, limit: int) -> list[dict] | None:
    try:
        r = subprocess.run([gh, "pr", "list", "-R", repo, "--state", state, "--limit", str(limit), "--json", FIELDS],
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
    """Every open PR (old ones too: a busy repository's last 40 can all be closed) and the most recent of the rest."""
    gh = shutil.which("gh")
    if not gh:
        return None
    opened, recent = _list(gh, repo, "open", 200), _list(gh, repo, "all", limit)
    if opened is None and recent is None:
        return None
    seen, out = set(), []
    for p in (opened or []) + (recent or []):
        if p["number"] not in seen:
            seen.add(p["number"]); out.append(p)
    return out


class PullRequests:
    """The last fetch per repository, refreshed in the background when asked for and stale."""

    def __init__(self):
        self.lock = threading.Lock()
        self.data: dict = {}             # owner/name -> {"at", "prs": [...], "error"}
        self.running = False
        self.available = shutil.which("gh") is not None

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

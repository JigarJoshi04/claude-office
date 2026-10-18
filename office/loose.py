"""Loose ends: work the agents left behind in git, and worktrees that are safe to remove.

The office looks at every worktree of the repositories its sessions and lanes used and says which hold work that is
nowhere else (uncommitted or untracked files, commits on no remote) and which are clean copies of pushed commits.
It only reads: `git worktree list` and `git status` run at low priority, with the fsmonitor and optional locks turned
off, and nothing is ever changed. Removing a worktree is a command you copy and run yourself.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

GIT = ["nice", "-n", "15", "git", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"]
ENV = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"}
STALE_S = 15 * 60            # a sweep is good for a quarter of an hour
MAX_WORKTREES = 2000          # per repository: far beyond a busy year of lanes


def repo_root(cwd: str | None) -> Path | None:
    """The main checkout of the repository a folder is in (a worktree's .git file leads back to it), or None."""
    if not cwd:
        return None
    try:
        p = Path(cwd)
        for d in (p, *p.parents):
            g = d / ".git"
            if g.is_dir():
                return d
            if g.is_file():
                text = g.read_text(errors="replace").strip()
                if not text.startswith("gitdir:"):
                    return None
                gitdir = Path(text[7:].strip())
                gitdir = gitdir if gitdir.is_absolute() else (d / gitdir).resolve()
                common = gitdir / "commondir"
                main = (gitdir / common.read_text().strip()).resolve() if common.exists() else gitdir
                return main.parent
    except OSError:
        return None
    return None


def _git(args: list[str], cwd: str | Path, timeout: float = 20) -> str | None:
    try:
        r = subprocess.run([*GIT, "-C", str(cwd), *args], capture_output=True, text=True, timeout=timeout, env=ENV)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


def worktrees(root: Path) -> list[dict]:
    """`git worktree list --porcelain`, as dicts: path, head, branch (or None when detached), locked, prunable, main."""
    out = _git(["worktree", "list", "--porcelain"], root)
    if out is None:
        return []
    items, cur = [], None
    for line in out.splitlines() + [""]:
        if line.startswith("worktree "):
            cur = {"path": line[9:], "head": None, "branch": None, "locked": False, "prunable": False}
        elif cur is None:
            continue
        elif line.startswith("HEAD "):
            cur["head"] = line[5:]
        elif line.startswith("branch "):
            cur["branch"] = line[7:].removeprefix("refs/heads/")
        elif line.startswith("locked"):
            cur["locked"] = True
        elif line.startswith("prunable"):
            cur["prunable"] = True
        elif line == "":
            items.append(cur)
            cur = None
    for i, w in enumerate(items):
        w["main"] = i == 0
    return items[:MAX_WORKTREES]


def parse_status(text: str) -> dict:
    """`git status --porcelain=v1 -b`: files changed or untracked, the upstream (None, or "gone"), ahead and behind."""
    lines = text.splitlines()
    head = lines[0][3:] if lines and lines[0].startswith("## ") else ""
    upstream, ahead, behind = None, 0, 0
    if "..." in head:
        rest = head.split("...", 1)[1]
        upstream = rest.split(" [", 1)[0]
        if "[gone]" in rest:
            upstream = "gone"
        for part in rest.split(" [", 1)[1].rstrip("]").split(", ") if " [" in rest else []:
            if part.startswith("ahead "):
                ahead = int(part[6:])
            elif part.startswith("behind "):
                behind = int(part[7:])
    return {"files": sum(1 for x in lines[1:] if x.strip()), "upstream": upstream, "ahead": ahead, "behind": behind,
            "detached": head.startswith("HEAD (no branch)")}


def default_branch(root: Path) -> str | None:
    """The remote's default branch ("origin/main"), to tell squash-merged work from work that is nowhere else."""
    ref = _git(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], root)
    if ref and ref.strip().startswith("refs/remotes/"):
        return ref.strip()[13:]
    for b in ("origin/main", "origin/master"):
        if _git(["rev-parse", "-q", "--verify", b], root) is not None:
            return b
    return None


GENERIC = re.compile(r"^(wip\b|fixup!|squash!|merge\b|revert\b|address (copilot )?review|review fixes?$|fix (lint|tests?|ci)$)", re.I)


def main_subjects(root: Path, base: str | None) -> set:
    """Every commit subject on the default branch, without a squash merge's " (#123)": a branch whose own commits
    show up here by name was merged."""
    if not base:
        return set()
    out = _git(["log", base, "--format=%s"], root, timeout=60) or ""
    return {re.sub(r"\s*\(#\d+\)$", "", x).strip() for x in out.splitlines() if x.strip()}


def merged_by_name(subjects: list[str], main: set) -> bool:
    """True when one of a branch's own commits is on the default branch by name. Generic or short subjects ("wip",
    "address review") never count."""
    return any(len(x) >= 20 and not GENERIC.match(x) and x in main for x in (y.strip() for y in subjects))


def inspect(w: dict, main: set | None = None) -> dict:
    """One worktree: its status, how many of its commits are on no remote at all, and whether those were merged."""
    path = w["path"]
    if w["prunable"] or not os.path.isdir(path):
        return dict(w, gone=True)
    st = _git(["status", "--porcelain=v1", "-b", "--untracked-files=normal"], path)
    if st is None:
        return dict(w, error=True)
    info = parse_status(st)
    n = _git(["rev-list", "--count", "HEAD", "--not", "--remotes"], path)
    try:
        info["unpushed"] = int((n or "0").strip() or 0)
    except ValueError:
        info["unpushed"] = 0
    subjects = (_git(["log", "--format=%s", "-200", "HEAD", "--not", "--remotes"], path) or "").splitlines() if info["unpushed"] else []
    info["merged"] = bool(subjects and main and merged_by_name(subjects, main))
    try:
        info["touched"] = os.stat(path).st_mtime
    except OSError:
        info["touched"] = None
    return dict(w, **info)


def sweep(roots: list[Path], live_cwds: set[str], workers: int = 4) -> dict:
    """Every worktree of every root: which hold work, which are safe to remove, which folders are gone."""
    live = {os.path.realpath(c) for c in live_cwds if c}
    repos = []
    for root in roots:
        trees, base = worktrees(root), default_branch(root)
        main = main_subjects(root, base)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            seen = list(pool.map(lambda w: inspect(w, main), trees))
        work, safe, deleted, gone = [], [], [], []
        for w in seen:
            real = os.path.realpath(w["path"])
            w["live"] = any(c == real or c.startswith(real + os.sep) for c in live)
            if w.get("gone"):
                gone.append(w)
            elif w.get("error"):
                continue
            elif w.get("files") or (w.get("unpushed") and not w.get("merged") and w.get("upstream") != "gone"):
                work.append(w)
            elif w.get("unpushed") and not w.get("merged"):   # its remote branch was deleted, usually after a merge
                if not w["main"] and not w["locked"] and not w["live"]:
                    deleted.append(w)
            elif not w["main"] and not w["locked"] and not w["live"]:
                safe.append(w)
        q = shlex.quote
        repos.append({
            "root": str(root), "name": root.name, "worktrees": len(trees), "base": base,
            "work": [_row(w) for w in sorted(work, key=lambda w: -(w.get("touched") or 0))],
            "safe": [_row(w) for w in sorted(safe, key=lambda w: (w.get("touched") or 0))],
            "deleted": [_row(w) for w in sorted(deleted, key=lambda w: (w.get("touched") or 0))],
            "deleted_cmds": [f"git -C {shlex.quote(str(root))} worktree remove {shlex.quote(w['path'])}" for w in deleted],
            "gone": len(gone),
            "remove_cmds": [f"git -C {q(str(root))} worktree remove {q(w['path'])}" for w in safe],
            "prune_cmd": f"git -C {q(str(root))} worktree prune" if gone else None,
        })
    repos.sort(key=lambda r: (-len(r["work"]), -len(r["safe"])))
    return {"at": time.time(), "repos": repos,
            "totals": {"repos": len(repos), "worktrees": sum(r["worktrees"] for r in repos),
                       "work": sum(len(r["work"]) for r in repos), "safe": sum(len(r["safe"]) for r in repos),
                       "deleted": sum(len(r["deleted"]) for r in repos),
                       "gone": sum(r["gone"] for r in repos)}}


def _row(w: dict) -> dict:
    return {"path": w["path"], "name": os.path.basename(w["path"].rstrip("/")), "branch": w.get("branch"),
            "head": (w.get("head") or "")[:7], "files": w.get("files", 0), "unpushed": w.get("unpushed", 0),
            "upstream": w.get("upstream"), "ahead": w.get("ahead", 0), "merged": w.get("merged", False),
            "main": w["main"], "live": w.get("live", False),
            "locked": w["locked"], "touched": w.get("touched")}


class LooseEnds:
    """The last sweep, and a background thread that refreshes it when it is asked for and stale. The repositories
    it sweeps are remembered (in `path`) from every session and lane that ever ran in one, plus config "repos"."""

    def __init__(self, path: Path | None = None):
        self.lock = threading.Lock()
        self.result: dict | None = None
        self.running = False
        self.path = path
        self.roots: set[str] = set()
        try:
            self.roots = set(json.loads(path.read_text())) if path else set()
        except (OSError, ValueError, TypeError):
            pass
        tmp = os.path.realpath(tempfile.gettempdir())
        self.roots = {r for r in self.roots if not r.startswith(tmp)}

    def note(self, cwds) -> None:
        """Remember the repository of every folder a session or lane works in (never a scratch folder's)."""
        tmp = os.path.realpath(tempfile.gettempdir())
        roots = {str(r) for r in (repo_root(c) for c in set(cwds) if c and not os.path.realpath(c).startswith(tmp)) if r}
        new = {r for r in roots if r != os.sep and not r.startswith(tmp)} - self.roots
        if new:
            self.roots |= new
            if self.path:
                try:
                    self.path.write_text(json.dumps(sorted(self.roots)))
                except OSError:
                    pass

    def known(self, extra=()) -> list[Path]:
        return sorted({Path(r) for r in (*self.roots, *extra) if r and os.path.isdir(r)})

    def view(self, roots: list[Path], live_cwds: set[str], force: bool = False) -> dict:
        with self.lock:
            stale = not self.result or time.time() - self.result["at"] > STALE_S or force
            if stale and not self.running and roots:
                self.running = True
                threading.Thread(target=self._run, args=(list(roots), set(live_cwds)), daemon=True, name="loose-ends").start()
            return dict(self.result or {"at": None, "repos": [], "totals": None}, scanning=self.running)

    def _run(self, roots, live):
        try:
            res = sweep(roots, live)
        except Exception:                                  # a nicety: never let it take the office down
            res = None
        with self.lock:
            if res:
                self.result = res
            self.running = False

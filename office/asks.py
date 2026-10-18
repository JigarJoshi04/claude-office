"""Questions agents ask the CEO, and the answers.

An agent that needs a decision runs `python3 -m office ask "Ship it behind a flag or wait for review?"` and keeps
working on what it can. The office finds the session by its process (the command runs inside it), rings the CEO's desk
and keeps the question in the Inbox; the answer goes back to the session as a message. Kept in
`state/asks.json`, the last 300.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path

MAX_KEEP = 300
MAX_TEXT = 1000


class Asks:
    def __init__(self, path: Path | None = None):
        self.path = path
        self.lock = threading.Lock()
        self.items: list[dict] = []
        try:
            data = json.loads(path.read_text()) if path else []
            self.items = [x for x in data if isinstance(x, dict) and x.get("id") and x.get("text")][-MAX_KEEP:]
        except (OSError, ValueError, TypeError):
            pass

    def _save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                json.dump(self.items, fh, separators=(",", ":"))
            os.replace(tmp, self.path)
        except OSError:
            pass

    def add(self, text: str, seat: str | None, session: str | None, name: str | None, cwd: str | None) -> dict:
        item = {"id": uuid.uuid4().hex[:12], "ts": time.time(), "text": text[:MAX_TEXT], "seat": seat, "session": session,
                "name": name, "where": os.path.basename((cwd or "").rstrip("/")) or None, "status": "open",
                "answer": None, "answered_at": None, "delivery": None}
        with self.lock:
            self.items = (self.items + [item])[-MAX_KEEP:]
            self._save()
        return dict(item)

    def answer(self, ask_id: str, text: str, delivery: str | None) -> dict | None:
        with self.lock:
            for x in self.items:
                if x["id"] == ask_id:
                    x.update(status="answered", answer=text[:MAX_TEXT], answered_at=time.time(), delivery=delivery)
                    self._save()
                    return dict(x)
        return None

    def dismiss(self, ask_id: str) -> dict | None:
        with self.lock:
            for x in self.items:
                if x["id"] == ask_id and x["status"] == "open":
                    x.update(status="dismissed", answered_at=time.time())
                    self._save()
                    return dict(x)
        return None

    def get(self, ask_id: str) -> dict | None:
        with self.lock:
            return next((dict(x) for x in self.items if x["id"] == ask_id), None)

    def view(self, limit: int = 60) -> list[dict]:
        """Open questions first (oldest first: they have waited longest), then the latest answered ones."""
        with self.lock:
            items = [dict(x) for x in self.items]
        open_ = [x for x in items if x["status"] == "open"]
        done = sorted((x for x in items if x["status"] != "open"), key=lambda x: -(x.get("answered_at") or x["ts"]))
        return (open_ + done)[:limit]


def session_for(snap: dict, pids: list[int], cwd: str | None) -> tuple[str | None, str | None, str | None]:
    """(seat, session id, session name) of the live session whose process is one of `pids` (the asking command's
    parents), else the only live session working in `cwd`, else nothing."""
    pids = {p for p in pids if isinstance(p, int) and p > 1}
    live = [(s, x) for s in snap.get("seats", []) for x in s.get("sessions", []) if x.get("live", True)]
    for s, x in live:
        if x.get("pid") in pids:
            return s["id"], x["id"], x.get("name")
    here = [(s, x) for s, x in live if cwd and x.get("cwd") and os.path.realpath(x["cwd"]) == os.path.realpath(cwd)]
    if len(here) == 1:
        return here[0][0]["id"], here[0][1]["id"], here[0][1].get("name")
    return None, None, None


def parent_pids(start: int | None = None, depth: int = 12) -> list[int]:
    """This process's parents, nearest first: the session that ran `office ask` is one of them."""
    out, pid = [], start or os.getpid()
    for _ in range(depth):
        try:
            with open(f"/proc/{pid}/stat") as fh:
                stat = fh.read()
            ppid = int(stat[stat.rindex(")") + 2:].split()[1])
        except (OSError, ValueError, IndexError):
            break
        if ppid <= 1:
            break
        out.append(ppid)
        pid = ppid
    return out

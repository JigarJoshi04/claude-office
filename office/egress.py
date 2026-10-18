"""What the office itself sends off this machine, and why. Every outbound call it makes is counted here: plan usage
readings (Anthropic), pull requests, checks and review comments (GitHub, through the gh CLI), and the office analyst
when it is on (Claude, through `claude -p`). Settings shows the last day's calls. The page itself fetches nothing
from elsewhere (its fonts are served by the office). Agents' own traffic is theirs, not the office's.
"""
from __future__ import annotations

import threading
import time
from collections import deque

_LOCK = threading.Lock()
_LOG: deque = deque(maxlen=5000)          # (ts, host, purpose, ok)
WHY = {
    "usage": ("api.anthropic.com", "Plan usage readings for each Claude seat (its own login)"),
    "github": ("api.github.com", "Pull requests, checks and review comments (gh)"),
    "analyst": ("api.anthropic.com", "The office analyst's questions (claude -p, only when on)"),
}


def note(kind: str, ok: bool = True) -> None:
    host, _ = WHY.get(kind, (kind, kind))
    with _LOCK:
        _LOG.append((time.time(), kind, ok))


def view(now: float | None = None) -> list[dict]:
    """The last day's outbound calls by kind: [{kind, host, why, calls, failed, last_at}]."""
    now = now or time.time()
    out: dict[str, dict] = {}
    with _LOCK:
        rows = [r for r in _LOG if now - r[0] < 86400]
    for ts, kind, ok in rows:
        host, why = WHY.get(kind, (kind, kind))
        e = out.setdefault(kind, {"kind": kind, "host": host, "why": why, "calls": 0, "failed": 0, "last_at": 0})
        e["calls"] += 1
        e["failed"] += 0 if ok else 1
        e["last_at"] = max(e["last_at"], ts)
    return sorted(out.values(), key=lambda e: -e["calls"])

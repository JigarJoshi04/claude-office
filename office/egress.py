"""What the office itself sends off this machine, and why. Every outbound call it makes is counted here: plan usage
readings (Anthropic), pull requests, checks and review comments (GitHub, through the gh CLI), and the office analyst
when it is on (Claude, through `claude -p`). Settings shows the last day's calls. The page itself fetches nothing
from elsewhere (its fonts are served by the office). Agents' own traffic is theirs, not the office's.
"""
from __future__ import annotations

import atexit
import json
import os
import threading
import time
from pathlib import Path

_LOCK = threading.Lock()
# Calls per hour and kind: {"<hour>|<kind>": [calls, failed, last_at]}, the last 25 hours. Kept in state/egress.json
# (at most once a minute), so a restart does not empty Settings' list; counts, so no cap undercounts a busy day.
_HOURS: dict[str, list] = {}
_PATH: Path | None = None
_SAVED = 0.0
WHY = {
    "usage": ("api.anthropic.com", "Plan usage readings for each Claude seat (its own login)"),
    "github": ("api.github.com", "Pull requests, checks and review comments (gh)"),
    "analyst": ("api.anthropic.com", "The office analyst's questions (claude -p, only when on)"),
}


def init(path: Path | None) -> None:
    """Where the counts are kept; read what an earlier run counted."""
    global _PATH
    _PATH = path
    try:
        d = json.loads(path.read_text()) if path else {}
    except (OSError, ValueError):
        d = {}
    with _LOCK:
        _HOURS.clear()
        _HOURS.update({k: v for k, v in (d if isinstance(d, dict) else {}).items()
                       if isinstance(k, str) and "|" in k and k.split("|", 1)[0].isdigit() and isinstance(v, list) and len(v) == 3
                       and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v)})   # a damaged file is read as far as it is sound


def _save(now: float, force: bool = False) -> None:
    global _SAVED
    if not _PATH or (now - _SAVED < 60 and not force):
        return
    _SAVED = now
    try:
        _PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = _PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(_HOURS, separators=(",", ":")))
        os.replace(tmp, _PATH)
    except OSError:
        pass


def flush() -> None:
    """Keep the last minute's counts too (at exit)."""
    with _LOCK:
        _save(time.time(), force=True)


atexit.register(flush)


def note(kind: str, ok: bool = True, now: float | None = None) -> None:
    now = now or time.time()
    key = f"{int(now // 3600)}|{kind}"
    with _LOCK:
        e = _HOURS.setdefault(key, [0, 0, 0])
        e[0] += 1
        e[1] += 0 if ok else 1
        e[2] = max(e[2], now)
        old = int(now // 3600) - 25
        for k in [k for k in _HOURS if int(k.split("|", 1)[0]) < old]:
            del _HOURS[k]
        _save(now)


def view(now: float | None = None) -> list[dict]:
    """The last day's outbound calls by kind (to the hour): [{kind, host, why, calls, failed, last_at}]."""
    now = now or time.time()
    out: dict[str, dict] = {}
    start = int(now // 3600) - 23
    with _LOCK:
        rows = [(k.split("|", 1)[1], v) for k, v in _HOURS.items() if int(k.split("|", 1)[0]) >= start]
    for kind, (calls, failed, last) in rows:
        host, why = WHY.get(kind, (kind, kind))
        e = out.setdefault(kind, {"kind": kind, "host": host, "why": why, "calls": 0, "failed": 0, "last_at": 0})
        e["calls"] += calls
        e["failed"] += failed
        e["last_at"] = max(e["last_at"], last)
    return sorted(out.values(), key=lambda e: -e["calls"])

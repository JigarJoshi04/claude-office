"""Office problems: when a part of the office keeps failing (a refresh, a seat's folder, the token ledger, the plan
readings), it is said once, then at most every ten minutes with how many times it has happened, and once more when it
has worked for a minute. Without this, a failure every four seconds would flood the news and push real events out.

A problem is keyed by its part, the kind of error and the start of its message, so two different failures of one
part are told apart, while the same failure with a changing number in it is not. A part that fails, works, then fails
again within the minute is one problem that carries on (no "failed" and "works again" every other refresh).
"""
from __future__ import annotations

import re
import threading
import time

QUIET_S = 600            # a problem that keeps happening is said again at most this often
STEADY_S = 60            # it has to work this long before it counts as over


def _what(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"[:160]


class Faults:
    def __init__(self, emit):
        self.emit = emit                                 # emit(kind, text, seat, level)
        self._lock = threading.Lock()
        self._open: dict[tuple, dict] = {}

    def fault(self, part: str, exc: BaseException, seat: str | None = None) -> None:
        now = time.time()
        what = _what(exc)
        key = (part, type(exc).__name__, re.sub(r"\d+", "#", str(exc))[:60])
        say = None
        with self._lock:
            f = self._open.get(key)
            if f is None:
                f = self._open[key] = {"part": part, "what": what, "seat": seat, "since": now, "last": now, "count": 0, "said_at": now, "said_count": 1}
                say = f"{part} failed: {what}"
            elif now - f["said_at"] >= QUIET_S and f["count"] + 1 > f["said_count"]:
                say = f"{part} is still failing ({f['count'] + 1} times since {time.strftime('%H:%M', time.localtime(f['since']))}): {what}"
                f["said_at"], f["said_count"] = now, f["count"] + 1
            f["count"] += 1
            f["last"], f["what"] = now, what
            for g in self._open.values():               # failing again: any "it works now" of this part starts over
                if g["part"] == part:
                    g.pop("ok_since", None)
        if say:
            self.emit("error", say, seat, "bad")

    def ok(self, part: str) -> None:
        """The part worked. Once it has worked for a minute its problems are over, and the news says so once."""
        now = time.time()
        with self._lock:
            mine = [k for k, f in self._open.items() if f["part"] == part]
            if not mine:
                return
            for k in mine:
                self._open[k].setdefault("ok_since", now)
            if now - min(self._open[k]["ok_since"] for k in mine) < STEADY_S:
                return
            gone = [self._open.pop(k) for k in mine]
        first = min(f["since"] for f in gone)
        mins = max(1, round((now - first) / 60))
        self.emit("error", f"{part} works again, after {mins} minute{'s' if mins != 1 else ''}", gone[0]["seat"], "good")

    def forget(self, keep) -> None:
        """Quietly drop the problems of parts that are no longer there (a beacon taken out of the config, a seat
        that has left): keep(part) says which parts still exist."""
        with self._lock:
            for k in [k for k, f in self._open.items() if not keep(f["part"])]:
                self._open.pop(k)

    def view(self) -> list[dict]:
        """The problems still open, the most recent first, for the briefing and the doctor."""
        with self._lock:
            out = [dict(f) for f in self._open.values()]
        for f in out:
            for k in ("said_at", "said_count", "ok_since"):
                f.pop(k, None)
        return sorted(out, key=lambda f: -f["last"])

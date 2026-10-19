"""Office problems: when a part of the office keeps failing (a refresh, a seat's folder, the token ledger, the plan
readings), it is said once, then at most every ten minutes with how many times it has happened, and once more when
it works again. Without this, a failure every four seconds would flood the news and push real events out.

A problem is keyed by its part, the kind of error and the start of its message, so two different failures of one
part are told apart, while the same failure with a changing number in it is not.
"""
from __future__ import annotations

import re
import threading
import time

QUIET_S = 600            # a problem that keeps happening is said again at most this often


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
        with self._lock:
            f = self._open.get(key)
            if f is None:
                f = self._open[key] = {"part": part, "what": what, "seat": seat, "since": now, "last": now, "count": 0, "said_at": now, "said_count": 1}
                say = f"{part} failed: {what}"
            else:
                say = None
                if now - f["said_at"] >= QUIET_S and f["count"] + 1 > f["said_count"]:
                    say = f"{part} is still failing ({f['count'] + 1} times since {time.strftime('%H:%M', time.localtime(f['since']))}): {what}"
                    f["said_at"], f["said_count"] = now, f["count"] + 1
            f["count"] += 1
            f["last"], f["what"] = now, what
        if say:
            self.emit("error", say, seat, "bad")

    def ok(self, part: str) -> None:
        """The part worked: its open problems are over, and the news says so once."""
        if not any(k[0] == part for k in self._open):      # the common case, without the lock
            return
        now = time.time()
        with self._lock:
            gone = [self._open.pop(k) for k in [k for k in self._open if k[0] == part]]
        if gone:
            first = min(f["since"] for f in gone)
            mins = max(1, round((now - first) / 60))
            self.emit("error", f"{part} works again, after {mins} minute{'s' if mins != 1 else ''}", gone[0]["seat"], "good")

    def view(self) -> list[dict]:
        """The problems still open, the most recent first, for the briefing and the doctor."""
        with self._lock:
            out = [dict(f) for f in self._open.values()]
        for f in out:
            f.pop("said_at", None); f.pop("said_count", None)
        return sorted(out, key=lambda f: -f["last"])

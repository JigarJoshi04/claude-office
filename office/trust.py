"""A report's claim against what its own transcript shows. When a session or lane says DONE (or READY, COMPLETE…), the
office looks at its last test run: passed after its last code change is Verified, failed is Contradicted, anything else
(no test run seen, or code changed after the last pass) is Unverified. No AI: the transcript's own tool results. The
verdict is kept (state/trust.json) so a lane's page still shows it after its session has gone.
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

from . import config
from .sessions import report_blocked

# The report's own status word claims it ("STATUS: DONE - …", "READY #12"), not a word further on ("FAILED - could not
# complete", "NOT DONE", "PARTIAL").
_CLAIM = re.compile(r"^[\W\d_]*(?:STATUS\W*)?(?:DONE|READY|COMPLETE[D]?|SUCCESS|FINISHED|SHIPPED|MERGED)\b", re.I)
WORDS = {"verified": "Verified", "unverified": "Unverified", "contradicted": "Contradicted"}


def trust_of(report_status: str | None, test_ok, test_at, edit_at) -> dict | None:
    """{"level", "why"} for a report that claims the work is done, or None (no report, a BLOCKED one, no claim)."""
    if not report_status or report_blocked(report_status) or not _CLAIM.match(report_status):
        return None
    if test_ok is False:
        return {"level": "contradicted", "why": "its last test run failed"}
    if test_ok is True and (not edit_at or (test_at or 0) >= edit_at):
        return {"level": "verified", "why": "its tests passed after its last change"}
    if test_ok is True:
        return {"level": "unverified", "why": "it changed code after its last passing test run"}
    return {"level": "unverified", "why": "no test run in its transcript"}


class Store:
    """Verdicts by session id: {"level", "why", "at", "name", "seat", "lane"}; the newest 500."""

    def __init__(self, path: Path | None):
        self.path, self.lock = path, threading.Lock()
        d = config.read_state(path) if path else None
        self.data: dict = d if isinstance(d, dict) else {}

    def put(self, sid: str, verdict: dict) -> None:
        with self.lock:
            self.data[sid] = verdict
            while len(self.data) > 500:
                self.data.pop(next(iter(self.data)))
            if not self.path:
                return
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(".tmp")
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as fh:
                    json.dump(self.data, fh, separators=(",", ":"))
                os.replace(tmp, self.path)
            except OSError:
                pass

    def get(self, sid: str) -> dict | None:
        with self.lock:
            v = self.data.get(sid)
            return dict(v) if v else None

    def recent(self, since: float) -> list[tuple[str, dict]]:
        with self.lock:
            return [(k, dict(v)) for k, v in self.data.items() if (v.get("at") or 0) >= since]

"""One save for the CEO's game, kept by the office so every screen shares it: the sticker album, badges, gifts and the
mailroom, streaks, goal days, quest stamps, Bug Squash bests, hire templates and the rest of the page's progress
(web/ui/util.js SYNC). The page merges it with its own copy on load and sends each change back; Settings exports and
imports it. Per-screen things (layout, drafts, what was dismissed) stay in each browser. Kept in state/save.json.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

from . import config

KEY = re.compile(r"[A-Za-z][A-Za-z0-9]{0,39}")
MAX_VALUE, MAX_TOTAL = 200_000, 2_000_000        # bytes of JSON: one key, and the whole save


class Save:
    def __init__(self, path: Path | None):
        self.path, self.lock = path, threading.Lock()
        d = config.read_state(path) if path else None
        self.keys: dict = {k: v for k, v in (d.get("keys") or {}).items() if KEY.fullmatch(k) and isinstance(v, dict) and "v" in v} \
            if isinstance(d, dict) else {}

    def view(self) -> dict:
        with self.lock:
            return {"keys": {k: dict(v) for k, v in self.keys.items()}, "at": max((v.get("at") or 0 for v in self.keys.values()), default=0)}

    def put(self, key, value, at) -> dict:
        """One key's new value and when the page changed it (ms). An older write than the one kept is ignored."""
        if not isinstance(key, str) or not KEY.fullmatch(key):
            raise ValueError("A save key is a short name")
        if isinstance(at, bool) or not isinstance(at, (int, float)) or not 0 < at < (time.time() + 86400) * 1000:
            raise ValueError("at is when it changed, in milliseconds")
        raw = json.dumps(value, separators=(",", ":"))
        if len(raw) > MAX_VALUE:
            raise ValueError("That value is too big to keep")
        with self.lock:
            old = self.keys.get(key)
            if old and (old.get("at") or 0) > at:
                return {"ok": True, "kept": "newer"}
            total = sum(len(json.dumps(v.get("v"), separators=(",", ":"))) for k, v in self.keys.items() if k != key) + len(raw)
            if total > MAX_TOTAL:
                raise ValueError("The save is full")
            self.keys[key] = {"v": value, "at": at}
            self._write()
        return {"ok": True}

    def _write(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                json.dump({"keys": self.keys}, fh, separators=(",", ":"))
            os.replace(tmp, self.path)
        except OSError:
            pass

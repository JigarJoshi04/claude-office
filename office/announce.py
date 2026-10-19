"""The CEO's announcements: a short note ("Freeze merges until 5 pm") pinned to the briefing, the TV ticker and a sticky
note on the CEO desk until it expires. The last 20 are kept in announcements.json; only unexpired ones show.
"""
from __future__ import annotations

import json
import os
import secrets
import threading
import time
from pathlib import Path

from . import config

KEEP, MAX_TEXT = 20, 280


class Announcements:
    def __init__(self, path: Path | None):
        self.path = path
        self.lock = threading.Lock()
        self.items: list[dict] = []
        try:
            d = json.loads(path.read_text()) if path else None
            self.items = [a for a in (d if isinstance(d, list) else []) if isinstance(a, dict) and a.get("id") and isinstance(a.get("text"), str)]
        except (OSError, ValueError):
            pass

    def _save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.items[-KEEP:]))
            os.replace(tmp, self.path)
        except OSError:
            pass

    def post(self, text, hours) -> dict:
        text = " ".join(str(text or "").split())
        if not 1 <= len(text) <= MAX_TEXT:
            raise ValueError(f"An announcement is 1 to {MAX_TEXT} characters")
        if type(hours) not in (int, float) or not 0.25 <= hours <= 72:
            raise ValueError("It stays up from a quarter of an hour to 72 hours")
        now = time.time()
        item = {"id": secrets.token_hex(4), "text": text, "at": now, "until": now + hours * 3600}
        with self.lock:
            self.items = (self.items + [item])[-KEEP:]
            self._save()
        return item

    def clear(self, aid) -> bool:
        with self.lock:
            before = len(self.items)
            self.items = [a for a in self.items if a.get("id") != str(aid)]
            if len(self.items) != before:
                self._save()
                return True
        return False

    def active(self, now: float | None = None) -> list[dict]:
        now = now or time.time()
        with self.lock:
            return sorted((dict(a) for a in self.items if a.get("until", 0) > now), key=lambda a: -a["at"])


def default() -> Announcements:
    return Announcements(config.STATE_DIR / "announcements.json")

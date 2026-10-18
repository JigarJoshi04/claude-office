"""Reminders without a calendar: a note to yourself for a time, or for when something in the office happens: a seat's
5-hour plan comes back, a session finishes, a lane ends, a PR merges. Each fires once as office news (a toast, a desktop
notification, the voice), marked late when the office was down at the time, and is forgotten a week after it was
set. Kept in `state/reminders.json`.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

from . import config

KINDS = ("at", "seat_reset", "session_end", "lane_end", "pr_merged")
MAX_TEXT, MAX_OPEN, KEEP_S, LATE_S = 140, 50, 7 * 86400, 300
_ENDED = {"done", "blocked", "failed", "stopped", "finished", "interrupted"}


def trigger_from(t, now: float | None = None) -> dict:
    """A reminder's trigger from the page or the CLI, checked: {"kind": "at", "at"} or {"kind": ..., "ref"}."""
    now = now or time.time()
    if not isinstance(t, dict) or t.get("kind") not in KINDS:
        raise ValueError("A reminder needs a trigger: at, seat_reset, session_end, lane_end or pr_merged")
    if t["kind"] == "at":
        at = t.get("at")
        if isinstance(at, bool) or not isinstance(at, (int, float)) or not now - 60 <= at <= now + KEEP_S:
            raise ValueError("A reminder can be set up to a week ahead")
        return {"kind": "at", "at": float(at)}
    ref = t.get("ref")
    if not isinstance(ref, str) or not 1 <= len(ref) <= 200:
        raise ValueError("The trigger needs what it is about (ref)")
    if t["kind"] == "pr_merged" and not re.fullmatch(r"#?\d{1,7}", ref):
        raise ValueError("A PR is its number, like #482")
    return {"kind": t["kind"], "ref": ref.lstrip("#") if t["kind"] == "pr_merged" else ref}


class Reminders:
    def __init__(self, path: Path | None):
        self.path, self.lock = path, threading.Lock()
        d = config.read_state(path) if path else None
        self.items: list[dict] = [x for x in d if isinstance(x, dict) and x.get("id") and isinstance(x.get("trigger"), dict)] if isinstance(d, list) else []

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

    def add(self, text: str, trigger: dict, seat: str | None = None, label: str | None = None, due: float | None = None,
            now: float | None = None, seen: bool = False, was_limited: bool = False) -> dict:
        now = now or time.time()
        text = " ".join(str(text or "").split())[:MAX_TEXT]
        if not text:
            raise ValueError("Write what to be reminded of")
        with self.lock:
            if sum(1 for x in self.items if not x.get("fired_at")) >= MAX_OPEN:
                raise ValueError(f"At most {MAX_OPEN} reminders at once")
            item = {"id": uuid.uuid4().hex[:10], "text": text, "trigger": trigger, "seat": seat, "label": (label or "")[:80] or None,
                    "due": due if due is not None else trigger.get("at"), "created": now, "fired_at": None, "late": False,
                    "seen": seen, "was_limited": was_limited}   # what the trigger saw when it was set (kept across restarts)
            self.items.append(item)
            self._save()
        return dict(item)

    def delete(self, rid: str) -> bool:
        with self.lock:
            n = len(self.items)
            self.items = [x for x in self.items if x["id"] != rid]
            self._save()
            return len(self.items) < n

    def check(self, snap: dict, now: float, events=(), merged_prs=()) -> list[dict]:
        """Fire every reminder whose moment has come, from the snapshot, the latest news and the PR numbers seen
        merged on the shelf; returns them."""
        live = {x.get("id") for s in snap.get("seats", []) for x in s.get("sessions", []) if x.get("live", True)}
        lanes = {l.get("id"): l.get("status") for l in snap.get("lanes", [])}
        seats = {s["id"]: s for s in snap.get("seats", [])}
        merged: dict[str, float] = {}               # PR number -> when it was seen merged (the latest, across repos)
        for e in events:
            m = e.get("kind") == "shipped" and re.search(r"PR #(\d+) merged$", e.get("text") or "")
            if m:
                merged[m.group(1)] = max(merged.get(m.group(1), 0), e.get("ts") or now)
        for item in merged_prs:                     # (number, merged at) from the shelf; a bare number counts as now
            n, at = item if isinstance(item, (tuple, list)) else (item, now)
            merged[str(n)] = max(merged.get(str(n), 0), at or 0)
        fired, flipped = [], False
        with self.lock:
            for x in self.items:
                if x.get("fired_at"):
                    continue
                t, hit = x["trigger"], False
                if t["kind"] == "at":
                    hit = now >= t["at"]
                elif t["kind"] == "seat_reset":                # back: past its reset and not out any more
                    s = seats.get(t["ref"]) or {}
                    back = s.get("status") not in (None, "limited")
                    hit = back and (bool(x.get("due") and now >= x["due"]) or bool(x.get("was_limited")))
                    if s.get("status") == "limited" and not x.get("was_limited"):
                        x["was_limited"] = flipped = True
                elif t["kind"] == "session_end":
                    hit = bool(x.get("seen")) and t["ref"] not in live
                    if not x.get("seen") and t["ref"] in live:
                        x["seen"] = flipped = True
                elif t["kind"] == "lane_end":
                    hit = lanes.get(t["ref"]) in _ENDED
                elif t["kind"] == "pr_merged":             # merged after it was set: an old #12 in another repo is not it
                    hit = merged.get(t["ref"], -1) >= x["created"] - 300
                if hit:
                    x["fired_at"] = now
                    x["late"] = bool(x.get("due") and now - x["due"] > LATE_S)
                    fired.append(dict(x))
            before = len(self.items)
            self.items = [x for x in self.items if now - x["created"] < KEEP_S and not (x.get("fired_at") and now - x["fired_at"] > 86400)]
            if fired or flipped or len(self.items) != before:
                self._save()
        return fired

    def view(self) -> list[dict]:
        with self.lock:
            return [{k: x.get(k) for k in ("id", "text", "trigger", "seat", "label", "due", "created", "fired_at", "late")}
                    for x in self.items if not x.get("fired_at")]

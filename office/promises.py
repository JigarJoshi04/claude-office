"""Promises: the CEO says by when a lane's work will be done ("the billing migration by Friday 6 pm"), and the lane's own
report keeps the promise or breaks it. It is kept when the lane, or the last stage of its chain, files a DONE report
before the time; broken when the time passes first. A blocked report does not break it while there is time to resume.
Kept in state/promises.json for every screen; a promise due within two hours on work still out shows in Needs you.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from . import config, lanes

MAX_OPEN, KEEP_DONE = 20, 60
SOON_S = 2 * 3600                         # due this soon on work still out: it needs the CEO
FINISHED = ("done", "blocked", "failed", "stopped", "finished")


def final_stage(lane: dict | None, load=lanes.load_lane) -> dict | None:
    """The last stage so far of a lane's chain (the lane itself when it has none)."""
    seen = set()
    while lane and lane.get("chain_next") and lane["chain_next"] not in seen:
        seen.add(lane["chain_next"])
        nxt = load(lane["chain_next"])
        if not nxt:
            break
        lane = nxt
    return lane


def done_at(lane: dict) -> float | None:
    """When a lane finished with a DONE report and nothing left in its chain, or None."""
    if lane.get("status") != "done" or lane.get("chain"):            # "finished" is an exit without a report: it keeps nothing
        return None
    runs = lane.get("runs") or []
    return lane.get("finished_at") or (runs[-1].get("ended_at") if runs else None) or None


class Promises:
    def __init__(self, path: Path | None):
        self.path, self.lock = path, threading.Lock()
        d = config.read_state(path) if path else None
        self.items: list[dict] = [p for p in (d.get("items") if isinstance(d, dict) else None) or [] if isinstance(p, dict) and p.get("id")]

    def make(self, lane_id: str, due, now: float | None = None, load=lanes.load_lane) -> dict:
        now = now or time.time()
        if isinstance(due, bool) or not isinstance(due, (int, float)) or not now + 300 <= due <= now + 30 * 86400:
            raise ValueError("A promise is due between 5 minutes and 30 days from now")
        if not isinstance(lane_id, str) or not lanes.LANE_ID.match(lane_id):
            raise ValueError("Unknown lane")
        lane = load(lane_id)
        if not lane:
            raise ValueError("Unknown lane")
        last = final_stage(lane, load)
        if last and (last.get("status") in FINISHED and not (last.get("status") == "done" and last.get("chain"))):
            raise ValueError("That lane has already finished")
        with self.lock:
            mine = next((p for p in self.items if p["lane"] == lane_id and p["status"] == "open"), None)
            if mine:                                          # one open promise per lane: a new time replaces the old
                mine["due"] = float(due)
                p = mine
            else:
                if sum(p["status"] == "open" for p in self.items) >= MAX_OPEN:
                    raise ValueError(f"At most {MAX_OPEN} open promises")
                p = {"id": os.urandom(4).hex(), "lane": lane_id, "title": lane.get("title") or lane_id,
                     "seat": lane.get("seat") or (lane.get("seat_pref") if lane.get("seat_pref") != "auto" else None),
                     "due": float(due), "made_at": now, "status": "open"}
                self.items.append(p)
            self._save()
            return dict(p)

    def drop(self, pid: str) -> dict:
        with self.lock:
            p = next((p for p in self.items if p["id"] == pid and p["status"] == "open"), None)
            if not p:
                raise ValueError("No such open promise")
            self.items.remove(p)
            self._save()
            return {"ok": True}

    def evaluate(self, lanes_now: list[dict], now: float, load=lanes.load_lane) -> list[dict]:
        """Settle the open promises against their lanes. Returns those settled now (status kept or broken)."""
        known = {l.get("id"): l for l in lanes_now}
        get = lambda lid: known.get(lid) or load(lid)
        out = []
        with self.lock:
            for p in self.items:
                if p["status"] != "open":
                    continue
                last = final_stage(get(p["lane"]), get)
                if last is None:                               # the lane was deleted: nothing can keep it
                    p.update(status="broken", settled_at=now, why="lost its lane")
                    out.append(dict(p))
                    continue
                at = done_at(last)
                p["state"] = last.get("status")
                p["seat"] = last.get("seat") or p.get("seat")
                if at and at <= p["due"]:
                    p.update(status="kept", settled_at=now, done_at=at, early_s=round(p["due"] - at), trust=(last.get("trust") or {}).get("level"))
                    out.append(dict(p))
                elif now > p["due"]:
                    p.update(status="broken", settled_at=now, why="was not done in time" if not at else "finished late")
                    out.append(dict(p))
            if out:
                done = [p for p in self.items if p["status"] != "open"]
                for p in done[:-KEEP_DONE]:
                    self.items.remove(p)
                self._save()
        return out

    def view(self, now: float) -> dict:
        with self.lock:
            open_ = sorted((dict(p) for p in self.items if p["status"] == "open"), key=lambda p: p["due"])
            done = sorted((dict(p) for p in self.items if p["status"] != "open"), key=lambda p: -(p.get("settled_at") or 0))
        streak = 0
        for p in done:                                         # kept in a row, the newest first
            if p["status"] != "kept":
                break
            streak += 1
        return {"open": open_, "recent": done[:8], "kept": sum(p["status"] == "kept" for p in done),
                "broken": sum(p["status"] == "broken" for p in done), "streak": streak}

    def attention(self, now: float) -> list[dict]:
        """Open promises due within SOON_S whose work is still out."""
        with self.lock:
            return [{"level": "warn", "promise": p["id"], "lane": p["lane"], "seat": p.get("seat"),
                     "text": f"Promise due {_until(p['due'] - now)}: '{p['title']}' is {p.get('state') or 'still out'}"}
                    for p in self.items if p["status"] == "open" and p["due"] - now <= SOON_S]

    def _save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"items": self.items}, separators=(",", ":")))
            os.replace(tmp, self.path)
        except OSError:
            pass


def early_words(s: float) -> str:
    """How early a promise was kept, in words."""
    m = round(s / 60)
    return f"{m} min early" if m < 60 else f"{m // 60} h {m % 60:02d} early" if m < 24 * 60 else f"{m // 1440} day{'s' if m >= 2880 else ''} early"


def _until(s: float) -> str:
    if s <= 60:
        return "now"
    m = round(s / 60)
    return f"in {m} min" if m < 60 else f"in {m // 60} h {m % 60:02d}"

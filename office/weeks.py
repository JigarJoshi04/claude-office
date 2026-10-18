"""Par for the week: each seat's weekly plan window, scored like a round of golf.

Using most of a plan without running into its weekly limit is the good round; leaving most of it unused, or hitting the
wall and waiting, costs strokes. A window is followed from the seat's weekly usage readings: its end (the reset time,
rounded to the hour because readings jitter), the highest use seen, how often the seat ran out of its week and for how
long, and how often it hit the 5-hour wall on the way (noted, not scored). When the reset passes, the window is closed
and scored. Kept in `state/weeks.json`: the open window per seat and the last 52 closed ones.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from . import config

KEEP = 52
WEEK = 7 * 86400


def grade(peak: float | None, week_limits: int = 0, limited_min: float = 0, benched: bool = False) -> dict:
    """A closed (or so-far) window's score against par, with its name and why. A seat sent on holiday is not scored
    for the plan it left unused."""
    if peak is None or peak < 5 or (benched and not week_limits and peak < 60):
        return {"score": None, "name": "Rest week", "why": "on holiday" if benched else "the seat was barely used"}
    if week_limits:
        bad = limited_min >= 6 * 60
        return {"score": 2 if bad else 1, "name": "Double bogey" if bad else "Bogey",
                "why": f"ran out of its week{' for ' + str(round(limited_min / 60)) + ' h' if limited_min >= 60 else ''}"}
    if peak >= 97:
        return {"score": -2, "name": "Eagle", "why": f"used {peak:.0f}% without running out"}
    if peak >= 90:
        return {"score": -1, "name": "Birdie", "why": f"used {peak:.0f}% without running out"}
    if peak >= 60:
        return {"score": 0, "name": "Par", "why": f"used {peak:.0f}% of the plan"}
    if peak >= 30:
        return {"score": 1, "name": "Bogey", "why": f"left {100 - peak:.0f}% of the plan unused"}
    return {"score": 2, "name": "Double bogey", "why": f"left {100 - peak:.0f}% of the plan unused"}


class Weeks:
    def __init__(self, path: Path | None):
        self.path, self.lock, self._saved = path, threading.Lock(), 0.0
        d = config.read_state(path) if path else None
        d = d if isinstance(d, dict) else {}
        self.open: dict = {k: v for k, v in (d.get("open") or {}).items() if isinstance(v, dict) and isinstance(v.get("ends"), (int, float))}
        self.closed: dict = {k: [w for w in v if isinstance(w, dict)][-KEEP:] for k, v in (d.get("closed") or {}).items() if isinstance(v, list)}

    def _close(self, seat: str, w: dict) -> dict:
        done = dict(w, **grade(w.get("peak"), w.get("limits", 0), w.get("limited_min", 0), bool(w.get("benched"))))
        done.pop("was_limited", None); done.pop("last", None)
        self.closed.setdefault(seat, []).append(done)
        self.closed[seat] = self.closed[seat][-KEEP:]
        return done

    def observe(self, seats: list[dict], now: float, seed=None) -> list[tuple[str, dict]]:
        """Follow every Claude seat's weekly window; returns the windows closed by this reading, as (seat, window).
        seed(seat, start, end) gives the highest weekly use already on record, for a window seen for the first time."""
        out = []
        with self.lock:
            for seat, w in list(self.open.items()):          # resets that passed while the office was down
                if w["ends"] < now - 3600:
                    out.append((seat, self._close(seat, self.open.pop(seat))))
            for s in seats:
                wk = (s.get("usage") or {}).get("weekly") or {}
                pct, resets = wk.get("pct"), wk.get("resets_at")
                if s.get("kind") != "claude" or not isinstance(pct, (int, float)) or not isinstance(resets, (int, float)):
                    continue
                ends = round(resets / 3600) * 3600
                w = self.open.get(s["id"])
                if w and abs(w["ends"] - ends) > 3600:          # the week turned over
                    out.append((s["id"], self._close(s["id"], self.open.pop(s["id"]))))
                    w = None
                if not w:
                    first = seed(s["id"], ends - WEEK, now) if seed else None
                    w = self.open[s["id"]] = {"ends": ends, "starts": ends - WEEK, "peak": max(pct, first or 0), "limits": 0,
                                              "limited_min": 0, "five_hour_walls": 0, "was_limited": None, "last": now}
                w["peak"] = max(w["peak"], float(pct))
                if not (s.get("divider") or {}).get("enabled", True):
                    w["benched"] = True
                limited = s.get("status") == "limited"
                by_week = limited and pct >= 99
                if limited and w.get("was_limited") is False:
                    if by_week:
                        w["limits"] += 1
                    else:
                        w["five_hour_walls"] += 1
                if by_week:
                    w["limited_min"] += min(5.0, max(0.0, (now - (w.get("last") or now)) / 60))
                w["was_limited"], w["last"] = limited, now
            if out or now - self._saved > 300:
                self._save(now)
        return out

    def _save(self, now: float) -> None:
        self._saved = now
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                json.dump({"open": self.open, "closed": self.closed}, fh, separators=(",", ":"))
            os.replace(tmp, self.path)
        except OSError:
            pass

    def card(self, seat: str, forecast: dict | None = None, now_ts: float | None = None, weeks: int = 6) -> dict:
        """A seat's scorecard: this week so far (and where its pace lands it), the last few weeks and the season total."""
        now_ts = now_ts or time.time()
        with self.lock:
            w = dict(self.open.get(seat) or {})
            past = [dict(x) for x in (self.closed.get(seat) or [])][-weeks:]
            season = [x.get("score") for x in (self.closed.get(seat) or []) if x.get("score") is not None]
        now = None
        if w:
            benched = bool(w.get("benched"))
            now = dict(grade(w.get("peak"), w.get("limits", 0), w.get("limited_min", 0), benched), ends=w["ends"], peak=w.get("peak"),
                       five_hour_walls=w.get("five_hour_walls", 0), elapsed=round(min(1.0, max(0.0, (now_ts - w["starts"]) / WEEK)), 2))
            now["benched"] = benched
            if w.get("limits"):
                now["heading"] = now["name"]
            elif benched:
                now["heading"] = None                          # on holiday: nothing to call
            elif forecast and forecast.get("state") == "runs_out":
                now["heading"] = "Bogey"                       # at this pace it runs out before the reset
            elif now["elapsed"] >= 0.15:                       # the week so far, carried on to the reset: past 100% it runs out
                pace = (w.get("peak") or 0) / now["elapsed"]
                now["heading"] = "Bogey" if pace > 100 else grade(pace, benched=benched)["name"]
            else:
                now["heading"] = None                          # too early to call
        return {"now": now, "past": [{k: x.get(k) for k in ("ends", "peak", "score", "name", "why", "limits", "five_hour_walls")} for x in past],
                "season": sum(season) if season else None, "rounds": len(season)}


def seed_from_history(path: Path):
    """seed(seat, start, end) for Weeks.observe: the highest weekly use in the history samples (state/history.jsonl)."""
    def seed(seat: str, start: float, end: float) -> float | None:
        best = None
        try:
            with open(path, "rb") as fh:
                for raw in fh:
                    try:
                        row = json.loads(raw)
                        if start <= row["ts"] <= end:
                            pw = (row["seats"].get(seat) or [None, None])[1]
                            if isinstance(pw, (int, float)):
                                best = pw if best is None else max(best, pw)
                    except (ValueError, KeyError, TypeError, AttributeError):
                        continue
        except OSError:
            return None
        return best
    return seed

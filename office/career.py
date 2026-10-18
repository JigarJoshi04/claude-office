"""Careers: every seat's character earns XP from real work, levels up and unlocks achievements. Kept for good.

XP is plain and countable: a tool call is 1, a minute at work is 2, a new session is 10 and a filed report is 100.
Shipped work counts too (read from the transcripts by the token ledger): a commit is 25, a push 5, an opened pull
request 50 and a merged one 150, from the day the office starts counting it (no back pay, so levels keep their meaning).
Level n needs 100 * (n - 1)^2 XP, so early levels come quickly and later ones take real weeks of work.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
import threading
import time
from pathlib import Path

XP_TOOL, XP_MINUTE, XP_SESSION, XP_REPORT = 1, 2, 10, 100
XP_SHIP = (25, 5, 50, 150)              # a commit, a push, a PR opened, a PR merged
TITLES = [(1, "Intern"), (3, "Junior"), (6, "Engineer"), (10, "Senior"), (15, "Staff"), (20, "Principal"),
          (30, "Distinguished"), (50, "Legend")]

# id, name, what earns it, icon (from web/ui/icons.js)
ACHIEVEMENTS = [
    ("first_hour", "First day", "Spend a full hour at work", "clock"),
    ("first_report", "Signed off", "File a first report", "file"),
    ("paper_trail", "Paper trail", "File 10 reports", "files"),
    ("hands_1k", "Busy hands", "Make 1,000 tool calls", "tool"),
    ("hands_10k", "Machine", "Make 10,000 tool calls", "zap"),
    ("marathon", "Marathon", "Keep one session at work for 4 hours", "trophy"),
    ("night_shift", "Night shift", "Work between 1 and 5 AM", "moon"),
    ("early_bird", "Early bird", "Work between 5 and 7 AM", "sun"),
    ("juggler", "Juggler", "Run four sessions at work at once", "layers"),
    ("hit_the_wall", "Hit the wall", "Use up a plan window for the first time", "battery"),
    ("comeback", "Comeback", "Get back to work within 10 minutes of a reset", "refresh"),
    ("tokens_10m", "Ten million", "Use 10 million tokens", "spark"),
    ("regular", "Regular", "Work on 3 days in a row", "calendar"),
    ("week_streak", "Week streak", "Work 7 days in a row", "flame"),
    ("level_10", "Senior", "Reach level 10", "star"),
    ("first_commit", "Shipped it", "Land a first commit", "check"),
    ("commits_100", "Committer", "Land 100 commits", "branch"),
    ("commits_1k", "Prolific", "Land 1,000 commits", "layers"),
    ("first_merge", "Merged", "Get a first pull request merged", "send"),
    ("merges_50", "Release train", "Get 50 pull requests merged", "trophy"),
]
CATALOGUE = [{"id": a, "name": n, "desc": d, "icon": i} for a, n, d, i in ACHIEVEMENTS]
NAMES = {a: n for a, n, _, _ in ACHIEVEMENTS}


def level_for(xp: float) -> int:
    return int(math.sqrt(max(0, xp) / 100)) + 1


def xp_for(level: int) -> int:
    return 100 * (level - 1) ** 2


def title_for(level: int) -> str:
    return [t for lv, t in TITLES if level >= lv][-1]


def _day(ts: float) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def _streak(days: list[str]) -> int:
    """Consecutive days at work, ending today or yesterday."""
    have = set(days)
    t = time.time()
    if _day(t) not in have:
        t -= 86400
    n = 0
    while _day(t) in have:
        n += 1
        t -= 86400
    return n


def new_seat(now: float) -> dict:
    return {"xp": 0, "tool_calls": 0, "active_s": 0.0, "sessions": 0, "reports": 0, "limits": 0, "tokens": 0,
            "days": [], "unlocked": {}, "since": now}


class Career:
    """Accumulates each seat's career from the snapshots. ``observe`` returns the news it produced."""

    def __init__(self, path: Path | None, clock=time.time):
        self.path, self.clock = path, clock
        self.lock = threading.Lock()
        self.seats: dict[str, dict] = {}
        self.sess: dict[str, dict] = {}
        self._status: dict[str, str] = {}
        self._reset_at: dict[str, float] = {}
        self._last = None
        self._saved = 0.0
        self._dirty = False
        if path:
            try:
                d = json.loads(path.read_text())
                self.seats = {k: dict(new_seat(v.get("since") or clock()), **v) for k, v in d.get("seats", {}).items()}
                self.sess = d.get("sessions", {})
            except (OSError, ValueError, AttributeError):
                pass

    def observe(self, snap: dict) -> list[tuple[str, str, str]]:
        """Credit the work since the last snapshot. Returns (seat id, kind, text) news items."""
        now = snap.get("now")
        now = self.clock() if now is None else now
        news: list[tuple[str, str, str]] = []
        with self.lock:
            quiet = self._last is None   # the first look credits work done so far, without a flood of news
            dt = 0.0 if self._last is None else max(0.0, min(30.0, now - self._last))
            self._last = now
            hour = time.localtime(now).tm_hour
            for s in snap.get("seats", []):
                sid = s["id"]
                c = self.seats.setdefault(sid, new_seat(now))
                before_level = level_for(c["xp"])
                gained = 0
                live = [x for x in s.get("sessions", []) if x.get("live", True)]
                working = [x for x in live if x.get("state") in ("working", "waiting")]
                for x in live:
                    key = f"{sid}/{x['id']}"
                    st = self.sess.get(key)
                    tools, toks = int(x.get("tool_calls") or 0), int(x.get("tokens_total") or 0)
                    if st is None:
                        st = self.sess[key] = {"tools": tools, "tokens": toks, "active_s": 0.0, "reported": False}
                        c["sessions"] += 1
                        c["tool_calls"] += tools
                        c["tokens"] += toks
                        gained += XP_SESSION + tools * XP_TOOL
                    else:
                        # Counters only grow; a smaller one means the office re-read the transcript, so re-baseline.
                        dtools, dtoks = tools - st["tools"], toks - st["tokens"]
                        if dtools > 0:
                            c["tool_calls"] += dtools
                            gained += dtools * XP_TOOL
                        if dtoks > 0:
                            c["tokens"] += dtoks
                        st["tools"], st["tokens"] = tools, toks
                    st["seen"] = now
                    if x.get("state") in ("working", "waiting"):
                        st["active_s"] = st.get("active_s", 0.0) + dt
                        if st["active_s"] >= 4 * 3600:
                            news += self._unlock(c, sid, s, "marathon", now)
                    if x.get("report_status") and not st.get("reported"):
                        st["reported"] = True
                        if "BLOCKED" not in str(x["report_status"]).upper():
                            c["reports"] += 1
                            gained += XP_REPORT
                if working and dt:
                    before_min = int(c["active_s"] // 60)
                    c["active_s"] += dt
                    gained += (int(c["active_s"] // 60) - before_min) * XP_MINUTE
                    today = _day(now)
                    if today not in c["days"]:
                        c["days"] = (c["days"] + [today])[-60:]
                    if 1 <= hour < 5:
                        news += self._unlock(c, sid, s, "night_shift", now)
                    elif 5 <= hour < 7:
                        news += self._unlock(c, sid, s, "early_bird", now)
                    if self._reset_at.get(sid) and now - self._reset_at[sid] <= 600:
                        news += self._unlock(c, sid, s, "comeback", now)
                status = s.get("status") or ""
                was = self._status.get(sid)
                if status == "limited" and was and was != "limited":
                    c["limits"] += 1
                    news += self._unlock(c, sid, s, "hit_the_wall", now)
                if was == "limited" and status != "limited":
                    self._reset_at[sid] = now
                self._status[sid] = status
                c["xp"] += gained
                if gained:
                    self._dirty = True
                news += self._milestones(c, sid, s, now, len(working))
                after = level_for(c["xp"])
                if after > before_level:
                    news.append((sid, "levelup", f"{s.get('label', sid)} reached level {after}: {title_for(after)}"))
                    self._dirty = True
            # Forget sessions not seen for three days.
            self.sess = {k: v for k, v in self.sess.items() if now - v.get("seen", now) < 3 * 86400}
            if self._dirty and (quiet or now - self._saved > 60):
                self._save(now)
        return [] if quiet else news

    def credit_shipped(self, sid: str, label: str, v: list) -> list[tuple[str, str, str]]:
        """XP for work a seat just shipped: v is [commits, pushes, prs opened, prs merged, ...] (tokens.SHIP)."""
        gained = sum(n * xp for n, xp in zip(v, XP_SHIP))
        if not gained:
            return []
        with self.lock:
            c = self.seats.setdefault(sid, new_seat(self.clock()))
            before = level_for(c["xp"])
            c["xp"] += gained
            for k, n in zip(("commits", "pushes", "prs_opened", "prs_merged"), v):
                c[k] = c.get(k, 0) + n
            self._dirty = True
            after = level_for(c["xp"])
        return [(sid, "levelup", f"{label} reached level {after}: {title_for(after)}")] if after > before else []

    def shipped_totals(self, totals: dict, labels: dict) -> list[tuple[str, str, str]]:
        """Shipping achievements from the ledger's all-time counts per seat ({seat: (commits, prs merged)}). The first
        call unlocks what history already earned without news."""
        out, quiet = [], not getattr(self, "_shipped_seen", False)
        self._shipped_seen = True
        now = self.clock()
        with self.lock:
            for sid, (commits, merged) in totals.items():
                c = self.seats.setdefault(sid, new_seat(now))
                s = {"label": labels.get(sid, sid)}
                for aid, ok in (("first_commit", commits >= 1), ("commits_100", commits >= 100), ("commits_1k", commits >= 1000),
                                ("first_merge", merged >= 1), ("merges_50", merged >= 50)):
                    if ok:
                        out += self._unlock(c, sid, s, aid, now)
        return [] if quiet else out

    def _milestones(self, c: dict, sid: str, s: dict, now: float, working: int) -> list:
        out = []
        checks = [("first_hour", c["active_s"] >= 3600), ("first_report", c["reports"] >= 1),
                  ("paper_trail", c["reports"] >= 10), ("hands_1k", c["tool_calls"] >= 1000),
                  ("hands_10k", c["tool_calls"] >= 10000), ("juggler", working >= 4),
                  ("tokens_10m", c["tokens"] >= 10_000_000), ("level_10", level_for(c["xp"]) >= 10)]
        streak = _streak(c["days"])
        checks += [("regular", streak >= 3), ("week_streak", streak >= 7)]
        for aid, ok in checks:
            if ok:
                out += self._unlock(c, sid, s, aid, now)
        return out

    def _unlock(self, c: dict, sid: str, s: dict, aid: str, now: float) -> list:
        if aid in c["unlocked"]:
            return []
        c["unlocked"][aid] = now
        self._dirty = True
        return [(sid, "achievement", f"{s.get('label', sid)} unlocked {NAMES[aid]}")]

    def view(self, sid: str) -> dict:
        """What the page shows for one seat."""
        with self.lock:
            c = self.seats.get(sid) or new_seat(self.clock())
            lv = level_for(c["xp"])
            lo, hi = xp_for(lv), xp_for(lv + 1)
            return {"xp": int(c["xp"]), "level": lv, "title": title_for(lv), "level_xp": lo, "next_xp": hi,
                    "progress": round((c["xp"] - lo) / (hi - lo), 3), "unlocked": dict(c["unlocked"]),
                    "streak": _streak(c["days"]), "since": c.get("since"),
                    "stats": {"tool_calls": c["tool_calls"], "hours": round(c["active_s"] / 3600, 1),
                              "sessions": c["sessions"], "reports": c["reports"], "limits": c["limits"],
                              "tokens": c["tokens"]}}

    def _save(self, now: float) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".career-", dir=self.path.parent)
            with os.fdopen(fd, "w") as f:
                json.dump({"seats": self.seats, "sessions": self.sess}, f, separators=(",", ":"))
            os.replace(tmp, self.path)
            self._saved, self._dirty = now, False
        except OSError:
            pass

    def flush(self) -> None:
        with self.lock:
            if self._dirty:
                self._save(self.clock())

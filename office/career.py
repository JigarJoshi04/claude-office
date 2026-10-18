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

from . import config
from .sessions import report_blocked

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
    ("hands_100k", "Factory", "Make 100,000 tool calls", "server"),
    ("paper_50", "Filing clerk", "File 50 reports", "files"),
    ("paper_200", "Archivist", "File 200 reports", "layers"),
    ("tokens_100m", "Hundred million", "Use 100 million tokens", "spark"),
    ("tokens_1b", "Billionaire", "Use a billion tokens", "star"),
    ("month_streak", "Iron will", "Work 30 days in a row", "flame"),
    ("speed_run", "Speedrun", "File a report within 10 minutes of starting", "zap"),
    ("ultramarathon", "Ultramarathon", "Keep one session at work for 12 hours", "trophy"),
]
# Chains: each tier is shown once the one before it is earned. Secrets stay "???" until someone earns them.
CHAINS = {"hands_1k": ("hands", 1), "hands_10k": ("hands", 2), "hands_100k": ("hands", 3),
          "first_report": ("paper", 1), "paper_trail": ("paper", 2), "paper_50": ("paper", 3), "paper_200": ("paper", 4),
          "tokens_10m": ("tokens", 1), "tokens_100m": ("tokens", 2), "tokens_1b": ("tokens", 3),
          "regular": ("streak", 1), "week_streak": ("streak", 2), "month_streak": ("streak", 3),
          "marathon": ("marathon", 1), "ultramarathon": ("marathon", 2),
          "first_commit": ("commits", 1), "commits_100": ("commits", 2), "commits_1k": ("commits", 3),
          "first_merge": ("merges", 1), "merges_50": ("merges", 2)}
HIDDEN = {"speed_run", "ultramarathon"}
CATALOGUE = [{"id": a, "name": n, "desc": d, "icon": i, "chain": CHAINS.get(a, (None, 0))[0], "tier": CHAINS.get(a, (None, 0))[1],
              "hidden": a in HIDDEN} for a, n, d, i in ACHIEVEMENTS]
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


BOND_LEVELS = (10, 30, 80)
BOND_NAMES = {0: "Colleagues", 1: "Teammates", 2: "Good friends", 3: "Best friends"}


def bond_key(a: str, b: str) -> str:
    return "|".join(sorted((a, b)))


def new_bond() -> dict:
    return {"pts": 0, "level": 0, "cowork_s": 0.0, "reports": 0, "covers": 0}


def bond_level(pts: float) -> int:
    return sum(1 for t in BOND_LEVELS if pts >= t)


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
        self.bonds: dict[str, dict] = {}     # "a|b" -> {pts, level, cowork_s, reports, covers}: teammate bonds
        self.covers_seen: list[str] = []     # lane hand-offs already counted ("lane:run")
        self._report_at: dict[str, float] = {}
        d = config.read_state(path)                    # a damaged file is set aside, never written over
        if isinstance(d, dict):
            try:
                self.seats = {k: dict(new_seat(v.get("since") or clock()), **v) for k, v in d.get("seats", {}).items()}
                self.sess = d.get("sessions", {})
                self.bonds = {k: v for k, v in (d.get("bonds") or {}).items() if isinstance(v, dict)}
                self.covers_seen = [x for x in d.get("covers_seen") or [] if isinstance(x, str)]
            except (AttributeError, TypeError):
                pass

    def observe(self, snap: dict) -> list[tuple[str, str, str]]:
        """Credit the work since the last snapshot. Returns (seat id, kind, text) news items."""
        now = snap.get("now")
        now = self.clock() if now is None else now
        news: list[tuple[str, str, str]] = []
        reported: list[str] = []          # seats that filed a good report in this look (for bonds)
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
                        if st["active_s"] >= 12 * 3600:
                            news += self._unlock(c, sid, s, "ultramarathon", now)
                    if x.get("report_status") and not st.get("reported"):
                        st["reported"] = True
                        if not report_blocked(str(x["report_status"])):
                            c["reports"] += 1
                            gained += XP_REPORT
                            if not quiet:
                                reported.append(sid)
                            if not quiet and x.get("started_at") and now - x["started_at"] <= 600:
                                news += self._unlock(c, sid, s, "speed_run", now)
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
            news += self._bonds(snap, now, dt, quiet, reported)
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

    def _bonds(self, snap: dict, now: float, dt: float, quiet: bool, reported: list[str]) -> list:
        """Teammate bonds from real shared history: +2 for every half hour two seats work in the same repository, +3
        when they file good reports within 15 minutes of each other, +5 when one takes over a lane the other's limit
        cut short. Bonds level up at 10, 30 and 80 points (news, once each)."""
        labels = {s["id"]: s.get("label") or s["id"] for s in snap.get("seats", [])}
        gained: dict[str, float] = {}
        add = lambda a, b, pts, what: (gained.__setitem__(bond_key(a, b), gained.get(bond_key(a, b), 0) + pts),
                                       self.bonds.setdefault(bond_key(a, b), new_bond()).__setitem__(what, self.bonds[bond_key(a, b)].get(what, 0) + 1))
        repos: dict[str, set] = {}                 # repository -> seats working in it now
        for s in snap.get("seats", []):
            for x in s.get("sessions", []):
                g = x.get("git") or {}
                if x.get("live", True) and x.get("state") in ("working", "waiting") and g.get("repo") and g.get("branch"):
                    repos.setdefault(g["repo"], set()).add(s["id"])
        if dt:
            pairs = {bond_key(a, b) for ids in repos.values() for a in ids for b in ids if a < b}
            for k in pairs:
                b = self.bonds.setdefault(k, new_bond())
                before = int(b.get("cowork_s", 0) // 1800)
                b["cowork_s"] = b.get("cowork_s", 0) + dt
                if int(b["cowork_s"] // 1800) > before:
                    gained[k] = gained.get(k, 0) + 2
        for sid in reported:                       # reports within 15 minutes of a teammate's
            for other, at in self._report_at.items():
                if other != sid and now - at <= 900:
                    add(sid, other, 3, "reports")
            self._report_at[sid] = now
        seen = set(self.covers_seen)
        for l in snap.get("lanes") or []:          # a lane that moved seats after a limit: the new seat covered
            runs = l.get("runs") or []
            for i in range(1, len(runs)):
                key = f"{l.get('id')}:{i}"
                if key in seen or runs[i - 1].get("ended_by") != "limit" or not runs[i].get("seat") or runs[i]["seat"] == runs[i - 1].get("seat"):
                    continue
                self.covers_seen.append(key)
                seen.add(key)
                if not quiet:
                    add(runs[i]["seat"], runs[i - 1]["seat"], 5, "covers")
        out = []
        for k, pts in gained.items():
            b = self.bonds.setdefault(k, new_bond())
            b["pts"] = b.get("pts", 0) + pts
            lv = bond_level(b["pts"])
            self._dirty = True
            if lv > b.get("level", 0):
                b["level"] = lv
                a, c = k.split("|")
                if not quiet:
                    out.append((a, "bond", f"{labels.get(a, a)} and {labels.get(c, c)} are {BOND_NAMES[lv].lower()} now"))
        return out

    def closest(self, sid: str) -> dict | None:
        """The teammate a seat has the strongest bond with: {with, pts, level, name, cowork_h, reports, covers}."""
        with self.lock:
            best = max(((k, b) for k, b in self.bonds.items() if sid in k.split("|") and b.get("pts", 0) > 0),
                       key=lambda kb: kb[1].get("pts", 0), default=None)
        if not best:
            return None
        k, b = best
        other = next(x for x in k.split("|") if x != sid) if k.count(sid) == 1 else sid
        lv = bond_level(b.get("pts", 0))
        return {"with": other, "pts": round(b.get("pts", 0)), "level": lv, "name": BOND_NAMES[lv],
                "cowork_h": round(b.get("cowork_s", 0) / 3600, 1), "reports": b.get("reports", 0), "covers": b.get("covers", 0),
                "next": next((t for t in BOND_LEVELS if t > b.get("pts", 0)), None)}

    def _milestones(self, c: dict, sid: str, s: dict, now: float, working: int) -> list:
        out = []
        checks = [("first_hour", c["active_s"] >= 3600), ("first_report", c["reports"] >= 1),
                  ("paper_trail", c["reports"] >= 10), ("hands_1k", c["tool_calls"] >= 1000),
                  ("hands_10k", c["tool_calls"] >= 10000), ("juggler", working >= 4),
                  ("tokens_10m", c["tokens"] >= 10_000_000), ("level_10", level_for(c["xp"]) >= 10),
                  ("hands_100k", c["tool_calls"] >= 100_000), ("paper_50", c["reports"] >= 50), ("paper_200", c["reports"] >= 200),
                  ("tokens_100m", c["tokens"] >= 100_000_000), ("tokens_1b", c["tokens"] >= 1_000_000_000)]
        streak = _streak(c["days"])
        checks += [("regular", streak >= 3), ("week_streak", streak >= 7), ("month_streak", streak >= 30)]
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
                json.dump({"seats": self.seats, "sessions": self.sess, "bonds": self.bonds, "covers_seen": self.covers_seen[-500:]}, f, separators=(",", ":"))
            os.replace(tmp, self.path)
            self._saved, self._dirty = now, False
        except OSError:
            pass

    def flush(self) -> None:
        with self.lock:
            if self._dirty:
                self._save(self.clock())

"""The office as one picture: seats, who sits at which desk, the server room, the whiteboard, and the news.

``Office`` refreshes a snapshot on a background thread (sessions every few seconds, plan usage on its own
poller) so the page always gets an instant answer. ``quick_seats`` is the light version the CLI and lane
runner use to ask the divider for a seat without starting the whole office.
"""
from __future__ import annotations

import fnmatch
import json
import shutil
import subprocess
import threading
import time
from collections import deque
from pathlib import Path

from . import config, divider, lanes, seats as seatmod, sessions
from .career import CATALOGUE, Career
from .history import DayLedger, HistoryStore
from .tokens import TokenLedger
from .live import LiveOffice, public
from .voice import Announcer

try:  # written by the Astra lane; the office still runs without it
    from .codex_seat import read_codex_seat
except Exception:  # pragma: no cover
    read_codex_seat = None

THRESHOLDS = (50, 80, 95)
FORECAST_WINDOWS = {"five_hour": 3600, "weekly": 6 * 3600}   # how far back the burn rate looks


class UsageHistory:
    """Usage readings over time, so the office can say whether a seat lasts until its reset."""

    def __init__(self):
        self.path = config.STATE_DIR / "usage-history.json"
        try:
            self.data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            self.data = {}
        self._saved = time.time()

    def record(self, seat_id: str, usage: dict | None, now: float) -> None:
        if not usage or not usage.get("fetched_at"):
            return
        rows = self.data.setdefault(seat_id, [])
        if rows and rows[-1][0] >= usage["fetched_at"]:
            return
        p5 = (usage.get("five_hour") or {}).get("pct")
        pw = (usage.get("weekly") or {}).get("pct")
        rows.append([usage["fetched_at"], p5, pw])
        cut = now - 8 * 3600
        self.data[seat_id] = [r for r in rows if r[0] >= cut][-500:]
        if now - self._saved > 300:
            try:
                self.path.write_text(json.dumps(self.data))
                self._saved = now
            except OSError:
                pass

    def forecast(self, seat_id: str, usage: dict | None, now: float) -> dict:
        out = {}
        rows = self.data.get(seat_id) or []
        for i, key in enumerate(("five_hour", "weekly"), start=1):
            w = (usage or {}).get(key) or {}
            pct, resets = w.get("pct"), w.get("resets_at")
            pts = [(r[0], r[i]) for r in rows if r[i] is not None and r[0] >= now - FORECAST_WINDOWS[key]]
            # Only the readings since the last reset count: a drop means the window started again.
            for j in range(len(pts) - 1, 0, -1):
                if pts[j][1] < pts[j - 1][1] - 2:
                    pts = pts[j:]
                    break
            if pct is None or len(pts) < 2 or pts[-1][0] - pts[0][0] < 480:
                out[key] = {"state": "learning"}
                continue
            rate = (pts[-1][1] - pts[0][1]) / (pts[-1][0] - pts[0][0])   # % per second
            if rate <= 0:
                out[key] = {"state": "flat", "per_hour": 0.0}
                continue
            eta = now + (100 - pct) / rate
            state = "runs_out" if (resets and eta < resets) or (not resets) else "lasts"
            out[key] = {"state": state, "per_hour": round(rate * 3600, 1), "out_at": eta,
                        "margin_s": (resets - eta) if resets else None}
        return out


def list_units(patterns: list[str]) -> list[dict]:
    try:
        r = subprocess.run(["systemctl", "--user", "list-units", "--type=service", "--all", "--output=json",
                            "--no-pager"], capture_output=True, text=True, timeout=8)
        units = json.loads(r.stdout or "[]")
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    out = []
    for u in units:
        name = u.get("unit", "")
        if not any(fnmatch.fnmatch(name, p) for p in patterns):
            continue
        if u.get("load") == "not-found":
            continue
        out.append({"unit": name, "active": u.get("active"), "sub": u.get("sub"),
                    "description": u.get("description") or name})
    out.sort(key=lambda u: (u["active"] != "active", u["unit"]))
    return out


def programme_for(cfg: dict, *texts: str | None) -> dict | None:
    blob = " ".join(t for t in texts if t)
    for rule in cfg.get("programmes") or []:
        m = rule.get("match")
        if m and m.lower() in blob.lower():
            return {"name": rule.get("name", m), "url": rule.get("url"), "key": m}
    for t in texts:  # fall back to the unit prefix: "apollo-lane-l12-..." -> "apollo"
        if t and "-lane-" in t:
            key = t.split("-lane-")[0]
            return {"name": key, "url": None, "key": key}
    return None


def _codex_seat(meta: dict, now: float) -> dict:
    data = {}
    if read_codex_seat:
        try:
            data = read_codex_seat(home=str(config.HOME), now=now) or {}
        except Exception as e:  # a format change in ~/.codex must not take the office down
            data = {"error": f"{type(e).__name__}: {e}"}
    usage = data.get("usage")
    view = None
    if usage:
        view = {"fetched_at": usage.get("observed_at"), "error": None, "scoped": [], "stale": False,
                "five_hour": usage.get("five_hour") and {"pct": usage["five_hour"]["pct"],
                                                         "resets_at": usage["five_hour"].get("resets_at")},
                "weekly": usage.get("weekly") and {"pct": usage["weekly"]["pct"],
                                                   "resets_at": usage["weekly"].get("resets_at")},
                "observed": True}
        for key in ("five_hour", "weekly"):
            w = view.get(key)
            if w and w.get("resets_at") and w["resets_at"] < now:
                view[key] = {"pct": 0.0, "resets_at": None, "reset_since_read": True}
    # The gpt wrapper around Codex when it is installed (as lanes.py finds it), otherwise the Codex CLI itself.
    wrapper = shutil.which("gpt") or (config.HOME / ".local" / "bin" / "gpt").exists()
    sess = []
    for s in data.get("sessions") or []:
        if not s.get("live") and (now - (s.get("updated_at") or 0)) > 3 * 3600:
            continue
        state = {"working": "working", "idle": "idle", "done": "done"}.get(s.get("state"), "idle")
        sess.append({
            "id": s.get("id"), "seat": meta["id"], "pid": s.get("pid"), "kind": "lane",
            "name": Path(s.get("cwd") or "codex").name or "codex", "unit": s.get("unit"), "terminal": None,
            "cwd": s.get("cwd"), "started_at": s.get("started_at"), "updated_at": s.get("updated_at"),
            "quiet_s": round(now - s["updated_at"]) if s.get("updated_at") else None,
            "state": state, "live": bool(s.get("live")), "activity": sessions.redact(s.get("activity")) or "Thinking",
            "activity_kind": "type" if (s.get("activity") or "").startswith(("Running", "Editing")) else "think",
            "title": None, "task": sessions.redact(s.get("task")), "last_text": sessions.redact(s.get("last_message")),
            "model": s.get("model"),
            "tool_calls": None, "recent": [], "tokens_total": (s.get("tokens") or {}).get("total"),
            "state_file": None, "report_file": None, "report_status": None, "transcript": s.get("rollout"),
            "resume_cmd": (f"gpt -R {s.get('id')} \"...\"" if wrapper else f"codex resume {s.get('id')}") if s.get("id") else None,
        })
    return dict(meta, start_cmd='gpt -w -C "$PWD" "your task"' if wrapper else 'codex -C "$PWD"',
                account={"name": "ChatGPT plan", "email": None, "org": None, "role": None},
                health={"state": "ok" if data.get("available", True) else "login",
                        "detail": data.get("error") or "Codex CLI", "tier": data.get("model") or meta.get("model"),
                        "subscription": "chatgpt"},
                usage=view, model=data.get("model"), sessions=sess)


def quick_seats(now: float | None = None) -> list[dict]:
    """Seats with health, cached usage and running lane counts: enough for the divider."""
    now = now or time.time()
    cfg = config.load_config()
    claude = config.discover_claude_seats(cfg)
    raw_usage = {}
    try:
        raw_usage = json.loads((config.STATE_DIR / "usage-cache.json").read_text())
    except (OSError, ValueError):
        pass
    if any(now - (raw_usage.get(s["id"]) or {}).get("fetched_at", 0) > 600 for s in claude):
        # Nobody (no running office) has looked lately: read the plans now so the pick is not a guess.
        poller = seatmod.UsagePoller(claude)
        poller.tick()
        raw_usage = {s["id"]: poller.get(s["id"]) for s in claude}
    cache = sessions.TranscriptCache()
    out = []
    for s in claude:
        live = sessions.list_sessions(s, cache, now)
        out.append(dict(s, health=seatmod.credential_meta(s["config_dir"], now),
                        usage=seatmod.usage_view(raw_usage.get(s["id"]), now),
                        lanes=sum(1 for x in live if x["kind"] == "lane")))
    meta = config.codex_seat_meta(cfg)
    if meta:
        c = _codex_seat(meta, now)
        out.append(dict(c, lanes=sum(1 for x in c["sessions"] if x.get("live"))))
    return out


class Office(LiveOffice):
    def __init__(self, demo: bool = False):
        self.init_live()
        self.demo = demo
        self.announcer = Announcer()
        self._build_lock = threading.RLock()
        self.cfg = config.load_config()
        self.claude_seats = config.discover_claude_seats(self.cfg)
        self.codex_meta = config.codex_seat_meta(self.cfg)
        self.cache = sessions.TranscriptCache()
        self.usage = seatmod.UsagePoller(self.claude_seats, self.cfg.get("usage_poll_seconds", 150))
        self.history = UsageHistory()
        self.events: deque = deque(maxlen=400)
        self._events_path = config.STATE_DIR / "events.jsonl"
        self._load_events()
        self.samples = HistoryStore(config.STATE_DIR / "history.jsonl", self._events_path,
                                    lanes_path=config.DATA_DIR / "lanes", ledger=DayLedger(config.STATE_DIR / "days.json"))
        self._ledger_at = 0.0
        self.career = Career(config.STATE_DIR / "career.json")
        self.tokens = TokenLedger(config.STATE_DIR / "tokens.json", [], config.HOME / ".codex" / "sessions")
        self.snapshot: dict = {}
        self._prev: dict | None = None
        self._reported: set[str] = set()
        self._units: list[dict] = []
        self._units_at = 0.0
        self._codex: dict | None = None
        self._codex_at = 0.0
        self.stop = threading.Event()

    # -- events --------------------------------------------------------------------------------------------
    def _load_events(self) -> None:
        try:
            lines = self._events_path.read_text().splitlines()[-400:]
            for l in lines:
                self.events.append(json.loads(l))
        except (OSError, ValueError):
            pass

    def emit(self, kind: str, text: str, seat: str | None = None, level: str = "info", ts: float | None = None):
        ev = public({"ts": time.time() if ts is None else ts, "kind": kind, "text": text, "seat": seat, "level": level})
        with self.condition:
            self.events.append(ev)
            self.notify_news(ev)
        self.announcer.announce(ev, self.cfg, demo=self.demo)
        try:
            config.STATE_DIR.mkdir(parents=True, exist_ok=True)
            with open(self._events_path, "a") as f:
                f.write(json.dumps(ev) + "\n")
            if self._events_path.stat().st_size > 2_000_000:
                keep = self._events_path.read_text().splitlines()[-1000:]
                self._events_path.write_text("\n".join(keep) + "\n")
        except OSError:
            pass

    def _diff(self, prev: dict, cur: dict) -> None:
        pseats = {s["id"]: s for s in prev.get("seats", [])}
        for s in cur["seats"]:
            p = pseats.get(s["id"])
            if not p:
                continue
            psess = {x["id"]: x for x in p["sessions"] if x.get("live", True)}
            csess = {x["id"]: x for x in s["sessions"] if x.get("live", True)}
            for sid, x in csess.items():
                if sid not in psess:
                    what = "lane" if x["kind"] == "lane" else "session"
                    self.emit("arrive", f"{x['name']} sat down at {s['label']} ({what})", s["id"])
                else:
                    was = psess[sid]["state"]
                    if x["state"] == "limited" and was != "limited":
                        self.emit("limit", f"{x['name']} on {s['label']} hit the usage limit", s["id"], "warn")
                    if x["state"] == "stuck" and was != "stuck":
                        self.emit("stuck", f"{x['name']} on {s['label']} has been quiet for 15+ minutes", s["id"], "warn")
                    if x.get("report_status") and not psess[sid].get("report_status") and sid not in self._reported:
                        self._reported.add(sid)
                        lvl = "warn" if "BLOCKED" in x["report_status"].upper() else "good"
                        self.emit("report", f"{x['name']} filed its report: {x['report_status']}", s["id"], lvl)
            for sid, x in psess.items():
                if sid not in csess:
                    self.emit("leave", f"{x['name']} left {s['label']}", s["id"])
            for key, label in (("five_hour", "5-hour window"), ("weekly", "weekly allowance")):
                a = ((p.get("usage") or {}).get(key) or {}).get("pct")
                b = ((s.get("usage") or {}).get(key) or {}).get("pct")
                if a is None or b is None:
                    continue
                for t in THRESHOLDS:
                    if a < t <= b:
                        self.emit("usage", f"{s['label']} passed {t}% of its {label}", s["id"],
                                  "bad" if t >= 95 else "warn" if t >= 80 else "info")
                if a - b >= 25:
                    self.emit("reset", f"{s['label']} {label} reset: back to {b:.0f}%", s["id"], "good")
            ph, ch = (p.get("health") or {}).get("state"), (s.get("health") or {}).get("state")
            if ph and ch and ph != ch and ch == "login":
                self.emit("login", f"{s['label']} needs /login", s["id"], "bad")
        plane = {l["id"]: l for l in prev.get("lanes", [])}
        for l in cur.get("lanes", []):
            was = plane.get(l["id"])
            if was and was.get("status") != l.get("status"):
                lvl = {"done": "good", "blocked": "warn", "failed": "bad", "waiting": "warn"}.get(l["status"], "info")
                seat = f" on {l['seat']}" if l.get("seat") and l["status"] == "running" else ""
                self.emit("lane", f"Office lane '{l['title']}' is {l['status']}{seat}", l.get("seat"), lvl)

    # -- build ---------------------------------------------------------------------------------------------
    def build(self) -> dict:
        with self._build_lock:
            return self._build()

    def _build(self) -> dict:
        now = time.time()
        cfg = self.cfg = config.load_config()
        self.claude_seats = config.discover_claude_seats(cfg)
        self.usage.seats = self.claude_seats
        self.tokens.claude_dirs = [(s["id"], Path(s["config_dir"])) for s in self.claude_seats]
        meta = config.codex_seat_meta(cfg)
        if meta != self.codex_meta:
            self._codex = None
        self.codex_meta = meta
        div_ids = [s["id"] for s in self.claude_seats] + ([self.codex_meta["id"]] if self.codex_meta else [])
        div = divider.load(div_ids)
        seats_out = []
        keep = set()
        for s in self.claude_seats:
            try:
                live = sessions.list_sessions(s, self.cache, now)
            except Exception as e:  # one unreadable seat must not freeze the whole office
                live = []
                self.emit("error", f"Could not read {s['label']}: {type(e).__name__}", s["id"], "bad")
            keep.update(x["transcript"] for x in live if x.get("transcript"))
            health = seatmod.credential_meta(s["config_dir"], now)
            seats_out.append(dict(s, account=seatmod.account_meta(s["account_file"]), health=health,
                                  usage=seatmod.usage_view(self.usage.get(s["id"]), now), sessions=live))
        self.cache.forget_except(keep)
        if self.codex_meta:
            if now - self._codex_at > 8 or self._codex is None:
                self._codex = _codex_seat(self.codex_meta, now)
                self._codex_at = now
            seats_out.append(self._codex)
        limits = lanes.read_limits()
        for s in seats_out:
            self.history.record(s["id"], s.get("usage"), now)
            s["forecast"] = self.history.forecast(s["id"], s.get("usage"), now)
            live = [x for x in s["sessions"] if x.get("live", True)]
            sc = div["seats"].get(s["id"], divider.DEFAULT_SEAT)
            s["lanes"] = sum(1 for x in live if x["kind"] == "lane")
            s["desks"] = sum(1 for x in live if x["kind"] == "desk")
            s["divider"] = sc
            s["resting_until"] = limits.get(s["id"])
            t1 = sum((x.get("tokens_1h") or {}).get("fresh", 0) for x in live)
            s["tokens_1h"] = t1
            s["tokens_1h_all"] = t1 + sum((x.get("tokens_1h") or {}).get("cached", 0) for x in live)   # the live burn meter
            s["status"] = self._seat_status(s, sc, live)
            # A pace measured while lanes ran says nothing once the seat stops working: don't raise an alarm on it.
            for fc in (s.get("forecast") or {}).values():
                if fc.get("state") == "runs_out" and s["status"] != "working":
                    fc["state"] = "paused"
            for x in s["sessions"]:
                prog = programme_for(cfg, x.get("unit"), x.get("name"), x.get("cwd"), x.get("task"))
                x["programme"] = prog
        if now - self._units_at > 10:
            self._units = list_units(cfg.get("watch_units") or [])
            self._units_at = now
        lane_list = lanes.list_lanes()
        from . import messaging
        direct = {l.get("pid") for l in lane_list if l.get("allow_messages") is True and l.get("pid")}
        by_pid = {l["pid"]: l for l in lane_list if l.get("pid") and l.get("status") == "running"}
        for s in seats_out:
            for x in s["sessions"]:
                lane = by_pid.get(x.get("pid")) if x.get("live", True) else None
                if lane:
                    # An office lane goes by the title the CEO gave it, not the folder-derived session name.
                    x["lane_id"], x["session_name"], x["name"] = lane["id"], x.get("name"), lane.get("title") or x.get("name")
                if s.get("kind") == "codex":
                    x["talk"] = "none"
                elif not x.get("live", True):
                    x["talk"] = "followup"
                elif messaging.valid_target(x.get("socket")):
                    x["talk"] = "direct" if x.get("pid") in direct else "review"
                else:
                    x["talk"] = "later"   # running without a message socket: follow up once it finishes
        evaluation = divider.evaluate(seats_out, div, limited_until=limits, now=now)
        programmes = {}
        for s in seats_out:
            for x in s["sessions"]:
                p = x.get("programme")
                if not p or not x.get("live", True):
                    continue
                g = programmes.setdefault(p["key"], {"name": p["name"], "url": p.get("url"), "sessions": []})
                g["sessions"].append({"name": x["name"], "seat": s["id"], "state": x["state"],
                                      "report_status": x.get("report_status")})
        snap = {
            "now": now,
            "office": {"started_at": self.started_at, "version": "3.27.0", "name": cfg.get("office_name"), "ceo": cfg.get("ceo"), "config_error": cfg.get("config_error"),
                       "default_workdir": cfg.get("default_workdir"),
                       "lane_defaults": {k: cfg["lane_defaults"].get(k) for k in ("model", "permission_mode")}},
            "seats": seats_out,
            "units": self._units,
            "lanes": lane_list,
            "programmes": list(programmes.values()),
            "divider": div,
            "next_pick": {"seat": evaluation["pick"], "why": evaluation["why"], "ranking": evaluation["ranking"]},
            "suggested_weights": divider.suggest(seats_out, div),
        }
        snap["attention"] = self._attention(snap)
        snap["totals"] = self._totals(snap)
        for seat_id, kind, text in self.career.observe(snap):
            self.emit(kind, text, seat_id, "good")
        for s in snap["seats"]:
            s["career"] = self.career.view(s["id"])
        snap["achievements"] = CATALOGUE
        if self._prev:
            self._diff(self._prev, snap)
        self._prev = snap
        self._reported.update(x["id"] for s in snap["seats"] for x in s["sessions"] if x.get("report_status"))
        with self._lock:
            snap["events"] = list(self.events)[-60:]
            snap = self.publish(snap)
        self.samples.record(snap)
        if snap["now"] - self._ledger_at >= 300:      # keep today's line in the day ledger fresh, browser open or not
            self._ledger_at = snap["now"]
            try:
                self.samples.stats(snap, None, list(self.events))
            except Exception:                         # the ledger is a nicety; never let it stop the office
                pass
        return snap

    @staticmethod
    def _seat_status(s: dict, sc: dict, live: list[dict]) -> str:
        h = (s.get("health") or {}).get("state")
        if h == "login":
            return "offline"
        u = s.get("usage") or {}
        if any((u.get(k) or {}).get("pct", 0) >= 100 for k in ("five_hour", "weekly")) or \
                (s.get("resting_until") or 0) > time.time() or any(x["state"] == "limited" for x in live):
            return "limited"
        if not sc.get("enabled", True):
            return "benched"
        if any(x["state"] in ("working", "waiting") for x in live):
            return "working"
        return "idle"

    @staticmethod
    def _attention(snap: dict) -> list[dict]:
        items = []
        for s in snap["seats"]:
            label = s["label"]
            if (s.get("health") or {}).get("state") == "login":
                items.append({"level": "bad", "seat": s["id"], "text": f"{label} is logged out: run /login on it"})
            else:                                     # a login that lapses soon: warn three days ahead, urgently at 12 h
                rexp = (s.get("health") or {}).get("refresh_expires_at")
                left = (rexp - snap["now"]) if rexp else None
                if left is not None and 0 < left < 3 * 86400:
                    when = f"{left / 3600:.0f} hours" if left < 2 * 86400 else f"{left / 86400:.0f} days"
                    items.append({"level": "bad" if left < 12 * 3600 else "warn", "seat": s["id"],
                                  "text": f"{label}'s login lapses in {when}: run /login on it", "resets_at": rexp})
            u = s.get("usage") or {}
            for key, name in (("five_hour", "5-hour"), ("weekly", "weekly")):
                w = u.get(key) or {}
                if w.get("pct", 0) >= 90:
                    items.append({"level": "bad" if w["pct"] >= 100 else "warn", "seat": s["id"],
                                  "text": f"{label} {name} usage at {w['pct']:.0f}%", "resets_at": w.get("resets_at")})
            fc = (s.get("forecast") or {}).get("five_hour") or {}
            if fc.get("state") == "runs_out" and s["status"] not in ("limited", "offline", "benched") \
                    and fc["out_at"] - snap["now"] < 3600:
                left = max(0, round((fc["out_at"] - snap["now"]) / 60))
                items.append({"level": "warn", "seat": s["id"],
                              "text": f"{label} runs out of its 5-hour window in ~{left} min at this pace",
                              "resets_at": (u.get("five_hour") or {}).get("resets_at")})
            if s["status"] == "benched" and any(x["kind"] == "lane" for x in s["sessions"] if x.get("live", True)):
                items.append({"level": "warn", "seat": s["id"],
                              "text": f"{label} is benched but still runs {s['lanes']} lane(s)"})
            for x in s["sessions"]:
                if x["state"] == "stuck":
                    items.append({"level": "warn", "seat": s["id"], "session": x["id"],
                                  "text": f"{x['name']} on {label} quiet for {x['quiet_s'] // 60} min"})
                if x["state"] == "limited":
                    items.append({"level": "warn", "seat": s["id"], "session": x["id"],
                                  "text": f"{x['name']} on {label} is stopped by the usage limit"})
                rs = x.get("report_status") or ""
                if "BLOCKED" in rs.upper() and x.get("live", True):
                    items.append({"level": "warn", "seat": s["id"], "session": x["id"],
                                  "text": f"{x['name']} is blocked: {rs[:120]}"})
        for l in snap["lanes"]:
            if l.get("status") in ("failed", "blocked"):
                items.append({"level": "bad" if l["status"] == "failed" else "warn", "lane": l["id"],
                              "text": f"Office lane '{l['title']}' {l['status']}"})
            if l.get("status") == "waiting":
                items.append({"level": "warn", "lane": l["id"],
                              "text": f"Office lane '{l['title']}' is waiting for a seat"})
        for u in snap["units"]:
            if u["active"] == "failed":
                items.append({"level": "bad", "unit": u["unit"], "text": f"Service {u['unit']} failed"})
        return items

    @staticmethod
    def _totals(snap: dict) -> dict:
        live = [x for s in snap["seats"] for x in s["sessions"] if x.get("live", True)]
        claude = [s for s in snap["seats"] if s["kind"] == "claude"]

        def left(key):
            vals = [100 - ((s.get("usage") or {}).get(key) or {}).get("pct", 100) for s in claude
                    if (s.get("health") or {}).get("state") != "login" and s["divider"].get("enabled", True)]
            return round(sum(max(0, v) for v in vals) / 100, 2)

        return {
            "seats": len(snap["seats"]),
            "sessions": len(live),
            "working": sum(1 for x in live if x["state"] in ("working", "waiting")),
            "lanes": sum(1 for x in live if x["kind"] == "lane"),
            "tokens_1h": sum(s.get("tokens_1h") or 0 for s in snap["seats"]),
            "five_hour_left_seats": left("five_hour"),
            "weekly_left_seats": left("weekly"),
        }

    def run(self) -> None:
        threading.Thread(target=self.usage.run, args=(self.stop,), daemon=True, name="usage").start()
        threading.Thread(target=self._tokens_run, daemon=True, name="tokens").start()
        while not self.stop.is_set():
            try:
                self.build()
            except Exception as e:  # keep serving the last good picture
                self.emit("error", f"Snapshot failed: {type(e).__name__}: {e}", level="bad")
            self.stop.wait(4)

    def _tokens_run(self) -> None:
        """The token ledger: a first full read once the seats are known, then what was appended, every minute. PRs
        opened or merged since the last read become office news."""
        self.stop.wait(3)
        while not self.stop.is_set():
            snap = self.get() or {}
            live = {x["id"]: s["id"] for s in snap.get("seats", []) if s.get("kind") == "claude" for x in s.get("sessions", []) if x.get("id")}
            try:
                self.tokens.scan(live)
                for e in self.tokens.take_events():
                    rec = self.tokens.data["sessions"].get(e["session"]) or {}
                    seat = rec.get("s") if rec.get("s") in {s["id"] for s in snap.get("seats", [])} else None
                    what = f"PR #{e['pr']}" if e.get("pr") else "a PR"
                    self.emit("shipped", f"{rec.get('p') or 'A session'}: {what} {'merged' if e['kind'] == 'pr_merged' else 'opened'}", seat, "good")
            except Exception:                         # the ledger is a nicety; never let it stop the office
                pass
            self.stop.wait(60)

    def tokens_view(self, rng: str = "all", seat: str | None = None, all_sessions: bool = False) -> dict:
        snap = self.get() or {}
        return self.tokens.view(snap.get("seats", []), rng=rng, seat=seat, all_sessions=all_sessions)

    def get(self) -> dict:
        with self._lock:
            return self.snapshot

    def find_session(self, seat_id: str, session_id: str) -> dict | None:
        for s in self.get().get("seats", []):
            if s["id"] == seat_id:
                for x in s["sessions"]:
                    if x["id"] == session_id:
                        return x
        return None

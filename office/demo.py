"""A made-up office for screenshots and for trying the UI without touching real seats.

``python3 -m office serve --demo``: nothing here reads your accounts, and every write is a no-op.
"""
from __future__ import annotations

import threading
import time
from collections import deque

from . import config, divider
from .snapshot import Office

ACTIVITY = {
    "orchestrator": [("Reading lane reports", "read"), ("Writing: L12 is green, merging it now", "talk"),
                     ("Merge PR #482", "type"), ("Updating Mission Control", "type"), ("Thinking", "think")],
    "rate": [("Editing limiter.py", "type"), ("Run unit tests", "wait"), ("Searching retry_after", "read"),
             ("Editing test_limiter.py", "type")],
    "billing": [("Reading invoices.sql", "read"), ("Delegating: backfill dry run", "delegate"),
                ("Editing migrate_0142.py", "type"), ("Run migration dry run", "wait")],
    "docs": [("Editing getting-started.md", "type"), ("Running: npm run build", "type"), ("Thinking", "think")],
}


def _sess(seat, sid, name, kind, state, act_key, now, start_ago, title=None, task=None, unit=None, report=None,
          cwd="/home/you/work/apollo", tokens=0):
    acts = ACTIVITY.get(act_key) or [("At the desk", "think")]
    step = int(now // 9) % len(acts)
    act, kind_ = acts[step]
    recent = [{"ts": now - 40 * i, "text": acts[(step - i) % len(acts)][0], "kind": acts[(step - i) % len(acts)][1]}
              for i in range(5, -1, -1)]
    return {
        "id": sid, "seat": seat, "pid": 40000 + hash(sid) % 9000, "name": name, "kind": kind, "unit": unit,
        "terminal": None if unit else "app-terminal.scope", "cwd": cwd, "started_at": now - start_ago,
        "updated_at": now - 5, "quiet_s": 5 if state == "working" else 900 if state == "stuck" else 60,
        "raw_status": "busy", "state": state, "activity": act if state not in ("limited", "idle") else
        ("Hit the usage limit" if state == "limited" else "At the desk"),
        "activity_kind": kind_, "title": title, "task": task or title, "last_prompt": None,
        "last_text": "Tests pass locally; pushing the branch and opening the PR next.",
        "limit_text": "You've hit your session limit · resets 9:40pm (Asia/Kolkata)" if state == "limited" else None,
        "model": "claude-opus-5-5", "tool_calls": 40 + hash(sid) % 160, "recent": recent,
        "tokens_1h": {"fresh": tokens, "cached": tokens * 30, "turns": tokens // 4000},
        "tokens_5h": {"fresh": tokens * 3, "cached": tokens * 90, "turns": tokens // 1300},
        "cpu_s": 312.0, "state_file": "/home/you/work/handover/L12-STATE.md" if kind == "lane" else None,
        "report_file": None, "report_status": report, "transcript": None,
        "resume_cmd": f"CLAUDE_CONFIG_DIR=~/.{seat} claude --resume {sid}", "live": True,
    }


class _NoPoll:
    def poke(self, seat=None):
        pass

    def run(self, stop):
        pass


class DemoOffice:
    def __init__(self):
        self.cfg = dict(config.DEFAULTS, office_name="Claude Office", ceo={"name": "Alex", "title": "CEO"},
                        default_workdir="/home/you/work")
        self.usage = _NoPoll()
        self.events: deque = deque(maxlen=200)
        self.stop = threading.Event()
        self.snapshot = {}
        t = time.time()
        for i, (txt, lvl, seat) in enumerate([
            ("billing-migration sat down at claude2 (lane)", "info", "claude2"),
            ("claude3 passed 95% of its 5-hour window", "bad", "claude3"),
            ("checkout-tests on claude3 hit the usage limit", "warn", "claude3"),
            ("Office lane 'Refresh the API docs' is running on astra", "info", "astra"),
            ("L11 filed its report: STATUS: READY #477", "good", "claude2"),
            ("CEO updated the load divider: claude benched, claude2 35, claude3 30, claude4 20, astra 15", "info", None),
        ]):
            self.events.append({"ts": t - 600 + i * 90, "kind": "demo", "text": txt, "seat": seat, "level": lvl})

    def emit(self, kind, text, seat=None, level="info", ts=None):
        self.events.append({"ts": ts or time.time(), "kind": kind, "text": text, "seat": seat, "level": level})

    def build(self):
        now = time.time()
        div = divider.validate({"mode": "headroom", "global_max_lanes": 6, "five_hour_guard": 90, "weekly_guard": 90,
                                "seats": {"claude": {"enabled": False, "weight": 0, "max_lanes": 1,
                                                     "note": "Weekly is tight: keep it for interactive work"},
                                          "claude2": {"weight": 35, "max_lanes": 3}, "claude3": {"weight": 30, "max_lanes": 2},
                                          "claude4": {"weight": 20, "max_lanes": 2}, "astra": {"weight": 15, "max_lanes": 1}}},
                               ["claude", "claude2", "claude3", "claude4", "astra"])
        div["updated_at"] = now - 3600

        def usage(p5, pw, r5, rw):
            return {"five_hour": {"pct": p5, "resets_at": now + r5}, "weekly": {"pct": pw, "resets_at": now + rw},
                    "fetched_at": now - 40, "stale": False, "error": None, "scoped": []}

        seats = [
            dict(id="claude", kind="claude", label="claude", nickname="Main", color="#d97757", config_dir="~/.claude",
                 account={"name": "Alex", "email": "alex@example.com", "org": "Acme", "role": "owner"},
                 health={"state": "ok", "detail": "Logged in", "tier": "Max 5x", "subscription": "team"},
                 usage=usage(12, 71, 4 * 3600, 2.5 * 86400),
                 sessions=[_sess("claude", "d-main-1", "ops-desk", "desk", "idle", None, now, 7200,
                                 title="Quarterly planning notes")]),
            dict(id="claude2", kind="claude", label="claude2", nickname="Atlas", color="#5b8def", config_dir="~/.claude2",
                 account={"name": "Seat Two", "email": "seat2@example.com", "org": "Acme", "role": "member"},
                 health={"state": "ok", "detail": "Logged in", "tier": "Max 5x", "subscription": "team"},
                 usage=usage(64, 48, 2.1 * 3600, 3 * 86400),
                 sessions=[_sess("claude2", "d-orch", "apollo-orchestrator", "desk", "working", "orchestrator", now, 14000,
                                 title="Apollo launch orchestration", tokens=180000),
                           _sess("claude2", "l-rate", "api-rate-limits", "lane", "working", "rate", now, 3100,
                                 title="Rate limiter rewrite", unit="apollo-lane-l12.service", tokens=320000),
                           _sess("claude2", "l-bill", "billing-migration", "lane", "waiting", "billing", now, 2400,
                                 title="Billing tables migration", unit="billing-lane-b3.service",
                                 cwd="/home/you/work/billing", tokens=210000)]),
            dict(id="claude3", kind="claude", label="claude3", nickname="Vega", color="#3fb68b", config_dir="~/.claude3",
                 account={"name": "Seat Three", "email": "seat3@example.com", "org": "Acme", "role": "member"},
                 health={"state": "ok", "detail": "Logged in", "tier": "Max 5x", "subscription": "team"},
                 usage=usage(100, 62, 38 * 60, 4 * 86400),
                 sessions=[_sess("claude3", "l-check", "checkout-tests", "lane", "limited", "rate", now, 5000,
                                 title="Checkout flaky tests", unit="apollo-lane-l13.service"),
                           _sess("claude3", "l-search", "search-index", "lane", "limited", "billing", now, 6100,
                                 title="Search index rebuild", unit="apollo-lane-l14.service")]),
            dict(id="claude4", kind="claude", label="claude4", nickname="Orion", color="#c678dd", config_dir="~/.claude4",
                 account={"name": "Seat Four", "email": "seat4@example.com", "org": "Acme", "role": "member"},
                 health={"state": "stale", "detail": "Login refreshes on the next run", "tier": "Max 5x", "subscription": "team"},
                 usage=usage(3, 22, 5 * 3600, 5 * 86400), sessions=[]),
            dict(id="astra", kind="codex", label="Astra", nickname="Codex", color="#10a37f", config_dir="~/.codex",
                 account={"name": "ChatGPT plan"}, health={"state": "ok", "detail": "Codex CLI", "tier": "gpt"},
                 usage=usage(18, 30, 3 * 3600, 6 * 86400),
                 sessions=[_sess("astra", "c-docs", "docs-refresh", "lane", "working", "docs", now, 1500,
                                 title="Refresh the API docs", cwd="/home/you/work/docs", tokens=90000)]),
        ]
        for s in seats:
            sc = div["seats"][s["id"]]
            s["divider"] = sc
            s["lanes"] = sum(1 for x in s["sessions"] if x["kind"] == "lane")
            s["desks"] = sum(1 for x in s["sessions"] if x["kind"] == "desk")
            s["resting_until"] = None
            s["tokens_1h"] = sum(x["tokens_1h"]["fresh"] for x in s["sessions"])
            s["status"] = Office._seat_status(s, sc, s["sessions"])
            for x in s["sessions"]:
                x["programme"] = ({"name": "Apollo launch", "url": "https://example.com/mission-control", "key": "apollo"}
                                  if "apollo" in (x.get("unit") or "") or x["name"].startswith("apollo") or "work/apollo" in x["cwd"]
                                  else {"name": "Billing revamp", "url": None, "key": "billing"} if "billing" in x["cwd"] else None)
        ev = divider.evaluate(seats, div, now=now)
        progs = {}
        for s in seats:
            for x in s["sessions"]:
                p = x.get("programme")
                if p:
                    g = progs.setdefault(p["key"], {"name": p["name"], "url": p["url"], "sessions": []})
                    g["sessions"].append({"name": x["name"], "seat": s["id"], "state": x["state"], "report_status": x["report_status"]})
        lanes = [
            {"id": "1016-140212-refresh-the-api-docs", "title": "Refresh the API docs", "workdir": "/home/you/work/docs",
             "seat_pref": "auto", "model": "opus", "permission_mode": "acceptEdits", "created_at": now - 1600,
             "status": "running", "seat": "astra", "runs": [{"seat": "astra", "started_at": now - 1500}],
             "unit": "office-lane-1016-140212-refresh-the-api-docs", "report_status": None,
             "state_tail": "14:05 read the OpenAPI spec\n14:18 regenerated 12 pages", "unit_active": True},
            {"id": "1016-101500-weekly-dependency-bump", "title": "Weekly dependency bump", "workdir": "/home/you/work/apollo",
             "seat_pref": "auto", "model": "sonnet", "permission_mode": "acceptEdits", "created_at": now - 14000,
             "status": "done", "seat": "claude4", "runs": [{"seat": "claude3", "started_at": now - 13900, "rc": 1, "ended_by": "limit"},
                                                          {"seat": "claude4", "started_at": now - 12000, "rc": 0}],
             "unit": "office-lane-1016-101500-weekly-dependency-bump", "report_status": "STATUS: DONE - 14 packages bumped, PR #480",
             "state_tail": None, "unit_active": False},
        ]
        units = [
            {"unit": "apollo-conductor.service", "active": "active", "sub": "running", "description": "Apollo conductor (lanes, integrator)"},
            {"unit": "apollo-lane-l12.service", "active": "active", "sub": "running", "description": "Apollo lane L12"},
            {"unit": "apollo-lane-l13.service", "active": "active", "sub": "running", "description": "Apollo lane L13"},
            {"unit": "apollo-lane-l14.service", "active": "active", "sub": "running", "description": "Apollo lane L14"},
            {"unit": "billing-lane-b3.service", "active": "active", "sub": "running", "description": "Billing lane B3"},
            {"unit": "lane-supervisor.service", "active": "active", "sub": "running", "description": "Relaunches lanes after a limit"},
            {"unit": "nightly-report.service", "active": "failed", "sub": "failed", "description": "Nightly usage report"},
        ]
        snap = {"now": now, "office": {"name": self.cfg["office_name"], "ceo": self.cfg["ceo"], "config_error": None,
                                       "default_workdir": "/home/you/work",
                                       "lane_defaults": {"model": "opus", "permission_mode": "acceptEdits"}},
                "seats": seats, "units": units, "lanes": lanes, "programmes": list(progs.values()), "divider": div,
                "next_pick": {"seat": ev["pick"], "why": ev["why"], "ranking": ev["ranking"]},
                "suggested_weights": divider.suggest(seats, div)}
        snap["attention"] = Office._attention(snap)
        snap["totals"] = Office._totals(snap)
        snap["events"] = list(self.events)[-60:]
        self.snapshot = snap
        return snap

    def run(self):
        while not self.stop.is_set():
            self.build()
            self.stop.wait(3)

    def get(self):
        return self.snapshot

    def find_session(self, seat_id, session_id):
        for s in self.snapshot.get("seats", []):
            for x in s["sessions"]:
                if s["id"] == seat_id and x["id"] == session_id:
                    return x
        return None

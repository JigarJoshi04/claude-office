"""A made-up office for screenshots and for trying the UI without touching real seats.

``python3 -m office serve --demo``: nothing here reads your accounts, and every write is a no-op.
"""
from __future__ import annotations

import threading
from datetime import date, datetime, timedelta
import time
from collections import deque

from . import config, divider
from .career import CATALOGUE, Career, new_seat, xp_for
from .snapshot import Office
from .history import DayLedger, HistoryStore
from . import prices, tokens
from .asks import Asks
from .tokens import TokenLedger
from .live import LiveOffice, public

ACTIVITY = {
    "orchestrator": [("Reading lane reports", "read"), ("Writing: L12 is green, merging it now", "talk"),
                     ("Merge PR #482", "type", "shell"), ("Publishing a page", "type", "publish"), ("Thinking", "think")],
    "rate": [("Editing limiter.py", "type"), ("Run unit tests", "wait", "test"), ("Browsing the web", "read", "web"),
             ("Editing test_limiter.py", "type")],
    "billing": [("Reading invoices.sql", "read"), ("Delegating: backfill dry run", "delegate"),
                ("monday: get board items", "read", "mcp"), ("Run migration dry run", "wait", "shell")],
    "docs": [("Editing getting-started.md", "type"), ("Running: npm run build", "type", "shell"), ("Browsing the web", "read", "web")],
}


def _sess(seat, sid, name, kind, state, act_key, now, start_ago, title=None, task=None, unit=None, report=None,
          cwd="/home/you/work/apollo", tokens=0):
    acts = ACTIVITY.get(act_key) or [("At the desk", "think")]
    step = int(now // 9) % len(acts)
    act, kind_ = acts[step][:2]
    screen = acts[step][2] if len(acts[step]) > 2 and state in ("working", "waiting") else None
    recent = [{"ts": now - 40 * i, "text": acts[(step - i) % len(acts)][0], "kind": acts[(step - i) % len(acts)][1]}
              for i in range(5, -1, -1)]
    return {
        "id": sid, "seat": seat, "pid": 40000 + hash(sid) % 9000, "name": name, "kind": kind, "unit": unit,
        "terminal": None if unit else "app-terminal.scope", "cwd": cwd, "started_at": now - start_ago,
        "git": {"repo": cwd.rstrip("/").rsplit("/", 1)[-1], "branch": "main" if kind == "desk" else f"lane/{name}", "detached": False},
        "updated_at": now - 5, "quiet_s": 5 if state == "working" else 900 if state == "stuck" else 60,
        "raw_status": "busy", "state": state, "activity": act if state not in ("limited", "idle") else
        ("Hit the usage limit" if state == "limited" else "At the desk"),
        "activity_kind": kind_, "screen": screen, "test_ok": ((int(now // 60) % 3) != 0) if act_key == "rate" else None,
        "title": title, "task": task or title, "last_prompt": None,
        "last_text": "Tests pass locally; pushing the branch and opening the PR next.",
        "limit_text": "You've hit your session limit · resets 9:40pm (Asia/Kolkata)" if state == "limited" else None,
        "model": "claude-opus-5-5", "tool_calls": 40 + hash(sid) % 160, "recent": recent,
        "tokens_total": tokens * 3,
        "tokens_1h": {"fresh": tokens, "cached": tokens * 30, "turns": tokens // 4000},
        "tokens_5h": {"fresh": tokens * 3, "cached": tokens * 90, "turns": tokens // 1300},
        "cpu_s": 312.0, "state_file": "/home/you/work/handover/L12-STATE.md" if kind == "lane" else None,
        "report_file": None, "report_status": report, "transcript": None,
        "resume_cmd": f"CLAUDE_CONFIG_DIR=~/.{seat} claude --resume {sid}", "live": True,
        "cache": _demo_cache(sid, state, now),
        "tasks": _demo_tasks(sid, now),
        "ci": DEMO_CI.get(sid),
        "helpers": [{"desc": d, "since": now - 300 - i * 140} for i, d in enumerate(DEMO_HELPERS.get(sid, []))][: 1 + int(now // 40) % 3],
        "helpers_done": int(now // 40) if sid in DEMO_HELPERS else 0,
        "spent": {"tokens": tokens * 40, "output": tokens // 10, "usd": round(tokens * 40 * 0.25 / 1e6 + 0.01 * (hash(sid) % 300), 2)} if tokens else None,
    }


DEMO_HELPERS = {"d-orch": ["Check the overnight lanes' reports", "Read the failing CI logs", "Draft tomorrow's lane briefs"]}


DEMO_CI = {   # the desks' CI lamps: a PR's checks on the branch each lane has out
    "l-rate": {"checks": "pending", "number": 482, "url": "https://github.com/example/apollo/pull/482", "state": "open", "review": "review_required"},
    "l-bill": {"checks": "fail", "number": 479, "url": "https://github.com/example/apollo/pull/479", "state": "open", "review": None},
    "c-docs": {"checks": "pass", "number": 481, "url": "https://github.com/example/apollo/pull/481", "state": "open", "review": "approved"},
}


DEMO_TASKS = {
    "l-rate": ["Read the current limiter", "Write failing tests for bursts", "Switch to a token bucket", "Run the load test", "Open the PR"],
    "d-orch": ["Check the overnight lanes", "Merge the green PRs", "Plan tomorrow's lanes", "Update Mission Control"],
    "c-docs": ["List the stale pages", "Rewrite getting-started", "Check every code sample"],
}


def _demo_tasks(sid, now):
    """A made-up task list that advances a step every two minutes, round and round."""
    names = DEMO_TASKS.get(sid)
    if not names:
        return None
    step = int(now // 120) % (len(names) + 1)
    items = [{"subject": n, "status": "completed" if i < step else "in_progress" if i == step else "pending"} for i, n in enumerate(names)]
    return {"done": step, "total": len(names), "now": names[step] if step < len(names) else None, "items": items}


def _demo_cache(sid, state, now):
    """A made-up prompt cache: warm while working; an idle one cools and warms again every six minutes."""
    context = 180_000 + hash(sid) % 400_000
    until = now + 290 if state == "working" else now - (now % 360) + 300
    p = prices.rates("claude-opus-5-5")
    return {"until": until, "ttl": 300, "context": context, "saves_usd": round(context * (p[1] - p[3]) / 1e6, 2), "window": 1_000_000}


class _NoPoll:
    def poke(self, seat=None):
        pass

    def run(self, stop):
        pass


DEMO_CHAT = [
    ("user", "Rewrite the rate limiter so bursts are smoothed. Keep the public API the same and add tests."),
    ("assistant", "On it. I'll read the current limiter, write failing tests for burst smoothing, then switch to a token bucket."),
    ("step", "Reading limiter.py"), ("step", "Searching retry_after"), ("step", "Editing test_limiter.py"),
    ("step", "Run unit tests"),
    ("assistant", "Three new tests fail as expected. Switching the implementation to a token bucket now."),
    ("step", "Editing limiter.py"), ("step", "Run unit tests"),
    ("peer", "Claude Office (CEO): How close are you? Can you ship before the 5-hour reset?"),
    ("assistant", "Yes. All 41 tests pass locally. I'm opening the PR next and will report back with the link."),
]


def _demo_ledger():
    """Two made-up weeks behind today, so the week chart and earlier days have something to show."""
    led = DayLedger(None)
    today = date.today()
    for i in range(1, 14):
        d = today - timedelta(days=i)
        weekend = d.weekday() >= 5
        k = (i * 37 % 11) / 10
        reports, mins = (2 + int(k * 4)) if weekend else (9 + int(k * 12)), (60 + int(k * 120)) if weekend else (300 + int(k * 420))
        seats = {sid: {"active_min": int(mins * w), "sessions": max(1, int(6 * w)), "lanes": int(3 * w), "reports": int(reports * w),
                       "limits": 1 if (sid == "claude3" and i % 3 == 0) else 0, "tokens_fresh": int(mins * w * 9000),
                       "tool_calls": int(mins * w * 5.5), "peak_p5": 60.0,
                       "limited_min": {"claude3": 95, "claude2": 40}.get(sid, 0) if i % 3 == 0 else (25 if sid == "claude3" and not weekend else 0)}
                 for sid, w in (("claude", 0.1), ("claude2", 0.35), ("claude3", 0.25), ("claude4", 0.2), ("astra", 0.1))}
        led.note({"day": d.isoformat(), "seats": seats, "mvp": {"seat": "claude2" if i % 2 else "claude3", "why": "the most XP"},
                  "office": {"sessions": sum(s["sessions"] for s in seats.values()), "reports": sum(s["reports"] for s in seats.values()),
                             "limits": sum(s["limits"] for s in seats.values()), "lanes_hired": 2 + i % 3, "busiest_seat": "claude2",
                             "all_out_min": 20 if i % 6 == 0 else 0,
                             "longest_session": None, "first_activity": None, "last_activity": None},
                  "digest": ["Atlas did the most work."]})
    return led


def _demo_token_ledger() -> TokenLedger:
    """Made-up token history for the demo, in the real ledger's own shape, so the demo shows exactly what the view does:
    about four months of a busy office, five seats, eight projects, four models, working hours and weekends."""
    import hashlib
    rnd = lambda *k: int(hashlib.sha256("|".join(map(str, k)).encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    today = date.today()
    weight = {"claude": 0.8, "claude2": 1.6, "claude3": 1.1, "claude4": 0.7, "astra": 0.45}
    projects = {"claude": ["infra-terraform", "api-gateway"], "claude2": ["api-gateway", "mobile-app", "auth-service"],
                "claude3": ["billing-service", "data-pipeline"], "claude4": ["docs-site"], "astra": ["design-system"]}
    model = {"claude": "claude-opus-5-5", "claude2": "claude-opus-5-5", "claude3": "claude-sonnet-5-5", "claude4": "claude-haiku-5-5", "astra": "codex"}
    led = TokenLedger(None, [])
    sessions, days, models = {}, {}, {}
    for back in range(120, -1, -1):
        d = today - timedelta(days=back)
        weekend = d.weekday() >= 5
        for seat, w in weight.items():
            for k in range(1 + int(rnd("n", d, seat) * 3)):
                if weekend and rnd("we", d, seat, k) < 0.6:
                    continue
                size = w * (0.35 + 0.65 * (120 - back) / 120) * (0.3 + rnd("s", d, seat, k)) * 140e6
                c = int(size); f = c // 40; o = c // 400; mo = model[seat]
                sid = hashlib.sha256(f"{seat}|{d}|{k}".encode()).hexdigest()[:8] + f"-demo-{seat}-{d}-{k}"   # short ids differ
                proj = projects[seat][int(rnd("p", d, seat, k) * len(projects[seat]))]
                start = datetime(d.year, d.month, d.day, 9 + int(rnd("h", d, seat, k) * 11)).timestamp()
                hours = {f"{d.weekday()}-{h}": (f + c) // 2 for h in (int(9 + rnd("h", d, seat, k) * 11), int(9 + rnd("h", d, seat, k) * 11) + 1) if h < 24}
                commits = int(rnd("c", d, seat, k) * 7 * (1.4 if seat == "claude3" else 1))     # Vega ships lean
                prs = 1 if rnd("pr", d, seat, k) < 0.25 else 0
                sessions[sid] = {"p": proj, "s": "@codex" if seat == "astra" else seat, "fi": start, "l": start + 5400, "m": {mo: f + c},
                                 "d": {d.isoformat(): [f, c, o]}, "h": hours, "f": f, "c": c, "o": o, "n": int(size / 1e5),
                                 "g": {d.isoformat(): [commits, int(commits > 0), prs, prs if rnd("m", d, seat, k) < 0.8 else 0, commits * 37, commits * 9]}}
                if seat != "astra":                                   # where they went: helpers, thinking, the web
                    sessions[sid]["x"] = {d.isoformat(): [int((f + c) * (0.1 + 0.3 * rnd("hx", d, seat, k))), int(o * 0.35), 0, 0]}
                    sessions[sid]["web"] = {d.isoformat(): [int(rnd("ws", d, seat, k) * 4), int(rnd("wf", d, seat, k) * 6)]}
                if seat in ("claude", "claude2") and rnd("tw", d, seat, k) < 0.7:   # desks the CEO talks to wait on replies
                    n = 2 + int(rnd("wn", d, seat, k) * 9)
                    waits = sorted(int(15 + 1500 * rnd("wv", d, seat, k, i) ** 2.6) for i in range(n))
                    hist = [0] * len(tokens.WAIT_EDGES)
                    for x in waits:
                        hist[next(j for j, e in enumerate(tokens.WAIT_EDGES) if x <= e)] += 1
                    sessions[sid]["w"] = {d.isoformat(): [sum(waits), n, waits[-1], int(rnd("wa", d, seat, k) < 0.3), int(start + 1800)] + hist}
                if seat != "astra":                                   # priced per response, as the real ledger does
                    usd = round(prices.estimate(mo, f, c, o) * (1 + 0.15 * rnd("1h", d, seat, k)) * 1e6)
                    sessions[sid]["$"] = {d.isoformat(): usd}
                    sessions[sid]["$m"] = {mo: usd}
                r = days.setdefault(d.isoformat(), {"f": 0, "c": 0, "o": 0, "n": 0}); r["f"] += f; r["c"] += c; r["o"] += o; r["n"] += int(size / 1e5)
                m = models.setdefault(mo, {"f": 0, "c": 0, "o": 0, "n": 0}); m["f"] += f; m["c"] += c; m["o"] += o
    led.data = {"v": 2, "files": {}, "codex": {}, "sessions": sessions, "days": days, "models": models}
    led.scanned_at = time.time()
    return led


def _demo_par(s: dict, now: float) -> dict:
    """A made-up scorecard: the last six weekly windows and this one so far."""
    from .weeks import grade
    peaks = {"claude": [22, 8, 3, 15, 30, 12], "claude2": [96, 100, 91, 88, 99, 93], "claude3": [100, 74, 100, 82, 95, 67],
             "claude4": [55, 64, 71, 48, 90, 77]}.get(s["id"], [60] * 6)
    limited = {"claude2": {1: 300}, "claude3": {0: 500, 2: 80}}.get(s["id"], {})
    wk = (s.get("usage") or {}).get("weekly") or {}
    ends = round((wk.get("resets_at") or now + 3 * 86400) / 3600) * 3600
    benched = s["id"] == "claude"
    past = [dict(grade(pk, 1 if i in limited else 0, limited.get(i, 0), benched), ends=ends - (6 - i) * 7 * 86400, peak=pk,
                 limits=1 if i in limited else 0, five_hour_walls=(i * 3 + len(s["id"])) % 4) for i, pk in enumerate(peaks)]
    so_far = wk.get("pct") or 0
    elapsed = round(min(1.0, max(0.0, 1 - (ends - now) / (7 * 86400))), 2)
    nw = dict(grade(so_far, benched=benched), ends=ends, peak=so_far, five_hour_walls=1, elapsed=elapsed, benched=benched,
              heading=None if benched else ("Bogey" if so_far / elapsed > 100 else grade(so_far / elapsed)["name"]) if elapsed >= 0.15 else None)
    scores = [x["score"] for x in past if x["score"] is not None]
    return {"now": nw, "past": past, "season": sum(scores) if scores else None, "rounds": len(scores)}


class DemoOffice(LiveOffice):
    is_demo = True

    def cabinet_view(self, q: str = "", seat: str | None = None, offset: int = 0) -> dict:
        """The filing cabinet over the demo's made-up sessions, with made-up titles (the demo reads no transcripts)."""
        from .cabinet import Cabinet
        if not hasattr(self, "_tokens"):
            self._tokens = _demo_token_ledger()
        c = Cabinet()
        titles = {"api-gateway": ["Rate limits per API key", "Retry the flaky upstream", "Gateway timeouts after deploy"],
                  "billing-service": ["Move invoices to the new schema", "Refunds for negative balances"], "mobile-app": ["Offline mode for the cart"],
                  "auth-service": ["Shorter session cookies"], "data-pipeline": ["Nightly export to the warehouse"], "docs-site": ["Getting started, rewritten"],
                  "infra-terraform": ["Staging database upgrade"], "design-system": ["Dark mode tokens"]}
        for i, (sid, r) in enumerate(self._tokens.data["sessions"].items()):
            pool = titles.get(r.get("p"), ["A session"])
            c.index[sid] = {"title": pool[i % len(pool)], "prompt": None, "cwd": f"/home/you/work/{r.get('p')}", "path": None, "mtime": 0}
        c.built_at = time.time()
        return dict(c.search(self._tokens.data["sessions"], self.get().get("seats", []), q, seat, 50, offset), building=False)

    def prs_view(self) -> dict:
        """A made-up PR shelf: the demo never calls GitHub."""
        now = time.time()
        iso = lambda h: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - h * 3600))
        pr = lambda n, title, state, branch, checks, review=None, h=1, desk=None: {
            "number": n, "title": title, "state": state, "url": f"https://github.com/example/apollo/pull/{n}", "branch": branch,
            "updated": iso(h), "merged": iso(h) if state == "merged" else None, "review": review, "checks": checks, "author": "you", "at_desk": desk}
        prs = [pr(482, "Rate limiter: a token bucket per API key", "open", "lane/api-rate-limits", "pending", "review_required", 0.2, {"seat": "claude2", "session": "l-rate", "name": "api-rate-limits"}),
               pr(481, "Docs: getting started, rewritten", "open", "lane/docs-refresh", "pass", "approved", 0.5, {"seat": "astra", "session": "c-docs", "name": "docs-refresh"}),
               pr(479, "Billing: move invoices to the new schema", "open", "lane/billing-migration", "fail", None, 1.5, {"seat": "claude2", "session": "l-bill", "name": "billing-migration"}),
               pr(478, "Search: index the archive nightly", "draft", "lane/search-index", None, None, 5),
               pr(477, "Checkout: retry flaky payment webhooks", "merged", "lane/checkout-retry", "pass", "approved", 3),
               pr(476, "Auth: shorter session cookies", "merged", "lane/auth-cookies", "pass", "approved", 7),
               pr(475, "Dark mode for the dashboard", "merged", "lane/dark-mode", "pass", "approved", 20),
               pr(470, "Spike: graph layout", "closed", "exp/graph-layout", None, None, 48)]
        return {"available": True, "scanning": False, "repos": [{"repo": "example/apollo", "at": now - 90, "error": False, "prs": prs}]}

    def loose_view(self, force: bool = False) -> dict:
        """Made-up loose ends: the demo never runs git."""
        now = time.time()
        row = lambda name, branch, files=0, unpushed=0, upstream=None, live=False, merged=False, days=1: {
            "path": f"/home/you/work/{name}", "name": name, "branch": branch, "head": "3f9c2ab", "files": files,
            "unpushed": unpushed, "upstream": upstream, "ahead": unpushed if upstream not in (None, "gone") else 0,
            "merged": merged, "main": name == "apollo", "live": live, "locked": False, "touched": now - days * 86400}
        work = [row("wt-rate-limits", "lane/api-rate-limits", files=3, upstream="origin/lane/api-rate-limits", live=True, days=0),
                row("wt-billing-spike", "spike/billing-v2", unpushed=6, days=4),
                row("wt-docs-refresh", "lane/docs-refresh", files=1, unpushed=2, upstream="origin/lane/docs-refresh", days=2)]
        safe = [row(f"wt-lane-{n}", f"lane/{n}", unpushed=1, upstream="gone", merged=True, days=3 + i) for i, n in enumerate(
            ["login-copy", "flaky-retry", "search-index", "cache-warmup", "csv-export", "dark-mode", "audit-log"])]
        deleted = [row("wt-old-experiment", "exp/graph-layout", unpushed=3, upstream="gone", days=12)]
        cmd = lambda w: f"git -C /home/you/work/apollo worktree remove /home/you/work/{w['name']}"
        repo = {"root": "/home/you/work/apollo", "name": "apollo", "worktrees": 12, "base": "origin/main", "work": work,
                "safe": safe, "deleted": deleted, "gone": 1, "remove_cmds": [cmd(w) for w in safe],
                "deleted_cmds": [cmd(w) for w in deleted], "prune_cmd": "git -C /home/you/work/apollo worktree prune"}
        return {"at": now - 180, "scanning": False, "repos": [repo],
                "totals": {"repos": 1, "worktrees": 12, "work": 3, "safe": 7, "deleted": 1, "gone": 1}}

    def tokens_view(self, rng: str = "all", seat: str | None = None, all_sessions: bool = False) -> dict:
        if not hasattr(self, "_tokens"):
            self._tokens = _demo_token_ledger()
        return self._tokens.view(self.get().get("seats", []), rng=rng, seat=seat, all_sessions=all_sessions)

    def standup(self) -> dict:
        from . import standup
        y = time.time() - 86400
        ev = [{"ts": y, "kind": "report", "level": "good", "text": "checkout-tests filed its report: STATUS: DONE - flaky retry test fixed"},
              {"ts": y + 60, "kind": "report", "level": "good", "text": "docs-refresh filed its report: STATUS: DONE - API docs regenerated"},
              {"ts": y + 120, "kind": "shipped", "level": "good", "text": "api-gateway: PR #477 merged"},
              {"ts": y + 180, "kind": "limit", "level": "warn", "text": "Vega is out of plan"}]
        return standup.build(self.get(), ev, {"commits": 41, "prs_opened": 6, "prs_merged": 4})

    def tokens_project(self, name: str, days: int = 30) -> dict:
        if not hasattr(self, "_tokens"):
            self._tokens = _demo_token_ledger()
        out = self._tokens.view_project(name, self.get().get("seats", []), days=days)
        for r in out["sessions"]:
            r.pop("session", None)
        out["lanes"] = [{"id": l["id"], "title": l.get("title"), "status": l.get("status"), "spent": l.get("spent")}
                        for l in self.get().get("lanes", []) if name in (l.get("workdir") or "")]
        return out

    def demo_lane_detail(self, lane_id):
        """Made-up lane pages: the demo never reads the real lanes folder."""
        lane = next((l for l in self.snapshot.get("lanes", []) if l.get("id") == lane_id), None)
        if not lane:
            raise ValueError("No such lane")
        when = time.strftime("%H:%M", time.localtime(lane.get("created_at") or time.time()))
        brief = (f"# {lane['title']}\n\nWork in {lane.get('workdir')}. Keep notes in STATE as you go, check your work, "
                 f"and write the report when it is done.")
        state = lane.get("state_tail") or f"{when} read the brief and the code it points at\n{when} planned the change"
        report = (lane["report_status"] + "\n\nAll checks pass. Notes and links are in STATE.") if lane.get("report_status") else ""
        log = "\n".join(f"=== {time.strftime('%Y-%m-%dT%H:%M', time.localtime(r.get('started_at') or time.time()))} start on {r['seat']}"
                        + (" (stopped by a limit)" if r.get("ended_by") == "limit" else "") for r in lane.get("runs", []))
        return {"lane": lane, "brief": brief, "state": state, "report": report, "log": log or lane.get("waiting_reason") or ""}

    def demo_conversation(self, session_id):
        # Anchored to when the demo started, so the conversation (and any steps the viewer opened) stays put.
        now = self.started_at
        out = []
        for i, (role, text) in enumerate(DEMO_CHAT):
            item = {"ts": now - (len(DEMO_CHAT) - i) * 95, "role": role, "text": text}
            if role == "peer":
                item.update(from_name="Claude Office (CEO)", text=text.split(": ", 1)[1])
            if role == "step":
                item["kind"] = "type" if text.startswith(("Editing", "Run")) else "read"
            out.append(item)
        return out

    def __init__(self):
        self.init_live()
        self.samples = HistoryStore(ledger=_demo_ledger())
        self.cfg = dict(config.DEFAULTS, office_name="Claude Office", ceo={"name": "Alex", "title": "CEO"},
                        default_workdir="/home/you/work")
        self.usage = _NoPoll()
        self.career = _demo_career()
        self._ship = [37, 5, 3]                      # today's commits, PRs opened, PRs merged on the lobby's ship board
        self._ship_seats = {"claude2": [14, 2, 1], "claude3": [16, 2, 2], "claude": [7, 1, 0]}
        self.asks = Asks(None)                    # one question waiting, so the Inbox and the ringing phone show
        self.asks.add("Ship the rate limiter behind a flag today, or wait for Vega's review tomorrow?", "claude2", "l-rate", "api-rate-limits", "/home/you/work/apollo")
        self.asks.items[-1]["ts"] = time.time() - 420
        self.asks.add("The billing export has 3 customers with negative balances. Refund them or leave them for finance?", "claude2", "l-bill", "billing-migration", "/home/you/work/apollo")
        self.asks.answer(self.asks.items[-1]["id"], "Leave them for finance, and list them in your report.", "direct")
        self._unlocks = list(DEMO_UNLOCKS)
        self._unlock_at = time.time() - 100     # the first celebration comes about 20 seconds in
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

    def emit(self, kind, text, seat=None, level="info", ts=None, extra=None):
        event = public({"ts": time.time() if ts is None else ts, "kind": kind, "text": text, "seat": seat, "level": level, **(extra or {})})
        with self.condition:
            self.events.append(event)
            self.notify_news(event)

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
            dict(id="claude", kind="claude", label="claude", nickname="Main", color="#d95926", config_dir="~/.claude",
                 account={"name": "Alex", "email": "alex@example.com", "org": "Acme", "role": "owner"},
                 health={"state": "ok", "detail": "Logged in", "tier": "Max 5x", "subscription": "team"},
                 usage=usage(12, 71, 4 * 3600, 2.5 * 86400),
                 sessions=[_sess("claude", "d-main-1", "ops-desk", "desk", "idle", None, now, 7200,
                                 title="Quarterly planning notes")]),
            dict(id="claude2", kind="claude", label="claude2", nickname="Atlas", color="#3987e5", config_dir="~/.claude2",
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
            dict(id="claude3", kind="claude", label="claude3", nickname="Vega", color="#199e70", config_dir="~/.claude3",
                 account={"name": "Seat Three", "email": "seat3@example.com", "org": "Acme", "role": "member"},
                 health={"state": "ok", "detail": "Logged in", "tier": "Max 5x", "subscription": "team"},
                 usage=usage(100, 62, 38 * 60, 4 * 86400),
                 sessions=[_sess("claude3", "l-check", "checkout-tests", "lane", "limited", "rate", now, 5000,
                                 title="Checkout flaky tests", unit="apollo-lane-l13.service"),
                           _sess("claude3", "l-search", "search-index", "lane", "limited", "billing", now, 6100,
                                 title="Search index rebuild", unit="apollo-lane-l14.service")]),
            dict(id="claude4", kind="claude", label="claude4", nickname="Orion", color="#9085e9", config_dir="~/.claude4",
                 account={"name": "Seat Four", "email": "seat4@example.com", "org": "Acme", "role": "member"},
                 health={"state": "stale", "detail": "Login refreshes on the next run", "tier": "Max 5x", "subscription": "team"},
                 usage=usage(3, 22, 5 * 3600, 5 * 86400), sessions=[]),
            dict(id="astra", kind="codex", label="Astra", nickname="Codex", color="#008300", config_dir="~/.codex",
                 account={"name": "ChatGPT plan"}, health={"state": "ok", "detail": "Codex CLI", "tier": "gpt"},
                 usage=usage(18, 30, 3 * 3600, 6 * 86400),
                 sessions=[_sess("astra", "c-docs", "docs-refresh", "lane", "working", "docs", now, 1500,
                                 title="Refresh the API docs", cwd="/home/you/work/docs", tokens=90000)]),
        ]
        # A visitor lane comes and goes every 45 seconds, so the demo shows arrivals, reports and departures.
        visiting = int(now // 45) % 2 == 1
        if visiting:
            seats[3]["sessions"].append(_sess("claude4", "c-visit", "visitor-lane", "lane", "working", "docs", now,
                                              (now % 45) + 5, title="Quick docs fix", tokens=40000))
        was = getattr(self, "_visiting", None)
        if was is not None and was != visiting:
            if visiting:
                self.emit("arrive", "visitor-lane sat down at claude4 (lane)", "claude4")
            else:
                self.emit("report", "visitor-lane filed its report: STATUS: DONE - docs fixed", "claude4", "good")
                self.emit("leave", "visitor-lane left claude4", "claude4")
        self._visiting = visiting
        if not visiting:                                  # someone on claude.ai uses Orion's login while its desk is empty
            seats[3]["ghost"] = {"rise": 6.0, "minutes": 22, "since": now - 1320}
        # Commits land now and then (a real office reads them from the transcripts every minute).
        beat = int(now // 20)
        if getattr(self, "_commit_beat", beat) != beat and beat % 3 == 0:
            who, proj = [("claude2", "api-gateway"), ("claude3", "billing-service"), ("claude", "infra-terraform")][beat // 3 % 3]
            n = 1 + beat % 3
            self.emit("commit", f"{proj}: {n} commit{'' if n == 1 else 's'}", who, "good")
            self._ship[0] += n; self._ship_seats.setdefault(who, [0, 0, 0])[0] += n
        if getattr(self, "_commit_beat", beat) != beat and beat % 7 == 1:   # and a PR goes up or merges every couple of minutes
            who, proj = [("claude3", "billing-service"), ("claude2", "api-gateway")][beat // 7 % 2]
            merged = beat // 7 % 3 != 0
            self.emit("shipped", f"{proj}: PR #{400 + beat % 97} {'merged' if merged else 'opened'}", who, "good")
            self._ship[2 if merged else 1] += 1; self._ship_seats.setdefault(who, [0, 0, 0])[2 if merged else 1] += 1
        self._commit_beat = beat
        for s in seats:
            sc = div["seats"][s["id"]]
            s["divider"] = sc
            s["lanes"] = sum(1 for x in s["sessions"] if x["kind"] == "lane")
            s["desks"] = sum(1 for x in s["sessions"] if x["kind"] == "desk")
            s["resting_until"] = None
            s["tokens_1h"] = sum(x["tokens_1h"]["fresh"] for x in s["sessions"])
            s["tokens_1h_all"] = s["tokens_1h"] + sum(x["tokens_1h"]["cached"] for x in s["sessions"])
            s["status"] = Office._seat_status(s, sc, s["sessions"])
            if s["kind"] == "claude":                     # par for the week: a made-up season per seat
                s["par"] = _demo_par(s, now)
            for x in s["sessions"]:
                x["talk"] = "none" if s["kind"] == "codex" else ("direct" if x["kind"] == "lane" else "review")
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
        lanes.append({"id": "1016-150000-nightly-flake-hunt", "title": "Nightly flake hunt", "workdir": "/home/you/work/apollo",
                      "seat_pref": "auto", "model": "opus", "permission_mode": "acceptEdits", "created_at": now - 300,
                      "status": "waiting", "seat": None, "runs": [], "unit": "office-lane-1016-150000-nightly-flake-hunt",
                      "waiting_reason": "Every seat is busy or at its cap", "report_status": None, "state_tail": None,
                      "unit_active": True})
        lanes.append({"id": "1016-031200-migrate-the-billing-tables", "title": "Migrate the billing tables", "workdir": "/home/you/work/billing",
                      "seat_pref": "auto", "model": "opus", "permission_mode": "acceptEdits", "created_at": now - 9 * 3600,
                      "status": "interrupted", "reboot": True, "interrupted_at": now - 25 * 60, "seat": "claude3", "runs": [],
                      "unit": "office-lane-1016-031200-migrate-the-billing-tables", "report_status": None,
                      "state_tail": "02:58 copied invoices and refunds\n03:05 started on the ledger table", "unit_active": False})
        lanes.append({"id": "1016-220000-draft-release-notes", "title": "Draft the release notes", "workdir": "/home/you/work/apollo",
                      "seat_pref": "auto", "model": "sonnet", "permission_mode": "acceptEdits", "created_at": now - 1200,
                      "status": "scheduled", "schedule": {"at": (now // 3600 + 3) * 3600}, "seat": None, "runs": [],
                      "unit": "office-lane-1016-220000-draft-release-notes", "report_status": None, "state_tail": None, "unit_active": False})
        units = [
            {"unit": "apollo-conductor.service", "active": "active", "sub": "running", "description": "Apollo conductor (lanes, integrator)"},
            {"unit": "apollo-lane-l12.service", "active": "active", "sub": "running", "description": "Apollo lane L12"},
            {"unit": "apollo-lane-l13.service", "active": "active", "sub": "running", "description": "Apollo lane L13"},
            {"unit": "apollo-lane-l14.service", "active": "active", "sub": "running", "description": "Apollo lane L14"},
            {"unit": "billing-lane-b3.service", "active": "active", "sub": "running", "description": "Billing lane B3"},
            {"unit": "lane-supervisor.service", "active": "active", "sub": "running", "description": "Relaunches lanes after a limit"},
            {"unit": "nightly-report.service", "active": "failed", "sub": "failed", "description": "Nightly usage report"},
        ]
        snap = {"now": now, "office": {"started_at": self.started_at, "version": "3.83.0", "name": self.cfg["office_name"], "ceo": self.cfg["ceo"], "config_error": None,
                                       "default_workdir": "/home/you/work",
                                       "lane_defaults": {"model": "opus", "permission_mode": "acceptEdits"}},
                "seats": seats, "units": units, "lanes": lanes, "programmes": list(progs.values()), "divider": div,
                "next_pick": {"seat": ev["pick"], "why": ev["why"], "ranking": ev["ranking"]},
                "suggested_weights": divider.suggest(seats, div)}
        c, o, m = self._ship
        snap["office"]["shipped_today"] = {"day": time.strftime("%Y-%m-%d"), "commits": c, "prs_opened": o, "prs_merged": m,
                                           "seats": {k: list(v) for k, v in self._ship_seats.items()}}
        snap["asks"] = self.asks.view(30)
        snap["attention"] = Office._attention(snap)
        if not hasattr(self, "quiet"):
            from .snapshot import Quiet
            self.quiet = Quiet(None)                   # the demo's quiet lives in memory
        quiet, t = self.quiet.get(), time.time()
        snap["snoozed"] = sum(1 for a in snap["attention"] if quiet["snoozed"].get(a["key"], 0) > t)
        snap["ceo"] = {"present": True, "away_since": None, "locked": False, "idle_s": 12, "source": "demo", "last_away": None}
        if not hasattr(self, "reminders"):
            from .reminders import Reminders
            self.reminders = Reminders(None)               # the demo's reminders live in memory
        for r in self.reminders.check(snap, t, list(self.events)[-80:]):
            self.emit("reminder", r["text"], r.get("seat"), "warn")
        snap["reminders"] = self.reminders.view()
        snap["attention"] = [a for a in snap["attention"] if quiet["snoozed"].get(a["key"], 0) <= t]
        snap["office"]["dnd_until"] = quiet["dnd_until"] if quiet["dnd_until"] > t else None
        snap["totals"] = Office._totals(snap)
        # Every couple of minutes someone levels up or unlocks something, so the demo shows the celebration.
        if self._unlocks and now - self._unlock_at >= 120:
            self._unlock_at = now
            seat, aid, text = self._unlocks.pop(0)
            c = self.career.seats[seat]
            if aid == "levelup":
                c["xp"] = xp_for(int(text.split()[-2].rstrip(":")))
            else:
                c["unlocked"][aid] = now
            self.emit("levelup" if aid == "levelup" else "achievement", text, seat, "good")
        for x in seats:
            x["career"] = self.career.view(x["id"])
        snap["achievements"] = CATALOGUE
        if not getattr(self, "_seeded", False):
            self._seed_history(snap)
            self._seeded = True
        snap["events"] = list(self.events)[-60:]
        snap = self.publish(snap)
        self.samples.record(snap)
        return snap

    def _seed_history(self, snap):
        """Six made-up hours so the timeline and today's stats have something to show."""
        now = snap["now"]
        start = now - 6 * 3600
        live = {x["id"]: (s["id"], x) for s in snap["seats"] for x in s["sessions"]}
        past = [  # finished sessions: (id, seat, name, kind, from_ago, to_ago, report)
            ("old-deps", "claude4", "dependency-bump", "lane", 5.2 * 3600, 3.3 * 3600, "STATUS: DONE - 14 packages bumped, PR #480"),
            ("old-l11", "claude2", "apollo-l11-search", "lane", 4.6 * 3600, 2.7 * 3600, "STATUS: READY #477"),
            ("old-perf", "claude3", "perf-audit", "lane", 5.9 * 3600, 4.1 * 3600, "STATUS: DONE - p95 down 38%"),
            ("old-astra", "astra", "changelog-draft", "lane", 3.9 * 3600, 3.1 * 3600, "STATUS: DONE - changelog drafted"),
        ]
        rows = []
        t = start
        while t < now - 60:
            ago = now - t
            sessions = {}
            for sid, (seat, x) in live.items():
                age = now - (x.get("started_at") or now)
                if ago > age:
                    continue
                k = int(t // 60)
                if x["state"] == "limited":
                    state = "limited" if ago < 40 * 60 else ("waiting" if k % 23 < 3 else "working")
                elif x["kind"] == "desk" and x["state"] == "idle":
                    state = "working" if (k // 9) % 5 == 0 else "idle"
                else:
                    state = "waiting" if k % 19 < 3 else "working"
                done = max(0.0, (age - ago) / max(age, 1))
                sessions[sid] = [seat, x["name"], x["kind"], state, x.get("title"), None,
                                 int(done * x["tokens_5h"]["fresh"] * 1.6), int(done * (x.get("tool_calls") or 0))]
            for sid, seat, name, kind, a0, a1, rep in past:
                if a1 <= ago <= a0:
                    frac = (a0 - ago) / (a0 - a1)
                    sessions[sid] = [seat, name, kind, "waiting" if int(t // 60) % 17 < 3 else "working", None,
                                     rep if ago < a1 + 120 else None, int(frac * 900000), int(frac * 240)]
            hrs = ago / 3600
            seats = {
                "claude": [12.0 - min(4, hrs), 71.0 - hrs * 0.4, 0, 0, 0],
                "claude2": [(64 - (2.1 - hrs) * 0 - hrs * 25.0) if hrs < 2.1 else max(0.0, 88 - (hrs - 2.1) * 22), 48 - hrs * 1.6,
                            2, 2 if hrs < 0.9 else 1, 420000],
                "claude3": [100.0 if hrs < 0.66 else max(0.0, 100 - (hrs - 0.66) * 21), 62 - hrs * 1.9, 0 if hrs < 0.66 else 2, 2, 380000],
                "claude4": [3.0 if hrs < 3.2 else max(0.0, 70 - (hrs - 3.2) * 24), 22 - hrs * 1.1, 0 if hrs < 3.3 else 1, 0 if hrs < 3.3 else 1, 0],
                "astra": [18.0 - hrs * 3 if hrs < 4 else 6.0, 30 - hrs, 1 if hrs < 0.42 or 3.1 < hrs < 3.9 else 0, 1 if hrs < 0.42 else 0, 90000],
            }
            seats = {k: [None if v is None else (round(max(0.0, min(100.0, v)), 1) if i < 2 else v) for i, v in enumerate(vals)]
                     for k, vals in seats.items()}
            rows.append({"ts": t, "seats": seats, "sessions": sessions, "first_seen": {}})
            t += 60
        with self.samples.lock:
            self.samples.rows = rows + self.samples.rows
            for r in rows:
                for sid in r["sessions"]:
                    self.samples.first_seen.setdefault(sid, r["ts"])
        for ago, kind, seat, text, level in [
            (5.9 * 3600, "lane", "claude3", "perf-audit sat down at claude3 (lane)", "info"),
            (4.1 * 3600, "report", "claude3", "perf-audit filed its report: STATUS: DONE - p95 down 38%", "good"),
            (3.3 * 3600, "report", "claude4", "dependency-bump filed its report: STATUS: DONE - 14 packages bumped, PR #480", "good"),
            (3.1 * 3600, "report", "astra", "changelog-draft filed its report: STATUS: DONE - changelog drafted", "good"),
            (2.9 * 3600, "reset", "claude2", "claude2 5-hour window reset: back to 0%", "good"),
            (2.7 * 3600, "report", "claude2", "apollo-l11-search filed its report: STATUS: READY #477", "good"),
            (0.7 * 3600, "usage", "claude3", "claude3 passed 95% of its 5-hour window", "bad"),
            (0.66 * 3600, "limit", "claude3", "checkout-tests on claude3 hit the usage limit", "warn"),
        ]:
            self.events.append({"ts": now - ago, "kind": kind, "text": text, "seat": seat, "level": level})
        self.events = deque(sorted(self.events, key=lambda e: e["ts"]), maxlen=200)

    def run(self):
        while not self.stop.is_set():
            self.build()
            self.stop.wait(3)

    def find_session(self, seat_id, session_id):
        for s in self.snapshot.get("seats", []):
            for x in s["sessions"]:
                if s["id"] == seat_id and x["id"] == session_id:
                    return x
        return None


# (seat, XP, hours at work, sessions, reports, limits, tool calls, tokens, unlocked achievements, days in a row)
DEMO_CAREERS = [
    ("claude", 13200, 61.5, 88, 9, 4, 9200, 38_000_000, ["first_hour", "first_report", "hands_1k", "night_shift", "hit_the_wall", "tokens_10m", "regular", "level_10"], 4),
    ("claude2", 26500, 140.2, 214, 41, 11, 21800, 96_000_000, ["first_hour", "first_report", "paper_trail", "hands_1k", "hands_10k", "marathon", "night_shift", "juggler", "hit_the_wall", "comeback", "tokens_10m", "regular", "week_streak", "level_10"], 12),
    ("claude3", 9100, 44.0, 120, 17, 9, 7600, 22_000_000, ["first_hour", "first_report", "paper_trail", "hands_1k", "hit_the_wall", "comeback", "tokens_10m", "regular", "level_10"], 6),
    ("claude4", 4300, 22.3, 51, 6, 2, 3100, 9_400_000, ["first_hour", "first_report", "hands_1k", "early_bird", "hit_the_wall"], 2),
    ("astra", 2150, 12.0, 30, 8, 1, 1900, 4_100_000, ["first_hour", "first_report", "hands_1k"], 1),
]
DEMO_UNLOCKS = [
    ("astra", "levelup", "Astra reached level 6: Engineer"),
    ("claude4", "juggler", "claude4 unlocked Juggler"),
    ("claude3", "marathon", "claude3 unlocked Marathon"),
    ("claude4", "levelup", "claude4 reached level 8: Engineer"),
    ("astra", "early_bird", "Astra unlocked Early bird"),
]


def _demo_career() -> Career:
    c = Career(None)
    now = time.time()
    for sid, xp, hours, sessions, reports, limits, tools, tokens, unlocked, streak in DEMO_CAREERS:
        seat = new_seat(now - 40 * 86400)
        seat.update(xp=xp, active_s=hours * 3600, sessions=sessions, reports=reports, limits=limits, tool_calls=tools,
                    tokens=tokens, unlocked={a: now - (i + 1) * 86400 * 2.5 for i, a in enumerate(reversed(unlocked))},
                    days=[time.strftime("%Y-%m-%d", time.localtime(now - d * 86400)) for d in range(streak)])
        c.seats[sid] = seat
    return c

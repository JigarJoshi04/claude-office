"""Your data out of the office: the days per character, careers, tokens per day and character, lanes and the news, as
CSV or JSON, and a month's report in Markdown for a status update. The page asks for them with the office token (they
carry project and lane names). Share-safe exports leave out titles, reports and news text.
"""
from __future__ import annotations

import calendar
import csv
import io
import hashlib
import json
import time
from datetime import date

from . import lanes


WHAT = ("days", "careers", "tokens", "lanes", "events")


def _cell(v):
    """A spreadsheet never runs a cell as a formula: one that starts with = + - @ (or a tab or CR before one) is quoted."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


def _iso(ts) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts)) if ts else ""


def names_from(raw) -> dict:
    """The page's names for the characters (they are made in the browser): {seat id: name}, checked."""
    try:
        d = json.loads(raw or "{}")
    except ValueError:
        return {}
    return {k: v.strip()[:40] for k, v in (d if isinstance(d, dict) else {}).items() if isinstance(k, str) and isinstance(v, str) and v.strip()}


def _all_lanes(office, snap: dict) -> list[dict]:
    """Every lane: the snapshot's (the newest 40, with their reports and costs) and the older ones from disk. The
    demo's lanes are made up, so only the snapshot's."""
    have = list(snap.get("lanes") or [])
    if getattr(office, "is_demo", False):
        return have
    seen = {l.get("id") for l in have}
    d = lanes.lanes_dir()
    for p in sorted(d.iterdir()) if d.is_dir() else []:
        if p.name in seen:
            continue
        l = lanes.load_lane(p.name)
        if l:
            l["report_status"] = lanes._first_line(p / "REPORT.md")
            have.append(l)
    return have


def rows(office, what: str, private: bool = False, names: dict | None = None) -> list[dict]:
    snap = office.get() or {}
    seats = snap.get("seats", [])
    label = {s["id"]: (names or {}).get(s["id"]) or s.get("nickname") or s.get("label") or s["id"] for s in seats}
    if what == "days":
        out = []
        ledger = getattr(office.samples, "ledger", None)
        for day, st in sorted(((ledger.days if ledger else {}) or {}).items()):
            for sid, v in sorted((st.get("seats") or {}).items()):
                v = v or {}
                out.append({"day": day, "seat": sid, "name": label.get(sid, sid), "active_min": v.get("active_min", 0), "sessions": v.get("sessions", 0),
                            "reports": v.get("reports", 0), "limits": v.get("limits", 0), "tool_calls": v.get("tool_calls", 0),
                            "tokens_fresh": v.get("tokens_fresh", 0), "plan_min": v.get("avail_min", 0), "busy_min": v.get("busy_min", 0),
                            "mvp": int((st.get("mvp") or {}).get("seat") == sid)})
        return out
    if what == "careers":
        return [{"seat": s["id"], "name": label[s["id"]], "level": (s.get("career") or {}).get("level"), "title": (s.get("career") or {}).get("title"),
                 "xp": (s.get("career") or {}).get("xp"), "trophies": len((s.get("career") or {}).get("unlocked") or {}),
                 "since": _iso((s.get("career") or {}).get("since"))} for s in seats]
    if what == "tokens":
        codex = next((s["id"] for s in seats if s.get("kind") == "codex"), None)
        led = getattr(office, "tokens", None)
        if led is None and hasattr(office, "tokens_view"):            # the demo builds its ledger on first use
            office.tokens_view()
            led = getattr(office, "_tokens", None)
        per = led.per_day_seat({s["id"] for s in seats}, codex) if led else {}
        return [{"day": d, "seat": k or "", "name": label.get(k, "unknown") if k else "unknown", "fresh": v[0], "cache_reads": v[1], "output": v[2],
                 "usd": round(v[3], 2), "commits": v[4], "prs_opened": v[5], "prs_merged": v[6]}
                for (d, k), v in sorted(per.items(), key=lambda kv: (kv[0][0], kv[0][1] or ""))]
    if what == "lanes":
        out = []
        for l in sorted(_all_lanes(office, snap), key=lambda l: l.get("created_at") or 0):
            runs = l.get("runs") or []
            out.append({"id": ("lane-" + hashlib.sha256(l["id"].encode()).hexdigest()[:8]) if private else l["id"],   # an id is made from its title
                        "title": "" if private else l.get("title", ""), "status": l.get("status"), "seat": l.get("seat") or l.get("seat_pref"),
                        "model": l.get("model"), "hired": _iso(l.get("created_at")), "finished": _iso(l.get("finished_at")), "runs": len(runs),
                        "report": "" if private else (l.get("report_status") or "")[:300]})
        return out
    if what == "events":
        out = []
        try:
            lines = office._events_path.read_text().splitlines()
        except (OSError, AttributeError):                              # the demo keeps its news in memory
            lines = [json.dumps(e) for e in getattr(office, "events", [])]
        for line in lines:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if isinstance(e, dict):
                out.append({"at": _iso(e.get("ts")), "kind": e.get("kind"), "seat": e.get("seat") or "", "level": e.get("level") or "",
                            "text": "" if private else e.get("text", "")})
        return out
    raise ValueError(f"what is one of {', '.join(WHAT)}")


def render(items: list[dict], fmt: str) -> tuple[bytes, str]:
    if fmt == "json":
        return json.dumps(items, indent=1).encode(), "application/json"
    if fmt != "csv":
        raise ValueError("format is csv or json")
    buf = io.StringIO()
    if items:
        w = csv.DictWriter(buf, fieldnames=list(items[0]), extrasaction="ignore")
        w.writeheader()
        for r in items:
            w.writerow({k: _cell(v) for k, v in r.items()})
    return buf.getvalue().encode(), "text/csv; charset=utf-8"


def report(office, month: str, private: bool = False, names: dict | None = None) -> str:
    """A month in Markdown: the work, the tokens and their list price, what shipped, promises, who did what, best days."""
    try:
        y, m = int(month[:4]), int(month[5:7])
        first = date(y, m, 1)
    except (ValueError, IndexError, TypeError):
        raise ValueError("month is YYYY-MM") from None
    last = date(y, m, calendar.monthrange(y, m)[1])
    inside = lambda d: first.isoformat() <= d <= last.isoformat()
    snap = office.get() or {}
    seats = snap.get("seats", [])
    label = {s["id"]: (names or {}).get(s["id"]) or s.get("nickname") or s.get("label") or s["id"] for s in seats}
    days = [r for r in rows(office, "days", names=names) if inside(r["day"])]
    toks = [r for r in rows(office, "tokens", names=names) if inside(r["day"])]
    who: dict = {}
    for r in days:
        e = who.setdefault(r["seat"], {"min": 0, "reports": 0, "sessions": 0, "mvp": 0, "limits": 0})
        e["min"] += r["active_min"]; e["reports"] += r["reports"]; e["sessions"] += r["sessions"]; e["mvp"] += r["mvp"]; e["limits"] += r["limits"]
    tot = {k: sum(e[k] for e in who.values()) for k in ("min", "reports", "sessions", "limits")}
    tk = {k: sum(r[k] for r in toks) for k in ("fresh", "cache_reads", "usd", "commits", "prs_opened", "prs_merged")}
    pm = getattr(office, "promises", None)               # every settled promise it keeps, not the briefing's latest 8
    every = [dict(p) for p in getattr(pm, "items", None) or []] if pm is not None and not isinstance(pm, dict) else (snap.get("promises") or {}).get("recent") or []
    settled = [p for p in every if p.get("status") != "open" and p.get("settled_at") and inside(time.strftime("%Y-%m-%d", time.localtime(p["settled_at"])))]
    by_day: dict = {}
    for r in days:
        e = by_day.setdefault(r["day"], [0, 0])
        e[0] += r["reports"]; e[1] += r["active_min"]
    best = sorted(by_day.items(), key=lambda kv: (-kv[1][0], -kv[1][1]))[:3]
    big = lambda n: f"{n / 1e9:.1f} B" if n >= 1e9 else f"{n / 1e6:.1f} M" if n >= 1e6 else f"{n / 1e3:.0f} k" if n >= 1e3 else str(n)
    name = (snap.get("office") or {}).get("name") or "Claude Office"
    out = [f"# {name} · {first.strftime('%B %Y')}", ""]
    if not days and not toks:
        return "\n".join(out + ["Nothing on record for this month."]) + "\n"
    out += [f"- **{tot['reports']} reports** filed, **{tot['min'] / 60:.1f} h** of agent work across **{tot['sessions']} session-days** (a session over midnight counts on both days).",
            f"- **{big(tk['fresh'] + tk['cache_reads'])} tokens** ({big(tk['fresh'])} fresh), worth **${tk['usd']:,.0f}** at API list prices.",
            f"- Shipped: **{tk['commits']} commits**, **{tk['prs_merged']} PRs merged** of {tk['prs_opened']} opened."]
    if tot["limits"]:
        out.append(f"- Usage limits hit: {tot['limits']}.")
    if settled:
        out.append(f"- Promises: {sum(p['status'] == 'kept' for p in settled)} kept of {len(settled)}.")
    out += ["", "## Who did what", "", "| Character | Hours at work | Reports | Sessions | Employee of the day |", "| --- | ---: | ---: | ---: | ---: |"]
    for sid, e in sorted(who.items(), key=lambda kv: -kv[1]["min"]):
        out.append(f"| {label.get(sid, sid)} | {e['min'] / 60:.1f} | {e['reports']} | {e['sessions']} | {e['mvp']} |")
    if best:
        out += ["", "## Best days", ""]
        for d, (rep, mins) in best:
            out.append(f"- {date.fromisoformat(d).strftime('%a %d %b')}: {rep} reports, {mins / 60:.1f} h at work")
    lane_rows = [l for l in rows(office, "lanes", private) if inside((l["finished"] or "")[:10])]
    if lane_rows:
        out += ["", "## Lanes finished", ""]
        for l in lane_rows[-15:]:
            out.append(f"- {l['title'] or 'A lane'}: {l['status']}" + (f" ({l['report']})" if l["report"] and not private else ""))
    out += ["", f"*From the office's own records, {time.strftime('%d %b %Y')}.*"]
    return "\n".join(out) + "\n"


def conversation_md(items: list[dict], name: str, seat: str) -> str:
    """A session's conversation as Markdown (already masked by conversation.read): its brief, the messages, and the
    steps between them as short lists."""
    out = [f"# {name or 'A session'} · {seat}", ""]
    steps: list[str] = []
    def flush():
        if steps:
            out.extend([f"- `{s[:160]}`" for s in steps] + [""])
            steps.clear()
    for x in items:
        role, text = x.get("role"), str(x.get("text") or "").strip()
        when = time.strftime("%d %b %H:%M", time.localtime(x["ts"])) if x.get("ts") else ""
        if role == "step":
            steps.append(text.replace("`", "'"))
            continue
        flush()
        if role == "brief":
            out += [f"**Brief: {x.get('title') or ''}**", "", text, ""]
        elif role == "user":
            out += [f"**You** · {when}", "", text, ""]
        elif role == "assistant":
            out += [f"**Claude** · {when}", "", text, ""]
        elif role == "peer":
            out += [f"**{x.get('from_name') or 'Another session'}** · {when}", "", text, ""]
        elif text:
            out += [f"*{text}*", ""]
    flush()
    out.append(f"*Exported from Claude Office, {time.strftime('%d %b %Y %H:%M')}. Credentials are masked.*")
    return "\n".join(out) + "\n"


def lane_pack(lane: dict, brief: str, report: str, state: str, names: dict | None = None) -> str:
    """A lane's handoff pack in Markdown: what it was asked, what it reported, its notes and runs, where its work is."""
    nm = lambda sid: (names or {}).get(sid) or sid or "the divider's pick"
    runs = lane.get("runs") or []
    out = [f"# {lane.get('title') or lane['id']}", "",
           f"- **Status:** {lane.get('status')}" + (f" ({(lane.get('trust') or {}).get('level')}: {(lane.get('trust') or {}).get('why')})" if lane.get("trust") else ""),
           f"- **Seat and model:** {nm(lane.get('seat') or lane.get('seat_pref'))}, {lane.get('model')}",
           f"- **Hired:** {_iso(lane.get('created_at'))}" + (f" · **finished:** {_iso(lane.get('finished_at'))}" if lane.get("finished_at") else ""),
           f"- **Folder:** `{lane.get('workdir')}`"]
    if lane.get("worktree"):
        out.append(f"- **Branch:** `{lane['worktree']['branch']}` (its own worktree)")
    if (lane.get("spent") or {}).get("tokens"):
        out.append(f"- **Tokens:** {lane['spent']['tokens']:,}" + (f" (${lane['spent']['usd']:,.2f} at list prices)" if lane["spent"].get("usd") else ""))
    sh = lane.get("shipped") or {}
    if sh.get("commits") or sh.get("prs_opened"):
        out.append(f"- **Shipped:** {sh.get('commits', 0)} commits, {sh.get('prs_opened', 0)} PRs opened, {sh.get('prs_merged', 0)} merged")
    out += ["", "## The brief", "", brief.strip() or "(none)", "", "## The report", "", report.strip() or "No report yet.", ""]
    if state.strip():
        out += ["## Its notes", "", state.strip(), ""]
    if runs:
        out += ["## Runs", ""]
        for r in runs:
            out.append(f"- {nm(r.get('seat'))}: {_iso(r.get('started_at'))} to {_iso(r.get('ended_at')) or 'now'}"
                       + (f", ended by its {r['ended_by']}" if r.get("ended_by") else "") + (f", exit {r['rc']}" if r.get("rc") not in (None, 0) else ""))
        out.append("")
    out.append(f"*From Claude Office, {time.strftime('%d %b %Y %H:%M')}. Credentials are masked.*")
    return "\n".join(out) + "\n"


def plan_calendar(snap: dict, names: dict | None = None) -> str:
    """The seats' plan resets and, at this pace, run-outs, as an iCalendar file for the week ahead."""
    now = time.time()
    stamp = lambda t: time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(t))
    out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Claude Office//plans//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Claude Office plans"]
    text = lambda v: "".join(ch if ch >= " " or ch == "\t" else " " for ch in v).replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;")   # no CR or LF in a value
    def event(uid, t, title, desc):                      # SEQUENCE grows with each download, so a calendar updates the event
        out.extend(["BEGIN:VEVENT", f"UID:{uid}@claude-office", f"DTSTAMP:{stamp(now)}", f"SEQUENCE:{int(now // 60) - 29_000_000}",
                    f"DTSTART:{stamp(t)}", f"DTEND:{stamp(t + 900)}", "SUMMARY:" + text(title), "DESCRIPTION:" + text(desc), "END:VEVENT"])
    minute = lambda t: round(t / 60) * 60                 # the plan's reset times wobble by under a second between readings
    for s in snap.get("seats", []):
        if s.get("kind") != "claude":
            continue
        name = (names or {}).get(s["id"]) or s.get("nickname") or s.get("label") or s["id"]
        u, fc = s.get("usage") or {}, s.get("forecast") or {}
        for key, word in (("five_hour", "5-hour window"), ("weekly", "week")):
            w, f = u.get(key) or {}, fc.get(key) or {}
            if w.get("resets_at") and now < w["resets_at"] < now + 8 * 86400:
                event(f"{s['id']}-{key}-reset-{int(minute(w['resets_at']))}", minute(w["resets_at"]), f"{name}: {word} resets", f"{name}'s {word} starts again.")
            if f.get("state") == "runs_out" and f.get("out_at") and now < f["out_at"] < (w.get("resets_at") or now + 8 * 86400):
                event(f"{s['id']}-{key}-out-before-{int(minute(w.get('resets_at') or 0))}", minute(f["out_at"]), f"{name}: {word} runs out (at this pace)",   # one per window: it moves
                      f"At {f.get('per_hour')}% an hour {name}'s {word} runs out before it resets.")
    if not any(line == "BEGIN:VEVENT" for line in out):   # a calendar needs one event at least (RFC 5545)
        event("nothing-due", now, "Claude Office: no plan resets in the next eight days", "Download the calendar again for fresh times.")
    out.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in out) + "\r\n"


def _fold(line: str) -> str:
    """An iCalendar line kept to 75 bytes: longer ones go on as lines that start with a space (RFC 5545 3.1)."""
    parts, cur = [], ""
    for ch in line:
        if len((cur + ch).encode()) > (75 if not parts else 74):
            parts.append(cur); cur = ""
        cur += ch
    return "\r\n ".join(parts + [cur])

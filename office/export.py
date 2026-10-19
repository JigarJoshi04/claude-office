"""Your data out of the office: the days per character, careers, tokens per day and character, lanes and the news, as
CSV or JSON, and a month's report in Markdown for a status update. The page asks for them with the office token (they
carry project and lane names). Share-safe exports leave out titles, reports and news text.
"""
from __future__ import annotations

import calendar
import csv
import io
import json
import time
from datetime import date


WHAT = ("days", "careers", "tokens", "lanes", "events")


def _cell(v):
    """A spreadsheet never runs a cell as a formula: one that starts with = + - @ is quoted."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@"):
        return "'" + v
    return v


def _iso(ts) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts)) if ts else ""


def rows(office, what: str, private: bool = False) -> list[dict]:
    snap = office.get() or {}
    seats = snap.get("seats", [])
    label = {s["id"]: s.get("nickname") or s.get("label") or s["id"] for s in seats}
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
        for l in sorted(snap.get("lanes") or [], key=lambda l: l.get("created_at") or 0):   # the snapshot's (the demo's are made up)
            runs = l.get("runs") or []
            out.append({"id": l["id"], "title": "" if private else l.get("title", ""), "status": l.get("status"), "seat": l.get("seat") or l.get("seat_pref"),
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


def report(office, month: str, private: bool = False) -> str:
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
    label = {s["id"]: s.get("nickname") or s.get("label") or s["id"] for s in seats}
    days = [r for r in rows(office, "days") if inside(r["day"])]
    toks = [r for r in rows(office, "tokens") if inside(r["day"])]
    who: dict = {}
    for r in days:
        e = who.setdefault(r["seat"], {"min": 0, "reports": 0, "sessions": 0, "mvp": 0, "limits": 0})
        e["min"] += r["active_min"]; e["reports"] += r["reports"]; e["sessions"] += r["sessions"]; e["mvp"] += r["mvp"]; e["limits"] += r["limits"]
    tot = {k: sum(e[k] for e in who.values()) for k in ("min", "reports", "sessions", "limits")}
    tk = {k: sum(r[k] for r in toks) for k in ("fresh", "cache_reads", "usd", "commits", "prs_opened", "prs_merged")}
    pr = snap.get("promises") or {}
    settled = [p for p in pr.get("recent") or [] if p.get("settled_at") and inside(time.strftime("%Y-%m-%d", time.localtime(p["settled_at"])))]
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
    out += [f"- **{tot['reports']} reports** filed, **{tot['min'] / 60:.1f} h** of agent work across **{tot['sessions']} sessions**.",
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

"""The morning standup, written from the office's own records: what got done yesterday, what is on today, and what
is blocked. Every line comes from an event, a lane or a Needs-you item (nothing is made up), ready to paste into Slack.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta


def day_bounds(day: str) -> tuple[float, float]:
    start = datetime.fromisoformat(day).timestamp()
    end = (datetime.fromisoformat(day) + timedelta(days=1)).timestamp()
    return start, end


def events_between(path, start: float, end: float) -> list[dict]:
    """The office news of [start, end) from state/events.jsonl."""
    out = []
    try:
        with open(path, "rb") as fh:
            for raw in fh:
                try:
                    e = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(e, dict) and isinstance(e.get("ts"), (int, float)) and start <= e["ts"] < end:
                    out.append(e)
    except OSError:
        pass
    return out


def yesterday_of(now: float) -> str:
    return (datetime.fromtimestamp(now).date() - timedelta(days=1)).isoformat()


def build(snap: dict, ev: list[dict], shipped_yesterday: dict | None, now: float | None = None) -> dict:
    """{"day", "yesterday": [...], "today": [...], "blockers": [...], "text"} for the morning of `now`'s day, from
    yesterday's news `ev`, yesterday's shipped work and the office as it is now."""
    now = now or time.time()
    today = datetime.fromtimestamp(now).date()
    labels = {s["id"]: s.get("label") or s["id"] for s in snap.get("seats", [])}
    yesterday, todo, blockers = [], [], []
    reports = [e for e in ev if e.get("kind") == "report" and e.get("level") == "good"]
    for e in reports[-8:]:
        yesterday.append(e["text"])
    if len(reports) > 8:
        yesterday.append(f"…and {len(reports) - 8} more reports")
    merged = [e["text"] for e in ev if e.get("kind") == "shipped" and e["text"].endswith(" merged")]
    yesterday += merged[-8:]
    sh = shipped_yesterday or {}
    if sh.get("commits") or sh.get("prs_merged"):
        yesterday.append(f"{sh.get('commits', 0)} commit{'' if sh.get('commits') == 1 else 's'}, {sh.get('prs_opened', 0)} PR{'' if sh.get('prs_opened') == 1 else 's'} opened, {sh.get('prs_merged', 0)} merged")
    limits = sum(1 for e in ev if e.get("kind") == "limit")
    if limits:
        yesterday.append("Hit a plan limit once" if limits == 1 else f"Hit a plan limit {limits} times")
    for l in snap.get("lanes", []):
        st = l.get("status")
        if st in ("running", "starting", "queued", "waiting"):
            todo.append(f"Lane '{l.get('title')}' is {st}" + (f" on {labels.get(l.get('seat'), l.get('seat'))}" if l.get("seat") else ""))
        elif st == "scheduled":
            at = (l.get("schedule") or {}).get("at")
            todo.append(f"Lane '{l.get('title')}' starts " + (time.strftime("%H:%M", time.localtime(at)) if at else "when a seat has room"))
    for s in snap.get("seats", []):
        for x in s.get("sessions", []):
            if x.get("live", True) and x.get("kind") == "desk" and x.get("state") in ("working", "waiting"):
                todo.append(f"{x.get('name')} on {labels.get(s['id'])}: {x.get('title') or x.get('task') or x.get('activity') or 'at work'}")
    for a in snap.get("attention", []):
        if a.get("level") in ("bad", "warn") and (a.get("ask") or a.get("lane") or a.get("interrupted") or "blocked" in (a.get("text") or "")
                                              or a.get("ci") or "out of plan" in (a.get("text") or "") or a.get("grouped")):
            blockers.append(a.get("text") or "")
    lines = [f"*Standup, {today.strftime('%a %d %b')}*", "", "*Yesterday*"]
    lines += [f"• {x}" for x in yesterday] or ["• A quiet day"]
    lines += ["", "*Today*"] + ([f"• {x}" for x in todo[:12]] or ["• Nothing running yet"])
    lines += ["", "*Blockers*"] + ([f"• {x}" for x in blockers[:8]] or ["• None"])
    return {"day": today.isoformat(), "yesterday": yesterday, "today": todo[:12], "blockers": blockers[:8], "text": "\n".join(lines)}

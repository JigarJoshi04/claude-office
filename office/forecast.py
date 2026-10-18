"""The next seven days of plan: for every Claude seat, when its weekly plan resets and, at this week's pace so far,
when it runs dry before that; and the stretches when no seat on duty could take work. The pace is the week's use so
far spread over the time gone (a straight line, the same as Par for the week): it says where today's habits lead,
not what will happen, so the page shows it as a projection.
"""
from __future__ import annotations

WEEK = 7 * 86400
HORIZON = 7 * 86400


def seat_capacity(s: dict, now: float, guard: float = 95.0) -> dict | None:
    """{seat, resets_at, out_at, out_now, benched} for one Claude seat, or None without a weekly reading."""
    wk = (s.get("usage") or {}).get("weekly") or {}
    pct, resets = wk.get("pct"), wk.get("resets_at")
    if s.get("kind") != "claude" or not isinstance(pct, (int, float)) or not isinstance(resets, (int, float)):
        return None
    benched = not (s.get("divider") or {}).get("enabled", True) or s.get("status") in ("benched", "offline")
    out_now = pct >= guard or (s.get("status") == "limited" and pct >= 99)
    out_at = None
    if not out_now and pct > 0:
        starts = resets - WEEK
        gone = max(1.0, now - starts)
        t = starts + gone * guard / pct            # when the straight line from the week's start reaches the guard
        if now < t < resets:
            out_at = t
    return {"seat": s["id"], "resets_at": resets, "out_at": now if out_now else out_at, "out_now": out_now, "benched": benched, "pct": pct}


def dry_spells(caps: list[dict], now: float, horizon: float = HORIZON) -> list[list[float]]:
    """[from, to] stretches within the horizon when every on-duty seat is out (from its run-out to its reset)."""
    duty = [c for c in caps if not c["benched"]]
    if not duty:
        return []
    out = []
    for c in duty:
        if c["out_at"] is None:
            return []                                   # a seat that lasts the week: never dry before its reset
    lo = max(c["out_at"] for c in duty)                 # the last seat to run out
    hi = min(c["resets_at"] for c in duty)              # the first seat to get its week back
    if lo < hi and lo < now + horizon:
        out.append([max(lo, now), min(hi, now + horizon)])
    return out


def capacity(seats: list[dict], now: float, guard: float = 95.0) -> dict:
    caps = [c for c in (seat_capacity(s, now, guard) for s in seats) if c]
    return {"now": now, "horizon": HORIZON, "seats": caps, "dry": dry_spells(caps, now)}

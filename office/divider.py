"""The load divider: how the CEO splits new work across seats, and the rule that picks the next seat.

A seat gets the next lane when it is on duty, healthy, under its lane cap, below the usage guards, outside the
hours it is kept free, and furthest below its target share of the running lanes. In "headroom" mode the target share
is scaled by how much of the plan the seat has left, so a seat that is nearly out naturally gets less. In "pace" mode
it is scaled by how far the seat's week is from being spent evenly: a seat with half its week left and three days to
go is on pace, one with 60% left and a day to go gets more (use it or lose it), one ahead of pace gets less. A lane
that names its model is also kept off a seat whose week for that model (Opus, say) is past the weekly guard.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from . import config

DEFAULT_SEAT = {"enabled": True, "weight": 25, "max_lanes": 2, "note": "", "free_hours": None}   # [from, to] local hours
WEEK = 7 * 86400
FAMILIES = ("opus", "sonnet", "haiku", "fable")
DEFAULTS = {
    "mode": "headroom",          # "fixed" = honour weights exactly; "headroom" = weights x plan left; "pace" = x week pace
    "global_max_lanes": 4,
    "five_hour_guard": 90,       # no new lane on a seat at or above this % of its 5-hour window
    "weekly_guard": 90,          # ... or of its weekly allowance
    "seats": {},
    "updated_at": None,
}


def path() -> Path:
    return config.CONFIG_DIR / "divider.json"


def load(seat_ids: list[str]) -> dict:
    try:
        raw = json.loads(path().read_text())
    except (OSError, ValueError):
        raw = {}
    out = dict(DEFAULTS, **{k: v for k, v in raw.items() if k in DEFAULTS})
    seats = {}
    for sid in seat_ids:
        seats[sid] = dict(DEFAULT_SEAT, **(raw.get("seats", {}).get(sid) or {}))
    out["seats"] = seats
    return out


def validate(body: dict, seat_ids: list[str]) -> dict:
    """Clamp everything a page can send into sane ranges; unknown keys and wrong shapes are dropped."""
    if not isinstance(body, dict):
        body = {}
    out = dict(DEFAULTS)
    mode = body.get("mode")
    out["mode"] = mode if mode in ("fixed", "headroom", "pace") else DEFAULTS["mode"]
    out["global_max_lanes"] = _clamp_int(body.get("global_max_lanes"), 0, 32, DEFAULTS["global_max_lanes"])
    out["five_hour_guard"] = _clamp_int(body.get("five_hour_guard"), 10, 100, DEFAULTS["five_hour_guard"])
    out["weekly_guard"] = _clamp_int(body.get("weekly_guard"), 10, 100, DEFAULTS["weekly_guard"])
    seats = {}
    given = body.get("seats") if isinstance(body.get("seats"), dict) else {}
    for sid in seat_ids:
        s = given.get(sid) if isinstance(given.get(sid), dict) else {}
        seats[sid] = {
            "enabled": bool(s.get("enabled", True)),
            "weight": _clamp_int(s.get("weight"), 0, 100, DEFAULT_SEAT["weight"]),
            "max_lanes": _clamp_int(s.get("max_lanes"), 0, 16, DEFAULT_SEAT["max_lanes"]),
            "note": str(s.get("note") or "")[:200],
            "free_hours": _hours(s.get("free_hours")),
        }
    out["seats"] = seats
    out["updated_at"] = time.time()
    return out


def save(cfg: dict) -> None:
    config.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path().with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2))
    tmp.replace(path())


def _clamp_int(v, lo, hi, default):
    if isinstance(v, bool):
        return default
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError, OverflowError):
        return default


def _hours(v) -> list[int] | None:
    """[from, to] whole local hours (0-24, from != to, wrapping past midnight when to < from), or None."""
    if not isinstance(v, (list, tuple)) or len(v) != 2 or any(isinstance(h, bool) or not isinstance(h, int) for h in v):
        return None
    a, b = v
    return [a, b] if 0 <= a <= 23 and 1 <= b <= 24 and a != b else None


def kept_free(hours, now: float) -> float | None:
    """When a seat's free hours end (epoch) if `now` is inside them, else None."""
    if not hours:
        return None
    a, b = hours
    lt = time.localtime(now)
    h = lt.tm_hour + lt.tm_min / 60
    inside = a <= h < b if a < b else (h >= a or h < b % 24)
    if not inside:
        return None
    end = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, b % 24, 0, 0, 0, 0, -1))
    return end if end > now else end + 86400


def pace(seat: dict, now: float) -> float | None:
    """The week's plan left per share of the week left: 1 is on pace to spend it evenly, 2 means twice the even rate
    would use it all before it resets, 0 is spent. None without a weekly reading."""
    w = (seat.get("usage") or {}).get("weekly") or {}
    pct, resets = w.get("pct"), w.get("resets_at")
    if not isinstance(pct, (int, float)) or not isinstance(resets, (int, float)):
        return None
    left_t = min(1.0, max(0.02, (resets - now) / WEEK))
    return max(0.0, min(3.0, (100.0 - pct) / 100.0 / left_t))


def family(model: str | None) -> str | None:
    m = (model or "").lower()
    return next((f for f in FAMILIES if f in m), None)


def headroom(seat: dict) -> float:
    """0..1: the smaller of what is left in the 5-hour window and the week. Unknown usage counts as half."""
    u = seat.get("usage") or {}
    left = []
    for key in ("five_hour", "weekly"):
        w = u.get(key)
        if w and w.get("pct") is not None:
            left.append(max(0.0, 100.0 - w["pct"]) / 100.0)
    return min(left) if left else 0.5


def _pct(seat: dict, key: str) -> float | None:
    w = (seat.get("usage") or {}).get(key)
    return w.get("pct") if w else None


def evaluate(seats: list[dict], cfg: dict, kind: str | None = None, exclude: tuple = (),
             limited_until: dict | None = None, now: float | None = None, model: str | None = None) -> dict:
    """Rank every seat for the next lane. ``seats`` are snapshot seats (with usage, health, lanes count)."""
    now = now or time.time()
    limited_until = limited_until or {}
    total_lanes = sum(s.get("lanes", 0) for s in seats)
    enabled_weight = sum(cfg["seats"].get(s["id"], DEFAULT_SEAT)["weight"] for s in seats
                         if cfg["seats"].get(s["id"], DEFAULT_SEAT)["enabled"]) or 1
    # In headroom mode each share is scaled by the plan left, then renormalised so the shares still sum to 1.
    scaled = {}
    for s in seats:
        sc = cfg["seats"].get(s["id"], DEFAULT_SEAT)
        w = sc["weight"] / enabled_weight if sc["enabled"] else 0.0
        if cfg["mode"] == "pace":                    # the week's pace, still within what the 5-hour window allows
            p5 = _pct(s, "five_hour")
            pc = pace(s, now)
            scaled[s["id"]] = w * (1.0 if pc is None else pc) * ((100.0 - p5) / 100.0 if p5 is not None else 1.0)
        else:
            scaled[s["id"]] = w * (headroom(s) if cfg["mode"] == "headroom" else 1.0)
    scaled_total = sum(scaled.values()) or 1.0
    rows = []
    for s in seats:
        sc = cfg["seats"].get(s["id"], DEFAULT_SEAT)
        lanes = s.get("lanes", 0)
        share = sc["weight"] / enabled_weight if sc["enabled"] else 0.0
        blockers = []
        if kind and s.get("kind") != kind:
            blockers.append(f"not a {kind} seat")
        if s["id"] in exclude:
            blockers.append("excluded")
        if not sc["enabled"]:
            blockers.append("benched")
        elif sc["weight"] <= 0:
            blockers.append("weight 0")
        if (s.get("health") or {}).get("state") == "login":
            blockers.append("needs /login")
        if lanes >= sc["max_lanes"]:
            blockers.append(f"at its cap ({lanes}/{sc['max_lanes']} lanes)")
        p5, pw = _pct(s, "five_hour"), _pct(s, "weekly")
        if p5 is not None and p5 >= cfg["five_hour_guard"]:
            blockers.append(f"5-hour window at {p5:.0f}%")
        if pw is not None and pw >= cfg["weekly_guard"]:
            blockers.append(f"weekly at {pw:.0f}%")
        fam = family(model)
        for sc_lim in (s.get("usage") or {}).get("scoped") or []:     # the model's own weekly cap (Opus, say)
            if fam and fam in str(sc_lim.get("label") or "").lower() and (sc_lim.get("pct") or 0) >= cfg["weekly_guard"]:
                blockers.append(f"its {sc_lim['label']} week at {sc_lim['pct']:.0f}%")
        free = kept_free(sc.get("free_hours"), now)
        if free:
            blockers.append("kept free for you until " + time.strftime("%H:%M", time.localtime(free)))
        lu = limited_until.get(s["id"], 0)
        if lu > now:
            blockers.append("hit its limit, resting until " + time.strftime("%H:%M", time.localtime(lu)))
        hr = headroom(s)
        target = scaled[s["id"]] / scaled_total
        # Expected lanes at this share once one more lane runs, minus what it already runs.
        deficit = target * (total_lanes + 1) - lanes
        pc = pace(s, now)
        rows.append({"seat": s["id"], "eligible": not blockers, "blockers": blockers, "share": round(share, 3),
                     "target": round(target, 3), "pace": None if pc is None else round(pc, 2),
                     "headroom": round(hr, 3), "lanes": lanes, "max_lanes": sc["max_lanes"],
                     "score": round(deficit, 4)})
    if total_lanes >= cfg["global_max_lanes"]:
        for r in rows:
            if r["eligible"]:
                r["eligible"] = False
                r["blockers"].append(f"office at its lane cap ({total_lanes}/{cfg['global_max_lanes']})")
    ranked = sorted(rows, key=lambda r: (not r["eligible"], -r["score"], -r["headroom"], r["lanes"]))
    pick = ranked[0] if ranked and ranked[0]["eligible"] else None
    if pick:
        why = (f"{pick['seat']}: target share {pick['target'] * 100:.0f}%, runs {pick['lanes']} of "
               f"{total_lanes} lanes, {pick['headroom'] * 100:.0f}% of its plan left")
        if cfg["mode"] == "pace" and pick["pace"] is not None:
            why += ", " + pace_words(pick["pace"])
    else:
        why = "No seat can take a lane: " + "; ".join(f"{r['seat']} {', '.join(r['blockers'])}" for r in rows)
    resets = [w.get("resets_at") for s in seats for w in ((s.get("usage") or {}).get("five_hour") or {},)
              if w.get("resets_at")]
    return {"pick": pick["seat"] if pick else None, "why": why, "ranking": ranked,
            "next_reset": min(resets) if resets else None}


def pace_words(p: float) -> str:
    """How a seat's week stands, in words: "on pace", "1.6× behind its week", "ahead of its week"."""
    if p <= 0:
        return "its week spent"
    if 0.85 <= p <= 1.15:
        return "on pace for its week"
    return f"{p:.1f}× behind its week (use it or lose it)" if p > 1 else "ahead of its week"


def suggest(seats: list[dict], cfg: dict) -> dict:
    """Weights proportional to what each on-duty, healthy seat has left. Benched seats stay at zero."""
    raw = {}
    for s in seats:
        sc = cfg["seats"].get(s["id"], DEFAULT_SEAT)
        ok = sc["enabled"] and (s.get("health") or {}).get("state") != "login"
        raw[s["id"]] = headroom(s) if ok else 0.0
    total = sum(raw.values())
    if total <= 0:
        return {sid: 0 for sid in raw}
    weights = {sid: int(round(v / total * 100)) for sid, v in raw.items()}
    drift = 100 - sum(weights.values())
    if drift and weights:
        top = max(weights, key=lambda k: raw[k])
        weights[top] += drift
    return weights

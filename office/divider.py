"""The load divider: how the CEO splits new work across seats, and the rule that picks the next seat.

A seat gets the next lane when it is on duty, healthy, under its lane cap, below the usage guards, and furthest
below its target share of the running lanes. In "headroom" mode the target share is scaled by how much of the
plan the seat has left, so a seat that is nearly out naturally gets less.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from . import config

DEFAULT_SEAT = {"enabled": True, "weight": 25, "max_lanes": 2, "note": ""}
DEFAULTS = {
    "mode": "headroom",          # "fixed" = honour weights exactly; "headroom" = weights x plan left
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
    out["mode"] = mode if mode in ("fixed", "headroom") else DEFAULTS["mode"]
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
             limited_until: dict | None = None, now: float | None = None) -> dict:
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
        lu = limited_until.get(s["id"], 0)
        if lu > now:
            blockers.append("hit its limit, resting until " + time.strftime("%H:%M", time.localtime(lu)))
        hr = headroom(s)
        target = scaled[s["id"]] / scaled_total
        # Expected lanes at this share once one more lane runs, minus what it already runs.
        deficit = target * (total_lanes + 1) - lanes
        rows.append({"seat": s["id"], "eligible": not blockers, "blockers": blockers, "share": round(share, 3),
                     "target": round(target, 3),
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
    else:
        why = "No seat can take a lane: " + "; ".join(f"{r['seat']} {', '.join(r['blockers'])}" for r in rows)
    resets = [w.get("resets_at") for s in seats for w in ((s.get("usage") or {}).get("five_hour") or {},)
              if w.get("resets_at")]
    return {"pick": pick["seat"] if pick else None, "why": why, "ranking": ranked,
            "next_reset": min(resets) if resets else None}


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

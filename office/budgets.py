"""Budgets: a ceiling on API value (USD at list prices) or fresh tokens, for the office or one seat, per day, week
(Monday to Sunday) or calendar month, from the token ledger's per-day sums. Warned at 80%, over at 100%. They only
watch: nothing is stopped when one is spent.

config "budgets": [{"scope": "office" | "seat:<id>", "period": "day" | "week" | "month", "usd": 50} or {..., "tokens": 2000000}]
"""
from __future__ import annotations

from datetime import date, timedelta

PERIODS = ("day", "week", "month")
MAX = 12
WARN, OVER = 80, 100


def validate(items, seat_ids=None) -> list[dict]:
    if not isinstance(items, list) or len(items) > MAX:
        raise ValueError(f"budgets must be a list of at most {MAX}")
    out = []
    for b in items:
        if not isinstance(b, dict):
            raise ValueError("A budget is an object")
        scope, period = b.get("scope"), b.get("period")
        if not (scope == "office" or (isinstance(scope, str) and scope.startswith("seat:") and (seat_ids is None or scope[5:] in seat_ids))):
            raise ValueError("A budget's scope is office or seat:<a seat id>")
        if period not in PERIODS:
            raise ValueError("A budget's period is day, week or month")
        usd, tokens = b.get("usd"), b.get("tokens")
        if (usd is None) == (tokens is None):
            raise ValueError("A budget is in usd or in tokens, one of them")
        if usd is not None and (type(usd) not in (int, float) or not 0 < usd <= 1e6):
            raise ValueError("A budget in usd is more than 0 and at most 1,000,000")
        if tokens is not None and (type(tokens) is not int or not 0 < tokens <= 10**12):
            raise ValueError("A budget in tokens is a whole number more than 0")
        out.append({"scope": scope, "period": period, **({"usd": float(usd)} if usd is not None else {"tokens": tokens})})
    return out


def _start(today: date, period: str) -> date:
    if period == "day":
        return today
    if period == "week":
        return today - timedelta(days=today.weekday())
    return today.replace(day=1)


def evaluate(items, per_day_seat: dict, today: date, names: dict | None = None) -> list[dict]:
    """Each budget now: {id, label, scope, period, unit, limit, used, pct, state (ok, warn or over), since}.
    per_day_seat is TokenLedger.per_day_seat: {(day, seat or None): [fresh, cache, output, usd, ...]}."""
    out = []
    for i, b in enumerate(items or []):
        if not isinstance(b, dict) or b.get("period") not in PERIODS:
            continue
        since = _start(today, b["period"]).isoformat()
        seat = b["scope"][5:] if str(b.get("scope", "")).startswith("seat:") else None
        unit = "usd" if b.get("usd") is not None else "tokens"
        idx = 3 if unit == "usd" else 0
        used = sum(v[idx] for (day, sid), v in per_day_seat.items() if since <= day <= today.isoformat() and (seat is None or sid == seat))
        limit = b.get("usd") if unit == "usd" else b.get("tokens")
        if not limit:
            continue
        pct = round(used / limit * 100, 1)
        who = "The office" if seat is None else (names or {}).get(seat, seat)
        word = {"day": "today", "week": "this week", "month": "this month"}[b["period"]]
        out.append({"id": f"{b['scope']}|{b['period']}|{unit}", "label": f"{who}, {word}", "scope": b["scope"], "period": b["period"], "unit": unit,
                    "limit": limit, "used": round(used, 2) if unit == "usd" else int(used), "pct": pct, "since": since,
                    "state": "over" if pct >= OVER else "warn" if pct >= WARN else "ok"})
    return out

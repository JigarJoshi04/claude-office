"""What the tokens would have cost at API list prices, and what the plans cost.

The seats are on plans, so nobody paid these prices: the value says what the same work would have cost on the API,
which is how a plan earns its keep. Prices are USD per million tokens, from Anthropic's and OpenAI's public pricing
pages (October 2026): (base input, 5-minute cache write, 1-hour cache write, cache read, output). Server tools (web
search, web fetch) are billed per use and are left out; only tokens are priced.
"""
from __future__ import annotations

_OPUS_45 = (5, 6.25, 10, 0.5, 25)
_OPUS_41 = (15, 18.75, 30, 1.5, 75)
_SONNET_45 = (3, 3.75, 6, 0.3, 15)
PRICES = {
    "claude-fable-5-1": (10, 12.5, 20, 0.25, 50),
    "claude-mythos-5-1": (10, 12.5, 20, 0.25, 50),
    "claude-fable-5": (10, 12.5, 20, 1, 50),
    "claude-mythos-5": (10, 12.5, 20, 1, 50),
    "claude-opus-5-5": (4, 5, 8, 0.2, 20),
    "claude-opus-5": _OPUS_45,
    "claude-opus-4-8": _OPUS_45, "claude-opus-4-7": _OPUS_45, "claude-opus-4-6": _OPUS_45, "claude-opus-4-5": _OPUS_45,
    "claude-opus-4-1": _OPUS_41, "claude-opus-4": _OPUS_41,
    "claude-sonnet-5-5": (2, 2.5, 4, 0.1, 10),
    "claude-sonnet-5": (2, 2.5, 4, 0.2, 10),
    "claude-sonnet-4-6": _SONNET_45, "claude-sonnet-4-5": _SONNET_45, "claude-sonnet-4": _SONNET_45,
    "claude-haiku-5-5": (0.1, 0.125, 0.2, 0.01, 0.5),
    "claude-haiku-4-5": (1, 1.25, 2, 0.1, 5),
    "claude-3-5-haiku": (0.8, 1, 1.6, 0.08, 4), "claude-haiku-3-5": (0.8, 1, 1.6, 0.08, 4),
    "gpt-6-astra": (10, 12.5, 12.5, 1, 50),
    "codex": (10, 12.5, 12.5, 1, 50),               # the ledger's name for the Codex seat's model (gpt-6-astra)
}
HAIKU_55_LONG = (0.5, 0.625, 1, 0.05, 2.5)          # Claude Haiku 5.5 with a prompt over 100 000 tokens
FAST = ("claude-opus-5-5", "claude-opus-5", "claude-opus-4-8")   # fast mode doubles every rate
OLD_GEO = ("claude-opus-4-5", "claude-opus-4-1", "claude-opus-4", "claude-sonnet-4-5", "claude-sonnet-4", "claude-haiku-4-5", "claude-3-5-haiku", "claude-haiku-3-5")
# What a plan costs a month (USD), by the tier Claude Code reports; anything else is set per seat in Settings.
PLAN_USD = {"Pro": 20, "Max 5x": 100, "Max 20x": 200}
_KEYS = sorted(PRICES, key=len, reverse=True)       # longest first: claude-opus-5-5 before claude-opus-5


def base_model(model: str | None) -> str | None:
    """The price-table name for a model id ("claude-haiku-4-5-20251001" -> "claude-haiku-4-5"), or None if unpriced."""
    m = (model or "").lower()
    for k in _KEYS:
        if m == k or (m.startswith(k + "-") and m[len(k) + 1:len(k) + 2].isdigit() and len(m) - len(k) - 1 >= 8):
            return k
    return None


def rates(model: str | None):
    k = base_model(model)
    return PRICES[k] if k else None


def response_cost(model: str | None, u: dict) -> int | None:
    """One API response's list price in micro-dollars, from its usage block; None for a model with no price."""
    k = base_model(model)
    if not k:
        return None
    n = lambda key, d=u: int((d or {}).get(key) or 0)
    inp, read, write, out = n("input_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens"), n("output_tokens")
    split = u.get("cache_creation") if isinstance(u.get("cache_creation"), dict) else {}
    w1 = n("ephemeral_1h_input_tokens", split)
    w5 = n("ephemeral_5m_input_tokens", split) if "ephemeral_5m_input_tokens" in split else max(0, write - w1)
    p = HAIKU_55_LONG if k == "claude-haiku-5-5" and inp + read + write > 100_000 else PRICES[k]
    usd = (inp * p[0] + w5 * p[1] + w1 * p[2] + read * p[3] + out * p[4]) / 1e6
    if u.get("speed") == "fast" and k in FAST:
        usd *= 2
    if u.get("inference_geo") == "us" and k.startswith("claude") and k not in OLD_GEO:
        usd *= 1.1
    return round(usd * 1e6)


def estimate(model: str | None, fresh: float, cache: float, output: float) -> float | None:
    """A list price in USD from stored totals, for sessions counted before costs were kept: fresh input priced as
    5-minute cache writes for Claude (Claude Code caches nearly every prompt) and as input for Codex."""
    p = rates(model)
    if not p:
        return None
    first = p[0] if base_model(model) in ("codex", "gpt-6-astra") else p[1]
    return (max(0, fresh - output) * first + cache * p[3] + output * p[4]) / 1e6


def plan_usd(seat: dict) -> float | None:
    """A seat's plan cost a month: set in Settings, or the list price of its tier, or None when unknown."""
    if isinstance(seat.get("plan_usd"), (int, float)):
        return float(seat["plan_usd"])
    return PLAN_USD.get((seat.get("health") or {}).get("tier"))

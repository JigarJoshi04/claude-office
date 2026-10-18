"""Claude seats: who is logged in, how healthy the login is, and how much of the plan is left.

Tokens are read from disk at the moment of a usage call and never stored, logged or returned. The office never
refreshes a token itself: a refresh rotates the refresh token and would race the Claude Code CLI that owns it.
When the access token has expired the office shows the last usage it saw and marks it stale; the next Claude
run on that seat refreshes the login.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import config, egress

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
TIER_NAMES = {
    "default_claude_max_5x": "Max 5x",
    "default_claude_max_20x": "Max 20x",
    "default_claude_pro": "Pro",
}


def _read_json(path: str | Path) -> dict:
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}


def credential_meta(config_dir: str, now: float | None = None) -> dict:
    """Login health without exposing any secret."""
    now = now or time.time()
    oauth = _read_json(Path(config_dir) / ".credentials.json").get("claudeAiOauth") or {}
    exp = (oauth.get("expiresAt") or 0) / 1000
    rexp = (oauth.get("refreshTokenExpiresAt") or 0) / 1000
    has_access = bool(oauth.get("accessToken"))
    has_refresh = bool(oauth.get("refreshToken"))
    if not oauth or not has_access:
        state, detail = "login", "Not logged in"
    elif exp > now + 60:
        state, detail = "ok", "Logged in"
    elif has_refresh and (rexp == 0 or rexp > now):
        state, detail = "stale", "Login refreshes on the next run"
    else:
        state, detail = "login", "Login expired: run /login on this seat"
    tier = oauth.get("rateLimitTier")
    return {
        "state": state,
        "detail": detail,
        "subscription": oauth.get("subscriptionType"),
        "tier": TIER_NAMES.get(tier, tier),
        "access_expires_at": exp or None,
        "refresh_expires_at": rexp or None,
    }


def account_meta(account_file: str) -> dict:
    acct = _read_json(account_file).get("oauthAccount") or {}
    return {
        "email": acct.get("emailAddress"),
        "name": acct.get("displayName"),
        "org": acct.get("organizationName"),
        "role": acct.get("organizationRole"),
    }


def _iso_epoch(s: str | None) -> float | None:
    if not s:
        return None
    from datetime import datetime
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def parse_usage(body: dict) -> dict:
    def window(key: str) -> dict | None:
        w = body.get(key)
        if not isinstance(w, dict) or w.get("utilization") is None:
            return None
        return {"pct": float(w["utilization"]), "resets_at": _iso_epoch(w.get("resets_at"))}

    scoped = []
    for lim in body.get("limits") or []:
        if lim.get("kind") in ("session", "weekly_all"):
            continue
        model = ((lim.get("scope") or {}).get("model") or {})
        label = model.get("display_name") or model.get("id") or lim.get("kind")
        if lim.get("percent"):
            scoped.append({"label": label, "pct": float(lim["percent"]), "resets_at": _iso_epoch(lim.get("resets_at"))})
    return {"five_hour": window("five_hour"), "weekly": window("seven_day"), "scoped": scoped}


class UsagePoller:
    """Polls each seat's plan usage on its own thread; readers get the cached copy instantly."""

    def __init__(self, seats: list[dict], interval: float = 150.0):
        self.seats = seats
        self.interval = interval
        self._cache: dict[str, dict] = {}
        self._next: dict[str, float] = {}
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._path = config.STATE_DIR / "usage-cache.json"
        cached = _read_json(self._path)
        if isinstance(cached, dict):
            self._cache.update(cached)

    def get(self, seat_id: str) -> dict | None:
        with self._lock:
            u = self._cache.get(seat_id)
            return dict(u) if u else None

    def poke(self, seat_id: str | None = None) -> None:
        """Ask for a fresh read on the next loop (e.g. after a seat was woken)."""
        with self._lock:
            for s in self.seats:
                if seat_id in (None, s["id"]):
                    self._next[s["id"]] = 0
        self._wake.set()

    def _fetch(self, seat: dict) -> dict:
        oauth = _read_json(Path(seat["config_dir"]) / ".credentials.json").get("claudeAiOauth") or {}
        if not oauth.get("accessToken") or (oauth.get("expiresAt") or 0) / 1000 < time.time() + 30:
            return {"error": "login stale"}
        req = urllib.request.Request(USAGE_URL, headers={
            "Authorization": "Bearer " + oauth["accessToken"],
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "claude-office/1.0",
        })
        try:
            with urllib.request.urlopen(req, timeout=12) as r:
                out = {"data": parse_usage(json.loads(r.read()))}
            egress.note("usage")
            return out
        except urllib.error.HTTPError as e:
            egress.note("usage", ok=False)
            return {"error": f"HTTP {e.code}", "status": e.code}
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
            egress.note("usage", ok=False)
            return {"error": type(e).__name__}

    def tick(self) -> None:
        now = time.time()
        changed = False
        for seat in self.seats:
            if self._next.get(seat["id"], 0) > now:
                continue
            res = self._fetch(seat)
            with self._lock:
                prev = self._cache.get(seat["id"]) or {}
                if "data" in res:
                    self._cache[seat["id"]] = dict(res["data"], fetched_at=now, error=None)
                    self._next[seat["id"]] = now + self.interval
                    changed = True
                else:
                    self._cache[seat["id"]] = dict(prev, error=res["error"], tried_at=now)
                    # Back off hard on rate limiting; retry a stale login every few minutes in case the CLI refreshed it.
                    back = 900 if res.get("status") == 429 else 180
                    self._next[seat["id"]] = now + back
        if changed:
            try:
                config.STATE_DIR.mkdir(parents=True, exist_ok=True)
                with self._lock:
                    self._path.write_text(json.dumps(self._cache))
            except OSError:
                pass

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self.tick()
            except Exception:  # never let one bad response kill the poller
                pass
            self._wake.wait(10)
            self._wake.clear()


def usage_view(raw: dict | None, now: float | None = None) -> dict | None:
    """What the page shows: drop windows whose reset already passed (that usage is gone)."""
    if not raw:
        return None
    now = now or time.time()
    out = {"fetched_at": raw.get("fetched_at"), "error": raw.get("error"), "scoped": raw.get("scoped") or []}
    age = now - (raw.get("fetched_at") or 0)
    out["stale"] = age > 900
    for key in ("five_hour", "weekly"):
        w = raw.get(key)
        if w and w.get("resets_at") and w["resets_at"] < now:
            w = {"pct": 0.0, "resets_at": None, "reset_since_read": True}
        out[key] = w
    return out

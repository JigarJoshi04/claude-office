"""The office doctor: a page of health checks, each with what it found and what to do about it.

Everything here is read from what the office already knows (the snapshot, the token ledger, the config) or from cheap
local checks (free disk, whether systemd and gh are there). Nothing is changed and nothing leaves the machine.
"""
from __future__ import annotations

import shutil
import sys
import time

from . import config


def _check(name: str, state: str, detail: str, fix: str | None = None) -> dict:
    return {"name": name, "state": state, "detail": detail, "fix": fix}


def checkup(office, snap: dict) -> list[dict]:
    now = time.time()
    out = []
    cfg = getattr(office, "cfg", {}) or {}
    if cfg.get("config_error"):
        out.append(_check("Config", "bad", cfg["config_error"], "Fix the JSON in ~/.config/claude-office/config.json, or move it aside to start fresh."))
    else:
        out.append(_check("Config", "ok", "config.json reads cleanly"))
    seats = snap.get("seats", [])
    claude = [s for s in seats if s.get("kind") == "claude"]
    if not seats:
        out.append(_check("Seats", "bad", "No seats found", "Log in with `claude` (or `CLAUDE_CONFIG_DIR=~/.claude2 claude` for a second account)."))
    for s in claude:
        h, u = s.get("health") or {}, s.get("usage") or {}
        name = f"{s.get('label', s['id'])}"
        if h.get("state") == "login":
            out.append(_check(f"{name}: login", "bad", h.get("detail") or "Logged out", f"Run `CLAUDE_CONFIG_DIR={s.get('config_dir')} claude`, then /login."))
        elif h.get("refresh_expires_at") and h["refresh_expires_at"] - now < 3 * 86400:
            out.append(_check(f"{name}: login", "warn", "The login lapses within three days", f"Run /login on it soon (CLAUDE_CONFIG_DIR={s.get('config_dir')} claude)."))
        else:
            out.append(_check(f"{name}: login", "ok", h.get("detail") or "Logged in"))
        if u.get("error"):
            out.append(_check(f"{name}: plan usage", "warn", f"The last reading failed ({u['error']})",
                              "It retries on its own; a login that went stale refreshes the next time Claude Code runs on that seat."))
        elif u.get("stale"):
            out.append(_check(f"{name}: plan usage", "warn", "The reading is more than 15 minutes old", "Use the seat once, or wait: the office reads it every few minutes."))
        elif u.get("fetched_at"):
            out.append(_check(f"{name}: plan usage", "ok", f"Read {round((now - u['fetched_at']) / 60)} min ago"))
    led = getattr(office, "tokens", None)
    if led is not None:
        if getattr(led, "_serve", None) is not None:
            out.append(_check("Token ledger", "warn", "Counting again from the transcripts after an update", "Nothing to do: it shows the old numbers until it is done."))
        elif led.scanned_at:
            out.append(_check("Token ledger", "ok", f"{len(led.data['sessions']):,} sessions counted, read {round((now - led.scanned_at) / 60)} min ago"))
        else:
            out.append(_check("Token ledger", "warn", "Reading the transcripts for the first time", "Nothing to do: it takes about half a minute."))
    try:
        free = shutil.disk_usage(config.STATE_DIR).free
        out.append(_check("Disk", "bad" if free < 1e9 else "warn" if free < 5e9 else "ok", f"{free / 1e9:.1f} GB free where the office keeps its state",
                          "Free some space: the history and the ledger stop saving when the disk is full." if free < 5e9 else None))
    except OSError:
        pass
    out.append(_check("Lanes", "ok" if shutil.which("systemd-run") else "warn",
                      "systemd can run office lanes" if shutil.which("systemd-run") else "systemd-run is missing: office lanes cannot start",
                      None if shutil.which("systemd-run") else "Office lanes need a Linux machine with systemd user services."))
    gh = shutil.which("gh")
    out.append(_check("GitHub CLI", "ok" if gh else "info", "gh is installed: the PR shelf and CI lamps work" if gh else "gh is not installed",
                      None if gh else "Install the GitHub CLI and run `gh auth login` for the PR shelf and the CI lamps."))
    stuck = [l for l in snap.get("lanes", []) if l.get("status") == "waiting" and now - (l.get("created_at") or now) > 6 * 3600]
    if stuck:
        out.append(_check("Waiting lanes", "warn", f"{len(stuck)} lane{'s have' if len(stuck) > 1 else ' has'} waited more than 6 hours for a seat",
                          "Check the divider (benched seats, weights) or stop the lanes you no longer need."))
    out.append(_check("Version", "ok", f"Claude Office {snap.get('office', {}).get('version', '?')} on Python {sys.version.split()[0]}"))
    order = {"bad": 0, "warn": 1, "info": 2, "ok": 3}
    return sorted(out, key=lambda c: order.get(c["state"], 4))

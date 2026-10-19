"""The office doctor: a page of health checks, each with what it found and what to do about it.

Everything here is read from what the office already knows (the snapshot, the token ledger, the config) or from cheap
local checks (free disk, whether systemd and gh are there). Nothing is changed and nothing leaves the machine.
"""
from __future__ import annotations

import shutil
import sys
import threading
import time

from . import config, sdnotify


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
    broken = sorted(p.name for p in config.STATE_DIR.glob("*.broken-*"))
    if broken:
        out.append(_check("Damaged files", "warn", f"{len(broken)} state file{'s were' if len(broken) > 1 else ' was'} damaged and set aside: {', '.join(broken[:3])}",
                          "The office started that file fresh. To go back a day: stop the office, run `python3 -m office restore <day>`, start it again."))
    days = sorted(p.name for p in (config.STATE_DIR / "backups").glob("*") if p.is_dir()) if (config.STATE_DIR / "backups").is_dir() else []
    out.append(_check("Backups", "ok" if days else "info", f"{len(days)} daily backup{'s' if len(days) != 1 else ''} of the state files, the latest {days[-1]}" if days
                      else "No backup yet: the first one is made within a minute of starting", None))
    cp = getattr(office, "_auto_cp", 0)
    if cp:
        out.append(_check("Hourly checkpoint", "ok", f"resume-latest.sh written {round((now - cp) / 60)} min ago: after a restart, `sh` it to reopen your terminal sessions in tmux"))
    cut = [l for l in snap.get("lanes", []) if l.get("status") == "interrupted"]
    if cut:
        out.append(_check("Interrupted lanes", "warn", f"{len(cut)} lane{'s were' if len(cut) > 1 else ' was'} cut off" + (" by a restart" if any(l.get("reboot") for l in cut) else ""),
                          "Needs you has a Resume button: each lane picks up from its notes."))
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
    errs = [e for e in getattr(office, "client_errors", []) or [] if now - e["ts"] < 86400]
    if errs:
        out.append(_check("The page", "warn", f"It reported {len(errs)} error{'s' if len(errs) > 1 else ''} in the last day; the latest: {errs[-1]['message']}"
                          + (f" ({errs[-1]['where']})" if errs[-1].get("where") else ""),
                          "Reload the page. If it keeps happening, report it with these words."))
    for f in (snap.get("office") or {}).get("faults") or []:            # parts of the office that keep failing (faults.py)
        out.append(_check(f["part"], "bad", f"Failing since {time.strftime('%H:%M', time.localtime(f['since']))}, {f['count']} time{'s' if f['count'] != 1 else ''}: {f['what']}",
                          "It tries again by itself. If it does not stop, look at `journalctl --user -u claude-office -n 50`."))
    perf = office.perf_view() if hasattr(office, "perf_view") else {}
    if perf.get("builds"):
        slow = f"; the slowest part is {perf['slowest_phase']}" if perf.get("slowest_phase") else ""
        busy = perf.get("p95_ms", 0) > 1500
        out.append(_check("Refresh cost", "warn" if busy else "ok",
                          f"A refresh takes {perf['p50_ms']:.0f} ms (95% within {perf['p95_ms']:.0f} ms){slow}"
                          + (". Running light: every 12 s while the machine is busy" if perf.get("light") else ""),
                          "Nothing to do: the office refreshes less often until it is quick again." if busy else None))
    if not getattr(office, "is_demo", False):
        wd = sdnotify.watchdog_s()
        out.append(_check("Watchdog", "ok" if wd else "info", f"systemd restarts the office if its loop stops for {wd:.0f} s" if wd
                          else "Not watched: a hung office is not restarted by itself", None if wd else "Run bin/install.sh again to install the watched service."))
    out.append(_check("Version", "ok", f"Claude Office {snap.get('office', {}).get('version', '?')} on Python {sys.version.split()[0]}"))
    order = {"bad": 0, "warn": 1, "info": 2, "ok": 3}
    return sorted(out, key=lambda c: order.get(c["state"], 4))


THREADS = ("office", "usage", "tokens", "presence")


def health(office, snap: dict, deep: bool = False) -> tuple[bool, dict]:
    """For /healthz: ok while the picture is fresh (under 30 s old). Deep adds each part's age, the refresh cost, the
    background threads and the watchdog, so a monitor can tell a stuck loop from a slow plan reading."""
    now = time.time()
    age = round(now - (snap.get("now") or 0), 1)
    ok = age <= 30
    out = {"ok": ok, "age_s": age}
    if not deep:
        return ok, out
    led = getattr(office, "tokens", None)
    alive = {t.name for t in threading.enumerate() if t.is_alive()}
    out.update({
        "version": (snap.get("office") or {}).get("version"),
        "up_s": round(now - ((snap.get("office") or {}).get("started_at") or now)),
        "refresh": office.perf_view() if hasattr(office, "perf_view") else {},
        "tokens": {"age_s": round(now - led.scanned_at) if led is not None and getattr(led, "scanned_at", 0) else None,
                   "scanning": bool(getattr(led, "scanning", False))},
        "usage": {s["id"]: {"age_s": round(now - s["usage"]["fetched_at"]) if (s.get("usage") or {}).get("fetched_at") else None,
                            "error": (s.get("usage") or {}).get("error")} for s in snap.get("seats", []) if s.get("kind") == "claude"},
        "threads": {} if getattr(office, "is_demo", False) else {name: name in alive for name in THREADS},   # the demo has none
        "watchdog": {"on": sdnotify.enabled(), "timeout_s": sdnotify.watchdog_s()},
    })
    out["degraded"] = any(v is False for v in out["threads"].values()) or bool((snap.get("office") or {}).get("faults"))
    return ok, out

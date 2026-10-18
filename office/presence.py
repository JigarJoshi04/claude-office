"""Whether the CEO is at the computer: the screen locked, or how long since the last keypress or mouse move.

Read from the desktop every half minute: GNOME's screensaver and idle monitor over D-Bus, else logind's idle hint. When
none of them answers (another desktop, no session bus, a server), `present` is None and the page behaves as before.
Nothing leaves the machine.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time

AWAY_IDLE_S = 300            # five minutes without a keypress or a mouse move is away


def _run(argv: list[str]) -> str | None:
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def idle_from(gdbus_out: str | None) -> float | None:
    """Seconds since the last input from Mutter's GetIdletime answer, "(uint64 596171,)" (milliseconds)."""
    m = re.search(r"uint64 (\d+)", gdbus_out or "")
    return int(m.group(1)) / 1000 if m else None


def read() -> dict:
    """{"locked": bool|None, "idle_s": float|None, "source": "gnome"|"logind"|None} from the desktop, right now."""
    out = {"locked": None, "idle_s": None, "source": None}
    gdbus = shutil.which("gdbus")
    if gdbus:
        call = lambda dest, path, method: _run([gdbus, "call", "--session", "--dest", dest, "--object-path", path, "--method", method])
        s = call("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver.GetActive")
        if s:
            out.update(locked="true" in s, source="gnome")
        s = call("org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor.GetIdletime")
        idle = idle_from(s)
        if idle is not None:
            out.update(idle_s=idle, source="gnome")
    if out["source"] is None and shutil.which("loginctl"):
        s = _run(["loginctl", "show-user", str(os.getuid()), "-p", "IdleHint", "-p", "IdleSinceHint"]) or ""
        hint, since = re.search(r"IdleHint=(\w+)", s), re.search(r"IdleSinceHint=(\d+)", s)
        if hint:
            idle = hint.group(1) == "yes"
            out.update(source="logind", idle_s=(max(0.0, time.time() - int(since.group(1)) / 1e6) if idle and since and int(since.group(1)) else 0.0))
    return out


class Presence:
    """The CEO's presence over time: present, since when away, and the last absence once back."""

    def __init__(self, reader=read):
        self.reader, self.lock = reader, threading.Lock()
        self.state = {"present": None, "away_since": None, "locked": None, "idle_s": None, "source": None, "last_away": None}

    def tick(self, now: float | None = None) -> dict:
        now = now or time.time()
        r = self.reader()
        with self.lock:
            st = self.state
            if r.get("source") is None:
                st.update(present=None, away_since=None, locked=None, idle_s=None, source=None)
                return dict(st)
            idle = r.get("idle_s")
            away = bool(r.get("locked")) or (idle or 0) >= AWAY_IDLE_S
            if away and st["present"] is not False:            # gone: since the last input, as far as the desktop knows
                st["away_since"] = now - idle if idle is not None else now
            if not away and st["present"] is False and st["away_since"]:
                st["last_away"] = {"from": st["away_since"], "to": now}
                st["away_since"] = None
            st.update(present=not away, locked=r.get("locked"), idle_s=round(idle) if idle is not None else None, source=r.get("source"))
            return dict(st)

    def get(self) -> dict:
        with self.lock:
            return dict(self.state)

    def run(self, stop: threading.Event, every: float = 30) -> None:
        while not stop.is_set():
            try:
                self.tick()
            except Exception:                                    # presence is a nicety; never let it stop the office
                pass
            stop.wait(every)

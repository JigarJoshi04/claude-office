"""The building's utilities: how much disk the AI team's files take (transcripts, Codex rollouts, file history,
the office's own state) and how much memory its live sessions use, with 30 days of disk growth. Disk is measured every
ten minutes on a low-priority thread, memory every half minute from /proc (Linux). Read only: it never deletes
anything; Claude Code's own `cleanupPeriodDays` setting is how transcripts are kept shorter.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
from datetime import date
from pathlib import Path

from . import config

PARTS = (("projects", "Claude Code transcripts"), ("file-history", "File history (rewind)"), ("shell-snapshots", "Shell snapshots"),
         ("debug", "Debug logs"), ("todos", "Task lists"), ("paste-cache", "Pasted text"))


def du(path: Path) -> tuple[int, int]:
    """(bytes, files) under a folder, not following links."""
    total = files = 0
    stack = [str(path)]
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append(e.path)
                        elif e.is_file(follow_symlinks=False):
                            total += e.stat(follow_symlinks=False).st_size
                            files += 1
                    except OSError:
                        continue
        except OSError:
            continue
    return total, files


def disk(home: Path, office_dirs: list[Path]) -> dict:
    """What the AI team keeps on disk, by kind (folders shared between seats by a link are counted once)."""
    seen, parts = set(), {}
    for seat in sorted(home.glob(".claude*")):
        if not seat.is_dir():
            continue
        for name, label in PARTS:
            p = seat / name
            try:
                real = p.resolve()
            except OSError:
                continue
            if not p.is_dir() or real in seen:
                continue
            seen.add(real)
            b, n = du(real)
            e = parts.setdefault(name, {"label": label, "bytes": 0, "files": 0})
            e["bytes"] += b
            e["files"] += n
    codex = home / ".codex" / "sessions"
    if codex.is_dir():
        b, n = du(codex)
        parts["codex"] = {"label": "Codex rollouts", "bytes": b, "files": n}
    b = n = 0
    for d in office_dirs:
        if d.is_dir():
            x, y = du(d)
            b, n = b + x, n + y
    parts["office"] = {"label": "Claude Office (state, lanes, checkpoints)", "bytes": b, "files": n}
    try:
        u = shutil.disk_usage(home)
        fs = {"total": u.total, "free": u.free}
    except OSError:
        fs = None
    return {"parts": [dict(v, key=k) for k, v in sorted(parts.items(), key=lambda kv: -kv[1]["bytes"])],
            "bytes": sum(v["bytes"] for v in parts.values()), "fs": fs}


def _rss_kb(pid: int) -> int:
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return 0


def children_map() -> dict[int, list[int]]:
    """Every process's children (from /proc/*/stat), to sum a session's whole tree."""
    kids: dict[int, list[int]] = {}
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            raw = Path(f"/proc/{d}/stat").read_text()
            ppid = int(raw[raw.rfind(")") + 2:].split()[1])
        except (OSError, ValueError, IndexError):
            continue
        kids.setdefault(ppid, []).append(int(d))
    return kids


def tree_rss(pid: int, kids: dict[int, list[int]]) -> int:
    """Resident memory of a process and everything it started (MB)."""
    total, stack, seen = 0, [pid], set()
    while stack:
        p = stack.pop()
        if p in seen:
            continue
        seen.add(p)
        total += _rss_kb(p)
        stack.extend(kids.get(p, ()))
    return round(total / 1024)


def machine_memory() -> dict | None:
    try:
        m = {k: int(v.split()[0]) for k, v in (line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines() if ":" in line)}
        return {"total_mb": m["MemTotal"] // 1024, "available_mb": m["MemAvailable"] // 1024}
    except (OSError, KeyError, ValueError):
        return None


class Utilities:
    def __init__(self, path: Path | None):
        self.path, self.lock = path, threading.Lock()
        d = config.read_state(path) if path else None
        self.history: dict[str, int] = d.get("days", {}) if isinstance(d, dict) and isinstance(d.get("days"), dict) else {}
        self.disk: dict | None = None
        self.memory: dict | None = None
        self._disk_at = self._mem_at = 0.0

    def measure_disk(self) -> None:
        d = disk(config.HOME, [config.STATE_DIR, config.DATA_DIR])
        day = time.strftime("%Y-%m-%d")
        with self.lock:
            self.disk, self._disk_at = d, time.time()
            self.history[day] = d["bytes"]
            self.history = dict(sorted(self.history.items())[-30:])
            if self.path:
                try:
                    self.path.parent.mkdir(parents=True, exist_ok=True)
                    tmp = self.path.with_suffix(".tmp")
                    tmp.write_text(json.dumps({"days": self.history}))
                    tmp.replace(self.path)
                except OSError:
                    pass

    def measure_memory(self, seats: list[dict]) -> None:
        if not os.path.isdir("/proc"):
            return
        kids = children_map()
        per_seat, sessions = {}, []
        for s in seats:
            for x in s.get("sessions", []):
                if not x.get("live", True) or not x.get("pid"):
                    continue
                mb = tree_rss(int(x["pid"]), kids)
                per_seat[s["id"]] = per_seat.get(s["id"], 0) + mb
                sessions.append({"seat": s["id"], "id": x["id"], "name": x.get("name"), "mb": mb})
        with self.lock:
            self.memory = {"seats": per_seat, "total_mb": sum(per_seat.values()), "machine": machine_memory(),
                           "top": sorted(sessions, key=lambda r: -r["mb"])[:6]}
            self._mem_at = time.time()

    def tick(self, seats: list[dict], now: float) -> None:
        """Called from the snapshot loop: memory every 30 s here; disk every 10 min on its own thread."""
        if now - self._mem_at > 30:
            try:
                self.measure_memory(seats)
            except Exception:                       # a nicety: never stop the office
                self._mem_at = now
        if now - self._disk_at > 600:
            self._disk_at = now
            threading.Thread(target=self._disk_thread, daemon=True, name="utilities-disk").start()

    def _disk_thread(self) -> None:
        try:
            os.nice(10)
        except OSError:
            pass
        try:
            self.measure_disk()
        except Exception:
            pass

    def view(self) -> dict:
        with self.lock:
            days = sorted(self.history.items())
            span = (date.fromisoformat(days[-1][0]) - date.fromisoformat(days[0][0])).days if len(days) >= 2 else 0
            grow = (days[-1][1] - days[0][1]) / span if span > 0 else None           # per calendar day, gaps included
            return {"disk": self.disk, "memory": self.memory, "days": days, "per_day": grow}

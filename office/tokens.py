"""All-time token use, from the transcripts already on disk.

Claude Code writes every API response into a session transcript (`<config>/projects/<project>/<session>.jsonl`, and
subagents under `<session>/subagents/`) with its `usage`. The ledger reads those files once, then only what was
appended since, and keeps running totals per session, per day and per model in `state/tokens.json`. A session belongs
to the seat whose config dir holds `session-env/<session id>` (seats may share one projects dir through symlinks, so
the transcript alone cannot say), or to the seat the office saw it live in. Codex rollouts count for the Codex seat.

Tokens are counted three ways: fresh (input + cache writes + output), cache reads, and output alone. "All" is fresh
plus cache reads: every token the model processed. Only counts and project folder names are kept, never content.
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime
from pathlib import Path

VERSION = 1
MAX_SESSIONS = 20000          # far beyond a busy year; the oldest drop off first


def _day(ts: str | None) -> str | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().date().isoformat()
    except ValueError:
        return None


def _epoch(ts: str | None) -> float | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _add(bucket: dict, f: int, c: int, o: int, n: int = 1) -> None:
    bucket["f"] = bucket.get("f", 0) + f
    bucket["c"] = bucket.get("c", 0) + c
    bucket["o"] = bucket.get("o", 0) + o
    bucket["n"] = bucket.get("n", 0) + n


class TokenLedger:
    def __init__(self, path: Path, claude_dirs: list[tuple[str, Path]], codex_dir: Path | None = None):
        self.path = path
        self.claude_dirs = claude_dirs          # (seat id, config dir) for every Claude seat
        self.codex_dir = codex_dir
        self.lock = threading.Lock()
        self.scanning = False
        self.scanned_at = 0.0
        self.data = self._load()

    # -- state ----------------------------------------------------------------------------------------------------
    def _empty(self) -> dict:
        return {"v": VERSION, "files": {}, "codex": {}, "sessions": {}, "days": {}, "models": {}}

    def _load(self) -> dict:
        try:
            d = json.loads(self.path.read_text())
            if d.get("v") == VERSION:
                for k, v in self._empty().items():
                    d.setdefault(k, v)
                return d
        except (OSError, ValueError):
            pass
        return self._empty()

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                json.dump(self.data, fh, separators=(",", ":"))
            os.replace(tmp, self.path)
        except OSError:
            pass

    # -- scanning -------------------------------------------------------------------------------------------------
    def _projects_dirs(self) -> list[Path]:
        seen, out = set(), []
        for _, d in self.claude_dirs:
            p = d / "projects"
            try:
                real = p.resolve()
            except OSError:
                continue
            if real.is_dir() and real not in seen:      # seats that share one projects dir are read once
                seen.add(real)
                out.append(real)
        return out

    def _seat_map(self) -> dict:
        """session id -> seat, from each seat's own session-env folder."""
        out = {}
        for seat, d in self.claude_dirs:
            try:
                for name in os.listdir(d / "session-env"):
                    out.setdefault(name, seat)
            except OSError:
                continue
        return out

    def scan(self, live: dict | None = None) -> bool:
        """Read what was appended since the last scan. live: session id -> seat seen live. True if anything changed."""
        with self.lock:
            if self.scanning:
                return False
            self.scanning = True
        changed = False
        try:
            seats = self._seat_map()
            for sid, seat in (live or {}).items():
                seats.setdefault(sid, seat)
            for root in self._projects_dirs():
                for dirpath, _, files in os.walk(root):
                    for name in files:
                        if name.endswith(".jsonl") and name != "journal.jsonl":
                            changed |= self._scan_file(root, Path(dirpath) / name)
            if self.codex_dir and self.codex_dir.is_dir():
                for dirpath, _, files in os.walk(self.codex_dir):
                    for name in files:
                        if name.endswith(".jsonl"):
                            changed |= self._scan_codex(Path(dirpath) / name)
            with self.lock:
                for sid, rec in self.data["sessions"].items():   # late attribution: a seat learned since the first read
                    if not rec.get("s") and sid in seats:
                        rec["s"] = seats[sid]; changed = True
                if len(self.data["sessions"]) > MAX_SESSIONS:
                    old = sorted(self.data["sessions"].items(), key=lambda kv: kv[1].get("l", 0))[:len(self.data["sessions"]) - MAX_SESSIONS]
                    for sid, _ in old:
                        del self.data["sessions"][sid]
            if changed:
                self._save()
        finally:
            with self.lock:
                self.scanning = False
                self.scanned_at = time.time()
        return changed

    def _session_of(self, root: Path, path: Path) -> tuple[str, str]:
        rel = path.relative_to(root).parts                 # (project, session.jsonl) or (project, session, subagents, ...)
        sid = rel[1][:-6] if len(rel) == 2 else rel[1]
        return rel[0], sid

    def _scan_file(self, root: Path, path: Path) -> bool:
        key = str(path)
        try:
            size = path.stat().st_size
        except OSError:
            return False
        rec = self.data["files"].get(key) or [0, None]
        offset, last_id = rec
        if size < offset:                                  # rewritten from scratch: start over from here on
            offset = size
        if size == offset:
            return False
        project_dir, sid = self._session_of(root, path)
        changed = False
        with open(path, "rb") as fh:
            fh.seek(offset)
            chunk = fh.read(size - offset)
        end = chunk.rfind(b"\n")
        if end < 0:
            return False
        for raw in chunk[:end].split(b"\n"):
            if b'"usage"' not in raw or b'"assistant"' not in raw:
                continue
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            m = d.get("message") if isinstance(d, dict) else None
            u = m.get("usage") if isinstance(m, dict) else None
            if d.get("type") != "assistant" or not isinstance(u, dict):
                continue
            mid = m.get("id")
            if mid and mid == last_id:                     # one response is written as several lines
                continue
            last_id = mid
            model = m.get("model") or "?"
            if model.startswith("<"):                      # <synthetic> lines are not API calls
                continue
            n = lambda k: int(u.get(k) or 0)
            f = n("input_tokens") + n("cache_creation_input_tokens") + n("output_tokens")
            c, o = n("cache_read_input_tokens"), n("output_tokens")
            day, at = _day(d.get("timestamp")), _epoch(d.get("timestamp"))
            with self.lock:
                s = self.data["sessions"].setdefault(sid, {"p": None, "s": None, "fi": at, "l": at, "m": {}, "d": {}})
                if not s.get("p") and d.get("cwd"):
                    s["p"] = os.path.basename(d["cwd"].rstrip("/")) or d["cwd"]
                if at:
                    s["fi"] = min(s.get("fi") or at, at); s["l"] = max(s.get("l") or at, at)
                _add(s, f, c, o)
                s["m"][model] = s["m"].get(model, 0) + f + c
                if day:
                    s["d"][day] = s["d"].get(day, 0) + f + c
                    _add(self.data["days"].setdefault(day, {}), f, c, o)
                _add(self.data["models"].setdefault(model, {}), f, c, o)
            changed = True
        if not self.data["sessions"].get(sid, {}).get("p"):
            with self.lock:
                if sid in self.data["sessions"]:
                    self.data["sessions"][sid]["p"] = project_dir.rsplit("-", 1)[-1] or project_dir
        self.data["files"][key] = [offset + end + 1, last_id]
        return changed

    def _scan_codex(self, path: Path) -> bool:
        key = str(path)
        try:
            size = path.stat().st_size
        except OSError:
            return False
        rec = self.data["codex"].get(key) or [0, 0, 0, 0]      # offset, total so far, cached so far, output so far
        offset, t0, c0, o0 = rec
        if size <= offset:
            return False
        with open(path, "rb") as fh:
            fh.seek(offset)
            chunk = fh.read(size - offset)
        end = chunk.rfind(b"\n")
        if end < 0:
            return False
        sid = "codex:" + path.stem
        changed = False
        for raw in chunk[:end].split(b"\n"):
            if b'"token_count"' not in raw:
                continue
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            p = d.get("payload") if isinstance(d, dict) else None
            info = p.get("info") if isinstance(p, dict) else None
            tot = info.get("total_token_usage") if isinstance(info, dict) else None
            if not isinstance(tot, dict):
                continue
            t, cached, out = int(tot.get("total_tokens") or 0), int(tot.get("cached_input_tokens") or 0), int(tot.get("output_tokens") or 0)
            if t <= t0:
                continue
            dc, dout = max(0, cached - c0), max(0, out - o0)
            dfresh = max(0, (t - t0) - dc)                      # Codex counts cached input inside its input
            t0, c0, o0 = t, cached, out
            day, at = _day(d.get("timestamp")), _epoch(d.get("timestamp"))
            with self.lock:
                s = self.data["sessions"].setdefault(sid, {"p": None, "s": "@codex", "fi": at, "l": at, "m": {}, "d": {}})
                if at:
                    s["fi"] = min(s.get("fi") or at, at); s["l"] = max(s.get("l") or at, at)
                _add(s, dfresh, dc, dout)
                s["m"]["codex"] = s["m"].get("codex", 0) + dfresh + dc
                if day:
                    s["d"][day] = s["d"].get(day, 0) + dfresh + dc
                    _add(self.data["days"].setdefault(day, {}), dfresh, dc, dout)
                _add(self.data["models"].setdefault("codex", {}), dfresh, dc, dout)
            changed = True
        self.data["codex"][key] = [offset + end + 1, t0, c0, o0]
        return changed

    def run(self, stop: threading.Event, live=lambda: {}, every: float = 120) -> None:
        """Scan now, then every `every` seconds, until stop."""
        while not stop.is_set():
            try:
                self.scan(live())
            except Exception:                              # the ledger is a nicety; never let it stop the office
                pass
            stop.wait(every)

    # -- the view -------------------------------------------------------------------------------------------------
    def view(self, seats: list[dict], today: str | None = None, days: int = 60) -> dict:
        today = today or datetime.now().date().isoformat()
        codex = next((s["id"] for s in seats if s.get("kind") == "codex"), None)
        known = {s["id"] for s in seats}
        with self.lock:
            sessions = {k: dict(v) for k, v in self.data["sessions"].items()}
            day_rows = dict(self.data["days"])
            models = dict(self.data["models"])
            scanning, scanned_at = self.scanning, self.scanned_at
        allt = lambda r: r.get("f", 0) + r.get("c", 0)
        seat_of = lambda r: codex if r.get("s") == "@codex" else (r.get("s") if r.get("s") in known else None)
        per_seat: dict = {}
        projects: dict = {}
        for sid, r in sessions.items():
            st = per_seat.setdefault(seat_of(r), {"f": 0, "c": 0, "o": 0, "n": 0, "sessions": 0, "today": 0, "m": {}})
            _add(st, r.get("f", 0), r.get("c", 0), r.get("o", 0), r.get("n", 0))
            st["sessions"] += 1
            st["today"] += (r.get("d") or {}).get(today, 0)
            for m, v in (r.get("m") or {}).items():
                st["m"][m] = st["m"].get(m, 0) + v
            if r.get("p") and r.get("s") != "@codex":
                pr = projects.setdefault(r["p"], {"all": 0, "sessions": 0, "seats": {}})
                pr["all"] += allt(r); pr["sessions"] += 1
                if seat_of(r):
                    pr["seats"][seat_of(r)] = pr["seats"].get(seat_of(r), 0) + allt(r)
        tot = {"f": 0, "c": 0, "o": 0, "n": 0}
        for r in day_rows.values():
            _add(tot, r.get("f", 0), r.get("c", 0), r.get("o", 0), r.get("n", 0))
        first = min(day_rows) if day_rows else None
        out_seats = sorted(({"seat": k, "all": allt(v), "fresh": v["f"], "output": v["o"], "messages": v["n"], "sessions": v["sessions"],
                             "today": v["today"], "top_model": max(v["m"], key=v["m"].get) if v["m"] else None}
                            for k, v in per_seat.items()), key=lambda x: -x["all"])
        top_sessions = sorted(sessions.items(), key=lambda kv: -allt(kv[1]))[:12]
        months: dict = {}
        for d, r in day_rows.items():
            _add(months.setdefault(d[:7], {}), r.get("f", 0), r.get("c", 0), r.get("o", 0), r.get("n", 0))
        recent = sorted(day_rows)[-days:]
        return {
            "scanning": scanning or not scanned_at, "scanned_at": scanned_at or None, "since": first,
            "total": {"all": allt(tot), "fresh": tot["f"], "cache": tot["c"], "output": tot["o"], "messages": tot["n"], "sessions": len(sessions)},
            "today": allt(day_rows.get(today, {})),
            "seats": out_seats,
            "days": [{"day": d, "all": allt(day_rows[d]), "fresh": day_rows[d].get("f", 0), "output": day_rows[d].get("o", 0)} for d in recent],
            "months": [{"month": m, "all": allt(v), "fresh": v["f"], "output": v["o"]} for m, v in sorted(months.items())],
            "models": sorted(({"model": m, "all": allt(v), "fresh": v.get("f", 0), "output": v.get("o", 0)} for m, v in models.items()), key=lambda x: -x["all"]),
            "projects": sorted(({"project": p, "all": v["all"], "sessions": v["sessions"], "top_seat": max(v["seats"], key=v["seats"].get) if v["seats"] else None}
                                for p, v in projects.items()), key=lambda x: -x["all"])[:12],
            "sessions": [{"id": sid.split(":")[-1][:8], "project": r.get("p"), "seat": seat_of(r), "all": allt(r), "fresh": r.get("f", 0),
                          "output": r.get("o", 0), "messages": r.get("n", 0), "first": r.get("fi"), "last": r.get("l")} for sid, r in top_sessions],
        }

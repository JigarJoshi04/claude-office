"""All-time token use, from the transcripts already on disk.

Claude Code writes every API response into a session transcript (`<config>/projects/<project>/<session>.jsonl`, and
subagents under `<session>/subagents/`) with its `usage`. The ledger reads those files once, then only what was
appended since, and keeps running totals per session, per day and per model in `state/tokens.json`. A session belongs
to the seat whose config dir holds `session-env/<session id>` (seats may share one projects dir through symlinks, so
the transcript alone cannot say), or to the seat the office saw it live in. Codex rollouts count for the Codex seat.

Tokens are counted three ways: fresh (input + cache writes + output), cache reads, and output alone. "All" is fresh
plus cache reads: every token the model processed. Only counts and project folder names are kept, never content.

Version 2 keeps each session's days split by measure ([fresh, cache, output]) and its tokens by weekday and hour, for
ranges, leaderboards that move, a calendar and a heatmap. A version 1 file is rebuilt from the transcripts still on
disk; a session whose transcript Claude Code has since deleted keeps its version 1 totals, spread over its days.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

VERSION = 2
SHIP_RULES = 3                # bumped when the rules for shipped work change: every transcript's commands are read again
RANGES = {"today": 1, "7": 7, "30": 30, "90": 90, "all": None}
# Shipped work, read from the Bash tool calls in the transcripts: what a command did, confirmed by its result.
SHIP = ("commits", "pushes", "prs_opened", "prs_merged", "insertions", "deletions")
_STAT = re.compile(r"(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?")
_PUSHED = re.compile(r"\b[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\s+\S+ -> \S+|\* \[new branch\]")
_PR_URL = re.compile(r"/pull/(\d+)")
_START = r"(?:^|[;&|(\n])\s*(?:[A-Za-z_]\w*=\S*\s+)*"                 # a command's start, after any VAR=value
_GIT = _START + r"git\b(?:\s+-[-\w]+(?:[ =][^\s;&|]+)?)*\s+"
_GH = _START + r"gh\s+pr\s+"
_MERGE_ARGS = re.compile(_GH + r"merge\b([^;&|\n]*)")
_MERGE_NO = re.compile(r"already merged|not mergeable|automatically merged|merge queue|auto-merge")   # nothing merged now
_MERGE_YES = re.compile(r"\bmerged pull request\b|\"state\":\s*\"merged\"|^merged\b", re.M)          # gh's words, or a gh pr view
_MERGE_ERR = re.compile(r"graphql|is expected|could not|^x |^! |^error|^fatal", re.M)
_COMMIT_LINE = re.compile(r"^\[[^\]\n]+ [0-9a-f]{7,40}\]", re.M)
_COMMIT_NO = re.compile(r"nothing (?:added )?to commit|no changes added|aborting commit")   # not "error:": later commands print those


def ship_kinds(cmd: str) -> set:
    """What a shell command would ship if it succeeds: commit, push, pr_open, pr_merge (pr_auto: an auto-merge)."""
    out = set()
    if re.search(_GIT + r"commit\b", cmd):
        out.add("commit")
    if re.search(_GIT + r"push\b", cmd):
        out.add("push")
    if re.search(_GH + r"create\b", cmd):
        out.add("pr_open")
    m = _MERGE_ARGS.search(cmd)
    if m and "--disable-auto" not in m.group(1):
        out.add("pr_merge")
        if re.search(r"--auto\b", m.group(1)):
            out.add("pr_auto")
    return out


def shipped(kinds: set, text: str) -> list:
    """[commits, pushes, prs_opened, prs_merged, insertions, deletions] that a successful command's output shows."""
    v = [0, 0, 0, 0, 0, 0]
    low = text.lower()
    if "commit" in kinds:
        lines = len(_COMMIT_LINE.findall(text))
        if lines or not _COMMIT_NO.search(low):                # `git commit -q` prints nothing
            v[0] = max(1, lines)
            for m in _STAT.finditer(text):
                v[4] += int(m.group(2) or 0)
                v[5] += int(m.group(3) or 0)
    if "push" in kinds and (_PUSHED.search(text) or not text.strip()):
        v[1] = 1
    if "pr_open" in kinds and _PR_URL.search(text):
        v[2] = 1
    # gh prints nothing when it merges without a terminal; the cleanup after a merge can fail without undoing it
    if "pr_merge" in kinds and not _MERGE_NO.search(low) and (
            _MERGE_YES.search(low) or ("pr_auto" not in kinds and not _MERGE_ERR.search(low))):
        v[3] = 1
    return v


def pr_number(kinds: set, cmd: str, text: str) -> int | None:
    """The PR a command opened or merged: from a /pull/N link, gh's "owner/repo#N", or the merge command's argument."""
    if "pr_merge" in kinds:
        m = (re.search(_GH + r"merge\s+(?:\S*/pull/|#)?(\d+)\b", cmd) or re.search(r"pull request (?:[\w.-]+/[\w.-]+)?#(\d+)", text, re.I))
        if m:
            return int(m.group(1))
    m = _PR_URL.search(text)
    return int(m.group(1)) if m else None


def short_id(sid: str) -> str:
    """A session id short enough for a table: a Claude session's first 8 characters; a Codex rollout's last 8 hex
    digits (its stem starts with the date, and new ids share a time prefix)."""
    if sid.startswith("codex:"):
        m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", sid)
        return m.group(1)[-8:] if m else sid[-8:]
    return sid[:8]
MAX_SESSIONS = 20000          # far beyond a busy year; the oldest drop off first


def next_rung(n: int) -> int:
    """The milestone after n on the 1-2-5 ladder: 1 M, 2 M, 5 M, 10 M, 20 M, 50 M, 100 M, …"""
    lead = int(str(n)[0])
    return n // lead * {1: 2, 2: 5, 5: 10}[lead]


def _when(ts: str | None) -> tuple[str | None, str | None]:
    """(local day, "weekday-hour" with Monday 0) for a transcript timestamp."""
    if not ts:
        return None, None
    try:
        t = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None, None
    return t.date().isoformat(), f"{t.weekday()}-{t.hour}"


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
        self._legacy = None                     # a version 1 ledger, merged after the first rebuild
        self._pending: dict = {}                # Bash tool_use id -> what it would ship, until its result arrives
        self._ts = None                         # the last timestamp seen in the file being read (results carry none)
        self.events: list = []                  # newly shipped PRs, for the office's news (see take_events)
        self.scans = 0
        self.data = self._load()

    # -- state ----------------------------------------------------------------------------------------------------
    def _empty(self) -> dict:
        return {"v": VERSION, "sr": SHIP_RULES, "files": {}, "files_out": {}, "codex": {}, "sessions": {}, "days": {}, "models": {}}

    def _load(self) -> dict:
        try:
            d = json.loads(self.path.read_text())
            if d.get("v") == 1:                    # rebuilt from the transcripts on the first scan; see _merge_legacy
                self._legacy = d
                return self._empty()
            if d.get("v") == VERSION:
                if d.get("sr") != SHIP_RULES:          # recount shipped work from the transcripts still on disk
                    d["files_out"] = {}
                    for r in (d.get("sessions") or {}).values():
                        r.pop("g", None)
                    d["sr"] = SHIP_RULES
                for k, v in self._empty().items():
                    d.setdefault(k, v)
                return d
        except (OSError, ValueError, AttributeError):   # no file yet (or no path: the demo's in-memory ledger)
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
            if self._legacy is not None:
                self._merge_legacy(); changed = True
            self.scans += 1
            if changed:
                self._save()
        finally:
            with self.lock:
                self.scanning = False
                self.scanned_at = time.time()
        return changed

    def _merge_legacy(self) -> None:
        """Sessions the version 1 ledger counted whose transcripts are gone: keep their totals, spread over their days."""
        old, self._legacy = self._legacy, None
        with self.lock:
            for sid, r in (old.get("sessions") or {}).items():
                if sid in self.data["sessions"]:
                    continue
                days = r.get("d") or {}
                whole = sum(days.values()) or 1
                f, c, o = r.get("f", 0), r.get("c", 0), r.get("o", 0)
                split = {day: [round(f * v / whole), round(c * v / whole), round(o * v / whole)] for day, v in days.items()}
                self.data["sessions"][sid] = {**r, "d": split, "h": {}, "legacy": True}
                for day, (df, dc, do) in split.items():
                    _add(self.data["days"].setdefault(day, {}), df, dc, do, 0)
                for m, v in (r.get("m") or {}).items():
                    share = v / max(1, f + c)
                    _add(self.data["models"].setdefault(m, {}), round(f * share), round(c * share), round(o * share), 0)

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
        out_off = min(self.data.setdefault("files_out", {}).get(key, 0), size)   # shipped work has its own offset
        start = min(offset, out_off)
        if size == start:
            return False
        project_dir, sid = self._session_of(root, path)
        changed = False
        pos = start
        self._ts = None
        with open(path, "rb") as fh:                       # line by line: a transcript can be hundreds of MB
            fh.seek(start)
            for raw in fh:
                if not raw.endswith(b"\n"):                # a line still being written: read it next time
                    break
                at, pos = pos, pos + len(raw)
                if at >= offset:
                    changed |= self._take(raw, sid, last_id)
                    last_id = self._last
                if at >= out_off:
                    changed |= self._ship(raw, sid)
        self.data["files_out"][key] = pos
        if pos <= offset:
            return changed
        if not self.data["sessions"].get(sid, {}).get("p"):
            with self.lock:
                if sid in self.data["sessions"]:
                    self.data["sessions"][sid]["p"] = project_dir.rsplit("-", 1)[-1] or project_dir
        self.data["files"][key] = [pos, last_id]
        return changed

    def _ship(self, raw: bytes, sid: str) -> bool:
        """Bash calls that commit, push, or open or merge a PR, counted when their result comes back without an error."""
        m = re.search(rb'"timestamp":\s*"([^"]+)"', raw)
        if m:
            self._ts = m.group(1).decode()
        if b'"tool_use"' in raw and b'"Bash"' in raw and (b"git" in raw or b"gh " in raw):
            try:
                d = json.loads(raw)
            except ValueError:
                return False
            content = (d.get("message") or {}).get("content") if isinstance(d, dict) else None
            for c in content if isinstance(content, list) else []:
                if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Bash":
                    cmd = str((c.get("input") or {}).get("command") or "")
                    kinds = ship_kinds(cmd)
                    if kinds:
                        self._pending[c.get("id")] = (kinds, cmd)
                        if len(self._pending) > 500:
                            self._pending.pop(next(iter(self._pending)))
            return False
        if b'"tool_result"' not in raw or not self._pending:
            return False
        try:
            d = json.loads(raw)
        except ValueError:
            return False
        content = (d.get("message") or {}).get("content") if isinstance(d, dict) else None
        changed = False
        for c in content if isinstance(content, list) else []:
            if not isinstance(c, dict) or c.get("type") != "tool_result" or c.get("tool_use_id") not in self._pending:
                continue
            kinds, cmd = self._pending.pop(c["tool_use_id"])
            if c.get("is_error"):
                continue
            body = c.get("content")
            text = body if isinstance(body, str) else " ".join(x.get("text", "") for x in body if isinstance(x, dict)) if isinstance(body, list) else ""
            v = shipped(kinds, text)
            if not any(v):
                continue
            day, _ = _when(self._ts)
            with self.lock:
                s = self.data["sessions"].setdefault(sid, {"p": None, "s": None, "fi": None, "l": None, "m": {}, "d": {}, "h": {}})
                g = s.setdefault("g", {}).setdefault(day or "?", [0] * len(SHIP))
                for i, x in enumerate(v):
                    g[i] += x
            changed = True
            at = _epoch(self._ts)
            if self.scans and (v[2] or v[3]) and at and time.time() - at < 900:     # fresh PR news, never from the first read
                self.events.append({"session": sid, "kind": "pr_merged" if v[3] else "pr_opened", "pr": pr_number(kinds if v[3] else {"pr_open"}, cmd, text), "at": at})
        return changed

    def take_events(self) -> list:
        """PRs opened or merged since the last call (from scans after the first), for the office's news."""
        with self.lock:
            out, self.events = self.events, []
        return out

    def _take(self, raw: bytes, sid: str, last_id) -> bool:
        """One transcript line: count it if it is a new API response. Sets self._last to the response id seen."""
        self._last = last_id
        if b'"usage"' not in raw or b'"assistant"' not in raw:
            return False
        try:
            d = json.loads(raw)
        except ValueError:
            return False
        m = d.get("message") if isinstance(d, dict) else None
        u = m.get("usage") if isinstance(m, dict) else None
        if d.get("type") != "assistant" or not isinstance(u, dict):
            return False
        mid = m.get("id")
        if mid and mid == last_id:                     # one response is written as several lines
            return False
        self._last = mid
        model = m.get("model") or "?"
        if model.startswith("<"):                      # <synthetic> lines are not API calls
            return False
        n = lambda k: int(u.get(k) or 0)
        f = n("input_tokens") + n("cache_creation_input_tokens") + n("output_tokens")
        c, o = n("cache_read_input_tokens"), n("output_tokens")
        (day, wh), at = _when(d.get("timestamp")), _epoch(d.get("timestamp"))
        with self.lock:
            s = self.data["sessions"].setdefault(sid, {"p": None, "s": None, "fi": at, "l": at, "m": {}, "d": {}, "h": {}})
            if not s.get("p") and d.get("cwd"):
                s["p"] = os.path.basename(d["cwd"].rstrip("/")) or d["cwd"]
            if at:
                s["fi"] = min(s.get("fi") or at, at); s["l"] = max(s.get("l") or at, at)
            _add(s, f, c, o)
            s["m"][model] = s["m"].get(model, 0) + f + c
            if day:
                v = s["d"].setdefault(day, [0, 0, 0]); v[0] += f; v[1] += c; v[2] += o
                _add(self.data["days"].setdefault(day, {}), f, c, o)
            if wh:
                h = s.setdefault("h", {}); h[wh] = h.get(wh, 0) + f + c
            _add(self.data["models"].setdefault(model, {}), f, c, o)
        return True

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
        sid = "codex:" + path.stem
        changed = False
        pos = offset
        with open(path, "rb") as fh:
            fh.seek(offset)
            for raw in fh:
                if not raw.endswith(b"\n"):
                    break
                pos += len(raw)
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
                (day, wh), at = _when(d.get("timestamp")), _epoch(d.get("timestamp"))
                with self.lock:
                    s = self.data["sessions"].setdefault(sid, {"p": None, "s": "@codex", "fi": at, "l": at, "m": {}, "d": {}, "h": {}})
                    if at:
                        s["fi"] = min(s.get("fi") or at, at); s["l"] = max(s.get("l") or at, at)
                    _add(s, dfresh, dc, dout)
                    s["m"]["codex"] = s["m"].get("codex", 0) + dfresh + dc
                    if day:
                        v = s["d"].setdefault(day, [0, 0, 0]); v[0] += dfresh; v[1] += dc; v[2] += dout
                        _add(self.data["days"].setdefault(day, {}), dfresh, dc, dout)
                    if wh:
                        h = s.setdefault("h", {}); h[wh] = h.get(wh, 0) + dfresh + dc
                    _add(self.data["models"].setdefault("codex", {}), dfresh, dc, dout)
                changed = True
        if pos == offset:
            return False
        self.data["codex"][key] = [pos, t0, c0, o0]
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
    def view(self, seats: list[dict], today: str | None = None, days: int = 60, rng: str = "all", seat: str | None = None,
             all_sessions: bool = False) -> dict:
        """The tokens page: totals, leaderboard (with the rank each seat had the period before), days, calendar,
        weekday-by-hour heat, models, projects, sessions and records, for a range (today, 7, 30, 90, all) and
        optionally one seat."""
        today = today or datetime.now().date().isoformat()
        t = datetime.fromisoformat(today)
        span = lambda back, length: {(t.date() - timedelta(days=back + i)).isoformat() for i in range(length)}
        month = re.fullmatch(r"m:(\d{4})-(\d{2})", rng or "")
        if month:                                                         # a calendar month, against the month before
            y, mo = int(month.group(1)), int(month.group(2))
            first = datetime(y, mo, 1).date()
            nxt = datetime(y + (mo == 12), mo % 12 + 1, 1).date()
            before = datetime(y - (mo == 1), (mo - 2) % 12 + 1, 1).date()
            cur = {(first + timedelta(days=i)).isoformat() for i in range((nxt - first).days)}
            prev = {(before + timedelta(days=i)).isoformat() for i in range((first - before).days)}
            length = len(cur)
        else:
            rng = rng if rng in RANGES else "all"
            length = RANGES[rng]
            cur = span(0, length) if length else None
            prev = span(length, length) if length else None
        codex = next((x["id"] for x in seats if x.get("kind") == "codex"), None)
        known = {x["id"] for x in seats}
        with self.lock:
            sessions = {k: dict(v) for k, v in self.data["sessions"].items()}
            day_rows = {k: dict(v) for k, v in self.data["days"].items()}
            models_all = {k: dict(v) for k, v in self.data["models"].items()}
            scanning, scanned_at = self.scanning, self.scanned_at
        seat_of = lambda r: codex if r.get("s") == "@codex" else (r.get("s") if r.get("s") in known else None)
        trip = lambda v: v if isinstance(v, list) else [0, v, 0]           # [fresh, cache, output]
        def sums(r, keep):                                                # a session's [f, c, o] over a set of days
            tot = [0, 0, 0]
            for d, v in (r.get("d") or {}).items():
                if keep is None or d in keep:
                    v = trip(v); tot[0] += v[0]; tot[1] += v[1]; tot[2] += v[2]
            return tot
        mine = {sid: r for sid, r in sessions.items() if seat is None or seat_of(r) == seat}
        def ship_sum(r, keep):                                            # a session's shipped work over a set of days
            tot = [0] * len(SHIP)
            for d, v in (r.get("g") or {}).items():
                if keep is None or d in keep:
                    for i, x in enumerate(v):
                        tot[i] += x
            return tot
        shipped_by: dict = {}
        for sid, r in sessions.items():
            g = ship_sum(r, cur)
            if any(g):
                x = shipped_by.setdefault(seat_of(r), [0] * len(SHIP))
                for i, v in enumerate(g):
                    x[i] += v
        per_seat, prev_seat, projects, models, heat = {}, {}, {}, {}, {}
        listed = []
        for sid, r in sessions.items():
            k = seat_of(r)
            f, c, o = sums(r, cur)
            if prev is not None:
                pf, pc, po = sums(r, prev)
                ps = prev_seat.setdefault(k, {"all": 0, "fresh": 0, "output": 0})
                ps["all"] += pf + pc; ps["fresh"] += pf; ps["output"] += po
            if f + c:
                st = per_seat.setdefault(k, {"all": 0, "fresh": 0, "output": 0, "sessions": 0, "today": 0, "today_by": [0, 0, 0], "m": {}})
                st["all"] += f + c; st["fresh"] += f; st["output"] += o; st["sessions"] += 1
                td = trip((r.get("d") or {}).get(today, [0, 0, 0]))
                st["today"] += td[0] + td[1]
                st["today_by"] = [a + b for a, b in zip(st["today_by"], td)]
                for m, v in (r.get("m") or {}).items():
                    st["m"][m] = st["m"].get(m, 0) + v
            if sid not in mine or not f + c:
                continue
            whole = max(1, r.get("f", 0) + r.get("c", 0))
            for m, v in (r.get("m") or {}).items():                       # a session's range, split by its models
                share = v / whole
                mm = models.setdefault(m, {"all": 0, "fresh": 0, "output": 0})
                mm["all"] += round((f + c) * share); mm["fresh"] += round(f * share); mm["output"] += round(o * share)
            if r.get("p") and r.get("s") != "@codex":
                pr = projects.setdefault(r["p"], {"all": 0, "fresh": 0, "output": 0, "sessions": 0, "seats": {}})
                pr["all"] += f + c; pr["fresh"] += f; pr["output"] += o; pr["sessions"] += 1
                if k:
                    pr["seats"][k] = pr["seats"].get(k, 0) + f + c
            if cur is None:                                               # the heatmap follows the range when it can
                for wh, v in (r.get("h") or {}).items():
                    heat[wh] = heat.get(wh, 0) + v
            listed.append((sid, r, f, c, o, k))
        if cur is not None:                                               # hours are not kept per day: use the sessions active in range
            for sid, r, f, c, o, k in listed:
                whole = max(1, r.get("f", 0) + r.get("c", 0))
                for wh, v in (r.get("h") or {}).items():
                    heat[wh] = heat.get(wh, 0) + v * (f + c) / whole
        # days: the office's, or this seat's from its sessions
        if seat is None:
            series = {d: [r.get("f", 0), r.get("c", 0), r.get("o", 0)] for d, r in day_rows.items()}
        else:
            series = {}
            for r in mine.values():
                for d, v in (r.get("d") or {}).items():
                    v = trip(v); x = series.setdefault(d, [0, 0, 0]); x[0] += v[0]; x[1] += v[1]; x[2] += v[2]
        row = lambda d, v: {"day": d, "all": v[0] + v[1], "fresh": v[0], "output": v[2]}
        by = lambda v: {"all": v[0] + v[1], "fresh": v[0], "output": v[2]}               # one day, every measure
        in_range = {d: v for d, v in series.items() if cur is None or d in cur}
        tot = [sum(v[i] for v in in_range.values()) for i in range(3)]
        months: dict = {}
        for d, v in series.items():
            m = months.setdefault(d[:7], [0, 0, 0]); m[0] += v[0]; m[1] += v[1]; m[2] += v[2]
        board = sorted(({"seat": k, **{x: v[x] for x in ("all", "fresh", "output", "sessions", "today")}, "today_by": by(v["today_by"]),
                         "top_model": max(v["m"], key=v["m"].get) if v["m"] else None,
                         **dict(zip(SHIP, shipped_by.get(k, [0] * len(SHIP))))} for k, v in per_seat.items()), key=lambda x: -x["all"])
        if prev is not None:
            order = [k for k, v in sorted(prev_seat.items(), key=lambda kv: -kv[1]["all"]) if v["all"] > 0]
            for b in board:
                b["prev_rank"] = order.index(b["seat"]) + 1 if b["seat"] in order else None
                b["prev_all"] = prev_seat.get(b["seat"], {}).get("all", 0)
        top = sorted(listed, key=lambda x: -(x[2] + x[3]))
        # records, all time: the biggest day, the hungriest session, the longest run of days with tokens
        records = {}
        if series:
            bd = max(series.items(), key=lambda kv: kv[1][0] + kv[1][1])
            records["biggest_day"] = {"day": bd[0], "all": bd[1][0] + bd[1][1]}
            run = best = 0; best_end = None; prev_day = None
            for d in sorted(series):
                if series[d][0] + series[d][1] <= 0:
                    continue
                run = run + 1 if prev_day and (datetime.fromisoformat(d) - datetime.fromisoformat(prev_day)).days == 1 else 1
                prev_day = d
                if run > best:
                    best, best_end = run, d
            records["longest_run"] = {"days": best, "until": best_end}
        if mine:
            hs = max(mine.items(), key=lambda kv: kv[1].get("f", 0) + kv[1].get("c", 0))
            records["hungriest_session"] = {"id": short_id(hs[0]), "project": hs[1].get("p"), "seat": seat_of(hs[1]),
                                            "all": hs[1].get("f", 0) + hs[1].get("c", 0)}
        if heat:
            wh = max(heat, key=heat.get)
            records["busiest_hour"] = {"weekday": int(wh.split("-")[0]), "hour": int(wh.split("-")[1])}
        cal_from = (t.date() - timedelta(days=7 * 25 + t.date().weekday())).isoformat()    # a Monday, 26 columns
        # the last 8 weeks, Monday to Sunday, per seat (for the Burner Belt): the last entry is this week so far
        monday = t.date() - timedelta(days=t.date().weekday())
        weeks = []
        for back in range(7, -1, -1):
            start = monday - timedelta(days=7 * back)
            keep = {(start + timedelta(days=i)).isoformat() for i in range(7)}
            per, commits = {}, {}
            for r in sessions.values():
                f, c, _ = sums(r, keep)
                k = seat_of(r)
                if f + c and k:
                    per[k] = per.get(k, 0) + f + c
                nc = ship_sum(r, keep)[0]
                if nc and k:
                    commits[k] = commits.get(k, 0) + nc
            weeks.append({"week": start.isoformat(), "seats": dict(sorted(per.items(), key=lambda kv: -kv[1])), "commits": commits})
        # milestones: the first day the office's running total crossed 1, 2 and 5 times each power of ten from a million
        milestones, run_total, rung = [], 0, 1_000_000
        for d in sorted(day_rows):
            run_total += day_rows[d].get("f", 0) + day_rows[d].get("c", 0)
            while run_total >= rung:
                milestones.append({"at": rung, "day": d})
                rung = next_rung(rung)
        return {
            "scanning": scanning or not scanned_at, "scanned_at": scanned_at or None,
            "since": min(day_rows) if day_rows else None, "range": rng, "seat": seat,
            "shipped": dict(zip(SHIP, [sum(v[i] for k, v in shipped_by.items() if seat is None or k == seat) for i in range(len(SHIP))])),
            "total": {"all": tot[0] + tot[1], "fresh": tot[0], "cache": tot[1], "output": tot[2],
                      "messages": sum((r.get("n", 0) for r in mine.values())) if cur is None else None,
                      "sessions": len(listed)},
            "prev_total": ({"all": sum(sum(series.get(d, [0, 0, 0])[:2]) for d in prev)} if prev is not None else None),
            "prev_partial": bool(prev is not None and day_rows and min(day_rows) > min(prev)),   # the period before is not all on record
            "today": sum(series.get(today, [0, 0, 0])[:2]),
            "today_by": by(series.get(today, [0, 0, 0])),
            "seats": board,
            "days": [row(d, series[d]) for d in sorted(series)[-days:]] if cur is None else
                    [row(d, series.get(d, [0, 0, 0])) for d in sorted(cur)] if month else
                    [row(d, series.get(d, [0, 0, 0])) for d in sorted(span(0, max(length, 7)))],
            "calendar": [row(d, v) for d, v in sorted(series.items()) if d >= cal_from],
            "heat": {k: round(v) for k, v in heat.items()},
            "months": [{"month": m, "all": v[0] + v[1], "fresh": v[0], "output": v[2]} for m, v in sorted(months.items())],
            "models": sorted(({"model": m, **v} for m, v in models.items() if v["all"] > 0), key=lambda x: -x["all"]),
            "projects": sorted(({"project": p, "all": v["all"], "fresh": v["fresh"], "output": v["output"], "sessions": v["sessions"],
                                 "top_seat": max(v["seats"], key=v["seats"].get) if v["seats"] else None}
                                for p, v in projects.items()), key=lambda x: -x["all"])[:12],
            "sessions": [{"id": short_id(sid), "project": r.get("p"), "seat": k, "all": f + c, "fresh": f, "cache": c, "output": o,
                          "messages": r.get("n", 0), "first": r.get("fi"), "last": r.get("l")}
                         for sid, r, f, c, o, k in (top if all_sessions else top[:12])],
            "records": records,
            "weeks": weeks,
            "milestones": milestones,
        }

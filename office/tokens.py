"""All-time token use, from the transcripts already on disk.

Claude Code writes every API response into a session transcript (`<config>/projects/<project>/<session>.jsonl`, and
subagents under `<session>/subagents/`) with its `usage`. The ledger reads those files once, then only what was
appended since, and keeps running totals per session, per day and per model in `state/tokens.json`. A session belongs
to the seat whose config dir holds `session-env/<session id>` (seats may share one projects dir through symlinks, so
the transcript alone cannot say), or to the seat the office saw it live in. Codex rollouts count for the Codex seat.

Tokens are counted three ways: fresh (input + cache writes + output), cache reads, and output alone. "All" is fresh
plus cache reads: every token the model processed. Only counts and project folder names are kept, never content.

Version 2 keeps each session's days split by measure ([fresh, cache, output]) and its tokens by weekday and hour, for
ranges, leaderboards that move, a calendar and a heatmap. Version 3 counts a response that Claude Code writes as several
lines (its output grows line by line) by its final usage, and a response copied into a forked subagent's file once.
Version 4 also keeps, per day, the tokens of helpers (subagents), the thinking in the output, and web searches and
page fetches, for "where the tokens go".
An older file is rebuilt from the transcripts still on disk while the old numbers keep showing; a session whose
transcript Claude Code has since deleted keeps what the old file had.
"""
from __future__ import annotations

import json
from collections import deque
import os
import re
import statistics
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import config, prices

VERSION = 4
SHIP_RULES = 16               # bumped when the rules for shipped work, prices or waits change: every transcript is read again
RANGES = {"today": 1, "7": 7, "30": 30, "90": 90, "all": None}
# Shipped work, read from the Bash tool calls in the transcripts: what a command did, confirmed by its result.
SHIP = ("commits", "pushes", "prs_opened", "prs_merged", "insertions", "deletions")
# Waits on a person, in seconds: the histogram's upper edges. A gap past the last one is time away, not waiting.
WAIT_EDGES = (10, 20, 30, 45, 60, 90, 120, 180, 240, 300, 420, 600, 900, 1200, 1800, 2400, 3600, 5400, 7200)
_STOP = re.compile(rb'"stop_reason":\s*"(\w+)"')
_ASST, _USER = re.compile(rb'"type":\s*"assistant"'), re.compile(rb'"type":\s*"user"')
_SIDE, _META = re.compile(rb'"isSidechain":\s*true'), re.compile(rb'"isMeta":\s*true')
_TYPED = re.compile(rb'"promptSource":\s*"typed"|"origin":\s*\{\s*"kind":\s*"human"')   # typed, or a suggestion accepted
_STAT = re.compile(r"(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?")
_PUSHED = re.compile(r"\b[0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40}\s+\S+ -> \S+|\* \[new branch\]")   # "..." is a forced update
_PUSH_FAIL = re.compile(r"! \[(?:remote )?rejected\]|error: failed to push|^fatal:", re.M)
_HOOK_FAIL = re.compile(r"\.{3,}\s*failed\b|- hook id:|^fatal:", re.M)              # pre-commit's "black....Failed"
_NO_OUTPUT = "(bash completed with no output)"                           # Claude Code's words for an empty result
_BACKGROUNDED = re.compile(r"moved to the background|running in the background with id", re.I)
_QUIET = r"(?:\s-[a-zA-Z]*q[a-zA-Z]*\b|\s--quiet\b|>\s*/dev/null)"                 # -q, -qm, -qam, --quiet, >/dev/null
_PR_URL = re.compile(r"/pull/(\d+)")
_CWD = re.compile(rb'"cwd":\s*"([^"]{1,1024})"')
_START = r"(?:^|[;&|(\n])\s*(?:[A-Za-z_]\w*=\S*\s+)*"                 # a command's start, after any VAR=value
_GIT = _START + r"git\b(?:\s+-[-\w]+(?:[ =][^\s;&|]+)?)*\s+"
_GH = _START + r"gh\s+pr\s+"
_MERGE_ARGS = re.compile(_GH + r"merge\b([^;&|\n]*)")
_MERGE_NO = re.compile(r"already merged|not mergeable|automatically merged|merge queue|auto-merge")   # nothing merged now
_MERGE_YES = re.compile(r"\bmerged pull request\b|\"state\":\s*\"merged\"|^merged\b", re.M)          # gh's words, or a gh pr view
_MERGE_ERR = re.compile(r"graphql|is expected|could not|^x |^! |^error|^fatal", re.M)
_COMMIT_LINE = re.compile(r"^\[[^\]\n]+ [0-9a-f]{7,40}\]", re.M)
_COMMIT_NO = re.compile(r"nothing (?:added )?to commit|no changes added|aborting commit")   # not "error:": later commands print those


REBUILD_MIN = 20_000           # a cache write this big after the cache expired counts as a cold rebuild
TOOL_MAX_S = 4 * 3600          # a tool call longer than this is a session left open, not a slow tool


def api_kind(d: dict) -> str | None:
    """An API error line's kind: server (5xx, overloaded), connection, login or other; None for a usage limit."""
    err = str(d.get("error") or "")
    text = ""
    for c in ((d.get("message") or {}).get("content") or []) if isinstance(d.get("message"), dict) else []:
        if isinstance(c, dict) and c.get("type") == "text":
            text = str(c.get("text") or "")
    if err == "rate_limit" or "hit your" in text and "limit" in text:
        return None
    if "authentication" in err or "authenticate" in text.lower():
        return "login"
    if "reach the API" in text or "connection" in text.lower() or "ECONN" in text or "timed out" in text.lower():
        return "connection"
    if err in ("server_error", "overloaded_error", "api_error") or "overloaded" in text.lower() or re.search(r"API Error: 5\d\d", text):
        return "server"
    return "other"


def tool_group(name: str) -> str:
    """A tool's name for Where the time goes: MCP tools by their server, the rest as they are."""
    if name.startswith("mcp__"):
        return "MCP: " + (name.split("__")[1] if name.count("__") >= 2 else name[5:])
    return "Agent" if name in ("Task", "Agent") else name or "?"


def _redact(text: str) -> str:
    from .sessions import redact
    return redact(text)


def strip_heredocs(cmd: str) -> str:
    """A command without its heredoc bodies: a script written to a file is not a script that ran (one linear pass,
    shared with the desks' screens and the risky-action watch)."""
    from .sessions import strip_heredocs as strip
    return strip(cmd)


def ship_kinds(cmd: str) -> set:
    """What a shell command would ship if it succeeds: commit, push, pr_open, pr_merge (pr_auto: an auto-merge;
    commit_q and push_q: quiet ones, which print nothing when they work)."""
    cmd = strip_heredocs(cmd)
    out = set()
    for verb in ("commit", "push"):
        m = re.search(_GIT + verb + r"(?![-\w])([^;&|\n]*)", cmd)          # not commit-tree: plumbing
        if m:
            out.add(verb)
            if re.search(_QUIET, " " + m.group(1)):
                out.add(verb + "_q")
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
    if text.strip().lower() == _NO_OUTPUT:
        text = ""
    if _BACKGROUNDED.search(text):                         # still running when the result came back: nothing known yet
        return v
    low = text.lower()
    if "commit" in kinds:
        lines = len(_COMMIT_LINE.findall(text))
        # a commit prints "[branch abc1234] subject"; a quiet one prints nothing, unless a hook or git itself failed
        if lines or ("commit_q" in kinds and not _COMMIT_NO.search(low) and not _HOOK_FAIL.search(low)):
            v[0] = max(1, lines)
            for m in _STAT.finditer(text):
                v[4] += int(m.group(2) or 0)
                v[5] += int(m.group(3) or 0)
    if "push" in kinds and not _PUSH_FAIL.search(text) and (_PUSHED.search(text) or not text.strip() or "push_q" in kinds):
        v[1] = 1
    if "pr_open" in kinds and _PR_URL.search(text):
        v[2] = 1
    # gh prints nothing when it merges without a terminal; the cleanup after a merge can fail without undoing it
    if "pr_merge" in kinds and not _MERGE_NO.search(low) and (
            _MERGE_YES.search(low) or ("pr_auto" not in kinds and not _MERGE_ERR.search(low))):
        v[3] = 1
    return v


_COMMIT_ITEM = re.compile(r"^\[([^\]\n]+?) ([0-9a-f]{7,40})\] (.+)$", re.M)
_COMMIT_MSG = re.compile(r"\bcommit\b[^|;&\n]*?\s-[a-zA-Z]*m[ =]?(?:\"((?:\\.|[^\"\\])*)\"|'([^']*)'|(\S+))")
_COMMIT_HEREDOC = re.compile(r"\bcommit\b[^\n]*?-[a-zA-Z]*m[ =]?\"?\$\(cat\s*<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n\s*([^\n]*)")
_PR_TITLE = re.compile(r"--title[ =](?:\"((?:\\.|[^\"\\])*)\"|'([^']*)'|(\S+))")


def ship_items(kinds: set, cmd: str, text: str, v: list) -> list[dict]:
    """What a command shipped, item by item, for "Shipped today": each commit's short sha and subject, a PR opened
    with its title, a PR merged."""
    out = []
    if v[0]:
        for m in _COMMIT_ITEM.finditer(text):
            out.append({"k": "c", "sha": m.group(2)[:9], "sub": _redact(" ".join(m.group(3).split()))[:120], "b": _redact(m.group(1).split()[-1])[:60]})
        if not out:                                       # a quiet commit (-q) prints nothing: its message from the command
            ms = list(_COMMIT_MSG.finditer(strip_heredocs(cmd)))   # the command itself, not a script or a file it writes
            msg = next((g for g in ms[-1].groups() if g), "") if ms else ""
            if msg.lstrip().startswith("$(cat"):         # -m "$(cat <<'EOF' … EOF)": the subject is the heredoc's first line
                hs = list(_COMMIT_HEREDOC.finditer(cmd))
                msg = hs[-1].group(2) if hs else ""
            sub = next((ln.strip() for ln in msg.replace("\\n", "\n").splitlines() if ln.strip()), "")   # the subject line only
            out.append({"k": "c", "sha": None, "sub": _redact(sub)[:120] or "a commit"})
    if v[2]:
        t = _PR_TITLE.search(cmd)
        out.append({"k": "po", "n": pr_number({"pr_open"}, cmd, text), "sub": _redact(" ".join((next((g for g in t.groups() if g), "") if t else "").split()))[:120]})
    if v[3]:
        out.append({"k": "pm", "n": pr_number(kinds, cmd, text)})
    return out


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


def _usd_days(r: dict) -> dict:
    """A session's list price per day, in USD: as priced response by response, or estimated from its models for a
    session counted before costs were kept."""
    if r.get("$"):
        return {d: v / 1e6 for d, v in r["$"].items()}
    ms, out = r.get("m") or {}, {}
    whole = sum(ms.values()) or 1
    for d, v in (r.get("d") or {}).items():
        f, c, o = v if isinstance(v, list) else [0, v, 0]
        x = [prices.estimate(m, f * w / whole, c * w / whole, o * w / whole) for m, w in ms.items()]
        if any(y is not None for y in x):
            out[d] = sum(y for y in x if y is not None)
    return out


def wait_median(hist) -> int | None:
    """The median wait (seconds) from a histogram over WAIT_EDGES, read off linearly inside its bucket."""
    n = sum(hist)
    if not n:
        return None
    half, run = n / 2, 0
    for i, c in enumerate(hist):
        if c and run + c >= half:
            lo = WAIT_EDGES[i - 1] if i else 0
            return round(lo + (WAIT_EDGES[i] - lo) * (half - run) / c)
        run += c
    return WAIT_EDGES[-1]


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
        self.cwds: set = set()                  # folders the sessions worked in, seen while reading (for loose.py; not saved)
        self._serve = None                      # while a rebuild runs, the old numbers keep showing (view reads this)
        self._old_extras = None                 # shipped work and prices kept across a rules change, for sessions not read again
        self._seen_ids: dict = {}               # registry name -> {session -> {hash of response or tool id}}: forks copy lines
        self._seen_total = 0
        self._read_sids: set = set()            # sessions whose files this scan read
        self._counted = None                    # what the response being read (self._last) has been counted at so far
        self._helper_file = False               # the file being read is a helper's (a subagent's)
        self._tool_open: dict = {}
        self.api_recent: deque = deque(maxlen=500)   # (when, kind, seat) of the last day's API errors, as they are read
        self._xusd = 0                          # the same, for its price
        self.data = self._load()

    # -- state ----------------------------------------------------------------------------------------------------
    def _empty(self) -> dict:
        return {"v": VERSION, "sr": SHIP_RULES, "files": {}, "files_out": {}, "codex": {}, "sessions": {}, "days": {}, "models": {}}

    def _load(self) -> dict:
        try:
            d = config.read_state(self.path)            # a damaged file is set aside (and rebuilt from the transcripts)
            if d.get("v") in (1, 2, 3):            # rebuilt from the transcripts on the first scan; see _merge_legacy
                self._legacy = d
                self._serve = d if d.get("v") >= 2 else None    # the old numbers show until the rebuild is done
                return self._empty()
            if d.get("v") == VERSION:
                if d.get("sr") != SHIP_RULES:          # recount shipped work and costs from the transcripts still on disk
                    self._serve = json.loads(json.dumps(d))
                    d["files_out"] = {}
                    self._old_extras = {}
                    for sid, r in (d.get("sessions") or {}).items():
                        kept = {k: r.pop(k) for k in ("g", "$", "$m", "w", "web", "sl", "rb", "lm", "tt", "su", "ae") if k in r}
                        if kept:
                            self._old_extras[sid] = kept
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
            if self._old_extras is not None:               # sessions whose transcripts are gone keep what they had
                with self.lock:
                    for sid, kept in self._old_extras.items():
                        if sid not in self._read_sids and sid in self.data["sessions"]:
                            self.data["sessions"][sid].update(kept)
                self._old_extras = None; changed = True
            self._serve = None
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
                if any(isinstance(v, list) for v in (r.get("d") or {}).values()):     # version 2: already split by measure
                    self.data["sessions"][sid] = {**r, "legacy": True}
                    for day, (df, dc, do) in r["d"].items():
                        _add(self.data["days"].setdefault(day, {}), df, dc, do, 0)
                    whole = max(1, r.get("f", 0) + r.get("c", 0))
                    for m, v in (r.get("m") or {}).items():
                        sh = v / whole
                        _add(self.data["models"].setdefault(m, {}), round(r.get("f", 0) * sh), round(r.get("c", 0) * sh), round(r.get("o", 0) * sh), 0)
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
        offset, last_id = rec[0], rec[1]
        self._counted = rec[2] if len(rec) > 2 else None
        if size < offset:                                  # rewritten from scratch: start over from here on
            offset = size
        out = self.data.setdefault("files_out", {}).get(key, 0)          # shipped work and costs have their own offset
        out = out if isinstance(out, list) else [out, None]
        out_off, self._xlast, self._xusd = out[0], out[1], (out[2] if len(out) > 2 else 0)
        self._wait_end = out[3] if len(out) > 3 else None
        out_off = min(out_off, size)
        start = min(offset, out_off)
        if size == start:
            return False
        project_dir, sid = self._session_of(root, path)
        self._read_sids.add(sid)
        self._helper_file = "subagents" in path.relative_to(root).parts      # a helper's own transcript
        self._tool_open: dict = {}                                           # tool calls still waiting for their result (_tool_time)
        changed = False
        pos = start
        self._ts = None
        with open(path, "rb") as fh:                       # line by line: a transcript can be hundreds of MB
            fh.seek(start)
            for raw in fh:
                if not raw.endswith(b"\n"):                # a line still being written: read it next time
                    break
                at, pos = pos, pos + len(raw)
                cw = _CWD.search(raw, 0, 4096) if len(self.cwds) < 5000 else None
                if cw:
                    self.cwds.add(cw.group(1).decode(errors="replace"))
                if at >= offset:
                    changed |= self._take(raw, sid, last_id)
                    last_id = self._last
                if at >= out_off:
                    changed |= self._ship(raw, sid)
                    if not self._helper_file:              # helpers never wait on a person
                        changed |= self._note_wait(raw, sid)
        self.data["files_out"][key] = [pos, self._xlast, self._xusd, self._wait_end]
        if pos <= offset:
            return changed
        if not self.data["sessions"].get(sid, {}).get("p"):
            with self.lock:
                if sid in self.data["sessions"]:
                    self.data["sessions"][sid]["p"] = project_dir.rsplit("-", 1)[-1] or project_dir
        self.data["files"][key] = [pos, last_id, self._counted]
        return changed

    def _seen(self, registry: str, sid: str, key) -> bool:
        """True when this response or tool call was already counted in another file of the session (a forked
        subagent's file starts with a copy of its parent's lines); otherwise remember it. Bounded: the oldest
        sessions are forgotten first."""
        if not key:
            return False
        reg = self._seen_ids.setdefault(registry, {})
        ids = reg.pop(sid, None)
        if ids is None:
            ids = set()
        reg[sid] = ids                                    # most recent session last
        h = hash(key)
        if h in ids:
            return True
        ids.add(h); self._seen_total += 1
        while self._seen_total > 400_000 and len(reg) > 1:
            old = next(iter(reg))
            self._seen_total -= len(reg.pop(old))
        return False

    def _ship(self, raw: bytes, sid: str) -> bool:
        """Bash calls that commit, push, or open or merge a PR, counted when their result comes back without an error;
        and each API response's list price (see prices.py)."""
        m = re.search(rb'"timestamp":\s*"([^"]+)"', raw)
        if m:
            self._ts = m.group(1).decode()
        priced = self._cost(raw, sid) if b'"usage"' in raw and b'"assistant"' in raw else False   # a line can carry both
        if not self._helper_file and (b'"tool_use"' in raw or b'"tool_result"' in raw):
            priced |= self._tool_time(raw, sid)
        if b'"isApiErrorMessage"' in raw:
            priced |= self._api_error(raw, sid)
        if b'"tool_use"' in raw and (b'"WebSearch"' in raw or b'"WebFetch"' in raw):
            priced |= self._web(raw, sid)
        if b'"tool_use"' in raw and b'"Bash"' in raw and (b"git" in raw or b"gh " in raw):
            try:
                d = json.loads(raw)
            except ValueError:
                return priced
            content = (d.get("message") or {}).get("content") if isinstance(d, dict) else None
            for c in content if isinstance(content, list) else []:
                if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Bash":
                    cmd = str((c.get("input") or {}).get("command") or "")
                    kinds = ship_kinds(cmd)
                    if kinds and not self._seen("tool", sid, c.get("id")):
                        self._pending[c.get("id")] = (kinds, cmd)
                        if len(self._pending) > 500:
                            self._pending.pop(next(iter(self._pending)))
            return priced
        if b'"tool_result"' not in raw or not self._pending:
            return priced
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
                if v[0] or v[2] or v[3]:                        # the items themselves, for "Shipped today"
                    lst = s.setdefault("sl", {}).setdefault(day or "?", [])
                    have = {x.get("sha") for x in lst if x.get("sha")}
                    for it in ship_items(kinds, cmd, text, v):
                        if not (it.get("sha") and it["sha"] in have):
                            lst.append(dict(it, at=_epoch(self._ts)))
                    del lst[:-60]                               # the newest 60 a session shipped that day
            changed = True
            at = _epoch(self._ts)
            if self.scans and at and time.time() - at < 900:     # fresh work makes news and XP, never from the first read
                kind = "pr_merged" if v[3] else "pr_opened" if v[2] else "commit" if v[0] else "push"
                pr = pr_number(kinds if v[3] else {"pr_open"}, cmd, text) if v[2] or v[3] else None
                self.events.append({"session": sid, "kind": kind, "v": v[:4], "pr": pr, "at": at})
        return changed

    def _web(self, raw: bytes, sid: str) -> bool:
        """Web searches and page fetches, per day as [searches, fetches]: the WebSearch and WebFetch calls themselves
        (Claude Code leaves the usage's server_tool_use counts at zero)."""
        try:
            d = json.loads(raw)
        except ValueError:
            return False
        content = (d.get("message") or {}).get("content") if isinstance(d, dict) and d.get("type") == "assistant" else None
        hit = [0, 0]
        for c in content if isinstance(content, list) else []:
            if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") in ("WebSearch", "WebFetch") \
                    and not self._seen("tool", sid, c.get("id")):
                hit[c["name"] == "WebFetch"] += 1
        if not any(hit):
            return False
        day, _ = _when(self._ts)
        with self.lock:
            s = self.data["sessions"].setdefault(sid, {"p": None, "s": None, "fi": None, "l": None, "m": {}, "d": {}, "h": {}})
            v = s.setdefault("web", {}).setdefault(day or "?", [0, 0])
            v[0] += hit[0]; v[1] += hit[1]
        return True

    def _note_wait(self, raw: bytes, sid: str) -> bool:
        """How long a session waited on its person: from a turn's end to the next prompt someone typed. Kept per day as
        [seconds, replies, longest, away, when the longest began, then a histogram over WAIT_EDGES]. Lanes never wait
        (nobody types to them); a prompt from the harness (a finished helper, a script) means it was not waiting."""
        if _SIDE.search(raw):
            return False
        if _ASST.search(raw):
            m = _STOP.search(raw)
            if m:                                          # null while a response is still being written
                self._wait_end = None if m.group(1) == b"tool_use" else _epoch(self._ts)   # end_turn, stop_sequence: its turn is over
            return False
        if not _USER.search(raw) or b'"tool_result"' in raw or _META.search(raw):
            return False
        if not _TYPED.search(raw):
            self._wait_end = None
            return False
        end, at = self._wait_end, _epoch(self._ts)
        self._wait_end = None
        if end is None or at is None or at < end:
            return False
        gap = at - end
        day, _ = _when(self._ts)
        with self.lock:
            s = self.data["sessions"].setdefault(sid, {"p": None, "s": None, "fi": None, "l": None, "m": {}, "d": {}, "h": {}})
            w = s.setdefault("w", {}).setdefault(day or "?", [0, 0, 0, 0, None] + [0] * len(WAIT_EDGES))
            if gap > WAIT_EDGES[-1]:
                w[3] += 1
                return True
            w[0] += round(gap); w[1] += 1
            if gap > w[2]:
                w[2], w[4] = round(gap), round(end)
            w[5 + next(i for i, e in enumerate(WAIT_EDGES) if gap <= e)] += 1
        return True

    def _api_error(self, raw: bytes, sid: str) -> bool:
        """An API error a session met (Claude Code writes them into the transcript): per day and kind. Usage limits are
        the plan, counted elsewhere; the rest is the connection's weather. The last day's are kept for "now"."""
        try:
            d = json.loads(raw)
        except ValueError:
            return False
        kind = api_kind(d) if isinstance(d, dict) and d.get("isApiErrorMessage") is True else None
        if not kind:
            return False
        day, _ = _when(d.get("timestamp"))
        at = _epoch(d.get("timestamp"))
        with self.lock:
            s = self.data["sessions"].setdefault(sid, {"p": None, "s": None, "fi": None, "l": None, "m": {}, "d": {}, "h": {}})
            e = s.setdefault("ae", {}).setdefault(day or "?", {})
            e[kind] = e.get(kind, 0) + 1
            if at and time.time() - at < 86400:
                self.api_recent.append((at, kind, s.get("s")))
        return True

    def _tool_time(self, raw: bytes, sid: str) -> bool:
        """How long each tool call took, from its call to its result (main conversations only): per day and tool,
        [calls, seconds, longest]. MCP tools go by their server; helpers (Agent) by themselves."""
        try:
            d = json.loads(raw)
        except ValueError:
            return False
        m = d.get("message") if isinstance(d, dict) else None
        content = m.get("content") if isinstance(m, dict) else None
        at = _epoch(d.get("timestamp")) if isinstance(d, dict) else None
        if not isinstance(content, list) or not at:
            return False
        changed = False
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use" and c.get("id"):
                self._tool_open[c["id"]] = (tool_group(str(c.get("name") or "")), at)
                if len(self._tool_open) > 400:
                    self._tool_open.pop(next(iter(self._tool_open)))
            elif c.get("type") == "tool_result":
                p = self._tool_open.pop(c.get("tool_use_id"), None)
                if not p or not 0 <= at - p[1] <= TOOL_MAX_S:
                    continue
                dur, (day, _) = at - p[1], _when(d.get("timestamp"))
                with self.lock:
                    s = self.data["sessions"].setdefault(sid, {"p": None, "s": None, "fi": None, "l": None, "m": {}, "d": {}, "h": {}})
                    e = s.setdefault("tt", {}).setdefault(day or "?", {}).setdefault(p[0], [0, 0.0, 0.0])
                    e[0] += 1; e[1] = round(e[1] + dur, 1); e[2] = max(e[2], round(dur, 1))
                changed = True
        return changed

    def _startup(self, sid: str, u: dict, ts) -> None:
        """A session's start-up weight: the whole prompt of its first response (system prompt, tools, MCP servers,
        CLAUDE.md and the first message), what it pays before doing any work. Kept once, with its day."""
        with self.lock:
            s = self.data["sessions"].setdefault(sid, {"p": None, "s": None, "fi": None, "l": None, "m": {}, "d": {}, "h": {}})
            if s.get("su"):
                return
            n = lambda k: int(u.get(k) or 0)
            day, _ = _when(ts)
            s["su"] = [day or "?", n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens")]

    def _rebuild(self, sid: str, model: str, u: dict, ts) -> None:
        """A cold-cache rebuild: a response that wrote a large prompt back into the cache after the conversation sat
        longer than the cache lives (5 minutes, or an hour for 1-hour writes), so what a warm cache would have read
        cheaply was written again. Per day: [rebuilds, tokens written, extra list price in micro-dollars]."""
        at = _epoch(ts)
        if not at:
            return
        n = lambda k, d=u: int((d or {}).get(k) or 0)
        cw, split = n("cache_creation_input_tokens"), u.get("cache_creation") if isinstance(u.get("cache_creation"), dict) else {}
        ttl = 3600 if n("ephemeral_1h_input_tokens", split) * 2 > cw else 300
        with self.lock:
            s = self.data["sessions"].setdefault(sid, {"p": None, "s": None, "fi": None, "l": None, "m": {}, "d": {}, "h": {}})
            prev = s.get("lm")
            s["lm"] = max(prev or 0, at)
            if not prev or at - prev <= ttl or cw < REBUILD_MIN:
                return
            mode = {k: u[k] for k in ("speed", "inference_geo") if k in u}     # fast mode and regional prices apply too
            extra = max(0, (prices.response_cost(model, {"cache_creation_input_tokens": cw, "cache_creation": split, **mode}) or 0)
                        - (prices.response_cost(model, {"cache_read_input_tokens": cw, **mode}) or 0))
            day, _ = _when(ts)
            r = s.setdefault("rb", {}).setdefault(day or "?", [0, 0, 0])
            r[0] += 1; r[1] += cw; r[2] += extra

    def _cost(self, raw: bytes, sid: str) -> bool:
        try:
            d = json.loads(raw)
        except ValueError:
            return False
        m = d.get("message") if isinstance(d, dict) else None
        u = m.get("usage") if isinstance(m, dict) else None
        if d.get("type") != "assistant" or not isinstance(u, dict):
            return False
        mid = m.get("id")
        model = m.get("model") or "?"
        usd = prices.response_cost(model, u) or 0
        if mid and mid == self._xlast:                      # one response, several lines as its output grows
            if self._xusd is None or usd <= self._xusd:
                return False
            usd, self._xusd = usd - self._xusd, usd           # price only what this line adds
        else:
            self._xlast = mid
            if mid and self._seen("cost", sid, mid):          # priced in another file of this session
                self._xusd = None
                return False
            self._xusd = usd
            if not self._helper_file:
                self._rebuild(sid, model, u, d.get("timestamp"))
                self._startup(sid, u, d.get("timestamp"))
        if not usd:
            return False
        day, _ = _when(d.get("timestamp"))
        with self.lock:
            s = self.data["sessions"].setdefault(sid, {"p": None, "s": None, "fi": None, "l": None, "m": {}, "d": {}, "h": {}})
            c = s.setdefault("$", {}); c[day or "?"] = c.get(day or "?", 0) + usd
            cm = s.setdefault("$m", {}); cm[model] = cm.get(model, 0) + usd
        return True

    def take_events(self) -> list:
        """Work shipped since the last call (from scans after the first): commits, pushes, PRs opened or merged, each
        {"session", "kind", "v": [commits, pushes, prs opened, prs merged], "pr", "at"}, for news and XP."""
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
        model = m.get("model") or "?"
        if model.startswith("<"):                      # <synthetic> lines are not API calls
            return False
        n = lambda k, d=u: int((d or {}).get(k) or 0)
        f = n("input_tokens") + n("cache_creation_input_tokens") + n("output_tokens")
        c, o = n("cache_read_input_tokens"), n("output_tokens")
        tools = u.get("server_tool_use") if isinstance(u.get("server_tool_use"), dict) else {}
        details = u.get("output_tokens_details") if isinstance(u.get("output_tokens_details"), dict) else {}
        now = [f, c, o, n("thinking_tokens", details), n("web_search_requests", tools), n("web_fetch_requests", tools)]
        new = 1
        if mid and mid == last_id:                     # one response written as several lines, its output growing
            was = self._counted
            if was is None:
                return False
            was = (list(was) + [0, 0, 0])[:6]
            delta = [max(0, a - b) for a, b in zip(now, was)]
            if not any(delta):
                return False
            self._counted = [max(a, b) for a, b in zip(now, was)]
            now, new = delta, 0                         # count only what this line adds
        else:
            self._last = mid
            if mid and self._seen("take", sid, mid):   # a forked subagent's copy of its parent's line
                self._counted = None
                return False
            self._counted = list(now)
        f, c, o, think, searches, fetches = now
        (day, wh), at = _when(d.get("timestamp")), _epoch(d.get("timestamp"))
        with self.lock:
            s = self.data["sessions"].setdefault(sid, {"p": None, "s": None, "fi": at, "l": at, "m": {}, "d": {}, "h": {}})
            if not s.get("p") and d.get("cwd"):
                s["p"] = os.path.basename(d["cwd"].rstrip("/")) or d["cwd"]
            if at:
                s["fi"] = min(s.get("fi") or at, at); s["l"] = max(s.get("l") or at, at)
            _add(s, f, c, o, new)
            s["m"][model] = s["m"].get(model, 0) + f + c
            if day:
                v = s["d"].setdefault(day, [0, 0, 0]); v[0] += f; v[1] += c; v[2] += o
                _add(self.data["days"].setdefault(day, {}), f, c, o, new)
                if self._helper_file or think or searches or fetches:     # where the tokens go: helpers, thinking, web
                    x = s.setdefault("x", {}).setdefault(day, [0, 0, 0, 0])
                    x[0] += (f + c) if self._helper_file else 0; x[1] += think; x[2] += searches; x[3] += fetches
            if wh:
                h = s.setdefault("h", {}); h[wh] = h.get(wh, 0) + f + c
            _add(self.data["models"].setdefault(model, {}), f, c, o, new)
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

    def project_cwds(self) -> set:
        """The folder each project's newest transcript worked in, from its first lines: where the sessions have been,
        for loose.py to find their repositories. Reads a few KB per project folder."""
        out = set()
        for root in self._projects_dirs():
            try:
                folders = [e for e in os.scandir(root) if e.is_dir()]
            except OSError:
                continue
            for d in folders:
                try:
                    newest = max((e for e in os.scandir(d.path) if e.name.endswith(".jsonl")), key=lambda e: e.stat().st_mtime, default=None)
                    if newest:
                        with open(newest.path, "rb") as fh:
                            m = _CWD.search(fh.read(65536))
                        if m:
                            out.add(m.group(1).decode(errors="replace"))
                except OSError:
                    continue
        return out

    def spent(self, sids) -> dict | None:
        """What sessions have cost so far: all tokens, fresh ones, output and their list price in USD (helpers included)."""
        tok = fresh = out = usd = 0
        seen = False
        with self.lock:
            src = (self._serve or self.data)["sessions"]
            for sid in sids:
                r = src.get(sid)
                if r:
                    seen = True
                    tok += r.get("f", 0) + r.get("c", 0); fresh += r.get("f", 0); out += r.get("o", 0); usd += sum((r.get("$") or {}).values())
        return {"tokens": tok, "fresh": fresh, "output": out, "usd": round(usd / 1e6, 2)} if seen else None

    def shipped_for(self, sids) -> dict | None:
        """What sessions shipped: commits, pushes, PRs opened and merged, lines (for a lane's outcome)."""
        tot, seen = [0] * len(SHIP), False
        with self.lock:
            src = (self._serve or self.data)["sessions"]
            for sid in sids:
                for v in ((src.get(sid) or {}).get("g") or {}).values():
                    seen = True
                    for i, x in enumerate(v):
                        tot[i] += x
        return dict(zip(SHIP, tot)) if seen else None

    def last_call(self) -> dict:
        """When each seat last made an API call from this machine (epoch seconds), from the transcripts read so far."""
        with self.lock:
            if getattr(self, "_last_call", None) and self._last_call[0] == self.scanned_at:
                return self._last_call[1]
            out: dict = {}
            for r in (self._serve or self.data)["sessions"].values():
                k, at = r.get("s"), r.get("l")
                if k and at and at > out.get(k, 0):
                    out[k] = at
            self._last_call = (self.scanned_at, out)
            return out

    def weather(self, now: float | None = None) -> dict:
        """The connection's weather now: the API errors sessions met in the last 30 minutes (not logins, which Needs
        you covers): clear, cloudy (one or two) or stormy (three or more)."""
        now = now or time.time()
        with self.lock:
            recent = [(at, k) for at, k, _ in self.api_recent if now - at < 1800 and k != "login"]
        by: dict = {}
        for _, k in recent:
            by[k] = by.get(k, 0) + 1
        n = len(recent)
        return {"sky": "stormy" if n >= 3 else "cloudy" if n else "clear", "errors": n, "by_kind": by, "last_at": max((a for a, _ in recent), default=None)}

    def per_day_seat(self, known: set, codex: str | None = None) -> dict:
        """Every day's tokens and shipped work per seat (for exports and the monthly report):
        {(day, seat or None): [fresh, cache, output, usd, commits, prs_opened, prs_merged]}."""
        out: dict = {}
        with self.lock:
            src = (self._serve or self.data)["sessions"]
            for r in src.values():
                k = codex if r.get("s") == "@codex" else (r.get("s") if r.get("s") in known else None)
                usd = _usd_days(r)
                for d, v in (r.get("d") or {}).items():
                    f, c, o = v if isinstance(v, list) else [0, v, 0]
                    e = out.setdefault((d, k), [0, 0, 0, 0.0, 0, 0, 0])
                    e[0] += f; e[1] += c; e[2] += o
                for d, v in usd.items():
                    out.setdefault((d, k), [0, 0, 0, 0.0, 0, 0, 0])[3] += v
                for d, v in (r.get("g") or {}).items():
                    e = out.setdefault((d, k), [0, 0, 0, 0.0, 0, 0, 0])
                    e[4] += v[0]; e[5] += v[2]; e[6] += v[3]
        return out

    def shipped_by_seat(self, known: set, codex: str | None = None) -> dict:
        """All-time (commits, PRs merged) per seat, for the shipping achievements."""
        out: dict = {}
        with self.lock:
            for r in (self._serve or self.data)["sessions"].values():
                k = codex if r.get("s") == "@codex" else r.get("s")
                if k not in known or not r.get("g"):
                    continue
                x = out.setdefault(k, [0, 0])
                for v in r["g"].values():
                    x[0] += v[0]; x[1] += v[3]
        return {k: tuple(v) for k, v in out.items()}

    def shipped_list(self, day: str, known: set, codex: str | None = None) -> list[dict]:
        """One day's shipped items across the office, oldest first: {k, sha|n, sub, b, at, seat, project, session}."""
        out = []
        with self.lock:
            for sid, r in (self._serve or self.data)["sessions"].items():
                for it in ((r.get("sl") or {}).get(day) or []):
                    k = codex if r.get("s") == "@codex" else r.get("s")
                    out.append(dict(it, seat=k if k in known else None, project=r.get("p"), session=sid))
        return sorted(out, key=lambda x: x.get("at") or 0)

    def shipped_on(self, day: str, known: set, codex: str | None = None) -> dict:
        """One day's commits, PRs opened and PRs merged, for the office and per seat (the lobby's ship board)."""
        with self.lock:
            key = (self.scanned_at, day, tuple(sorted(known)), codex)
            if getattr(self, "_shipped_on", None) and self._shipped_on[0] == key:
                return self._shipped_on[1]
            tot, seats = [0, 0, 0], {}
            for r in (self._serve or self.data)["sessions"].values():
                v = (r.get("g") or {}).get(day)
                if not v or not (v[0] or v[2] or v[3]):
                    continue
                row = (v[0], v[2], v[3])
                k = codex if r.get("s") == "@codex" else r.get("s")
                for i, x in enumerate(row):
                    tot[i] += x
                if k in known:
                    seats[k] = [a + b for a, b in zip(seats.get(k, [0, 0, 0]), row)]
            out = {"day": day, "commits": tot[0], "prs_opened": tot[1], "prs_merged": tot[2], "seats": seats}
            self._shipped_on = (key, out)
            return out

    def run(self, stop: threading.Event, live=lambda: {}, every: float = 120) -> None:
        """Scan now, then every `every` seconds, until stop."""
        while not stop.is_set():
            try:
                self.scan(live())
            except Exception:                              # the ledger is a nicety; never let it stop the office
                pass
            stop.wait(every)

    # -- one project ----------------------------------------------------------------------------------------------
    def view_project(self, name: str, seats: list[dict], today: str | None = None, days: int = 30) -> dict:
        """One project (the folder its sessions worked in): tokens, API value and shipped work per day, the seats and
        models that worked on it and its biggest sessions, over the last `days` days, with its all-time totals."""
        t = datetime.fromisoformat(today or datetime.now().date().isoformat()).date()
        keep = [(t - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
        inside = set(keep)
        codex = next((x["id"] for x in seats if x.get("kind") == "codex"), None)
        known = {x["id"] for x in seats}
        seat_of = lambda r: codex if r.get("s") == "@codex" else (r.get("s") if r.get("s") in known else None)
        with self.lock:
            src = self._serve or self.data
            mine = {sid: dict(r) for sid, r in src["sessions"].items() if r.get("p") == name}
        per_day = {d: [0, 0, 0, 0.0] for d in keep}                        # fresh, cache, output, USD
        tot, ever, ship = [0, 0, 0, 0.0], [0, 0, 0, 0.0], [0] * len(SHIP)
        by_seat, models, rows = {}, {}, []
        for sid, r in mine.items():
            usd, k, sess = _usd_days(r), seat_of(r), [0, 0, 0, 0.0]
            for d, v in (r.get("d") or {}).items():
                f, c, o = v if isinstance(v, list) else [0, v, 0]
                ever[0] += f; ever[1] += c; ever[2] += o
                if d in inside:
                    x = per_day[d]; x[0] += f; x[1] += c; x[2] += o
                    sess[0] += f; sess[1] += c; sess[2] += o
            for d, v in usd.items():
                ever[3] += v
                if d in inside:
                    per_day[d][3] += v; sess[3] += v
            for d, v in (r.get("g") or {}).items():
                if d in inside:
                    for i, n in enumerate(v):
                        ship[i] += n
            if not sess[0] + sess[1]:
                continue
            for i in range(4):
                tot[i] += sess[i]
            b = by_seat.setdefault(k, {"seat": k, "all": 0, "usd": 0.0, "sessions": 0})
            b["all"] += sess[0] + sess[1]; b["usd"] += sess[3]; b["sessions"] += 1
            whole = max(1, r.get("f", 0) + r.get("c", 0))
            for m, v in (r.get("m") or {}).items():                       # the range's share, split by the session's models
                models[m] = models.get(m, 0) + round((sess[0] + sess[1]) * v / whole)
            rows.append({"id": short_id(sid), "session": sid, "seat": k, "first": r.get("fi"), "last": r.get("l"),
                         "all": sess[0] + sess[1], "usd": round(sess[3], 2)})
        rows.sort(key=lambda x: -x["all"])
        return {"project": name, "range_days": days, "since": keep[0],
                "days": [{"day": d, "all": v[0] + v[1], "fresh": v[0], "output": v[2], "usd": round(v[3], 2)} for d, v in per_day.items()],
                "total": {"all": tot[0] + tot[1], "fresh": tot[0], "output": tot[2], "usd": round(tot[3], 2), "sessions": len(rows)},
                "all_time": {"all": ever[0] + ever[1], "usd": round(ever[3], 2), "sessions": len(mine),
                             "first": min((r.get("fi") for r in mine.values() if r.get("fi")), default=None)},
                "seats": sorted(({**b, "usd": round(b["usd"], 2)} for b in by_seat.values()), key=lambda x: -x["all"]),
                "models": sorted(({"model": m, "all": v} for m, v in models.items() if v), key=lambda x: -x["all"]),
                "sessions": rows[:12], "shipped": dict(zip(SHIP, ship))}

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
            src = self._serve or self.data                  # the old numbers while a rebuild runs
            sessions = {k: dict(v) for k, v in src["sessions"].items()}
            day_rows = {k: dict(v) for k, v in src["days"].items()}
            models_all = {k: dict(v) for k, v in src["models"].items()}
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
        priced: dict = {}
        def usd_days(sid, r):                                             # a session's list price per day, in USD
            if sid not in priced:
                priced[sid] = _usd_days(r)
            return priced[sid]
        usd_in = lambda sid, r, keep: sum(v for d, v in usd_days(sid, r).items() if keep is None or d in keep)
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
        listed, estimated = [], 0.0
        for sid, r in sessions.items():
            k = seat_of(r)
            f, c, o = sums(r, cur)
            usd = usd_in(sid, r, cur)
            if prev is not None:
                pf, pc, po = sums(r, prev)
                ps = prev_seat.setdefault(k, {"all": 0, "fresh": 0, "output": 0, "usd": 0})
                ps["all"] += pf + pc; ps["fresh"] += pf; ps["output"] += po; ps["usd"] += usd_in(sid, r, prev)
            if f + c:
                st = per_seat.setdefault(k, {"all": 0, "fresh": 0, "output": 0, "usd": 0, "sessions": 0, "today": 0, "today_by": [0, 0, 0], "today_usd": 0, "m": {}})
                st["all"] += f + c; st["fresh"] += f; st["output"] += o; st["usd"] += usd; st["sessions"] += 1
                st["today_usd"] += usd_days(sid, r).get(today, 0)
                td = trip((r.get("d") or {}).get(today, [0, 0, 0]))
                st["today"] += td[0] + td[1]
                st["today_by"] = [a + b for a, b in zip(st["today_by"], td)]
                for m, v in (r.get("m") or {}).items():
                    st["m"][m] = st["m"].get(m, 0) + v
            if sid not in mine or not f + c:
                continue
            whole = max(1, r.get("f", 0) + r.get("c", 0))
            cost_m = r.get("$m") or {}
            cost_whole = sum(cost_m.values()) or 1
            for m, v in (r.get("m") or {}).items():                       # a session's range, split by its models
                share = v / whole
                mm = models.setdefault(m, {"all": 0, "fresh": 0, "output": 0, "usd": 0})
                mm["all"] += round((f + c) * share); mm["fresh"] += round(f * share); mm["output"] += round(o * share)
                mm["usd"] += usd * (cost_m.get(m, 0) / cost_whole if cost_m else share)
            for m in cost_m:                                              # a model priced but never counted (rare)
                if m not in (r.get("m") or {}):
                    models.setdefault(m, {"all": 0, "fresh": 0, "output": 0, "usd": 0})["usd"] += usd * cost_m[m] / cost_whole
            if not r.get("$") and r.get("s") != "@codex" and usd:
                estimated += usd
            if r.get("p") and r.get("s") != "@codex":
                pr = projects.setdefault(r["p"], {"all": 0, "fresh": 0, "output": 0, "usd": 0, "sessions": 0, "seats": {}})
                pr["all"] += f + c; pr["fresh"] += f; pr["output"] += o; pr["usd"] += usd; pr["sessions"] += 1
                if k:
                    pr["seats"][k] = pr["seats"].get(k, 0) + f + c
            if cur is None:                                               # the heatmap follows the range when it can
                for wh, v in (r.get("h") or {}).items():
                    heat[wh] = heat.get(wh, 0) + v
            listed.append((sid, r, f, c, o, k, usd))
        if cur is not None:                                               # hours are not kept per day: use the sessions active in range
            for sid, r, f, c, o, k, _ in listed:
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
        usd_series: dict = {}
        for sid, r in mine.items():
            for d, v in usd_days(sid, r).items():
                usd_series[d] = usd_series.get(d, 0) + v
        row = lambda d, v: {"day": d, "all": v[0] + v[1], "fresh": v[0], "output": v[2], "usd": round(usd_series.get(d, 0), 2)}
        by = lambda v, usd=0: {"all": v[0] + v[1], "fresh": v[0], "output": v[2], "usd": round(usd, 2)}   # one day, every measure
        in_range = {d: v for d, v in series.items() if cur is None or d in cur}
        tot = [sum(v[i] for v in in_range.values()) for i in range(3)]
        months: dict = {}
        for d, v in series.items():
            m = months.setdefault(d[:7], [0, 0, 0, 0]); m[0] += v[0]; m[1] += v[1]; m[2] += v[2]
        for d, v in usd_series.items():
            if d[:7] in months:
                months[d[:7]][3] += v
        tot_usd = sum(v for d, v in usd_series.items() if cur is None or d in cur)
        where = [0, 0, 0, 0]                                              # helpers' tokens, thinking, web searches, page fetches
        rebuilt, rebuilt_by = [0, 0, 0], {}                               # cold-cache rebuilds: count, tokens, extra micro-dollars
        for r in sessions.values():
            for d, v in (r.get("rb") or {}).items():
                if cur is None or d in cur:
                    x = rebuilt_by.setdefault(seat_of(r), [0, 0, 0])
                    for i in range(3):
                        x[i] += v[i]
                        if seat is None or seat_of(r) == seat:
                            rebuilt[i] += v[i]
        for r in mine.values():
            for d, v in (r.get("x") or {}).items():
                if cur is None or d in cur:
                    where[0] += v[0]; where[1] += v[1]
            for d, v in (r.get("web") or {}).items():                    # counted from the calls (see _web)
                if cur is None or d in cur:
                    where[2] += v[0]; where[3] += v[1]
        api: dict = {}                                                    # the connection's weather: errors per day and kind
        for r in mine.values():
            for d, per in (r.get("ae") or {}).items():
                if cur is None or d in cur:
                    e = api.setdefault(d, {})
                    for k, n in per.items():
                        e[k] = e.get(k, 0) + n
        starts: dict = {}                                                 # start-up weight: per seat, each session's first prompt
        for r in mine.values():
            su = r.get("su")
            if su and su[1] and (cur is None or su[0] in cur):
                starts.setdefault(seat_of(r), []).append(su[1])
        tools: dict = {}                                                  # where the time goes: per tool, [calls, seconds, longest]
        for r in mine.values():
            for d, per in (r.get("tt") or {}).items():
                if cur is None or d in cur:
                    for name, v in per.items():
                        e = tools.setdefault(name, [0, 0.0, 0.0])
                        e[0] += v[0]; e[1] += v[1]; e[2] = max(e[2], v[2])
        waits, longest, wait_days = [0, 0, 0] + [0] * len(WAIT_EDGES), [], {}  # seconds, replies, away, histogram
        for sid, r in mine.items():
            for d, v in (r.get("w") or {}).items():
                if cur is None or d in cur:
                    waits[0] += v[0]; waits[1] += v[1]; waits[2] += v[3]
                    for i in range(len(WAIT_EDGES)):
                        waits[3 + i] += v[5 + i]
                    x = wait_days.setdefault(d, [0, 0]); x[0] += v[0]; x[1] += v[1]
                    if v[2]:
                        longest.append((v[2], v[4], sid, r))
        longest.sort(key=lambda x: -x[0])
        board = sorted(({"seat": k, **{x: v[x] for x in ("all", "fresh", "output", "sessions", "today")}, "usd": round(v["usd"], 2),
                         "today_by": by(v["today_by"], v["today_usd"]),
                         "top_model": max(v["m"], key=v["m"].get) if v["m"] else None,
                         **dict(zip(SHIP, shipped_by.get(k, [0] * len(SHIP)))),
                         **dict(zip(("rebuilds", "rebuild_tokens"), rebuilt_by.get(k, [0, 0])[:2]))} for k, v in per_seat.items()), key=lambda x: -x["all"])
        if prev is not None:                                              # the place each seat had, in every measure
            orders = {m: [k for k, v in sorted(prev_seat.items(), key=lambda kv: -kv[1][m]) if v[m] > 0] for m in ("all", "fresh", "output", "usd")}
            for b in board:
                b["prev_rank_by"] = {m: (o.index(b["seat"]) + 1 if b["seat"] in o else None) for m, o in orders.items()}
                b["prev_rank"] = b["prev_rank_by"]["all"]
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
        # What the plans cost over the range, against the list price of the tokens of the seats on them.
        plan_days = (len([d for d in cur if d <= today]) if cur is not None else
                     (t.date() - datetime.fromisoformat(min(day_rows)).date()).days + 1 if day_rows else 0)
        plans = {x["id"]: p for x in seats if (seat is None or x["id"] == seat) and (p := prices.plan_usd(x)) is not None}
        plan_cost = sum(plans.values()) * plan_days / 30.44
        covered = sum(b["usd"] for b in board if b["seat"] in plans)
        for b in board:
            b["plan_month"] = plans.get(b["seat"])
        return {
            "where": {"helpers": where[0], "main": max(0, tot[0] + tot[1] - where[0]), "thinking": where[1], "output": tot[2],
                      "searches": where[2], "fetches": where[3],
                      "rebuilds": rebuilt[0], "rebuild_tokens": rebuilt[1], "rebuild_usd": round(rebuilt[2] / 1e6, 2)},
            "api_errors": {"days": dict(sorted(api.items())), "by_kind": {k: sum(e.get(k, 0) for e in api.values()) for k in ("server", "connection", "login", "other")}},
            "startup": {"sessions": sum(len(v) for v in starts.values()), "tokens": sum(sum(v) for v in starts.values()),
                        "median": round(statistics.median([x for v in starts.values() for x in v])) if starts else None,
                        "seats": sorted(({"seat": k, "sessions": len(v), "median": round(statistics.median(v)), "tokens": sum(v)} for k, v in starts.items()),
                                        key=lambda e: -e["median"])},
            "tools": [{"tool": k, "calls": v[0], "seconds": round(v[1]), "avg": round(v[1] / v[0], 1) if v[0] else 0, "max": round(v[2])}
                      for k, v in sorted(tools.items(), key=lambda kv: -kv[1][1])[:14]],
            "waits": {"seconds": waits[0], "replies": waits[1], "away": waits[2], "median_s": wait_median(waits[3:]),
                      "days": dict(sorted(wait_days.items())) if cur is not None else None,
                      "longest": [{"wait_s": w, "at": at, "id": short_id(sid), "project": r.get("p"), "seat": seat_of(r)}
                                  for w, at, sid, r in longest[:5]]},
            "value": {"usd": round(tot_usd, 2), "estimated": round(min(estimated, tot_usd), 2), "plans": plans, "days": plan_days,
                      "plan_usd": round(plan_cost, 2), "covered_usd": round(covered, 2),
                      "multiple": round(covered / plan_cost, 1) if plan_cost else None},
            "scanning": scanning or not scanned_at, "scanned_at": scanned_at or None, "rebuilding": src is not self.data,
            "since": min(day_rows) if day_rows else None, "range": rng, "seat": seat,
            "shipped": dict(zip(SHIP, [sum(v[i] for k, v in shipped_by.items() if seat is None or k == seat) for i in range(len(SHIP))])),
            "total": {"all": tot[0] + tot[1], "fresh": tot[0], "cache": tot[1], "output": tot[2], "usd": round(tot_usd, 2),
                      "messages": sum((r.get("n", 0) for r in mine.values())) if cur is None else None,
                      "sessions": len(listed)},
            "prev_total": ({"all": sum(sum(series.get(d, [0, 0, 0])[:2]) for d in prev), "usd": round(sum(usd_series.get(d, 0) for d in prev), 2)}
                           if prev is not None else None),
            "prev_partial": bool(prev is not None and day_rows and min(day_rows) > min(prev)),   # the period before is not all on record
            "today": sum(series.get(today, [0, 0, 0])[:2]),
            "today_by": by(series.get(today, [0, 0, 0]), usd_series.get(today, 0)),
            "seats": board,
            "days": [row(d, series[d]) for d in sorted(series)[-days:]] if cur is None else
                    [row(d, series.get(d, [0, 0, 0])) for d in sorted(cur)] if month else
                    [row(d, series.get(d, [0, 0, 0])) for d in sorted(span(0, max(length, 7)))],
            "calendar": [row(d, v) for d, v in sorted(series.items()) if d >= cal_from],
            "heat": {k: round(v) for k, v in heat.items()},
            "months": [{"month": m, "all": v[0] + v[1], "fresh": v[0], "output": v[2], "usd": round(v[3], 2)} for m, v in sorted(months.items())],
            "models": sorted(({"model": m, **v, "usd": round(v["usd"], 2)} for m, v in models.items() if v["all"] > 0 or v["usd"] > 0), key=lambda x: -x["all"]),
            "projects": sorted(({"project": p, "all": v["all"], "fresh": v["fresh"], "output": v["output"], "usd": round(v["usd"], 2), "sessions": v["sessions"],
                                 "top_seat": max(v["seats"], key=v["seats"].get) if v["seats"] else None}
                                for p, v in projects.items()), key=lambda x: -x["all"])[:12],
            "sessions": [{"id": short_id(sid), "project": r.get("p"), "seat": k, "all": f + c, "fresh": f, "cache": c, "output": o, "usd": round(usd, 2),
                          "messages": r.get("n", 0), "first": r.get("fi"), "last": r.get("l")}
                         for sid, r, f, c, o, k, usd in (top if all_sessions else top[:12])],
            "records": records,
            "weeks": weeks,
            "milestones": milestones,
        }

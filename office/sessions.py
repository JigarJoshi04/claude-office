"""Live Claude Code sessions on each seat, and what each one is doing right now.

A session is live when ``<config_dir>/sessions/<pid>.json`` names a running process whose kernel start time
matches the recorded ``procStart`` (so a recycled pid never counts). What it is doing comes from its transcript,
which is parsed incrementally: only bytes appended since the last look are read.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime
from pathlib import Path

HEAD_BYTES = 256 * 1024
TAIL_BYTES = 3 * 1024 * 1024
LEDGER_SECONDS = 6 * 3600
LIMIT_RE = re.compile(r"(hit your .*limit|usage limit|limit reached|session limit)", re.I)
RESET_RE = re.compile(r"resets? (?:at )?([^·\n]+?)(?:$|·|\n)", re.I)
PATH_RE = re.compile(r"(/[^\s'\"`]+?(STATE|REPORT)\.md)")
# Things that look like credentials are masked before any text reaches the page.
SECRET_RE = re.compile(
    r"(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}"
    r"|(?i:bearer)\s+[A-Za-z0-9._~+/=-]{16,}"
    r"|(?i:(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)[^\s'\"]{6,})")


def redact(text):
    """Mask credential-shaped substrings. Commit SHAs and ids stay readable."""
    if not text or not isinstance(text, str):
        return text
    return SECRET_RE.sub(lambda m: m.group(0)[:6] + "…[hidden]", text)


# ---------------------------------------------------------------------------------------------- processes

def proc_start_ticks(pid: int) -> str | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    rest = raw[raw.rfind(")") + 2:].split()
    return rest[19] if len(rest) > 19 else None


def proc_argv(pid: int) -> list[str]:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().decode(errors="replace").split("\0")[:-1]
    except OSError:
        return []


def proc_unit(pid: int) -> str | None:
    """The systemd unit (service or scope) a process runs in, from its cgroup path."""
    try:
        line = Path(f"/proc/{pid}/cgroup").read_text().strip().splitlines()[-1]
    except (OSError, IndexError):
        return None
    for part in reversed(line.split("/")):
        if part.endswith(".service") or part.endswith(".scope"):
            return part
    return None


def proc_cpu_seconds(pid: int) -> float | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        rest = raw[raw.rfind(")") + 2:].split()
        return (int(rest[11]) + int(rest[12])) / os.sysconf("SC_CLK_TCK")
    except (OSError, IndexError, ValueError):
        return None


def prompt_from_argv(argv: list[str]) -> str | None:
    for i, a in enumerate(argv):
        if a in ("-p", "--print") and i + 1 < len(argv) and not argv[i + 1].startswith("-"):
            return argv[i + 1]
    return None


# --------------------------------------------------------------------------------------------- transcripts

def project_dir_name(cwd: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def find_transcript(config_dir: str, cwd: str, session_id: str) -> Path | None:
    projects = Path(config_dir) / "projects"
    p = projects / project_dir_name(cwd) / f"{session_id}.jsonl"
    if p.exists():
        return p
    hits = list(projects.glob(f"*/{session_id}.jsonl"))
    return hits[0] if hits else None


def _ts(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _short(text: str, n: int) -> str:
    text = redact(" ".join(str(text).split()))
    return text if len(text) <= n else text[: n - 1] + "…"


def describe_tool(name: str, inp: dict) -> tuple[str, str]:
    """(one-line activity, animation kind) for a tool call."""
    inp = inp if isinstance(inp, dict) else {}
    base = lambda p: os.path.basename(str(p).rstrip("/")) or str(p)
    if name == "Bash":
        what = inp.get("description") or inp.get("command") or ""
        return _short(what, 70) or "Running a command", "type"
    if name in ("Edit", "MultiEdit", "NotebookEdit"):
        return f"Editing {base(inp.get('file_path') or inp.get('notebook_path') or '')}", "type"
    if name == "Write":
        return f"Writing {base(inp.get('file_path', ''))}", "type"
    if name == "Read":
        return f"Reading {base(inp.get('file_path', ''))}", "read"
    if name in ("Grep", "Glob"):
        return f"Searching {_short(inp.get('pattern', ''), 40)}", "read"
    if name in ("Agent", "Task"):
        return f"Delegating: {_short(inp.get('description') or inp.get('prompt') or '', 50)}", "delegate"
    if name in ("WebFetch", "WebSearch"):
        return "Browsing the web", "read"
    if name in ("TodoWrite", "TaskCreate", "TaskUpdate"):
        return "Updating the plan", "think"
    if name == "Skill":
        return f"Using skill {inp.get('skill', '')}".strip(), "think"
    if name == "Monitor" or name == "ScheduleWakeup":
        return "Waiting on a background job", "wait"
    if name == "Artifact":
        return "Publishing a page", "type"
    if name == "ToolSearch":
        return "Loading tools", "think"
    if name.startswith("mcp__"):
        parts = name.split("__")
        server = parts[1].replace("claude_ai_", "") if len(parts) > 1 else "mcp"
        return f"{server}: {parts[-1].replace('_', ' ')}", "read"
    return name, "type"


def _user_text(content) -> str | None:
    """Text of a real human/task prompt, or None for tool results and harness notices."""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        if any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content):
            return None
        text = " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    else:
        return None
    t = text.strip()
    if not t or t.startswith("<") or t.startswith("[SYSTEM") or t.startswith("Caveat:"):
        return None
    return t


class TranscriptState:
    __slots__ = ("path", "offset", "size", "mtime", "title", "first_prompt", "last_prompt", "model",
                 "last_ts", "activity", "activity_kind", "recent", "tool_calls", "ledger", "seen_ids",
                 "limited_at", "limit_text", "last_text", "partial", "ino")

    def __init__(self, path: Path):
        self.path = path
        self.offset = 0
        self.size = -1
        self.mtime = 0
        self.title = None
        self.first_prompt = None
        self.last_prompt = None
        self.model = None
        self.last_ts = None
        self.activity = None
        self.activity_kind = None
        self.recent: list[dict] = []
        self.tool_calls = 0
        self.ledger: list[tuple[float, int, int]] = []  # (ts, fresh input+output tokens, cache-read tokens)
        self.seen_ids: dict[str, float] = {}
        self.limited_at = None
        self.limit_text = None
        self.last_text = None
        self.partial = b""
        self.ino = None

    # -- parsing -------------------------------------------------------------------------------------------
    def feed_line(self, line: bytes) -> None:
        try:
            d = json.loads(line)
        except ValueError:
            return
        if not isinstance(d, dict):
            return
        t = d.get("type")
        if t == "ai-title":
            if isinstance(d.get("aiTitle"), str):
                self.title = redact(d["aiTitle"])
            return
        if t == "last-prompt":
            if isinstance(d.get("lastPrompt"), str) and d["lastPrompt"]:
                self.last_prompt = d["lastPrompt"]
            return
        ts = _ts(d.get("timestamp"))
        msg = d.get("message")
        if not isinstance(msg, dict):
            msg = {}
        if t == "user" and not d.get("isSidechain"):
            text = _user_text(msg.get("content"))
            if text:
                if not self.first_prompt:
                    self.first_prompt = text
                self.last_prompt = text
                self._push(ts, "Got a new instruction", "talk")
                self.limited_at = None
            if ts:
                self.last_ts = max(self.last_ts or 0, ts)
            return
        if t != "assistant":
            return
        if ts:
            self.last_ts = max(self.last_ts or 0, ts)
        model = msg.get("model")
        content = msg.get("content") if isinstance(msg.get("content"), list) else []
        if model == "<synthetic>":
            text = " ".join(str(c.get("text", "")) for c in content if isinstance(c, dict))
            if LIMIT_RE.search(text):
                self.limited_at = ts or time.time()
                self.limit_text = _short(text, 160)
                self._push(ts, "Hit the usage limit", "sleep")
            return
        if model:
            self.model = model
        mid = msg.get("id")
        usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
        if isinstance(mid, str) and mid not in self.seen_ids and usage and ts:
            self.seen_ids[mid] = ts
            fresh = int(usage.get("input_tokens") or 0) + int(usage.get("output_tokens") or 0) \
                + int(usage.get("cache_creation_input_tokens") or 0)
            self.ledger.append((ts, fresh, int(usage.get("cache_read_input_tokens") or 0)))
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use":
                self.tool_calls += 1
                text, kind = describe_tool(str(c.get("name") or ""), c.get("input") or {})
                if d.get("isSidechain"):
                    text, kind = f"Helper: {text}", kind
                self._push(ts, text, kind)
            elif c.get("type") == "text" and isinstance(c.get("text"), str) and c["text"].strip() and not d.get("isSidechain"):
                self.last_text = _short(c["text"], 400)
                self._push(ts, "Writing: " + _short(c["text"], 70), "talk")
            elif c.get("type") == "thinking" and not d.get("isSidechain"):
                self._push(ts, "Thinking", "think", dedupe=True)

    def _push(self, ts, text, kind, dedupe=False):
        if dedupe and self.recent and self.recent[-1]["text"] == text:
            self.recent[-1]["ts"] = ts or self.recent[-1]["ts"]
        else:
            self.recent.append({"ts": ts, "text": text, "kind": kind})
            del self.recent[:-12]
        self.activity, self.activity_kind = text, kind

    def trim(self, now: float) -> None:
        cut = now - LEDGER_SECONDS
        if self.ledger and self.ledger[0][0] < cut:
            self.ledger = [e for e in self.ledger if e[0] >= cut]
        if len(self.seen_ids) > 4000:
            self.seen_ids = {k: v for k, v in self.seen_ids.items() if v >= cut}

    def tokens(self, since: float) -> dict:
        fresh = sum(e[1] for e in self.ledger if e[0] >= since)
        cached = sum(e[2] for e in self.ledger if e[0] >= since)
        return {"fresh": fresh, "cached": cached, "turns": sum(1 for e in self.ledger if e[0] >= since)}


class TranscriptCache:
    def __init__(self):
        self._states: dict[str, TranscriptState] = {}
        self._lock = threading.Lock()

    def read(self, path: Path) -> TranscriptState:
        key = str(path)
        with self._lock:
            st = self._states.get(key)
            if st is None:
                st = self._states[key] = TranscriptState(path)
        try:
            stat = path.stat()
        except OSError:
            return st
        if stat.st_size == st.size and stat.st_mtime_ns == st.mtime and stat.st_ino == st.ino:
            return st
        if stat.st_size < st.offset or (st.ino is not None and stat.st_ino != st.ino):
            st = self._states[key] = TranscriptState(path)  # truncated or replaced: start again
        st.ino = stat.st_ino
        with open(path, "rb") as f:
            if st.size < 0 and stat.st_size > HEAD_BYTES + TAIL_BYTES:
                # First look at a big transcript: the head has the task, the tail has the present.
                head = f.read(HEAD_BYTES)
                for line in head.split(b"\n")[:-1]:
                    st.feed_line(line)
                st.recent.clear()
                st.ledger.clear()
                st.offset = stat.st_size - TAIL_BYTES
                f.seek(st.offset)
                f.readline()  # skip the partial line we landed in
                st.offset = f.tell()
            f.seek(st.offset)
            chunk = f.read()
        end = st.offset + len(chunk)
        data = st.partial + chunk
        lines = data.split(b"\n")
        st.partial = lines.pop()  # an incomplete last line is kept here, and its bytes are not read again
        for line in lines:
            if line:
                st.feed_line(line)
        st.offset = end
        st.size, st.mtime = stat.st_size, stat.st_mtime_ns
        st.trim(time.time())
        return st

    def forget_except(self, keep: set[str]) -> None:
        with self._lock:
            for k in list(self._states):
                if k not in keep:
                    del self._states[k]


# ------------------------------------------------------------------------------------------------ sessions

def _state_report_paths(*texts: str | None) -> tuple[str | None, str | None]:
    state = report = None
    for text in texts:
        for m in PATH_RE.finditer(text or ""):
            if m.group(2) == "STATE" and not state:
                state = m.group(1)
            elif m.group(2) == "REPORT" and not report:
                report = m.group(1)
    return state, report


def tail_text(path: str | None, max_lines: int = 12, max_bytes: int = 16384) -> str | None:
    if not path:
        return None
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            data = f.read().decode(errors="replace")
    except OSError:
        return None
    lines = [l for l in data.splitlines() if l.strip()]
    return redact("\n".join(lines[-max_lines:]))


def first_line(path: str | None) -> str | None:
    if not path:
        return None
    try:
        with open(path, "rb") as f:
            head = f.read(4096).decode(errors="replace")
    except OSError:
        return None
    for line in head.splitlines():
        if line.strip():
            return redact(line.strip()[:200])
    return None


def list_sessions(seat: dict, cache: TranscriptCache, now: float | None = None) -> list[dict]:
    now = now or time.time()
    out = []
    sdir = Path(seat["config_dir"]) / "sessions"
    for f in sdir.glob("*.json") if sdir.is_dir() else []:
        try:
            s = json.loads(f.read_text())
            pid = int(s["pid"])
        except (OSError, ValueError, KeyError, TypeError):
            continue
        start = proc_start_ticks(pid)
        if start is None or (s.get("procStart") and str(s["procStart"]) != start):
            continue
        argv = proc_argv(pid)
        prompt = prompt_from_argv(argv)
        headless = s.get("entrypoint") == "sdk-cli" or prompt is not None
        cwd = s.get("cwd") or ""
        tpath = find_transcript(seat["config_dir"], cwd, s.get("sessionId", "")) if s.get("sessionId") else None
        tr = cache.read(tpath) if tpath else None
        unit = proc_unit(pid)
        raw_status = s.get("status")
        last = max(filter(None, [tr.last_ts if tr else None, (s.get("updatedAt") or 0) / 1000])) \
            if (tr and tr.last_ts) or s.get("updatedAt") else None
        quiet = now - last if last else None
        if tr and tr.limited_at and (not tr.last_ts or tr.limited_at >= tr.last_ts - 1):
            state = "limited"
        elif raw_status == "idle":
            state = "idle"
        elif quiet is not None and quiet > 900:
            state = "stuck" if headless else "idle"
        elif quiet is not None and quiet > 90:
            state = "waiting"
        else:
            state = "working"
        task = prompt or (tr.first_prompt if tr else None)
        state_file, report_file = _state_report_paths(prompt, tr.first_prompt if tr else None)
        report_status = first_line(report_file) if report_file and os.path.exists(report_file) else None
        out.append({
            "id": s.get("sessionId"),
            "seat": seat["id"],
            "pid": pid,
            "name": s.get("name") or f"pid {pid}",
            "kind": "lane" if headless else "desk",
            "unit": unit if unit and unit.endswith(".service") else None,
            "terminal": unit if unit and unit.endswith(".scope") else None,
            "cwd": cwd,
            "started_at": (s.get("startedAt") or 0) / 1000 or None,
            "updated_at": last,
            "quiet_s": round(quiet) if quiet is not None else None,
            "raw_status": raw_status,
            "state": state,
            "activity": (tr.activity if tr else None) or ("Starting up" if headless else "At the desk"),
            "activity_kind": (tr.activity_kind if tr else None) or "think",
            "title": (tr.title if tr else None),
            "task": _short(task, 600) if task else None,
            "last_prompt": _short(tr.last_prompt, 300) if tr and tr.last_prompt else None,
            "last_text": tr.last_text if tr else None,
            "limit_text": tr.limit_text if tr and state == "limited" else None,
            "model": tr.model if tr else None,
            "tool_calls": tr.tool_calls if tr else 0,
            "recent": list(tr.recent[-8:]) if tr else [],
            "tokens_1h": tr.tokens(now - 3600) if tr else None,
            "tokens_5h": tr.tokens(now - 5 * 3600) if tr else None,
            "cpu_s": proc_cpu_seconds(pid),
            "state_file": state_file,
            "report_file": report_file,
            "report_status": report_status,
            "transcript": str(tpath) if tpath else None,
            "resume_cmd": f"CLAUDE_CONFIG_DIR={seat['config_dir']} claude --resume {s.get('sessionId')}"
                          if s.get("sessionId") else None,
        })
    order = {"working": 0, "waiting": 1, "limited": 2, "stuck": 3, "idle": 4}
    out.sort(key=lambda x: (order.get(x["state"], 9), -(x["updated_at"] or 0)))
    return out

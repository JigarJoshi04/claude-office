"""Live Claude Code sessions on each seat, and what each one is doing right now.

A session is live when ``<config_dir>/sessions/<pid>.json`` names a running process whose kernel start time
matches the recorded ``procStart`` (so a recycled pid never counts). What it is doing comes from its transcript,
which is parsed incrementally: only bytes appended since the last look are read.
"""
from __future__ import annotations

import bisect
import functools
import hashlib
import json
import os
import re
import threading
import time
from datetime import datetime
from pathlib import Path

from . import prices

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
    r"|(?i:(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\w{0,30}[\"']?\s*[=:]\s*[\"']?)(?=[^\s'\",}]*[A-Za-z])[^\s'\",}]{6,}"
    r"|(?i:aws_secret_access_key|aws_session_token)\s+[^\s'\"]{12,})")   # (bounded, so a long run of "token" never backtracks)
# Credentials that sit next to something worth keeping: the password in `user:pass@host`, `curl -u user:pass` and
# `mysql -pSecret` (the user and the host stay readable).
_URL_PASS = re.compile(r"(\b[a-z][\w+.-]{0,20}://[^\s/:@'\"]{1,100}:)[^\s@/'\"]{1,200}(?=@)")
_USER_PASS = re.compile(r"((?:\s-u|--user)[ =]?[A-Za-z][^\s:'\"]{0,100}:)[^\s'\"]+")      # not docker's -u 1000:1000
_MYSQL_P = re.compile(r"(\b(?:mysql|mysqldump|mariadb|mysqladmin)\b[^\n|;&]*?\s-p)[^\s'\"]{3,}")


def redact(text):
    """Mask credential-shaped substrings. Commit SHAs and ids stay readable."""
    if not text or not isinstance(text, str):
        return text
    text = SECRET_RE.sub(lambda m: m.group(0)[:6] + "…[hidden]", text)
    if ":" in text or "-p" in text:
        text = _URL_PASS.sub(r"\1…[hidden]", text)
        text = _USER_PASS.sub(r"\1…[hidden]", text)
        text = _MYSQL_P.sub(r"\1…[hidden]", text)
    return text


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


def proc_is_brain(pid: int) -> bool:
    """The office analyst's own `claude -p` (brain.py marks it CLAUDE_OFFICE_BRAIN=1): never a desk or a lane."""
    try:
        return b"CLAUDE_OFFICE_BRAIN=1" in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except OSError:
        return False


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


_GIT_CACHE: dict = {}


def git_place(cwd: str | None, now: float | None = None) -> dict | None:
    """The git repository a folder is in and its checked-out branch (or short commit when detached), read from .git
    without running git. Worktrees (a .git file pointing at the real git dir) work too. Cached for 20 seconds."""
    if not cwd:
        return None
    now = now or time.time()
    hit = _GIT_CACHE.get(cwd)
    if hit and now - hit[0] < 20:
        return hit[1]
    place = None
    try:
        p = Path(cwd)
        for d in (p, *p.parents):
            g = d / ".git"
            if g.is_dir():
                head = g / "HEAD"
            elif g.is_file():
                text = g.read_text(errors="replace").strip()
                if not text.startswith("gitdir:"):
                    break
                gitdir = Path(text[7:].strip())
                head = (gitdir if gitdir.is_absolute() else d / gitdir) / "HEAD"
            else:
                continue
            ref = head.read_text(errors="replace").strip()
            branch = ref[16:] if ref.startswith("ref: refs/heads/") else ref[:7]
            # a worktree's own folder name is not the project: name the repository by the main checkout when we can
            repo = d.name
            common = head.parent / "commondir"
            if common.exists():
                repo = (head.parent / common.read_text().strip()).resolve().parent.name or repo
            place = {"repo": repo, "branch": branch, "detached": not ref.startswith("ref: ")}
            break
    except OSError:
        place = None
    _GIT_CACHE[cwd] = (now, place)
    if len(_GIT_CACHE) > 500:
        _GIT_CACHE.pop(next(iter(_GIT_CACHE)))
    return place


def _ts(s: str | None) -> float | None:
    if not isinstance(s, str) or not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except (ValueError, OverflowError, OSError):
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


# A test run: a command segment that starts with a test runner (after env settings and wrappers like `timeout 60`).
_TEST_CMD = re.compile(r"^(?:\w+=\S*\s+)*(?:(?:time|nice|timeout\s+\S+|uv run|poetry run|npx|pipenv run)\s+)*"
                       r"(?:(?:python3?|py) -m (?:pytest|unittest)\b|pytest\b|tox\b|nox\b|jest\b|vitest\b|mocha\b|rspec\b|phpunit\b|ctest\b"
                       r"|(?:npm|pnpm|yarn|bun) (?:run )?test\b|(?:go|cargo|dotnet|mix|swift) test\b|node --test\b|make (?:test|check)\b)")


# A test run's output that says it failed, whatever the exit code (piped through tail, the exit code is tail's).
# (A summary line only: a test's own name can say "1 failed", as jest's "✓ retries a chunk when 1 failed" does.)
_TEST_FAILED = re.compile(r"\bFAILED\b|(?<!expected )\bfailures=[1-9]|\berrors=[1-9]|\b[1-9]\d* failed(?=,| in \d)|\b[1-9]\d* failing\b"
                          r"|ℹ fail [1-9]|^# fail [1-9]|^not ok\b|^\s*(?:Test Files|Tests:?)\s+[1-9]\d* failed\b|^\s*[1-9]\d* failed\s*$"
                          r"|^--- FAIL|^FAIL\b", re.M)


_HEREDOC_START = re.compile(r"<<-?\s*(['\"]?)(\w+)\1")


def strip_heredocs(cmd: str) -> str:
    """The command with each heredoc's body taken out (the lines up to the one that is just WORD). One pass over the lines
    (a backtracking regex took minutes on long scripts full of C++'s `cout << x`); a `<<` with no closing line stays."""
    if "<<" not in cmd:
        return cmd
    closers, i = {}, 0                               # WORD -> [(start, end)] of the lines that are just WORD
    for line in cmd.split("\n"):
        w = line.strip()
        if w and re.fullmatch(r"\w+", w):
            closers.setdefault(w, []).append((i, i + len(line)))
        i += len(line) + 1
    out, pos = [], 0
    for m in _HEREDOC_START.finditer(cmd):
        if m.start() < pos:
            continue
        nl = cmd.find("\n", m.end())
        if nl < 0:
            break
        ends = closers.get(m.group(2)) or []
        k = bisect.bisect_left(ends, (nl + 1, -1))   # the first closing line after the heredoc's first line
        if k < len(ends):                            # the body goes; the rest of its first line stays (`<<EOF && git push`)
            out.append(cmd[pos:m.start()] + cmd[m.end():nl])
            pos = ends[k][1]
    return "".join(out) + cmd[pos:]


_QUOTED_TARGET = re.compile(r"(>{1,2})\s*([\"'])([^\"'\n]{1,300})\2")


def _segments(cmd: str) -> list[str]:
    """A shell command's simple commands, with quoted strings and heredoc bodies taken out first, so a commit message
    or a script's text never reads as a command."""
    cmd = strip_heredocs(cmd)
    cmd = _QUOTED_TARGET.sub(lambda m: m.group(1) + " " + m.group(3).replace(" ", "_"), cmd)   # `>> "/x/STATE.md"` keeps its name
    cmd = re.sub(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", "''", cmd)
    return [seg.strip() for seg in re.split(r"&&|\|\||[;|\n(]", cmd)]


def screen_for(name: str, inp: dict) -> str | None:
    """What a desk's screen shows for a tool call: web, shell, test, mcp or publish (None: the pose decides)."""
    if name in ("WebFetch", "WebSearch"):
        return "web"
    if name == "Bash":
        cmd = str((inp if isinstance(inp, dict) else {}).get("command") or "")
        return "test" if any(_TEST_CMD.match(seg) for seg in _segments(cmd)) else "shell"
    if name.startswith("mcp__"):
        return "mcp"
    if name == "Artifact":
        return "publish"
    return None


_SHIP = re.compile(r"(?:git\s+(?:commit|push|tag)|gh\s+(?:pr\s+(?:create|merge|ready)|release\s+create))\b")
_LOOK = re.compile(r"(?:cat|ls|head|tail|grep|rg|find(?!.*\s-(?:delete|exec))|wc|tree|less|jq|git\s+(?:log|show|diff|status|blame|branch|fetch)"
                   r"|gh\s+(?:(?:pr|run|issue)\s+(?:view|list|checks|diff|watch|status)|api))\b")
_GIT_OPTS = re.compile(r"^git\s+(?:(?:-C|-c)\s+\S+\s+|--[\w-]+\s+)+")   # git -C <dir> / -c k=v / --no-pager before the verb
# A file written from the shell (not stderr, /dev/null, or the lane's own STATE and REPORT notes).
_WRITES = re.compile(r"^(?:cat|tee|printf|echo)\b.*?(?<![\d&>])>{1,2}(?!>)\s*(?!&|/dev/null)(?![^\s]*(?:STATE|REPORT)[^/\s]*\.md\b)\S")


def step_kind(name: str, inp, screen: str | None) -> str | None:
    """A tool call as a step of work: look, edit, run, test or ship (None: not telling)."""
    inp = inp if isinstance(inp, dict) else {}
    if screen == "test":
        return "test"
    if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        path = str(inp.get("file_path") or inp.get("notebook_path") or "")
        return "ship" if re.search(r"(?:^|/)REPORT[^/]*\.md$", path) else None if re.search(r"(?:^|/)STATE[^/]*\.md$", path) else "edit"
    if name in ("Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch") or name.startswith("mcp__"):
        return "look"
    if name == "Bash":
        segs = [_GIT_OPTS.sub("git ", x) for x in _segments(str(inp.get("command") or "")) if x and not re.match(r"cd\b", x)]
        if any(_SHIP.match(x) for x in segs):
            return "ship"
        if any(_WRITES.match(x) for x in segs):
            return "edit"
        return "look" if segs and all(_LOOK.match(x) for x in segs) else "run"
    return None


def _trust(report_status, tr):
    from .trust import trust_of                  # (trust.py imports this module)
    return trust_of(report_status, tr.test_ok, tr.test_at, tr.edit_at)


_ROOTS: dict[str, tuple[float, str | None]] = {}


def work_root(folder: str) -> str | None:
    """The git working tree a folder is in, remembered (a folder outside any repository is looked at again after five
    minutes, in case it became one)."""
    hit = _ROOTS.get(folder)
    if hit and (hit[1] or time.time() - hit[0] < 300):
        return hit[1]
    root = _work_root(folder)
    if len(_ROOTS) > 4096:
        _ROOTS.clear()
    _ROOTS[folder] = (time.time(), root)
    return root


work_root.cache_clear = _ROOTS.clear                    # (tests)


def _work_root(folder: str) -> str | None:
    """The git working tree a folder is in (the nearest parent with a real .git: a repository's HEAD, or a worktree's
    "gitdir:" file; a stray empty .git folder does not count), or None."""
    d = folder
    for _ in range(40):
        g = os.path.join(d, ".git")
        if os.path.exists(os.path.join(g, "HEAD")) or (os.path.isfile(g) and _gitdir_file(g)):
            return d
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up
    return None


def _gitdir_file(path: str) -> bool:
    try:
        with open(path) as fh:
            return fh.read(8) == "gitdir: "
    except OSError:
        return False


TOUCH_S = 15 * 60


def touch_of(edits: dict, now: float) -> dict | None:
    """What a session wrote in the last 15 minutes, for the collision alarm: its working trees ({root: last}) and its
    files by a short hash ({id: last}), so no file path reaches the page."""
    roots, files = {}, {}
    for path, ts in edits.items():
        if now - ts > TOUCH_S:
            continue
        root = work_root(os.path.dirname(path))
        if not root:                                     # outside any repository: not a collision
            continue
        roots[root] = max(roots.get(root, 0), ts)
        files.setdefault(root, {})[hashlib.sha1(path.encode()).hexdigest()[:12]] = ts   # compared within one tree
    return {"roots": roots, "files": files} if roots else None


def phase_of(steps: list[str], test_ok) -> str | None:
    """Where a session is in its work, from its last steps: exploring, building, testing, debugging or wrapping up."""
    if not steps:
        return None
    if "ship" in steps[-3:]:
        return "wrapping up"
    if steps[-1] == "test":
        return "testing"
    if test_ok is False and "test" in steps:
        return "debugging"
    last = steps[-6:]
    made = last.count("edit") + last.count("run")
    return "building" if made and made >= last.count("look") else "exploring"


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


def task_view(tr) -> dict | None:
    """The session's task list: how many are done, what it is on now, and the list (at most 20, unfinished first)."""
    if not tr or not tr.tasks:
        return None
    items = list(tr.tasks.values())
    done = sum(1 for x in items if x["status"] == "completed")
    now = next((x for x in items if x["status"] == "in_progress"), None)
    order = {"in_progress": 0, "pending": 1, "completed": 2}
    shown = items if len(items) <= 20 else sorted(items, key=lambda x: order.get(x["status"], 3))[:20]   # the list's own order
    return {"done": done, "total": len(items), "now": (now["active"] or now["subject"]) if now else None,
            "items": [{"subject": x["subject"], "status": x["status"]} for x in shown]}


def cache_view(tr) -> dict | None:
    """The session's prompt cache: until when it is warm, the context it holds, and what a reply saves while it is
    warm (a cooled cache is written again at the cache-write price instead of read at the cache-read price)."""
    if not tr or not tr.cache_at or not tr.context:
        return None
    p = prices.rates(tr.model)
    saves = round(tr.context * ((p[2] if tr.cache_ttl == 3600 else p[1]) - p[3]) / 1e6, 2) if p else None
    return {"until": tr.cache_at + tr.cache_ttl, "ttl": tr.cache_ttl, "context": tr.context, "saves_usd": saves,
            "window": prices.context_window(tr.model)}


class TranscriptState:
    __slots__ = ("path", "offset", "size", "mtime", "title", "first_prompt", "last_prompt", "model",
                 "last_ts", "activity", "activity_kind", "recent", "tool_calls", "ledger", "seen_ids",
                 "limited_at", "limit_text", "last_text", "partial", "ino", "fresh_total", "cache_at", "cache_ttl", "context",
                 "tasks", "task_pending", "helpers", "helpers_done", "repeat", "screen", "test_id", "test_ok", "test_at", "risks", "steps", "edit_at", "edits")

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
        self.fresh_total = 0
        self.ledger: list[tuple[float, int, int]] = []  # (ts, fresh input+output tokens, cache-read tokens)
        self.seen_ids: dict[str, float] = {}
        self.limited_at = None
        self.limit_text = None
        self.last_text = None
        self.partial = b""
        self.ino = None
        self.cache_at = None        # the main chain's last API response: its prompt cache lives until cache_at + cache_ttl
        self.cache_ttl = 300        # 5 minutes, or an hour once the session writes 1-hour cache entries
        self.context = 0            # that response's prompt: input, cache reads and cache writes
        self.tasks: dict = {}       # the session's own task list (TaskCreate/TaskUpdate, or TodoWrite): id -> task
        self.task_pending: dict = {}   # TaskCreate tool_use id -> (subject, activeForm), until its result names the id
        self.helpers: dict = {}        # Agent/Task tool_use id -> {"desc", "since", "bg"}: helpers at work right now
        self.helpers_done = 0          # how many have finished (the floor docks a drone each time it goes up)
        self.repeat = None             # [signature, times in a row, activity text, since]: the same tool call again and again
        self.screen = None             # what the desk's screen shows for the latest tool call (screen_for)
        self.test_id = None            # the last test run's tool_use id, until its result comes back
        self.test_ok = None            # whether the last test run passed (None: none seen yet)
        self.test_at = None
        self.risks: list[dict] = []    # risky tool calls (risk.py): {"id", "ts", "rule", "text"}, the last 20
        self.steps: list[str] = []     # the last main-chain tool calls by kind (step_kind), for its phase
        self.edit_at = None            # its last code change (a main-chain edit), for trust.py
        self.edits: dict = {}          # file path -> when it last wrote it (the last 30), for the collision alarm

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
        if t == "user" and not d.get("isSidechain") and self.helpers:
            self._helper_result(msg.get("content"))
        if t == "user" and not d.get("isSidechain") and self.test_id and isinstance(msg.get("content"), list):
            for c in msg["content"]:                # the last test run passed or failed: the desk's build light
                if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") == self.test_id:
                    body = c.get("content")
                    text = body if isinstance(body, str) else " ".join(x.get("text", "") for x in body if isinstance(x, dict)) if isinstance(body, list) else ""
                    self.test_ok, self.test_at, self.test_id = not c.get("is_error") and not _TEST_FAILED.search(text[-20000:]), ts, None
        if t == "attachment" and self.helpers and isinstance(d.get("attachment"), dict) \
                and d["attachment"].get("type") == "queued_command":   # a helper that finished while the session was busy
            self._helper_result(d["attachment"].get("prompt"))
        if t == "user" and not d.get("isSidechain") and self.task_pending and isinstance(msg.get("content"), list):
            for c in msg["content"]:                # "Task #3 created successfully: …" gives a new task its id
                if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in self.task_pending:
                    subject, active = self.task_pending.pop(c["tool_use_id"])
                    body = c.get("content")
                    body = body if isinstance(body, str) else " ".join(x.get("text", "") for x in body if isinstance(x, dict)) if isinstance(body, list) else ""
                    m = re.search(r"Task #(\w+) created", body)
                    if m and not c.get("is_error"):
                        self.tasks[m.group(1)] = {"subject": subject, "active": active, "status": "pending"}
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
        if isinstance(mid, str) and mid not in self.seen_ids and usage:
            self.seen_ids[mid] = ts or 0
            fresh = int(usage.get("input_tokens") or 0) + int(usage.get("output_tokens") or 0) \
                + int(usage.get("cache_creation_input_tokens") or 0)
            self.fresh_total += fresh
            if ts:
                self.ledger.append((ts, fresh, int(usage.get("cache_read_input_tokens") or 0)))
            if ts and not d.get("isSidechain"):
                cc = usage.get("cache_creation") if isinstance(usage.get("cache_creation"), dict) else {}
                if int(cc.get("ephemeral_1h_input_tokens") or 0) > 0:
                    self.cache_ttl = 3600
                elif int(cc.get("ephemeral_5m_input_tokens") or 0) > 0:
                    self.cache_ttl = 300
                self.cache_at = max(self.cache_at or 0, ts)
                self.context = int(usage.get("input_tokens") or 0) + int(usage.get("cache_read_input_tokens") or 0) \
                    + int(usage.get("cache_creation_input_tokens") or 0)
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use":
                if not d.get("isSidechain"):
                    self._task_tool(c)
                    self._note_repeat(c, ts)
                    if c.get("name") in ("Agent", "Task") and c.get("id"):     # a helper goes to work
                        inp = c.get("input") if isinstance(c.get("input"), dict) else {}
                        self.helpers[c["id"]] = {"desc": redact(_short(str(inp.get("description") or inp.get("prompt") or "a helper"), 80)),
                                                 "since": ts, "bg": bool(inp.get("run_in_background"))}
                        while len(self.helpers) > 24:
                            self.helpers.pop(next(iter(self.helpers)))
                self.tool_calls += 1
                from .risk import RULES, check as risk_check     # (risk.py imports this module)
                for rule, shown in risk_check(str(c.get("name") or ""), c.get("input")):
                    self.risks.append({"id": f"{c.get('id') or mid}:{rule}", "ts": ts, "rule": rule, "label": RULES[rule], "text": shown,
                                       "helper": bool(d.get("isSidechain"))})
                    del self.risks[:-20]
                text, kind = describe_tool(str(c.get("name") or ""), c.get("input") or {})
                if d.get("isSidechain"):
                    text, kind = f"Helper: {text}", kind
                else:
                    self.screen = screen_for(str(c.get("name") or ""), c.get("input") or {})
                    if self.screen == "test" and not (c.get("input") or {}).get("run_in_background"):
                        self.test_id = c.get("id")         # a run in the background reports later: no verdict from "started"
                    sk = step_kind(str(c.get("name") or ""), c.get("input"), self.screen)
                    if sk:
                        self.steps.append(sk)
                        del self.steps[:-10]
                    if sk == "edit":
                        self.edit_at = ts or self.edit_at
                        inp = c.get("input") if isinstance(c.get("input"), dict) else {}
                        fp = str(inp.get("file_path") or inp.get("notebook_path") or "")
                        if fp.startswith("/") and ts:
                            self.edits.pop(fp, None)
                            self.edits[fp] = ts
                            while len(self.edits) > 30:
                                self.edits.pop(next(iter(self.edits)))
                self._push(ts, text, kind)
            elif c.get("type") == "text" and isinstance(c.get("text"), str) and c["text"].strip() and not d.get("isSidechain"):
                self.last_text = _short(c["text"], 400)
                self._push(ts, "Writing: " + _short(c["text"], 70), "talk")
            elif c.get("type") == "thinking" and not d.get("isSidechain"):
                self._push(ts, "Thinking", "think", dedupe=True)

    LOOP_EXEMPT = ("Monitor", "ScheduleWakeup", "TaskOutput", "BashOutput", "TaskUpdate", "TodoWrite", "TaskList", "TaskGet")

    def _note_repeat(self, c: dict, ts) -> None:
        """Count the same tool call (name and input alike) made again and again: a session that runs one command ten
        times in a row with nothing between is likely stuck in a loop. Waiting and polling tools do not count."""
        name = str(c.get("name") or "")
        if name in self.LOOP_EXEMPT:
            return
        try:
            sig = hash(name + json.dumps(c.get("input"), sort_keys=True, default=str))
        except (TypeError, ValueError):
            return
        if self.repeat and self.repeat[0] == sig:
            self.repeat[1] += 1
        else:
            self.repeat = [sig, 1, describe_tool(name, c.get("input") or {})[0], ts]

    def _helper_result(self, content) -> None:
        """A helper is done when its result comes back, or, for one in the background, when its task notification
        arrives ("Async agent launched" only means it started)."""
        items = content if isinstance(content, list) else [{"type": "text", "text": content}] if isinstance(content, str) else []
        for c in items:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_result" and c.get("tool_use_id") in self.helpers:
                body = c.get("content")
                text = body if isinstance(body, str) else " ".join(x.get("text", "") for x in body if isinstance(x, dict)) if isinstance(body, list) else ""
                if "Async agent launched" in text or "launched successfully" in text:
                    self.helpers[c["tool_use_id"]]["bg"] = True
                else:
                    self.helpers.pop(c["tool_use_id"]); self.helpers_done += 1
            text = c.get("text") if c.get("type") == "text" else None
            if isinstance(text, str) and "<task-notification>" in text:
                for m in re.finditer(r"<tool-use-id>([\w-]+)</tool-use-id>", text):
                    if self.helpers.pop(m.group(1), None) is not None:
                        self.helpers_done += 1

    def _task_tool(self, c: dict) -> None:
        """Follow the session's task list: TaskCreate and TaskUpdate (Claude Code today), TodoWrite (before)."""
        name, inp = c.get("name"), c.get("input") if isinstance(c.get("input"), dict) else {}
        if name == "TaskCreate" and isinstance(inp.get("subject"), str):
            self.task_pending[c.get("id")] = (redact(_short(inp["subject"], 120)), redact(_short(str(inp.get("activeForm") or ""), 120)) or None)
            if len(self.task_pending) > 50:
                self.task_pending.pop(next(iter(self.task_pending)))
        elif name == "TaskUpdate" and str(inp.get("taskId") or "") in self.tasks:
            task = self.tasks[str(inp["taskId"])]
            if inp.get("status") == "deleted":
                del self.tasks[str(inp["taskId"])]
                return
            if inp.get("status") in ("pending", "in_progress", "completed"):
                task["status"] = inp["status"]
            if isinstance(inp.get("subject"), str):
                task["subject"] = redact(_short(inp["subject"], 120))
            if isinstance(inp.get("activeForm"), str):
                task["active"] = redact(_short(inp["activeForm"], 120))
        elif name == "TodoWrite" and isinstance(inp.get("todos"), list):
            self.tasks = {str(i + 1): {"subject": redact(_short(str(x.get("content") or ""), 120)), "active": redact(_short(str(x.get("activeForm") or ""), 120)) or None,
                                       "status": x.get("status") if x.get("status") in ("pending", "in_progress", "completed") else "pending"}
                          for i, x in enumerate(inp["todos"][:40]) if isinstance(x, dict)}

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

    def tokens(self, since: float) -> dict:
        fresh = sum(e[1] for e in self.ledger if e[0] >= since)
        cached = sum(e[2] for e in self.ledger if e[0] >= since)
        return {"fresh": fresh, "cached": cached, "turns": sum(1 for e in self.ledger if e[0] >= since)}


TASK_NEEDLES = (b'"TaskCreate"', b'"TaskUpdate"', b'"TodoWrite"', b" created successfully")


def task_lines(f, start: int, end: int) -> list[bytes]:
    """The lines between two offsets that touch the session's task list, found by a byte search: the middle of a big
    transcript is otherwise skipped, and its task list with it."""
    import mmap
    try:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    except (ValueError, OSError):
        return []
    found = {}
    with mm:
        for needle in TASK_NEEDLES:
            i = mm.find(needle, start, end)
            while i != -1 and len(found) < 2000:
                a = mm.rfind(b"\n", start, i) + 1 or start
                b = mm.find(b"\n", i, end)
                b = end if b == -1 else b
                found.setdefault(a, mm[a:b])
                i = mm.find(needle, b, end)
    return [found[k] for k in sorted(found)]


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
                for line in task_lines(f, HEAD_BYTES, stat.st_size - TAIL_BYTES):   # the task list, from the middle too
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


_BLOCKED = re.compile(r"^[\W\d_]*(?:STATUS\W*)?BLOCKED\b", re.I)   # "⛔ STATUS: BLOCKED", "[BLOCKED]", "1. Status: blocked"


def report_blocked(line: str | None) -> bool:
    """Whether a report's status line says BLOCKED ("STATUS: BLOCKED - ...", "**Status:** blocked"), and not a DONE
    that merely mentions it ("STATUS: DONE - unblocked the release")."""
    return bool(line and _BLOCKED.match(line))


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
        if start is None or (s.get("procStart") and str(s["procStart"]) != start) or proc_is_brain(pid):
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
            "git": git_place(cwd, now),
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
            "tokens_total": tr.fresh_total if tr else 0,
            "tokens_1h": tr.tokens(now - 3600) if tr else None,
            "tokens_5h": tr.tokens(now - 5 * 3600) if tr else None,
            "cache": cache_view(tr),
            "tasks": task_view(tr),
            "helpers": [{"desc": h["desc"], "since": h["since"]} for h in tr.helpers.values()
                        if (h["since"] or now) > now - 6 * 3600][:8] if tr else [],
            "helpers_done": tr.helpers_done if tr else 0,
            "screen": tr.screen if tr else None,
            "test_ok": tr.test_ok if tr else None,
            "test_at": tr.test_at if tr else None, "edit_at": tr.edit_at if tr else None,   # (trust.py, at its exit)
            "risks": list(tr.risks) if tr else [],        # all it keeps (20): each is announced once
            "phase": phase_of(tr.steps, tr.test_ok) if tr and state in ("working", "waiting") else None,
            "trust": _trust(report_status, tr) if tr and report_status else None,
            "touch": touch_of(tr.edits, now) if tr and tr.edits else None,
            "loop": {"text": redact(tr.repeat[2]), "count": tr.repeat[1], "since": tr.repeat[3]} if tr and tr.repeat and tr.repeat[1] >= 5 else None,
            "cpu_s": proc_cpu_seconds(pid),
            "state_file": state_file,
            "report_file": report_file,
            "report_status": report_status,
            "transcript": str(tpath) if tpath else None,
            "socket": s.get("messagingSocketPath"),
            "resume_cmd": f"CLAUDE_CONFIG_DIR={seat['config_dir']} claude --resume {s.get('sessionId')}"
                          if s.get("sessionId") else None,
        })
    order = {"working": 0, "waiting": 1, "limited": 2, "stuck": 3, "idle": 4}
    out.sort(key=lambda x: (order.get(x["state"], 9), -(x["updated_at"] or 0)))
    return out

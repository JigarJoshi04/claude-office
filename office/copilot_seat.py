"""The GitHub Copilot CLI seat, read-only (stdlib only): its plan's AI credits and the Copilot runs on this machine.

The plan comes from ``gh api copilot_internal/user``, read by ``CreditPoller`` every few minutes; only the plan name,
the reset date and the quota fields in ``QUOTA_FIELDS`` are ever kept, never the rest of the answer. Each reading's
credits are stored with its time, so the office can say what Copilot costs an hour and where the month is heading.

Runs are found by their executable (never by searching command lines): a process whose executable or argv[0] is the
``copilot`` binary. Its session is the ``~/.copilot/session-state/<id>/`` folder holding ``inuse.<pid>.lock``, whose
``events.jsonl`` is read incrementally for the task, the model, what it is doing and, once it is written, the credits
it used. The ``AI Credits`` lines a run prints when it ends are summed from the log it writes to, per lane.
"""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from datetime import date, datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time

QUOTA_FIELDS = ("unlimited", "entitlement", "remaining", "percent_remaining", "overage_permitted",
                "token_based_billing", "credits_used")
QUOTAS = ("premium_interactions", "chat", "completions")
NANO = 1e9                          # a session's totalNanoAiu is AI credits in billionths ("AI Credits 3.38" = 3,380,000,000)
HISTORY_S = 36 * 3600               # how long the poller keeps its readings (the burn rate needs the last hour)
_MAX_LINE = 2 * 1024 * 1024
_LOCK = threading.Lock()
_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_CACHE_LIMIT = 64
_LOGS: dict = {}                    # log path -> {"identity", "offset", "credits", "runs", "pending"}
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CREDITS_LINE = re.compile(rb"AI Credits\s+([0-9][0-9,]*(?:\.[0-9]+)?)")


# -- the plan ------------------------------------------------------------------------------------------------------
def _num(v):
    if isinstance(v, bool) or v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError, OverflowError):
        return None
    return f if math.isfinite(f) else None


def _field(key: str, v):
    if key in ("unlimited", "overage_permitted", "token_based_billing"):
        return v if isinstance(v, bool) else None
    return _num(v)


def _epoch(text) -> float | None:
    if not isinstance(text, str) or not text:
        return None
    try:
        if _DATE.match(text):
            return datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
        d = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return d.replace(tzinfo=d.tzinfo or timezone.utc).timestamp()
    except (ValueError, OverflowError, OSError):
        return None


def parse_quota(body) -> dict | None:
    """The fields the office keeps from `gh api copilot_internal/user`: the plan, the reset date and each quota's
    QUOTA_FIELDS. Everything else in the answer (ids, logins, endpoints, tokens) is dropped here. None when the answer
    has no premium quota to read."""
    if not isinstance(body, dict):
        return None
    snaps = body.get("quota_snapshots") if isinstance(body.get("quota_snapshots"), dict) else {}
    plan = body.get("copilot_plan")
    reset = body.get("quota_reset_date")
    out = {"plan": plan[:40] if isinstance(plan, str) and plan else None,
           "reset_date": reset if isinstance(reset, str) and _DATE.match(reset) else None}
    out["reset_at"] = _epoch(body.get("quota_reset_date_utc")) or _epoch(out["reset_date"])
    for name in QUOTAS:
        q = snaps.get(name)
        if isinstance(q, dict):
            out[name] = {f: _field(f, q.get(f)) for f in QUOTA_FIELDS}
    if not isinstance(out.get("premium_interactions"), dict):
        return None
    return out


def read_plan(timeout: float = 20.0) -> dict:
    """One reading through the gh CLI (its own login). Raises RuntimeError with a short reason; never returns or
    logs the raw answer."""
    gh = shutil.which("gh")
    if not gh:
        raise RuntimeError("the gh CLI is not on PATH")
    from . import egress
    try:
        r = subprocess.run([gh, "api", "copilot_internal/user"], capture_output=True, timeout=timeout,
                           stdin=subprocess.DEVNULL, env=dict(os.environ, GH_PROMPT_DISABLED="1", NO_COLOR="1"))
    except (OSError, subprocess.SubprocessError) as e:
        egress.note("copilot", False)
        raise RuntimeError(f"gh did not answer ({type(e).__name__})") from None
    egress.note("copilot", r.returncode == 0)
    if r.returncode != 0:
        first = (r.stderr or b"").decode(errors="replace").strip().splitlines()[:1]
        from .sessions import redact
        raise RuntimeError(f"gh api exited {r.returncode}" + (f": {redact(first[0])[:160]}" if first else ""))
    try:
        body = json.loads(r.stdout or b"{}")
    except ValueError:
        raise RuntimeError("gh api answered with something other than JSON") from None
    reading = parse_quota(body)
    if reading is None:
        raise RuntimeError("the answer had no Copilot quota (is Copilot on for this account?)")
    return reading


class CreditPoller:
    """Reads the Copilot plan every `every` seconds (5 minutes by default) on its own thread and keeps the last
    readings in a state file: {"reading", "fetched_at", "error", "failures", "next_at", "history": [[ts, credits]]}.
    A failed read waits twice as long each time (up to an hour) before the next try."""

    def __init__(self, path: Path | None, every: float = 300, reader=read_plan):
        self.path, self.every, self.reader = path, max(60.0, float(every)), reader
        self.lock = threading.Lock()
        self.on_fault = self.on_ok = None
        data = None
        if path:
            from .config import read_state
            data = read_state(path)
        d = data if isinstance(data, dict) else {}
        hist = [[float(r[0]), float(r[1])] for r in d.get("history") or []
                if isinstance(r, list) and len(r) == 2 and all(_num(x) is not None for x in r)]
        self.data = {"reading": d.get("reading") if isinstance(d.get("reading"), dict) else None,
                     "fetched_at": _num(d.get("fetched_at")), "error": d.get("error") if isinstance(d.get("error"), str) else None,
                     "failures": int(_num(d.get("failures")) or 0), "next_at": 0.0, "history": hist}

    def get(self) -> dict:
        with self.lock:
            return deepcopy(self.data)

    def poke(self) -> None:
        with self.lock:
            self.data["next_at"] = 0.0

    def tick(self, now: float | None = None) -> bool:
        """Read the plan if it is time. True when a reading was taken."""
        now = time.time() if now is None else now
        with self.lock:
            if now < self.data["next_at"]:
                return False
        try:
            reading = self.reader()
        except Exception as e:                       # gh missing, offline, logged out, a changed answer
            with self.lock:
                self.data["failures"] += 1
                self.data["error"] = str(e)[:200] or type(e).__name__
                self.data["next_at"] = now + min(3600.0, self.every * 2 ** min(self.data["failures"], 6))
            self._save()
            if self.on_fault:
                self.on_fault(e)
            return False
        with self.lock:
            used = (reading.get("premium_interactions") or {}).get("credits_used")
            hist = [r for r in self.data["history"] if r[0] >= now - HISTORY_S and r[0] < now]
            if used is not None:
                hist.append([now, float(used)])
            self.data.update(reading=reading, fetched_at=now, error=None, failures=0, next_at=now + self.every,
                             history=hist[-600:])
        self._save()
        if self.on_ok:
            self.on_ok()
        return True

    def _save(self) -> None:
        if not self.path:
            return
        with self.lock:
            text = json.dumps({k: v for k, v in self.data.items() if k != "next_at"})
        try:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(text)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            self.tick()
            stop.wait(20)


def _month_start(reset_at: float) -> float:
    """The start of the billing month that ends at reset_at (the same day of the previous month, in UTC)."""
    d = datetime.fromtimestamp(reset_at, timezone.utc)
    y, m = (d.year - 1, 12) if d.month == 1 else (d.year, d.month - 1)
    day = min(d.day, 28)
    return datetime(y, m, day, d.hour, d.minute, tzinfo=timezone.utc).timestamp()


def burn(history: list, now: float, window: float = 3600.0) -> dict | None:
    """Credits an hour over the last `window` seconds of readings, since the last drop (a new month). None until two
    readings at least four minutes apart are in the window."""
    rows = [r for r in history if r[0] <= now]
    for i in range(len(rows) - 1, 0, -1):            # only the readings since the month started again
        if rows[i][1] < rows[i - 1][1]:
            rows = rows[i:]
            break
    rows = [r for r in rows if r[0] >= now - window - 60]
    if len(rows) < 2 or rows[-1][0] - rows[0][0] < 240:
        return None
    span = rows[-1][0] - rows[0][0]
    return {"per_hour": max(0.0, (rows[-1][1] - rows[0][1]) / span * 3600), "minutes": round(span / 60)}


def credits_view(poll: dict | None, settings: dict, now: float) -> dict | None:
    """What the seat page, the briefing and the floor show: credits used this month and their dollar value, the
    included credits and how much of them is used, overage, the burn an hour, a month-end projection at this
    month's pace and at this hour's, and the reset date. None before the first reading (and no error)."""
    poll = poll or {}
    r = poll.get("reading")
    if not r:
        return {"error": poll.get("error"), "fetched_at": None, "credits_used": None} if poll.get("error") else None
    pi = r.get("premium_interactions") or {}
    usd = float(settings.get("credit_usd", 0.01))
    included = float(settings.get("included_credits", 1900))
    used = pi.get("credits_used")
    out = {"plan": r.get("plan"), "reset_date": r.get("reset_date"), "reset_at": r.get("reset_at"),
           "fetched_at": poll.get("fetched_at"), "error": poll.get("error"),
           "stale": bool(poll.get("fetched_at") and now - poll["fetched_at"] > 3 * 3600),
           "unlimited": pi.get("unlimited"), "overage_permitted": pi.get("overage_permitted"),
           "token_based_billing": pi.get("token_based_billing"), "credit_usd": usd, "included": included,
           "credits_used": used, "usd": None, "included_pct": None, "overage_credits": None, "overage_usd": None,
           "entitlement": None, "percent_remaining": None, "burn": None, "projection": None}
    # A finite entitlement is a real allowance: its percent left means something. "Unlimited" reads 100% left forever.
    ent = pi.get("entitlement")
    if not pi.get("unlimited") and ent:
        out["entitlement"] = ent
        out["percent_remaining"] = pi.get("percent_remaining")
    if used is None:
        return out
    out["usd"] = round(used * usd, 2)
    if included > 0:
        out["included_pct"] = round(used / included * 100, 1)
        out["overage_credits"] = max(0.0, used - included)
        out["overage_usd"] = round(out["overage_credits"] * usd, 2)
    b = burn(poll.get("history") or [], now)
    if b:
        out["burn"] = {"credits_per_hour": round(b["per_hour"], 1), "usd_per_hour": round(b["per_hour"] * usd, 2),
                       "minutes": b["minutes"]}
    reset = r.get("reset_at")
    if reset and reset > now:
        start = _month_start(reset)
        elapsed, left = max(3600.0, now - start), reset - now
        month = used + used / elapsed * left        # this month's pace so far, kept up to the reset
        proj = {"month_credits": round(month), "month_usd": round(month * usd, 2), "hours_left": round(left / 3600, 1)}
        if b:
            hour = used + b["per_hour"] * left / 3600
            proj.update(hour_credits=round(hour), hour_usd=round(hour * usd, 2))
        out["projection"] = proj
    return out


# -- runs on this machine --------------------------------------------------------------------------------------------
def _is_copilot(value: str) -> bool:
    return bool(value) and Path(value.removesuffix(" (deleted)")).name == "copilot"


def scan_processes(proc_root: str = "/proc") -> list[dict]:
    """[{pid, ppid, unit, cwd, log, prompt}] for the processes whose executable or argv[0] is the copilot binary. A
    copilot process started by another one (a helper of the same run) is left out, so each run is counted once."""
    found = []
    try:
        entries = list(Path(proc_root).iterdir())
    except OSError:
        return found
    for p in entries:
        if not p.name.isdecimal():
            continue
        exe = argv = ""
        try:
            exe = os.readlink(p / "exe")
        except OSError:
            pass
        try:
            with (p / "cmdline").open("rb") as f:
                raw = f.read(4096)
            parts = raw.split(b"\0")
            argv = os.fsdecode(parts[0])
        except OSError:
            parts = []
        if not (_is_copilot(exe) or _is_copilot(argv)):
            continue
        ppid = unit = cwd = log = None
        try:
            ppid = int((p / "stat").read_text().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            pass
        try:
            for line in (p / "cgroup").read_text().splitlines():
                for part in reversed(line.split(":", 2)[-1].split("/")):
                    if part.endswith((".service", ".scope")):
                        unit = part
                        break
        except (OSError, UnicodeError):
            pass
        try:
            cwd = os.readlink(p / "cwd")
        except OSError:
            pass
        try:
            out = os.readlink(p / "fd" / "1")
            if out.startswith("/") and not out.startswith(("/dev/", "/proc/")) and os.path.isfile(out):
                log = out
        except OSError:
            pass
        flags = {os.fsdecode(x) for x in parts[1:12]}
        found.append({"pid": int(p.name), "ppid": ppid, "unit": unit, "cwd": cwd, "log": log,
                      "prompt": bool(flags & {"-p", "--prompt"}) or any(f.startswith("--prompt=") for f in flags)})
    pids = {x["pid"] for x in found}
    return [x for x in found if x["ppid"] not in pids]


def log_credits(path, max_read: int = 8 * 1024 * 1024) -> dict | None:
    """The AI Credits a log's Copilot runs printed when they ended, summed: {"credits", "runs"}. Read incrementally
    (at most max_read new bytes a call), so a long lane log costs only what was appended since the last look."""
    try:
        p = Path(path)
        st = p.stat()
    except (OSError, TypeError):
        return None
    key, ident = str(p), (st.st_dev, st.st_ino)
    with _LOCK:
        e = _LOGS.get(key)
        if e is None or e["identity"] != ident or st.st_size < e["offset"]:
            e = {"identity": ident, "offset": 0, "credits": 0.0, "runs": 0, "pending": b""}
        if st.st_size > e["offset"]:
            try:
                with p.open("rb") as f:
                    f.seek(e["offset"])
                    chunk = f.read(min(max_read, st.st_size - e["offset"]))
            except OSError:
                return None
            e["offset"] += len(chunk)
            text = e["pending"] + chunk
            cut = text.rfind(b"\n") + 1
            e["pending"] = text[cut:][-4096:]
            for m in _CREDITS_LINE.finditer(text[:cut]):
                v = _num(m.group(1).replace(b",", b"").decode())
                if v is not None:
                    e["credits"] += v
                    e["runs"] += 1
        _LOGS[key] = e
        if len(_LOGS) > 256:
            _LOGS.pop(next(iter(_LOGS)))
        return {"credits": round(e["credits"], 2), "runs": e["runs"]}


def _text(v, limit: int) -> str | None:
    if not isinstance(v, str):
        return None
    return " ".join(v.split())[:limit] or None


def _activity(data: dict) -> str:
    name = data.get("toolName") if isinstance(data.get("toolName"), str) else "tool"
    args = data.get("arguments") if isinstance(data.get("arguments"), dict) else {}
    cmd = args.get("command")
    if isinstance(cmd, str) and cmd.strip():
        return "Running: " + (_text(cmd, 160) or "command")
    path = args.get("path") or args.get("file_path") or args.get("filePath")
    if isinstance(path, str) and path:
        verb = "Editing" if any(w in name.lower() for w in ("edit", "write", "create", "patch", "str_replace")) else "Reading"
        return f"{verb} {Path(path).name[:120]}"
    return "Using: " + name[:80]


def _risks(session: dict, data: dict) -> None:
    """The risky-action watch (risk.py) over a Copilot tool call: its shell command, or the file it writes."""
    from .risk import RULES, check
    args = data.get("arguments") if isinstance(data.get("arguments"), dict) else {}
    name = str(data.get("toolName") or "").lower()
    hits = []
    if isinstance(args.get("command"), str):
        hits += check("Bash", {"command": args["command"]})
    path = args.get("path") or args.get("file_path")
    if isinstance(path, str) and any(w in name for w in ("edit", "write", "create", "str_replace")):
        hits += check("Write", {"file_path": path})
    call = str(data.get("toolCallId") or "")[:64]
    have = {r["id"] for r in session.get("risks") or []}
    for rule, shown in hits:
        rid = f"copilot:{call}:{rule}"
        if rid not in have:
            session.setdefault("risks", []).append({"id": rid, "ts": session.get("updated_at"), "rule": rule,
                                                    "label": RULES[rule], "text": shown, "helper": False})
    if hits:
        del session["risks"][:-20]


def _ts(v) -> float | None:
    return _epoch(v) if isinstance(v, str) else _num(v)


def _event(entry: dict, rec) -> None:
    if not isinstance(rec, dict):
        return
    s = entry["session"]
    data = rec.get("data") if isinstance(rec.get("data"), dict) else {}
    kind = rec.get("type")
    t = _ts(rec.get("timestamp"))
    if t is not None:
        s["updated_at"] = t
    if kind in ("session.start", "session.resume"):
        ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
        if isinstance(ctx.get("cwd"), str):
            s["cwd"] = ctx["cwd"]
        for key, src in (("model", "selectedModel"), ("effort", "reasoningEffort")):
            if isinstance(data.get(src), str):
                s[key] = data[src]
        if s["started_at"] is None:
            s["started_at"] = _ts(data.get("startTime")) or t
        s["ended"] = False
    elif kind == "session.model_change" and isinstance(data.get("newModel"), str):
        s["model"] = data["newModel"]
    elif kind == "user.message":
        if s["task"] is None:
            s["task"] = _text(data.get("content"), 300)
        s["activity"] = "Thinking"
    elif kind == "assistant.turn_start":
        s["activity"] = "Thinking"
        s["turn"] = True
    elif kind == "assistant.turn_end":
        s["turn"] = False
    elif kind == "tool.execution_complete":
        call = data.get("toolCallId")
        if call in s["pending"]:
            s["pending"].remove(call)
    elif kind == "assistant.message":
        text = _text(data.get("content"), 400)
        if text:
            s["last_message"] = text
            s["activity"] = "Replied: " + text[:80]
        if isinstance(data.get("model"), str):
            s["model"] = data["model"]
    elif kind == "tool.execution_start":
        s["activity"] = _activity(data)
        s["tool_calls"] += 1
        if isinstance(data.get("toolCallId"), str):         # running until its execution_complete arrives
            s["pending"] = (s["pending"] + [data["toolCallId"][:64]])[-20:]
        _risks(s, data)
    elif kind in ("session.usage_checkpoint", "session.shutdown"):
        n = _num(data.get("totalNanoAiu"))
        if n is not None:
            s["credits"] = round(n / NANO, 2)
        if kind == "session.shutdown":
            s["ended"], s["pending"], s["turn"] = True, [], False
            td = data.get("tokenDetails") if isinstance(data.get("tokenDetails"), dict) else {}
            count = lambda k: int(_num((td.get(k) or {}).get("tokenCount") if isinstance(td.get(k), dict) else None) or 0)
            s["tokens"] = {"input": count("input"), "cached": count("cache_read"), "written": count("cache_write"),
                           "output": count("output")}
            s["tokens"]["total"] = sum(s["tokens"].values())
            if isinstance(data.get("currentModel"), str):
                s["model"] = data["currentModel"]


def _consume(entry: dict, chunk: bytes) -> None:
    parts = chunk.split(b"\n")
    for i, piece in enumerate(parts):
        done = i < len(parts) - 1
        if not entry["discarding"]:
            if len(entry["pending"]) + len(piece) > _MAX_LINE:     # an oversized record is skipped through its newline
                entry["pending"], entry["discarding"] = b"", True
            else:
                entry["pending"] += piece
        if done:
            if not entry["discarding"]:
                try:
                    _event(entry, json.loads(entry["pending"]))
                except (ValueError, UnicodeError, RecursionError):
                    pass
            entry["pending"], entry["discarding"] = b"", False


def _read(folder: Path) -> dict | None:
    """A session folder's summary, from its events.jsonl, read from where the last call stopped."""
    path = folder / "events.jsonl"
    key = str(path)
    try:
        st = path.stat()
    except OSError:
        return None
    e = _CACHE.get(key)
    if e is None or e["identity"] != (st.st_dev, st.st_ino) or st.st_size < e["offset"]:
        e = {"identity": (st.st_dev, st.st_ino), "offset": 0, "pending": b"", "discarding": False,
             "session": {"id": folder.name, "cwd": None, "model": None, "effort": None, "started_at": None,
                         "updated_at": None, "task": None, "activity": None, "last_message": None, "credits": None,
                         "tokens": None, "tool_calls": 0, "ended": False, "risks": [], "events": str(path),
                         "pending": [], "turn": False}}
    if st.st_size > e["offset"]:
        try:
            with path.open("rb") as f:
                f.seek(e["offset"])
                left = st.st_size - e["offset"]
                while left > 0:
                    chunk = f.read(min(65536, left))
                    if not chunk:
                        break
                    _consume(e, chunk)
                    e["offset"] += len(chunk)
                    left -= len(chunk)
        except OSError:
            return None
    _CACHE[key] = e
    _CACHE.move_to_end(key)
    while len(_CACHE) > _CACHE_LIMIT:
        _CACHE.popitem(last=False)
    return e["session"]


def _state(s: dict, now: float) -> str:
    """A run's state: waiting while a tool it started has not finished, working while a turn is open or a headless
    (-p) run goes on (it never waits for anyone), working for two minutes after anything happened, else idle."""
    if not s["live"]:
        return "done"
    if s["pending"]:
        return "waiting"
    if s["turn"] or s["prompt"] or (s["updated_at"] and now - s["updated_at"] < 120):
        return "working"
    return "idle"


def read_copilot_seat(home: str | None = None, now: float | None = None, recent_hours: float = 3.0) -> dict:
    """The live Copilot runs under *home* and the ones that ended in the last few hours (eight at most), newest
    first: [{id, live, pid, unit, cwd, log, lane_credits, prompt, ...the events summary}]."""
    root = (Path(home).expanduser() if home is not None else Path.home()) / ".copilot"
    out = {"available": root.is_dir(), "sessions": []}
    if not out["available"]:
        return out
    now = time.time() if now is None else now
    state = root / "session-state"
    procs = {p["pid"]: p for p in scan_processes()}
    live: dict = {}                                    # session folder -> process
    try:
        for lock in state.glob("*/inuse.*.lock"):
            pid = lock.name[6:-5]
            if pid.isdecimal() and int(pid) in procs:
                live.setdefault(lock.parent, procs[int(pid)])
    except OSError:
        pass
    cands: dict = {}
    try:
        with os.scandir(state) as it:
            for d in it:
                try:
                    m = os.stat(os.path.join(d.path, "events.jsonl")).st_mtime
                except OSError:
                    continue
                if m >= now - recent_hours * 3600 or Path(d.path) in live:
                    cands[Path(d.path)] = m
    except OSError:
        pass
    for folder in live:
        cands.setdefault(folder, now)
    order = sorted(cands, key=lambda f: (f in live, cands[f]), reverse=True)
    with _LOCK:
        for key in [k for k in _CACHE if Path(k).parent not in cands]:
            del _CACHE[key]
        rows = []
        for folder in order:
            if len(rows) >= 8 and folder not in live:
                break
            s = _read(folder)
            if s is None:
                continue
            s = deepcopy(s)
            p = live.get(folder)
            s.update(live=bool(p) and not s["ended"], pid=p and p["pid"], unit=p and p["unit"], log=p and p["log"],
                     prompt=bool(p and p["prompt"]))
            if p and not s.get("cwd"):
                s["cwd"] = p["cwd"]
            s["state"] = _state(s, now)
            rows.append(s)
    for s in rows:
        s["lane_credits"] = log_credits(s["log"]) if s.get("log") else None
    out["sessions"] = rows
    return out

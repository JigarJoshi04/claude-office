"""Read-only, incremental view of the local Codex CLI seat (stdlib only)."""

from collections import OrderedDict
from copy import deepcopy
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import threading
import time


_CACHE = OrderedDict()
_CACHE_LIMIT = 64
_MAX_LINE = 2 * 1024 * 1024
_LOCK = threading.Lock()


def _number(value):
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _timestamp(value):
    numeric = _number(value)
    if numeric is not None:
        return numeric
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).timestamp()
        except (ValueError, OverflowError, OSError):
            pass
    return None


def _dict(value):
    return value if isinstance(value, dict) else {}


def _text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(filter(None, (_text(part) for part in value)))
    if isinstance(value, dict):
        return _text(value.get("text", ""))
    return ""


def _short(value, limit):
    return " ".join(_text(value).split())[:limit] or None


def _task(value):
    parts = value if isinstance(value, list) else [value]
    for part in parts:
        text = _text(part).strip()
        if not text or text.startswith("<"):
            continue
        if re.match(r"(?i)^#+\s*(?:AGENTS\.md\b|(?:system|developer|custom) instructions\b)", text):
            continue
        return _short(text, 300)
    return None


def _command(value):
    if isinstance(value, list):
        return " ".join(str(arg) for arg in value)
    return _text(value)


def _tool_activity(payload):
    name = payload.get("name")
    name = name if isinstance(name, str) else "tool"
    raw = payload.get("arguments", payload.get("input", {}))
    if isinstance(raw, str):
        try:
            args = _dict(json.loads(raw))
        except ValueError:
            args = {}
    else:
        args = _dict(raw)
    command = _command(args.get("cmd", args.get("command")))
    if command:
        return "Running: " + (_short(command, 160) or "command")
    patch = args.get("patch", raw if isinstance(raw, str) else "")
    if "apply_patch" in name and isinstance(patch, str):
        match = re.search(r"\*\*\* (?:Update|Add|Delete) File: ([^\n]+)", patch)
        if match:
            return "Editing " + match[1].strip()[:160]
    path = args.get("file_path", args.get("path"))
    if isinstance(path, str) and any(word in name.lower() for word in ("edit", "write", "patch")):
        return "Editing " + path[:160]
    return "Using: " + name[:160]


def _risks(session, payload):
    """The risky-action watch (risk.py) over a Codex tool call: its shell command, and the files a patch writes."""
    from .risk import RULES, check
    raw = payload.get("arguments", payload.get("input", {}))
    try:
        args = _dict(json.loads(raw)) if isinstance(raw, str) and raw.lstrip().startswith("{") else _dict(raw)
    except ValueError:
        args = {}
    hits = []
    cmd = args.get("cmd", args.get("command"))
    if isinstance(cmd, list) and len(cmd) >= 3 and re.fullmatch(r"-[a-z]*c[a-z]*", str(cmd[1])):   # ["bash", "-lc", "<script>"]
        cmd = cmd[2]
    command = _command(cmd)
    if command:
        hits += check("Bash", {"command": command})
    patch = args.get("patch", raw if isinstance(raw, str) else "")
    if isinstance(patch, str):
        for path in re.findall(r"\*\*\* (?:Update|Add) File: ([^\n]+)", patch)[:20]:
            hits += check("Write", {"file_path": path.strip()})
    call = str(payload.get("call_id") or payload.get("id") or hash(json.dumps(payload, sort_keys=True, default=str)))
    have = {(r["rule"], r["text"], r["ts"]) for r in session.get("risks") or []}
    for rule, shown in hits:                         # a call and its exec event are one action
        if (rule, shown, session.get("updated_at")) in have or any(r["id"] == f"codex:{call}:{rule}" for r in session.get("risks") or []):
            continue
        session.setdefault("risks", []).append({"id": f"codex:{call}:{rule}", "ts": session.get("updated_at"), "rule": rule,
                                                "label": RULES[rule], "text": shown, "helper": False})
    if hits:
        del session["risks"][:-20]


def _tokens(value):
    value = _dict(value)
    return {key: max(0, int(_number(value.get(source)) or 0)) for key, source in (
        ("input", "input_tokens"), ("output", "output_tokens"),
        ("cached", "cached_input_tokens"), ("total", "total_tokens"))}


def _usage(value, timestamp):
    value = _dict(value)
    if timestamp is None:
        return None
    result = {"observed_at": timestamp}
    found = False
    for key, source in (("five_hour", "primary"), ("weekly", "secondary")):
        window = _dict(value.get(source))
        pct = _number(window.get("used_percent"))
        found |= pct is not None
        minutes = _number(window.get("window_minutes"))
        result[key] = {"pct": pct if pct is not None else 0.0,
                       "resets_at": _timestamp(window.get("resets_at")),
                       "window_min": int(minutes) if minutes is not None else None}
    return result if found else None


def _message(session, value):
    message = _short(value, 400)
    if message:
        session["last_message"] = message
        session["activity"] = "Replied: " + message[:80]


def _item(session, payload):
    kind = payload.get("type")
    if kind in ("message", "UserMessage", "AgentMessage", "agent_message"):
        role = payload.get("role")
        content = payload.get("content", payload.get("message", payload.get("text")))
        if (role == "user" or kind == "UserMessage") and session["task"] is None:
            session["task"] = _task(content)
        elif role == "assistant" or kind in ("AgentMessage", "agent_message"):
            _message(session, content)
    elif kind in ("function_call", "custom_tool_call"):
        session["activity"] = _tool_activity(payload)
        _risks(session, payload)
    elif kind in ("reasoning", "Reasoning"):
        session["activity"] = "Thinking"
    elif kind in ("exec_command_begin", "CommandExecution"):
        command = _short(_command(payload.get("command", payload.get("cmd"))), 160)
        session["activity"] = "Running: " + (command or "command")
        _risks(session, {"call_id": payload.get("call_id"), "arguments": {"command": payload.get("command", payload.get("cmd"))}})


def _record(entry, record):
    if not isinstance(record, dict):
        return
    session = entry["session"]
    timestamp = _timestamp(record.get("timestamp"))
    if timestamp is not None:
        session["updated_at"] = timestamp
    payload = _dict(record.get("payload"))
    kind = record.get("type")
    if kind == "session_meta":
        sid = payload.get("id", payload.get("session_id"))
        if isinstance(sid, str) and sid:
            session["id"] = sid
        if session["started_at"] is None:
            session["started_at"] = _timestamp(payload.get("timestamp")) or timestamp
    if kind in ("session_meta", "turn_context"):
        for key in ("cwd", "model"):
            if isinstance(payload.get(key), str):
                session[key] = payload[key]
    elif kind == "world_state":
        state = _dict(payload.get("state"))
        model = _dict(state.get("collaboration_mode")).get("model", state.get("model"))
        if isinstance(model, str):
            session["model"] = model
    elif kind == "response_item":
        _item(session, payload)
    elif kind == "token_usage_record":
        totals = payload.get("thread_token_usage", payload.get("total_token_usage"))
        if isinstance(totals, dict):
            session["tokens"] = _tokens(totals)
    elif kind == "event_msg":
        event = payload.get("type")
        if event == "token_count":
            totals = _dict(payload.get("info")).get("total_token_usage")
            if isinstance(totals, dict):
                session["tokens"] = _tokens(totals)
            usage = _usage(payload.get("rate_limits"), timestamp)
            if usage and (entry["usage"] is None or usage["observed_at"] >= entry["usage"]["observed_at"]):
                entry["usage"] = usage
        elif event == "task_complete":
            _message(session, payload.get("last_agent_message"))
        elif event == "task_started":
            session["activity"] = "Thinking"
            if session["started_at"] is None:
                session["started_at"] = _timestamp(payload.get("started_at")) or timestamp
        elif event == "item_completed":
            _item(session, _dict(payload.get("item")))
        elif event == "user_message" and session["task"] is None:
            session["task"] = _task(payload.get("message"))
        else:
            _item(session, payload)


def _new_entry(path, stat):
    fallback = re.search(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", path.stem)
    return {"identity": (stat.st_dev, stat.st_ino), "signature": None,
            "offset": 0, "pending": b"", "discarding": False, "usage": None,
            "session": {"id": fallback[0] if fallback else path.stem,
                        "live": False, "pid": None, "unit": None, "cwd": None,
                        "model": None, "started_at": None, "updated_at": None,
                        "task": None, "activity": None, "state": "done",
                        "last_message": None, "tokens": _tokens({}), "rollout": str(path)}}


def _consume(entry, chunk):
    # Keep only a bounded unfinished line. Oversized records are skipped through
    # their newline, so a large tool output cannot grow the cache indefinitely.
    pieces = chunk.split(b"\n")
    for index, piece in enumerate(pieces):
        complete = index < len(pieces) - 1
        if not entry["discarding"]:
            if len(entry["pending"]) + len(piece) > _MAX_LINE:
                entry["pending"] = b""
                entry["discarding"] = True
            else:
                entry["pending"] += piece
        if complete:
            if not entry["discarding"]:
                try:
                    _record(entry, json.loads(entry["pending"]))
                except (ValueError, UnicodeError, RecursionError):
                    pass
            entry["pending"] = b""
            entry["discarding"] = False


def _parse(path):
    key = str(path)
    try:
        stat = path.stat()
        signature = (stat.st_size, stat.st_mtime_ns)
        entry = _CACHE.get(key)
        if entry and entry["signature"] == signature and entry["identity"] == (stat.st_dev, stat.st_ino):
            _CACHE.move_to_end(key)
            return entry
        if (entry is None or entry["identity"] != (stat.st_dev, stat.st_ino)
                or stat.st_size <= entry["offset"]):
            entry = _new_entry(path, stat)
        with path.open("rb") as stream:
            stream.seek(entry["offset"])
            remaining = stat.st_size - entry["offset"]
            while remaining > 0:
                chunk = stream.read(min(65536, remaining))
                if not chunk:
                    break
                _consume(entry, chunk)
                entry["offset"] += len(chunk)
                remaining -= len(chunk)
        entry["signature"] = signature
        _CACHE[key] = entry
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_LIMIT:
            _CACHE.popitem(last=False)
        return entry
    except OSError:
        return None


def _scan_processes(proc_root="/proc"):
    """Return {pid, ppid, unit, rollouts} for actual Codex executables only."""
    result = []
    try:
        processes = list(Path(proc_root).iterdir())
    except OSError:
        return result
    for process in processes:
        if not process.name.isdecimal():
            continue
        executable = argv0 = ""
        try:
            executable = os.readlink(process / "exe").removesuffix(" (deleted)")
        except OSError:
            pass
        try:
            with (process / "cmdline").open("rb") as stream:
                argv0 = os.fsdecode(stream.read(4096).split(b"\0", 1)[0])
        except OSError:
            pass
        if not any(Path(value).name == "codex" for value in (executable, argv0)):
            continue
        ppid = unit = None
        try:
            # comm may itself contain spaces and parentheses.
            fields = (process / "stat").read_text().rsplit(")", 1)[1].split()
            ppid = int(fields[1])
        except (OSError, ValueError, IndexError):
            pass
        try:
            for line in (process / "cgroup").read_text().splitlines():
                path = line.split(":", 2)[-1]
                for part in reversed(path.split("/")):
                    if part.endswith((".service", ".scope")):
                        unit = part
                        break
        except (OSError, UnicodeError):
            pass
        rollouts = set()
        try:
            for fd in (process / "fd").iterdir():
                try:
                    target = os.readlink(fd)
                    path = Path(target)
                    if path.name.startswith("rollout-") and path.suffix == ".jsonl":
                        rollouts.add(str(path.resolve()))
                except OSError:
                    pass
        except OSError:
            pass
        result.append({"pid": int(process.name), "ppid": ppid, "unit": unit,
                       "rollouts": sorted(rollouts)})
    return result


def _model(root):
    try:
        with (root / "config.toml").open() as stream:
            for line in stream:
                if line.lstrip().startswith("["):
                    break
                match = re.match(r'''\s*model\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$''', line)
                if match:
                    return match[2]
    except (OSError, UnicodeError):
        pass
    return None


def read_codex_seat(home: str | None = None, now: float | None = None,
                    recent_hours: float = 12.0) -> dict:
    """Read ~/.codex under *home*, without writing or inspecting credentials.

    Files are considered newest by mtime. Read live files and up to eight recent
    session files, continuing the newest-first search only until usage is found.
    Cache entries contain summaries and a bounded partial line, never history.
    """
    root = (Path(home).expanduser() if home is not None else Path.home()) / ".codex"
    root = root.resolve()
    result = {"id": "astra", "kind": "codex", "available": root.is_dir(),
              "model": None, "usage": None, "sessions": []}
    if not result["available"]:
        return result
    result["model"] = _model(root)
    now = time.time() if now is None else now
    cutoff = now - recent_hours * 3600
    live = {}
    for process in sorted(_scan_processes(), key=lambda item: item["pid"]):
        for rollout in process["rollouts"]:
            path = Path(rollout).resolve()
            if path.is_relative_to(root / "sessions"):
                live.setdefault(path, process)
    candidates = {}
    try:
        for path in (root / "sessions").glob("*/*/*/rollout-*.jsonl"):
            try:
                modified = path.stat().st_mtime
                if modified >= cutoff:
                    candidates[path] = modified
            except OSError:
                pass
    except OSError:
        pass
    for path in live:
        try:
            candidates[path] = path.stat().st_mtime
        except OSError:
            pass
    ordered = sorted(candidates, key=lambda path: (candidates[path], str(path)), reverse=True)
    with _LOCK:
        # Prune expired/deleted entries for this home without evicting other homes.
        for key in list(_CACHE):
            path = Path(key)
            if path.is_relative_to(root) and path not in candidates:
                del _CACHE[key]
        sessions = []
        for path in ordered:
            need_session = path in live or len(sessions) < 8
            if not need_session and result["usage"] is not None:
                continue
            entry = _parse(path)
            if entry is None:
                continue
            if result["usage"] is None and entry["usage"] is not None:
                result["usage"] = deepcopy(entry["usage"])
            if not need_session:
                continue
            session = deepcopy(entry["session"])
            process = live.get(path)
            if process:
                session.update(live=True, pid=process["pid"], unit=process["unit"])
                updated = session["updated_at"]
                session["state"] = "working" if updated is not None and now - updated < 120 else "idle"
            sessions.append(session)
        sessions.sort(key=lambda item: (item["live"], item["updated_at"] if item["updated_at"] is not None else candidates[Path(item["rollout"])], item["rollout"]), reverse=True)
        result["sessions"] = sessions[:8]
    return result

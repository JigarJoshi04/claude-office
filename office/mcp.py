"""The office as an MCP server, so an agent can ask it things from inside its session: how the seats stand, which seat
the next lane would go to, how the lanes are doing and what one reported; and it can put news on the floor or ask the
CEO a question. It speaks JSON-RPC 2.0 over stdio, one message a line (the standard library only), and is a client of
the running office's local API with this user's token, like `claude-office ask` and `post`.

Add it to a seat with:  claude mcp add office -- /path/to/claude-office/bin/claude-office mcp
It cannot hire lanes or stop them: work that spends a plan stays with the CEO (the hiring desk, or `claude-office hire`).
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

from . import config

PROTOCOL = "2025-06-18"
TOOLS = [
    {"name": "office_status", "description": "The office now: each seat's state, plan used in its 5-hour window and week (and when each resets), live and working sessions, lanes, and how many things need the CEO.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "next_seat", "description": "Which seat the load divider would give the next background lane to, and why (or why none can take one).",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "list_lanes", "description": "The office's background lanes: id, title, status, seat and the first line of its report.",
     "inputSchema": {"type": "object", "properties": {"status": {"type": "string", "description": "only lanes with this status (running, waiting, done, blocked, failed, stopped, ...)"}}}},
    {"name": "lane_report", "description": "One lane's report and the end of its notes (STATE.md).",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "post_news", "description": "Put a line of news on the office floor (a toast and a line in the news), for example when a deploy or a long job finishes.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string", "maxLength": 140}, "level": {"type": "string", "enum": ["good", "info", "warn", "bad"]}}, "required": ["text"]}},
    {"name": "ask_ceo", "description": "Ask the CEO (the person running the office) a question only they can answer. Their desk phone rings; the answer comes back to this session as a message. Keep working on what does not depend on it.",
     "inputSchema": {"type": "object", "properties": {"question": {"type": "string", "maxLength": 600}}, "required": ["question"]}},
]


def _port() -> int:
    return config.load_config().get("port", config.DEFAULT_PORT)


def _call(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(f"http://127.0.0.1:{_port()}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "X-Office-Token": config.api_token()})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read() or b"{}").get("error")
        except ValueError:
            msg = None
        raise RuntimeError(msg or f"The office answered HTTP {e.code}") from None
    except OSError as e:
        raise RuntimeError(f"The office is not running on port {_port()} ({e})") from None


def _status() -> str:
    v = _call("GET", "/api/public")
    lines = [f"{v['office'].get('name') or 'The office'} (level {v['office'].get('level')}), version {v.get('version')}"]
    for s in v.get("seats", []):
        w = lambda k: f"{s[k]['used_pct']}% used" + (f", resets {_when(s[k].get('resets_at'))}" if s[k].get("resets_at") else "") if s.get(k) else "no reading"
        lines.append(f"- {s['name']} ({s['id']}, {s.get('kind')}): {s.get('status')}; 5-hour window {w('five_hour')}; week {w('weekly')}; "
                     f"{s.get('working', 0)} working of {s.get('sessions', 0)} live, {s.get('lanes', 0)} lanes")
    t = v.get("totals") or {}
    lines.append(f"Needs the CEO: {t.get('needs_you', 0)}. Lanes by status: " + (", ".join(f"{k} {n}" for k, n in sorted((v.get("lanes") or {}).items())) or "none"))
    return "\n".join(lines)


def _when(ts) -> str:
    import time
    try:
        return time.strftime("%a %H:%M", time.localtime(float(ts)))
    except (TypeError, ValueError, OverflowError):
        return "?"


def _next_seat() -> str:
    np = _call("GET", "/api/state").get("next_pick") or {}
    return f"The next lane goes to {np['seat']}: {np.get('why') or ''}".strip() if np.get("seat") else f"No seat can take a lane now: {np.get('why') or 'every seat is busy, benched or out of plan'}"


def _lanes(status: str | None) -> str:
    rows = [l for l in _call("GET", "/api/state").get("lanes") or [] if not status or l.get("status") == status]
    if not rows:
        return "No lanes" + (f" with status {status}" if status else "") + "."
    return "\n".join(f"- {l['id']} [{l.get('status')}] on {l.get('seat') or l.get('seat_pref') or 'any seat'}: {l.get('title')}"
                     + (f" — {l['report_status']}" if l.get("report_status") else "") for l in rows[:40])


def _report(lane_id: str) -> str:
    d = _call("GET", "/api/lane?id=" + urllib.request.quote(str(lane_id)))
    lane = d.get("lane") or {}
    return (f"{lane.get('title')} [{lane.get('status')}]\n\nReport:\n{(d.get('report') or '(none yet)').strip()}\n\n"
            f"Notes (the end of STATE.md):\n{(d.get('state') or '(none)').strip()}")


def _ask(question: str) -> str:
    import os
    from .asks import parent_pids
    out = _call("POST", "/api/ask", {"text": question, "pids": parent_pids(), "cwd": os.getcwd()})
    return ("Asked. Keep working on what does not depend on it: the CEO's answer comes back to this session as a message."
            if out.get("found_session") else "Asked. The office could not tell which session this is, so the answer waits in its Inbox.")


def call_tool(name: str, args: dict) -> str:
    if name == "office_status":
        return _status()
    if name == "next_seat":
        return _next_seat()
    if name == "list_lanes":
        return _lanes(args.get("status"))
    if name == "lane_report":
        return _report(args.get("id") or "")
    if name == "post_news":
        _call("POST", "/api/event", {"text": str(args.get("text") or ""), "level": args.get("level") or "info", "source": "agent"})
        return "On the floor."
    if name == "ask_ceo":
        return _ask(str(args.get("question") or ""))
    raise KeyError(name)


def handle(msg: dict) -> dict | None:
    """One JSON-RPC message in, its reply out (None for a notification)."""
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    reply = lambda result: {"jsonrpc": "2.0", "id": mid, "result": result}
    if mid is None:                                   # a notification (initialized, cancelled): nothing to say
        return None
    if method == "initialize":
        return reply({"protocolVersion": params.get("protocolVersion") or PROTOCOL, "capabilities": {"tools": {}},
                      "serverInfo": {"name": "claude-office", "version": "1"},
                      "instructions": "The Claude Office on this machine: seats, plans, lanes and the CEO. Ask before assuming a seat has plan left."})
    if method == "ping":
        return reply({})
    if method == "tools/list":
        return reply({"tools": TOOLS})
    if method == "tools/call":
        try:
            text = call_tool(str(params.get("name")), params.get("arguments") or {})
            return reply({"content": [{"type": "text", "text": text}]})
        except KeyError:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"No tool named {params.get('name')}"}}
        except (RuntimeError, ValueError) as e:
            return reply({"content": [{"type": "text", "text": str(e)}], "isError": True})
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Unknown method {method}"}}


def serve(stdin=None, stdout=None) -> int:
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        else:
            out = handle(msg) if isinstance(msg, dict) else {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}}
        if out is not None:
            stdout.write(json.dumps(out) + "\n")
            stdout.flush()
    return 0

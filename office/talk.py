"""Talking to a task: read its conversation, message it while it runs, or follow up once it has finished."""
from __future__ import annotations

import json
from pathlib import Path

from . import config, conversation, lanes, messaging

SESSION_ID = messaging.SESSION_ID


def _live(office, seat_id: str, session_id: str) -> tuple[dict | None, dict | None]:
    for s in office.get().get("seats", []):
        if s["id"] != seat_id:
            continue
        for x in s.get("sessions", []):
            if x.get("id") == session_id and x.get("live", True):
                return s, x
        return s, None
    return None, None


def _transcript(seat: dict | None, session_id: str, candidate: str | None = None) -> Path | None:
    roots = [Path(seat["config_dir"]) / "projects"] if seat and seat.get("kind") == "claude" else []
    roots.append(config.HOME / ".claude" / "projects")
    for root in roots:
        hits = [Path(candidate)] if isinstance(candidate, str) else root.glob(f"*/{session_id}.jsonl")
        for path in hits:
            try:
                resolved = path.resolve()
                if (resolved.name == f"{session_id}.jsonl" and root.resolve() in resolved.parents
                        and resolved.is_file()):
                    return resolved
            except (OSError, ValueError, RuntimeError):
                continue
    return None


def _cwd_of(path: Path) -> str | None:
    try:
        with open(path, "rb") as f:
            budget = conversation.HEAD_BYTES
            for _ in range(400):
                line = f.readline(budget + 1)
                if not line:
                    break
                budget -= len(line)
                if budget < 0:
                    return None
                try:
                    d = json.loads(line)
                except (ValueError, RecursionError):
                    continue
                if isinstance(d, dict) and isinstance(d.get("cwd"), str):
                    return d["cwd"]
    except OSError:
        return None
    return None


def delivery_for(office, x: dict | None) -> str:
    """How a message to this session would land: direct, review (held in its terminal), followup, or none."""
    if x is None:
        return "followup"
    if not messaging.valid_target(x.get("socket")):
        return "none"
    pids = {l.get("pid") for l in office.get().get("lanes", []) if l.get("allow_messages") is True and l.get("pid")}
    return "direct" if x.get("pid") in pids else "review"


def conversation_view(office, seat_id: str, session_id: str) -> dict:
    demo = getattr(office, "is_demo", False)
    if not demo and not SESSION_ID.fullmatch(session_id or ""):
        raise ValueError("Unknown session")
    seat, x = _live(office, seat_id, session_id)
    if seat is None:
        raise ValueError("Unknown seat")
    if demo:
        return {"items": office.demo_conversation(session_id), "thread": [], "live": x is not None,
                "delivery": "direct" if x and x.get("kind") == "lane" else "review", "name": x.get("name") if x else None}
    path = _transcript(seat, session_id, (x or {}).get("transcript"))
    inbox = getattr(office, "inbox", None)
    return {
        "items": conversation.read(path),
        "thread": inbox.thread_for(x.get("socket") if x else None, session_id) if inbox else [],
        "live": x is not None,
        "delivery": "none" if seat.get("kind") == "codex" else delivery_for(office, x),
        "name": x.get("name") if x else None,
    }


def followup_title(text: str, fallback: str) -> str:
    """'Follow-up: <the message's first words>', so the lane reads as what was asked, not as an id."""
    words = " ".join(text.split())
    if not words:
        return f"Follow-up: {fallback}"
    cut = words[:42]
    if len(words) > 42:
        cut = cut[:cut.rfind(" ")] if " " in cut[12:] else cut
        cut = cut.rstrip(",;:.-") + "…"
    return f"Follow-up: {cut}"

def send(office, body: dict, seat_ids: list[str]) -> dict:
    seat_id, session_id = str(body.get("seat", "")), str(body.get("id", ""))
    text = str(body.get("text") or "").strip()
    if not SESSION_ID.fullmatch(session_id):
        raise ValueError("Unknown session")
    if not text:
        raise ValueError("Write a message first")
    if len(text) > messaging.MAX_TEXT:
        raise ValueError(f"Keep it under {messaging.MAX_TEXT} characters")
    seat, x = _live(office, seat_id, session_id)
    if seat is None:
        raise ValueError("Unknown seat")
    if seat.get("kind") == "codex":
        raise ValueError("Codex sessions cannot take messages yet")
    inbox = getattr(office, "inbox", None)
    mode = delivery_for(office, x)
    fork = body.get("fork") is True and x is not None              # a copy of a session still open in its terminal
    if x is not None and body.get("followup") and not fork:
        raise ValueError("Wait for the running session to finish before following up")
    if x is not None and (mode == "none" or inbox is None):
        raise ValueError("That running session cannot receive messages right now")
    if mode in ("direct", "review") and inbox is not None and not fork:
        msg_id = messaging.send(x["socket"], text, inbox.address, office.cfg.get("message_from_name") or "Claude Office (CEO)")
        inbox.record_out(msg_id, x["socket"], seat_id, session_id, text)
        office.emit("message", f"CEO messaged {x['name']} on {seat['label']}", seat_id)
        return {"ok": True, "delivery": mode, "msg_id": msg_id}
    # Finished: continue its conversation as a follow-up lane on the seat the CEO picks.
    path = _transcript(seat, session_id, (x or {}).get("transcript"))
    cwd = (x or {}).get("cwd") or (path and _cwd_of(path))
    if not path or not cwd:
        raise ValueError("Cannot find that session's transcript to follow up on")
    pick = body.get("seat_choice") or seat_id
    if pick != "auto" and not any(s["id"] == pick and s.get("kind") == "claude"
                                  for s in office.get().get("seats", [])):
        raise ValueError("Claude follow-ups require a Claude seat")
    lane = lanes.create_lane(followup_title(text, (x or {}).get("name") or session_id[:8]), text, cwd, pick,
                             office.cfg["lane_defaults"]["model"], office.cfg["lane_defaults"]["permission_mode"],
                             seat_ids, office.cfg, resume_session=session_id, fork=fork)
    office.emit("lane", f"CEO followed up on {(x or {}).get('name') or session_id[:8]} ({lane['id']})", seat_id, "good")
    return {"ok": True, "delivery": "followup", "lane": lane}

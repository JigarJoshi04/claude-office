"""Talking to a task: read its conversation, message it while it runs, or follow up once it has finished."""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import config, conversation, lanes, messaging

SESSION_ID = re.compile(r"^[0-9a-f-]{36}$")


def _live(office, seat_id: str, session_id: str) -> tuple[dict | None, dict | None]:
    for s in office.get().get("seats", []):
        if s["id"] != seat_id:
            continue
        for x in s.get("sessions", []):
            if x.get("id") == session_id and x.get("live", True):
                return s, x
        return s, None
    return None, None


def _transcript(seat: dict | None, session_id: str) -> Path | None:
    roots = [Path(seat["config_dir"]) / "projects"] if seat and seat.get("kind") == "claude" else []
    roots.append(config.HOME / ".claude" / "projects")
    for root in roots:
        hits = list(root.glob(f"*/{session_id}.jsonl")) if root.is_dir() else []
        if hits:
            return hits[0]
    return None


def _cwd_of(path: Path) -> str | None:
    try:
        with open(path, "rb") as f:
            for _ in range(400):
                line = f.readline()
                if not line:
                    break
                try:
                    d = json.loads(line)
                except ValueError:
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
        return "followup" if x.get("kind") != "codex" and x.get("seat") != "astra" else "none"
    pids = {l.get("pid") for l in office.get().get("lanes", []) if l.get("allow_messages") is True and l.get("pid")}
    return "direct" if x.get("pid") in pids else "review"


def conversation_view(office, seat_id: str, session_id: str) -> dict:
    demo = getattr(office, "is_demo", False)
    if not demo and not SESSION_ID.match(session_id or ""):
        raise ValueError("Unknown session")
    seat, x = _live(office, seat_id, session_id)
    if seat is None:
        raise ValueError("Unknown seat")
    if demo:
        return {"items": office.demo_conversation(session_id), "thread": [], "live": x is not None,
                "delivery": "direct" if x and x.get("kind") == "lane" else "review", "name": x.get("name") if x else None}
    path = Path(x["transcript"]) if x and x.get("transcript") else _transcript(seat, session_id)
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
    if not SESSION_ID.match(session_id):
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
    if body.get("followup"):
        mode = "followup"
    if mode in ("direct", "review") and inbox is not None:
        msg_id = messaging.send(x["socket"], text, inbox.address, office.cfg.get("message_from_name") or "Claude Office (CEO)")
        inbox.record_out(msg_id, x["socket"], seat_id, session_id, text)
        office.emit("message", f"CEO messaged {x['name']} on {seat['label']}", seat_id)
        return {"ok": True, "delivery": mode, "msg_id": msg_id}
    # Finished (or not reachable): continue its conversation as a follow-up lane on the seat the CEO picks.
    path = Path(x["transcript"]) if x and x.get("transcript") else _transcript(seat, session_id)
    cwd = (x or {}).get("cwd") or (path and _cwd_of(path))
    if not path or not cwd:
        raise ValueError("Cannot find that session's transcript to follow up on")
    pick = body.get("seat_choice") or seat_id
    lane = lanes.create_lane(followup_title(text, (x or {}).get("name") or session_id[:8]), text, cwd, pick,
                             office.cfg["lane_defaults"]["model"], office.cfg["lane_defaults"]["permission_mode"],
                             seat_ids, office.cfg, resume_session=session_id)
    office.emit("lane", f"CEO followed up on {(x or {}).get('name') or session_id[:8]} ({lane['id']})", seat_id, "good")
    return {"ok": True, "delivery": "followup", "lane": lane}

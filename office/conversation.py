"""A session's conversation, readable: what was asked, what the agent said, and the steps in between."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .messaging import parse_incoming
from .sessions import _ts, describe_tool, redact

TAIL_BYTES = 12_000_000
TYPE_RE = re.compile(rb'"type":"([a-z-]+)"')
MAX_TEXT = 6000


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    return ""


def read(path: str | Path | None, limit: int = 60) -> list[dict]:
    """The last ``limit`` items of a transcript: user, assistant, peer, step and notice entries."""
    if not path:
        return []
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - TAIL_BYTES))
            if size > TAIL_BYTES:
                f.readline()
            raw = f.read()
    except OSError:
        return []
    items: list[dict] = []
    seen_text: set = set()
    for line in raw.split(b"\n"):
        if not line:
            continue
        # Cheap triage before parsing: tool output (images, file dumps) is most of a transcript's bytes.
        if line.startswith(b'{"type":"') and not line.startswith((b'{"type":"user"', b'{"type":"assistant"')):
            continue                                   # api-request blobs, titles, modes, file history
        head = line[:400]
        if b'"attachment":{' in head:
            continue
        m = TYPE_RE.search(head)
        if m and m.group(1) == b"user" and b'"type":"tool_result"' in line[:4000]:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if not isinstance(d, dict) or d.get("isSidechain"):
            continue
        t = d.get("type")
        ts = _ts(d.get("timestamp"))
        msg = d.get("message") if isinstance(d.get("message"), dict) else {}
        if t == "user":
            content = msg.get("content")
            if isinstance(content, list) and any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content):
                continue
            text = _text_of(content).strip()
            if not text:
                continue
            at = text.find("<cross-session-message")
            if 0 <= at < 200:
                p = parse_incoming(text[at:])
                items.append({"ts": ts, "role": "peer", "from_name": p["from_name"] or "another session",
                              "text": redact(p["text"])[:MAX_TEXT]})
            elif text.startswith(("[SYSTEM", "<task-notification", "<system-reminder", "Caveat:")):
                first = text.splitlines()[0][:160]
                items.append({"ts": ts, "role": "notice", "text": redact(first)})
            elif text.startswith("<"):
                continue
            else:
                items.append({"ts": ts, "role": "user", "text": redact(text)[:MAX_TEXT]})
        elif t == "assistant":
            if msg.get("model") == "<synthetic>":
                items.append({"ts": ts, "role": "notice", "text": redact(_text_of(msg.get("content")))[:300]})
                continue
            for c in msg.get("content") if isinstance(msg.get("content"), list) else []:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "text" and isinstance(c.get("text"), str) and c["text"].strip():
                    key = (msg.get("id"), c["text"][:80])
                    if key in seen_text:
                        continue
                    seen_text.add(key)
                    items.append({"ts": ts, "role": "assistant", "text": redact(c["text"])[:MAX_TEXT]})
                elif c.get("type") == "tool_use":
                    text, kind = describe_tool(str(c.get("name") or ""), c.get("input") or {})
                    items.append({"ts": ts, "role": "step", "text": text, "kind": kind})
    # Keep the last `limit` messages (steps between them ride along; they collapse in the page).
    kept, start = 0, 0
    for i in range(len(items) - 1, -1, -1):
        if items[i]["role"] != "step":
            kept += 1
            if kept > limit:
                start = i + 1
                break
    return items[start:][-(limit * 6):]

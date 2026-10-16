"""A session's conversation, readable: what was asked, what the agent said, and the steps in between."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .messaging import FOLLOWUP_PREFIX, LANE_PROMPT_START, parse_incoming
from .sessions import _ts, describe_tool, redact

TAIL_BYTES = 12_000_000
HEAD_BYTES = 256_000
TYPE_RE = re.compile(rb'"type":"([a-z-]+)"')
MAX_TEXT = 6000


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    return ""


def _parse(raw: bytes) -> list[dict]:
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
        if not isinstance(d, dict) or d.get("isSidechain") or d.get("isMeta"):   # meta: injected, never typed
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
            if text.startswith(FOLLOWUP_PREFIX):
                items.append({"ts": ts, "role": "peer", "from_name": "Claude Office (CEO)",
                              "text": redact(text[len(FOLLOWUP_PREFIX):])[:MAX_TEXT]})
            elif text.startswith(LANE_PROMPT_START):
                # A lane's opening prompt: show the CEO's brief, not the office's boilerplate around it.
                title = text[len(LANE_PROMPT_START):].split('" (lane id ', 1)[0]
                items.append({"ts": ts, "role": "brief", "title": redact(title)[:120],
                              "text": redact(text.split("\nTHE BRIEF:\n", 1)[-1])[:MAX_TEXT]})
            elif 0 <= at < 200:
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
    return items


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
    items = _parse(raw)
    if size > TAIL_BYTES and not any(x["role"] == "brief" for x in items):
        # The tail skipped the start of a long session: fetch just its opening brief from the head.
        try:
            with open(path, "rb") as f:
                head = f.read(HEAD_BYTES)
        except OSError:
            head = b""
        first = next((x for x in _parse(head[:head.rfind(b"\n") + 1]) if x["role"] == "brief"), None)
        if first:
            items[:0] = [first, {"ts": (first["ts"] or 0) + 0.001, "role": "notice", "text": "Earlier messages are not shown."}]
    # Keep the last `limit` messages (steps between them ride along; they collapse in the page).
    kept, start = 0, 0
    for i in range(len(items) - 1, -1, -1):
        if items[i]["role"] != "step":
            kept += 1
            if kept > limit:
                start = i + 1
                break
    out = items[start:][-(limit * 6):]
    # A lane's brief is what the whole conversation is about: keep it on top even when it scrolled out.
    brief = next((x for x in items if x["role"] == "brief"), None)
    if brief and brief not in out:
        out = [brief, {"ts": (brief["ts"] or 0) + 0.001, "role": "notice", "text": "Earlier messages are not shown."}] + out
    return out

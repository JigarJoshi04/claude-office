"""Talk to a running session.

Claude Code sessions listen on a Unix socket (``messagingSocketPath`` in their session file) for cross-session
messages: one JSON line per connection, the same frame the SendMessage tool writes. The office sends the CEO's
message there, wrapped and labelled as coming from "Claude Office", and listens on a socket of its own so agents
can answer and so delivery receipts come back.

The receiving session decides what to do with it. By default Claude Code HOLDS a message from a sender that does not
attest a permission mode and shows it to the person at that terminal for approval; a session started with the
setting ``crossSessionInbound: "accept"`` (office lanes, when the CEO allows it) receives it directly. The office
never claims a permission mode to get around that review.
"""
from __future__ import annotations

import json
import os
import re
import socket
import stat
import struct
import threading
import time
import uuid
from collections import deque
from pathlib import Path

from . import config
from .sessions import redact

MAX_TEXT = 4000
# How the office opens the prompt of a follow-up lane, so the Chat tab can show it as the CEO's message.
FOLLOWUP_PREFIX = "Message from the CEO, sent from Claude Office:\n\n"
LANE_PROMPT_START = 'You are an office lane named "'
NAME_RE = re.compile(r"^\d+\.sock$")
WRAP_RE = re.compile(r'<cross-session-message from="([^"]*)"(?: from-session="[^"]*")?(?: hop-chain="[^"]*")?'
                     r'(?: from-name="([^"<>\n\r]*)")?[^>]*>\n([\s\S]*?)\n</cross-session-message>')


def sock_dir() -> Path:
    return Path(f"/run/user/{os.getuid()}/cc-socks")


def valid_target(path: str | None) -> bool:
    """Only real session sockets in this user's private socket directory."""
    if not path:
        return False
    p = Path(path)
    try:
        return p.parent.resolve() == sock_dir().resolve() and bool(NAME_RE.match(p.name)) and stat.S_ISSOCK(p.stat().st_mode)
    except OSError:
        return False


def wrap(text: str, from_addr: str, from_name: str) -> str:
    safe_name = re.sub(r'["<>\n\r]', "", from_name)[:60]
    return f'<cross-session-message from="{from_addr}" from-name="{safe_name}">\n{text}\n</cross-session-message>'


def send(target: str, text: str, from_addr: str, from_name: str = "Claude Office") -> str:
    """Deliver one message to a session socket. Returns the message id. Raises OSError/ValueError on failure."""
    text = str(text or "").strip()
    if not text:
        raise ValueError("Write a message first")
    if len(text) > MAX_TEXT:
        raise ValueError(f"Keep it under {MAX_TEXT} characters")
    if not valid_target(target):
        raise ValueError("That session cannot receive messages")
    msg_id = str(uuid.uuid4())
    frame = {"msgV": 1, "msg_id": msg_id, "type": "user",
             "message": {"role": "user", "content": wrap(text, from_addr, from_name)},
             "priority": "next", "from": from_addr}
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect(target)
        s.sendall((json.dumps(frame) + "\n").encode())
        try:
            s.shutdown(socket.SHUT_WR)
            s.settimeout(1.5)
            s.recv(1)              # the receiver closes once it has read the line
        except (OSError, socket.timeout):
            pass
    finally:
        s.close()
    return msg_id


def parse_incoming(content) -> dict:
    """Pull sender and body out of a wrapped cross-session message."""
    if isinstance(content, list):
        content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
    content = str(content or "")
    m = WRAP_RE.search(content)
    if not m:
        return {"from": None, "from_name": None, "text": content}
    return {"from": m.group(1), "from_name": m.group(2), "text": m.group(3)}


class Inbox:
    """The office's own socket: agents' replies and delivery receipts land here."""

    def __init__(self, path: Path | None = None, store: Path | None = None):
        self.path = path or sock_dir() / f"{os.getpid()}.sock"
        self.store = store or config.STATE_DIR / "messages.jsonl"
        self.items: deque = deque(maxlen=2000)
        self.lock = threading.Lock()
        self.listeners = []           # callables(item) for live news
        self._sock = None
        self._stop = threading.Event()
        self._load()

    @property
    def address(self) -> str:
        return "uds:" + str(self.path)

    def _load(self) -> None:
        try:
            for line in self.store.read_text().splitlines()[-2000:]:
                try:
                    self.items.append(json.loads(line))
                except ValueError:
                    continue
        except OSError:
            pass

    def _append(self, item: dict) -> dict:
        with self.lock:
            self.items.append(item)
            try:
                self.store.parent.mkdir(parents=True, exist_ok=True)
                with open(self.store, "a") as f:
                    f.write(json.dumps(item) + "\n")
                    if f.tell() > 2_000_000:
                        keep = list(self.items)[-1000:]
                        f.close()
                        self.store.write_text("".join(json.dumps(x) + "\n" for x in keep))
            except OSError:
                pass
        for fn in list(self.listeners):
            try:
                fn(item)
            except Exception:
                pass
        return item

    def record_out(self, msg_id: str, target: str, seat: str, session_id: str, text: str) -> dict:
        return self._append({"ts": time.time(), "dir": "out", "msg_id": msg_id, "to": "uds:" + target,
                             "seat": seat, "session": session_id, "text": redact(text), "status": "sent"})

    def start(self) -> bool:
        d = sock_dir()
        if not d.is_dir():
            return False
        try:
            if self.path.exists():
                self.path.unlink()
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.bind(str(self.path))
            os.chmod(self.path, 0o600)
            s.listen(16)
            s.settimeout(1.0)
        except OSError:
            return False
        self._sock = s
        threading.Thread(target=self._serve, daemon=True, name="office-inbox").start()
        return True

    def stop(self) -> None:
        self._stop.set()
        try:
            if self._sock:
                self._sock.close()
            self.path.unlink(missing_ok=True)
        except OSError:
            pass

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except (socket.timeout, OSError):
                continue
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn: socket.socket) -> None:
        try:
            creds = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
            pid, uid, _ = struct.unpack("3i", creds)
            if uid != os.getuid():
                return
            conn.settimeout(3)
            buf = b""
            while b"\n" not in buf and len(buf) < 1_000_000:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf += chunk
        except OSError:
            return
        finally:
            conn.close()
        line = buf.split(b"\n", 1)[0]
        try:
            frame = json.loads(line)
        except ValueError:
            return
        if not isinstance(frame, dict):
            return
        self.receive(frame, pid)

    def receive(self, frame: dict, pid: int | None = None) -> dict | None:
        kind = frame.get("type")
        if kind == "user":
            msg = frame.get("message") or {}
            parsed = parse_incoming(msg.get("content"))
            return self._append({"ts": time.time(), "dir": "in", "msg_id": frame.get("msg_id"),
                                 "from": frame.get("from") or parsed["from"], "from_name": parsed["from_name"],
                                 "text": redact(parsed["text"])[:MAX_TEXT], "peer_pid": pid})
        # Anything else is a receipt or control frame about something we sent: keep its status.
        ref = frame.get("msg_id") if frame.get("msg_id") in self._out_ids() else None
        for key in ("ack_msg_id", "for_msg_id", "in_reply_to", "ref", "message_id", "msgId"):
            if frame.get(key) in self._out_ids():
                ref = frame.get(key)
        status = frame.get("status") or frame.get("state") or frame.get("action") or kind
        item = {"ts": time.time(), "dir": "receipt", "ref": ref, "status": str(status)[:40],
                "keys": sorted(frame.keys())[:20], "peer_pid": pid}
        return self._append(item)

    def _out_ids(self) -> set:
        with self.lock:
            return {x.get("msg_id") for x in self.items if x.get("dir") == "out"}

    def thread_for(self, socket_path: str | None, session_id: str | None) -> list[dict]:
        """Messages to and from one session, with the latest known status of each message we sent."""
        addr = "uds:" + socket_path if socket_path else None
        with self.lock:
            items = list(self.items)
        status = {}
        for x in items:
            if x.get("dir") == "receipt" and x.get("ref"):
                status[x["ref"]] = x.get("status")
        out = []
        for x in items:
            if x.get("dir") == "out" and (x.get("session") == session_id or (addr and x.get("to") == addr)):
                out.append(dict(x, status=status.get(x["msg_id"], x.get("status"))))
            elif x.get("dir") == "in" and addr and x.get("from") == addr:
                out.append(x)
        return out[-100:]

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
import html
import os
import re
import socket
import stat
import struct
import threading
import tempfile
import time
import uuid
from collections import deque
from pathlib import Path

from . import config
from .sessions import redact

MAX_TEXT = 4000
MAX_FRAME = 64 * 1024
MAX_CLIENTS = 8
FRAME_TIMEOUT = 3
MAX_STORE = 2_000_000
SESSION_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
# How the office opens the prompt of a follow-up lane, so the Chat tab can show it as the CEO's message.
FOLLOWUP_PREFIX = "Message from the CEO, sent from Claude Office:\n\n"
LANE_PROMPT_START = 'You are an office lane named "'
NAME_RE = re.compile(r"^\d+\.sock$")
WRAP_RE = re.compile(r'<cross-session-message from="([^"]*)"(?: from-session="[^"]*")?(?: hop-chain="[^"]*")?'
                     r'(?: from-name="([^"<>\n\r]*)")?[^>]*>\n([\s\S]*?)\n</cross-session-message>')


def sock_dir() -> Path:
    return Path(f"/run/user/{os.getuid()}/cc-socks")


def _private_dir(path: Path) -> bool:
    try:
        st = path.lstat()
        return (path.is_absolute() and path.resolve() == path and stat.S_ISDIR(st.st_mode)
                and st.st_uid == os.getuid() and not st.st_mode & 0o077)
    except (OSError, ValueError, RuntimeError):
        return False


def valid_target(path: str | None) -> bool:
    """Only real session sockets in this user's private socket directory."""
    if not isinstance(path, str) or not path or "\0" in path:
        return False
    try:
        p = Path(path)
        st = p.lstat()  # Never follow a socket symlink, even within cc-socks.
        return (p.parent == sock_dir() and _private_dir(p.parent) and p.resolve() == p
                and bool(NAME_RE.fullmatch(p.name)) and stat.S_ISSOCK(st.st_mode) and st.st_uid == os.getuid())
    except (OSError, ValueError, RuntimeError):
        return False


def wrap(text: str, from_addr: str, from_name: str) -> str:
    safe_name = html.escape(re.sub(r'[\x00-\x1f\x7f]', "", from_name)[:60], quote=True)
    address = html.escape(from_addr, quote=True)
    # The body escapes & < > and double quotes, so it can neither close the wrapper nor fake an attribute. Apostrophes
    # stay as typed: the attributes use double quotes, and agents should read "don't", not "don&#x27;t".
    body = html.escape(text, quote=False).replace('"', "&quot;")
    return f'<cross-session-message from="{address}" from-name="{safe_name}">\n{body}\n</cross-session-message>'


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
        _, uid, _ = struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
        if uid != os.getuid() or not valid_target(target):
            raise ValueError("That session cannot receive messages")
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
        content = " ".join(c["text"] for c in content if isinstance(c, dict) and isinstance(c.get("text"), str))
    content = content if isinstance(content, str) else ""
    m = WRAP_RE.search(content)
    if not m:
        return {"from": None, "from_name": None, "text": content}
    return {"from": html.unescape(m.group(1)), "from_name": html.unescape(m.group(2) or "") or None,
            "text": html.unescape(m.group(3))}


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
        self._thread = None
        self._bound_identity = None
        self._clients = {}
        self._clients_lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(MAX_CLIENTS)
        self._tokens, self._refilled = 40.0, time.monotonic()
        self._load()

    @property
    def address(self) -> str:
        return "uds:" + str(self.path)

    def _load(self) -> None:
        try:
            with open(self.store, "rb") as f:
                size = f.seek(0, 2)
                f.seek(max(0, size - MAX_STORE))
                raw = f.read(MAX_STORE)
            if size > MAX_STORE:
                raw = raw.partition(b"\n")[2]
            for line in raw.splitlines()[-2000:]:
                try:
                    item = json.loads(line)
                    if self._valid_item(item):
                        self.items.append(self._clean(item))
                except (ValueError, RecursionError):
                    continue
        except OSError:
            pass

    @staticmethod
    def _valid_item(item) -> bool:
        if not isinstance(item, dict) or item.get("dir") not in ("in", "out", "receipt"):
            return False
        if not all(item.get(k) is None or isinstance(item[k], str)
                   for k in ("msg_id", "ref", "session", "to", "from", "from_name", "text", "status")):
            return False
        return item.get("dir") != "out" or isinstance(item.get("msg_id"), str)

    @staticmethod
    def _clean(item: dict) -> dict:
        strings = {"dir", "msg_id", "ref", "seat", "session", "to", "from", "from_name", "text", "status"}
        out = {k: redact(v)[:MAX_TEXT] if isinstance(v, str) else None
               for k, v in item.items() if k in strings}
        for key in ("ts", "peer_pid"):
            value = item.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                out[key] = value
        if isinstance(item.get("keys"), list):
            out["keys"] = [redact(k)[:120] for k in item["keys"][:20] if isinstance(k, str)]
        return out

    def _append(self, item: dict) -> dict:
        item = self._clean(item)
        with self.lock:
            self.items.append(item)
            try:
                self.store.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(self.store, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "a") as f:
                    os.fchmod(f.fileno(), 0o600)
                    f.write(json.dumps(item) + "\n")
                if self.store.stat().st_size > MAX_STORE:
                    # Bound bytes as well as item count; publish the compacted log atomically.
                    keep, size = [], 0
                    for x in reversed(self.items):
                        line = (json.dumps(x) + "\n").encode()
                        if size + len(line) > MAX_STORE // 2:
                            break
                        keep.append(line)
                        size += len(line)
                    name = None
                    try:
                        with tempfile.NamedTemporaryFile(dir=self.store.parent, delete=False) as f:
                            name = f.name
                            f.write(b"".join(reversed(keep)))
                        os.replace(name, self.store)
                    finally:
                        if name:
                            Path(name).unlink(missing_ok=True)
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
        if self._thread and self._thread.is_alive():
            return True
        if self.path.parent != sock_dir() or not _private_dir(self.path.parent):
            return False
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            # bind fails if anything already owns this name. Never unlink someone else's listener/file.
            s.bind(str(self.path))
            st = self.path.lstat()
            self._bound_identity = (st.st_dev, st.st_ino)
            os.chmod(self.path, 0o600)
            s.listen(16)
            s.settimeout(1.0)
        except OSError:
            s.close()
            self._unlink_owned()
            return False
        self._stop.clear()
        self._sock = s
        self._thread = threading.Thread(target=self._serve, daemon=True, name="office-inbox")
        self._thread.start()
        return True

    def _unlink_owned(self) -> None:
        try:
            st = self.path.lstat()
            if self._bound_identity == (st.st_dev, st.st_ino):
                self.path.unlink()
        except OSError:
            pass
        self._bound_identity = None

    def stop(self) -> None:
        self._stop.set()
        try:
            if self._sock:
                self._sock.close()
        except OSError:
            pass
        if self._thread:
            self._thread.join(timeout=2)
        with self._clients_lock:
            clients = list(self._clients.items())
        for thread, conn in clients:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            conn.close()
        for thread, _ in clients:
            thread.join(timeout=FRAME_TIMEOUT + 1)
        self._unlink_owned()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except (socket.timeout, OSError):
                continue
            if self._stop.is_set() or not self._slots.acquire(blocking=False):
                conn.close()
                continue
            thread = threading.Thread(target=self._worker, args=(conn,), daemon=True, name="office-inbox-client")
            with self._clients_lock:
                self._clients[thread] = conn
            thread.start()

    def _worker(self, conn: socket.socket) -> None:
        try:
            self._handle(conn)
        finally:
            with self._clients_lock:
                self._clients.pop(threading.current_thread(), None)
            self._slots.release()

    def _handle(self, conn: socket.socket) -> None:
        try:
            creds = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
            pid, uid, _ = struct.unpack("3i", creds)
            if uid != os.getuid():
                return
            deadline = time.monotonic() + FRAME_TIMEOUT
            buf = b""
            while b"\n" not in buf:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or len(buf) >= MAX_FRAME:
                    return
                conn.settimeout(remaining)
                chunk = conn.recv(min(8192, MAX_FRAME - len(buf)))
                if not chunk:
                    return  # The protocol requires a complete newline-terminated frame.
                buf += chunk
        except OSError:
            return
        finally:
            conn.close()
        line = buf.split(b"\n", 1)[0]
        try:
            frame = json.loads(line)
        except (ValueError, RecursionError):
            return
        if not isinstance(frame, dict):
            return
        self.receive(frame, pid)

    def receive(self, frame: dict, pid: int | None = None) -> dict | None:
        if not isinstance(frame, dict):
            return None
        for key in ("type", "from", "msg_id", "ack_msg_id", "for_msg_id", "in_reply_to", "ref", "message_id",
                    "msgId", "status", "state", "action"):
            if frame.get(key) is not None and (not isinstance(frame[key], str) or len(frame[key]) > MAX_TEXT):
                return None
        with self.lock:
            now = time.monotonic()
            self._tokens = min(40, self._tokens + (now - self._refilled) * 20)
            self._refilled = now
            if self._tokens < 1:
                return None
            self._tokens -= 1
        kind = frame.get("type")
        if kind == "user":
            msg = frame.get("message") or {}
            if not isinstance(msg, dict):
                return None
            parsed = parse_incoming(msg.get("content"))
            return self._append({"ts": time.time(), "dir": "in", "msg_id": frame.get("msg_id"),
                                 "from": frame.get("from") or parsed["from"], "from_name": parsed["from_name"],
                                 "text": redact(parsed["text"])[:MAX_TEXT], "peer_pid": pid})
        # Anything else is a receipt or control frame about something we sent: keep its status.
        # Receipts may arrive before send() returns and record_out() runs.
        ref = frame.get("msg_id")
        for key in ("ack_msg_id", "for_msg_id", "in_reply_to", "ref", "message_id", "msgId"):
            if frame.get(key):
                ref = frame.get(key)
                break
        status = frame.get("status") or frame.get("state") or frame.get("action") or kind
        item = {"ts": time.time(), "dir": "receipt", "ref": ref, "status": str(status)[:40],
                "keys": sorted(frame.keys())[:20], "peer_pid": pid}
        return self._append(item)

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

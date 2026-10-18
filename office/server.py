"""HTTP front door: the page, a JSON API, and the CEO's controls.

Listens on 127.0.0.1 only. Every request must name a loopback Host (stops DNS-rebinding pages from reading the
office), and every write must carry the per-install token that only the office's own page receives.
"""
from __future__ import annotations

import hmac
import json
import re
import mimetypes
import select
import signal
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import asks, checkpoint, config, divider, lanes, messaging, sessions, talk, settings, tokens

MAX_BODY = 256 * 1024


def _fmt_tok(n: float) -> str:
    return f"{n / 1e9:.1f}B" if n >= 1e9 else f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.0f}k" if n >= 1e3 else str(int(n))


def status_line(snap: dict, style: str = "emoji") -> str:
    """One line for a tmux status bar, a shell prompt or Claude Code's status line: who works, what needs you, the
    burn and the tightest plan. style=plain drops the emoji."""
    seats = snap.get("seats") or []
    live = [x for s in seats for x in s.get("sessions", []) if x.get("live", True)]
    working = sum(1 for x in live if x.get("state") in ("working", "waiting"))
    needs = len(snap.get("attention") or [])
    burn = sum(s.get("tokens_1h_all") or 0 for s in seats)
    tight = None
    for s in seats:
        for w in ((s.get("usage") or {}).get("five_hour"), (s.get("usage") or {}).get("weekly")):
            if w and w.get("pct") is not None and s.get("status") not in ("benched", "offline"):
                left = max(0, 100 - w["pct"])
                if tight is None or left < tight[1]:
                    tight = (s.get("nickname") or s.get("label") or s["id"], left)
    e = (lambda a, b: a) if style != "plain" else (lambda a, b: b)
    parts = [f"{e('⚙', 'work')} {working} working"]
    if needs:
        parts.append(f"{e('⚠', '!')} {needs} need{'s' if needs == 1 else ''} you")
    if burn:
        parts.append(f"{e('🔥', 'burn')} {_fmt_tok(burn)}/h")
    if tight:
        parts.append(f"{e('▁', 'low')} {tight[0]} {tight[1]:.0f}% left")
    return " · ".join(parts)


def _number(value: str, message: str) -> int:
    """A query number in plain ASCII digits; int() alone also takes "７" or "٣" and has its own message for "²"."""
    if not (value.isascii() and value.isdigit() and len(value) <= 6):
        raise ValueError(message)
    return int(value)


def ask_question(office, body: dict) -> dict:
    """POST /api/ask: {"text", "pids"?, "cwd"?}. The session is found by the asking command's parent processes."""
    text = body.get("text")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= asks.MAX_TEXT:
        raise ValueError(f"text must be 1-{asks.MAX_TEXT} characters")
    pids = body.get("pids") or []
    if not isinstance(pids, list) or len(pids) > 20 or any(type(p) is not int for p in pids):
        raise ValueError("pids must be a short list of process ids")
    cwd = body.get("cwd")
    if cwd is not None and (not isinstance(cwd, str) or len(cwd) > 1024):
        raise ValueError("cwd must be a path")
    snap = office.get()
    seat, session, name = asks.session_for(snap, pids, cwd)
    item = office.asks.add(text.strip(), seat, session, name, cwd)
    label = next((s["label"] for s in snap.get("seats", []) if s["id"] == seat), None)
    who = name or item.get("where") or "An agent"
    office.emit("ask", f"{who}{' on ' + label if label else ''} asks: {item['text'][:120]}", seat, "warn", extra={"ask": item["id"]})
    office.build()
    return {"ok": True, "id": item["id"], "found_session": bool(session)}


def answer_question(office, body: dict, dismiss: bool, demo: bool) -> dict:
    """POST /api/ask/answer {"id", "text"} sends the answer to the asking session as a message; /dismiss closes it."""
    ask_id = body.get("id")
    item = office.asks.get(ask_id) if isinstance(ask_id, str) else None
    if not item:
        raise ValueError("Unknown question")
    if item["status"] != "open":
        raise ValueError("That question is already closed")
    if dismiss:
        office.asks.dismiss(ask_id)
        office.build()
        return {"ok": True}
    text = body.get("text")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= asks.MAX_TEXT:
        raise ValueError(f"Write an answer of 1-{asks.MAX_TEXT} characters")
    delivery, note = None, None
    if not demo and item.get("session") and item.get("seat"):
        try:
            r = talk.send(office, {"seat": item["seat"], "id": item["session"],
                                   "text": f"The CEO answered your question ({item['text'][:200]}):\n\n{text.strip()}"},
                          [s["id"] for s in office.get().get("seats", [])])
            delivery = r.get("delivery")
        except ValueError as e:
            note = str(e)
    elif not item.get("session"):
        note = "The office could not tell which session asked, so the answer is kept here."
    done = office.asks.answer(ask_id, text.strip(), delivery)
    office.emit("answer", f"CEO answered {item.get('name') or 'an agent'}: {text.strip()[:80]}", item.get("seat"), "good")
    office.build()
    return {"ok": True, "delivery": delivery, "note": note, "ask": done}


_EVENTS: list = []


def _event_budget(now: float | None = None, limit: int = 30) -> bool:
    """At most `limit` inbound events a minute, so a runaway script cannot flood the floor."""
    now = time.time() if now is None else now
    _EVENTS[:] = [t for t in _EVENTS if now - t < 60]
    if len(_EVENTS) >= limit:
        return False
    _EVENTS.append(now)
    return True


def inbound_event(body: dict, seat_ids: list) -> dict:
    """Validate POST /api/event: {"text", "level"?, "seat"?, "source"?, "banner"?}."""
    if not isinstance(body, dict):
        raise ValueError("Expected an object")
    text = body.get("text")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 140:
        raise ValueError("text must be 1-140 characters")
    level = body.get("level", "info")
    if level not in ("good", "info", "warn", "bad"):
        raise ValueError("level must be good, info, warn or bad")
    seat = body.get("seat")
    if seat is not None and seat not in seat_ids:
        raise ValueError("Unknown seat")
    source = body.get("source")
    if source is not None and (not isinstance(source, str) or not re.fullmatch(r"[\w .:/-]{1,24}", source)):
        raise ValueError("source must be 1-24 letters, digits, spaces or . : / -")
    if not isinstance(body.get("banner", False), bool):
        raise ValueError("banner must be true or false")
    return {"text": " ".join(text.split()), "level": level, "seat": seat, "source": source, "banner": body.get("banner", False)}


class Handler(BaseHTTPRequestHandler):
    office = None          # set by serve()
    token = ""
    port = config.DEFAULT_PORT
    demo = False
    server_version = "ClaudeOffice/3.46.0"

    def log_message(self, fmt, *args):  # quiet: the office polls every few seconds
        pass

    # -- guards --------------------------------------------------------------------------------------------
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        allowed = {f"127.0.0.1:{self.port}", f"localhost:{self.port}", f"[::1]:{self.port}"}
        if host not in allowed:
            return False
        if len(self.headers.get_all("Host", [])) != 1 or len(self.headers.get_all("Origin", [])) > 1:
            return False
        origin = self.headers.get("Origin")
        if origin and origin.lower() not in {"http://" + h for h in allowed}:
            return False
        return True

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, default=str).encode(), "application/json")

    def _body(self) -> dict:
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or self.headers.get("Transfer-Encoding"):
            raise ValueError("Ambiguous request framing")
        n = int(self.headers.get("Content-Length") or 0)
        if n < 0 or n > MAX_BODY:
            raise ValueError("Request too large")
        self.connection.settimeout(5)
        raw = self.rfile.read(n) if n else b"{}"
        data = json.loads(raw or b"{}")
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object")
        return data

    # -- GET -----------------------------------------------------------------------------------------------
    def do_GET(self):
        if not self._host_ok():
            return self._send(403, b"forbidden", "text/plain")
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path in ("/", "/index.html"):
                html = (config.WEB_DIR / "index.html").read_text()
                html = html.replace("{{TOKEN}}", self.token).replace("{{DEMO}}", "1" if self.demo else "0")
                csp = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' "
                       "https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; "
                       "connect-src 'self'; frame-ancestors 'none'")
                return self._send(200, html.encode(), "text/html; charset=utf-8", {"Content-Security-Policy": csp})
            if url.path.startswith("/static/"):
                return self._static(url.path[len("/static/"):])
            if url.path == "/api/state":
                return self._json(200, self.office.get())
            if url.path == "/api/stream":
                return self._stream()
            if url.path == "/api/history":
                hours = _number(q.get("hours", "6"), "hours must be an integer from 1 to 24")
                return self._json(200, self.office.samples.query(self.office.get(), hours, list(self.office.events)))
            if url.path == "/api/stats":
                return self._json(200, self.office.samples.stats(self.office.get(), q.get("day"),
                                                               list(self.office.events)))
            if url.path == "/api/status.txt":
                return self._send(200, status_line(self.office.get(), q.get("style", "emoji")).encode() + b"\n", "text/plain; charset=utf-8")
            if url.path == "/api/tokens":
                rng, seat = q.get("range", "all"), q.get("seat") or None
                if rng not in tokens.RANGES and not re.fullmatch(r"m:\d{4}-(0[1-9]|1[0-2])", rng):
                    raise ValueError("range must be today, 7, 30, 90, all or m:YYYY-MM")
                return self._json(200, self.office.tokens_view(rng, seat, q.get("sessions") == "all"))
            if url.path == "/api/cabinet":
                q_text = q.get("q", "")
                if len(q_text) > 200:
                    raise ValueError("Search for at most 200 characters")
                return self._json(200, self.office.cabinet_view(q_text, q.get("seat") or None,
                                                                _number(q.get("offset", "0"), "offset must be a whole number")))
            if url.path == "/api/prs":
                return self._json(200, self.office.prs_view())
            if url.path == "/api/loose":
                return self._json(200, self.office.loose_view(q.get("refresh") == "1"))
            if url.path == "/api/week":
                days = _number(q.get("days", "7"), "days must be an integer from 1 to 90")
                return self._json(200, {"days": self.office.samples.week(self.office.get(), days, list(self.office.events))})
            if url.path == "/api/settings":
                return self._json(200, settings.view(self.office.cfg, self.office.get().get("seats", [])))
            if url.path == "/api/session":
                return self._json(200, self._session_detail(q.get("seat", ""), q.get("id", "")))
            if url.path == "/api/lane":
                return self._json(200, self._lane_detail(q.get("id", "")))
            if url.path == "/api/conversation":
                return self._json(200, talk.conversation_view(self.office, q.get("seat", ""), q.get("id", "")))
            if url.path == "/healthz":
                return self._json(200, {"ok": True, "age_s": round(time.time() - (self.office.get().get("now") or 0), 1)})
        except (ValueError, KeyError) as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:  # never drop the connection on a surprise; say what kind of failure it was
            return self._json(500, {"error": f"Internal error: {type(e).__name__}"})
        return self._send(404, b"not found", "text/plain")

    def _stream(self):
        office = self.office
        subscription = office.subscribe()
        if subscription is None:
            return self._json(503, {"error": "Too many stream clients"})
        client, last_hash, initial = subscription
        self.close_connection = True
        try:
            self.connection.settimeout(5)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(f"event: state\ndata: {initial}\n\n".encode())
            self.wfile.flush()
            last_state = last_write = time.monotonic()
            while not office.stop.is_set():
                # Detect FIN without waiting for the next heartbeat to free the slot.
                if select.select([self.connection], [], [], 0)[0]:
                    if not self.connection.recv(1, socket.MSG_PEEK):
                        break
                with office.condition:
                    if client.closed:
                        break
                    now = time.monotonic()
                    news = list(client.news)
                    client.news.clear()
                    state = None
                    if office._state_hash != last_hash and now - last_state >= 1.5:
                        state, last_hash = office._state_json, office._state_hash
                        last_state = now
                    ping = now - last_write >= 15
                    if not news and state is None and not ping:
                        delay = max(0.01, 1.5 - (now - last_state)) if office._state_hash != last_hash else 0.5
                        office.condition.wait(min(0.5, delay))
                        continue
                for event in news:
                    self.wfile.write(f"event: news\ndata: {event}\n\n".encode())
                if state is not None:
                    self.wfile.write(f"event: state\ndata: {state}\n\n".encode())
                if ping and not news and state is None:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                last_write = time.monotonic()
        except (OSError, ConnectionError):
            pass
        finally:
            office.unsubscribe(client)

    def _static(self, rel: str):
        base = config.WEB_DIR.resolve()
        p = (base / rel).resolve()
        if base not in p.parents or not p.is_file():
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        if p.suffix == ".js":
            ctype = "text/javascript"
        return self._send(200, p.read_bytes(), ctype)

    def _session_detail(self, seat_id: str, session_id: str) -> dict:
        if self.demo:
            x = self.office.find_session(seat_id, session_id)
            return {"session": x, "state_tail": "2026-10-16 14:02 tests green, opening PR\n2026-10-16 14:20 PR open, waiting on checks",
                    "report": None}
        x = self.office.find_session(seat_id, session_id)
        if not x:
            raise ValueError("No such live session")
        out = {"session": x, "state_tail": sessions.tail_text(x.get("state_file"), 14),
               "report": None}
        rf = x.get("report_file")
        if rf and Path(rf).exists():
            out["report"] = sessions.tail_text(rf, 40)
        return out

    def _lane_detail(self, lane_id: str) -> dict:
        if self.demo:
            return self.office.demo_lane_detail(lane_id)
        lane = lanes.load_lane(lane_id)
        if not lane:
            raise ValueError("No such lane")
        d = lanes.lane_dir(lane_id)
        read = lambda name, n: sessions.tail_text(str(d / name), n)
        return {"lane": lane, "brief": (d / "brief.md").read_text()[:20000] if (d / "brief.md").exists() else "",
                "state": read("STATE.md", 30), "report": read("REPORT.md", 60), "log": read("lane.log", 30)}

    # -- POST ----------------------------------------------------------------------------------------------
    def do_POST(self):
        if not self._host_ok():
            return self._send(403, b"forbidden", "text/plain")
        given = self.headers.get("X-Office-Token") or ""
        if not self.token or not hmac.compare_digest(given.encode(), self.token.encode()):
            return self._json(403, {"error": "Missing or wrong office token"})
        if (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower() != "application/json":
            return self._json(415, {"error": "Send JSON"})
        path = urlparse(self.path).path
        try:
            body = self._body()
            if path == "/api/settings":
                if self.demo:
                    return self._json(200, {"ok": True, "demo": True})
                settings.save(body)
                self.office.build()
                return self._json(200, dict(settings.view(self.office.cfg, self.office.get().get("seats", [])), ok=True))
            if path == "/api/ask":                        # an agent's question for the CEO (python3 -m office ask)
                return self._json(200, ask_question(self.office, body))
            if path in ("/api/ask/answer", "/api/ask/dismiss"):
                return self._json(200, answer_question(self.office, body, path.endswith("dismiss"), self.demo))
            if path == "/api/event":                      # a script's news: a deploy, a cron job, a CI run
                ev = inbound_event(body, [s["id"] for s in self.office.get().get("seats", [])])
                if not _event_budget():
                    return self._json(429, {"error": "Too many events: at most 30 a minute"})
                self.office.emit("external", ev["text"], ev["seat"], ev["level"], extra={"source": ev["source"], "banner": ev["banner"]})
                return self._json(200, {"ok": True})
            if self.demo and path not in ("/api/checkpoint", "/api/divider/preview"):
                return self._json(200, {"ok": True, "demo": True, "note": "Demo office: nothing was changed"})
            snap = self.office.get()
            seat_ids = [s["id"] for s in snap.get("seats", [])]
            if path == "/api/divider":
                cfg = divider.validate(body, seat_ids)
                divider.save(cfg)
                self.office.emit("divider", "CEO updated the load divider: " + ", ".join(
                    f"{sid} {c['weight'] if c['enabled'] else 'benched'}" for sid, c in cfg["seats"].items()))
                self.office.build()
                return self._json(200, {"ok": True, "divider": cfg, "next_pick": self.office.get().get("next_pick")})
            if path == "/api/divider/preview":
                cfg = divider.validate(body, seat_ids)
                ev = divider.evaluate(snap.get("seats", []), cfg, limited_until=lanes.read_limits())
                return self._json(200, {"ok": True, "next_pick": {"seat": ev["pick"], "why": ev["why"],
                                                                  "ranking": ev["ranking"]}})
            if path == "/api/message":
                return self._json(200, talk.send(self.office, body, seat_ids))
            if path == "/api/lanes":
                cfg = self.office.cfg
                ld = cfg["lane_defaults"]
                lane = lanes.create_lane(body.get("title", ""), body.get("brief", ""), body.get("workdir") or "",
                                         body.get("seat") or "auto", body.get("model") or ld["model"],
                                         body.get("permission_mode") or ld["permission_mode"], seat_ids, cfg,
                                         allow_messages=body.get("allow_messages") is not False,   # the form's switch
                                         chain=lanes.chain_from(body.get("chain"), " ".join(str(body.get("title", "")).split())[:60]))
                self.office.emit("lane", f"CEO hired office lane '{lane['title']}' ({lane['seat_pref']})", level="good")
                return self._json(200, {"ok": True, "lane": lane})
            if path == "/api/lanes/stop":
                lane = lanes.stop_lane(str(body.get("id", "")))
                self.office.emit("lane", f"CEO stopped office lane '{lane['title']}'", lane.get("seat"), "warn")
                return self._json(200, {"ok": True, "lane": lane})
            if path == "/api/lanes/resume":
                lane = lanes.resume_lane(str(body.get("id", "")), body.get("seat"), seat_ids)
                self.office.emit("lane", f"CEO resumed office lane '{lane['title']}'", lane.get("seat"))
                return self._json(200, {"ok": True, "lane": lane})
            if path == "/api/checkpoint":
                text = checkpoint.render(snap)
                where = None if self.demo else checkpoint.write(snap, self.office.cfg)
                if where:
                    self.office.emit("checkpoint", f"Checkpoint saved to {where}", level="good")
                return self._json(200, {"ok": True, "path": where, "markdown": text})
            if path == "/api/usage/refresh":
                self.office.usage.poke(body.get("seat"))
                return self._json(200, {"ok": True})
        except (ValueError, KeyError, json.JSONDecodeError, RecursionError) as e:
            return self._json(400, {"error": str(e)})
        except RuntimeError as e:
            return self._json(500, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": f"Internal error: {type(e).__name__}"})
        return self._json(404, {"error": "No such action"})


def serve(port: int, demo: bool = False) -> None:
    config.ensure_dirs()
    if demo:
        from .demo import DemoOffice
        office = DemoOffice()
    else:
        from .snapshot import Office
        office = Office()
    if not demo:
        office.inbox = messaging.Inbox()
        if office.inbox.start():
            def on_inbox(item, office=office):
                if item.get("dir") != "in":
                    return
                who = item.get("from_name") or "A session"
                seat = next((s["id"] for s in office.get().get("seats", []) for x in s.get("sessions", [])
                             if x.get("socket") and "uds:" + x["socket"] == item.get("from")), None)
                office.emit("reply", f"{who} replied to the CEO: {item.get('text', '')[:90]}", seat, "good")
            office.inbox.listeners.append(on_inbox)
        else:
            office.inbox = None
    office.build()
    threading.Thread(target=office.run, daemon=True, name="office").start()
    Handler.office = office
    Handler.token = config.api_token() if not demo else "demo"
    Handler.port = port
    Handler.demo = demo
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    print(f"Claude Office {'(demo) ' if demo else ''}is open at http://127.0.0.1:{port}", flush=True)
    def _term(*_):
        raise KeyboardInterrupt   # systemd stops us with SIGTERM: shut down cleanly so careers and the inbox close

    try:
        signal.signal(signal.SIGTERM, _term)
    except ValueError:            # not the main thread (tests)
        pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        office.stop.set()
        if getattr(office, "inbox", None):
            office.inbox.stop()
        if getattr(office, "career", None):
            office.career.flush()

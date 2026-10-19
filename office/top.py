"""claude-office top: the office in a terminal, for SSH and tmux. The seats and how much plan each has left, what needs
you, who is working on what (and in which phase), the office lanes still out and the latest news, refreshed every two
seconds from the running office.

Keys: up/down pick a session, m messages it, s stops its lane, p is share-safe (hides what sessions are doing and
the news's words), r refreshes now, q quits. Reads are plain GETs; a message or a stop uses the per-install token,
as the page does.
"""
from __future__ import annotations

import curses
import json
import re
import time
import urllib.error
import urllib.request

from . import config

STATE = {"working": "working", "waiting": "waiting", "idle": "idle", "stuck": "quiet", "limited": "out of plan"}


def fetch(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=4) as r:
            return json.loads(r.read())
    except (OSError, ValueError):
        return None


def _pct_left(u: dict | None) -> str:
    return "  -" if not u or u.get("pct") is None else f"{max(0, 100 - round(u['pct'])):3d}%"


def working(snap: dict) -> list[tuple[dict, dict]]:
    """(seat, session) for every live session, the busy ones first."""
    out = [(s, x) for s in snap.get("seats", []) for x in s.get("sessions", []) if x.get("live", True)]
    order = {"working": 0, "waiting": 1, "stuck": 2, "limited": 3, "idle": 4}
    return sorted(out, key=lambda p: (order.get(p[1].get("state"), 5), p[0]["id"], p[1].get("name") or ""))


def _private_need(a: dict) -> str:
    """What needs you, in share-safe words: the kind of thing and the seat, never a title, a repo or a command."""
    kind = ("An agent asks you a question" if a.get("ask") else "A bake-off is ready to judge" if a.get("bakeoff")
            else "Two sessions share a working tree" if a.get("collision") else "Review comments wait on a pull request" if a.get("review")
            else "A risky action" if a.get("risk") else "A report its own tests contradict" if a.get("trust") else None)
    if kind:
        return kind + (f" on {a['seat']}" if a.get("seat") else "")
    if a.get("lane"):
        return "An office lane needs you"
    t = a.get("text", "")
    return t.split(":")[0] if ":" in t else "Something needs you" + (f" on {a['seat']}" if a.get("seat") else "")


def lines(snap: dict, width: int, private: bool = False, pick: int = 0) -> list[tuple[str, str]]:
    """The screen as (text, style) rows, styles: head, dim, good, warn, bad, sel or "". Pure, for tests."""
    w = max(40, width)
    cut = lambda t, n=w: (lambda u: u if len(u) <= n else u[: n - 1] + "…")(" ".join(str(t).split()))   # one line each
    o = snap.get("office") or {}
    t = snap.get("totals") or {}
    rows: list[tuple[str, str]] = []
    att = snap.get("attention") or []
    busy = sum(1 for _, x in working(snap) if x.get("state") in ("working", "waiting"))
    rows.append((cut(f"Claude Office {o.get('version', '')} · {busy} at work · {len(att)} need{'s' if len(att) == 1 else ''} you"
                     + (f" · {t['tokens_1h'] / 1e6:.1f}M tokens/h" if isinstance(t.get("tokens_1h"), (int, float)) else "")
                     + time.strftime(" · %H:%M", time.localtime(snap.get("now") or time.time()))), "head"))
    rows.append(("", ""))
    rows.append((cut(f"{'SEAT':<16}{'STATUS':<12}{'5H LEFT':>8}{'WEEK LEFT':>11}{'DESKS':>7}"), "dim"))
    for s in snap.get("seats", []):
        u = s.get("usage") or {}
        live = [x for x in s.get("sessions", []) if x.get("live", True)]
        st = s.get("status") or ""
        style = "bad" if st in ("limited", "offline") else "dim" if st == "benched" else ""
        name = s.get("nickname") or s.get("label") or s["id"]
        rows.append((cut(f"{name[:15]:<16}{st[:11]:<12}{_pct_left(u.get('five_hour')):>8}{_pct_left(u.get('weekly')):>11}{len(live):>7}"), style))
    rows.append(("", ""))
    rows.append((f"NEEDS YOU ({len(att)})", "dim"))
    names = {s.get("label") or s["id"]: s.get("nickname") for s in snap.get("seats", []) if s.get("nickname")}
    named = lambda t: re.sub(r"\b(" + "|".join(map(re.escape, sorted(names, key=len, reverse=True))) + r")\b(?![-\w])", lambda m: names[m.group(1)], t) if names else t
    for a in att[:6]:
        text = named(_private_need(a) if private else a.get("text", ""))
        rows.append((cut("  " + text), "bad" if a.get("level") == "bad" else "warn"))
    if not att:
        rows.append(("  All clear.", "good"))
    rows.append(("", ""))
    ws = working(snap)
    rows.append((f"SESSIONS ({len(ws)})  up/down pick · m message · s stop its lane", "dim"))
    for i, (s, x) in enumerate(ws[:14]):
        act = STATE.get(x.get("state"), x.get("state") or "") if private else (x.get("activity") or STATE.get(x.get("state"), ""))
        title = ("a lane" if x.get("kind") == "lane" else "a session") if private else (x.get("name") or "")
        phase = f" [{x['phase']}]" if x.get("phase") else ""
        line = f"{'>' if i == pick else ' '} {(s.get('nickname') or s.get('label') or s['id'])[:10]:<11}{title[:22]:<23}{STATE.get(x.get('state'), x.get('state') or '')[:11]:<12}{phase} {act}"
        rows.append((cut(line), "sel" if i == pick else "good" if x.get("state") == "working" else ""))
    lanes = [l for l in snap.get("lanes") or [] if l.get("status") in ("scheduled", "queued", "starting", "running", "waiting", "interrupted")]
    if lanes:
        rows.append(("", ""))
        rows.append((f"LANES OUT ({len(lanes)})", "dim"))
        for l in lanes[:6]:
            rows.append((cut(f"  {('A lane' if private else l.get('title') or l['id'])[:40]:<41}{l.get('status')}"), "warn" if l.get("status") in ("waiting", "interrupted") else ""))
    rows.append(("", ""))
    rows.append(("NEWS", "dim"))
    for e in list(snap.get("events") or [])[-8:][::-1]:
        text = f"{e.get('kind')} news" if private and e.get("kind") not in ("usage", "reset", "levelup", "achievement") else e.get("text", "")
        rows.append((cut(time.strftime("  %H:%M ", time.localtime(e.get("ts") or 0)) + text),
                     {"bad": "bad", "warn": "warn", "good": "good"}.get(e.get("level"), "")))
    return [(cut(t), st) for t, st in rows]                # every row fits the terminal


def _post(port: int, path: str, body: dict) -> str:
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Office-Token": config.api_token()})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            d = json.loads(r.read() or b"{}")
            return "Demo office: nothing was sent." if d.get("demo") else "Done."
    except urllib.error.HTTPError as e:
        try:
            return "Could not: " + json.loads(e.read()).get("error", str(e.code))
        except ValueError:
            return f"Could not: {e.code}"
    except OSError as e:
        return f"Could not reach the office: {e}"


def _ask(scr, prompt: str) -> str:
    h, w = scr.getmaxyx()
    curses.echo(); curses.curs_set(1); scr.nodelay(False)
    scr.move(h - 1, 0); scr.clrtoeol(); scr.addstr(h - 1, 0, prompt[: w - 1])
    try:
        text = scr.getstr(h - 1, min(len(prompt), w - 2), 400).decode(errors="replace")
    finally:
        curses.noecho(); curses.curs_set(0); scr.nodelay(True); scr.timeout(200)   # back to waking five times a second
    return text.strip()


def run(scr, port: int, every: float = 2.0) -> None:
    curses.curs_set(0)
    scr.nodelay(True)
    scr.timeout(200)
    styles = {"": curses.A_NORMAL, "head": curses.A_BOLD, "dim": curses.A_DIM, "sel": curses.A_REVERSE}
    if curses.has_colors():
        curses.start_color()
        curses.use_default_colors()
        for i, (k, c) in enumerate((("good", curses.COLOR_GREEN), ("warn", curses.COLOR_YELLOW), ("bad", curses.COLOR_RED)), 1):
            curses.init_pair(i, c, -1)
            styles[k] = curses.color_pair(i)
    snap, last, pick, private, note = None, 0.0, 0, False, ""
    while True:
        if time.time() - last >= every:
            snap, last = fetch(port) or snap, time.time()
        scr.erase()
        h, w = scr.getmaxyx()
        if not snap:
            scr.addstr(0, 0, f"Waiting for the office on port {port}… (q quits)"[: w - 1])
        else:
            pick = max(0, min(pick, min(14, len(working(snap))) - 1))   # only the sessions shown can be picked
            for y, (text, style) in enumerate(lines(snap, w - 1, private, pick)[: h - 1]):
                try:
                    scr.addstr(y, 0, text[: w - 1], styles.get(style, curses.A_NORMAL))
                except curses.error:                     # a terminal too small for a row: skip it, never crash
                    pass
            try:
                scr.addstr(h - 1, 0, (note or ("share-safe · " if private else "") + "q quit · p share-safe · r refresh")[: w - 1], curses.A_DIM)
            except curses.error:
                pass
        scr.refresh()
        k = scr.getch()
        if k in (ord("q"), 27):
            return
        if k == ord("p"):
            private = not private
        elif k == ord("r"):
            last = 0
        elif k == curses.KEY_DOWN:
            pick += 1
        elif k == curses.KEY_UP:
            pick = max(0, pick - 1)
        elif k in (ord("m"), ord("s")) and snap:
            ws = working(snap)
            if not ws:
                continue
            s, x = ws[min(pick, len(ws) - 1)]
            if k == ord("m"):
                text = _ask(scr, f"Message {x.get('name')}: ")
                note = _post(port, "/api/message", {"seat": s["id"], "id": x["id"], "text": text}) if text else ""
            elif x.get("lane_id"):
                if _ask(scr, f"Stop the lane '{x.get('name')}'? Type yes: ").lower() == "yes":
                    note = _post(port, "/api/lanes/stop", {"id": x["lane_id"]})
            else:
                note = "Only office lanes can be stopped from here."
            last = 0


def main(port: int | None = None) -> int:
    port = port or config.load_config().get("port", config.DEFAULT_PORT)
    try:
        curses.wrapper(run, port)
    except KeyboardInterrupt:
        pass
    return 0

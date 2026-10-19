"""Command line: ``python3 -m office <command>``.

  serve [--port N] [--demo]        open the office at http://127.0.0.1:7420
  status                           one line per seat: usage, sessions, what they are doing
  pick-seat [--kind claude|codex] [--exclude a,b] [--model opus] [--json]
                                   the seat the load divider gives the next lane (exit 3 when none can)
  top [--port N]                   the office in this terminal: seats, Needs you, sessions, lanes, news
  hire --title T --brief-file F [--workdir D] [--seat auto|ID] [--model opus]
                                   start an office lane
  lanes | stop ID | resume ID [--seat ID]
  checkpoint                       write the office down (resume commands for every session)
  ask QUESTION                     (from inside a session) ask the CEO; the answer comes back as a message
  backups | restore DAY            the daily backups of the office's state, and putting one back (office stopped)
  post TEXT [--level good|info|warn|bad] [--seat ID] [--source NAME] [--banner]
                                   put a script's news on the floor ("Prod deploy done")
  run-lane ID                      (internal) the lane supervisor that systemd runs
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from . import config, divider, lanes


def _fmt_pct(u, key):
    w = (u or {}).get(key) or {}
    return f"{w['pct']:>3.0f}%" if w.get("pct") is not None else "  ? "


def cmd_status(_args) -> int:
    from .snapshot import Office
    office = Office()
    office.usage.tick()
    snap = office.build()
    for s in snap["seats"]:
        live = [x for x in s["sessions"] if x.get("live", True)]
        print(f"{s['label']:<10} {s['status']:<8} 5h {_fmt_pct(s.get('usage'), 'five_hour')}  "
              f"wk {_fmt_pct(s.get('usage'), 'weekly')}  {len(live)} live ({s['lanes']} lanes)")
        for x in live:
            print(f"    {x['state']:<8} {x['name'][:34]:<34} {(x.get('activity') or '')[:70]}")
    np = snap["next_pick"]
    print(f"\nNext lane goes to: {np['seat'] or 'nobody'} - {np['why']}")
    return 0


def cmd_pick(args) -> int:
    from .snapshot import quick_seats
    seats = quick_seats()
    cfg = divider.load([s["id"] for s in seats])
    ev = divider.evaluate(seats, cfg, kind=args.kind, exclude=tuple(filter(None, (args.exclude or "").split(","))),
                          limited_until=lanes.read_limits(), model=args.model)
    if args.json:
        cdir = next((s["config_dir"] for s in seats if s["id"] == ev["pick"]), None)
        print(json.dumps(dict(ev, config_dir=cdir), default=str))
    elif ev["pick"]:
        print(ev["pick"])
    else:
        print(ev["why"], file=sys.stderr)
    return 0 if ev["pick"] else 3


def cmd_hire(args) -> int:
    cfg = config.load_config()
    from .snapshot import quick_seats
    ids = [s["id"] for s in quick_seats()]
    brief = open(args.brief_file).read() if args.brief_file != "-" else sys.stdin.read()
    lane = lanes.create_lane(args.title, brief, args.workdir or cfg["default_workdir"], args.seat,
                             args.model or cfg["lane_defaults"]["model"],
                             args.permission_mode or cfg["lane_defaults"]["permission_mode"], ids, cfg)
    print(f"hired {lane['id']} (unit {lane['unit']})")
    return 0


def _post(path: str, body: dict, port: int | None) -> tuple[int, dict | None]:
    """POST to the running office with the per-install token (only this user can read it): (status, JSON reply)."""
    import urllib.error
    import urllib.request
    port = port or config.load_config().get("port", config.DEFAULT_PORT)
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Office-Token": config.api_token()})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            raw = r.read()
            code = r.status
    except urllib.error.HTTPError as e:
        raw, code = e.read(), e.code
    except OSError as e:
        raise SystemExit(f"The office is not running on port {port}: {e}")
    try:
        out = json.loads(raw or b"{}")
    except ValueError:                                 # not the office on that port
        out = None
    return code, out if isinstance(out, dict) else None


def cmd_backups(_args) -> int:
    root = config.STATE_DIR / "backups"
    days = sorted(p.name for p in root.iterdir() if p.is_dir()) if root.is_dir() else []
    for d in days:
        files = sorted(p.name for p in (root / d).iterdir())
        print(f"{d}  {', '.join(files)}")
    if not days:
        print("No backups yet: the office makes one a day while it runs.")
    return 0


def cmd_restore(args) -> int:
    """Put a day's backup of the state files back, keeping the current ones beside them. The office must be stopped,
    or it would write its own state over the restored files."""
    import shutil
    import socket
    src = config.STATE_DIR / "backups" / args.day
    if not src.is_dir():
        print(f"No backup for {args.day}. Run `python3 -m office backups` to see the days there are.", file=sys.stderr)
        return 1
    port = config.load_config().get("port", config.DEFAULT_PORT)
    with socket.socket() as s:
        s.settimeout(1)
        if s.connect_ex(("127.0.0.1", port)) == 0:
            print(f"The office is running on port {port}: stop it first (systemctl --user stop claude-office), then restore.", file=sys.stderr)
            return 1
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for f in sorted(src.iterdir()):
        cur = config.STATE_DIR / f.name
        if cur.exists():
            shutil.copy2(cur, cur.with_name(f"{f.name}.before-restore-{stamp}"))
        shutil.copy2(f, cur)
        print(f"restored {f.name}")
    return 0


def cmd_ask(args) -> int:
    """Ask the CEO from inside a session: the office finds the session by this command's parent processes."""
    import os
    from .asks import parent_pids
    code, out = _post("/api/ask", {"text": args.question, "pids": parent_pids(), "cwd": os.getcwd()}, args.port)
    if code != 200 or out is None:
        print((out or {}).get("error") or f"HTTP {code}", file=sys.stderr)
        return 1
    print("Asked. Keep working on what does not depend on it: the CEO's answer comes back to this session as a message."
          if out.get("found_session") else "Asked. The office could not tell which session this is, so the answer stays in its Inbox.")
    return 0


def cmd_post(args) -> int:
    """POST /api/event to the running office: a script's news on the floor."""
    body = {"text": args.text, "level": args.level, "banner": args.banner}
    if args.seat:
        body["seat"] = args.seat
    if args.source:
        body["source"] = args.source
    code, out = _post("/api/event", body, args.port)
    if code != 200 or out is None:
        print((out or {}).get("error") or f"HTTP {code}", file=sys.stderr)
        return 1
    return 0


def cmd_lanes(_args) -> int:
    for l in lanes.list_lanes():
        when = time.strftime("%d %b %H:%M", time.localtime(l["created_at"]))
        print(f"{l['id']:<40} {l['status']:<9} {l.get('seat') or '-':<8} {when}  {l['title']}")
        if l.get("report_status"):
            print(f"{'':<40} {l['report_status']}")
    return 0


def cmd_events(args) -> int:
    """The office's news in this terminal: the last lines, and with --follow every new one as it comes."""
    path = config.STATE_DIR / "events.jsonl"
    def show(line: str) -> None:
        try:
            e = json.loads(line)
        except ValueError:
            return
        if not isinstance(e, dict) or (args.kind and e.get("kind") != args.kind):
            return
        if args.json:
            print(json.dumps(e), flush=True)
        else:
            print(f"{time.strftime('%d %b %H:%M', time.localtime(e.get('ts') or 0))}  {e.get('kind', ''):<11} {e.get('seat') or '-':<9} {e.get('text', '')}", flush=True)
    try:
        with open(path) as f:
            lines = f.readlines()
            for line in lines[-args.lines:]:
                show(line)
            if not args.follow:
                return 0
            while True:                                   # tail -f: new news as it is written
                line = f.readline()
                if line:
                    show(line)
                else:
                    time.sleep(1.5)
    except FileNotFoundError:
        print("No news yet.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0


def cmd_token(args) -> int:
    """Show where the office's write token is kept, or make a new one (the office reads it when it starts)."""
    path = config.CONFIG_DIR / "token"
    if not args.rotate:
        print(f"The office token is kept in {path} (mode 0600). Rotate it with: claude-office token --rotate")
        return 0
    path.unlink(missing_ok=True)
    config.api_token()
    print("A new token is written. Restart the office (systemctl --user restart claude-office) and reload open pages;"
          " scripts that use ask and post read the file each time.")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="office", description="Claude Office")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=None)
    s.add_argument("--demo", action="store_true", help="a made-up office, for screenshots and trying the UI")
    sub.add_parser("status")
    pk = sub.add_parser("pick-seat")
    pk.add_argument("--kind", choices=["claude", "codex"])
    pk.add_argument("--exclude")
    pk.add_argument("--model", help="the lane's model (opus, sonnet, …): keeps it off a seat whose week for that model is spent")
    pk.add_argument("--json", action="store_true")
    h = sub.add_parser("hire")
    h.add_argument("--title", required=True)
    h.add_argument("--brief-file", required=True, help="path, or - for stdin")
    h.add_argument("--workdir")
    h.add_argument("--seat", default="auto")
    h.add_argument("--model")
    h.add_argument("--permission-mode")
    sub.add_parser("lanes")
    st = sub.add_parser("stop")
    st.add_argument("id")
    rs = sub.add_parser("resume")
    rs.add_argument("id")
    rs.add_argument("--seat")
    sub.add_parser("checkpoint")
    sub.add_parser("backups", help="list the daily backups of the office's state")
    rs2 = sub.add_parser("restore", help="put a day's backup back (stop the office first)")
    rs2.add_argument("day")
    ak = sub.add_parser("ask", help="ask the CEO a question (run it from inside a session)")
    ak.add_argument("question")
    ak.add_argument("--port", type=int)
    po = sub.add_parser("post", help="put a script's news on the floor")
    po.add_argument("text")
    po.add_argument("--level", choices=["good", "info", "warn", "bad"], default="info")
    po.add_argument("--seat")
    po.add_argument("--source", help="who says it: deploy, cron, CI (1-24 characters)")
    po.add_argument("--banner", action="store_true", help="also a banner across the floor (at Full game intensity)")
    po.add_argument("--port", type=int)
    tp = sub.add_parser("top", help="the office in this terminal (for SSH and tmux)")
    tp.add_argument("--port", type=int)
    ev = sub.add_parser("events", help="the office's news in this terminal")
    ev.add_argument("--follow", "-f", action="store_true", help="keep printing new news as it comes")
    ev.add_argument("--lines", "-n", type=int, default=20)
    ev.add_argument("--kind", help="only this kind: report, limit, lane, risk, promise, …")
    ev.add_argument("--json", action="store_true")
    tk = sub.add_parser("token", help="the office's write token: where it is, or --rotate for a new one")
    tk.add_argument("--rotate", action="store_true")
    rl = sub.add_parser("run-lane")
    rl.add_argument("id")
    args = p.parse_args(argv)

    config.ensure_dirs()
    if args.cmd == "top":
        from . import top
        return top.main(args.port)
    if args.cmd == "serve":
        from .server import serve
        serve(args.port or config.load_config().get("port", config.DEFAULT_PORT), demo=args.demo)
        return 0
    if args.cmd == "status":
        return cmd_status(args)
    if args.cmd == "events":
        return cmd_events(args)
    if args.cmd == "token":
        return cmd_token(args)
    if args.cmd == "pick-seat":
        return cmd_pick(args)
    if args.cmd == "hire":
        return cmd_hire(args)
    if args.cmd == "lanes":
        return cmd_lanes(args)
    if args.cmd == "stop":
        print(lanes.stop_lane(args.id)["status"])
        return 0
    if args.cmd == "resume":
        from .snapshot import quick_seats
        print(lanes.resume_lane(args.id, args.seat, [s["id"] for s in quick_seats()])["status"])
        return 0
    if args.cmd == "checkpoint":
        from . import checkpoint
        from .snapshot import Office
        print(checkpoint.write(Office().build(), config.load_config()))
        return 0
    if args.cmd == "post":
        return cmd_post(args)
    if args.cmd == "ask":
        return cmd_ask(args)
    if args.cmd == "backups":
        return cmd_backups(args)
    if args.cmd == "restore":
        return cmd_restore(args)
    if args.cmd == "run-lane":
        return lanes.run_lane(args.id)
    return 2


if __name__ == "__main__":
    sys.exit(main())

"""Command line: ``python3 -m office <command>``.

  serve [--port N] [--demo]        open the office at http://127.0.0.1:7420
  status                           one line per seat: usage, sessions, what they are doing
  pick-seat [--kind claude|codex] [--exclude a,b] [--json]
                                   the seat the load divider gives the next lane (exit 3 when none can)
  hire --title T --brief-file F [--workdir D] [--seat auto|ID] [--model opus]
                                   start an office lane
  lanes | stop ID | resume ID [--seat ID]
  checkpoint                       write the office down (resume commands for every session)
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
                          limited_until=lanes.read_limits())
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


def cmd_lanes(_args) -> int:
    for l in lanes.list_lanes():
        when = time.strftime("%d %b %H:%M", time.localtime(l["created_at"]))
        print(f"{l['id']:<40} {l['status']:<9} {l.get('seat') or '-':<8} {when}  {l['title']}")
        if l.get("report_status"):
            print(f"{'':<40} {l['report_status']}")
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
    rl = sub.add_parser("run-lane")
    rl.add_argument("id")
    args = p.parse_args(argv)

    config.ensure_dirs()
    if args.cmd == "serve":
        from .server import serve
        serve(args.port or config.load_config().get("port", config.DEFAULT_PORT), demo=args.demo)
        return 0
    if args.cmd == "status":
        return cmd_status(args)
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
    if args.cmd == "run-lane":
        return lanes.run_lane(args.id)
    return 2


if __name__ == "__main__":
    sys.exit(main())

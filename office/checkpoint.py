"""A checkpoint is the office written down: every seat, every running session, and the exact command to
resume it. Take one before closing the laptop or restarting it."""
from __future__ import annotations

import os
import time
from pathlib import Path

from . import config


def _pct(u, key):
    w = (u or {}).get(key) or {}
    if w.get("pct") is None:
        return "?"
    r = w.get("resets_at")
    return f"{w['pct']:.0f}%" + (f" (resets {time.strftime('%a %H:%M', time.localtime(r))})" if r else "")


def render(snap: dict) -> str:
    now = snap.get("now") or time.time()
    lines = [f"# Office checkpoint, {time.strftime('%a %d %b %Y %H:%M %Z', time.localtime(now))}", ""]
    t = snap.get("totals") or {}
    lines.append(f"{t.get('sessions', 0)} live sessions on {t.get('seats', 0)} seats, "
                 f"{t.get('working', 0)} working, {t.get('lanes', 0)} headless lanes.")
    lines.append("")
    for s in snap.get("seats", []):
        h = s.get("health") or {}
        lines.append(f"## {s['label']} ({s['id']}): {s.get('status')}")
        lines.append(f"- Login: {h.get('detail')}; 5-hour {_pct(s.get('usage'), 'five_hour')}; "
                     f"weekly {_pct(s.get('usage'), 'weekly')}")
        live = [x for x in s.get("sessions", []) if x.get("live", True)]
        if not live:
            lines.append("- No live sessions.")
        for x in live:
            lines.append(f"- **{x['name']}** ({x['kind']}, {x['state']}) in `{x.get('cwd')}`")
            if x.get("title") or x.get("task"):
                lines.append(f"  - Task: {(x.get('title') or x.get('task') or '')[:200]}")
            lines.append(f"  - Now: {x.get('activity')}")
            if x.get("unit"):
                lines.append(f"  - Unit: `{x['unit']}`")
            if x.get("state_file"):
                lines.append(f"  - STATE: `{x['state_file']}`")
            if x.get("report_status"):
                lines.append(f"  - REPORT: {x['report_status']}")
            if x.get("resume_cmd"):
                lines.append(f"  - Resume: `{x['resume_cmd']}`")
        lines.append("")
    if snap.get("lanes"):
        lines.append("## Office lanes")
        for l in snap["lanes"]:
            lines.append(f"- {l['title']} (`{l['id']}`): {l.get('status')} on {l.get('seat') or '-'}; "
                         f"resume with `python3 -m office resume {l['id']}`")
        lines.append("")
    if snap.get("units"):
        lines.append("## Services")
        for u in snap["units"]:
            lines.append(f"- `{u['unit']}`: {u['active']}/{u['sub']}: {u['description']}")
    return "\n".join(lines) + "\n"


def write(snap: dict, cfg: dict) -> str:
    d = Path(os.path.expanduser(cfg.get("checkpoint_dir") or str(config.DATA_DIR / "checkpoints")))
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"office-checkpoint-{time.strftime('%Y%m%d-%H%M%S')}.md"
    p.write_text(render(snap))
    return str(p)

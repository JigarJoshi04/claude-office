"""A checkpoint is the office written down: every seat, every running session, and the exact command to
resume it. Take one before closing the laptop or restarting it."""
from __future__ import annotations

import os
import shlex
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
            lines.append(f"- **{x.get('name')}** ({x.get('kind')}, {x.get('state')}) in `{x.get('cwd')}`")
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


def _desks(snap: dict) -> list[tuple[dict, dict]]:
    return [(s, x) for s in snap.get("seats", []) if s.get("kind") == "claude" and s.get("config_dir")
            for x in s.get("sessions", []) if x.get("live", True) and x.get("kind") == "desk" and x.get("id") and x.get("cwd")]


def resume_script(snap: dict) -> str | None:
    """A shell script that reopens every live terminal session in a tmux window of its own: its folder, then
    `claude --resume`. Nothing in the folders is switched or changed; the branch each was on is noted. None when no
    terminal session is live."""
    rows = _desks(snap)
    if not rows:
        return None
    q, one = shlex.quote, (lambda t: " ".join(str(t or "").split())[:120])   # a comment stays on one line
    now = snap.get("now") or time.time()
    out = ["#!/bin/sh", f"# Claude Office: the terminal sessions that were live at {time.strftime('%a %d %b %H:%M', time.localtime(now))},",
           "# one tmux window each. Run: sh <this file>  (needs tmux)", 'S=office-resume',
           'tmux has-session -t "$S" 2>/dev/null || tmux new-session -d -s "$S" -n office']
    for s, x in rows:
        br = (x.get("git") or {}).get("branch")
        cmd = f"cd {q(x['cwd'])} && CLAUDE_CONFIG_DIR={q(s['config_dir'])} claude --resume {q(x['id'])}; exec \"${{SHELL:-sh}}\""
        out.append(f"# {one(x.get('name'))} on {one(s.get('label'))}" + (f", branch {one(br)}" if br else ""))
        out.append(f'tmux new-window -t "$S" -n {q(one(x.get("name"))[:24] or "session")} {q(cmd)}')
    out.append('tmux attach -t "$S"')
    return "\n".join(out) + "\n"


def _dir(cfg: dict) -> Path:
    d = Path(os.path.expanduser(cfg.get("checkpoint_dir") or str(config.DATA_DIR / "checkpoints")))
    d.mkdir(parents=True, exist_ok=True)
    return d


def write(snap: dict, cfg: dict) -> str:
    d = _dir(cfg)
    p = d / f"office-checkpoint-{time.strftime('%Y%m%d-%H%M%S')}.md"
    p.write_text(render(snap))
    return str(p)


def write_latest(snap: dict, cfg: dict) -> str | None:
    """The hourly checkpoint: office-checkpoint-latest.md and resume-latest.sh, written over each time, and only while a
    terminal session is live, so the one from before a restart is still there after it."""
    script = resume_script(snap)
    if not script:
        return None
    d = _dir(cfg)
    for name, text, mode in (("office-checkpoint-latest.md", render(snap), 0o600), ("resume-latest.sh", script, 0o700)):
        tmp = d / (name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        os.replace(tmp, d / name)
    return str(d / "resume-latest.sh")

"""Where Claude Office keeps things, and which seats it can see.

Everything personal (account labels, programme names, links, lane defaults) lives in a local config file
outside the repo: ``~/.config/claude-office/config.json``. The repo ships only defaults.
"""
from __future__ import annotations

import json
import os
import re
import secrets
from pathlib import Path

HOME = Path(os.environ.get("CLAUDE_OFFICE_HOME") or os.path.expanduser("~"))
CONFIG_DIR = Path(os.environ.get("CLAUDE_OFFICE_CONFIG") or HOME / ".config" / "claude-office")
STATE_DIR = Path(os.environ.get("CLAUDE_OFFICE_STATE") or HOME / ".local" / "state" / "claude-office")
DATA_DIR = Path(os.environ.get("CLAUDE_OFFICE_DATA") or HOME / ".local" / "share" / "claude-office")
REPO_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = REPO_DIR / "web"

DEFAULT_PORT = 7420

# Seat colours, in fixed order: validated for lightness, chroma, colour-blind separation and contrast on dark.
PALETTE = ["#d95926", "#3987e5", "#199e70", "#9085e9", "#c98500", "#d55181"]
ASTRA_COLOR = "#008300"

DEFAULTS: dict = {
    "port": DEFAULT_PORT,
    "office_name": "Claude Office",
    "ceo": {"name": "CEO", "title": "Chief Executive"},
    # Per-seat overrides keyed by seat id: label, nickname, color, hidden.
    "seats": {},
    # Programmes group sessions on the whiteboard. A rule matches a unit name, session name, cwd or task.
    # Example: {"match": "apollo", "name": "Apollo launch", "url": "https://..."}
    "programmes": [],
    # systemd --user units shown in the server room (fnmatch patterns).
    "watch_units": ["*conductor*", "*supervisor*", "*-lane-*", "claude-office*"],
    "default_workdir": str(HOME),
    "checkpoint_dir": str(DATA_DIR / "checkpoints"),
    "lane_defaults": {
        "model": "opus",
        "permission_mode": "acceptEdits",
        "allowed_tools": "Bash,Read,Write,Edit,Glob,Grep,Agent,Skill,TodoWrite,WebFetch,ToolSearch",
        "add_dirs": [],
        "preamble": (
            "Safety: do not deploy, merge, force-push, restart services or delete data unless the brief "
            "explicitly asks for it. Keep git worktrees under your working directory, never /tmp."
        ),
    },
    "usage_poll_seconds": 150,
    "codex": {"enabled": True, "label": "Astra", "seat_id": "astra"},
}

_SEAT_DIR = re.compile(r"^\.claude(\d*)$")


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config() -> dict:
    path = CONFIG_DIR / "config.json"
    cfg = DEFAULTS
    if path.exists():
        try:
            cfg = _merge(DEFAULTS, json.loads(path.read_text()))
        except (OSError, ValueError) as exc:  # a broken local file must not take the office down
            cfg = dict(DEFAULTS, config_error=f"{path}: {exc}")
    return cfg


def discover_claude_seats(cfg: dict) -> list[dict]:
    """Every ~/.claude or ~/.claudeN that holds a login is a seat. Order: claude, claude2, claude3, ..."""
    found = []
    for entry in HOME.iterdir() if HOME.exists() else []:
        m = _SEAT_DIR.match(entry.name)
        if not m or not entry.is_dir():
            continue
        if not ((entry / ".credentials.json").exists() or (entry / "sessions").is_dir()):
            continue
        n = int(m.group(1) or 1)
        seat_id = "claude" if n == 1 else f"claude{n}"
        found.append((n, seat_id, entry))
    found.sort()
    seats = []
    for i, (n, seat_id, path) in enumerate(found):
        over = cfg.get("seats", {}).get(seat_id, {})
        if over.get("hidden"):
            continue
        seats.append({
            "id": seat_id,
            "kind": "claude",
            "config_dir": str(path),
            # The main account keeps its .claude.json in $HOME, the others inside their config dir.
            "account_file": str(HOME / ".claude.json") if n == 1 else str(path / ".claude.json"),
            "label": over.get("label", seat_id),
            "nickname": over.get("nickname"),
            "color": over.get("color", PALETTE[i % len(PALETTE)]),
        })
    return seats


def codex_seat_meta(cfg: dict) -> dict | None:
    c = cfg.get("codex", {})
    if not c.get("enabled", True) or not (HOME / ".codex").is_dir():
        return None
    seat_id = c.get("seat_id", "astra")
    over = cfg.get("seats", {}).get(seat_id, {})
    if over.get("hidden"):
        return None
    return {
        "id": seat_id,
        "kind": "codex",
        "config_dir": str(HOME / ".codex"),
        "label": over.get("label", c.get("label", "Astra")),
        "nickname": over.get("nickname"),
        "color": over.get("color", ASTRA_COLOR),
    }


def api_token() -> str:
    """Per-install secret the page must echo on every write; stops other local pages from driving the office."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    path = CONFIG_DIR / "token"
    if not path.exists():
        path.write_text(secrets.token_urlsafe(32))
        path.chmod(0o600)
    return path.read_text().strip()


def ensure_dirs() -> None:
    for d in (CONFIG_DIR, STATE_DIR, DATA_DIR, DATA_DIR / "lanes"):
        d.mkdir(parents=True, exist_ok=True)

"""Open in…: a live session's or a lane's folder in the file manager, in the editor, or a terminal there, on your own
desktop. Every path is looked up on the office's side (never taken from the page), programs get a list of arguments
(never a shell line built from a request), and a finished lane's terminal can carry its conversation on with
`claude --resume`. config "open": {"terminal": [...], "editor": [...], "folder": [...]} names your own programs, with
"{dir}" where the folder goes.
"""
from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import threading
import time

from . import lanes, messaging

_last = [0.0]
_lock = threading.Lock()

# Terminals, first found wins: the argv that opens one in {dir} (and, after "--", runs a command there).
TERMINALS = [("ptyxis", ["ptyxis", "--new-window", "--working-directory={dir}"], ["--"]),
             ("gnome-terminal", ["gnome-terminal", "--working-directory={dir}"], ["--"]),
             ("kitty", ["kitty", "--directory", "{dir}"], []),
             ("konsole", ["konsole", "--workdir", "{dir}"], ["-e"]),
             ("xterm", ["xterm"], ["-e"])]


def _target(office, body: dict) -> tuple[str, dict | None, dict | None]:
    """(folder, the lane or None, the seat or None) for a live session ({seat, id}) or a lane ({lane})."""
    if body.get("lane"):
        lane = lanes.load_lane(str(body["lane"]))
        if not lane or not lane.get("workdir"):
            raise ValueError("No such lane")
        seat = next((s for s in office.get().get("seats", []) if s["id"] == (lane.get("seat") or lane.get("seat_pref"))), None)
        return lane["workdir"], lane, seat
    seat = next((s for s in office.get().get("seats", []) if s["id"] == str(body.get("seat", ""))), None)
    x = seat and next((x for x in seat.get("sessions", []) if x.get("id") == str(body.get("id", "")) and x.get("live", True)), None)
    if not x or not x.get("cwd"):
        raise ValueError("That session is not running here, so there is no folder to open")
    return x["cwd"], None, seat


def command(office, body: dict, which=shutil.which) -> list[str]:
    """The argv for {what: folder | editor | terminal} on the target; ValueError when it cannot be done."""
    what = body.get("what")
    if what not in ("folder", "editor", "terminal"):
        raise ValueError("Open what: folder, editor or terminal")
    folder, lane, seat = _target(office, body)
    if not os.path.isdir(folder):
        raise ValueError("That folder is not there any more")
    opens = (getattr(office, "cfg", {}) or {}).get("open")
    own = opens.get(what) if isinstance(opens, dict) else None
    if isinstance(own, list) and own and all(isinstance(a, str) for a in own):
        return [a.replace("{dir}", folder) for a in own]
    if what == "folder":
        if not which("xdg-open"):
            raise ValueError("No xdg-open to open folders with: set config open.folder")
        return ["xdg-open", folder]
    if what == "editor":
        for ed in ("code", "codium", "zed", "gnome-text-editor"):
            if which(ed):
                return [ed, folder]
        raise ValueError("No editor found (code, codium, zed): set config open.editor")
    term = next(((argv, run) for name, argv, run in TERMINALS if which(name)), None)
    if not term:
        raise ValueError("No terminal found (ptyxis, gnome-terminal, kitty, konsole, xterm): set config open.terminal")
    argv, run = [a.replace("{dir}", folder) for a in term[0]], term[1]
    sid = (lane or {}).get("last_session_id")
    if lane and sid and messaging.SESSION_ID.fullmatch(sid) and lane.get("status") not in lanes.UNFINISHED and seat and seat.get("kind") == "claude":
        # the main account keeps its .claude.json in $HOME: it runs without CLAUDE_CONFIG_DIR (as lanes.py does)
        env = "" if seat["id"] == "claude" else f"CLAUDE_CONFIG_DIR={shlex.quote(seat['config_dir'])} "
        resume = f"cd {shlex.quote(folder)} && {env}claude --resume {sid}; exec bash"
        return argv + run + ["bash", "-lc", resume]       # a finished lane: carry its conversation on
    return argv


def open_target(office, body: dict, popen=subprocess.Popen, which=shutil.which) -> dict:
    argv = command(office, body, which)
    folder = _target(office, body)[0]
    with _lock:                                        # one a second: a double click opens one window
        if time.monotonic() - _last[0] < 1:
            raise ValueError("One moment: it is opening")
        _last[0] = time.monotonic()
    # In a scope of its own, so restarting the office (whose unit kills its whole cgroup) never closes your editor
    # or terminal, and it does not count against the office's memory cap.
    run = (["systemd-run", "--user", "--scope", "--collect", "--quiet", "--"] if which("systemd-run") else []) + argv
    try:
        popen(run, cwd=folder, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, umask=lanes.REPO_UMASK)
    except OSError as e:
        raise ValueError(f"Could not start {os.path.basename(argv[0])}: {e.strerror or e}") from None
    return {"ok": True, "opened": body.get("what"), "program": os.path.basename(argv[0])}

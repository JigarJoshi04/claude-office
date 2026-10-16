"""Office lanes: work the CEO hands out from the office, run headless on whichever seat the divider picks.

Each lane lives in ``~/.local/share/claude-office/lanes/<id>/`` with its brief, STATE (progress notes the
agent keeps, so it can resume on another seat), REPORT (written when done) and log. A lane runs as a transient
systemd user unit ``office-lane-<id>`` at low CPU priority with no display, so it survives the office server
restarting and never pops windows on the desktop. When a seat hits its usage limit mid-run, the runner marks
the seat as resting until its reset and resumes the lane on the next seat the divider picks.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import config, divider

LANE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
LIMIT_RE = re.compile(r"hit your .*limit|usage limit|limit reached|rate.?limit.*exceeded|session limit", re.I)
NET_RE = re.compile(r"EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Can't reach the API|stream disconnected", re.I)
RESET_RE = re.compile(r"resets\s+([^(\n·]+?)\s*(?:\(([^)]+)\))?\s*$", re.I | re.M)
MODELS = ("opus", "sonnet", "haiku", "fable")
PERMISSIONS = ("acceptEdits", "bypassPermissions", "default", "plan")


def lanes_dir() -> Path:
    return config.DATA_DIR / "lanes"


def lane_dir(lane_id: str) -> Path:
    if not LANE_ID.match(lane_id):
        raise ValueError("bad lane id")
    return lanes_dir() / lane_id


def unit_name(lane_id: str) -> str:
    return f"office-lane-{lane_id}"


def _slug(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:24].strip("-")
    return s or "lane"


def load_lane(lane_id: str) -> dict | None:
    try:
        return json.loads((lane_dir(lane_id) / "lane.json").read_text())
    except (OSError, ValueError):
        return None


def save_lane(lane: dict) -> None:
    d = lane_dir(lane["id"])
    tmp = d / "lane.json.tmp"
    tmp.write_text(json.dumps(lane, indent=2))
    tmp.replace(d / "lane.json")


def limits_path() -> Path:
    return config.STATE_DIR / "seat-limits.json"


@contextlib.contextmanager
def office_lock(name: str):
    """A cross-process lock, so two lane runners never pick the same free slot or lose a limit update."""
    config.STATE_DIR.mkdir(parents=True, exist_ok=True)
    with open(config.STATE_DIR / f"{name}.lock", "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def read_limits() -> dict:
    try:
        data = json.loads(limits_path().read_text())
        now = time.time()
        return {k: v for k, v in data.items() if isinstance(v, (int, float)) and v > now}
    except (OSError, ValueError):
        return {}


def mark_limited(seat_id: str, until: float) -> None:
    with office_lock("limits"):
        data = read_limits()
        data[seat_id] = max(until, data.get(seat_id, 0))
        tmp = limits_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(limits_path())


def parse_reset(text: str, now: float | None = None) -> float:
    """Epoch of 'resets 3am (Asia/Kolkata)' / 'resets 9:40pm' in a limit line; falls back to 30 minutes."""
    now = now or time.time()
    m = None
    for m in RESET_RE.finditer(text or ""):
        pass
    if m:
        when, tz = m.group(1).strip(), (m.group(2) or "").strip()
        env = dict(os.environ, TZ=tz) if tz else None
        try:
            out = subprocess.run(["date", "-d", when, "+%s"], capture_output=True, text=True, env=env, timeout=5)
            e = int(out.stdout.strip())
            if e <= now:
                e += 86400
            return e + 120
        except (ValueError, OSError, subprocess.SubprocessError):
            pass
    return now + 1800


def active_lane_units() -> set[str]:
    """Every running office-lane unit, in one systemctl call."""
    try:
        r = subprocess.run(["systemctl", "--user", "list-units", "office-lane-*", "--type=service", "--output=json",
                            "--no-pager"], capture_output=True, text=True, timeout=8)
        return {u["unit"].removesuffix(".service") for u in json.loads(r.stdout or "[]")
                if u.get("active") in ("active", "activating")}
    except (OSError, ValueError, subprocess.SubprocessError):
        return set()


def list_lanes() -> list[dict]:
    out = []
    d = lanes_dir()
    dirs = sorted(d.iterdir() if d.is_dir() else [], key=lambda p: p.stat().st_mtime, reverse=True)[:40]
    active = active_lane_units() if dirs else set()
    for p in dirs:
        lane = load_lane(p.name)
        if not lane:
            continue
        lane["report_status"] = _first_line(p / "REPORT.md")
        lane["state_tail"] = _tail(p / "STATE.md", 6)
        lane["unit_active"] = unit_name(lane["id"]) in active
        if not lane["unit_active"] and lane.get("status") in ("running", "starting", "waiting", "queued"):
            lane["status"] = "stopped"   # the unit died without the runner recording why
        out.append(lane)
    return out


def _first_line(path: Path) -> str | None:
    from .sessions import first_line
    return first_line(str(path))


def _tail(path: Path, n: int) -> str | None:
    from .sessions import tail_text
    return tail_text(str(path), n, 8192) or None


def unit_active(unit: str) -> bool:
    try:
        r = subprocess.run(["systemctl", "--user", "is-active", unit], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() in ("active", "activating")
    except (OSError, subprocess.SubprocessError):
        return False


# ------------------------------------------------------------------------------------------------ create

def create_lane(title: str, brief: str, workdir: str, seat: str, model: str, permission_mode: str,
                seat_ids: list[str], cfg: dict, launch: bool = True, allow_messages: bool = True,
                resume_session: str | None = None) -> dict:
    title = " ".join(str(title).split())[:80]
    if not title or not str(brief).strip():
        raise ValueError("A lane needs a title and a brief")
    workdir = os.path.realpath(os.path.expanduser(workdir or cfg["default_workdir"]))
    if not os.path.isdir(workdir):
        raise ValueError(f"Working directory does not exist: {workdir}")
    if seat != "auto" and seat not in seat_ids:
        raise ValueError(f"Unknown seat {seat}")
    if model not in MODELS:
        raise ValueError(f"Model must be one of {', '.join(MODELS)}")
    if permission_mode not in PERMISSIONS:
        raise ValueError(f"Permission mode must be one of {', '.join(PERMISSIONS)}")
    if resume_session is not None and not re.match(r"^[0-9a-f-]{36}$", resume_session):
        raise ValueError("A follow-up needs a session id")
    lane_id = f"{time.strftime('%m%d-%H%M%S')}-{_slug(title)}"
    if lane_dir(lane_id).exists():                       # two hires in the same second with the same title
        lane_id = f"{lane_id[:-4] if len(lane_id) > 40 else lane_id}-{os.urandom(2).hex()}"
    d = lane_dir(lane_id)
    d.mkdir(parents=True, exist_ok=False)
    d.chmod(0o700)   # briefs and logs can hold private details
    (d / "brief.md").write_text(str(brief).strip() + "\n")
    (d / "STATE.md").write_text("")
    lane = {
        "id": lane_id, "title": title, "workdir": workdir, "seat_pref": seat, "model": model,
        "permission_mode": permission_mode, "created_at": time.time(), "status": "queued",
        "seat": None, "runs": [], "unit": unit_name(lane_id), "allow_messages": bool(allow_messages),
        "resume_session": resume_session,
    }
    save_lane(lane)
    if launch:
        start_unit(lane_id)
    return load_lane(lane_id) or lane


def start_unit(lane_id: str) -> None:
    lane = load_lane(lane_id)
    if not lane:
        raise ValueError("No such lane")
    if unit_active(unit_name(lane_id)):
        raise ValueError("Lane is already running")
    env_path = os.environ.get("PATH", "/usr/bin:/bin")
    cmd = ["systemd-run", "--user", f"--unit={unit_name(lane_id)}", "--collect", "--quiet",
           "--nice=15", "-p", "CPUWeight=20",
           "--setenv=DISPLAY=", "--setenv=WAYLAND_DISPLAY=",
           f"--setenv=PATH={env_path}", f"--setenv=HOME={config.HOME}",
           f"--setenv=PYTHONPATH={config.REPO_DIR}",
           # The runner starts in the office's own folder: `python -m` imports from the current directory first,
           # so starting in the lane's workdir would run any `office/` package found there. The agent itself still
           # works in the lane's workdir (see _command).
           f"--working-directory={config.REPO_DIR}",
           sys.executable, "-m", "office", "run-lane", lane_id]
    for var in ("CLAUDE_OFFICE_HOME", "CLAUDE_OFFICE_CONFIG", "CLAUDE_OFFICE_STATE", "CLAUDE_OFFICE_DATA"):
        if os.environ.get(var):
            cmd.insert(-5, f"--setenv={var}={os.environ[var]}")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        lane["status"] = "failed"
        lane["error"] = (r.stderr or r.stdout).strip()[:300]
        save_lane(lane)
        raise RuntimeError(f"systemd-run failed: {lane['error']}")
    lane["status"] = "starting"
    lane.pop("stop_requested", None)
    save_lane(lane)


def stop_lane(lane_id: str) -> dict:
    lane = load_lane(lane_id)
    if not lane:
        raise ValueError("No such lane")
    lane["stop_requested"] = time.time()
    save_lane(lane)
    subprocess.run(["systemctl", "--user", "stop", unit_name(lane_id)], capture_output=True, timeout=30)
    lane = load_lane(lane_id) or lane
    if lane.get("status") not in ("done", "blocked", "failed"):
        lane["status"] = "stopped"
    save_lane(lane)
    return lane


def resume_lane(lane_id: str, seat: str | None, seat_ids: list[str]) -> dict:
    lane = load_lane(lane_id)
    if not lane:
        raise ValueError("No such lane")
    if seat:
        if seat != "auto" and seat not in seat_ids:
            raise ValueError(f"Unknown seat {seat}")
        lane["seat_pref"] = seat
    lane["fails"] = 0
    save_lane(lane)
    start_unit(lane_id)
    return load_lane(lane_id) or lane


# --------------------------------------------------------------------------------------------- the runner

def build_prompt(lane: dict, seat_id: str, cfg: dict) -> str:
    d = lane_dir(lane["id"])
    pre = cfg["lane_defaults"].get("preamble") or ""
    return (
        f'You are an office lane named "{lane["title"]}" (lane id {lane["id"]}), working headless on the '
        f"seat {seat_id} in Claude Office. Nobody is watching this terminal; do not ask questions, decide. "
        f"Do not end your turn while a background task or workflow you still need is running.\n"
        f"Working directory: {lane['workdir']}\n"
        f"STATE file: {d / 'STATE.md'} - read it FIRST. If it has content you are RESUMING after a restart or a "
        f"seat switch: continue from it and do not redo finished steps. After every meaningful step append one "
        f"dated line to it: what you did and what is next.\n"
        f"REPORT file: {d / 'REPORT.md'} - write it only when finished. First line exactly "
        f"`STATUS: DONE - <one line>` or `STATUS: BLOCKED - <reason>`, then a short summary of what changed "
        f"and how you verified it.\n{pre}\n\nTHE BRIEF:\n{(d / 'brief.md').read_text()}"
    )


def _log(lane_id: str, text: str) -> None:
    with open(lane_dir(lane_id) / "lane.log", "a") as f:
        f.write(f"=== {time.strftime('%Y-%m-%dT%H:%M:%S%z')} {text}\n")


def _log_tail(lane_id: str, n: int = 6) -> str:
    try:
        with open(lane_dir(lane_id) / "lane.log", "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 4096))
            return "\n".join(f.read().decode(errors="replace").splitlines()[-n:])
    except OSError:
        return ""


def _choose_seat(lane: dict, exclude: tuple = ()) -> tuple[str | None, str, float | None]:
    from .snapshot import quick_seats
    seats = quick_seats()
    ids = [s["id"] for s in seats]
    cfg = divider.load(ids)
    if lane["seat_pref"] != "auto":
        # A pinned lane overrides the split and caps (the CEO chose), but not a dead login or a spent plan.
        pinned = next((s for s in seats if s["id"] == lane["seat_pref"]), None)
        if not pinned:
            return None, f"{lane['seat_pref']} is not a seat any more", None
        if (pinned.get("health") or {}).get("state") == "login":
            return None, f"{lane['seat_pref']} needs /login", time.time() + 600
        lu = read_limits().get(lane["seat_pref"], 0)
        if lu > time.time():
            return None, f"{lane['seat_pref']} is resting until {time.strftime('%H:%M', time.localtime(lu))}", lu
        for key in ("five_hour", "weekly"):
            w = (pinned.get("usage") or {}).get(key) or {}
            if (w.get("pct") or 0) >= 100:
                return None, f"{lane['seat_pref']} has used all of its {key.replace('_', '-')} plan", w.get("resets_at")
        return lane["seat_pref"], "pinned by the CEO", None
    ev = divider.evaluate(seats, cfg, exclude=exclude, limited_until=read_limits())
    return ev["pick"], ev["why"], ev.get("next_reset")


def _command(lane: dict, seat: dict, prompt: str, d: Path, cfg: dict) -> tuple[list[str], dict]:
    if seat["kind"] == "codex":
        gpt = shutil.which("gpt") or str(config.HOME / ".local" / "bin" / "gpt")
        cmd = [gpt, "-w", "-C", lane["workdir"], "--add-dir", str(d), prompt]
        env = dict(os.environ)
    else:
        ld = cfg["lane_defaults"]
        if lane.get("resume_session"):
            # A follow-up: continue that session's own conversation with the CEO's message.
            prompt = "Message from the CEO, sent from Claude Office:\n\n" + (d / "brief.md").read_text()
            cmd = ["claude", "--resume", lane["resume_session"], "-p", prompt, "--permission-mode", lane["permission_mode"],
                   "--allowedTools", ld["allowed_tools"]]
        else:
            cmd = ["claude", "-p", prompt, "--model", lane["model"], "--permission-mode", lane["permission_mode"],
                   "--allowedTools", ld["allowed_tools"], "--add-dir", str(d)]
        if lane.get("allow_messages", True):
            # The CEO chose to be able to message this lane from the office: deliver instead of holding.
            cmd += ["--settings", json.dumps({"crossSessionInbound": "accept"})]
        for extra in ld.get("add_dirs") or []:
            cmd += ["--add-dir", os.path.expanduser(extra)]
        # Headless runs stop their background tasks 10 minutes after the last turn unless told not to.
        env = dict(os.environ, CLAUDE_CONFIG_DIR=seat["config_dir"], CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS="0")
        if seat["id"] == "claude":   # the main account keeps its .claude.json in $HOME, so it runs without the variable
            env.pop("CLAUDE_CONFIG_DIR")
    env.pop("DISPLAY", None)
    env.pop("WAYLAND_DISPLAY", None)
    return cmd, env


def _wait_until_seated(seat: dict, proc, timeout: float = 30.0) -> str | None:
    """Block until the new agent shows up as a live session on its seat (or exits, or the timeout passes).
    Returns its Claude session id when it can be read, so the CEO can follow up on it later."""
    t0 = time.time()
    sdir = Path(seat["config_dir"]) / "sessions"
    while time.time() - t0 < timeout and proc.poll() is None:
        if seat["kind"] == "codex":
            if time.time() - t0 > 8:
                return None
        else:
            try:
                mine = sdir / f"{proc.pid}.json"
                if mine.exists():
                    return json.loads(mine.read_text()).get("sessionId")
                if any(f.stat().st_mtime >= t0 - 1 for f in sdir.glob("*.json")) and time.time() - t0 > 12:
                    return None
            except (OSError, ValueError):
                pass
        time.sleep(1)
    return None


def run_lane(lane_id: str) -> int:
    """Supervise one lane until it reports, gets stopped, or fails three times."""
    cfg = config.load_config()
    lane = load_lane(lane_id)
    if not lane:
        print(f"no such lane {lane_id}", file=sys.stderr)
        return 2
    d = lane_dir(lane_id)
    fails = lane.get("fails", 0)
    while True:
        lane = load_lane(lane_id) or lane
        if (d / "REPORT.md").exists() and (d / "REPORT.md").stat().st_size:
            status_line = _first_line(d / "REPORT.md") or ""
            lane["status"] = "blocked" if "BLOCKED" in status_line.upper() else "done"
            lane["finished_at"] = time.time()
            save_lane(lane)
            _log(lane_id, f"report written: {status_line}")
            return 0
        # Choosing a seat and starting the agent happen under one lock, and the lock is held until the new
        # session shows up on that seat, so two runners never both take the last free slot.
        proc, log, seat_id = None, None, None
        with office_lock("launch"):
            seat_id, why, wake = _choose_seat(lane)
            seat = None
            if seat_id:
                seats = {s["id"]: s for s in config.discover_claude_seats(cfg)}
                codex = config.codex_seat_meta(cfg)
                if codex:
                    seats[codex["id"]] = codex
                seat = seats.get(seat_id)
            if seat:
                prompt = build_prompt(lane, seat_id, cfg)
                lane.update(status="running", seat=seat_id, waiting_reason=None, last_pick_reason=why)
                lane["runs"].append({"seat": seat_id, "started_at": time.time(), "why": why})
                save_lane(lane)
                _log(lane_id, f"start on {seat_id} ({why})")
                cmd, env = _command(lane, seat, prompt, d, cfg)
                log = open(d / "lane.log", "ab")
                try:
                    proc = subprocess.Popen(cmd, cwd=lane["workdir"], env=env, stdin=subprocess.DEVNULL,
                                            stdout=subprocess.PIPE if seat["kind"] == "codex" or lane.get("resume_session") else log,
                                            stderr=log)
                    lane["pid"] = proc.pid
                    save_lane(lane)
                    sid = _wait_until_seated(seat, proc)
                    if sid:
                        lane["runs"][-1]["session_id"] = sid
                        lane["last_session_id"] = sid
                        save_lane(lane)
                except OSError as e:
                    _log(lane_id, f"could not start: {e}")
        if not seat_id:
            lane["status"] = "waiting"
            lane["waiting_reason"] = why
            save_lane(lane)
            _log(lane_id, f"waiting for a seat: {why}")
            delay = max(60, min(1800, (wake or time.time() + 600) - time.time() + 60))
            time.sleep(delay)
            continue
        if not seat:
            _log(lane_id, f"seat {seat_id} vanished")
            time.sleep(60)
            continue
        try:
            if proc is None:
                raise OSError("the agent did not start")
            out, _ = proc.communicate()
            rc = proc.returncode
        except OSError as e:
            rc, out = 127, None
            _log(lane_id, f"could not start: {e}")
        finally:
            if log:
                log.close()
        if out:
            with open(d / "lane.log", "ab") as f:
                f.write(out)
            if not (d / "REPORT.md").exists() and rc == 0:
                head = b"STATUS: DONE - replied\n\n" if lane.get("resume_session") else b"STATUS: DONE - see summary\n\n"
                (d / "REPORT.md").write_bytes(head + out)
        lane = load_lane(lane_id) or lane
        lane["runs"][-1].update(ended_at=time.time(), rc=rc)
        lane["pid"] = None
        save_lane(lane)
        _log(lane_id, f"exit rc={rc} on {seat_id}")
        tail = _log_tail(lane_id)
        if (d / "REPORT.md").exists() and (d / "REPORT.md").stat().st_size:
            continue  # top of loop records done/blocked
        if LIMIT_RE.search(tail):
            until = parse_reset(tail)
            mark_limited(seat_id, until)
            lane["runs"][-1]["ended_by"] = "limit"
            save_lane(lane)
            _log(lane_id, f"{seat_id} hit its limit; resting until {time.strftime('%H:%M', time.localtime(until))}")
            fails = 0
            continue
        if NET_RE.search(tail):
            _log(lane_id, "network trouble; retrying in 2 minutes (not counted as a failure)")
            time.sleep(120)
            continue
        if rc == 0:
            lane["status"] = "finished"
            lane["finished_at"] = time.time()
            save_lane(lane)
            _log(lane_id, "exited cleanly without a report")
            return 0
        fails += 1
        lane["fails"] = fails
        save_lane(lane)
        if fails >= 3:
            lane["status"] = "failed"
            save_lane(lane)
            _log(lane_id, "three failures in a row; giving up")
            return rc or 1
        time.sleep(90)

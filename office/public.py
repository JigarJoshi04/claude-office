"""The public view of the office: what a status page, a screen on another machine or a metrics scraper may see.

It is built from an allow-list, so nothing private slips in when the snapshot grows: the names the page shows,
states, plan percentages, levels and counts. Never titles, tasks, prompts, activity, folders, sockets, accounts or
commands. Served at GET /api/public, printed by `claude-office status --json`, written to the beacon file when
config "beacon": {"path": ...} is set, and the source of GET /metrics.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
from pathlib import Path

from .live import public

SCHEMA = 1
OFFICE_STEP = 400                                   # web/engine/unlocks.js: office level n needs 400 · (n − 1)² XP


def office_level(seats: list[dict]) -> int:
    xp = sum(((s.get("career") or {}).get("xp") or 0) for s in seats)
    return int(math.floor(math.sqrt(max(0, xp) / OFFICE_STEP))) + 1


def _window(w) -> dict | None:
    if not isinstance(w, dict) or w.get("pct") is None:
        return None
    return {"used_pct": w.get("pct"), "resets_at": w.get("resets_at")}


def view(snap: dict) -> dict:
    seats = []
    for s in snap.get("seats", []):
        u, c = s.get("usage") or {}, s.get("career") or {}
        live = [x for x in s.get("sessions", []) if x.get("live", True)]
        seats.append({
            "id": s["id"], "name": s.get("nickname") or s.get("label") or s["id"], "kind": s.get("kind"), "status": s.get("status"),
            "level": c.get("level"), "xp": c.get("xp"),
            "five_hour": _window(u.get("five_hour")), "weekly": _window(u.get("weekly")),
            "sessions": len(live), "working": sum(1 for x in live if x.get("state") == "working"),
            "stuck": sum(1 for x in live if x.get("state") == "stuck"), "lanes": sum(1 for x in live if x.get("kind") == "lane"),
            "tokens_1h": s.get("tokens_1h"),
        })
    t, o = snap.get("totals") or {}, snap.get("office") or {}
    lanes: dict[str, int] = {}
    for l in snap.get("lanes") or []:                  # the ones still to finish (the snapshot keeps all of them)
        if l.get("status") in ("scheduled", "queued", "starting", "running", "waiting", "interrupted"):
            lanes[str(l["status"])] = lanes.get(str(l["status"]), 0) + 1
    return public({
        "schema": SCHEMA, "at": snap.get("now"), "version": o.get("version"),
        "office": {"name": o.get("name"), "level": office_level(snap.get("seats", []))},
        "seats": seats,
        "totals": {"sessions": t.get("sessions"), "working": t.get("working"), "lanes": t.get("lanes"), "tokens_1h": t.get("tokens_1h"),
                   "needs_you": len(snap.get("attention") or []), "problems": len(o.get("faults") or [])},
        "lanes": lanes,
    })


def write_beacon(snap: dict, path: str) -> Path:
    """The public view as a file other programs read (a web server, a wall screen): written whole each time, and
    readable by others (0644), since that is what it is for. Readers should check "at" for its age."""
    dest = Path(os.path.expanduser(path))
    if not dest.parent.is_dir():
        dest.parent.mkdir(parents=True)
        os.chmod(dest.parent, 0o755)                     # readable by the programs it is for (the office's umask is 077)
    fd, tmp = tempfile.mkstemp(prefix=".beacon-", dir=dest.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(view(snap), f)
        os.chmod(tmp, 0o644)
        os.replace(tmp, dest)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return dest


# -- GET /metrics: the Prometheus text format ----------------------------------------------------------------------
def _label(v) -> str:
    return str(v).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def metrics(snap: dict, perf: dict | None = None) -> str:
    """The public view as Prometheus/OpenMetrics gauges, labelled by seat id only (a few series per seat)."""
    v, out = view(snap), []

    def gauge(name: str, help_: str, rows: list[tuple[dict, float | int | None]]):
        rows = [(labels, val) for labels, val in rows if isinstance(val, (int, float)) and not isinstance(val, bool)]
        if not rows:
            return
        out.append(f"# HELP claude_office_{name} {help_}")
        out.append(f"# TYPE claude_office_{name} gauge")
        for labels, val in rows:
            lab = ",".join(f'{k}="{_label(x)}"' for k, x in labels.items())
            out.append(f"claude_office_{name}{{{lab}}} {val}" if lab else f"claude_office_{name} {val}")

    seats = v["seats"]
    gauge("plan_used_percent", "Plan used in the window, per seat.",
          [({"seat": s["id"], "window": w}, (s[w] or {}).get("used_pct")) for s in seats for w in ("five_hour", "weekly")])
    gauge("plan_resets_at_seconds", "When the window resets (Unix time).",
          [({"seat": s["id"], "window": w}, (s[w] or {}).get("resets_at")) for s in seats for w in ("five_hour", "weekly")])
    gauge("sessions", "Live sessions per seat and state.",
          [({"seat": s["id"], "state": st}, s[st]) for s in seats for st in ("working", "stuck")]
          + [({"seat": s["id"], "state": "all"}, s["sessions"]) for s in seats])
    gauge("seat_lanes", "Office lanes running on the seat.", [({"seat": s["id"]}, s["lanes"]) for s in seats])
    gauge("tokens_last_hour", "Tokens in the last hour, per seat.", [({"seat": s["id"]}, s["tokens_1h"]) for s in seats])
    gauge("career_xp", "The character's XP.", [({"seat": s["id"]}, s["xp"]) for s in seats])
    gauge("career_level", "The character's level.", [({"seat": s["id"]}, s["level"]) for s in seats])
    gauge("lanes", "Office lanes by status.", [({"status": k}, n) for k, n in sorted(v["lanes"].items())])
    gauge("office_level", "The office level (everyone's XP).", [({}, v["office"]["level"])])
    gauge("needs_you", "Items in Needs you.", [({}, v["totals"]["needs_you"])])
    gauge("problems", "Parts of the office that keep failing.", [({}, v["totals"]["problems"])])
    if v.get("at"):
        import time
        gauge("snapshot_age_seconds", "How old the office's picture is.", [({}, round(time.time() - v["at"], 1))])
    if perf and perf.get("builds"):
        gauge("refresh_seconds", "What a refresh costs.", [({"quantile": "0.5"}, perf["p50_ms"] / 1000), ({"quantile": "0.95"}, perf["p95_ms"] / 1000)])
    return "\n".join(out) + "\n"

"""Pre-limit save: shortly before a seat runs out of its 5-hour window or its week, at the pace it is going, the office
asks each lane working on it to write its STATE notes, so the seat that picks the lane up next loses nothing. Off until
turned on in Settings. Only lanes that take the office's messages directly are asked (a terminal session would hold
the message for approval), each once per window, and the office says so in the news.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from . import config

DEFAULTS = {"prelimit_save": False, "lead_min": 10}
LEADS = (5, 10, 20, 30)
FULL = {"five_hour": 95, "weekly": 98}              # this full, it is about to run out whatever the pace says
WINDOW = {"five_hour": "5-hour window", "weekly": "week"}
TEXT = ("A note from Claude Office: {seat} is about to run out of its {window} ({when}). Write your STATE notes now: "
        "what is done, what is in progress, and the exact next step, so the next seat can pick this up without redoing "
        "anything. Then carry on with the work.")


def settings(cfg: dict) -> dict:
    a = cfg.get("automation") if isinstance(cfg.get("automation"), dict) else {}
    out = dict(DEFAULTS)
    if isinstance(a.get("prelimit_save"), bool):
        out["prelimit_save"] = a["prelimit_save"]
    if a.get("lead_min") in LEADS and not isinstance(a.get("lead_min"), bool):
        out["lead_min"] = a["lead_min"]
    return out


def validate(v) -> dict:
    """The `automation` block from the Settings page, checked."""
    if not isinstance(v, dict) or set(v) - set(DEFAULTS):
        raise ValueError("automation must be an object with prelimit_save and lead_min")
    out = {}
    if "prelimit_save" in v:
        if type(v["prelimit_save"]) is not bool:
            raise ValueError("automation.prelimit_save must be true or false")
        out["prelimit_save"] = v["prelimit_save"]
    if "lead_min" in v:
        if type(v["lead_min"]) is not int or v["lead_min"] not in LEADS:
            raise ValueError(f"automation.lead_min must be one of {', '.join(map(str, LEADS))}")
        out["lead_min"] = v["lead_min"]
    return out


def due(seat: dict, now: float, lead_s: float) -> dict | None:
    """{"key", "window", "when", "id"} when a seat is about to run out of a window, or None."""
    usage, fc = seat.get("usage") or {}, seat.get("forecast") or {}
    for key in ("five_hour", "weekly"):
        w, f = usage.get(key) or {}, fc.get(key) or {}
        pct = w.get("pct")
        if pct is None or pct >= 100:
            continue
        out_at = f.get("out_at") if f.get("state") == "runs_out" else None
        if (out_at and out_at - now <= lead_s) or pct >= FULL[key]:
            mins = max(1, round((out_at - now) / 60)) if out_at and out_at > now else None
            when = f"about {mins} min left at this pace" if mins else f"{pct:.0f}% used"
            return {"key": key, "window": WINDOW[key], "when": when, "id": f"{key}:{round(w.get('resets_at') or 0)}"}
    return None


class PreLimit:
    """Which lanes were asked in which window (state/prelimit.json), so each is asked once."""

    def __init__(self, path: Path | None):
        self.path, self.lock = path, threading.Lock()
        d = config.read_state(path) if path else None
        self.sent: dict[str, float] = {k: v for k, v in d.items() if isinstance(v, (int, float))} if isinstance(d, dict) else {}

    def run(self, seats: list[dict], cfg: dict, now: float, send) -> list[tuple[str, str, list[str]]]:
        """Ask the lanes on seats about to run out; send(seat, session, text) delivers one message (raising on
        failure). Returns [(seat id, window, [lane names])] for the news."""
        s = settings(cfg)
        if not s["prelimit_save"]:
            return []
        out, changed = [], False
        for seat in seats:
            if seat.get("kind") != "claude" or seat.get("status") in ("limited", "offline"):
                continue
            d = due(seat, now, s["lead_min"] * 60)
            if not d:
                continue
            asked = []
            for x in seat.get("sessions", []):
                k = f"{x.get('id')}|{d['id']}"
                if not x.get("live", True) or x.get("talk") != "direct" or k in self.sent:
                    continue
                text = TEXT.format(seat=seat.get("nickname") or seat.get("label") or seat["id"], window=d["window"], when=d["when"])
                try:
                    send(seat, x, text)
                except Exception:                       # not delivered: try again on the next look
                    continue
                with self.lock:
                    self.sent[k] = now
                changed = True
                asked.append(x.get("name") or "a lane")
            if asked:
                out.append((seat["id"], d["window"], asked))
        if changed:
            self._save(now)
        return out

    def _save(self, now: float) -> None:
        with self.lock:
            self.sent = {k: v for k, v in self.sent.items() if now - v < 8 * 86400}
            if not self.path:
                return
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(self.sent, separators=(",", ":")))
                os.replace(tmp, self.path)
            except OSError:
                pass

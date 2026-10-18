"""Validated public preferences; preserve private config when saving."""
import json
import os
import re
import shutil
import tempfile
import threading

from . import config, prices
from .live import public

VOICE_DEFAULTS = {"enabled": False, "events": ["report", "limit", "login", "lane"], "quiet_hours": [23, 8]}
VOICE_EVENTS = {"report", "limit", "login", "lane", "usage", "stuck"}
# A seat's personality (its voice and room style); the names match web/ui/personas.js ARCHETYPES.
STYLES = {"The Orchestrator", "The Builder", "The Investigator", "The Perfectionist", "The Night Owl", "The Speedrunner", "The Contractor"}
_LOCK = threading.Lock()


def view(cfg, seats):
    return public({"office_name": cfg.get("office_name", "Claude Office"),
                   "ceo_name": cfg.get("ceo", {}).get("name", "CEO"),
                   "seats": {s["id"]: {**{k: s.get(k) for k in ("label", "nickname", "color", "role", "motto", "style", "plan_usd")},
                                       "plan_default": prices.plan_usd({"health": s.get("health")})} for s in seats},
                   "voice": {k: cfg.get("voice", {}).get(k, v) for k, v in VOICE_DEFAULTS.items()},
                   "voice_available": shutil.which("jarvis-say") is not None})


def validate(body):
    if not isinstance(body, dict):
        raise ValueError("Expected settings object")
    out = {}

    def name(value, key, maximum=40, empty=False):
        if value is None and empty:
            return None
        if not isinstance(value, str) or not (0 if empty else 1) <= len(value.strip()) <= maximum:
            raise ValueError(f"{key} must be {'0' if empty else '1'}–{maximum} characters")
        return value.strip() or None

    for key in ("office_name", "ceo_name"):
        if key in body:
            value = name(body[key], key)
            if key == "ceo_name":
                out["ceo"] = {"name": value}
            else:
                out[key] = value
    if "seats" in body:
        if not isinstance(body["seats"], dict):
            raise ValueError("seats must be an object")
        out["seats"] = {}
        for sid, entry in body["seats"].items():
            if not isinstance(sid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", sid):
                raise ValueError("Invalid seat id")
            if not isinstance(entry, dict):
                raise ValueError("seat settings must be an object")
            dest = out["seats"][sid] = {}
            for key, maximum, optional in (("label", 40, False), ("nickname", 24, True), ("role", 40, True), ("motto", 90, True)):
                if key in entry:
                    dest[key] = name(entry[key], key, maximum, optional)
            if "style" in entry:
                if entry["style"] is not None and (not isinstance(entry["style"], str) or entry["style"] not in STYLES):
                    raise ValueError("style must be one of the personalities")
                dest["style"] = entry["style"]
            if "plan_usd" in entry:                       # what the seat's plan costs a month; None goes back to its tier's price
                v = entry["plan_usd"]
                if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 10000):
                    raise ValueError("plan_usd must be a number from 0 to 10000")
                dest["plan_usd"] = v
            if "color" in entry:
                if not isinstance(entry["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", entry["color"]):
                    raise ValueError("color must be #RRGGBB")
                dest["color"] = entry["color"]
    if "voice" in body:
        v = body["voice"]
        if not isinstance(v, dict):
            raise ValueError("voice must be an object")
        dest = out["voice"] = {}
        if "enabled" in v:
            if type(v["enabled"]) is not bool:
                raise ValueError("voice.enabled must be a boolean")
            dest["enabled"] = v["enabled"]
        if "events" in v:
            if not isinstance(v["events"], list) or any(not isinstance(x, str) or x not in VOICE_EVENTS for x in v["events"]):
                raise ValueError("Invalid voice events")
            dest["events"] = list(dict.fromkeys(v["events"]))
        if "quiet_hours" in v:
            q = v["quiet_hours"]
            if not isinstance(q, list) or len(q) != 2 or any(type(x) is not int or not 0 <= x <= 23 for x in q):
                raise ValueError("quiet_hours must be two hours from 0 to 23")
            dest["quiet_hours"] = q
    return out


def save(body):
    update = validate(body)
    with _LOCK:
        path = config.CONFIG_DIR / "config.json"
        try:
            original = json.loads(path.read_text())
        except FileNotFoundError:
            original = {}
        if not isinstance(original, dict):
            raise ValueError("Existing config must be an object")
        merged = config._merge(original, update)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".config-", dir=path.parent)
        try:
            with os.fdopen(fd, "w") as f:
                os.fchmod(f.fileno(), 0o600)
                json.dump(merged, f, separators=(",", ":"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return merged

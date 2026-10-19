"""Validated public preferences; preserve private config when saving."""
import json
import os
import re
import shutil
import tempfile
import threading

from . import config, prices
from .live import public

VOICE_DEFAULTS = {"enabled": False, "events": ["report", "limit", "login", "lane", "risk"], "quiet_hours": [23, 8]}
VOICE_EVENTS = {"report", "limit", "login", "lane", "usage", "stuck", "risk"}
# A seat's personality (its voice and room style); the names match web/ui/personas.js ARCHETYPES.
STYLES = {"The Orchestrator", "The Builder", "The Investigator", "The Perfectionist", "The Night Owl", "The Speedrunner", "The Contractor"}
_LOCK = threading.Lock()


def view(cfg, seats):
    return public({"office_name": cfg.get("office_name", "Claude Office"),
                   "ceo_name": cfg.get("ceo", {}).get("name", "CEO"),
                   "ceo_look": cfg.get("ceo", {}).get("look"),
                   "seats": {s["id"]: {**{k: s.get(k) for k in ("label", "nickname", "color", "role", "motto", "style", "plan_usd", "look")},
                                       "plan_default": prices.plan_usd({"health": s.get("health")})} for s in seats},
                   "voice": {k: cfg.get("voice", {}).get(k, v) for k, v in VOICE_DEFAULTS.items()},
                   "risk_watch": {"mute": risk_mute(cfg), "rules": risk_rules()},
                   "ai": ai_settings(cfg),
                   "automation": automation(cfg),
                   "budgets": cfg.get("budgets") or [],
                   "voice_available": shutil.which("jarvis-say") is not None})


def risk_rules():
    from .risk import RULES                  # (risk.py imports sessions, which this module need not load early)
    return RULES


def automation(cfg):
    from .prelimit import settings as pre
    return pre(cfg)


def ai_settings(cfg):
    from .brain import settings as ai
    return ai(cfg)


def risk_mute(cfg):
    from .risk import mute_list
    return mute_list(cfg)


def look(value):
    """A character creator's choice: {"skin": 0-5, "hair": 0-8, "style": 0-5, "glasses": bool}, or None for the default."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {"skin", "hair", "style", "glasses"}:
        raise ValueError("look must be an object with skin, hair, style and glasses")
    for key, top in (("skin", 5), ("hair", 8), ("style", 5)):
        v = value.get(key)
        if v is not None and (type(v) is not int or not 0 <= v <= top):
            raise ValueError(f"look.{key} must be a number from 0 to {top}")
    if value.get("glasses") is not None and type(value["glasses"]) is not bool:
        raise ValueError("look.glasses must be true or false")
    return {k: v for k, v in value.items() if v is not None}


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
            if "look" in entry:
                dest["look"] = look(entry["look"])
            if "plan_usd" in entry:                       # what the seat's plan costs a month; None goes back to its tier's price
                v = entry["plan_usd"]
                if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 10000):
                    raise ValueError("plan_usd must be a number from 0 to 10000")
                dest["plan_usd"] = v
            if "color" in entry:
                if not isinstance(entry["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", entry["color"]):
                    raise ValueError("color must be #RRGGBB")
                dest["color"] = entry["color"]
    if "budgets" in body:                             # ceilings on API value or fresh tokens (budgets.py)
        from .budgets import validate as budget_validate
        out["budgets"] = budget_validate(body["budgets"])
    if "ceo_look" in body:
        out.setdefault("ceo", {})["look"] = look(body["ceo_look"])
    if "ai" in body:                                  # the opt-in analyst (brain.py)
        from .brain import validate as ai_validate
        out["ai"] = ai_validate(body["ai"])
    if "automation" in body:                          # what the office does on its own (prelimit.py)
        from .prelimit import validate as pre_validate
        out["automation"] = pre_validate(body["automation"])
    if "risk_watch" in body:                          # rules of the risky-action watch muted in this office
        rw = body["risk_watch"]
        mute = rw.get("mute") if isinstance(rw, dict) else None
        if not isinstance(mute, list) or any(not isinstance(x, str) or x not in risk_rules() for x in mute):
            raise ValueError("risk_watch.mute must list rule ids")
        out["risk_watch"] = {"mute": sorted(set(mute))}
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

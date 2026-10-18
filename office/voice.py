"""Short optional Jarvis announcements with an injected clock for deterministic tests."""
import re
import shutil
import subprocess
import threading
import time

from .settings import VOICE_DEFAULTS


def phrase(event):
    # Only a simple seat label is spoken; arbitrary event text may contain paths or IDs.
    seat = event.get("seat") or "A seat"
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9 -]{0,23}", seat) or re.search(r"\d{5}", seat):
        seat = "A seat"
    kind = event.get("kind")
    return {
        "report": f"{seat} filed a report.",
        "limit": f"{seat} hit its usage limit.",
        "login": f"{seat} needs to log in.",
        "lane": "An office lane has good news." if event.get("level") == "good" else "An office lane needs attention.",
        "usage": f"{seat} is nearly out of usage.",
        "stuck": f"{seat} has a session that needs attention.",
        "risk": f"{seat} has a session that did something risky.",
    }.get(kind)


class Announcer:
    def __init__(self, clock=time.time, localtime=time.localtime, popen=subprocess.Popen, which=shutil.which):
        self.clock, self.localtime, self.popen, self.which = clock, localtime, popen, which
        self.last = float("-inf")
        self.lock = threading.Lock()

    def announce(self, event, cfg, demo=False):
        v = dict(VOICE_DEFAULTS, **cfg.get("voice", {}))
        kind = event.get("kind")
        if demo or not v["enabled"] or kind not in v["events"]:
            return
        if kind == "lane" and event.get("level") not in ("good", "bad"):
            return
        if kind == "usage" and event.get("level") != "bad":
            return
        text = phrase(event)
        if not text:
            return
        with self.lock:
            now = self.clock()
            start, end = v["quiet_hours"]
            hour = self.localtime(now).tm_hour
            quiet = start <= hour < end if start <= end else hour >= start or hour < end
            if quiet or now - self.last < 20:
                return
            exe = self.which("jarvis-say")
            if not exe:
                return
            try:
                self.popen([exe, text], start_new_session=True, stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.last = now
            except OSError:
                pass

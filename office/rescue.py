"""The stuck rescuer: a session that has gone quiet in the background (stuck) or keeps making the same call (a loop)
gets a ladder in Needs you. First a nudge, a standard message that says what the office sees and what to do about
it; if it is still stuck ten minutes after, an office lane is restarted from its STATE notes. The CEO clicks each step.
"""
from __future__ import annotations

AGAIN_S = 600                       # still stuck this long after a nudge: the next step is a restart


def needs_rescue(x: dict) -> bool:
    """Stuck, or making the same call 8 times in a row while it is live and working: the one rule for Needs you, the
    nudge and a group message to the stuck ones."""
    if not x.get("live", True):
        return False
    return x.get("state") == "stuck" or (((x.get("loop") or {}).get("count") or 0) >= 8 and x.get("state") in ("working", "waiting"))


def nudge_text(x: dict) -> str:
    lp = x.get("loop") or {}
    if x.get("state") != "stuck" and lp.get("count"):
        return ("A note from Claude Office: you have made the same call {n} times in a row ({what}). If it is not getting "
                "anywhere, stop, write what you tried in your STATE notes and try a different approach, or report BLOCKED "
                "with the reason.").format(n=lp["count"], what=str(lp.get("text") or "")[:80])
    mins = max(1, int((x.get("quiet_s") or 0) // 60))
    return (f"A note from Claude Office: this session has been quiet for {mins} minute{'' if mins == 1 else 's'}. If you are waiting on something "
            "that is not coming, write your STATE notes, then either carry on with the next step or report BLOCKED with "
            "the reason.")

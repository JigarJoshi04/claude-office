"""The office analyst: small structured questions to Claude on one of your seats (Haiku by default), for features that
need reading rather than counting, such as "did that session run its tests?".

Off until turned on in Settings. Every call has a daily token budget, a cache, and a log of exactly what was sent
(state/ai/). It runs `claude -p` with every customisation off (--safe-mode: no CLAUDE.md, hooks, MCP or skills), no
tools and no saved session, so it can only answer, never act; it is marked CLAUDE_OFFICE_BRAIN=1 so the floor never
shows it as a lane. Questions about a session's transcript go to that session's own seat, so one account's
conversation is never sent through another.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

from . import config, egress
from .sessions import redact

DEFAULTS = {"enabled": False, "model": "haiku", "daily_tokens": 300_000, "allow_transcripts": False}
MODELS = ("haiku", "sonnet")
MAX_PROMPT = 120_000            # characters sent in one call
CACHE_S = 86400
GUARD_5H = 85                   # never on a seat past this much of its 5-hour window


class Unavailable(ValueError):
    """The analyst cannot answer right now (off, over budget, no seat): said to the CEO as it is."""


def settings(cfg: dict) -> dict:
    a = cfg.get("ai") if isinstance(cfg.get("ai"), dict) else {}
    out = dict(DEFAULTS)
    if isinstance(a.get("enabled"), bool):
        out["enabled"] = a["enabled"]
    if a.get("model") in MODELS:
        out["model"] = a["model"]
    if isinstance(a.get("daily_tokens"), int) and not isinstance(a.get("daily_tokens"), bool) and 10_000 <= a["daily_tokens"] <= 10_000_000:
        out["daily_tokens"] = a["daily_tokens"]
    if isinstance(a.get("allow_transcripts"), bool):
        out["allow_transcripts"] = a["allow_transcripts"]
    return out


def validate(v) -> dict:
    """The `ai` block from the Settings page, checked."""
    if not isinstance(v, dict) or set(v) - set(DEFAULTS):
        raise ValueError("ai must be an object with enabled, model, daily_tokens and allow_transcripts")
    out = {}
    for k in ("enabled", "allow_transcripts"):
        if k in v:
            if type(v[k]) is not bool:
                raise ValueError(f"ai.{k} must be true or false")
            out[k] = v[k]
    if "model" in v:
        if v["model"] not in MODELS:
            raise ValueError("ai.model must be haiku or sonnet")
        out["model"] = v["model"]
    if "daily_tokens" in v:
        n = v["daily_tokens"]
        if type(n) is not int or not 10_000 <= n <= 10_000_000:
            raise ValueError("ai.daily_tokens must be a whole number from 10,000 to 10,000,000")
        out["daily_tokens"] = n
    return out


def _day(ts: float) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(ts))


class Brain:
    def __init__(self, root: Path | None, runner=subprocess.run, which=shutil.which):
        self.root, self.run, self.which, self.lock = root, runner, which, threading.Lock()
        self.busy = 0

    def _path(self, *parts) -> Path:
        p = self.root.joinpath(*parts)
        p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        return p

    def spent(self, now: float | None = None) -> dict:
        """Today's calls, tokens and list-price dollars, and the last few calls (what was sent, in short)."""
        now = now or time.time()
        out = {"day": _day(now), "calls": 0, "tokens": 0, "usd": 0.0, "recent": []}
        if not self.root:
            return out
        try:
            lines = self._path("spend.jsonl").read_text().splitlines()[-2000:]
        except OSError:
            return out
        for line in lines:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if _day(e.get("ts") or 0) == out["day"]:
                out["calls"] += 1
                out["tokens"] += int(e.get("tokens") or 0)
                out["usd"] += float(e.get("usd") or 0)
            out["recent"].append({k: e.get(k) for k in ("ts", "kind", "seat", "tokens", "usd", "chars", "cached", "about")})
        out["recent"] = out["recent"][-12:][::-1]
        out["usd"] = round(out["usd"], 4)
        return out

    def _log(self, entry: dict) -> None:
        if not self.root:
            return
        try:
            p = self._path("spend.jsonl")
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a") as fh:
                fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
            if p.stat().st_size > 2_000_000:
                p.write_text("\n".join(p.read_text().splitlines()[-1000:]) + "\n")
        except OSError:
            pass

    def ask(self, kind: str, prompt: str, schema: dict, seat: dict, cfg: dict, about: str = "", timeout: float = 150) -> dict:
        """{"answer": <structured output>, "cached", "tokens", "seat"} or Unavailable with the reason."""
        s = settings(cfg)
        if not s["enabled"]:
            raise Unavailable("The office analyst is off. Turn it on in Settings (it uses a little of a seat's plan).")
        prompt = redact(prompt)[:MAX_PROMPT]
        key = hashlib.sha256(json.dumps([kind, s["model"], schema, prompt], sort_keys=True).encode()).hexdigest()[:32]
        if self.root:
            try:
                c = json.loads(self._path("cache", key + ".json").read_text())
                if time.time() - c["at"] < CACHE_S:
                    self._log({"ts": time.time(), "kind": kind, "seat": c.get("seat"), "tokens": 0, "usd": 0, "chars": len(prompt), "cached": True, "about": about[:80]})
                    return {"answer": c["answer"], "cached": True, "tokens": 0, "seat": c.get("seat")}
            except (OSError, ValueError, KeyError, TypeError):
                pass
        today = self.spent()
        if today["tokens"] >= s["daily_tokens"]:
            raise Unavailable(f"The analyst's daily budget is spent ({today['tokens']:,} of {s['daily_tokens']:,} tokens). It starts again at midnight.")
        if not seat or seat.get("kind") != "claude":
            raise Unavailable("The analyst runs on a Claude seat, and none can take it right now.")
        p5 = ((seat.get("usage") or {}).get("five_hour") or {}).get("pct")
        if seat.get("status") in ("limited", "offline") or (seat.get("health") or {}).get("state") == "login" or (p5 or 0) >= GUARD_5H:
            raise Unavailable(f"{seat.get('label') or seat['id']} cannot take an analyst call right now (out of plan, logged out or nearly full).")
        claude = self.which("claude")
        if not claude:
            raise Unavailable("The claude CLI is not on PATH.")
        with self.lock:
            if self.busy >= 2:
                raise Unavailable("The analyst is already answering two questions. Try again in a moment.")
            self.busy += 1
        try:
            env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY", "CLAUDE_CONFIG_DIR")}
            if seat["id"] != "claude":        # the main account keeps its .claude.json in $HOME (as lanes run it)
                env["CLAUDE_CONFIG_DIR"] = seat["config_dir"]
            env["CLAUDE_OFFICE_BRAIN"] = "1"
            work = self._path("work", ".keep").parent if self.root else Path(config.STATE_DIR)
            nice = self.which("nice")             # low priority, without preexec_fn (unsafe in the threaded server)
            cmd = ([nice, "-n", "15"] if nice else []) + [claude, "-p", "--model", s["model"], "--output-format", "json", "--json-schema", json.dumps(schema),
                   "--tools", "", "--safe-mode", "--no-session-persistence", "--max-budget-usd", "0.5"]
            started = time.time()
            try:
                r = self.run(cmd, input=prompt, capture_output=True, text=True, timeout=timeout, cwd=str(work), env=env)
            except subprocess.TimeoutExpired:
                raise Unavailable("The analyst took too long to answer.") from None
            except OSError as e:
                raise Unavailable(f"The analyst could not start: {e}") from None
            egress.note("analyst", r.returncode == 0)
            try:
                d = json.loads(r.stdout or "{}")
            except ValueError:
                d = {}
            u = d.get("usage") or {}
            tokens = sum(int(u.get(k) or 0) for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
            self._log({"ts": started, "kind": kind, "seat": seat["id"], "tokens": tokens, "usd": d.get("total_cost_usd") or 0,
                       "chars": len(prompt), "cached": False, "about": about[:80], "ok": not d.get("is_error") and r.returncode == 0})
            answer = d.get("structured_output")
            if r.returncode != 0 or d.get("is_error") or not isinstance(answer, dict):
                raise Unavailable("The analyst could not answer: " + redact(str(d.get("result") or r.stderr or "no answer"))[:200])
            if self.root:
                try:
                    p = self._path("cache", key + ".json")
                    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                    with os.fdopen(fd, "w") as fh:
                        json.dump({"at": time.time(), "seat": seat["id"], "answer": answer}, fh)
                    old = sorted(p.parent.glob("*.json"), key=lambda f: f.stat().st_mtime)
                    for f in old[:-400]:                 # keep the newest 400 answers
                        f.unlink(missing_ok=True)
                except OSError:
                    pass
            return {"answer": answer, "cached": False, "tokens": tokens, "seat": seat["id"]}
        finally:
            with self.lock:
                self.busy -= 1

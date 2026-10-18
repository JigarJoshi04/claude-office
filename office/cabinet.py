"""The filing cabinet: every past session on this machine, searchable by its title, its first instruction, its project
and its seat, with its dates, tokens and API value, to open or to resume.

The numbers come from the token ledger. Titles, first instructions and folders are read from the start of each
transcript into memory only (the ledger keeps no content), built in the background the first time the cabinet is
opened and brought up to date when transcripts change.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from .sessions import _user_text, redact

HEAD = 96 * 1024
STALE_S = 120


def read_head(path: Path) -> dict:
    """Title, first instruction and folder from the start of a transcript."""
    out = {"title": None, "prompt": None, "cwd": None}
    try:
        with open(path, "rb") as fh:
            head = fh.read(HEAD)
    except OSError:
        return out
    for raw in head.split(b"\n")[:-1]:
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(d, dict):
            continue
        if d.get("type") == "ai-title" and isinstance(d.get("aiTitle"), str):
            out["title"] = redact(d["aiTitle"])[:160]
        if not out["cwd"] and isinstance(d.get("cwd"), str):
            out["cwd"] = d["cwd"][:1024]
        if not out["prompt"] and d.get("type") == "user" and not d.get("isSidechain"):
            t = _user_text((d.get("message") or {}).get("content"))
            if t:
                out["prompt"] = redact(" ".join(t.split()))[:300]
    return out


class Cabinet:
    def __init__(self):
        self.lock = threading.Lock()
        self.index: dict = {}            # session id -> {title, prompt, cwd, path, mtime}
        self.built_at = 0.0
        self.running = False

    def _build(self, roots: list[Path]) -> None:
        try:
            seen = {}
            for root in roots:
                try:
                    projects = [e for e in os.scandir(root) if e.is_dir()]
                except OSError:
                    continue
                for proj in projects:
                    try:
                        files = [e for e in os.scandir(proj.path) if e.name.endswith(".jsonl") and e.is_file()]
                    except OSError:
                        continue
                    for f in files:
                        sid = f.name[:-6]
                        try:
                            mtime = f.stat().st_mtime
                        except OSError:
                            continue
                        old = self.index.get(sid)
                        seen[sid] = old if old and old["mtime"] == mtime else dict(read_head(Path(f.path)), path=f.path, mtime=mtime)
            with self.lock:
                self.index = seen
                self.built_at = time.time()
        finally:
            with self.lock:
                self.running = False

    def refresh(self, roots: list[Path]) -> bool:
        """Start a background (re)build when stale. True while one runs or none has finished yet."""
        with self.lock:
            if not self.running and time.time() - self.built_at > STALE_S:
                self.running = True
                threading.Thread(target=self._build, args=(list(roots),), daemon=True, name="filing-cabinet").start()
            return self.running or not self.built_at

    def search(self, ledger_sessions: dict, seats: list[dict], q: str = "", seat: str | None = None,
               limit: int = 50, offset: int = 0) -> dict:
        """Sessions, most recent first, matching every word of q in their title, first instruction, project or folder."""
        known = {s["id"]: s for s in seats}
        codex = next((s["id"] for s in seats if s.get("kind") == "codex"), None)
        words = [w for w in (q or "").lower().split() if w][:8]
        with self.lock:
            index = dict(self.index)
        rows = []
        for sid, r in ledger_sessions.items():
            k = codex if r.get("s") == "@codex" else r.get("s")
            if seat and k != seat:
                continue
            meta = index.get(sid) or {}
            hay = " ".join(str(x or "") for x in (meta.get("title"), meta.get("prompt"), r.get("p"), meta.get("cwd"))).lower()
            if words and not all(w in hay for w in words):
                continue
            rows.append((r.get("l") or 0, sid, r, k, meta))
        rows.sort(key=lambda x: -x[0])
        out = []
        for _, sid, r, k, meta in rows[offset:offset + limit]:
            st = known.get(k)
            cwd = meta.get("cwd")
            resume = (f"cd {json.dumps(cwd)} && CLAUDE_CONFIG_DIR={st['config_dir']} claude --resume {sid}"
                      if st and st.get("kind") == "claude" and meta.get("path") and cwd else None)
            out.append({"id": sid, "seat": k, "project": r.get("p"), "title": meta.get("title"), "prompt": meta.get("prompt"),
                        "first": r.get("fi"), "last": r.get("l"), "tokens": r.get("f", 0) + r.get("c", 0), "responses": r.get("n", 0),
                        "usd": round(sum((r.get("$") or {}).values()) / 1e6, 2), "has_transcript": bool(meta.get("path")),
                        "resume": resume, "codex": sid.startswith("codex:")})
        return {"total": len(rows), "rows": out, "indexed": len(index)}

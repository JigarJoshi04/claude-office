"""Team templates: lane briefs kept as JSON files in ~/.config/claude-office/templates/ (a folder a team can keep in
git), shown on the hiring desk beside your own. Each file holds one template or a list of them:

    {"name": "Release notes", "title": "Release notes for v", "brief": "Goal: ..."}

Read only, size-capped and masked like everything else the office shows. Nothing in them runs: a click fills the
Hire form, and only Hire starts a lane.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import config
from .sessions import redact

MAX_FILES, MAX_BYTES, MAX_EACH = 50, 32 * 1024, 20
LIMITS = {"name": 40, "title": 80, "brief": 20000}       # the same as a share code's (web/ui/sharecode.js)

DEMO = [{"name": "Release notes", "title": "Release notes for v", "brief": "Goal: write the release notes for v<version>.\nWhere: the merged PRs since the last tag.\nDone when: the notes are in CHANGELOG.md and every PR is mentioned once.", "file": "release.json"},
        {"name": "Dependency bump", "title": "Bump dependencies", "brief": "Goal: bump the minor versions of our dependencies.\nRun the full test suite after each bump; leave majors alone.\nDone when: a PR is open with the suite green.", "file": "deps.json"}]


def folder() -> Path:
    return config.CONFIG_DIR / "templates"


def _clean(d) -> dict:
    if not isinstance(d, dict):
        raise ValueError("not a template object")
    out = {}
    for k, cap in LIMITS.items():
        v = d.get(k)
        if not isinstance(v, str) or not v.strip():
            raise ValueError(f"no {k}")
        if len(v) > cap:
            raise ValueError(f"the {k} is over {cap} characters")
        out[k] = redact(v.strip() if k == "name" else v)
    return out


def load(where: Path | None = None) -> dict:
    """{templates: [{name, title, brief, file}], skipped: [{file, why}], folder}: every good template in the folder,
    and why any file was left out."""
    where = where or folder()
    out: list[dict] = []
    skipped: list[dict] = []
    try:
        files = sorted(p for p in where.iterdir() if p.suffix == ".json" and p.is_file())
    except OSError:
        return {"templates": [], "skipped": [], "folder": str(where)}
    if len(files) > MAX_FILES:
        skipped.append({"file": f"{len(files) - MAX_FILES} more files", "why": f"only the first {MAX_FILES} are read"})
    for p in files[:MAX_FILES]:
        try:
            if p.stat().st_size > MAX_BYTES:
                raise ValueError("over 32 KB")
            data = json.loads(p.read_text(encoding="utf-8"))
            items = data if isinstance(data, list) else [data]
            if not items:
                raise ValueError("empty")
            for d in items[:MAX_EACH]:
                out.append(dict(_clean(d), file=p.name))
        except (OSError, ValueError, UnicodeDecodeError) as e:
            skipped.append({"file": p.name, "why": str(e)[:80] or type(e).__name__})
    names = set()
    unique = [t for t in out if not (t["name"] in names or names.add(t["name"]))]   # the first of a name wins
    return {"templates": unique, "skipped": skipped, "folder": str(where)}

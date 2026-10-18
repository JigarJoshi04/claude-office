"""The risky-action watch: a session that force-pushes, deletes outside a temp folder, applies or tears down
infrastructure, drops a table, pipes a download into a shell, puts a credential on a command line, or writes a key,
a .env file or Claude Code's own settings shows up in Needs you within seconds, with the command (credentials masked).

It reads what already ran, so it warns; it cannot stop anything. The rules are deliberately few and plain, and each
can be muted in Settings (`risk_watch.mute` in config.json) for an office whose agents do one of these on purpose.
"""
from __future__ import annotations

import json
import os
import re
import shlex
from pathlib import Path

from . import config
from .sessions import redact

_SEG = r"[^|;&\n]*"                                   # within one command of a pipeline or a list
BASH_RULES = [
    ("force_push", "Force-pushed", re.compile(rf"\bgit\b{_SEG}\bpush\b{_SEG}(?:\s--force(?![-\w])|\s-[a-zA-Z]*f\b|\s\+[\w./-]+)")),
    ("infra", "Applied or destroyed infrastructure",
     re.compile(rf"\b(?:terraform|tofu|terragrunt)\b{_SEG}\b(?:apply|destroy)\b|\bkubectl\b{_SEG}\b(?:delete|drain)\b|\bhelm\s+(?:uninstall|delete)\b")),
    ("cloud_delete", "Deleted cloud resources",
     re.compile(rf"\baws\s+s3\s+(?:rm|rb)\b{_SEG}--recursive|\baws\s+[\w-]+\s+(?:delete|terminate)-[\w-]+|\bgcloud\b{_SEG}\bdelete\b")),
    ("drop_table", "Dropped or emptied a table",       # through a database client, not SQL words in a JSON body
     re.compile(r"(?i)\b(?:psql|mysql|mariadb|sqlite3|duckdb|clickhouse(?:-client)?|snowsql|bq)\b[^\n]*\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b")),
    ("pipe_shell", "Ran a downloaded script", re.compile(rf"\b(?:curl|wget)\b{_SEG}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b")),
    ("admin_merge", "Merged past branch protection", re.compile(rf"\bgh\s+pr\s+merge\b{_SEG}--admin\b")),
]
PATH_RULES = [
    ("secret_file", "Wrote a secrets file",
     re.compile(r"(?:^|/)\.env(?:\.(?!example$|sample$|template$)[\w.-]+)?$|\.(?:pem|key|p12|pfx)$|/\.aws/credentials$|/\.netrc$|/\.pypirc$")),
    ("ssh", "Wrote to ~/.ssh", re.compile(r"/\.ssh/|(?:^|/)id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$")),
    ("agent_settings", "Changed Claude Code's settings", re.compile(r"/\.claude\d*/settings(?:\.local)?\.json$|/\.codex/config\.toml$")),
    ("startup", "Changed a shell start-up file", re.compile(r"/\.(?:bashrc|zshrc|profile|bash_profile|zprofile)$|^/etc/")),
]
RULES = {rid: label for rid, label, _ in BASH_RULES + PATH_RULES} | {"rm_rf": "Deleted outside a temp folder", "secret_cmd": "Put a credential in a command"}
_SAFE_RM = ("/tmp/", "/var/tmp/", "/dev/shm/")
# A real credential's shape (not "token=…" in a grep pattern or a short placeholder like sk-ant-test).
TOKEN_RE = re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}"
                      r"|xox[abposr]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}")
_WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}


_HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?.*?\n.*?^\s*\1\s*$", re.S | re.M)


def _dequoted(cmd: str) -> str:
    """The command with heredoc bodies and quoted strings taken out, so a commit message never reads as a command."""
    return re.sub(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", "''", _HEREDOC.sub("", cmd))


def _commands(cmd: str) -> list[list[str]]:
    """The simple commands of a shell line as words (quotes honoured), split at ; & | ( ) and redirections."""
    lex = shlex.shlex(_HEREDOC.sub("", cmd), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    out, cur = [], []
    try:
        for tok in lex:
            if tok and set(tok) <= set(";&|()<>"):
                out.append(cur)
                cur = []
            else:
                cur.append(tok)
    except ValueError:                                  # an unclosed quote: read it word by word
        return [cmd.split()]
    return out + [cur]


def _rm_outside(words: list[str]) -> bool:
    """`rm -r` (any spelling) on /, the home folder, a parent folder or an absolute path outside the temp folders."""
    for i, w in enumerate(words):
        if w.rsplit("/", 1)[-1] != "rm":
            continue
        args = words[i + 1:]
        flags = [a for a in args if a.startswith("-")]
        recursive = any(a in ("-r", "-R", "--recursive") or (not a.startswith("--") and re.search(r"[rR]", a)) for a in flags)
        if not recursive:
            continue
        for t in (a for a in args if not a.startswith("-")):
            if t in (".", "*", "/*") or t.startswith(("~", "$HOME", "${HOME}", "..")) \
                    or (t.startswith("/") and not t.startswith(_SAFE_RM)):
                return True
    return False


def check(name: str, inp) -> list[tuple[str, str]]:
    """The rules one tool call breaks: [(rule id, the redacted command or path)]."""
    if not isinstance(inp, dict):
        return []
    out = []
    if name == "Bash":
        cmd = str(inp.get("command") or "")
        if not cmd:
            return []
        show = redact(" ".join(cmd.split()))[:200]
        plain = _dequoted(cmd)
        for rid, _, rx in BASH_RULES:
            if rx.search(plain if rid != "drop_table" else _HEREDOC.sub("", cmd)):   # SQL is quoted: psql -c "DROP TABLE …"
                out.append((rid, show))
        if any(_rm_outside(words) for words in _commands(cmd)):
            out.append(("rm_rf", show))
        if TOKEN_RE.search(cmd):
            out.append(("secret_cmd", show))
    elif name in _WRITE_TOOLS:
        path = str(inp.get("file_path") or inp.get("notebook_path") or "")
        for rid, _, rx in PATH_RULES:
            if path and rx.search(path):
                out.append((rid, path[-200:]))
    return out


RECENT_S = 2 * 3600          # a risky call older than this when first read (the office was down) is noted, not announced
WINDOW_S = 12 * 3600         # how long it stays in Needs you unless marked seen


class Seen:
    """The risky calls already announced, kept across restarts so a re-read transcript never raises them again."""

    def __init__(self, path: Path | None):
        self.path, self.dirty = path, False
        d = config.read_state(path) if path else None
        self.ids: dict[str, None] = dict.fromkeys(x for x in d if isinstance(x, str)) if isinstance(d, list) else {}

    def first(self, rid: str) -> bool:
        if rid in self.ids:
            return False
        self.ids[rid] = None
        while len(self.ids) > 3000:
            self.ids.pop(next(iter(self.ids)))
        self.dirty = True
        return True

    def save(self) -> None:
        if not (self.path and self.dirty):
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                json.dump(list(self.ids), fh, separators=(",", ":"))
            os.replace(tmp, self.path)
            self.dirty = False
        except OSError:
            pass


DEFAULT_MUTE = ["admin_merge"]       # an admin merge is a deliberate act: watched only when the CEO turns it on


def mute_list(cfg: dict) -> list[str]:
    m = (cfg.get("risk_watch") or {}).get("mute") if isinstance(cfg.get("risk_watch"), dict) else None
    return sorted({x for x in m if x in RULES}) if isinstance(m, list) else list(DEFAULT_MUTE)

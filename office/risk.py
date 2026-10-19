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
from .sessions import redact, strip_heredocs

# Each Bash rule reads the command's simple commands as words (quotes honoured, heredoc bodies out), so a commit
# message or a script being written never reads as a command, and nothing backtracks on a long line.
LABELS = {
    "force_push": "Force-pushed", "infra": "Applied or destroyed infrastructure", "cloud_delete": "Deleted cloud resources",
    "drop_table": "Dropped or emptied a table", "pipe_shell": "Ran a downloaded script",
    "admin_merge": "Merged past branch protection", "rm_rf": "Deleted outside a temp folder",
    "secret_cmd": "Put a credential in a command",
}
PATH_RULES = [
    ("secret_file", "Wrote a secrets file",
     re.compile(r"(?:^|/)\.env(?:\.(?!example$|sample$|template$)[\w.-]+)?$|\.(?:pem|key|p12|pfx)$|/\.aws/credentials$|/\.netrc$|/\.pypirc$")),
    ("ssh", "Wrote to ~/.ssh", re.compile(r"/\.ssh/|(?:^|/)id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$")),
    ("agent_settings", "Changed Claude Code's settings", re.compile(r"/\.claude\d*/settings(?:\.local)?\.json$|/\.codex/config\.toml$")),
    ("startup", "Changed a shell start-up file", re.compile(r"/\.(?:bashrc|zshrc|profile|bash_profile|zprofile)$|^/etc/")),
]
RULES = LABELS | {rid: label for rid, label, _ in PATH_RULES}
_SAFE_RM = ("/tmp/", "/var/tmp/", "/dev/shm/")
# A real credential's shape (not "token=…" in a grep pattern or a short placeholder like sk-ant-test).
TOKEN_RE = re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}"
                      r"|xox[abposr]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}")
_WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
_DB = {"psql", "mysql", "mariadb", "sqlite3", "duckdb", "clickhouse", "clickhouse-client", "snowsql", "bq"}
_DROP_SQL = re.compile(r"(?i)\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b")
_SHELLS = {"bash", "sh", "zsh", "dash"}
_PIPE_SHELL = re.compile(r"\b(?:curl|wget)\b[^|\n]{0,400}\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b"
                         r"|\b(?:ba|z|da)?sh\s+(?:-c\s+)?[\"']?(?:\$\(|<\()\s*(?:curl|wget)\b")
_AWS_VALUE_OPTS = {"--profile", "--region", "--output", "--endpoint-url", "--query", "--color", "--ca-bundle",
                   "--cli-read-timeout", "--cli-connect-timeout"}
_K8S_VALUE_OPTS = {"-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server"}


def _dequoted(cmd: str) -> str:
    """The command with heredoc bodies and quoted strings taken out, so a commit message never reads as a command."""
    return re.sub(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", "''", strip_heredocs(cmd))


def _parse(cmd: str) -> list[dict]:
    """The simple commands of a shell line: [{"words": [...], "out": [redirect targets]}], split at ; & | ( )."""
    lex = shlex.shlex(strip_heredocs(cmd), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    out, cur, redir, pending = [], [], [], False
    try:
        for tok in lex:
            if tok and set(tok) <= set(";&|()<>"):
                if ">" in tok:                          # what comes next is where it writes
                    pending = True
                    continue
                if "<" in tok:
                    continue
                out.append({"words": cur, "out": redir})
                cur, redir = [], []
            elif pending:
                redir.append(tok)
                pending = False
            else:
                cur.append(tok)
    except ValueError:                                  # an unclosed quote: read it word by word
        return [{"words": cmd.split(), "out": []}]
    return out + [{"words": cur, "out": redir}]


def _commands(cmd: str) -> list[list[str]]:
    return [c["words"] for c in _parse(cmd)]


def _name(w: str) -> str:
    return w.rsplit("/", 1)[-1]


def _rm_outside(words: list[str]) -> bool:
    """`rm -r` (any spelling) on /, the home folder, a parent folder or an absolute path outside the temp folders
    (`git rm -r` takes files out of the index, not off the disk)."""
    for i, w in enumerate(words):
        if _name(w) != "rm" or (i and _name(words[i - 1]) == "git"):
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


def _after_opts(words: list[str], value_opts: set) -> list[str]:
    """A command's words without its options (and the values of the options that take one)."""
    out, skip = [], False
    for w in words:
        if skip:
            skip = False
            continue
        if w.startswith("-"):
            skip = w in value_opts
            continue
        out.append(w)
    return out


_PREFIX = {"env", "time", "nohup", "exec", "command", "builtin", "then", "do", "else", "elif", "{", "!", "xargs", "stdbuf", "ionice"}
# The options of a prefix that take a value as the next word (`env -u NAME`, `xargs -n 1`, `ionice -c 3`); the rest are
# single words (`env -i`, `time -p`, `xargs -0`, `stdbuf -oL`, `ionice -c3`).
_PREFIX_VALUE = {"env": {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"}, "time": {"-f", "--format", "-o", "--output"},
                 "xargs": {"-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"},
                 "stdbuf": {"-i", "-o", "-e"}, "ionice": {"-c", "-n", "-p", "-P", "-u"}, "exec": {"-a"}}


def _strip(words: list[str]) -> list[str]:
    """A command's words without what runs it: VAR=x assignments, env, sudo (and its options), time, nohup, exec,
    timeout N, nice -n N, and the then/do/{ of a compound command."""
    w = list(words)
    while w:
        n = _name(w[0])
        if re.fullmatch(r"[A-Za-z_]\w*=.*", w[0]):
            w = w[1:]
        elif n in _PREFIX:
            w, vals = w[1:], _PREFIX_VALUE.get(n, set())
            while w and w[0].startswith("-") and w[0] != "-":
                if w[0] == "--":
                    w = w[1:]
                    break
                w = w[2:] if w[0] in vals else w[1:]
        elif n == "sudo":
            w = w[1:]
            while w and w[0].startswith("-"):
                w = w[2:] if w[0] in ("-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t") else w[1:]
        elif n == "timeout":
            w = w[1:]
            while w and w[0].startswith("-"):
                w = w[2:] if w[0] in ("-s", "-k", "--signal", "--kill-after") else w[1:]
            w = w[1:]                                    # the duration
        elif n == "nice":
            w = w[1:]
            while w and w[0].startswith("-"):
                w = w[2:] if w[0] == "-n" else w[1:]
        else:
            break
    return w


def _word_rules(words: list[str]) -> set[str]:
    """The rules one simple command breaks, from its words."""
    words = _strip(words)
    if not words:
        return set()
    hit, n = set(), _name(words[0])
    if n == "git" and "push" in words:
        args = words[words.index("push") + 1:]
        if any(a == "--force" or a.startswith("--force=") or re.fullmatch(r"-[a-zA-Z]*f[a-zA-Z]*", a) or a.startswith("+") for a in args):
            hit.add("force_push")
    if n in ("terraform", "tofu", "terragrunt"):
        sub = _after_opts(words[1:], set())
        if sub and sub[0] in ("apply", "destroy"):
            hit.add("infra")
    if n == "kubectl":
        sub = _after_opts(words[1:], _K8S_VALUE_OPTS)
        if sub and sub[0] in ("delete", "drain"):
            hit.add("infra")
    if n == "helm" and len(words) > 1 and words[1] in ("uninstall", "delete"):
        hit.add("infra")
    if n == "aws":
        sub = _after_opts(words[1:], _AWS_VALUE_OPTS)
        if len(sub) >= 2 and (re.match(r"(?:delete|terminate)-", sub[1])
                               or sub[0] == "s3" and (sub[1] == "rm" and "--recursive" in words or sub[1] == "rb")):
            hit.add("cloud_delete")
    if n == "gcloud" and "delete" in words:
        hit.add("cloud_delete")
    if n == "gh" and words[1:3] == ["pr", "merge"] and "--admin" in words:
        hit.add("admin_merge")
    if _rm_outside(words):
        hit.add("rm_rf")
    return hit


def _paths_written(c: dict) -> list[str]:
    """Files a simple command writes: its redirect targets, and what cp, mv, install and tee write to."""
    words, out = c["words"], list(c["out"])
    n = _name(words[0]) if words else ""
    args = [w for w in words[1:] if not w.startswith("-")]
    if n in ("cp", "mv", "install", "ln") and len(args) >= 2:
        out.append(args[-1])
    elif n == "tee":
        out += args
    return [os.path.expanduser(p) for p in out if p and not p.isdigit() and p != "/dev/null"]


def _bash(cmd: str, depth: int = 0) -> set[str]:
    hit: set[str] = set()
    parsed = _parse(cmd)
    for c in parsed:
        words = c["words"]
        hit |= _word_rules(words)
        words = _strip(words)
        n = _name(words[0]) if words else ""
        if any(_name(x) in _DB for x in words) and (_DROP_SQL.search(" ".join(words)) or "<<" in cmd and _DROP_SQL.search(cmd)):
            hit.add("drop_table")                       # SQL sent to a database client (docker exec … psql too): -c "…" or a heredoc
        flag = next((i for i, w in enumerate(words[:-1]) if i and re.fullmatch(r"-[a-zA-Z]*c[a-zA-Z]*", w)), None)
        if depth < 2 and n in _SHELLS and flag:          # bash -c "…" (or -lc): read the script it runs
            hit |= _bash(words[flag + 1], depth + 1)
        if depth < 2 and n == "ssh":                   # ssh host "…": read the command it sends
            rest = _after_opts(words[1:], {"-i", "-p", "-l", "-o", "-J", "-F", "-L", "-R", "-D"})
            if len(rest) >= 2:
                hit |= _bash(" ".join(rest[1:]), depth + 1)
        for path in _paths_written(c):
            hit |= {rid for rid, _, rx in PATH_RULES if rx.search(path)}
    if _PIPE_SHELL.search(_dequoted(cmd)) or (depth and re.match(r"\s*\$\(\s*(?:curl|wget)\b", cmd)):
        hit.add("pipe_shell")                           # not words in a commit message; bash -c "$(curl …)" read from inside
    if TOKEN_RE.search(cmd):
        hit.add("secret_cmd")
    return hit


ORDER = list(LABELS) + [rid for rid, _, _ in PATH_RULES]


def check(name: str, inp) -> list[tuple[str, str]]:
    """The rules one tool call breaks: [(rule id, the redacted command or path)]."""
    if not isinstance(inp, dict):
        return []
    if name == "Bash":
        cmd = str(inp.get("command") or "")
        if not cmd:
            return []
        show = redact(" ".join(cmd.split()))[:200]
        hit = _bash(cmd)
        return [(rid, show) for rid in ORDER if rid in hit]
    if name in _WRITE_TOOLS:
        path = str(inp.get("file_path") or inp.get("notebook_path") or "")
        return [(rid, path[-200:]) for rid, _, rx in PATH_RULES if path and rx.search(path)]
    return []

RECENT_S = 2 * 3600          # a risky call older than this when first read (the office was down) is noted, not announced
WINDOW_S = 12 * 3600         # how long it stays in Needs you unless marked seen


class Seen:
    """The risky calls already announced, kept across restarts so a re-read transcript never raises them again, and the
    ones announced in the last 12 hours ({id: {ts, rule, text, seat, session, name}}), so Needs you keeps them after
    their session has gone."""

    def __init__(self, path: Path | None):
        self.path, self.dirty = path, False
        d = config.read_state(path) if path else None
        if isinstance(d, list):                          # the 3.100 file: ids only
            d = {"ids": d}
        d = d if isinstance(d, dict) else {}
        self.ids: dict[str, None] = dict.fromkeys(x for x in d.get("ids") or [] if isinstance(x, str))
        self.recent: dict[str, dict] = {k: v for k, v in (d.get("recent") or {}).items() if isinstance(v, dict) and v.get("rule")}

    def first(self, rid: str) -> bool:
        if rid in self.ids:
            return False
        self.ids[rid] = None
        while len(self.ids) > 3000:
            self.ids.pop(next(iter(self.ids)))
        self.dirty = True
        return True

    def keep(self, rid: str, info: dict) -> None:
        self.recent[rid] = info
        self.dirty = True

    def within(self, now: float) -> list[dict]:
        """The announced risks of the last 12 hours, oldest first (older ones are let go)."""
        old = [k for k, v in self.recent.items() if now - (v.get("ts") or 0) > WINDOW_S]
        for k in old:
            self.recent.pop(k)
        self.dirty |= bool(old)
        return sorted((dict(v, id=k) for k, v in self.recent.items()), key=lambda v: v.get("ts") or 0)

    def save(self) -> None:
        if not (self.path and self.dirty):
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                json.dump({"ids": list(self.ids), "recent": self.recent}, fh, separators=(",", ":"))
            os.replace(tmp, self.path)
            self.dirty = False
        except OSError:
            pass


DEFAULT_MUTE = ["admin_merge"]       # an admin merge is a deliberate act: watched only when the CEO turns it on


def mute_list(cfg: dict) -> list[str]:
    m = (cfg.get("risk_watch") or {}).get("mute") if isinstance(cfg.get("risk_watch"), dict) else None
    return sorted({x for x in m if x in RULES}) if isinstance(m, list) else list(DEFAULT_MUTE)

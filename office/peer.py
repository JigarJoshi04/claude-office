"""Who is on the other end of a loopback connection: the Unix user that owns the client's socket, read from
/proc/net/tcp. The office answers only the user it runs as, so another account on the same machine cannot read
conversations, briefs or the cabinet through 127.0.0.1 (a loopback port has no other notion of who is asking).
"""
from __future__ import annotations

import os

ESTABLISHED = "01"


def peer_uid(client_port: int, server_port: int, table: str | None = None) -> int | None:
    """The uid owning the client end of the connection client_port -> server_port, or None when it is not listed."""
    try:
        text = table if table is not None else open("/proc/net/tcp").read()
    except OSError:
        return None
    for line in text.splitlines()[1:]:
        f = line.split()
        if len(f) < 8 or f[3] != ESTABLISHED:
            continue
        try:
            local, remote = int(f[1].rsplit(":", 1)[1], 16), int(f[2].rsplit(":", 1)[1], 16)
            if local == client_port and remote == server_port:
                return int(f[7])
        except (IndexError, ValueError):
            continue
    return None


def same_user(client_port: int, server_port: int, table: str | None = None) -> bool:
    """True when the client runs as this user. A client that cannot be found (no /proc, or gone already) is refused,
    except where there is no /proc to ask at all."""
    if table is None and not os.path.exists("/proc/net/tcp"):
        return True
    uid = peer_uid(client_port, server_port, table)
    return uid is not None and uid == os.getuid()

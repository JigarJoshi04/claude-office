"""Who is on the other end of a loopback connection: the Unix user that owns the client's socket, read from
/proc/net/tcp. The office answers only the user it runs as, so another account on the same machine cannot read
conversations, briefs or the cabinet through 127.0.0.1 (a loopback port has no other notion of who is asking).

The client's row is found by the whole connection, both addresses and both ports: matching ports alone let another
account bind its source port to the office's own port and be taken for the office's accepted socket.
"""
from __future__ import annotations

import os
import socket
import struct

# The client end may be open, or half-closed once it has sent its request (FIN_WAIT1, FIN_WAIT2, CLOSE_WAIT).
OPEN_STATES = {"01", "04", "05", "08"}


def _addr(field: str) -> tuple[str, int]:
    """'0100007F:1D04' -> ('127.0.0.1', 7428): the kernel prints each 32-bit word as a host-order number. An
    IPv4-mapped IPv6 address (::ffff:127.0.0.1, a client that came in over IPv6) is given as its IPv4 form."""
    ip, port = field.rsplit(":", 1)
    if len(ip) == 8:
        return socket.inet_ntoa(struct.pack("=I", int(ip, 16))), int(port, 16)
    raw = b"".join(struct.pack("=I", int(ip[i:i + 8], 16)) for i in range(0, 32, 8))
    return (socket.inet_ntoa(raw[12:]) if raw[:12] == b"\0" * 10 + b"\xff\xff" else socket.inet_ntop(socket.AF_INET6, raw)), int(port, 16)


def peer_uid(client: tuple, server: tuple, table: str | None = None) -> int | None:
    """The uid owning the client end of the connection client (ip, port) -> server (ip, port), or None."""
    if table is None:                                   # IPv4 first; a client over IPv6 is in tcp6
        for path in ("/proc/net/tcp", "/proc/net/tcp6"):
            try:
                uid = peer_uid(client, server, open(path).read())
            except OSError:
                continue
            if uid is not None:
                return uid
        return None
    text = table
    want_local, want_remote = (client[0], int(client[1])), (server[0], int(server[1]))
    for line in text.splitlines()[1:]:
        f = line.split()
        if len(f) < 8 or f[3] not in OPEN_STATES:
            continue
        try:
            if _addr(f[1]) == want_local and _addr(f[2]) == want_remote:
                return int(f[7])
        except (IndexError, ValueError, OSError, struct.error):
            continue
    return None


def same_user(client: tuple, server: tuple, table: str | None = None) -> bool:
    """True when the client runs as this user. A client that cannot be found (no /proc, or gone already) is refused,
    except where there is no /proc to ask at all."""
    if table is None and not os.path.exists("/proc/net/tcp"):
        return True
    uid = peer_uid(client, server, table)
    return uid is not None and uid == os.getuid()

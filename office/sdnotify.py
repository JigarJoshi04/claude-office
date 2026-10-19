"""systemd's notify protocol with the standard library: READY=1 once the office answers, WATCHDOG=1 while its loop
runs. Under `Type=notify` with `WatchdogSec=`, a loop that stops ticking gets the office restarted. Outside systemd
(a terminal, the tests) there is no NOTIFY_SOCKET and every call does nothing.
"""
from __future__ import annotations

import os
import socket

# Read once and taken out of the environment, so lanes and tools the office starts never inherit it.
_SOCKET = os.environ.pop("NOTIFY_SOCKET", None)
_WATCHDOG_USEC = os.environ.pop("WATCHDOG_USEC", None)
os.environ.pop("WATCHDOG_PID", None)


def enabled() -> bool:
    return bool(_SOCKET)


def watchdog_s() -> float | None:
    """The watchdog's timeout in seconds, when systemd set one."""
    try:
        return int(_WATCHDOG_USEC) / 1e6 if _WATCHDOG_USEC else None
    except ValueError:
        return None


def notify(state: str, sock: str | None = None) -> bool:
    """Send one notify line ("READY=1", "WATCHDOG=1", "STOPPING=1", "STATUS=…"). True when it was sent."""
    addr = sock if sock is not None else _SOCKET
    if not addr or addr[0] not in "/@":
        return False
    if addr[0] == "@":                                   # an abstract socket
        addr = "\0" + addr[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM | getattr(socket, "SOCK_CLOEXEC", 0)) as s:
            s.connect(addr)
            s.sendall(state.encode())
        return True
    except OSError:
        return False

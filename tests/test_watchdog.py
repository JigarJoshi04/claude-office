"""systemd's notify protocol (sdnotify.py), what a refresh costs (Office.perf_view), running light, and /healthz."""
import os
import socket
import tempfile
import time
import unittest
from collections import deque
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from office import doctor, sdnotify, snapshot


class NotifyTests(unittest.TestCase):
    def test_sends_to_a_path_or_an_abstract_socket(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "notify")
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as rx:
                rx.bind(path)
                self.assertTrue(sdnotify.notify("READY=1", path))
                self.assertEqual(rx.recv(64), b"READY=1")
        name = f"co-test-{os.getpid()}"
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as rx:
            rx.bind("\0" + name)
            self.assertTrue(sdnotify.notify("WATCHDOG=1", "@" + name))
            self.assertEqual(rx.recv(64), b"WATCHDOG=1")

    def test_nothing_happens_outside_systemd(self):
        self.assertFalse(sdnotify.notify("READY=1", ""))
        self.assertFalse(sdnotify.notify("READY=1", "relative/path"))
        self.assertFalse(sdnotify.notify("READY=1", "/nonexistent/notify"))
        self.assertNotIn("NOTIFY_SOCKET", os.environ)                  # never passed on to lanes


def office_with(runs, light=False):
    o = SimpleNamespace(perf=deque(runs, maxlen=120), light=light)
    o.perf_view = snapshot.Office.perf_view.__get__(o)
    o._busy = snapshot.Office._busy.__get__(o)
    return o


class PerfTests(unittest.TestCase):
    def test_median_p95_and_the_slowest_part(self):
        runs = [(0.02, {"seats": 0.015, "lanes": 0.005})] * 19 + [(2.0, {"seats": 0.1, "lanes": 1.9})]
        v = office_with(runs).perf_view()
        self.assertEqual((v["builds"], v["p50_ms"], v["p95_ms"], v["max_ms"]), (20, 20.0, 20.0, 2000.0))   # 19 of 20 within 20 ms
        self.assertEqual(v["slowest_phase"], "seats")                  # by the median, not one bad refresh
        self.assertEqual(office_with([]).perf_view(), {"builds": 0, "light": False})

    def test_running_light_has_hysteresis(self):
        quick, slow, middling = [(0.05, {})] * 30, [(2.0, {})] * 30, [(1.2, {})] * 30
        with patch.object(os, "getloadavg", return_value=(1.0, 1, 1)), patch.object(os, "cpu_count", return_value=4):
            self.assertFalse(office_with(quick)._busy())
            self.assertTrue(office_with(slow)._busy())
            self.assertFalse(office_with(middling)._busy())             # 1.2 s: not slow enough to start running light...
            self.assertTrue(office_with(middling, light=True)._busy())  # ...nor quick enough to stop
            self.assertFalse(office_with([(2.0, {})] * 9)._busy())         # nine refreshes are too few to judge
        with patch.object(os, "getloadavg", return_value=(7.0, 1, 1)), patch.object(os, "cpu_count", return_value=4):
            self.assertTrue(office_with(quick)._busy())                 # the machine is loaded past its cores


class HealthTests(unittest.TestCase):
    def test_stale_picture_is_not_ok(self):
        office = SimpleNamespace(tokens=SimpleNamespace(scanned_at=time.time() - 120, scanning=False))
        ok, body = doctor.health(office, {"now": time.time() - 5})
        self.assertEqual((ok, set(body)), (True, {"ok", "age_s"}))
        ok, body = doctor.health(office, {"now": time.time() - 45, "seats": [{"id": "c2", "kind": "claude", "usage": {"fetched_at": time.time() - 60}}]}, deep=True)
        self.assertFalse(ok)
        self.assertEqual(body["tokens"]["age_s"], 120)
        self.assertEqual(body["usage"]["c2"]["age_s"], 60)
        self.assertEqual(set(body["threads"]), set(doctor.THREADS))


if __name__ == "__main__":
    unittest.main()

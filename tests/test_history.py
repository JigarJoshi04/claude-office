from datetime import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from office.history import HistoryStore


def snap(ts, state="working", tokens=10, tools=2, live=True, sid="one", seat="a", started=None):
    return {"now": ts, "seats": [{"id": seat, "label": seat.upper(), "color": "#123456",
        "usage": {"five_hour": {"pct": 20}, "weekly": {"pct": None}}, "tokens_1h": 8,
        "sessions": [{"id": sid, "name": sid, "kind": "lane", "state": state, "live": live,
                      "title": None, "report_status": None, "tokens_total": tokens, "tool_calls": tools,
                      "started_at": started}]}], "lanes": []}


class HistoryTests(unittest.TestCase):
    def test_sampling_retention_load_corruption_and_rotation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "history.jsonl"
            store = HistoryStore(path, clock=lambda: 100000)
            self.assertTrue(store.record(snap(100000)))
            self.assertFalse(store.record(snap(100059)))
            self.assertTrue(store.record(snap(100060)))
            raw = json.loads(path.read_text().splitlines()[0])
            self.assertEqual(raw["seats"]["a"], [20, None, 1, 1, 8, 0])
            self.assertEqual(raw["sessions"]["one"], ["a", "one", "lane", "working", None, None, 10, 2])
            with path.open("a") as f:
                f.write('junk\nnull\n{"ts":100000,"seats":{},"sessions":{"bad":[]}}\n')
            reloaded = HistoryStore(path, clock=lambda: 100060)
            self.assertEqual(len(reloaded.rows), 2)
            with patch("office.history.ROTATE_BYTES", 1):
                store.record(snap(200000))
            self.assertEqual(len(store.rows), 1)
            self.assertEqual(len(path.read_text().splitlines()), 1)
            self.assertEqual(HistoryStore(path, clock=lambda: 300000).rows, [])

    def test_live_edge_segments_state_change_gap_and_nonlive_filter(self):
        h = HistoryStore(clock=lambda: 10000)
        for t, state in ((10000, "working"), (10060, "working"), (10120, "waiting"), (10400, "waiting")):
            h.record(snap(t, state))
        result = h.query(snap(10430, "waiting"))
        self.assertEqual(result["step"], 60)
        self.assertEqual(result["from"], 10430 - 21600)
        self.assertEqual(result["seats"]["a"]["series"][-1], [10430, 20, None, 1, 1, 8, 0])
        session = result["sessions"][0]
        self.assertEqual(session["segments"], [[10000, 10120, "working"], [10120, 10180, "waiting"], [10400, 10430, "waiting"]])
        self.assertTrue(session["live"])
        gone = h.query(snap(10440, live=False))["sessions"][0]
        self.assertFalse(gone["live"])
        self.assertEqual(gone["last_seen"], 10400)
        self.assertNotIn("one", HistoryStore().query(snap(10440, live=False))["sessions"])

    def test_markers_read_full_log_and_filter_kinds_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "events.jsonl"
            evs = [{"ts": t, "kind": k, "seat": "a", "text": k, "level": "info"}
                   for t, k in ((9999, "report"), (10001, "report"), (10002, "limit"), (10003, "arrive"), (14000, "login"))]
            path.write_text("\n".join(json.dumps(e) for e in evs) + "\ninvalid\n")
            h = HistoryStore(events_path=path)
            result = h.query(snap(13600), 1, evs)
            self.assertEqual([e["kind"] for e in result["markers"]], ["report", "limit"])

    def test_session_cap_newest_win_and_sort(self):
        h = HistoryStore()
        for i in range(305):
            h.record(snap(100000 + i * 60, sid=str(i), seat="b" if i % 2 else "a"))
        out = h.query(snap(118300, sid="new", seat="a"), 24)["sessions"]
        self.assertEqual(len(out), 300)
        self.assertNotIn("0", [s["id"] for s in out])
        self.assertEqual(out, sorted(out, key=lambda s: (s["seat"], s["first_seen"], s["id"])))

    def test_invalid_hours(self):
        for hours in (0, 25, 1.5, True):
            with self.assertRaises(ValueError):
                HistoryStore().query(snap(10000), hours)


class StatsTests(unittest.TestCase):
    def setUp(self):
        self.start = datetime(2026, 10, 16).timestamp()
        self.clock = self.start + 300
        self.h = HistoryStore(clock=lambda: self.clock)

    def test_daily_deltas_existing_session_baseline_and_counter_reset(self):
        t = self.start
        self.h.record(snap(t - 60, tokens=100, tools=10))
        self.h.record(snap(t, tokens=120, tools=12))
        self.h.record(snap(t + 60, tokens=150, tools=15))
        self.h.record(snap(t + 120, tokens=5, tools=1))
        current = snap(t + 180, tokens=15, tools=3)
        self.h.record(current)
        out = self.h.stats(current, "2026-10-16")
        self.assertEqual(out["seats"]["a"]["tokens_fresh"], 40)
        self.assertEqual(out["seats"]["a"]["tool_calls"], 5)
        self.assertEqual(out["seats"]["a"]["active_min"], 4)
        self.assertEqual(out["office"]["sessions"], 1)
        self.assertEqual(out["office"]["longest_session"]["minutes"], 3)
        self.assertEqual(out["seats"]["a"]["peak_p5"], 20)

    def test_new_session_counts_from_zero_and_minute_is_not_double_counted(self):
        t = self.start
        self.h.record(snap(t, tokens=10, tools=2))
        current = snap(t + 30, tokens=20, tools=3)
        out = self.h.stats(current, "2026-10-16")
        self.assertEqual(out["seats"]["a"]["tokens_fresh"], 20)
        self.assertEqual(out["seats"]["a"]["tool_calls"], 3)
        self.assertEqual(out["seats"]["a"]["active_min"], 1)
        self.assertEqual(out["seats"]["a"]["lanes"], 1)

    def test_start_time_before_day_makes_initial_read_a_baseline(self):
        t = self.start
        self.h.record(snap(t + 60, tokens=100, started=t - 600))
        out = self.h.stats(snap(t + 120, tokens=130, started=t - 600), "2026-10-16")
        self.assertEqual(out["seats"]["a"]["tokens_fresh"], 30)

    def test_minutes_out_of_plan_per_seat_and_for_the_whole_office(self):
        t = self.start
        two = lambda ts, a_out, b_out: {"now": ts, "lanes": [], "seats": [
            {"id": "a", "kind": "claude", "status": "limited" if a_out else "working", "usage": {}, "sessions": []},
            {"id": "b", "kind": "claude", "status": "limited" if b_out else "idle", "usage": {}, "sessions": []}]}
        for i, (a_out, b_out) in enumerate([(1, 0), (1, 1), (1, 1), (0, 1)]):
            self.h.record(two(t + 60 + i * 60, a_out, b_out))
        out = self.h.stats(two(t + 300, 0, 0), "2026-10-16")
        self.assertEqual((out["seats"]["a"]["limited_min"], out["seats"]["b"]["limited_min"]), (3, 3))
        self.assertEqual(out["office"]["all_out_min"], 2)                          # both out at once: no Claude seat free

    def test_plan_in_use_counts_minutes_with_plan_left_and_who_worked(self):
        t = self.start
        def one(ts, p5, wk, working, status="working"):
            return {"now": ts, "lanes": [], "seats": [{"id": "a", "kind": "claude", "status": status,
                    "usage": {"five_hour": {"pct": p5}, "weekly": {"pct": wk}},
                    "sessions": [{"id": "s1", "name": "x", "state": "working" if working else "idle", "live": True}]}]}
        rows = [(40, 50, 1, "working"), (41, 50, 0, "idle"), (100, 50, 0, "limited"), (None, None, 0, "idle"), (45, 99, 1, "working")]
        for i, (p5, wk, w, st) in enumerate(rows):
            self.h.record(one(t + 60 + i * 60, p5, wk, w, st))
        a = self.h.stats(one(t + 400, 45, 99, 0, "idle"), "2026-10-16")["seats"]["a"]
        self.assertEqual((a["avail_min"], a["busy_min"]), (4, 2))     # with the reading now; out of plan and unread minutes do not count

    def test_postmortem_of_the_last_time_a_seat_ran_out(self):
        t = self.start
        def one(ts, p5, out, toks):
            return {"now": ts, "lanes": [], "seats": [{"id": "a", "kind": "claude", "status": "limited" if out else "working",
                    "usage": {"five_hour": {"pct": p5}, "weekly": {"pct": 30}},
                    "sessions": [{"id": "big", "name": "api lane", "kind": "lane", "state": "working", "tokens_total": toks[0], "started_at": t, "live": True},
                                 {"id": "small", "name": "docs", "kind": "desk", "state": "working", "tokens_total": toks[1], "started_at": t, "live": True}]}]}
        self.assertEqual(self.h.postmortem(one(t, 10, 0, (0, 0)), "a"), {"limit": None})
        self.h.record(one(t, 100, 0, (0, 0)))                          # the end of the window before, then a reset
        for i in range(10):                                          # ten minutes filling the window, then out of plan
            p5 = min(100, 10 + i * 10)
            self.h.record(one(t + 60 * (i + 1), p5, 1 if p5 >= 100 else 0, (i * 3000, i * 1000)))
        pm = self.h.postmortem(one(t + 700, 100, 1, (27000, 9000)), "a")["limit"]
        self.assertEqual(pm["at"], t + 600)                          # the first minute out of plan
        self.assertEqual(pm["window"], "five_hour")
        self.assertEqual([(x["name"], x["share"]) for x in pm["sessions"]], [("api lane", 75), ("docs", 25)])
        self.assertGreater(pm["per_hour"], 400)                      # 80 points in 9 minutes
        self.assertEqual(pm["pace"][0][1], 10)                        # from the reset, not the window before

    def test_what_one_percent_of_the_plan_buys(self):
        t = self.start
        def one(ts, p5, wk, toks):
            return {"now": ts, "lanes": [], "seats": [{"id": "a", "kind": "claude", "status": "working", "usage": {"five_hour": {"pct": p5}, "weekly": {"pct": wk}},
                    "sessions": [{"id": "s1", "name": "x", "state": "working", "tokens_total": toks, "started_at": t, "live": True}]}]}
        # The 5-hour reading moves every other minute; the tokens of the minutes between count too.
        for i, (p5, wk, toks) in enumerate([(10, 40, 0), (10, 40, 100_000), (12, 40, 200_000), (12, 41, 300_000), (14, 41, 400_000),
                                            (2, 41, 500_000), (2, 41, 600_000), (4, 42, 700_000)]):
            self.h.record(one(t + 60 * (i + 1), p5, wk, toks))
        ex = self.h.exchange(one(t + 540, 4, 42, 700_000), "a")
        self.assertEqual(ex["five_hour"], 100_000)                    # 600k tokens over 6 points; the reset's minute is left out
        self.assertIsNone(ex["weekly"])                               # two points of the week is too few to say
        self.assertEqual(ex["points"]["weekly"], 2)

    def test_baseline_survives_restart_without_a_previous_day_sample(self):
        t = self.start
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "history.jsonl"
            store = HistoryStore(path, clock=lambda: t + 60)
            store.record(snap(t + 60, tokens=100, started=t - 600))
            reloaded = HistoryStore(path, clock=lambda: t + 120)
            out = reloaded.stats(snap(t + 120, tokens=130), "2026-10-16")
            self.assertEqual(out["seats"]["a"]["tokens_fresh"], 30)

    def test_mvp_by_xp_and_event_boundaries(self):
        t = self.start
        for offset in (0, 60, 120):
            row = snap(t + offset, state="idle" if offset == 120 else "working")
            b = snap(t + offset, seat="b", sid="two", state="waiting")
            row["seats"] += b["seats"]
            self.h.record(row)
        row["lanes"] = [{"created_at": t}, {"created_at": t - 1}]
        events = [{"ts": when, "kind": kind, "seat": seat, "text": "x", "level": "info"}
                  for when, kind, seat in ((t, "report", "a"), (t+1, "report", "b"), (t+2, "limit", "a"),
                                           (t+86400, "report", "a"), (t-1, "report", "a"))]
        out = self.h.stats(row, "2026-10-16", events)
        self.assertEqual(out["mvp"], {"seat": "b", "why": "1 report and 3 active minutes"})
        self.assertEqual(out["office"]["reports"], 2)
        self.assertEqual(out["office"]["limits"], 1)
        self.assertEqual(out["office"]["lanes_hired"], 1)
        self.assertEqual(out["office"]["busiest_seat"], "b")
        self.assertLessEqual(len(out["digest"]), 5)
        self.clock += 61
        events.append(dict(events[0], ts=t+3))
        self.assertEqual(self.h.stats(row, "2026-10-16", events)["mvp"]["seat"], "a")

    def test_an_hour_of_work_beats_a_one_minute_report(self):
        t = self.start
        for m in range(61):
            row = snap(t + m * 60, tools=3 * m)
            if m < 2:
                row["seats"] += snap(t + m * 60, seat="b", sid="two")["seats"]
            self.h.record(row)
        events = [{"ts": t + 30, "kind": "report", "seat": "b", "text": "x", "level": "good"}]
        self.assertEqual(self.h.stats(row, "2026-10-16", events)["mvp"]["seat"], "a")

    def test_empty_day_cache_expiry_and_strict_date(self):
        row = snap(self.start)
        out = self.h.stats(row, "2026-10-15")
        self.assertIsNone(out["mvp"])
        self.assertIsNone(out["office"]["longest_session"])
        self.assertIsNone(out["office"]["first_activity"])
        first = self.h.stats(row)
        self.assertEqual(first["day"], "2026-10-16")
        self.assertIs(first, self.h.stats(snap(self.start + 60)))
        self.clock += 60
        self.assertIsNot(first, self.h.stats(row))
        for day in ("20261016", "2026-10-32", "yesterday", "2026-1-1"):
            with self.assertRaises(ValueError):
                self.h.stats(row, day)

    def test_longest_does_not_count_offline_gap(self):
        for t in (self.start, self.start+60, self.start+600):
            self.h.record(snap(t))
        out = self.h.stats(snap(self.start+660), "2026-10-16")
        self.assertEqual(out["office"]["longest_session"]["minutes"], 3)

    def test_hired_counts_all_lane_files_beyond_snapshot_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for i in range(45):
                (root / str(i)).mkdir()
                (root / str(i) / "lane.json").write_text(json.dumps({"id": str(i), "created_at": self.start}))
            self.h.lanes_path = root
            current = snap(self.start + 60)
            current["lanes"] = [{"id": "0", "created_at": self.start}]
            self.assertEqual(self.h.stats(current, "2026-10-16")["office"]["lanes_hired"], 45)


class AllOutTests(unittest.TestCase):
    def test_a_benched_seat_does_not_hide_the_minutes_lost_to_limits(self):
        import tempfile
        from pathlib import Path
        t = 1_792_281_600.0                                           # a day start; the day is read in local time below
        with tempfile.TemporaryDirectory() as tmp:
            h = HistoryStore(Path(tmp) / "h.jsonl", clock=lambda: t + 600)
            snap2 = lambda ts, a, b: {"now": ts, "lanes": [], "seats": [
                {"id": "a", "kind": "claude", "status": a, "usage": {}, "sessions": []},
                {"id": "b", "kind": "claude", "status": b, "usage": {}, "sessions": []}]}
            for i, (a, b) in enumerate([("limited", "benched"), ("limited", "offline"), ("benched", "offline"), ("limited", "idle")]):
                h.record(snap2(t + 60 + i * 60, a, b))
            day = __import__("time").strftime("%Y-%m-%d", __import__("time").localtime(t + 60))
            out = h.stats(snap2(t + 400, "idle", "idle"), day)
            self.assertEqual(out["office"]["all_out_min"], 2)          # limited + out anyway; never when nobody was limited
            self.assertEqual(out["seats"]["a"]["limited_min"], 3)

"""Minute samples, compact timelines, and daily totals. Standard library only."""
from datetime import date, datetime, time as daytime, timedelta
import json
import os
from pathlib import Path
import tempfile
import threading
import time

from . import config
from .career import XP_MINUTE, XP_REPORT, XP_SESSION, XP_TOOL
from .live import public

MARKER_KINDS = {"limit", "report", "reset", "hire", "login", "lane", "usage", "levelup", "achievement", "shipped", "external", "ghost", "risk", "collision", "bond"}
STATES = {"working", "waiting", "idle", "limited", "stuck"}
RETENTION = 24 * 3600
ROTATE_BYTES = 3_000_000


def sample(snapshot):
    out = {"ts": snapshot["now"], "seats": {}, "sessions": {}}
    for seat in snapshot.get("seats", []):
        live = [x for x in seat.get("sessions", []) if x.get("live", True)]
        usage = seat.get("usage") or {}
        out["seats"][seat["id"]] = [
            (usage.get("five_hour") or {}).get("pct"), (usage.get("weekly") or {}).get("pct"),
            sum(x.get("state") in ("working", "waiting") for x in live),
            sum(x.get("kind") == "lane" for x in live), seat.get("tokens_1h") or 0,
            1 if seat.get("status") == "limited" else                   # out of plan this minute (hours lost to limits)
            2 if seat.get("status") in ("offline", "benched") or (seat.get("health") or {}).get("state") == "login" else 0]   # out for another reason
        for x in live:
            out["sessions"][x["id"]] = [seat["id"], x.get("name"), x.get("kind", "desk"),
                x.get("state") if x.get("state") in STATES else "idle", x.get("title"),
                x.get("report_status"), x.get("tokens_total") or 0, x.get("tool_calls") or 0]
    return public(out)


def timelines(rows, now, live_ids=()):
    """A sample covers at most a minute; adjacent state changes meet at their boundary."""
    found = {}
    for row in rows:
        ts = row["ts"]
        for sid, x in row["sessions"].items():
            entry = found.get(sid)
            state = x[3]
            if entry is None:
                entry = found[sid] = {"id": sid, "seat": x[0], "name": x[1], "kind": x[2], "title": x[4],
                    "first_seen": ts, "last_seen": ts, "live": sid in live_ids,
                    "segments": [], "report_status": x[5]}
            segments = entry["segments"]
            end = min(ts + 60, now)
            if segments and ts - entry["last_seen"] <= 180:
                if segments[-1][2] == state:
                    segments[-1][1] = end
                else:
                    segments[-1][1] = ts
                    segments.append([ts, end, state])
            else:
                segments.append([ts, end, state])
            entry.update(last_seen=ts, seat=x[0], name=x[1], title=x[4], report_status=x[5])
            if sid in live_ids and ts == now:
                segments[-1][1] = now
    return list(found.values())


class DayLedger:
    """One summary per day (the Today numbers), kept for months in a small JSON file. History itself keeps 24 hours,
    so earlier days and the week chart read from here."""

    FIELDS = ("reports", "sessions", "active_min", "tool_calls", "limits", "lanes_hired")

    def __init__(self, path: Path | None = None, keep_days: int = 120):
        self.path, self.keep_days = path, keep_days
        self.lock = threading.Lock()
        self.days = {}
        raw = config.read_state(path)                  # a damaged file is set aside, never written over
        if isinstance(raw, dict):
            self.days = {k: v for k, v in raw.items() if _is_day(k) and isinstance(v, dict)}

    def note(self, stats):
        if not isinstance(stats, dict) or not _is_day(stats.get("day")):
            return
        o = stats.get("office") or {}
        mins = sum((s or {}).get("active_min") or 0 for s in (stats.get("seats") or {}).values())
        if not (o.get("sessions") or o.get("reports") or mins):
            return                                    # an empty day is not worth a line
        with self.lock:
            self.days[stats["day"]] = stats
            for k in sorted(self.days)[:-self.keep_days]:
                del self.days[k]
            self._save()

    def get(self, day):
        return self.days.get(day)

    def week(self, today, n=7):
        if not _is_day(today):
            raise ValueError("day must be YYYY-MM-DD")
        if type(n) is not int or not 1 <= n <= 90:
            raise ValueError("days must be an integer from 1 to 90")
        end = date.fromisoformat(today)
        out = []
        for i in range(n - 1, -1, -1):
            d = (end - timedelta(days=i)).isoformat()
            st = self.days.get(d) or {}
            o = st.get("office") or {}
            seats = st.get("seats") or {}
            out.append({"day": d, "reports": o.get("reports") or 0, "sessions": o.get("sessions") or 0,
                        "active_min": sum((s or {}).get("active_min") or 0 for s in seats.values()),
                        "tool_calls": sum((s or {}).get("tool_calls") or 0 for s in seats.values()),
                        "limits": o.get("limits") or 0, "lanes_hired": o.get("lanes_hired") or 0,
                        "mvp": (st.get("mvp") or {}).get("seat"),
                        "limited_min": {sid: (s or {}).get("limited_min") or 0 for sid, s in seats.items() if (s or {}).get("limited_min")},
                        "all_out_min": o.get("all_out_min") or 0})
        return out

    def _save(self):
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".days-", dir=self.path.parent)
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "w") as f:
                    json.dump(self.days, f, separators=(",", ":"))
                os.replace(tmp, self.path)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
        except OSError:
            pass                                      # the ledger is a nicety; the office runs without it


def _is_day(value):
    try:
        return isinstance(value, str) and date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


class HistoryStore:
    def __init__(self, path: Path | None = None, events_path: Path | None = None, clock=time.time,
                 lanes_path: Path | None = None, ledger: "DayLedger | None" = None):
        self.path, self.events_path, self.clock = path, events_path, clock
        self.ledger = ledger
        self.lanes_path = lanes_path
        self.lock = threading.RLock()
        self.rows = []
        self.first_seen = {}
        self.stats_cache = {}
        now = clock()
        if path:
            try:
                with path.open() as f:
                    for line in f:
                        try:
                            row = json.loads(line)
                            if (isinstance(row, dict) and isinstance(row.get("ts"), (int, float))
                                    and now - RETENTION <= row["ts"] <= now
                                    and isinstance(row.get("seats"), dict)
                                    and isinstance(row.get("sessions"), dict)
                                    and all(isinstance(x, list) and len(x) in (5, 6) for x in row["seats"].values())   # 6: with "limited" (3.53)
                                    and all(isinstance(x, list) and len(x) == 8 for x in row["sessions"].values())):
                                self.rows.append(row)
                        except (ValueError, TypeError):
                            continue
            except OSError:
                pass
        self.rows.sort(key=lambda r: r["ts"])
        for row in self.rows:
            for sid in row["sessions"]:
                known = row.get("first_seen")
                first = known.get(sid, row["ts"]) if isinstance(known, dict) else row["ts"]
                if not isinstance(first, (int, float)):
                    first = row["ts"]
                self.first_seen[sid] = min(self.first_seen.get(sid, first), first)

    def record(self, snapshot):
        row = sample(snapshot)
        now = row["ts"]
        with self.lock:
            self.rows = [r for r in self.rows if r["ts"] >= now - RETENTION]
            # Process start times disambiguate sessions already running before our first sample.
            for seat in snapshot.get("seats", []):
                for x in seat.get("sessions", []):
                    if x.get("live", True):
                        first = x.get("started_at") or now
                        self.first_seen[x["id"]] = min(self.first_seen.get(x["id"], first), first)
            if self.rows and now - self.rows[-1]["ts"] < 60:
                return False
            # Preserve the baseline across restarts even when the original sighting ages out.
            row["first_seen"] = {sid: self.first_seen[sid] for sid in row["sessions"]}
            self.rows.append(row)
            retained = {sid for r in self.rows for sid in r["sessions"]}
            self.first_seen = {sid: ts for sid, ts in self.first_seen.items() if sid in retained}
            if self.path:
                try:
                    self.path.parent.mkdir(parents=True, exist_ok=True)
                    with self.path.open("a") as f:
                        f.write(json.dumps(row, separators=(",", ":")) + "\n")
                    if self.path.stat().st_size > ROTATE_BYTES:
                        self._compact()
                except OSError:
                    pass  # Keep the in-memory history if the disk is temporarily unavailable.
            return True

    def _compact(self):
        fd, tmp = tempfile.mkstemp(prefix=".history-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as f:
                for row in self.rows:
                    f.write(json.dumps(row, separators=(",", ":")) + "\n")
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def _points(self, snapshot):
        now = snapshot["now"]
        rows = [r for r in self.rows if now - RETENTION <= r["ts"] < now]
        rows.append(sample(snapshot))
        return rows

    def events(self, start, end, fallback=()):
        events = []
        if self.events_path:
            try:
                with self.events_path.open() as f:
                    for line in f:
                        try:
                            ev = json.loads(line)
                            if isinstance(ev, dict) and start <= ev.get("ts", -1) <= end:
                                events.append(ev)
                        except (ValueError, TypeError):
                            continue
            except OSError:
                pass
        # Include in-memory events even if disk writes failed; don't duplicate persisted ones.
        seen = {json.dumps(e, sort_keys=True) for e in events}
        for e in fallback:
            key = json.dumps(e, sort_keys=True)
            if start <= e.get("ts", -1) <= end and key not in seen:
                events.append(e)
                seen.add(key)
        return sorted(events, key=lambda e: e["ts"])

    def query(self, snapshot, hours=6, events=()):
        if type(hours) is not int or not 1 <= hours <= 24:
            raise ValueError("hours must be an integer from 1 to 24")
        now = snapshot["now"]
        start = now - hours * 3600
        with self.lock:
            rows = [r for r in self._points(snapshot) if r["ts"] >= start]
        meta = {s["id"]: s for s in snapshot.get("seats", [])}
        seats = {}
        for row in rows:
            for sid, values in row["seats"].items():
                s = meta.get(sid, {})
                entry = seats.setdefault(sid, {"label": s.get("label", sid), "color": s.get("color", "#5b8def"), "series": []})
                entry["series"].append([row["ts"], *values])
        live_ids = sample(snapshot)["sessions"]
        sessions = timelines(rows, now, live_ids)
        sessions = sorted(sessions, key=lambda s: s["last_seen"], reverse=True)[:300]
        sessions.sort(key=lambda s: (s["seat"], s["first_seen"], s["id"]))
        markers = [{k: e.get(k) for k in ("ts", "kind", "seat", "text", "level")}
                   for e in self.events(start, now, events) if e.get("kind") in MARKER_KINDS]
        return public({"now": now, "from": start, "step": 60, "seats": seats, "sessions": sessions, "markers": markers})

    def stats(self, snapshot, day=None, events=()):
        now = self.clock()
        day = day or datetime.fromtimestamp(now).date().isoformat()
        try:
            parsed = date.fromisoformat(day)
            if parsed.isoformat() != day:
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError("day must be YYYY-MM-DD") from None
        start = datetime.combine(parsed, daytime()).timestamp()
        end = datetime.combine(parsed + timedelta(days=1), daytime()).timestamp()
        today = datetime.fromtimestamp(now).date().isoformat()
        if self.ledger and day < today and self.ledger.get(day):
            return self.ledger.get(day)               # a finished day, as it was recorded while it happened
        with self.lock:
            cached = self.stats_cache.get(day)
            if cached and 0 <= now - cached[0] < 60:
                return cached[1]
            rows = self._points(snapshot)
            points = [r for r in rows if start <= r["ts"] < end]
            result = self._stats(snapshot, day, start, end, rows, points, events)
            self.stats_cache = {k: v for k, v in self.stats_cache.items() if now - v[0] < 60}
            self.stats_cache[day] = (now, result)
        if self.ledger and (day == today or not self.ledger.get(day)):
            self.ledger.note(result)                  # today as it goes; an earlier day still in history, once
        return result

    def week(self, snapshot, n=7, events=()):
        """The last n days for the week chart: today live, earlier days from the ledger."""
        self.stats(snapshot, None, events)
        today = datetime.fromtimestamp(self.clock()).date().isoformat()
        yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
        if self.ledger and not self.ledger.get(yesterday):
            self.stats(snapshot, yesterday, events)     # history still holds part of yesterday: better than a zero
        return (self.ledger or DayLedger(None)).week(today, n)

    def _stats(self, snapshot, day, start, end, rows, points, events):
        seats, active, ids, lane_ids, limited, all_out = {}, {}, {}, {}, {}, set()

        def ensure(sid):
            if sid not in seats:
                seats[sid] = dict(active_min=0, sessions=0, lanes=0, reports=0, limits=0,
                                  tokens_fresh=0, tool_calls=0, peak_p5=None, limited_min=0)
                active[sid], ids[sid], lane_ids[sid], limited[sid] = set(), set(), set(), set()
            return seats[sid]

        for s in snapshot.get("seats", []):
            ensure(s["id"])
        snap_claude = {s["id"] for s in snapshot.get("seats", []) if s.get("kind") == "claude"}
        previous = {}
        first = dict(self.first_seen)
        for row in rows:
            if row["ts"] >= end:
                break
            in_day = row["ts"] >= start
            for sid, x in row["sessions"].items():
                first.setdefault(sid, row["ts"])
                old = previous.get(sid)
                if in_day:
                    dest = ensure(x[0])
                    ids[x[0]].add(sid)
                    if x[2] == "lane":
                        lane_ids[x[0]].add(sid)
                    if x[3] in ("working", "waiting"):
                        active[x[0]].add(int(row["ts"] // 60))
                    for i, key in ((6, "tokens_fresh"), (7, "tool_calls")):
                        baseline = old[i] if old is not None else (0 if first[sid] >= start else x[i])
                        dest[key] += max(0, (x[i] or 0) - (baseline or 0))
                if in_day:
                    previous[sid] = x
            if in_day:
                for sid, x in row["seats"].items():
                    dest = ensure(sid)
                    if x[0] is not None:
                        dest["peak_p5"] = max(dest["peak_p5"] or 0, x[0])
                    if len(x) > 5 and x[5] == 1:
                        limited[sid].add(int(row["ts"] // 60))
                claude = [x for sid, x in row["seats"].items() if sid in snap_claude]
                # no Claude seat could take work this minute, and limits are why (benched or logged-out seats were out anyway)
                if claude and all(len(x) > 5 and x[5] for x in claude) and any(x[5] == 1 for x in claude):
                    all_out.add(int(row["ts"] // 60))
        day_events = [e for e in self.events(start, end, events) if e["ts"] < end]
        for e in day_events:
            if e.get("seat") and e.get("kind") in ("report", "limit"):
                ensure(e["seat"])["reports" if e["kind"] == "report" else "limits"] += 1
        for sid, dest in seats.items():
            dest.update(active_min=len(active[sid]), sessions=len(ids[sid]), lanes=len(lane_ids[sid]), limited_min=len(limited[sid]))
        sessions = timelines(points, min(snapshot["now"], end))
        duration = lambda s: sum(b - a for a, b, _ in s["segments"]) / 60
        longest = max(sessions, key=duration, default=None)
        activity = [r["ts"] for r in points if any(x[3] in ("working", "waiting") for x in r["sessions"].values())]
        activity += [e["ts"] for e in day_events if e.get("kind") in ("report", "limit", "hire", "lane")]
        # The floor only lists the latest 40 lanes; daily totals must read all lane metadata.
        created = {l.get("id", str(i)): l.get("created_at") or 0 for i, l in enumerate(snapshot.get("lanes", []))}
        if self.lanes_path:
            for path in self.lanes_path.glob("*/lane.json"):
                try:
                    lane = json.loads(path.read_text())
                    if isinstance(lane, dict) and isinstance(lane.get("created_at"), (int, float)):
                        created[lane.get("id", path.parent.name)] = lane["created_at"]
                except (OSError, ValueError):
                    continue
        hired = sum(start <= ts < end for ts in created.values())
        office = {"sessions": len({sid for r in points for sid in r["sessions"]}),
                  "reports": sum(e.get("kind") == "report" for e in day_events),
                  "limits": sum(e.get("kind") == "limit" for e in day_events), "lanes_hired": hired, "all_out_min": len(all_out),
                  "busiest_seat": max((sid for sid in seats if seats[sid]["active_min"]),
                                      key=lambda sid: seats[sid]["active_min"], default=None),
                  "longest_session": {"name": longest["name"], "seat": longest["seat"],
                                      "minutes": round(duration(longest), 2)} if longest else None,
                  "first_activity": min(activity) if activity else None, "last_activity": max(activity) if activity else None}
        candidates = [sid for sid, s in seats.items() if s["sessions"] or s["reports"] or s["limits"]]
        # The crown goes to the most XP earned today, scored like careers (office/career.py), so a one-minute
        # report does not beat an hour of work.
        def xp(sid):
            s = seats[sid]
            return (s["tool_calls"] * XP_TOOL + s["active_min"] * XP_MINUTE + s["sessions"] * XP_SESSION
                    + s["reports"] * XP_REPORT)
        winner = max(sorted(candidates), key=lambda sid: (xp(sid), seats[sid]["reports"]), default=None)
        def n(count, word):
            return f"{count} {word}{'' if count == 1 else 's'}"

        mvp = None
        if winner:
            w = seats[winner]
            why = (f"{n(w['reports'], 'report')} and {n(w['active_min'], 'active minute')}" if w["reports"]
                   else f"the most time at work: {n(w['active_min'], 'active minute')}")
            mvp = {"seat": winner, "why": why}
        digest = []
        if winner:
            s = seats[winner]
            filed = f", {n(s['reports'], 'report')}" if s["reports"] else ""
            digest.append(f"{winner} did the most work: {n(s['active_min'], 'active minute')}{filed}.")
        for sid, s in sorted(seats.items()):
            if s["limits"]:
                digest.append(f"{sid} hit a usage limit {'once' if s['limits'] == 1 else str(s['limits']) + ' times'}.")
        if not office["reports"]:
            digest.append("Nothing filed a report today.")
        if hired:
            digest.append(f"The office hired {hired} lane{'s' if hired != 1 else ''}.")
        return public({"day": day, "seats": seats, "office": office, "mvp": mvp, "digest": digest[:5]})

// Today's goals: three small daily targets, measured from the Today numbers (/api/stats). A new set every day.
// Finishing one celebrates on the floor (app.js); the briefing shows progress (panels.js).
const sum = (st, k) => Object.values(st.seats || {}).reduce((n, s) => n + (s[k] || 0), 0);
const hm = (min) => { const m = Math.round(min); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}` : ""}`; };

// The pool: each day draws three different kinds, each at one of three difficulties, from the date (the same for
// everyone looking at the office that day). Every kind is measured from /api/stats.
const busySeats = (st) => Object.values(st.seats || {}).filter(s => (s.active_min || 0) > 0).length;
export const POOL = [
  { kind: "reports", icon: "check", targets: [3, 5, 8], label: (n) => `File ${n} reports`, have: (st) => (st.office && st.office.reports) || 0, fmt: (n) => String(n) },
  { kind: "calls", icon: "tool", targets: [600, 1000, 2000], label: (n) => `${n.toLocaleString()} tool calls`, have: (st) => sum(st, "tool_calls"), fmt: (n) => n.toLocaleString() },
  { kind: "hours", icon: "clock", targets: [180, 300, 480], label: (n) => `${n / 60} hours of agent work`, have: (st) => sum(st, "active_min"), fmt: hm },
  { kind: "sessions", icon: "users", targets: [6, 10, 16], label: (n) => `Run ${n} sessions`, have: (st) => (st.office && st.office.sessions) || 0, fmt: (n) => String(n) },
  { kind: "lanes", icon: "briefcase", targets: [1, 2, 4], label: (n) => n === 1 ? "Hire a lane" : `Hire ${n} lanes`, have: (st) => (st.office && st.office.lanes_hired) || 0, fmt: (n) => String(n) },
  { kind: "team", icon: "sparkles", targets: [2, 3, 4], label: (n) => `${n} characters at work`, have: busySeats, fmt: (n) => String(n) },
];
function hashDay(day) { let h = 2166136261; for (const ch of String(day)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

// The three goals for a day ("YYYY-MM-DD"): different kinds, each with a difficulty.
export function goalsFor(day) {
  let h = hashDay(day || "today");
  const kinds = POOL.map((g, i) => [g, i]), out = [];
  while (out.length < 3) {
    const [g] = kinds.splice(h % kinds.length, 1)[0];
    h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0;
    const target = g.targets[h % g.targets.length];
    h = Math.imul(h ^ (h >>> 11), 2246822519) >>> 0;
    out.push({ id: `${g.kind}-${target}`, icon: g.icon, label: g.label(target), target, have: g.have, fmt: g.fmt });
  }
  return out;
}

// Progress for each goal from one day's stats, or null while the numbers are not in.
export function goals(st) {
  if (!st || st.unavailable || !st.office) return null;
  return goalsFor(st.day).map(g => {
    const have = g.have(st), done = have >= g.target;
    return { id: g.id, icon: g.icon, label: g.label, done, f: Math.min(1, have / g.target),
      text: done ? "Done" : `${g.fmt(have)} of ${g.fmt(g.target)}` };
  });
}

// Days in a row with every goal done, ending today (or yesterday while today is still open). The days live in this
// browser only (a per-viewer nicety), as "YYYY-MM-DD" strings.
export function streak(days, today) {
  const have = new Set(days || []);
  const step = (d, n) => { const t = new Date(d + "T12:00:00"); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); };
  let d = have.has(today) ? today : step(today, -1), n = 0;
  while (have.has(d)) { n++; d = step(d, -1); }
  return n;
}

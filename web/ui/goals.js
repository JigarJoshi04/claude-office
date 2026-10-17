// Today's goals: three small daily targets, measured from the Today numbers (/api/stats). They reset at midnight.
// Finishing one celebrates on the floor (app.js); the briefing shows progress (panels.js).
const sum = (st, k) => Object.values(st.seats || {}).reduce((n, s) => n + (s[k] || 0), 0);
const hm = (min) => { const m = Math.round(min); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}` : ""}`; };

export const GOALS = [
  { id: "reports", icon: "check", label: "File 5 reports", target: 5, have: (st) => (st.office && st.office.reports) || 0, fmt: (n) => String(n) },
  { id: "calls", icon: "tool", label: "1,000 tool calls", target: 1000, have: (st) => sum(st, "tool_calls"), fmt: (n) => n.toLocaleString() },
  { id: "hours", icon: "clock", label: "5 hours of agent work", target: 300, have: (st) => sum(st, "active_min"), fmt: hm },
];

// Progress for each goal from one day's stats, or null while the numbers are not in.
export function goals(st) {
  if (!st || st.unavailable || !st.office) return null;
  return GOALS.map(g => {
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

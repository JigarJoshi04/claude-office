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

// Adapted to this office (app.js calls configureGoals on every snapshot): targets follow the median of the last two
// weeks (×0.8, ×1 and ×1.3, rounded), a team goal never asks for more characters than there are, and lanes come up
// only for an office that hires them. With fewer than five days on record the fixed targets above are used. A day's
// three goals are kept once drawn (they never shift as the numbers do), and one reroll a day swaps the unfinished ones.
let ctx = null;                        // { store, days: /api/week rows, seats: how many can work }
export function configureGoals(c) { ctx = c; }
const BASE = { reports: (d) => d.reports, calls: (d) => d.tool_calls, hours: (d) => d.active_min, sessions: (d) => d.sessions };
const STEP = { reports: 1, calls: 100, hours: 30, sessions: 1 };
const median = (xs) => { const v = [...xs].sort((a, b) => a - b), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
export function poolFor(day, c = ctx) {
  if (!c || !Array.isArray(c.days)) return POOL;
  const known = c.days.filter(d => d.day < day && (d.sessions || d.reports || d.active_min)).slice(-14);
  return POOL.map(g => {
    let targets = g.targets;
    if (BASE[g.kind] && known.length >= 5) {
      const m = median(known.map(BASE[g.kind])), st = STEP[g.kind], floor = Math.max(st, Math.ceil(g.targets[0] / 2 / st) * st);
      targets = [0.8, 1, 1.3].map(k => Math.max(floor, Math.round(m * k / st) * st));
      for (let i = 1; i < 3; i++) if (targets[i] <= targets[i - 1]) targets[i] = targets[i - 1] + st;   // three different steps
    }
    if (g.kind === "team") targets = targets.filter(t => t <= Math.max(1, c.seats || 0));
    if (g.kind === "lanes" && !known.some(d => d.lanes_hired)) targets = [];
    return targets.length ? { ...g, targets } : null;
  }).filter(Boolean);
}
const make = (kind, target) => { const g = POOL.find(x => x.kind === kind); return g && { id: `${kind}-${target}`, kind, icon: g.icon, label: g.label(target), target, have: g.have, fmt: g.fmt }; };
function pick(seed, pool, n, skip = new Set()) {
  let h = hashDay(seed);
  const kinds = pool.filter(g => !skip.has(g.kind)), out = [];
  while (out.length < n && kinds.length) {
    const g = kinds.splice(h % kinds.length, 1)[0];
    h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0;
    const target = g.targets[h % g.targets.length];
    h = Math.imul(h ^ (h >>> 11), 2246822519) >>> 0;
    out.push(make(g.kind, target));
  }
  return out;
}

// The three goals for a day ("YYYY-MM-DD"): different kinds, each with a difficulty.
export function goalsFor(day, c = ctx) {
  day = day || "today";
  const kept = c && c.store && c.store.get("goalsSet", null);
  if (kept && kept.day === day && Array.isArray(kept.set)) { const set = kept.set.map(x => make(x.kind, x.target)).filter(Boolean); if (set.length === 3) return set; }
  const out = pick(day, poolFor(day, c), 3);
  if (c && c.store && Array.isArray(c.days)) c.store.set("goalsSet", { day, reroll: 0, set: out.map(g => ({ kind: g.kind, target: g.target })) });
  return out;
}
// One reroll a day: the unfinished goals make way for others (the finished ones stay). True when it rerolled.
export function canReroll(day, c = ctx) { const k = c && c.store && c.store.get("goalsSet", null); return !!(k && k.day === day && !k.reroll); }
export function rerollGoals(st, c = ctx) {
  const gl = goals(st, c);
  if (!gl || !canReroll(st.day, c) || gl.every(g => g.done)) return false;
  const keep = goalsFor(st.day, c).filter((g, i) => gl[i].done);
  // Only targets not reached yet: a reroll is a new challenge, never a goal (and its gift) handed over already done.
  const open = poolFor(st.day, c).map(g => ({ ...g, targets: g.targets.filter(t => g.have(st) < t) })).filter(g => g.targets.length);
  const old = goalsFor(st.day, c), fresh = pick(st.day + "|reroll", open, 3 - keep.length, new Set(old.map(g => g.kind)));
  // A small office has few kinds: then another target of a kind it had, never the very same goal again.
  const other = open.map(g => ({ ...g, targets: g.targets.filter(t => !old.some(o => o.kind === g.kind && o.target === t)) })).filter(g => g.targets.length);
  const more = fresh.length < 3 - keep.length ? pick(st.day + "|reroll2", other, 3 - keep.length - fresh.length, new Set([...keep, ...fresh].map(g => g.kind))) : [];
  const swaps = [...fresh, ...more], set = [...old];
  for (let i = 0; i < set.length; i++) {             // each finished goal keeps its place; never two of one kind
    if (gl[i].done) continue;
    const j = swaps.findIndex(x => !set.some((g, k) => k !== i && g.kind === x.kind));
    if (j >= 0) set[i] = swaps.splice(j, 1)[0];
  }
  if (set.every((g, i) => g === old[i])) return false;
  c.store.set("goalsSet", { day: st.day, reroll: 1, set: set.map(g => ({ kind: g.kind, target: g.target })) });
  return true;
}

// Progress for each goal from one day's stats, or null while the numbers are not in (or, adapted, while the last two
// weeks are not in yet: the goals are drawn once, from them).
export function goals(st, c = ctx) {
  if (!st || st.unavailable || !st.office) return null;
  if (c && !Array.isArray(c.days)) return null;
  return goalsFor(st.day, c).map(g => {
    const have = g.have(st), done = have >= g.target;
    return { id: g.id, icon: g.icon, label: g.label, done, f: Math.min(1, have / g.target),
      text: done ? "Done" : `${g.fmt(have)} of ${g.fmt(g.target)}` };
  });
}

// Days in a row with every goal done, ending today (or yesterday while today is still open). The days live in this
// browser only (a per-viewer nicety), as "YYYY-MM-DD" strings.
export function streak(days, today) {
  const have = new Set(days || []);
  const step = (d, n) => { const t = new Date(d + "T12:00:00"); t.setDate(t.getDate() + n); return localDay(t); };
  let d = have.has(today) ? today : step(today, -1), n = 0;
  while (have.has(d)) { n++; d = step(d, -1); }
  return n;
}

// The weekly challenge: beat last week. The target is 10% above last week's reports (at least 5), so it follows the
// office's own pace. `days` is /api/week's list (oldest first, at least 14 days, ending today).
export function weekly(days) {
  if (!Array.isArray(days) || days.length < 14) return null;
  const today = new Date(days[days.length - 1].day + "T12:00:00"), dow = (today.getDay() + 6) % 7;   // Monday = 0
  const thisWeek = days.slice(days.length - 1 - dow), lastWeek = days.slice(days.length - 8 - dow, days.length - 1 - dow);
  const sum = (xs) => xs.reduce((a, d) => a + (d.reports || 0), 0);
  const last = sum(lastWeek), have = sum(thisWeek), target = Math.max(5, Math.ceil(last * 1.1));
  const known = lastWeek.filter(d => d.sessions || d.reports || d.active_min).length;
  if (known < 3) return { calibrating: true, week: thisWeek[0].day, known };   // too little of last week on record to beat
  return { week: thisWeek[0].day, have, target, last, f: Math.min(1, have / target), done: have >= target, daysLeft: 6 - dow };
}

// The week's quests: three a week, drawn from the week's start (the same for every tab), each aiming a little past
// last week (10% more, at least a floor), so they follow the office's own pace. Beating last week's reports is one
// kind. A finished quest stamps the month's punch card (game.js). `days` is /api/week's list, oldest first, ending today.
const QUESTS = [
  { kind: "reports", icon: "check", get: (d) => d.reports || 0, floor: 5, label: (n) => `File ${n} reports this week` },
  { kind: "hours", icon: "clock", get: (d) => (d.active_min || 0) / 60, floor: 10, label: (n) => `${n} hours of agent work` },
  { kind: "calls", icon: "tool", get: (d) => d.tool_calls || 0, floor: 3000, round: 500, label: (n) => `${n.toLocaleString()} tool calls` },
  { kind: "sessions", icon: "users", get: (d) => d.sessions || 0, floor: 10, label: (n) => `Run ${n} sessions` },
  { kind: "workdays", icon: "calendar", whole: true, label: (n) => `Work on ${n} days`, count: (xs) => xs.filter(d => d.sessions || d.active_min).length, fixed: 5 },
  { kind: "lanes", icon: "briefcase", get: (d) => d.lanes_hired || 0, floor: 2, label: (n) => `Hire ${n} lanes`, needs: (last) => last > 0 },
];
export function quests(days) {
  if (!Array.isArray(days) || days.length < 14) return null;
  const today = new Date(days[days.length - 1].day + "T12:00:00"), dow = (today.getDay() + 6) % 7;   // Monday = 0
  const thisWeek = days.slice(days.length - 1 - dow), lastWeek = days.slice(days.length - 8 - dow, days.length - 1 - dow);
  if (lastWeek.filter(d => d.sessions || d.reports || d.active_min).length < 3) return { calibrating: true, week: thisWeek[0].day };
  const sum = (xs, q) => (q.count ? q.count(xs) : xs.reduce((a, d) => a + q.get(d), 0));
  const pool = QUESTS.map(q => {
    const last = sum(lastWeek, q), round = q.round || 1;
    if (q.needs && !q.needs(last)) return null;
    const target = q.fixed || Math.max(q.floor, Math.ceil(last * 1.1 / round) * round);
    return { ...q, last, target };
  }).filter(Boolean);
  let h = hashDay("quests|" + thisWeek[0].day);
  const picked = [];
  while (picked.length < 3 && pool.length) { picked.push(pool.splice(h % pool.length, 1)[0]); h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0; }
  return { week: thisWeek[0].day, daysLeft: 6 - dow, quests: picked.map(q => {
    const have = sum(thisWeek, q), shown = q.kind === "hours" ? Math.floor(have * 10) / 10 : Math.floor(have);
    return { id: `${thisWeek[0].day}:${q.kind}`, kind: q.kind, icon: q.icon, label: q.label(q.target), have: shown, target: q.target, last: Math.round(q.last), f: Math.min(1, have / q.target), done: have >= q.target };
  }) };
}
// The month's punch card: the quests stamped in a month ("YYYY-MM" -> quest ids), four for a full card.
export const PUNCH = 4;
export function punch(stamps, month) { return ((stamps || {})[month] || []).length; }

// "YYYY-MM-DD" in local time (toISOString is UTC, a day off east of UTC+12 and west of UTC−12).
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

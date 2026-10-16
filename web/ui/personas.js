// Personalities: every seat is a character with a name, a role, a voice and a mood that follows its real state.

const ARCHETYPES = [
  { role: "The Orchestrator", traits: ["calm", "plans ahead", "keeps score"], motto: "Three steps ahead, one step at a time.",
    lines: { arrive: "Reporting in. Let's get organised.", report: "Done, and documented.", limit: "Out of juice. Back after the reset.", stuck: "Thinking this one through…", idle: "Ready when you are.", hello: "Atlas here. What's the plan?" } },
  { role: "The Builder", traits: ["ships fast", "tests everything", "loves a green build"], motto: "If it isn't tested, it isn't done.",
    lines: { arrive: "Hard hat on. Building.", report: "Shipped it.", limit: "Tools down until the reset.", stuck: "This one's fighting back…", idle: "Give me something to build.", hello: "Builder on deck." } },
  { role: "The Investigator", traits: ["reads every log", "asks why five times", "trusts evidence"], motto: "Show me the evidence.",
    lines: { arrive: "On the case.", report: "Case closed. Evidence attached.", limit: "Taking a nap. The clues will wait.", stuck: "Following a long trail…", idle: "Any mysteries today?", hello: "What are we investigating?" } },
  { role: "The Perfectionist", traits: ["sweats the details", "refactors for fun", "names things well"], motto: "Good enough isn't.",
    lines: { arrive: "Let's do this properly.", report: "Polished and shipped.", limit: "Resting. Perfection needs sleep.", stuck: "Getting this exactly right…", idle: "I'll be here, tidying.", hello: "Ready to make it right." } },
  { role: "The Night Owl", traits: ["unbothered by deadlines", "best after midnight", "quietly relentless"], motto: "The best work happens when it's quiet.",
    lines: { arrive: "Coffee's on. Let's go.", report: "Wrapped up while you slept.", limit: "Even owls sleep sometimes.", stuck: "Long night on this one…", idle: "Quiet in here. I like it.", hello: "Night shift reporting." } },
  { role: "The Speedrunner", traits: ["hates waiting", "parallelises everything", "competitive"], motto: "Fastest path to done.",
    lines: { arrive: "Clock's running. Go!", report: "Done. New record?", limit: "Hit the wall. Respawning at reset.", stuck: "Speedrun stalled…", idle: "Bored. Give me a challenge.", hello: "Ready, set…" } },
];
const CODEX = { role: "The Contractor", traits: ["precise", "a little formal", "bills by the window"], motto: "Scope it, ship it, invoice it.",
  lines: { arrive: "Contractor on site.", report: "Deliverable complete.", limit: "Outside contracted hours until reset.", stuck: "Reviewing the specification…", idle: "Available for the next contract.", hello: "Astra, at your service." } };
const NAMES = ["Ember", "Atlas", "Vega", "Orion", "Nova", "Juno", "Rigel", "Lyra", "Sol", "Iris"];

export function personaFor(seat, index = 0) {
  const base = seat.kind === "codex" ? CODEX : ARCHETYPES[index % ARCHETYPES.length];   // one character per seat, in order
  return {
    name: seat.nickname || (seat.kind === "codex" ? "Astra" : NAMES[index % NAMES.length]),
    role: seat.role || base.role,
    motto: seat.motto || base.motto,
    traits: base.traits,
    lines: base.lines,
  };
}

export function leftOf(seat, key) {
  const w = (seat.usage || {})[key];
  return w && w.pct != null ? Math.max(0, 100 - w.pct) : null;
}

// The tighter of the two plan windows: what actually limits this seat right now.
export function binding(seat) {
  const a = leftOf(seat, "five_hour"), b = leftOf(seat, "weekly");
  if (a == null && b == null) return { left: null, label: "plan", key: null };
  if (b == null || (a != null && a <= b)) return { left: a, label: "5-hour window", key: "five_hour" };
  return { left: b, label: "this week", key: "weekly" };
}

export function moodFor(seat, fmtTime) {
  const live = seat.sessions.filter(x => x.live !== false);
  const working = live.filter(x => x.state === "working" || x.state === "waiting").length;
  const b = binding(seat);
  const reset = b.key && seat.usage && seat.usage[b.key] && seat.usage[b.key].resets_at;
  switch (seat.status) {
    case "offline": return { mood: "Locked out", tone: "bad", detail: "needs /login on this seat" };
    case "benched": return { mood: "On holiday", tone: "info", detail: "benched on the load divider" };
    case "limited": return { mood: reset ? `Napping until ${fmtTime(reset)}` : "Napping", tone: "bad", detail: "out of plan until the reset" };
    default: break;
  }
  if (working) {
    if (b.left != null && b.left < 15) return { mood: "Running on fumes", tone: "warn", detail: `${working} at work, ${Math.round(b.left)}% of ${b.label} left` };
    if (b.left != null && b.left < 40) return { mood: "Pacing myself", tone: "warn", detail: `${working} at work` };
    return { mood: "In the zone", tone: "good", detail: `${working} at work` };
  }
  if (live.length) return { mood: "Waiting for you", tone: "idle", detail: `${live.length} session${live.length === 1 ? "" : "s"} open, none busy` };
  return { mood: "Free for work", tone: "idle", detail: "nobody at the desk" };
}

// A one-paragraph, plain-English read of the whole office.
export function pulse(snap, persona, fmtTime) {
  const t = snap.totals;
  const parts = [];
  if (!t.sessions) parts.push("The office is quiet: no agents are running.");
  else parts.push(`${t.working ? (t.working === 1 ? "One agent is" : `${words(t.working)} agents are`) : "No agents are"} working${t.sessions > t.working ? `, ${t.sessions - t.working} more ${t.sessions - t.working === 1 ? "is" : "are"} idle` : ""}.`);
  const tight = snap.seats.filter(s => s.status !== "benched" && s.status !== "offline")
    .map(s => ({ s, b: binding(s) })).filter(x => x.b.left != null).sort((a, b) => a.b.left - b.b.left)[0];
  const spent = snap.seats.filter(s => s.status === "limited");
  if (spent.length) {
    const s = spent[0], r = s.usage && s.usage.five_hour && s.usage.five_hour.resets_at;
    parts.push(`${persona(s).name} is out of plan${r ? ` until ${fmtTime(r)}` : ""}.`);
  } else if (tight && tight.b.left < 35) {
    const r = tight.s.usage[tight.b.key] && tight.s.usage[tight.b.key].resets_at;
    parts.push(`${persona(tight.s).name} is lowest, with ${Math.round(tight.b.left)}% of its ${tight.b.label} left${r ? ` (resets ${fmtTime(r)})` : ""}.`);
  }
  const np = snap.next_pick;
  const next = np.seat && snap.seats.find(s => s.id === np.seat);
  parts.push(next ? `The next lane would go to ${persona(next).name}.` : "No seat can take a new lane right now.");
  return parts.join(" ");
}
function words(n) { return ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"][n] || String(n); }

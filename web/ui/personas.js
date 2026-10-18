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
// Extra lines shared by everyone, so the office never sounds like a loop.
const COMMON = {
  arrive: ["Morning, team.", "Let's get to it.", "Found my desk!", "Plugging in."],
  report: ["Report's in.", "That's a wrap.", "Ticket closed.", "Done and dusted."],
  limit: ["Brain full. Back after the reset.", "Out of plan. Nap time.", "Hit the limit. See you at the reset."],
  stuck: ["Still on it…", "This one's stubborn.", "Bear with me."],
  reset: ["Fresh window. Let's go!", "Recharged.", "Back in business."],
  levelup: ["Level up!", "Moving up in the world.", "New title, same desk.", "Promotion! Drinks on me."],
  achievement: ["Achievement unlocked!", "Put that on my wall.", "Another one for the trophy shelf."],
};
// Status in each character's own voice, for every state the office knows. t = a reset time, n = sessions at work.
const VOICE = {
  "The Orchestrator": { working: n => n > 1 ? `Running ${n} threads. All on plan.` : "On it. Everything is on plan.", waiting: "Ready for the next step when you are.",
    free: "Desk is clear. What's the plan?", limited: t => `Out of plan. Back at ${t}, notes are in order.`, benched: "On holiday. The plan can wait.",
    offline: "Locked out. Run /login and I'm back.", stuck: "Rethinking this one…" },
  "The Builder": { working: n => n > 1 ? `${n} builds going. Hard hat on.` : "Building. Tests come next.", waiting: "Built it. Waiting for your call.",
    free: "Give me something to build.", limited: t => `Tools down until ${t}.`, benched: "On holiday. No building today.",
    offline: "Locked out of the workshop. /login, please.", stuck: "This one is fighting back…" },
  "The Investigator": { working: n => n > 1 ? `Working ${n} cases at once.` : "Following the evidence.", waiting: "I have findings. Your move.",
    free: "Any mysteries today?", limited: t => `Napping until ${t}. The clues will keep.`, benched: "Off the case for now.",
    offline: "Locked out. /login and I pick up the trail.", stuck: "Following a long trail…" },
  "The Perfectionist": { working: n => n > 1 ? `${n} things, each done properly.` : "Getting it exactly right.", waiting: "Polished. Have a look?",
    free: "Tidying while I wait.", limited: t => `Resting until ${t}. Perfection needs sleep.`, benched: "On holiday. Everything is in its place.",
    offline: "Locked out. Untidy. /login, please.", stuck: "Not quite right yet…" },
  "The Night Owl": { working: n => n > 1 ? `${n} quiet jobs on the go.` : "Quietly getting it done.", waiting: "Done for now. Coffee's still warm.",
    free: "Quiet in here. I like it.", limited: t => `Even owls sleep. Back at ${t}.`, benched: "Off shift.",
    offline: "Locked out in the dark. /login?", stuck: "Long night on this one…" },
  "The Speedrunner": { working: n => n > 1 ? `${n} runs at once. New record incoming.` : "Going fast. Don't blink.", waiting: "Done! What's next?",
    free: "Bored. Give me a challenge.", limited: t => `Hit the wall. Respawning at ${t}.`, benched: "Benched. Unfair, but fine.",
    offline: "Logged out. Run ruined. /login!", stuck: "Speedrun stalled…" },
  "The Contractor": { working: n => n > 1 ? `${n} contracts in progress.` : "Delivering the contract.", waiting: "Deliverable ready for review.",
    free: "Available for the next contract.", limited: t => `Outside contracted hours until ${t}.`, benched: "Not on contract right now.",
    offline: "Credentials expired. /login, please.", stuck: "Reviewing the specification…" },
};
// One or two words for tiles and doors, and the tone that colours them.
const WORD = { working: ["In the zone", "good"], waiting: ["Waiting for you", "warn"], free: ["Free", "idle"], limited: ["Napping", "bad"],
  benched: ["On holiday", "info"], offline: ["Locked out", "bad"], stuck: ["Stuck", "warn"] };

function stateOf(seat) {
  if (seat.status === "offline") return "offline";
  if (seat.status === "benched") return "benched";
  if (seat.status === "limited") return "limited";
  const live = seat.sessions.filter(x => x.live !== false);
  if (live.some(x => x.state === "stuck")) return "stuck";
  if (live.some(x => x.state === "working" || x.state === "waiting")) return "working";
  return live.length ? "waiting" : "free";
}

// What a character says about itself right now: { state, line, word, tone }.
export function voice(seat, p, fmtTime) {
  const st = stateOf(seat), v = VOICE[p.archetype] || VOICE["The Orchestrator"];
  const working = seat.sessions.filter(x => x.live !== false && (x.state === "working" || x.state === "waiting")).length;
  const b = binding(seat), w = b.key && seat.usage && seat.usage[b.key];
  const reset = w && w.resets_at ? fmtTime(w.resets_at) : "the reset";
  const raw = v[st];
  const text = typeof raw === "function" ? raw(st === "limited" ? reset : working) : raw;
  const [word, tone] = WORD[st];
  return { state: st, line: text, word: st === "limited" && w && w.resets_at ? `Back ${fmtTime(w.resets_at)}` : word, tone };
}

// Teammates react to each other's news. {name} is the teammate the line is about.
const REACT = {
  report: ["Nice one, {name}!", "{name} ships again.", "Another one for {name}.", "Good work, {name}."],
  levelup: ["Congrats, {name}!", "Level up, {name}! Drinks later?", "{name} is moving up."],
  limit: ["I've got room. Send {name}'s work my way.", "Rest up, {name}. I'll cover.", "Out already, {name}? I'm here."],
};
export function reaction(kind, aboutName) {
  const pool = REACT[kind] || [];
  return pool.length ? pool[Math.floor(Math.random() * pool.length)].replace("{name}", aboutName) : "";
}

// A first-person line about today, from the day's stats: "Today I spent 1 h at work in 3 sessions…".
export function diary(p, st) {
  if (!st || (!st.active_min && !st.sessions)) return `Nothing yet today. ${p.lines.idle}`;
  const h = st.active_min >= 60 ? `${Math.floor(st.active_min / 60)} h ${st.active_min % 60} min` : `${st.active_min} min`;
  const bits = [`spent ${h} at work in ${st.sessions} session${st.sessions === 1 ? "" : "s"}`];
  if (st.tool_calls) bits.push(`made ${st.tool_calls.toLocaleString()} tool call${st.tool_calls === 1 ? "" : "s"}`);
  if (st.reports) bits.push(`filed ${st.reports} report${st.reports === 1 ? "" : "s"}`);
  if (st.limits) bits.push(`hit the limit ${st.limits === 1 ? "once" : st.limits + " times"}`);
  const last = bits.pop();
  return `Today I ${bits.length ? bits.join(", ") + " and " : ""}${last}.`;
}

export function line(p, key) {
  const own = p.lines[key] ? [p.lines[key]] : [];
  const pool = own.concat(own, COMMON[key] || []);       // a character's own line comes up twice as often
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : "";
}

export function personaFor(seat, index = 0) {
  index = Math.max(0, index);                 // a seat not (yet) in the list still gets a character
  const chosen = seat.style && [...ARCHETYPES, CODEX].find(a => a.role === seat.style);   // a personality picked in Settings
  const base = chosen || (seat.kind === "codex" ? CODEX : ARCHETYPES[index % ARCHETYPES.length]);   // else one per seat, in order
  return {
    name: seat.nickname || (seat.kind === "codex" ? "Astra" : NAMES[index % NAMES.length]),
    archetype: base.role,          // the voice and room decor follow the archetype, even under a custom role
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
  const all = snap.seats.flatMap(s => s.sessions.filter(x => x.live !== false));
  const working = all.filter(x => x.state === "working" || x.state === "waiting").length;
  const stopped = all.filter(x => x.state === "limited" || x.state === "stuck").length;
  const idle = all.length - working - stopped;
  if (!all.length) parts.push("The office is quiet: no agents are running.");
  else {
    const rest = [idle ? `${words(idle).toLowerCase()} ${idle === 1 ? "is" : "are"} idle` : "", stopped ? `${words(stopped).toLowerCase()} ${stopped === 1 ? "is" : "are"} stopped` : ""].filter(Boolean);
    parts.push(`${working ? (working === 1 ? "One agent is" : `${words(working)} agents are`) : "No agents are"} working${rest.length ? ", " + rest.join(" and ") : ""}.`);
  }
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

// The personalities a seat can take (Settings → Characters): each brings its own voice, room floor and furniture.
export const PERSONALITIES = [...ARCHETYPES, CODEX].map(a => ({ role: a.role, motto: a.motto }));

// Banter: now and then two characters at their desks trade a line about what is going on. `a` speaks first, `b`
// answers; {a}, {b} and {c} (a third character the lines are about) are names. The first exchange whose condition
// holds is a candidate; one is picked at random among the candidates.
const BANTER = [
  { when: (o) => o.napping, lines: [["{c}'s napping again.", "Let them. They earned it."], ["Is {c} out of plan?", "Back after the reset. More coffee for us."]] },
  { when: (o) => o.busy >= 3, lines: [["Busy floor today.", "Heads down. Ship it."], ["Three builds at once?", "Four if you count mine."], ["How many sessions are we running?", "Enough that the elevator's tired."]] },
  { when: (o) => o.recentReport, lines: [["Did you see {c}'s report?", "Clean work. Raising the bar."], ["Another one shipped.", "That's the combo going."]] },
  { when: (o) => o.lowPlan, lines: [["{c}'s running low.", "Send the next lane my way."], ["Pace yourself, {c}.", "Says the one at 90%."]] },
  { when: (o) => o.night, lines: [["Still here?", "The best work happens when it's quiet."], ["Night shift crew.", "Somebody has to keep the lights on."]] },
  { when: () => true, lines: [["Coffee?", "Always."], ["What are you on?", "Same thing as you, but with tests."], ["The cat's on my keyboard again.", "That's not a bug, that's Pixel."],
    ["Any word from the CEO?", "Only good news so far."], ["Nice desk upgrade.", "Level ups have perks."], ["Lunch at the lounge?", "After this build."]] },
];
export function banter(o) {
  const pool = BANTER.filter(b => b.when(o)).flatMap(b => b.lines.map(l => ({ l, w: b.when === BANTER[BANTER.length - 1].when ? 1 : 3 })));
  const total = pool.reduce((n, x) => n + x.w, 0);
  let r = Math.random() * total;
  const pick = pool.find(x => (r -= x.w) < 0) || pool[0];
  const fill = (s) => s.replace("{a}", o.a).replace("{b}", o.b).replace("{c}", o.c || o.b);
  return [fill(pick.l[0]), fill(pick.l[1])];
}

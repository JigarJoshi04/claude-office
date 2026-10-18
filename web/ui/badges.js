// Badges for the CEO (the person at the screen), earned by using the office. They live in this browser only: a
// per-viewer nicety, like the goal streak. award() returns the badge when it is new, so the caller can celebrate.
import { store } from "./util.js";

export const BADGES = [
  { id: "welcome", icon: "sparkles", name: "Welcome aboard", desc: "Open the office for the first time." },
  { id: "inbox_zero", icon: "check", name: "Inbox zero", desc: "Clear everything in Needs you." },
  { id: "hiring", icon: "briefcase", name: "Hiring manager", desc: "Hire a lane from the office." },
  { id: "talker", icon: "chat", name: "Open door", desc: "Send 10 messages to your agents." },
  { id: "time_traveller", icon: "rewind", name: "Time traveller", desc: "Replay the day on the floor." },
  { id: "big_screen", icon: "tv", name: "Big screen", desc: "Put the office in TV mode." },
  { id: "show_and_tell", icon: "star", name: "Show and tell", desc: "Share today's card." },
  { id: "hot_streak", icon: "flame", name: "Hot streak", desc: "Reach a ×3 combo." },
  { id: "clean_sweep", icon: "trophy", name: "Clean sweep", desc: "Finish all three goals in a day." },
  { id: "consistent", icon: "calendar", name: "Consistent", desc: "Finish every goal three days in a row." },
  { id: "record_week", icon: "flame", name: "Record week", desc: "Beat last week's reports." },
  { id: "regular", icon: "flame", name: "Regular", desc: "Check on the office seven days in a row." },
  { id: "collector", icon: "gift", name: "Collector", desc: "Collect 12 different stickers from gifts." },
  { id: "golden", icon: "sparkles", name: "Golden duck", desc: "Find the legendary golden duck." },
  { id: "exterminator", icon: "bug", name: "Exterminator", desc: "Score 40 in Bug Squash, the lounge's arcade game." },
  { id: "cat_person", icon: "heart", name: "Pet person", desc: "Pet the office cat (or the dog) ten times." },
  { id: "night_owl", icon: "moon", name: "Night owl", desc: "Check on the office between midnight and 4 AM." },
  { id: "early_bird", icon: "sun", name: "Early bird", desc: "Check on the office between 5 and 7 AM." },
];

export const earned = () => store.get("badges", {});

export function award(id) {
  const b = BADGES.find(x => x.id === id), have = earned();
  if (!b || have[id]) return null;
  have[id] = Math.floor(Date.now() / 1000);
  store.set("badges", have);
  return b;
}

// How far along the counted badges are, as id -> [have, need]. Counters live in this browser; the rest is passed in.
export function progress({ visits = 0, stickers = 0, best = 0 } = {}) {
  const c = store.get("counts", {});
  return { talker: [c.messages || 0, 10], cat_person: [c.pets || 0, 10], collector: [stickers, 12], regular: [visits, 7], exterminator: [best, 40] };
}
// The unearned badge closest to done (at least a third of the way), for a nudge in the briefing.
export function nextBadge(prog, have = earned()) {
  let best = null;
  for (const [id, [n, need]] of Object.entries(prog)) {
    if (have[id] || n >= need || n / need < 1 / 3) continue;
    if (!best || n / need > best.n / best.need) best = { badge: BADGES.find(b => b.id === id), n, need };
  }
  return best && best.badge ? best : null;
}

// A counter-backed badge: award it once the count reaches n.
export function bump(key, n, id) {
  const c = (store.get("counts", {})[key] || 0) + 1;
  store.set("counts", { ...store.get("counts", {}), [key]: c });
  return c >= n ? award(id) : null;
}

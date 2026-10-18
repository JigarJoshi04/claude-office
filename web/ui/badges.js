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

// A counter-backed badge: award it once the count reaches n.
export function bump(key, n, id) {
  const c = (store.get("counts", {})[key] || 0) + 1;
  store.set("counts", { ...store.get("counts", {}), [key]: c });
  return c >= n ? award(id) : null;
}

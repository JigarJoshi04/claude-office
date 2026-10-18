// Gifts: a report or a finished lane may leave a gift box on the floor for the CEO, and the first visit of a day finds
// one at the CEO desk. Opening one adds a sticker to the album. Five spare stickers swap for a gift that is rare or
// better. Waiting gifts and the album live in this browser, like badges; the demo office keeps them in memory only.
import { STICKERS, RARITY, rollSticker } from "../engine/stickers.js";

export const MAX_WAITING = 3;          // more than this on the floor is clutter: later gifts are skipped
export const KEEP_S = 24 * 3600;       // an unopened gift goes back after a day
export const CHANCE = 0.45;            // a report's chance of a gift…
export const PITY = 3;                 // …but never three reports in a row without one
export const SWAP = 5;                 // spares for one rare-or-better gift
export const HAPPY_CHANCE = 0.9;       // during the day's happy hour
export const GRANT_ROOM = 2;           // earned-for-sure gifts (goals, level-ups) may go this far over the cap

// The day's happy hour: half an hour between 11:00 and 17:30 local time, the same for every tab on a given day.
export function happyHourFor(day) {
  let h = 2166136261;
  for (const ch of "happy|" + day) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const slot = h % 14;                 // 11:00, 11:30, … 17:30
  return { hour: 11 + Math.floor(slot / 2), minute: (slot % 2) * 30, minutes: 30 };
}
export function happyNow(d = new Date()) {
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hh = happyHourFor(day), start = new Date(d); start.setHours(hh.hour, hh.minute, 0, 0);
  const end = new Date(start.getTime() + hh.minutes * 60000);
  return { on: d >= start && d < end, start, end, left: Math.max(0, Math.ceil((end - d) / 60000)) };
}

const ORDER = Object.keys(RARITY);

// The album sets: finishing every sticker of a rarity puts something on the floor.
export const SETS = {
  common: { name: "Sticker wall", desc: "Stickers all over the lobby's back wall." },
  rare: { name: "Lava lamps", desc: "A lava lamp on every desk." },
  epic: { name: "Close encounters", desc: "A UFO crosses the sky now and then." },
  legendary: { name: "The golden duck", desc: "The golden duck sits on the CEO's desk." },
};
export function setsDone(album) {
  return new Set(Object.keys(RARITY).filter(k => STICKERS.filter(s => s.rarity === k).every(s => album[s.id])));
}

export function makeGifts({ store, demo = false, now = () => Date.now() / 1000, rand = Math.random, happy = () => false }) {
  const mem = new Map();
  const get = (k, d) => (demo ? (mem.has(k) ? mem.get(k) : d) : store.get(k, d));
  const set = (k, v) => (demo ? mem.set(k, v) : store.set(k, v));
  const waiting = () => get("gifts", []).filter(g => now() - g.at < KEEP_S);
  let seq = 0;
  const add = (g, room = 0) => {
    const list = waiting();
    if (list.length >= MAX_WAITING + room) return null;
    const gift = { id: Math.floor(now() * 1000).toString(36) + "-" + (seq++).toString(36), at: now(), ...g };
    set("gifts", [...list, gift]);
    return gift;
  };
  const album = () => get("album", {});
  const spares = () => Object.values(album()).reduce((n, x) => n + Math.max(0, x.n - 1), 0);

  return {
    waiting, album, spares,
    // The demo's ?stickers=all: a full album, in memory, to show what the sets put on the floor.
    fillDemo() { if (demo) set("album", Object.fromEntries(STICKERS.map(s => [s.id, { n: 1, first: now() }]))); },
    // A report or a finished lane: maybe a gift from that seat.
    earn(seat, from = "report", name) {
      if (waiting().length >= MAX_WAITING) return null;
      const miss = get("giftMiss", 0);
      if (miss + 1 < PITY && rand() >= (happy() ? HAPPY_CHANCE : CHANCE)) { set("giftMiss", miss + 1); return null; }
      set("giftMiss", 0);
      return add({ seat, from, ...(name ? { name } : {}) });   // the name stays with the gift if the seat leaves
    },
    // A gift earned for sure: all goals done, a level up, a big combo. `min` lifts the rarity.
    grant(seat, from, min, name) { return add({ seat, from, ...(min ? { min } : {}), ...(name ? { name } : {}) }, GRANT_ROOM); },
    // The first visit of a local day: a morning delivery at the CEO desk. A visit streak makes it better: from three
    // days in a row it is rare or better, and every seventh day epic or better. With the floor full it waits for room.
    daily(day, streak = 0) {
      if (get("giftDay", "") === day) return null;
      const min = streak >= 7 && streak % 7 === 0 ? "epic" : streak >= 3 ? "rare" : null;
      const g = add({ seat: null, from: "daily", ...(min ? { min, streak } : {}) });
      if (g) set("giftDay", day);
      return g;
    },
    // Swap the most-duplicated spares for a gift that is rare or better.
    swap() {
      if (spares() < SWAP || waiting().length >= MAX_WAITING + GRANT_ROOM) return null;
      const al = { ...album() };
      for (let left = SWAP; left > 0;) {
        const [id] = Object.entries(al).filter(([, x]) => x.n > 1).sort((a, b) => ORDER.indexOf(STICKERS.find(s => s.id === a[0]).rarity) - ORDER.indexOf(STICKERS.find(s => s.id === b[0]).rarity) || b[1].n - a[1].n)[0];
        al[id] = { ...al[id], n: al[id].n - 1 };
        left--;
      }
      set("album", al);
      return add({ seat: null, from: "swap", min: "rare" }, GRANT_ROOM);
    },
    open(id) {
      const list = waiting(), g = list.find(x => x.id === id);
      if (!g) return null;
      set("gifts", list.filter(x => x.id !== id));
      const min = ORDER.indexOf(g.min || "common");
      let st = rollSticker(rand);
      for (let i = 0; i < 50 && ORDER.indexOf(st.rarity) < min; i++) st = rollSticker(rand);
      if (ORDER.indexOf(st.rarity) < min) st = STICKERS.find(s => s.rarity === g.min);
      const al = { ...album() }, had = al[st.id];
      al[st.id] = { n: (had ? had.n : 0) + 1, first: had ? had.first : now() };
      set("album", al);
      return { gift: g, sticker: st, isNew: !had, count: al[st.id].n, have: Object.keys(al).length, total: STICKERS.length };
    },
  };
}

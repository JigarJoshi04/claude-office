// Gifts: a report or a finished lane may leave a gift box on the floor for the CEO, and the first visit of a day finds
// one at the CEO desk. Opening one adds a sticker to the album. Five spare stickers swap for a gift that is rare or
// better. No gift is lost: one that finds the floor full, or waits there unopened for a day, goes to the mailroom and
// comes back to the floor as room frees up. The last 50 openings are logged (where each sticker came from).
// Waiting gifts and the album live in this browser, like badges; the demo office keeps them in memory only.
import { STICKERS, RARITY, rollSticker, teamSticker } from "../engine/stickers.js";
import { seasonFor } from "../engine/season.js";

export const MAX_WAITING = 3;          // more than this on the floor is clutter: later gifts wait in the mailroom
export const KEEP_S = 24 * 3600;       // an unopened gift goes to the mailroom after a day
export const MAILROOM = 30;            // the mailroom's pigeonholes (past this, the oldest plain gift there goes back)
export const LOG = 50;                 // openings remembered
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
  seasonal: { name: "Through the year", desc: "Every season's sticker: they only turn up in their season." },
};
export function setsDone(album) {
  return new Set(Object.keys(RARITY).filter(k => STICKERS.filter(s => s.rarity === k).every(s => album[s.id])));
}
// The team set is done when every character on the floor (two or more) has its sticker in the album.
export const teamDone = (album, seatIds) => seatIds.length >= 2 && seatIds.every(id => album["team-" + id]);

export const TEAM_CHANCE = 0.25;    // a character's gift holds its team sticker one time in four
export function makeGifts({ store, demo = false, now = () => Date.now() / 1000, rand = Math.random, happy = () => false, team = () => null }) {
  const mem = new Map();
  const get = (k, d) => (demo ? (mem.has(k) ? mem.get(k) : d) : store.get(k, d));
  const set = (k, v) => (demo ? mem.set(k, v) : store.set(k, v));
  // Gifts opened on any screen (the save keeps them for every screen), so a copy another screen still holds never
  // comes back to be opened twice.
  const opened = () => new Set(get("giftOpened", []));
  const mailroom = () => { const o = opened(), m = get("mailroom", []); return o.size ? m.filter(g => !o.has(g.id)) : m; };
  // Over the cap the oldest plain gift goes; one that promises something (a swap, a rarity) never does.
  const toMail = (list) => {
    const m = [...mailroom(), ...list];
    while (m.length > MAILROOM) { const i = m.findIndex(g => !g.min && g.from !== "swap"); if (i < 0) break; m.splice(i, 1); }
    set("mailroom", m.slice(-2 * MAILROOM));          // and a hard stop, however many promises
  };
  // The floor's gifts; any that waited a day unopened move to the mailroom.
  const waiting = () => {
    const o = opened(), all = get("gifts", []).filter(g => !o.has(g.id)), fresh = all.filter(g => now() - g.at < KEEP_S);
    if (fresh.length < all.length) { set("gifts", fresh); toMail(all.filter(g => now() - g.at >= KEEP_S).map(g => ({ ...g, late: true }))); }
    return fresh;
  };
  let seq = 0;
  // A new gift: on the floor while it has room, else in the mailroom ({ mail: true } says which).
  const add = (g, room = 0) => {
    const list = waiting();
    if (g.id && (opened().has(g.id) || list.some(x => x.id === g.id) || mailroom().some(x => x.id === g.id))) return null;   // a once-a-day gift another screen gave
    const gift = { id: Math.floor(now() * 1000).toString(36) + "-" + (seq++).toString(36), at: now(), ...g };
    if (list.length >= MAX_WAITING + room) { toMail([gift]); return { ...gift, mail: true }; }
    set("gifts", [...list, gift]);
    return gift;
  };
  const album = () => get("album", {});
  const spares = () => Object.entries(album()).reduce((n, [id, x]) => n + (id.startsWith("team-") ? 0 : Math.max(0, x.n - 1)), 0);   // team stickers are never swapped

  return {
    waiting, album, spares, mailroom,
    log: () => get("giftLog", []),
    // Room on the floor: the mailroom's oldest gift comes out (a fresh day to open it). Returns it, or null.
    restock() {
      const list = waiting(), m = mailroom();
      if (!m.length || list.length >= MAX_WAITING) return null;
      const [g, ...rest] = m, back = { ...g, at: now(), late: undefined };
      set("mailroom", rest); set("gifts", [...list, back]);
      return back;
    },
    // The demo's ?stickers=all: a full album, in memory, to show what the sets put on the floor.
    fillDemo(seatIds = []) { if (demo) set("album", Object.fromEntries([...STICKERS.map(s => s.id), ...seatIds.map(id => "team-" + id)].map(id => [id, { n: 1, first: now() }]))); },
    // A report or a finished lane: maybe a gift from that seat.
    earn(seat, from = "report", name) {
      const miss = get("giftMiss", 0);
      if (miss + 1 < PITY && rand() >= (happy() ? HAPPY_CHANCE : CHANCE)) { set("giftMiss", miss + 1); return null; }
      set("giftMiss", 0);
      return add({ seat, from, ...(name ? { name } : {}) });   // the name stays with the gift if the seat leaves
    },
    // A gift earned for sure: all goals done, a level up, a big combo. `min` lifts the rarity.
    grant(seat, from, min, name, id) { return add({ seat, from, ...(min ? { min } : {}), ...(name ? { name } : {}), ...(id ? { id } : {}) }, GRANT_ROOM); },
    // The first visit of a local day: a morning delivery at the CEO desk. A visit streak makes it better: from three
    // days in a row it is rare or better, and every seventh day epic or better. With the floor full it waits for room.
    daily(day, streak = 0) {
      if (get("giftDay", "") === day) return null;
      const min = streak >= 7 && streak % 7 === 0 ? "epic" : streak >= 3 ? "rare" : null;
      const g = add({ id: "daily-" + day, seat: null, from: "daily", ...(min ? { min, streak } : {}) });
      if (g) set("giftDay", day);
      return g;
    },
    // Swap the most-duplicated spares for a gift that is rare or better.
    swap() {
      if (spares() < SWAP) return null;
      const al = { ...album() };
      for (let left = SWAP; left > 0;) {
        const [id] = Object.entries(al).filter(([k, x]) => x.n > 1 && !k.startsWith("team-")).sort((a, b) => ORDER.indexOf(STICKERS.find(s => s.id === a[0]).rarity) - ORDER.indexOf(STICKERS.find(s => s.id === b[0]).rarity) || b[1].n - a[1].n)[0];
        al[id] = { ...al[id], n: al[id].n - 1 };
        left--;
      }
      set("album", al);
      return add({ seat: null, from: "swap", min: "rare" }, GRANT_ROOM);
    },
    open(id) {
      const list = waiting(), m = mailroom(), g = list.find(x => x.id === id) || m.find(x => x.id === id);
      if (!g) return null;
      if (list.includes(g)) set("gifts", list.filter(x => x.id !== id)); else set("mailroom", m.filter(x => x.id !== id));
      set("giftOpened", [...get("giftOpened", []).filter(x => x !== id), id].slice(-400));
      const min = ORDER.indexOf(g.min || "common"), season = seasonFor(new Date(now() * 1000));
      const rank = (x) => (x.rarity === "seasonal" || x.rarity === "team" ? 1 : ORDER.indexOf(x.rarity));     // seasonal and team stickers count as rare
      const mate = g.seat ? team(g.seat) : null;            // {id, name, color}: the character the gift came from
      let st = mate && rand() < TEAM_CHANCE ? teamSticker(mate.id, mate.name, mate.color) : rollSticker(rand, season);
      for (let i = 0; i < 50 && rank(st) < min; i++) st = rollSticker(rand, season);
      if (rank(st) < min) st = STICKERS.find(s => s.rarity === g.min);
      const al = { ...album() }, had = al[st.id];
      al[st.id] = { n: (had ? had.n : 0) + 1, first: had ? had.first : now() };
      set("album", al);
      set("giftLog", [{ at: now(), sticker: st.id, from: g.from, seat: g.seat || null, name: g.name || null, isNew: !had }, ...get("giftLog", [])].slice(0, LOG));
      return { gift: g, sticker: st, isNew: !had, count: al[st.id].n, have: Object.keys(al).filter(k => !k.startsWith("team-")).length, total: STICKERS.length };
    },
  };
}

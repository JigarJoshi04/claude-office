// Gifts: a report or a finished lane may leave a gift box on the floor for the CEO, and the first visit of a day finds
// one at the CEO desk. Opening one adds a sticker to the album. Five spare stickers swap for a gift that is rare or
// better. Waiting gifts and the album live in this browser, like badges; the demo office keeps them in memory only.
import { STICKERS, RARITY, rollSticker } from "../engine/stickers.js";

export const MAX_WAITING = 3;          // more than this on the floor is clutter: later gifts are skipped
export const KEEP_S = 24 * 3600;       // an unopened gift goes back after a day
export const CHANCE = 0.45;            // a report's chance of a gift…
export const PITY = 3;                 // …but never three reports in a row without one
export const SWAP = 5;                 // spares for one rare-or-better gift

const ORDER = Object.keys(RARITY);

export function makeGifts({ store, demo = false, now = () => Date.now() / 1000, rand = Math.random }) {
  const mem = new Map();
  const get = (k, d) => (demo ? (mem.has(k) ? mem.get(k) : d) : store.get(k, d));
  const set = (k, v) => (demo ? mem.set(k, v) : store.set(k, v));
  const waiting = () => get("gifts", []).filter(g => now() - g.at < KEEP_S);
  let seq = 0;
  const add = (g) => {
    const list = waiting();
    if (list.length >= MAX_WAITING) return null;
    const gift = { id: Math.floor(now() * 1000).toString(36) + "-" + (seq++).toString(36), at: now(), ...g };
    set("gifts", [...list, gift]);
    return gift;
  };
  const album = () => get("album", {});
  const spares = () => Object.values(album()).reduce((n, x) => n + Math.max(0, x.n - 1), 0);

  return {
    waiting, album, spares,
    // A report or a finished lane: maybe a gift from that seat.
    earn(seat, from = "report") {
      if (waiting().length >= MAX_WAITING) return null;
      const miss = get("giftMiss", 0);
      if (miss + 1 < PITY && rand() >= CHANCE) { set("giftMiss", miss + 1); return null; }
      set("giftMiss", 0);
      return add({ seat, from });
    },
    // The first visit of a local day: a morning delivery at the CEO desk.
    daily(day) {
      if (get("giftDay", "") === day) return null;
      set("giftDay", day);
      return add({ seat: null, from: "daily" });
    },
    // Swap the most-duplicated spares for a gift that is rare or better.
    swap() {
      if (spares() < SWAP || waiting().length >= MAX_WAITING) return null;
      const al = { ...album() };
      for (let left = SWAP; left > 0;) {
        const [id] = Object.entries(al).filter(([, x]) => x.n > 1).sort((a, b) => ORDER.indexOf(STICKERS.find(s => s.id === a[0]).rarity) - ORDER.indexOf(STICKERS.find(s => s.id === b[0]).rarity) || b[1].n - a[1].n)[0];
        al[id] = { ...al[id], n: al[id].n - 1 };
        left--;
      }
      set("album", al);
      return add({ seat: null, from: "swap", min: "rare" });
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

// One save for the CEO's game (office/save.py): the album, badges, gifts, streaks, bests and templates are the same on
// every screen. The page keeps the office's copy of each key as it last saw it (the base) and merges three ways: what
// this screen changed since the base goes on top of what the office has now, so two screens never undo each other.
// Counters add up their changes (a sticker swapped away stays swapped; two gifts opened on two screens count twice),
// lists keep everyone's additions and removals (templates by name, gifts by id), day lists join. A write carries the
// version it was based on; the office refuses a stale one and sends its copy back to merge with, then it goes again.
// The page merges on load (and reloads once if its copy changed), and again when it comes back into view. Settings
// exports and imports the whole save.
import { store, setStoreHook, toast } from "./util.js";

export const SYNC = new Set(["album", "badges", "counts", "gifts", "giftLog", "giftMiss", "giftDay", "mailroom", "goalDays", "questStamps",
  "squashBest", "squashDays", "squashGiftDay", "visits", "combo", "officeLevel", "milestone", "milestoneGift", "tokRecords", "tokRecordsDay",
  "weeklyDone", "frozenDays", "freezes", "freezeDay", "happyDay", "anniversaries", "lanesHired", "myTemplates", "belt", "giftOpened", "chapterBase", "chapterClaimed"]);

const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
const arr = (x) => (Array.isArray(x) ? x : []);
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A counter: the office's value plus what this screen added or spent since the base (without a base, the larger).
const count = (l, s, b, known) => Math.max(0, known ? num(s) + num(l) - num(b) : Math.max(num(l), num(s)));
const days = (cap) => (l, s) => [...new Set([...arr(l), ...arr(s)])].sort().slice(-cap);
// A list of things with an identity: the office's list, less what this screen removed since the base, plus what it
// added or changed. Without a base nothing is removed (two screens' separate lists join).
const byId = (id, cap) => (l, s, b, known) => {
  const L = new Map(arr(l).map(x => [id(x), x])), B = new Map(arr(b).map(x => [id(x), x])), out = [], seen = new Set();
  for (const x of arr(s)) {
    const k = id(x);
    if (seen.has(k)) continue;
    seen.add(k);
    if (known && B.has(k) && !L.has(k)) continue;                       // removed here
    out.push(L.has(k) && (!known || !B.has(k) || !same(L.get(k), B.get(k))) ? L.get(k) : x);
  }
  for (const x of arr(l)) {                                            // added here (not ones the office has since removed)
    const k = id(x);
    if (seen.has(k) || (known && B.has(k) && same(x, B.get(k)))) continue;
    seen.add(k); out.push(x);
  }
  return cap ? cap(out) : out;
};
const giftKey = (g) => (g && (g.id ?? JSON.stringify(g)));

// How two copies of one key become one. (local, server, base, baseKnown) → merged. Keys without a rule take this
// screen's copy when it changed since the base, the office's otherwise (and the newer write without a base).
export const MERGE = {
  album: (l, s, b, known) => {
    const o = {}, L = obj(l), S = obj(s), B = known ? obj(b) : {};
    for (const id of new Set([...Object.keys(L), ...Object.keys(S)])) {
      const x = L[id] || {}, y = S[id] || {}, n = count(x.n, y.n, (B[id] || {}).n, known);
      if (n <= 0) continue;
      const first = Math.min(x.first || Infinity, y.first || Infinity);
      o[id] = { ...y, ...x, n };
      if (Number.isFinite(first)) o[id].first = first; else delete o[id].first;
    }
    return o;
  },
  counts: (l, s, b, known) => {
    const o = { ...obj(s) }, L = obj(l), B = obj(b);
    for (const [k, v] of Object.entries(L)) o[k] = typeof v === "number" ? count(v, o[k], B[k], known) : (k in o && !(known && same(v, B[k])) ? o[k] : v);
    return o;
  },
  freezes: (l, s, b, known) => count(l, s, b, known),
  badges: (l, s) => { const o = { ...obj(l) }; for (const [k, t] of Object.entries(obj(s))) o[k] = o[k] ? Math.min(o[k], t) : t; return o; },
  goalDays: days(90),
  frozenDays: days(90),
  visits: days(400),
  giftOpened: (l, s) => [...new Set([...arr(l), ...arr(s)])].slice(-400),   // every gift opened anywhere stays opened
  // A chapter's start: the earliest XP any screen saw for it; a later chapter replaces an earlier one.
  chapterBase: (l, s) => { const a = obj(l), b = obj(s); return a.id === b.id ? { id: a.id, xp: Math.min(num(a.xp), num(b.xp)) } : num(a.id) > num(b.id) ? a : b; },
  chapterClaimed: (l, s) => { const a = obj(l), b = obj(s); return a.id === b.id ? { id: a.id, tier: Math.max(num(a.tier), num(b.tier)), keys: Math.max(num(a.keys), num(b.keys)) } : num(a.id) > num(b.id) ? a : b; },
  squashDays: (l, s) => { const o = { ...obj(l) }; for (const [d, v] of Object.entries(obj(s))) o[d] = Math.max(o[d] || 0, v || 0); return Object.fromEntries(Object.entries(o).sort().slice(-30)); },
  squashBest: (l, s) => Math.max(num(l), num(s)),
  officeLevel: (l, s) => Math.max(num(l), num(s)),
  lanesHired: (l, s) => !!(l || s),
  questStamps: (l, s) => { const o = { ...obj(l) }; for (const [m, ids] of Object.entries(obj(s))) o[m] = [...new Set([...arr(o[m]), ...arr(ids)])]; return o; },
  anniversaries: (l, s) => ({ ...obj(s), ...obj(l) }),
  tokRecords: (l, s) => (l == null && s == null ? l : { ...obj(s), ...obj(l) }),
  myTemplates: byId(t => t && t.name, xs => xs.slice(0, 40)),
  gifts: byId(giftKey),
  mailroom: byId(giftKey),
  giftLog: byId(e => e && `${e.at}|${e.sticker}`, xs => xs.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 60)),
};

const COUNTERS = new Set(["album", "counts", "freezes"]);
// The merge of one key. base is the office's copy this screen last saw (undefined: never seen, as on a first sync or
// for a page from before bases were kept); localAt and serverAt are when each copy was written.
export function merge3(k, local, server, base, localAt, serverAt) {
  if (local === undefined) return server;
  if (server === undefined) return local;
  const known = base !== undefined;
  if (known && same(local, base)) return server;                       // only the office's copy changed
  if (same(server, base) || (same(local, server) && !COUNTERS.has(k))) return local;   // only this screen's did (equal counters still add)
  if (MERGE[k]) return MERGE[k](local, server, base, known);
  return known || (localAt || 0) >= (serverAt || 0) ? local : server;  // both changed: this screen's write is the latest intent
}
export const mergeKey = (k, local, server, localAt, serverAt) => merge3(k, local, server, undefined, localAt, serverAt);

const read = (k, d) => { try { const r = localStorage.getItem("office." + k); return r == null ? d : JSON.parse(r); } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem("office." + k, JSON.stringify(v)); return true; } catch { return false; } };
const stamps = () => read("__at", {}) || {};
const bases = () => read("__base", {}) || {};
const setBase = (k, v, ver) => { const b = bases(); b[k] = { v, ver }; write("__base", b); };

let ready = false, post = null, onChange = () => {}, flushing = false;
const queue = new Set();
let timer = null;
// This browser, and the writes it sent: an office copy that is one of them is this browser's own (a reply that never
// came back, a tab that sent it), so it is the base, not a change to add on top again.
const DEV = (() => { let d = read("__dev"); if (!d) { d = Math.random().toString(36).slice(2, 10); write("__dev", d); } return d; })();
const sentAt = (k) => (read("__sent", {}) || {})[k] || [];
function noteSent(k, at) { const s = read("__sent", {}) || {}; s[k] = [...(s[k] || []), at].slice(-8); write("__sent", s); }
const mine = (k, s) => s && s.dev === DEV && sentAt(k).includes(s.at);
const baseOf = (k, s, b) => (mine(k, s) ? s.v : b ? b.v : undefined);

// Send this screen's copy of the queued keys, each with the version it was merged against; a refused write comes back
// with the office's copy, is merged in, and goes again.
function flush() {
  timer = null;
  if (flushing) { timer = setTimeout(flush, 400); return; }            // one at a time: a slow reply must not overlap the next
  flushing = true;
  const keys = [...queue]; queue.clear();
  (async () => {
    let changed = false;
    try {
      for (const k of keys) {
        for (let tries = 0; tries < 4; tries++) {
          const v = read(k), b = bases()[k];
          if (v === undefined || (b && same(v, b.v))) break;                // nothing new to send
          const at = Date.now();
          noteSent(k, at);
          let r;
          try { r = await post("/api/save", { key: k, v, at, base: b ? b.ver || 0 : 0, dev: DEV }); } catch { break; }   // the next write tries again
          if (r && r.ok) { setBase(k, v, r.ver); break; }
          if (!r || !r.conflict) break;
          const srv = r.v === null ? undefined : r.v, bNow = bases()[k];     // a pull may have moved the base while it waited
          const m = merge3(k, read(k), srv, baseOf(k, r, bNow), stamps()[k], r.at);
          setBase(k, srv, r.ver);
          if (!same(m, read(k))) { write(k, m); changed = true; }
        }
      }
    } finally { flushing = false; }
    if (changed) onChange();
  })();
}
function send(k) { queue.add(k); clearTimeout(timer); timer = setTimeout(flush, 1500); }

// Merge the office's save into this screen's: on load (true when this screen's copy changed) and when it comes back.
async function pull() {
  if (flushing) return null;                                             // a write in flight: merge after it lands
  let srv;
  try { const r = await fetch("/api/save"); srv = r.ok ? await r.json() : null; } catch { srv = null; }
  if (!srv || !srv.keys || flushing) return null;
  const st = stamps(), bs = bases();
  let changed = false;
  for (const k of SYNC) {
    const local = read(k), s = srv.keys[k], b = bs[k];
    // An office copy older than the one this screen last saw (a reply that crossed this screen's write, or an office
    // that lost its save and got a stale screen's first) is merged with no base: nothing this screen has is undone.
    const older = s && b && (s.ver || 0) < (b.ver || 0);
    const merged = merge3(k, local, s ? s.v : undefined, older ? undefined : baseOf(k, s, b), st[k], s ? s.at : 0);
    if (merged === undefined) continue;
    if (s && !older) setBase(k, s.v, s.ver || 0);
    else if (older) { const bb = bases(); bb[k] = { v: s.v, ver: s.ver || 0 }; write("__base", bb); }   // its version, to write over it
    else if (b) { const bb = bases(); delete bb[k]; write("__base", bb); }  // the office lost its copy: send this one again
    if (!same(merged, local)) { if (write(k, merged)) changed = true; }
    if (!s || !same(s.v, merged)) send(k);
  }
  return changed;
}

export async function syncSave({ post: p, demo, changed }) {
  if (demo) return;
  post = p;
  if (changed) onChange = changed;
  setStoreHook((k, v) => {
    if (!ready || !SYNC.has(k)) return;
    const b = bases()[k];
    if (b && same(v, b.v)) return;                                       // unchanged: nothing to send
    const st = stamps(); st[k] = Date.now(); write("__at", st);
    send(k);
  });
  const changedNow = await pull();
  ready = true;
  if (changedNow && !sessionStorage.getItem("office.synced")) { sessionStorage.setItem("office.synced", "1"); location.reload(); return; }
  let last = Date.now();
  const again = async () => {                                              // back in view: what the other screens did
    if (document.hidden || Date.now() - last < 15000) return;
    last = Date.now();
    if (await pull()) onChange();
  };
  document.addEventListener("visibilitychange", again);
  window.addEventListener("focus", again);
  setInterval(() => { if (!document.hidden && Date.now() - last >= 55000) { last = Date.now(); pull().then(c => { if (c) onChange(); }); } }, 60000);   // two screens both in view
}

// Settings → Your data: the whole save as a file, and back.
export function exportSave() {
  const out = { app: "claude-office", saved: new Date().toISOString(), keys: {} };
  for (const k of SYNC) { const v = store.get(k); if (v !== undefined) out.keys[k] = v; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: "application/json" })), a = document.createElement("a");
  a.href = url; a.download = `claude-office-save-${out.saved.slice(0, 10)}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast("Saved your game to a file.", "good");
}
export async function importSave(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch { toast("That file is not a Claude Office save.", "bad"); return; }
  if (!d || d.app !== "claude-office" || !d.keys || typeof d.keys !== "object") { toast("That file is not a Claude Office save.", "bad"); return; }
  if (!confirm("Merge this save into this office? Stickers, badges, streaks, templates and gifts add up; the rest takes the file's values.")) return;
  for (const [k, v] of Object.entries(d.keys)) if (SYNC.has(k)) store.set(k, MERGE[k] ? MERGE[k](store.get(k), v, undefined, false) : v);
  toast("Imported. Reloading…", "good");
  setTimeout(() => location.reload(), 1800);              // after the writes reach the office
}

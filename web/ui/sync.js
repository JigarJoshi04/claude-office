// One save for the CEO's game (office/save.py): the album, badges, gifts, streaks, bests and templates are the same on
// every screen. Each write of a shared key goes to the office with when it happened; on load the page merges what the
// office keeps into its own copy (adding up where that is safe: stickers, badges, goal days, quest stamps, bests; the
// newer write otherwise) and reloads once if anything changed. Settings exports and imports the whole save.
import { store, setStoreHook, toast } from "./util.js";

export const SYNC = new Set(["album", "badges", "counts", "gifts", "giftLog", "giftMiss", "giftDay", "mailroom", "goalDays", "questStamps",
  "squashBest", "squashDays", "squashGiftDay", "visits", "combo", "officeLevel", "milestone", "milestoneGift", "tokRecords", "tokRecordsDay",
  "weeklyDone", "frozenDays", "freezes", "freezeDay", "happyDay", "anniversaries", "lanesHired", "myTemplates", "belt"]);

const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
// How two copies of one key become one, where adding up is right; the newer write wins for the rest.
export const MERGE = {
  album: (a, b) => { const o = { ...obj(a) }; for (const [id, x] of Object.entries(obj(b))) { const y = o[id]; o[id] = y ? { n: Math.max(y.n || 0, x.n || 0), first: Math.min(y.first || Infinity, x.first || Infinity) } : x; } return o; },
  badges: (a, b) => { const o = { ...obj(a) }; for (const [k, t] of Object.entries(obj(b))) o[k] = o[k] ? Math.min(o[k], t) : t; return o; },
  goalDays: (a, b) => [...new Set([...(a || []), ...(b || [])])].sort().slice(-90),
  frozenDays: (a, b) => [...new Set([...(a || []), ...(b || [])])].sort().slice(-90),
  squashDays: (a, b) => { const o = { ...obj(a) }; for (const [d, v] of Object.entries(obj(b))) o[d] = Math.max(o[d] || 0, v || 0); return Object.fromEntries(Object.entries(o).sort().slice(-30)); },
  squashBest: (a, b) => Math.max(+a || 0, +b || 0),
  questStamps: (a, b) => { const o = { ...obj(a) }; for (const [m, ids] of Object.entries(obj(b))) o[m] = [...new Set([...(o[m] || []), ...(ids || [])])]; return o; },
  counts: (a, b) => { const o = { ...obj(a) }; for (const [k, v] of Object.entries(obj(b))) o[k] = typeof v === "number" && typeof o[k] === "number" ? Math.max(o[k], v) : (o[k] ?? v); return o; },
};
export function mergeKey(k, local, server, localAt, serverAt) {
  if (local === undefined) return server;
  if (server === undefined) return local;
  if (MERGE[k]) return MERGE[k](local, server);
  return (serverAt || 0) > (localAt || 0) ? server : local;
}

const stamps = () => store.get("__at", {}) || {};
let ready = false;
const queue = new Map();
function push(post, k, v, at) {
  queue.set(k, { v, at });
  clearTimeout(push.t);
  push.t = setTimeout(async () => {
    const items = [...queue.entries()]; queue.clear();
    for (const [key, x] of items) { try { await post("/api/save", { key, v: x.v, at: x.at }); } catch { /* the next write tries again */ } }
  }, 1500);
}

// On load: merge the office's save into this browser's, send back what this browser has newer, and reload once if the
// page's copy changed (the game reads its state as it starts).
export async function syncSave({ post, demo }) {
  if (demo) return;
  setStoreHook((k, v) => { if (!ready || !SYNC.has(k)) return; const at = Date.now(); const st = stamps(); st[k] = at; try { localStorage.setItem("office.__at", JSON.stringify(st)); } catch { /* */ } push(post, k, v, at); });
  let srv;
  try { const r = await fetch("/api/save"); srv = r.ok ? await r.json() : null; } catch { srv = null; }
  if (!srv || !srv.keys) { ready = true; return; }
  const st = stamps(), now = Date.now();
  let changed = false;
  for (const k of SYNC) {
    const raw = localStorage.getItem("office." + k), local = raw == null ? undefined : JSON.parse(raw), s = srv.keys[k];
    const merged = mergeKey(k, local, s ? s.v : undefined, st[k], s ? s.at : 0);
    if (merged === undefined) continue;
    const m = JSON.stringify(merged);
    if (m !== raw) { try { localStorage.setItem("office." + k, m); changed = true; } catch { /* */ } }
    if (!s || JSON.stringify(s.v) !== m) push(post, k, merged, st[k] && (!s || st[k] > s.at) ? st[k] : now);
    st[k] = Math.max(st[k] || 0, s ? s.at : 0);
  }
  try { localStorage.setItem("office.__at", JSON.stringify(st)); } catch { /* */ }
  ready = true;
  if (changed && !sessionStorage.getItem("office.synced")) { sessionStorage.setItem("office.synced", "1"); location.reload(); }
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
  if (!confirm("Merge this save into this office? Stickers, badges and streaks add up; the rest takes the file's values.")) return;
  for (const [k, v] of Object.entries(d.keys)) if (SYNC.has(k)) store.set(k, MERGE[k] ? MERGE[k](store.get(k), v) : v);
  toast("Imported. Reloading…", "good");
  setTimeout(() => location.reload(), 1800);              // after the writes reach the office
}

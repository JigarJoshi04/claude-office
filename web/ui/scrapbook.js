// The scrapbook: the office's big moments as captioned floor photos (a character's level-up or trophy, an office
// level, a day with every goal done). Each is a picture of the room it happened in, taken a moment after, while the
// confetti is still up. Kept in this browser (the newest 36; a full store drops the oldest) and flipped through from
// Trophies, the menu or Ctrl+K.
import { store, esc } from "./util.js";

const KEY = "scrapbook", MAX = 36;

export const photos = () => (store.get(KEY, []) || []).filter(p => p && p.img);

function keep(items) {
  let it = items.slice(-MAX);
  while (it.length) {
    try { localStorage.setItem("office." + KEY, JSON.stringify(it)); return true; } catch { it = it.slice(1); }
  }
  return false;
}

// A moment worth keeping: once per caption a day, never with the game off.
export function capture(office, prefs, kind, caption, seat) {
  if (prefs.game === "off" || prefs.view !== "floor" || document.hidden) return;
  setTimeout(() => {
    const img = office.photo(seat);
    if (!img) return;
    const items = photos(), day = new Date().toDateString();
    if (items.some(p => p.caption === caption && new Date(p.at).toDateString() === day)) return;
    keep([...items, { id: Date.now().toString(36), at: Date.now(), kind, caption, seat: seat || null, img }]);
  }, 1600);
}

export function remove(id) { keep(photos().filter(p => p.id !== id)); }

const STAMP = { levelup: "Level up", achievement: "Trophy", office: "Office level", goals: "All goals" };

export function pageHtml({ crumbs, privacy }) {
  const ps = photos().slice().reverse();
  return `${crumbs("Scrapbook")}
    <h2>Scrapbook</h2>
    <p class="lede">The office's big moments, photographed on the floor as they happened: level-ups, trophies, office levels and days with every goal done. Kept in this browser, the newest ${MAX}.</p>
    ${ps.length ? `<div class="scrap">${ps.map((p, i) => `<button class="polaroid" data-photo="${i}" style="--tilt:${((i * 37) % 7) - 3}deg" aria-label="${esc(p.caption)}">
        <img src="${p.img}" alt="" loading="lazy"><span class="pc">${privacy ? esc(STAMP[p.kind] || "A moment") : esc(p.caption)}</span>
        <small>${esc(STAMP[p.kind] || "")} · ${new Date(p.at).toLocaleDateString([], { day: "numeric", month: "short" })}</small></button>`).join("")}</div>`
      : `<div class="empty-state"><b>Nothing yet.</b><span>The next level-up, trophy or all-goals day is photographed here.</span></div>`}`;
}

// A photo full size, with the next and the previous one (arrows and the keyboard) and a way to throw it away.
export function bindPage(root, { dialog, rerender, privacy }) {
  root.querySelectorAll("[data-photo]").forEach(b => b.addEventListener("click", () => open(+b.dataset.photo)));
  function open(i) {
    const ps = photos().slice().reverse();
    if (!ps.length) return;
    i = (i + ps.length) % ps.length;
    const p = ps[i];
    dialog.innerHTML = `<div class="photo-view"><img src="${p.img}" alt="${esc(p.caption)}">
      <p><b>${privacy ? esc(STAMP[p.kind] || "A moment") : esc(p.caption)}</b><small>${new Date(p.at).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</small></p>
      <div class="row between"><div class="row" style="gap:6px"><button class="btn sm" data-pv="-1" aria-label="Previous photo">‹</button><span class="hint">${i + 1} of ${ps.length}</span><button class="btn sm" data-pv="1" aria-label="Next photo">›</button></div>
      <div class="row" style="gap:6px"><button class="btn sm ghost" data-pv-del>Remove</button><button class="btn sm" data-pv-x>Close</button></div></div></div>`;
    if (!dialog.open) dialog.showModal();
    dialog.querySelectorAll("[data-pv]").forEach(b => b.addEventListener("click", () => open(i + +b.dataset.pv)));
    dialog.querySelector("[data-pv-x]").addEventListener("click", () => dialog.close());
    dialog.querySelector("[data-pv-del]").addEventListener("click", () => { remove(p.id); dialog.close(); rerender(); });
    dialog.onkeydown = (e) => { if (e.key === "ArrowRight") open(i + 1); else if (e.key === "ArrowLeft") open(i - 1); };
  }
}

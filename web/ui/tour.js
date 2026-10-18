// The first-run tour: five short steps that point at the real thing on screen (the floor, a room, the briefing, the
// dock and the Hire button). Skippable at any step, re-runnable from the menu or the palette.
import { esc } from "./util.js";
import { icon } from "./icons.js";

const STEPS = [
  { sel: "#stage", title: "This is your office", text: "Every Claude Code account on this machine is a character with a room. Each person at a desk is a live session." },
  { sel: ".hot.pod", title: "Point at a room", text: "Hover for a peek at who is there and what they are doing. Click to open the character, double-click to fly the camera in." },
  { sel: "#panel", title: "Your briefing", text: "How many are working, what needs you (each with a one-click fix), today's goals and the team. Drag its edge to resize it." },
  { sel: "#dock", title: "Right now", text: "Everyone at work, newest first. Click a card to open the chat and talk to that session." },
  { sel: "#btnHire", title: "Hire a lane", text: "Start a background agent on whichever seat has the most plan left. It walks in from the elevator.", last: true },
];

export function startTour({ onDone } = {}) {
  let i = 0;
  const shade = document.createElement("div"), card = document.createElement("div"), ring = document.createElement("div");
  shade.className = "tour-shade"; ring.className = "tour-ring"; card.className = "tour-card";
  card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "false"); card.setAttribute("aria-live", "polite");
  document.body.append(shade, ring, card);
  const keys = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); end(); }
    else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); if (i > 0) { i--; show(); } }
  };
  document.addEventListener("keydown", keys, true);
  addEventListener("resize", show);

  function target() {
    const s = STEPS[i], el = [...document.querySelectorAll(s.sel)].find(e => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
    return el || null;
  }
  function show() {
    const s = STEPS[i], el = target();
    const r = el ? el.getBoundingClientRect() : { left: innerWidth / 2 - 1, top: innerHeight / 2 - 1, width: 2, height: 2, right: innerWidth / 2 + 1, bottom: innerHeight / 2 + 1 };
    const pad = 6;
    Object.assign(ring.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px" });
    card.innerHTML = `<div class="tc-step">${i + 1} of ${STEPS.length}</div><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p>
      <div class="tc-row"><button class="btn sm ghost" data-t="skip">Skip the tour</button><span class="grow"></span>
      ${i > 0 ? `<button class="btn sm" data-t="back">${icon("back", 14)}Back</button>` : ""}<button class="btn sm primary" data-t="next">${s.last ? "Done" : "Next"}${s.last ? "" : icon("chevronRight", 14)}</button></div>`;
    card.querySelector('[data-t="skip"]').onclick = end;
    card.querySelector('[data-t="next"]').onclick = next;
    const b = card.querySelector('[data-t="back"]'); if (b) b.onclick = () => { i--; show(); };
    // place the card beside the target: below, above, left or right, whichever fits
    const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-zoom")) || 1;   // the card is zoomed with the text size
    const cb = card.getBoundingClientRect(), cw = cb.width, ch = cb.height, m = 14;
    let left = Math.min(innerWidth - cw - 12, Math.max(12, r.left + r.width / 2 - cw / 2)), top = r.bottom + m;
    if (top + ch > innerHeight - 12) top = r.top - ch - m;
    if (top < 12) { top = Math.max(12, Math.min(innerHeight - ch - 12, r.top + r.height / 2 - ch / 2)); left = r.right + m + cw < innerWidth ? r.right + m : Math.max(12, r.left - cw - m); }
    card.style.left = left / z + "px"; card.style.top = top / z + "px";
    card.querySelector('[data-t="next"]').focus();
  }
  function next() { if (i < STEPS.length - 1) { i++; show(); } else end(); }
  function end() {
    document.removeEventListener("keydown", keys, true);
    removeEventListener("resize", show);
    shade.remove(); ring.remove(); card.remove();
    if (onDone) onDone();
  }
  show();
}

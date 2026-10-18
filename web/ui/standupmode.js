// Standup mode: the morning's standup as a two-minute story for a screen share. Five big slides over the live floor
// (the day and the team, yesterday, today, what is blocked, and the team's numbers), 20 seconds each, with a progress
// bar. Space or the right arrow goes on, the left arrow goes back, P pauses, Esc ends it. Share-safe keeps to counts.
import { esc } from "./util.js";
import { icon } from "./icons.js";

const EVERY = 20000;

export function openStandupMode({ data, snap, persona, humanise, privacy, onClose }) {
  const seats = snap.seats || [];
  const day = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const list = (items, empty) => !items.length ? `<p class="su-empty">${empty}</p>`
    : privacy ? `<p class="su-empty">${items.length} item${items.length === 1 ? "" : "s"}, kept off the screen while share-safe is on.</p>`
    : `<ul>${items.slice(0, 7).map(t => `<li>${esc(humanise(t))}</li>`).join("")}${items.length > 7 ? `<li class="more">and ${items.length - 7} more</li>` : ""}</ul>`;
  const count = (n, one, many) => `<b>${n}</b> ${n === 1 ? one : many}`;
  const team = seats.map(s => { const p = persona(s); return `<span class="su-mate" style="--seat:${esc(s.color)}"><i></i>${esc(p.name)}</span>`; }).join("");
  const slides = [
    { k: "Standup", h: day, body: `<p class="su-lede">${count(data.yesterday.length, "thing", "things")} done yesterday · ${count(data.today.length, "thing", "things")} on today · ${count(data.blockers.length, "blocker", "blockers")}</p><div class="su-team">${team}</div>` },
    { k: "Yesterday", h: "What got done", body: list(data.yesterday, "A quiet day: nothing filed.") },
    { k: "Today", h: "What is on", body: list(data.today, "Nothing is running yet. Hire a lane.") },
    { k: "Blockers", h: data.blockers.length ? "What needs a decision" : "Nothing blocks us", body: list(data.blockers, "All clear.") },
    { k: "Team", h: "Who carried it", body: `<div class="su-cards">${seats.filter(s => s.career).sort((a, b) => (b.career.level || 0) - (a.career.level || 0)).slice(0, 6).map(s => {
        const p = persona(s); return `<div class="su-card" style="--seat:${esc(s.color)}"><b>${esc(p.name)}</b><span>Level ${s.career.level}${s.career.title ? " · " + esc(s.career.title) : ""}</span></div>`; }).join("")}</div>` },
  ];
  const el = document.createElement("div");
  el.className = "su-mode";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Standup mode");
  el.innerHTML = `<div class="su-bar"><i></i></div><div class="su-slide" aria-live="polite"></div>
    <div class="su-nav"><button class="btn sm ghost" data-su="-1" aria-label="Back">${icon("back", 16)}</button><span class="su-n"></span>
      <button class="btn sm ghost" data-su-pause aria-label="Pause">${icon("pause", 16)}</button><button class="btn sm ghost" data-su="1" aria-label="Next">${icon("chevronRight", 16)}</button>
      <button class="btn sm ghost" data-su-x aria-label="End standup mode">${icon("x", 16)}</button></div>`;
  document.body.appendChild(el);
  let i = 0, timer = 0, paused = false, started = 0;
  const bar = el.querySelector(".su-bar i");
  function show(n) {
    i = Math.max(0, Math.min(slides.length - 1, n));
    const s = slides[i];
    el.querySelector(".su-slide").innerHTML = `<div class="su-k">${esc(s.k)}</div><h1>${esc(s.h)}</h1>${s.body}`;
    el.querySelector(".su-n").textContent = `${i + 1} / ${slides.length}`;
    restart();
  }
  function restart() {
    clearTimeout(timer); started = performance.now();
    bar.style.transition = "none"; bar.style.width = "0%"; void bar.offsetWidth;
    if (paused) return;
    bar.style.transition = `width ${EVERY}ms linear`; bar.style.width = "100%";
    timer = setTimeout(() => (i < slides.length - 1 ? show(i + 1) : close()), EVERY);
  }
  function pause() {
    paused = !paused;
    el.querySelector("[data-su-pause]").innerHTML = icon(paused ? "play" : "pause", 16);
    if (paused) { clearTimeout(timer); const f = Math.min(1, (performance.now() - started) / EVERY); bar.style.transition = "none"; bar.style.width = (f * 100).toFixed(1) + "%"; }
    else restart();
  }
  function close() { clearTimeout(timer); document.removeEventListener("keydown", key, true); el.remove(); if (onClose) onClose(); }
  function key(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); e.stopPropagation(); if (i < slides.length - 1) show(i + 1); else close(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); show(i - 1); }
    else if (e.key === "p" || e.key === "P") { e.preventDefault(); e.stopPropagation(); pause(); }
  }
  document.addEventListener("keydown", key, true);
  el.querySelectorAll("[data-su]").forEach(b => b.addEventListener("click", () => { const n = i + +b.dataset.su; if (n >= slides.length) close(); else show(n); }));
  el.querySelector("[data-su-pause]").addEventListener("click", pause);
  el.querySelector("[data-su-x]").addEventListener("click", close);
  show(0);
  el.querySelector("[data-su-x]").focus();
  return { close };
}

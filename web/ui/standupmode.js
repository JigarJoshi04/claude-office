// Standup mode: the morning's standup as a two-minute story for a screen share. Five big slides over the live floor
// (the day and the team, yesterday, today, what is blocked, and the team's numbers), 20 seconds each, with a progress
// bar. Space or the right arrow goes on, the left arrow goes back, P pauses, Esc ends it. Share-safe keeps to counts.
import { esc } from "./util.js";
import { icon } from "./icons.js";

const EVERY = 20000;
let current = null;                                    // one deck at a time

export function openStandupMode({ data, snap, persona, humanise, privacy, onClose }) {
  if (current) return current;
  const seats = snap.seats || [];
  const day = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const list = (items, empty) => !items.length ? `<p class="su-empty">${empty}</p>`
    : privacy ? `<p class="su-empty">${items.length} item${items.length === 1 ? "" : "s"}, kept off the screen while share-safe is on.</p>`
    : `<ul>${items.slice(0, 7).map(t => `<li>${esc(humanise(t))}</li>`).join("")}${items.length > 7 ? `<li class="more">and ${items.length - 7} more</li>` : ""}</ul>`;
  const count = (n, one, many) => `<b>${n}</b> ${n === 1 ? one : many}`;
  const team = seats.map(s => { const p = persona(s); return `<span class="su-mate" style="--seat:${esc(s.color)}"><i></i>${esc(p.name)}</span>`; }).join("");
  const slides = [
    { k: "Standup", h: day, body: `<p class="su-lede">${count(data.yesterday.filter(t => !/^(?:…and|Hit a plan limit)/.test(t)).length, "thing", "things")} done yesterday · ${count(data.today.length, "thing", "things")} on today · ${count(data.blockers.length, "blocker", "blockers")}</p><div class="su-team">${team}</div>` },
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
  let i = 0, timer = 0, paused = false, started = 0, left = EVERY;
  const bar = el.querySelector(".su-bar i");
  function show(n) {
    i = Math.max(0, Math.min(slides.length - 1, n));
    const s = slides[i];
    el.querySelector(".su-slide").innerHTML = `<div class="su-k">${esc(s.k)}</div><h1>${esc(s.h)}</h1>${s.body}`;
    el.querySelector(".su-n").textContent = `${i + 1} / ${slides.length}`;
    restart();
  }
  function run(ms) {                                  // the bar fills over what is left of this slide
    clearTimeout(timer); started = performance.now(); left = ms;
    bar.style.transition = "none"; bar.style.width = ((1 - ms / EVERY) * 100).toFixed(1) + "%"; void bar.offsetWidth;
    if (paused) return;
    bar.style.transition = `width ${ms}ms linear`; bar.style.width = "100%";
    timer = setTimeout(() => (i < slides.length - 1 ? show(i + 1) : close()), ms);
  }
  const restart = () => run(EVERY);
  function pause() {
    paused = !paused;
    el.querySelector("[data-su-pause]").innerHTML = icon(paused ? "play" : "pause", 16);
    if (paused) { clearTimeout(timer); left = Math.max(0, left - (performance.now() - started)); bar.style.transition = "none"; bar.style.width = ((1 - left / EVERY) * 100).toFixed(1) + "%"; }
    else run(left);                                  // on from where it stopped
  }
  function close() { clearTimeout(timer); document.removeEventListener("keydown", key, true); el.remove(); current = null; if (onClose) onClose(); }
  function key(e) {                                  // the deck owns the keyboard while it is up
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowRight" || (e.key === " " && !e.target.closest("button"))) { e.preventDefault(); if (i < slides.length - 1) show(i + 1); else close(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); show(i - 1); }
    else if (e.key === "p" || e.key === "P") { e.preventDefault(); pause(); }
    else if (e.key === "Tab") {                      // focus stays on the deck's own buttons
      const bs = [...el.querySelectorAll("button")], k = bs.indexOf(document.activeElement);
      e.preventDefault(); bs[(k + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus();
    } else if ((e.key === "Enter" || e.key === " ") && e.target.closest("button")) return;   // a focused button's own click
    else if (!e.ctrlKey && !e.metaKey) e.preventDefault();
  }
  document.addEventListener("keydown", key, true);
  el.querySelectorAll("[data-su]").forEach(b => b.addEventListener("click", () => { const n = i + +b.dataset.su; if (n >= slides.length) close(); else show(n); }));
  el.querySelector("[data-su-pause]").addEventListener("click", pause);
  el.querySelector("[data-su-x]").addEventListener("click", close);
  show(0);
  el.querySelector("[data-su-x]").focus();
  current = { close };
  return current;
}

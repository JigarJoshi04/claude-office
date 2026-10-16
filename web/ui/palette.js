// Ctrl/⌘+K: jump to any seat, session or lane, or run any action, from the keyboard.
import { esc } from "./util.js";

export function openPalette(items) {
  const back = document.createElement("div");
  back.className = "palette-back";
  back.innerHTML = `<div class="palette" role="dialog" aria-label="Search and commands">
    <input type="text" placeholder="Search seats, sessions, lanes, actions…" aria-label="Search" autocomplete="off">
    <ul role="listbox"></ul></div>`;
  document.body.appendChild(back);
  const input = back.querySelector("input"), ul = back.querySelector("ul");
  let sel = 0, shown = [];
  const score = (it, q) => {
    if (!q) return 1;
    const hay = (it.label + " " + (it.hint || "") + " " + (it.keywords || "")).toLowerCase();
    let s = 0, i = 0;
    for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
      const at = hay.indexOf(w);
      if (at < 0) return 0;
      s += at === 0 ? 3 : hay[at - 1] === " " ? 2 : 1; i++;
    }
    return s / i;
  };
  function render() {
    const q = input.value.trim();
    shown = items.map(it => [score(it, q), it]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 40).map(([, it]) => it);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    ul.innerHTML = shown.length ? shown.map((it, i) => `<li role="option" data-i="${i}" class="${i === sel ? "on" : ""}" aria-selected="${i === sel}">
      <span class="ico">${it.icon || "›"}</span><span>${esc(it.label)}</span><small>${esc(it.hint || "")}</small></li>`).join("")
      : `<div class="empty">Nothing matches “${esc(q)}”.</div>`;
    ul.querySelectorAll("li").forEach(li => {
      li.addEventListener("mousemove", () => { if (sel !== +li.dataset.i) { sel = +li.dataset.i; mark(); } });
      li.addEventListener("click", () => run(+li.dataset.i));
    });
  }
  function mark() { ul.querySelectorAll("li").forEach((li, i) => { li.classList.toggle("on", i === sel); li.setAttribute("aria-selected", String(i === sel)); }); const on = ul.querySelector("li.on"); if (on) on.scrollIntoView({ block: "nearest" }); }
  function close() { back.remove(); }
  function run(i) { const it = shown[i]; close(); if (it) it.run(); }
  input.addEventListener("input", () => { sel = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
    else if (e.key === "Enter") { e.preventDefault(); run(sel); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  render();
  input.focus();
  return close;
}

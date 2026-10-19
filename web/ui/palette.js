// Ctrl/⌘+K: jump to any seat, session or lane, or run any action, from the keyboard.
import { esc } from "./util.js";

// `commands(q)` turns what was typed into ready actions ("remind me in 20 min to…"), listed first.
export function openPalette(items, commands = null) {
  const open = document.querySelector(".palette-back");
  if (open) { open.querySelector("input").focus(); return () => open.remove(); }   // one palette at a time
  const back = document.createElement("div");
  back.className = "palette-back";
  back.innerHTML = `<div class="palette" role="dialog" aria-label="Search and commands">
    <input type="text" placeholder="Search, or type: msg Atlas …, stop …, resume …, hire …, remind me …" aria-label="Search and commands" autocomplete="off"
      role="combobox" aria-expanded="true" aria-controls="palList" aria-autocomplete="list">
    <ul role="listbox" id="palList" aria-label="Results"></ul></div>`;
  document.body.appendChild(back);
  const input = back.querySelector("input"), ul = back.querySelector("ul");
  let sel = 0, shown = [];
  // What you use most comes first with nothing typed (kept in this browser).
  const used = () => { try { return JSON.parse(localStorage.getItem("office.paletteUse") || "{}") || {}; } catch { return {}; } };
  const remember = (it) => { try { const u = used(); u[it.label] = Date.now(); const keep = Object.entries(u).sort((a, b) => b[1] - a[1]).slice(0, 30); localStorage.setItem("office.paletteUse", JSON.stringify(Object.fromEntries(keep))); } catch { /* */ } };
  const score = (it, q) => {
    if (!q) return 1 + (used()[it.label] || 0) / 1e13;
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
    shown = [...(commands && q ? commands(q).map(c => ({ ...c, once: true })) : []), ...items.map(it => [score(it, q), it]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 40).map(([, it]) => it)];
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    const recent = !q ? used() : {};
    ul.innerHTML = shown.length ? shown.map((it, i) => `<li role="option" id="pal-${i}" data-i="${i}" class="${i === sel ? "on" : ""}" aria-selected="${i === sel}">
      <span class="ico">${it.icon || "›"}</span><span>${esc(it.label)}</span><small>${esc(recent[it.label] ? "recent" : it.hint || "")}</small></li>`).join("")
      : `<li class="empty" role="presentation">Nothing matches “${esc(q)}”.</li>`;
    ul.querySelectorAll("li[data-i]").forEach(li => {
      li.addEventListener("mousemove", () => { if (sel !== +li.dataset.i) { sel = +li.dataset.i; mark(); } });
      li.addEventListener("click", () => run(+li.dataset.i));
    });
  }
  function mark() {
    ul.querySelectorAll("li[data-i]").forEach((li, i) => { li.classList.toggle("on", i === sel); li.setAttribute("aria-selected", String(i === sel)); });
    const on = ul.querySelector("li.on");
    if (on) { on.scrollIntoView({ block: "nearest" }); input.setAttribute("aria-activedescendant", on.id); } else input.removeAttribute("aria-activedescendant");   // the screen reader follows the selection
  }
  function close() { back.remove(); }
  function run(i) { const it = shown[i]; close(); if (it) { if (!it.verb && !it.once) remember(it); it.run(); } }   // a typed one-off is no "recent"
  input.addEventListener("input", () => { sel = 0; render(); mark(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
    else if (e.key === "Enter") { e.preventDefault(); run(sel); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  render();
  mark();
  input.focus();
  return close;
}

// Plain-language commands in the palette: what you type becomes an action, shown first.
//   "remind me in 20 min to check the PR", "remind me at 5:30pm to reply to Vega", "remind me at 17:30 stand up"
//   "hire fix the flaky export test" (the hiring desk with that title), "project api-gateway" (its page)
export function paletteCommands(q, now = new Date()) {
  const out = [];
  let m = /^remind me (?:in )?(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)\b\s*(?:to\s+)?(.+)$/i.exec(q);
  if (m && m[3].trim()) {
    const mins = +m[1] * (/^h/i.test(m[2]) ? 60 : 1);
    if (mins >= 1 && mins <= 7 * 1440) out.push({ kind: "remind", at: now.getTime() / 1000 + mins * 60, text: m[3].trim(), when: `in ${m[1]} ${/^h/i.test(m[2]) ? (+m[1] === 1 ? "hour" : "hours") : "min"}` });
  }
  m = /^remind me at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to\s+)?(.+)$/i.exec(q);
  if (m && m[4].trim()) {
    let h = +m[1]; const mi = +(m[2] || 0), ap = (m[3] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
    if (h < 24 && mi < 60) {
      // A bare hour from 1 to 12 ("at 5") is the next 5 o'clock coming up, morning or evening.
      const hours = !ap && h >= 1 && h <= 12 ? [h % 12, h % 12 + 12] : [h];
      const next = (hh) => { const d = new Date(now); d.setHours(hh, mi, 0, 0); if (d <= now) d.setDate(d.getDate() + 1); return d; };
      const d = hours.map(next).sort((x, y) => x - y)[0];
      const tomorrow = d.toDateString() !== now.toDateString();
      out.push({ kind: "remind", at: d.getTime() / 1000, text: m[4].trim(), when: `${tomorrow ? "tomorrow " : ""}at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` });
    }
  }
  m = /^hire (?:a lane (?:to |for )?)?(.{3,80})$/i.exec(q);
  if (m) out.push({ kind: "hire", title: m[1].trim().replace(/^./, c => c.toUpperCase()) });
  m = /^project (.{1,200})$/i.exec(q);
  if (m) out.push({ kind: "project", name: m[1].trim() });
  return out;
}

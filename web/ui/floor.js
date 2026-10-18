// The floor's cards and screens: the room peek (hover a room), the room menu (right-click a room), the floor legend
// (the ? camera button) and TV mode (V). Moved out of app.js; `ctx` carries what they need from the app.
import { $, esc, toast, live, hydratePortraits, dayTime, relTime } from "./util.js";
import { icon } from "./icons.js";
import { voice, leftOf } from "./personas.js";

export function makeFloor(ctx) {
  const { app, office, panels, replay, prefs, QS, DEMO, go, setView, badge, award, zoomNow } = ctx;

  // Room peek: hover a room for a moment and a card says who it is, how they feel, how much plan is left and who is at
  // the desk doing what. It never takes focus or clicks (the room under it still opens the character).
  const peekEl = document.createElement("div");
  peekEl.className = "peek"; peekEl.hidden = true; peekEl.setAttribute("aria-hidden", "true");
  document.body.appendChild(peekEl);
  function peekCard(id, r) {
    const snap = app.snap();
    const s = id && snap && snap.seats.find(x => x.id === id);
    if (!s || !r) { peekEl.hidden = true; return; }
    const p = panels.persona(s), v = voice(s, p, dayTime), people = live(s);
    const plan = (key, label) => { const left = leftOf(s, key); return left == null ? "" :
      `<div class="pk-plan"><span>${label}</span><span class="pk-bar ${left < 15 ? "low" : left < 35 ? "mid" : ""}"><i style="width:${Math.round(left)}%"></i></span><b>${Math.round(left)}%</b></div>`; };
    const STATE = { working: "working", waiting: "on a long tool", idle: "idle", limited: "out of plan", stuck: "quiet a while" };
    const row = (x) => `<div class="pk-row"><i class="sdot ${x.state}"></i><b>${esc(x.name.replace(/^wt-/, ""))}</b><span>${esc(prefs.privacy && x.kind === "desk" ? STATE[x.state] || x.state : x.activity || STATE[x.state] || x.state)}</span></div>`;
    peekEl.style.setProperty("--seat", s.color);
    peekEl.innerHTML = `<div class="pk-top"><span class="av"><i data-portrait="mascot-${esc(s.id)}|${esc(s.color)}|${s.status === "offline" ? "dim" : ""}"></i></span>
        <div class="grow"><b class="pk-name">${esc(p.name)}${s.career ? `<em>Lv ${s.career.level}</em>` : ""}</b><span class="pk-role">${esc(p.role)}</span></div>
        <span class="pk-word ${v.tone}"><i></i>${esc(v.word)}</span></div>
      <p class="pk-voice">“${esc(v.line)}”</p>
      ${plan("five_hour", "5 hours")}${plan("weekly", "This week")}
      ${people.length ? `<div class="pk-h">At the desk · ${people.length}</div>${people.slice(0, 4).map(row).join("")}${people.length > 4 ? `<div class="pk-more">+${people.length - 4} more</div>` : ""}` : `<div class="pk-h">Nobody at the desk</div>`}
      <div class="pk-foot">Click to open · double-click to zoom in</div>`;
    hydratePortraits(peekEl, 3);
    peekEl.hidden = false;
    // The card is zoomed with the text size: measure it on screen, then give left/top in its own (zoomed) pixels.
    const z = zoomNow(), box = peekEl.getBoundingClientRect(), w = box.width, h = box.height, gap = 10;
    let left = r.right + gap; if (left + w > innerWidth - 8) left = r.left - w - gap; if (left < 8) left = Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    const minTop = document.body.classList.contains("tv") ? 62 * z : 8;   // below TV mode's status strip
    const top = Math.max(minTop, Math.min(innerHeight - h - 10, r.top + r.height / 2 - h / 2));
    peekEl.style.left = Math.max(8, left) / z + "px"; peekEl.style.top = top / z + "px";
  }
  addEventListener("scroll", () => { peekEl.hidden = true; }, { passive: true, capture: true });

  // TV mode: the floor alone, full screen, for a second monitor or a wall. A heads-up line keeps the time and the
  // office's one-sentence status; every few seconds the tour lights up the next room with people in it and shows its card.
  let tvTimer = 0, tvAt = -1;
  function tvTour() {
    const snap = app.snap();
    if (!snap || !document.body.classList.contains("tv")) return;
    const seats = [...snap.seats.filter(s => live(s).length), ...snap.seats.filter(s => !live(s).length)];
    if (!seats.length) return;
    tvAt = (tvAt + 1) % seats.length;
    const s = seats[tvAt], el = document.querySelector(`.hot.pod[data-k="pod:${CSS.escape(s.id)}"]`);
    office.spotlight(s.id);
    if (el && !replay.active()) peekCard(s.id, el.getBoundingClientRect()); else peekCard(null);   // live cards never sit on a replayed floor
    const hud = document.querySelector(".tv-hud .tv-line");
    if (hud) hud.textContent = $("pulseText").textContent;
    tvTicker();
  }
  // TV mode's news ticker: the latest news scrolls along the bottom, in plain words, with when it happened.
  function tvTicker() {
    const snap = app.snap();
    const el = document.querySelector(".tv-ticker .tk-in");
    if (!el || !snap) return;
    const ICON = { report: "✓", levelup: "★", achievement: "🏆", limit: "⏸", reset: "↻", arrive: "→", leave: "←", lane: "▣" };
    const items = (snap.events || []).slice(-8).reverse().map(e => `<span class="tk-item ${esc(e.level || "")}"><b>${ICON[e.kind] || "•"}</b>${esc(panels.humanise(e.text))}<em>${esc(relTime(e.ts))}</em></span>`).join("");
    const html = items || `<span class="tk-item">Quiet in the office.</span>`;
    if (el.dataset.html !== html) { el.innerHTML = html + html; el.dataset.html = html; el.style.setProperty("--tk-dur", Math.max(30, (snap.events || []).slice(-8).length * 9) + "s"); }
  }
  function setTv(on) {
    const snap = app.snap();
    if (on === document.body.classList.contains("tv")) return;
    if (on) {
      setView("floor");
      const hud = document.createElement("div");
      hud.className = "tv-hud";
      hud.innerHTML = `<span class="tv-brand">${esc(snap ? snap.office.name || "Claude Office" : "Claude Office")}</span><i class="tv-dot"></i><span class="tv-line">${esc($("pulseText").textContent)}</span><span class="tv-clock"></span><button class="btn sm ghost" data-tv-exit>${icon("x", 14)}Exit TV</button>`;
      document.querySelector(".floor-frame").appendChild(hud);
      const tk = document.createElement("div"); tk.className = "tv-ticker"; tk.setAttribute("aria-hidden", "true"); tk.innerHTML = `<span class="tk-label">News</span><div class="tk-track"><div class="tk-in"></div></div>`;
      document.querySelector(".floor-frame").appendChild(tk);
      hud.querySelector("[data-tv-exit]").addEventListener("click", () => setTv(false));
      document.body.classList.add("tv");
      if (!DEMO) badge(award("big_screen"));
      tvAt = -1; clearInterval(tvTimer); tvTimer = setInterval(tvTour, 9000); setTimeout(tvTour, 600);
      try { if (document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {}); } catch { /* not allowed */ }
    } else {
      document.body.classList.remove("tv");
      clearInterval(tvTimer); office.spotlight(null); peekCard(null);
      const hud = document.querySelector(".tv-hud"); if (hud) hud.remove();
      const tk = document.querySelector(".tv-ticker"); if (tk) tk.remove();
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    }
  }
  app.setTv = setTv;
  setInterval(() => { const c = document.querySelector(".tv-clock"); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }, 1000);
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && document.body.classList.contains("tv") && QS.get("tv") !== "1") setTv(false); });

  // The room menu (right-click, or Shift+F10 / the context-menu key on a focused room): quick actions for one seat.
  function roomMenu(id, x, y, origin) {
    const snap = app.snap();
    closeRoomMenu();
    const s = snap && snap.seats.find(z => z.id === id);
    if (!s) return;
    const p = panels.persona(s), duty = s.divider ? s.divider.enabled !== false : s.status !== "benched";
    const cmd = s.kind === "claude" ? `CLAUDE_CONFIG_DIR=${s.config_dir} claude` : s.start_cmd || "codex -C <folder>";
    const items = [
      ["open", "users", `Open ${p.name}`], ["card", "star", `${p.name}'s card`], ["zoom", "target", "Zoom in on the room"], ["hire", "plus", `Hire a lane for ${p.name}`],
      ["duty", duty ? "sun" : "briefcase", duty ? "Send on holiday" : "Back on duty"], ["copy", "copy", s.kind === "claude" ? "Copy the terminal command" : "Copy the Codex command"],
    ];
    const m = document.createElement("div");
    m.className = "menu room-menu"; m.setAttribute("role", "menu"); m.setAttribute("aria-label", `${p.name}'s room`);
    m.innerHTML = `<div class="rm-h" style="--seat:${esc(s.color)}"><i></i><b>${esc(p.name)}</b><span>${esc(p.role)}</span></div>` +
      items.map(([k, ic, label]) => `<button class="mi" role="menuitem" data-rm="${k}">${icon(ic, 17)}<span>${esc(label)}</span></button>`).join("");
    document.body.appendChild(m);
    if (!x && !y && origin) { const r = origin.getBoundingClientRect(); x = r.left + 12; y = r.top + 12; }   // opened from the keyboard
    const z = zoomNow(), box = m.getBoundingClientRect();                                                       // the menu is zoomed with the text size
    m.style.left = Math.max(8, Math.min(innerWidth - box.width - 8, x)) / z + "px"; m.style.top = Math.max(8, Math.min(innerHeight - box.height - 8, y)) / z + "px"; m.style.right = "auto";
    const list = [...m.querySelectorAll(".mi")]; list[0].focus();
    const back = () => { closeRoomMenu(); if (origin && origin.isConnected) origin.focus({ preventScroll: true }); };
    m.addEventListener("keydown", (e) => {
      const i = list.indexOf(document.activeElement);
      const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
      if (to != null) { e.preventDefault(); list[(to + list.length) % list.length].focus(); }
      else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); back(); }
    });
    m.querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", () => {
      const k = b.dataset.rm; closeRoomMenu();
      if (k === "open") go({ kind: "seat", seat: id });
      else if (k === "card") app.openCard(id);
      else if (k === "zoom") { setView("floor"); office.focusSeat(id); }
      else if (k === "hire") { panels.hireFor(id); go({ kind: "hire" }); }
      else if (k === "duty") panels.setDuty(id, !duty);
      else if (k === "copy") navigator.clipboard.writeText(cmd).then(() => toast("Copied.", "good", 1800), () => toast("Copy failed: open the character's Settings tab instead.", "warn"));
    }));
    setTimeout(() => document.addEventListener("mousedown", roomMenuAway, true), 0);
  }
  function roomMenuAway(e) { const m = document.querySelector(".room-menu"); if (m && !m.contains(e.target)) closeRoomMenu(); }
  function closeRoomMenu() { const m = document.querySelector(".room-menu"); if (m) m.remove(); document.removeEventListener("mousedown", roomMenuAway, true); }

  // The floor legend: what the colours, badges and little icons mean.
  function legend(btn) {
    const old = document.querySelector(".legend");
    if (old) { old.remove(); btn.setAttribute("aria-expanded", "false"); btn.focus(); return; }
    const el = document.createElement("div");
    el.className = "legend"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "What the floor shows");
    const chip = (cls, text) => `<span class="lg-chip ${cls}">${text}</span>`;
    el.innerHTML = `<div class="lg-h"><b>What the floor shows</b><button class="btn sm ghost icon" data-lg-close aria-label="Close">${icon("x", 15)}</button></div>
      <div class="lg-sec">Rooms</div>
      <div class="lg-row">${chip("good", "3 working")}<span>People at the desk are busy</span></div>
      <div class="lg-row">${chip("warn", "Waiting for you")}<span>Sessions are open and idle: your turn</span></div>
      <div class="lg-row">${chip("bad", "Napping")}<span>Out of plan until the reset; the room goes dim</span></div>
      <div class="lg-row">${chip("info", "On holiday")}<span>Benched on the load divider: no new lanes</span></div>
      <div class="lg-row"><span class="lg-badge">2</span><span>Things about this seat in Needs you</span></div>
      <div class="lg-row"><span class="lg-bar"><i></i></span><span>Plan left (the tighter of 5 hours and this week)</span></div>
      <div class="lg-sec">People</div>
      <div class="lg-grid"><span>💭 Thinking</span><span>⌨ Typing (the screen shows what)</span><span>☕ Idle at the desk</span><span>? Quiet for a while</span><span>z Asleep: out of plan</span><span>🛸 A helper subagent</span></div>
      <div class="lg-sec">Signs</div>
      <div class="lg-grid"><span>🌧 Rain in a window: out of plan</span><span>☁ Clouds: under 20% left</span><span>🧢 Caps, shades, gold headphones: the character's level</span><span>🐶 Pets, palms, a vacuum: office level unlocks</span><span>🎁 A gift box: click it for a sticker</span><span>🛸 Lava lamps, a UFO: finished sticker sets</span></div>
      <div class="lg-sec">Lobby</div>
      <div class="lg-grid"><span>Elevator: office news</span><span>Cabinet: trophies</span><span>Gold frame: today's star</span><span>Screen: load divider</span><span>Green desk: hire a lane</span><span>Racks: background services</span><span>Boombox: the office radio (M)</span><span>Arcade (lounge): Bug Squash</span></div>
      <div class="lg-foot">Hover a room for a peek · right-click it for actions · double-click to zoom · drag to pan · 0 fits the office</div>`;
    btn.closest(".floor-frame").appendChild(el);
    btn.setAttribute("aria-expanded", "true");
    el.querySelector("[data-lg-close]").addEventListener("click", () => legend(btn));
    el.querySelector("[data-lg-close]").focus();
    el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); legend(btn); } });
  }

  return { peekCard, roomMenu, closeRoomMenu, legend, setTv, tv: () => document.body.classList.contains("tv") };
}

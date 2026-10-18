// Claude Office: the controller. Live data in; floor, inspector and views out.
import { createOffice } from "./office.js";
import { $, esc, store, toast, debounce, setNow, live, hydratePortraits, drawLogo, relTime, dayTime, SEAT_LABEL, fmtTok, mmss } from "./ui/util.js";
import { makePanels } from "./ui/panels.js";
import { renderTimeline, renderBoard, renderStats } from "./ui/views.js";
import { openPalette } from "./ui/palette.js";
import { sound } from "./ui/sound.js";
import { icon } from "./ui/icons.js";
import { pulse, line, reaction, voice, binding, leftOf, banter } from "./ui/personas.js";
import { makeReplay } from "./ui/replay.js";
import { dayCard } from "./ui/daycard.js";
import { award, bump, earned, progress } from "./ui/badges.js";
import { startTour } from "./ui/tour.js";
import { makeFloor } from "./ui/floor.js";
import { makeGiftBox } from "./ui/giftbox.js";
import { makeGame } from "./ui/game.js";
import { makeWeekReview } from "./ui/weekreview.js";
import { makeWrapped } from "./ui/wrapped.js";
import { makeArcade } from "./ui/arcade.js";
import { makeRadio } from "./ui/radio.js";
import { makeCards } from "./ui/charcard.js";
import { renderTokens } from "./ui/tokens.js";
import { makeBurn } from "./ui/burn.js";
import { hydrateStickers } from "./engine/stickers.js";

const TOKEN = document.querySelector('meta[name="office-token"]').content;
const DEMO = document.querySelector('meta[name="office-demo"]').content === "1";
const QS = new URLSearchParams(location.search);

const prefs = Object.assign({ theme: "dark", motion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full",
  sound: false, notify: false, privacy: false, view: "floor", tlHours: 6, statsDay: null, textSize: "auto", panel: true, seasonal: true, game: "full" }, store.get("prefs", {}));
let snap = null, view = { kind: "ceo" }, liveMode = "connecting";
const details = new Map(), histCache = new Map(), statsCache = new Map(), inflight = new Set();
const tokens = new Map();   // "range|seat" -> {data, at}
let week = null;
const chats = new Map(), pending = new Map(), drafts = store.get("drafts", {}), opened = new Set();
const seenNews = new Set();
let lastEventTs = 0;

// ------------------------------------------------------------------------------------------------ app api
// "While you were away": when this viewer last had the office open (a per-browser convenience), and what happened since.
let away = null;
const AWAY_AFTER = 3600;
function markSeen() { if (snap && !document.hidden) store.set("lastSeen", snap.now); }
async function checkAway() {
  const since = store.get("lastSeen", null);
  if (!snap || !since || snap.now - since < AWAY_AFTER) return;
  const hours = Math.max(1, Math.min(24, Math.ceil((snap.now - since) / 3600)));
  try {
    const r = await fetch(`/api/history?hours=${hours}`);
    if (!r.ok) return;
    const d = await r.json();
    away = { since: Math.max(since, d.from || since), items: (d.markers || []).filter(m => m.ts > since) };
    renderPanel(true);
  } catch { /* the briefing works without it */ }
}
document.addEventListener("visibilitychange", () => { if (document.hidden) markSeen(); else checkAway().then(markSeen); });
setInterval(markSeen, 30000);

const app = {
  demo: DEMO,
  away: () => away,
  dismissAway: () => { away = null; renderPanel(true); $("panel").focus({ preventScroll: true }); },
  broadcast: () => broadcast(),
  snap: () => snap,
  prefs: () => prefs,
  privacy: () => prefs.privacy,
  liveMode: () => liveMode,
  go,
  setView: (v) => setView(v),
  rerender: (force) => renderPanel(force),
  refresh: () => pollOnce(),
  async post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Office-Token": TOKEN }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({ error: "Bad response" }));
    if (!r.ok || data.error) throw new Error(data.error || "HTTP " + r.status);
    return data;
  },
  setPref,
  detailFor: (k) => (details.get(k) || {}).data || null,
  historyCache: (h) => { const c = histCache.get(h); if (!c || Date.now() - c.at > 60000) loadHistory(h); return c ? c.data : null; },
  weekCache: () => {   // the last 14 days for the week chart (/api/week), refreshed every 2 minutes
    if ((!week || Date.now() - week.at > 120000) && !inflight.has("week")) {
      inflight.add("week");
      fetch("/api/week?days=15").then(r => r.ok ? r.json() : null).then(d => { week = { data: d && d.days ? d.days : [], at: Date.now() }; inflight.delete("week"); if (prefs.view === "stats") renderMain(); })
        .catch(() => { week = { data: [], at: Date.now() }; inflight.delete("week"); });
    }
    return week ? week.data : null;
  },
  weekMetric: () => prefs.weekMetric || "reports",
  // Tokens (/api/tokens), per range and seat: refreshed every 2 minutes, every 5 s while the first read runs.
  tokensCache: (rng = "all", seat = null) => {
    const k = rng + "|" + (seat || ""), c = tokens.get(k);
    const stale = !c || Date.now() - c.at > (c.data && c.data.scanning ? 5000 : 120000);
    if (stale && !inflight.has("t" + k)) {
      inflight.add("t" + k);
      fetch(`/api/tokens?range=${encodeURIComponent(rng)}${seat ? "&seat=" + encodeURIComponent(seat) : ""}`).then(r => r.ok ? r.json() : null).then(d => {
        tokens.set(k, { data: d, at: Date.now() }); inflight.delete("t" + k);
        if (k === "all|") burn.onAll(d);
        if (prefs.view === "stats" || prefs.view === "tokens") renderMain();
        if (k === "all|" && view.kind === "seat") renderPanel(true);
      }).catch(() => { tokens.set(k, { data: null, at: Date.now() }); inflight.delete("t" + k); });
    }
    return c ? c.data : null;
  },
  tokenMetric: () => prefs.tokenMetric || "all",
  statsCache: (day) => { const k = day || "today"; const c = statsCache.get(k); if (!c || Date.now() - c.at > 60000) loadStats(day); return c ? c.data : null; },
  loadHistory: (h, force) => loadHistory(h, force),
  loadStats: (d, force) => loadStats(d, force),
  chatFor: (seat, id) => { const k = seat + "/" + id; const c = chats.get(k); if (!c || Date.now() - c.at > 4000) loadChat(seat, id); return c ? c.data : null; },
  chatSent(seat, id, text, r) {
    if (!DEMO) app.bump("messages", 10, "talker");
    const k = seat + "/" + id;
    if (!pending.has(k)) pending.set(k, []);
    pending.get(k).push({ ts: Date.now() / 1000, text, delivery: r.delivery });
    renderPanel(true);
    for (const ms of [1500, 5000, 12000, 25000]) setTimeout(() => loadChat(seat, id, true), ms);
    if (r.delivery === "followup") pollOnce();
  },
  pendingFor: (seat, id) => pending.get(seat + "/" + id) || [],
  draftFor: (id) => drafts[id] || "",
  setDraft: (id, text) => { if (text) drafts[id] = text; else delete drafts[id]; store.set("drafts", drafts); },
  chatJustOpened: (id) => { if (opened.has(id)) return false; opened.add(id); return true; },
};
const panels = makePanels(app);
app.humanise = (t) => panels.humanise(t);   // news in plain words, character names for seat ids (views use it too)
const office = createOffice($("stage"), {
  openCEO: () => go({ kind: "ceo" }),
  openSeat: (seat) => go({ kind: "seat", seat }, false, { floor: true }),
  openSession: (seat, id) => go({ kind: "session", seat, id }, false, { floor: true }),
  openServices: () => go({ kind: "services" }),
  openProgrammes: () => go({ kind: "programmes" }),
  openLounge: () => go({ kind: "lounge" }),
  openHire: () => go({ kind: "hire" }),
  openDivider: () => go({ kind: "divider" }),
  openNews: () => go({ kind: "news" }),
  openTrophies: () => go({ kind: "trophies" }),
  openStats: () => setView("stats"),
  onCat: () => { sound.play("purr"); if (!DEMO) badge(bump("pets", 10, "cat_person")); },
  onDouble: () => { clearTimeout(panelScroll); clearTimeout(revealT); },
  onPeek: (id, r) => floor.peekCard(id, r),
  onRoomMenu: (id, x, y, el) => floor.roomMenu(id, x, y, el),
  needsFor: (id) => panels.needsBySeat()[id] || 0,
  onLegend: (btn) => floor.legend(btn),
  onGift: (id) => giftBox.open(id),
  openArcade: () => arcade.open(),
  onRadio: () => setRadio(!radio.on),
  onHoverSeat: (id) => document.querySelectorAll("#panel [data-spot], #rightnow [data-spot]").forEach(m => m.classList.toggle("hl", !!id && m.dataset.spot === id)),
});
office.setPersonas((s) => { const p = panels.persona(s); return { ...p, lines: { ...p.lines, arrive: line(p, "arrive") } }; });
const replay = makeReplay(app, office, document.querySelector(".floor-frame"));   // the floor plays back the day (ui/replay.js)
app.replay = replay;

// ------------------------------------------------------------------------------------------------ inspector width
// Drag the handle between the floor and the inspector (or use the arrow keys); double-click puts it back.
// The width is a per-browser convenience; the floor refits itself through its ResizeObserver.
// Its limits grow with the text size, so large text never lands in a cramped column.
const PANEL_W = { min: 340, def: 440, step: 24 };
const zoomNow = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-zoom")) || 1;
const panelMin = () => Math.round(PANEL_W.min * zoomNow());
const panelDef = () => Math.round(PANEL_W.def * zoomNow());
const panelMax = () => Math.max(panelMin(), Math.min(Math.round(900 * zoomNow()), document.querySelector(".main").clientWidth - 600));   // the floor keeps ~540px
function setPanelW(w, save) {
  const v = Math.round(Math.max(panelMin(), Math.min(panelMax(), w)));
  document.documentElement.style.setProperty("--panel-w", v + "px");
  const sp = $("splitter");
  sp.setAttribute("aria-valuenow", v); sp.setAttribute("aria-valuemin", panelMin()); sp.setAttribute("aria-valuemax", panelMax());
  sp.setAttribute("aria-valuetext", `${v} pixels wide`);
  if (save) store.set("panelW", v);
  return v;
}
(function splitter() {
  const sp = $("splitter");
  let start = null;
  setPanelW(store.get("panelW", panelDef()));
  sp.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); sp.setPointerCapture(e.pointerId);
    start = { x: e.clientX, w: $("panel").getBoundingClientRect().width };
    document.body.classList.add("resizing");
  });
  sp.addEventListener("pointermove", (e) => { if (start) setPanelW(start.w + (start.x - e.clientX)); });
  const end = () => { if (!start) return; start = null; document.body.classList.remove("resizing"); setPanelW($("panel").getBoundingClientRect().width, true); };
  sp.addEventListener("pointerup", end); sp.addEventListener("pointercancel", end); sp.addEventListener("lostpointercapture", end);
  sp.addEventListener("dblclick", () => { setPanelW(panelDef(), true); toast("Inspector width reset."); });
  sp.addEventListener("keydown", (e) => {
    const w = $("panel").getBoundingClientRect().width;
    const to = { ArrowLeft: w + PANEL_W.step, ArrowRight: w - PANEL_W.step, Home: panelMin(), End: panelMax(), Enter: panelDef() }[e.key];
    if (to != null) { e.preventDefault(); setPanelW(to, true); }
  });
  addEventListener("resize", debounce(() => setPanelW(store.get("panelW", panelDef())), 150));
})();

// Text size: Auto picks larger text on big screens; the floor scales itself, everything else follows --ui-zoom.
const TEXT_ZOOM = { s: 0.92, m: 1, l: 1.12, xl: 1.25 };
const TEXT_LABEL = { auto: "Auto", s: "Small", m: "Medium", l: "Large", xl: "Extra large" };
function uiZoom() {
  if (prefs.textSize !== "auto") return TEXT_ZOOM[prefs.textSize] || 1;
  const w = innerWidth;
  return w >= 2400 ? 1.25 : w >= 1900 ? 1.15 : w >= 1600 ? 1.06 : 1;
}
function applyTextSize() { document.documentElement.style.setProperty("--ui-zoom", uiZoom()); if (typeof setPanelW === "function") setPanelW(store.get("panelW", panelDef())); }
applyTextSize();
addEventListener("resize", debounce(applyTextSize, 150));
app.textSize = () => ({ pref: prefs.textSize, zoom: uiZoom(), label: TEXT_LABEL });

// Hide the inspector for a full-width floor (the button by the clock, or \). Opening anything brings it back.
function applyPanel() {
  document.body.classList.toggle("panel-off", !prefs.panel);
  const b = $("btnPanel");
  b.innerHTML = icon("sidebar", 17);
  b.setAttribute("aria-pressed", String(!!prefs.panel));
  b.title = prefs.panel ? "Hide the inspector (\\)" : "Show the inspector (\\)";
  b.setAttribute("aria-label", prefs.panel ? "Hide the inspector" : "Show the inspector");
}
$("btnPanel").addEventListener("click", () => setPref("panel", !prefs.panel));
const shell = () => matchMedia("(min-width: 1241px) and (min-height: 640px)").matches;   // the full-height layout (app.css)
applyPanel();

// A first-visit hint on the floor itself, gone after the first click there.
(function floorHint() {
  const h = $("floorHint");
  if (store.get("welcomed", false)) return;
  h.innerHTML = `${icon("sparkles", 16)}<span>New here? Click anyone to see what they are doing and talk to them.</span><button class="btn sm primary" data-tour>Show me around</button><button class="btn sm ghost" data-dismiss-welcome aria-label="Dismiss">${icon("x", 14)}</button>`;
  h.hidden = false;
  const done = () => { store.set("welcomed", true); h.hidden = true; };
  h.querySelector("[data-dismiss-welcome]").addEventListener("click", done);
  h.querySelector("[data-tour]").addEventListener("click", () => { done(); tour(); });
  $("stage").addEventListener("pointerdown", done, { once: true });
})();

// The guided tour (ui/tour.js): from the first-visit hint, the menu or the palette. It needs the floor and the briefing.
function tour() {
  const hadPanel = prefs.panel;                 // the tour shows the inspector, then leaves it as it was
  setView("floor"); if (!hadPanel) setPref("panel", true); go({ kind: "ceo" });
  setTimeout(() => startTour({ onDone: () => { if (!hadPanel) setPref("panel", false); } }), 300);
}

const floor = makeFloor({ app, office, panels, replay, prefs, QS, DEMO, go, setView, badge: (b) => badge(b), award, zoomNow });
// The game layer (ui/game.js): goals, badges, the weekly challenge, streaks, anniversaries, combos, the level chip.
function badge(b) { game.badge(b); }
const giftBox = makeGiftBox({ app, office, panels, replay, store, DEMO, setView, prefs, forceHappy: QS.has("happy"), fullAlbum: QS.get("stickers") === "all", badge: (b) => badge(b), award, onAlbum: () => openAlbum() });
app.gifts = giftBox;
const game = makeGame({ app, office, panels, replay, store, DEMO, prefs, gifts: giftBox, view: () => view, renderPanel });
const weekReview = makeWeekReview({ app, panels, store, DEMO, prefs, gifts: giftBox, earned, toast });
app.playWeek = () => weekReview.play();
const wrapped = makeWrapped({ app, panels, store, DEMO, prefs, toast });
app.badge = (id) => badge(award(id));            // badges from the panels (a hire, a replay)
app.bump = (key, n, id) => badge(bump(key, n, id)); // counter badges (messages sent)
app.badgeProgress = () => progress({ visits: game.visits(), stickers: Object.keys(giftBox.album()).length, best: store.get("squashBest", 0) });
// The office radio (ui/radio.js): remembered across visits, but browsers only start audio after a click or a key.
const radio = makeRadio();
radio.onChange((on) => office.setRadio(on));
function setRadio(on) {
  setPref("radio", on);
  if (on ? radio.start() : (radio.stop(), true)) toast(on ? "Office radio on: lo-fi, made up as it plays. M turns it off." : "Office radio off.", "info", { ic: "volume", ms: 3500 });
}
// A gesture that is itself a radio toggle (M, the boombox, the menu item, the palette) does the toggling instead.
if (prefs.radio) {
  const wake = (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (e.key === "m" || (t && t.closest('[data-mi="radio"], .hot[aria-label^="Office radio"], .palette, .palette-back'))) return;
    removeEventListener("pointerdown", wake, true); removeEventListener("keydown", wake, true);
    if (prefs.radio && !radio.on) radio.start();
  };
  addEventListener("pointerdown", wake, true); addEventListener("keydown", wake, true);
}
const cards = makeCards({ app, panels, prefs });
const burn = makeBurn({ app, office, panels, store, DEMO, prefs, giftBox, toast, sound, replay });
app.openCard = (id) => cards.open(id);
const arcade = makeArcade({ store, onBest: (score) => { if (!DEMO && score >= 40) badge(award("exterminator")); return giftBox.grant(null, "arcade"); } });
// "Your office", scrolled to the sticker album.
function openAlbum() { if (floor.tv()) floor.setTv(false); go({ kind: "office" }, false, { anchor: "album" }); }

// ------------------------------------------------------------------------------------------------ prefs
// ?theme= and ?game= last for the visit: what was saved before them is what gets saved, until set by hand.
const qsOver = {};
const savePrefs = () => store.set("prefs", { ...prefs, ...qsOver });
// System follows the OS: the page wears "light" or "dark", so every light-theme rule applies to it too.
const lightOs = window.matchMedia ? matchMedia("(prefers-color-scheme: light)") : null;
function applyTheme() { document.documentElement.dataset.theme = prefs.theme === "system" ? (lightOs && lightOs.matches ? "light" : "dark") : prefs.theme; }
if (lightOs) lightOs.addEventListener("change", () => { if (prefs.theme === "system") applyTheme(); });
function setPref(k, v) {
  delete qsOver[k];
  prefs[k] = v; savePrefs();
  if (k === "theme") applyTheme();
  if (k === "motion") { document.documentElement.dataset.motion = v; office.setReducedMotion(v === "reduced"); }
  if (k === "sound") sound.set(v);
  if (k === "textSize") { applyTextSize(); if (view.kind === "settings") renderPanel(true); }
  if (k === "panel") applyPanel();
  if (k === "seasonal") office.setSeasonal(v);
  if (k === "game") applyGame();
  if (k === "privacy") { office.setPrivacy(v); renderPanel(true); renderMain(); rnSig = ""; if (snap) renderRightNow(); }
  if (k === "notify" && v) {
    // The switch only stays on if the browser really lets the office notify.
    const refuse = (why, later) => {
      prefs.notify = false; savePrefs(); toast(why, "warn");
      if (later && document.querySelector(".menu")) { document.querySelector(".menu").remove(); openMenu("notify"); }   // redraw an open menu
      if (view.kind === "settings") renderPanel(true);
    };
    if (!("Notification" in window)) refuse("This browser cannot show notifications.");
    else if (Notification.permission === "denied") refuse("Notifications are blocked for this page. Allow them in the browser's site settings.");
    else if (Notification.permission === "default") Notification.requestPermission().then(p => { if (p !== "granted") refuse("Notifications are blocked by the browser.", true); });
  }
}

// ------------------------------------------------------------------------------------------------ routing
function hashFor(v) {
  if (v.kind === "seat") return "#seat=" + encodeURIComponent(v.seat);
  if (v.kind === "session") return "#session=" + encodeURIComponent(v.seat) + "/" + encodeURIComponent(v.id);
  if (v.kind === "lane") return "#lane=" + encodeURIComponent(v.id);
  return v.kind === "ceo" ? "#" : "#" + v.kind;
}
function viewFromHash() {
  let h = "";
  try { h = decodeURIComponent(location.hash.slice(1)); } catch { return { kind: "ceo" }; }   // a malformed link opens the briefing
  if (!h) return { kind: "ceo" };
  const at = h.indexOf("="), k = at < 0 ? h : h.slice(0, at), rest = at < 0 ? "" : h.slice(at + 1);
  if (["seat", "session", "lane"].includes(k) && !rest) return { kind: "ceo" };
  if (k === "seat") return { kind: "seat", seat: rest };
  if (k === "session") { const i = rest.indexOf("/"); return i > 0 ? { kind: "session", seat: rest.slice(0, i), id: rest.slice(i + 1) } : { kind: "ceo" }; }
  if (k === "lane") return { kind: "lane", id: rest };
  return ["divider", "hire", "services", "programmes", "lounge", "news", "settings", "trophies", "office"].includes(k) ? { kind: k } : { kind: "ceo" };
}
window.addEventListener("hashchange", () => { const v = viewFromHash(); if (hashFor(v) !== hashFor(view)) go(v, true); });
let revealT = 0;
function go(v, fromHash, opt = {}) {
  // Opening anything brings a hidden inspector back; from the floor it waits out a double-click (which only flies the
  // camera), so the building does not re-plan under the second click.
  if (!fromHash && !prefs.panel) { clearTimeout(revealT); if (opt.floor) revealT = setTimeout(() => setPref("panel", true), 420); else setPref("panel", true); }
  if (!fromHash && hashFor(v) !== (location.hash || "#")) history.pushState(null, "", hashFor(v) === "#" ? location.pathname + location.search : hashFor(v));
  view = v;
  if (v.kind === "seat" && !fromHash && snap && !replay.active()) greet(v.seat);
  if (v.kind === "session") { loadDetail("s:" + v.seat + "/" + v.id, true); loadChat(v.seat, v.id, true); }
  if (v.kind === "lane") loadDetail("l:" + v.id, true);
  office.setSelected(v.kind === "seat" ? { seat: v.seat } : v.kind === "session" ? { seat: v.seat, session: v.id } : null);
  renderPanel(true);
  $("panel").scrollTop = 0;
  const anchor = () => (opt.anchor && document.getElementById(opt.anchor)) || $("panel");   // a section to land on, or the top
  if (opt.anchor && anchor() !== $("panel")) requestAnimationFrame(() => anchor().scrollIntoView({ block: "start" }));
  if (matchMedia("(max-width: 1240px)").matches && v.kind !== "ceo") {
    // The header is sticky: land the panel's title just below it, not under it. Wait out a double-click first: a
    // second click on the floor means "fly there", and then the page must stay on the floor.
    clearTimeout(panelScroll);
    panelScroll = setTimeout(() => {
      const y = anchor().getBoundingClientRect().top + window.scrollY - document.querySelector(".top").offsetHeight - 8;
      window.scrollTo({ top: Math.max(0, y), behavior: prefs.motion === "reduced" ? "auto" : "smooth" });
    }, 420);
  }
}
let panelScroll = 0;
// Open a character and someone at their desk looks up and says hello, in that character's voice (once a minute each).
const greeted = new Map();
function greet(id) {
  const s = snap.seats.find(x => x.id === id);
  if (!s || ["limited", "offline"].includes(s.status) || !live(s).length || Date.now() - (greeted.get(id) || 0) < 60000) return;
  greeted.set(id, Date.now());
  setTimeout(() => office.sayAtSeat(id, line(panels.persona(s), "hello"), 4500), 350);
}

// ------------------------------------------------------------------------------------------------ data
async function loadDetail(key, force) {
  const c = details.get(key);
  if (!force && c && Date.now() - c.at < 9000) return;
  details.set(key, { data: c ? c.data : null, at: Date.now() });
  const url = key.startsWith("s:") ? (() => { const [seat, id] = key.slice(2).split("/"); return `/api/session?seat=${encodeURIComponent(seat)}&id=${encodeURIComponent(id)}`; })()
    : `/api/lane?id=${encodeURIComponent(key.slice(2))}`;
  try {
    const r = await fetch(url);
    if (r.ok) { details.set(key, { data: await r.json(), at: Date.now() }); renderPanel(true); }
    else if (r.status === 400 || r.status === 404) { details.set(key, { data: { missing: true }, at: Date.now() }); renderPanel(true); }   // gone: say so
  } catch { /* keep the last copy */ }
}
async function loadChat(seat, id, force) {
  const k = seat + "/" + id;
  if (inflight.has("c" + k)) return;
  const c = chats.get(k);
  if (!force && c && Date.now() - c.at < 4000) return;
  inflight.add("c" + k);
  if (!c) chats.set(k, { data: null, at: Date.now() });
  try {
    const r = await fetch(`/api/conversation?seat=${encodeURIComponent(seat)}&id=${encodeURIComponent(id)}`);
    const data = r.ok ? await r.json() : { items: [], thread: [], delivery: "none", error: true };
    data.id = id;
    const prev = c && c.data ? JSON.stringify(c.data) : "";
    chats.set(k, { data, at: Date.now() });
    if (JSON.stringify(data) !== prev && view.kind === "session" && view.seat === seat && view.id === id) renderPanel(true, true);
  } catch { chats.set(k, { data: (c && c.data) || { items: [], thread: [], delivery: "none" }, at: Date.now() }); }
  inflight.delete("c" + k);
}
async function loadHistory(h, force) {
  const k = "h" + h; if (inflight.has(k)) return; inflight.add(k);
  if (force) histCache.delete(h);
  try { const r = await fetch(`/api/history?hours=${h}`); histCache.set(h, { data: r.ok ? await r.json() : { unavailable: true }, at: Date.now() }); }
  catch { histCache.set(h, { data: { unavailable: true }, at: Date.now() }); }
  inflight.delete(k);
  if (prefs.view === "timeline") renderMain();
  if (view.kind === "seat") renderPanel(true);
}
async function loadStats(day, force) {
  const k = day || "today"; if (inflight.has("s" + k)) return; inflight.add("s" + k);
  if (force) statsCache.delete(k);
  try {
    const r = await fetch("/api/stats" + (day ? "?day=" + encodeURIComponent(day) : ""));
    const data = r.ok ? await r.json() : { unavailable: true };
    statsCache.set(k, { data, at: Date.now() });
    if (!day && data && !data.unavailable) { office.setMvp(data.mvp); game.cheerGoals(data); }
  } catch { statsCache.set(k, { data: { unavailable: true }, at: Date.now() }); }
  inflight.delete("s" + k);
  if (prefs.view === "stats") renderMain();
  if (!day && view.kind === "seat") renderPanel(true);   // the character page's diary
}

// ------------------------------------------------------------------------------------------------ live
function apply(next) {
  if (!next || !next.seats) return;
  const first = !snap;
  snap = next; setNow(snap.now);
  if (!replay.active()) office.update(snap);   // while replaying, live data waits underneath
  renderTop(); game.renderOfficeLevel(); renderLatest(); renderRightNow(); renderMain(true);
  if (!DEMO) { game.checkBadges(); game.cheerWeekly(); game.anniversaries(); }   // the demo office never hands out badges
  if (first) { app.tokensCache(); game.visitStreak(); setTimeout(whatsNew, 1500); giftBox.sync(); setTimeout(() => (QS.has("week") ? weekReview.play() : QS.has("wrapped") ? wrapped.play() : weekReview.maybeMonday()), 3500); setTimeout(() => wrapped.maybeNewMonth(), 6000); }
  if (!replay.active()) giftBox.daily(game.visits()); // the first visit of a day finds a gift at the CEO desk
  app.tokensCache();                                  // the odometer, the belt and milestones (fetched every 2 minutes)
  renderPanel(false);
  if (first) { (snap.events || []).forEach(e => seenNews.add(e.ts + "|" + e.text)); app.statsCache(null); checkAway().then(markSeen); }
  else if (liveMode !== "live") for (const e of snap.events || []) if (e.ts > lastEventTs) safeNews(e);
  lastEventTs = Math.max(lastEventTs, ...(snap.events || []).map(e => e.ts));
  if (view.kind === "session") { loadDetail("s:" + view.seat + "/" + view.id); app.chatFor(view.seat, view.id); }
  if (view.kind === "lane") loadDetail("l:" + view.id);
}

// A teammate reacts to someone's news: cheers a report or a level-up, offers to cover a limit. Only someone at a desk,
// awake and not the one the news is about, and never more than one reaction at a time.
let lastReaction = 0;
function teammateReacts(e, kind) {
  if (!snap || replay.active() || Date.now() - lastReaction < 8000) return;
  const about = snap.seats.find(s => s.id === e.seat);
  if (!about) return;
  const mates = snap.seats.filter(s => s.id !== e.seat && !["limited", "offline", "benched"].includes(s.status) && live(s).length);
  if (!mates.length) return;
  const mate = mates[Math.floor(Math.random() * mates.length)];
  lastReaction = Date.now();
  setTimeout(() => office.sayAtSeat(mate.id, reaction(kind, panels.persona(about).name), 6000), 1800);
}

// Banter: every couple of minutes two characters at their desks trade a line (ui/personas.js banter). Never during
// replay or reduced motion, and never over another reaction.
let lastReport = 0, lastReportSeat = null;
setInterval(() => {
  if (!snap || replay.active() || prefs.motion === "reduced" || prefs.game !== "full" || document.hidden || prefs.view !== "floor" || Date.now() - lastReaction < 15000) return;
  const awake = snap.seats.filter(s => !["limited", "offline", "benched"].includes(s.status) && live(s).length);
  if (awake.length < 2 || Math.random() < 0.4) return;
  const [a, b] = awake.sort(() => Math.random() - 0.5);
  const third = (s) => s && s !== a && s !== b;        // the lines can be about someone, never about one of the speakers
  const napping = snap.seats.find(s => third(s) && s.status === "limited");
  const low = snap.seats.find(s => { const x = binding(s); return third(s) && x.left != null && x.left < 20 && s.status !== "limited"; });
  const recent = Date.now() - lastReport < 10 * 60000, reporter = recent && snap.seats.find(s => third(s) && s.id === lastReportSeat);
  const h = new Date().getHours(), name = (s) => (s ? panels.persona(s).name : "");
  const [l1, l2] = banter({ a: name(a), b: name(b), napper: name(napping), low: name(low), reporter: name(reporter),
    busy: snap.seats.flatMap(s => live(s)).filter(x => x.state === "working").length, recentReport: recent, night: h >= 22 || h < 5 });
  lastReaction = Date.now();
  office.sayAtSeat(a.id, l1, 5000);
  setTimeout(() => office.sayAtSeat(b.id, l2, 5000), 2200);
}, 45000);

const NOFX = { celebrate() {}, alarm() {}, banner() {}, say() {}, sayAtSeat() {}, shipPop() {} };
// One item of news going wrong is logged and skipped; it never stops the rest of the snapshot or the stream.
function safeNews(e) { try { onNews(e); } catch (err) { console.error("office news:", err); } }
function onNews(e) {
  const fx = replay.active() ? NOFX : office;     // while replaying, the floor shows the past: live news only toasts
  const key = e.ts + "|" + e.text;
  if (seenNews.has(key)) return;
  seenNews.add(key);
  if (seenNews.size > 2000) seenNews.clear();
  const seat = snap && snap.seats.find(s => s.id === e.seat);
  const who = seat ? panels.persona(seat) : null;
  const text = panels.humanise(e.text);
  switch (e.kind) {
    case "arrive": sound.play("arrive"); break;
    case "leave": sound.play("leave"); break;
    case "report": {
      const ok = e.level === "good";
      const sid = findSessionByText(e.text);
      if (ok) { lastReport = Date.now(); lastReportSeat = e.seat; fx.celebrate(e.seat, sid, "Shipped!"); if (who) fx.say(sid, line(who, "report"), 7000); sound.play("report"); teammateReacts(e, "report"); game.comboHit(e); giftBox.earn(e.seat, "report"); }
      else sound.play("bad");
      toast(text, ok ? "good" : "warn"); notify(ok ? "Report filed" : "Lane blocked", text);
      break;
    }
    case "external": {                                 // a script's news (POST /api/event, python3 -m office post)
      const tone = { good: "good", warn: "warn", bad: "bad" }[e.level] || "info";
      if (e.seat && e.level === "good") fx.celebrate(e.seat, null, e.source || "Done!");
      if (e.banner && prefs.view === "floor") fx.banner(e.source || "News", text, { good: "#3ddc84", warn: "#ffc24b", bad: "#ff6170" }[e.level] || "#7aa8ff");
      sound.play(e.level === "bad" ? "bad" : e.level === "good" ? "report" : "arrive");
      toast(`${e.source ? e.source + ": " : ""}${text}`, tone, { ic: "bell", ms: 6000 });
      if (e.level === "bad" || e.level === "warn") notify(e.source || "Office news", text);
      break;
    }
    case "commit": {                                   // commits read from a session's transcript, one line per read
      const n = +(/: (\d+) commits?$/.exec(e.text) || [])[1] || 1;
      fx.shipPop(e.seat, `+${n} commit${n === 1 ? "" : "s"}`);
      if (who && n >= 3) fx.sayAtSeat(e.seat, `${n} commits in a minute. On a roll.`, 5000);
      break;
    }
    case "limit": fx.alarm(e.seat, "Out of plan"); if (who) fx.sayAtSeat(e.seat, line(who, "limit"), 8000); teammateReacts(e, "limit"); sound.play("limit"); toast(text, "warn"); notify("Usage limit", text); break;
    case "login": fx.alarm(e.seat, "Logged out"); sound.play("bad"); toast(text, "bad"); notify("Seat logged out", text); break;
    case "usage": if (e.level === "bad") { sound.play("bad"); toast(text, "bad"); notify("Seat nearly empty", text); } break;
    case "reset": toast(text, "good"); fx.celebrate(e.seat, null, "Fresh plan!"); sound.play("arrive"); if (who) fx.sayAtSeat(e.seat, line(who, "reset"), 6000); break;
    case "stuck": if (who) fx.sayAtSeat(e.seat, line(who, "stuck"), 7000); break;
    case "levelup":
    case "achievement": {
      const lvl = e.kind === "levelup";
      const what = lvl ? (text.match(/level (\d+)/) || [])[1] : text.split(" unlocked ")[1];
      fx.celebrate(e.seat, null, lvl ? `Level ${what}!` : what || "Unlocked!");
      if (lvl && seat && prefs.view === "floor") fx.banner("Level up!", `${who ? who.name : seat.label} is now level ${what}${seat.career ? ": " + seat.career.title : ""}`, seat.color);
      if (who) fx.sayAtSeat(e.seat, line(who, e.kind), 6500);
      if (lvl) { teammateReacts(e, "levelup"); giftBox.grant(e.seat, "levelup"); }
      if (prefs.game === "full") sound.play(e.kind);
      if (prefs.game !== "off") toast(text, "good", { ic: lvl ? "star" : "trophy", ms: 6000 });
      notify(lvl ? "Level up" : "Achievement unlocked", text);
      break;
    }
    case "shipped": {                                  // a PR opened or merged, read from a session's transcript
      const merged = / merged$/.test(e.text);
      fx.celebrate(e.seat, null, merged ? "Merged!" : "PR opened");
      if (who) fx.sayAtSeat(e.seat, merged ? "Merged. On to the next one." : "PR's up. Fingers crossed.", 6000);
      if (merged) { game.comboHit(e); giftBox.grant(e.seat, "shipped"); } else giftBox.earn(e.seat, "shipped");
      sound.play("report");
      toast(text, "good", { ic: "check", ms: 5000 });
      notify(merged ? "PR merged" : "PR opened", text);
      break;
    }
    case "reply": sound.play("arrive"); toast(text, "good"); notify("A session replied", text); for (const k of chats.keys()) chats.get(k).at = 0; break;
    case "lane":
      if (e.level === "good") { fx.celebrate(e.seat, null, "Lane done!"); sound.play("report"); notify("Office lane", text); giftBox.earn(e.seat, "lane"); }
      else if (e.level === "bad") { sound.play("bad"); notify("Office lane failed", text); }
      if (e.level !== "info") toast(text, e.level);
      break;
    default: break;
  }
  loadStats(null, true);
}
function findSessionByText(text) {
  for (const s of snap.seats) for (const x of s.sessions) if (text && text.startsWith(x.name)) return x.id;
  return null;
}
function notify(title, body) {
  if (!prefs.notify || !("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
  try { new Notification(title, { body, tag: title, silent: !prefs.sound }); } catch { /* not supported */ }
}

let es = null, pollTimer = null, sseFails = 0;
function setLive(mode) {
  liveMode = mode;
  const el = $("live");
  el.classList.toggle("off", mode !== "live" && mode !== "polling");
  el.querySelector("span").textContent = { live: "Live", polling: "Live", connecting: "Connecting", lost: "Reconnecting" }[mode] || mode;
}
function connect() {
  if (!("EventSource" in window) || sseFails >= 3 || QS.has("poll")) { startPolling(); return; }
  try { es = new EventSource("/api/stream"); } catch { startPolling(); return; }
  es.addEventListener("state", (ev) => { sseFails = 0; stopPolling(); setLive("live"); try { apply(JSON.parse(ev.data)); } catch { /* skip a bad frame */ } });
  es.addEventListener("news", (ev) => { let e; try { e = JSON.parse(ev.data); } catch { return; } safeNews(e); });
  es.onerror = () => {
    sseFails++;
    if (es.readyState === EventSource.CLOSED || sseFails >= 3) { es.close(); es = null; startPolling(); setTimeout(() => { if (!es) { sseFails = 0; connect(); } }, 30000); }
    else setLive("lost");
  };
}
async function pollOnce() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    apply(await r.json());
    if (!es) setLive("polling");
  } catch {
    setLive("lost");
    $("pulse").className = "pulse urgent";
    $("pulseText").textContent = "Can't reach the office server. Retrying every few seconds…";
  }
}
function startPolling() { if (pollTimer) return; pollOnce(); pollTimer = setInterval(() => { if (!document.hidden) pollOnce(); }, 3000); }
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

// ------------------------------------------------------------------------------------------------ header & latest
$("officeLvl").addEventListener("click", () => go({ kind: "office" }));

let badgeN = -1;
// The live burn meter: tokens the sessions at work processed in the last hour, by the Live badge; a click opens Tokens.
function renderBurn() {
  const b = $("burn"), n = snap.seats.reduce((a, s) => a + (s.tokens_1h_all || 0), 0);
  b.hidden = !n;
  if (!n) return;
  const top = [...snap.seats].sort((x, y) => (y.tokens_1h_all || 0) - (x.tokens_1h_all || 0))[0];
  const html = `${icon("flame", 13)}${fmtTok(n)}<small>/h</small>`;
  if (b.dataset.html !== html) { b.innerHTML = html; b.dataset.html = html; }
  b.title = `${n.toLocaleString()} tokens in the last hour${top && top.tokens_1h_all ? `, most by ${panels.persona(top).name}` : ""}. Click for the Tokens tab.`;
  b.setAttribute("aria-label", b.title);
  b.classList.toggle("hot", n >= 50e6);
}
$("burn").addEventListener("click", () => setView("tokens"));
function renderTop() {
  renderBurn();
  $("officeName").textContent = snap.office.name || "Claude Office";
  const bad = snap.attention.some(a => a.level === "bad"), warn = snap.attention.length > 0;
  document.title = (bad ? "● " : "") + (snap.office.name || "Claude Office");
  const p = $("pulse");
  p.className = "pulse" + (bad ? " urgent" : warn ? " attn" : "");
  const n = panels.needsCount();
  // The header says the one thing worth a glance; the whole story is in its tooltip and the briefing.
  const full = pulse(snap, (s) => panels.persona(s), dayTime), needs = n ? ` ${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you.` : "";
  $("pulseText").textContent = full.split(/(?<=\.) /)[0] + needs + (DEMO ? " (Demo office.)" : "");
  p.title = full + needs;
  if (n !== badgeN && "setAppBadge" in navigator) {   // an installed app shows the Needs-you count on its dock icon
    badgeN = n;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }
}
let latestIdx = 0, latestSig = "";
function renderLatest() {
  const ev = (snap.events || []).slice(-5).reverse();
  const sig = ev.map(e => e.ts).join(",");
  if (sig !== latestSig) { latestSig = sig; latestIdx = 0; }
  paintLatest();
}
function paintLatest() {
  const el = $("latest");
  const ev = (snap && snap.events || []).slice(-5).reverse();
  if (!ev.length) { el.innerHTML = `${icon("coffee", 18)}<span class="txt">Quiet in the office. News shows up here as agents arrive, finish and file reports.</span>`; return; }
  const e = ev[latestIdx % ev.length];
  const ic = { levelup: "star", achievement: "trophy", arrive: "play", leave: "reply", report: "check", limit: "sleep", reset: "refresh", usage: "zap", login: "alert", lane: "briefcase", reply: "chat", message: "send" }[e.kind] || "news";
  el.innerHTML = `${icon(ic, 18, { good: "good", warn: "warn", bad: "bad" }[e.level] || "")}<span class="txt" title="${esc(panels.humanise(e.text))}">${esc(panels.humanise(e.text))}</span><span class="when">${relTime(e.ts)}</span><button class="btn sm ghost" data-go-news>All news</button><button class="btn sm ghost" data-replay title="Replay the last 6 hours on the floor (R)">${icon("rewind", 15)}Replay</button>`;
  el.querySelector("[data-go-news]").addEventListener("click", () => go({ kind: "news" }));
  el.querySelector("[data-replay]").addEventListener("click", () => { setView("floor"); replay.open(6); });
}
setInterval(() => { if (snap && prefs.motion !== "reduced") { latestIdx++; paintLatest(); } }, 7000);

// Prompt cache countdowns on the session page tick every second; when one cools, the page redraws it as cooled.
setInterval(() => {
  let cooled = false;
  document.querySelectorAll("[data-cache-until]").forEach(el => {
    const left = +el.dataset.cacheUntil - Date.now() / 1000, b = el.querySelector("b");
    if (left <= 0) { el.removeAttribute("data-cache-until"); cooled = true; return; }
    if (b) b.textContent = mmss(left);
    el.classList.toggle("soon", left < 60);
  });
  if (cooled) renderPanel(true);
}, 1000);

let rnSig = "";
// The dock under the floor: one card per agent that is working or stopped, newest first. The card says who, what it is
// doing and for how long; a click opens its chat and flies the camera to its desk.
function renderRightNow() {
  const order = { working: 0, waiting: 1, stuck: 2, limited: 3 };
  const rows = snap.seats.flatMap(s => live(s).filter(x => x.state in order).map(x => ({ s, x })))
    .sort((a, b) => order[a.x.state] - order[b.x.state] || (b.x.updated_at || 0) - (a.x.updated_at || 0)).slice(0, 12);
  const w = rows.filter(r => r.x.state === "working" || r.x.state === "waiting").length, o = rows.length - w;
  const sig = JSON.stringify([prefs.privacy, rows.map(r => [r.x.id, r.x.state, r.x.activity, r.x.name, Math.floor((snap.now - (r.x.started_at || snap.now)) / 60)])]);
  if (sig === rnSig) return;
  rnSig = sig;
  $("rnCount").textContent = rows.length ? `${w} at work${o ? `, ${o} stopped` : ""}` : "";
  const el = $("rightnow");
  if (!rows.length) {
    el.innerHTML = `<div class="rn-empty">${icon("coffee", 18)}<span>Nobody is working right now.</span><button class="btn sm" data-go-hire>${icon("plus", 14)}Hire a lane</button></div>`;
    el.querySelector("[data-go-hire]").addEventListener("click", () => go({ kind: "hire" }));
    return;
  }
  const STATE = { working: "Working", waiting: "On a long tool", stuck: "Stuck", limited: "Out of plan" };
  el.innerHTML = rows.map(({ s, x }) => {
    const p = panels.persona(s);
    const act = prefs.privacy && x.kind === "desk" ? "Working…" : (x.activity || STATE[x.state]);
    const mins = x.started_at ? Math.max(0, Math.round((snap.now - x.started_at) / 60)) : null;
    const age = mins == null ? "" : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")}`;
    return `<button class="rn st-${x.state}" data-seat="${esc(s.id)}" data-id="${esc(x.id)}" data-spot="${esc(s.id)}" style="--seat:${s.color}" title="${esc(x.name)}: ${esc(act)}">
      <span class="av"><i data-portrait="${esc(x.id)}|${esc(s.color)}|${x.kind === "desk" ? "headset" : ""}"></i></span>
      <span class="rn-body"><span class="rn-top"><i class="sdot ${x.state}" title="${STATE[x.state]}"></i><b>${esc(x.name.replace(/^wt-/, ""))}</b>${x.state === "working" ? "" : `<span class="rn-state">${STATE[x.state]}</span>`}</span>
      <span class="rn-act">${esc(act)}</span><span class="rn-meta"><span class="rn-who">${esc(p.name)}</span> · ${x.kind === "lane" ? "lane" : "terminal"}${age ? " · " + age : ""}</span></span></button>`;
  }).join("");
  hydratePortraits(el, 3);
  requestAnimationFrame(() => el.classList.toggle("more", el.scrollWidth > el.clientWidth + 4 && el.scrollLeft + el.clientWidth < el.scrollWidth - 4));
  if (!el.dataset.fade) {
    el.dataset.fade = "1";
    const fade = () => el.classList.toggle("more", el.scrollWidth > el.clientWidth + 4 && el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    el.addEventListener("scroll", fade, { passive: true });
    new ResizeObserver(fade).observe(el);
  }
  el.querySelectorAll(".rn").forEach(b => {
    b.addEventListener("click", () => { go({ kind: "session", seat: b.dataset.seat, id: b.dataset.id }); office.focusSession(b.dataset.id); });
    b.addEventListener("mouseenter", () => office.spotlight(b.dataset.spot)); b.addEventListener("mouseleave", () => office.spotlight(null));
  });
}

// ------------------------------------------------------------------------------------------------ menu
// A PNG of the floor with a footer naming each character, its level and what it is doing. Only pixel art and
// character names go in: no session names, topics or accounts, so it is safe to share.
async function savePicture() {
  const { canvas: src, W: worldW } = office.picture();
  if (!src || !snap) return;
  const k = Math.max(1, Math.round(1600 / src.width)), w = src.width * k, fh = src.height * k, foot = 132;
  const c = document.createElement("canvas"); c.width = w; c.height = fh + foot;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.fillStyle = "#0a0c12"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0, w, fh);
  try { await Promise.all([document.fonts.load("26px Silkscreen"), document.fonts.load("600 17px Inter"), document.fonts.load("500 15px Inter")]); } catch { /* system fonts */ }
  const u = w / worldW;                 // the neon sign is page text on the floor, so paint it in (office.js: 254,10 92x24)
  g.save(); g.font = `${Math.round(6.2 * u)}px Silkscreen, monospace`; g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = "#ff4fd8"; g.shadowBlur = 5 * u; g.fillStyle = "#ffd8fb";
  g.fillText((snap.office.name || "Claude Office").toUpperCase(), 300 * u, 22 * u); g.restore();
  g.fillStyle = "#eef0f6"; g.font = "26px Silkscreen, monospace"; g.textBaseline = "alphabetic";
  g.fillText((snap.office.name || "Claude Office").toUpperCase(), 32, fh + 50);
  const t = snap.totals || {};
  g.font = "500 15px Inter, sans-serif"; g.fillStyle = "#9298ae";
  g.fillText(`${new Date().toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · ${t.working || 0} working, ${t.sessions || 0} sessions`, 32, fh + 78);
  g.textAlign = "right"; g.fillText("github.com/JigarJoshi04/claude-office", w - 32, fh + 50); g.textAlign = "left";
  let x = 32;
  for (const s of snap.seats) {
    const p = panels.persona(s), lv = s.career ? ` · Lv ${s.career.level}` : "";
    const label = `${p.name}${lv}`, mood = (SEAT_LABEL[s.status] || s.status || "").toLowerCase();
    g.font = "600 17px Inter, sans-serif"; const lw = g.measureText(label).width;
    g.font = "500 14px Inter, sans-serif"; const mw = g.measureText(mood).width;
    if (x + 22 + lw + 8 + mw > w - 32) break;
    g.fillStyle = s.color; g.beginPath(); g.arc(x + 6, fh + 107, 6, 0, Math.PI * 2); g.fill();
    g.font = "600 17px Inter, sans-serif"; g.fillStyle = "#eef0f6"; g.fillText(label, x + 20, fh + 113);
    g.font = "500 14px Inter, sans-serif"; g.fillStyle = "#9298ae"; g.fillText(mood, x + 20 + lw + 8, fh + 113);
    x += 20 + lw + 8 + mw + 34;
  }
  c.toBlob((b) => {
    if (!b) { toast("Could not make the picture.", "bad"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b); const d = new Date(); a.download = `claude-office-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast("Saved a picture of the office.", "good");
  }, "image/png");
}

// The day card (ui/daycard.js): shown in a dialog with Save and Copy, so it can go straight into a post or a channel.
async function shareDay() {
  const stats = app.statsCache(null);
  if (!snap || !stats || stats.unavailable) { toast("Today's numbers are still loading. Try again in a moment.", "info"); loadStats(null, true); return; }
  const c = await dayCard({ snap, stats, persona: (s) => panels.persona(s), goalDays: store.get("goalDays", []) });
  const url = c.toDataURL("image/png");
  $("dialogBody").innerHTML = `<div class="dh"><b>Today's card</b><button class="btn sm ghost" id="dcClose" aria-label="Close">${icon("x", 16)}</button></div>
    <div class="db"><img class="daycard" src="${url}" alt="A card of today's work: reports, hours, tool calls, the employee of the day, goals and the team">
    <p class="hint" style="margin:10px 0 0">Only character names, levels and counts: no session names, topics or accounts.</p>
    <div class="row" style="margin-top:14px;gap:8px"><button class="btn primary" id="dcSave">${icon("file", 15)}Save PNG</button><button class="btn" id="dcCopy">${icon("copy", 15)}Copy image</button></div></div>`;
  $("dialog").classList.add("wide"); $("dialog").showModal();
  $("dialog").addEventListener("close", () => $("dialog").classList.remove("wide"), { once: true });
  $("dcClose").addEventListener("click", () => $("dialog").close());
  $("dcSave").addEventListener("click", () => { const a = document.createElement("a"); a.href = url; a.download = `claude-office-day-${stats.day || "today"}.png`; document.body.appendChild(a); a.click(); a.remove(); toast("Saved today's card.", "good"); });
  $("dcCopy").addEventListener("click", () => c.toBlob(async (b) => {
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]); toast("Copied. Paste it into a post or a channel.", "good"); }
    catch { toast("This browser cannot copy images: use Save instead.", "warn"); }
  }, "image/png"));
  $("dcSave").focus();
  if (!DEMO) badge(award("show_and_tell"));
}
app.shareDay = shareDay;

// What's new: after an update, people who used an earlier version get a short list of what changed (once). A first
// visit gets the tour instead.
const WHATS_NEW = [
  ["gift", "Gifts and a sticker album", "Reports and finished lanes sometimes leave a gift box on the floor, and a delivery waits every morning. Open them for 24 stickers in four rarities."],
  ["star", "The office levels up", "Everyone's XP adds up to an office level that unlocks palms, a vacuum, a dog, fireworks and more. Click the gold ring."],
  ["rewind", "Replay the day", "Press R and the floor plays back the last hours."],
  ["tv", "TV mode", "Press V for the floor alone, full screen, with a news ticker."],
  ["flame", "Goals, combos and a weekly challenge", "Three new goals every day, combos for reports in a row, and a challenge to beat last week."],
  ["calendar", "Last 7 days", "Today now charts the last seven days."],
  ["sparkles", "Gear, seasons and banter", "Team caps and shades come with levels, Halloween is on the floor, and characters chat."],
  ["users", "Right-click a room", "Open, zoom, hire a lane for that seat, or send it on holiday."],
];
function whatsNew() {
  const v = snap && snap.office.version, seen = store.get("seenVersion", null);
  if (!v || DEMO) return;
  store.set("seenVersion", v);
  if (seen === v || !store.get("welcomed", false)) return;   // a returning visitor (the hint was dismissed) who has not seen this version
  $("dialogBody").innerHTML = `<div class="dh"><b>New in Claude Office ${esc(v)}</b><button class="btn sm ghost" id="wnClose" aria-label="Close">${icon("x", 16)}</button></div>
    <div class="db"><div class="wn">${WHATS_NEW.map(([ic, t, d]) => `<div class="wn-row"><span class="wn-ic">${icon(ic, 18)}</span><div><b>${esc(t)}</b><span>${esc(d)}</span></div></div>`).join("")}</div>
    <div class="row" style="margin-top:14px;gap:8px"><button class="btn primary" id="wnOk">Got it</button><button class="btn" id="wnTour">${icon("sparkles", 15)}Take the tour</button></div></div>`;
  $("dialog").showModal();
  $("wnClose").addEventListener("click", () => $("dialog").close());
  $("wnOk").addEventListener("click", () => $("dialog").close());
  $("wnTour").addEventListener("click", () => { $("dialog").close(); tour(); });
  $("wnOk").focus();
}

function shortcuts() {
  const keys = [["Ctrl K", "Search seats, sessions and actions"], ["H", "Hire a lane"], ["D", "Load divider"], ["F T B S K", "Floor, Timeline, Team, Today, Tokens"],
    ["+ − 0", "Zoom in, out, fit (floor)"], ["Arrows", "Pan the floor while zoomed"], ["Double-click", "Fly to a desk, person or room"],
    ["P", "Share-safe mode"], [",", "Settings"], ["1…9", "Open a character"], ["R", "Replay the day (space, arrows, Esc)"], ["V", "TV mode: the floor full screen"], ["M", "Office radio: lo-fi on or off"], ["Z", "Game intensity: Full, Calm, Off"], ["\\", "Hide or show the inspector"],
    ["Enter", "Send a chat message (Shift+Enter for a new line)"], ["Esc", "Close, or back to the briefing"], ["?", "This list"]];
  $("dialogBody").innerHTML = `<div class="dh"><b>Keyboard shortcuts</b><button class="btn sm ghost" id="kClose">${icon("x", 16)}</button></div>
    <div class="db"><table class="keys">${keys.map(([k, what]) => `<tr><td>${k.split(" ").map(x => `<kbd>${esc(x)}</kbd>`).join(" ")}</td><td>${esc(what)}</td></tr>`).join("")}</table></div>`;
  $("dialog").showModal();
  $("kClose").addEventListener("click", () => $("dialog").close());
  $("kClose").focus();
}

function openMenu(focusItem) {
  const old = document.querySelector(".menu"); if (old) { old.remove(); $("btnMenu").setAttribute("aria-expanded", "false"); return; }
  const m = document.createElement("div");
  m.className = "menu"; m.setAttribute("role", "menu");
  const item = (id, ic, label, state, on) => `<button class="mi" role="menuitem" data-mi="${id}">${icon(ic, 18)}<span>${label}</span>${state != null ? `<span class="state ${on ? "on" : ""}">${state}</span>` : ""}</button>`;
  m.innerHTML = item("sound", prefs.sound ? "volume" : "mute", "Sound effects", prefs.sound ? "On" : "Off", prefs.sound)
    + item("notify", "bell", "Desktop notifications", prefs.notify ? "On" : "Off", prefs.notify)
    + item("privacy", prefs.privacy ? "eyeOff" : "eye", "Share-safe mode", prefs.privacy ? "On" : "Off", prefs.privacy)
    + item("theme", prefs.theme === "light" ? "sun" : prefs.theme === "system" ? "monitor" : "moon", "Theme", { dark: "Night", light: "Day", system: "System" }[prefs.theme])
    + item("text", "textSize", "Text size", TEXT_LABEL[prefs.textSize] || "Auto")
    + "<hr>" + item("daycard", "star", "Share today's card") + item("week", "play", "Your week in review") + item("wrapped", "star", "Last month, wrapped") + item("arcade", "bug", "Play Bug Squash") + item("radio", "volume", radio.on ? "Office radio: on" : "Office radio: off", "M") + item("tv", "tv", "TV mode", "V") + item("replay", "rewind", "Replay the day", "R") + item("broadcast", "send", "Message all lanes") + item("picture", "copy", "Save a picture of the office") + item("checkpoint", "pin", "Take a checkpoint") + item("news", "news", "Office news") + item("divider", "sliders", "Load divider")
    + "<hr>" + (installPrompt ? item("install", "monitor", "Install as an app") : "") + item("tour", "sparkles", "Take the tour") + item("settings", "settings", "Settings");
  document.body.appendChild(m);
  $("btnMenu").setAttribute("aria-expanded", "true");
  // Keyboard: focus lands on the first item; arrows move, Home/End jump, Tab leaves (Escape is handled globally).
  const items = [...m.querySelectorAll(".mi")];
  const at = (focusItem && items[Math.max(0, items.findIndex(b => b.dataset.mi === focusItem))]) || items[0];
  if (at) at.focus();
  m.addEventListener("keydown", (e) => {
    const i = items.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (to != null) { e.preventDefault(); items[(to + items.length) % items.length].focus(); }
    else if (e.key === "Tab") { m.remove(); $("btnMenu").setAttribute("aria-expanded", "false"); }
  });
  m.querySelectorAll("[data-mi]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.mi;
    if (k === "sound") { setPref("sound", !prefs.sound); if (prefs.sound) sound.play("hire"); }
    else if (k === "notify") setPref("notify", !prefs.notify);
    else if (k === "privacy") setPref("privacy", !prefs.privacy);
    else if (k === "theme") setPref("theme", { dark: "light", light: "system", system: "dark" }[prefs.theme] || "dark");
    else if (k === "text") setPref("textSize", { auto: "s", s: "m", m: "l", l: "xl", xl: "auto" }[prefs.textSize] || "auto");
    else if (k === "checkpoint") checkpoint();
    else if (k === "tv") floor.setTv(true);
    else if (k === "daycard") shareDay();
    else if (k === "week") weekReview.play();
    else if (k === "wrapped") wrapped.play();
    else if (k === "arcade") arcade.open();
    else if (k === "radio") setRadio(!radio.on);
    else if (k === "tour") tour();
    else if (k === "install") installApp();
    else if (k === "replay") { setView("floor"); replay.open(6); }
    else if (k === "broadcast") broadcast();
    else if (k === "picture") savePicture();
    else go({ kind: k });
    m.remove(); $("btnMenu").setAttribute("aria-expanded", "false");
    if (["sound", "notify", "privacy", "theme", "text"].includes(k)) openMenu(k);   // a toggle keeps the menu open on that item
  }));
  setTimeout(() => document.addEventListener("mousedown", function close(ev) { if (!m.contains(ev.target) && ev.target !== $("btnMenu") && !$("btnMenu").contains(ev.target)) { m.remove(); $("btnMenu").setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", close); } }), 0);
}

// Install as an app: the browser offers it when the manifest is valid; the menu shows the item while it does.
let installPrompt = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; });
addEventListener("appinstalled", () => { installPrompt = null; toast("Installed. Claude Office opens in its own window now.", "good"); });
async function installApp() {
  if (!installPrompt) { toast("This browser cannot install it from here: use its menu, \"Install Claude Office\".", "info"); return; }
  installPrompt.prompt();
  try { await installPrompt.userChoice; } catch { /* dismissed */ }
  installPrompt = null;
}

// ------------------------------------------------------------------------------------------------ views
function setView(v) {
  if (!["floor", "timeline", "board", "stats", "tokens"].includes(v)) v = "floor";
  if (v !== "floor" && document.body.classList.contains("tv")) floor.setTv(false);   // TV mode is the floor alone
  if (v !== "floor" && typeof replay !== "undefined" && replay.active()) replay.close();   // replay lives on the floor
  mainDrawn.delete(v);
  setPref("view", v);
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.view === v));
  for (const [k, id] of [["floor", "viewFloor"], ["timeline", "viewTimeline"], ["board", "viewBoard"], ["stats", "viewStats"], ["tokens", "viewTokens"]]) $(id).hidden = k !== v;
  if (v === "timeline") loadHistory(prefs.tlHours);
  if (v === "stats") loadStats(prefs.statsDay);
  renderMain();
}
let mainSig = "";
const mainDrawn = new Set();
function renderMain(fromSnap) {
  if (!snap) return;
  const v = prefs.view;
  if (v === "floor") return;
  if (fromSnap && !mainDrawn.has(v)) fromSnap = false;
  mainDrawn.add(v);
  const el = $({ timeline: "viewTimeline", board: "viewBoard", stats: "viewStats", tokens: "viewTokens" }[v]);
  if (v === "board") { const sig = JSON.stringify(snap.seats.map(s => [s.status, s.usage && [s.usage.five_hour, s.usage.weekly], live(s).map(x => [x.id, x.state, x.activity])])) + prefs.privacy; if (fromSnap && sig === mainSig) return; mainSig = sig; renderBoard(el, app); }
  // Timeline and Today come from their own endpoints: refresh them on a clock (they redraw when the data lands),
  // keeping the old picture on screen meanwhile.
  else if (v === "timeline") { if (fromSnap) { const c = histCache.get(prefs.tlHours); if (!c || Date.now() - c.at > 60000) loadHistory(prefs.tlHours); return; } renderTimeline(el, app); }
  else if (v === "tokens") { if (fromSnap) { app.tokensCache(prefs.tokRange || "30", prefs.tokSeat || null); return; } renderTokens(el, app); }
  else if (v === "stats") { if (fromSnap) { const c = statsCache.get(prefs.statsDay || "today"); if (!prefs.statsDay && (!c || Date.now() - c.at > 120000)) loadStats(null); return; } renderStats(el, app); }
}

// ------------------------------------------------------------------------------------------------ panel
function renderPanel(force, keepScroll) {
  if (!snap) return;
  const p = $("panel"), k = view.kind;
  if (!force && panels.isEditing(k)) {
    const ll = k === "hire" && $("laneList");
    if (ll) { const html = panels.laneListHtml(); if (ll.dataset.html !== html) { ll.innerHTML = html; ll.dataset.html = html; bindCommon(ll); } }
    return;
  }
  const sel = window.getSelection && window.getSelection();
  if (!force && sel && !sel.isCollapsed && p.contains(sel.anchorNode)) return;
  const ae = document.activeElement && p.contains(document.activeElement) ? document.activeElement : null;
  const active = ae ? ae.id || null : null;
  // Controls without an id (duty switches, share fields, handles) are found again by their first data-* attribute.
  const dataAttr = ae && !ae.id ? [...ae.attributes].find(a => a.name.startsWith("data-")) : null;
  const activeSel = active ? "#" + CSS.escape(active) : dataAttr ? `[${dataAttr.name}="${CSS.escape(dataAttr.value)}"]` : null;
  if (k === "session" && active === "chatBox" && !force) return;       // don't redraw under someone typing
  const box = active === "chatBox" ? $("chatBox") : null, caret = box ? [box.selectionStart, box.selectionEnd] : null;
  const out = (panels[k] || panels.ceo)(view);
  if (!force && p.dataset.html === out.html) return;
  const top = p.scrollTop;
  const atBottom = p.scrollHeight - p.scrollTop - p.clientHeight < 60;
  const vk = JSON.stringify(view), oc = p.dataset.vk === vk ? p.querySelector(".chat") : null;   // a chat with its own scroll (phones)
  const chatScroll = oc ? { top: oc.scrollTop, end: oc.scrollHeight - oc.scrollTop - oc.clientHeight < 40 } : null;
  p.innerHTML = `<div class="panel-in">${out.html}</div>`;
  p.dataset.html = out.html; p.dataset.vk = vk;
  hydratePortraits(p, 4);
  hydrateStickers(p);
  bindCommon(p);
  if (out.bind) out.bind(p);
  const nc = chatScroll && p.querySelector(".chat");
  if (nc) nc.scrollTop = chatScroll.end ? nc.scrollHeight : chatScroll.top;
  if (!force || keepScroll) p.scrollTop = k === "session" && atBottom ? p.scrollHeight : top;
  const back = activeSel && p.querySelector(activeSel);
  if (back) { back.focus({ preventScroll: true }); if (caret) back.setSelectionRange(caret[0], caret[1]); }   // keep focus and the caret where they were
  else if (ae && !p.contains(document.activeElement)) p.focus({ preventScroll: true });   // its control went away: stay in the inspector
}
function bindCommon(p) {
  p.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go({ kind: b.dataset.go })));
  p.querySelectorAll("[data-view-go]").forEach(b => b.addEventListener("click", () => { setView(b.dataset.viewGo); if (b.dataset.anchor) setTimeout(() => { const a = document.getElementById(b.dataset.anchor); if (a) a.scrollIntoView({ block: "start", behavior: prefs.motion === "reduced" ? "auto" : "smooth" }); }, 120); }));
  p.querySelectorAll("[data-seat-go]").forEach(b => b.addEventListener("click", () => go({ kind: "seat", seat: b.dataset.seatGo })));
  p.querySelectorAll("[data-card]").forEach(b => b.addEventListener("click", () => cards.open(b.dataset.card)));
  p.querySelectorAll("[data-gift-seek]").forEach(b => b.addEventListener("click", () => giftBox.seek()));
  p.querySelectorAll("button[data-lane], .need[data-lane]").forEach(b => b.addEventListener("click", () => go({ kind: "lane", id: b.dataset.lane })));
  p.querySelectorAll(".member[data-seat], .act.click[data-seat]").forEach(r => r.addEventListener("click", () => go({ kind: "seat", seat: r.dataset.seat })));
  p.querySelectorAll(".sess").forEach(r => r.addEventListener("click", () => go({ kind: "session", seat: r.dataset.seat, id: r.dataset.id })));
  p.querySelectorAll(".need:not([data-lane])").forEach(a => a.addEventListener("click", () => {
    if (a.dataset.id) go({ kind: "session", seat: a.dataset.seat, id: a.dataset.id });
    else if (a.dataset.seat) go({ kind: "seat", seat: a.dataset.seat });
  }));
  p.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast(b.dataset.copyNote ? "Copied. " + b.dataset.copyNote : "Copied.", "good", b.dataset.copyNote ? 5000 : 1800); } catch { toast("Copy failed: select the text instead.", "warn"); }
  }));
  p.querySelectorAll("[data-refresh]").forEach(b => b.addEventListener("click", async () => {
    try { const r = await app.post("/api/usage/refresh", { seat: b.dataset.refresh }); toast(r.demo ? "Demo office: nothing to read." : "Reading the plan now."); setTimeout(pollOnce, 2500); } catch (e) { toast(e.message, "bad"); }
  }));
  p.querySelectorAll("[data-spot]").forEach(b => {   // pointing at a character lights up its room on the floor
    b.addEventListener("mouseenter", () => office.spotlight(b.dataset.spot)); b.addEventListener("mouseleave", () => office.spotlight(null));
  });
  p.querySelectorAll("[data-focus-seat]").forEach(b => b.addEventListener("click", () => { setView("floor"); office.focusSeat(b.dataset.focusSeat); }));
  p.querySelectorAll("[data-focus-session]").forEach(b => b.addEventListener("click", () => { setView("floor"); office.focusSession(b.dataset.focusSession); }));
}

// ------------------------------------------------------------------------------------------------ actions
async function checkpoint() {
  try {
    const r = await app.post("/api/checkpoint", {});
    $("dialogBody").innerHTML = `<div class="dh"><b>${r.path ? "Checkpoint saved" : "Checkpoint (demo, not saved)"}</b><button class="btn sm ghost" id="dClose">${icon("x", 16)}</button></div>
      <div class="db"><p class="muted" style="margin-top:0">Everything running right now, and the command to pick each one up again.</p>${r.path ? `<div class="copy" style="margin-bottom:12px"><code>${esc(r.path)}</code><button class="btn sm" id="dCopyPath">${icon("copy", 14)}Copy path</button></div>` : ""}
      ${prefs.privacy ? `<div class="hint" style="margin-bottom:8px">${icon("eyeOff", 14)} Share-safe is on, so the list is blurred. Copy still copies it.</div>` : ""}
      <pre class="pre ${prefs.privacy ? "private" : ""}" style="max-height:52vh">${esc(r.markdown)}</pre><div class="row" style="margin-top:12px"><button class="btn" id="dCopy">${icon("copy", 15)}Copy all</button></div></div>`;
    $("dialog").showModal();
    $("dClose").addEventListener("click", () => $("dialog").close());
    $("dCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(r.markdown); toast("Copied.", "good", 1800); } catch { toast("Copy failed.", "warn"); } });
    const cp = $("dCopyPath"); if (cp) cp.addEventListener("click", async () => { try { await navigator.clipboard.writeText(r.path); toast("Copied.", "good", 1800); } catch { /* ignore */ } });
  } catch (e) { toast("Checkpoint failed: " + e.message, "bad"); }
}
function broadcast() {
  const targets = snap.seats.flatMap(s => live(s).filter(x => x.kind === "lane" && (x.talk === "direct" || x.talk === "review")).map(x => ({ s, x })));
  const who = (s) => panels.persona(s).name;
  $("dialogBody").innerHTML = `<div class="dh"><b>Message all lanes</b><button class="btn sm ghost" id="bClose">${icon("x", 16)}</button></div>
    <div class="db">${targets.length ? `<p class="muted" style="margin-top:0">One message to every running background lane. Lanes you hired here get it straight away; others may wait for approval in their terminal.</p>
      <div class="row wrap" style="gap:6px;margin-bottom:12px">${targets.map(t => `<label class="pill" style="cursor:pointer"><input type="checkbox" data-bt="${esc(t.s.id)}|${esc(t.x.id)}" checked> ${esc(t.x.name)} · ${esc(who(t.s))}</label>`).join("")}</div>
      <textarea id="bText" placeholder="e.g. Limits reset in 20 minutes: write your progress notes now and keep going." style="min-height:110px"></textarea>
      <div class="row" style="margin-top:12px;gap:8px"><button class="btn primary" id="bSend">${icon("send", 16)}Send to selected</button><span class="hint" id="bStatus"></span></div>`
      : `<p class="muted" style="margin-top:0">No running lanes can take a message right now.</p>`}</div>`;
  $("dialog").showModal();
  if ($("bText")) $("bText").focus();
  $("bClose").addEventListener("click", () => $("dialog").close());
  const send = $("bSend");
  if (send) send.addEventListener("click", async () => {
    const text = $("bText").value.trim();
    const picked = [...document.querySelectorAll("[data-bt]")].filter(c => c.checked).map(c => c.dataset.bt.split("|"));
    if (!text || !picked.length) { toast("Write a message and pick at least one lane.", "warn"); return; }
    send.disabled = true;
    let ok = 0, held = 0, failed = 0, demo = false;
    for (const [seat, id] of picked) {
      try { const r = await app.post("/api/message", { seat, id, text }); if (r.demo) demo = true; else if (r.delivery === "review") held++; else ok++; if (!r.demo) app.chatSent(seat, id, text, r); }
      catch { failed++; }
      $("bStatus").textContent = `${ok + held + failed} of ${picked.length} sent…`;
    }
    $("dialog").close();
    if (demo) { toast("Demo office: nothing was sent."); return; }
    sound.play("hire");
    toast(`Sent to ${ok + held} lane${ok + held === 1 ? "" : "s"}${held ? `, ${held} waiting for approval` : ""}${failed ? `; ${failed} failed` : ""}.`, failed ? "warn" : "good");
  });
}
function paletteItems() {
  const items = [
    { icon: icon("coffee", 16), label: "Briefing", hint: "Esc", run: () => go({ kind: "ceo" }) },
    { icon: icon("plus", 16), label: "Hire a lane", hint: "H", keywords: "new lane dispatch task", run: () => go({ kind: "hire" }) },
    { icon: icon("sliders", 16), label: "Load divider", hint: "D", keywords: "split weights bench", run: () => go({ kind: "divider" }) },
    { icon: icon("floor", 16), label: "Floor", hint: "F", run: () => setView("floor") },
    { icon: icon("star", 16), label: "Your office: level and unlocks", keywords: "office level unlocks xp progress", run: () => go({ kind: "office" }) },
    { icon: icon("gift", 16), label: "Sticker album", keywords: "stickers album gifts collection swap", run: () => openAlbum() },
    ...(giftBox.waiting().length ? [{ icon: icon("gift", 16), label: `Find the gift on the floor (${giftBox.waiting().length} waiting)`, keywords: "gift open present box", run: () => giftBox.seek() }] : []),
    { icon: icon("sparkles", 16), label: "Take the tour", keywords: "help onboarding guide tutorial how", run: () => tour() },
    { icon: icon("star", 16), label: "Share today's card", keywords: "share picture day summary post card", run: () => shareDay() },
    { icon: icon("volume", 16), label: radio.on ? "Turn the office radio off" : "Turn the office radio on", keywords: "radio music lofi lo-fi sound play", run: () => setRadio(!radio.on) },
    ...(snap && snap.seats.length ? [{ icon: icon("star", 16), label: "Character cards", keywords: "card cards collectible trading character share picture", run: () => cards.open(snap.seats[0].id) }] : []),
    ...["full", "calm", "off"].filter(g => g !== (prefs.game || "full")).map(g => ({ icon: icon("sparkles", 16), label: `Game intensity: ${GAME_WORD[g]}`, keywords: "game calm work mode quiet focus off full celebrations", run: () => setPref("game", g) })),
    { icon: icon("bug", 16), label: "Play Bug Squash", keywords: "game arcade bugs squash play fun", run: () => arcade.open() },
    { icon: icon("star", 16), label: "Last month, wrapped", keywords: "month wrapped review recap story year", run: () => wrapped.play() },
    { icon: icon("play", 16), label: "Your week in review", keywords: "week review wrapped story recap summary", run: () => weekReview.play() },
    { icon: icon("tv", 16), label: "TV mode", hint: "V", keywords: "fullscreen wall display monitor kiosk", run: () => floor.setTv(true) },
    { icon: icon("rewind", 16), label: "Replay the last 6 hours", hint: "R", keywords: "history playback rewind day", run: () => { setView("floor"); replay.open(6); } },
    { icon: icon("rewind", 16), label: "Replay the last 24 hours", keywords: "history playback rewind day yesterday", run: () => { setView("floor"); replay.open(24); } },
    { icon: icon("timeline", 16), label: "Timeline", hint: "T", keywords: "gantt history", run: () => setView("timeline") },
    { icon: icon("users", 16), label: "Team", hint: "B", keywords: "board cards", run: () => setView("board") },
    { icon: icon("trophy", 16), label: "Today: stats and MVP", hint: "S", keywords: "league employee of the day", run: () => setView("stats") },
    { icon: icon("news", 16), label: "Office news", run: () => go({ kind: "news" }) },
    { icon: icon("star", 16), label: "Trophy room", keywords: "achievements levels xp leaderboard career", run: () => go({ kind: "trophies" }) },
    { icon: icon("pin", 16), label: "Take a checkpoint", keywords: "save resume restart laptop", run: checkpoint },
    { icon: icon("copy", 16), label: "Save a picture of the office", keywords: "screenshot png share image export", run: savePicture },
    { icon: icon("send", 16), label: "Message all lanes", keywords: "broadcast everyone announce", run: broadcast },
    { icon: icon(prefs.privacy ? "eye" : "eyeOff", 16), label: prefs.privacy ? "Turn share-safe off" : "Turn share-safe on", hint: "P", run: () => setPref("privacy", !prefs.privacy) },
    { icon: icon("volume", 16), label: prefs.sound ? "Mute sound effects" : "Turn on sound effects", run: () => setPref("sound", !prefs.sound) },
    { icon: icon("moon", 16), label: "Night theme", run: () => setPref("theme", "dark") },
    { icon: icon("sun", 16), label: "Day theme", run: () => setPref("theme", "light") },
    { icon: icon("target", 16), label: "Zoom to fit", hint: "0", run: () => { setView("floor"); office.fit(); } },
    { icon: icon("settings", 16), label: "Settings", run: () => go({ kind: "settings" }) },
    { icon: icon("sliders", 16), label: "Keyboard shortcuts", hint: "?", keywords: "keys help hotkeys", run: shortcuts },
    { icon: icon("server", 16), label: "Server room", run: () => go({ kind: "services" }) },
  ];
  // Share-safe: a terminal session's topic never becomes a search keyword.
  for (const s of snap.seats) {
    const p = panels.persona(s);
    items.push({ icon: icon("users", 16), label: `${p.name} · ${p.role}`, hint: SEAT_LABEL[s.status] || s.status, keywords: s.label, run: () => { go({ kind: "seat", seat: s.id }); if (prefs.view === "floor") office.focusSeat(s.id); } });
    for (const x of live(s)) {
      items.push({ icon: icon(x.kind === "desk" ? "terminal" : "bot", 16), label: x.name, hint: `${p.name} · ${x.state}`, keywords: prefs.privacy && x.kind === "desk" ? "" : (x.title || "") + " " + (x.activity || ""), run: () => { go({ kind: "session", seat: s.id, id: x.id }); if (prefs.view === "floor") office.focusSession(x.id); } });
      if (["direct", "review", "followup"].includes(x.talk)) items.push({ icon: icon("chat", 16), label: `Message ${x.name}`, hint: p.name, keywords: "chat talk send", run: () => go({ kind: "session", seat: s.id, id: x.id }) });
    }
  }
  for (const l of snap.lanes || []) items.push({ icon: icon("briefcase", 16), label: "Lane: " + l.title, hint: l.status, run: () => go({ kind: "lane", id: l.id }) });
  return items;
}

// ------------------------------------------------------------------------------------------------ wiring
$("btnPalette").innerHTML = `${icon("search", 17)}<span class="lbl">Search</span><kbd>Ctrl K</kbd>`;
$("btnHire").innerHTML = `${icon("plus", 17)}<span>Hire</span>`;
$("btnMenu").innerHTML = icon("menu", 19);
document.querySelectorAll(".tab").forEach(t => {
  const [ic, label] = { floor: ["floor", "Floor"], timeline: ["timeline", "Timeline"], board: ["users", "Team"], stats: ["trophy", "Today"], tokens: ["flame", "Tokens"] }[t.dataset.view];
  t.innerHTML = `${icon(ic, 17)}${label}`;
  t.addEventListener("click", () => { sound.play("click"); setView(t.dataset.view); });
});
// After a palette command, keyboard focus lands in the inspector instead of falling back to the page.
const landFocus = (items) => items.map(it => ({ ...it, run: () => { it.run(); setTimeout(() => { if (document.activeElement === document.body) $("panel").focus({ preventScroll: true }); }, 0); } }));
$("btnPalette").addEventListener("click", () => snap && openPalette(landFocus(paletteItems())));
$("btnHire").addEventListener("click", () => go({ kind: "hire" }));
$("btnMenu").addEventListener("click", (e) => { e.stopPropagation(); openMenu(); });
// Game intensity: Full, Calm (no banners, confetti, banter, party lights or game chimes) or Off (no game at all:
// no gifts, goals, combos, level chip or game toasts). Real alerts, reports and needs stay at every level.
const GAME_WORD = { full: "Full", calm: "Calm", off: "Off" };
function applyGame(quiet) {
  const g = ["full", "calm", "off"].includes(prefs.game) ? prefs.game : "full";
  document.documentElement.dataset.game = g;
  office.setGameLevel(g);
  if (typeof giftBox !== "undefined") giftBox.sync();
  if (snap) { game.renderOfficeLevel(); game.renderCombo(); game.visitStreak(); renderPanel(true); }
  if (!quiet) toast(g === "full" ? "Game: Full. Celebrations are back." : g === "calm" ? "Game: Calm. No banners, confetti or chatter; alerts stay." : "Game: Off. Just the office: no gifts, goals or celebrations.", "info", { ic: "sparkles", ms: 3500 });
}
function cycleGame() { setPref("game", { full: "calm", calm: "off", off: "full" }[prefs.game] || "calm"); }
// The code everybody knows (↑ ↑ ↓ ↓ ← → ← → B A) throws a party on the floor, and a secret badge for finding it.
const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
let konami = 0;
document.addEventListener("keydown", (e) => {
  // Not while typing or with a dialog or the palette open; the B and A that finish the code are not shortcuts.
  if ((e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) || document.querySelector(".palette-back, dialog[open]")) { konami = 0; return; }
  konami = e.key === KONAMI[konami] ? konami + 1 : e.key === KONAMI[0] ? 1 : 0;
  if (konami > 8) e.stopImmediatePropagation();
  if (konami < KONAMI.length) return;
  konami = 0;
  if (!snap || replay.active()) return;
  setView("floor");
  office.setHappy(true);
  for (const s of snap.seats) office.celebrate(s.id, null, "Party!");
  office.banner("Old school!", "↑ ↑ ↓ ↓ ← → ← → B A", "#ff4fd8");
  if ((prefs.game || "full") === "full") sound.play("happy");          // the horn is a game chime
  if (!DEMO) badge(award("old_school"));
  setTimeout(() => office.setHappy(giftBox.happy()), 20000);   // back to normal (or to the real happy hour)
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (snap) openPalette(landFocus(paletteItems())); return; }
  // A dialog or the palette owns the keyboard while it is open (Escape closes it and nothing else).
  if ((e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".palette-back, dialog[open]")) return;
  const k = e.key;
  if (replay.active()) {
    if (k === "Escape") { e.preventDefault(); replay.close(); return; }
    if (k === " ") { e.preventDefault(); replay.toggle(); return; }
    if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); replay.step(k === "ArrowLeft" ? -5 : 5); return; }
  }
  if (k === "r" && prefs.view === "floor" && !replay.active()) { replay.open(6); return; }
  if (k === "Escape" && document.querySelector(".legend")) { floor.legend(document.querySelector('[data-cam="legend"]')); return; }
  if (document.body.classList.contains("tv") && k === "Escape") { floor.setTv(false); return; }
  if (k === "v") { floor.setTv(!document.body.classList.contains("tv")); return; }
  if (k === "m") { setRadio(!radio.on); return; }
  if (k === "z") { cycleGame(); return; }
  if (k === "Escape") { const m = document.querySelector(".menu"); if (m) { m.remove(); $("btnMenu").setAttribute("aria-expanded", "false"); $("btnMenu").focus(); } else { const back = $("panel").contains(document.activeElement); go({ kind: "ceo" }); if (back) $("panel").focus({ preventScroll: true }); } }
  else if (k === "h") go({ kind: "hire" });
  else if (k === "d") go({ kind: "divider" });
  else if (k === "f") setView("floor");
  else if (k === "t") setView("timeline");
  else if (k === "b") setView("board");
  else if (k === "s") setView("stats");
  else if (k === "k") setView("tokens");
  else if (k === "p") setPref("privacy", !prefs.privacy);
  else if (k === ",") go({ kind: "settings" });
  else if (k === "?") shortcuts();
  else if (k === "\\") { if (shell()) { const inPanel = $("panel").contains(document.activeElement); setPref("panel", !prefs.panel); if (inPanel || !prefs.panel) $("btnPanel").focus(); } }
  else if (/^[1-9]$/.test(k) && snap && snap.seats[+k - 1]) go({ kind: "seat", seat: snap.seats[+k - 1].id });
  else if (prefs.view === "floor" && (k === "+" || k === "=")) office.zoom(1);
  else if (prefs.view === "floor" && k === "-") office.zoom(-1);
  else if (prefs.view === "floor" && k === "0") office.fit();
  else if (prefs.view === "floor" && k.startsWith("Arrow") && $("stage").classList.contains("zoomed")) { e.preventDefault(); office.pan(k === "ArrowLeft" ? 80 : k === "ArrowRight" ? -80 : 0, k === "ArrowUp" ? 80 : k === "ArrowDown" ? -80 : 0); }
});
setInterval(() => { $("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }, 1000);
setInterval(() => {
  if (!snap) return;
  app.statsCache(null);
  if (view.kind === "seat") app.historyCache(6);
}, 60000);
setInterval(() => { if (snap && view.kind === "session" && !document.hidden) app.chatFor(view.seat, view.id); }, 4000);

drawLogo($("logo"));
const qTheme = QS.get("theme");
if (["dark", "light", "system"].includes(qTheme)) { qsOver.theme = prefs.theme; prefs.theme = qTheme; }
applyTheme();
document.documentElement.dataset.motion = prefs.motion;
office.setReducedMotion(prefs.motion === "reduced");
if (["full", "calm", "off"].includes(QS.get("game"))) { qsOver.game = prefs.game; prefs.game = QS.get("game"); }   // ?game=calm for a screen share
applyGame(true);
office.setPrivacy(prefs.privacy);
office.setSeasonal(prefs.seasonal);
sound.set(prefs.sound);
setView(QS.get("view") || prefs.view || "floor");
view = viewFromHash();
connect();
const startT = setInterval(() => { if (snap) { clearInterval(startT); go(view, true); if (QS.get("tv") === "1") floor.setTv(true); } }, 100);
document.addEventListener("visibilitychange", () => { if (!document.hidden && !es) pollOnce(); });
export { app };

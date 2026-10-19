// Claude Office: the controller. Live data in; floor, inspector and views out.
import { createOffice } from "./office.js";
import { $, esc, store, toast, debounce, setNow, live, hydratePortraits, drawLogo, relTime, dayTime, SEAT_LABEL, fmtTok, mmss, setToastGate, clock } from "./ui/util.js";
import { configureGoals, goals, localDay } from "./ui/goals.js";
import * as scrapbook from "./ui/scrapbook.js";
import { openStandupMode } from "./ui/standupmode.js";
import { makeRecorder } from "./ui/recorder.js";
import { syncSave } from "./ui/sync.js";
import { renderLanesBoard } from "./ui/lanesboard.js";
import { md } from "./ui/md.js";
import { openVersus } from "./ui/versus.js";
import { trackNow, claim as claimChapter } from "./ui/chapters.js";
import { TOPICS as HELP_TOPICS } from "./ui/help.js";
import { openPoster } from "./ui/poster.js";
import { makeDirector } from "./ui/director.js";
import { makePanels } from "./ui/panels.js";
import { renderTimeline, renderBoard, renderStats } from "./ui/views.js";
import { openPalette, paletteCommands } from "./ui/palette.js";
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
import { makeAlarms } from "./ui/alarms.js";
import { hydrateStickers } from "./engine/stickers.js";
import { setLooks } from "./engine/sprites.js";

const TOKEN = document.querySelector('meta[name="office-token"]').content;
const DEMO = document.querySelector('meta[name="office-demo"]').content === "1";
const QS = new URLSearchParams(location.search);
const HARD_LOCK = !TOKEN;            // the /tv page: no token, read-only for good (the presenter lock, setLocked)
let locked = HARD_LOCK || QS.get("lock") === "1" || (() => { try { return sessionStorage.getItem("office.locked") === "1"; } catch { return false; } })();

const prefs = Object.assign({ theme: "dark", motion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full",
  sound: false, notify: false, privacy: false, view: "floor", tlHours: 6, statsDay: null, textSize: "auto", panel: true, seasonal: true, game: "full" }, store.get("prefs", {}));
let snap = null, view = { kind: "ceo" }, liveMode = "connecting";
const details = new Map(), histCache = new Map(), statsCache = new Map(), inflight = new Set();
const tokens = new Map();   // "range|seat" -> {data, at}
let week = null;
let loose = null;          // the last /api/loose answer and when it came
let prsData = null;        // the last /api/prs answer and when it came
const cabinet = new Map();   // "q|seat|offset" -> {data, at}: the filing cabinet's searches
const projects = new Map();  // "name|days" -> {data, at}: project drill-downs
const shippedDays = new Map();     // day -> {data, at}: what shipped (app.shippedCache)
const chats = new Map(), pending = new Map(), drafts = store.get("drafts", {}), opened = new Set();
const seenNews = new Set();
let lastEventTs = 0;

// ------------------------------------------------------------------------------------------------ app api
// "While you were away": when this viewer last had the office open (a per-browser convenience), and what happened since.
let away = null;
const AWAY_AFTER = 3600;
function markSeen() { if (snap && !document.hidden) store.set("lastSeen", snap.now); }
async function checkAway(from) {
  const since = from || store.get("lastSeen", null);
  if (!snap || !since || (!from && snap.now - since < AWAY_AFTER)) return;
  const hours = Math.max(1, Math.min(24, Math.ceil((snap.now - since) / 3600)));
  try {
    const r = await fetch(`/api/history?hours=${hours}`);
    if (!r.ok) return;
    const d = await r.json();
    away = { since: Math.max(since, d.from || since), items: (d.markers || []).filter(m => m.ts > since) };
    renderPanel(true);
    // With the analyst on, it writes the card: a headline, what needs a decision, what got done (askabout.away).
    if (snap.office.ai && snap.office.ai.enabled && away.items.length) {
      const mine = away;
      app.post("/api/ai/away", { since: mine.since }).then(b => { if (away === mine) { mine.brief = b; renderPanel(true); } }).catch(() => {});
    }
  } catch { /* the briefing works without it */ }
}
document.addEventListener("visibilitychange", () => { if (document.hidden) markSeen(); else checkAway().then(markSeen); });
// The desktop says when the CEO steps away (snap.ceo, office/presence.py): the CEO's chair empties on the floor and
// banners wait; back after ten minutes or more, "While you were away" tells that absence, even with the page left open.
let wasPresent = null;
function presenceStep(ceo) {
  const present = ceo ? ceo.present : null;
  office.setCeoAway(present === false && !replay.active());
  if (wasPresent === false && present === true && ceo.last_away && ceo.last_away.to - ceo.last_away.from >= 600) checkAway(ceo.last_away.from).then(markSeen);
  wasPresent = present;
}
setInterval(markSeen, 30000);

const app = {
  demo: DEMO,
  away: () => away,
  dismissAway: () => { away = null; renderPanel(true); $("panel").focus({ preventScroll: true }); },
  broadcast: (preset, group, value) => broadcast(preset, group, value),
  locked: () => locked,
  newsReadAt: () => newsReadTs,
  markNewsRead: () => markNewsRead(),
  snap: () => snap,
  prefs: () => prefs,
  privacy: () => prefs.privacy,
  liveMode: () => liveMode,
  go,
  openStandup: () => openStandup(),
  installApp: () => installApp(),
  canInstall: () => !!installPrompt,
  tour: () => tour(),
  setPref: (k, v) => setPref(k, v),
  remind: (when, label, text) => openRemind(when, label, text),
  setView: (v) => setView(v),
  rerender: (force) => renderPanel(force),
  refresh: () => pollOnce(),
  async post(path, body) {
    if (locked) throw new Error(HARD_LOCK ? "This is the read-only TV page." : "This screen is locked: hold Esc for 2 seconds to unlock it.");
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Office-Token": TOKEN }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({ error: "Bad response" }));
    if (r.status === 403 && /office token/.test(data.error || "")) throw new Error("The office's token has changed: reload this page to carry on.");
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
  // The filing cabinet (/api/cabinet): a search, its results, and more of them on request.
  cabinetCache: (q = "", seat = "", offset = 0) => {
    const k = `${q}|${seat}|${offset}`, c = cabinet.get(k);
    if ((!c || Date.now() - c.at > (c.data && c.data.building ? 2000 : 60000)) && !inflight.has("cab" + k)) {
      inflight.add("cab" + k);
      fetch(`/api/cabinet?q=${encodeURIComponent(q)}&seat=${encodeURIComponent(seat)}&offset=${offset}`).then(r => r.ok ? r.json() : null).then(d => {
        cabinet.set(k, { data: d, at: Date.now() }); inflight.delete("cab" + k);
        if (cabinet.size > 40) cabinet.delete(cabinet.keys().next().value);
        if (view.kind === "cabinet") renderPanel(true);
      }).catch(() => { cabinet.set(k, { data: null, at: Date.now() }); inflight.delete("cab" + k); });
    }
    return c ? c.data : null;
  },
  // A day's shipped items (/api/shipped), for the Today view.
  shippedCache: (day) => {
    const k = day || localDay(), c = shippedDays.get(k);
    if ((!c || Date.now() - c.at > 60000) && !inflight.has("shp" + k)) {
      inflight.add("shp" + k);
      fetch(`/api/shipped?day=${encodeURIComponent(k)}`).then(r => r.ok ? r.json() : null).then(d => {
        shippedDays.set(k, { data: d, at: Date.now() }); inflight.delete("shp" + k);
        if (prefs.view === "stats") renderMain();
      }).catch(() => { shippedDays.set(k, { data: null, at: Date.now() }); inflight.delete("shp" + k); });
    }
    return c ? c.data : null;
  },
  // One project's drill-down (/api/tokens/project), per range.
  projectCache: (name, days = 30) => {
    const k = `${name}|${days}`, c = projects.get(k);
    if ((!c || Date.now() - c.at > 120000) && !inflight.has("prj" + k)) {
      inflight.add("prj" + k);
      fetch(`/api/tokens/project?name=${encodeURIComponent(name)}&days=${days}`).then(r => r.ok ? r.json() : null).then(d => {
        projects.set(k, { data: d, at: Date.now() }); inflight.delete("prj" + k);
        if (projects.size > 20) projects.delete(projects.keys().next().value);
        if (view.kind === "project") renderPanel(true);
      }).catch(() => { projects.set(k, { data: null, at: Date.now() }); inflight.delete("prj" + k); });
    }
    return c ? c.data : null;
  },
  // Pull requests (/api/prs): asked for when the shelf or the briefing shows.
  prsCache: () => {
    if ((!prsData || Date.now() - prsData.at > (prsData.data && prsData.data.scanning ? 4000 : 90000)) && !inflight.has("prs")) {
      inflight.add("prs");
      fetch("/api/prs").then(r => r.ok ? r.json() : null).then(d => {
        prsData = { data: d, at: Date.now() }; inflight.delete("prs");
        if (view.kind === "prs" || view.kind === "ceo") renderPanel(true);
      }).catch(() => { prsData = { data: null, at: Date.now() }; inflight.delete("prs"); });
    }
    return prsData ? prsData.data : null;
  },
  // Loose ends (/api/loose): asked for when its page or the briefing shows; polled while a sweep runs.
  looseCache: (force = false) => {
    const stale = !loose || Date.now() - loose.at > (loose.data && loose.data.scanning ? 3000 : 60000);
    if ((stale || force) && !inflight.has("loose")) {
      inflight.add("loose");
      fetch(`/api/loose${force ? "?refresh=1" : ""}`).then(r => r.ok ? r.json() : null).then(d => {
        loose = { data: d, at: Date.now() }; inflight.delete("loose");
        if (view.kind === "loose" || view.kind === "ceo") renderPanel(true);
      }).catch(() => { loose = { data: null, at: Date.now() }; inflight.delete("loose"); });
    }
    return loose ? loose.data : null;
  },
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
app.humanise = (t) => panels.humanise(t);
app.plane = (seat, id) => office.plane(seat, id);   // a paper plane from the CEO's desk (answers in the Inbox)   // news in plain words, character names for seat ids (views use it too)
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
  openShipped: () => go({ kind: "prs" }),
  openStats: () => setView("stats"),
  onCat: () => { sound.play("purr"); if (!DEMO) badge(bump("pets", 10, "cat_person")); },
  onDouble: () => { clearTimeout(panelScroll); clearTimeout(revealT); },
  onPeek: (id, r) => floor.peekCard(id, r),
  onRoomMenu: (id, x, y, el) => floor.roomMenu(id, x, y, el),
  needsFor: (id) => panels.needsBySeat()[id] || 0,
  onLegend: (btn) => floor.legend(btn),
  onGift: (id) => giftBox.open(id),
  onMailroom: () => giftBox.openNext(),
  openArcade: () => arcade.open(),
  onRadio: () => setRadio(!radio.on),
  onDirector: () => setDirector(!prefs.director),
  onHoverSeat: (id) => document.querySelectorAll("#panel [data-spot], #rightnow [data-spot]").forEach(m => m.classList.toggle("hl", !!id && m.dataset.spot === id)),
});
office.setPersonas((s) => { const p = panels.persona(s); return { ...p, lines: { ...p.lines, arrive: line(p, "arrive") } }; });
const replay = makeReplay(app, office, document.querySelector(".floor-frame"));   // the floor plays back the day (ui/replay.js)
const recorder = makeRecorder({ office, replay, frame: document.querySelector(".floor-frame") });   // clips and timelapses (ui/recorder.js)
syncSave({ post: (path, body) => app.post(path, body), demo: DEMO, changed: () => { renderMain(); renderPanel(true, true); } });   // one game save for every screen (ui/sync.js)
const director = makeDirector({ office, prefs, replay });   // the camera flies to what just happened (ui/director.js)
function setDirector(on) {
  setPref("director", !!on); office.setDirector(!!on);
  if (!on) director.stop();
  toast(on ? "Director cam on: the camera follows what happens. Move it yourself and it waits." : "Director cam off.", "info", { ic: "eye" });
}
office.setDirector(!!prefs.director);
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
  setTimeout(() => startTour({ onDone: () => { store.set("tourDone", true); if (!hadPanel) setPref("panel", false); } }), 300);
}

const floor = makeFloor({ app, office, panels, replay, prefs, QS, DEMO, go, setView, badge: (b) => badge(b), award, zoomNow });
// The game layer (ui/game.js): goals, badges, the weekly challenge, streaks, anniversaries, combos, the level chip.
function badge(b) { game.badge(b); }
const giftBox = makeGiftBox({ app, office, panels, replay, store, DEMO, setView, prefs, forceHappy: QS.has("happy"), fullAlbum: QS.get("stickers") === "all", demoGifts: +QS.get("gifts") || 0, badge: (b) => badge(b), award, onAlbum: () => openAlbum() });
app.gifts = giftBox;
const game = makeGame({ app, office, panels, replay, store, DEMO, prefs, gifts: giftBox, view: () => view, renderPanel });
const weekReview = makeWeekReview({ app, panels, store, DEMO, prefs, gifts: giftBox, earned, toast });
app.playWeek = () => weekReview.play();
const wrapped = makeWrapped({ app, panels, store, DEMO, prefs, toast });
// The help desk's IT helper walks to a room with a stuck, looping or blocked session (office.help), on the floor in
// full game intensity, never in replay.
function helpDesk(seat, text) { if (seat && !replay.active() && prefs.game === "full" && prefs.view === "floor" && !document.hidden) office.help(seat, text); }
app.helpDesk = (seat) => helpDesk(seat, "Saw the nudge. Need a hand?");
// The connection's weather (tokens.weather): API errors in the last half hour, as a chip and a storm on the floor.
function apiWeather(w) {
  if (DEMO && QS.has("storm")) w = { sky: "stormy", errors: 4, by_kind: { server: 3, connection: 1 } };   // the demo's ?storm=1
  const chip = $("apiwx"), sky = (w && w.sky) || "clear";
  office.setApiSky && office.setApiSky(sky);
  if (sky === "clear") { chip.hidden = true; return; }
  const kinds = Object.entries(w.by_kind || {}).map(([k, n]) => `${n} ${k}`).join(", ");
  chip.hidden = false; chip.className = "wxchip " + sky;
  chip.innerHTML = `${icon(sky === "stormy" ? "zap" : "alert", 13)}API ${sky}`;
  chip.title = `${w.errors} API error${w.errors === 1 ? "" : "s"} in the last 30 minutes (${kinds}). Sessions retry on their own; the Tokens page has the days.`;
}
$("apiwx").addEventListener("click", () => setView("tokens"));
// Chapters (ui/chapters.js): the team's XP since the chapter began fills a 30-tier track; each new tier brings a gift.
let chapter = null;
app.chapter = () => chapter;
function chapterTick() {
  if (!snap || prefs.game === "off") return;
  const xp = snap.seats.reduce((a, s) => a + ((s.career || {}).xp || 0), 0);
  if (!xp) return;
  chapter = trackNow(localDay(), xp, DEMO);
  if (DEMO || replay.active()) return;
  const got = claimChapter(chapter, giftBox.grant);
  if (!got.length) return;
  const done = got.some(x => x.tier === 30), top = got.filter(x => x.tier).pop() || got[got.length - 1];
  const words = top.key ? `Chapter ${chapter.n}: vault key ${top.key}` : `Chapter ${chapter.n}: tier ${top.tier}${done ? ", the whole track" : ""}`;
  if (prefs.game === "full" && prefs.view === "floor") office.banner(done ? "Chapter complete!" : "New tier!", words, "#ffd24a");
  toast(`${words}. ${top.label}.`, "good", { ic: "star", ms: 6000 });
  if (!DEMO && done) badge(award("chapter"));
}
// Your data (export.py): CSV and JSON downloads and the month's report. They need the office token, so the page
// fetches them and saves the file itself.
async function fetchExport(qs) {
  const names = encodeURIComponent(JSON.stringify(Object.fromEntries(snap.seats.map(s => [s.id, panels.persona(s).name]))));   // the characters' names, as the page shows them
  const r = await fetch("/api/export?" + qs + (prefs.privacy ? "&safe=1" : "") + "&names=" + names, { headers: { "X-Office-Token": TOKEN } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "HTTP " + r.status);
  return r;
}
async function downloadExport(qs, name) {
  try {
    const blob = await (await fetchExport(qs)).blob(), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) { toast("Could not export it: " + e.message, "bad"); }
}
let exportSeq = 0;
async function openExport(month = localDay().slice(0, 7), from = null) {
  if (HARD_LOCK) { toast("This is the read-only TV page: exports are on the office's own page.", "info", { ic: "lock" }); return; }
  const prev = (() => { const d = new Date(month + "-15T12:00:00"); d.setMonth(d.getMonth() - 1); return localDay(d).slice(0, 7); })();
  const next = (() => { const d = new Date(month + "-15T12:00:00"); d.setMonth(d.getMonth() + 1); return localDay(d).slice(0, 7); })();
  let text = "";
  const seq = ++exportSeq;
  try { text = await (await fetchExport("what=report&month=" + month)).text(); } catch (e) { text = "Could not read the report: " + e.message; }
  if (seq !== exportSeq || (from && !$("dialog").open)) return;   // a later month was asked for, or the dialog was closed meanwhile
  const files = [["days", "csv", "Days per character"], ["careers", "csv", "Careers"], ["tokens", "csv", "Tokens per day"], ["lanes", "csv", "Lanes"], ["events", "json", "News"]];
  $("dialogBody").innerHTML = `<div class="dh"><b>Your data</b><button class="btn sm ghost" id="exClose" aria-label="Close">${icon("x", 16)}</button></div>
    <div class="db"><div class="row between" style="margin:0 0 8px"><b>The month's report</b><span class="row" style="gap:6px"><button class="btn sm ghost" data-ex-month="${prev}" aria-label="The month before">${icon("back", 14)}</button>
      <span class="hint" style="margin:0">${esc(new Date(month + "-15T12:00:00").toLocaleDateString([], { month: "long", year: "numeric" }))}</span>
      ${month < localDay().slice(0, 7) ? `<button class="btn sm ghost" data-ex-month="${next}" aria-label="The month after">${icon("chevronRight", 14)}</button>` : ""}</span></div>
    <div class="doc md ex-md">${md(text)}</div>
    <div class="row" style="gap:6px;margin:8px 0 14px"><button class="btn sm primary" id="exCopy">${icon("copy", 14)}Copy as Markdown</button><button class="btn sm" id="exSave">${icon("download", 14)}Save as .md</button></div>
    <b>Download</b><div class="row wrap" style="gap:6px;margin-top:8px">${files.map(([w, f, l]) => `<button class="btn sm" data-ex="${w}|${f}">${icon("download", 14)}${l} (${f.toUpperCase()})</button>`).join("")}<button class="btn sm" id="exCal">${icon("calendar", 14)}Plan calendar (ICS)</button></div>
    <p class="hint">From the office's own records: days for 120 days, the token ledger since the first transcript, the newest lanes, the news it kept.${prefs.privacy ? " Share-safe is on, so titles, reports and news text are left out." : ""}</p></div>`;
  if (!$("dialog").open) $("dialog").showModal();
  $("exClose").addEventListener("click", () => $("dialog").close());
  $("exCopy").addEventListener("click", () => navigator.clipboard.writeText(text).then(() => toast("The report is on the clipboard.", "good"), () => toast("Could not copy.", "warn")));
  $("exSave").addEventListener("click", () => downloadExport("what=report&month=" + month, `claude-office-${month}.md`));
  $("dialogBody").querySelectorAll("[data-ex]").forEach(b => b.addEventListener("click", () => { const [w, f] = b.dataset.ex.split("|"); downloadExport(`what=${w}&format=${f}`, `claude-office-${w}.${f}`); }));
  $("dialogBody").querySelectorAll("[data-ex-month]").forEach(b => b.addEventListener("click", () => openExport(b.dataset.exMonth, b.getAttribute("aria-label"))));
  if (from) ($("dialogBody").querySelector(`[aria-label="${from}"]`) || $("exClose")).focus();   // the keyboard stays on the arrow
  $("exCal").addEventListener("click", downloadCalendar);
}
// The week's plan resets and run-outs as a calendar file (export.plan_calendar), named as the page names the characters.
function downloadCalendar() {
  const names = encodeURIComponent(JSON.stringify(Object.fromEntries(snap.seats.map(s => [s.id, panels.persona(s).name]))));
  const a = document.createElement("a");
  a.href = "/api/calendar.ics?names=" + names; a.download = "claude-office-plans.ics"; document.body.appendChild(a); a.click(); a.remove();
  toast("The plan calendar is downloading: open the file to add the resets to your calendar.", "good", { ic: "calendar" });
}
app.openExport = () => openExport();
app.downloadExport = (qs, name) => downloadExport(qs, name);
// A Markdown export in a dialog, to copy or save: a lane's handoff pack, a conversation.
app.showMarkdown = async (title, qs, name) => {
  let text = "";
  try { text = await (await fetchExport(qs)).text(); } catch (e) { toast("Could not export it: " + e.message, "bad"); return; }
  $("dialogBody").innerHTML = `<div class="dh"><b>${esc(title)}</b><button class="btn sm ghost" id="mdClose" aria-label="Close">${icon("x", 16)}</button></div>
    <div class="db"><div class="doc md ex-md">${md(text)}</div>
    <div class="row" style="gap:6px;margin-top:10px"><button class="btn sm primary" id="mdCopy">${icon("copy", 14)}Copy as Markdown</button><button class="btn sm" id="mdSave">${icon("download", 14)}Save as .md</button></div></div>`;
  if (!$("dialog").open) $("dialog").showModal();
  $("mdClose").addEventListener("click", () => $("dialog").close());
  $("mdCopy").addEventListener("click", () => navigator.clipboard.writeText(text).then(() => toast("On the clipboard.", "good"), () => toast("Could not copy.", "warn")));
  $("mdSave").addEventListener("click", () => downloadExport(qs, name));
};
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
const alarms = makeAlarms({ app, prefs, toast, notify: (t, b) => { notifyTarget = { kind: "ceo" }; notify(t, b); }, sound, panels, DEMO, quiet: () => dndOn() });
const burn = makeBurn({ app, office, panels, store, DEMO, prefs, giftBox, toast, sound, replay, alarms });
app.openCard = (id) => cards.open(id);
const arcade = makeArcade({ store, onBest: (score) => { if (!DEMO && score >= 40) badge(award("exterminator")); return giftBox.grant(null, "arcade"); },
  onDaily: (n) => office.setSquash(n) });
office.setSquash((store.get("squashDays", {}) || {})[localDay()]);   // today's Daily run on the lounge cabinet
setInterval(() => office.setSquash((store.get("squashDays", {}) || {})[localDay()]), 60000);   // a new day clears it
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
  if (locked && k === "privacy") { toast(HARD_LOCK ? "This is the read-only TV page: share-safe stays on." : "The screen is locked: share-safe stays on until you unlock it.", "info", { ic: "lock" }); return; }
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
// The presenter lock: a screen on a TV or in a screen share stays share-safe and read-only until someone holds
// Escape (or the padlock) for two seconds. Share-safe is forced without touching the saved setting. On this page it is
// a courtesy; /tv is the guard, since that page carries no token and the office refuses its every write.
let holdT = null;
function setLocked(on) {
  if (HARD_LOCK || on === locked) return;
  locked = on;
  try { if (on) sessionStorage.setItem("office.locked", "1"); else sessionStorage.removeItem("office.locked"); } catch { /* a reload unlocks */ }
  if (on) {
    document.querySelector(".menu")?.remove(); document.querySelector(".palette-back")?.remove();
    if ($("dialog").open) $("dialog").close();
    if (!("privacy" in qsOver)) { qsOver.privacy = prefs.privacy; prefs.privacy = true; }
  } else if ("privacy" in qsOver) { prefs.privacy = qsOver.privacy; delete qsOver.privacy; }
  if (!on && QS.get("lock") === "1") { const u = new URL(location.href); u.searchParams.delete("lock"); history.replaceState(null, "", u.pathname + u.search + u.hash); }   // a reload stays unlocked
  if (on && view && LOCKED_PAGES.includes(view.kind)) go({ kind: "ceo" });
  document.body.classList.toggle("locked", on); lockChip();
  office.setPrivacy(prefs.privacy); renderPanel(true); renderMain(); rnSig = ""; if (snap) renderRightNow();
  if (!on) $("btnMenu").focus({ preventScroll: true });
  toast(on ? "Screen locked: share-safe and read-only. Hold Esc (or the padlock) for 2 seconds to unlock." : "Screen unlocked.", "info", { ic: "lock", ms: 5000 });
}
function holdStart() {
  if (holdT) return;
  if (HARD_LOCK) { toast("This is the read-only TV page. Open the office without /tv to change things.", "info", { ic: "lock" }); return; }
  $("lockChip").classList.add("holding");
  holdT = setTimeout(() => { holdT = null; $("lockChip").classList.remove("holding"); setLocked(false); }, 2000);
}
function holdStop() { clearTimeout(holdT); holdT = null; const c = $("lockChip"); if (c) c.classList.remove("holding"); }
function lockChip() {
  let c = $("lockChip");
  if (!c) {
    c = document.createElement("button");
    c.id = "lockChip"; c.type = "button"; c.className = "lockchip";
    c.innerHTML = `${icon("lock", 14)}<span>${HARD_LOCK ? "TV page: read-only" : "Locked · hold to unlock"}</span>`;
    c.title = HARD_LOCK ? "The read-only TV page: the office refuses its writes" : "Share-safe and read-only. Hold here, or hold Esc, for 2 seconds to unlock.";
    c.setAttribute("aria-label", c.title);                  // on a phone it shows the padlock alone
    c.addEventListener("pointerdown", holdStart);
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) c.addEventListener(ev, holdStop);
    c.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); holdStart(); } });
    c.addEventListener("keyup", (e) => { if (e.key === "Enter" || e.key === " ") holdStop(); });
  }
  const home = document.body.classList.contains("tv") ? document.querySelector(".tv-hud") : document.querySelector(".top .actions");
  if (home && c.parentElement !== home) home.prepend(c);   // in the layout: in the header, or in TV mode's strip
  c.hidden = !locked;
}
new MutationObserver(() => { if (locked) lockChip(); }).observe(document.body, { attributes: true, attributeFilter: ["class"] });   // TV on or off
// Pages that change things are closed while locked; the rest (seats, sessions, lanes, the floor) can be looked at.
const LOCKED_PAGES = ["hire", "settings", "divider", "inbox", "bakeoff"];
// While locked only looking around works: views, the floor's camera, TV, replay and the radio.
const LOCK_KEYS = /^(?:[ftbsklvrm?0-9=+-]|Arrow\w+| )$/;
addEventListener("keyup", (e) => { if (e.key === "Escape") holdStop(); });

// ------------------------------------------------------------------------------------------------ routing
function hashFor(v) {
  if (v.kind === "seat") return "#seat=" + encodeURIComponent(v.seat);
  if (v.kind === "session") return "#session=" + encodeURIComponent(v.seat) + "/" + encodeURIComponent(v.id);
  if (v.kind === "lane") return "#lane=" + encodeURIComponent(v.id);
  if (v.kind === "bakeoff") return "#bakeoff=" + encodeURIComponent(v.id);
  if (v.kind === "help") return "#help" + (v.topic ? "=" + encodeURIComponent(v.topic) : "");
  if (v.kind === "project") return "#project=" + encodeURIComponent(v.name);
  return v.kind === "ceo" ? "#" : "#" + v.kind;
}
function viewFromHash() {
  let h = "";
  try { h = decodeURIComponent(location.hash.slice(1)); } catch { return { kind: "ceo" }; }   // a malformed link opens the briefing
  if (!h) return { kind: "ceo" };
  const at = h.indexOf("="), k = at < 0 ? h : h.slice(0, at), rest = at < 0 ? "" : h.slice(at + 1);
  if (["seat", "session", "lane", "project"].includes(k) && !rest) return { kind: "ceo" };
  if (k === "project") return { kind: "project", name: rest.slice(0, 200) };
  if (k === "seat") return { kind: "seat", seat: rest };
  if (k === "session") { const i = rest.indexOf("/"); return i > 0 ? { kind: "session", seat: rest.slice(0, i), id: rest.slice(i + 1) } : { kind: "ceo" }; }
  if (k === "lane") return { kind: "lane", id: rest };
  if (k === "bakeoff") return { kind: "bakeoff", id: rest.slice(0, 20) };
  if (k === "help") return { kind: "help", topic: rest ? rest.slice(0, 30) : null };
  return ["divider", "hire", "services", "programmes", "lounge", "news", "settings", "trophies", "scrapbook", "office", "loose", "prs", "inbox", "cabinet", "doctor"].includes(k) ? { kind: k } : { kind: "ceo" };
}
window.addEventListener("hashchange", () => { const v = viewFromHash(); if (hashFor(v) !== hashFor(view)) go(v, true); });
let revealT = 0;
function go(v, fromHash, opt = {}) {
  if (locked && v && LOCKED_PAGES.includes(v.kind)) {
    toast(HARD_LOCK ? "This is the read-only TV page." : "The screen is locked: hold Esc for 2 seconds to unlock it.", "info", { ic: "lock" });
    if (!fromHash) return;
    v = { kind: "ceo" };                                  // a link straight to one opens the briefing instead
  }
  // Opening anything brings a hidden inspector back; from the floor it waits out a double-click (which only flies the
  // camera), so the building does not re-plan under the second click.
  if (!fromHash && !prefs.panel) { clearTimeout(revealT); if (opt.floor) revealT = setTimeout(() => setPref("panel", true), 420); else setPref("panel", true); }
  if (!fromHash && hashFor(v) !== (location.hash || "#")) history.pushState(null, "", hashFor(v) === "#" ? location.pathname + location.search : hashFor(v));
  view = v;
  if (v.kind === "seat" && !fromHash && snap && !replay.active()) greet(v.seat);
  if (v.kind === "session") { loadDetail("s:" + v.seat + "/" + v.id, true); loadChat(v.seat, v.id, true); markTalkSeen(v.seat, v.id); }
  if (v.kind === "lane") loadDetail("l:" + v.id, true);
  if (v.kind === "seat") loadDetail("p:" + v.seat, true);
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
    : key.startsWith("p:") ? `/api/postmortem?seat=${encodeURIComponent(key.slice(2))}`      // why a seat last ran out of plan
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
  prevLive = snap ? snap.seats.reduce((n, s) => n + live(s).length, 0) : null;   // who was in before this refresh (First one in)
  snap = next; setNow(snap.now);
  office.setAnnounce((next.announcements || []).length);
  if (!newsReadTs) { newsReadTs = snap.now; store.set("newsReadTs", newsReadTs); }
  if (DEMO && QS.get("levels") === "tiers") snap.seats.forEach((s, i) => { if (s.career) s.career.level = [50, 35, 25, 18, 12][i % 5]; });   // the demo's ?levels=tiers: every room tier
  if (DEMO && QS.has("faults")) snap.office.faults = [{ part: "The token ledger", what: "PermissionError: [Errno 13] Permission denied: 'tokens.json'", count: 37, since: snap.now - 1500, last: snap.now - 4 }];   // the demo's ?faults=1
  apiWeather(snap.api_weather);
  chapterTick();
  if (!DEMO && snap.promises && snap.promises.kept >= 5) badge(award("reliable"));   // the fifth kept promise (award says it once)
  setLooks(Object.fromEntries([...snap.seats.filter(s => s.look).map(s => ["mascot-" + s.id, s.look]),   // the character creator's looks
    ...(snap.office.ceo && snap.office.ceo.look ? [["ceo-" + (snap.office.ceo.name || "CEO"), snap.office.ceo.look]] : [])]));
  if (!replay.active()) office.update(snap);   // while replaying, live data waits underneath
  renderTop(); game.renderOfficeLevel(); renderLatest(); renderRightNow(); renderMain(true);
  alarms.check(snap);                                 // this viewer's burn alarms (ui/alarms.js)
  if (!DEMO) { game.checkBadges(); game.cheerWeekly(); game.anniversaries(); }   // the demo office never hands out badges
  if (first) { app.tokensCache(); game.visitStreak(); setTimeout(whatsNew, 1500); giftBox.sync(); setTimeout(() => (QS.has("week") ? weekReview.play() : QS.has("wrapped") ? wrapped.play() : weekReview.maybeMonday()), 3500); setTimeout(() => wrapped.maybeNewMonth(), 6000); }
  if (!replay.active()) giftBox.daily(game.visits()); // the first visit of a day finds a gift at the CEO desk
  app.tokensCache();                                  // the odometer, the belt and milestones (fetched every 2 minutes)
  configureGoals({ store, days: app.weekCache(), seats: snap.seats.filter(s => (s.divider || {}).enabled !== false && s.status !== "offline").length });   // today's goals follow the office's pace
  presenceStep(snap.ceo);
  office.setLightsOut((prefs.lightsOutUntil || 0) > Date.now() / 1000);   // goodnight's lights out, until the morning
  renderPanel(false);
  if (first) { (snap.events || []).forEach(e => seenNews.add(e.ts + "|" + e.text)); app.statsCache(null); checkAway().then(markSeen); setTimeout(() => standupScene(), 4000); }
  else if (liveMode !== "live") for (const e of snap.events || []) if (e.ts > lastEventTs) safeNews(e);
  lastEventTs = Math.max(lastEventTs, ...(snap.events || []).map(e => e.ts));
  if (view.kind === "session") { loadDetail("s:" + view.seat + "/" + view.id); app.chatFor(view.seat, view.id); }
  if (view.kind === "lane") loadDetail("l:" + view.id);
  if (view.kind === "seat") { const c = details.get("p:" + view.seat); if (!c || Date.now() - c.at > 60000) loadDetail("p:" + view.seat, true); }
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
  setTimeout(() => office.sayAtSeat(mate.id, reaction(kind, panels.persona(about).name, panels.persona(mate).role), 6000), 1800);
}

// The morning standup on the floor (office.js startStandup): on the day's first visit between 5 and 11, everyone on
// duty walks to the lounge and says what they did yesterday. Once a day per browser, at Full game intensity.
async function standupScene(force) {
  const h = new Date().getHours();
  if (!snap || replay.active() || prefs.motion === "reduced" || prefs.view !== "floor" || document.hidden) return;
  if (!force && (prefs.game !== "full" || h < 5 || h >= 11 || store.get("standupScene", "") === localDay())) return;
  const d = new Date(); d.setDate(d.getDate() - 1);
  let y = null;
  try { const r = await fetch("/api/stats?day=" + localDay(d)); y = r.ok ? await r.json() : null; } catch { y = null; }
  const seats = snap.seats.filter(s => s.status !== "benched" && s.status !== "offline");
  const lines = seats.map(s => {
    const v = (y && y.seats && y.seats[s.id]) || {}, bits = [];
    if (v.reports) bits.push(`${v.reports} report${v.reports === 1 ? "" : "s"}`);
    if (v.active_min) bits.push(`${(v.active_min / 60).toFixed(v.active_min >= 600 ? 0 : 1)} h at work`);
    return { seat: s.id, text: bits.length ? `Yesterday: ${bits.join(", ")}.` : "Fresh start today." };
  });
  if (office.standup(lines)) { store.set("standupScene", localDay()); office.banner("Morning standup", "Everyone to the lounge", "#ffd24a"); }
}
// Banter: every couple of minutes two characters at their desks trade a line (ui/personas.js banter). Never during
// replay or reduced motion, and never over another reaction.
let lastReport = 0, lastReportSeat = null, prevLive = null;
const banterSaid = new Set();                          // the last few exchanges, not said again soon
setInterval(() => {
  if (!snap || replay.active() || prefs.motion === "reduced" || prefs.game !== "full" || document.hidden || prefs.view !== "floor" || Date.now() - lastReaction < 15000) return;
  const awake = snap.seats.filter(s => !["limited", "offline", "benched"].includes(s.status) && live(s).length);
  if (awake.length < 2 || Math.random() < 0.4) return;
  let [a, b] = awake.sort(() => Math.random() - 0.5);
  const pair = awake.find(s => s.career && s.career.bond && s.career.bond.level && awake.some(o => o.id === s.career.bond.with));
  if (pair && Math.random() < 0.5) [a, b] = [pair, awake.find(o => o.id === pair.career.bond.with)];   // teammates chat more
  const pairBond = (x, y) => (x.career && x.career.bond && x.career.bond.with === y.id ? x.career.bond : y.career && y.career.bond && y.career.bond.with === x.id ? y.career.bond : null);
  const bondOf = (x, y) => (pairBond(x, y) || {}).level || 0;
  const third = (s) => s && s !== a && s !== b;        // the lines can be about someone, never about one of the speakers
  const napping = snap.seats.find(s => third(s) && s.status === "limited");
  const low = snap.seats.find(s => { const x = binding(s); return third(s) && x.left != null && x.left < 20 && s.status !== "limited"; });
  const recent = Date.now() - lastReport < 10 * 60000, reporter = recent && snap.seats.find(s => third(s) && s.id === lastReportSeat);
  const now = new Date(), h = now.getHours(), name = (s) => (s ? panels.persona(s).name : "");
  const today = app.tokensCache("today"), top = today && today.seats && [...today.seats].filter(x => x.seat && x.today > 0).sort((x, y) => y.today - x.today)[0];
  const leader = top && snap.seats.find(s => third(s) && s.id === top.seat), gl = goals(app.statsCache(null));
  const [l1, l2] = banter({ a: name(a), b: name(b), napper: name(napping), low: name(low), reporter: name(reporter), leader: name(leader),
    busy: snap.seats.flatMap(s => live(s)).filter(x => x.state === "working").length, recentReport: recent, night: h >= 22 || h < 5,
    goalsLeft: gl ? gl.filter(g => !g.done).length : undefined, happy: giftBox.happy(), merges: (snap.office.shipped_today || {}).prs_merged || 0,
    weekday: now.getDay(), season: office.season(), bond: bondOf(a, b), covers: (pairBond(a, b) || {}).covers || 0 }, banterSaid);
  lastReaction = Date.now();
  office.sayAtSeat(a.id, l1, 5000);
  setTimeout(() => office.sayAtSeat(b.id, l2, 5000), 2200);
}, 45000);

// Collab visits (office.visit): two characters at work in the same repository; every few minutes one walks over to
// the other's room for a word. Floor only, full game, never in replay or reduced motion.
const VISIT_LINES = ["Got a minute on {r}?", "Same repo! Compare notes on {r}?", "Mind if I look at your {r} diff?", "Are you touching {r} too?", "Pair on {r} for a bit?"];
let visitAt = 0, visitN = 0;
setInterval(() => {
  if (!snap || replay.active() || prefs.motion === "reduced" || prefs.game !== "full" || document.hidden || prefs.view !== "floor" || Date.now() - visitAt < 150000) return;
  const by = new Map();                                  // repository -> the seats with someone at work in it
  for (const s of snap.seats) {
    if (["limited", "offline", "benched"].includes(s.status)) continue;
    for (const x of live(s)) {
      const r = x.git && x.git.repo;
      if (!r || x.state !== "working") continue;
      if (!by.has(r)) by.set(r, new Set());
      by.get(r).add(s.id);
    }
  }
  const pairs = [...by.entries()].filter(([, ids]) => ids.size >= 2);
  if (!pairs.length) return;
  const [repo, ids] = pairs[visitN++ % pairs.length], list = [...ids], from = list[visitN % list.length], to = list[(visitN + 1) % list.length];
  const text = prefs.privacy ? "Got a minute? Same project." : VISIT_LINES[visitN % VISIT_LINES.length].replace("{r}", repo);
  if (office.visit(from, to, text)) visitAt = Date.now();
}, 20000);
if (DEMO && QS.get("visit")) setTimeout(() => office.visit("claude2", "claude4", "Got a minute on apollo?"), 3000);   // the demo's ?visit=1, for pictures
if (DEMO && QS.get("help")) setTimeout(() => office.help("claude2", "Quiet in here. Need a hand?"), 3000);            // and ?help=1, the help desk

// In share-safe mode, news whose words could name a session, a project or a report says only who and what kind.
const PRIVATE_NEWS = { report: "filed a report", shipped: "shipped a PR", commit: "committed work", lane: "has office lane news", external: "has news",
  reply: "replied", arrive: "started a session", leave: "finished a session", stuck: "has a quiet session", answer: "got an answer", risk: "did something risky",
  ask: "has a question for you", limit: "has a session that hit its usage limit", message: "got a message from you", collision: "has two sessions in one working tree",
  promise: "has news of a promise" };
const NOFX = { celebrate() {}, alarm() {}, banner() {}, say() {}, sayAtSeat() {}, shipPop() {}, plane() {}, mail() {}, ringBell() {} };
// One item of news going wrong is logged and skipped; it never stops the rest of the snapshot or the stream.
// A page error says so once, quietly, and reports itself to the office (the doctor lists it). Errors from browser
// extensions and the harmless ResizeObserver notice are left alone; at most a few reports a minute.
const pageErrors = new Set();
function pageError(message, where) {
  const msg = String(message || "Unknown error").slice(0, 300);
  if (/ResizeObserver loop/.test(msg) || pageErrors.has(msg) || pageErrors.size > 8) return;
  pageErrors.add(msg);
  toast("Something went wrong on this page. It keeps working; reload if something looks off.", "warn", { ms: 6000 });
  app.post("/api/client-error", { message: msg, where: where ? String(where).slice(0, 200) : null }).catch(() => {});
}
window.addEventListener("error", (e) => { if (!e.filename || e.filename.startsWith(location.origin)) pageError(e.message, e.filename ? `${e.filename.replace(location.origin, "")}:${e.lineno}` : null); });
window.addEventListener("unhandledrejection", (e) => { const r = e.reason; if (r && /Failed to fetch|NetworkError|aborted/i.test(String(r.message || r))) return; pageError(r && r.message ? r.message : String(r), r && r.stack ? String(r.stack).split("\n")[1] : null); });
// News is background: do not disturb quiets its toasts (a toast that answers something the CEO did always shows).
let inNews = 0;
function safeNews(e) { inNews++; try { onNews(e); } catch (err) { console.error("office news:", err); } finally { inNews--; } }
function onNews(e) {
  const fx = replay.active() ? NOFX : office;     // while replaying, the floor shows the past: live news only toasts
  const key = e.ts + "|" + e.text;
  if (seenNews.has(key)) return;
  seenNews.add(key);
  if (seenNews.size > 2000) seenNews.clear();
  const seat = snap && snap.seats.find(s => s.id === e.seat);
  const who = seat ? panels.persona(seat) : null;
  const text = prefs.privacy && PRIVATE_NEWS[e.kind] ? `${who ? who.name : "The office"} ${PRIVATE_NEWS[e.kind]}` : panels.humanise(e.text);   // share-safe
  const sid = e.kind === "report" ? findSessionByText(e.text) : null;
  notifyTarget = e.kind === "ask" ? { kind: "inbox" } : sid && e.seat ? { kind: "session", seat: e.seat, id: sid }
    : e.kind === "shipped" ? { kind: "prs" } : e.seat ? { kind: "seat", seat: e.seat } : null;
  switch (e.kind) {
    case "arrive": sound.play("arrive"); break;
    case "leave": sound.play("leave"); break;
    case "report": {
      const ok = e.level === "good";
      const sid = findSessionByText(e.text);
      if (ok) { lastReport = Date.now(); lastReportSeat = e.seat; fx.celebrate(e.seat, sid, "Shipped!"); if (who) fx.say(sid, line(who, "report"), 7000); sound.play("report"); teammateReacts(e, "report"); game.comboHit(e); giftBox.earn(e.seat, "report"); }
      else { sound.play("bad"); helpDesk(e.seat, /\(Contradicted:/.test(e.text) ? "Tests say otherwise? Let's look." : "Blocked? Let's see what's in the way."); }
      toast(text, ok ? "good" : "warn"); notify(ok ? "Report filed" : /\(Contradicted:/.test(e.text) ? "Report contradicted by its tests" : "Report: blocked", text);
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
    case "ask": {                                      // an agent's question for the CEO (python3 -m office ask): an alert, at every level
      const said = prefs.privacy ? "An agent asks you a question. Open the Inbox to answer." : text;   // share-safe: not the question
      sound.play("ring");
      toast(said, "warn", { ic: "bell", ms: 9000 });
      notify("A question for you", said);
      if (e.seat) fx.sayAtSeat(e.seat, "I need a decision from the CEO.", 7000);
      break;
    }
    case "commit": {                                   // commits read from a session's transcript, one line per read
      const n = +(/: (\d+) commits?$/.exec(e.text) || [])[1] || 1;
      fx.shipPop(e.seat, `+${n} commit${n === 1 ? "" : "s"}`);
      fx.mail(e.seat, n);                            // envelopes fly to the outbox by the lobby's ship board
      if (who && n >= 3) fx.sayAtSeat(e.seat, `${n} commits in a minute. On a roll.`, 5000);
      break;
    }
    case "limit": fx.alarm(e.seat, "Out of plan"); if (who) fx.sayAtSeat(e.seat, line(who, "limit"), 8000); teammateReacts(e, "limit"); sound.play("limit"); toast(text, "warn"); notify("Usage limit", text); break;
    case "login": fx.alarm(e.seat, "Logged out"); sound.play("bad"); toast(text, "bad"); notify("Seat logged out", text); break;
    case "usage": if (e.level === "bad") { sound.play("bad"); toast(text, "bad"); notify("Seat nearly empty", text); } break;
    case "reset": toast(text, "good"); fx.celebrate(e.seat, null, "Fresh plan!"); sound.play("arrive"); if (who) fx.sayAtSeat(e.seat, line(who, "reset"), 6000); teammateReacts(e, "reset"); break;
    case "stuck": if (who) fx.sayAtSeat(e.seat, line(who, "stuck"), 7000); helpDesk(e.seat, "Quiet in here. Need a hand?"); break;
    case "bond": if (prefs.game !== "off") { fx.celebrate(e.seat, null, "Teammates!"); sound.play("achievement"); toast(text, "good", { ic: "heart" }); } break;
    case "risk": case "collision": sound.play("bad"); toast(text, "bad"); notify(e.kind === "risk" ? "Risky action" : "Two sessions, one working tree", text); break;
    case "levelup":
    case "achievement": {
      const lvl = e.kind === "levelup";
      const what = lvl ? (text.match(/level (\d+)/) || [])[1] : text.split(" unlocked ")[1];
      fx.celebrate(e.seat, null, lvl ? `Level ${what}!` : what || "Unlocked!");
      if (lvl && seat && prefs.view === "floor") fx.banner("Level up!", `${who ? who.name : seat.label} is now level ${what}${seat.career ? ": " + seat.career.title : ""}`, seat.color);
      if (who) fx.sayAtSeat(e.seat, line(who, e.kind), 6500);
      if (lvl) { teammateReacts(e, "levelup"); giftBox.grant(e.seat, "levelup", null, null, `levelup-${e.seat}-${what}`); } else teammateReacts(e, "achievement");   // one gift a level, on any screen
      if (!replay.active() && who) scrapbook.capture(office, prefs, e.kind, lvl ? `${who.name} reached level ${what}` : `${who.name} unlocked ${what || "a trophy"}`, e.seat);
      if (prefs.game === "full") sound.play(e.kind);
      if (prefs.game !== "off") toast(text, "good", { ic: lvl ? "star" : "trophy", ms: 6000 });
      notify(lvl ? "Level up" : "Achievement unlocked", text);
      break;
    }
    case "shipped": {                                  // a PR opened or merged, read from a session's transcript
      const merged = / merged$/.test(e.text);
      fx.celebrate(e.seat, null, merged ? "Merged!" : "PR opened");
      if (merged) { fx.ringBell(1); teammateReacts(e, "shipped"); } else fx.mail(e.seat, 1, "parcel");   // a merge rings the ship's bell in the lobby
      if (who) fx.sayAtSeat(e.seat, merged ? "Merged. On to the next one." : "PR's up. Fingers crossed.", 6000);
      if (merged) { game.comboHit(e); giftBox.grant(e.seat, "shipped", null, null, `shipped-${e.seat}-${Math.round(e.ts)}`); } else giftBox.earn(e.seat, "shipped");
      sound.play(merged ? "bell" : "report");
      toast(text, "good", { ic: "check", ms: 5000 });
      notify(merged ? "PR merged" : "PR opened", text);
      break;
    }
    case "promise": {                                  // a promise the CEO made, kept or broken by its lane's report (promises.py)
      const kept = e.level === "good";
      if (kept) {
        fx.celebrate(e.seat, null, "Promise kept!");
        if (prefs.game !== "off") { giftBox.grant(e.seat, "promise", "rare", null, `promise-${Math.round(e.ts)}`); if (!DEMO) badge(award("word_kept")); }
        if (prefs.game === "full") sound.play("report");
      }
      toast(text, kept ? "good" : "warn", { ic: "flag", ms: 7000 });
      notify(kept ? "Promise kept" : "Promise broken", text);
      break;
    }
    case "par": {                                      // a seat's weekly plan closed, scored like a round of golf
      const good = /: (Eagle|Birdie|Par) \(/.test(e.text);
      const grade = (/: (Eagle|Birdie|Par) \(/.exec(e.text) || [])[1];
      if (good && e.seat) { fx.celebrate(e.seat, null, grade + "!"); teammateReacts(e, "par_" + grade.toLowerCase()); }
      if (prefs.game !== "off") toast(text, good ? "good" : "info", { ic: "flag", ms: 7000 });
      break;
    }
    case "reminder": {                                 // a note you left yourself (reminders.py), on every channel
      sound.play("ring");
      toast(prefs.privacy ? "A reminder you set is due." : text, "warn", { ic: "bell", ms: 12000 });
      notify("Reminder", prefs.privacy ? "A reminder you set is due." : text);
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
  if (!replay.active()) director.push({ kind: e.kind, seat: e.seat, session: sid, merged: e.kind === "shipped" && / merged$/.test(e.text) });
  if (!replay.active() && e.seat && (e.kind === "shipped" || e.kind === "report" && e.level === "good") && prefs.game !== "off") office.petsCheer(e.seat);   // the pets come to see
  if (e.kind === "arrive" && !replay.active() && new Date().getHours() >= 6 && store.get("firstIn", "") !== localDay()
      && prevLive === 0) {                                // the first one in, each morning: into an empty office (the night shift ends at 6)
    store.set("firstIn", localDay());
    const who = e.seat && snap.seats.find(s => s.id === e.seat);
    if (who && prefs.game !== "off") { fx.banner("First one in", `${panels.persona(who).name} opened the office`, who.color); toast(`${panels.persona(who).name} is the first one in today.`, "good", { ic: "sun" }); }
  }
  loadStats(null, true);
}
function findSessionByText(text) {
  for (const s of snap.seats) for (const x of s.sessions) if (text && text.startsWith(x.name)) return x.id;
  return null;
}
// A click on a notification brings the office forward on the thing it is about (set by onNews for its own news).
let notifyTarget = null;
function notify(title, body) {
  if (dndOn()) return;
  if (!prefs.notify || !("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
  const target = notifyTarget;
  try {
    const n = new Notification(title, { body, tag: title, silent: !prefs.sound });
    n.onclick = () => { window.focus(); if (target) go(target); n.close(); };
  } catch { /* not supported */ }
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
// Do not disturb, shared by every screen (POST /api/dnd): no sounds, no notifications, only serious toasts.
const dndOn = () => !!(snap && snap.office.dnd_until && snap.office.dnd_until > Date.now() / 1000);
setToastGate((level) => !inNews || !dndOn() || level === "bad");
{ const play = sound.play.bind(sound); sound.play = (...a) => { if (!dndOn()) play(...a); }; }
async function setDnd(minutes) {
  try {
    await app.post("/api/dnd", { minutes });
    pollOnce();
    if (!minutes) toast("Do not disturb is off.", "good");
  } catch (e) { toast("Could not change do not disturb: " + e.message, "bad"); }
}
const untilNine = () => { const d = new Date(); d.setDate(d.getDate() + (d.getHours() >= 9 ? 1 : 0)); d.setHours(9, 0, 0, 0); return Math.min(1440, Math.ceil((d - Date.now()) / 60000)); };
function renderDnd() {
  const chip = $("dndChip"), on = dndOn();
  chip.hidden = !on;
  if (!on) return;
  const html = `${icon("moon", 14)}<span>Quiet until ${esc(clock(snap.office.dnd_until))}</span>`;
  if (chip.dataset.html !== html) { chip.innerHTML = html; chip.dataset.html = html; }
  chip.title = "Do not disturb: no sounds or notifications, only serious toasts, on every screen. Click to end it.";
}
$("dndChip").addEventListener("click", () => setDnd(0));
// This page's code is the version it loaded with; when the office restarts on a newer one, a bar offers a reload.
let pageVersion = null;
function staleCheck() {
  const v = snap.office.version;
  if (!pageVersion) { pageVersion = v; return; }
  let bar = $("staleBar");
  if (v === pageVersion) { if (bar) bar.remove(); return; }
  if (bar) return;
  bar = document.createElement("div");
  bar.id = "staleBar"; bar.className = "stalebar"; bar.setAttribute("role", "status");
  bar.innerHTML = `${icon("refresh", 15)}<span>Claude Office was updated to ${esc(v)}. Reload to get what is new.</span><button class="btn sm primary" type="button">Reload</button><button class="btn sm ghost icon" type="button" aria-label="Not now">${icon("x", 14)}</button>`;
  bar.querySelector(".primary").addEventListener("click", () => location.reload());
  bar.querySelector(".icon").addEventListener("click", () => { bar.remove(); pageVersion = v; });
  document.body.appendChild(bar);
}
function renderTop() {
  staleCheck();
  renderDnd();
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
// Unread markers (this browser's own): the news since the last look at it, and sessions that said something new
// since you last opened them (a dot on their dock card).
let newsReadTs = store.get("newsReadTs", 0);
const seenTalk = (() => { const m = store.get("seenTalk", {}) || {}, week = Date.now() / 1000 - 7 * 86400; return Object.fromEntries(Object.entries(m).filter(([, v]) => Array.isArray(v) && v[1] > week)); })();
const textHash = (t) => { let h = 0; for (let i = 0; i < (t || "").length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; };
const unreadNews = () => (snap && snap.events || []).filter(e => e.ts > newsReadTs).length;
const saidNew = (s, x) => { const k = s.id + "/" + x.id, v = seenTalk[k]; return !!(v && x.last_text && textHash(x.last_text) !== v[0]); };
function markNewsRead() { if (!snap) return; newsReadTs = snap.now; store.set("newsReadTs", newsReadTs); paintLatest(); }
function markTalkSeen(seat, id) {
  const s = snap && snap.seats.find(z => z.id === seat), x = s && live(s).find(z => z.id === id);
  if (!x) return;
  seenTalk[seat + "/" + id] = [textHash(x.last_text), snap.now]; store.set("seenTalk", seenTalk); rnSig = ""; renderRightNow();
}
function paintLatest() {
  const el = $("latest");
  const ev = (snap && snap.events || []).slice(-5).reverse();
  if (!ev.length) { el.innerHTML = `${icon("coffee", 18)}<span class="txt">Quiet in the office. News shows up here as agents arrive, finish and file reports.</span>`; return; }
  const e = ev[latestIdx % ev.length];
  const ic = { levelup: "star", achievement: "trophy", arrive: "play", leave: "reply", report: "check", limit: "sleep", reset: "refresh", usage: "zap", login: "alert", lane: "briefcase", reply: "chat", message: "send" }[e.kind] || "news";
  el.innerHTML = `${icon(ic, 18, { good: "good", warn: "warn", bad: "bad" }[e.level] || "")}<span class="txt" title="${esc(panels.humanise(e.text))}">${esc(panels.humanise(e.text))}</span><span class="when">${relTime(e.ts)}</span><button class="btn sm ghost" data-go-news>All news${(() => { const n = unreadNews(); return n ? `<span class="count" aria-label="${n} new">${n >= 60 ? "60+" : n}</span>` : ""; })()}</button><button class="btn sm ghost" data-replay title="Replay the last 6 hours on the floor (R)">${icon("rewind", 15)}Replay</button>`;
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
  const sig = JSON.stringify([prefs.privacy, rows.map(r => [saidNew(r.s, r.x), r.x.id, r.x.state, r.x.activity, r.x.name, r.x.phase, r.x.tasks && r.x.tasks.done + "/" + r.x.tasks.total, Math.floor((snap.now - (r.x.started_at || snap.now)) / 60)])]);
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
      <span class="rn-body"><span class="rn-top"><i class="sdot ${x.state}" title="${STATE[x.state]}"></i><b>${esc(x.name.replace(/^wt-/, ""))}</b>${saidNew(s, x) ? `<i class="rn-new" title="Said something new since you last looked"></i>` : ""}${x.state === "working" ? "" : `<span class="rn-state">${STATE[x.state]}</span>`}</span>
      <span class="rn-act">${esc(act)}</span><span class="rn-meta"><span class="rn-who">${esc(p.name)}</span> · ${x.kind === "lane" ? "lane" : "terminal"}${age ? " · " + age : ""}${x.phase ? ` · <span class="ph ph-${x.phase.replace(" ", "-")}">${x.phase}</span>` : x.tasks ? ` · ${x.tasks.done}/${x.tasks.total} tasks` : ""}</span></span></button>`;
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
// "Save a picture of the office": the floor as a poster, sized for a post (ui/poster.js).
function savePicture() { openPoster(app, office, (s) => panels.persona(s)); }

// Reminders (office/reminders.py): a note for a time, or for when something happens (a plan back, a session or lane
// finishing, a PR merging). `when` is a trigger the page already knows, or none: then the dialog offers times.
function openRemind(when = null, label = "", text = "") {
  const times = [[15, "In 15 min"], [30, "In 30 min"], [60, "In 1 hour"], [120, "In 2 hours"], [0, "At a time…"]];
  $("dialogBody").innerHTML = `<div class="dh"><b>Remind me</b><button class="btn sm ghost" id="rmClose" aria-label="Close">${icon("x", 16)}</button></div>
    <div class="db"><label class="f">What<input type="text" id="rmText" maxlength="140" value="${esc(text)}" placeholder="Check the migration, reply to Vega…"></label>
      ${when ? `<p class="hint" style="margin-top:8px">${icon("bell", 13)} ${esc(label)}</p>`
        : `<div class="seg-ctl wrap" role="group" aria-label="When" style="margin-top:10px">${times.map(([m, l], i) => `<button data-rm-in="${m}" class="${i === 1 ? "on" : ""}">${l}</button>`).join("")}</div>
           <input id="rmAt" type="time" hidden style="margin-top:8px;width:auto">`}
      <div class="row" style="margin-top:12px;gap:8px"><button class="btn primary" id="rmGo">${icon("bell", 15)}Set the reminder</button></div></div>`;
  $("dialog").showModal();
  let mins = 30;
  document.querySelectorAll("[data-rm-in]").forEach(b => b.addEventListener("click", () => {
    mins = +b.dataset.rmIn; document.querySelectorAll("[data-rm-in]").forEach(x => x.classList.toggle("on", x === b)); $("rmAt").hidden = mins !== 0;
    if (!mins) $("rmAt").focus();
  }));
  $("rmClose").addEventListener("click", () => $("dialog").close());
  $("rmGo").addEventListener("click", async () => {
    let trigger = when, lbl = label;
    if (!trigger) {
      let at = Date.now() / 1000 + mins * 60;
      if (!mins) {
        const [h, m] = ($("rmAt").value || "").split(":").map(Number);
        if (!Number.isFinite(h)) { toast("Pick a time.", "warn"); return; }
        const d = new Date(); d.setHours(h, m || 0, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
        at = d.getTime() / 1000;
      }
      trigger = { kind: "at", at }; lbl = `at ${clock(at)}`;
    }
    try {
      await app.post("/api/reminders", { text: $("rmText").value, trigger, label: lbl, seat: trigger.kind === "seat_reset" ? trigger.ref : null });
      $("dialog").close(); toast(`Reminder set, ${lbl}.`, "good", { ic: "bell" }); pollOnce();
    } catch (e) { toast("Could not set it: " + e.message, "bad"); }
  });
  $("rmText").focus();
}

// Goodnight: before you go, what still needs you, who works on overnight (and a note to the lanes to write theirs),
// which seats get their plan back before morning, a checkpoint, and lights out until the morning.
function morning() { const d = new Date(); d.setHours(7, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime() / 1000; }
// Goodnight, or, with the lights already out, lights on: the G key, the menu and the palette.
const lightsOut = () => (prefs.lightsOutUntil || 0) > Date.now() / 1000;
function nightToggle() {
  if (lightsOut()) { setPref("lightsOutUntil", 0); office.setLightsOut(false); toast("Good morning. Lights on.", "good"); }
  else goodnight();
}
function goodnight() {
  if (!snap) return;                       // before the first snapshot there is nothing to sum up
  const need = panels.needsList(), working = snap.seats.flatMap(s => live(s).filter(x => x.state === "working" || x.state === "waiting"));
  const lanesUp = working.filter(x => x.kind === "lane").length, until = morning();
  const back = snap.seats.filter(s => s.kind === "claude").map(s => ({ s, at: ((s.usage || {}).five_hour || {}).resets_at }))
    .filter(x => x.at && x.at > Date.now() / 1000 && x.at < until && ((x.s.usage || {}).five_hour || {}).pct >= 50).sort((a, b) => a.at - b.at);
  const row = (ic, t, d, act = "") => `<div class="setup-step"><span class="es-ic">${icon(ic, 16)}</span><span class="grow"><b>${t}</b><small>${d}</small></span>${act}</div>`;
  $("dialogBody").innerHTML = `<div class="dh"><b>Goodnight${(snap.office.ceo || {}).name && snap.office.ceo.name !== "CEO" ? ", " + esc(snap.office.ceo.name) : ""}</b><button class="btn sm ghost" id="gnClose" aria-label="Close">${icon("x", 16)}</button></div>
    <div class="db">
      ${row("alert", need.length ? `${need.length} thing${need.length === 1 ? "" : "s"} still need${need.length === 1 ? "s" : ""} you` : "Nothing needs you", need.length ? esc(need.slice(0, 2).map(a => panels.needText(a)).join(" · ")) : "A clean desk.", need.length ? `<button class="btn sm" id="gnNeeds">Look</button>` : "")}
      ${row("moon", working.length ? `${working.length} session${working.length === 1 ? "" : "s"} at work overnight` : "Nobody at work", lanesUp ? `${lanesUp} of them ${lanesUp === 1 ? "is a lane" : "are lanes"}: ask them to write their notes before you go.` : "Lanes keep notes as they go.", lanesUp ? `<button class="btn sm" id="gnNotes">Ask for notes</button>` : "")}
      ${back.length ? row("refresh", "Back before morning", back.map(x => `${esc(panels.persona(x.s).name)} at ${esc(clock(x.at))}`).join(" · ")) : ""}
      <div class="row" style="margin-top:14px;gap:8px"><button class="btn" id="gnCheck">${icon("pin", 15)}Take a checkpoint</button><button class="btn primary" id="gnOut">${icon("moon", 15)}Lights out</button></div>
      <p class="hint">Lights out dims the floor until 7 in the morning (rooms at work keep their lights); the menu turns them back on.</p></div>`;
  $("dialog").showModal();
  $("gnClose").addEventListener("click", () => $("dialog").close());
  const nb = $("gnNeeds"); if (nb) nb.addEventListener("click", () => { $("dialog").close(); go({ kind: "ceo" }); });
  const nn = $("gnNotes"); if (nn) nn.addEventListener("click", () => { $("dialog").close(); broadcast("Before the night: write your progress notes and what you will do next, then keep going."); });
  $("gnCheck").addEventListener("click", () => { $("dialog").close(); checkpoint(); });
  $("gnOut").addEventListener("click", () => { setPref("lightsOutUntil", until); office.setLightsOut(true); $("dialog").close(); toast("Goodnight. The lights come back on at 7.", "good", { ic: "moon" }); });
  $("gnOut").focus();
}

// This morning's standup (office/standup.py): Yesterday, Today and Blockers from the office's own records, with the
// characters' names, in a dialog to copy into Slack. Share-safe blurs it on screen; copying still gives the words.
// Standup mode (ui/standupmode.js): the standup as five big slides over the live floor, for a screen share.
async function presentStandup(d) {
  if (!d) { try { const r = await fetch("/api/standup"); d = r.ok ? await r.json() : null; } catch { d = null; } }
  if (!d || !snap) { toast("Could not write the standup.", "bad"); return; }
  setView("floor");
  openStandupMode({ data: d, snap, persona: (s) => panels.persona(s), humanise: panels.humanise, privacy: prefs.privacy });
}
async function openStandup() {
  let d;
  try { const r = await fetch("/api/standup"); d = r.ok ? await r.json() : null; } catch { d = null; }
  if (!d) { toast("Could not write the standup.", "bad"); return; }
  const text = panels.humanise(d.text);
  $("dialogBody").innerHTML = `<div class="dh"><b>This morning's standup</b><button class="btn sm ghost" id="suClose" aria-label="Close">${icon("x", 16)}</button></div>
    <div class="db"><pre class="standup ${prefs.privacy ? "private" : ""}">${esc(text)}</pre>
    <p class="hint">Written from the office's own records: yesterday's reports, merges and commits, what runs today, and what Needs you holds. Bold and bullets as Slack writes them.</p>
    <div class="row" style="margin-top:10px;gap:8px"><button class="btn primary" id="suCopy">${icon("copy", 15)}Copy for Slack</button><button class="btn" id="suPresent">${icon("tv", 15)}Present (2 min)</button></div></div>`;
  $("dialog").showModal();
  $("suClose").addEventListener("click", () => $("dialog").close());
  $("suCopy").addEventListener("click", () => navigator.clipboard.writeText(text).then(() => toast("The standup is on the clipboard.", "good"), () => toast("Could not copy.", "warn")));
  $("suPresent").addEventListener("click", () => { $("dialog").close(); presentStandup(d); });
  $("suCopy").focus();
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
  ["lock", "Lock the screen", "Presenting? Lock this screen from the menu: share-safe and read-only until you hold Esc for two seconds. /tv is a page that can never change anything."],
  ["tv", "TV mode", "Press V for the floor alone, full screen: room tours, big slides and a news ticker, and the screen stays awake."],
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
  const keys = [["Ctrl K", "Search seats, sessions and actions"], ["H", "Hire a lane"], ["D", "Load divider"], ["F T B S K L", "Floor, Timeline, Team, Today, Tokens, Lanes"],
    ["+ − 0", "Zoom in, out, fit (floor)"], ["Arrows", "Pan the floor while zoomed"], ["Double-click", "Fly to a desk, person or room"],
    ["P", "Share-safe mode"], [",", "Settings"], ["1…9", "Open a character"], ["R", "Replay the day (space, arrows, Esc)"], ["V", "TV mode: the floor full screen"], ["G", "Goodnight (again: lights on)"], ["M", "Office radio: lo-fi on or off"], ["Z", "Game intensity: Full, Calm, Off"], ["\\", "Hide or show the inspector"],
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
    + item("dnd", "moon", "Do not disturb", dndOn() ? `Until ${clock(snap.office.dnd_until)}` : "Off", dndOn())
    + item("night", lightsOut() ? "sun" : "moon", lightsOut() ? "Lights on" : "Goodnight…")
    + "<hr>" + item("daycard", "star", "Share today's card") + item("clip", "play", "Record a 15-second clip") + item("timelapse", "rewind", "Record today's timelapse") + item("week", "play", "Your week in review") + item("wrapped", "star", "Last month, wrapped") + item("arcade", "bug", "Play Bug Squash") + item("radio", "volume", radio.on ? "Office radio: on" : "Office radio: off", "M") + item("tv", "tv", "TV mode", "V") + item("replay", "rewind", "Replay the day", "R") + item("announce", "pin", "Post an announcement") + item("lock", "lock", "Lock this screen") + item("broadcast", "send", "Message a group") + item("picture", "copy", "Save a picture of the office") + item("checkpoint", "pin", "Take a checkpoint") + item("news", "news", "Office news") + item("divider", "sliders", "Load divider")
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
    else if (k === "dnd") setDnd(dndOn() ? 0 : 60);
    else if (k === "night") { m.remove(); $("btnMenu").setAttribute("aria-expanded", "false"); nightToggle(); return; }
    else if (k === "checkpoint") checkpoint();
    else if (k === "tv") floor.setTv(true);
    else if (k === "lock") setLocked(true);
    else if (k === "announce") announceDialog();
    else if (k === "daycard") shareDay();
    else if (k === "week") weekReview.play();
    else if (k === "wrapped") wrapped.play();
    else if (k === "arcade") arcade.open();
    else if (k === "clip") { setView("floor"); recorder.clip(15); }
    else if (k === "timelapse") { setView("floor"); recorder.timelapse(24); }
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
addEventListener("appinstalled", () => { installPrompt = null; store.set("installed", true); toast("Installed. Claude Office opens in its own window now.", "good"); });
async function installApp() {
  if (!installPrompt) { toast("This browser cannot install it from here: use its menu, \"Install Claude Office\".", "info"); return; }
  installPrompt.prompt();
  try { await installPrompt.userChoice; } catch { /* dismissed */ }
  installPrompt = null;
}

// ------------------------------------------------------------------------------------------------ views
function setView(v) {
  if (!["floor", "timeline", "board", "stats", "tokens", "lanes"].includes(v)) v = "floor";
  if (v !== "floor" && document.body.classList.contains("tv")) floor.setTv(false);   // TV mode is the floor alone
  if (v !== "floor" && typeof replay !== "undefined" && replay.active()) replay.close();   // replay lives on the floor
  mainDrawn.delete(v);
  setPref("view", v);
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.view === v));
  for (const [k, id] of [["floor", "viewFloor"], ["timeline", "viewTimeline"], ["board", "viewBoard"], ["stats", "viewStats"], ["tokens", "viewTokens"], ["lanes", "viewLanes"]]) $(id).hidden = k !== v;
  if (v === "timeline") loadHistory(prefs.tlHours);
  if (v === "stats") loadStats(prefs.statsDay);
  renderMain();
}
let mainSig = "", lanesSig = "";
const mainDrawn = new Set();
function renderMain(fromSnap) {
  if (!snap) return;
  const v = prefs.view;
  if (v === "floor") return;
  if (fromSnap && !mainDrawn.has(v)) fromSnap = false;
  mainDrawn.add(v);
  const el = $({ timeline: "viewTimeline", board: "viewBoard", stats: "viewStats", tokens: "viewTokens", lanes: "viewLanes" }[v]);
  if (v === "lanes") {                                  // the lanes board: drawn again only when a lane changes
    const sig = JSON.stringify([(snap.lanes || []).map(l => [l.id, l.status, l.seat, l.report_status, l.backlog_pos, l.trust && l.trust.level, l.spent && l.spent.tokens]), (snap.promises || {}).open, prefs.privacy, Math.floor(snap.now / 60)]);   // and each minute, for the times
    if (fromSnap && (sig === lanesSig || (document.activeElement && document.activeElement.id === "lbFind"))) return;   // never under someone typing
    lanesSig = sig; keepFocus(el, () => renderLanesBoard(el, app, (s) => panels.persona(s)));
    return;
  }
  if (v === "board") { const sig = JSON.stringify(snap.seats.map(s => [s.status, s.usage && [s.usage.five_hour, s.usage.weekly], live(s).map(x => [x.id, x.state, x.activity])])) + prefs.privacy; if (fromSnap && sig === mainSig) return; mainSig = sig; keepFocus(el, () => renderBoard(el, app)); }
  // Timeline and Today come from their own endpoints: refresh them on a clock (they redraw when the data lands),
  // keeping the old picture on screen meanwhile.
  else if (v === "timeline") { if (fromSnap) { const c = histCache.get(prefs.tlHours); if (!c || Date.now() - c.at > 60000) loadHistory(prefs.tlHours); return; } renderTimeline(el, app); }
  else if (v === "tokens") { if (fromSnap) { app.tokensCache(prefs.tokRange || "30", prefs.tokSeat || null); return; } renderTokens(el, app); }
  else if (v === "stats") { if (fromSnap) { const c = statsCache.get(prefs.statsDay || "today"); if (!prefs.statsDay && (!c || Date.now() - c.at > 120000)) loadStats(null); return; } renderStats(el, app); }
}

// ------------------------------------------------------------------------------------------------ panel
// A focused control as a selector from its data-* attributes (null: none to find it by).
function focusSel(ae) {
  const attrs = ae ? [...ae.attributes].filter(a => a.name.startsWith("data-")) : [];
  return attrs.length ? attrs.map(a => `[${a.name}="${CSS.escape(a.value)}"]`).join("") : null;
}
// Draw a view again without losing the keyboard's place in it.
function keepFocus(el, draw) {
  const ae = document.activeElement && el.contains(document.activeElement) ? document.activeElement : null;
  const sel = ae && (ae.id ? "#" + CSS.escape(ae.id) : focusSel(ae)), nth = sel ? [...el.querySelectorAll(sel)].indexOf(ae) : 0;
  draw();
  const back = sel && (el.querySelectorAll(sel)[Math.max(0, nth)] || el.querySelector(sel));
  if (back) back.focus({ preventScroll: true });
}
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
  // Controls without an id (duty switches, share fields, rows) are found again by their data-* attributes, and among
  // rows that share them (a character's news), by their place.
  const activeSel = active ? "#" + CSS.escape(active) : focusSel(ae);
  const nth = activeSel && !active ? [...p.querySelectorAll(activeSel)].indexOf(ae) : 0;
  if (k === "session" && active === "chatBox" && !force) return;       // don't redraw under someone typing
  const caret = ae && typeof ae.selectionStart === "number" ? [ae.selectionStart, ae.selectionEnd] : null;   // a text field keeps its caret
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
  const back = activeSel && (p.querySelectorAll(activeSel)[Math.max(0, nth)] || p.querySelector(activeSel));
  if (back) { back.focus({ preventScroll: true }); if (caret && back.setSelectionRange) try { back.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ } }   // keep focus and the caret where they were
  else if (ae && !p.contains(document.activeElement)) p.focus({ preventScroll: true });   // its control went away: stay in the inspector
}
function bindCommon(p) {
  p.querySelectorAll("[data-stop-all]").forEach(b => b.addEventListener("click", () => panels.stopAllLanes()));
  p.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go({ kind: b.dataset.go })));
  p.querySelectorAll("[data-view-go]").forEach(b => b.addEventListener("click", () => { setView(b.dataset.viewGo); if (b.dataset.anchor) setTimeout(() => { const a = document.getElementById(b.dataset.anchor); if (a) a.scrollIntoView({ block: "start", behavior: prefs.motion === "reduced" ? "auto" : "smooth" }); }, 120); }));
  p.querySelectorAll("[data-seat-go]").forEach(b => b.addEventListener("click", () => go({ kind: "seat", seat: b.dataset.seatGo })));
  p.querySelectorAll("[data-card]").forEach(b => b.addEventListener("click", () => cards.open(b.dataset.card)));
  // Reminders tied to what the page shows: a seat's plan coming back, a session finishing, a lane ending.
  p.querySelectorAll("[data-remind]").forEach(b => b.addEventListener("click", () => {
    const [kind, ref, label] = JSON.parse(b.dataset.remind);
    openRemind({ kind, ref }, label, label.replace(/^when /, "").replace(/^./, c => c.toUpperCase()));
  }));
  p.querySelectorAll("[data-remind-new]").forEach(b => b.addEventListener("click", () => openRemind()));
  p.querySelectorAll("[data-remind-del]").forEach(b => b.addEventListener("click", async () => {
    try { await app.post("/api/reminders", { action: "delete", id: b.dataset.remindDel }); pollOnce(); } catch (e) { toast("Could not delete it: " + e.message, "bad"); }
  }));
  p.querySelectorAll("[data-gift-seek]").forEach(b => b.addEventListener("click", () => giftBox.seek()));
  p.querySelectorAll("button[data-lane], .need[data-lane]").forEach(b => b.addEventListener("click", () => go({ kind: "lane", id: b.dataset.lane })));
  p.querySelectorAll(".member[data-seat], .act.click[data-seat]").forEach(r => {   // buttons for the keyboard too (Tab, Enter or Space)
    const open = () => go({ kind: "seat", seat: r.dataset.seat });
    if (!r.hasAttribute("tabindex")) { r.tabIndex = 0; r.setAttribute("role", "button"); }
    r.addEventListener("click", open);
    r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
  p.querySelectorAll(".sess").forEach(r => r.addEventListener("click", () => go({ kind: "session", seat: r.dataset.seat, id: r.dataset.id })));
  p.querySelectorAll(".need:not([data-lane])").forEach(a => a.addEventListener("click", () => {
    if (a.dataset.id) go({ kind: "session", seat: a.dataset.seat, id: a.dataset.id });
    else if (a.dataset.seat) go({ kind: "seat", seat: a.dataset.seat });
  }));
  p.querySelectorAll("[data-prog-msg]").forEach(b => b.addEventListener("click", () => broadcast("", "programme", b.dataset.progMsg)));
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
// Post an announcement (announce.py): pinned to the briefing, the TV ticker and the CEO desk until it is taken down
// or runs out; it can go to every lane as a message too.
function announceDialog() {
  $("dialogBody").innerHTML = `<div class="dh"><b>Post an announcement</b><button class="btn sm ghost" id="anClose" aria-label="Close">${icon("x", 16)}</button></div>
    <div class="db"><label class="f">The note<textarea id="anText" maxlength="280" placeholder="e.g. Merge freeze until 5 pm: the release is cut at 4." style="min-height:80px"></textarea></label>
      <div class="row wrap" style="gap:12px;align-items:flex-end"><label class="f" style="margin:0">Up for<select id="anHours">${[[1, "an hour"], [4, "4 hours"], [8, "the day (8 h)"], [24, "a day"], [72, "three days"]].map(([h, l]) => `<option value="${h}" ${h === 4 ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="row" style="gap:6px;margin-bottom:8px"><input type="checkbox" id="anSend">Also message every lane</label></div>
      <p class="hint">It is pinned to the top of the briefing, leads the TV news strip and sits as a note on your desk on the floor.</p>
      <div class="row" style="gap:8px;margin-top:8px"><button class="btn primary" id="anPost">${icon("pin", 15)}Pin it</button></div></div>`;
  if (!$("dialog").open) $("dialog").showModal();
  $("anText").focus();
  $("anClose").addEventListener("click", () => $("dialog").close());
  $("anPost").addEventListener("click", async () => {
    const text = $("anText").value.trim();
    if (!text) { toast("Write the note first.", "warn"); return; }
    try {
      const r = await app.post("/api/announce", { text, hours: +$("anHours").value });
      const also = $("anSend").checked;
      $("dialog").close(); pollOnce();
      toast(r.demo ? "Demo office: nothing was changed." : "Pinned.", "good", { ic: "pin" });
      if (also) broadcast(text, "lanes");
    } catch (e) { toast(e.message, "bad"); }
  });
}
// One message to a group (talk.broadcast on the office): every lane, the stuck ones, one seat's or one programme's.
// The office says who is in the group (a dry run), the CEO can untick some, and the send carries how many it showed,
// so a list that changed meanwhile is refused instead of messaging more sessions than were on screen.
async function broadcast(preset = "", group = "lanes", value = "", terminals = false) {
  const who = (s) => panels.persona(s).name, seatOf = (id) => snap.seats.find(s => s.id === id);
  const groups = [["lanes|", "Every lane"], ["stuck|", "Stuck or looping"], ["all|", "Everything that can take a message"],
    ...snap.seats.filter(s => s.kind === "claude").map(s => [`seat|${s.id}`, `On ${who(s)}`]),
    ...(snap.programmes || []).filter(p => p.key).map(p => [`programme|${p.key}`, `In ${p.name}`])];
  let dry;
  try { dry = await app.post("/api/broadcast", { group, value, terminals: terminals || group === "all", dry: true }); }
  catch (e) { toast("Could not list the group: " + e.message, "bad"); return; }
  const draft = $("bText") ? $("bText").value : preset;
  const label = (t) => { const s = seatOf(t.seat); return `${prefs.privacy && t.kind !== "lane" ? "A terminal session" : esc(t.name || "a session")} · ${esc(s ? who(s) : t.seat)}${t.talk === "review" ? " · waits for approval" : ""}`; };
  $("dialogBody").innerHTML = `<div class="dh"><b>Message a group</b><button class="btn sm ghost" id="bClose" aria-label="Close">${icon("x", 16)}</button></div>
    <div class="db"><div class="row wrap" style="gap:10px;margin-bottom:10px"><label class="f" style="margin:0;flex:1;min-width:200px">Who<select id="bGroup">${groups.map(([k, l]) => `<option value="${esc(k)}" ${k === group + "|" + value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      ${group === "all" ? "" : `<label class="row" style="gap:6px;align-self:flex-end;margin-bottom:6px"><input type="checkbox" id="bTerm" ${terminals ? "checked" : ""}>Terminal sessions too</label>`}</div>
      ${dry.targets.length ? `<div class="row wrap" style="gap:6px;margin-bottom:12px">${dry.targets.map(t => `<label class="pill" style="cursor:pointer"><input type="checkbox" data-bt="${esc(t.id)}" checked> ${label(t)}</label>`).join("")}</div>`
        : `<p class="muted" style="margin-top:0">Nobody in this group can take a message right now.</p>`}
      ${dry.count > dry.max ? `<p class="hint bad">${dry.count} sessions: at most ${dry.max} at once. Untick some, or pick a smaller group.</p>` : ""}
      <div class="row wrap" style="gap:6px;margin-bottom:8px">${(dry.macros || []).map((m, i) => `<button class="btn sm ghost" data-macro="${i}" title="${esc(m.text)}">${icon("sparkles", 13)}${esc(m.name)}</button>`).join("")}</div>
      <textarea id="bText" placeholder="e.g. Limits reset in 20 minutes: write your progress notes now and keep going." style="min-height:110px"></textarea>
      <p class="hint">{{seat}}, {{lane_title}} and {{reset_time}} are filled in for each one. Lanes you hired here get it at once; a terminal session holds it until someone approves it there.</p>
      <div class="row" style="margin-top:8px;gap:8px"><button class="btn primary" id="bSend" ${dry.targets.length ? "" : "disabled"}>${icon("send", 16)}Send</button><span class="hint" id="bStatus"></span></div></div>`;
  if (!$("dialog").open) $("dialog").showModal();
  $("bText").value = draft; $("bText").focus();
  $("bClose").addEventListener("click", () => $("dialog").close());
  const again = () => { const [g, v] = $("bGroup").value.split("|"); broadcast($("bText").value, g, v, $("bTerm") ? $("bTerm").checked : terminals); };
  $("bGroup").addEventListener("change", again);
  if ($("bTerm")) $("bTerm").addEventListener("change", again);
  $("dialogBody").querySelectorAll("[data-macro]").forEach(b => b.addEventListener("click", () => { $("bText").value = dry.macros[+b.dataset.macro].text; $("bText").focus(); }));
  const picked = () => [...document.querySelectorAll("[data-bt]")].filter(c => c.checked).map(c => c.dataset.bt);
  const count = () => { const n = picked().length; $("bSend").innerHTML = `${icon("send", 16)}Send to ${n}`; $("bSend").disabled = !n || n > dry.max; };
  document.querySelectorAll("[data-bt]").forEach(c => c.addEventListener("change", count)); if (dry.targets.length) count();
  $("bSend").addEventListener("click", async () => {
    const text = $("bText").value.trim(), only = picked();
    if (!text || !only.length) { toast("Write a message and pick at least one session.", "warn"); return; }
    $("bSend").disabled = true; $("bStatus").textContent = "Sending…";
    try {
      const r = await app.post("/api/broadcast", { group, value, terminals: terminals || group === "all", only, expect: only.length, text });
      $("dialog").close();
      if (r.demo) { toast("Demo office: nothing was sent."); return; }
      for (const x of r.results || []) if (!x.error) { office.plane(x.seat, x.id); app.bump("messages", 10, "talker"); }   // each counts toward Talker
      sound.play("hire");
      toast(`Sent to ${r.sent + r.held}${r.held ? `, ${r.held} waiting for approval` : ""}${r.failed ? `; ${r.failed} failed` : ""}.`, r.failed ? "warn" : "good");
    } catch (e) { $("bSend").disabled = false; $("bStatus").textContent = ""; toast(e.message, "bad"); if (/changed/.test(e.message)) again(); }
  });
}
// The palette's verbs: each row names the exact session or lane it acts on, so Enter on it is the confirmation.
//   "msg atlas status?" or "message atlas: status?" (a live session on Atlas, or one whose name has "atlas"),
//   "stop docs", "resume billing"
function verbItems(q) {
  const out = [], priv = prefs.privacy;
  if (!snap) return out;
  // "message" needs a colon after who ("message atlas: status?"), so typing a command's name ("Message a group")
  // never turns into a message; the short "msg atlas status?" is clearly meant.
  let m = /^msg\s+(\S+?)\s*:?\s+([\s\S]{1,2000})$/i.exec(q) || /^message\s+(\S+?)\s*:\s*([\s\S]{1,2000})$/i.exec(q);
  if (m) {
    const who = m[1].toLowerCase(), text = m[2].trim();
    for (const s of snap.seats) {
      if (s.kind !== "claude") continue;
      const name = panels.persona(s).name;
      for (const x of live(s)) {
        if (out.length >= 4 || !x.talk || x.talk === "none" || x.talk === "later") continue;
        if (!(name.toLowerCase().startsWith(who) || s.id === who || (x.name || "").toLowerCase().includes(who))) continue;
        out.push({ verb: true, icon: icon("send", 16), label: `Message ${priv && x.kind !== "lane" ? "a session" : x.name} on ${name}: ${text}`,
          hint: x.talk === "direct" ? "↵ sends it" : "↵ sends it; it waits for approval at its terminal", run: async () => {
            try { const r = await app.post("/api/message", { seat: s.id, id: x.id, text }); toast(r.demo ? "Demo office: nothing was sent." : `Sent to ${x.name}.`, r.demo ? "info" : "good"); if (!r.demo) app.bump("messages", 10, "talker"); pollOnce(); }
            catch (e) { toast("Could not send it: " + e.message, "bad"); } } });
      }
    }
  }
  const seatName = (id) => { const s = id && snap.seats.find(x => x.id === id); return s ? panels.persona(s).name : "any seat"; };
  const laneVerb = (re, statuses, word, path, done) => {
    const mm = re.exec(q);
    if (!mm) return;
    const words = mm[1].toLowerCase().split(/\s+/).filter(Boolean);
    for (const l of (snap.lanes || []).filter(l => statuses.includes(l.status) && words.every(w => (l.title || "").toLowerCase().includes(w))).slice(0, 4))
      out.push({ verb: true, icon: icon(word === "Stop" ? "stop" : "play", 16), label: `${word} lane ${priv ? `on ${seatName(l.seat || l.seat_pref)}, hired ${dayTime(l.created_at)}` : `“${l.title}”`}`, hint: `${l.status} · ↵ to ${word.toLowerCase()}`, run: async () => {
        if (word === "Stop" && !confirm(`Stop the lane “${l.title}”? Its notes stay, so you can resume it.`)) return;
        try { const r = await app.post(path, { id: l.id, seat: null }); toast(r.demo ? "Demo office: nothing was changed." : done, r.demo ? "info" : "good"); pollOnce(); }
        catch (e) { toast(e.message, "bad"); } } });
  };
  laneVerb(/^stop\s+(?:lane\s+)?(.{2,80})$/i, ["running", "starting", "waiting", "queued", "scheduled"], "Stop", "/api/lanes/stop", "Lane stopped.");
  laneVerb(/^resume\s+(?:lane\s+)?(.{2,80})$/i, ["interrupted", "failed", "stopped", "blocked", "finished"], "Resume", "/api/lanes/resume", "Resuming the lane.");
  return out;
}
function commandItems(q) {
  return [...verbItems(q), ...paletteCommands(q).map(c => c.kind === "remind"
    ? { icon: icon("bell", 16), label: `Remind me ${c.when}: ${c.text}`, hint: "↵ to set", run: async () => {
        try { await app.post("/api/reminders", { text: c.text, trigger: { kind: "at", at: c.at }, label: `at ${dayTime(c.at)}` }); toast(`Reminder set, ${c.when}.`, "good", { ic: "bell" }); pollOnce(); }
        catch (e) { toast("Could not set it: " + e.message, "bad"); } } }
    : c.kind === "hire" ? { icon: icon("briefcase", 16), label: `Hire a lane: ${c.title}`, hint: "the hiring desk, with this title", run: () => {
        const cur = store.get("hireDraft", {}) || {}, mine = (cur.title || "").trim() || (cur.brief || "").trim();
        // A draft on the desk is never replaced without asking; either way the desk opens with the brief to write.
        if (!mine || cur.title === c.title || confirm(`Start a new lane "${c.title}"? Your draft on the hiring desk is replaced.`)) panels.draftHire({ title: c.title, brief: cur.title === c.title ? cur.brief || "" : "" });
        go({ kind: "hire" });
        setTimeout(() => { const f = document.getElementById("hBrief"); if (f) f.focus(); }, 50);
      } }
    : { icon: icon("layers", 16), label: `Project ${c.name}`, hint: "its page", run: () => go({ kind: "project", name: c.name }) })];
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
    { icon: icon("check", 16), label: "Mark all news read", keywords: "unread new news clear seen", run: () => { markNewsRead(); for (const s of snap.seats) for (const x of live(s)) seenTalk[s.id + "/" + x.id] = [textHash(x.last_text), snap.now]; store.set("seenTalk", seenTalk); rnSig = ""; renderRightNow(); toast("All caught up.", "good", { ic: "check" }); } },
    { icon: icon("pin", 16), label: "Post an announcement: a note pinned for everyone", keywords: "announce announcement notice pin note board freeze tell everyone", run: () => announceDialog() },
    { icon: icon("lock", 16), label: "Lock this screen: share-safe and read-only", keywords: "lock presenter screen share present meeting tv kiosk read only", run: () => setLocked(true) },
    { icon: icon("rewind", 16), label: "Replay the last 6 hours", hint: "R", keywords: "history playback rewind day", run: () => { setView("floor"); replay.open(6); } },
    { icon: icon("rewind", 16), label: "Replay the last 24 hours", keywords: "history playback rewind day yesterday", run: () => { setView("floor"); replay.open(24); } },
    { icon: icon("timeline", 16), label: "Timeline", hint: "T", keywords: "gantt history", run: () => setView("timeline") },
    { icon: icon("users", 16), label: "Team", hint: "B", keywords: "board cards", run: () => setView("board") },
    { icon: icon("trophy", 16), label: "Today: stats and MVP", hint: "S", keywords: "league employee of the day", run: () => setView("stats") },
    { icon: icon("briefcase", 16), label: "Lanes board", hint: "L", keywords: "kanban backlog lanes running done blocked", run: () => setView("lanes") },
    ...(snap && snap.seats.length > 1 ? [{ icon: icon("flag", 16), label: "Versus card: two characters head to head", keywords: "versus duel compare battle rival week card", run: () => openVersus(app, panels, snap.seats[0].id) }] : []),
    { icon: icon("download", 16), label: "Your data: export and the month's report", keywords: "export csv json download report month status update data", run: () => openExport() },
    { icon: icon("calendar", 16), label: "Plan calendar: this week's resets as an .ics file", keywords: "calendar ics ical reset limit window week plan google outlook", run: () => downloadCalendar() },
    { icon: icon("news", 16), label: "Office news", run: () => go({ kind: "news" }) },
    { icon: icon("star", 16), label: "Trophy room", keywords: "achievements levels xp leaderboard career", run: () => go({ kind: "trophies" }) },
    { icon: icon("star", 16), label: "Scrapbook", keywords: "photos moments memories album pictures", run: () => go({ kind: "scrapbook" }) },
    { icon: icon("play", 16), label: "Record a clip of the floor", hint: "15 s", keywords: "record video clip webm capture gif", run: () => { setView("floor"); recorder.clip(15); } },
    { icon: icon("rewind", 16), label: "Record today's timelapse", keywords: "record video timelapse day replay webm", run: () => { setView("floor"); recorder.timelapse(24); } },
    ...HELP_TOPICS.map(t => ({ icon: icon(t.icon, 16), label: `Help: ${t.title}`, keywords: "help how what explain " + t.text.slice(0, 160), run: () => go({ kind: "help", topic: t.id }) })),
    { icon: icon("users", 16), label: "Standup on the floor", keywords: "standup morning lounge gather walk", run: () => { setView("floor"); standupScene(true); } },
    { icon: icon("tv", 16), label: "Standup mode", hint: "2 min", keywords: "standup present screen share meeting slides morning", run: () => presentStandup() },
    { icon: icon("pin", 16), label: "Take a checkpoint", keywords: "save resume restart laptop", run: checkpoint },
    { icon: icon("copy", 16), label: "Save a picture of the office", keywords: "screenshot png share image export", run: savePicture },
    { icon: icon("news", 16), label: "This morning's standup", keywords: "standup slack yesterday today blockers daily", run: openStandup },
    { icon: icon("bell", 16), label: "Remind me…", keywords: "reminder remind later timer alarm note", run: () => openRemind() },
    { icon: icon("moon", 16), label: lightsOut() ? "Lights on" : "Goodnight…", hint: "G", keywords: "goodnight night lights out bed sleep wrap", run: nightToggle },
    { icon: icon("eye", 16), label: prefs.director ? "Director cam: off" : "Director cam: on", keywords: "director camera follow auto tour", run: () => setDirector(!prefs.director) },
    { icon: icon("send", 16), label: "Message a group: every lane, the stuck ones, a seat or a programme", keywords: "broadcast everyone announce all lanes stuck programme macro", run: () => broadcast() },
    { icon: icon(prefs.privacy ? "eye" : "eyeOff", 16), label: prefs.privacy ? "Turn share-safe off" : "Turn share-safe on", hint: "P", run: () => setPref("privacy", !prefs.privacy) },
    { icon: icon("volume", 16), label: prefs.sound ? "Mute sound effects" : "Turn on sound effects", run: () => setPref("sound", !prefs.sound) },
    { icon: icon("moon", 16), label: "Night theme", run: () => setPref("theme", "dark") },
    { icon: icon("sun", 16), label: "Day theme", run: () => setPref("theme", "light") },
    { icon: icon("target", 16), label: "Zoom to fit", hint: "0", run: () => { setView("floor"); office.fit(); } },
    { icon: icon("settings", 16), label: "Settings", run: () => go({ kind: "settings" }) },
    { icon: icon("sliders", 16), label: "Keyboard shortcuts", hint: "?", keywords: "keys help hotkeys", run: shortcuts },
    { icon: icon("server", 16), label: "Server room", run: () => go({ kind: "services" }) },
    { icon: icon("moon", 16), label: "Do not disturb for an hour", keywords: "quiet mute dnd silence focus", run: () => setDnd(60) },
    { icon: icon("moon", 16), label: "Do not disturb until 9 tomorrow", keywords: "quiet mute dnd night silence", run: () => setDnd(untilNine()) },
    { icon: icon("volume", 16), label: "End do not disturb", keywords: "quiet dnd off unmute", run: () => setDnd(0) },
    { icon: icon("heart", 16), label: "Office doctor: health checks", keywords: "health check problems fix diagnose", run: () => go({ kind: "doctor" }) },
    { icon: icon("stop", 16), label: "Stop every office lane", keywords: "panic stop all lanes halt", run: () => panels.stopAllLanes() },
    { icon: icon("files", 16), label: "Filing cabinet: past sessions", keywords: "history search old sessions resume archive", run: () => go({ kind: "cabinet" }) },
    { icon: icon("bell", 16), label: "Inbox: agents' questions", keywords: "ask questions answer decisions", run: () => go({ kind: "inbox" }) },
    { icon: icon("send", 16), label: "Pull requests", keywords: "pr github checks ci reviews", run: () => go({ kind: "prs" }) },
    { icon: icon("branch", 16), label: "Loose ends", keywords: "git worktrees uncommitted unpushed cleanup", run: () => go({ kind: "loose" }) },
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
  const [ic, label] = { floor: ["floor", "Floor"], timeline: ["timeline", "Timeline"], board: ["users", "Team"], stats: ["trophy", "Today"], tokens: ["flame", "Tokens"], lanes: ["briefcase", "Lanes"] }[t.dataset.view];
  t.innerHTML = `${icon(ic, 17)}${label}`;
  t.addEventListener("click", () => { sound.play("click"); setView(t.dataset.view); });
});
// After a palette command, keyboard focus lands in the inspector instead of falling back to the page.
const landFocus = (items) => items.map(it => ({ ...it, run: () => { it.run(); setTimeout(() => { if (document.activeElement === document.body) $("panel").focus({ preventScroll: true }); }, 0); } }));
$("btnPalette").addEventListener("click", () => snap && openPalette(landFocus(paletteItems()), commandItems));
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (locked) toast("The screen is locked: search opens again once it is unlocked.", "info", { ic: "lock" }); else if (snap) openPalette(landFocus(paletteItems()), commandItems); return; }
  // A dialog or the palette owns the keyboard while it is open (Escape closes it and nothing else).
  if ((e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".palette-back, dialog[open]")) return;
  const k = e.key;
  if (locked) {
    if (k === "Escape") { if (!e.repeat) { if (replay.active()) replay.close(); holdStart(); } return; }
    if (!LOCK_KEYS.test(k)) return;
  }
  if (replay.active()) {
    if (k === "Escape") { e.preventDefault(); replay.close(); return; }
    if (k === " ") { e.preventDefault(); replay.toggle(); return; }
    if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); replay.step(k === "ArrowLeft" ? -5 : 5); return; }
  }
  if (k === "r" && prefs.view === "floor" && !replay.active()) { replay.open(6); return; }
  if (k === "Escape" && document.querySelector(".legend")) { floor.legend(document.querySelector('[data-cam="legend"]')); return; }
  if (document.body.classList.contains("tv") && k === "Escape") { floor.setTv(false); return; }
  if (k === "v") { floor.setTv(!document.body.classList.contains("tv")); return; }
  if (k === "g") { nightToggle(); return; }
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
  else if (k === "l") setView("lanes");
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
if (locked) { qsOver.privacy = prefs.privacy; prefs.privacy = true; document.body.classList.add("locked"); lockChip(); }   // ?lock=1, /tv or a locked tab reloaded
office.setPrivacy(prefs.privacy);
office.setSeasonal(prefs.seasonal);
sound.set(prefs.sound);
setView(QS.get("view") || prefs.view || "floor");
view = viewFromHash();
connect();
const replayHours = (v) => Math.min(24, Math.max(1, Math.round(+v) || 6));
const startT = setInterval(() => { if (snap) { clearInterval(startT); go(view, true); if (QS.get("tv") === "1" || location.pathname === "/tv") floor.setTv(true); else if (QS.get("replay")) { setView("floor"); replay.open(replayHours(QS.get("replay"))); } } }, 100);
// The installed app's shortcuts (manifest.webmanifest) focus the open window instead of a new one: the link they were
// opened with comes here, and goes where it points.
if ("launchQueue" in window) window.launchQueue.setConsumer((p) => {
  let u = null;
  try { u = p && p.targetURL ? new URL(p.targetURL) : null; } catch { return; }
  if (!u || u.origin !== location.origin || !snap) return;                 // the first launch: the page's own start reads it
  const q = u.searchParams;
  if (["floor", "timeline", "board", "stats", "tokens", "lanes"].includes(q.get("view"))) setView(q.get("view"));
  if (q.get("tv") === "1") floor.setTv(true);
  else if (q.get("replay")) { setView("floor"); replay.open(replayHours(q.get("replay"))); }
  if (u.hash && u.hash !== location.hash) location.hash = u.hash;           // hashchange opens it
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && !es) pollOnce(); });
export { app };

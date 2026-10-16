// Claude Office: the controller. Live data in; floor, inspector and views out.
import { createOffice } from "./office.js";
import { $, esc, store, toast, setNow, live, hydratePortraits, drawLogo, relTime, dayTime, SEAT_LABEL } from "./ui/util.js";
import { makePanels } from "./ui/panels.js";
import { renderTimeline, renderBoard, renderStats } from "./ui/views.js";
import { openPalette } from "./ui/palette.js";
import { sound } from "./ui/sound.js";
import { icon } from "./ui/icons.js";
import { pulse, line } from "./ui/personas.js";

const TOKEN = document.querySelector('meta[name="office-token"]').content;
const DEMO = document.querySelector('meta[name="office-demo"]').content === "1";
const QS = new URLSearchParams(location.search);

const prefs = Object.assign({ theme: "dark", motion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full",
  sound: false, notify: false, privacy: false, view: "floor", tlHours: 6, statsDay: null }, store.get("prefs", {}));
let snap = null, view = { kind: "ceo" }, liveMode = "connecting";
const details = new Map(), histCache = new Map(), statsCache = new Map(), inflight = new Set();
const chats = new Map(), pending = new Map(), drafts = store.get("drafts", {}), opened = new Set();
const seenNews = new Set();
let lastEventTs = 0;

// ------------------------------------------------------------------------------------------------ app api
const app = {
  demo: DEMO,
  broadcast: () => broadcast(),
  snap: () => snap,
  prefs: () => prefs,
  privacy: () => prefs.privacy,
  liveMode: () => liveMode,
  go,
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
  statsCache: (day) => { const k = day || "today"; const c = statsCache.get(k); if (!c || Date.now() - c.at > 60000) loadStats(day); return c ? c.data : null; },
  loadHistory: (h, force) => loadHistory(h, force),
  loadStats: (d, force) => loadStats(d, force),
  chatFor: (seat, id) => { const k = seat + "/" + id; const c = chats.get(k); if (!c || Date.now() - c.at > 4000) loadChat(seat, id); return c ? c.data : null; },
  chatSent(seat, id, text, r) {
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
const office = createOffice($("stage"), {
  openCEO: () => go({ kind: "ceo" }),
  openSeat: (seat) => go({ kind: "seat", seat }),
  openSession: (seat, id) => go({ kind: "session", seat, id }),
  openServices: () => go({ kind: "services" }),
  openProgrammes: () => go({ kind: "programmes" }),
  openLounge: () => go({ kind: "lounge" }),
  openHire: () => go({ kind: "hire" }),
  openDivider: () => go({ kind: "divider" }),
  openNews: () => go({ kind: "news" }),
  openTrophies: () => go({ kind: "trophies" }),
  openStats: () => setView("stats"),
  onCat: () => sound.play("arrive"),
});
office.setPersonas((s) => { const p = panels.persona(s); return { ...p, lines: { ...p.lines, arrive: line(p, "arrive") } }; });

// ------------------------------------------------------------------------------------------------ prefs
function setPref(k, v) {
  prefs[k] = v; store.set("prefs", prefs);
  if (k === "theme") document.documentElement.dataset.theme = v;
  if (k === "motion") { document.documentElement.dataset.motion = v; office.setReducedMotion(v === "reduced"); }
  if (k === "sound") sound.set(v);
  if (k === "privacy") { office.setPrivacy(v); renderPanel(true); renderMain(); rnSig = ""; if (snap) renderRightNow(); }
  if (k === "notify" && v && "Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().then(p => { if (p !== "granted") { prefs.notify = false; store.set("prefs", prefs); toast("Notifications are blocked by the browser.", "warn"); } });
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
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h) return { kind: "ceo" };
  const [k, rest] = h.split("=");
  if (k === "seat") return { kind: "seat", seat: rest };
  if (k === "session") { const i = rest.indexOf("/"); return { kind: "session", seat: rest.slice(0, i), id: rest.slice(i + 1) }; }
  if (k === "lane") return { kind: "lane", id: rest };
  return ["divider", "hire", "services", "programmes", "lounge", "news", "settings", "trophies"].includes(k) ? { kind: k } : { kind: "ceo" };
}
window.addEventListener("hashchange", () => { const v = viewFromHash(); if (hashFor(v) !== hashFor(view)) go(v, true); });
function go(v, fromHash) {
  if (!fromHash && hashFor(v) !== (location.hash || "#")) history.pushState(null, "", hashFor(v) === "#" ? location.pathname + location.search : hashFor(v));
  view = v;
  if (v.kind === "session") { loadDetail("s:" + v.seat + "/" + v.id, true); loadChat(v.seat, v.id, true); }
  if (v.kind === "lane") loadDetail("l:" + v.id, true);
  office.setSelected(v.kind === "seat" ? { seat: v.seat } : v.kind === "session" ? { seat: v.seat, session: v.id } : null);
  renderPanel(true);
  $("panel").scrollTop = 0;
  if (matchMedia("(max-width: 1240px)").matches && v.kind !== "ceo") $("panel").scrollIntoView({ behavior: prefs.motion === "reduced" ? "auto" : "smooth", block: "start" });
}

// ------------------------------------------------------------------------------------------------ data
async function loadDetail(key, force) {
  const c = details.get(key);
  if (!force && c && Date.now() - c.at < 9000) return;
  details.set(key, { data: c ? c.data : null, at: Date.now() });
  const url = key.startsWith("s:") ? (() => { const [seat, id] = key.slice(2).split("/"); return `/api/session?seat=${encodeURIComponent(seat)}&id=${encodeURIComponent(id)}`; })()
    : `/api/lane?id=${encodeURIComponent(key.slice(2))}`;
  try { const r = await fetch(url); if (r.ok) { details.set(key, { data: await r.json(), at: Date.now() }); renderPanel(true); } } catch { /* keep the last copy */ }
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
    if (!day && data && !data.unavailable) office.setMvp(data.mvp);
  } catch { statsCache.set(k, { data: { unavailable: true }, at: Date.now() }); }
  inflight.delete("s" + k);
  if (prefs.view === "stats") renderMain();
}

// ------------------------------------------------------------------------------------------------ live
function apply(next) {
  if (!next || !next.seats) return;
  const first = !snap;
  snap = next; setNow(snap.now);
  office.update(snap);
  renderTop(); renderLatest(); renderRightNow(); renderMain(true);
  renderPanel(false);
  if (first) { (snap.events || []).forEach(e => seenNews.add(e.ts + "|" + e.text)); app.statsCache(null); }
  else if (liveMode !== "live") for (const e of snap.events || []) if (e.ts > lastEventTs) onNews(e);
  lastEventTs = Math.max(lastEventTs, ...(snap.events || []).map(e => e.ts));
  if (view.kind === "session") { loadDetail("s:" + view.seat + "/" + view.id); app.chatFor(view.seat, view.id); }
  if (view.kind === "lane") loadDetail("l:" + view.id);
}

function onNews(e) {
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
      if (ok) { office.celebrate(e.seat, sid, "Shipped!"); if (who) office.say(sid, line(who, "report"), 7000); sound.play("report"); }
      else sound.play("bad");
      toast(text, ok ? "good" : "warn"); notify(ok ? "Report filed" : "Lane blocked", text);
      break;
    }
    case "limit": office.alarm(e.seat, "Out of plan"); if (who) office.sayAtSeat(e.seat, line(who, "limit"), 8000); sound.play("limit"); toast(text, "warn"); notify("Usage limit", text); break;
    case "login": office.alarm(e.seat, "Logged out"); sound.play("bad"); toast(text, "bad"); notify("Seat logged out", text); break;
    case "usage": if (e.level === "bad") { sound.play("bad"); toast(text, "bad"); notify("Seat nearly empty", text); } break;
    case "reset": toast(text, "good"); if (who) office.sayAtSeat(e.seat, line(who, "reset"), 6000); break;
    case "stuck": if (who) office.sayAtSeat(e.seat, line(who, "stuck"), 7000); break;
    case "levelup":
    case "achievement": {
      const lvl = e.kind === "levelup";
      const what = lvl ? (text.match(/level (\d+)/) || [])[1] : text.split(" unlocked ")[1];
      office.celebrate(e.seat, null, lvl ? `Level ${what}!` : what || "Unlocked!");
      if (who) office.sayAtSeat(e.seat, line(who, e.kind), 6500);
      sound.play(e.kind);
      toast(text, "good", { ic: lvl ? "star" : "trophy", ms: 6000 });
      notify(lvl ? "Level up" : "Achievement unlocked", text);
      break;
    }
    case "reply": sound.play("arrive"); toast(text, "good"); notify("A session replied", text); for (const k of chats.keys()) chats.get(k).at = 0; break;
    case "lane":
      if (e.level === "good") { office.celebrate(e.seat, null, "Lane done!"); sound.play("report"); notify("Office lane", text); }
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
  es.addEventListener("news", (ev) => { try { onNews(JSON.parse(ev.data)); } catch { /* ignore */ } });
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
function renderTop() {
  $("officeName").textContent = snap.office.name || "Claude Office";
  const bad = snap.attention.some(a => a.level === "bad"), warn = snap.attention.length > 0;
  document.title = (bad ? "● " : "") + (snap.office.name || "Claude Office");
  const p = $("pulse");
  p.className = "pulse" + (bad ? " urgent" : warn ? " attn" : "");
  const n = snap.attention.length;
  $("pulseText").textContent = pulse(snap, (s) => panels.persona(s), dayTime) + (n ? ` ${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you.` : "") + (DEMO ? " (Demo office.)" : "");
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
  el.innerHTML = `${icon(ic, 18, { good: "good", warn: "warn", bad: "bad" }[e.level] || "")}<span class="txt" title="${esc(panels.humanise(e.text))}">${esc(panels.humanise(e.text))}</span><span class="when">${relTime(e.ts)}</span><button class="btn sm ghost" data-go-news>All news</button>`;
  el.querySelector("[data-go-news]").addEventListener("click", () => go({ kind: "news" }));
}
setInterval(() => { if (snap && prefs.motion !== "reduced") { latestIdx++; paintLatest(); } }, 7000);

let rnSig = "";
function renderRightNow() {
  const rows = snap.seats.flatMap(s => live(s).filter(x => ["working", "waiting", "stuck", "limited"].includes(x.state)).map(x => ({ s, x })))
    .sort((a, b) => ({ working: 0, waiting: 1, stuck: 2, limited: 3 }[a.x.state] - { working: 0, waiting: 1, stuck: 2, limited: 3 }[b.x.state]) || (b.x.updated_at || 0) - (a.x.updated_at || 0)).slice(0, 8);
  const sig = JSON.stringify([prefs.privacy, rows.map(r => [r.x.id, r.x.state, r.x.activity, r.x.name])]);
  if (sig === rnSig) return;
  rnSig = sig;
  const el = $("rightnow");
  if (!rows.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="rn-h"><h4>Right now</h4><span class="hint">${rows.length} at work</span></div><div class="rn-grid">${rows.map(({ s, x }) => {
    const p = panels.persona(s);
    const act = prefs.privacy && x.kind === "desk" ? "Working…" : (x.activity || x.state);
    return `<button class="rn" data-seat="${esc(s.id)}" data-id="${esc(x.id)}" style="--seat:${s.color}">
      <span class="av"><i data-portrait="${esc(x.id)}|${esc(s.color)}|${x.kind === "desk" ? "headset" : ""}"></i></span>
      <span class="rn-body"><span class="rn-top"><b>${esc(x.name.replace(/^wt-/, ""))}</b><span class="sdot ${x.state}"></span></span>
      <span class="rn-act">${esc(act)}</span><span class="rn-meta">${esc(p.name)} · ${x.kind === "lane" ? "lane" : "terminal"}${x.started_at ? " · " + esc(relTime(x.started_at).replace(" ago", "")) : ""}</span></span></button>`;
  }).join("")}</div>`;
  hydratePortraits(el, 3);
  el.querySelectorAll(".rn").forEach(b => b.addEventListener("click", () => { go({ kind: "session", seat: b.dataset.seat, id: b.dataset.id }); office.focusSession(b.dataset.id); }));
}

// ------------------------------------------------------------------------------------------------ menu
function openMenu() {
  const old = document.querySelector(".menu"); if (old) { old.remove(); $("btnMenu").setAttribute("aria-expanded", "false"); return; }
  const m = document.createElement("div");
  m.className = "menu"; m.setAttribute("role", "menu");
  const item = (id, ic, label, state, on) => `<button class="mi" role="menuitem" data-mi="${id}">${icon(ic, 18)}<span>${label}</span>${state != null ? `<span class="state ${on ? "on" : ""}">${state}</span>` : ""}</button>`;
  m.innerHTML = item("sound", prefs.sound ? "volume" : "mute", "Sound effects", prefs.sound ? "On" : "Off", prefs.sound)
    + item("notify", "bell", "Desktop notifications", prefs.notify ? "On" : "Off", prefs.notify)
    + item("privacy", prefs.privacy ? "eyeOff" : "eye", "Share-safe mode", prefs.privacy ? "On" : "Off", prefs.privacy)
    + item("theme", prefs.theme === "light" ? "sun" : prefs.theme === "system" ? "monitor" : "moon", "Theme", { dark: "Night", light: "Day", system: "System" }[prefs.theme])
    + "<hr>" + item("broadcast", "send", "Message all lanes") + item("checkpoint", "pin", "Take a checkpoint") + item("news", "news", "Office news") + item("divider", "sliders", "Load divider")
    + "<hr>" + item("settings", "settings", "Settings");
  document.body.appendChild(m);
  $("btnMenu").setAttribute("aria-expanded", "true");
  m.querySelectorAll("[data-mi]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.mi;
    if (k === "sound") { setPref("sound", !prefs.sound); if (prefs.sound) sound.play("hire"); }
    else if (k === "notify") setPref("notify", !prefs.notify);
    else if (k === "privacy") setPref("privacy", !prefs.privacy);
    else if (k === "theme") setPref("theme", { dark: "light", light: "system", system: "dark" }[prefs.theme] || "dark");
    else if (k === "checkpoint") checkpoint();
    else if (k === "broadcast") broadcast();
    else go({ kind: k });
    m.remove(); $("btnMenu").setAttribute("aria-expanded", "false");
    if (["sound", "notify", "privacy", "theme"].includes(k)) openMenu();
  }));
  setTimeout(() => document.addEventListener("mousedown", function close(ev) { if (!m.contains(ev.target) && ev.target !== $("btnMenu") && !$("btnMenu").contains(ev.target)) { m.remove(); $("btnMenu").setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", close); } }), 0);
}

// ------------------------------------------------------------------------------------------------ views
function setView(v) {
  if (!["floor", "timeline", "board", "stats"].includes(v)) v = "floor";
  mainDrawn.delete(v);
  setPref("view", v);
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.view === v));
  for (const [k, id] of [["floor", "viewFloor"], ["timeline", "viewTimeline"], ["board", "viewBoard"], ["stats", "viewStats"]]) $(id).hidden = k !== v;
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
  const el = $({ timeline: "viewTimeline", board: "viewBoard", stats: "viewStats" }[v]);
  if (v === "board") { const sig = JSON.stringify(snap.seats.map(s => [s.status, s.usage && [s.usage.five_hour, s.usage.weekly], live(s).map(x => [x.id, x.state, x.activity])])) + prefs.privacy; if (fromSnap && sig === mainSig) return; mainSig = sig; renderBoard(el, app); }
  else if (v === "timeline") { if (fromSnap) return; renderTimeline(el, app); }
  else if (v === "stats") { if (fromSnap) return; renderStats(el, app); }
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
  const active = document.activeElement && p.contains(document.activeElement) ? document.activeElement.id : null;
  if (k === "session" && active === "chatBox" && !force) return;       // don't redraw under someone typing
  const out = (panels[k] || panels.ceo)(view);
  if (!force && p.dataset.html === out.html) return;
  const top = p.scrollTop;
  const atBottom = p.scrollHeight - p.scrollTop - p.clientHeight < 60;
  p.innerHTML = `<div class="panel-in">${out.html}</div>`;
  p.dataset.html = out.html;
  hydratePortraits(p, 4);
  bindCommon(p);
  if (out.bind) out.bind(p);
  if (!force || keepScroll) p.scrollTop = k === "session" && atBottom ? p.scrollHeight : top;
  if (active && $(active)) { $(active).focus(); if (active === "chatBox") { const ta = $(active); ta.setSelectionRange(ta.value.length, ta.value.length); } }
}
function bindCommon(p) {
  p.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go({ kind: b.dataset.go })));
  p.querySelectorAll("[data-view-go]").forEach(b => b.addEventListener("click", () => setView(b.dataset.viewGo)));
  p.querySelectorAll("[data-seat-go]").forEach(b => b.addEventListener("click", () => go({ kind: "seat", seat: b.dataset.seatGo })));
  p.querySelectorAll("button[data-lane], .need[data-lane]").forEach(b => b.addEventListener("click", () => go({ kind: "lane", id: b.dataset.lane })));
  p.querySelectorAll(".member[data-seat], .act.click[data-seat]").forEach(r => r.addEventListener("click", () => go({ kind: "seat", seat: r.dataset.seat })));
  p.querySelectorAll(".sess").forEach(r => r.addEventListener("click", () => go({ kind: "session", seat: r.dataset.seat, id: r.dataset.id })));
  p.querySelectorAll(".need:not([data-lane])").forEach(a => a.addEventListener("click", () => {
    if (a.dataset.id) go({ kind: "session", seat: a.dataset.seat, id: a.dataset.id });
    else if (a.dataset.seat) go({ kind: "seat", seat: a.dataset.seat });
  }));
  p.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied.", "good", 1800); } catch { toast("Copy failed: select the text instead.", "warn"); }
  }));
  p.querySelectorAll("[data-refresh]").forEach(b => b.addEventListener("click", async () => {
    try { await app.post("/api/usage/refresh", { seat: b.dataset.refresh }); toast("Reading the plan now."); setTimeout(pollOnce, 2500); } catch (e) { toast(e.message, "bad"); }
  }));
  p.querySelectorAll("[data-focus-seat]").forEach(b => b.addEventListener("click", () => { setView("floor"); office.focusSeat(b.dataset.focusSeat); }));
  p.querySelectorAll("[data-focus-session]").forEach(b => b.addEventListener("click", () => { setView("floor"); office.focusSession(b.dataset.focusSession); }));
}

// ------------------------------------------------------------------------------------------------ actions
async function checkpoint() {
  try {
    const r = await app.post("/api/checkpoint", {});
    $("dialogBody").innerHTML = `<div class="dh"><b>${r.path ? "Checkpoint saved" : "Checkpoint (demo, not saved)"}</b><button class="btn sm ghost" id="dClose">${icon("x", 16)}</button></div>
      <div class="db"><p class="muted" style="margin-top:0">Everything running right now, and the command to pick each one up again.</p>${r.path ? `<div class="copy" style="margin-bottom:12px"><code>${esc(r.path)}</code><button class="btn sm" id="dCopyPath">${icon("copy", 14)}Copy path</button></div>` : ""}
      <pre class="pre" style="max-height:52vh">${esc(r.markdown)}</pre><div class="row" style="margin-top:12px"><button class="btn" id="dCopy">${icon("copy", 15)}Copy all</button></div></div>`;
    $("dialog").showModal();
    $("dClose").addEventListener("click", () => $("dialog").close());
    $("dCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(r.markdown); toast("Copied.", "good", 1800); } catch { toast("Copy failed.", "warn"); } });
    const cp = $("dCopyPath"); if (cp) cp.addEventListener("click", async () => { try { await navigator.clipboard.writeText(r.path); toast("Copied.", "good", 1800); } catch { /* ignore */ } });
  } catch (e) { toast("Checkpoint failed: " + e.message, "bad"); }
}
function broadcast() {
  const targets = snap.seats.flatMap(s => live(s).filter(x => x.kind === "lane" && x.talk && x.talk !== "none" && x.talk !== "followup").map(x => ({ s, x })));
  const who = (s) => panels.persona(s).name;
  $("dialogBody").innerHTML = `<div class="dh"><b>Message all lanes</b><button class="btn sm ghost" id="bClose">${icon("x", 16)}</button></div>
    <div class="db">${targets.length ? `<p class="muted" style="margin-top:0">One message to every running background lane. Lanes you hired here get it straight away; others may wait for approval in their terminal.</p>
      <div class="row wrap" style="gap:6px;margin-bottom:12px">${targets.map(t => `<label class="pill" style="cursor:pointer"><input type="checkbox" data-bt="${esc(t.s.id)}|${esc(t.x.id)}" checked> ${esc(t.x.name)} · ${esc(who(t.s))}</label>`).join("")}</div>
      <textarea id="bText" placeholder="e.g. Limits reset in 20 minutes: write your progress notes now and keep going." style="min-height:110px"></textarea>
      <div class="row" style="margin-top:12px;gap:8px"><button class="btn primary" id="bSend">${icon("send", 16)}Send to selected</button><span class="hint" id="bStatus"></span></div>`
      : `<p class="muted" style="margin-top:0">No running lanes can take a message right now.</p>`}</div>`;
  $("dialog").showModal();
  $("bClose").addEventListener("click", () => $("dialog").close());
  const send = $("bSend");
  if (send) send.addEventListener("click", async () => {
    const text = $("bText").value.trim();
    const picked = [...document.querySelectorAll("[data-bt]")].filter(c => c.checked).map(c => c.dataset.bt.split("|"));
    if (!text || !picked.length) { toast("Write a message and pick at least one lane.", "warn"); return; }
    send.disabled = true;
    let ok = 0, held = 0, failed = 0;
    for (const [seat, id] of picked) {
      try { const r = await app.post("/api/message", { seat, id, text }); if (r.delivery === "review") held++; else ok++; app.chatSent(seat, id, text, r); }
      catch { failed++; }
      $("bStatus").textContent = `${ok + held + failed} of ${picked.length} sent…`;
    }
    $("dialog").close();
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
    { icon: icon("timeline", 16), label: "Timeline", hint: "T", keywords: "gantt history", run: () => setView("timeline") },
    { icon: icon("users", 16), label: "Team", hint: "B", keywords: "board cards", run: () => setView("board") },
    { icon: icon("trophy", 16), label: "Today: stats and MVP", hint: "S", keywords: "league employee of the day", run: () => setView("stats") },
    { icon: icon("news", 16), label: "Office news", run: () => go({ kind: "news" }) },
    { icon: icon("star", 16), label: "Trophy room", keywords: "achievements levels xp leaderboard career", run: () => go({ kind: "trophies" }) },
    { icon: icon("pin", 16), label: "Take a checkpoint", keywords: "save resume restart laptop", run: checkpoint },
    { icon: icon("send", 16), label: "Message all lanes", keywords: "broadcast everyone announce", run: broadcast },
    { icon: icon(prefs.privacy ? "eye" : "eyeOff", 16), label: prefs.privacy ? "Turn share-safe off" : "Turn share-safe on", hint: "P", run: () => setPref("privacy", !prefs.privacy) },
    { icon: icon("volume", 16), label: prefs.sound ? "Mute sound effects" : "Turn on sound effects", run: () => setPref("sound", !prefs.sound) },
    { icon: icon("moon", 16), label: "Night theme", run: () => setPref("theme", "dark") },
    { icon: icon("sun", 16), label: "Day theme", run: () => setPref("theme", "light") },
    { icon: icon("target", 16), label: "Zoom to fit", hint: "0", run: () => { setView("floor"); office.fit(); } },
    { icon: icon("settings", 16), label: "Settings", run: () => go({ kind: "settings" }) },
    { icon: icon("server", 16), label: "Server room", run: () => go({ kind: "services" }) },
  ];
  for (const s of snap.seats) {
    const p = panels.persona(s);
    items.push({ icon: icon("users", 16), label: `${p.name} · ${p.role}`, hint: SEAT_LABEL[s.status] || s.status, keywords: s.label, run: () => { go({ kind: "seat", seat: s.id }); if (prefs.view === "floor") office.focusSeat(s.id); } });
    for (const x of live(s)) {
      items.push({ icon: icon(x.kind === "desk" ? "terminal" : "bot", 16), label: x.name, hint: `${p.name} · ${x.state}`, keywords: (x.title || "") + " " + (prefs.privacy && x.kind === "desk" ? "" : x.activity || ""), run: () => { go({ kind: "session", seat: s.id, id: x.id }); if (prefs.view === "floor") office.focusSession(x.id); } });
      if (x.talk && x.talk !== "none") items.push({ icon: icon("chat", 16), label: `Message ${x.name}`, hint: p.name, keywords: "chat talk send", run: () => go({ kind: "session", seat: s.id, id: x.id }) });
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
  const [ic, label] = { floor: ["floor", "Floor"], timeline: ["timeline", "Timeline"], board: ["users", "Team"], stats: ["trophy", "Today"] }[t.dataset.view];
  t.innerHTML = `${icon(ic, 17)}${label}`;
  t.addEventListener("click", () => { sound.play("click"); setView(t.dataset.view); });
});
$("btnPalette").addEventListener("click", () => snap && openPalette(paletteItems()));
$("btnHire").addEventListener("click", () => go({ kind: "hire" }));
$("btnMenu").addEventListener("click", (e) => { e.stopPropagation(); openMenu(); });
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (snap) openPalette(paletteItems()); return; }
  if (e.target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".palette-back")) return;
  const k = e.key;
  if (k === "Escape") { const m = document.querySelector(".menu"); if (m) m.remove(); else go({ kind: "ceo" }); }
  else if (k === "h") go({ kind: "hire" });
  else if (k === "d") go({ kind: "divider" });
  else if (k === "f") setView("floor");
  else if (k === "t") setView("timeline");
  else if (k === "b") setView("board");
  else if (k === "s") setView("stats");
  else if (k === "p") setPref("privacy", !prefs.privacy);
  else if (k === "," || k === "?") go({ kind: "settings" });
  else if (prefs.view === "floor" && (k === "+" || k === "=")) office.zoom(1);
  else if (prefs.view === "floor" && k === "-") office.zoom(-1);
  else if (prefs.view === "floor" && k === "0") office.fit();
  else if (prefs.view === "floor" && k.startsWith("Arrow")) { e.preventDefault(); office.pan(k === "ArrowLeft" ? 80 : k === "ArrowRight" ? -80 : 0, k === "ArrowUp" ? 80 : k === "ArrowDown" ? -80 : 0); }
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
if (["dark", "light", "system"].includes(qTheme)) prefs.theme = qTheme;
document.documentElement.dataset.theme = prefs.theme;
document.documentElement.dataset.motion = prefs.motion;
office.setReducedMotion(prefs.motion === "reduced");
office.setPrivacy(prefs.privacy);
sound.set(prefs.sound);
setView(QS.get("view") || prefs.view || "floor");
view = viewFromHash();
connect();
const startT = setInterval(() => { if (snap) { clearInterval(startT); go(view, true); } }, 100);
document.addEventListener("visibilitychange", () => { if (!document.hidden && !es) pollOnce(); });
export { app };

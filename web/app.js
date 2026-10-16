// Claude Office: the controller. Live data in, HUD + floor + panels + views out.
import { createOffice } from "./office.js";
import { $, esc, store, toast, setNow, until, pct, live, hydratePortraits, drawLogo, SEAT_LABEL } from "./ui/util.js";
import { makePanels } from "./ui/panels.js";
import { renderTimeline, renderBoard, renderStats } from "./ui/views.js";
import { openPalette } from "./ui/palette.js";
import { sound } from "./ui/sound.js";

const TOKEN = document.querySelector('meta[name="office-token"]').content;
const DEMO = document.querySelector('meta[name="office-demo"]').content === "1";

const prefs = Object.assign({ theme: "dark", motion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full",
  sound: false, notify: false, privacy: false, view: "floor", tlHours: 6, statsDay: null }, store.get("prefs", {}));
let snap = null, view = { kind: "ceo" }, liveMode = "connecting";
const details = new Map();                 // "s:seat/id" | "l:id" -> {data, at}
const histCache = new Map(), statsCache = new Map();
const seenNews = new Set();
let lastEventTs = 0;

// ------------------------------------------------------------------------------------------------ app api
const app = {
  demo: DEMO,
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
  openStats: () => setView("stats"),
});

// ------------------------------------------------------------------------------------------------ prefs
function setPref(k, v) {
  prefs[k] = v; store.set("prefs", prefs);
  if (k === "theme") document.documentElement.dataset.theme = v;
  if (k === "motion") { document.documentElement.dataset.motion = v; office.setReducedMotion(v === "reduced"); }
  if (k === "sound") sound.set(v);
  if (k === "privacy") { office.setPrivacy(v); renderPanel(true); renderMain(); }
  if (k === "notify" && v && "Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().then(p => { if (p !== "granted") { prefs.notify = false; store.set("prefs", prefs); toast("Notifications are blocked by the browser.", "warn"); } paintIcons(); });
  }
  paintIcons();
}
function paintIcons() {
  $("btnSound").classList.toggle("on", prefs.sound); $("btnSound").textContent = prefs.sound ? "♫" : "♪";
  $("btnNotify").classList.toggle("on", prefs.notify);
  $("btnPrivacy").classList.toggle("on", prefs.privacy);
  $("btnTheme").textContent = { dark: "☾", light: "☀", system: "◐" }[prefs.theme] || "◐";
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
  return ["divider", "hire", "services", "programmes", "lounge", "news", "settings"].includes(k) ? { kind: k } : { kind: "ceo" };
}
window.addEventListener("hashchange", () => { const v = viewFromHash(); if (hashFor(v) !== hashFor(view)) go(v, true); });
function go(v, fromHash) {
  if (!fromHash && hashFor(v) !== (location.hash || "#")) history.pushState(null, "", hashFor(v) === "#" ? location.pathname + location.search : hashFor(v));
  view = v;
  if (v.kind === "session") loadDetail("s:" + v.seat + "/" + v.id, true);
  if (v.kind === "lane") loadDetail("l:" + v.id, true);
  office.setSelected(v.kind === "seat" ? { seat: v.seat } : v.kind === "session" ? { seat: v.seat, session: v.id } : null);
  renderPanel(true); renderHud();
  $("panel").scrollTop = 0;
  if (matchMedia("(max-width: 1180px)").matches && v.kind !== "ceo") $("panel").scrollIntoView({ behavior: prefs.motion === "reduced" ? "auto" : "smooth", block: "start" });
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
const inflight = new Set();
async function loadHistory(h, force) {
  const k = "h" + h; if (inflight.has(k)) return; inflight.add(k);
  if (force) histCache.delete(h);
  try {
    const r = await fetch(`/api/history?hours=${h}`);
    histCache.set(h, { data: r.ok ? await r.json() : { unavailable: true }, at: Date.now() });
  } catch { histCache.set(h, { data: { unavailable: true }, at: Date.now() }); }
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
  if (view.kind === "ceo") renderPanel(false);
}

// ------------------------------------------------------------------------------------------------ live
function apply(next) {
  if (!next || !next.seats) return;
  const first = !snap;
  snap = next; setNow(snap.now);
  office.update(snap);
  renderHud(); renderTicker(); renderMain(true);
  renderPanel(false);
  if (first) { (snap.events || []).forEach(e => seenNews.add(e.ts + "|" + e.text)); lastEventTs = Math.max(0, ...(snap.events || []).map(e => e.ts)); app.statsCache(null); }
  else if (liveMode !== "live") for (const e of snap.events || []) if (e.ts > lastEventTs) onNews(e);
  lastEventTs = Math.max(lastEventTs, ...(snap.events || []).map(e => e.ts));
  if (view.kind === "session") loadDetail("s:" + view.seat + "/" + view.id);
  if (view.kind === "lane") loadDetail("l:" + view.id);
}

function onNews(e) {
  const key = e.ts + "|" + e.text;
  if (seenNews.has(key)) return;
  seenNews.add(key);
  if (seenNews.size > 2000) seenNews.clear();
  const seat = e.seat;
  switch (e.kind) {
    case "arrive": sound.play("arrive"); break;
    case "leave": sound.play("leave"); break;
    case "report": {
      const blocked = e.level !== "good";
      if (!blocked) { office.celebrate(seat, findSessionByText(e.text), "Shipped!"); sound.play("report"); }
      else sound.play("bad");
      toast(e.text, blocked ? "warn" : "good"); notify(blocked ? "Lane blocked" : "Report filed", e.text);
      break;
    }
    case "limit": office.alarm(seat, "Out of plan"); sound.play("limit"); toast(e.text, "warn"); notify("Usage limit", e.text); break;
    case "login": office.alarm(seat, "Logged out"); sound.play("bad"); toast(e.text, "bad"); notify("Seat logged out", e.text); break;
    case "usage": if (e.level === "bad") { sound.play("bad"); toast(e.text, "bad"); notify("Seat nearly empty", e.text); } break;
    case "reset": toast(e.text, "good"); break;
    case "stuck": toast(e.text, "warn"); break;
    case "lane":
      if (e.level === "good") { office.celebrate(seat, null, "Lane done!"); sound.play("report"); notify("Office lane done", e.text); }
      else if (e.level === "bad") { sound.play("bad"); notify("Office lane failed", e.text); }
      toast(e.text, e.level === "info" ? "info" : e.level);
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
  el.querySelector("span").textContent = { live: "LIVE", polling: "LIVE · POLL", connecting: "CONNECTING", lost: "RECONNECTING" }[mode] || mode.toUpperCase();
}
function connect() {
  if (!("EventSource" in window) || sseFails >= 3 || new URLSearchParams(location.search).has("poll")) { startPolling(); return; }
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
  } catch { setLive("lost"); }
}
function startPolling() { if (pollTimer) return; pollOnce(); pollTimer = setInterval(() => { if (!document.hidden) pollOnce(); }, 3000); }
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

// ------------------------------------------------------------------------------------------------ HUD
let hudSig = "";
function renderHud() {
  if (!snap) return;
  $("officeName").textContent = snap.office.name || "Claude Office";
  document.title = (snap.attention.some(a => a.level === "bad") ? "● " : "") + (snap.office.name || "Claude Office");
  const t = snap.totals, np = snap.next_pick;
  $("summaryLine").textContent = `${t.working}/${t.sessions} working · ${t.lanes} lanes · next → ${np.seat || "nobody"}${DEMO ? " · DEMO" : ""}`;
  const sig = JSON.stringify([view.kind === "seat" ? view.seat : null, snap.seats.map(s => [s.id, s.label, s.nickname, s.color, s.status, Math.round(pct(s.usage, "five_hour") ?? -1), Math.round(pct(s.usage, "weekly") ?? -1), Math.round(((s.usage || {}).five_hour || {}).resets_at / 60 || 0)])]);
  if (sig === hudSig) return;
  hudSig = sig;
  const el = $("hudSeats");
  el.innerHTML = snap.seats.map(s => {
    const u = s.usage || {}, p5 = pct(u, "five_hour"), pw = pct(u, "weekly");
    const bar = (p) => `<span class="hpbar ${p != null && p >= 90 ? "low" : p != null && p >= 75 ? "mid" : ""}"><i style="width:${p == null ? 0 : 100 - p}%"></i></span>`;
    return `<button class="scard ${view.kind === "seat" && view.seat === s.id ? "sel" : ""}" style="--seat:${s.color}" data-seat="${esc(s.id)}" title="${esc(s.label)}: 5-hour ${p5 == null ? "?" : Math.round(100 - p5) + "% left"}${u.five_hour && u.five_hour.resets_at ? ", resets in " + until(u.five_hour.resets_at) : ""}; weekly ${pw == null ? "?" : Math.round(100 - pw) + "% left"}">
      <i data-portrait="mascot-${esc(s.id)}|${esc(s.color)}|${s.status === "offline" ? "dim" : ""}"></i>
      <span class="nm"><span>${esc(s.nickname || s.label)}</span><span class="st ${s.status}">${esc({ working: "WORKING", idle: "IDLE", limited: "LIMIT", benched: "BENCHED", offline: "OFFLINE" }[s.status] || s.status)}</span></span>
      <span class="hpr"><span>5h</span>${bar(p5)}<b>${p5 == null ? "–" : Math.round(100 - p5) + "%"}</b></span>
      <span class="hpr"><span>wk</span>${bar(pw)}<b>${pw == null ? "–" : Math.round(100 - pw) + "%"}</b></span>
    </button>`;
  }).join("");
  hydratePortraits(el, 3);
  el.querySelectorAll(".scard").forEach(b => {
    b.addEventListener("click", () => { go({ kind: "seat", seat: b.dataset.seat }); if (prefs.view === "floor") office.focusSeat(b.dataset.seat); });
  });
}

function renderTicker() {
  const ev = (snap.events || []).slice(-24).reverse();
  const html = ev.length ? ev.map(e => `<span class="${e.level || ""}"><b>${new Date(e.ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</b>${esc(e.text)}</span>`).join("")
    : `<span>Quiet in the office. News appears here as agents arrive, finish, hit limits and file reports.</span>`;
  const el = $("tickerIn");
  if (el.dataset.html !== html) {
    el.innerHTML = `<div class="ticker-run">${html}</div><div class="ticker-run" aria-hidden="true">${html}</div>`;
    el.dataset.html = html; el.style.animationDuration = Math.max(30, ev.length * 7) + "s";
  }
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
  if (v === "board") { const sig = JSON.stringify(snap.seats.map(s => [s.status, s.usage, live(s).map(x => [x.id, x.state, x.activity])])) + prefs.privacy; if (fromSnap && sig === mainSig) return; mainSig = sig; renderBoard(el, app); }
  else if (v === "timeline") { if (fromSnap) return; renderTimeline(el, app); }
  else if (v === "stats") { if (fromSnap) return; renderStats(el, app); }
}
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => { sound.play("click"); setView(t.dataset.view); }));

// ------------------------------------------------------------------------------------------------ panel
function renderPanel(force) {
  if (!snap) return;
  const p = $("panel"), k = view.kind;
  if (!force && panels.isEditing(k)) {
    const ll = k === "hire" && $("laneList");
    if (ll) { const html = panels.laneListHtml(); if (ll.dataset.html !== html) { ll.innerHTML = html; ll.dataset.html = html; bindCommon(ll); } }
    return;
  }
  const sel = window.getSelection && window.getSelection();
  if (!force && sel && !sel.isCollapsed && p.contains(sel.anchorNode)) return;
  const fn = panels[k] || panels.ceo;
  const out = fn(view);
  if (!force && p.dataset.html === out.html) return;
  const top = p.scrollTop;
  const active = document.activeElement && p.contains(document.activeElement) ? document.activeElement.id : null;
  p.innerHTML = out.html;
  p.dataset.html = out.html;
  hydratePortraits(p, 4);
  bindCommon(p);
  if (out.bind) out.bind(p);
  if (!force) p.scrollTop = top;
  if (active && $(active)) $(active).focus();
}
function bindCommon(p) {
  p.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go({ kind: b.dataset.go })));
  p.querySelectorAll("[data-seat-go]").forEach(b => b.addEventListener("click", () => go({ kind: "seat", seat: b.dataset.seatGo })));
  p.querySelectorAll("button[data-lane]").forEach(b => b.addEventListener("click", () => go({ kind: "lane", id: b.dataset.lane })));
  p.querySelectorAll(".seatrow[data-seat]").forEach(r => r.addEventListener("click", () => go({ kind: "seat", seat: r.dataset.seat })));
  p.querySelectorAll(".sess").forEach(r => r.addEventListener("click", () => go({ kind: "session", seat: r.dataset.seat, id: r.dataset.id })));
  p.querySelectorAll(".alert.click").forEach(a => a.addEventListener("click", () => {
    if (a.dataset.lane) go({ kind: "lane", id: a.dataset.lane });
    else if (a.dataset.id) go({ kind: "session", seat: a.dataset.seat, id: a.dataset.id });
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
    $("dialogBody").innerHTML = `<div class="dh"><b>📌 Checkpoint ${r.path ? "saved" : "(demo, not saved)"}</b><button class="btn small" id="dClose">Close</button></div>
      <div class="db">${r.path ? `<div class="copy" style="margin-bottom:10px"><code>${esc(r.path)}</code><button class="btn small" id="dCopyPath">Copy path</button></div>` : ""}
      <pre class="pre" style="max-height:55vh">${esc(r.markdown)}</pre><div class="row" style="margin-top:10px"><button class="btn" id="dCopy">Copy all</button></div></div>`;
    $("dialog").showModal();
    $("dClose").addEventListener("click", () => $("dialog").close());
    $("dCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(r.markdown); toast("Copied.", "good", 1800); } catch { toast("Copy failed.", "warn"); } });
    const cp = $("dCopyPath"); if (cp) cp.addEventListener("click", async () => { try { await navigator.clipboard.writeText(r.path); toast("Copied.", "good", 1800); } catch { /* ignore */ } });
  } catch (e) { toast("Checkpoint failed: " + e.message, "bad"); }
}
function paletteItems() {
  const items = [
    { icon: "☕", label: "CEO briefing", hint: "Esc", run: () => go({ kind: "ceo" }) },
    { icon: "＋", label: "Hire a lane", hint: "H", keywords: "new lane dispatch task", run: () => go({ kind: "hire" }) },
    { icon: "⚖", label: "Load divider", hint: "D", keywords: "split weights bench", run: () => go({ kind: "divider" }) },
    { icon: "▦", label: "Floor view", hint: "F", run: () => setView("floor") },
    { icon: "≋", label: "Timeline view", hint: "T", keywords: "gantt history", run: () => setView("timeline") },
    { icon: "▤", label: "Board view", hint: "B", run: () => setView("board") },
    { icon: "★", label: "Today: stats and MVP", hint: "S", keywords: "league employee of the day", run: () => setView("stats") },
    { icon: "📰", label: "Office news", run: () => go({ kind: "news" }) },
    { icon: "📌", label: "Take a checkpoint", keywords: "save resume restart laptop", run: checkpoint },
    { icon: "👁", label: prefs.privacy ? "Turn share-safe off" : "Turn share-safe on", hint: "P", run: () => setPref("privacy", !prefs.privacy) },
    { icon: "♪", label: prefs.sound ? "Mute sound effects" : "Turn on sound effects", run: () => setPref("sound", !prefs.sound) },
    { icon: "☾", label: "Theme: dark", run: () => setPref("theme", "dark") },
    { icon: "☀", label: "Theme: light", run: () => setPref("theme", "light") },
    { icon: "⤢", label: "Zoom to fit", hint: "0", run: () => { setView("floor"); office.fit(); } },
    { icon: "⚙", label: "Settings", hint: ",", run: () => go({ kind: "settings" }) },
    { icon: "🖥", label: "Server room", run: () => go({ kind: "services" }) },
    { icon: "◆", label: "Programmes", run: () => go({ kind: "programmes" }) },
  ];
  for (const s of snap.seats) {
    items.push({ icon: "◼", label: `Seat ${s.nickname || s.label}`, hint: SEAT_LABEL[s.status] || s.status, keywords: s.label, run: () => { go({ kind: "seat", seat: s.id }); if (prefs.view === "floor") office.focusSeat(s.id); } });
    for (const x of live(s)) items.push({ icon: x.kind === "desk" ? "🎧" : "⚙", label: x.name, hint: `${s.label} · ${x.state}`, keywords: (x.title || "") + " " + (prefs.privacy && x.kind === "desk" ? "" : x.activity || ""), run: () => { go({ kind: "session", seat: s.id, id: x.id }); if (prefs.view === "floor") office.focusSession(x.id); } });
  }
  for (const l of snap.lanes || []) items.push({ icon: "📋", label: "Lane: " + l.title, hint: l.status, run: () => go({ kind: "lane", id: l.id }) });
  return items;
}

// ------------------------------------------------------------------------------------------------ wiring
$("btnPalette").addEventListener("click", () => snap && openPalette(paletteItems()));
$("btnSound").addEventListener("click", () => { setPref("sound", !prefs.sound); if (prefs.sound) sound.play("hire"); toast(prefs.sound ? "Sound effects on." : "Sound effects off."); });
$("btnNotify").addEventListener("click", () => { setPref("notify", !prefs.notify); toast(prefs.notify ? "Desktop notifications on (when this tab is in the background)." : "Desktop notifications off."); });
$("btnPrivacy").addEventListener("click", () => { setPref("privacy", !prefs.privacy); toast(prefs.privacy ? "Share-safe on: interactive topics and emails are hidden." : "Share-safe off."); });
$("btnTheme").addEventListener("click", () => setPref("theme", { dark: "light", light: "system", system: "dark" }[prefs.theme] || "dark"));
$("btnSettings").addEventListener("click", () => go({ kind: "settings" }));
$("btnHire").addEventListener("click", () => go({ kind: "hire" }));
$("btnCheckpoint").addEventListener("click", checkpoint);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (snap) openPalette(paletteItems()); return; }
  if (e.target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".palette-back")) return;
  const k = e.key;
  if (k === "Escape") go({ kind: "ceo" });
  else if (k === "h") go({ kind: "hire" });
  else if (k === "d") go({ kind: "divider" });
  else if (k === "f") setView("floor");
  else if (k === "t") setView("timeline");
  else if (k === "b") setView("board");
  else if (k === "s") setView("stats");
  else if (k === "p") $("btnPrivacy").click();
  else if (k === ",") go({ kind: "settings" });
  else if (k === "?") go({ kind: "settings" });
  else if (prefs.view === "floor" && (k === "+" || k === "=")) office.zoom(1);
  else if (prefs.view === "floor" && k === "-") office.zoom(-1);
  else if (prefs.view === "floor" && k === "0") office.fit();
  else if (prefs.view === "floor" && k.startsWith("Arrow")) { e.preventDefault(); office.pan(k === "ArrowLeft" ? 80 : k === "ArrowRight" ? -80 : 0, k === "ArrowUp" ? 80 : k === "ArrowDown" ? -80 : 0); }
});
setInterval(() => { $("clock").textContent = new Date().toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", second: "2-digit" }); }, 1000);
setInterval(() => { if (snap) { app.statsCache(null); if (view.kind === "seat") app.historyCache(6); } }, 60000);

drawLogo($("logo"));
const qTheme = new URLSearchParams(location.search).get("theme");
if (["dark", "light", "system"].includes(qTheme)) prefs.theme = qTheme;
document.documentElement.dataset.theme = prefs.theme;
document.documentElement.dataset.motion = prefs.motion;
office.setReducedMotion(prefs.motion === "reduced");
office.setPrivacy(prefs.privacy);
sound.set(prefs.sound);
paintIcons();
setView(new URLSearchParams(location.search).get("view") || prefs.view || "floor");
view = viewFromHash();
connect();
const startT = setInterval(() => { if (snap) { clearInterval(startT); go(view, true); } }, 100);
document.addEventListener("visibilitychange", () => { if (!document.hidden && !es) pollOnce(); });
export { app };

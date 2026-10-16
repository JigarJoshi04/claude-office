// Claude Office: polling, the top bar, the CEO's side panel, the load divider and the hiring desk.
import { createOffice, esc, fmtTok } from "./office.js";

const TOKEN = document.querySelector('meta[name="office-token"]').content;
const DEMO = document.querySelector('meta[name="office-demo"]').content === "1";
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("office." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("office." + k, JSON.stringify(v)); } catch { /* private window */ } },
};

let snap = null;
let view = { kind: "ceo" };
let privacy = store.get("privacy", false);
let mode = store.get("mode", "floor");
let detail = null, detailKey = "", detailAt = 0;
let dv = null, dvDirty = false, dvPreview = null;
let hireDraft = store.get("hireDraft", { title: "", brief: "", workdir: "", seat: "auto", model: "", permission_mode: "" });

const office = createOffice($("canvas"), $("overlay"), {
  openCEO: () => go({ kind: "ceo" }),
  openSeat: (seat) => go({ kind: "seat", seat }),
  openSession: (seat, id) => go({ kind: "session", seat, id }),
  openServices: () => go({ kind: "services" }),
  openProgrammes: () => go({ kind: "programmes" }),
  openLounge: () => go({ kind: "lounge" }),
  openHire: () => go({ kind: "hire" }),
  openDivider: () => go({ kind: "divider" }),
});

// ------------------------------------------------------------------------------------------------ helpers
function seatById(id) { return snap && snap.seats.find(s => s.id === id); }
function live(s) { return s.sessions.filter(x => x.live !== false); }
function pct(u, k) { return u && u[k] && u[k].pct != null ? u[k].pct : null; }
function ago(ts) {
  if (!ts || !snap) return "–";
  const s = Math.max(0, Math.round(snap.now - ts));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h " + Math.round((s % 3600) / 60) + "m ago";
  return Math.floor(s / 86400) + "d ago";
}
function until(ts) {
  if (!ts || !snap) return "";
  const s = Math.max(0, Math.round(ts - snap.now));
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h" + String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return Math.floor(s / 86400) + "d " + Math.floor((s % 86400) / 3600) + "h";
}
function clock(ts) { return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function dur(sec) {
  if (sec == null) return "–";
  if (sec < 60) return Math.round(sec) + "s";
  if (sec < 3600) return Math.round(sec / 60) + "m";
  return Math.floor(sec / 3600) + "h " + Math.round((sec % 3600) / 60) + "m";
}
function meter(p, color) {
  const v = p == null ? 0 : Math.min(100, p);
  const cls = p == null ? "" : p >= 90 ? "m-hot" : p >= 75 ? "m-warm" : "";
  return `<div class="meter ${cls}" style="--seat:${color}"><i style="width:${v}%"></i></div>`;
}
function paceLine(fc) {
  if (!fc) return "";
  if (fc.state === "learning") return `<div class="lbl pace">Learning the pace…</div>`;
  if (fc.state === "flat") return `<div class="lbl pace good">Not burning right now</div>`;
  if (fc.state === "runs_out") return `<div class="lbl pace bad">At ${fc.per_hour}%/h: out in ${until(fc.out_at)}${fc.margin_s ? `, ${until(snap.now + fc.margin_s)} before the reset` : ""}</div>`;
  return `<div class="lbl pace good">At ${fc.per_hour}%/h it lasts until the reset</div>`;
}
const STATE_LABEL = { working: "Working", waiting: "Waiting on a tool", idle: "Idle", limited: "Out of plan", stuck: "Quiet 15 min+", done: "Finished" };
const SEAT_LABEL = { working: "Working", idle: "Idle", limited: "Out of plan", benched: "Benched", offline: "Logged out" };
const LEVEL = { bad: "bad", warn: "warn", good: "good", info: "info" };
function privateText(sess, text) {
  if (privacy && sess && sess.kind === "desk") return `<span class="private" aria-label="hidden">${esc(text || "")}</span>`;
  return esc(text || "");
}
function toast(msg, ms = 3800) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Office-Token": TOKEN }, body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({ error: "Bad response" }));
  if (!r.ok || data.error) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}
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
  return ["divider", "hire", "services", "programmes", "lounge"].includes(k) ? { kind: k } : { kind: "ceo" };
}
window.addEventListener("hashchange", () => { const v = viewFromHash(); if (hashFor(v) !== hashFor(view)) go(v, true); });
function go(v, fromHash) {
  if (!fromHash && hashFor(v) !== (location.hash || "#")) history.pushState(null, "", hashFor(v) === "#" ? location.pathname : hashFor(v));
  view = v;
  if (v.kind === "lane") setTimeout(panelLaneLoad, 0);
  if (v.kind === "divider" && !dvDirty) dv = null;
  detail = null; detailKey = "";
  office.setSelected(v.kind === "seat" ? { seat: v.seat } : v.kind === "session" ? { seat: v.seat, session: v.id } : null);
  renderPanel(true);
  if (window.matchMedia("(max-width: 1100px)").matches && v.kind !== "ceo") $("panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ------------------------------------------------------------------------------------------------ top bar
function renderTop() {
  $("officeName").textContent = snap.office.name || "Claude Office";
  document.title = (snap.attention.filter(a => a.level === "bad").length ? "● " : "") + (snap.office.name || "Claude Office");
  const t = snap.totals;
  const np = snap.next_pick.seat ? seatById(snap.next_pick.seat) : null;
  $("summaryLine").textContent = `${t.working} of ${t.sessions} sessions working · ${t.lanes} lanes · next lane → ${np ? np.label : "nobody"}` + (DEMO ? " · DEMO" : "");
  $("caps").innerHTML = snap.seats.map(s => {
    const u = s.usage || {};
    const p5 = pct(u, "five_hour"), pw = pct(u, "weekly");
    const r5 = u.five_hour && u.five_hour.resets_at;
    return `<button class="cap" style="--seat:${s.color}" data-seat="${esc(s.id)}" title="${esc(s.label)}: 5-hour ${p5 == null ? "unknown" : Math.round(p5) + "% used"}, weekly ${pw == null ? "unknown" : Math.round(pw) + "% used"}">
      <span class="nm"><span class="dot"></span>${esc(s.label)}<span class="st">${esc(SEAT_LABEL[s.status] || s.status)}</span></span>
      ${meter(p5, s.color)}${meter(pw, s.color)}
      <span class="lbl">5h ${p5 == null ? "–" : Math.round(p5) + "%"}${r5 ? "·" + until(r5) : ""}  wk ${pw == null ? "–" : Math.round(pw) + "%"}</span>
    </button>`;
  }).join("");
  $("caps").querySelectorAll(".cap").forEach(b => b.addEventListener("click", () => go({ kind: "seat", seat: b.dataset.seat })));
  $("btnPrivacy").classList.toggle("on", privacy);
  $("btnView").textContent = mode === "floor" ? "Board" : "Floor";
}

function renderTicker() {
  const ev = (snap.events || []).slice(-24).reverse();
  const html = ev.length ? ev.map(e => `<span class="${LEVEL[e.level] || ""}"><b>${clock(e.ts)}</b>${esc(e.text)}</span>`).join("")
    : `<span>Quiet in the office. News appears here as agents arrive, finish, hit limits and file reports.</span>`;
  const el = $("tickerIn");
  if (el.dataset.html !== html) {
    el.innerHTML = `<div class="ticker-run">${html}</div><div class="ticker-run" aria-hidden="true">${html}</div>`;
    el.dataset.html = html;
    el.style.animationDuration = Math.max(30, ev.length * 7) + "s";
  }
}

// ------------------------------------------------------------------------------------------------ board
function renderBoard() {
  $("board").innerHTML = snap.seats.map(s => {
    const u = s.usage || {};
    const L = live(s);
    return `<div class="card" style="--seat:${s.color}">
      <div class="row between"><h3><span class="dot"></span>${esc(s.label)}</h3><span class="chip"><span class="st-dot ${s.status}"></span>${esc(SEAT_LABEL[s.status] || s.status)}</span></div>
      <div class="gauges">
        <div><div class="lbl muted" style="font-size:12px">5-hour ${pct(u, "five_hour") == null ? "–" : Math.round(pct(u, "five_hour")) + "%"}</div>${meter(pct(u, "five_hour"), s.color)}</div>
        <div><div class="lbl muted" style="font-size:12px">Weekly ${pct(u, "weekly") == null ? "–" : Math.round(pct(u, "weekly")) + "%"}</div>${meter(pct(u, "weekly"), s.color)}</div>
      </div>
      <div style="margin-top:8px">${L.length ? L.map(x => sessRow(s, x)).join("") : `<div class="muted" style="padding:8px 6px">Nobody at this desk.</div>`}</div>
    </div>`;
  }).join("");
  bindSessRows($("board"));
}
function sessRow(s, x) {
  const label = x.title && x.kind === "desk" ? x.title : x.activity;
  return `<div class="sess" data-seat="${esc(s.id)}" data-id="${esc(x.id)}">
    <span class="st-dot ${x.state}"></span><span class="nm">${esc(x.name)}</span>
    <span class="chip">${x.kind === "lane" ? "lane" : "desk"}</span>
    <span class="act">${privateText(x, label)}</span></div>`;
}
function bindSessRows(root) {
  root.querySelectorAll(".sess").forEach(r => r.addEventListener("click", () => go({ kind: "session", seat: r.dataset.seat, id: r.dataset.id })));
}

// ------------------------------------------------------------------------------------------------ panels
function renderPanel(force) {
  if (!snap) return;
  const p = $("panel");
  const k = view.kind;
  if (!force && (k === "divider" || k === "hire")) { refreshLiveBits(); return; }
  const sel = window.getSelection && window.getSelection();
  if (!force && sel && !sel.isCollapsed && p.contains(sel.anchorNode)) return;   // don't wipe what you are selecting
  const html = ({ ceo: panelCEO, seat: panelSeat, session: panelSession, divider: panelDivider, hire: panelHire,
    services: panelServices, programmes: panelProgrammes, lounge: panelLounge, lane: panelLane }[k] || panelCEO)();
  if (!force && p.dataset.html === html) return;
  const active = document.activeElement && p.contains(document.activeElement) ? document.activeElement.id : null;
  const top = p.scrollTop;
  p.innerHTML = html;
  p.dataset.html = html;
  if (!force) p.scrollTop = top;
  bindPanel(p);
  if (active && $(active)) $(active).focus();
}
function crumbs(...parts) {
  return `<nav class="crumbs"><button data-go="ceo">Office</button>${parts.map(x => ` › ${x}`).join("")}</nav>`;
}

function panelCEO() {
  const t = snap.totals;
  const h = new Date().getHours();
  const greet = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const ceo = snap.office.ceo || {};
  const np = snap.next_pick;
  const att = snap.attention || [];
  return `
    <h2>${greet}, ${esc(ceo.name || "CEO")}</h2>
    <div class="sub">${t.working} of ${t.sessions} sessions working on ${t.seats} seats · ${t.lanes} headless lanes · ${fmtTok(t.tokens_1h)} fresh tokens in the last hour</div>
    ${snap.office.config_error ? `<div class="alert bad" style="margin-top:10px"><span class="bar"></span>Config problem: ${esc(snap.office.config_error)}</div>` : ""}
    <h4>Needs you ${att.length ? `(${att.length})` : ""}</h4>
    ${att.length ? att.map(a => `<div class="alert ${a.level} ${a.seat ? "click" : ""}" data-seat="${esc(a.seat || "")}" data-id="${esc(a.session || "")}" data-lane="${esc(a.lane || "")}"><span class="bar"></span><span>${esc(a.text)}</span>${a.resets_at ? `<span class="when">resets in ${until(a.resets_at)}</span>` : ""}</div>`).join("")
      : `<div class="alert good"><span class="bar"></span>All clear. Nothing needs you right now.</div>`}
    <h4>Capacity <span class="muted" style="text-transform:none;letter-spacing:0">· plan left ≈ ${t.five_hour_left_seats} seats (5-hour), ${t.weekly_left_seats} seats (week)</span></h4>
    ${snap.seats.map(s => {
      const u = s.usage || {};
      const p5 = pct(u, "five_hour"), pw = pct(u, "weekly");
      return `<div class="seatrow" style="--seat:${s.color}" data-seat="${esc(s.id)}">
        <span class="dot"></span>
        <span class="nm">${esc(s.label)} <small>${esc(SEAT_LABEL[s.status] || s.status)} · ${live(s).length} live</small></span>
        <span class="u">${meter(p5, s.color)}<span>5h ${p5 == null ? "–" : Math.round(p5) + "%"}${u.five_hour && u.five_hour.resets_at ? " · " + until(u.five_hour.resets_at) : ""}${s.forecast && s.forecast.five_hour && s.forecast.five_hour.state === "runs_out" && p5 < 100 ? ` <b class="warn-t" title="Runs out before its reset at this pace">· out ${until(s.forecast.five_hour.out_at)}</b>` : ""}</span></span>
        <span class="u">${meter(pw, s.color)}<span>wk ${pw == null ? "–" : Math.round(pw) + "%"}${u.weekly && u.weekly.resets_at ? " · " + until(u.weekly.resets_at) : ""}</span></span>
      </div>`;
    }).join("")}
    <div class="pick ${np.seat ? "" : "none"}"><b>Next lane goes to ${esc(np.seat ? seatById(np.seat).label : "nobody")}.</b> <span class="muted">${esc(np.why)}</span>
      <div style="margin-top:8px" class="row"><button class="btn small" data-go="divider">Change the split</button><button class="btn small primary" data-go="hire">Hire a lane</button></div></div>
    ${(snap.programmes || []).length ? `<h4>Programmes</h4>${snap.programmes.map(progBlock).join("")}` : ""}
    ${snap.lanes.length ? `<h4>Office lanes</h4>${snap.lanes.slice(0, 6).map(laneRow).join("")}` : ""}
    <h4>Latest news</h4>
    ${(snap.events || []).slice(-8).reverse().map(e => `<div class="alert ${LEVEL[e.level] || ""}"><span class="bar"></span><span>${esc(e.text)}</span><span class="when">${clock(e.ts)}</span></div>`).join("") || `<div class="muted">No news yet.</div>`}
  `;
}
function progBlock(p) {
  const done = p.sessions.filter(s => s.report_status).length;
  return `<div class="alert"><span class="bar"></span><div style="min-width:0;flex:1">
    <div class="row between"><b>${esc(p.name)}</b>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="chip info">Mission Control ↗</a>` : ""}</div>
    <div class="muted" style="font-size:12.5px">${p.sessions.length} at work${done ? ` · ${done} reported` : ""}: ${p.sessions.map(s => `<span class="st-dot ${s.state}" style="margin:0 3px 0 6px"></span>${esc(s.name.replace(/^wt-/, ""))} <span class="muted">(${esc(s.seat)})</span>`).join("")}</div>
  </div></div>`;
}
function laneRow(l) {
  const cls = { done: "good", running: "info", blocked: "warn", failed: "bad", waiting: "warn", stopped: "" }[l.status] || "";
  return `<div class="alert click ${cls}" data-lane="${esc(l.id)}"><span class="bar"></span><span style="min-width:0"><b>${esc(l.title)}</b><br><span class="muted" style="font-size:12px">${esc(l.status)}${l.seat ? " on " + esc(l.seat) : ""} · ${ago(l.created_at)}${l.report_status ? " · " + esc(l.report_status) : ""}</span></span></div>`;
}

function panelSeat() {
  const s = seatById(view.seat);
  if (!s) return crumbs("gone") + `<div class="muted">That seat is gone.</div>`;
  const u = s.usage || {};
  const a = s.account || {}, h = s.health || {};
  const L = live(s);
  const recent = (snap.events || []).filter(e => e.seat === s.id).slice(-6).reverse();
  const gauge = (k, name) => {
    const w = u[k];
    const v = w && w.pct != null ? w.pct : null;
    return `<div class="gauge" style="--seat:${s.color}"><div class="lbl">${name}</div>
      <div class="big">${v == null ? "–" : Math.round(v) + "%"} <small>used</small></div>${meter(v, s.color)}
      <div class="lbl">${w && w.resets_at ? "resets in " + until(w.resets_at) + " (" + clock(w.resets_at) + ")" : w && w.reset_since_read ? "reset since the last read" : "reset time unknown"}</div>
      ${v != null && v < 100 ? paceLine((s.forecast || {})[k]) : ""}</div>`;
  };
  const sc = s.divider || {};
  return `${crumbs(esc(s.label))}
    <h2 style="--seat:${s.color}"><span class="dot"></span>${esc(s.label)}${s.nickname ? ` <span class="muted" style="font-weight:400">“${esc(s.nickname)}”</span>` : ""}
      <span class="chip" style="margin-left:auto"><span class="st-dot ${s.status}"></span>${esc(SEAT_LABEL[s.status] || s.status)}</span></h2>
    <div class="sub">${privacy ? `<span class="private">${esc(a.email || "")}</span>` : esc([a.name, a.email].filter(Boolean).join(" · "))}</div>
    <div class="sub">${esc([h.tier, h.subscription, a.role].filter(Boolean).join(" · "))} · ${esc(h.detail || "")}</div>
    <div class="gauges">${gauge("five_hour", "5-hour window")}${gauge("weekly", "Weekly allowance")}</div>
    ${(u.scoped || []).length ? `<div class="hint" style="margin-top:6px">${u.scoped.map(x => `${esc(x.label)} ${Math.round(x.pct)}%`).join(" · ")}</div>` : ""}
    <div class="hint" style="margin-top:6px">${u.fetched_at ? `Read ${ago(u.fetched_at)}${u.stale ? " (stale: the login refreshes when this seat next runs)" : ""}` : "No usage read yet"}${u.error ? ` · last try: ${esc(u.error)}` : ""}
      ${s.kind === "claude" ? ` · <button class="btn small" data-refresh="${esc(s.id)}">Read now</button>` : ""}</div>
    ${s.resting_until ? `<div class="alert warn" style="margin-top:8px"><span class="bar"></span>Resting until ${clock(s.resting_until)} after an office lane hit its limit here.</div>` : ""}
    <h4>On the divider</h4>
    <div class="row" style="flex-wrap:wrap;gap:10px;font-size:13px">
      <label class="switch" title="On duty"><input type="checkbox" id="seatDuty" ${sc.enabled ? "checked" : ""}><span></span></label>
      <span>${sc.enabled ? "On duty" : "Benched"}</span>
      <span class="chip">weight ${sc.weight}</span><span class="chip">cap ${sc.max_lanes} lanes</span><span class="chip">runs ${s.lanes} now</span>
      <button class="btn small" data-go="divider">Open divider</button>
    </div>
    ${sc.note ? `<div class="hint" style="margin-top:4px">${esc(sc.note)}</div>` : ""}
    <h4>At the desks (${L.length})</h4>
    ${L.length ? L.map(x => sessRow(s, x)).join("") : `<div class="muted">Nobody here right now${s.status === "limited" ? ": the seat is out of plan" : ""}.</div>`}
    ${s.kind === "claude" ? `<h4>Open a terminal on this seat</h4><div class="copy"><code>CLAUDE_CONFIG_DIR=${esc(s.config_dir)} claude</code><button class="btn small" data-copy="CLAUDE_CONFIG_DIR=${esc(s.config_dir)} claude">Copy</button></div>` : `<h4>Use this seat</h4><div class="copy"><code>gpt -w -C &lt;dir&gt; "task"</code></div>`}
    ${recent.length ? `<h4>Recent</h4>${recent.map(e => `<div class="alert ${LEVEL[e.level] || ""}"><span class="bar"></span><span>${esc(e.text)}</span><span class="when">${clock(e.ts)}</span></div>`).join("")}` : ""}
  `;
}

function panelSession() {
  const s = seatById(view.seat);
  const x = s && s.sessions.find(z => z.id === view.id);
  if (!x) return crumbs(s ? `<button data-seat-go="${esc(s.id)}">${esc(s.label)}</button>` : "") + `<div class="muted" style="margin-top:12px">This session has ended.</div>`;
  const d = detail && detailKey === s.id + "/" + x.id ? detail : null;
  const t1 = x.tokens_1h || {}, t5 = x.tokens_5h || {};
  const lane = (snap.lanes || []).find(l => x.cwd && l.workdir === x.cwd && l.status === "running" && l.seat === s.id);
  return `${crumbs(`<button data-seat-go="${esc(s.id)}">${esc(s.label)}</button>`, esc(x.name))}
    <h2 style="--seat:${s.color}"><span class="dot"></span><span style="overflow:hidden;text-overflow:ellipsis">${esc(x.name)}</span></h2>
    <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
      <span class="chip"><span class="st-dot ${x.state}"></span>${esc(STATE_LABEL[x.state] || x.state)}</span>
      <span class="chip">${x.kind === "lane" ? "Headless lane" : "Interactive"}</span>
      ${x.model ? `<span class="chip">${esc(x.model.replace(/^claude-/, ""))}</span>` : ""}
      ${x.programme ? `<span class="chip info">${esc(x.programme.name)}</span>` : ""}
      ${x.report_status ? `<span class="chip ${/BLOCKED/i.test(x.report_status) ? "warn" : "good"}">Reported</span>` : ""}
    </div>
    <h4>Right now</h4>
    <div class="quote">${privateText(x, x.activity)}${x.quiet_s != null ? `<div class="hint">last sign of life ${dur(x.quiet_s)} ago</div>` : ""}</div>
    ${x.limit_text ? `<div class="alert bad" style="margin-top:8px"><span class="bar"></span>${esc(x.limit_text)}</div>` : ""}
    ${x.title || x.task ? `<h4>Working on</h4>${x.title ? `<div style="font-weight:600;margin-bottom:6px">${privateText(x, x.title)}</div>` : ""}${x.task ? `<div class="quote">${privateText(x, x.task)}</div>` : ""}` : ""}
    ${x.last_text ? `<h4>Last said</h4><div class="quote">${privateText(x, x.last_text)}</div>` : ""}
    ${(x.recent || []).length ? `<h4>Last steps</h4><ul class="timeline">${x.recent.slice().reverse().map(r => `<li><span>${r.ts ? clock(r.ts) : ""}</span><b>${privateText(x, r.text)}</b></li>`).join("")}</ul>` : ""}
    ${x.state_file ? `<h4>Progress notes <span class="muted" style="text-transform:none;letter-spacing:0">(STATE)</span></h4>${d && d.state_tail ? `<pre class="pre">${esc(d.state_tail)}</pre>` : `<div class="hint">${d ? "Empty so far." : "Loading…"}</div>`}` : ""}
    ${x.report_status ? `<h4>Report</h4>${d && d.report ? `<pre class="pre">${esc(d.report)}</pre>` : `<div class="quote">${esc(x.report_status)}</div>`}` : ""}
    <h4>Facts</h4>
    <dl class="kv">
      <dt>Seat</dt><dd>${esc(s.label)}</dd>
      <dt>Started</dt><dd>${x.started_at ? ago(x.started_at) + " (" + clock(x.started_at) + ")" : "–"}</dd>
      <dt>Tools used</dt><dd>${x.tool_calls ?? "–"}</dd>
      <dt>Tokens, 1 h</dt><dd>${fmtTok(t1.fresh)} fresh · ${fmtTok(t1.cached)} cache reads · ${t1.turns ?? 0} turns</dd>
      <dt>Tokens, 5 h</dt><dd>${fmtTok(t5.fresh)} fresh · ${fmtTok(t5.cached)} cache reads</dd>
      ${x.unit ? `<dt>Runs in</dt><dd><code>${esc(x.unit)}</code></dd>` : x.terminal ? `<dt>Runs in</dt><dd>a terminal</dd>` : ""}
      <dt>Folder</dt><dd><code>${esc(x.cwd || "–")}</code></dd>
      ${x.pid ? `<dt>Process</dt><dd>${x.pid}${x.cpu_s != null ? ` · ${dur(x.cpu_s)} CPU` : ""}</dd>` : ""}
      ${x.state_file ? `<dt>STATE</dt><dd><code>${esc(x.state_file)}</code></dd>` : ""}
    </dl>
    ${x.resume_cmd ? `<h4>Resume it later</h4><div class="copy"><code>${esc(x.resume_cmd)}</code><button class="btn small" data-copy="${esc(x.resume_cmd)}">Copy</button></div>` : ""}
    ${lane ? `<div style="margin-top:12px"><button class="btn" data-lane-go="${esc(lane.id)}">Open office lane</button></div>` : ""}
  `;
}

function panelServices() {
  const units = snap.units || [];
  return `${crumbs("Server room")}<h2>Server room</h2><div class="sub">Background services that keep lanes going: conductors, supervisors and lanes run by systemd.</div>
    <h4>Services (${units.length})</h4>
    ${units.length ? units.map(u => `<div class="alert ${u.active === "failed" ? "bad" : u.active === "active" ? "good" : ""}"><span class="bar"></span><span style="min-width:0"><b>${esc(u.unit)}</b><br><span class="muted" style="font-size:12.5px">${esc(u.description)}</span></span><span class="when">${esc(u.active)}/${esc(u.sub)}</span></div>`).join("")
      : `<div class="muted">No watched services. Add patterns to <code>watch_units</code> in the config.</div>`}`;
}
function panelProgrammes() {
  return `${crumbs("Meeting room")}<h2>Programmes</h2><div class="sub">Work grouped by programme. Set names and Mission Control links in <code>~/.config/claude-office/config.json</code>.</div>
    <h4>On the whiteboard</h4>${(snap.programmes || []).map(progBlock).join("") || `<div class="muted">No running work belongs to a programme.</div>`}`;
}
function panelLounge() {
  const resting = snap.seats.filter(s => ["limited", "benched", "offline"].includes(s.status) || !live(s).length);
  return `${crumbs("Lounge")}<h2>Lounge</h2><div class="sub">Seats with nobody at their desks take a break here; a seat out of plan sleeps on the couch until it resets.</div>
    <h4>On a break (${resting.length})</h4>
    ${resting.map(s => {
      const u = s.usage || {};
      const why = s.status === "limited" ? `out of plan${u.five_hour && u.five_hour.resets_at ? `, back in ${until(u.five_hour.resets_at)}` : ""}` :
        s.status === "benched" ? "benched on the divider" : s.status === "offline" ? "logged out" : "free for work";
      return `<div class="alert click" data-seat="${esc(s.id)}"><span class="bar" style="background:${s.color}"></span><span><b>${esc(s.label)}</b> · ${esc(why)}</span></div>`;
    }).join("") || `<div class="muted">Everyone is at their desk.</div>`}`;
}

// ------------------------------------------------------------------------------------------------ divider
function dvFromSnap() { return JSON.parse(JSON.stringify(snap.divider)); }
function enabledIds() { return snap.seats.map(s => s.id).filter(id => dv.seats[id] && dv.seats[id].enabled && dv.seats[id].weight > 0); }
function normalise() {
  const ids = snap.seats.map(s => s.id).filter(id => dv.seats[id].enabled);
  const total = ids.reduce((a, id) => a + dv.seats[id].weight, 0);
  if (!ids.length) return;
  if (total <= 0) { ids.forEach(id => dv.seats[id].weight = Math.floor(100 / ids.length)); }
  else ids.forEach(id => dv.seats[id].weight = Math.round(dv.seats[id].weight / total * 100));
  const drift = 100 - ids.reduce((a, id) => a + dv.seats[id].weight, 0);
  if (drift) { const top = ids.reduce((a, b) => dv.seats[a].weight >= dv.seats[b].weight ? a : b); dv.seats[top].weight += drift; }
}
function panelDivider() {
  if (!dv) { dv = dvFromSnap(); normalise(); dvDirty = false; }
  const ids = enabledIds();
  const segs = snap.seats.map(s => {
    const c = dv.seats[s.id];
    const on = c.enabled && c.weight > 0;
    return `<div class="seg ${on ? "" : "off"}" data-seg="${esc(s.id)}" style="--seat:${s.color};flex:0 0 ${on ? c.weight : 0}%">${esc(s.label)}<small>${c.weight}%</small></div>`;
  }).join("");
  return `${crumbs("Load divider")}
    <h2>Load divider</h2>
    <div class="sub">Decide how new work is split across seats. Drag the white handles, bench a seat, cap its lanes. Office lanes and anything that calls <code>pick-seat</code> follow it.</div>
    <h4>Split</h4>
    <div class="split" id="split">${segs}${ids.slice(0, -1).map((id, i) => `<div class="handle" tabindex="0" role="slider" aria-label="Border after ${esc(seatById(id).label)}" data-h="${i}"></div>`).join("")}</div>
    <div class="row between" style="margin-top:10px">
      <div class="seg-ctl" role="group" aria-label="Mode">
        <button data-mode="fixed" class="${dv.mode === "fixed" ? "on" : ""}">Fixed split</button>
        <button data-mode="headroom" class="${dv.mode === "headroom" ? "on" : ""}">Headroom-aware</button>
      </div>
      <button class="btn small" id="dvSuggest" title="Weights proportional to the plan each on-duty seat has left">Suggest from plan left</button>
    </div>
    <div class="hint" style="margin-top:6px">${dv.mode === "headroom" ? "Headroom-aware: each seat's share shrinks as its plan runs out, so a nearly-spent seat gets less." : "Fixed split: shares are honoured as set, until a guard stops a seat."}</div>
    <div id="dvPick"></div>
    <h4>Seats</h4>
    ${snap.seats.map(s => {
      const c = dv.seats[s.id];
      const u = s.usage || {};
      return `<div class="dseat" style="--seat:${s.color}">
        <span class="dot"></span><b>${esc(s.label)} <span class="muted" style="font-weight:400;font-size:12.5px">${esc(SEAT_LABEL[s.status] || s.status)} · 5h ${pct(u, "five_hour") == null ? "–" : Math.round(pct(u, "five_hour")) + "%"} · wk ${pct(u, "weekly") == null ? "–" : Math.round(pct(u, "weekly")) + "%"}</span></b>
        <label class="switch" title="On duty"><input type="checkbox" data-duty="${esc(s.id)}" ${c.enabled ? "checked" : ""} aria-label="${esc(s.label)} on duty"><span></span></label>
        <div class="ctl">
          <label>Share <input type="number" min="0" max="100" value="${c.weight}" data-w="${esc(s.id)}" ${c.enabled ? "" : "disabled"}>%</label>
          <label>Lane cap <input type="number" min="0" max="16" value="${c.max_lanes}" data-cap="${esc(s.id)}"></label>
          <span>runs ${s.lanes} now</span>
        </div>
        <div class="ctl"><input type="text" placeholder="Note, e.g. keep for interactive work" value="${esc(c.note || "")}" data-note="${esc(s.id)}" maxlength="200"></div>
      </div>`;
    }).join("")}
    <h4>Guards</h4>
    <div class="grid2">
      <label class="f">No new lane at 5-hour usage ≥ <input type="number" min="10" max="100" id="dv5" value="${dv.five_hour_guard}"></label>
      <label class="f">No new lane at weekly usage ≥ <input type="number" min="10" max="100" id="dvW" value="${dv.weekly_guard}"></label>
      <label class="f">Office-wide lane cap <input type="number" min="0" max="32" id="dvG" value="${dv.global_max_lanes}"></label>
    </div>
    <div class="row" style="gap:8px;margin-top:4px">
      <button class="btn primary" id="dvSave" ${dvDirty ? "" : "disabled"}>Save split</button>
      <button class="btn" id="dvReset" ${dvDirty ? "" : "disabled"}>Undo changes</button>
      ${dvDirty ? `<span class="hint">Unsaved changes</span>` : snap.divider.updated_at ? `<span class="hint">Saved ${ago(snap.divider.updated_at)}</span>` : ""}
    </div>
    <h4>Use it from scripts</h4>
    <div class="copy"><code>seat=$(python3 -m office pick-seat) || echo "no seat free"</code><button class="btn small" data-copy='seat=$(python3 -m office pick-seat) || echo "no seat free"'>Copy</button></div>
    <div class="hint" style="margin-top:6px">Run from the claude-office folder. <code>--json</code> adds the config dir and the reasoning; exit code 3 means every seat is blocked.</div>
  `;
}
function renderPick() {
  const el = $("dvPick");
  if (!el) return;
  const np = dvPreview || snap.next_pick;
  const who = np.seat || np.pick;
  el.innerHTML = `<div class="pick ${who ? "" : "none"}"><b>${who ? "Next lane → " + esc(seatById(who) ? seatById(who).label : who) : "No seat can take a lane"}</b>${dvPreview ? " <span class='chip'>preview</span>" : ""}<div class="muted" style="font-size:12.5px;margin-top:3px">${esc(np.why)}</div>
    <div style="margin-top:6px;font-size:12px">${(np.ranking || []).map(r => `<div class="row between"><span>${r.eligible ? "✓" : "–"} ${esc(seatById(r.seat) ? seatById(r.seat).label : r.seat)}</span><span class="muted">${r.eligible ? `share ${Math.round(r.share * 100)}% · runs ${r.lanes} · ${Math.round(r.headroom * 100)}% plan left` : esc(r.blockers.join(", "))}</span></div>`).join("")}</div></div>`;
}
async function previewDivider() {
  if (DEMO) { dvPreview = null; renderPick(); return; }
  try { const r = await post("/api/divider/preview", dv); dvPreview = r.next_pick; } catch { dvPreview = null; }
  renderPick();
}
const previewSoon = debounce(previewDivider, 250);
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function markDirty() { dvDirty = true; previewSoon(); }
function bindDivider(p) {
  const split = $("split");
  if (split) {
    split.querySelectorAll(".handle").forEach(h => {
      positionHandles();
      const i = +h.dataset.h;
      const move = (clientX) => {
        const ids = enabledIds();
        const r = split.getBoundingClientRect();
        let acc = 0; for (let k = 0; k < i; k++) acc += dv.seats[ids[k]].weight;
        const pair = dv.seats[ids[i]].weight + dv.seats[ids[i + 1]].weight;
        let pos = Math.round((clientX - r.left) / r.width * 100) - acc;
        pos = Math.max(1, Math.min(pair - 1, pos));
        dv.seats[ids[i]].weight = pos; dv.seats[ids[i + 1]].weight = pair - pos;
        paintSplit(); markDirty();
      };
      h.addEventListener("pointerdown", (e) => {
        h.setPointerCapture(e.pointerId);
        const mv = (ev) => move(ev.clientX);
        const up = () => { h.removeEventListener("pointermove", mv); h.removeEventListener("pointerup", up); renderPanel(true); };
        h.addEventListener("pointermove", mv); h.addEventListener("pointerup", up);
      });
      h.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const ids = enabledIds();
        const a = dv.seats[ids[i]], b = dv.seats[ids[i + 1]];
        const d = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1);
        if (a.weight + d < 1 || b.weight - d < 1) return;
        a.weight += d; b.weight -= d; paintSplit(); markDirty();
      });
    });
  }
  p.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => { dv.mode = b.dataset.mode; markDirty(); renderPanel(true); }));
  p.querySelectorAll("[data-duty]").forEach(c => c.addEventListener("change", () => {
    const id = c.dataset.duty; dv.seats[id].enabled = c.checked;
    if (c.checked && dv.seats[id].weight <= 0) dv.seats[id].weight = Math.max(5, Math.round(100 / Math.max(1, enabledIds().length + 1)));
    normalise(); markDirty(); renderPanel(true);
  }));
  p.querySelectorAll("[data-w]").forEach(inp => inp.addEventListener("change", () => {
    const id = inp.dataset.w; const v = Math.max(0, Math.min(100, +inp.value || 0));
    const others = enabledIds().filter(x => x !== id);
    const rest = 100 - v, otot = others.reduce((a, x) => a + dv.seats[x].weight, 0);
    dv.seats[id].weight = v;
    others.forEach(x => dv.seats[x].weight = otot ? Math.round(dv.seats[x].weight / otot * rest) : Math.round(rest / others.length));
    normalise(); markDirty(); renderPanel(true);
  }));
  p.querySelectorAll("[data-cap]").forEach(inp => inp.addEventListener("change", () => { dv.seats[inp.dataset.cap].max_lanes = Math.max(0, Math.min(16, +inp.value || 0)); markDirty(); renderPanel(true); }));
  p.querySelectorAll("[data-note]").forEach(inp => inp.addEventListener("input", () => { dv.seats[inp.dataset.note].note = inp.value; dvDirty = true; const sb = $("dvSave"); if (sb) sb.disabled = false; }));
  for (const [id, key, lo, hi] of [["dv5", "five_hour_guard", 10, 100], ["dvW", "weekly_guard", 10, 100], ["dvG", "global_max_lanes", 0, 32]]) {
    const el = $(id); if (el) el.addEventListener("change", () => { dv[key] = Math.max(lo, Math.min(hi, +el.value || 0)); markDirty(); renderPanel(true); });
  }
  const sug = $("dvSuggest");
  if (sug) sug.addEventListener("click", () => {
    let tot = 0; const raw = {};
    for (const s of snap.seats) {
      const c = dv.seats[s.id];
      const left = ["five_hour", "weekly"].map(k => pct(s.usage, k)).filter(v => v != null).map(v => Math.max(0, 100 - v) / 100);
      raw[s.id] = c.enabled && s.status !== "offline" ? (left.length ? Math.min(...left) : 0.5) : 0; tot += raw[s.id];
    }
    for (const s of snap.seats) dv.seats[s.id].weight = tot ? Math.round(raw[s.id] / tot * 100) : 0;
    normalise(); markDirty(); renderPanel(true); toast("Split set from the plan each seat has left. Save to apply.");
  });
  const save = $("dvSave");
  if (save) save.addEventListener("click", async () => {
    try { const r = await post("/api/divider", dv); dvDirty = false; dvPreview = null; dv = null; if (r.demo) toast("Demo office: nothing saved."); else toast(`Saved. Next lane → ${r.next_pick && r.next_pick.seat ? r.next_pick.seat : "nobody"}.`); await poll(); renderPanel(true); }
    catch (e) { toast("Could not save: " + e.message); }
  });
  const reset = $("dvReset");
  if (reset) reset.addEventListener("click", () => { dv = null; dvDirty = false; dvPreview = null; renderPanel(true); });
  renderPick();
}
function paintSplit() {
  const split = $("split"); if (!split) return;
  split.querySelectorAll(".seg").forEach(seg => {
    const c = dv.seats[seg.dataset.seg];
    const on = c.enabled && c.weight > 0;
    seg.style.flexBasis = (on ? c.weight : 0) + "%";
    seg.querySelector("small").textContent = c.weight + "%";
  });
  positionHandles();
  document.querySelectorAll("[data-w]").forEach(inp => { if (document.activeElement !== inp) inp.value = dv.seats[inp.dataset.w].weight; });
  const sb = $("dvSave"), rb = $("dvReset"); if (sb) sb.disabled = false; if (rb) rb.disabled = false;
}
function positionHandles() {
  const split = $("split"); if (!split) return;
  const ids = enabledIds(); let acc = 0;
  split.querySelectorAll(".handle").forEach((h, i) => {
    acc += dv.seats[ids[i]] ? dv.seats[ids[i]].weight : 0;
    h.style.left = acc + "%";
    h.setAttribute("aria-valuenow", String(acc));
  });
}

// ------------------------------------------------------------------------------------------------ hiring
function panelHire() {
  const ld = snap.office.lane_defaults || {};
  const np = snap.next_pick;
  const dirs = [...new Set([snap.office.default_workdir, ...snap.seats.flatMap(s => s.sessions.map(x => x.cwd))].filter(Boolean))];
  const d = hireDraft;
  return `${crumbs("Hiring desk")}
    <h2>Hire a lane</h2>
    <div class="sub">A lane is a headless agent with a brief. It keeps progress notes so it can move to another seat if its seat runs out of plan, and files a report when it is done.</div>
    <h4>Brief</h4>
    <label class="f">Title <input type="text" id="hTitle" maxlength="80" placeholder="e.g. Fix flaky export test" value="${esc(d.title)}"></label>
    <label class="f">What to do <textarea id="hBrief" placeholder="Goal, where to look, how to verify, what counts as done.">${esc(d.brief)}</textarea></label>
    <label class="f">Working folder <input type="text" id="hDir" list="hDirs" value="${esc(d.workdir || snap.office.default_workdir || "")}"><datalist id="hDirs">${dirs.map(x => `<option value="${esc(x)}">`).join("")}</datalist></label>
    <div class="grid2">
      <label class="f">Seat <select id="hSeat">
        <option value="auto" ${d.seat === "auto" ? "selected" : ""}>Auto: divider picks (now ${esc(np.seat || "nobody")})</option>
        ${snap.seats.map(s => `<option value="${esc(s.id)}" ${d.seat === s.id ? "selected" : ""}>${esc(s.label)} · ${esc(SEAT_LABEL[s.status] || s.status)}</option>`).join("")}
      </select></label>
      <label class="f">Model <select id="hModel">${["opus", "sonnet", "fable", "haiku"].map(m => `<option ${(d.model || ld.model) === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    </div>
    <label class="f">Permissions <select id="hPerm">
      <option value="acceptEdits" ${(d.permission_mode || ld.permission_mode) === "acceptEdits" ? "selected" : ""}>Accept edits, listed tools only</option>
      <option value="bypassPermissions" ${(d.permission_mode || ld.permission_mode) === "bypassPermissions" ? "selected" : ""}>Full trust (skips every permission check)</option>
    </select></label>
    <div class="hint" id="hNote">${d.seat && seatById(d.seat) && seatById(d.seat).kind === "codex" ? "Codex seat: runs through the gpt bridge; model and permissions do not apply." : "Runs at low CPU priority with no display, as a systemd user unit."}</div>
    <div class="row" style="margin-top:12px;gap:8px"><button class="btn primary" id="hGo">Hire and start</button><button class="btn" id="hClear">Clear</button></div>
    <h4>Office lanes</h4>
    <div id="laneList">${laneList()}</div>`;
}
function laneList() { return snap.lanes.length ? snap.lanes.map(laneRow).join("") : `<div class="muted">No office lanes yet.</div>`; }
function bindHire(p) {
  const save = () => { hireDraft = { title: $("hTitle").value, brief: $("hBrief").value, workdir: $("hDir").value, seat: $("hSeat").value, model: $("hModel").value, permission_mode: $("hPerm").value }; store.set("hireDraft", hireDraft); };
  ["hTitle", "hBrief", "hDir", "hSeat", "hModel", "hPerm"].forEach(id => $(id).addEventListener("input", save));
  $("hSeat").addEventListener("change", () => { save(); renderPanel(true); });
  $("hClear").addEventListener("click", () => { hireDraft = { title: "", brief: "", workdir: "", seat: "auto", model: "", permission_mode: "" }; store.set("hireDraft", hireDraft); renderPanel(true); });
  $("hGo").addEventListener("click", async () => {
    save();
    if (!hireDraft.title.trim() || !hireDraft.brief.trim()) { toast("Give the lane a title and a brief."); return; }
    if (hireDraft.permission_mode === "bypassPermissions" && !confirm("Full trust lets the lane run any command without asking. Start it?")) return;
    const btn = $("hGo"); btn.disabled = true;
    try {
      const r = await post("/api/lanes", hireDraft);
      if (r.demo) toast("Demo office: no lane was started.");
      else { toast(`Hired “${r.lane.title}”. It will sit down in a few seconds.`); hireDraft = { title: "", brief: "", workdir: hireDraft.workdir, seat: "auto", model: "", permission_mode: "" }; store.set("hireDraft", hireDraft); }
      await poll(); renderPanel(true);
    } catch (e) { toast("Could not hire: " + e.message); btn.disabled = false; }
  });
}

async function panelLaneLoad() {
  try { const r = await fetch("/api/lane?id=" + encodeURIComponent(view.id)); detail = await r.json(); detailKey = "lane/" + view.id; renderPanel(true); } catch { /* keep the last view */ }
}
function panelLane() {
  const d = detail && detailKey === "lane/" + view.id ? detail : null;
  const l = (snap.lanes || []).find(x => x.id === view.id) || (d && d.lane);
  if (!l) return crumbs("Lane") + `<div class="muted">Loading…</div>`;
  const runs = (d && d.lane.runs) || l.runs || [];
  const running = l.unit_active || l.status === "running" || l.status === "starting" || l.status === "waiting";
  return `${crumbs(`<button data-go="hire">Hiring desk</button>`, esc(l.title))}
    <h2>${esc(l.title)}</h2>
    <div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap"><span class="chip">${esc(l.status)}</span>${l.seat ? `<span class="chip">on ${esc(l.seat)}</span>` : ""}<span class="chip">${esc(l.model)}</span><span class="chip">${esc(l.seat_pref === "auto" ? "divider picks" : "pinned to " + l.seat_pref)}</span></div>
    ${l.waiting_reason ? `<div class="alert warn" style="margin-top:8px"><span class="bar"></span>${esc(l.waiting_reason)}</div>` : ""}
    <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
      ${running ? `<button class="btn danger" id="lStop">Stop</button>` : `<button class="btn" id="lResume">Resume</button>`}
      <select id="lSeat" style="width:auto"><option value="">same seat rule</option><option value="auto">Auto (divider)</option>${snap.seats.map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join("")}</select>
    </div>
    ${l.report_status ? `<h4>Report</h4><pre class="pre">${esc((d && d.report) || l.report_status)}</pre>` : ""}
    <h4>Progress notes</h4><pre class="pre">${esc((d && d.state) || l.state_tail || "Nothing yet.")}</pre>
    <h4>Runs</h4>${runs.length ? `<ul class="timeline">${runs.slice().reverse().map(r => `<li><span>${clock(r.started_at)}</span><b>${esc(r.seat)}${r.rc != null ? ` · exit ${r.rc}` : " · running"}${r.ended_by ? " · " + esc(r.ended_by) : ""}</b></li>`).join("")}</ul>` : `<div class="muted">Not started yet.</div>`}
    <h4>Brief</h4><div class="quote">${esc(d ? d.brief : "")}</div>
    <h4>Log tail</h4><pre class="pre">${esc((d && d.log) || "")}</pre>
    <dl class="kv" style="margin-top:12px"><dt>Lane id</dt><dd><code>${esc(l.id)}</code></dd><dt>Unit</dt><dd><code>${esc(l.unit)}</code></dd><dt>Folder</dt><dd><code>${esc(l.workdir)}</code></dd></dl>`;
}

// ------------------------------------------------------------------------------------------------ bind
function bindPanel(p) {
  p.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go({ kind: b.dataset.go })));
  p.querySelectorAll("[data-seat-go]").forEach(b => b.addEventListener("click", () => go({ kind: "seat", seat: b.dataset.seatGo })));
  p.querySelectorAll("[data-lane-go]").forEach(b => b.addEventListener("click", () => go({ kind: "lane", id: b.dataset.laneGo })));
  p.querySelectorAll(".seatrow").forEach(r => r.addEventListener("click", () => go({ kind: "seat", seat: r.dataset.seat })));
  p.querySelectorAll(".alert.click").forEach(a => a.addEventListener("click", () => {
    if (a.dataset.lane) go({ kind: "lane", id: a.dataset.lane });
    else if (a.dataset.id) go({ kind: "session", seat: a.dataset.seat, id: a.dataset.id });
    else if (a.dataset.seat) go({ kind: "seat", seat: a.dataset.seat });
  }));
  p.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied."); } catch { toast("Copy failed: select the text instead."); }
  }));
  p.querySelectorAll("[data-refresh]").forEach(b => b.addEventListener("click", async () => {
    try { await post("/api/usage/refresh", { seat: b.dataset.refresh }); toast("Reading the plan now."); setTimeout(poll, 2500); } catch (e) { toast(e.message); }
  }));
  bindSessRows(p);
  const duty = $("seatDuty");
  if (duty) duty.addEventListener("change", async () => {
    const cfg = dvFromSnap(); cfg.seats[view.seat].enabled = duty.checked;
    try { await post("/api/divider", cfg); toast(duty.checked ? "Back on duty." : "Benched: no new lanes go here."); await poll(); renderPanel(true); } catch (e) { toast(e.message); duty.checked = !duty.checked; }
  });
  if (view.kind === "divider") bindDivider(p);
  if (view.kind === "hire") bindHire(p);
  if (view.kind === "lane") {
    const stop = $("lStop"), res = $("lResume");
    if (stop) stop.addEventListener("click", async () => { if (!confirm("Stop this lane? Its progress notes stay, so you can resume it.")) return; try { await post("/api/lanes/stop", { id: view.id }); toast("Stopped."); await poll(); panelLaneLoad(); } catch (e) { toast(e.message); } });
    if (res) res.addEventListener("click", async () => { try { await post("/api/lanes/resume", { id: view.id, seat: $("lSeat").value || null }); toast("Resuming."); await poll(); panelLaneLoad(); } catch (e) { toast(e.message); } });
  }
}
function refreshLiveBits() {
  if (view.kind === "divider") { if (!dvDirty) { dv = null; renderPanel(true); } else renderPick(); }
  if (view.kind === "hire") { const ll = $("laneList"); if (ll) { ll.innerHTML = laneList(); bindPanel(ll); } }
}

// ------------------------------------------------------------------------------------------------ loop
async function poll() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    snap = await r.json();
    if (!snap || !snap.seats) return;
    office.update(snap);
    renderTop(); renderTicker();
    if (mode === "board") renderBoard();
    renderPanel(false);
    if (view.kind === "session") maybeDetail();
    if (view.kind === "lane" && Date.now() - detailAt > 8000) { detailAt = Date.now(); panelLaneLoad(); }
  } catch (e) {
    $("summaryLine").textContent = "Lost the office server: " + e.message + ". Retrying…";
  }
}
async function maybeDetail() {
  const key = view.seat + "/" + view.id;
  if (detailKey === key && Date.now() - detailAt < 10000) return;
  detailAt = Date.now();
  try {
    const r = await fetch(`/api/session?seat=${encodeURIComponent(view.seat)}&id=${encodeURIComponent(view.id)}`);
    if (!r.ok) return;
    detail = await r.json(); detailKey = key; renderPanel(true);
  } catch { /* the panel shows what the snapshot has */ }
}

function setMode(m) {
  mode = m; store.set("mode", m);
  $("floor").hidden = m !== "floor"; $("board").hidden = m !== "board";
  if (snap) { renderTop(); if (m === "board") renderBoard(); }
}

$("btnView").addEventListener("click", () => setMode(mode === "floor" ? "board" : "floor"));
$("btnPrivacy").addEventListener("click", () => { privacy = !privacy; store.set("privacy", privacy); office.setPrivacy(privacy); renderTop(); renderPanel(true); if (mode === "board") renderBoard(); toast(privacy ? "Share-safe on: interactive sessions' topics are hidden." : "Share-safe off."); });
$("btnDivider").addEventListener("click", () => go({ kind: "divider" }));
$("btnHire").addEventListener("click", () => go({ kind: "hire" }));
$("btnCheckpoint").addEventListener("click", async () => {
  try {
    const r = await post("/api/checkpoint", {});
    $("dialogBody").innerHTML = `<div class="dh"><b>Checkpoint ${r.path ? "saved" : "(demo, not saved)"}</b><button class="btn small" id="dClose">Close</button></div>
      <div class="db">${r.path ? `<div class="copy" style="margin-bottom:10px"><code>${esc(r.path)}</code><button class="btn small" data-copy="${esc(r.path)}">Copy path</button></div>` : ""}<pre class="pre" style="max-height:55vh">${esc(r.markdown)}</pre>
      <div class="row" style="margin-top:10px"><button class="btn" id="dCopy">Copy all</button></div></div>`;
    $("dialog").showModal();
    $("dClose").addEventListener("click", () => $("dialog").close());
    $("dCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(r.markdown); toast("Copied."); } catch { toast("Copy failed."); } });
    $("dialogBody").querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied."); } catch { /* ignore */ } }));
  } catch (e) { toast("Checkpoint failed: " + e.message); }
});
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Escape") go({ kind: "ceo" });
  else if (e.key === "h") go({ kind: "hire" });
  else if (e.key === "d") go({ kind: "divider" });
  else if (e.key === "b") setMode(mode === "floor" ? "board" : "floor");
  else if (e.key === "p") $("btnPrivacy").click();
});

office.setPrivacy(privacy);
setMode(mode);
view = viewFromHash();
poll().then(() => go(view, true));
let timer = setInterval(poll, 3000);
document.addEventListener("visibilitychange", () => {
  clearInterval(timer);
  if (!document.hidden) { poll(); timer = setInterval(poll, 3000); }
});

// The lanes board (L): every office lane as a card in four columns, up next, at work, needs you and done, with search,
// a filter by character and model, and old finished lanes archived out of sight. A card opens its lane; a few act in
// place (to the front of the backlog, resume). From the snapshot: the newest 40 lanes and every one still to finish.
import { esc, fmtTok, relTime, dayTime, toast } from "./util.js";
import { icon } from "./icons.js";

const COLS = [
  ["next", "Up next", "clock", (l) => ["scheduled", "queued"].includes(l.status)],
  ["work", "At work", "play", (l) => ["starting", "running", "waiting"].includes(l.status)],
  ["needs", "Needs you", "alert", (l) => ["blocked", "failed", "interrupted"].includes(l.status)],
  ["done", "Done", "check", (l) => ["done", "finished", "stopped"].includes(l.status)],
];
const ARCHIVE_S = 7 * 86400;            // a finished lane older than a week is archived (shown with "Show archived")
const TONE = { done: "good", finished: "good", running: "info", starting: "info", waiting: "warn", blocked: "warn", failed: "bad", interrupted: "warn", stopped: "", scheduled: "", queued: "" };

const ended = (l) => l.finished_at || ((l.runs || []).slice(-1)[0] || {}).ended_at || l.created_at || 0;

// Which lanes show, in which column, in what order.
export function boardColumns(lanes, { q = "", seat = "", model = "", archived = false, now = Date.now() / 1000 } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const keep = lanes.filter(l => (!seat || (l.seat || l.seat_pref) === seat) && (!model || l.model === model)
    && words.every(w => `${l.title || ""} ${l.id} ${(l.report_status || "")}`.toLowerCase().includes(w)));
  const out = {};
  let hidden = 0;
  for (const [key, , , test] of COLS) {
    let col = keep.filter(test);
    if (key === "done" && !archived) { const old = col.filter(l => now - ended(l) > ARCHIVE_S); hidden = old.length; col = col.filter(l => !old.includes(l)); }
    col.sort(key === "next" ? (a, b) => ((a.schedule || {}).backlog ? a.backlog_pos ?? 999 : -1) - ((b.schedule || {}).backlog ? b.backlog_pos ?? 999 : -1) || (a.created_at || 0) - (b.created_at || 0)
      : key === "done" ? (a, b) => ended(b) - ended(a) : (a, b) => (b.created_at || 0) - (a.created_at || 0));
    out[key] = col;
  }
  return { cols: out, hidden, total: keep.length };
}

export function renderLanesBoard(el, app, persona) {
  const snap = app.snap(), p = app.prefs(), priv = app.privacy();
  const f = { q: p.lbQuery || "", seat: p.lbSeat || "", model: p.lbModel || "", archived: !!p.lbArchived, now: snap.now };
  const lanes = snap.lanes || [], { cols, hidden, total } = boardColumns(lanes, f);
  const seatOf = (id) => snap.seats.find(s => s.id === id), name = (id) => { const s = seatOf(id); return s ? persona(s).name : id === "auto" ? "Divider picks" : id || "No seat yet"; };
  const promised = new Map(((snap.promises || {}).open || []).map(x => [x.lane, x]));
  const models = [...new Set(lanes.map(l => l.model).filter(Boolean))].sort();
  const when = (l) => l.status === "scheduled" ? ((l.schedule || {}).backlog ? `in the backlog${l.backlog_pos != null ? `, #${l.backlog_pos + 1}` : ""}` : (l.schedule || {}).at ? `starts ${dayTime(l.schedule.at)}` : "starts when a seat has room")
    : ["running", "starting", "waiting"].includes(l.status) ? `${l.status === "waiting" ? "waiting" : "running"} ${relTime(((l.runs || []).slice(-1)[0] || {}).started_at || l.created_at).replace(/ ago$/, "")}`
    : `${l.status} ${relTime(ended(l))}`;
  const card = (l) => {
    const s = seatOf(l.seat || l.seat_pref), pm = promised.get(l.id);
    return `<div class="lb-card st-${esc(l.status)}" style="--seat:${esc(s ? s.color : "#82889f")}" data-lane-go="${esc(l.id)}" role="button" tabindex="0" aria-label="${esc(priv ? "A lane" : l.title)}, ${esc(l.status)}">
      <div class="lb-top"><b class="${priv ? "private" : ""}">${esc(priv ? "A lane" : l.title)}</b><span class="pill ${TONE[l.status] || ""}">${esc(l.status)}</span></div>
      <div class="lb-meta"><span class="lb-who"><i></i>${esc(name(l.seat || l.seat_pref))}</span><span>${esc(l.model || "")}</span><span>${esc(when(l))}</span></div>
      ${!priv && l.report_status ? `<div class="lb-rep">${esc(l.report_status.slice(0, 140))}</div>` : ""}
      <div class="lb-tags">${l.trust ? `<span class="lb-tag t-${esc(l.trust.level)}">${icon(l.trust.level === "verified" ? "check" : l.trust.level === "contradicted" ? "x" : "alert", 11)}${esc(l.trust.level)}</span>` : ""}
        ${pm ? `<span class="lb-tag">${icon("flag", 11)}by ${esc(dayTime(pm.due))}</span>` : ""}${l.bakeoff ? `<span class="lb-tag">${icon("flag", 11)}bake-off ${esc(l.bakeoff.side)}</span>` : ""}
        ${l.worktree ? `<span class="lb-tag">${icon("branch", 11)}own worktree</span>` : ""}${(l.chain_of || {}).of > 1 ? `<span class="lb-tag">stage ${l.chain_of.step} of ${l.chain_of.of}</span>` : ""}
        ${l.spent && l.spent.tokens ? `<span class="lb-tag">${fmtTok(l.spent.tokens)} tokens</span>` : ""}</div>
      ${(l.schedule || {}).backlog && l.backlog_pos > 0 ? `<button class="btn sm ghost" data-lb-front="${esc(l.id)}">${icon("chevronRight", 13)}To the front</button>` : ""}
      ${["interrupted", "failed"].includes(l.status) ? `<button class="btn sm" data-lb-resume="${esc(l.id)}">${icon("play", 13)}Resume</button>` : ""}</div>`;
  };
  const focus = document.activeElement && document.activeElement.id === "lbFind" ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  el.innerHTML = `<div class="view-card lb">
    <div class="lb-head"><div class="grow"><h3>Lanes</h3><p>${total} lane${total === 1 ? "" : "s"}${hidden ? `, ${hidden} archived` : ""}: the newest 40 and every one still to finish.</p></div>
      <div class="chat-find" style="margin:0;min-width:200px">${icon("search", 15)}<input type="search" id="lbFind" placeholder="Find a lane" aria-label="Find a lane" value="${esc(f.q)}" autocomplete="off"></div>
      <select id="lbSeat" aria-label="Character"><option value="">Every character</option>${snap.seats.map(s => `<option value="${esc(s.id)}" ${f.seat === s.id ? "selected" : ""}>${esc(persona(s).name)}</option>`).join("")}</select>
      <select id="lbModel" aria-label="Model"><option value="">Every model</option>${models.map(m => `<option ${f.model === m ? "selected" : ""}>${esc(m)}</option>`).join("")}</select>
      <label class="check"><input type="checkbox" id="lbArch" ${f.archived ? "checked" : ""}> Show archived</label>
      <button class="btn sm primary" data-go="hire">${icon("plus", 14)}Hire</button></div>
    <div class="lb-cols">${COLS.map(([key, label, ic]) => `<section class="lb-col c-${key}"><h4>${icon(ic, 15)}${label}<span class="count">${cols[key].length}</span></h4>
      ${cols[key].length ? cols[key].map(card).join("") : `<p class="muted lb-none">${key === "needs" ? "Nothing needs you." : key === "work" ? "No lane at work." : key === "next" ? "Nothing waiting." : "None yet."}</p>`}</section>`).join("")}</div></div>`;
  const find = el.querySelector("#lbFind");
  if (focus) { find.focus(); try { find.setSelectionRange(focus[0], focus[1]); } catch { /* */ } }
  let t = 0;
  find.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { app.setPref("lbQuery", find.value); renderLanesBoard(el, app, persona); }, 200); });
  el.querySelector("#lbSeat").addEventListener("change", (e) => { app.setPref("lbSeat", e.target.value); renderLanesBoard(el, app, persona); });
  el.querySelector("#lbModel").addEventListener("change", (e) => { app.setPref("lbModel", e.target.value); renderLanesBoard(el, app, persona); });
  el.querySelector("#lbArch").addEventListener("change", (e) => { app.setPref("lbArchived", e.target.checked); renderLanesBoard(el, app, persona); });
  el.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => app.go({ kind: b.dataset.go })));
  el.querySelectorAll("[data-lane-go]").forEach(c => {
    const open = () => app.go({ kind: "lane", id: c.dataset.laneGo });
    c.addEventListener("click", (e) => { if (!e.target.closest("button")) open(); });
    c.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === c) { e.preventDefault(); open(); } });
  });
  const act = (sel, path, ok) => el.querySelectorAll(sel).forEach(b => b.addEventListener("click", async () => {
    b.disabled = true;
    try { const r = await app.post(path, { id: b.getAttribute(sel.slice(1, -1)), seat: null }); toast(r.demo ? "Demo office: nothing was changed." : ok, r.demo ? "info" : "good"); app.refresh(); }
    catch (e) { toast(e.message, "bad"); b.disabled = false; }
  }));
  act("[data-lb-front]", "/api/lanes/front", "First in line now.");
  act("[data-lb-resume]", "/api/lanes/resume", "Resuming the lane.");
}

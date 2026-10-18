// The big views beside the floor: Timeline, Team and Today.
import { esc, fmtTok, live, hydratePortraits, avatar, dayTime, STATE_LABEL, clock, toast } from "./util.js";
import { timeline, bindTips } from "./charts.js";
import { icon } from "./icons.js";
import { personaFor, leftOf, voice, diary } from "./personas.js";
import { localDay } from "./goals.js";
import { tokensCard, bindTokens, focusKey, refocus as refocusTokens, waitCard, waitFor } from "./tokens.js";

export function renderTimeline(el, app) {
  const hours = app.prefs().tlHours || 6;
  const hist = app.historyCache(hours);
  const width = Math.max(600, el.clientWidth - 40);
  el.innerHTML = `<div class="view-card">
    <div class="view-head"><div class="grow"><h3>Timeline</h3><p>Every session on every seat, with plan resets coming up on the right.</p></div>
      <div class="seg-ctl">${[1, 3, 6, 12, 24].map(h => `<button data-h="${h}" class="${h === hours ? "on" : ""}">${h} h</button>`).join("")}</div></div>
    ${hist ? (hist.unavailable ? `<div class="muted" style="padding:20px">The timeline needs the history store on the server. Restart the office after updating.</div>` : timeline(hist, app.snap(), width, hours, (s) => personaFor(s, app.snap().seats.findIndex(x => x.id === s.id)).name, app.humanise))
      : `<div class="skeleton"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%"></div>`}
    <div class="tl-legend"><span><i class="k working"></i>Working</span><span><i class="k waiting"></i>Waiting on a tool</span><span><i class="k idle"></i>Idle</span><span><i class="k limited"></i>Out of plan</span><span><i class="k stuck"></i>Quiet</span>
      <span>◆ News</span><span style="color:var(--info)">┆ Plan resets</span><span style="color:var(--bad)">✕ Runs out at this pace</span><span>✓ Reported</span></div>
  </div>`;
  el.querySelectorAll("[data-h]").forEach(b => b.addEventListener("click", () => { app.setPref("tlHours", +b.dataset.h); app.loadHistory(+b.dataset.h, true); }));
  bindTips(el);
  el.querySelectorAll(".seg").forEach(r => r.addEventListener("click", () => app.go({ kind: "session", seat: r.dataset.seat, id: r.dataset.sid })));
}

export function renderBoard(el, app) {
  const snap = app.snap();
  el.innerHTML = `<div class="team">${snap.seats.map((s, i) => {
    const p = personaFor(s, i), vo = voice(s, p, dayTime), L = live(s);
    const meter = (key, label) => {
      const left = leftOf(s, key), w = (s.usage || {})[key];
      return `<div style="margin-top:10px"><div class="row between" style="font-size:13px"><span class="muted">${label}</span><b>${left == null ? "–" : Math.round(left) + "% left"}</b></div>
        <div class="minibar ${left != null && left < 15 ? "low" : left != null && left < 35 ? "mid" : ""}" style="--seat:${s.color}"><i style="width:${left ?? 0}%"></i></div>
        ${w && w.resets_at ? `<div class="hint" style="margin-top:4px">resets ${dayTime(w.resets_at)}</div>` : ""}</div>`;
    };
    return `<div class="tcard" style="--seat:${s.color}">
      <div class="who" data-seat="${esc(s.id)}" role="button" tabindex="0" aria-label="Open ${esc(p.name)}">${avatar("mascot-" + s.id, s.color, (s.status === "offline" ? "dim," : "") + "lv" + (s.career ? s.career.level : 0))}
        <div><h3>${esc(p.name)}</h3><div class="role">${esc(p.role)} · ${esc(s.label)}</div></div>
        <span class="pill ${vo.tone}">${esc(vo.word)}</span></div>
      <div class="moodline">“${esc(vo.line)}”</div>
      ${s.career ? `<div class="tlevel"><span class="lvchip">Lv ${s.career.level}</span><span>${esc(s.career.title)}</span><div class="xpbar"><i style="width:${Math.round(s.career.progress * 100)}%"></i></div><span class="tro">${icon("trophy", 13)}${Object.keys(s.career.unlocked).length}</span></div>` : ""}
      ${meter("five_hour", "5-hour window")}${meter("weekly", "This week")}
      <div style="margin-top:14px">${L.length ? L.map(x => `<div class="sess" data-seat="${esc(s.id)}" data-id="${esc(x.id)}" role="button" tabindex="0" aria-label="Open ${esc(x.name)}, ${esc(STATE_LABEL[x.state] || x.state)}">${avatar(x.id, s.color, x.kind === "desk" ? "headset" : "")}
        <span class="nm"><span class="sdot ${x.state}"></span>${esc(x.name)}</span><span class="pill">${esc(STATE_LABEL[x.state] || x.state)}</span>
        <span class="ac">${app.privacy() && x.kind === "desk" ? "<span class='private'>hidden</span>" : esc(x.activity || "")}</span></div>`).join("") : `<div class="muted" style="font-size:14px">Nobody at the desk.</div>`}</div>
    </div>`;
  }).join("")}</div>`;
  hydratePortraits(el, 4);
  // The rows are buttons for the keyboard too: Tab reaches them, Enter or Space opens them.
  const activate = (r, fn) => { r.addEventListener("click", fn); r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } }); };
  el.querySelectorAll(".sess").forEach(r => activate(r, () => app.go({ kind: "session", seat: r.dataset.seat, id: r.dataset.id })));
  el.querySelectorAll(".who[data-seat]").forEach(r => activate(r, () => app.go({ kind: "seat", seat: r.dataset.seat })));
}

export function renderStats(el, app) {
  const day = app.prefs().statsDay || null;
  const st = app.statsCache(day);
  const snap = app.snap();
  const seatOf = (id) => snap.seats.find(s => s.id === id);
  const nameOf = (id) => { const s = seatOf(id); return s ? personaFor(s, snap.seats.findIndex(x => x.id === s.id)).name : id; };
  if (!st) { el.innerHTML = `<div class="view-card"><div class="skeleton"></div><div class="skeleton" style="width:70%"></div></div>`; return; }
  if (st.unavailable) { el.innerHTML = `<div class="view-card"><div class="muted">Daily stats need the history store on the server. Restart the office after updating.</div></div>`; return; }
  const rows = Object.entries(st.seats || {}).map(([id, v]) => ({ id, ...v, seat: seatOf(id) })).filter(r => r.seat).sort((a, b) => b.active_min - a.active_min || b.reports - a.reports);
  const maxMin = Math.max(1, ...rows.map(r => r.active_min));
  const mvpSeat = st.mvp && seatOf(st.mvp.seat);
  const o = st.office || {};
  const shift0 = (day, n) => { const d = new Date(day + "T12:00:00"); d.setDate(d.getDate() + n); return localDay(d); };
  const shift = (n) => shift0(st.day || localDay(), n);
  const now = new Date(), todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const human = (t) => { let x = String(t); for (const s of snap.seats) { const n = nameOf(s.id); if (n !== s.label) x = x.replace(new RegExp(`\\b${s.label}\\b`, "g"), n); } return x; };
  const hours = Math.round(rows.reduce((a, r) => a + r.active_min, 0) / 6) / 10;
  // Trophies won on this day, from each seat's career.
  const d0 = new Date((st.day || todayStr) + "T00:00:00").getTime() / 1000;
  const cat = Object.fromEntries((snap.achievements || []).map(a => [a.id, a]));
  const won = snap.seats.flatMap(s => Object.entries((s.career || {}).unlocked || {}).filter(([id, at]) => cat[id] && at >= d0 && at < d0 + 86400)
    .map(([id, at]) => ({ s, a: cat[id], at }))).sort((a, b) => a.at - b.at);
  el.innerHTML = `<div class="stats-grid">
    <div class="view-head"><div class="grow"><h3>${st.day === todayStr ? "Today" : st.day === shift0(todayStr, -1) ? "Yesterday" : esc(new Date(st.day + "T12:00:00").toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }))}</h3><p>Who did what, from the office's own records.</p></div>
      <button class="btn sm" data-copy-day title="The day as a few lines of text, for a standup or a channel">${icon("copy", 14)}Copy as text</button>
      <button class="btn sm" data-day="${shift(-1)}">${icon("chevronRight", 14, "flip")}Day before</button>${st.day !== todayStr ? `<button class="btn sm" data-day="${shift(1)}">Next day</button><button class="btn sm" data-day="">Today</button>` : ""}</div>
    <div class="stats-top">
      ${mvpSeat ? `<div class="mvp">${avatar("mascot-" + mvpSeat.id, mvpSeat.color, "crown")}<div><div class="eyebrow">Employee of the day</div><h3>${esc(nameOf(mvpSeat.id))}</h3><div class="muted">${esc(st.mvp.why)}</div></div></div>`
        : `<div class="mvp"><span class="av">${icon("trophy", 40)}</span><div><div class="eyebrow">Employee of the day</div><h3>Nobody yet</h3><div class="muted">The crown goes to whoever earns the most XP today.</div></div></div>`}
      <div class="tiles">
        <div class="tile"><div class="v">${o.sessions ?? 0}</div><div class="tk">sessions</div></div>
        <div class="tile"><div class="v">${o.reports ?? 0}</div><div class="tk">reports filed</div></div>
        <div class="tile"><div class="v">${o.limits ?? 0}</div><div class="tk">limits hit</div></div>
        <div class="tile"><div class="v">${fmtTok(rows.reduce((a, r) => a + (r.tokens_fresh || 0), 0))}</div><div class="tk">fresh tokens</div></div>
        <div class="tile"><div class="v">${hours}</div><div class="tk">hours of agent work</div></div>
        <div class="tile"><div class="v">${o.lanes_hired ?? 0}</div><div class="tk">lanes hired here</div></div>
      </div>
    </div>
    ${weekCard(app, st.day || todayStr)}
    ${parCard(app)}
    ${capacityCard(app)}
    ${limitsCard(app)}
    ${st.day === todayStr || !st.day ? waitCard(app.tokensCache("today"), { label: "today", who: (id) => (id ? nameOf(id) : "Unknown seat"), priv: app.privacy(), section: true }) : ""}
    ${tokensCard(app)}
    ${(st.digest || []).length ? `<div class="view-card"><div class="section-h"><h4>The day in a few lines</h4></div><ul class="digest">${st.digest.map(x => `<li>${esc(human(x))}</li>`).join("")}</ul></div>` : ""}
    <div class="view-card"><div class="section-h"><h4>Diaries</h4></div><div class="diaries">${rows.map(r => { const p = personaFor(r.seat, snap.seats.findIndex(x => x.id === r.seat.id));
      return `<div class="diary-row" style="--seat:${esc(r.seat.color)}"><i data-portrait="mascot-${esc(r.id)}|${esc(r.seat.color)}|"></i><div><b>${esc(p.name)}</b><span>${esc(diary(p, r))}</span></div></div>`; }).join("")}</div></div>
    ${won.length ? `<div class="view-card"><div class="section-h"><h4>Trophies won · ${won.length}</h4><button class="btn sm ghost" data-trophies>${icon("trophy", 14)}Trophy room</button></div>
      <div class="won">${won.map(w => `<span class="wonchip" style="--seat:${esc(w.s.color)}" title="${esc(w.a.desc)}">${icon(w.a.icon, 15)}<b>${esc(nameOf(w.s.id))}</b>${esc(w.a.name)}<small>${clock(w.at)}</small></span>`).join("")}</div></div>` : ""}
    <div class="view-card"><div class="section-h"><h4>League</h4></div>
      <div class="table-scroll"><table class="league"><thead><tr><th>Seat</th><th class="num">Level</th><th style="width:28%">Time at work</th><th class="num">Active</th><th class="num">Sessions</th><th class="num">Reports</th><th class="num">Limits</th><th class="num">Tool calls</th><th class="num">Fresh tokens</th><th class="num">Peak 5 h</th></tr></thead>
      <tbody>${rows.map(r => `<tr style="--seat:${r.seat.color}"><td><span class="who"><i data-portrait="mascot-${esc(r.id)}|${esc(r.seat.color)}|${st.mvp && st.mvp.seat === r.id ? "crown" : ""}"></i>${esc(nameOf(r.id))}</span></td>
        <td class="num">${r.seat.career ? `<span class="lvchip">Lv ${r.seat.career.level}</span>` : "–"}</td>
        <td><div class="bar" style="width:${(r.active_min / maxMin * 100).toFixed(1)}%"></div></td>
        <td class="num">${Math.floor(r.active_min / 60)} h ${String(r.active_min % 60).padStart(2, "0")}</td><td class="num">${r.sessions}</td><td class="num">${r.reports}</td><td class="num">${r.limits}</td>
        <td class="num">${fmtTok(r.tool_calls)}</td><td class="num">${fmtTok(r.tokens_fresh)}</td><td class="num">${r.peak_p5 == null ? "–" : Math.round(r.peak_p5) + "%"}</td></tr>`).join("")}</tbody></table></div>
      ${o.longest_session ? `<div class="hint" style="margin-top:12px">Longest session: <b>${esc(o.longest_session.name)}</b> on ${esc(nameOf(o.longest_session.seat))}, ${Math.floor(o.longest_session.minutes / 60)} h ${Math.round(o.longest_session.minutes % 60)} min.${o.first_activity ? ` First activity ${clock(o.first_activity)}, last ${clock(o.last_activity)}.` : ""}</div>` : ""}
    </div>
  </div>`;
  hydratePortraits(el, 4);
  bindWeek(el, app);
  bindTokens(el, app, () => { const f = focusKey(el); renderStats(el, app); refocusTokens(el, f); });
  if (!day) app.tokensCache("today");                 // warm, for Copy as text
  const cp = el.querySelector("[data-copy-day]");
  if (cp) cp.addEventListener("click", () => {
    const text = dayText(st, app, nameOf);
    navigator.clipboard.writeText(text).then(() => toast("The day is on the clipboard.", "good"), () => toast("Could not copy.", "warn"));
  });
  if (refocus) { const f = el.querySelector(refocus); if (f) { f.focus({ preventScroll: true }); refocus = null; } }
  el.querySelectorAll("[data-trophies]").forEach(b => b.addEventListener("click", () => app.go({ kind: "trophies" })));
  el.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => { app.setPref("statsDay", b.dataset.day || null); app.loadStats(b.dataset.day || null, true); }));
}

// The day as plain text: a standup note or a channel post. Names, counts and the star; no session topics.
export function dayText(st, app, nameOf) {
  const o = st.office || {}, seats = st.seats || {}, sum = (k) => Object.values(seats).reduce((a, s) => a + (s[k] || 0), 0);
  const hrs = sum("active_min") / 60, day = new Date((st.day || new Date().toISOString().slice(0, 10)) + "T12:00:00");
  const t = app.tokensCache("today"), lines = [];
  lines.push(`${app.snap().office.name || "Claude Office"}, ${day.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}`);
  lines.push(`- ${o.reports || 0} report${o.reports === 1 ? "" : "s"} filed, ${hrs >= 10 ? Math.round(hrs) : hrs.toFixed(1)} h of agent work, ${o.sessions || 0} sessions`);
  if (t && t.shipped && (t.shipped.commits || t.shipped.prs_merged)) lines.push(`- Shipped: ${t.shipped.commits} commit${t.shipped.commits === 1 ? "" : "s"}${t.shipped.prs_merged ? `, ${t.shipped.prs_merged} PR${t.shipped.prs_merged === 1 ? "" : "s"} merged` : ""}`);
  if (t && t.total && t.total.all) { const top = (t.seats || []).find(s => s.seat); lines.push(`- Tokens: ${fmtTok(t.total.all)}${top ? `, most by ${nameOf(top.seat)}` : ""}`); }
  if (t && t.waits && t.waits.replies) lines.push(`- Waited on you: ${waitFor(t.waits.seconds)} over ${t.waits.replies} repl${t.waits.replies === 1 ? "y" : "ies"}${t.waits.median_s != null ? `, median reply ${waitFor(t.waits.median_s)}` : ""}`);
  if (st.mvp && st.mvp.seat) lines.push(`- Employee of the day: ${nameOf(st.mvp.seat)}${st.mvp.why ? ` (${st.mvp.why})` : ""}`);
  const busy = Object.entries(seats).filter(([, s]) => s.reports || s.active_min).sort((a, b) => b[1].active_min - a[1].active_min)
    .map(([id, s]) => `${nameOf(id)} ${Math.round(s.active_min / 60 * 10) / 10} h${s.reports ? `, ${s.reports} report${s.reports === 1 ? "" : "s"}` : ""}`);
  if (busy.length) lines.push(`- Who: ${busy.join("; ")}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------------ week chart
// The last seven days as bars, one measure at a time (no second axis): reports, agent hours or tool calls. The day on
// show is highlighted; hovering a bar shows that day's numbers; the header compares with the seven days before.
const WEEK_METRICS = { reports: ["Reports", (d) => d.reports, (v) => String(v)], hours: ["Agent hours", (d) => d.active_min / 60, (v) => v >= 10 ? Math.round(v) + " h" : v.toFixed(1) + " h"],
  calls: ["Tool calls", (d) => d.tool_calls, (v) => v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + "M" : v >= 10000 ? Math.round(v / 1000) + "k" : v.toLocaleString()] };
// Par for the week: each seat's weekly plan window scored like a round of golf (office/weeks.py), the last six and
// this one so far, with the season total. Using most of the plan without running out is the good round.
const PAR_TONE = { "-2": "eagle", "-1": "birdie", "0": "par", "1": "bogey", "2": "double" };
export const parMark = (score) => (score == null ? "–" : score === 0 ? "E" : score < 0 ? "−" + Math.abs(score) : "+" + score);
function parCard(app) {
  const snap = app.snap(), seats = snap.seats.filter(s => s.par && (s.par.past.length || s.par.now));
  if (!seats.length) return "";
  const nameOf = (s) => personaFor(s, snap.seats.findIndex(x => x.id === s.id)).name;
  const cols = Math.max(...seats.map(s => s.par.past.length));
  const ref = seats.find(s => s.par.past.length === cols);
  const day = (ts) => new Date(ts * 1000).toLocaleDateString([], { day: "numeric", month: "short" });
  const cell = (w) => `<td><span class="par ${PAR_TONE[String(w.score)] || "rest"}" title="${esc(`${w.name}: ${w.why}${w.five_hour_walls ? ` · hit the 5-hour wall ${w.five_hour_walls}×` : ""} · ended ${day(w.ends)}`)}">${parMark(w.score)}</span></td>`;
  const nowCell = (n) => !n ? "<td>–</td>" : `<td class="par-now"><b>${Math.round(n.peak || 0)}%</b><small>${n.benched ? "on holiday" : n.heading ? `heading for ${esc(n.heading.toLowerCase())}` : "too early to call"}</small></td>`;
  return `<div class="view-card"><div class="section-h"><h4>Par for the week</h4><span class="hint">each weekly plan, played like a round of golf</span></div>
    <div class="table-scroll"><table class="league par-card"><thead><tr><th>Seat</th>${Array.from({ length: cols }, (_, i) => `<th class="num">${ref ? esc(day(ref.par.past[i].ends)) : ""}</th>`).join("")}<th>This week</th><th class="num">Season</th></tr></thead>
    <tbody>${seats.map(s => { const pad = cols - s.par.past.length;
      return `<tr style="--seat:${esc(s.color)}"><td><span class="who"><i data-portrait="mascot-${esc(s.id)}|${esc(s.color)}|"></i>${esc(nameOf(s))}</span></td>${"<td></td>".repeat(pad)}${s.par.past.map(cell).join("")}${nowCell(s.par.now)}
        <td class="num"><b class="par-total ${s.par.season == null ? "" : s.par.season <= 0 ? "under" : "over"}">${s.par.season == null ? "–" : parMark(s.par.season)}</b></td></tr>`; }).join("")}</tbody></table></div>
    <p class="hint" style="margin-top:10px">Use most of a week's plan without running out: 60% is par, 90% a birdie, 97% an eagle. Running out of the week is a bogey (a double after 6 hours waiting), and so is leaving most of it unused. Hitting the 5-hour wall is noted, not scored; a seat on holiday rests.</p></div>`;
}

// The next seven days of plan (office/forecast.py): each seat's week as a bar: plan left, run dry at this week's pace
// (a projection), the weekly reset, and the fresh week after it; red bands where no seat on duty could take work.
function capacityCard(app) {
  const snap = app.snap(), c = snap.capacity;
  if (!c || !c.seats || !c.seats.length) return "";
  const t0 = c.now, span = c.horizon, x = (t) => Math.max(0, Math.min(100, (t - t0) / span * 100));
  const day = (t) => new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const nameOf = (id) => { const s = snap.seats.find(q => q.id === id); return s ? personaFor(s, snap.seats.findIndex(q => q.id === id)).name : id; };
  const colour = (id) => (snap.seats.find(q => q.id === id) || {}).color || "#888";
  const ticks = Array.from({ length: 8 }, (_, i) => { const d = new Date((t0 + i * 86400) * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; }).filter(t => t > t0 && t < t0 + span);
  const row = (k) => {
    const out = k.out_at, rs = k.resets_at;
    const segs = k.benched ? [[t0, t0 + span, "rest"]]
      : [[t0, out != null ? out : rs, "left"], ...(out != null ? [[out, rs, "dry"]] : []), [rs, t0 + span, "fresh"]];
    const words = k.benched ? "on holiday" : k.out_now ? `out of its week until ${day(rs)}` : out != null ? `runs dry about ${day(out)} at this pace, back ${day(rs)}` : `lasts the week, resets ${day(rs)}`;
    return `<div class="cap-row" style="--seat:${esc(colour(k.seat))}"><span class="cap-name">${esc(nameOf(k.seat))}</span>
      <svg class="cap-bar" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${esc(nameOf(k.seat))}: ${esc(words)}">${segs.filter(g => g[1] > g[0]).map(([a, b, cls]) => `<rect class="${cls}" x="${x(a).toFixed(2)}" y="1" width="${Math.max(0.3, x(b) - x(a)).toFixed(2)}" height="8" rx="1.2"/>`).join("")}
        ${rs < t0 + span ? `<rect class="reset" x="${(x(rs) - 0.25).toFixed(2)}" y="0" width="0.5" height="10"/>` : ""}${ticks.map(t => `<rect class="tick" x="${x(t).toFixed(2)}" y="0" width="0.12" height="10"/>`).join("")}</svg>
      <small>${esc(words)}</small></div>`;
  };
  const dry = (c.dry || []).map(([a, b]) => `${day(a)} to ${day(b)}`);
  return `<div class="view-card"><div class="section-h"><h4>The next 7 days</h4><span class="hint">each seat's weekly plan, at this week's pace</span></div>
    <div class="cap-days">${ticks.map(t => `<span style="left:${x(t).toFixed(2)}%">${esc(new Date(t * 1000).toLocaleDateString([], { weekday: "short" }))}</span>`).join("")}</div>
    ${c.seats.map(row).join("")}
    ${dry.length ? `<p class="cap-dry">${icon("alert", 15)}No seat on duty could take work ${esc(dry.join(", "))}.</p>` : ""}
    <p class="hint" style="margin-top:8px">Each bar is a seat's week, in its own colour while it has plan left; red where it is out of its week, until the white line, its weekly reset. The pace is the week's use so far drawn straight on, so it says where today's habits lead, not what will happen.</p></div>`;
}

// Hours lost to limits, the last 7 days: how long each seat sat out of plan, and how long no Claude seat could take work.
function limitsCard(app) {
  const days = (app.weekCache() || []).slice(-7), snap = app.snap();
  const per = {}; let allOut = 0;
  for (const d of days) { for (const [sid, m] of Object.entries(d.limited_min || {})) per[sid] = (per[sid] || 0) + m; allOut += d.all_out_min || 0; }
  const rows = Object.entries(per).filter(([, m]) => m >= 5).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return "";
  const hrs = (m) => (m >= 60 ? `${(m / 60).toFixed(m >= 600 ? 0 : 1)} h` : `${m} min`), max = Math.max(...rows.map(r => r[1]));
  const name = (sid) => { const s = snap.seats.find(x => x.id === sid); return s ? personaFor(s, snap.seats.indexOf(s)).name : sid; };
  const color = (sid) => (snap.seats.find(x => x.id === sid) || {}).color || "#82889f";
  return `<div class="view-card"><div class="section-h"><h4>Hours lost to limits</h4><span class="hint">the last 7 days</span></div>
    ${rows.map(([sid, m]) => `<div class="lim-row" style="--seat:${esc(color(sid))}"><span class="grow">${esc(name(sid))}</span><span class="tb-bar"><i style="width:${(m / max * 100).toFixed(1)}%"></i></span><b>${hrs(m)}</b></div>`).join("")}
    <p class="hint">${allOut >= 5 ? `For ${hrs(allOut)} no Claude seat could take work at all: lanes waited.` : "There was always a Claude seat free to take work."} The divider moves new lanes to seats with plan left; a seat that runs dry often may need a bigger plan.</p></div>`;
}

function weekCard(app, shown) {
  const days = app.weekCache();
  if (!days) return `<div class="view-card"><div class="skeleton" style="width:40%"></div><div class="skeleton"></div></div>`;
  if (!days.length) return "";
  const key = app.weekMetric(), [label, get, fmt] = WEEK_METRICS[key] || WEEK_METRICS.reports;
  const last = days.slice(-7), before = days.slice(-14, -7);
  const sum = (xs) => xs.reduce((a, d) => a + get(d), 0), now = sum(last), prev = sum(before);
  const delta = before.length === 7 && prev > 0 ? Math.round((now - prev) / prev * 100) : null;
  const max = Math.max(1e-9, ...last.map(get)), H = 120, W = 7 * 64, T = 22;   // T: room above the tallest bar for its label
  // Days before the office existed have no record: hatched, not drawn as zero.
  const born = Math.min(...app.snap().seats.map(s => (s.career || {}).since).filter(Boolean)), bornDay = Number.isFinite(born) ? localDay(new Date(born * 1000)) : null;
  const noRecord = (d) => bornDay && d.day < bornDay && !d.sessions && !d.reports && !d.tool_calls;
  const wd = (d) => new Date(d + "T12:00:00").toLocaleDateString([], { weekday: "short" });
  const bars = last.map((d, i) => {
    const v = get(d), h = v > 0 ? Math.max(3, Math.round(v / max * H)) : 0, x = i * 64 + 14, on = d.day === shown, B = H + T;
    if (noRecord(d)) return `<g class="wk-bar norec"><rect class="hatch" x="${x}" y="${B - H}" width="36" height="${H}" rx="4" fill="url(#wkHatch)"/>
      <text class="ax" x="${x + 18}" y="${B + 18}" text-anchor="middle">${wd(d.day)}</text><title>No record: the office opened ${esc(new Date(born * 1000).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" }))}</title></g>`;
    const tip = `${new Date(d.day + "T12:00:00").toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" })} · ${d.reports} report${d.reports === 1 ? "" : "s"} · ${WEEK_METRICS.hours[2](d.active_min / 60)} · ${d.tool_calls.toLocaleString()} tool calls · ${d.sessions} session${d.sessions === 1 ? "" : "s"}`;
    return `<g class="wk-bar ${on ? "on" : ""}" data-week-day="${d.day}" tabindex="0" role="button" aria-label="${tip}">
      <rect class="hit" x="${x - 8}" y="0" width="52" height="${B + 26}" fill="transparent"/>
      ${h ? `<path class="val" d="M${x} ${B} V${B - h + 4} q0 -4 4 -4 h28 q4 0 4 4 V${B} Z"/>` : `<rect class="zero" x="${x}" y="${B - 2}" width="36" height="2" rx="1"/>`}
      ${(on || v === max) && v > 0 ? `<text class="lbl" x="${x + 18}" y="${B - h - 6}" text-anchor="middle">${fmt(v)}</text>` : ""}
      <text class="ax" x="${x + 18}" y="${B + 18}" text-anchor="middle">${wd(d.day)}</text><title>${tip}</title></g>`;
  }).join("");
  const empty = last.every(d => !d.sessions && !d.reports && !d.tool_calls);
  return `<div class="view-card week"><div class="section-h"><h4>Last 7 days</h4><button class="btn sm ghost" data-week-play title="Your week in review: a short story of the last seven days">${icon("play", 13)}Play the week</button><span class="grow"></span>
      <div class="seg-ctl" role="group" aria-label="Measure">${Object.entries(WEEK_METRICS).map(([k, [l]]) => `<button data-week-metric="${k}" class="${k === key ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="wk-head"><b>${fmt(now)}</b><span>${label.toLowerCase()} in the last 7 days</span>${delta == null ? "" : `<em class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)}% vs the week before</em>`}</div>
    <div class="wk-body"><svg class="wk" viewBox="0 0 ${W} ${H + T + 26}" role="img" aria-label="${label} per day for the last seven days"><defs><pattern id="wkHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-line" width="2" height="6"/></pattern></defs><line class="base" x1="0" x2="${W}" y1="${H + T}" y2="${H + T}"/>${bars}</svg>
      ${weekFacts(app, last)}</div>
    <div class="hint">${empty ? "Nothing on record yet: the bars fill in as your agents work. " : ""}${last.some(noRecord) ? "Hatched days came before the office opened. " : ""}Click a day to open it. Earlier days come from the office's day ledger.</div></div>`;
}
// Beside the chart: the best day, the star of the week (most days as employee of the day) and the week's totals.
function weekFacts(app, last) {
  const snap = app.snap(), best = [...last].sort((a, b) => b.reports - a.reports || b.active_min - a.active_min)[0];
  const stars = {}; for (const d of last) if (d.mvp) stars[d.mvp] = (stars[d.mvp] || 0) + 1;
  const most = Math.max(0, ...Object.values(stars));                 // a tie shares the title
  const tied = Object.keys(stars).filter(id => stars[id] === most).map(id => snap.seats.find(s => s.id === id)).filter(Boolean);
  const top = most ? [null, most] : null, seat = tied[0];
  const hrs = last.reduce((a, d) => a + d.active_min, 0) / 60, calls = last.reduce((a, d) => a + d.tool_calls, 0), active = last.filter(d => d.sessions).length;
  const row = (ic, k, v) => `<div class="wf"><span class="wf-ic">${icon(ic, 16)}</span><span class="wf-k">${k}</span><b>${v}</b></div>`;
  return `<div class="wk-facts">
    ${best && best.reports ? row("trophy", "Best day", `${esc(new Date(best.day + "T12:00:00").toLocaleDateString([], { weekday: "long" }))} · ${best.reports} report${best.reports === 1 ? "" : "s"}`) : ""}
    ${seat ? row("star", tied.length > 1 ? "Stars of the week" : "Star of the week", `${tied.slice(0, 3).map(s => `<span class="wf-who" style="--seat:${esc(s.color)}"><i></i>${esc(personaFor(s, snap.seats.findIndex(x => x.id === s.id)).name)}</span>`).join(" and ")} · ${top[1]} day${top[1] === 1 ? "" : "s"} on top`) : ""}
    ${row("clock", "Agent hours", hrs >= 10 ? Math.round(hrs) + " h" : hrs.toFixed(1) + " h")}
    ${row("tool", "Tool calls", calls.toLocaleString())}
    ${row("calendar", "Days with work", `${active} of 7`)}</div>`;
}
// The view re-renders whole, so a bar or measure button used from the keyboard is focused again once it is back.
let refocus = null;
function bindWeek(el, app) {
  const play = el.querySelector("[data-week-play]"); if (play) play.addEventListener("click", () => app.playWeek());
  el.querySelectorAll("[data-week-metric]").forEach(b => b.addEventListener("click", () => { refocus = `[data-week-metric="${b.dataset.weekMetric}"]`; app.setPref("weekMetric", b.dataset.weekMetric); renderStats(el, app); }));
  el.querySelectorAll("[data-week-day]").forEach(g => {
    const open = () => { const d = g.dataset.weekDay, day = d === app.weekCache().slice(-1)[0].day ? null : d; refocus = `[data-week-day="${d}"]`; app.setPref("statsDay", day); app.loadStats(day, true); };
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

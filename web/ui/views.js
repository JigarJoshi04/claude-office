// The big views beside the floor: Timeline, Team and Today.
import { esc, fmtTok, live, hydratePortraits, avatar, dayTime, STATE_LABEL, clock } from "./util.js";
import { timeline, bindTips } from "./charts.js";
import { icon } from "./icons.js";
import { personaFor, leftOf, voice, diary } from "./personas.js";
import { localDay } from "./goals.js";

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
      <div class="who" data-seat="${esc(s.id)}">${avatar("mascot-" + s.id, s.color, (s.status === "offline" ? "dim," : "") + "lv" + (s.career ? s.career.level : 0))}
        <div><h3>${esc(p.name)}</h3><div class="role">${esc(p.role)} · ${esc(s.label)}</div></div>
        <span class="pill ${vo.tone}">${esc(vo.word)}</span></div>
      <div class="moodline">“${esc(vo.line)}”</div>
      ${s.career ? `<div class="tlevel"><span class="lvchip">Lv ${s.career.level}</span><span>${esc(s.career.title)}</span><div class="xpbar"><i style="width:${Math.round(s.career.progress * 100)}%"></i></div><span class="tro">${icon("trophy", 13)}${Object.keys(s.career.unlocked).length}</span></div>` : ""}
      ${meter("five_hour", "5-hour window")}${meter("weekly", "This week")}
      <div style="margin-top:14px">${L.length ? L.map(x => `<div class="sess" data-seat="${esc(s.id)}" data-id="${esc(x.id)}">${avatar(x.id, s.color, x.kind === "desk" ? "headset" : "")}
        <span class="nm"><span class="sdot ${x.state}"></span>${esc(x.name)}</span><span class="pill">${esc(STATE_LABEL[x.state] || x.state)}</span>
        <span class="ac">${app.privacy() && x.kind === "desk" ? "<span class='private'>hidden</span>" : esc(x.activity || "")}</span></div>`).join("") : `<div class="muted" style="font-size:14px">Nobody at the desk.</div>`}</div>
    </div>`;
  }).join("")}</div>`;
  hydratePortraits(el, 4);
  el.querySelectorAll(".sess").forEach(r => r.addEventListener("click", () => app.go({ kind: "session", seat: r.dataset.seat, id: r.dataset.id })));
  el.querySelectorAll(".who[data-seat]").forEach(r => r.addEventListener("click", () => app.go({ kind: "seat", seat: r.dataset.seat })));
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
  const shift = (n) => { const d = new Date((st.day || localDay()) + "T12:00:00"); d.setDate(d.getDate() + n); return localDay(d); };
  const now = new Date(), todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const human = (t) => { let x = String(t); for (const s of snap.seats) { const n = nameOf(s.id); if (n !== s.label) x = x.replace(new RegExp(`\\b${s.label}\\b`, "g"), n); } return x; };
  const hours = Math.round(rows.reduce((a, r) => a + r.active_min, 0) / 6) / 10;
  // Trophies won on this day, from each seat's career.
  const d0 = new Date((st.day || todayStr) + "T00:00:00").getTime() / 1000;
  const cat = Object.fromEntries((snap.achievements || []).map(a => [a.id, a]));
  const won = snap.seats.flatMap(s => Object.entries((s.career || {}).unlocked || {}).filter(([id, at]) => cat[id] && at >= d0 && at < d0 + 86400)
    .map(([id, at]) => ({ s, a: cat[id], at }))).sort((a, b) => a.at - b.at);
  el.innerHTML = `<div class="stats-grid">
    <div class="view-head"><div class="grow"><h3>${st.day === todayStr ? "Today" : esc(st.day)}</h3><p>Who did what, from the office's own records.</p></div>
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
  el.querySelectorAll("[data-trophies]").forEach(b => b.addEventListener("click", () => app.go({ kind: "trophies" })));
  el.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => { app.setPref("statsDay", b.dataset.day || null); app.loadStats(b.dataset.day || null, true); }));
}

// ------------------------------------------------------------------------------------------------ week chart
// The last seven days as bars, one measure at a time (no second axis): reports, agent hours or tool calls. The day on
// show is highlighted; hovering a bar shows that day's numbers; the header compares with the seven days before.
const WEEK_METRICS = { reports: ["Reports", (d) => d.reports, (v) => String(v)], hours: ["Agent hours", (d) => d.active_min / 60, (v) => v >= 10 ? Math.round(v) + " h" : v.toFixed(1) + " h"],
  calls: ["Tool calls", (d) => d.tool_calls, (v) => v >= 10000 ? Math.round(v / 1000) + "k" : v.toLocaleString()] };
function weekCard(app, shown) {
  const days = app.weekCache();
  if (!days) return `<div class="view-card"><div class="skeleton" style="width:40%"></div><div class="skeleton"></div></div>`;
  if (!days.length) return "";
  const key = app.weekMetric(), [label, get, fmt] = WEEK_METRICS[key] || WEEK_METRICS.reports;
  const last = days.slice(-7), before = days.slice(-14, -7);
  const sum = (xs) => xs.reduce((a, d) => a + get(d), 0), now = sum(last), prev = sum(before);
  const delta = before.length === 7 && prev > 0 ? Math.round((now - prev) / prev * 100) : null;
  const max = Math.max(1e-9, ...last.map(get)), H = 120, W = 7 * 64, T = 22;   // T: room above the tallest bar for its label
  const wd = (d) => new Date(d + "T12:00:00").toLocaleDateString([], { weekday: "short" });
  const bars = last.map((d, i) => {
    const v = get(d), h = v > 0 ? Math.max(3, Math.round(v / max * H)) : 0, x = i * 64 + 14, on = d.day === shown, B = H + T;
    const tip = `${new Date(d.day + "T12:00:00").toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" })} · ${d.reports} report${d.reports === 1 ? "" : "s"} · ${WEEK_METRICS.hours[2](d.active_min / 60)} · ${d.tool_calls.toLocaleString()} tool calls · ${d.sessions} sessions`;
    return `<g class="wk-bar ${on ? "on" : ""}" data-week-day="${d.day}" tabindex="0" role="button" aria-label="${tip}">
      <rect class="hit" x="${x - 8}" y="0" width="52" height="${B + 26}" fill="transparent"/>
      ${h ? `<path class="val" d="M${x} ${B} V${B - h + 4} q0 -4 4 -4 h28 q4 0 4 4 V${B} Z"/>` : `<rect class="zero" x="${x}" y="${B - 2}" width="36" height="2" rx="1"/>`}
      ${(on || v === max) && v > 0 ? `<text class="lbl" x="${x + 18}" y="${B - h - 6}" text-anchor="middle">${fmt(v)}</text>` : ""}
      <text class="ax" x="${x + 18}" y="${B + 18}" text-anchor="middle">${wd(d.day)}</text><title>${tip}</title></g>`;
  }).join("");
  return `<div class="view-card week"><div class="section-h"><h4>This week</h4>
      <div class="seg-ctl" role="group" aria-label="Measure">${Object.entries(WEEK_METRICS).map(([k, [l]]) => `<button data-week-metric="${k}" class="${k === key ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="wk-head"><b>${fmt(now)}</b><span>${label.toLowerCase()} in the last 7 days</span>${delta == null ? "" : `<em class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)}% vs the week before</em>`}</div>
    <div class="wk-body"><svg class="wk" viewBox="0 0 ${W} ${H + T + 26}" role="img" aria-label="${label} per day for the last seven days"><line class="base" x1="0" x2="${W}" y1="${H + T}" y2="${H + T}"/>${bars}</svg>
      ${weekFacts(app, last)}</div>
    <div class="hint">Click a day to open it. Earlier days come from the office's day ledger.</div></div>`;
}
// Beside the chart: the best day, the star of the week (most days as employee of the day) and the week's totals.
function weekFacts(app, last) {
  const snap = app.snap(), best = [...last].sort((a, b) => b.reports - a.reports || b.active_min - a.active_min)[0];
  const stars = {}; for (const d of last) if (d.mvp) stars[d.mvp] = (stars[d.mvp] || 0) + 1;
  const top = Object.entries(stars).sort((a, b) => b[1] - a[1])[0], seat = top && snap.seats.find(s => s.id === top[0]);
  const hrs = last.reduce((a, d) => a + d.active_min, 0) / 60, calls = last.reduce((a, d) => a + d.tool_calls, 0), active = last.filter(d => d.sessions).length;
  const row = (ic, k, v) => `<div class="wf"><span class="wf-ic">${icon(ic, 16)}</span><span class="wf-k">${k}</span><b>${v}</b></div>`;
  return `<div class="wk-facts">
    ${best && best.reports ? row("trophy", "Best day", `${esc(new Date(best.day + "T12:00:00").toLocaleDateString([], { weekday: "long" }))} · ${best.reports} report${best.reports === 1 ? "" : "s"}`) : ""}
    ${seat ? row("star", "Star of the week", `<span class="wf-who" style="--seat:${esc(seat.color)}"><i></i>${esc(personaFor(seat, snap.seats.findIndex(x => x.id === seat.id)).name)}</span> · ${top[1]} day${top[1] === 1 ? "" : "s"} on top`) : ""}
    ${row("clock", "Agent hours", hrs >= 10 ? Math.round(hrs) + " h" : hrs.toFixed(1) + " h")}
    ${row("tool", "Tool calls", calls.toLocaleString())}
    ${row("calendar", "Days with work", `${active} of 7`)}</div>`;
}
function bindWeek(el, app) {
  el.querySelectorAll("[data-week-metric]").forEach(b => b.addEventListener("click", () => { app.setPref("weekMetric", b.dataset.weekMetric); renderStats(el, app); }));
  el.querySelectorAll("[data-week-day]").forEach(g => {
    const open = () => { const d = g.dataset.weekDay, day = d === app.weekCache().slice(-1)[0].day ? null : d; app.setPref("statsDay", day); app.loadStats(day, true); };
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

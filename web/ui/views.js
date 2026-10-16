// The big views next to the floor: Timeline, Board and Today.
import { esc, fmtTok, until, pct, live, portraitTag, hydratePortraits, SEAT_LABEL, KIND_ICON, STATE_LABEL, clock } from "./util.js";
import { timeline, bindTips } from "./charts.js";

export function renderTimeline(el, app) {
  const hours = app.prefs().tlHours || 6;
  const hist = app.historyCache(hours);
  const width = Math.max(600, el.clientWidth - 30);
  el.innerHTML = `<div class="tl">
    <div class="tl-head"><h3>≋ Timeline</h3><span class="muted" style="font-size:12.5px">every session on every seat, with plan resets ahead</span>
      <span style="flex:1"></span>
      <div class="seg-ctl">${[1, 3, 6, 12, 24].map(h => `<button data-h="${h}" class="${h === hours ? "on" : ""}">${h}h</button>`).join("")}</div></div>
    ${hist ? (hist.unavailable ? `<div class="muted" style="padding:20px">The timeline needs the history store on the server (restart the office after updating).</div>` : timeline(hist, app.snap(), width, hours))
      : `<div class="muted" style="padding:20px">Loading the last ${hours} hours…</div>`}
    <div class="tl-legend"><span><i class="lg working"></i>Working</span><span><i class="lg waiting"></i>Waiting on a tool</span><span><i class="lg idle"></i>Idle</span><span><i class="lg limited"></i>Out of plan</span><span><i class="lg stuck"></i>Quiet</span>
      <span>◆ news on that seat</span><span style="color:var(--info)">┆ 5-hour reset</span><span style="color:var(--bad)">✕ runs out at this pace</span><span>✓ reported</span></div>
  </div>`;
  el.querySelectorAll("[data-h]").forEach(b => b.addEventListener("click", () => { app.setPref("tlHours", +b.dataset.h); app.loadHistory(+b.dataset.h, true); }));
  bindTips(el);
  el.querySelectorAll(".seg").forEach(r => r.addEventListener("click", () => {
    if (r.dataset.live === "1") app.go({ kind: "session", seat: r.dataset.seat, id: r.dataset.sid });
    else app.go({ kind: "seat", seat: r.dataset.seat });
  }));
}

export function renderBoard(el, app) {
  const snap = app.snap();
  el.innerHTML = `<div class="board">${snap.seats.map(s => {
    const u = s.usage || {}, L = live(s);
    const row = (label, p, r) => `<div class="hpr" style="--seat:${s.color};grid-template-columns:22px 1fr 82px"><span>${label}</span><span class="hpbar ${p != null && p >= 90 ? "low" : p != null && p >= 75 ? "mid" : ""}"><i style="width:${p == null ? 0 : 100 - p}%"></i></span><b>${p == null ? "–" : Math.round(100 - p) + "% left"}</b></div>${r ? `<div class="hint" style="margin:-1px 0 4px 27px">reset in ${until(r)}</div>` : ""}`;
    return `<div class="card" style="--seat:${s.color}">
      <div class="row between"><h3>${portraitTag("mascot-" + s.id, s.color, s.status === "offline" ? "dim" : "")}${esc(s.nickname || s.label)}</h3><span class="chip"><span class="st-dot ${s.status}"></span>${esc(SEAT_LABEL[s.status] || s.status)}</span></div>
      <div style="margin-top:10px;display:grid;gap:4px">${row("5h", pct(u, "five_hour"), u.five_hour && u.five_hour.resets_at)}${row("wk", pct(u, "weekly"), null)}</div>
      <div style="margin-top:8px">${L.length ? L.map(x => `<div class="sess" data-seat="${esc(s.id)}" data-id="${esc(x.id)}">${portraitTag(x.id, s.color, x.kind === "desk" ? "headset" : "")}
        <span class="nm"><span class="st-dot ${x.state}"></span>${esc(x.name)}</span><span class="chip">${esc(STATE_LABEL[x.state] || x.state)}</span>
        <span class="act">${KIND_ICON[x.activity_kind] || ""} ${app.privacy() && x.kind === "desk" ? "<span class='private'>hidden</span>" : esc(x.activity || "")}</span></div>`).join("") : `<div class="muted" style="padding:8px">Nobody at this desk.</div>`}</div>
    </div>`;
  }).join("")}</div>`;
  hydratePortraits(el, 3);
  el.querySelectorAll(".sess").forEach(r => r.addEventListener("click", () => app.go({ kind: "session", seat: r.dataset.seat, id: r.dataset.id })));
}

export function renderStats(el, app) {
  const day = app.prefs().statsDay || null;
  const st = app.statsCache(day);
  const snap = app.snap();
  const seatOf = (id) => snap.seats.find(s => s.id === id);
  if (!st) { el.innerHTML = `<div class="tl"><div class="muted" style="padding:20px">Loading today's numbers…</div></div>`; return; }
  if (st.unavailable) { el.innerHTML = `<div class="tl"><div class="muted" style="padding:20px">Daily stats need the history store on the server (restart the office after updating).</div></div>`; return; }
  const rows = Object.entries(st.seats || {}).map(([id, v]) => ({ id, ...v, seat: seatOf(id) })).filter(r => r.seat).sort((a, b) => b.active_min - a.active_min || b.reports - a.reports);
  const maxMin = Math.max(1, ...rows.map(r => r.active_min));
  const mvpSeat = st.mvp && seatOf(st.mvp.seat);
  const o = st.office || {};
  const shift = (n) => { const d = new Date((st.day || new Date().toISOString().slice(0, 10)) + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const today = new Date(); const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  el.innerHTML = `<div class="stats">
    <div class="tl-head"><h3>★ ${st.day === todayStr ? "Today" : esc(st.day)}</h3><span class="muted" style="font-size:12.5px">who did what, from the office's own records</span><span style="flex:1"></span>
      <button class="btn small" data-day="${shift(-1)}">‹ Day before</button>${st.day !== todayStr ? `<button class="btn small" data-day="${shift(1)}">Next day ›</button><button class="btn small" data-day="">Today</button>` : ""}</div>
    <div class="top">
      ${mvpSeat ? `<div class="mvp" style="--seat:${mvpSeat.color}">${portraitTag("mascot-" + mvpSeat.id, mvpSeat.color, "crown")}<div>
        <div class="crown">★ EMPLOYEE OF THE DAY</div><h3>${esc(mvpSeat.nickname || mvpSeat.label)}</h3><div class="muted">${esc(st.mvp.why)}</div></div></div>`
        : `<div class="mvp"><div style="font-size:40px;text-align:center">🏆</div><div><div class="crown">EMPLOYEE OF THE DAY</div><h3>Nobody yet</h3><div class="muted">The crown goes to the seat with the most reports.</div></div></div>`}
      <div class="tiles" style="grid-template-columns:repeat(3,1fr)">
        <div class="tile"><div class="v">${o.sessions ?? 0}</div><div class="k">sessions</div></div>
        <div class="tile"><div class="v">${o.reports ?? 0}</div><div class="k">reports filed</div></div>
        <div class="tile"><div class="v">${o.limits ?? 0}</div><div class="k">limits hit</div></div>
        <div class="tile"><div class="v">${fmtTok(rows.reduce((a, r) => a + (r.tokens_fresh || 0), 0))}</div><div class="k">fresh tokens</div></div>
        <div class="tile"><div class="v">${Math.round(rows.reduce((a, r) => a + r.active_min, 0) / 6) / 10}<small>h</small></div><div class="k">seat-hours of work</div></div>
        <div class="tile"><div class="v">${o.lanes_hired ?? 0}</div><div class="k">lanes hired here</div></div>
      </div>
    </div>
    <div class="tl"><h3 style="margin:0 0 8px;font-size:15px">League</h3>
      <table class="league"><thead><tr><th>Seat</th><th style="width:34%">Active time</th><th class="num">Active</th><th class="num">Sessions</th><th class="num">Reports</th><th class="num">Limits</th><th class="num">Tool calls</th><th class="num">Fresh tokens</th><th class="num">Peak 5h</th></tr></thead>
      <tbody>${rows.map(r => `<tr style="--seat:${r.seat.color}"><td><span class="who">${portraitTag("mascot-" + r.id, r.seat.color, st.mvp && st.mvp.seat === r.id ? "crown" : "")}${esc(r.seat.nickname || r.seat.label)}</span></td>
        <td><div class="bar" style="width:${(r.active_min / maxMin * 100).toFixed(1)}%"></div></td>
        <td class="num">${Math.floor(r.active_min / 60)}h ${String(r.active_min % 60).padStart(2, "0")}m</td><td class="num">${r.sessions}</td><td class="num">${r.reports}</td><td class="num">${r.limits}</td>
        <td class="num">${fmtTok(r.tool_calls)}</td><td class="num">${fmtTok(r.tokens_fresh)}</td><td class="num">${r.peak_p5 == null ? "–" : Math.round(r.peak_p5) + "%"}</td></tr>`).join("")}</tbody></table>
      ${o.longest_session ? `<div class="hint" style="margin-top:8px">Longest session: <b>${esc(o.longest_session.name)}</b> on ${esc(o.longest_session.seat)}, ${Math.floor(o.longest_session.minutes / 60)}h ${o.longest_session.minutes % 60}m.${o.first_activity ? ` First activity ${clock(o.first_activity)}, last ${clock(o.last_activity)}.` : ""}</div>` : ""}
    </div>
    ${(st.digest || []).length ? `<div class="tl"><h3 style="margin:0 0 8px;font-size:15px">The day in a few lines</h3><ul class="digest">${st.digest.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
  </div>`;
  hydratePortraits(el, 3);
  el.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => { app.setPref("statsDay", b.dataset.day || null); app.loadStats(b.dataset.day || null, true); }));
}

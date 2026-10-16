// The big views beside the floor: Timeline, Team and Today.
import { esc, fmtTok, live, hydratePortraits, avatar, dayTime, STATE_LABEL, clock } from "./util.js";
import { timeline, bindTips } from "./charts.js";
import { icon } from "./icons.js";
import { personaFor, moodFor, leftOf } from "./personas.js";

export function renderTimeline(el, app) {
  const hours = app.prefs().tlHours || 6;
  const hist = app.historyCache(hours);
  const width = Math.max(600, el.clientWidth - 40);
  el.innerHTML = `<div class="view-card">
    <div class="view-head"><div class="grow"><h3>Timeline</h3><p>Every session on every seat, with plan resets coming up on the right.</p></div>
      <div class="seg-ctl">${[1, 3, 6, 12, 24].map(h => `<button data-h="${h}" class="${h === hours ? "on" : ""}">${h} h</button>`).join("")}</div></div>
    ${hist ? (hist.unavailable ? `<div class="muted" style="padding:20px">The timeline needs the history store on the server. Restart the office after updating.</div>` : timeline(hist, app.snap(), width, hours, (s) => personaFor(s, app.snap().seats.indexOf(s)).name))
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
    const p = personaFor(s, i), m = moodFor(s, dayTime), L = live(s);
    const meter = (key, label) => {
      const left = leftOf(s, key), w = (s.usage || {})[key];
      return `<div style="margin-top:10px"><div class="row between" style="font-size:13px"><span class="muted">${label}</span><b>${left == null ? "–" : Math.round(left) + "% left"}</b></div>
        <div class="minibar ${left != null && left < 15 ? "low" : left != null && left < 35 ? "mid" : ""}" style="--seat:${s.color}"><i style="width:${left ?? 0}%"></i></div>
        ${w && w.resets_at ? `<div class="hint" style="margin-top:4px">resets ${dayTime(w.resets_at)}</div>` : ""}</div>`;
    };
    return `<div class="tcard" style="--seat:${s.color}">
      <div class="who" data-seat="${esc(s.id)}">${avatar("mascot-" + s.id, s.color, s.status === "offline" ? "dim" : "")}
        <div><h3>${esc(p.name)}</h3><div class="role">${esc(p.role)} · ${esc(s.label)}</div></div>
        <span class="pill ${m.tone}">${esc(m.mood)}</span></div>
      <div class="moodline">“${esc(p.motto)}”</div>
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
  const nameOf = (id) => { const s = seatOf(id); return s ? personaFor(s, snap.seats.indexOf(s)).name : id; };
  if (!st) { el.innerHTML = `<div class="view-card"><div class="skeleton"></div><div class="skeleton" style="width:70%"></div></div>`; return; }
  if (st.unavailable) { el.innerHTML = `<div class="view-card"><div class="muted">Daily stats need the history store on the server. Restart the office after updating.</div></div>`; return; }
  const rows = Object.entries(st.seats || {}).map(([id, v]) => ({ id, ...v, seat: seatOf(id) })).filter(r => r.seat).sort((a, b) => b.active_min - a.active_min || b.reports - a.reports);
  const maxMin = Math.max(1, ...rows.map(r => r.active_min));
  const mvpSeat = st.mvp && seatOf(st.mvp.seat);
  const o = st.office || {};
  const shift = (n) => { const d = new Date((st.day || new Date().toISOString().slice(0, 10)) + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const now = new Date(), todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const human = (t) => { let x = String(t); for (const s of snap.seats) { const n = nameOf(s.id); if (n !== s.label) x = x.replace(new RegExp(`\\b${s.label}\\b`, "g"), n); } return x; };
  const hours = Math.round(rows.reduce((a, r) => a + r.active_min, 0) / 6) / 10;
  el.innerHTML = `<div class="stats-grid">
    <div class="view-head"><div class="grow"><h3>${st.day === todayStr ? "Today" : esc(st.day)}</h3><p>Who did what, from the office's own records.</p></div>
      <button class="btn sm" data-day="${shift(-1)}">${icon("chevronRight", 14, "flip")}Day before</button>${st.day !== todayStr ? `<button class="btn sm" data-day="${shift(1)}">Next day</button><button class="btn sm" data-day="">Today</button>` : ""}</div>
    <div class="stats-top">
      ${mvpSeat ? `<div class="mvp">${avatar("mascot-" + mvpSeat.id, mvpSeat.color, "crown")}<div><div class="eyebrow">Employee of the day</div><h3>${esc(nameOf(mvpSeat.id))}</h3><div class="muted">${esc(st.mvp.why)}</div></div></div>`
        : `<div class="mvp"><span class="av">${icon("trophy", 40)}</span><div><div class="eyebrow">Employee of the day</div><h3>Nobody yet</h3><div class="muted">The crown goes to the seat with the most reports.</div></div></div>`}
      <div class="tiles">
        <div class="tile"><div class="v">${o.sessions ?? 0}</div><div class="tk">sessions</div></div>
        <div class="tile"><div class="v">${o.reports ?? 0}</div><div class="tk">reports filed</div></div>
        <div class="tile"><div class="v">${o.limits ?? 0}</div><div class="tk">limits hit</div></div>
        <div class="tile"><div class="v">${fmtTok(rows.reduce((a, r) => a + (r.tokens_fresh || 0), 0))}</div><div class="tk">fresh tokens</div></div>
        <div class="tile"><div class="v">${hours}</div><div class="tk">hours of agent work</div></div>
        <div class="tile"><div class="v">${o.lanes_hired ?? 0}</div><div class="tk">lanes hired here</div></div>
      </div>
    </div>
    ${(st.digest || []).length ? `<div class="view-card"><div class="section-h"><h4>The day in a few lines</h4></div><ul class="digest">${st.digest.map(x => `<li>${esc(human(x))}</li>`).join("")}</ul></div>` : ""}
    <div class="view-card"><div class="section-h"><h4>League</h4></div>
      <table class="league"><thead><tr><th>Seat</th><th style="width:30%">Time at work</th><th class="num">Active</th><th class="num">Sessions</th><th class="num">Reports</th><th class="num">Limits</th><th class="num">Tool calls</th><th class="num">Fresh tokens</th><th class="num">Peak 5 h</th></tr></thead>
      <tbody>${rows.map(r => `<tr style="--seat:${r.seat.color}"><td><span class="who"><i data-portrait="mascot-${esc(r.id)}|${esc(r.seat.color)}|${st.mvp && st.mvp.seat === r.id ? "crown" : ""}"></i>${esc(nameOf(r.id))}</span></td>
        <td><div class="bar" style="width:${(r.active_min / maxMin * 100).toFixed(1)}%"></div></td>
        <td class="num">${Math.floor(r.active_min / 60)} h ${String(r.active_min % 60).padStart(2, "0")}</td><td class="num">${r.sessions}</td><td class="num">${r.reports}</td><td class="num">${r.limits}</td>
        <td class="num">${fmtTok(r.tool_calls)}</td><td class="num">${fmtTok(r.tokens_fresh)}</td><td class="num">${r.peak_p5 == null ? "–" : Math.round(r.peak_p5) + "%"}</td></tr>`).join("")}</tbody></table>
      ${o.longest_session ? `<div class="hint" style="margin-top:12px">Longest session: <b>${esc(o.longest_session.name)}</b> on ${esc(nameOf(o.longest_session.seat))}, ${Math.floor(o.longest_session.minutes / 60)} h ${Math.round(o.longest_session.minutes % 60)} min.${o.first_activity ? ` First activity ${clock(o.first_activity)}, last ${clock(o.last_activity)}.` : ""}</div>` : ""}
    </div>
  </div>`;
  hydratePortraits(el, 4);
  el.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => { app.setPref("statsDay", b.dataset.day || null); app.loadStats(b.dataset.day || null, true); }));
}

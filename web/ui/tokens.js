// All-time tokens, in the Today view: the office's total since its transcripts begin, who burns the most (characters,
// sessions, projects), the models, and the last 60 days. One measure at a time: everything the model processed, fresh
// tokens (input, cache writes and output) or output alone. Data from /api/tokens (office/tokens.py).
import { esc, fmtTok, relTime, hydratePortraits, portrait } from "./util.js";
import { icon } from "./icons.js";
import { personaFor } from "./personas.js";

export const TOKEN_METRICS = {
  all: ["All tokens", "everything the models processed, cache reads included"],
  fresh: ["Fresh", "input, cache writes and output: what was new to the model"],
  output: ["Output", "what the models wrote"],
};
const big = (n) => (n >= 1e9 ? (n / 1e9).toFixed(n >= 1e11 ? 0 : 1) + " B" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + " M" : fmtTok(n));
export const modelName = (m) => {
  if (!m) return "?";
  if (m === "codex") return "Codex";
  const x = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(m);
  return x ? `${x[1][0].toUpperCase() + x[1].slice(1)} ${x[2]}${x[3] && x[3].length < 3 ? "." + x[3] : ""}` : m;
};

// The Burner Belt: last week's (the last complete Monday-to-Sunday week's) top seat, and this week's leader so far.
export function beltHolders(weeks) {
  const top = (w) => (w && Object.keys(w.seats || {})[0]) || null;
  return { holder: top(weeks && weeks[weeks.length - 2]), week: weeks && weeks.length > 1 ? weeks[weeks.length - 2].week : null, leader: top(weeks && weeks[weeks.length - 1]) };
}

// The Lean ribbon: last week's fewest tokens per commit, among seats with at least three commits.
export function leanHolder(weeks) {
  const w = weeks && weeks[weeks.length - 2];
  if (!w || !w.commits) return null;
  const rows = Object.entries(w.commits).filter(([, n]) => n >= 3).map(([k, n]) => [k, (w.seats[k] || 0) / n]).filter(([, r]) => r > 0);
  rows.sort((a, b) => a[1] - b[1]);
  return rows.length >= 2 ? { seat: rows[0][0], perCommit: rows[0][1] } : null;   // a ribbon needs someone to beat
}

// The seat with the most tokens of all time (for the flame on the floor and the character page), or null.
export function topBurner(t) {
  const s = t && t.seats && t.seats.find(x => x.seat);
  return s && s.all > 0 ? s.seat : null;
}

export function tokensCard(app) {
  const t = app.tokensCache();
  if (!t) return `<div class="view-card tok" id="tokens"><div class="section-h"><h4>All-time tokens</h4></div><div class="skeleton" style="width:40%"></div><div class="skeleton"></div></div>`;
  if (t.scanning && !t.total.all) return `<div class="view-card tok" id="tokens"><div class="section-h"><h4>All-time tokens</h4></div>
    <div class="muted">Reading the transcripts on this machine for the first time. This takes a few seconds.</div></div>`;
  const key = app.tokenMetric(), [label] = TOKEN_METRICS[key] || TOKEN_METRICS.all;
  const val = (r) => r[key] || 0, snap = app.snap(), priv = app.privacy();
  const todayOf = (r) => (r.today_by ? val(r.today_by) : key === "all" ? r.today || 0 : 0);   // today, in the measure shown
  const seatOf = (id) => snap.seats.find(s => s.id === id);
  const who = (id) => { const s = seatOf(id); return s ? personaFor(s, snap.seats.findIndex(x => x.id === id)).name : "Unknown seat"; };
  const since = t.since ? new Date(t.since + "T12:00:00").toLocaleDateString([], { day: "numeric", month: "short", year: t.since.slice(0, 4) === String(new Date().getFullYear()) ? undefined : "numeric" }) : null;
  const total = val(t.total), seats = [...t.seats].filter(s => val(s) > 0).sort((a, b) => val(b) - val(a)), max = Math.max(1, ...seats.map(val));
  const burners = seats.map((s, i) => {
    const seat = seatOf(s.seat), color = seat ? seat.color : "#82889f", share = total ? Math.round(val(s) / total * 100) : 0;
    return `<div class="tb-row ${i === 0 ? "first" : ""}" style="--seat:${esc(color)}" ${seat ? `data-seat-go="${esc(s.seat)}" role="button" tabindex="0"` : ""} title="${esc(who(s.seat))}: ${val(s).toLocaleString()} ${label.toLowerCase()} · ${s.sessions} sessions · ${(s.messages || 0).toLocaleString()} responses${s.top_model ? " · mostly " + modelName(s.top_model) : ""}">
      <span class="rk">${i + 1}</span>${seat ? `<i data-portrait="mascot-${esc(s.seat)}|${esc(color)}|"></i>` : `<span class="tb-unk">?</span>`}
      <span class="grow"><span class="tb-name"><b>${esc(who(s.seat))}</b>${i === 0 ? `<em class="tb-flame">${icon("flame", 13)}Top burner</em>` : ""}</span>
        <span class="tb-bar"><i style="width:${(val(s) / max * 100).toFixed(1)}%"></i></span></span>
      <span class="tb-v"><b>${big(val(s))}</b><small>${share}%${todayOf(s) ? ` · ${big(todayOf(s))} today` : ""}</small></span></div>`;
  }).join("");
  // the last 60 days as bars, months marked under them
  const days = t.days || [], dmax = Math.max(1, ...days.map(val)), W = days.length * 10, H = 90, today = days.length ? days[days.length - 1].day : "";
  const bars = days.map((d, i) => { const h = val(d) > 0 ? Math.max(2, Math.round(val(d) / dmax * H)) : 0, x = i * 10 + 1;
    return `<rect class="${d.day === today ? "on" : ""}" x="${x}" y="${H - h}" width="8" height="${h}" rx="1.5"><title>${esc(new Date(d.day + "T12:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }))}: ${val(d).toLocaleString()}</title></rect>`; }).join("");
  const marks = days.map((d, i) => d.day.endsWith("-01") || (i === 0 && d.day.slice(8) < "25") ? `<span style="left:${(i / Math.max(1, days.length) * 100).toFixed(2)}%">${esc(new Date(d.day + "T12:00:00").toLocaleDateString([], { month: "short" }))}</span>` : "").join("");
  const months = (t.months || []).slice(-4).map(m => `<span><b>${big(val(m))}</b>${esc(new Date(m.month + "-15T12:00:00").toLocaleDateString([], { month: "long" }))}</span>`).join("");
  const sessions = (t.sessions || []).slice(0, 6).map((s, i) => `<li><span class="rk">${i + 1}</span><span class="grow"><b class="${priv ? "private" : ""}">${esc(s.project || "a session")}</b>
    <small>${esc(who(s.seat))}${s.last ? ` · ${esc(relTime(s.last))}` : ""} · ${(s.messages || 0).toLocaleString()} responses</small></span><em>${big(val(s))}</em></li>`).join("");
  const projects = (t.projects || []).slice(0, 6).map((p, i) => `<li><span class="rk">${i + 1}</span><span class="grow"><b class="${priv ? "private" : ""}">${esc(p.project)}</b>
    <small>${p.sessions} session${p.sessions === 1 ? "" : "s"}${p.top_seat ? ` · mostly ${esc(who(p.top_seat))}` : ""}</small></span><em>${big(p.all)}</em></li>`).join("");
  const mmax = Math.max(1, ...(t.models || []).map(val));
  const models = (t.models || []).filter(m => val(m) > 0).slice(0, 6).map(m => `<li><span class="grow"><b>${esc(modelName(m.model))}</b><span class="tb-bar"><i style="width:${(val(m) / mmax * 100).toFixed(1)}%"></i></span></span><em>${big(val(m))}</em></li>`).join("");
  return `<div class="view-card tok" id="tokens"><div class="section-h"><h4>All-time tokens</h4><button class="btn sm ghost" data-tok-open title="Ranges, rank movement, a calendar and the hours of the week (K)">${icon("flame", 13)}Open Tokens</button><span class="grow"></span>
      <div class="seg-ctl" role="group" aria-label="Measure">${Object.entries(TOKEN_METRICS).map(([k, [l, d]]) => `<button data-tok-metric="${k}" class="${k === key ? "on" : ""}" title="${esc(d)}">${l}</button>`).join("")}</div></div>
    <div class="tok-hero"><b>${big(total)}</b><span>${label.toLowerCase()}${since ? ` since ${esc(since)}` : ""}</span>${todayOf(t) ? `<em>${big(todayOf(t))} today</em>` : ""}</div>
    <div class="tok-parts"><span title="Tokens read back from the prompt cache: cheap, and most of the volume">${icon("refresh", 13)}${big(t.total.cache)} cache reads</span>
      <span title="Input, cache writes and output">${icon("zap", 13)}${big(t.total.fresh)} fresh</span><span title="What the models wrote">${icon("send", 13)}${big(t.total.output)} output</span>
      <span>${icon("chat", 13)}${(t.total.messages || 0).toLocaleString()} responses · ${(t.total.sessions || 0).toLocaleString()} sessions</span></div>
    <div class="tok-grid"><div><h5>Who burns the most</h5><div class="tb-list">${burners || `<div class="muted">Nothing counted yet.</div>`}</div></div>
      <div><h5>Per day, last ${days.length} days</h5><svg class="tok-days" viewBox="0 0 ${Math.max(W, 10)} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)} per day for the last ${days.length} days">${bars}</svg><div class="tok-mlabels">${marks}</div>
        <div class="tok-months">${months}</div></div></div>
    <div class="tok-lists"><div><h5>Hungriest sessions</h5><ol>${sessions}</ol></div><div><h5>Projects</h5><ol>${projects}</ol></div><div><h5>Models</h5><ul class="tok-models">${models}</ul></div></div>
    <div class="hint">Counted from the session transcripts on this machine (Claude Code keeps about a month of them; the office keeps its totals from then on), and Codex's own records. A session belongs to the seat that ran it.</div></div>`;
}

export function bindTokens(el, app, rerender) {
  el.querySelectorAll("[data-tok-open]").forEach(b => b.addEventListener("click", () => app.setView("tokens")));
  el.querySelectorAll("[data-tok-metric]").forEach(b => b.addEventListener("click", () => { app.setPref("tokenMetric", b.dataset.tokMetric); rerender(); }));
  el.querySelectorAll(".tb-row[data-seat-go]").forEach(r => {
    const open = () => app.go({ kind: "seat", seat: r.dataset.seatGo });
    r.addEventListener("click", open);
    r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

// ------------------------------------------------------------------------------------------------ the Tokens tab
// The whole story for a range (today, 7, 30 or 90 days, all time) and optionally one character: the total against
// the period before, the live burn, a leaderboard that shows who moved, the days, a calendar, the hours of the week,
// the hungriest sessions, projects and models, and the office's records. Sessions export as CSV.
const RANGES = [["today", "Today"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["all", "All time"]];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const rangeWord = { today: "today", 7: "in the last 7 days", 30: "in the last 30 days", 90: "in the last 90 days", all: "all time" };
const prevWord = { today: "yesterday", 7: "the 7 days before", 30: "the 30 days before", 90: "the 90 days before" };

// The control that had focus before a redraw, as an attribute and value to find it again afterwards.
const FOCUS_KEYS = ["data-tp-range", "data-tok-metric", "data-tp-seat", "data-tp-csv", "data-tp-share", "data-tok-open", "data-seat-go"];
export function focusKey(el) {
  const a = document.activeElement;
  if (!a || !el.contains(a)) return null;
  const k = FOCUS_KEYS.find(n => a.hasAttribute(n));
  return k ? [k, a.getAttribute(k)] : null;
}
export function refocus(el, f) {
  if (!f) return;
  const b = el.querySelector(`[${f[0]}="${CSS.escape(f[1])}"]`);
  if (b) b.focus({ preventScroll: true });
}

export function renderTokens(el, app) {
  const f = focusKey(el);
  renderTokensInner(el, app);
  refocus(el, f);
}

function renderTokensInner(el, app) {
  const p = app.prefs(), rng = p.tokRange || "30", seat = p.tokSeat || null;
  const t = app.tokensCache(rng, seat), key = app.tokenMetric(), [label] = TOKEN_METRICS[key] || TOKEN_METRICS.all;
  const snap = app.snap(), priv = app.privacy();
  const seatOf = (id) => snap.seats.find(s => s.id === id);
  const who = (id) => { const s = seatOf(id); return s ? personaFor(s, snap.seats.findIndex(x => x.id === id)).name : "Unknown seat"; };
  const val = (r) => (r ? r[key] || 0 : 0);
  const todayOf = (r) => (r.today_by ? val(r.today_by) : key === "all" ? r.today || 0 : 0);
  const gameOff = (p.game || "full") === "off";
  const head = `<div class="tp-head"><div class="grow"><h3>Tokens${seat ? ` · ${esc(who(seat))}` : ""}</h3><p>${seat ? `Everything ${esc(who(seat))} burned` : "Who burns the most, and when"}, counted from the transcripts on this machine.</p></div>
    <div class="seg-ctl" role="group" aria-label="Range">${RANGES.map(([k, l]) => `<button data-tp-range="${k}" class="${k === rng ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="seg-ctl" role="group" aria-label="Measure">${Object.entries(TOKEN_METRICS).map(([k, [l, d]]) => `<button data-tok-metric="${k}" class="${k === key ? "on" : ""}" title="${esc(d)}">${l}</button>`).join("")}</div>
    ${seat ? `<button class="btn sm" data-tp-seat="">${icon("x", 14)}All characters</button>` : ""}<button class="btn sm" data-tp-csv>${icon("download", 14)}CSV</button><button class="btn sm" data-tp-share>${icon("star", 14)}Picture</button></div>`;
  if (!t) { el.innerHTML = `<div class="view-card">${head}<div class="skeleton" style="width:40%"></div><div class="skeleton"></div></div>`; bind(); return; }
  const total = val(t.total), prev = t.prev_total ? t.prev_total.all : null;
  const delta = key === "all" && prev ? Math.round((total - prev) / prev * 100) : null;
  const liveNow = snap.seats.filter(s => !seat || s.id === seat).reduce((a, s) => a + (s.tokens_1h_all || 0), 0);
  // the leaderboard, with how each character moved since the period before
  const board = (t.seats || []).filter(s => val(s) > 0), max = Math.max(1, ...board.map(val)), sum = board.reduce((a, s) => a + val(s), 0);
  const rows = board.map((s, i) => {
    const st = seatOf(s.seat), color = st ? st.color : "#82889f", mv = s.prev_rank == null ? null : s.prev_rank - (i + 1);
    const move = s.prev_rank == null ? (rng === "all" ? "" : `<em class="mv new" title="Not on the board ${esc(prevWord[rng] || "")}">new</em>`)
      : mv > 0 ? `<em class="mv up" title="Up from #${s.prev_rank}">▲${mv}</em>` : mv < 0 ? `<em class="mv down" title="Down from #${s.prev_rank}">▼${-mv}</em>` : `<em class="mv same" title="Same place as ${esc(prevWord[rng] || "")}">=</em>`;
    return `<div class="tb-row ${i === 0 ? "first" : ""} ${s.seat === seat ? "sel" : ""}" style="--seat:${esc(color)}" ${st ? `data-tp-seat="${esc(s.seat)}" role="button" tabindex="0" aria-label="${esc(who(s.seat))}: ${big(val(s))}, show only ${esc(who(s.seat))}"` : ""}>
      <span class="rk">${i + 1}</span>${st ? `<i data-portrait="mascot-${esc(s.seat)}|${esc(color)}|"></i>` : `<span class="tb-unk">?</span>`}
      <span class="grow"><span class="tb-name"><b>${esc(who(s.seat))}</b>${move}${i === 0 ? `<em class="tb-flame">${icon("flame", 13)}${rng === "all" ? "Top burner" : "Burning hottest"}</em>` : ""}</span>
        <span class="tb-bar"><i style="width:${(val(s) / max * 100).toFixed(1)}%"></i></span></span>
      <span class="tb-v"><b>${big(val(s))}</b><small>${sum ? Math.round(val(s) / sum * 100) : 0}% · ${s.sessions} session${s.sessions === 1 ? "" : "s"}</small></span></div>`;
  }).join("") || `<div class="muted">No tokens ${esc(rangeWord[rng])}.</div>`;
  // days in the range, as bars
  const days = t.days || [], dmax = Math.max(1, ...days.map(val));
  const bars = days.map((d, i) => { const h = val(d) > 0 ? Math.max(2, Math.round(val(d) / dmax * 100)) : 0, w = 100 / days.length;
    return `<rect x="${(i * w + w * 0.12).toFixed(2)}" y="${100 - h}" width="${(w * 0.76).toFixed(2)}" height="${h}" class="${i === days.length - 1 ? "on" : ""}"><title>${esc(new Date(d.day + "T12:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }))}: ${val(d).toLocaleString()}</title></rect>`; }).join("");
  const firstDay = days[0] && new Date(days[0].day + "T12:00:00").toLocaleDateString([], { day: "numeric", month: "short" });
  // the calendar: 26 weeks, Monday at the top, five shades of one hue
  const cal = t.calendar || [], cmax = Math.max(1, ...cal.map(val)), byDay = Object.fromEntries(cal.map(d => [d.day, d]));
  const end = new Date(), start = new Date(end); start.setDate(end.getDate() - 7 * 25 - ((end.getDay() + 6) % 7));   // a Monday: 26 columns, this week last
  let cells = "";
  for (let i = 0, d = new Date(start); d <= end; i++, d.setDate(d.getDate() + 1)) {
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, v = val(byDay[k]);
    const lvl = v <= 0 ? 0 : Math.min(4, 1 + Math.floor(v / cmax * 4));
    cells += `<i class="l${lvl}" style="grid-row:${((d.getDay() + 6) % 7) + 1};grid-column:${Math.floor(i / 7) + 1}" title="${esc(d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }))}: ${v ? big(v) : "nothing"}"></i>`;
  }
  // the week's hours: Monday to Sunday down, midnight to 11 PM across
  const heat = t.heat || {}, hmax = Math.max(1, ...Object.values(heat));
  let hcells = "";
  for (let wd = 0; wd < 7; wd++) for (let h = 0; h < 24; h++) {
    const v = heat[`${wd}-${h}`] || 0, lvl = v <= 0 ? 0 : Math.min(4, 1 + Math.floor(v / hmax * 4));
    hcells += `<i class="l${lvl}" style="grid-row:${wd + 1};grid-column:${h + 2}" title="${DAYS[wd]} ${h}:00–${h + 1}:00: ${v ? big(v) : "nothing"}"></i>`;
  }
  const hlabels = DAYS.map((d, i) => `<b style="grid-row:${i + 1};grid-column:1">${d}</b>`).join("") + [0, 6, 12, 18].map(h => `<b class="hx" style="grid-row:8;grid-column:${h + 2}">${h}</b>`).join("");
  const rec = t.records || {};
  const records = [
    rec.biggest_day && [icon("calendar", 16), "Biggest day", `${big(rec.biggest_day.all)}`, new Date(rec.biggest_day.day + "T12:00:00").toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })],
    rec.hungriest_session && [icon("flame", 16), "Hungriest session", big(rec.hungriest_session.all), `${priv ? "a project" : esc(rec.hungriest_session.project || "a session")} · ${esc(who(rec.hungriest_session.seat))}`],
    rec.longest_run && rec.longest_run.days > 1 && [icon("zap", 16), "Longest run", `${rec.longest_run.days} days`, `in a row with tokens, to ${new Date(rec.longest_run.until + "T12:00:00").toLocaleDateString([], { day: "numeric", month: "short" })}`],
    rec.busiest_hour && [icon("clock", 16), "Busiest hour", `${DAYS[rec.busiest_hour.weekday]} ${rec.busiest_hour.hour}:00`, "the hour of the week that burns the most"],
  ].filter(Boolean).map(([ic, k, v, sub]) => `<div class="tp-rec"><span class="ic-w">${ic}</span><span><small>${k}</small><b>${v}</b><span>${sub}</span></span></div>`).join("");
  // What the tokens bought: commits, pushes, PRs and lines, read from the sessions' own git and gh commands.
  function shipCard() {
    const sh = t.shipped;
    if (!sh || !(sh.commits || sh.prs_opened)) return "";
    const lean = gameOff ? null : leanHolder(t.weeks);
    const rows = (t.seats || []).filter(s => s.commits || s.prs_opened || s.prs_merged).sort((a, b) => b.commits - a.commits).map(s => {
      const st = seatOf(s.seat), per = s.commits ? s.all / s.commits : null;
      return `<tr style="--seat:${esc(st ? st.color : "#82889f")}"><td><span class="who">${st ? `<i data-portrait="mascot-${esc(s.seat)}|${esc(st.color)}|"></i>` : ""}${esc(who(s.seat))}${lean && lean.seat === s.seat ? ` <em class="lean" title="Lean ribbon: fewest tokens per commit last week">${icon("check", 11)}Lean</em>` : ""}</span></td>
        <td class="num">${s.commits.toLocaleString()}</td><td class="num">${s.prs_merged}<small> / ${s.prs_opened}</small></td><td class="num">+${fmtTok(s.insertions)} <small>−${fmtTok(s.deletions)}</small></td><td class="num">${per ? big(per) : "–"}</td></tr>`; }).join("");
    return `<div class="view-card"><h5>What it shipped · ${esc(RANGES.find(r => r[0] === rng)[1].toLowerCase())}</h5>
      <div class="tok-parts"><span>${icon("check", 13)}${sh.commits.toLocaleString()} commits</span><span>${icon("send", 13)}${sh.pushes.toLocaleString()} pushes</span>
        <span>${icon("star", 13)}${sh.prs_merged} PRs merged of ${sh.prs_opened} opened</span><span>+${fmtTok(sh.insertions)} −${fmtTok(sh.deletions)} lines</span>
        ${sh.commits && key === "all" ? `<span>${icon("flame", 13)}${big(total / sh.commits)} tokens a commit</span>` : ""}</div>
      ${rows ? `<div class="table-scroll"><table class="league ship"><thead><tr><th>Character</th><th class="num">Commits</th><th class="num">PRs merged / opened</th><th class="num">Lines</th><th class="num">Tokens a commit</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
      <p class="hint">Counted from the git and gh commands the sessions ran, when they succeeded.${lean ? ` Lean ribbon: ${esc(who(lean.seat))}, with the fewest tokens per commit last week (${big(lean.perCommit)}).` : ""}</p></div>`;
  }
  const list = (items, fn) => items.length ? `<ol>${items.map(fn).join("")}</ol>` : `<p class="muted">Nothing ${esc(rangeWord[rng])}.</p>`;
  const sessions = list((t.sessions || []).slice(0, 8), (s, i) => `<li><span class="rk">${i + 1}</span><span class="grow"><b class="${priv ? "private" : ""}">${esc(s.project || "a session")}</b>
    <small>${esc(who(s.seat))}${s.last ? ` · ${esc(relTime(s.last))}` : ""}</small></span><em>${big(val(s))}</em></li>`);
  const projects = list((t.projects || []).slice(0, 8), (p, i) => `<li><span class="rk">${i + 1}</span><span class="grow"><b class="${priv ? "private" : ""}">${esc(p.project)}</b>
    <small>${p.sessions} session${p.sessions === 1 ? "" : "s"}${p.top_seat && !seat ? ` · mostly ${esc(who(p.top_seat))}` : ""}</small></span><em>${big(val(p))}</em></li>`);
  const mmax = Math.max(1, ...(t.models || []).map(val));
  const models = list((t.models || []).filter(m => val(m) > 0).slice(0, 8), (m) => `<li><span class="grow"><b>${esc(modelName(m.model))}</b><span class="tb-bar"><i style="width:${(val(m) / mmax * 100).toFixed(1)}%"></i></span></span><em>${big(val(m))}</em></li>`);
  el.innerHTML = `<div class="tokpage">
    <div class="view-card">${head}
      <div class="tp-hero"><div><b>${big(total)}</b><span>${esc(label.toLowerCase())} ${esc(rangeWord[rng])}</span></div>
        ${delta != null ? `<em class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)}% on ${esc(prevWord[rng])}</em>` : ""}
        <em class="live" title="All tokens the sessions at work processed in the last hour, cache reads included">${icon("flame", 13)}${big(liveNow)} in the last hour</em>
        ${rng !== "today" && todayOf(t) ? `<em>${big(todayOf(t))} today</em>` : ""}</div>
      <div class="tok-parts"><span>${icon("refresh", 13)}${big(t.total.cache)} cache reads</span><span>${icon("zap", 13)}${big(t.total.fresh)} fresh</span><span>${icon("send", 13)}${big(t.total.output)} output</span><span>${icon("chat", 13)}${(t.total.sessions || 0).toLocaleString()} sessions</span></div></div>
    <div class="tp-grid"><div class="view-card"><h5>${seat ? "Where it ranks" : "Who burns the most"} · ${esc(RANGES.find(r => r[0] === rng)[1].toLowerCase())}</h5><div class="tb-list">${rows}</div>
        ${(() => { const b = beltHolders(t.weeks); return b.holder && !gameOff ? `<p class="tp-belt">${icon("belt", 15)}<span><b>Burner Belt: ${esc(who(b.holder))}</b>, the most tokens last week${b.leader && b.leader !== b.holder ? ` · ${esc(who(b.leader))} leads this week` : b.leader ? " and leads this week too" : ""}.</span></p>` : ""; })()}
        ${!seat && board.length ? `<p class="hint">Click a character to see only theirs.${rng === "all" ? "" : " Arrows: places moved since " + esc(prevWord[rng]) + "."}</p>` : ""}</div>
      <div class="view-card"><h5>Per day${firstDay ? ` · from ${esc(firstDay)}` : ""}</h5><svg class="tp-bars" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${esc(label)} per day">${bars}</svg>
        <div class="tok-months">${(t.months || []).slice(-4).map(m => `<span><b>${big(val(m))}</b>${esc(new Date(m.month + "-15T12:00:00").toLocaleDateString([], { month: "long" }))}</span>`).join("")}</div></div></div>
    <div class="tp-grid"><div class="view-card"><h5>Calendar · 26 weeks</h5><div class="tp-cal" role="img" aria-label="Tokens per day over 26 weeks">${cells}</div>
        <div class="tp-scale"><span>Less</span>${[0, 1, 2, 3, 4].map(l => `<i class="l${l}"></i>`).join("")}<span>More</span></div></div>
      <div class="view-card"><h5>The week's hours${rng === "all" ? "" : " · " + esc(RANGES.find(r => r[0] === rng)[1].toLowerCase())}</h5><div class="tp-heat" role="img" aria-label="Tokens by weekday and hour">${hlabels}${hcells}</div>
        <div class="tp-scale"><span>Less</span>${[0, 1, 2, 3, 4].map(l => `<i class="l${l}"></i>`).join("")}<span>More</span></div></div></div>
    ${shipCard()}
    ${records ? `<div class="view-card"><h5>Records${seat ? ` · ${esc(who(seat))}` : ""}</h5><div class="tp-recs">${records}</div></div>` : ""}
    <div class="view-card tok"><div class="tok-lists"><div><h5>Hungriest sessions</h5>${sessions}</div><div><h5>Projects</h5>${projects}</div><div><h5>Models</h5><ul class="tok-models">${models.replace(/^<ol>|<\/ol>$/g, "")}</ul></div></div>
      <p class="hint">Since ${t.since ? esc(new Date(t.since + "T12:00:00").toLocaleDateString([], { day: "numeric", month: "long" })) : "the first transcript"}. Claude Code keeps about a month of transcripts; the office keeps its totals from then on. Fresh: input, cache writes and output. Cache reads are tokens read back from the prompt cache.</p></div>
  </div>`;
  hydratePortraits(el, 4);
  bind();

  function bind() {
    const rerender = () => renderTokens(el, app);
    el.querySelectorAll("[data-tp-range]").forEach(b => b.addEventListener("click", () => { app.setPref("tokRange", b.dataset.tpRange); rerender(); }));
    el.querySelectorAll("[data-tok-metric]").forEach(b => b.addEventListener("click", () => { app.setPref("tokenMetric", b.dataset.tokMetric); rerender(); }));
    el.querySelectorAll("[data-tp-seat]").forEach(b => {
      const go = () => { const v = b.dataset.tpSeat || null; app.setPref("tokSeat", v === seat ? null : v); rerender(); };
      b.addEventListener("click", go);
      b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
    const share = el.querySelector("[data-tp-share]");
    if (share) share.addEventListener("click", () => { const d = app.tokensCache(rng, seat); if (d) shareTokens(app, d, rng); });   // one character's, when drilled in
    const csv = el.querySelector("[data-tp-csv]");
    if (csv) csv.addEventListener("click", () => downloadCsv(app, rng, seat, who));
  }
}

// Every session in the range as CSV: seat, project (left out in share-safe mode), the range's four counts, and the
// session's own first and last times and responses (those are whole-session, whatever the range).
async function downloadCsv(app, rng, seat, who) {
  try {
    const r = await fetch(`/api/tokens?range=${encodeURIComponent(rng)}${seat ? "&seat=" + encodeURIComponent(seat) : ""}&sessions=all`);
    const t = await r.json(), priv = app.privacy();
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const iso = (s) => (s ? new Date(s * 1000).toISOString() : "");
    const lines = [["character", "seat", "project", "session", "session_first", "session_last", "all_tokens", "fresh", "cache_reads", "output", "session_responses"].join(","),
      ...t.sessions.map(s => [q(who(s.seat)), q(s.seat || ""), q(priv ? "" : s.project), q(s.id), q(iso(s.first)), q(iso(s.last)), s.all, s.fresh, s.cache, s.output, s.messages].join(","))];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
    a.download = `tokens-${rng}${seat ? "-" + seat : ""}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch { /* the toast belongs to the app; a failed export just does nothing */ }
}

// The token picture: 1200×630, for a post or a channel. The range's total, every character ranked (the top one
// crowned), shipped work and the model split. Names and counts only: no projects, no sessions. With one character
// picked (t.seat), it is that character's: their total, work and models, their row lit in the ranking, and their place.
export async function tokensPicture(app, t, rng) {
  try { await Promise.all([document.fonts.load("40px Silkscreen"), document.fonts.load("800 56px Inter")]); } catch { /* system fonts */ }
  const W = 1200, H = 630, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d"), snap = app.snap(), who = (id) => { const s = snap.seats.find(x => x.id === id); return s ? personaFor(s, snap.seats.indexOf(s)).name : "Unknown seat"; };
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, "#1c0f08"); bg.addColorStop(1, "#0b0e1c");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(260, 120, 0, 260, 120, 560); glow.addColorStop(0, "rgba(255,122,69,0.28)"); glow.addColorStop(1, "rgba(255,122,69,0)");
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  g.font = "38px Silkscreen, monospace"; g.fillStyle = "#ffd8b0"; g.shadowColor = "#ff7a45"; g.shadowBlur = 16;
  g.fillText((snap.office.name || "Claude Office").toUpperCase().slice(0, 28), 60, 88); g.shadowBlur = 0;
  g.font = "500 22px Inter, sans-serif"; g.fillStyle = "#b8a99c";
  const span = rng.startsWith("m:") ? new Date(rng.slice(2) + "-15T12:00:00").toLocaleDateString([], { month: "long", year: "numeric" })
    : { today: "today", 7: "the last 7 days", 30: "the last 30 days", 90: "the last 90 days", all: t.since ? "since " + new Date(t.since + "T12:00:00").toLocaleDateString([], { day: "numeric", month: "long" }) : "all time" }[rng];
  const focus = t.seat || null;
  g.fillText(`${focus ? who(focus) + "'s" : "My AI team's"} tokens · ${span}`.slice(0, 64), 60, 126);
  g.fillStyle = "#ffffff"; g.font = "800 92px Inter, sans-serif"; g.fillText(big(t.total.all), 60, 250);
  g.fillStyle = "#c9b9ab"; g.font = "600 20px Inter, sans-serif";
  g.fillText(`${big(t.total.cache)} cache reads · ${big(t.total.fresh)} fresh · ${big(t.total.output)} written`, 64, 288);
  const sh = t.shipped || {};
  if (sh.commits) { g.fillStyle = "#7df0ad"; g.fillText(`${sh.commits.toLocaleString()} commits · ${sh.prs_merged} PRs merged · ${big(t.total.all / sh.commits)} tokens a commit`, 64, 322); }
  // the ranking
  const board = (t.seats || []).filter(s => s.seat && s.all > 0), boardSum = board.reduce((a, s) => a + s.all, 0) || 1;
  const place = focus ? board.findIndex(s => s.seat === focus) : 0;
  let rows = board.slice(0, 6);
  if (place >= 6) rows = [...board.slice(0, 5), board[place]];                       // the picked character always shows
  const max = Math.max(1, ...rows.map(s => s.all));
  rows.forEach((s, i) => {
    const seat = snap.seats.find(x => x.id === s.seat), y = 380 + i * 38, color = seat ? seat.color : "#82889f";
    if (focus && s.seat === focus) { g.fillStyle = "rgba(255,255,255,0.08)"; g.fillRect(48, y - 4, 760, 34); }
    g.fillStyle = focus && s.seat !== focus ? "#a39a92" : "#ffffff"; g.font = "700 20px Inter, sans-serif";
    g.fillText(`${board.indexOf(s) + 1}. ${who(s.seat)}`.slice(0, 22), 60, y + 20);
    g.fillStyle = "rgba(255,255,255,0.08)"; g.fillRect(300, y + 6, 420, 14);
    g.fillStyle = color; g.fillRect(300, y + 6, Math.max(4, 420 * s.all / max), 14);
    g.fillStyle = "#d9cbbf"; g.font = "700 18px Inter, sans-serif"; g.fillText(big(s.all), 734, y + 20);
  });
  // the top burner, crowned (or the picked character, with their place)
  const lead = focus ? board[place] : rows[0], top = lead && snap.seats.find(x => x.id === lead.seat);
  if (top) {
    g.fillStyle = "rgba(255,122,69,0.12)"; g.fillRect(860, 150, 280, 300);
    g.strokeStyle = "rgba(255,160,90,0.5)"; g.lineWidth = 2; g.strokeRect(860, 150, 280, 300);
    g.fillStyle = "#ff9b3d"; g.font = "700 15px Inter, sans-serif"; g.fillText(focus && place > 0 ? `RANK #${place + 1} OF ${board.length}` : rng === "all" ? "TOP BURNER" : "BURNING HOTTEST", 884, 184);
    g.imageSmoothingEnabled = false; g.drawImage(portrait("mascot-" + top.id, top.color, { scale: 9, crown: !focus || place === 0, level: top.career ? top.career.level : 0 }), 946, 200);
    g.fillStyle = "#ffffff"; g.font = "800 30px Inter, sans-serif"; g.textAlign = "center"; g.fillText(who(top.id).slice(0, 14), 1000, 380);
    g.fillStyle = "#d9cbbf"; g.font = "600 17px Inter, sans-serif"; g.fillText(`${Math.round(lead.all / boardSum * 100)}% of the team's tokens`, 1000, 410); g.textAlign = "left";
  }
  // the models, as one strip
  const models = (t.models || []).filter(m => m.all > 0).slice(0, 4), mt = models.reduce((a, m) => a + m.all, 0) || 1;
  let x = 860; const hues = ["#ff7a45", "#ffb36b", "#7aa8ff", "#a993ff"];
  models.forEach((m, i) => { const w = 280 * m.all / mt; g.fillStyle = hues[i]; g.fillRect(x, 480, Math.max(2, w - 2), 12); x += w; });
  g.font = "600 14px Inter, sans-serif"; g.fillStyle = "#c9b9ab";
  const names = models.map(m => `${modelName(m.model)} ${Math.round(m.all / mt * 100)}%`);
  while (names.length > 1 && g.measureText(names.join(" · ")).width > 290) names.pop();   // whole names only
  g.fillText(names.join(" · "), 860, 516);
  g.fillStyle = "#7a6f68"; g.font = "500 15px Inter, sans-serif"; g.textAlign = "right";
  g.fillText("Claude Office · github.com/JigarJoshi04/claude-office", W - 60, H - 30); g.textAlign = "left";
  return c;
}

// The picture in a dialog, to save or copy.
export async function shareTokens(app, t, rng) {
  const { $, toast } = await import("./util.js");
  const c = await tokensPicture(app, t, rng), url = c.toDataURL("image/png");
  $("dialogBody").innerHTML = `<div class="dh"><b>Tokens picture</b><button class="btn sm ghost" id="tsClose" aria-label="Close">${icon("x", 16)}</button></div>
    <div class="db"><img class="daycard" src="${url}" alt="${t.seat ? "One character's tokens: their total, their place in the ranking, shipped work and models" : "The office's tokens: the total, every character ranked, shipped work and the models"}">
    <div class="row" style="margin-top:12px;gap:8px"><button class="btn primary" id="tsSave">${icon("download", 15)}Save</button><button class="btn" id="tsCopy">${icon("copy", 15)}Copy</button></div></div>`;
  $("dialog").showModal();
  $("tsClose").addEventListener("click", () => $("dialog").close());
  $("tsSave").addEventListener("click", () => { const a = document.createElement("a"); a.download = `tokens-${rng.replace(":", "-")}${t.seat ? "-" + t.seat : ""}.png`; a.href = url; a.click(); });
  $("tsCopy").addEventListener("click", () => c.toBlob(b => {
    if (!b || !navigator.clipboard || !window.ClipboardItem) { toast("Copying pictures is not supported here: use Save.", "info"); return; }
    navigator.clipboard.write([new ClipboardItem({ "image/png": b })]).then(() => toast("Copied. Paste it into a post or a channel.", "good"), () => toast("Could not copy: use Save.", "warn"));
  }));
  $("tsSave").focus();
}

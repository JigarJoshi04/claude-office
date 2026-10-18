// All-time tokens, in the Today view: the office's total since its transcripts begin, who burns the most (characters,
// sessions, projects), the models, and the last 60 days. One measure at a time: everything the model processed, fresh
// tokens (input, cache writes and output) or output alone. Data from /api/tokens (office/tokens.py).
import { esc, fmtTok, relTime } from "./util.js";
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
  const seatOf = (id) => snap.seats.find(s => s.id === id);
  const who = (id) => { const s = seatOf(id); return s ? personaFor(s, snap.seats.findIndex(x => x.id === id)).name : "Unknown seat"; };
  const since = t.since ? new Date(t.since + "T12:00:00").toLocaleDateString([], { day: "numeric", month: "short", year: t.since.slice(0, 4) === String(new Date().getFullYear()) ? undefined : "numeric" }) : null;
  const total = val(t.total), seats = [...t.seats].filter(s => val(s) > 0).sort((a, b) => val(b) - val(a)), max = Math.max(1, ...seats.map(val));
  const burners = seats.map((s, i) => {
    const seat = seatOf(s.seat), color = seat ? seat.color : "#82889f", share = total ? Math.round(val(s) / total * 100) : 0;
    return `<div class="tb-row ${i === 0 ? "top" : ""}" style="--seat:${esc(color)}" ${seat ? `data-seat-go="${esc(s.seat)}" role="button" tabindex="0"` : ""} title="${esc(who(s.seat))}: ${val(s).toLocaleString()} ${label.toLowerCase()} · ${s.sessions} sessions · ${(s.messages || 0).toLocaleString()} responses${s.top_model ? " · mostly " + modelName(s.top_model) : ""}">
      <span class="rk">${i + 1}</span>${seat ? `<i data-portrait="mascot-${esc(s.seat)}|${esc(color)}|"></i>` : `<span class="tb-unk">?</span>`}
      <span class="grow"><span class="tb-name"><b>${esc(who(s.seat))}</b>${i === 0 ? `<em class="tb-flame">${icon("flame", 13)}Top burner</em>` : ""}</span>
        <span class="tb-bar"><i style="width:${(val(s) / max * 100).toFixed(1)}%"></i></span></span>
      <span class="tb-v"><b>${big(val(s))}</b><small>${share}%${s.today ? ` · ${big(s.today)} today` : ""}</small></span></div>`;
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
  return `<div class="view-card tok" id="tokens"><div class="section-h"><h4>All-time tokens</h4>
      <div class="seg-ctl" role="group" aria-label="Measure">${Object.entries(TOKEN_METRICS).map(([k, [l, d]]) => `<button data-tok-metric="${k}" class="${k === key ? "on" : ""}" title="${esc(d)}">${l}</button>`).join("")}</div></div>
    <div class="tok-hero"><b>${big(total)}</b><span>${label.toLowerCase()}${since ? ` since ${esc(since)}` : ""}</span>${t.today && key === "all" ? `<em>${big(t.today)} today</em>` : ""}</div>
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
  el.querySelectorAll("[data-tok-metric]").forEach(b => b.addEventListener("click", () => { app.setPref("tokenMetric", b.dataset.tokMetric); rerender(); }));
  el.querySelectorAll(".tb-row[data-seat-go]").forEach(r => {
    const open = () => app.go({ kind: "seat", seat: r.dataset.seatGo });
    r.addEventListener("click", open);
    r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

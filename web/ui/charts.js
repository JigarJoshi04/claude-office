// Charts: plan rings, usage sparklines with a burn forecast, and the timeline of every session.
import { esc, clock, dur, tip } from "./util.js";

const ST_VAR = { working: "var(--st-working)", waiting: "var(--st-waiting)", idle: "var(--st-idle)", limited: "var(--st-limited)", stuck: "var(--st-stuck)", done: "var(--st-done)" };

// A ring showing how much plan is LEFT (the number a CEO acts on).
export function ring(usedPct, color, label) {
  const left = usedPct == null ? null : Math.max(0, 100 - usedPct);
  const r = 26, c = 2 * Math.PI * r;
  const frac = left == null ? 0 : left / 100;
  const col = left == null ? "var(--line-2)" : left <= 10 ? "var(--bad)" : left <= 25 ? "var(--warn)" : color;
  return `<svg class="ring" viewBox="0 0 64 64" role="img" aria-label="${label}: ${left == null ? "unknown" : Math.round(left) + "% left"}">
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--line-2)" stroke-width="7"/>
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 32 32)"/>
    <text x="32" y="34" text-anchor="middle">${left == null ? "–" : Math.round(left) + "%"}</text>
    <text class="rl" x="32" y="45" text-anchor="middle">left</text></svg>`;
}

// Usage over time for one window (5-hour or weekly), with the projected burn to the reset.
const charts = new Map();
let chartSeq = 0;
export function usageSpark(points, opts) {
  // points: [[ts, pct]], opts: {color, now, reset, forecast:{state, out_at, per_hour}, label}
  const id = "sp" + (++chartSeq);
  const W = 360, H = 96, padL = 26, padR = 8, padT = 8, padB = 16;
  const pts = points.filter(p => p[1] != null);
  const now = opts.now;
  const t0 = pts.length ? Math.min(pts[0][0], now - 3600) : now - 3600;
  let t1 = now + Math.max(600, (now - t0) * 0.15);
  if (opts.reset && opts.reset > now) t1 = Math.min(Math.max(t1, opts.reset + 300), now + (now - t0) * 1.2);
  const x = (t) => padL + (t - t0) / (t1 - t0) * (W - padL - padR);
  const y = (v) => padT + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - padT - padB);
  let path = "", area = "";
  pts.forEach((p, i) => { path += (i ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1); });
  if (pts.length) area = path + `L${x(pts[pts.length - 1][0]).toFixed(1)} ${y(0)} L${x(pts[0][0]).toFixed(1)} ${y(0)} Z`;
  let proj = "";
  const last = pts[pts.length - 1];
  const fc = opts.forecast;
  if (last && fc && fc.per_hour > 0) {
    const endT = Math.min(t1, fc.state === "runs_out" ? fc.out_at : (opts.reset || t1));
    const endV = Math.min(100, last[1] + fc.per_hour * (endT - last[0]) / 3600);
    proj = `<path d="M${x(last[0]).toFixed(1)} ${y(last[1]).toFixed(1)} L${x(endT).toFixed(1)} ${y(endV).toFixed(1)}" fill="none" stroke="${fc.state === "runs_out" ? "var(--bad)" : opts.color}" stroke-width="2" stroke-dasharray="4 3"/>`;
    if (fc.state === "runs_out" && fc.out_at <= t1) proj += `<circle cx="${x(fc.out_at).toFixed(1)}" cy="${y(100)}" r="4" fill="var(--bad)" stroke="var(--surface-2)" stroke-width="2"/>`;
  }
  const ticks = [];
  const span = t1 - t0, step = span > 4 * 86400 ? 86400 : span > 12 * 3600 ? 6 * 3600 : span > 4 * 3600 ? 3600 * 2 : 3600;
  for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) ticks.push(t);
  const fmt = (t) => step >= 86400 ? new Date(t * 1000).toLocaleDateString([], { weekday: "short" }) : new Date(t * 1000).toLocaleTimeString([], { hour: "numeric" });
  charts.set(id, { pts, x, y, t0, t1, opts, W });
  return `<svg class="spark" id="${id}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(opts.label)} usage over time">
    <line class="gl" x1="${padL}" x2="${W - padR}" y1="${y(100)}" y2="${y(100)}"/><line class="gl" x1="${padL}" x2="${W - padR}" y1="${y(50)}" y2="${y(50)}"/>
    <line class="gl" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/>
    <text class="ax" x="2" y="${y(100) + 3}">100%</text><text class="ax" x="6" y="${y(50) + 3}">50%</text>
    ${ticks.map(t => `<text class="ax" x="${x(t)}" y="${H - 3}" text-anchor="middle">${fmt(t)}</text>`).join("")}
    <rect x="${x(now)}" y="${padT}" width="${Math.max(0, x(t1) - x(now))}" height="${H - padT - padB}" fill="var(--line)" opacity="1"/>
    ${opts.reset && opts.reset < t1 ? `<line x1="${x(opts.reset)}" x2="${x(opts.reset)}" y1="${padT}" y2="${H - padB}" stroke="var(--info)" stroke-dasharray="2 2"/><text class="ax" x="${x(opts.reset) - 3}" y="${padT + 8}" text-anchor="end" style="fill:var(--info)">reset</text>` : ""}
    ${area ? `<path d="${area}" fill="${opts.color}" opacity=".14"/>` : ""}
    ${path ? `<path d="${path}" fill="none" stroke="${opts.color}" stroke-width="2" stroke-linejoin="round"/>` : ""}
    ${proj}
    ${last ? `<circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="4" fill="${opts.color}" stroke="var(--surface-2)" stroke-width="2"/>` : ""}
    <line class="xh" x1="0" x2="0" y1="${padT}" y2="${H - padB}" stroke="var(--muted)" opacity="0"/>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" class="hit"/>
  </svg>`;
}
export function bindSparks(root) {
  root.querySelectorAll("svg.spark").forEach(svg => {
    const c = charts.get(svg.id); if (!c || !c.pts.length) return;
    const hit = svg.querySelector(".hit"), xh = svg.querySelector(".xh");
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const vx = (e.clientX - r.left) / r.width * c.W;
      let best = c.pts[0];
      for (const p of c.pts) if (Math.abs(c.x(p[0]) - vx) < Math.abs(c.x(best[0]) - vx)) best = p;
      xh.setAttribute("x1", c.x(best[0])); xh.setAttribute("x2", c.x(best[0])); xh.setAttribute("opacity", ".6");
      tip(`<b>${Math.round(best[1])}% used</b> · ${clock(best[0])}`, r.left + c.x(best[0]) / c.W * r.width, r.top + c.y(best[1]) / 96 * r.height);
    });
    hit.addEventListener("pointerleave", () => { xh.setAttribute("opacity", "0"); tip(null); });
  });
}

// The timeline: one block per seat, one row per session, segments coloured by state.
export function timeline(hist, snap, width, hours, nameOf = (s) => s.label, words = (t) => t, privacy = false) {
  const labelW = 170, padR = 14, rowH = 18, headH = 28, gapH = 10;
  const now = hist.now || snap.now;
  const t0 = now - hours * 3600, t1 = now + Math.max(1800, hours * 3600 * 0.18);
  const plotW = Math.max(200, width - labelW - padR);
  const x = (t) => labelW + (Math.max(t0, Math.min(t1, t)) - t0) / (t1 - t0) * plotW;
  const rows = [];
  let yy = 24;
  const sessBySeat = new Map();
  for (const s of hist.sessions || []) {
    if ((s.last_seen || now) < t0) continue;
    if (!sessBySeat.has(s.seat)) sessBySeat.set(s.seat, []);
    sessBySeat.get(s.seat).push(s);
  }
  const marks = (hist.markers || []).filter(m => m.ts >= t0);
  let svg = "";
  const step = hours > 12 ? 3 * 3600 : hours > 6 ? 2 * 3600 : hours > 2 ? 3600 : 1800;
  for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) {
    if (Math.abs(x(t) - x(now)) < 34) { svg += `<line class="tick" x1="${x(t)}" x2="${x(t)}" y1="18" y2="__H__"/>`; continue; }
    svg += `<line class="tick" x1="${x(t)}" x2="${x(t)}" y1="18" y2="__H__"/><text class="ticklbl" x="${x(t)}" y="12" text-anchor="middle">${new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: step < 3600 ? "2-digit" : undefined })}</text>`;
  }
  svg += `<rect x="${x(now)}" y="18" width="${x(t1) - x(now)}" height="__HH__" fill="url(#tlhatch)"/>`;
  for (const seat of snap.seats) {
    const list = (sessBySeat.get(seat.id) || []).sort((a, b) => a.first_seen - b.first_seen);
    const shown = list.slice(-10);
    svg += `<rect class="rowbg" x="0" y="${yy}" width="${labelW + plotW}" height="${headH}" rx="6"/>`;
    svg += `<rect x="8" y="${yy + 9}" width="10" height="10" rx="3" fill="${seat.color}"/>`;
    const nm = nameOf(seat);
    svg += `<text class="lbl" x="24" y="${yy + 18}">${esc(nm)}</text><text class="lbl2" x="${32 + nm.length * 7.6}" y="${yy + 18}">${list.length} session${list.length === 1 ? "" : "s"}</text>`;
    // usage strip: 5-hour % as a thin line across the header
    const ser = ((hist.seats || {})[seat.id] || {}).series || [];
    const pts = ser.filter(r => r[0] >= t0 && r[1] != null);
    if (pts.length > 1) {
      const y = (v) => yy + headH - 4 - v / 100 * (headH - 8);
      svg += `<path d="${pts.map((p, i) => (i ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1)).join("")}" fill="none" stroke="${seat.color}" stroke-width="1.5" opacity=".9"/>`;
    }
    const u = seat.usage || {};
    if (u.five_hour && u.five_hour.resets_at && u.five_hour.resets_at < t1) {
      const rx = x(u.five_hour.resets_at);
      svg += `<line x1="${rx}" x2="${rx}" y1="${yy}" y2="${yy + headH}" stroke="var(--info)" stroke-width="2" stroke-dasharray="3 2"/><text class="ticklbl" x="${rx + 3}" y="${yy + 10}" style="fill:var(--info)">reset</text>`;
    }
    const fc = (seat.forecast || {}).five_hour;
    if (fc && fc.state === "runs_out" && fc.out_at < t1) {
      const ox = x(fc.out_at);
      svg += `<text x="${ox}" y="${yy + 19}" text-anchor="middle" style="fill:var(--bad);font:700 13px Inter">✕</text><text class="ticklbl" x="${ox + 7}" y="${yy + 24}" style="fill:var(--bad)">out</text>`;
    }
    for (const m of marks.filter(m => m.seat === seat.id)) {
      const mx = x(m.ts), col = m.level === "good" ? "var(--good)" : m.level === "bad" ? "var(--bad)" : m.level === "warn" ? "var(--warn)" : "var(--info)";
      svg += `<path class="mk" data-tip="${esc(esc(clock(m.ts) + " · " + (privacy ? `${m.kind} news` : words(m.text))))}" d="M${mx} ${yy + 3} l4 4 l-4 4 l-4 -4 Z" fill="${col}" stroke="var(--surface)" stroke-width="1"/>`;   // share-safe: the kind only
    }
    yy += headH + 3;
    for (const s of shown) {
      svg += `<text class="lbl2" x="24" y="${yy + 12}" data-sid="${esc(s.id)}">${esc(privacy ? (s.kind === "lane" ? "a lane" : "a session") : trim(s.name, 22))}${s.kind === "desk" ? " 🎧" : ""}</text>`;
      for (const [a, b, st] of s.segments || []) {
        if (b < t0) continue;
        const sx = x(a), ex = Math.max(sx + 2, x(b));
        svg += `<rect class="seg" x="${sx.toFixed(1)}" y="${yy + 3}" width="${(ex - sx).toFixed(1)}" height="${rowH - 7}" rx="3" fill="${ST_VAR[st] || "var(--faint)"}" data-seat="${esc(seat.id)}" data-sid="${esc(s.id)}" data-live="${s.live ? 1 : 0}"
          data-tip="${esc(`<b>${esc(s.name)}</b> · ${esc(st)}<br>${clock(a)} – ${b >= now - 90 ? "now" : clock(b)} (${dur(b - a)})`)}"/>`;
      }
      if (s.report_status) svg += `<text x="${x(s.last_seen) + 4}" y="${yy + 12}" style="fill:var(--good);font:700 11px Inter">✓</text>`;
      yy += rowH;
    }
    if (list.length > shown.length) { svg += `<text class="lbl2" x="24" y="${yy + 12}">+${list.length - shown.length} earlier</text>`; yy += rowH; }
    if (!list.length) { svg += `<text class="lbl2" x="24" y="${yy + 12}">No sessions in this window</text>`; yy += rowH; }
    yy += gapH;
  }
  const H = yy + 4;
  svg += `<line class="nowl" x1="${x(now)}" x2="${x(now)}" y1="16" y2="${H - 4}"/><text class="nowlbl" x="${x(now) + 4}" y="12">NOW</text>`;
  svg = svg.replaceAll("__H__", String(H - 4)).replaceAll("__HH__", String(H - 22));
  return `<svg class="tl-svg" viewBox="0 0 ${labelW + plotW + padR} ${H}" width="${labelW + plotW + padR}" height="${H}" role="img" aria-label="Timeline of sessions per seat">
    <defs><pattern id="tlhatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="transparent"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-2)" stroke-width="1.5"/></pattern></defs>
    ${svg}</svg>`;
}
function trim(s, n) { s = (s || "").replace(/^wt-/, ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

export function bindTips(root) {
  root.querySelectorAll("[data-tip]").forEach(el => {
    el.addEventListener("pointermove", (e) => tip(el.dataset.tip, e.clientX, e.clientY - 6));
    el.addEventListener("pointerleave", () => tip(null));
  });
}

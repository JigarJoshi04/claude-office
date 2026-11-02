// The Copilot seat's plan in money: AI credits used this month, what they cost, the included credits, overage, the burn
// an hour and where the month is heading (office/copilot_seat.py credits_view). Copilot has no 5-hour or weekly window,
// so nothing here draws one; the seat page, the briefing, the floor and the board all read this one summary.
import { esc } from "./util.js";
import { icon } from "./icons.js";

export const isCopilot = (s) => !!s && s.kind === "copilot";

// "$28.47", "$1,234", "$10.6k": cents while they matter, then whole dollars, then thousands.
export function usd(v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 10000) return "$" + (n / 1000).toFixed(a >= 100000 ? 0 : 1) + "k";
  if (a >= 1000) return "$" + Math.round(n).toLocaleString("en-US");
  return "$" + n.toFixed(2);
}
export const creditsN = (v) => (v == null || !Number.isFinite(Number(v)) ? "–" : Math.round(Number(v)).toLocaleString("en-US"));

// The plan's reset day ("Dec 1") and how far off it is ("in 29 days").
export function resetWords(at, now) {
  if (!at) return { day: "–", left: "" };
  const day = new Date(at * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
  const s = Math.max(0, at - now), d = Math.round(s / 86400);
  return { day, left: s < 86400 ? `in ${Math.max(1, Math.round(s / 3600))} h` : `in ${d} day${d === 1 ? "" : "s"}` };
}

// Everything a view shows, worked out once: null before the first reading (and when there is nothing to say).
export function creditsSummary(c, now) {
  if (!c) return null;
  if (c.credits_used == null) return c.error ? { error: c.error } : null;
  const used = Number(c.credits_used), inc = Number(c.included) || 0, over = inc > 0 && used > inc;
  const total = Math.max(used, inc) || 1;
  const b = c.burn, p = c.projection || {};
  return {
    usd: usd(c.usd), credits: creditsN(used), rate: c.credit_usd,
    included: inc, includedPct: c.included_pct, over, overUsd: usd(c.overage_usd || 0), overCredits: creditsN(c.overage_credits || 0),
    bar: inc > 0 ? { inc: Math.min(used, inc) / total * 100, over: over ? (used - inc) / total * 100 : 0, mark: over ? inc / total * 100 : null } : null,
    burn: b ? { usd: usd(b.usd_per_hour) + "/h", credits: creditsN(b.credits_per_hour) + " credits/h", minutes: b.minutes } : null,
    month: p.month_usd != null ? usd(p.month_usd) : null, hour: p.hour_usd != null ? usd(p.hour_usd) : null,
    reset: resetWords(c.reset_at, now), plan: c.plan ? "Copilot " + c.plan.charAt(0).toUpperCase() + c.plan.slice(1) : "Copilot",
    overage: c.overage_permitted, unlimited: c.unlimited, percentLeft: c.percent_remaining, entitlement: c.entitlement,
    stale: !!c.stale, fetchedAt: c.fetched_at, error: c.error,
  };
}

// One short line for plates, peeks and rows: "$28.47 this month".
export function creditsLine(s) {
  const c = creditsSummary(s && s.credits, 0);
  return c && !c.error ? `${c.usd} this month` : null;
}

// The included credits as a bar: the seat's colour up to the included amount, the rest (overage) in amber past a tick.
export function creditsBar(sm, label = "AI credits used against the included credits") {
  if (!sm || !sm.bar) return "";
  const { inc, over, mark } = sm.bar;
  return `<div class="cc-bar" role="img" aria-label="${esc(label)}: ${esc(sm.credits)} of ${esc(creditsN(sm.included))}"><i class="inc" style="width:${inc.toFixed(1)}%"></i>${over ? `<i class="ovr" style="width:${over.toFixed(1)}%"></i>` : ""}${mark != null ? `<b class="mark" style="left:${mark.toFixed(1)}%"></b>` : ""}</div>`;
}

// The card: the month in dollars up top, the included credits as a bar, then the last hour, the month end and the reset.
// opts: { now, relTime, refresh (a seat id for the refresh button), compact (the briefing's version), name, seatId }.
export function creditsCard(s, opts = {}) {
  const now = opts.now || Date.now() / 1000, sm = creditsSummary(s.credits, now);
  if (!sm) return `<div class="cc empty"><span class="cc-ic">${icon("coin", 16)}</span><span>Reading Copilot's plan: the first reading comes within a minute of the office starting.</span></div>`;
  if (sm.error && sm.credits == null) return `<div class="cc empty bad"><span class="cc-ic">${icon("alert", 16)}</span><span>Could not read Copilot's plan: ${esc(sm.error)}</span></div>`;
  const tile = (k, v, sub, cls = "") => `<div class="cc-t ${cls}"><small>${k}</small><b>${v}</b><span>${sub}</span></div>`;
  const incl = sm.included > 0
    ? `${creditsBar(sm)}<div class="cc-inc"><span>${sm.over ? `<b>${esc(sm.overUsd)}</b> overage: ${esc(sm.overCredits)} credits past the ${esc(creditsN(sm.included))} included`
        : `${esc(sm.credits)} of the ${esc(creditsN(sm.included))} included credits`}</span><em>${sm.includedPct != null ? Math.round(sm.includedPct) + "%" : ""}</em></div>`
    : "";
  const ent = sm.entitlement && sm.percentLeft != null ? `<div class="cc-inc"><span>Premium requests left this month</span><em>${Math.round(sm.percentLeft)}%</em></div>` : "";
  const burn = sm.burn ? tile("Last hour", esc(sm.burn.usd), `${esc(sm.burn.credits)}`, "burn") : tile("Last hour", "–", "Learning: a reading every 5 min");
  const month = tile("Month end", sm.month ? "~" + esc(sm.month) : "–", "at this month's pace");
  const reset = tile("Resets", esc(sm.reset.day), esc(sm.reset.left));
  const read = sm.fetchedAt && opts.relTime ? `Read ${esc(opts.relTime(sm.fetchedAt))}${sm.stale ? " (stale)" : ""}.` : "";
  const notes = [sm.overage === true ? "Overage is on: credits past the included ones are billed." : sm.overage === false ? "Overage is off: Copilot stops at the included credits." : "",
    sm.hour ? `At this hour's pace the month would end near ${esc(sm.hour)}.` : "", sm.error ? `Last read failed: ${esc(sm.error)}.` : "", read].filter(Boolean).join(" ");
  return `<div class="cc${opts.compact ? " compact" : ""}" style="--seat:${esc(s.color || "#d55181")}">
    <div class="cc-top"><div class="grow"><div class="cc-usd">${esc(sm.usd)}</div>
      <div class="cc-sub">this month · ${esc(sm.credits)} AI credits at ${usd(sm.rate)}</div></div>
      ${opts.compact ? "" : `<span class="cc-plan">${esc(sm.plan)}</span>`}${opts.refresh ? `<button class="btn sm ghost icon" data-refresh="${esc(opts.refresh)}" title="Read the plan now" aria-label="Read Copilot's plan now">${icon("refresh", 14)}</button>` : ""}</div>
    ${incl}${ent}
    <div class="cc-tiles">${burn}${month}${reset}</div>
    ${notes ? `<p class="cc-note">${notes}</p>` : ""}</div>`;
}

// Small shared helpers for the page.
import * as S from "../engine/sprites.js";
import { icon } from "./icons.js";

export const $ = (id) => document.getElementById(id);
// A blank screen says why it is blank and what to do next: an icon, a line, a hint (HTML the caller has escaped) and at
// most one action.
export function emptyState(ic, title, text = "", action = "") {
  return `<div class="empty-st"><span class="es-ic">${icon(ic, 18)}</span><div class="grow"><b>${esc(title)}</b>${text ? `<p>${text}</p>` : ""}${action ? `<div class="es-act">${action}</div>` : ""}</div></div>`;
}
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function fmtTok(n) {
  if (n == null) return "–";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(Math.round(n));
}
export const store = {
  get(k, d) { try { const v = localStorage.getItem("office." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("office." + k, JSON.stringify(v)); } catch { /* private window */ } },
};
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

let NOW = Date.now() / 1000;
export function setNow(n) { NOW = n; }
export function ago(ts) {
  if (!ts) return "–";
  const s = Math.max(0, Math.round(NOW - ts));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h " + Math.round((s % 3600) / 60) + "m ago";
  return Math.floor(s / 86400) + "d ago";
}
export function until(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round(ts - NOW));
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h" + String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return Math.floor(s / 86400) + "d " + Math.floor((s % 86400) / 3600) + "h";
}
// A countdown: "4:07", or "52:10" (minutes and seconds); never negative.
export const mmss = (sec) => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
export function clock(ts) { return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
export function dur(sec) {
  if (sec == null) return "–";
  if (sec < 60) return Math.round(sec) + "s";
  if (sec < 3600) return Math.round(sec / 60) + "m";
  return Math.floor(sec / 3600) + "h " + Math.round((sec % 3600) / 60) + "m";
}
export function pct(u, k) { return u && u[k] && u[k].pct != null ? u[k].pct : null; }
export function live(s) { return s.sessions.filter(x => x.live !== false); }

export const STATE_LABEL = { working: "Working", waiting: "Waiting on a tool", idle: "Idle", limited: "Out of plan", stuck: "Quiet 15 min+", done: "Finished" };
export const SEAT_LABEL = { working: "Working", idle: "Idle", limited: "Out of plan", benched: "Benched", offline: "Logged out" };
export const KIND_ICON = { type: "⌨", read: "📖", think: "💭", talk: "💬", delegate: "🛸", wait: "⏳", sleep: "💤" };
export const LEVEL_ICON = { bad: "!", warn: "▲", good: "✓", info: "i" };

// A pixel portrait (the same sprite as on the floor) as a small canvas.
export function portrait(id, color, opts = {}) {
  const c = document.createElement("canvas");
  const scale = opts.scale || 3;
  c.width = 12 * scale; c.height = 15 * scale;
  const ctx = c.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingEnabled = false;
  const look = S.lookFor(id, color, opts.look);             // opts.look: a look being chosen, for a preview
  if (opts.crown) { S.rect(ctx, 3, 0, 6, 1, "#ffd24a"); S.rect(ctx, 3, -1, 1, 1, "#ffd24a"); }
  S.drawSeated(ctx, 1, 2, opts.level >= 5 ? { ...look, gear: opts.level } : look, "down", opts.pose || "idle", 0);
  if (opts.headset) { S.rect(ctx, 0, 5, 1, 3, "#2a2d38"); S.rect(ctx, 11, 5, 1, 3, "#2a2d38"); S.rect(ctx, 1, 1, 10, 1, "#2a2d38"); }
  if (opts.dim) { c.style.opacity = ".5"; }
  c.setAttribute("aria-hidden", "true");
  return c;
}
// Placeholder elements in an HTML string are swapped for portraits after render: <i data-portrait="id|color|opts">
export function portraitTag(id, color, opts = "") { return `<i data-portrait="${esc(id)}|${esc(color)}|${esc(opts)}"></i>`; }
export function avatar(id, color, opts = "", cls = "") { return `<span class="av ${cls}" style="--seat:${esc(color)}">${portraitTag(id, color, opts)}</span>`; }
export function relTime(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round(NOW - ts));
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}
export function inWords(ts) {   // "in 2 h 05 min"
  if (!ts) return "";
  const s = Math.max(0, Math.round(ts - NOW));
  if (s < 3600) return "in " + Math.max(1, Math.round(s / 60)) + " min";
  if (s < 86400) return "in " + Math.floor(s / 3600) + " h " + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + " min";
  return "in " + Math.floor(s / 86400) + " d " + Math.floor((s % 86400) / 3600) + " h";
}
export function dayTime(ts) {   // "1:40 AM" today, "Sun 2:30 PM" later
  if (!ts) return "";
  const d = new Date(ts * 1000), now = new Date(NOW * 1000);
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString([], { weekday: "short" }) + " " + t;
}
export function hydratePortraits(root, scale) {
  root.querySelectorAll("i[data-portrait]").forEach(el => {
    const [id, color, o] = el.dataset.portrait.split("|");
    const opts = { scale };
    for (const f of (o || "").split(",")) if (/^lv\d+$/.test(f)) opts.level = +f.slice(2); else if (f) opts[f] = true;   // "lv12": the character's gear
    el.replaceWith(portrait(id, color, opts));
  });
}

export function drawLogo(canvas) {
  const ctx = canvas.getContext("2d");
  const r = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  r(0, 0, 17, 17, "#1b1f34"); r(2, 2, 13, 9, "#2f3454");
  r(3, 3, 3, 3, "#ffd76a"); r(7, 3, 3, 3, "#ffd76a"); r(11, 3, 3, 3, "#38e07b");
  r(3, 7, 3, 3, "#ffd76a"); r(7, 7, 3, 3, "#2a2f4d"); r(11, 7, 3, 3, "#ffd76a");
  r(2, 12, 13, 3, "#ff7a45"); r(7, 12, 3, 3, "#1b1f34");
}

let toastEl = null;
// Do not disturb (app.js): while it is on, only serious toasts show.
let toastGate = null;
export function setToastGate(fn) { toastGate = fn; }
export function toast(msg, level = "info", opts = 4200) {
  if (toastGate && !toastGate(level)) return;
  const { ms = 4200, ic = null } = typeof opts === "number" ? { ms: opts } : opts || {};
  toastEl = toastEl || $("toasts");
  const t = document.createElement("div");
  t.className = "toast " + level + (ic ? " special" : "");
  t.innerHTML = `${icon(ic || { good: "check", bad: "alert", warn: "alert", info: "chat" }[level] || "chat", 18)}<span>${esc(msg)}</span>`;
  toastEl.appendChild(t);
  while (toastEl.children.length > 4) toastEl.firstChild.remove();
  // Toasts live in the top layer (a manual popover), re-raised each time so they show above an open dialog.
  try { if (toastEl.matches(":popover-open")) toastEl.hidePopover(); toastEl.showPopover(); } catch { /* no popover API: plain fixed layer */ }
  setTimeout(() => { t.remove(); if (!toastEl.children.length) try { toastEl.hidePopover(); } catch { /* ignore */ } }, ms);
}

let tipEl = null;
export function tip(html, x, y) {
  tipEl = tipEl || $("tip");
  if (html == null) { tipEl.hidden = true; return; }
  tipEl.innerHTML = html; tipEl.hidden = false;
  tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
}

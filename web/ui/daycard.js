// The day card: a 1200×630 picture of the office's day, sized for a social post or a team channel. It carries only
// character names, levels and counts (no session names, topics or accounts), so it is safe to share.
import { portrait } from "./util.js";
import { goals, streak } from "./goals.js";
import { officeLevel } from "../engine/unlocks.js";

const W = 1200, H = 630;

export async function dayCard({ snap, stats, persona, goalDays }) {
  try { await Promise.all([document.fonts.load("40px Silkscreen"), document.fonts.load("700 56px Inter"), document.fonts.load("500 20px Inter")]); } catch { /* system fonts */ }
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  // backdrop: night blue with a warm glow and a pixel skyline
  const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, "#0b0e1c"); bg.addColorStop(1, "#141a33");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(240, 80, 0, 240, 80, 520); glow.addColorStop(0, "rgba(255,122,69,0.22)"); glow.addColorStop(1, "rgba(255,122,69,0)");
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let x = 0; x < W; x += 24 + Math.floor(rnd() * 20)) {
    const bh = 40 + Math.floor(rnd() * 90), bw = 18 + Math.floor(rnd() * 26);
    g.fillStyle = "#0a0d1a"; g.fillRect(x, H - bh, bw, bh);
    g.fillStyle = "rgba(255,215,106,0.35)";
    for (let i = 0; i < 4; i++) if (rnd() < 0.5) g.fillRect(x + 4 + Math.floor(rnd() * (bw - 8)), H - bh + 8 + Math.floor(rnd() * (bh - 16)), 3, 3);
  }
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(255,255,255,${0.2 + rnd() * 0.5})`; g.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * 300), 2, 2); }

  const office = stats.office || {}, seats = stats.seats || {};
  const sum = (k) => Object.values(seats).reduce((a, s) => a + (s[k] || 0), 0);
  const hours = sum("active_min") / 60, calls = sum("tool_calls");
  const day = stats.day ? new Date(stats.day + "T12:00:00") : new Date();

  // heading
  g.textBaseline = "alphabetic";
  g.font = "40px Silkscreen, monospace"; g.fillStyle = "#ffd8fb"; g.shadowColor = "#ff4fd8"; g.shadowBlur = 16;
  g.fillText((snap.office.name || "Claude Office").toUpperCase(), 60, 92); g.shadowBlur = 0;
  g.font = "500 22px Inter, sans-serif"; g.fillStyle = "#a1a7bc";
  g.fillText(`My AI team's day · ${day.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}`, 60, 130);

  // office level badge (top right)
  const ol = officeLevel(snap.seats);
  const bx = W - 130, by = 92;
  g.lineWidth = 10; g.strokeStyle = "rgba(255,255,255,0.12)"; g.beginPath(); g.arc(bx, by, 50, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = "#ffd24a"; g.lineCap = "round"; g.beginPath(); g.arc(bx, by, 50, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, ol.progress)); g.stroke();
  g.textAlign = "center"; g.fillStyle = "#a1a7bc"; g.font = "700 13px Inter, sans-serif"; g.fillText("OFFICE LV", bx, by - 8);
  g.fillStyle = "#ffffff"; g.font = "800 34px Inter, sans-serif"; g.fillText(String(ol.level), bx, by + 26); g.textAlign = "left";

  // the four numbers
  const big = [[String(office.reports || 0), "reports filed"], [hours >= 10 ? Math.round(hours) + " h" : hours.toFixed(1) + " h", "of agent work"],
    [calls >= 1e4 ? Math.round(calls / 1000) + "k" : calls.toLocaleString(), "tool calls"], [String(office.sessions || 0), "sessions"]];
  big.forEach(([v, l], i) => {
    const x = 60 + i * 200;
    g.fillStyle = "rgba(255,255,255,0.05)"; roundRect(g, x, 170, 184, 118, 18); g.fill();
    g.fillStyle = "#ffffff"; g.font = "800 48px Inter, sans-serif"; g.fillText(v, x + 20, 238);
    g.fillStyle = "#a1a7bc"; g.font = "500 18px Inter, sans-serif"; g.fillText(l, x + 20, 270);
  });

  // employee of the day
  const mvpSeat = stats.mvp && snap.seats.find(s => s.id === stats.mvp.seat);
  const mx = 880, my = 170;
  g.fillStyle = "rgba(255,210,74,0.10)"; roundRect(g, mx, my, 260, 118, 18); g.fill();
  g.strokeStyle = "rgba(255,210,74,0.45)"; g.lineWidth = 2; roundRect(g, mx, my, 260, 118, 18); g.stroke();
  g.fillStyle = "#ffd24a"; g.font = "700 13px Inter, sans-serif"; g.fillText("EMPLOYEE OF THE DAY", mx + 20, my + 30);
  if (mvpSeat) {
    g.imageSmoothingEnabled = false; g.drawImage(portrait("mascot-" + mvpSeat.id, mvpSeat.color, { scale: 5, crown: true }), mx + 18, my + 40);
    g.fillStyle = "#ffffff"; g.font = "700 26px Inter, sans-serif"; g.fillText(persona(mvpSeat).name, mx + 88, my + 72);
    g.fillStyle = "#c6cad8"; g.font = "500 15px Inter, sans-serif"; wrap(g, (stats.mvp.why || "").replace(/^\w/, ch => ch.toUpperCase()), mx + 88, my + 96, 160, 18, 2);
  } else { g.fillStyle = "#a1a7bc"; g.font = "500 17px Inter, sans-serif"; g.fillText("Nobody yet today.", mx + 20, my + 72); }

  // goals and streak
  const gl = goals(stats) || [];
  let gx = 60;
  g.font = "700 15px Inter, sans-serif"; g.fillStyle = "#a1a7bc"; g.fillText("TODAY'S GOALS", gx, 334);
  gl.forEach((goal, i) => {
    const x = gx + i * 280, y = 372;
    g.lineWidth = 6; g.strokeStyle = "rgba(255,255,255,0.12)"; g.beginPath(); g.arc(x + 18, y, 16, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = goal.done ? "#ffd24a" : "#ff7a45"; g.beginPath(); g.arc(x + 18, y, 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, goal.f)); g.stroke();
    if (goal.done) { g.fillStyle = "#ffd24a"; g.beginPath(); g.arc(x + 18, y, 9, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = "#ffffff"; g.font = "600 18px Inter, sans-serif"; g.fillText(goal.label, x + 46, y - 2);
    g.fillStyle = goal.done ? "#7df0ad" : "#a1a7bc"; g.font = "500 15px Inter, sans-serif"; g.fillText(goal.text, x + 46, y + 18);
  });
  const run = streak(goalDays, stats.day);
  if (run >= 2) { g.fillStyle = "#ff9b3d"; g.font = "700 18px Inter, sans-serif"; g.textAlign = "right"; g.fillText(`🔥 ${run}-day streak`, W - 60, 334); g.textAlign = "left"; }

  // the team
  g.font = "700 15px Inter, sans-serif"; g.fillStyle = "#a1a7bc"; g.fillText("THE TEAM", 60, 438);
  const team = snap.seats.slice(0, 6);
  team.forEach((s, i) => {
    const x = 60 + i * 180, y = 452, p = persona(s);
    g.fillStyle = "rgba(255,255,255,0.05)"; roundRect(g, x, y, 174, 74, 14); g.fill();
    g.fillStyle = s.color; roundRect(g, x, y, 5, 74, 3); g.fill();
    g.imageSmoothingEnabled = false; g.drawImage(portrait("mascot-" + s.id, s.color, { scale: 4, dim: false }), x + 14, y + 10);
    g.fillStyle = "#ffffff"; g.font = "700 18px Inter, sans-serif"; g.fillText(p.name, x + 66, y + 32);
    const st = seats[s.id] || {};
    g.fillStyle = "#a1a7bc"; g.font = "500 14px Inter, sans-serif";
    const n = st.reports || 0;
    g.fillText(`${s.career ? "Lv " + s.career.level + " · " : ""}${n} report${n === 1 ? "" : "s"}`, x + 66, y + 54);
  });

  g.fillStyle = "#6f7590"; g.font = "500 15px Inter, sans-serif"; g.textAlign = "right";
  g.fillText("Claude Office · github.com/JigarJoshi04/claude-office", W - 60, H - 30); g.textAlign = "left";
  return c;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function wrap(g, text, x, y, maxW, lh, lines) {
  const words = text.split(" "); let line = "", n = 0;
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (g.measureText(t).width > maxW && line) { g.fillText(line, x, y + n * lh); line = w; if (++n >= lines) return; } else line = t;
  }
  if (line && n < lines) g.fillText(line, x, y + n * lh);
}

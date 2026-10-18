// Seasonal decorations, drawn over the floor each frame: Halloween (pumpkins and bats), Diwali (lamps and a rangoli)
// and the winter holidays (a tree, lights and snow in the windows). Settings can turn them off.
import * as S from "./sprites.js";
import { LOBBY_W, WALL } from "./scene.js";

// Diwali moves with the lunar calendar; the main day for the years the office will plausibly run.
const DIWALI = { 2026: "11-08", 2027: "10-29", 2028: "10-17", 2029: "11-05", 2030: "10-26" };

export function seasonFor(d = new Date()) {
  const y = d.getFullYear(), md = (m, day) => new Date(y, m - 1, day);
  const dw = DIWALI[y] && new Date(`${y}-${DIWALI[y]}T12:00:00`);
  if (dw && d >= new Date(dw.getTime() - 4 * 864e5) && d <= new Date(dw.getTime() + 3 * 864e5)) return "diwali";
  if (d >= md(10, 15) && d < md(11, 2)) return "halloween";          // through the whole of 1 November
  if (d >= md(12, 10) || d < new Date(y, 0, 3)) return "winter";      // through the whole of 2 January
  return null;
}

export const SEASON_NAME = { halloween: "Halloween", diwali: "Diwali", winter: "Winter holidays" };

function pumpkin(c, x, y, t, lit, lights) {
  S.rect(c, x + 1, y + 8, 10, 1, "rgba(0,0,0,0.3)");
  S.rect(c, x + 1, y + 2, 10, 6, "#e8742a"); S.rect(c, x, y + 3, 12, 4, "#e8742a"); S.rect(c, x + 3, y + 2, 1, 6, "#c95e1c"); S.rect(c, x + 8, y + 2, 1, 6, "#c95e1c");
  S.rect(c, x + 5, y, 2, 2, "#4a7a2a");
  const glow = lit ? (Math.floor(t / 180 + x) % 5 ? "#ffd24a" : "#ffb23a") : "#7a3a10";
  S.rect(c, x + 3, y + 3, 2, 1, glow); S.rect(c, x + 7, y + 3, 2, 1, glow); S.rect(c, x + 4, y + 5, 4, 1, glow);
  if (lit && lights) lights.push({ x: x + 6, y: y + 4, r: 16, c: "#ff9b3d", i: 0.5 });
}
function bat(c, x, y, t) {                            // purple-black with red eyes, so it reads on the dark corridor
  const up = Math.floor(t / 140) % 2, b = "#3a2a55";
  S.rect(c, x + 3, y + 1, 3, 3, b); S.rect(c, x + 3, y + 2, 1, 1, "#ff4d5e"); S.rect(c, x + 5, y + 2, 1, 1, "#ff4d5e");
  S.rect(c, x, y + (up ? 0 : 3), 3, 1, b); S.rect(c, x + 6, y + (up ? 0 : 3), 3, 1, b);
  S.rect(c, x + 1, y + (up ? 1 : 2), 2, 1, b); S.rect(c, x + 6, y + (up ? 1 : 2), 2, 1, b);
}
function diya(c, x, y, t, lights) {
  S.rect(c, x, y + 3, 6, 2, "#b5643e"); S.rect(c, x + 1, y + 5, 4, 1, "#8a4a2a");
  const f = Math.floor(t / 120 + x) % 3;
  S.rect(c, x + 2, y + 1 - (f === 1 ? 1 : 0), 2, 2, "#ffd24a"); S.rect(c, x + 2, y + 2, 2, 1, "#ff8f3d");
  if (lights) lights.push({ x: x + 3, y: y + 2, r: 12, c: "#ffb23a", i: 0.55 });
}
function rangoli(c, x, y) {
  const cols = ["#ff5fa2", "#ffd24a", "#38c0ff", "#7ee787", "#ff7a45"];
  for (let r = 14; r > 0; r -= 3) {
    const col = cols[(r / 3 | 0) % cols.length];
    for (let a = 0; a < 16; a++) { const k = a / 16 * Math.PI * 2; S.rect(c, x + Math.round(Math.cos(k) * r), y + Math.round(Math.sin(k) * r * 0.6), 2, 2, col); }
  }
  S.rect(c, x - 1, y - 1, 3, 3, "#ffffff");
}
function tree(c, x, y, t, lights) {
  S.rect(c, x + 8, y + 30, 4, 5, "#6d4a2a"); S.rect(c, x + 4, y + 34, 12, 3, "#c94f4f");
  for (let i = 0; i < 5; i++) S.rect(c, x + 8 - i * 2, y + 6 + i * 5, 4 + i * 4, 6, i % 2 ? "#2f8a4a" : "#3aa05a");
  S.rect(c, x + 9, y + 2, 2, 4, "#ffd24a"); S.rect(c, x + 8, y + 3, 4, 2, "#ffd24a");
  const cols = ["#ff6b6b", "#ffd24a", "#7aa8ff", "#ff7bd8"];
  for (let i = 0; i < 10; i++) {
    const lx = x + 4 + ((i * 7) % 13), ly = y + 10 + ((i * 11) % 20);
    S.rect(c, lx, ly, 1, 1, Math.floor(t / 400 + i) % 3 ? cols[i % 4] : "#ffffff");
  }
  if (lights) lights.push({ x: x + 10, y: y + 20, r: 26, c: "#ffd24a", i: 0.4 });
}

// Decorations for this frame. L is the floor layout; night lights pumpkins and lamps.
export function drawSeason(c, L, season, t, night, lights) {
  if (!season || !L) return;
  if (season === "halloween") {
    pumpkin(c, 8, WALL + 46, t, night, lights); pumpkin(c, 142, WALL + 14, t, night, lights);   // clear of the palms, the TV and the carpet
    for (const p of L.pods) pumpkin(c, p.room.x + 8, p.room.y + p.room.h - 46, t, night, lights);   // above the nameplate
    for (let i = 0; i < 3; i++) {                    // a few bats flutter over the corridors
      const cy = L.corridors[i % L.corridors.length], k = ((t / 9000) + i / 3) % 1;
      bat(c, Math.round(LOBBY_W + k * (L.W - LOBBY_W)), cy + 3 + Math.round(Math.sin(t / 300 + i) * 3), t);
    }
  } else if (season === "diwali") {
    for (const cy of L.corridors) for (let x = LOBBY_W + 12; x < L.W - 10; x += 40) diya(c, x, cy - 6, t, night ? lights : null);
    rangoli(c, 132, WALL + 50);
    for (const p of L.pods) diya(c, p.room.x + p.room.w / 2 - 3, p.room.y + p.room.h - 12, t, night ? lights : null);
  } else if (season === "winter") {
    tree(c, 150, WALL + 6, t, lights);
    for (const p of L.pods) {                         // string lights along each room's top band
      for (let x = p.room.x + 4; x < p.room.x + p.room.w - 4; x += 6) S.rect(c, x, p.room.y + 6, 2, 2, ["#ff6b6b", "#ffd24a", "#7aa8ff", "#7ee787"][((x / 6 | 0) + Math.floor(t / 600)) % 4]);
    }
  }
}

// Snow falling in a window (winter only).
export function drawSnow(c, x, y, w, h, t) {
  for (let i = 0; i < 8; i++) {
    const sx = x + ((S.hashOf("sn" + i + x) % w) + Math.round(Math.sin(t / 700 + i) * 2)), sy = y + ((t / 60 + i * 9) % h);
    S.rect(c, sx, sy, 1, 1, "#ffffff");
  }
}

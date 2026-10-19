// Seasonal decorations, drawn over the floor each frame: Halloween (pumpkins and bats), Diwali (lamps and a rangoli),
// the winter holidays (a tree, lights and snow in the windows), New Year's Eve (fireworks), Valentine's (hearts),
// Lunar New Year (lanterns) and the office's own birthday (a cake and balloons). Settings can turn them off.
import * as S from "./sprites.js";
import { LOBBY_W, WALL } from "./scene.js";

// Diwali moves with the lunar calendar; the main day for the years the office will plausibly run.
const DIWALI = { 2026: "11-08", 2027: "10-29", 2028: "10-17", 2029: "11-05", 2030: "10-26" };

// Lunar New Year's day for the same years.
const LUNAR = { 2026: "02-17", 2027: "02-06", 2028: "01-26", 2029: "02-13", 2030: "02-03" };

// born: the office's first day (YYYY-MM-DD, the earliest character's start); on its anniversary the office has a party.
export function seasonFor(d = new Date(), born = null) {
  const y = d.getFullYear(), md = (m, day) => new Date(y, m - 1, day);
  if (born && /^\d{4}-\d{2}-\d{2}$/.test(born) && +born.slice(0, 4) < y && born.slice(5) === `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`) return "birthday";
  if ((d.getMonth() === 11 && d.getDate() === 31) || (d.getMonth() === 0 && d.getDate() === 1)) return "newyear";
  const ln = LUNAR[y] && new Date(`${y}-${LUNAR[y]}T12:00:00`);
  if (ln && d >= new Date(ln.getTime() - 2 * 864e5) && d <= new Date(ln.getTime() + 3 * 864e5)) return "lunar";
  if (d >= md(2, 12) && d < md(2, 15)) return "valentine";
  const dw = DIWALI[y] && new Date(`${y}-${DIWALI[y]}T12:00:00`);
  if (dw && d >= new Date(dw.getTime() - 4 * 864e5) && d <= new Date(dw.getTime() + 3 * 864e5)) return "diwali";
  if (d >= md(10, 15) && d < md(11, 2)) return "halloween";          // through the whole of 1 November
  if (d >= md(12, 10) || d < new Date(y, 0, 3)) return "winter";      // through the whole of 2 January
  return null;
}

export const SEASON_NAME = { halloween: "Halloween", diwali: "Diwali", winter: "Winter holidays", newyear: "New Year", valentine: "Valentine's Day", lunar: "Lunar New Year", birthday: "The office's birthday" };

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

function lantern(c, x, y, t, lit, lights) {             // a red paper lantern on a cord, swaying a little
  const sw = Math.round(Math.sin(t / 900 + x) * 1);
  S.rect(c, x + 3 + sw, y - 4, 1, 4, "#8a6d3c");
  S.rect(c, x + sw + 1, y, 6, 1, "#d8b45a"); S.rect(c, x + sw, y + 1, 8, 6, "#d6283c"); S.rect(c, x + sw + 1, y + 1, 6, 6, "#e8384c");
  S.rect(c, x + sw + 3, y + 1, 1, 6, "#b81d30"); S.rect(c, x + sw + 1, y + 7, 6, 1, "#d8b45a"); S.rect(c, x + sw + 3, y + 8, 2, 3, "#ffd24a");
  if (lit && lights) lights.push({ x: x + 4, y: y + 4, r: 14, c: "#ff5a3c", i: 0.5 });
}
function heart(c, x, y, col) {
  S.rect(c, x, y, 2, 2, col); S.rect(c, x + 3, y, 2, 2, col); S.rect(c, x, y + 1, 5, 2, col); S.rect(c, x + 1, y + 3, 3, 1, col); S.rect(c, x + 2, y + 4, 1, 1, col);
}
function balloon(c, x, y, t, col) {
  const bob = Math.round(Math.sin(t / 700 + x) * 1.5);
  S.rect(c, x + 1, y + bob, 5, 6, col); S.rect(c, x, y + 1 + bob, 7, 4, col); S.rect(c, x + 1, y + 1 + bob, 1, 2, "rgba(255,255,255,0.6)");
  S.rect(c, x + 3, y + 7 + bob, 1, 8, "#c9c2b0");
}
function cake(c, x, y, t, lights) {                     // two tiers, three candles that flicker
  S.rect(c, x, y + 8, 18, 6, "#f4d7b0"); S.rect(c, x, y + 8, 18, 2, "#ff8fb8"); S.rect(c, x + 2, y + 3, 14, 5, "#fbe6c8"); S.rect(c, x + 2, y + 3, 14, 1, "#ff8fb8");
  for (let i = 0; i < 3; i++) {
    const cx = x + 4 + i * 5;
    S.rect(c, cx, y, 1, 3, "#7aa8ff"); S.rect(c, cx, y - 2 - (Math.floor(t / 150 + i) % 2), 1, 2, "#ffd24a");
    if (lights) lights.push({ x: cx, y: y - 2, r: 10, c: "#ffd24a", i: 0.45 });
  }
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
  } else if (season === "lunar") {
    for (const cy of L.corridors) for (let x = LOBBY_W + 20; x < L.W - 12; x += 48) lantern(c, x, cy - 12, t, night, lights);
    for (const p of L.pods) lantern(c, p.room.x + 6, p.room.y + 44, t, night, lights);
  } else if (season === "valentine") {
    for (const p of L.pods) { heart(c, p.room.x + p.room.w - 14, p.room.y + 44, "#ff5f8a"); heart(c, p.room.x + p.room.w - 22, p.room.y + 50, "#ff9fbf"); }
    for (let i = 0; i < 4; i++) {                    // a few hearts drift up the corridors
      const cy = L.corridors[i % L.corridors.length], k = ((t / 7000) + i / 4) % 1;
      heart(c, Math.round(LOBBY_W + 20 + ((i * 97) % Math.max(40, L.W - LOBBY_W - 40))), cy + 8 - Math.round(k * 10), i % 2 ? "#ff5f8a" : "#ff9fbf");
    }
  } else if (season === "newyear") {
    for (const p of L.pods) for (let x = p.room.x + 6; x < p.room.x + p.room.w - 6; x += 9) S.rect(c, x, p.room.y + 6 + ((x / 9 | 0) % 2), 3, 2, ["#ffd24a", "#ff5fa2", "#7fdbe6"][(x / 9 | 0) % 3]);
  } else if (season === "birthday") {
    cake(c, (L.ceo ? L.ceo.x : 0) + 132, (L.ceo ? L.ceo.y : WALL) + 52, t, night ? lights : null);
    ["#ff5f8a", "#ffd24a", "#7aa8ff"].forEach((col, i) => balloon(c, (L.ceo ? L.ceo.x + L.ceo.w : LOBBY_W) - 30 + i * 8, (L.ceo ? L.ceo.y : WALL) + 26 + (i % 2) * 4, t, col));   // tied by the CEO desk
    for (const p of L.pods) balloon(c, p.room.x + p.room.w - 14, p.room.y + 44, t, p.seat.color);
  } else if (season === "winter") {
    tree(c, 150, WALL + 6, t, lights);
    for (const p of L.pods) {                         // string lights along each room's top band
      for (let x = p.room.x + 4; x < p.room.x + p.room.w - 4; x += 6) S.rect(c, x, p.room.y + 6, 2, 2, ["#ff6b6b", "#ffd24a", "#7aa8ff", "#7ee787"][((x / 6 | 0) + Math.floor(t / 600)) % 4]);
    }
  }
}

// Fireworks over the city in a window (New Year): small bursts that bloom and fade.
export function drawWindowFireworks(c, x, y, w, h, t) {
  for (let i = 0; i < 2; i++) {
    const k = ((t / 1600) + i * 0.5 + (x % 7) / 7) % 1, r = Math.round(2 + k * 6), col = ["#ffd24a", "#ff5fa2", "#7fdbe6"][(i + (x >> 3)) % 3];
    if (k > 0.8) continue;
    const cx = x + 10 + ((S.hashOf("fw" + x + i + Math.floor(t / 1600)) % Math.max(1, w - 20))), cy = y + 6 + i * 4;
    for (let a = 0; a < 8; a++) { const ang = a / 8 * Math.PI * 2, px = cx + Math.round(Math.cos(ang) * r), py = cy + Math.round(Math.sin(ang) * r * 0.7); if (px > x && px < x + w - 1 && py > y && py < y + h - 1) S.rect(c, px, py, 1, 1, col); }
  }
}

// Snow falling in a window (winter only).
export function drawSnow(c, x, y, w, h, t) {
  for (let i = 0; i < 8; i++) {
    const sx = x + ((S.hashOf("sn" + i + x) % w) + Math.round(Math.sin(t / 700 + i) * 2)), sy = y + ((t / 60 + i * 9) % h);
    S.rect(c, sx, sy, 1, 1, "#ffffff");
  }
}

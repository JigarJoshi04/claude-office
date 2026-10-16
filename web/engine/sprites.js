// Pixel-art building blocks. Every shape is an integer rect in logical pixels; the renderer scales the whole
// canvas by a whole number, so pixels stay square and crisp at any zoom.

export const P = {
  wall: "#2f3454", wallHi: "#3a4066", wallLo: "#252943", wainscot: "#1f2238", trim: "#5a6290",
  floorA: "#7d5f43", floorB: "#74583d", floorLine: "#5e4630", floorHi: "#8a6a4c",
  carpet: "#4f3657", carpetB: "#472f4f", tile: "#232735", tileB: "#1f2230", tileLine: "#171a26",
  rug: "#2f5658", rugB: "#2a4d4f", meet: "#3b4463", meetB: "#353d5a",
  deskTop: "#d6b088", deskTopHi: "#e4c29d", deskEdge: "#a07a54", deskDark: "#7e5e40",
  mon: "#181b24", monEdge: "#3a4052", monHi: "#4a5168", screenOff: "#0e1016",
  chair: "#434a68", chairHi: "#535b7e", chairDark: "#30354d",
  glass: "rgba(160,205,255,0.16)", glassEdge: "#8fb6dd",
  plant: "#3f9b5a", plantHi: "#5cbf72", plantDark: "#2b7041", pot: "#b5643e", potHi: "#d07a52",
  white: "#f4f1ea", paper: "#eceae3", black: "#12131a", shadow: "rgba(0,0,0,0.28)",
  skin: ["#f2c9a0", "#e0b089", "#c48b5f", "#9a643f", "#f6d5b8", "#70452b"],
  hair: ["#2b1d14", "#5a3a22", "#a8652a", "#e0b34a", "#1f1f28", "#8c8c96", "#b5452f", "#3d2a5c", "#d9d4cc"],
  pants: ["#2b3045", "#3a3226", "#1f2a3a", "#40404a"],
};

export function rect(ctx, x, y, w, h, c) {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return "#" + ((c((n >> 16) & 255) << 16) | (c((n >> 8) & 255) << 8) | c(n & 255)).toString(16).padStart(6, "0");
}
export function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function hashOf(str) {
  let h = 2166136261;
  for (let i = 0; i < (str || "").length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Same agent, same look, every refresh.
export function lookFor(id, shirt) {
  const h = hashOf(id);
  return {
    skin: P.skin[h % P.skin.length],
    hair: P.hair[(h >>> 3) % P.hair.length],
    style: (h >>> 7) % 6,               // 0 short, 1 long, 2 bun, 3 spiky, 4 cap, 5 bald-ish crop
    shirt,
    pants: P.pants[(h >>> 13) % P.pants.length],
    glasses: ((h >>> 11) % 5) === 0,
  };
}

const HEAD_DOWN = [
  "...hhhh...",
  "..hhhhhh..",
  ".hhhhhhhh.",
  ".hssssssh.",
  ".ssessess.",
  ".ssssssss.",
  "..ssmmss..",
  "...ssss...",
];
const HEAD_UP = [
  "...hhhh...",
  "..hhhhhh..",
  ".hhhhhhhh.",
  ".hhhhhhhh.",
  ".hhhhhhhh.",
  ".shhhhhhs.",
  "..ssssss..",
  "...ssss...",
];
const TORSO = [
  "..tttttt..",
  ".tttttttt.",
  "tttttttttt",
  "tttttttttt",
  "tttttttttt",
];
const LEGS = {
  stand: ["..pppppp..", "..pp..pp..", "..pp..pp..", "..oo..oo.."],
  a:     ["..pppppp..", ".pp....pp.", ".pp....pp.", ".oo....oo."],
  b:     ["..pppppp..", "...pppp...", "...pp.pp..", "...oo.oo.."],
};

function paint(ctx, x, y, rows, cols) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === "." || !cols[ch]) continue;
      ctx.fillStyle = cols[ch];
      ctx.fillRect(x + c, y + r, 1, 1);
    }
  }
}

// Head (10x8). facing "down" shows the face; "up" the back of the head. o: {blink, sleep, talk, eyes: -1|0|1}
export function drawHead(ctx, x, y, look, facing, o = {}) {
  const map = facing === "up" ? HEAD_UP : HEAD_DOWN;
  const cols = { h: look.hair, s: look.skin, e: P.black, m: shade(look.skin, 0.72) };
  if (o.blink || o.sleep) cols.e = shade(look.skin, 0.62);
  if (look.style === 5) cols.h = shade(look.skin, 0.9);
  paint(ctx, x, y, map, cols);
  if (facing === "down" && o.eyes) {          // glance sideways while walking
    rect(ctx, x + 3, y + 4, 1, 1, look.skin); rect(ctx, x + 6, y + 4, 1, 1, look.skin);
    if (!o.blink) { rect(ctx, x + 3 + o.eyes, y + 4, 1, 1, P.black); rect(ctx, x + 6 + o.eyes, y + 4, 1, 1, P.black); }
  }
  switch (look.style) {
    case 1: for (let r = 3; r < 8; r++) { rect(ctx, x, y + r, 1, 1, look.hair); rect(ctx, x + 9, y + r, 1, 1, look.hair); } break;
    case 2: rect(ctx, x + 4, y - 2, 2, 2, look.hair); rect(ctx, x + 3, y - 1, 4, 1, look.hair); break;
    case 3: rect(ctx, x + 2, y - 1, 1, 1, look.hair); rect(ctx, x + 5, y - 1, 1, 1, look.hair); rect(ctx, x + 7, y - 1, 1, 1, look.hair); break;
    case 4: rect(ctx, x + 1, y, 8, 2, shade(look.shirt, 0.7)); rect(ctx, x + (facing === "up" ? 1 : 0), y + 2, facing === "up" ? 8 : 10, 1, shade(look.shirt, 0.55)); break;
    default: break;
  }
  if (facing === "down") {
    if (look.glasses && !o.sleep) {
      rect(ctx, x + 2, y + 4, 3, 1, "#24252e"); rect(ctx, x + 5, y + 4, 3, 1, "#24252e");
      rect(ctx, x + 3, y + 4, 1, 1, "#9fd3ff"); rect(ctx, x + 6, y + 4, 1, 1, "#9fd3ff");
    }
    if (o.talk) rect(ctx, x + 4, y + 6, 2, 1, P.black);
  }
}

export function drawTorso(ctx, x, y, look, rows = 5) {
  const cols = { t: look.shirt };
  paint(ctx, x, y, TORSO.slice(0, rows), cols);
  rect(ctx, x, y + 2, 1, rows - 2, shade(look.shirt, 0.78));
  rect(ctx, x + 9, y + 2, 1, rows - 2, shade(look.shirt, 0.78));
  rect(ctx, x + 4, y, 2, 1, shade(look.shirt, 0.65));        // collar
}

// Seated, upper body only (the desk hides the rest): 13 rows.
export function drawSeated(ctx, x, y, look, facing, pose, t) {
  const sleep = pose === "sleep";
  const bob = pose === "idle" ? Math.round(Math.sin(t / 900) * 0.6) : 0;
  const hy = y + (sleep && facing === "down" ? 3 : bob);
  drawTorso(ctx, x, y + 8, look);
  const blink = !sleep && Math.floor(t / 3100) % 7 === 0 && (t % 3100) < 130;
  const thinking = pose === "think" && Math.floor(t / 1400) % 2 === 0;
  drawHead(ctx, x, hy, look, facing, { blink, sleep, talk: pose === "talk" && Math.floor(t / 170) % 2 === 0, eyes: thinking ? 1 : 0 });
  if (facing === "down" && pose === "stuck") rect(ctx, x + 8, hy + 2, 1, 2, "#8fd3ff");   // sweat drop
}

// Walking, full body: 18 rows. facing "down" | "up" | "left" | "right".
export function drawWalker(ctx, x, y, look, facing, t, moving) {
  const step = moving ? Math.floor(t / 140) % 4 : 0;
  const legs = !moving ? LEGS.stand : (step % 2 === 0 ? LEGS.a : LEGS.b);
  const bounce = moving && step % 2 === 0 ? -1 : 0;
  rect(ctx, x + 1, y + 17, 8, 1, P.shadow);
  paint(ctx, x, y + 13, legs, { p: look.pants, o: "#1a1a20" });
  drawTorso(ctx, x, y + 8 + bounce, look);
  if (moving) {   // arms swing
    const sw = step < 2 ? 1 : -1;
    rect(ctx, x, y + 10 + bounce + sw, 1, 2, look.skin);
    rect(ctx, x + 9, y + 10 + bounce - sw, 1, 2, look.skin);
  } else {
    rect(ctx, x, y + 12 + bounce, 1, 1, look.skin); rect(ctx, x + 9, y + 12 + bounce, 1, 1, look.skin);
  }
  const eyes = facing === "left" ? -1 : facing === "right" ? 1 : 0;
  drawHead(ctx, x, y + bounce, look, facing === "up" ? "up" : "down", { eyes, blink: Math.floor(t / 2900) % 6 === 0 && (t % 2900) < 120 });
}

export function drawHands(ctx, x, y, look, pose, t) {
  const f = Math.floor(t / 110) % 4;
  let l = 0, r = 0;
  if (pose === "type") { l = f === 0 || f === 2 ? -1 : 0; r = f === 1 || f === 3 ? -1 : 0; }
  rect(ctx, x + 1, y + l, 2, 2, look.skin);
  rect(ctx, x + 7, y + r, 2, 2, look.skin);
}

// A subagent: a tiny helper drone hovering by the desk.
export function drawDrone(ctx, x, y, color, t) {
  const by = y + Math.round(Math.sin(t / 260) * 1.5);
  rect(ctx, x + 1, y + 9, 5, 1, "rgba(0,0,0,0.22)");
  rect(ctx, x, by, 7, 4, "#dfe4ee"); rect(ctx, x + 1, by + 1, 5, 2, "#24283a");
  rect(ctx, x + 2, by + 1, 1, 1, color); rect(ctx, x + 4, by + 1, 1, 1, color);
  const spin = Math.floor(t / 60) % 2;
  rect(ctx, x - 1 + spin, by - 1, 3, 1, "#9aa3b5"); rect(ctx, x + 5 - spin, by - 1, 3, 1, "#9aa3b5");
  if (Math.floor(t / 400) % 2) rect(ctx, x + 3, by + 4, 1, 1, color);
}

// ------------------------------------------------------------------------------------------- furniture
export function drawChairFront(ctx, x, y) {     // seat back behind someone facing us
  rect(ctx, x, y, 14, 12, P.chair); rect(ctx, x + 1, y + 1, 12, 1, P.chairHi); rect(ctx, x, y + 11, 14, 1, P.chairDark);
}
export function drawChairBack(ctx, x, y) {      // chair seen from behind
  rect(ctx, x, y, 12, 9, P.chair); rect(ctx, x, y, 12, 1, P.chairHi); rect(ctx, x + 1, y + 9, 10, 2, P.chairDark);
  rect(ctx, x + 2, y + 11, 1, 1, "#1a1d29"); rect(ctx, x + 9, y + 11, 1, 1, "#1a1d29");
}

export function drawDeskIsland(ctx, x, y, w, h) {
  rect(ctx, x + 2, y + h, w - 4, 4, P.shadow);
  rect(ctx, x, y, w, h, P.deskTop);
  rect(ctx, x + 1, y, w - 2, 1, P.deskTopHi);
  rect(ctx, x, y + Math.floor(h / 2), w, 1, P.deskEdge);
  rect(ctx, x, y + h - 3, w, 3, P.deskEdge);
  rect(ctx, x, y + h - 1, w, 1, P.deskDark);
  rect(ctx, x + 2, y + h, 2, 3, P.deskDark); rect(ctx, x + w - 4, y + h, 2, 3, P.deskDark);
}

export function drawMonitorBack(ctx, x, y) {
  rect(ctx, x, y, 16, 10, P.monEdge); rect(ctx, x + 1, y + 1, 14, 8, P.mon); rect(ctx, x + 1, y + 1, 14, 1, P.monHi);
  rect(ctx, x + 7, y + 10, 2, 2, P.monEdge);
}

// What the screen shows tells you what the agent is doing.
export function drawMonitorFront(ctx, x, y, mode, color, t) {
  rect(ctx, x, y, 16, 11, P.monEdge);
  rect(ctx, x + 7, y + 11, 2, 1, P.monEdge); rect(ctx, x + 5, y + 12, 6, 1, P.monEdge);
  const sx = x + 1, sy = y + 1, sw = 14, sh = 8;
  switch (mode) {
    case "type": {
      rect(ctx, sx, sy, sw, sh, "#0d1522");
      const off = Math.floor(t / 150);
      const cols = ["#7ee787", "#79c0ff", "#d2a8ff", "#ffa657", "#e6edf3"];
      for (let i = 0; i < 4; i++) {
        const k = (off + i) * 7;
        rect(ctx, sx + 1 + ((k >> 2) % 3), sy + 1 + i * 2, Math.min(3 + (k % 9), sw - 2), 1, cols[(off + i) % cols.length]);
      }
      if (Math.floor(t / 400) % 2) rect(ctx, sx + 12, sy + 7, 1, 1, "#e6edf3");
      break;
    }
    case "read": {
      rect(ctx, sx, sy, sw, sh, "#e9edf2");
      const off = Math.floor(t / 500) % 4;
      for (let i = 0; i < 4; i++) rect(ctx, sx + 2, sy + 1 + i * 2, 7 + ((i + off) % 3) * 2, 1, "#8a94a6");
      rect(ctx, sx + 1, sy + 1 + (off % 4) * 2, 1, 1, color);
      break;
    }
    case "wait": {
      rect(ctx, sx, sy, sw, sh, "#121a2a");
      const p = Math.floor(t / 120) % 12;
      rect(ctx, sx + 1, sy + 4, 12, 2, "#2a3550"); rect(ctx, sx + 1, sy + 4, p + 1, 2, color);
      break;
    }
    case "think": case "delegate": {
      rect(ctx, sx, sy, sw, sh, "#1a1530");
      const p = Math.floor(t / 300) % 3;
      for (let i = 0; i < 3; i++) rect(ctx, sx + 3 + i * 3, sy + 4, 2, 2, i === p ? "#d2a8ff" : "#4b3f73");
      break;
    }
    case "talk": {
      rect(ctx, sx, sy, sw, sh, "#10202a");
      rect(ctx, sx + 1, sy + 1, 8, 3, "#2f6f8f"); rect(ctx, sx + 5, sy + 5, 8, 2, color);
      break;
    }
    case "sleep": rect(ctx, sx, sy, sw, sh, "#2a0f14"); rect(ctx, sx + 3, sy + 3, 8, 2, Math.floor(t / 900) % 2 ? "#7a2430" : "#5a1a24"); break;
    case "stuck":
      rect(ctx, sx, sy, sw, sh, "#2a1a08");
      if (Math.floor(t / 500) % 2) { rect(ctx, sx + 6, sy + 1, 2, 4, "#ffb020"); rect(ctx, sx + 6, sy + 6, 2, 1, "#ffb020"); }
      break;
    case "idle": {
      rect(ctx, sx, sy, sw, sh, "#0b0e15");
      const bx = Math.abs((Math.floor(t / 140) % 22) - 11), by = Math.abs((Math.floor(t / 190) % 12) - 6);
      rect(ctx, sx + Math.min(bx, 11), sy + Math.min(by, 6), 3, 2, shade(color, 0.85));
      break;
    }
    default: rect(ctx, sx, sy, sw, sh, P.screenOff); rect(ctx, sx + 1, sy + 1, 3, 1, "#1d2130");
  }
}

export function drawKeyboard(ctx, x, y) { rect(ctx, x, y, 10, 2, "#2a2f40"); rect(ctx, x + 1, y, 8, 1, "#3d4459"); }

export function drawMug(ctx, x, y, t, steam, color = P.white) {
  rect(ctx, x, y, 3, 3, color); rect(ctx, x + 3, y + 1, 1, 1, color);
  if (steam) {
    const s = Math.floor(t / 330) % 3;
    rect(ctx, x + 1, y - 2 - s, 1, 1, "rgba(255,255,255,0.55)");
    if (s === 1) rect(ctx, x + 2, y - 4, 1, 1, "rgba(255,255,255,0.35)");
  }
}

export function drawDeskLamp(ctx, x, y, on) {
  rect(ctx, x, y + 6, 5, 1, "#2a2f40"); rect(ctx, x + 2, y + 1, 1, 5, "#3a4052");
  rect(ctx, x, y, 5, 2, on ? "#ffd27a" : "#4a5168");
}

export function drawPlant(ctx, x, y, kind = 0) {
  if (kind === 1) {                    // tall snake plant
    rect(ctx, x + 1, y + 12, 8, 6, "#3b3f52"); rect(ctx, x + 1, y + 12, 8, 1, "#50566e");
    for (let i = 0; i < 4; i++) rect(ctx, x + 2 + i * 2, y + 2 + (i % 2) * 3, 1, 10 - (i % 2) * 3, i % 2 ? P.plantHi : P.plant);
    return;
  }
  if (kind === 2) {                    // round bush
    rect(ctx, x + 2, y + 9, 6, 5, P.pot); rect(ctx, x + 2, y + 9, 6, 1, P.potHi);
    rect(ctx, x, y + 2, 10, 7, P.plant); rect(ctx, x + 2, y, 6, 3, P.plant); rect(ctx, x + 2, y + 2, 3, 2, P.plantHi);
    rect(ctx, x + 6, y + 5, 2, 2, P.plantDark);
    return;
  }
  rect(ctx, x + 2, y + 9, 6, 5, P.pot); rect(ctx, x + 2, y + 9, 6, 1, P.potHi);
  rect(ctx, x + 4, y + 1, 2, 8, P.plantDark);
  rect(ctx, x, y + 3, 4, 3, P.plant); rect(ctx, x + 6, y + 2, 4, 3, P.plant); rect(ctx, x + 3, y, 4, 3, P.plantHi);
  rect(ctx, x + 1, y + 6, 3, 2, P.plantDark);
}

export function drawRack(ctx, x, y, h, state, t, seed) {
  rect(ctx, x + 2, y + h, 16, 3, P.shadow);
  rect(ctx, x, y, 18, h, "#151824"); rect(ctx, x + 1, y + 1, 16, h - 2, "#1f2332"); rect(ctx, x + 1, y + 1, 16, 1, "#2d3246");
  const rows = Math.floor((h - 4) / 5);
  for (let i = 0; i < rows; i++) {
    const ry = y + 3 + i * 5;
    rect(ctx, x + 2, ry, 14, 3, "#2a2f42");
    let c = "#3a3f52";
    if (state === "active") c = ((hashOf(seed + i) + Math.floor(t / (170 + i * 37))) % 3) ? "#38e07b" : "#1c6b3d";
    else if (state === "failed") c = Math.floor(t / 280) % 2 ? "#ff4d5e" : "#6b1d26";
    else if (state === "activating") c = "#ffb020";
    rect(ctx, x + 13, ry + 1, 2, 1, c);
    rect(ctx, x + 3, ry + 1, 6, 1, "#3a4058");
    if (state === "active" && (hashOf(seed + "b" + i) + Math.floor(t / 90)) % 7 === 0) rect(ctx, x + 11, ry + 1, 1, 1, "#79c0ff");
  }
}

export function drawCouch(ctx, x, y, color) {
  rect(ctx, x + 2, y + 15, 44, 2, P.shadow);
  rect(ctx, x, y, 48, 6, shade(color, 0.85)); rect(ctx, x, y + 6, 48, 8, color); rect(ctx, x + 1, y + 6, 46, 1, shade(color, 1.12));
  rect(ctx, x, y + 2, 4, 12, shade(color, 0.72)); rect(ctx, x + 44, y + 2, 4, 12, shade(color, 0.72));
  rect(ctx, x + 23, y + 7, 1, 6, shade(color, 0.8));
  rect(ctx, x + 6, y + 3, 6, 4, "#f2d16b"); rect(ctx, x + 36, y + 3, 6, 4, "#7fb8e6");   // cushions
}

export function drawBeanBag(ctx, x, y, color) {
  rect(ctx, x + 1, y + 9, 14, 2, P.shadow);
  rect(ctx, x + 2, y, 12, 9, color); rect(ctx, x, y + 3, 16, 6, color); rect(ctx, x + 3, y + 1, 6, 2, shade(color, 1.2));
}

export function drawCoffeeMachine(ctx, x, y, t) {
  rect(ctx, x, y, 12, 16, "#2a2d38"); rect(ctx, x + 1, y + 1, 10, 4, "#454a5c");
  rect(ctx, x + 2, y + 2, 2, 1, Math.floor(t / 700) % 2 ? "#ff6b4a" : "#7a2a1d");
  rect(ctx, x + 6, y + 2, 4, 1, "#79c0ff");
  rect(ctx, x + 3, y + 7, 6, 5, "#12141a");
  drawMug(ctx, x + 4, y + 9, t, true);
  rect(ctx, x, y + 16, 12, 1, "#181a22");
}

export function drawVending(ctx, x, y, t) {
  rect(ctx, x, y, 16, 24, "#b33a3a"); rect(ctx, x + 1, y + 1, 10, 20, "#1b1e2a");
  const cols = ["#ffd24a", "#79c0ff", "#7ee787", "#ff8fb1"];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) rect(ctx, x + 2 + c * 3, y + 2 + r * 5, 2, 3, cols[(r + c) % 4]);
  rect(ctx, x + 12, y + 3, 3, 6, "#2a2d38"); rect(ctx, x + 12, y + 11, 3, 2, Math.floor(t / 1200) % 2 ? "#7ee787" : "#2f6f3f");
  rect(ctx, x + 2, y + 21, 8, 2, "#0d0f15");
}

export function drawArcade(ctx, x, y, t) {
  rect(ctx, x, y, 14, 22, "#5b2a86"); rect(ctx, x + 1, y + 1, 12, 2, "#ff4fd8");
  rect(ctx, x + 2, y + 4, 10, 7, "#0b0d14");
  const p = Math.floor(t / 200) % 8;
  rect(ctx, x + 3 + p, y + 7, 1, 1, "#ffe14d"); rect(ctx, x + 4, y + 9, 6, 1, "#39d0ff");
  if (p % 3 === 0) rect(ctx, x + 10 - p % 6, y + 5, 1, 1, "#ff4d5e");
  rect(ctx, x + 2, y + 13, 10, 3, "#3e1d5e");
  rect(ctx, x + 4, y + 14, 1, 1, "#ff4d5e"); rect(ctx, x + 8, y + 14, 1, 1, "#39d0ff");
}

export function drawAquarium(ctx, x, y, t) {
  rect(ctx, x, y + 14, 30, 6, "#3b2a1e"); rect(ctx, x, y + 14, 30, 1, "#5a4030");
  rect(ctx, x, y, 30, 14, "#1d4f7a"); rect(ctx, x + 1, y + 1, 28, 12, "#2a6ea3");
  rect(ctx, x + 1, y + 1, 28, 2, "#3f8cc4");
  rect(ctx, x + 1, y + 11, 28, 2, "#c9b27a");
  rect(ctx, x + 4, y + 6, 1, 5, "#3f9b5a"); rect(ctx, x + 5, y + 8, 1, 3, "#5cbf72"); rect(ctx, x + 24, y + 7, 1, 4, "#3f9b5a");
  const fish = [["#ff9f43", 0, 5], ["#ffd24a", 900, 8], ["#ff6b9a", 1800, 4]];
  for (const [c, off, fy] of fish) {
    const span = 22, ph = ((t + off) / 60) % (span * 2);
    const fx = ph < span ? ph : span * 2 - ph, dir = ph < span ? 1 : -1;
    rect(ctx, x + 3 + fx, y + fy, 3, 2, c); rect(ctx, x + 3 + fx + (dir > 0 ? -1 : 3), y + fy, 1, 2, shade(c, 0.75));
  }
  if (Math.floor(t / 500) % 3 === 0) rect(ctx, x + 20, y + 3 + (Math.floor(t / 160) % 6), 1, 1, "#cfefff");
}

export function drawWaterCooler(ctx, x, y, t) {
  rect(ctx, x + 1, y, 8, 8, "rgba(120,190,255,0.75)"); rect(ctx, x + 2, y + 1, 2, 5, "rgba(255,255,255,0.4)");
  rect(ctx, x, y + 8, 10, 12, "#dfe3ea"); rect(ctx, x + 3, y + 11, 4, 2, "#8a93a6");
  if (Math.floor(t / 2500) % 4 === 0) rect(ctx, x + 4, y + 2 + Math.floor(t / 250) % 5, 1, 1, "#ffffff");
}

export function drawBookshelf(ctx, x, y, w) {
  rect(ctx, x, y, w, 28, "#5a3d27"); rect(ctx, x, y, w, 1, "#6e4b31");
  const cols = ["#d9534f", "#5b8def", "#3fb68b", "#e5a50a", "#c678dd", "#56b6c2", "#ef8a5a"];
  for (let s = 0; s < 2; s++) {
    rect(ctx, x + 1, y + 2 + s * 13, w - 2, 11, "#3b2819");
    for (let i = 0; i * 3 < w - 4; i++) {
      const h = 6 + ((i * 7 + s * 3) % 5);
      rect(ctx, x + 2 + i * 3, y + 13 + s * 13 - h, 2, h, cols[(i + s * 2) % cols.length]);
    }
  }
}

export function drawWindow(ctx, x, y, w, h, sky, t, night) {
  rect(ctx, x - 2, y - 2, w + 4, h + 4, P.trim);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, sky[0]); g.addColorStop(1, sky[1]);
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  if (night) {
    for (let i = 0; i < 7; i++) {
      const sx = x + (hashOf("s" + i + x) % w), sy = y + (hashOf("y" + i + x) % Math.max(1, h - 8));
      if ((Math.floor(t / 900) + i) % 5) rect(ctx, sx, sy, 1, 1, "#fff8d0");
    }
    rect(ctx, x + w - 9, y + 3, 4, 4, "#f4f1d0"); rect(ctx, x + w - 8, y + 3, 3, 3, sky[0]);   // moon
    for (let i = 0; i < w; i += 5) {
      const bh = 5 + (hashOf("b" + (x + i)) % 10);
      rect(ctx, x + i, y + h - bh, 5, bh, "#121625");
      if (hashOf("l" + (x + i)) % 3 === 0) rect(ctx, x + i + 2, y + h - bh + 2, 1, 1, (Math.floor(t / 4000) + i) % 7 ? "#ffd76a" : "#121625");
      if (hashOf("m" + (x + i)) % 4 === 0) rect(ctx, x + i + 1, y + h - bh + 5, 1, 1, "#ffd76a");
    }
  } else {
    const cx = (Math.floor(t / 200) % (w + 24)) - 12;
    rect(ctx, x + cx, y + 5, 9, 2, "rgba(255,255,255,0.92)"); rect(ctx, x + cx + 2, y + 4, 5, 1, "rgba(255,255,255,0.92)");
    rect(ctx, x + w - 10, y + 3, 5, 5, "#fff2a8");
    for (let i = 0; i < w; i += 6) { const bh = 4 + (hashOf("b" + (x + i)) % 8); rect(ctx, x + i, y + h - bh, 6, bh, "rgba(60,80,115,0.55)"); }
  }
  rect(ctx, x + Math.floor(w / 2), y, 1, h, P.trim);
  rect(ctx, x, y + Math.floor(h / 2), w, 1, alpha("#5a6290", 0.6));
  rect(ctx, x - 3, y + h + 2, w + 6, 2, "#6c7398");
}

export function drawClock(ctx, x, y, date) {
  rect(ctx, x, y, 15, 15, "#2b2f3a"); rect(ctx, x + 1, y + 1, 13, 13, P.white);
  for (let i = 0; i < 12; i += 3) {
    const a = i / 12 * Math.PI * 2;
    rect(ctx, x + 7 + Math.round(Math.sin(a) * 5), y + 7 - Math.round(Math.cos(a) * 5), 1, 1, "#6b7080");
  }
  const cx = x + 7.5, cy = y + 7.5;
  const hr = (date.getHours() % 12 + date.getMinutes() / 60) / 12 * Math.PI * 2;
  const mn = date.getMinutes() / 60 * Math.PI * 2;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#1d1f27"; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(hr) * 3.2, cy - Math.cos(hr) * 3.2); ctx.stroke();
  ctx.strokeStyle = "#d94a4a"; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(mn) * 5, cy - Math.cos(mn) * 5); ctx.stroke();
}

export function drawPoster(ctx, x, y, kind) {
  rect(ctx, x - 1, y - 1, 20, 26, "#d7d2c4");
  if (kind === 0) {                 // rocket: ship it
    rect(ctx, x, y, 18, 24, "#1d2140");
    for (let i = 0; i < 5; i++) rect(ctx, x + (hashOf("st" + i) % 17), y + (hashOf("sy" + i) % 12), 1, 1, "#fff8d0");
    rect(ctx, x + 8, y + 5, 3, 9, "#e9edf2"); rect(ctx, x + 9, y + 3, 1, 2, "#e9edf2"); rect(ctx, x + 9, y + 7, 1, 2, "#5b8def");
    rect(ctx, x + 7, y + 12, 1, 3, "#d94a4a"); rect(ctx, x + 11, y + 12, 1, 3, "#d94a4a");
    rect(ctx, x + 9, y + 15, 1, 2, "#ffb020"); rect(ctx, x + 8, y + 17, 3, 1, "#ff6b4a");
    rect(ctx, x + 3, y + 20, 12, 2, "#ffd24a");
  } else if (kind === 1) {          // up-and-to-the-right chart
    rect(ctx, x, y, 18, 24, "#f4f1ea");
    rect(ctx, x + 2, y + 18, 14, 1, "#39404f"); rect(ctx, x + 2, y + 4, 1, 15, "#39404f");
    const ys = [15, 13, 14, 10, 8, 5];
    ys.forEach((v, i) => rect(ctx, x + 4 + i * 2, y + v, 2, 18 - v, i === ys.length - 1 ? "#3fb68b" : "#5b8def"));
    rect(ctx, x + 3, y + 21, 12, 1, "#9aa3b5");
  } else {                          // "be kind to robots" heart
    rect(ctx, x, y, 18, 24, "#ffe6ec");
    rect(ctx, x + 5, y + 6, 3, 2, "#e0476d"); rect(ctx, x + 10, y + 6, 3, 2, "#e0476d");
    rect(ctx, x + 4, y + 8, 10, 3, "#e0476d"); rect(ctx, x + 5, y + 11, 8, 2, "#e0476d"); rect(ctx, x + 7, y + 13, 4, 2, "#e0476d");
    rect(ctx, x + 3, y + 18, 12, 1, "#a04060"); rect(ctx, x + 5, y + 20, 8, 1, "#a04060");
  }
}

export function drawElevator(ctx, x, y, open, floorText, t) {
  rect(ctx, x - 3, y - 6, 32, 46, "#4a5070"); rect(ctx, x - 2, y - 5, 30, 1, "#6a7298");
  rect(ctx, x + 8, y - 4, 10, 4, "#0d0f15");
  rect(ctx, x + 10, y - 3, 6, 2, Math.floor(t / 800) % 2 ? "#ff8f3d" : "#a85a25");
  rect(ctx, x, y, 26, 40, "#151824");
  const gap = Math.round(open * 12);
  rect(ctx, x, y, 13 - gap, 40, "#9aa3b5"); rect(ctx, x + 13 + gap, y, 13 - gap, 40, "#9aa3b5");
  rect(ctx, x + 12 - gap, y, 1, 40, "#6b7488"); rect(ctx, x + 13 + gap, y, 1, 40, "#6b7488");
  rect(ctx, x + 1, y + 1, 11 - gap, 1, "#c4cad6"); rect(ctx, x + 14 + gap, y + 1, 11 - gap, 1, "#c4cad6");
  rect(ctx, x + 29, y + 16, 3, 6, "#2b2f3a"); rect(ctx, x + 30, y + 17, 1, 1, "#7ee787"); rect(ctx, x + 30, y + 20, 1, 1, "#ff6b6b");
}

export function drawFrame(ctx, x, y, w, h, gold) {
  rect(ctx, x - 2, y - 2, w + 4, h + 4, gold ? "#c9a227" : "#6b5a3e");
  rect(ctx, x - 1, y - 1, w + 2, h + 2, gold ? "#f0cf5a" : "#8a7553");
  rect(ctx, x, y, w, h, "#20243a");
}

// Desk upgrades earned by levelling up: a mug (3), a plant (6), a gold cup (10), a glowing desk edge (15), a pennant (20)
// and a gold trim (30). px/py are the pod's top-left; everything sits in the free band between the two monitor rows.
export function drawDeskPerks(ctx, px, py, level, color, t) {
  if (level >= 15) {
    ctx.globalAlpha = 0.8 + 0.2 * Math.sin(t / 700);
    rect(ctx, px + 10, py + 67, 108, 2, color);
    ctx.globalAlpha = 0.35; rect(ctx, px + 10, py + 69, 108, 2, color);
    ctx.globalAlpha = 1;
  }
  if (level >= 30) { rect(ctx, px + 11, py + 38, 106, 1, "#ffd24a"); rect(ctx, px + 10, py + 39, 1, 28, "#c9a227"); rect(ctx, px + 117, py + 39, 1, 28, "#c9a227"); }
  if (level >= 3) drawMug(ctx, px + 114, py + 46, t, false, color);
  if (level >= 6) {                         // a little succulent
    rect(ctx, px + 82, py + 47, 5, 3, "#a0522d"); rect(ctx, px + 82, py + 47, 5, 1, "#c06a3a");
    rect(ctx, px + 83, py + 45, 1, 2, "#3fb68b"); rect(ctx, px + 85, py + 44, 1, 3, "#3fb68b"); rect(ctx, px + 84, py + 45, 1, 1, "#56d39c");
  }
  if (level >= 10) {                        // a gold cup
    rect(ctx, px + 41, py + 43, 5, 1, "#fff0a8"); rect(ctx, px + 41, py + 44, 5, 2, "#ffd24a");
    rect(ctx, px + 40, py + 44, 1, 1, "#e0a92a"); rect(ctx, px + 46, py + 44, 1, 1, "#e0a92a");
    rect(ctx, px + 42, py + 46, 3, 1, "#e0a92a"); rect(ctx, px + 43, py + 47, 1, 2, "#b8841c"); rect(ctx, px + 42, py + 49, 3, 1, "#8a6a1c");
    if (Math.floor(t / 300) % 9 === 0) rect(ctx, px + 44, py + 42, 1, 1, "#ffffff");
  }
  if (level >= 20) {                        // a pennant in the seat's colour
    rect(ctx, px + 120, py + 36, 1, 12, "#d7d2c4");
    const wave = Math.floor(t / 400) % 2;
    rect(ctx, px + 121, py + 36, 5, 2, color); rect(ctx, px + 121, py + 38, 3 + wave, 1, color); rect(ctx, px + 121, py + 39, 1 + wave, 1, color);
  }
}

// A glass trophy cabinet with two shelves of cups, one per unlocked achievement (newest last).
export function drawCabinet(ctx, x, y, cups, t) {
  const w = 56, h = 30;
  rect(ctx, x - 1, y - 1, w + 2, h + 2, "#20150e");
  rect(ctx, x, y, w, h, "#4a3424"); rect(ctx, x + 2, y + 2, w - 4, h - 4, "#17131f");
  for (const sy of [y + 14, y + 27]) { rect(ctx, x + 2, sy, w - 4, 1, "#7a5a3c"); rect(ctx, x + 2, sy + 1, w - 4, 1, "#3a2818"); }
  cups.slice(-12).forEach((c, i) => {
    const cx = x + 5 + (i % 6) * 8, cy = (i < 6 ? y + 7 : y + 20);
    rect(ctx, cx, cy, 5, 1, "#fff0a8");
    rect(ctx, cx, cy + 1, 5, 2, "#ffd24a"); rect(ctx, cx - 1, cy + 1, 1, 1, "#e0a92a"); rect(ctx, cx + 5, cy + 1, 1, 1, "#e0a92a");
    rect(ctx, cx + 1, cy + 3, 3, 1, "#e0a92a"); rect(ctx, cx + 2, cy + 4, 1, 2, "#b8841c");
    rect(ctx, cx + 1, cy + 6, 3, 1, c.color || "#c9a227");
    if (c.glint && Math.floor(t / 260) % 6 === 0) { rect(ctx, cx + 3, cy - 2, 1, 1, "#ffffff"); rect(ctx, cx + 2, cy - 1, 3, 1, "#fff8c0"); }
  });
  ctx.globalAlpha = 0.09;                      // the glass
  for (let i = 0; i < 3; i++) rect(ctx, x + 8 + i * 17, y + 2, 2, h - 4, "#ffffff");
  ctx.globalAlpha = 1;
}

export function drawZ(ctx, x, y, t) {
  const phase = (t / 1600) % 1;
  for (let i = 0; i < 3; i++) {
    const p = (phase + i / 3) % 1;
    const zx = x + i * 3 + Math.round(p * 3), zy = y - Math.round(p * 10);
    ctx.globalAlpha = Math.max(0, 1 - p);
    rect(ctx, zx, zy, 3, 1, "#cfe3ff"); rect(ctx, zx + 1, zy + 1, 1, 1, "#cfe3ff"); rect(ctx, zx, zy + 2, 3, 1, "#cfe3ff");
    ctx.globalAlpha = 1;
  }
}

export function drawMark(ctx, x, y, kind, t) {   // "?" or "!" floating over a head
  if (Math.floor(t / 450) % 2 === 0) return;
  const c = kind === "!" ? "#ff4d5e" : "#ffb020";
  if (kind === "!") { rect(ctx, x + 1, y, 2, 4, c); rect(ctx, x + 1, y + 5, 2, 1, c); return; }
  rect(ctx, x, y, 3, 1, c); rect(ctx, x + 2, y + 1, 1, 2, c); rect(ctx, x + 1, y + 3, 1, 1, c); rect(ctx, x + 1, y + 5, 1, 1, c);
}

export function drawThought(ctx, x, y, t) {
  rect(ctx, x, y + 6, 1, 1, "#e8e4ff"); rect(ctx, x + 2, y + 4, 2, 2, "#e8e4ff");
  rect(ctx, x + 4, y - 2, 10, 6, "#e8e4ff"); rect(ctx, x + 5, y - 3, 8, 1, "#e8e4ff"); rect(ctx, x + 5, y + 4, 8, 1, "#e8e4ff");
  const p = Math.floor(t / 300) % 3;
  for (let i = 0; i < 3; i++) rect(ctx, x + 6 + i * 2 + i, y, 2, 2, i === p ? "#7c5cd6" : "#b9aee8");
}

export function drawBeacon(ctx, x, y, t, color = "#ff3b4e") {
  rect(ctx, x, y + 3, 5, 2, "#2a2d38");
  const on = Math.floor(t / 220) % 2;
  rect(ctx, x + 1, y, 3, 3, on ? color : shade(color, 0.45));
  if (on) rect(ctx, x + 2, y - 1, 1, 1, "#ffd0d6");
}

// Pixel, the office cat. mode: "walk" | "sit" | "sleep"; facing: 1 right, -1 left.
export function drawCat(ctx, x, y, mode, facing, t) {
  const fur = "#e9a35b", dark = "#b9773a", light = "#f6cf9c";
  const X = (dx) => (facing > 0 ? x + dx : x + 10 - dx);
  const px = (dx, dy, w, h, c) => { for (let i = 0; i < w; i++) rect(ctx, X(dx + i) - (facing > 0 ? 0 : 0), y + dy, 1, h, c); };
  rect(ctx, x + 1, y + 7, 9, 1, "rgba(0,0,0,0.25)");
  if (mode === "sleep") {
    px(1, 3, 8, 4, fur); px(2, 3, 2, 1, dark); px(6, 3, 2, 1, dark); px(7, 2, 3, 2, fur); px(8, 1, 1, 1, fur); px(9, 3, 1, 1, light);
    px(0, 5, 2, 1, fur); px(1, 6, 7, 1, dark);
    return;
  }
  const step = mode === "walk" ? Math.floor(t / 150) % 2 : 0;
  const tail = mode === "sit" ? Math.round(Math.sin(t / 400)) : 0;
  px(1, 2, 6, 3, fur); px(2, 2, 1, 1, dark); px(4, 2, 1, 1, dark);           // body + stripes
  px(6, 0, 3, 3, fur); px(6, 0, 1, 1, dark); px(8, 0, 1, 1, dark);           // head + ears
  px(7, 1, 1, 1, "#2a2420"); px(9, 2, 1, 1, light);                          // eye + muzzle
  px(0, 1 + tail, 1, 2, dark);                                               // tail
  if (mode === "sit") { px(2, 5, 1, 1, fur); px(5, 5, 1, 1, fur); }
  else { px(1 + step, 5, 1, 1, dark); px(4 - step, 5, 1, 1, dark); px(6 + step, 5, 1, 1, dark); }
}

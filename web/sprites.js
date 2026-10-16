// Pixel-art building blocks for the office floor. Everything is drawn with integer rects at logical
// resolution; the canvas is scaled up with smoothing off, so every "pixel" stays crisp.

export const P = {
  wall: "#3b4060", wallDark: "#2d3150", wainscot: "#272a42", trim: "#535a82",
  floorA: "#8a6a4b", floorB: "#80613f", floorLine: "#6c5034",
  carpet: "#5b3f63", carpetB: "#523859",
  tile: "#2a2e3c", tileB: "#252836", tileLine: "#1d2030",
  rug: "#3e6466", rugB: "#355a5c",
  meet: "#46506e", meetB: "#3f4864",
  deskTop: "#d2ab80", deskEdge: "#a47d55", deskLeg: "#6d5136",
  mon: "#1d2029", monEdge: "#383d4f", screenOff: "#11131a",
  chair: "#4b5270", chairDark: "#363b52",
  glass: "rgba(170,210,255,0.22)", glassEdge: "#9fc4e8",
  plant: "#3f9b5a", plantDark: "#2b7041", pot: "#b5643e",
  white: "#f4f1ea", black: "#14151c", shadow: "rgba(0,0,0,0.25)",
  skin: ["#f2c9a0", "#d9a57a", "#b57b52", "#8d5a3b", "#f6d5b8", "#6b4129"],
  hair: ["#2b1d14", "#5a3a22", "#a8652a", "#e0b34a", "#1f1f28", "#8c8c96", "#b5452f", "#3d2a5c"],
};

export function rect(ctx, x, y, w, h, c) {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

// Deterministic look per session id: same agent, same face, every refresh.
export function hashOf(str) {
  let h = 2166136261;
  for (let i = 0; i < (str || "").length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function lookFor(id, shirt) {
  const h = hashOf(id);
  return {
    skin: P.skin[h % P.skin.length],
    hair: P.hair[(h >>> 3) % P.hair.length],
    style: (h >>> 7) % 4,            // 0 short, 1 long, 2 bun, 3 spiky
    shirt,
    glasses: ((h >>> 11) % 5) === 0,
  };
}

const FRONT = [
  "...hhhh...",
  "..hhhhhh..",
  ".hhhhhhhh.",
  ".hssssssh.",
  ".ssessess.",
  ".ssssssss.",
  "..ssmmss..",
  "...ssss...",
  "..tttttt..",
  ".tttttttt.",
  "tttttttttt",
  "tttttttttt",
  "tttttttttt",
];
const BACK = [
  "...hhhh...",
  "..hhhhhh..",
  ".hhhhhhhh.",
  ".hhhhhhhh.",
  ".hhhhhhhh.",
  ".shhhhhhs.",
  "..ssssss..",
  "...ssss...",
  "..tttttt..",
  ".tttttttt.",
  "tttttttttt",
  "tttttttttt",
  "tttttttttt",
];

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * f)));
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}
export { shade };

// A seated person, upper body only (the desk hides the rest). facing: "down" shows the face, "up" the back.
// pose: "type" | "read" | "think" | "talk" | "idle" | "sleep" | "wait" | "stuck" | "delegate"
export function drawPerson(ctx, x, y, look, facing, pose, t) {
  const map = facing === "up" ? BACK : FRONT;
  const sleeping = pose === "sleep";
  const dy = sleeping && facing === "down" ? 3 : (pose === "idle" ? Math.round(Math.sin(t / 900) * 0.6) : 0);
  const cols = { h: look.hair, s: look.skin, e: P.black, m: shade(look.skin, 0.7), t: look.shirt };
  for (let r = 0; r < map.length; r++) {
    const row = map[r];
    for (let c = 0; c < row.length; c++) {
      let ch = row[c];
      if (ch === ".") continue;
      if (sleeping && facing === "down" && ch === "e") ch = "s";
      let col = cols[ch];
      if (ch === "t" && (c === 0 || c === 9)) col = shade(look.shirt, 0.8);
      const head = r < 8;
      rect(ctx, x + c, y + r + (head ? dy : 0), 1, 1, col);
    }
  }
  // hairstyles
  if (look.style === 1) {           // long hair falls past the ears
    for (let r = 3; r < 8; r++) { rect(ctx, x, y + r + dy, 1, 1, look.hair); rect(ctx, x + 9, y + r + dy, 1, 1, look.hair); }
  } else if (look.style === 2) {    // bun
    rect(ctx, x + 4, y - 2 + dy, 2, 2, look.hair);
  } else if (look.style === 3) {    // spikes
    rect(ctx, x + 2, y - 1 + dy, 1, 1, look.hair); rect(ctx, x + 5, y - 1 + dy, 1, 1, look.hair); rect(ctx, x + 7, y - 1 + dy, 1, 1, look.hair);
  }
  if (facing === "down") {
    if (sleeping) { rect(ctx, x + 3, y + 4 + dy, 1, 1, shade(look.skin, 0.6)); rect(ctx, x + 6, y + 4 + dy, 1, 1, shade(look.skin, 0.6)); }
    else if (pose === "think" && Math.floor(t / 1400) % 2 === 0) { rect(ctx, x + 3, y + 4, 1, 1, look.skin); rect(ctx, x + 6, y + 4, 1, 1, look.skin); rect(ctx, x + 3, y + 3, 1, 1, P.black); rect(ctx, x + 6, y + 3, 1, 1, P.black); }
    else if (Math.floor(t / 3100) % 9 === 0 && (t % 3100) < 140) { rect(ctx, x + 3, y + 4, 1, 1, look.skin); rect(ctx, x + 6, y + 4, 1, 1, look.skin); } // blink
    if (look.glasses && !sleeping) { rect(ctx, x + 2, y + 4 + dy, 3, 1, "#2b2b35"); rect(ctx, x + 5, y + 4 + dy, 3, 1, "#2b2b35"); rect(ctx, x + 3, y + 4 + dy, 1, 1, "#9fd3ff"); rect(ctx, x + 6, y + 4 + dy, 1, 1, "#9fd3ff"); }
    if (pose === "talk" && Math.floor(t / 180) % 2 === 0) rect(ctx, x + 4, y + 6, 2, 1, P.black);
    if (pose === "stuck") rect(ctx, x + 4, y + 6, 2, 1, shade(look.skin, 0.5));
  }
}

// Hands on the keyboard, animated while typing.
export function drawHands(ctx, x, y, look, pose, t) {
  const f = Math.floor(t / 110) % 4;
  let l = 0, r = 0;
  if (pose === "type") { l = f === 0 || f === 2 ? -1 : 0; r = f === 1 || f === 3 ? -1 : 0; }
  rect(ctx, x + 1, y + l, 2, 2, look.skin);
  rect(ctx, x + 7, y + r, 2, 2, look.skin);
}

export function drawChairBack(ctx, x, y) {      // chair seen from behind (person faces up, away from us)
  rect(ctx, x, y, 12, 9, P.chair);
  rect(ctx, x, y, 12, 1, P.chairDark);
  rect(ctx, x + 1, y + 9, 10, 2, P.chairDark);
}
export function drawChairFront(ctx, x, y) {     // chair back visible behind a person facing us
  rect(ctx, x, y, 14, 12, P.chair);
  rect(ctx, x + 1, y + 1, 12, 1, shade(P.chair, 1.2));
}

export function drawDeskIsland(ctx, x, y, w, h) {
  rect(ctx, x + 2, y + h, w - 4, 3, P.shadow);
  rect(ctx, x, y, w, h, P.deskTop);
  rect(ctx, x, y + Math.floor(h / 2), w, 1, P.deskEdge);
  rect(ctx, x, y + h - 2, w, 2, P.deskEdge);
  rect(ctx, x + 1, y, w - 2, 1, shade(P.deskTop, 1.08));
}

export function drawMonitorBack(ctx, x, y, glow) {
  rect(ctx, x, y, 16, 10, P.monEdge);
  rect(ctx, x + 1, y + 1, 14, 8, P.mon);
  rect(ctx, x + 7, y + 10, 2, 2, P.monEdge);
  if (glow) { rect(ctx, x - 1, y - 1, 18, 1, glow); }
}

// Screen content tells you the mode at a glance.
export function drawMonitorFront(ctx, x, y, mode, color, t) {
  rect(ctx, x, y, 16, 11, P.monEdge);
  const sx = x + 1, sy = y + 1, sw = 14, sh = 8;
  rect(ctx, x + 7, y + 11, 2, 1, P.monEdge);
  switch (mode) {
    case "type": {
      rect(ctx, sx, sy, sw, sh, "#0f1724");
      const off = Math.floor(t / 160);
      const cols = ["#7ee787", "#79c0ff", "#d2a8ff", "#ffa657", "#e6edf3"];
      for (let i = 0; i < 4; i++) {
        const k = (off + i) * 7;
        const w = 3 + (k % 9);
        rect(ctx, sx + 1 + ((k >> 2) % 3), sy + 1 + i * 2, Math.min(w, sw - 2), 1, cols[(off + i) % cols.length]);
      }
      if (Math.floor(t / 400) % 2) rect(ctx, sx + 12, sy + 7, 1, 1, "#e6edf3");
      break;
    }
    case "read": {
      rect(ctx, sx, sy, sw, sh, "#e9edf2");
      const off = Math.floor(t / 600) % 3;
      for (let i = 0; i < 4; i++) rect(ctx, sx + 2, sy + 1 + i * 2, 8 + ((i + off) % 3) * 1, 1, "#8a94a6");
      break;
    }
    case "wait": {
      rect(ctx, sx, sy, sw, sh, "#151b2a");
      const p = Math.floor(t / 120) % 12;
      rect(ctx, sx + 1, sy + 4, 12, 2, "#2a3550");
      rect(ctx, sx + 1, sy + 4, p + 1, 2, color);
      break;
    }
    case "think": {
      rect(ctx, sx, sy, sw, sh, "#1b1630");
      const p = Math.floor(t / 300) % 3;
      for (let i = 0; i < 3; i++) rect(ctx, sx + 3 + i * 3, sy + 4, 2, 2, i === p ? "#d2a8ff" : "#4b3f73");
      break;
    }
    case "sleep": {
      rect(ctx, sx, sy, sw, sh, "#2a0f14");
      rect(ctx, sx + 3, sy + 3, 8, 2, "#7a2430");
      break;
    }
    case "stuck": {
      rect(ctx, sx, sy, sw, sh, "#2a1a08");
      if (Math.floor(t / 500) % 2) { rect(ctx, sx + 6, sy + 1, 2, 4, "#ffb020"); rect(ctx, sx + 6, sy + 6, 2, 1, "#ffb020"); }
      break;
    }
    case "idle": {
      rect(ctx, sx, sy, sw, sh, "#0c0f16");
      const bx = Math.abs((Math.floor(t / 140) % 22) - 11), by = Math.abs((Math.floor(t / 190) % 12) - 6);
      rect(ctx, sx + Math.min(bx, 11), sy + Math.min(by, 6), 3, 2, shade(color, 0.8));
      break;
    }
    default:
      rect(ctx, sx, sy, sw, sh, P.screenOff);
  }
}

export function drawMug(ctx, x, y, t, steam) {
  rect(ctx, x, y, 3, 3, P.white);
  rect(ctx, x + 3, y + 1, 1, 1, P.white);
  if (steam) {
    const s = Math.floor(t / 350) % 3;
    rect(ctx, x + 1, y - 2 - s, 1, 1, "rgba(255,255,255,0.55)");
  }
}

export function drawZ(ctx, x, y, t) {
  const phase = (t / 1600) % 1;
  for (let i = 0; i < 3; i++) {
    const p = (phase + i / 3) % 1;
    const zx = x + i * 3 + Math.round(p * 3), zy = y - Math.round(p * 10);
    const a = 1 - p;
    ctx.globalAlpha = Math.max(0, a);
    rect(ctx, zx, zy, 3, 1, "#cfe3ff"); rect(ctx, zx + 1, zy + 1, 1, 1, "#cfe3ff"); rect(ctx, zx, zy + 2, 3, 1, "#cfe3ff");
    ctx.globalAlpha = 1;
  }
}

export function drawPlant(ctx, x, y, big) {
  const s = big ? 1.4 : 1;
  rect(ctx, x + 2 * s, y + 9 * s, 6 * s, 5 * s, P.pot);
  rect(ctx, x + 2 * s, y + 9 * s, 6 * s, 1, "#d07a52");
  rect(ctx, x + 4 * s, y + 1 * s, 2 * s, 8 * s, P.plantDark);
  rect(ctx, x, y + 3 * s, 4 * s, 3 * s, P.plant);
  rect(ctx, x + 6 * s, y + 2 * s, 4 * s, 3 * s, P.plant);
  rect(ctx, x + 3 * s, y, 4 * s, 3 * s, P.plant);
  rect(ctx, x + 1 * s, y + 6 * s, 3 * s, 2 * s, P.plantDark);
}

export function drawRack(ctx, x, y, h, state, t, seed) {
  rect(ctx, x + 2, y + h, 16, 2, P.shadow);
  rect(ctx, x, y, 18, h, "#1a1d27");
  rect(ctx, x + 1, y + 1, 16, h - 2, "#232736");
  const rows = Math.floor((h - 4) / 5);
  for (let i = 0; i < rows; i++) {
    const ry = y + 3 + i * 5;
    rect(ctx, x + 2, ry, 14, 3, "#2e3346");
    let c = "#3a3f52";
    if (state === "active") c = ((hashOf(seed + i) + Math.floor(t / (180 + i * 40))) % 3) ? "#38e07b" : "#1c6b3d";
    else if (state === "failed") c = Math.floor(t / 300) % 2 ? "#ff4d5e" : "#6b1d26";
    else if (state === "activating") c = "#ffb020";
    rect(ctx, x + 13, ry + 1, 2, 1, c);
    rect(ctx, x + 3, ry + 1, 6, 1, "#3d4359");
  }
}

export function drawCouch(ctx, x, y, color) {
  rect(ctx, x + 2, y + 14, 40, 2, P.shadow);
  rect(ctx, x, y, 44, 6, shade(color, 0.85));
  rect(ctx, x, y + 6, 44, 8, color);
  rect(ctx, x, y + 2, 4, 12, shade(color, 0.75));
  rect(ctx, x + 40, y + 2, 4, 12, shade(color, 0.75));
  rect(ctx, x + 21, y + 7, 1, 6, shade(color, 0.8));
}

export function drawCoffeeMachine(ctx, x, y, t) {
  rect(ctx, x, y, 12, 16, "#2c2f3a");
  rect(ctx, x + 1, y + 1, 10, 4, "#454a5c");
  rect(ctx, x + 2, y + 2, 2, 1, Math.floor(t / 700) % 2 ? "#ff6b4a" : "#7a2a1d");
  rect(ctx, x + 3, y + 7, 6, 5, "#16181f");
  drawMug(ctx, x + 4, y + 9, t, true);
  rect(ctx, x, y + 16, 12, 1, "#1d1f27");
}

export function drawArcade(ctx, x, y, t) {
  rect(ctx, x, y, 14, 22, "#5b2a86");
  rect(ctx, x + 1, y + 1, 12, 2, "#ff4fd8");
  rect(ctx, x + 2, y + 4, 10, 7, "#0b0d14");
  const p = Math.floor(t / 200) % 8;
  rect(ctx, x + 3 + p, y + 7, 1, 1, "#ffe14d");
  rect(ctx, x + 4, y + 9, 6, 1, "#39d0ff");
  rect(ctx, x + 2, y + 13, 10, 3, "#3e1d5e");
  rect(ctx, x + 4, y + 14, 1, 1, "#ff4d5e"); rect(ctx, x + 8, y + 14, 1, 1, "#39d0ff");
}

export function drawWaterCooler(ctx, x, y, t) {
  rect(ctx, x + 1, y, 8, 8, "rgba(120,190,255,0.75)");
  rect(ctx, x + 2, y + 1, 2, 5, "rgba(255,255,255,0.4)");
  rect(ctx, x, y + 8, 10, 12, "#dfe3ea");
  rect(ctx, x + 3, y + 11, 4, 2, "#8a93a6");
  if (Math.floor(t / 2500) % 4 === 0) rect(ctx, x + 4, y + 2 + Math.floor(t / 250) % 5, 1, 1, "#ffffff");
}

export function drawBookshelf(ctx, x, y, w) {
  rect(ctx, x, y, w, 26, "#5a3d27");
  const cols = ["#d9534f", "#5b8def", "#3fb68b", "#e5a50a", "#c678dd", "#56b6c2", "#ef8a5a"];
  for (let s = 0; s < 2; s++) {
    rect(ctx, x + 1, y + 2 + s * 12, w - 2, 10, "#3b2819");
    for (let i = 0; i * 3 < w - 4; i++) {
      const h = 6 + ((i * 7 + s * 3) % 4);
      rect(ctx, x + 2 + i * 3, y + 12 + s * 12 - h, 2, h, cols[(i + s * 2) % cols.length]);
    }
  }
}

export function drawWindow(ctx, x, y, w, h, sky, t, night) {
  rect(ctx, x - 1, y - 1, w + 2, h + 2, P.trim);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, sky[0]); g.addColorStop(1, sky[1]);
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  if (night) {
    for (let i = 0; i < 6; i++) {
      const sx = x + (hashOf("s" + i + x) % w), sy = y + (hashOf("y" + i + x) % (h - 6));
      if ((Math.floor(t / 900) + i) % 5) rect(ctx, sx, sy, 1, 1, "#fff8d0");
    }
    // city skyline with lit windows
    for (let i = 0; i < w; i += 5) {
      const bh = 4 + (hashOf("b" + (x + i)) % 9);
      rect(ctx, x + i, y + h - bh, 5, bh, "#141826");
      if (hashOf("l" + (x + i)) % 3 === 0) rect(ctx, x + i + 2, y + h - bh + 2, 1, 1, "#ffd76a");
    }
  } else {
    const cx = (Math.floor(t / 220) % (w + 20)) - 10;
    rect(ctx, x + cx, y + 4, 8, 2, "rgba(255,255,255,0.9)"); rect(ctx, x + cx + 2, y + 3, 4, 1, "rgba(255,255,255,0.9)");
    for (let i = 0; i < w; i += 6) { const bh = 3 + (hashOf("b" + (x + i)) % 7); rect(ctx, x + i, y + h - bh, 6, bh, "rgba(70,90,120,0.55)"); }
  }
  rect(ctx, x + Math.floor(w / 2), y, 1, h, P.trim);
  rect(ctx, x, y + h, w, 2, "#6c7398");
}

export function drawClock(ctx, x, y, date) {
  rect(ctx, x, y, 13, 13, P.white);
  rect(ctx, x, y, 13, 1, "#2b2f3a"); rect(ctx, x, y + 12, 13, 1, "#2b2f3a");
  rect(ctx, x, y, 1, 13, "#2b2f3a"); rect(ctx, x + 12, y, 1, 13, "#2b2f3a");
  const cx = x + 6.5, cy = y + 6.5;
  const hr = (date.getHours() % 12 + date.getMinutes() / 60) / 12 * Math.PI * 2;
  const mn = date.getMinutes() / 60 * Math.PI * 2;
  ctx.strokeStyle = "#1d1f27"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(hr) * 3, cy - Math.cos(hr) * 3); ctx.stroke();
  ctx.strokeStyle = "#d94a4a";
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(mn) * 5, cy - Math.cos(mn) * 5); ctx.stroke();
}

export function drawLampGlow(ctx, x, y, r, color, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color.replace("ALPHA", a)); g.addColorStop(1, color.replace("ALPHA", 0));
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

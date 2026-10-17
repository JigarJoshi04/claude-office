// A room per character: the shell (floor, walls, door) and decor that matches each personality. Static parts are drawn
// once into the background; live parts (steam, a ticking stopwatch, a blinking flowchart) are drawn every frame.
import * as S from "./sprites.js";

const r = S.rect;
export const BACK = 40;                         // height of a room's back wall
export const DOOR_W = 24;

// Floor, walls, a back-wall accent in the seat colour, and a door in the front wall.
export function drawRoomShell(c, room, color) {
  const { x, y, w, h } = room;
  // floor: soft carpet tiles tinted with the seat colour
  for (let yy = y + BACK; yy < y + h - 4; yy += 6) {
    const odd = ((yy - y) / 6 | 0) % 2;
    r(c, x, yy, w, 6, odd ? "#3a3448" : "#37314a");
  }
  c.globalAlpha = 0.16; r(c, x, y + BACK, w, h - BACK - 4, color); c.globalAlpha = 1;
  // a rug under the desks
  c.globalAlpha = 0.22; r(c, x + 34, y + BACK + 18 + (room.dy || 0), w - 68, 74, S.shade(color, 0.7)); c.globalAlpha = 1;
  // back wall
  r(c, x, y, w, BACK, "#2c3150");
  for (let xx = x + 6; xx < x + w; xx += 24) r(c, xx, y + 4, 1, BACK - 12, "#323858");
  r(c, x, y, w, 3, S.shade(color, 0.85));                       // the room's colour along the top
  r(c, x, y + BACK - 8, w, 8, "#232741"); r(c, x, y + BACK - 9, w, 1, "#4d5480");
  r(c, x, y + BACK, w, 2, "rgba(0,0,0,0.25)");
  // side walls
  r(c, x, y, 2, h, "#1b1e31"); r(c, x + w - 2, y, 2, h, "#1b1e31");
  // front wall with a door in the middle
  const dx = x + (w - DOOR_W) / 2;
  r(c, x, y + h - 4, dx - x, 4, "#1b1e31"); r(c, dx + DOOR_W, y + h - 4, x + w - dx - DOOR_W, 4, "#1b1e31");
  r(c, dx - 2, y + h - 6, 2, 6, "#4d5480"); r(c, dx + DOOR_W, y + h - 6, 2, 6, "#4d5480");
  r(c, dx, y + h - 4, DOOR_W, 4, S.shade(color, 0.55));           // door mat
}

export function windowRect(room) { return { x: room.x + room.w - 62, y: room.y + 8, w: 46, h: 22 }; }

// ------------------------------------------------------------------------------------------- decor
// Each piece hangs on the back wall (x+14..x+110, y+6..y+34) or stands in the left margin (x+6..x+28, y+46..y+118).
const STATIC = {
  "The Orchestrator"(c, x, y) {                                    // a planning whiteboard with a flowchart
    r(c, x + 14, y + 6, 74, 28, "#9aa3b5"); r(c, x + 15, y + 7, 72, 26, "#f6f7f9");
    const box = (bx, by, col) => { r(c, x + bx, y + by, 12, 6, col); r(c, x + bx + 1, y + by + 1, 10, 4, S.shade(col, 1.25)); };
    box(19, 10, "#5b8def"); box(40, 10, "#3fb68b"); box(61, 10, "#e5a50a"); box(40, 22, "#c678dd"); box(61, 22, "#5b8def");
    r(c, x + 31, y + 12, 9, 1, "#39404f"); r(c, x + 52, y + 12, 9, 1, "#39404f"); r(c, x + 46, y + 16, 1, 6, "#39404f"); r(c, x + 52, y + 24, 9, 1, "#39404f");
    r(c, x + 16, y + 34, 22, 2, "#c94f4f"); r(c, x + 44, y + 34, 8, 2, "#3d6fd6");
    // a flip chart in the margin
    r(c, x + 10, y + 50, 1, 34, "#5a4030"); r(c, x + 24, y + 50, 1, 34, "#5a4030");
    r(c, x + 9, y + 48, 18, 22, "#f4f1ea"); r(c, x + 11, y + 52, 10, 1, "#5b8def"); r(c, x + 11, y + 56, 13, 1, "#9aa3b5"); r(c, x + 11, y + 60, 8, 1, "#9aa3b5");
  },
  "The Builder"(c, x, y) {                                        // a tool pegboard, a workbench, a hard hat
    r(c, x + 14, y + 6, 74, 28, "#8a6a46"); r(c, x + 15, y + 7, 72, 26, "#a57f55");
    for (let i = 0; i < 9; i++) for (let j = 0; j < 3; j++) r(c, x + 19 + i * 8, y + 11 + j * 8, 1, 1, "#6d5136");
    r(c, x + 22, y + 10, 2, 16, "#5a4030"); r(c, x + 19, y + 9, 8, 4, "#9aa3b5");               // hammer
    r(c, x + 38, y + 10, 2, 16, "#9aa3b5"); r(c, x + 36, y + 9, 6, 3, "#9aa3b5"); r(c, x + 37, y + 10, 4, 1, "#a57f55");   // wrench
    r(c, x + 52, y + 10, 18, 7, "#c4cad6"); r(c, x + 52, y + 16, 18, 1, "#6b7488"); r(c, x + 70, y + 9, 5, 9, "#b5452f");  // saw
    r(c, x + 56, y + 22, 22, 6, "#e5a50a"); r(c, x + 56, y + 22, 22, 1, "#ffd24a");             // tape measure / level
    // workbench + toolbox in the margin
    r(c, x + 6, y + 84, 24, 4, "#a07a54"); r(c, x + 7, y + 88, 2, 12, "#7e5e40"); r(c, x + 27, y + 88, 2, 12, "#7e5e40");
    r(c, x + 9, y + 76, 14, 8, "#d94a4a"); r(c, x + 9, y + 76, 14, 2, "#ff6b6b"); r(c, x + 14, y + 74, 4, 2, "#2a2d38");
    r(c, x + 9, y + 50, 14, 6, "#ffd24a"); r(c, x + 8, y + 55, 16, 2, "#e5a50a"); r(c, x + 15, y + 48, 2, 2, "#2a2d38");   // hard hat on a hook
  },
  "The Investigator"(c, x, y) {                                    // a corkboard with photos and red string
    r(c, x + 14, y + 6, 74, 28, "#7a5634"); r(c, x + 15, y + 7, 72, 26, "#c49a62");
    const pins = [[22, 11], [44, 9], [66, 12], [30, 23], [56, 24], [76, 21]];
    for (const [px, py] of pins) { r(c, x + px - 4, y + py, 9, 7, "#f4f1ea"); r(c, x + px - 3, y + py + 1, 7, 4, ["#5b8def", "#3fb68b", "#9aa3b5", "#e0b089"][(px + py) % 4]); }
    c.strokeStyle = "#d33"; c.lineWidth = 0.8; c.beginPath();
    c.moveTo(x + 22, y + 11); c.lineTo(x + 44, y + 9); c.lineTo(x + 56, y + 24); c.lineTo(x + 30, y + 23); c.lineTo(x + 22, y + 11);
    c.moveTo(x + 44, y + 9); c.lineTo(x + 66, y + 12); c.lineTo(x + 76, y + 21); c.stroke();
    for (const [px, py] of pins) r(c, x + px, y + py - 1, 2, 2, "#ff4d5e");
    // a filing cabinet in the margin
    r(c, x + 8, y + 64, 18, 34, "#6b7488"); r(c, x + 9, y + 65, 16, 32, "#8a93a6");
    for (let i = 0; i < 3; i++) { r(c, x + 9, y + 66 + i * 11, 16, 1, "#6b7488"); r(c, x + 15, y + 70 + i * 11, 4, 1, "#c4cad6"); }
    r(c, x + 12, y + 60, 10, 4, "#f4f1ea"); r(c, x + 13, y + 61, 6, 1, "#9aa3b5");            // a case file on top
  },
  "The Perfectionist"(c, x, y) {                                   // three aligned frames, a bonsai, a neat shelf
    for (let i = 0; i < 3; i++) {
      const fx = x + 16 + i * 26;
      r(c, fx, y + 8, 20, 22, "#c9a227"); r(c, fx + 1, y + 9, 18, 20, "#f4f1ea");
      r(c, fx + 4, y + 13, 12, 1, "#39404f"); r(c, fx + 4, y + 17, 10, 1, "#9aa3b5"); r(c, fx + 4, y + 20, 12, 1, "#9aa3b5");
      r(c, fx + 8, y + 24, 4, 3, "#c94f4f");
    }
    // a bonsai on a pedestal
    r(c, x + 10, y + 86, 14, 14, "#4a5070"); r(c, x + 10, y + 86, 14, 1, "#6a7298");
    r(c, x + 11, y + 80, 12, 6, "#5a4030"); r(c, x + 16, y + 70, 2, 10, "#5a4030"); r(c, x + 13, y + 72, 4, 1, "#5a4030");
    r(c, x + 8, y + 64, 18, 7, "#3f9b5a"); r(c, x + 11, y + 61, 10, 4, "#5cbf72"); r(c, x + 9, y + 68, 6, 3, "#2b7041");
  },
  "The Night Owl"(c, x, y) {                                       // a moon poster, string lights, an owl
    r(c, x + 14, y + 6, 34, 28, "#d7d2c4"); r(c, x + 15, y + 7, 32, 26, "#141a3a");
    for (let i = 0; i < 7; i++) r(c, x + 17 + (S.hashOf("ow" + i) % 28), y + 9 + (S.hashOf("oy" + i) % 20), 1, 1, "#fff8d0");
    // a crescent moon: a pale disc with a night-coloured disc laid over its right side
    r(c, x + 25, y + 13, 10, 12, "#ffe8a3"); r(c, x + 24, y + 15, 12, 8, "#ffe8a3"); r(c, x + 27, y + 12, 6, 14, "#ffe8a3");
    r(c, x + 29, y + 12, 10, 12, "#141a3a"); r(c, x + 28, y + 14, 12, 8, "#141a3a"); r(c, x + 31, y + 11, 6, 14, "#141a3a");
    r(c, x + 54, y + 10, 40, 1, "#39404f");                                                       // the string for the lights
    // an owl plush on a side table
    r(c, x + 8, y + 88, 18, 3, "#7e5e40"); r(c, x + 10, y + 91, 2, 9, "#5a4030"); r(c, x + 22, y + 91, 2, 9, "#5a4030");
    r(c, x + 11, y + 74, 12, 14, "#8a6a46"); r(c, x + 12, y + 76, 4, 4, "#f4f1ea"); r(c, x + 18, y + 76, 4, 4, "#f4f1ea");
    r(c, x + 13, y + 77, 2, 2, "#12131a"); r(c, x + 19, y + 77, 2, 2, "#12131a"); r(c, x + 16, y + 81, 2, 2, "#e5a50a");
    r(c, x + 11, y + 72, 2, 3, "#8a6a46"); r(c, x + 21, y + 72, 2, 3, "#8a6a46");
  },
  "The Speedrunner"(c, x, y) {                                     // a stopwatch, a chequered flag, energy drinks
    r(c, x + 16, y + 6, 28, 28, "#c4cad6"); r(c, x + 18, y + 8, 24, 24, "#f4f1ea"); r(c, x + 27, y + 3, 6, 4, "#9aa3b5");
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; r(c, x + 29.5 + Math.cos(a) * 10, y + 19.5 + Math.sin(a) * 10, 1, 1, "#39404f"); }
    for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) r(c, x + 54 + i * 6, y + 9 + j * 6, 6, 6, (i + j) % 2 ? "#12131a" : "#f4f1ea");
    r(c, x + 53, y + 8, 1, 26, "#6b7488");
    // a pyramid of cans in the margin
    const can = (cx, cy) => { r(c, x + cx, y + cy, 5, 8, "#38e07b"); r(c, x + cx, y + cy, 5, 1, "#c4cad6"); r(c, x + cx + 1, y + cy + 3, 3, 2, "#12131a"); };
    can(8, 92); can(14, 92); can(20, 92); can(11, 84); can(17, 84); can(14, 76);
  },
  "The Contractor"(c, x, y) {                                      // a contract on a clipboard, a calendar, a briefcase
    r(c, x + 16, y + 6, 22, 28, "#8a6a46"); r(c, x + 18, y + 10, 18, 22, "#f4f1ea"); r(c, x + 23, y + 5, 8, 4, "#c4cad6");
    for (let i = 0; i < 5; i++) r(c, x + 20, y + 13 + i * 3, i === 4 ? 8 : 14, 1, "#9aa3b5");
    r(c, x + 28, y + 28, 6, 2, "#3d6fd6");                                                         // signature
    r(c, x + 46, y + 8, 28, 24, "#f4f1ea"); r(c, x + 46, y + 8, 28, 6, "#c94f4f");                // calendar
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) r(c, x + 49 + i * 6, y + 17 + j * 5, 3, 2, i + j * 4 === 6 ? "#c94f4f" : "#9aa3b5");
    // filing cabinet and a briefcase in the margin
    r(c, x + 8, y + 70, 18, 30, "#4a5070"); r(c, x + 9, y + 71, 16, 28, "#5a6290");
    for (let i = 0; i < 2; i++) { r(c, x + 9, y + 72 + i * 14, 16, 1, "#4a5070"); r(c, x + 15, y + 77 + i * 14, 4, 1, "#c4cad6"); }
    r(c, x + 9, y + 58, 16, 11, "#5a3a24"); r(c, x + 9, y + 58, 16, 2, "#7a5034"); r(c, x + 14, y + 56, 6, 2, "#3a2516"); r(c, x + 16, y + 62, 2, 2, "#c9a227");
  },
};

export function drawDecorStatic(c, room, arch) {
  (STATIC[arch] || STATIC["The Orchestrator"])(c, room.x, room.y);
  S.drawPlant(c, room.x + room.w - 24, room.y + room.h - 46, (room.x + room.y) % 3);
}

// Live touches, drawn every frame. `on` is false when the room is dark (napping, on holiday, logged out).
export function drawDecorLive(ctx, room, arch, t, on) {
  const { x, y } = room;
  if (arch === "The Orchestrator" && on && Math.floor(t / 900) % 3 === 0) r(ctx, x + 41, y + 23, 10, 4, "#e8d5ff");
  if (arch === "The Speedrunner") {                                 // the stopwatch's second hand
    const a = (on ? t / 1000 : 0) * Math.PI * 2 / 6 - Math.PI / 2;
    for (let i = 0; i < 8; i++) r(ctx, x + 29.5 + Math.cos(a) * i, y + 19.5 + Math.sin(a) * i, 1, 1, "#d94a4a");
    r(ctx, x + 29, y + 19, 2, 2, "#39404f");
  }
  if (arch === "The Night Owl") {                                   // string lights and a coffee machine with steam
    const cols = ["#ff6b6b", "#ffd24a", "#38e07b", "#5b8def", "#c678dd"];
    for (let i = 0; i < 8; i++) r(ctx, x + 56 + i * 5, y + 11 + (i % 2), 2, 2, on && Math.floor(t / 500 + i) % 3 ? cols[i % cols.length] : S.shade(cols[i % cols.length], 0.45));
    S.drawCoffeeMachine(ctx, x + 12, y + 50, t);
    if (on) { const s = Math.floor(t / 330) % 3; r(ctx, x + 17, y + 46 - s, 1, 1, "rgba(255,255,255,0.6)"); if (s === 1) r(ctx, x + 18, y + 43, 1, 1, "rgba(255,255,255,0.4)"); }
  }
  if (arch === "The Investigator" && on) {                          // a swinging desk lamp over the case file
    const sw = Math.round(Math.sin(t / 700) * 2);
    r(ctx, x + 22 + sw, y + 46, 1, 6, "#39404f"); r(ctx, x + 19 + sw, y + 52, 7, 3, "#2f6f3f"); r(ctx, x + 20 + sw, y + 55, 5, 1, "#ffe8a3");
  }
}

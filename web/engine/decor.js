// A room per character: the shell (floor, walls, door) and decor that matches each personality. Static parts are drawn
// once into the background; live parts (steam, a ticking stopwatch, a blinking flowchart) are drawn every frame.
import * as S from "./sprites.js";

const r = S.rect;
export const BACK = 40;                         // height of a room's back wall
export const DOOR_W = 24;

// Each personality gets its own floor; the seat's colour shows in the wall band, the door mat and the rug under the desk.
const FLOORS = {
  "The Orchestrator"(c, x, y, w, h) {                               // carpet tiles
    for (let yy = 0; yy < h; yy += 10) for (let xx = 0; xx < w; xx += 10) r(c, x + xx, y + yy, 10, 10, ((xx + yy) / 10) % 2 ? "#3f4a6e" : "#3a4467");
    for (let yy = 0; yy < h; yy += 10) r(c, x, y + yy, w, 1, "#35405f");
  },
  "The Builder"(c, x, y, w, h) {                                    // light oak planks
    for (let yy = 0; yy < h; yy += 6) {
      const row = (yy / 6) | 0;
      r(c, x, y + yy, w, 6, row % 2 ? "#a77c52" : "#9f754c"); r(c, x, y + yy, w, 1, "#b48a5e");
      for (let xx = (row % 3) * 22; xx < w; xx += 64) r(c, x + xx, y + yy, 1, 6, "#87613d");
    }
  },
  "The Investigator"(c, x, y, w, h) {                               // library-green carpet with a diamond weave
    r(c, x, y, w, h, "#2f4d3c");
    for (let yy = 4; yy < h; yy += 8) for (let xx = ((yy / 8) | 0) % 2 * 4; xx < w; xx += 8) r(c, x + xx, y + yy, 1, 1, "#3b5e4a");
  },
  "The Perfectionist"(c, x, y, w, h) {                              // clean pale tiles on a strict grid
    r(c, x, y, w, h, "#b9bfcd");
    for (let yy = 0; yy < h; yy += 12) r(c, x, y + yy, w, 1, "#a6adbe");
    for (let xx = 0; xx < w; xx += 12) r(c, x + xx, y, 1, h, "#a6adbe");
  },
  "The Night Owl"(c, x, y, w, h) {                                  // a deep navy carpet with tiny stars
    r(c, x, y, w, h, "#262d52");
    for (let i = 0; i < w * h / 160; i++) r(c, x + S.hashOf("nx" + i) % w, y + S.hashOf("ny" + i) % h, 1, 1, i % 5 ? "#323a66" : "#59609a");
  },
  "The Speedrunner"(c, x, y, w, h) {                                // a chequered floor with a racing stripe
    for (let yy = 0; yy < h; yy += 8) for (let xx = 0; xx < w; xx += 8) r(c, x + xx, y + yy, 8, 8, ((xx + yy) / 8) % 2 ? "#3a3f50" : "#2f3443");
    r(c, x + w - 22, y, 6, h, "#b93a3a"); r(c, x + w - 14, y, 3, h, "#e8e4da");
  },
  "The Contractor"(c, x, y, w, h) {                                 // warm parquet
    for (let yy = 0; yy < h; yy += 8) for (let xx = 0; xx < w; xx += 16) {
      const alt = ((xx / 16) + (yy / 8)) % 2;
      r(c, x + xx, y + yy, 16, 8, alt ? "#8d6343" : "#7f583a");
      if (alt) r(c, x + xx, y + yy + 4, 16, 1, "#74502f"); else r(c, x + xx + 8, y + yy, 1, 8, "#74502f");
    }
  },
};

// Floor, walls, a back-wall band in the seat colour, and a door in the front wall.
export function drawRoomShell(c, room, color, arch) {
  const { x, y, w, h } = room;
  (FLOORS[arch] || FLOORS["The Orchestrator"])(c, x, y + BACK, w, h - BACK - 4);
  // back wall: a soft two-tone wall with a picture rail
  r(c, x, y, w, BACK, "#3a4169");
  for (let xx = x + 6; xx < x + w; xx += 24) r(c, xx, y + 5, 1, BACK - 14, "#424a76");
  r(c, x, y, w, 4, S.shade(color, 0.9)); r(c, x, y + 4, w, 1, S.shade(color, 0.6));     // the room's colour along the top
  r(c, x, y + BACK - 9, w, 9, "#2a2f50"); r(c, x, y + BACK - 10, w, 1, "#5a6396");
  r(c, x, y + BACK, w, 2, "rgba(0,0,0,0.22)");
  // side walls
  r(c, x, y, 2, h, "#1b1e31"); r(c, x + w - 2, y, 2, h, "#1b1e31");
  // front wall with a door in the middle
  const dx = x + (w - DOOR_W) / 2;
  r(c, x, y + h - 4, dx - x, 4, "#1b1e31"); r(c, dx + DOOR_W, y + h - 4, x + w - dx - DOOR_W, 4, "#1b1e31");
  r(c, dx - 2, y + h - 6, 2, 6, "#6b74a8"); r(c, dx + DOOR_W, y + h - 6, 2, 6, "#6b74a8");
  r(c, dx, y + h - 4, DOOR_W, 4, S.shade(color, 0.7)); r(c, dx + 2, y + h - 3, DOOR_W - 4, 1, S.shade(color, 1.1));   // door mat
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

// A furniture corner on the right of each room (x + w - 28 … x + w - 6, from y + 48 down), so no room is a bare floor.
// It stays 22 px wide: the aisle to the desk's far end runs just left of it.
const CORNER = {
  "The Orchestrator"(c, x, y) {                                     // a shelf of binders and a sticky-note column
    S.drawBookshelf(c, x, y + 4, 22);
    for (let i = 0; i < 4; i++) r(c, x + 2 + (i % 2) * 10, y + 38 + ((i / 2) | 0) * 9, 8, 7, ["#ffe066", "#8fd3ff", "#ffb3c7", "#b8f5c9"][i]);
  },
  "The Builder"(c, x, y) {                                          // a 3D printer on a stand, mid-print
    r(c, x, y + 30, 22, 3, "#5a4030"); r(c, x + 2, y + 33, 2, 14, "#4a3020"); r(c, x + 18, y + 33, 2, 14, "#4a3020");
    r(c, x + 1, y + 4, 20, 26, "#2a2d38"); r(c, x + 3, y + 6, 16, 20, "#14161e"); r(c, x + 3, y + 6, 16, 1, "#3d4459");
    r(c, x + 6, y + 20, 10, 5, "#ff8f3d"); r(c, x + 7, y + 18, 8, 2, "#ffb36b"); r(c, x + 10, y + 9, 2, 8, "#9aa3b5");
    r(c, x + 19, y + 8, 3, 6, "#3fb68b");
  },
  "The Investigator"(c, x, y) {                                     // a leather armchair under a floor lamp
    r(c, x + 18, y + 2, 1, 34, "#39404f"); r(c, x + 13, y, 9, 4, "#2f6f3f"); r(c, x + 14, y + 4, 7, 1, "#ffe8a3");
    r(c, x + 1, y + 26, 20, 18, "#6b3b2a"); r(c, x + 3, y + 22, 16, 8, "#7d4632"); r(c, x + 1, y + 30, 4, 12, "#5a3022"); r(c, x + 17, y + 30, 4, 12, "#5a3022");
    r(c, x + 4, y + 23, 14, 1, "#94573f"); r(c, x + 5, y + 44, 12, 2, "rgba(0,0,0,0.25)");
  },
  "The Perfectionist"(c, x, y) {                                    // a raked sand garden with three stones
    r(c, x, y + 20, 22, 22, "#8a8f9e"); r(c, x + 1, y + 21, 20, 20, "#e6dcc3");
    for (let i = 0; i < 5; i++) r(c, x + 3, y + 24 + i * 4, 16, 1, "#d2c6a8");
    r(c, x + 5, y + 27, 5, 4, "#6b7080"); r(c, x + 13, y + 32, 6, 5, "#7d8292"); r(c, x + 11, y + 24, 3, 3, "#5a5f6e");
  },
  "The Night Owl"(c, x, y) {                                        // a bean bag and a lava lamp
    S.drawBeanBag(c, x, y + 30, "#6a4fc4");
    r(c, x + 18, y + 14, 4, 2, "#9aa3b5"); r(c, x + 17, y + 16, 5, 14, "#2a2440"); r(c, x + 18, y + 17, 3, 12, "#ff5fa2");
    r(c, x + 19, y + 19, 1, 3, "#ffd0e4"); r(c, x + 19, y + 25, 1, 2, "#ffd0e4"); r(c, x + 17, y + 30, 5, 3, "#9aa3b5");
  },
  "The Speedrunner"(c, x, y) {                                      // a treadmill desk's walking belt
    r(c, x, y + 30, 22, 10, "#2a2d38"); r(c, x + 2, y + 32, 18, 6, "#3d4459");
    for (let i = 0; i < 4; i++) r(c, x + 4 + i * 4, y + 34, 2, 2, "#4f5873");
    r(c, x + 17, y + 10, 2, 22, "#9aa3b5"); r(c, x + 12, y + 9, 10, 3, "#c4cad6"); r(c, x + 14, y + 6, 6, 3, "#38e07b");
  },
  "The Contractor"(c, x, y) {                                       // a coat rack and an umbrella stand
    r(c, x + 8, y + 2, 2, 40, "#5a4030"); r(c, x + 4, y + 41, 10, 2, "#5a4030"); r(c, x + 3, y + 4, 12, 2, "#5a4030");
    r(c, x + 1, y + 6, 8, 16, "#3d4f6e"); r(c, x + 2, y + 6, 6, 2, "#4f6389");                                   // a coat
    r(c, x + 15, y + 30, 7, 12, "#4a5070"); r(c, x + 16, y + 22, 1, 9, "#c94f4f"); r(c, x + 19, y + 24, 1, 7, "#2b3045");
  },
};

export function drawDecorStatic(c, room, arch, bloom = false) {
  (STATIC[arch] || STATIC["The Orchestrator"])(c, room.x, room.y);
  (CORNER[arch] || CORNER["The Orchestrator"])(c, room.x + room.w - 28, room.y + 48);
  const px = room.x + room.w - 24, py = room.y + room.h - 46;
  S.drawPlant(c, px, py, (room.x + room.y) % 3);
  if (bloom) for (const [fx, fy, col] of [[1, 2, "#ff7bd8"], [7, 1, "#ffd24a"], [4, -1, "#ff6b6b"], [8, 5, "#ffffff"]]) { r(c, px + fx, py + fy, 2, 2, col); r(c, px + fx, py + fy, 1, 1, "#fff6d0"); }   // office level: in bloom
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

// Floor plan and the static background. v4 "Studio": a lobby down the left (elevator, CEO desk, hiring desk, server
// closet) and a room per character on the right, each opening onto a corridor through its door. v5: the plan adapts to
// the space it is shown in (2, 3 or 4 rooms to a row, taller rooms), so the building fills the screen.
import * as S from "./sprites.js";
import { BACK, drawRoomShell, drawDecorStatic, roomTier } from "./decor.js";

export const W = 768;                           // the default plan's width (three rooms to a row); a layout carries its own
export const WALL = 48;                         // the lobby's back wall
export const LOBBY_W = 196;
export const ROOM_W = 190, ROOM_H = 160, ROOM_H_MAX = 240, CORR = 16;
export const POD_W = 128, POD_H = 118;          // the desk island inside a room (people, monitors, chairs)
export const SLOT_X = [19, 59, 99];
export const ELEVATOR = { x: 84, y: 6 };
export const SPINE_X = 178;                     // the lobby walkway that joins every corridor (walker left x)
export const WALK_Y = 50;                       // the walkway under the lobby wall (walker top y)

// The plan that draws the office biggest in a box of bw × bh pixels: rooms per row, then rooms as tall as the box
// allows (within limits). Leftover space is scored down, so a plan that fills the box wins a near tie.
export function planFor(nSeats, bw, bh) {
  let best = null;
  for (const cols of [2, 3, 4]) {
    const w = LOBBY_W + 2 + cols * ROOM_W, rows = Math.max(2, Math.ceil((nSeats + 1) / cols));
    const roomH = Math.round(Math.max(ROOM_H, Math.min(ROOM_H_MAX, (bh * w / bw) / rows - CORR)));
    const h = rows * (roomH + CORR), f = Math.min(bw / w, bh / h), fill = (w * f * h * f) / (bw * bh);
    const score = f * Math.sqrt(fill);
    if (!best || score > best.score + 1e-6) best = { cols, roomH, score };
  }
  return { cols: best.cols, roomH: best.roomH };
}

export function computeLayout(seats, archetypeOf = () => null, plan = {}) {
  const cols = plan.cols || 3, roomH = plan.roomH || ROOM_H;
  const W = LOBBY_W + 2 + cols * ROOM_W;
  const cells = seats.length + 1;              // + the lounge
  const rows = Math.max(2, Math.ceil(cells / cols));
  const H = rows * (roomH + CORR);
  const dy = Math.round((roomH - ROOM_H) / 2);     // in a taller room the desks sit in the middle of the floor
  const cell = (i) => ({ x: LOBBY_W + 2 + (i % cols) * ROOM_W, y: Math.floor(i / cols) * (roomH + CORR), w: ROOM_W, h: roomH, dy, row: Math.floor(i / cols), col: i % cols });
  const pods = seats.map((s, i) => {
    const room = cell(i);
    // the desk island sits in the middle of the room, under the back wall
    const y = room.y + BACK - 12 + dy;           // a one-row desk drops a little lower (office.js assign) to stay centred
    return { seat: s, arch: archetypeOf(s), room, x: room.x + (ROOM_W - POD_W) / 2, y, baseY: y, cap: 6, row: room.row, col: room.col,
      door: { x: room.x + ROOM_W / 2, y: room.y + roomH }, corr: room.y + roomH + 1 };
  });
  const spare = [];
  for (let i = seats.length; i < rows * cols; i++) spare.push(cell(i));
  return {
    W, H, rows, cols, roomH, pods,
    lounge: spare[0],
    meet: spare[1] || null,
    open: spare.slice(2),
    lobby: { x: 0, y: 0, w: LOBBY_W, h: H },
    ceo: { x: 0, y: WALL, w: LOBBY_W, h: 104 },
    hire: { x: 22, y: WALL + 110 },
    server: { x: 0, y: WALL + 236, w: LOBBY_W, h: H - WALL - 236 },
    corridors: Array.from({ length: rows }, (_, r) => r * (roomH + CORR) + roomH + 1),
  };
}

// A desk sized to the people at it: 1, 2, 3, 4 or 6 seats (x inside the pod, top row first). A room never shows rows
// of empty chairs; an empty room keeps a two-seat desk.
const SEATS = {
  1: [[59, true]],
  2: [[39, true], [79, true]],
  3: [[19, true], [59, true], [99, true]],
  4: [[39, true], [79, true], [39, false], [79, false]],
  6: [[19, true], [59, true], [99, true], [19, false], [59, false], [99, false]],
};
export const capFor = (n) => n <= 0 ? 2 : n <= 1 ? 1 : n <= 2 ? 2 : n <= 3 ? 3 : n <= 4 ? 4 : 6;
export const seatsOf = (pod) => SEATS[pod.cap || 6];

// Where a worker sits (relative to the desk island).
export function seatSpot(pod, slot) {
  const lay = seatsOf(pod), [dx, top] = lay[Math.min(slot, lay.length - 1)];
  const cx = pod.x + dx;
  return { cx, top, seatY: top ? pod.y + 22 : pod.y + 64, standY: top ? pod.y + 4 : pod.y + 82 };
}

// The desk under a pod's seats: one row (people face us) or two (back to back).
export function deskFor(pod) {
  const lay = seatsOf(pod), xs = lay.map(([dx]) => dx), two = lay.some(([, top]) => !top);
  let x0 = Math.min(...xs) - 9, x1 = Math.max(...xs) + 19;
  if (x1 - x0 < 46) { const c = (x0 + x1) / 2; x0 = c - 23; x1 = c + 23; }
  return { x: pod.x + x0, y: pod.y + 38, w: x1 - x0, h: two ? 32 : 18, two,
    gaps: xs.slice(1).map((x, i) => pod.x + (xs[i] + 10 + x) / 2) };   // spaces between neighbours, for desk things
}

// From one seat to another without the elevator: out of room A by its door, along its corridor (and the spine to the
// other corridor when the rooms are on different rows), in by room B's door, to the seat (walker top-left coords).
export function pathBetween(layout, podA, slotA, podB, slotB) {
  const a = pathTo(layout, podA, slotA).reverse(), b = pathTo(layout, podB, slotB);
  const doorA = a.findIndex(p => p[0] === podA.door.x - 5 && p[1] === podA.corr - 2);
  const doorB = b.findIndex(p => p[0] === podB.door.x - 5 && p[1] === podB.corr - 2);
  const spine = podA.corr === podB.corr ? [] : [[SPINE_X, podA.corr - 2], [SPINE_X, podB.corr - 2]];
  return [...a.slice(0, doorA + 1), ...spine, ...b.slice(doorB)]
    .filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
}

// Elevator → lobby walkway → spine → the room's corridor → its door → an aisle → the seat (walker top-left coords).
export function pathTo(layout, pod, slot) {
  const sp = seatSpot(pod, slot), room = pod.room;
  const ex = ELEVATOR.x + 8, ey = ELEVATOR.y + 18;
  const corrY = pod.corr - 2, doorX = pod.door.x - 5;
  const aisleY = room.y + room.h - 44;                          // inside the room, below the bottom chairs, above the door sign
  const pts = [[ex, ey], [ex, WALK_Y], [SPINE_X, WALK_Y], [SPINE_X, corrY], [doorX, corrY], [doorX, aisleY]];
  if (sp.top) {   // round the end of the desk, keeping clear of the decor in the side margins
    const d = deskFor(pod);
    const side = sp.cx < d.x + d.w / 2 ? Math.max(room.x + 26, d.x - 13) : Math.min(room.x + room.w - 40, d.x + d.w + 3);
    pts.push([side, aisleY], [side, sp.standY], [sp.cx, sp.standY]);
  } else {
    pts.push([sp.cx, aisleY], [sp.cx, sp.standY]);
  }
  return pts.filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
}

export function drawStatic(c, L) {
  const H = L.H, W = L.W;
  // the building: dark gaps between rooms read as corridors
  S.rect(c, 0, 0, W, H, "#1a1c2b");
  // corridors: a warm floor with a burgundy runner and a gold stitch, lit from above at each door
  for (const cy of L.corridors) {
    S.rect(c, LOBBY_W, cy - 1, W - LOBBY_W, CORR, "#47425c"); S.rect(c, LOBBY_W, cy - 1, W - LOBBY_W, 1, "#615b7d"); S.rect(c, LOBBY_W, cy + CORR - 2, W - LOBBY_W, 1, "#2f2b40");
    S.rect(c, LOBBY_W, cy + 3, W - LOBBY_W, 8, "#6b3a4d"); S.rect(c, LOBBY_W, cy + 3, W - LOBBY_W, 1, "#7d4a5e");
    for (let x = LOBBY_W + 3; x < W - 3; x += 6) { S.rect(c, x, cy + 4, 2, 1, "#b8913f"); S.rect(c, x + 3, cy + 9, 2, 1, "#b8913f"); }
  }
  // lobby: a terrazzo floor in big polished slabs, a back wall with the brand, the elevator and the trophy cabinet
  S.rect(c, 0, WALL, LOBBY_W, H - WALL, "#8a8174");
  for (let y = WALL; y < H; y += 24) for (let x = 0; x < LOBBY_W; x += 24) { S.rect(c, x, y, 24, 1, "#766e62"); S.rect(c, x, y, 1, 24, "#766e62"); S.rect(c, x + 1, y + 1, 22, 1, "#978e80"); }
  for (let i = 0; i < LOBBY_W * (H - WALL) / 40; i++) {
    const hx = S.hashOf("tz" + i), x = hx % LOBBY_W, y = WALL + (hx >>> 9) % (H - WALL);
    S.rect(c, x, y, 1, 1, ["#a1977f", "#6f675c", "#b49d78", "#7d8a8a"][(hx >>> 20) % 4]);
  }
  S.rect(c, 0, 0, LOBBY_W, WALL, S.P.wall);
  for (let x = 0; x < LOBBY_W; x += 32) { S.rect(c, x, 0, 1, WALL - 10, S.P.wallLo); S.rect(c, x + 1, 0, 1, WALL - 10, S.P.wallHi); }
  S.rect(c, 0, WALL - 10, LOBBY_W, 10, S.P.wainscot); S.rect(c, 0, WALL - 11, LOBBY_W, 1, S.P.trim);
  S.rect(c, 0, WALL, LOBBY_W, 3, "rgba(0,0,0,0.28)");
  // a red carpet from the elevator to the rooms, edged in gold
  const runner = (x, y, w, h) => { S.rect(c, x, y, w, h, "#7a2f3f"); S.rect(c, x + 1, y + 1, w - 2, h - 2, "#8c3949"); S.rect(c, x, y, w, 1, "#c9a24a"); S.rect(c, x, y + h - 1, w, 1, "#c9a24a"); S.rect(c, x, y, 1, h, "#c9a24a"); S.rect(c, x + w - 1, y, 1, h, "#c9a24a"); };
  runner(70, WALL + 2, LOBBY_W - 70, 10); runner(LOBBY_W - 22, WALL + 2, 12, H - WALL - 4);
  // CEO corner: a navy rug with a gold border under the desk
  S.rect(c, 70, L.ceo.y + 30, 112, 62, "#27304f"); S.rect(c, 72, L.ceo.y + 32, 108, 58, "#c9a24a"); S.rect(c, 73, L.ceo.y + 33, 106, 56, "#33406a");
  for (let i = 0; i < 6; i++) S.rect(c, 80 + i * 17, L.ceo.y + 58, 6, 6, "#3e4c7c");
  // the hiring desk: a reception counter in teal with a frosted front
  const h = L.hire;
  S.rect(c, h.x + 22, h.y + 68, 84, 3, S.P.shadow);
  S.rect(c, h.x + 22, h.y + 44, 84, 24, "#235c4e"); S.rect(c, h.x + 22, h.y + 44, 84, 2, "#3f9b80"); S.rect(c, h.x + 26, h.y + 49, 76, 14, "#2c7262");
  for (let i = 0; i < 4; i++) S.rect(c, h.x + 30 + i * 18, h.y + 52, 10, 8, "#348571");
  S.rect(c, h.x + 22, h.y + 40, 84, 5, S.P.deskTop); S.rect(c, h.x + 22, h.y + 40, 84, 1, S.P.deskTopHi);
  S.drawChairFront(c, h.x + 57, h.y + 26);
  S.drawPlant(c, 6, h.y + 70, 1); S.drawPlant(c, h.x + 108, h.y + 54, 2);
  // server closet: tiles behind a low wall
  const sv = L.server;
  for (let y = sv.y; y < H; y += 8) for (let x = 0; x < LOBBY_W - 26; x += 8) { S.rect(c, x, y, 8, 8, ((x + y) / 8) % 2 ? S.P.tile : S.P.tileB); S.rect(c, x, y, 8, 1, S.P.tileLine); }
  S.rect(c, 0, sv.y - 3, LOBBY_W - 26, 3, "#141722");
  // office-level unlocks in the lobby: palms either side of the elevator, and at the top the founder's statue
  if (L.unlocked && L.unlocked.has("palms")) { S.drawPalm(c, 68, WALL - 2); S.drawPalm(c, 113, WALL - 2); }
  if (L.unlocked && L.unlocked.has("statue")) {
    const sx = 148, sy = L.hire.y - 4;
    S.rect(c, sx, sy + 28, 22, 10, "#6b6f80"); S.rect(c, sx, sy + 28, 22, 2, "#8a8fa2"); S.rect(c, sx + 2, sy + 38, 18, 2, "rgba(0,0,0,0.3)");
    S.rect(c, sx + 7, sy + 4, 8, 7, "#e0b84a"); S.rect(c, sx + 6, sy + 11, 10, 12, "#d4a83a"); S.rect(c, sx + 7, sy + 23, 3, 5, "#c49a30"); S.rect(c, sx + 12, sy + 23, 3, 5, "#c49a30");
    S.rect(c, sx + 15, sy + 9, 3, 2, "#d4a83a"); S.rect(c, sx + 17, sy + 4, 2, 6, "#d4a83a"); S.rect(c, sx + 8, sy + 5, 2, 2, "#fff0a8");   // one arm raised
  }
  // the wall between the lobby and the rooms, open where each corridor meets the lobby walkway
  let wy = 0;
  for (const cy of L.corridors) { S.rect(c, LOBBY_W - 2, wy, 2, cy - 3 - wy, "#141722"); wy = cy + CORR; }
  if (wy < H) S.rect(c, LOBBY_W - 2, wy, 2, H - wy, "#141722");
  // character rooms
  for (const p of L.pods) {
    drawRoomShell(c, p.room, p.seat.color, p.arch, roomTier(p.seat.career && p.seat.career.level));
    drawDecorStatic(c, p.room, p.arch, !!(L.unlocked && L.unlocked.has("flowers")));
  }
  // the lounge, the meeting room and any open space
  if (L.lounge) drawCommonRoom(c, L.lounge, "#2f5658", "#2a4d4f");
  if (L.meet) {
    drawCommonRoom(c, L.meet, S.P.meet, S.P.meetB);
    const tx = L.meet.x + 40, ty = L.meet.y + 66;
    S.rect(c, tx + 2, ty + 36, 110, 4, S.P.shadow);
    S.rect(c, tx, ty, 112, 36, "#5e412c"); S.rect(c, tx + 2, ty + 2, 108, 32, "#77543a"); S.rect(c, tx + 2, ty + 2, 108, 1, "#8a6446");
    for (let i = 0; i < 4; i++) { S.drawChairFront(c, tx + 8 + i * 26, ty - 12); S.drawChairBack(c, tx + 9 + i * 26, ty + 38); }
  }
  for (const o of L.open) drawGarden(c, o);
}

// A spare cell becomes a little indoor garden: grass, a stepping-stone path from the door, a pond, a bench, plants.
function drawGarden(c, room) {
  const { x, y, w, h } = room;
  drawCommonRoom(c, room, "#2f5a3a", "#2b5335");
  for (let yy = y + BACK + 6; yy < y + h - 8; yy += 9) for (let xx = x + 6 + ((yy / 9) | 0) % 2 * 5; xx < x + w - 6; xx += 11) S.rect(c, xx, yy, 1, 2, "#3d7049");
  const cx = x + w / 2;
  for (let yy = y + h - 14; yy > y + BACK + 30; yy -= 13) { S.rect(c, cx - 6 + (((yy / 13) | 0) % 2 ? 3 : -3), yy, 12, 6, "#8f8b7c"); S.rect(c, cx - 6 + (((yy / 13) | 0) % 2 ? 3 : -3), yy, 12, 1, "#aaa596"); }
  const px = x + 18, py = y + h - 62;                                  // the pond
  S.rect(c, px + 4, py, 44, 26, "#2a4f7a"); S.rect(c, px, py + 4, 52, 18, "#2a4f7a"); S.rect(c, px + 6, py + 3, 40, 2, "#4f86c0"); S.rect(c, px + 30, py + 12, 6, 1, "#7fb2e6");
  S.rect(c, px + 14, py + 9, 4, 2, "#e8823a"); S.rect(c, px + 18, py + 10, 1, 1, "#e8823a");   // a koi
  const bx = x + w - 66, by = y + BACK + 34;                           // a bench
  S.rect(c, bx, by, 46, 6, "#7a5233"); S.rect(c, bx, by, 46, 1, "#9a6b44"); S.rect(c, bx, by - 8, 46, 4, "#6b4529");
  S.rect(c, bx + 3, by + 6, 2, 6, "#4a3020"); S.rect(c, bx + 41, by + 6, 2, 6, "#4a3020");
  S.drawPlant(c, x + 10, y + BACK + 8, 0); S.drawPlant(c, x + w - 24, y + h - 40, 2); S.drawPlant(c, x + w - 30, y + BACK + 60, 1); S.drawPlant(c, x + 64, y + BACK + 14, 2);
}

function drawCommonRoom(c, room, a, b) {
  const { x, y, w, h } = room;
  for (let yy = y + BACK; yy < y + h - 4; yy += 4) S.rect(c, x, yy, w, 4, ((yy / 4) | 0) % 2 ? a : b);
  S.rect(c, x, y, w, BACK, "#2c3150"); S.rect(c, x, y + BACK - 8, w, 8, "#232741"); S.rect(c, x, y + BACK - 9, w, 1, "#4d5480");
  S.rect(c, x, y, 2, h, "#1b1e31"); S.rect(c, x + w - 2, y, 2, h, "#1b1e31");
  const dx = x + w / 2 - 14;
  S.rect(c, x, y + h - 4, dx - x, 4, "#1b1e31"); S.rect(c, dx + 28, y + h - 4, x + w - dx - 28, 4, "#1b1e31");
}

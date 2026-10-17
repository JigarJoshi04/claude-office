// Floor plan and the static background. v4 "Studio": a lobby down the left (elevator, CEO desk, hiring desk, server
// closet) and a room per character on the right, three to a row, each opening onto a corridor through its door.
import * as S from "./sprites.js";
import { BACK, drawRoomShell, drawDecorStatic } from "./decor.js";

export const W = 768;
export const WALL = 48;                         // the lobby's back wall
export const LOBBY_W = 196;
export const ROOM_W = 190, ROOM_H = 160, CORR = 16;
export const POD_W = 128, POD_H = 118;          // the desk island inside a room (people, monitors, chairs)
export const SLOT_X = [19, 59, 99];
export const ELEVATOR = { x: 84, y: 6 };
export const SPINE_X = 178;                     // the lobby walkway that joins every corridor (walker left x)
export const WALK_Y = 50;                       // the walkway under the lobby wall (walker top y)

export function computeLayout(seats, archetypeOf = () => null) {
  const cells = seats.length + 1;              // + the lounge
  const rows = Math.max(2, Math.ceil(cells / 3));
  const H = rows * (ROOM_H + CORR);
  const cell = (i) => ({ x: LOBBY_W + 2 + (i % 3) * ROOM_W, y: Math.floor(i / 3) * (ROOM_H + CORR), w: ROOM_W, h: ROOM_H, row: Math.floor(i / 3), col: i % 3 });
  const pods = seats.map((s, i) => {
    const room = cell(i);
    // the desk island sits in the middle of the room, under the back wall
    return { seat: s, arch: archetypeOf(s), room, x: room.x + (ROOM_W - POD_W) / 2, y: room.y + BACK - 12, row: room.row, col: room.col,
      door: { x: room.x + ROOM_W / 2, y: room.y + ROOM_H }, corr: room.y + ROOM_H + 1 };
  });
  const spare = [];
  for (let i = seats.length; i < rows * 3; i++) spare.push(cell(i));
  return {
    H, rows, pods,
    lounge: spare[0],
    meet: spare[1] || null,
    open: spare.slice(2),
    lobby: { x: 0, y: 0, w: LOBBY_W, h: H },
    ceo: { x: 0, y: WALL, w: LOBBY_W, h: 104 },
    hire: { x: 22, y: WALL + 110 },
    server: { x: 0, y: WALL + 236, w: LOBBY_W, h: H - WALL - 236 },
    corridors: Array.from({ length: rows }, (_, r) => r * (ROOM_H + CORR) + ROOM_H + 1),
  };
}

// Where a worker sits (relative to the desk island).
export function seatSpot(pod, slot) {
  const col = slot % 3, top = slot < 3;
  const cx = pod.x + SLOT_X[col];
  return { cx, top, seatY: top ? pod.y + 22 : pod.y + 64, standY: top ? pod.y + 4 : pod.y + 82 };
}

// Elevator → lobby walkway → spine → the room's corridor → its door → an aisle → the seat (walker top-left coords).
export function pathTo(layout, pod, slot) {
  const sp = seatSpot(pod, slot), room = pod.room;
  const ex = ELEVATOR.x + 8, ey = ELEVATOR.y + 18;
  const corrY = pod.corr - 2, doorX = pod.door.x - 5;
  const aisleY = room.y + ROOM_H - 44;                          // inside the room, below the bottom chairs, above the door sign
  const pts = [[ex, ey], [ex, WALK_Y], [SPINE_X, WALK_Y], [SPINE_X, corrY], [doorX, corrY], [doorX, aisleY]];
  if (sp.top) {
    const side = sp.cx < pod.x + POD_W / 2 ? room.x + 26 : room.x + ROOM_W - 34;
    pts.push([side, aisleY], [side, sp.standY], [sp.cx, sp.standY]);
  } else {
    pts.push([sp.cx, aisleY], [sp.cx, sp.standY]);
  }
  return pts.filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
}

export function drawStatic(c, L) {
  const H = L.H;
  // the building: dark gaps between rooms read as corridors
  S.rect(c, 0, 0, W, H, "#1a1c2b");
  // corridors: a runner along each row
  for (const cy of L.corridors) {
    S.rect(c, LOBBY_W, cy - 1, W - LOBBY_W, CORR, "#4a3f5c"); S.rect(c, LOBBY_W, cy - 1, W - LOBBY_W, 1, "#5c4f72");
    for (let x = LOBBY_W + 6; x < W - 6; x += 14) S.rect(c, x, cy + 6, 7, 1, "#3d3450");
  }
  // lobby: warm planks, a back wall with the brand, the elevator and the trophy cabinet
  for (let y = WALL; y < H; y += 6) {
    const odd = ((y / 6) | 0) % 2;
    S.rect(c, 0, y, LOBBY_W, 6, odd ? S.P.floorA : S.P.floorB);
    S.rect(c, 0, y, LOBBY_W, 1, S.P.floorHi);
    for (let x = odd ? 0 : 20; x < LOBBY_W; x += 40) S.rect(c, x, y, 1, 6, S.P.floorLine);
  }
  S.rect(c, 0, 0, LOBBY_W, WALL, S.P.wall);
  for (let x = 0; x < LOBBY_W; x += 32) { S.rect(c, x, 0, 1, WALL - 10, S.P.wallLo); S.rect(c, x + 1, 0, 1, WALL - 10, S.P.wallHi); }
  S.rect(c, 0, WALL - 10, LOBBY_W, 10, S.P.wainscot); S.rect(c, 0, WALL - 11, LOBBY_W, 1, S.P.trim);
  S.rect(c, 0, WALL, LOBBY_W, 3, "rgba(0,0,0,0.28)");
  // a runner from the elevator to the rooms
  S.rect(c, 70, WALL + 2, LOBBY_W - 70, 10, "#5c4a6e"); S.rect(c, LOBBY_W - 22, WALL + 2, 12, H - WALL - 4, "#5c4a6e");
  // CEO corner: a rug under the desk
  S.rect(c, 70, L.ceo.y + 30, 112, 62, "#6e3646"); S.rect(c, 73, L.ceo.y + 33, 106, 56, "#84445a");
  // hiring desk
  const h = L.hire;
  S.rect(c, h.x + 4, h.y + 8, POD_W - 8, 88, "rgba(63,182,139,0.10)");
  S.rect(c, h.x + 24, h.y + 44, 80, 22, S.P.deskEdge); S.rect(c, h.x + 24, h.y + 42, 80, 6, S.P.deskTop); S.rect(c, h.x + 24, h.y + 42, 80, 1, S.P.deskTopHi);
  S.drawChairFront(c, h.x + 57, h.y + 28);
  S.drawPlant(c, 6, h.y + 70, 1);
  // server closet: tiles behind a low wall
  const sv = L.server;
  for (let y = sv.y; y < H; y += 8) for (let x = 0; x < LOBBY_W - 26; x += 8) { S.rect(c, x, y, 8, 8, ((x + y) / 8) % 2 ? S.P.tile : S.P.tileB); S.rect(c, x, y, 8, 1, S.P.tileLine); }
  S.rect(c, 0, sv.y - 3, LOBBY_W - 26, 3, "#141722");
  // the wall between the lobby and the rooms, open where each corridor meets the lobby walkway
  let wy = 0;
  for (const cy of L.corridors) { S.rect(c, LOBBY_W - 2, wy, 2, cy - 3 - wy, "#141722"); wy = cy + CORR; }
  if (wy < H) S.rect(c, LOBBY_W - 2, wy, 2, H - wy, "#141722");
  // character rooms
  for (const p of L.pods) {
    drawRoomShell(c, p.room, p.seat.color);
    drawDecorStatic(c, p.room, p.arch);
    S.drawDeskIsland(c, p.x + 10, p.y + 38, POD_W - 20, 32);
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
  for (const o of L.open) { drawCommonRoom(c, o, "#2c3042", "#292c3d"); S.drawPlant(c, o.x + 20, o.y + 60, 0); S.drawPlant(c, o.x + o.w - 34, o.y + 90, 2); }
}

function drawCommonRoom(c, room, a, b) {
  const { x, y, w, h } = room;
  for (let yy = y + BACK; yy < y + h - 4; yy += 4) S.rect(c, x, yy, w, 4, ((yy / 4) | 0) % 2 ? a : b);
  S.rect(c, x, y, w, BACK, "#2c3150"); S.rect(c, x, y + BACK - 8, w, 8, "#232741"); S.rect(c, x, y + BACK - 9, w, 1, "#4d5480");
  S.rect(c, x, y, 2, h, "#1b1e31"); S.rect(c, x + w - 2, y, 2, h, "#1b1e31");
  const dx = x + w / 2 - 14;
  S.rect(c, x, y + h - 4, dx - x, 4, "#1b1e31"); S.rect(c, dx + 28, y + h - 4, x + w - dx - 28, 4, "#1b1e31");
}

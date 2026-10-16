// Floor plan and the static background (everything that does not move), drawn once per layout change.
import * as S from "./sprites.js";

export const W = 768;
export const WALL = 60;
export const POD_W = 128, POD_H = 118, CORR = 18, ROW0 = 74;
export const LEFT = 176, RIGHT = 576, PODS_X = 184;
export const SLOT_X = [19, 59, 99];
export const ELEVATOR = { x: 352, y: 18 };
export const WALK_Y = 58;                      // the walkway along the back wall (walker top-left y)

export function computeLayout(seats) {
  const slots = seats.length + 1;              // + the hiring desk
  const rows = Math.max(2, Math.ceil(slots / 3));
  const H = ROW0 + rows * (POD_H + CORR) + 6;
  const pod = (i) => ({ x: PODS_X + (i % 3) * POD_W, y: ROW0 + Math.floor(i / 3) * (POD_H + CORR), row: Math.floor(i / 3), col: i % 3 });
  const pods = seats.map((s, i) => ({ seat: s, ...pod(i) }));
  const hire = pod(seats.length);
  const split = ROW0 + POD_H + 8;
  return {
    H, rows, pods, hire,
    ceo: { x: 0, y: WALL, w: LEFT, h: split - WALL },
    server: { x: 0, y: split + 6, w: LEFT, h: H - split - 6 },
    meet: { x: RIGHT, y: WALL, w: W - RIGHT, h: split - WALL },
    lounge: { x: RIGHT, y: split + 6, w: W - RIGHT, h: H - split - 6 },
  };
}

// Where a worker sits, and the path from the elevator to that seat (walker top-left coordinates).
export function seatSpot(pod, slot) {
  const col = slot % 3, top = slot < 3;
  const cx = pod.x + SLOT_X[col];
  return { cx, top, seatY: top ? pod.y + 22 : pod.y + 64, standY: top ? pod.y + 4 : pod.y + 82 };
}

export function pathTo(layout, pod, slot) {
  const sp = seatSpot(pod, slot);
  const ex = ELEVATOR.x + 8, ey = ELEVATOR.y + 22;
  const corrAbove = pod.row === 0 ? WALK_Y : pod.y - CORR - 2;
  const corrBelow = pod.y + POD_H - 2;
  const cy = sp.top ? corrAbove : corrBelow;
  const aisles = [pod.x - 6, pod.x + POD_W - 6];
  const ax = Math.abs(aisles[0] - sp.cx) < Math.abs(aisles[1] - sp.cx) ? aisles[0] : aisles[1];
  const pts = [[ex, ey], [ex, WALK_Y]];
  if (cy !== WALK_Y) pts.push([ax, WALK_Y], [ax, cy]);
  pts.push([sp.cx, cy], [sp.cx, sp.standY]);
  return pts.filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
}

export function drawStatic(c, L, seats, units) {
  const H = L.H;
  // floor: warm planks with a soft vignette
  for (let y = WALL; y < H; y += 6) {
    const odd = ((y / 6) | 0) % 2;
    S.rect(c, 0, y, W, 6, odd ? S.P.floorA : S.P.floorB);
    S.rect(c, 0, y, W, 1, S.P.floorHi);
    for (let x = odd ? 0 : 20; x < W; x += 40) S.rect(c, x, y, 1, 6, S.P.floorLine);
  }
  // back wall with panels and a skirting board
  S.rect(c, 0, 0, W, WALL, S.P.wall);
  for (let x = 0; x < W; x += 32) { S.rect(c, x, 0, 1, WALL - 10, S.P.wallLo); S.rect(c, x + 1, 0, 1, WALL - 10, S.P.wallHi); }
  S.rect(c, 0, WALL - 10, W, 10, S.P.wainscot);
  S.rect(c, 0, WALL - 11, W, 1, S.P.trim);
  S.rect(c, 0, WALL, W, 3, "rgba(0,0,0,0.28)");
  // walkway runner along the wall
  S.rect(c, PODS_X, WALL + 2, RIGHT - PODS_X - 8, 10, "#5c4a6e"); S.rect(c, PODS_X, WALL + 2, RIGHT - PODS_X - 8, 1, "#6f5a84");
  for (let x = PODS_X + 4; x < RIGHT - 12; x += 12) S.rect(c, x, WALL + 6, 6, 1, "#4a3b59");

  // CEO cabin: carpet, glass, rug
  for (let y = L.ceo.y; y < L.ceo.y + L.ceo.h; y += 4) S.rect(c, 0, y, L.ceo.w, 4, ((y / 4) | 0) % 2 ? S.P.carpet : S.P.carpetB);
  glassWall(c, L.ceo.w, L.ceo.y, L.ceo.h, true);
  S.rect(c, 0, L.ceo.y + L.ceo.h, L.ceo.w - 36, 3, S.P.glass); S.rect(c, 0, L.ceo.y + L.ceo.h + 1, L.ceo.w - 36, 1, S.P.glassEdge);
  S.rect(c, 22, L.ceo.y + 46, 112, 64, "#6e3646"); S.rect(c, 25, L.ceo.y + 49, 106, 58, "#84445a");
  for (let i = 0; i < 6; i++) S.rect(c, 30 + i * 18, L.ceo.y + 52, 8, 1, "#9c5a70");
  S.drawPlant(c, 6, L.ceo.y + L.ceo.h - 24, 1);
  S.drawPlant(c, L.ceo.w - 18, L.ceo.y + 8, 2);
  // server room
  for (let y = L.server.y; y < H; y += 8) for (let x = 0; x < L.server.w; x += 8) {
    S.rect(c, x, y, 8, 8, ((x + y) / 8) % 2 ? S.P.tile : S.P.tileB);
    S.rect(c, x, y, 8, 1, S.P.tileLine);
  }
  S.rect(c, L.server.w, L.server.y, 4, L.server.h, "#141722");
  for (let i = 0; i < 6; i++) S.rect(c, 4 + i * 28, L.server.y + 3, 2, L.server.h - 6, "rgba(90,110,160,0.18)");   // cable trays
  // meeting room
  for (let y = L.meet.y; y < L.meet.y + L.meet.h; y += 4) S.rect(c, L.meet.x, y, L.meet.w, 4, ((y / 4) | 0) % 2 ? S.P.meet : S.P.meetB);
  glassWall(c, L.meet.x - 4, L.meet.y, L.meet.h, false);
  const tx = L.meet.x + 40, ty = L.meet.y + 52;
  S.rect(c, tx + 2, ty + 36, 110, 4, S.P.shadow);
  S.rect(c, tx, ty, 112, 36, "#5e412c"); S.rect(c, tx + 2, ty + 2, 108, 32, "#77543a"); S.rect(c, tx + 2, ty + 2, 108, 1, "#8a6446");
  for (let i = 0; i < 4; i++) { S.drawChairFront(c, tx + 8 + i * 26, ty - 12); S.drawChairBack(c, tx + 9 + i * 26, ty + 38); }
  S.drawPlant(c, L.meet.x + 6, L.meet.y + L.meet.h - 24, 2);
  // lounge
  for (let y = L.lounge.y; y < H; y += 4) S.rect(c, L.lounge.x, y, L.lounge.w, 4, ((y / 4) | 0) % 2 ? S.P.rug : S.P.rugB);
  glassWall(c, L.lounge.x - 4, L.lounge.y, L.lounge.h, false);
  S.drawCouch(c, L.lounge.x + 14, L.lounge.y + 22, "#c0564b");
  S.rect(c, L.lounge.x + 22, L.lounge.y + 46, 32, 14, "#5e412c"); S.rect(c, L.lounge.x + 23, L.lounge.y + 47, 30, 1, "#77543a");
  S.drawCouch(c, L.lounge.x + 14, L.lounge.y + 70, "#4b6fbf");
  S.drawBeanBag(c, L.lounge.x + 70, L.lounge.y + 28, "#e5a50a");
  S.drawBeanBag(c, L.lounge.x + 90, L.lounge.y + 40, "#3fb68b");
  // pods
  for (const p of L.pods) {
    const col = p.seat.color;
    c.globalAlpha = 0.2; S.rect(c, p.x + 4, p.y + 8, POD_W - 8, 88, col); c.globalAlpha = 1;
    c.globalAlpha = 0.5;
    S.rect(c, p.x + 4, p.y + 8, POD_W - 8, 1, col); S.rect(c, p.x + 4, p.y + 95, POD_W - 8, 1, col);
    S.rect(c, p.x + 4, p.y + 8, 1, 88, col); S.rect(c, p.x + POD_W - 5, p.y + 8, 1, 88, col);
    c.globalAlpha = 1;
    S.drawDeskIsland(c, p.x + 10, p.y + 38, POD_W - 20, 32);
    S.drawPlant(c, p.x + POD_W - 18, p.y + 80, p.col % 3);
  }
  // hiring desk
  const h = L.hire;
  S.rect(c, h.x + 4, h.y + 8, POD_W - 8, 88, "rgba(63,182,139,0.10)");
  S.rect(c, h.x + 24, h.y + 44, 80, 22, S.P.deskEdge); S.rect(c, h.x + 24, h.y + 42, 80, 6, S.P.deskTop); S.rect(c, h.x + 24, h.y + 42, 80, 1, S.P.deskTopHi);
  S.drawChairFront(c, h.x + 57, h.y + 28);
  S.drawPlant(c, h.x + 8, h.y + 78, 1);
  S.drawPlant(c, h.x + POD_W - 20, h.y + 78, 2);
}

function glassWall(c, x, y, h, right) {
  S.rect(c, x, y, 4, h, S.P.glass);
  S.rect(c, x + (right ? 1 : 2), y, 1, h, S.P.glassEdge);
  for (let yy = y + 6; yy < y + h; yy += 22) S.rect(c, x + 1, yy, 2, 6, "rgba(255,255,255,0.25)");
}

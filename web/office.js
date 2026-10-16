// The office floor: a pixel-art canvas with a DOM overlay for names, speech bubbles and click targets.
import * as S from "./sprites.js";

const W = 600;
const WALL = 44;
const COL_L = 150, COL_R = 492;
const POD_X0 = 156, POD_W = 110, POD_H = 122, ROW0 = 52;
const SLOTS = [[20, "down"], [68, "down"], [20, "up"], [68, "up"]];

export function poseFor(sess, seatStatus) {
  if (!sess) return "idle";
  if (sess.state === "limited" || seatStatus === "limited") return "sleep";
  if (sess.state === "stuck") return "stuck";
  if (sess.state === "idle" || sess.state === "done") return "idle";
  if (sess.state === "waiting") return "wait";
  const k = sess.activity_kind;
  if (k === "type" || k === "read" || k === "think" || k === "talk" || k === "delegate" || k === "wait") return k;
  return "type";
}

function skyFor(d) {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 5.5 || h >= 20) return { sky: ["#0b1030", "#1b2350"], night: true, dim: 0.28 };
  if (h < 7.5) return { sky: ["#3a4a8a", "#f2a65a"], night: false, dim: 0.12 };
  if (h < 17) return { sky: ["#6fb3ff", "#bfe3ff"], night: false, dim: 0 };
  if (h < 20) return { sky: ["#3b2f6b", "#f07a5a"], night: false, dim: 0.14 };
  return { sky: ["#0b1030", "#1b2350"], night: true, dim: 0.28 };
}

function ago(ts, now) {
  if (!ts) return "";
  const s = Math.max(0, Math.round(now - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`;
}

export function createOffice(canvas, overlay, handlers) {
  const ctx = canvas.getContext("2d");
  const bg = document.createElement("canvas");
  const bgx = bg.getContext("2d");
  let snap = null, layout = null, scale = 2, H = 320, bgKey = "";
  const fresh = new Map();   // session id -> {text, until}
  let hoverId = null, selected = null, privacy = false;

  function computeLayout() {
    const seats = snap ? snap.seats : [];
    const slots = seats.length + 1;                  // + the hiring desk
    const rows = Math.max(2, Math.ceil(slots / 3));
    H = ROW0 + rows * (POD_H + 4) + 4;
    const pods = seats.map((s, i) => ({ seat: s, x: POD_X0 + (i % 3) * POD_W, y: ROW0 + Math.floor(i / 3) * (POD_H + 4) }));
    const hi = seats.length;
    const hire = { x: POD_X0 + (hi % 3) * POD_W, y: ROW0 + Math.floor(hi / 3) * (POD_H + 4) };
    const splitY = ROW0 + POD_H + 4;
    return { pods, hire, rows, splitY, ceo: { x: 0, y: WALL, w: COL_L, h: splitY - WALL - 6 },
             server: { x: 0, y: splitY, w: COL_L, h: H - splitY }, meet: { x: COL_R, y: WALL, w: W - COL_R, h: splitY - WALL - 6 },
             lounge: { x: COL_R, y: splitY, w: W - COL_R, h: H - splitY } };
  }

  // ------------------------------------------------------------------------------------------ static layer
  function drawStatic() {
    bg.width = W; bg.height = H;
    const c = bgx;
    // floor planks
    for (let y = WALL; y < H; y += 6) {
      S.rect(c, 0, y, W, 6, ((y / 6) | 0) % 2 ? S.P.floorA : S.P.floorB);
      for (let x = ((y / 6) | 0) % 2 ? 0 : 18; x < W; x += 36) S.rect(c, x, y, 1, 6, S.P.floorLine);
    }
    // back wall
    S.rect(c, 0, 0, W, WALL, S.P.wall);
    S.rect(c, 0, WALL - 8, W, 8, S.P.wainscot);
    S.rect(c, 0, WALL - 9, W, 1, S.P.trim);
    S.rect(c, 0, WALL, W, 2, "rgba(0,0,0,0.25)");
    const L = layout;
    // CEO cabin: carpet + glass walls
    for (let y = L.ceo.y; y < L.ceo.y + L.ceo.h; y += 4) S.rect(c, 0, y, L.ceo.w, 4, ((y / 4) | 0) % 2 ? S.P.carpet : S.P.carpetB);
    S.rect(c, L.ceo.w, L.ceo.y, 3, L.ceo.h, S.P.glass);
    S.rect(c, L.ceo.w + 1, L.ceo.y, 1, L.ceo.h, S.P.glassEdge);
    S.rect(c, 0, L.ceo.y + L.ceo.h, L.ceo.w - 34, 3, S.P.glass);
    S.rect(c, 0, L.ceo.y + L.ceo.h + 1, L.ceo.w - 34, 1, S.P.glassEdge);
    // rug + CEO desk
    S.rect(c, 26, L.ceo.y + 40, 98, 56, "#7a3f4f"); S.rect(c, 29, L.ceo.y + 43, 92, 50, "#8f4b5d");
    S.drawBookshelf(c, 8, 12, 46);
    S.drawPlant(c, 6, L.ceo.y + L.ceo.h - 22, true);
    S.drawPlant(c, L.ceo.w - 18, L.ceo.y + 8, false);
    // server room floor
    for (let y = L.server.y; y < H; y += 8) for (let x = 0; x < L.server.w; x += 8) {
      S.rect(c, x, y, 8, 8, ((x + y) / 8) % 2 ? S.P.tile : S.P.tileB);
      S.rect(c, x, y, 8, 1, S.P.tileLine);
    }
    S.rect(c, L.server.w, L.server.y, 3, L.server.h, "#1b1d28");
    // meeting room
    for (let y = L.meet.y; y < L.meet.y + L.meet.h; y += 4) S.rect(c, L.meet.x, y, L.meet.w, 4, ((y / 4) | 0) % 2 ? S.P.meet : S.P.meetB);
    S.rect(c, L.meet.x - 3, L.meet.y, 3, L.meet.h, S.P.glass);
    S.rect(c, L.meet.x - 2, L.meet.y, 1, L.meet.h, S.P.glassEdge);
    const tx = L.meet.x + 22, ty = L.meet.y + 46;
    S.rect(c, tx + 2, ty + 34, 62, 3, S.P.shadow);
    S.rect(c, tx, ty, 64, 34, "#6b4a32"); S.rect(c, tx + 2, ty + 2, 60, 30, "#7d583c");
    for (let i = 0; i < 3; i++) {
      S.drawChairFront(c, tx + 6 + i * 20, ty - 12);
      S.drawChairBack(c, tx + 7 + i * 20, ty + 36);
    }
    // lounge
    for (let y = L.lounge.y; y < H; y += 4) S.rect(c, L.lounge.x, y, L.lounge.w, 4, ((y / 4) | 0) % 2 ? S.P.rug : S.P.rugB);
    S.rect(c, L.lounge.x - 3, L.lounge.y, 3, L.lounge.h, S.P.glass);
    S.drawCouch(c, L.lounge.x + 12, L.lounge.y + 22, "#c0564b");
    S.drawCouch(c, L.lounge.x + 12, L.lounge.y + 74, "#c0564b");
    S.rect(c, L.lounge.x + 22, L.lounge.y + 46, 26, 14, "#6b4a32");
    S.drawPlant(c, L.lounge.x + 88, L.lounge.y + 4, true);
    // pods: team rugs + desk islands
    for (const p of L.pods) {
      const col = p.seat.color;
      c.globalAlpha = 0.22; S.rect(c, p.x + 3, p.y + 6, POD_W - 6, 92, col); c.globalAlpha = 1;
      S.rect(c, p.x + 3, p.y + 6, POD_W - 6, 1, S.shade(col, 0.9));
      S.drawDeskIsland(c, p.x + 8, p.y + 36, POD_W - 16, 30);
      S.drawPlant(c, p.x + POD_W - 16, p.y + 82, false);
    }
    // hiring desk
    const h = L.hire;
    S.rect(c, h.x + 14, h.y + 30, 80, 22, S.P.deskEdge); S.rect(c, h.x + 14, h.y + 28, 80, 6, S.P.deskTop);
    S.drawChairFront(c, h.x + 47, h.y + 14);
    S.drawPlant(c, h.x + 10, h.y + 76, true);
  }

  // ----------------------------------------------------------------------------------------- dynamic layer
  function drawFrame(t) {
    if (!layout) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bg, 0, 0);
    const now = new Date();
    const env = skyFor(now);
    // windows, clock, wall TV
    const winY = 8, winH = 22;
    S.drawWindow(ctx, 62, winY, 60, winH, env.sky, t, env.night);
    S.drawWindow(ctx, 382, winY, 96, winH, env.sky, t, env.night);
    S.rect(ctx, 130, 9, 118, 20, "#1a1424"); S.rect(ctx, 131, 10, 116, 18, "#221a30");
    S.drawClock(ctx, 255, 12, now);
    drawTV(t);
    drawWhiteboard();
    drawCEO(t);
    drawServerRoom(t);
    for (const p of layout.pods) drawPod(p, t);
    drawHire(t);
    drawLounge(t);
    drawMeeting(t);
    S.drawCoffeeMachine(ctx, layout.lounge.x + 70, layout.lounge.y + 46, t);
    S.drawArcade(ctx, layout.lounge.x + 88, H - 30, t);
    S.drawWaterCooler(ctx, layout.lounge.x + 4, H - 26, t);
    if (env.dim) {
      ctx.fillStyle = `rgba(8,12,40,${env.dim})`; ctx.fillRect(0, WALL, W, H - WALL);
      for (const p of layout.pods) {
        const busy = p.seat.sessions.some(x => x.live !== false && (x.state === "working" || x.state === "waiting"));
        if (busy) S.drawLampGlow(ctx, p.x + POD_W / 2, p.y + 50, 52, "rgba(255,214,140,ALPHA)", 0.22);
      }
      S.drawLampGlow(ctx, 75, layout.ceo.y + 64, 56, "rgba(255,214,140,ALPHA)", 0.25);
    }
  }

  function drawTV(t) {
    const x = 274, y = 6, w = 96, h = 28;
    S.rect(ctx, x - 2, y - 2, w + 4, h + 4, "#0d0e14");
    S.rect(ctx, x, y, w, h, "#121726");
    const seats = snap.seats;
    const bw = Math.max(4, Math.floor((w - 6) / Math.max(1, seats.length)) - 3);
    seats.forEach((s, i) => {
      const bx = x + 4 + i * (bw + 3);
      const u = s.usage || {};
      for (const [k, off, a] of [["five_hour", 0, 1], ["weekly", Math.ceil(bw / 2), 0.55]]) {
        const pct = u[k] && u[k].pct != null ? u[k].pct : null;
        const hh = h - 8;
        S.rect(ctx, bx + off, y + 3, Math.floor(bw / 2), hh, "#1e2438");
        if (pct != null) {
          const left = Math.max(0, 100 - pct) / 100;
          ctx.globalAlpha = a;
          S.rect(ctx, bx + off, y + 3 + hh - Math.round(hh * left), Math.floor(bw / 2), Math.round(hh * left), pct >= 90 ? "#ff4d5e" : s.color);
          ctx.globalAlpha = 1;
        }
      }
      S.rect(ctx, bx, y + h - 4, bw, 1, s.color);
    });
    if (Math.floor(t / 900) % 2) S.rect(ctx, x + w - 4, y + 2, 2, 2, "#ff4d5e");
  }

  function drawWhiteboard() {
    const x = COL_R + 8, y = 6, w = W - COL_R - 16, h = 30;
    S.rect(ctx, x - 1, y - 1, w + 2, h + 2, "#9aa3b5");
    S.rect(ctx, x, y, w, h, "#f5f6f8");
    const progs = (snap.programmes || []).slice(0, 4);
    progs.forEach((p, i) => {
      const done = p.sessions.filter(s => s.report_status).length;
      S.rect(ctx, x + 3, y + 4 + i * 6, 3, 3, ["#5b8def", "#3fb68b", "#d97757", "#c678dd"][i % 4]);
      S.rect(ctx, x + 8, y + 5 + i * 6, Math.min(w - 26, 10 + p.name.length * 2), 1, "#39404f");
      for (let k = 0; k < Math.min(6, p.sessions.length); k++) S.rect(ctx, x + w - 16 + k * 2, y + 4 + i * 6, 1, 3, k < done ? "#3fb68b" : "#e5a50a");
    });
    S.rect(ctx, x + w - 10, y + h, 8, 2, "#c94f4f");
  }

  function drawCEO(t) {
    const L = layout.ceo;
    const dx = 36, dy = L.y + 58;
    const attn = (snap.attention || []).filter(a => a.level !== "info").length;
    const look = { skin: S.P.skin[1], hair: "#1f1a17", style: 0, shirt: "#24304f", glasses: false };
    S.drawChairFront(ctx, dx + 31, dy - 22);
    S.drawPerson(ctx, dx + 33, dy - 18, look, "down", attn ? "talk" : "idle", t);
    S.rect(ctx, dx + 37, dy - 10, 2, 3, "#c94f4f");     // tie
    S.rect(ctx, dx + 35, dy - 21, 6, 1, "#ffd24a");     // crown
    S.rect(ctx, dx + 35, dy - 22, 1, 1, "#ffd24a"); S.rect(ctx, dx + 37, dy - 23, 2, 2, "#ffd24a"); S.rect(ctx, dx + 40, dy - 22, 1, 1, "#ffd24a");
    S.rect(ctx, dx + 2, dy + 26, 74, 3, S.P.shadow);
    S.rect(ctx, dx, dy, 78, 24, "#5a3a24"); S.rect(ctx, dx, dy, 78, 3, "#7a5034"); S.rect(ctx, dx + 2, dy + 22, 74, 2, "#41291a");
    S.drawMonitorBack(ctx, dx + 30, dy - 6, null);
    S.rect(ctx, dx + 30, dy + 9, 18, 5, "#c8a046"); S.rect(ctx, dx + 31, dy + 10, 16, 3, "#e8c66a");   // nameplate
    // the phone rings when something needs the CEO
    const ring = attn && Math.floor(t / 160) % 6 < 3 ? (Math.floor(t / 80) % 2 ? 1 : -1) : 0;
    S.rect(ctx, dx + 62 + ring, dy + 4, 8, 5, attn ? "#d94a4a" : "#30343f");
    S.rect(ctx, dx + 61 + ring, dy + 3, 10, 2, attn ? "#ff6b6b" : "#454a5c");
    S.drawMug(ctx, dx + 10, dy + 6, t, true);
    S.rect(ctx, dx + 16, dy + 5, 8, 6, S.P.white); S.rect(ctx, dx + 17, dy + 6, 6, 1, "#9aa3b5"); S.rect(ctx, dx + 17, dy + 8, 4, 1, "#9aa3b5");
  }

  function drawServerRoom(t) {
    const L = layout.server;
    const units = (snap.units || []).slice(0, 10);
    const per = 5;
    const n = Math.max(units.length, 4);
    for (let i = 0; i < n; i++) {
      const u = units[i];
      const x = 10 + (i % per) * 26, y = L.y + 14 + Math.floor(i / per) * 52;
      if (y + 40 > H) break;
      S.drawRack(ctx, x, y, 40, u ? u.active : "inactive", t, u ? u.unit : "spare" + i);
    }
  }

  function drawPod(p, t) {
    const s = p.seat;
    const live = s.sessions.filter(x => x.live !== false);
    const status = s.status;
    const off = status === "offline";
    SLOTS.forEach(([sx, facing], i) => {
      const sess = live[i];
      const x = p.x + sx, look = sess ? S.lookFor(sess.id, s.color) : null;
      const pose = sess ? poseFor(sess, status) : null;
      if (facing === "down") {
        S.drawChairFront(ctx, x - 2, p.y + 14);
        if (sess) {
          S.drawPerson(ctx, x, p.y + 18, look, "down", pose, t + i * 777);
          if (sess.kind === "desk") { S.rect(ctx, x - 1, p.y + 21, 1, 3, "#30343f"); S.rect(ctx, x + 10, p.y + 21, 1, 3, "#30343f"); S.rect(ctx, x, p.y + 17, 10, 1, "#30343f"); }
        }
        S.drawMonitorBack(ctx, x - 3, p.y + 29, sess && !off && pose !== "sleep" ? null : null);
        if (sess && pose !== "sleep") S.drawHands(ctx, x, p.y + 38, look, pose, t + i * 333);
        if (sess && pose === "sleep") S.drawZ(ctx, x + 8, p.y + 14, t + i * 500);
        if (sess && (pose === "idle" || pose === "wait")) S.drawMug(ctx, x + 12, p.y + 40, t, pose === "wait");
      } else {
        S.drawMonitorFront(ctx, x - 3, p.y + 46, sess && !off ? pose : "off", s.color, t + i * 1234);
        if (sess) {
          const by = pose === "sleep" ? p.y + 61 : p.y + 60;
          S.drawPerson(ctx, x, by, look, "up", pose, t + i * 777);
          if (sess.kind === "desk") { S.rect(ctx, x, by + 1, 10, 1, "#30343f"); S.rect(ctx, x - 1, by + 3, 1, 3, "#30343f"); S.rect(ctx, x + 10, by + 3, 1, 3, "#30343f"); }
          if (pose === "sleep") S.drawZ(ctx, x + 8, p.y + 58, t + i * 500);
        }
        S.drawChairBack(ctx, x - 1, p.y + 72);
      }
      if (sess && pose === "delegate") {     // a helper stands by the desk
        const hx = x + (facing === "down" ? 12 : 13), hy = facing === "down" ? p.y + 20 : p.y + 70;
        S.drawPerson(ctx, hx, hy, { ...S.lookFor(sess.id + "h", S.shade(s.color, 1.25)), style: 2 }, "down", "talk", t);
      }
      if (sess && pose === "stuck" && Math.floor(t / 500) % 2) {
        const qy = facing === "down" ? p.y + 10 : p.y + 52;
        S.rect(ctx, x + 4, qy, 3, 1, "#ffb020"); S.rect(ctx, x + 6, qy + 1, 1, 2, "#ffb020"); S.rect(ctx, x + 5, qy + 3, 1, 1, "#ffb020"); S.rect(ctx, x + 5, qy + 5, 1, 1, "#ffb020");
      }
    });
    if (off) {   // a sticky note: this seat needs a login
      S.rect(ctx, p.x + 46, p.y + 40, 14, 12, "#ffe066"); S.rect(ctx, p.x + 48, p.y + 43, 10, 1, "#8a6d00"); S.rect(ctx, p.x + 48, p.y + 46, 7, 1, "#8a6d00");
    }
    // status lamp on the island
    const lamp = { working: "#38e07b", idle: "#e5c07b", limited: "#ff4d5e", benched: "#5b8def", offline: "#6b7080" }[status] || "#6b7080";
    S.rect(ctx, p.x + POD_W / 2 - 1, p.y + 38, 3, 3, lamp);
    if (status === "working" && Math.floor(t / 600) % 2) S.rect(ctx, p.x + POD_W / 2 - 2, p.y + 37, 5, 5, "rgba(56,224,123,0.25)");
  }

  function drawHire(t) {
    const h = layout.hire;
    S.rect(ctx, h.x + 26, h.y + 4, 56, 12, "#2c3047");
    const blink = Math.floor(t / 700) % 2;
    S.rect(ctx, h.x + 28, h.y + 6, 52, 8, blink ? "#3fb68b" : "#2f8a69");
    for (let i = 0; i < 6; i++) S.rect(ctx, h.x + 32 + i * 8, h.y + 9, 5, 2, "#eafff6");
    S.rect(ctx, h.x + 40, h.y + 34, 10, 7, S.P.white); S.rect(ctx, h.x + 42, h.y + 36, 6, 1, "#9aa3b5"); S.rect(ctx, h.x + 42, h.y + 38, 4, 1, "#9aa3b5");
    S.rect(ctx, h.x + 56, h.y + 33, 2, 8, "#2b2f3a");
  }

  function drawMeeting(t) {
    // One representative per running programme sits at the table, wearing its whiteboard colour.
    const tx = COL_R + 22, ty = WALL + 46;
    const cols = ["#5b8def", "#3fb68b", "#d97757", "#c678dd", "#e5a50a", "#56b6c2"];
    (snap.programmes || []).slice(0, 6).forEach((p, i) => {
      const top = i < 3, k = i % 3;
      const x = tx + 8 + k * 20;
      const look = S.lookFor("prog-" + p.name, cols[i % cols.length]);
      if (top) S.drawPerson(ctx, x, ty - 9, look, "down", p.sessions.some(s => s.state === "working") ? "talk" : "idle", t + i * 600);
      else { S.drawPerson(ctx, x, ty + 30, look, "up", "idle", t); S.drawChairBack(ctx, x - 1, ty + 36); }
    });
    if ((snap.programmes || []).length) {   // papers on the table
      S.rect(ctx, tx + 12, ty + 10, 7, 5, S.P.white); S.rect(ctx, tx + 40, ty + 14, 7, 5, S.P.white);
    }
  }

  function drawLounge(t) {
    // Seats with nobody at their desk take a break here; a seat out of plan sleeps it off.
    const L = layout.lounge;
    const resting = snap.seats.filter(s => ["limited", "benched", "offline"].includes(s.status) || s.sessions.filter(x => x.live !== false).length === 0);
    const spots = [[L.x + 18, L.y + 16], [L.x + 36, L.y + 16], [L.x + 18, L.y + 68], [L.x + 36, L.y + 68]];
    resting.slice(0, 4).forEach((s, i) => {
      const [x, y] = spots[i];
      const pose = s.status === "limited" ? "sleep" : "idle";
      S.drawPerson(ctx, x, y, S.lookFor("mascot-" + s.id, s.color), "down", pose, t + i * 911);
      if (pose === "sleep") S.drawZ(ctx, x + 8, y - 2, t + i * 300);
      else S.drawMug(ctx, x + 11, y + 10, t, true);
    });
  }

  // ------------------------------------------------------------------------------------------- overlay
  function px(v) { return (v * scale / devicePixelRatio) + "px"; }

  function place(el, x, y, w, h) {
    el.style.left = px(x); el.style.top = px(y);
    if (w != null) el.style.width = px(w);
    if (h != null) el.style.height = px(h);
  }

  function hot(cls, label, x, y, w, h, onClick, key) {
    const b = document.createElement("button");
    b.className = "hot " + cls; b.type = "button"; b.setAttribute("aria-label", label); b.title = label;
    if (key) b.dataset.key = key;
    place(b, x, y, w, h);
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    overlay.appendChild(b);
    return b;
  }

  function renderOverlay() {
    overlay.innerHTML = "";
    if (!layout) return;
    const now = snap.now;
    const L = layout;
    // rooms
    hot("room", "CEO office: briefing, alerts, capacity", L.ceo.x, L.ceo.y, L.ceo.w, L.ceo.h, () => handlers.openCEO(), "ceo");
    hot("room", "Server room: background services", L.server.x, L.server.y, L.server.w, L.server.h, () => handlers.openServices(), "server");
    hot("room", "Meeting room: programmes", L.meet.x, 0, L.meet.w, L.meet.h + WALL, () => handlers.openProgrammes(), "meet");
    hot("room", "Lounge", L.lounge.x, L.lounge.y, L.lounge.w, L.lounge.h, () => handlers.openLounge(), "lounge");
    hot("tv", "Capacity board: plan left on every seat", 272, 4, 100, 32, () => handlers.openDivider(), "tv");
    label("room-label", "CEO", 6, L.ceo.y + 4);
    label("room-label", "SERVER ROOM", 6, L.server.y + 3);
    label("room-label", "MEETING", L.meet.x + 6, L.meet.y + 4);
    label("room-label", "LOUNGE", L.lounge.x + 6, L.lounge.y + 3);
    const sign = label("neon", snap.office.name || "Claude Office", 130, 9);
    sign.style.width = px(118); sign.style.height = px(20);
    // whiteboard text
    const wb = document.createElement("div");
    wb.className = "wb"; place(wb, COL_R + 10, 7, W - COL_R - 34, 28);
    (snap.programmes || []).slice(0, 4).forEach(p => { const d = document.createElement("div"); d.textContent = p.name; wb.appendChild(d); });
    if (!(snap.programmes || []).length) wb.innerHTML = "<div class='muted'>No programmes</div>";
    overlay.appendChild(wb);
    // hiring desk
    hot("hire", "Hiring desk: start a new lane", L.hire.x + 10, L.hire.y + 2, POD_W - 20, POD_H - 10, () => handlers.openHire(), "hire");
    const ht = label("plate hire-plate", "NOW HIRING", L.hire.x + 30, L.hire.y + 92);
    ht.style.left = px(L.hire.x + 18); ht.style.width = px(74);
    // pods
    for (const p of L.pods) {
      const s = p.seat;
      const live = s.sessions.filter(x => x.live !== false);
      const plate = document.createElement("button");
      plate.type = "button";
      plate.className = `plate seat-plate st-${s.status}` + (selected && selected.seat === s.id && !selected.session ? " sel" : "");
      plate.style.setProperty("--seat", s.color);
      place(plate, p.x + 6, p.y + 92, POD_W - 12, null);
      const u = s.usage || {};
      const pct = (k) => (u[k] && u[k].pct != null ? Math.round(u[k].pct) : null);
      const p5 = pct("five_hour"), pw = pct("weekly");
      plate.innerHTML = `<span class="dot"></span><b>${esc(s.label)}</b>` +
        (s.nickname ? `<i>${esc(s.nickname)}</i>` : "") +
        `<span class="mini" title="5-hour window used">${p5 == null ? "–" : p5 + "%"}</span>` +
        `<span class="mini wk" title="Weekly allowance used">${pw == null ? "–" : pw + "%"}</span>` +
        (live.length > 4 ? `<span class="more">+${live.length - 4}</span>` : "") +
        ((s.tokens_1h || 0) > 400000 ? `<span class="burn" title="Burning fast: ${fmtTok(s.tokens_1h)} tokens in the last hour">▲</span>` : "");
      plate.setAttribute("aria-label", `${s.label}: ${s.status}, ${live.length} live sessions`);
      plate.addEventListener("click", (e) => { e.stopPropagation(); handlers.openSeat(s.id); });
      overlay.appendChild(plate);
      hot("pod", `${s.label} desks`, p.x + 4, p.y + 8, POD_W - 8, 82, () => handlers.openSeat(s.id), "pod-" + s.id);
      SLOTS.forEach(([sx, facing], i) => {
        const sess = live[i];
        if (!sess) return;
        const x = p.x + sx;
        const top = facing === "down";
        const b = hot("worker" + (selected && selected.session === sess.id ? " sel" : ""), `${sess.name} (${sess.state}), open details`,
          x - 4, top ? p.y + 14 : p.y + 56, 18, top ? 26 : 24, () => handlers.openSession(s.id, sess.id), "w-" + sess.id);
        b.addEventListener("mouseenter", () => { hoverId = sess.id; renderBubbles(); });
        b.addEventListener("mouseleave", () => { hoverId = null; renderBubbles(); });
        const tag = document.createElement("div");
        tag.className = `tag st-${sess.state} k-${sess.kind}`;
        tag.textContent = shortName(sess.name);
        tag.dataset.sid = sess.id;
        place(tag, x + 5, top ? p.y + 41 : p.y + 83, null, null);
        overlay.appendChild(tag);
      });
    }
    renderBubbles();
    function label(cls, text, x, y) {
      const d = document.createElement("div");
      d.className = cls; d.textContent = text; place(d, x, y);
      overlay.appendChild(d); return d;
    }
  }

  function bubbleText(sess) {
    if (privacy && sess.kind === "desk") return sess.state === "idle" ? "Idle" : "Working…";
    if (sess.state === "limited") return "Out of plan: " + (sess.limit_text || "waiting for reset");
    if (sess.state === "stuck") return `Quiet for ${ago(snap.now - (sess.quiet_s || 0), snap.now)}: ${sess.activity || ""}`;
    if (sess.state === "waiting") return "⏳ " + (sess.activity || "Waiting");
    return sess.activity || sess.state;
  }

  function renderBubbles() {
    if (!layout) return;
    const t = performance.now();
    const want = new Set();
    for (const p of layout.pods) {
      const live = p.seat.sessions.filter(x => x.live !== false);
      SLOTS.forEach(([sx, facing], i) => {
        const sess = live[i];
        if (!sess) return;
        const f = fresh.get(sess.id);
        const show = hoverId === sess.id || (selected && selected.session === sess.id) || (f && f.until > t);
        if (!show) return;
        want.add(sess.id);
        let b = overlay.querySelector(`.bubble[data-sid="${CSS.escape(sess.id)}"]`);
        if (!b) { b = document.createElement("div"); b.dataset.sid = sess.id; overlay.appendChild(b); }
        b.className = "bubble" + (facing === "down" ? "" : " low") + (sess.state === "limited" ? " bad" : sess.state === "stuck" ? " warn" : "");
        const txt = bubbleText(sess);
        if (b.textContent !== txt) b.textContent = txt;
        place(b, p.x + sx + 5, facing === "down" ? p.y + 13 : p.y + 55);
      });
    }
    overlay.querySelectorAll(".bubble").forEach(b => { if (!want.has(b.dataset.sid)) b.remove(); });
  }

  function shortName(n) {
    n = (n || "").replace(/^wt-/, "");
    return n.length > 16 ? n.slice(0, 15) + "…" : n;
  }

  // -------------------------------------------------------------------------------------------- public
  function resize() {
    const box = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const want = box.width * dpr;
    scale = Math.max(1, want / W);
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    canvas.style.width = (W * scale / dpr) + "px";
    canvas.style.height = (H * scale / dpr) + "px";
    overlay.style.width = canvas.style.width; overlay.style.height = canvas.style.height;
    overlay.style.setProperty("--s", scale / dpr);
    ovKey = "";
    renderOverlayIfChanged();
  }

  function update(next) {
    const prev = snap;
    snap = next;
    // pop a bubble whenever an agent starts something new
    const prevAct = new Map();
    if (prev) for (const s of prev.seats) for (const x of s.sessions) prevAct.set(x.id, x.activity);
    const t = performance.now();
    for (const s of snap.seats) for (const x of s.sessions) {
      if (x.live === false) continue;
      const busy = x.state === "working" || x.state === "waiting";
      if (!prev && busy) fresh.set(x.id, { until: t + 9000 });
      else if (prev && prevAct.get(x.id) !== x.activity && busy) fresh.set(x.id, { until: t + 7000 });
    }
    const key = JSON.stringify(snap.seats.map(s => [s.id, s.color])) + (snap.units || []).length;
    layout = computeLayout();
    if (key !== bgKey || bg.height !== H) { drawStatic(); bgKey = key; resize(); }
    else renderOverlayIfChanged();
  }

  let ovKey = "";
  function overlaySig() {
    return JSON.stringify([selected, snap.office.name, (snap.programmes || []).map(p => p.name), snap.seats.map(s => {
      const u = s.usage || {};
      return [s.id, s.label, s.nickname, s.status, u.five_hour && Math.round(u.five_hour.pct), u.weekly && Math.round(u.weekly.pct),
        (s.tokens_1h || 0) > 400000, s.sessions.filter(x => x.live !== false).map(x => [x.id, x.name, x.state, x.kind])];
    })]);
  }
  function renderOverlayIfChanged() {
    const sig = overlaySig();
    if (sig === ovKey) { renderBubbles(); return; }
    ovKey = sig;
    renderOverlay();
  }

  function setSelected(sel) { selected = sel; ovKey = ""; if (snap) renderOverlayIfChanged(); }
  function setPrivacy(on) { privacy = on; renderBubbles(); }

  let last = 0;
  function loop(t) {
    if (t - last > 33) { drawFrame(t); last = t; }
    if (Math.floor(t / 1000) !== Math.floor((t - 34) / 1000)) renderBubblesIfExpired(t);
    requestAnimationFrame(loop);
  }
  function renderBubblesIfExpired(t) {
    let changed = false;
    for (const [k, v] of fresh) if (v.until < t) { fresh.delete(k); changed = true; }
    if (changed) renderBubbles();
  }
  requestAnimationFrame(loop);
  let lastW = 0;
  new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (!layout || w === lastW) return;
    lastW = w;
    requestAnimationFrame(resize);
  }).observe(canvas.parentElement);
  return { update, setSelected, setPrivacy };
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function fmtTok(n) {
  if (n == null) return "–";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}

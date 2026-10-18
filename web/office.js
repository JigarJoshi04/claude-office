// The office floor engine: a pixel canvas rendered at a whole-number scale, a DOM overlay for names, bubbles
// and click targets, a camera you can zoom and pan, agents that walk in from the elevator, and night lighting.
import * as S from "./engine/sprites.js";
import { WALL, POD_W, POD_H, ROOM_H, LOBBY_W, ELEVATOR, SPINE_X, WALK_Y, computeLayout, planFor, seatSpot, pathTo, drawStatic, capFor, deskFor } from "./engine/scene.js";
import { windowRect, drawDecorLive } from "./engine/decor.js";

const SPEED = 46;                 // logical px per second
const MAX_SLOTS = 6;
const BACK_LABEL = 42;            // room labels sit just under a room's back wall
const PROG_COLORS = ["#5b8def", "#3fb68b", "#d97757", "#c678dd", "#e5a50a", "#56b6c2", "#e06c75", "#98c379"];

export function poseFor(sess, seatStatus) {
  if (!sess) return "idle";
  if (sess.state === "limited" || seatStatus === "limited") return "sleep";
  if (sess.state === "stuck") return "stuck";
  if (sess.state === "idle" || sess.state === "done") return "idle";
  if (sess.state === "waiting") return "wait";
  const k = sess.activity_kind;
  return ["type", "read", "think", "talk", "delegate", "wait"].includes(k) ? k : "type";
}

function skyFor(d) {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 5.5 || h >= 20) return { sky: ["#070b26", "#18204a"], night: true, dark: 0.36 };
  if (h < 7.5) return { sky: ["#34407e", "#f2a65a"], night: false, dark: 0.16 };
  if (h < 17) return { sky: ["#5fa8ff", "#bfe3ff"], night: false, dark: 0 };
  return { sky: ["#35296a", "#f07a5a"], night: false, dark: 0.18 };
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

export function createOffice(stage, handlers) {
  stage.innerHTML = `<div class="world"><canvas aria-hidden="true"></canvas><div class="overlay"></div></div>
    <div class="cam" role="group" aria-label="Camera">
      <button type="button" data-cam="in" title="Zoom in (+)" aria-label="Zoom in">+</button>
      <button type="button" data-cam="out" title="Zoom out (−)" aria-label="Zoom out">−</button>
      <button type="button" data-cam="fit" title="Fit the office (0)" aria-label="Fit the office">⤢</button>
      <button type="button" data-cam="legend" title="What the floor shows" aria-label="What the floor shows" aria-expanded="false">?</button>
    </div>
    <div class="cam-hint">Ctrl + scroll or pinch to zoom · drag to pan · double-click a desk to focus</div>`;
  const world = stage.querySelector(".world");
  const canvas = stage.querySelector("canvas");
  const overlay = stage.querySelector(".overlay");
  const ctx = canvas.getContext("2d");
  const bg = document.createElement("canvas"), bgx = bg.getContext("2d");
  const lightC = document.createElement("canvas"), lx = lightC.getContext("2d");

  let snap = null, L = null, W = 768, H = 340, F = 1, RES = 1, staticKey = "", ovKey = "";
  let plan = { cols: 3, roomH: ROOM_H };   // rooms per row and room height, re-planned to fill the frame (resize)
  let selected = null, privacy = false, reduced = false, mvp = null, hoverId = null, persona = null;
  let spot = null;
  let skyKey = "";
  let walkBoost = 1;                   // replay speeds walking up so arrivals reach their desks in replay time                     // a seat being pointed at in the inspector or on the floor: its room lights up
  const said = new Map();              // session id -> {text, until, at}: personality lines
  const agents = new Map();          // session id -> agent
  let leavers = [];                   // agents walking out
  const fresh = new Map();            // session id -> bubble expiry
  const particles = [];
  const pops = [];
  const xpSeen = new Map();           // seat id -> {xp, pending, at}: XP floaters over each desk
  const elevator = { open: 0, until: 0 };
  const cam = { z: 1, x: 0, y: 0, tz: 1, tx: 0, ty: 0 };
  let first = true, lastT = performance.now(), ceoPace = 0;
  const cat = { x: 140, y: 60, tx: 140, ty: 60, path: [], mode: "sit", until: 0, facing: 1, el: null };
  const TIPS = ["Ctrl + K jumps to any seat, session or action.", "Double-click a desk to fly the camera to it.",
    "Click a person, then Chat, to message them.", "The load divider decides who gets the next lane.",
    "Take a checkpoint before you restart the laptop.", "Share-safe mode blurs topics before a screen share.",
    "Today shows who carried the day.", "A drone by a desk means a subagent is working.", "Meow."];

  // ---------------------------------------------------------------------------------------- agents
  function assign() {
    const seen = new Set();
    for (const pod of L.pods) {
      const want = pod.seat.sessions.filter(x => x.live !== false).slice(0, MAX_SLOTS);
      pod.cap = capFor(want.length);                 // the desk grows and shrinks with the people at it
      pod.y = pod.baseY + (pod.cap <= 3 ? 12 : 0);   // one row of seats sits lower, centred in the room
      const taken = new Set();
      const keep = new Set();
      for (const x of want) {
        const a = agents.get(x.id);
        if (a && a.seatId === pod.seat.id && a.slot < pod.cap && !taken.has(a.slot)) { taken.add(a.slot); keep.add(x.id); }
      }
      for (const x of want) {
        seen.add(x.id);
        let a = agents.get(x.id);
        if (a && keep.has(x.id)) { a.sess = x; a.pod = pod; continue; }
        let slot = 0; while (taken.has(slot)) slot++;
        taken.add(slot);
        const look = S.lookFor(x.id, pod.seat.color);
        if (!a) {
          a = { id: x.id, seatId: pod.seat.id, slot, sess: x, pod, look, mode: "seated", x: 0, y: 0, path: [], facing: "down" };
          if (!first && !reduced) {      // a new arrival walks in from the elevator
            const p = pathTo(L, pod, slot);
            a.mode = "walking"; a.x = p[0][0]; a.y = p[0][1]; a.path = p.slice(1); openElevator();
            if (persona) said.set(x.id, { text: persona(pod.seat).lines.arrive, until: performance.now() + 9000, at: performance.now() });
          }
          agents.set(x.id, a);
        } else { Object.assign(a, { slot, pod, seatId: pod.seat.id, sess: x, look, mode: "seated", path: [] }); }
      }
    }
    for (const [id, a] of agents) {
      if (seen.has(id)) continue;
      agents.delete(id);
      if (a.mode === "seated" && !reduced) {      // walk out to the elevator
        const p = pathTo(L, a.pod, a.slot).reverse();
        const sp = seatSpot(a.pod, a.slot);
        leavers.push({ ...a, mode: "leaving", x: sp.cx, y: sp.standY, path: p.slice(1), gone: false, tagEl: null });
      }
    }
  }

  // Pixel walks the lobby, the corridors and the lounge, joined by the walkway down the lobby's right side.
  const SPX = SPINE_X + 4;
  function inLounge(x, y) { const lo = L.lounge; return lo && x >= lo.x && x < lo.x + lo.w && y >= lo.y && y < lo.y + lo.h; }
  function catSpots() {
    const pts = [[40, WALK_Y + 10], [140, WALK_Y + 10], [30, L.ceo.y + 92], [12, L.hire.y + 104]];
    for (const cy of L.corridors) for (let k = 0; k < 4; k++) pts.push([Math.round(LOBBY_W + 54 + k * (W - LOBBY_W - 108) / 3), cy + 5]);
    const lo = L.lounge;
    if (lo) pts.push([lo.x + 70, lo.y + 92], [lo.x + 118, lo.y + 126], [lo.x + 60, lo.y + 136]);
    return pts;
  }
  function catLegs(x, y) {                       // from a point to the walkway, through the lounge door if need be
    if (inLounge(x, y)) { const lo = L.lounge, dx = lo.x + lo.w / 2, cy = lo.y + lo.h + 5; return [[dx, y], [dx, cy], [SPX, cy]]; }
    return [[SPX, y]];
  }
  function stepCat(dt, t) {
    if (!L || reduced) return;
    if (cat.mode === "walk") {
      const dx = cat.tx - cat.x, dy = cat.ty - cat.y, d = Math.hypot(dx, dy), v = 26 * dt;
      if (Math.abs(dx) > 0.5) cat.facing = dx > 0 ? 1 : -1;
      if (d <= v && cat.path.length) { cat.x = cat.tx; cat.y = cat.ty; [cat.tx, cat.ty] = cat.path.shift(); }
      else if (d <= v) { cat.x = cat.tx; cat.y = cat.ty; cat.mode = inLounge(cat.x, cat.y) && Math.random() < 0.6 ? "sleep" : "sit"; cat.until = t + (cat.mode === "sleep" ? 25000 : 4000 + Math.random() * 7000); }
      else { cat.x += dx / d * v; cat.y += dy / d * v; }
    } else if (t > cat.until) {
      const spots = catSpots(), [nx, ny] = spots[Math.floor(Math.random() * spots.length)];
      const out = catLegs(cat.x, cat.y), back = catLegs(nx, ny).reverse();
      cat.path = [...out, [SPX, back[0][1]], ...back.slice(1), [nx, ny]];
      [cat.tx, cat.ty] = cat.path.shift(); cat.mode = "walk";
    }
  }
  function openElevator() { elevator.until = performance.now() + 1600; }

  function stepAgents(dt) {
    const move = (a) => {
      if (!a.path.length) return true;
      const [tx, ty] = a.path[0];
      const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy);
      const step = SPEED * walkBoost * dt;
      if (Math.abs(dx) > Math.abs(dy)) a.facing = dx > 0 ? "right" : "left"; else a.facing = dy > 0 ? "down" : "up";
      if (d <= step) { a.x = tx; a.y = ty; a.path.shift(); return !a.path.length; }
      a.x += dx / d * step; a.y += dy / d * step;
      return false;
    };
    let settled = false;
    for (const a of agents.values()) if (a.mode === "walking" && move(a)) { a.mode = "seated"; settled = true; }
    for (const a of leavers) if (move(a)) { a.gone = true; openElevator(); }
    if (leavers.some(a => a.gone)) { leavers.filter(a => a.gone && a.tagEl).forEach(a => a.tagEl.remove()); leavers = leavers.filter(a => !a.gone); settled = true; }
    if (settled) { ovKey = ""; renderOverlay(); }
  }

  // ------------------------------------------------------------------------------------- particles
  function burst(x, y, n, kind) {
    const cols = ["#ff5d73", "#ffd24a", "#38e07b", "#5b8def", "#c678dd", "#ff9f43", "#56b6c2"];
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, v = 30 + Math.random() * 60;
      particles.push(kind === "spark"
        ? { x, y, vx: Math.cos(ang) * 25, vy: -Math.random() * 30, g: 60, life: 0, max: 0.5 + Math.random() * 0.3, c: Math.random() > 0.5 ? "#ffd24a" : "#ff7a3d", s: 1 }
        : { x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v - 50, g: 90, life: 0, max: 1.4 + Math.random() * 0.8, c: cols[i % cols.length], s: 1 + (i % 2) });
    }
    if (particles.length > 600) particles.splice(0, particles.length - 600);
  }
  function stepParticles(dt) {
    for (const p of particles) { p.life += dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.985; }
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life > particles[i].max) particles.splice(i, 1);
  }
  function drawParticles() {
    for (const p of particles) { ctx.globalAlpha = Math.max(0, 1 - p.life / p.max); S.rect(ctx, p.x, p.y, p.s, p.s, p.c); }
    ctx.globalAlpha = 1;
  }

  // ----------------------------------------------------------------------------------------- render
  function drawFrame(t) {
    ctx.setTransform(RES, 0, 0, RES, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bg, 0, 0, W, H);
    const now = new Date();
    const env = skyFor(now);
    if (env.sky[0] !== skyKey) { skyKey = env.sky[0]; stage.style.setProperty("--sky-a", env.sky[0]); stage.style.setProperty("--sky-b", env.sky[1]); stage.dataset.sky = env.night ? "night" : "day"; }   // the backdrop's sky
    const lights = [];
    drawLobbyWall(t, lights);
    drawCEO(t, lights);
    drawServer(t, lights);
    if (L.meet) drawMeeting(t, env);
    drawLounge(t, lights, env);
    for (const pod of L.pods) drawRoom(pod, t, lights, env);
    drawHire(t, lights);
    const walkers = [...[...agents.values()].filter(a => a.mode === "walking"), ...leavers].sort((a, b) => a.y - b.y);
    for (const a of walkers) S.drawWalker(ctx, a.x, a.y, a.look, a.facing, t, true);
    S.drawCat(ctx, Math.round(cat.x), Math.round(cat.y), cat.mode, cat.facing, t);
    if (cat.mode === "sleep") S.drawZ(ctx, cat.x + 8, cat.y - 2, t);
    drawParticles();
    if (spot) { const p = L.pods.find(p => p.seat.id === spot); if (p) lights.push({ x: p.room.x + p.room.w / 2, y: p.room.y + p.room.h / 2, r: 110, c: p.seat.color, i: 0.5 }); }
    if (env.dark > 0) drawLighting(env, lights);
    else drawSun(t);
    if (spot) drawSpot(t);
  }
  // A glowing outline around the room of the seat being pointed at (drawn over the lighting, so it reads at night).
  function drawSpot(t) {
    const p = L.pods.find(p => p.seat.id === spot);
    if (!p) return;
    const { x, y, w, h } = p.room, a = reduced ? 1 : 0.75 + 0.25 * Math.sin(t / 220), c = p.seat.color;
    const frame = (i, col, alpha) => { ctx.globalAlpha = alpha; S.rect(ctx, x + i, y + i, w - 2 * i, 1, col); S.rect(ctx, x + i, y + h - 1 - i, w - 2 * i, 1, col); S.rect(ctx, x + i, y + i, 1, h - 2 * i, col); S.rect(ctx, x + w - 1 - i, y + i, 1, h - 2 * i, col); };
    frame(0, "#ffffff", a); frame(1, c, a); frame(2, c, a); frame(3, c, a * 0.45); frame(4, c, a * 0.2);   // white rim, the seat's colour, a soft inner glow
    ctx.globalAlpha = 1;
  }

  // The lobby wall: the neon sign (a page element), the elevator, the trophy cabinet and the employee-of-the-day frame.
  function drawLobbyWall(t, lights) {
    S.rect(ctx, 6, 8, 70, 22, "#140f1f"); S.rect(ctx, 7, 9, 68, 20, "#1d1530");
    lights.push({ x: 41, y: 19, r: 40, c: "#ff4fd8", i: 0.55 });
    const open = performance.now() < elevator.until ? 1 : 0;
    elevator.open += (open - elevator.open) * 0.12;
    S.drawElevator(ctx, ELEVATOR.x, ELEVATOR.y, elevator.open, "", t);
    lights.push({ x: ELEVATOR.x + 13, y: ELEVATOR.y - 2, r: 12, c: "#ff8f3d", i: 0.5 });
    const cups = trophies();
    S.drawCabinet(ctx, 116, 8, cups, t);
    if (cups.length) lights.push({ x: 144, y: 22, r: 26, c: "#ffd24a", i: cups.some(c => c.glint) ? 0.4 : 0.22 });
    S.drawFrame(ctx, 176, 12, 16, 22, !!mvp);
    if (mvp) {
      const seat = snap.seats.find(s => s.id === mvp.seat);
      if (seat) S.drawSeated(ctx, 179, 18, S.lookFor("mascot-" + seat.id, seat.color), "down", "idle", t);
      if (Math.floor(t / 600) % 4 === 0) S.rect(ctx, 178 + (Math.floor(t / 150) % 12), 13, 1, 1, "#fff8c0");
      lights.push({ x: 184, y: 22, r: 18, c: "#ffd24a", i: 0.35 });
    }
  }

  // Every unlocked achievement in the office, oldest first; ones from the last hour glint.
  let cupsKey = "", cupsCache = [];
  function trophies() {
    const key = snap.now + "|" + snap.seats.length;
    if (key === cupsKey) return cupsCache;
    const out = [];
    for (const s of snap.seats) for (const [id, at] of Object.entries((s.career || {}).unlocked || {})) out.push({ at, color: s.color, glint: snap.now - at < 3600 });
    cupsKey = key; cupsCache = out.sort((a, b) => a.at - b.at);
    return cupsCache;
  }

  // The capacity board: plan left on every seat, as bars. It stands in the CEO corner.
  const TV = () => ({ x: 8, y: L.ceo.y + 8, w: 58, h: 30 });
  function drawTV(t, lights) {
    const { x, y, w, h } = TV();
    S.rect(ctx, x + w / 2 - 2, y + h + 2, 4, 14, "#2b2f3a"); S.rect(ctx, x + w / 2 - 10, y + h + 15, 20, 3, "#2b2f3a");
    S.rect(ctx, x - 2, y - 2, w + 4, h + 4, "#0a0b10"); S.rect(ctx, x, y, w, h, "#0f1424");
    const seats = snap.seats;
    const bw = Math.max(4, Math.floor((w - 6) / Math.max(1, seats.length)) - 3);
    seats.forEach((s, i) => {
      const bx = x + 4 + i * (bw + 3), hh = h - 9;
      const us = s.usage || {};
      for (const [k, off, a] of [["five_hour", 0, 1], ["weekly", Math.ceil(bw / 2), 0.5]]) {
        const pct = us[k] && us[k].pct != null ? us[k].pct : null;
        S.rect(ctx, bx + off, y + 3, Math.floor(bw / 2), hh, "#1b2236");
        if (pct != null) {
          const left = Math.max(0, 100 - pct) / 100;
          ctx.globalAlpha = a;
          S.rect(ctx, bx + off, y + 3 + hh - Math.round(hh * left), Math.floor(bw / 2), Math.round(hh * left), pct >= 90 ? "#ff4d5e" : s.color);
          ctx.globalAlpha = 1;
        }
      }
      S.rect(ctx, bx, y + h - 4, bw, 2, s.color);
    });
    S.rect(ctx, x, y + (Math.floor(t / 40) % h), w, 1, "rgba(255,255,255,0.05)");
    lights.push({ x: x + w / 2, y: y + h / 2, r: 40, c: "#5b8def", i: 0.45 });
  }

  // The meeting room's whiteboard: one row per programme, with its sessions as ticks.
  function drawWhiteboard(x, y, w, h) {
    S.rect(ctx, x - 2, y - 2, w + 4, h + 4, "#9aa3b5"); S.rect(ctx, x, y, w, h, "#f6f7f9");
    (snap.programmes || []).slice(0, 4).forEach((p, i) => {
      const done = p.sessions.filter(s => s.report_status).length;
      S.rect(ctx, x + 4, y + 4 + i * 6, 3, 3, PROG_COLORS[i % PROG_COLORS.length]);
      S.rect(ctx, x + 9, y + 5 + i * 6, 30, 1, "#9aa3b5");
      for (let k = 0; k < Math.min(8, p.sessions.length); k++) S.rect(ctx, x + w - 22 + k * 2, y + 4 + i * 6, 1, 3, k < done ? "#3fb68b" : "#e5a50a");
    });
  }

  function drawCEO(t, lights) {
    const c = L.ceo, dx = 96, dy = c.y + 58;
    drawTV(t, lights);
    const urgent = (snap.attention || []).filter(a => a.level === "bad").length;
    const attn = (snap.attention || []).filter(a => a.level !== "info").length;
    const look = S.lookFor("ceo-" + ((snap.office.ceo || {}).name || "CEO"), "#22304f");
    S.drawChairFront(ctx, dx + 31, dy - 22);
    if (urgent && !reduced) {                       // pacing behind the desk, on the phone
      ceoPace += 0.016;
      const px = dx + 28 + Math.round(Math.sin(ceoPace) * 22);
      S.drawWalker(ctx, px, dy - 26, look, Math.cos(ceoPace) > 0 ? "right" : "left", t, true);
      S.rect(ctx, px + 9, dy - 21, 2, 3, "#2a2d38");
    } else {
      S.drawSeated(ctx, dx + 33, dy - 18, look, "down", attn ? "talk" : "idle", t);
      S.rect(ctx, dx + 37, dy - 10, 2, 3, "#c94f4f");
      S.rect(ctx, dx + 36, dy - 20, 6, 1, "#ffd24a"); S.rect(ctx, dx + 36, dy - 21, 1, 1, "#ffd24a"); S.rect(ctx, dx + 38, dy - 22, 2, 2, "#ffd24a"); S.rect(ctx, dx + 41, dy - 21, 1, 1, "#ffd24a");
    }
    S.rect(ctx, dx + 2, dy + 26, 74, 3, S.P.shadow);
    S.rect(ctx, dx, dy, 78, 24, "#5a3a24"); S.rect(ctx, dx, dy, 78, 3, "#7a5034"); S.rect(ctx, dx + 2, dy + 22, 74, 2, "#41291a");
    S.drawMonitorBack(ctx, dx + 30, dy - 6);
    S.rect(ctx, dx + 30, dy + 10, 18, 5, "#c8a046"); S.rect(ctx, dx + 31, dy + 11, 16, 3, "#e8c66a");
    const ring = attn && Math.floor(t / 160) % 6 < 3 ? (Math.floor(t / 80) % 2 ? 1 : -1) : 0;
    S.rect(ctx, dx + 62 + ring, dy + 5, 8, 5, attn ? "#d94a4a" : "#30343f"); S.rect(ctx, dx + 61 + ring, dy + 4, 10, 2, attn ? "#ff6b6b" : "#454a5c");
    if (attn) { S.drawMark(ctx, dx + 64, dy - 4, urgent ? "!" : "?", t); lights.push({ x: dx + 66, y: dy + 6, r: 16, c: "#ff4d5e", i: 0.5 }); }
    S.drawMug(ctx, dx + 10, dy + 6, t, true, "#e8c66a");
    S.rect(ctx, dx + 16, dy + 5, 8, 6, S.P.white); S.rect(ctx, dx + 17, dy + 6, 6, 1, "#9aa3b5"); S.rect(ctx, dx + 17, dy + 8, 4, 1, "#9aa3b5");
    S.drawDeskLamp(ctx, dx + 50, dy - 4, true);
    lights.push({ x: dx + 39, y: dy + 4, r: 60, c: "#ffcf7a", i: 0.65 });
  }

  function rackPos(i) { return [8 + (i % 6) * 27, L.server.y + 12 + Math.floor(i / 6) * 48]; }
  // The closet holds six racks. Failed services always get one, then running ones; the rest show as "+N".
  const RANK = { failed: 0, activating: 1, active: 2 };
  function closetUnits() {
    const all = [...(snap.units || [])].sort((a, b) => (RANK[a.active] ?? 3) - (RANK[b.active] ?? 3));
    return { shown: all.slice(0, 6), hidden: Math.max(0, all.length - 6) };
  }
  function drawServer(t, lights) {
    const units = closetUnits().shown;
    for (let i = 0; i < 6; i++) {
      const un = units[i];
      const [x, y] = rackPos(i);
      if (y + 42 > H - 2) break;
      const st = un ? un.active : "inactive";
      S.drawRack(ctx, x, y, 42, st, t, un ? un.unit : "spare" + i);
      if (st === "active") lights.push({ x: x + 14, y: y + 20, r: 14, c: "#38e07b", i: 0.25 });
      if (st === "failed") {
        lights.push({ x: x + 9, y: y + 10, r: 22, c: "#ff4d5e", i: 0.55 });
        if (!reduced && Math.random() < 0.04) burst(x + 9, y + 6, 6, "spark");
      }
    }
  }

  function drawMeeting(t, env) {
    const m = L.meet, tx = m.x + 40, ty = m.y + 66;
    drawWhiteboard(m.x + 50, m.y + 5, 90, 28);
    (snap.programmes || []).slice(0, 8).forEach((p, i) => {
      const top = i < 4, x = tx + 10 + (i % 4) * 26;
      const look = S.lookFor("prog-" + p.name, PROG_COLORS[i % PROG_COLORS.length]);
      const busy = p.sessions.some(s => s.state === "working");
      if (top) S.drawSeated(ctx, x, ty - 9, look, "down", busy ? "talk" : "idle", t + i * 600);
      else { S.drawSeated(ctx, x, ty + 32, look, "up", "idle", t); S.drawChairBack(ctx, x - 1, ty + 38); }
    });
    if ((snap.programmes || []).length) {
      S.rect(ctx, tx + 14, ty + 10, 8, 6, S.P.paper); S.rect(ctx, tx + 60, ty + 16, 8, 6, S.P.paper); S.rect(ctx, tx + 88, ty + 8, 10, 7, "#2a2f40");
    }
  }

  function restingSeats() {
    return snap.seats.filter(s => ["limited", "benched", "offline"].includes(s.status) || !s.sessions.some(x => x.live !== false));
  }

  // The lounge: couches, an aquarium, snacks and an arcade. Seats on a break hang out here.
  function drawLounge(t, lights, env) {
    const lo = L.lounge;
    if (!lo) return;
    const wr = windowRect(lo);
    S.drawWindow(ctx, wr.x, wr.y, wr.w, wr.h, env.sky, t, env.night);
    S.drawPoster(ctx, lo.x + 18, lo.y + 7, 1);
    S.drawCouch(ctx, lo.x + 14, lo.y + 52, "#c0564b");
    S.rect(ctx, lo.x + 22, lo.y + 78, 32, 14, "#5e412c"); S.rect(ctx, lo.x + 23, lo.y + 79, 30, 1, "#77543a");
    S.drawCouch(ctx, lo.x + 14, lo.y + 100, "#4b6fbf");
    S.drawBeanBag(ctx, lo.x + 76, lo.y + 62, "#e5a50a");
    S.drawBeanBag(ctx, lo.x + 98, lo.y + 78, "#3fb68b");
    S.drawAquarium(ctx, lo.x + 146, lo.y + 44, t);
    lights.push({ x: lo.x + 161, y: lo.y + 51, r: 28, c: "#4fb3ff", i: 0.45 });
    S.drawVending(ctx, lo.x + 166, lo.y + 72, t);
    lights.push({ x: lo.x + 174, y: lo.y + 84, r: 22, c: "#ffcf7a", i: 0.4 });
    S.drawCoffeeMachine(ctx, lo.x + 148, lo.y + 76, t);
    S.drawArcade(ctx, lo.x + 166, lo.y + 110, t);
    lights.push({ x: lo.x + 173, y: lo.y + 118, r: 22, c: "#ff4fd8", i: 0.45 });
    S.drawWaterCooler(ctx, lo.x + 148, lo.y + 112, t);
    const spots = [[lo.x + 22, lo.y + 46], [lo.x + 42, lo.y + 46], [lo.x + 22, lo.y + 94], [lo.x + 42, lo.y + 94], [lo.x + 79, lo.y + 54], [lo.x + 101, lo.y + 70]];
    restingSeats().slice(0, spots.length).forEach((s, i) => {
      const [x, y] = spots[i];
      const look = S.lookFor("mascot-" + s.id, s.color);
      if (s.status === "offline") ctx.globalAlpha = 0.45;
      const pose = s.status === "limited" ? "sleep" : "idle";
      S.drawSeated(ctx, x, y, look, "down", pose, t + i * 911);
      ctx.globalAlpha = 1;
      if (pose === "sleep") S.drawZ(ctx, x + 8, y - 2, t + i * 300);
      else if (s.status === "benched") { S.rect(ctx, x + 2, y + 4, 6, 1, "#101015"); S.rect(ctx, x + 2, y + 4, 2, 2, "#101015"); S.rect(ctx, x + 6, y + 4, 2, 2, "#101015"); }
      else if (s.status === "offline") S.drawMark(ctx, x + 4, y - 7, "?", t);
      else S.drawMug(ctx, x + 11, y + 10, t, true);
    });
  }

  // A character's room: its window, live decor, the people at the desks, and the lights. A room is dim while its
  // seat naps, is on holiday or is logged out, and dark-ish when nobody is in.
  function drawRoom(pod, t, lights, env) {
    const s = pod.seat, room = pod.room, wr = windowRect(room), st = s.status;
    S.drawWindow(ctx, wr.x, wr.y, wr.w, wr.h, env.sky, t, env.night);
    if (env.night) lights.push({ x: wr.x + wr.w / 2, y: wr.y + wr.h + 6, r: 24, c: "#9bb8ff", i: 0.2 });
    const live = s.sessions.filter(x => x.live !== false);
    const dark = st === "offline" ? 0.5 : st === "limited" ? 0.42 : st === "benched" ? 0.3 : !live.length ? 0.2 : 0;
    drawDecorLive(ctx, room, pod.arch, t, dark < 0.25);
    drawPod(pod, t, lights);
    if (dark) { ctx.fillStyle = `rgba(6,8,22,${dark})`; ctx.fillRect(room.x + 2, room.y + 3, room.w - 4, room.h - 7); }
    else lights.push({ x: room.x + room.w / 2, y: room.y + 82 + room.dy, r: 74, c: "#ffd59a", i: live.some(x => x.state === "working") ? 0.38 : 0.2 });
    const dx = pod.door.x, dy = room.y + room.h - 4;
    if (st === "offline") {                          // a padlock on the door
      S.rect(ctx, dx - 4, dy - 9, 8, 7, "#c9a227"); S.rect(ctx, dx - 3, dy - 8, 6, 1, "#ffd24a"); S.rect(ctx, dx - 1, dy - 6, 2, 2, "#5a4030");
      S.rect(ctx, dx - 3, dy - 13, 1, 4, "#9aa3b5"); S.rect(ctx, dx + 2, dy - 13, 1, 4, "#9aa3b5"); S.rect(ctx, dx - 3, dy - 14, 6, 1, "#9aa3b5");
    }
    if (st === "benched") {                          // on holiday: a beach umbrella in the corner
      const ux = room.x + room.w - 40, uy = room.y + 50;
      S.rect(ctx, ux + 8, uy + 6, 1, 18, "#d7d2c4");
      for (let i = 0; i < 4; i++) S.rect(ctx, ux + i * 4, uy + 2 - (i === 1 || i === 2 ? 2 : 0), 4, 5, i % 2 ? "#f4f1ea" : "#e0364a");
    }
  }

  function drawPod(pod, t, lights) {
    const s = pod.seat, status = s.status, off = status === "offline";
    const bySlot = new Map();
    for (const a of agents.values()) if (a.seatId === s.id && a.mode === "seated") bySlot.set(a.slot, a);
    const busy = [...bySlot.values()].some(a => a.sess.state === "working" || a.sess.state === "waiting");
    const desk = deskFor(pod), mid = desk.x + desk.w / 2;
    S.drawRug(ctx, desk.x - 12, pod.y + 8, desk.w + 24, desk.two ? 92 : 64, s.color);
    S.drawDeskIsland(ctx, desk.x, desk.y, desk.w, desk.h, desk.two);
    S.drawDeskLamp(ctx, desk.x + 1, pod.y + 34, busy);
    if (busy) lights.push({ x: mid, y: pod.y + 54, r: 62, c: "#ffd59a", i: 0.5 });
    const lv = s.career ? s.career.level : 1;
    if (lv >= 3) S.drawDeskPerks(ctx, desk, lv, s.color, t);
    if (lv >= 15) lights.push({ x: mid, y: desk.y + desk.h, r: 40, c: s.color, i: 0.3 });
    for (let slot = 0; slot < pod.cap; slot++) {
      const sp = seatSpot(pod, slot), a = bySlot.get(slot), x = sp.cx;
      const pose = a ? poseFor(a.sess, status) : null;
      if (sp.top) {
        S.drawChairFront(ctx, x - 2, pod.y + 16);
        if (a) {
          S.drawSeated(ctx, x, sp.seatY, a.look, "down", pose, t + slot * 777);
          if (a.sess.kind === "desk") { S.rect(ctx, x - 1, sp.seatY + 3, 1, 3, "#2a2d38"); S.rect(ctx, x + 10, sp.seatY + 3, 1, 3, "#2a2d38"); S.rect(ctx, x, sp.seatY - 1, 10, 1, "#2a2d38"); }
        }
        S.drawMonitorBack(ctx, x - 3, pod.y + 31);
        if (a && pose !== "sleep") S.drawHands(ctx, x, pod.y + 42, a.look, pose, t + slot * 333);
        if (a && pose === "sleep") S.drawZ(ctx, x + 8, sp.seatY - 6, t + slot * 500);
        if (a && (pose === "idle" || pose === "wait")) S.drawMug(ctx, x + 12, pod.y + 43, t, pose === "wait");
        if (a && pose === "stuck") S.drawMark(ctx, x + 3, sp.seatY - 9, "?", t);
        if (a && pose === "think") S.drawThought(ctx, x + 8, sp.seatY - 8, t);
        if (a && pose !== "sleep" && !off) lights.push({ x: x + 5, y: pod.y + 30, r: 12, c: "#9fd0ff", i: 0.35 });
      } else {
        S.drawMonitorFront(ctx, x - 3, pod.y + 51, a && !off ? pose : "off", s.color, t + slot * 1234);
        if (a) {
          S.drawSeated(ctx, x, sp.seatY, a.look, "up", pose, t + slot * 777);
          if (a.sess.kind === "desk") { S.rect(ctx, x, sp.seatY + 1, 10, 1, "#2a2d38"); S.rect(ctx, x - 1, sp.seatY + 3, 1, 3, "#2a2d38"); S.rect(ctx, x + 10, sp.seatY + 3, 1, 3, "#2a2d38"); }
          if (pose === "sleep") S.drawZ(ctx, x + 8, sp.seatY - 4, t + slot * 500);
          if (pose === "stuck") S.drawMark(ctx, x + 3, sp.seatY - 8, "?", t);
          if (pose === "think") S.drawThought(ctx, x + 8, sp.seatY - 10, t);
          if (!off && pose !== "sleep") lights.push({ x: x + 5, y: pod.y + 57, r: 16, c: pose === "read" ? "#e8f0ff" : "#7ec8ff", i: 0.5 });
          if (pose === "sleep") lights.push({ x: x + 5, y: pod.y + 57, r: 10, c: "#ff4d5e", i: 0.3 });
        }
        S.drawChairBack(ctx, x - 1, pod.y + 74);
      }
      if (a && pose === "delegate") {
        const hx = x + 11, hy = sp.top ? sp.seatY - 2 : sp.seatY - 6;
        S.drawDrone(ctx, hx, hy, s.color, t + slot * 400);
        lights.push({ x: hx + 3, y: hy + 2, r: 10, c: s.color, i: 0.5 });
      }
    }
    if (off) { S.rect(ctx, pod.x + 56, pod.y + 46, 16, 13, "#ffe066"); S.rect(ctx, pod.x + 58, pod.y + 49, 12, 1, "#8a6d00"); S.rect(ctx, pod.x + 58, pod.y + 52, 8, 1, "#8a6d00"); S.rect(ctx, pod.x + 58, pod.y + 55, 10, 1, "#8a6d00"); }
    const lamp = { working: "#38e07b", idle: "#e5c07b", limited: "#ff3b4e", benched: "#5b8def", offline: "#6b7080" }[status] || "#6b7080";
    if (status === "limited") { S.drawBeacon(ctx, pod.x + POD_W - 18, pod.y + 36, t); lights.push({ x: pod.x + POD_W - 16, y: pod.y + 37, r: 34 + Math.sin(t / 220) * 6, c: "#ff3b4e", i: 0.6 }); }
    else { S.rect(ctx, pod.x + POD_W - 17, pod.y + 40, 3, 3, lamp); if (status === "working" && Math.floor(t / 600) % 2) S.rect(ctx, pod.x + POD_W - 18, pod.y + 39, 5, 5, S.alpha(lamp, 0.3)); }
  }

  function waiting() { return (snap.lanes || []).filter(l => l.status === "waiting" || l.status === "queued").slice(0, 5); }
  function drawHire(t, lights) {
    const h = L.hire;
    S.rect(ctx, h.x + 34, h.y + 12, 60, 14, "#1f2a28");
    S.rect(ctx, h.x + 36, h.y + 14, 56, 10, Math.floor(t / 700) % 2 ? "#2fa77b" : "#258763");
    for (let i = 0; i < 6; i++) S.rect(ctx, h.x + 40 + i * 8, h.y + 18, 5, 2, "#eafff6");
    lights.push({ x: h.x + 64, y: h.y + 19, r: 34, c: "#3fe0a0", i: 0.45 });
    S.rect(ctx, h.x + 52, h.y + 41, 10, 3, S.P.white); S.rect(ctx, h.x + 54, h.y + 42, 6, 1, "#9aa3b5");
    S.rect(ctx, h.x + 72, h.y + 34, 2, 7, "#2b2f3a"); S.rect(ctx, h.x + 70, h.y + 33, 6, 2, "#3fb68b");
    waiting().forEach((l, i) => {                  // office lanes waiting for a seat queue up here
      const x = h.x + 34 + i * 14, y = h.y + 70;
      S.drawWalker(ctx, x, y, S.lookFor("lane-" + l.id, "#6b7a90"), "up", t, false);
      S.rect(ctx, x + 2, y + 12, 6, 3, "#ffe066");
    });
  }

  function drawLighting(env, lights) {
    if (lightC.width !== W || lightC.height !== H) { lightC.width = W; lightC.height = H; }
    lx.globalCompositeOperation = "source-over";
    lx.clearRect(0, 0, W, H);
    lx.fillStyle = `rgba(4,8,28,${env.dark})`;
    lx.fillRect(0, 0, W, H);
    lx.globalCompositeOperation = "destination-out";
    for (const l of lights) {
      const g = lx.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
      g.addColorStop(0, `rgba(0,0,0,${Math.min(1, l.i * 1.3)})`); g.addColorStop(1, "rgba(0,0,0,0)");
      lx.fillStyle = g; lx.fillRect(l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(lightC, 0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = "lighter";
    for (const l of lights) {
      const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
      g.addColorStop(0, S.alpha(l.c, 0.16 * l.i)); g.addColorStop(1, S.alpha(l.c, 0));
      ctx.fillStyle = g; ctx.fillRect(l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function drawSun(t) {
    ctx.globalCompositeOperation = "lighter";
    const rooms = [...L.pods.map(p => p.room), L.lounge, L.meet].filter(Boolean);
    for (const room of rooms) {
      const wr = windowRect(room), top = wr.y + wr.h + 4;   // a few dust motes drift down from the window
      if (!reduced) for (let i = 0; i < 2; i++) {
        const p = ((t / 9000) + i / 2 + room.x / 300) % 1;
        S.rect(ctx, wr.x + 6 + i * 16 - p * 24, top + p * 64, 1, 1, "rgba(255,250,220,0.5)");
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------------------------------------------------------------------------------------- overlay
  const u = (v) => v * F + "px";
  function place(el, x, y, w, h) {
    el.style.left = u(x); el.style.top = u(y);
    if (w != null) el.style.width = u(w);
    if (h != null) el.style.height = u(h);
  }
  // The first click opens a panel, which rebuilds this overlay, so the browser never sees a double-click on the same
  // element. Spot it ourselves: a second click within 400 ms, a few pixels away, flies the camera there.
  let lastTap = { t: 0, x: 0, y: 0 };
  function secondTap(e) {
    const t = performance.now(), again = t - lastTap.t < 400 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 8;
    lastTap = { t: again ? 0 : t, x: e.clientX, y: e.clientY };
    return again;
  }
  function zoomToEvent(e) { const r = stage.getBoundingClientRect(); zoomAt(cam.tz < 1.6 ? 2.2 : 1, e.clientX - r.left, e.clientY - r.top); }
  function hot(cls, label, x, y, w, h, onClick, onDouble) {
    const b = document.createElement("button");
    b.className = "hot " + cls; b.type = "button"; b.setAttribute("aria-label", label); b.title = label;
    b.dataset.k = cls.split(" ")[0] + ":" + label;          // a stable key, so keyboard focus survives a rebuild
    place(b, x, y, w, h);
    b.addEventListener("click", (e) => { e.stopPropagation(); if (dragMoved) return; if (secondTap(e)) { if (handlers.onDouble) handlers.onDouble(); onDouble ? onDouble() : zoomToEvent(e); return; } onClick(); });
    b.addEventListener("dblclick", (e) => e.stopPropagation());
    overlay.appendChild(b);
    return b;
  }
  function div(cls, text, x, y) {
    const d = document.createElement("div");
    d.className = cls; if (text != null) d.textContent = text; place(d, x, y);
    overlay.appendChild(d); return d;
  }

  function overlaySig() {
    return JSON.stringify([F, selected, privacy, snap.office.name, persona ? snap.seats.map(s => persona(s).name) : 0, mvp && mvp.seat, (snap.programmes || []).map(p => p.name),
      (snap.units || []).map(x => x.unit + x.active), waiting().map(l => l.id),
      [...agents.values()].map(a => [a.id, a.slot, a.mode, a.sess.state, a.sess.name, a.sess.kind]), leavers.map(a => a.id),
      snap.seats.map(s => { const us = s.usage || {}; return [s.id, s.label, s.nickname, s.color, s.status, s.career && s.career.level, us.five_hour && Math.round(us.five_hour.pct), us.weekly && Math.round(us.weekly.pct), (s.tokens_1h || 0) > 400000, s.sessions.filter(x => x.live !== false).length]; })]);
  }

  function renderOverlay() {
    if (!snap || !L) return;
    const sig = overlaySig();
    if (sig === ovKey) { renderBubbles(); return; }
    ovKey = sig;
    const fk = overlay.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const keepPops = pops.map(p => p.el);
    overlay.innerHTML = "";
    keepPops.forEach(el => overlay.appendChild(el));
    hot("room", "CEO desk: briefing and alerts", 70, L.ceo.y + 22, 120, 76, () => handlers.openCEO());
    hot("room", "Server closet: background services", L.server.x, L.server.y, L.server.w - 26, L.server.h, () => handlers.openServices());
    if (L.meet) hot("room", "Meeting room: programmes", L.meet.x, L.meet.y, L.meet.w, L.meet.h, () => handlers.openProgrammes());
    if (L.lounge) hot("room", "Lounge: seats on a break", L.lounge.x, L.lounge.y, L.lounge.w, L.lounge.h, () => handlers.openLounge());
    const tv = TV();
    hot("wallhot", "Capacity board: plan left on every seat", tv.x - 2, tv.y - 2, tv.w + 4, tv.h + 20, () => handlers.openDivider());
    hot("wallhot", "Elevator: office news", ELEVATOR.x - 3, ELEVATOR.y - 6, 32, 46, () => handlers.openNews());
    hot("wallhot", "Employee of the day", 172, 8, 24, 32, () => handlers.openStats());
    hot("wallhot", "Trophy cabinet: everyone's achievements", 114, 6, 60, 34, () => handlers.openTrophies());
    if (L.lounge) div("room-label", "LOUNGE", L.lounge.x + 8, L.lounge.y + BACK_LABEL);
    if (L.meet) div("room-label", "MEETING", L.meet.x + 8, L.meet.y + BACK_LABEL);
    for (const o of L.open) div("room-label", "GARDEN", o.x + 8, o.y + BACK_LABEL);

    const neon = div("neon", snap.office.name || "Claude Office", 6, 8); place(neon, 6, 8, 70, 22);
    if (mvp) place(div("mvp-tag", "MVP", 172, 36), 172, 36, 24, null);
    const closet = closetUnits();
    closet.shown.forEach((un, i) => { const [x, y] = rackPos(i); hot("rack", `${un.unit}: ${un.active}`, x, y, 18, 42, () => handlers.openServices()); });
    if (closet.hidden) div("room-label more", `+${closet.hidden} more`, LOBBY_W - 70, L.server.y - 12);
    hot("hire", "Hiring desk: start a new lane", L.hire.x + 8, L.hire.y + 8, POD_W - 16, POD_H - 14, () => handlers.openHire());
    place(div("plate hire-plate", "Hiring desk", 0, 0), L.hire.x + 24, L.hire.y + 98, POD_W - 48, null);
    waiting().forEach((l, i) => { const tg = div("tag queue", "⏳ " + short(l.title, 12), L.hire.x + 39 + i * 14, L.hire.y + 80); tg.title = l.waiting_reason || "Waiting for a seat"; });
    for (const pod of L.pods) renderPod(pod);
    for (const a of leavers) a.tagEl = div("tag ghost", short(a.sess.name), a.x + 5, a.y + 19);
    if (fk) { const back = [...overlay.querySelectorAll("[data-k]")].find(e => e.dataset.k === fk); if (back) back.focus({ preventScroll: true }); }
    renderBubbles();
  }

  function renderPod(pod) {
    const s = pod.seat;
    const live = s.sessions.filter(x => x.live !== false);
    const who = persona ? persona(s) : { name: s.nickname || s.label };
    const plate = document.createElement("button");
    plate.type = "button"; plate.dataset.k = "plate:" + s.id;
    plate.className = `plate st-${s.status}` + (selected && selected.seat === s.id && !selected.session ? " sel" : "");
    plate.style.setProperty("--seat", s.color);
    place(plate, pod.room.x + 12, pod.room.y + pod.room.h - 31, pod.room.w - 24, null);
    const line = plateLine(s, live);
    const lv = s.career ? `<em class="lv" title="Level ${s.career.level} ${esc(s.career.title)}">${s.career.level}</em>` : "";
    const need = (snap.attention || []).filter(a => a.seat === s.id).length;   // things about this seat in Needs you
    if (need) plate.classList.add("needs");
    plate.innerHTML = `<span class="pl-line"><b><i></i>${esc(who.name)}${lv}</b><span class="pl-chip ${line.tone}">${esc(line.main)}</span></span>` +
      `<span class="pl-line pl-sub"><span class="bar ${line.left != null && line.left < 15 ? "low" : line.left != null && line.left < 35 ? "mid" : ""}"><i style="width:${line.left ?? 0}%"></i></span><span>${esc(line.side)}</span></span>` +
      (need ? `<span class="pl-need" title="${need} thing${need === 1 ? "" : "s"} in Needs you">${need}</span>` : "");
    plate.setAttribute("aria-label", `${who.name}${s.career ? `, level ${s.career.level}` : ""}: ${line.main}, ${line.side}`);
    plate.addEventListener("click", (e) => { e.stopPropagation(); if (dragMoved) return; if (secondTap(e)) { if (handlers.onDouble) handlers.onDouble(); focusSeat(s.id); return; } handlers.openSeat(s.id); });
    plate.addEventListener("dblclick", (e) => e.stopPropagation());
    overlay.appendChild(plate);
    const podHot = hot("pod", `${who.name}'s desks`, pod.room.x + 2, pod.room.y + 2, pod.room.w - 4, pod.room.h - 30, () => handlers.openSeat(s.id), () => focusSeat(s.id));
    podHot.dataset.k = "pod:" + s.id;
    for (const el of [podHot, plate]) {
      el.addEventListener("mouseenter", () => { spot = s.id; if (handlers.onHoverSeat) handlers.onHoverSeat(s.id); peek(s.id, podHot); });
      el.addEventListener("mouseleave", () => { if (spot === s.id) spot = null; if (handlers.onHoverSeat) handlers.onHoverSeat(null); peek(null); });
    }
    for (const a of agents.values()) {
      if (a.seatId !== s.id) continue;
      if (a.mode === "walking") { a.tagEl = div("tag walking", short(a.sess.name), a.x + 5, a.y + 19); continue; }
      const sp = seatSpot(pod, a.slot), sess = a.sess;
      const isSel = selected && selected.session === sess.id;
      const b = hot("worker" + (isSel ? " sel" : ""), `${sess.name}, ${sess.state}: open`,
        sp.cx - 4, sp.top ? sp.seatY - 4 : sp.seatY - 6, 18, sp.top ? 24 : 22, () => handlers.openSession(s.id, sess.id), () => focusSession(sess.id));
      b.dataset.k = "worker:" + sess.id;
      const tg = div("tag" + (isSel ? " show" : ""), short(sess.name), sp.cx + 5, sp.top ? pod.y + 45 : pod.y + 86);
      b.addEventListener("mouseenter", () => { hoverId = sess.id; tg.classList.add("show"); renderBubbles(); spot = s.id; if (handlers.onHoverSeat) handlers.onHoverSeat(s.id); peek(s.id, podHot); });
      b.addEventListener("mouseleave", () => { hoverId = null; if (!isSel) tg.classList.remove("show"); renderBubbles(); if (spot === s.id) spot = null; if (handlers.onHoverSeat) handlers.onHoverSeat(null); peek(null); });
    }
  }

  // The room peek card waits a moment (a pointer passing over the floor should not flash cards) and hides at once.
  let peekT = 0, peekOn = null;
  function peek(id, el) {
    clearTimeout(peekT);
    if (!handlers.onPeek || matchMedia("(pointer: coarse)").matches) return;
    if (!id) { if (peekOn) { peekOn = null; handlers.onPeek(null); } return; }
    peekT = setTimeout(() => { if (!el.isConnected || dragMoved) return; peekOn = id; handlers.onPeek(id, el.getBoundingClientRect()); }, peekOn ? 60 : 380);
  }

  function plateLine(s, live) {
    const u = s.usage || {};
    const l5 = u.five_hour && u.five_hour.pct != null ? Math.max(0, 100 - u.five_hour.pct) : null;
    const lw = u.weekly && u.weekly.pct != null ? Math.max(0, 100 - u.weekly.pct) : null;
    const tight = l5 == null ? (lw == null ? null : ["week", lw]) : lw == null || l5 <= lw ? ["5h", l5] : ["week", lw];
    const busy = live.filter(x => x.state === "working" || x.state === "waiting").length;
    const r5 = u.five_hour && u.five_hour.resets_at;
    const left = tight ? `${Math.round(tight[1])}% ${tight[0] === "5h" ? "of 5 h" : "of week"} left` : "no reading";
    if (s.status === "limited") return { main: "Napping", tone: "bad", side: r5 ? "back at " + hhmm(r5) : "out of plan", left: 0 };
    if (s.status === "offline") return { main: "Locked out", tone: "bad", side: "needs /login", left: null };
    if (s.status === "benched") return { main: "On holiday", tone: "info", side: left, left: tight ? tight[1] : null };
    return { main: busy ? `${busy} working` : live.length ? "Waiting for you" : "Free", tone: busy ? "good" : live.length ? "warn" : "idle", side: left, left: tight ? tight[1] : null };
  }
  function hhmm(ts) { return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

  function short(n, max = 16) {
    n = (n || "").replace(/^wt-/, "");
    return n.length > max ? n.slice(0, max - 1) + "…" : n;
  }

  function bubbleText(sess) {
    if (privacy && sess.kind === "desk") return sess.state === "idle" ? "Idle" : "Working…";
    if (sess.state === "limited") return "Out of plan, back after the reset";
    if (sess.state === "stuck") return "Taking a while: " + (sess.activity || "");
    if (sess.state === "waiting") return "⏳ " + (sess.activity || "Waiting");
    return sess.activity || sess.state;
  }

  function anchorFor(a) {
    if (a.mode !== "seated") return [a.x + 5, a.y - 1];
    const sp = seatSpot(a.pod, a.slot);
    return [sp.cx + 5, sp.top ? sp.seatY - 3 : sp.seatY - 4];
  }

  function renderBubbles() {
    if (!L) return;
    const t = performance.now();
    const cands = [];
    for (const a of agents.values()) {
      const sess = a.sess, f = fresh.get(sess.id), say = said.get(sess.id);
      const forced = hoverId === sess.id || (selected && selected.session === sess.id) || a.mode === "walking";
      const sayOn = say && say.until > t;
      if (!forced && !sayOn && !(f && f > t)) continue;
      cands.push({ a, forced, prio: forced ? 1e15 : sayOn ? say.at + 1e12 : f, text: a.mode === "walking" ? (say && say.text) || `On my way to ${persona ? persona(a.pod.seat).name + "'s desk" : a.seatId}` : sayOn ? say.text : bubbleText(sess), persona: sayOn && !forced });
    }
    cands.sort((x, y) => y.prio - x.prio);
    const perPod = new Set(), want = new Set();
    let n = 0;
    for (const c of cands) {
      const podKey = c.a.mode === "seated" ? c.a.seatId : "walk-" + c.a.id;
      if (!c.forced && (perPod.has(podKey) || n >= 3)) continue;
      perPod.add(podKey); n++;
      const sess = c.a.sess;
      want.add(sess.id);
      let b = overlay.querySelector(`.bubble[data-sid="${CSS.escape(sess.id)}"]`);
      if (!b) { b = document.createElement("div"); b.dataset.sid = sess.id; overlay.appendChild(b); }
      b.className = "bubble" + (sess.state === "limited" ? " bad" : sess.state === "stuck" ? " warn" : "") + (c.a.mode === "walking" ? " hello" : c.persona ? " persona" : "");
      if (b.textContent !== c.text) b.textContent = c.text;
      const [bx, by] = anchorFor(c.a);
      place(b, bx, by);
    }
    overlay.querySelectorAll(".bubble[data-sid]").forEach(b => { if (!want.has(b.dataset.sid)) b.remove(); });
  }

  function catHot() {
    if (cat.el && cat.el.isConnected) return cat.el;
    cat.el = document.createElement("button");
    cat.el.className = "hot cat"; cat.el.type = "button"; cat.el.setAttribute("aria-label", "Pixel the office cat");
    cat.el.addEventListener("click", (e) => {
      e.stopPropagation();
      const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
      if (cat.mode === "sleep") { cat.mode = "sit"; cat.until = performance.now() + 5000; }
      pops.push({ el: div("bubble cat-says", "Mrrp! " + tip, cat.x + 5, cat.y - 2), until: performance.now() + 5200 });
      if (handlers.onCat) handlers.onCat(tip);
    });
    overlay.appendChild(cat.el);
    return cat.el;
  }
  function moveDynamicDom() {
    place(catHot(), cat.x - 2, cat.y - 3, 15, 12);
    for (const a of agents.values()) {
      if (a.mode !== "walking") continue;
      if (a.tagEl) place(a.tagEl, a.x + 5, a.y + 19);
      const b = overlay.querySelector(`.bubble[data-sid="${CSS.escape(a.id)}"]`);
      if (b) place(b, a.x + 5, a.y - 1);
    }
    for (const a of leavers) if (a.tagEl) place(a.tagEl, a.x + 5, a.y + 19);
    const now = performance.now();
    for (let i = pops.length - 1; i >= 0; i--) if (pops[i].until < now) { pops[i].el.remove(); pops.splice(i, 1); }
  }

  // ----------------------------------------------------------------------------------------- camera
  function sizes() { const r = stage.getBoundingClientRect(); return { sw: Math.max(1, r.width), sh: Math.max(1, r.height) }; }
  function clampCam(c) {
    const { sw, sh } = sizes();
    const ww = W * F * c.tz, wh = H * F * c.tz;
    c.tx = ww <= sw ? (sw - ww) / 2 : Math.min(0, Math.max(sw - ww, c.tx));
    c.ty = wh <= sh ? (sh - wh) / 2 : Math.min(0, Math.max(sh - wh, c.ty));
  }
  function zoomAt(z, px, py) {
    const nz = Math.max(1, Math.min(4, z));
    const wx = (px - cam.tx) / cam.tz, wy = (py - cam.ty) / cam.tz;
    cam.tz = nz; cam.tx = px - wx * nz; cam.ty = py - wy * nz;
    clampCam(cam);
  }
  function focusRect(x, y, w, h) {
    const { sw, sh } = sizes();
    const z = Math.max(1, Math.min(3.2, Math.min(sw / (w * F * 1.25), sh / (h * F * 1.25))));
    cam.tz = z; cam.tx = sw / 2 - (x + w / 2) * F * z; cam.ty = sh / 2 - (y + h / 2) * F * z;
    clampCam(cam);
  }
  // A focus asked for just before the frame changes size (the inspector coming back re-plans the building) is aimed
  // again once the new plan is in, so the camera lands on the right room.
  let refocus = null;
  function focusSeat(id) { refocus = { at: performance.now(), run: () => focusSeat(id) }; const p = L && L.pods.find(p => p.seat.id === id); if (p) focusRect(p.room.x, p.room.y, p.room.w, p.room.h); }
  function focusSession(id) { refocus = { at: performance.now(), run: () => focusSession(id) }; const a = agents.get(id); if (!a) return; const [x, y] = anchorFor(a); focusRect(x - 44, y - 24, 88, 70); }
  function fit() { refocus = null; cam.tz = 1; cam.tx = 0; cam.ty = 0; clampCam(cam); }
  function applyCam(force) {
    const dz = cam.tz - cam.z, dx = cam.tx - cam.x, dy = cam.ty - cam.y;
    if (!force && Math.abs(dz) < 0.001 && Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) {
      if (dz || dx || dy) { cam.z = cam.tz; cam.x = cam.tx; cam.y = cam.ty; world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`; }
      return false;
    }
    if (reduced || force) { cam.z = cam.tz; cam.x = cam.tx; cam.y = cam.ty; }
    else { cam.z += dz * 0.18; cam.x += dx * 0.18; cam.y += dy * 0.18; }
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
    stage.classList.toggle("zoomed", cam.tz > 1.01);
    world.classList.toggle("zoomin", cam.z > 1.7);
    return true;
  }

  let dragStart = null, dragMoved = false;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".cam")) return;
    dragStart = { x: e.clientX, y: e.clientY, tx: cam.tx, ty: cam.ty }; dragMoved = false;
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
    if (!dragMoved && Math.hypot(dx, dy) > 5 && cam.tz > 1.01) { dragMoved = true; stage.classList.add("dragging"); }
    if (dragMoved) { cam.tx = dragStart.tx + dx; cam.ty = dragStart.ty + dy; clampCam(cam); applyCam(true); }
  });
  window.addEventListener("pointerup", () => {
    if (!dragStart) return;
    dragStart = null; stage.classList.remove("dragging");
    setTimeout(() => { dragMoved = false; }, 0);
  });
  stage.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(cam.tz * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  stage.addEventListener("dblclick", (e) => {
    if (e.target.closest(".cam")) return;
    const r = stage.getBoundingClientRect();
    zoomAt(cam.tz < 1.6 ? 2.2 : 1, e.clientX - r.left, e.clientY - r.top);
  });
  stage.querySelectorAll("[data-cam]").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const { sw, sh } = sizes();
    if (b.dataset.cam === "legend") { if (handlers.onLegend) handlers.onLegend(b); return; }
    if (b.dataset.cam === "in") zoomAt(cam.tz * 1.4, sw / 2, sh / 2);
    else if (b.dataset.cam === "out") zoomAt(cam.tz / 1.4, sw / 2, sh / 2);
    else fit();
  }));
  // The camera buttons belong to the visible frame, not the floor: on a phone the floor scrolls sideways inside it.
  const frame = stage.closest(".floor-frame");
  if (frame) frame.appendChild(stage.querySelector(".cam"));

  // ------------------------------------------------------------------------------------- resolution
  // In the desktop shell the stage is a box (CSS sets --fit: contain): the building re-plans itself to fill it and
  // scales to fit both ways. Elsewhere (laptops, phones) it keeps the default plan and fits the width.
  const fills = () => getComputedStyle(stage).getPropertyValue("--fit").trim() === "contain";
  function relayout() {
    const arch = (s) => (persona ? persona(s).archetype : null);
    L = computeLayout(snap.seats, arch, plan); W = L.W; H = L.H;
    for (const a of agents.values()) if (a.mode === "walking") { a.mode = "seated"; a.path = []; }   // walkers on the old plan sit down
    leavers = leavers.filter(l => { if (l.tagEl) l.tagEl.remove(); return false; });
    cat.x = cat.tx = 140; cat.y = cat.ty = WALK_Y + 10; cat.path = []; cat.mode = "sit"; cat.until = 0;
    assign();
  }
  function resize() {
    if (!L) return;
    const fill = fills();
    stage.style.height = "";
    const { sw, sh } = sizes();
    const want = fill ? planFor(snap.seats.length, sw, sh) : { cols: 3, roomH: ROOM_H };
    if (want.cols !== plan.cols || want.roomH !== plan.roomH) { plan = want; relayout(); }
    F = fill ? Math.min(sw / W, sh / H) : sw / W;
    world.style.width = W * F + "px"; world.style.height = H * F + "px";
    if (!fill) stage.style.height = H * F + "px";
    world.style.setProperty("--f", F);
    clampCam(cam);
    if (refocus && performance.now() - refocus.at < 1500) { const r = refocus; r.run(); refocus = r; }
    applyCam(true);
    reres(true);
    ovKey = ""; renderOverlay();
  }
  function reres(force) {
    const dpr = window.devicePixelRatio || 1;
    const want = Math.max(1, Math.min(6, Math.ceil(F * cam.tz * dpr)));
    if (!force && want === RES) return;
    RES = want;
    canvas.width = W * RES; canvas.height = H * RES;
    canvas.style.width = W * F + "px"; canvas.style.height = H * F + "px";
    bg.width = W * RES; bg.height = H * RES;
    bgx.setTransform(RES, 0, 0, RES, 0, 0); bgx.imageSmoothingEnabled = false;
    drawStatic(bgx, L);
  }
  let reresTimer = 0;

  // ------------------------------------------------------------------------------------------- loop
  let lastDraw = 0, lastSec = 0;
  function loop(t) {
    const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
    if (snap && L) {
      if (applyCam(false)) { clearTimeout(reresTimer); reresTimer = setTimeout(() => reres(false), 160); }
      stepAgents(dt); stepParticles(dt); stepCat(dt, t);
      const every = reduced ? 250 : RES <= 2 ? 33 : RES <= 4 ? 50 : 66;   // big canvases draw a little less often
      if (t - lastDraw >= every) { drawFrame(t); lastDraw = t; }
      moveDynamicDom();
      if (Math.floor(t / 1000) !== lastSec) {
        lastSec = Math.floor(t / 1000);
        let changed = false;
        for (const [k, v] of fresh) if (v < t) { fresh.delete(k); changed = true; }
        for (const [k, v] of said) if (v.until < t) { said.delete(k); changed = true; }
        if (changed) renderBubbles();
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  let lastBox = "";
  new ResizeObserver((en) => { const r = en[0].contentRect, k = Math.round(r.width) + "x" + Math.round(r.height); if (k !== lastBox) { lastBox = k; requestAnimationFrame(resize); } }).observe(stage);

  // ----------------------------------------------------------------------------------------- public
  function update(next) {
    const prev = snap;
    snap = next;
    const arch = (s) => (persona ? persona(s).archetype : null);
    const key = JSON.stringify(snap.seats.map(s => [s.id, s.color, arch(s)])) + "|" + (snap.units || []).length;
    const relayout = key !== staticKey;
    if (relayout) { L = computeLayout(snap.seats, arch, plan); W = L.W; H = L.H; staticKey = key; }
    else L.pods.forEach((p, i) => { p.seat = snap.seats[i]; });
    assign();
    const t = performance.now();
    const prevAct = new Map();
    if (prev) for (const s of prev.seats) for (const x of s.sessions) prevAct.set(x.id, x.activity);
    for (const s of snap.seats) for (const x of s.sessions) {
      if (x.live === false) continue;
      const busy = x.state === "working" || x.state === "waiting";
      if (first && busy) fresh.set(x.id, t + 9000);
      else if (prev && prevAct.get(x.id) !== x.activity && busy) fresh.set(x.id, t + 7000);
    }
    first = false;
    if (relayout) resize(); else renderOverlay();
    floatXp(t);
  }

  // "+12 XP" rises from a desk as its people work: at most one every 20 seconds per desk, so it stays a nicety.
  function floatXp(t) {
    for (const s of snap.seats) {
      const xp = s.career && s.career.xp;
      if (xp == null) continue;
      const st = xpSeen.get(s.id);
      if (!st) { xpSeen.set(s.id, { xp, pending: 0, at: t }); continue; }
      if (xp > st.xp) st.pending += xp - st.xp;
      st.xp = xp;
      if (st.pending < 5 || t - st.at < 20000 || reduced || document.hidden) continue;
      const p = L && L.pods.find(p => p.seat.id === s.id);
      if (p) { const el = div("pop xp", `+${st.pending} XP`, p.x + POD_W - 26, p.y + 94); el.style.setProperty("--seat", s.color); pops.push({ el, until: t + 2600 }); }
      st.pending = 0; st.at = t;
    }
  }

  // A full-width "LEVEL UP" banner over the floor.
  function banner(title, sub, color) {
    if (reduced) return;
    const old = stage.querySelector(".lvl-banner"); if (old) old.remove();
    const b = document.createElement("div");
    b.className = "lvl-banner"; b.setAttribute("aria-hidden", "true");
    b.style.setProperty("--seat", color || "#ffd24a");
    b.innerHTML = `<div class="lb-in"><span class="lb-stars">✦ ✦ ✦</span><b>${esc(title)}</b><span class="lb-sub">${esc(sub)}</span></div>`;
    stage.appendChild(b);
    stage.classList.add("bannering");
    setTimeout(() => { b.remove(); if (!stage.querySelector(".lvl-banner")) stage.classList.remove("bannering"); }, 3400);
  }

  function celebrate(seatId, sessionId, text) {
    if (!L) return;
    let x, y;
    const a = sessionId && agents.get(sessionId);
    if (a) [x, y] = anchorFor(a);
    else { const p = L.pods.find(p => p.seat.id === seatId); if (!p) return; x = p.x + POD_W / 2; y = p.y + 40; }
    if (!reduced) burst(x, y, 46, "confetti");
    pops.push({ el: div("pop good", text || "Shipped!", x, y - 6), until: performance.now() + 2600 });
  }
  function alarm(seatId, text) {
    const p = L && L.pods.find(p => p.seat.id === seatId); if (!p) return;
    pops.push({ el: div("pop bad", text || "Out of plan", p.x + POD_W / 2, p.y + 30), until: performance.now() + 2600 });
  }

  return {
    update,
    setSelected(sel) { selected = sel; ovKey = ""; renderOverlay(); },
    setPrivacy(on) { privacy = on; ovKey = ""; renderOverlay(); },
    setReducedMotion(on) { reduced = on; },
    setMvp(m) { mvp = m && m.seat ? m : null; ovKey = ""; renderOverlay(); },
    setPersonas(fn) { persona = fn; staticKey = ""; ovKey = ""; if (snap) update(snap); },
    say(sessionId, text, ms = 6000) { if (!sessionId || !text) return; said.set(sessionId, { text, until: performance.now() + ms, at: performance.now() }); renderBubbles(); },
    sayAtSeat(seatId, text, ms = 6000) {
      const a = [...agents.values()].find(x => x.seatId === seatId && x.mode === "seated");
      if (a) { said.set(a.id, { text, until: performance.now() + ms, at: performance.now() }); renderBubbles(); }
    },
    focusSeat, focusSession, fit, celebrate, alarm, banner,
    spotlight(id) { spot = id || null; },
    setWalkBoost(k) { walkBoost = Math.max(1, Math.min(8, k || 1)); },
    // The next update seats everyone where they belong at once (no walking in or out): for jumps in time (replay).
    reset() { for (const a of agents.values()) if (a.tagEl) a.tagEl.remove(); agents.clear(); leavers = leavers.filter(l => { if (l.tagEl) l.tagEl.remove(); return false; }); fresh.clear(); first = true; },
    picture: () => ({ canvas, W }),   // W is the current plan's width    // the whole floor, whatever the camera shows (for "Save a picture")
    zoom(dir) { const { sw, sh } = sizes(); zoomAt(dir > 0 ? cam.tz * 1.4 : cam.tz / 1.4, sw / 2, sh / 2); },
    pan(dx, dy) { cam.tx += dx; cam.ty += dy; clampCam(cam); },
  };
}

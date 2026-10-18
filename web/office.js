// The office floor engine: a pixel canvas rendered at a whole-number scale, a DOM overlay for names, bubbles
// and click targets, a camera you can zoom and pan, agents that walk in from the elevator, and night lighting.
import * as S from "./engine/sprites.js";
import { WALL, POD_W, POD_H, ROOM_H, LOBBY_W, ELEVATOR, SPINE_X, WALK_Y, computeLayout, planFor, seatSpot, pathTo, drawStatic, capFor, deskFor } from "./engine/scene.js";
import { windowRect, drawDecorLive } from "./engine/decor.js";
import { officeLevel } from "./engine/unlocks.js";
import { seasonFor, drawSeason, drawSnow } from "./engine/season.js";
import { icon } from "./ui/icons.js";

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
  let spot = null;                     // a seat being pointed at in the inspector or on the floor: its room lights up
  let skyKey = "";
  let walkBoost = 1;                   // replay speeds walking up so arrivals reach their desks in replay time
  let clockAt = null;                  // replay's time (seconds), or null for now
  let seasonal = true;                 // Settings → Seasonal decorations
  let gifts = [];                      // gift boxes waiting on the floor: {id, seat, from, label}
  let giftsSeen = null;                // ids already on the floor (null before the first list: those are simply there)
  let couriers = [];                   // delivery people carrying new CEO-desk gifts in from the elevator
  const carried = new Set();           // gift ids still in a courier's hands (not on the floor yet)
  let happy = false;                   // the day's happy hour: party lights in the lobby and corridors
  let sets = new Set();                // finished album sets (rarities): their rewards on the floor
  let radioOn = false;
  let burner = null;                   // the seat with the most tokens of all time: a flame on its nameplate
  let odometer = null;                 // the office's all-time tokens, on the lobby wall under the neon
  let odoShown = null;                 // the number the odometer last rolled in
  let belt = null;                     // last week's heaviest burner: a belt on its nameplate
  let lean = null;                     // last week's fewest tokens per commit: a green ribbon on its nameplate
  let game = "full";                   // game intensity: "full", "calm" (no banners, confetti, banter or party) or "off"                 // the office radio is playing: notes rise from the boombox on the CEO desk
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
  const cat = { x: 140, y: 60, tx: 140, ty: 60, path: [], mode: "sit", until: 0, facing: 1, el: null, speed: 26, name: "Pixel the office cat", says: "Mrrp! " };
  const dog = { x: 40, y: 60, tx: 40, ty: 60, path: [], mode: "sit", until: 0, facing: -1, el: null, speed: 36, name: "Biscuit the office dog", says: "Woof! " };
  let ol = officeLevel([]);                    // the office level and what it has unlocked (engine/unlocks.js)
  const has = (id) => ol.unlocked.has(id);
  const TIPS = ["Ctrl + K jumps to any seat, session or action.", "Double-click a desk to fly the camera to it.",
    "Click a person, then Chat, to message them.", "The load divider decides who gets the next lane.",
    "Take a checkpoint before you restart the laptop.", "Share-safe mode blurs topics before a screen share.",
    "Today shows who carried the day.", "A drone by a desk means a subagent is working.", "Meow."];

  // ---------------------------------------------------------------------------------------- agents
  function assign() {
    const seen = new Set();
    // Where everyone sits right now, before desks resize: people then slide to their new seats, and anyone leaving
    // starts from the chair they were really in.
    for (const a of agents.values()) a.was = a.mode === "seated" && a.pod ? { ...seatSpot(a.pod, a.slot), shown: a.shift || 0 } : null;
    for (const pod of L.pods) {
      const want = pod.seat.sessions.filter(x => x.live !== false).slice(0, MAX_SLOTS);
      pod.cap = capFor(want.length);                 // the desk grows and shrinks with the people at it
      pod.targetY = pod.baseY + (pod.cap <= 3 ? 12 : 0);   // one row of seats sits lower, centred in the room
      if (first || pod.y == null || reduced) pod.y = pod.targetY;
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
            if (persona && game === "full") said.set(x.id, { text: persona(pod.seat).lines.arrive, until: performance.now() + 9000, at: performance.now() });
          }
          agents.set(x.id, a);
        } else { Object.assign(a, { slot, pod, seatId: pod.seat.id, sess: x, look, mode: "seated", path: [] }); }
      }
    }
    for (const a of agents.values()) if (a.mode === "seated" && a.was) a.shift = a.was.cx + (a.was.shown || 0) - seatSpot(a.pod, a.slot).cx;   // slide, don't jump
    for (const [id, a] of agents) {
      if (seen.has(id)) continue;
      agents.delete(id);
      if (a.mode === "seated" && !reduced) {      // walk out to the elevator, from the chair they were in
        const p = pathTo(L, a.pod, a.slot).reverse();
        const sp = a.was || seatSpot(a.pod, a.slot);
        leavers.push({ ...a, mode: "leaving", x: sp.cx + (sp.shown || 0), y: sp.standY, path: p.slice(1), gone: false, tagEl: null });
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
  function stepPet(p, dt, t) {
    if (!L || reduced) return;
    if (p.mode === "walk") {
      const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy), v = p.speed * dt;
      if (Math.abs(dx) > 0.5) p.facing = dx > 0 ? 1 : -1;
      if (d <= v && p.path.length) { p.x = p.tx; p.y = p.ty; [p.tx, p.ty] = p.path.shift(); }
      else if (d <= v) { p.x = p.tx; p.y = p.ty; p.mode = inLounge(p.x, p.y) && Math.random() < 0.6 ? "sleep" : "sit"; p.until = t + (p.mode === "sleep" ? 25000 : 4000 + Math.random() * 7000); }
      else { p.x += dx / d * v; p.y += dy / d * v; }
    } else if (t > p.until) {
      const spots = catSpots(), [nx, ny] = spots[Math.floor(Math.random() * spots.length)];
      const out = catLegs(p.x, p.y), back = catLegs(nx, ny).reverse();
      p.path = [...out, [SPX, back[0][1]], ...back.slice(1), [nx, ny]];
      [p.tx, p.ty] = p.path.shift(); p.mode = "walk";
    }
  }
  function openElevator() { elevator.until = performance.now() + 1600; }

  let onScreen = true;                 // the floor is visible (another view or a hidden tab skips painting)
  new IntersectionObserver((en) => { onScreen = en[0].isIntersecting; }).observe(stage);
  const DRONE_EVERY = 48000, DRONE_FLIGHT = 9000;
  const droneUp = (t) => has("drone") && !reduced && t % DRONE_EVERY > DRONE_EVERY - DRONE_FLIGHT;
  const UFO_EVERY = 75000, UFO_FLIGHT = 12000;      // the epic set's saucer, out of step with the drone
  const ufoUp = (t) => sets.has("epic") && !reduced && (t + 31000) % UFO_EVERY > UFO_EVERY - UFO_FLIGHT;
  function walkingNow() {
    if (couriers.length) return true;
    for (const a of agents.values()) if (a.mode === "walking" || a.shift) return true;
    return !!L && L.pods.some(p => p.targetY != null && p.y !== p.targetY);
  }
  function stepAgents(dt) {
    const k = 1 - Math.exp(-dt * 9);                 // people slide along a resized desk; the desk glides up or down
    for (const a of agents.values()) if (a.shift) { a.shift -= a.shift * k; if (Math.abs(a.shift) < 0.3) a.shift = 0; }
    if (L) for (const p of L.pods) if (p.targetY != null && p.y !== p.targetY) { p.y += (p.targetY - p.y) * k; if (Math.abs(p.targetY - p.y) < 0.3) p.y = p.targetY; }
    const move = (a) => walkStep(a, dt);
    let settled = false;
    for (const a of agents.values()) if (a.mode === "walking" && move(a)) { a.mode = "seated"; settled = true; }
    for (const a of leavers) if (move(a)) { a.gone = true; openElevator(); }
    if (leavers.some(a => a.gone)) { leavers.filter(a => a.gone && a.tagEl).forEach(a => a.tagEl.remove()); leavers = leavers.filter(a => !a.gone); settled = true; }
    for (const c of couriers) {
      if (!walkStep(c, dt)) continue;
      if (c.phase === "in") {                        // drop the box, then head back
        carried.delete(c.gift); settled = true;
        if (!reduced) burst(c.drop[0] + 5, c.drop[1] - 6, 8, "spark");   // at the box, just above the courier
        c.phase = "out"; c.path = c.back;
      } else { c.gone = true; openElevator(); }
    }
    couriers = couriers.filter(c => !c.gone);
    if (settled) { ovKey = ""; renderOverlay(); }
  }
  // One step along a walker's path (top-left coordinates); true once it has arrived.
  function walkStep(a, dt) {
    if (!a.path.length) return true;
    const [tx, ty] = a.path[0];
    const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy);
    const step = (a.speed || SPEED) * walkBoost * dt;
    if (Math.abs(dx) > Math.abs(dy)) a.facing = dx > 0 ? "right" : "left"; else a.facing = dy > 0 ? "down" : "up";
    if (d <= step) { a.x = tx; a.y = ty; a.path.shift(); return !a.path.length; }
    a.x += dx / d * step; a.y += dy / d * step;
    return false;
  }
  // A courier out of the elevator, down the clear lane between the palm and the CEO desk, to the gift's spot.
  function sendCourier(p) {
    // lane: clear of the palm, the board and the desk; it comes in below the boxes already waiting and stands in front of
    // where its own goes, so it never steps on another gift.
    const ex = ELEVATOR.x + 8, ey = ELEVATOR.y + 18, lane = 85, drop = [p.x + 1, p.y + 10];
    const there = [[ex, WALK_Y], [lane, WALK_Y], [lane, drop[1]], drop];
    carried.add(p.g.id);
    couriers.push({ gift: p.g.id, color: p.color, x: ex, y: ey, path: there, back: [[lane, drop[1]], [lane, WALK_Y], [ex, WALK_Y], [ex, ey]],
      drop, phase: "in", facing: "down", speed: 40, look: S.lookFor("courier", "#8a5a2a") });
    openElevator();
  }

  // ------------------------------------------------------------------------------------- particles
  // Paper planes: a message from the CEO flies from the desk to the session it is for, in an arc, and lands with a spark.
  const planes = [];
  const helpersDone = new Map();          // session id -> helpers finished when last drawn, to dock drones as more finish
  function drawPlanes() {
    const now = performance.now();
    for (let i = planes.length - 1; i >= 0; i--) {
      const p = planes[i], k = (now - p.start) / p.dur;
      if (k < 0) continue;                                  // not off yet (a batch leaves one after another)
      if (k >= 1) { planes.splice(i, 1); burst(p.to[0], p.to[1], p.kind ? 4 : 8, "spark"); continue; }
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const x = Math.round(p.from[0] + (p.to[0] - p.from[0]) * e), y = Math.round(p.from[1] + (p.to[1] - p.from[1]) * e - Math.sin(k * Math.PI) * p.arc);
      if (p.kind === "mail") {                              // a commit's envelope, on its way to the outbox
        S.rect(ctx, x - 1, y - 1, 9, 7, "#2a2f40"); S.rect(ctx, x, y, 7, 5, "#f7f3e6");
        for (const [dx, dy] of [[1, 1], [2, 2], [3, 3], [4, 2], [5, 1]]) S.rect(ctx, x + dx, y + dy, 1, 1, "#b9b2a0");
        continue;
      }
      if (p.kind === "parcel") {                            // a PR, a parcel with tape
        S.rect(ctx, x - 1, y - 1, 9, 8, "#2a2f40"); S.rect(ctx, x, y, 7, 6, "#c9a26b"); S.rect(ctx, x, y, 7, 1, "#e0bd84"); S.rect(ctx, x + 3, y, 1, 6, "#8a6a3e");
        continue;
      }
      const d = p.to[0] >= p.from[0] ? 1 : -1, at = (dx, w) => (d > 0 ? x + dx : x + 9 - dx - w);   // mirrored when it flies left
      S.rect(ctx, at(0, 9), y - 1, 9, 1, "#2a2f40");                                     // a dark edge, so it reads on any floor
      S.rect(ctx, at(0, 9), y, 9, 1, "#ffffff"); S.rect(ctx, at(1, 7), y + 1, 7, 1, "#e6ebf6"); S.rect(ctx, at(3, 4), y + 2, 4, 1, "#b9c3da");
      S.rect(ctx, at(4, 2), y + 3, 2, 1, "#8f9bb8");
      for (let j = 1; j <= 3; j++) S.rect(ctx, d > 0 ? x - j * 4 : x + 9 + j * 4, y + 1, 2, 1, `rgba(255,255,255,${0.45 - j * 0.12})`);
    }
  }
  function burst(x, y, n, kind) {
    const cols = ["#ff5d73", "#ffd24a", "#38e07b", "#5b8def", "#c678dd", "#ff9f43", "#56b6c2"];
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, v = 30 + Math.random() * 60;
      if (kind === "heart") { particles.push({ x: x + (Math.random() - 0.5) * 8, y, vx: (Math.random() - 0.5) * 16, vy: -14 - Math.random() * 18, g: -4, life: 0, max: 1.2 + Math.random() * 0.6, c: i % 3 ? "#ff6fa8" : "#ff9cc4", s: 1, heart: true }); continue; }
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
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.max);
      if (p.heart) { const x = Math.round(p.x), y = Math.round(p.y); S.rect(ctx, x, y, 1, 1, p.c); S.rect(ctx, x + 2, y, 1, 1, p.c); S.rect(ctx, x, y + 1, 3, 1, p.c); S.rect(ctx, x + 1, y + 2, 1, 1, p.c); }
      else S.rect(ctx, p.x, p.y, p.s, p.s, p.c);
    }
    ctx.globalAlpha = 1;
  }

  // ----------------------------------------------------------------------------------------- render
  function drawFrame(t) {
    ctx.setTransform(RES, 0, 0, RES, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bg, 0, 0, W, H);
    const now = clockAt ? new Date(clockAt * 1000) : new Date();   // replay shows its own time of day
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
    drawShipBoard(t, lights);
    const season = seasonal ? seasonFor(now) : null;
    if (season) {
      drawSeason(ctx, L, season, reduced ? 0 : t, env.night, lights);
      if (season === "winter") for (const pod of L.pods) { const wr = windowRect(pod.room); drawSnow(ctx, wr.x, wr.y, wr.w, wr.h, reduced ? 0 : t); }
    }
    if (happy) drawParty(reduced ? 0 : t);
    drawGifts(t);
    const walkers = [...[...agents.values()].filter(a => a.mode === "walking"), ...leavers, ...couriers].sort((a, b) => a.y - b.y);
    for (const a of walkers) {
      S.drawWalker(ctx, a.x, a.y, a.look, a.facing, t, true);
      if (a.phase === "in") { S.rect(ctx, a.x + 2, a.y + 8, 7, 5, a.color); S.rect(ctx, a.x + 5, a.y + 8, 1, 5, "#ffd24a"); S.rect(ctx, a.x + 2, a.y + 8, 7, 1, "#ffffff"); }   // the box in both hands
    }
    S.drawCat(ctx, Math.round(cat.x), Math.round(cat.y), cat.mode, cat.facing, t);
    if (cat.mode === "sleep") S.drawZ(ctx, cat.x + 8, cat.y - 2, t);
    if (has("dog")) { S.drawDog(ctx, Math.round(dog.x), Math.round(dog.y), dog.mode, dog.facing, t); if (dog.mode === "sleep") S.drawZ(ctx, dog.x + 9, dog.y - 2, t); }
    if (has("roomba") && L.corridors.length) {      // a robot vacuum sweeps the first corridor back and forth
      const span = W - LOBBY_W - 30, ph = (t / 1000 * 16) % (span * 2), fwd = ph < span;
      S.drawRoomba(ctx, Math.round(LOBBY_W + 10 + (fwd ? ph : span * 2 - ph)), L.corridors[0] + 5, t, fwd ? 1 : -1);
    }
    if (droneUp(t)) {                               // now and then a delivery drone crosses over the building
      const k = ((t % DRONE_EVERY) - DRONE_EVERY + DRONE_FLIGHT) / DRONE_FLIGHT, dx = -20 + k * (W + 40), dy = 4 + Math.round(Math.sin(k * 9) * 2);
      S.rect(ctx, dx + 2, dy + 8, 4, 4, "#c9a26b"); S.rect(ctx, dx + 2, dy + 8, 4, 1, "#e0bd84");
      S.drawDrone(ctx, Math.round(dx), dy, "#38e07b", t);
    }
    if (ufoUp(t)) {                                 // the epic set: a saucer drifts across, beaming now and then
      const k = (((t + 31000) % UFO_EVERY) - UFO_EVERY + UFO_FLIGHT) / UFO_FLIGHT, ux = W + 20 - k * (W + 40), uy = 3 + Math.round(Math.sin(k * 14) * 2);
      S.drawUfo(ctx, Math.round(ux), uy, t, Math.floor(t / 900) % 5 === 0);
    }
    drawParticles();
    drawPlanes();
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

  // Gift boxes: a seat's in its room, above the nameplate (clear of the seasonal pumpkin); the morning delivery, swaps
  // and gifts from a seat that has left the plan wait in front of the CEO desk.
  function giftSpots(all = false) {
    const out = [], per = new Map();
    for (const g of gifts) {
      if (!all && carried.has(g.id)) { per.set("", (per.get("") || 0) + 1); continue; }   // keeps its place while it is carried
      const pod = g.seat && L.pods.find(p => p.seat.id === g.seat), key = pod ? g.seat : "", k = per.get(key) || 0;
      per.set(key, k + 1);
      out.push(pod ? { g, x: pod.room.x + 26 + k * 15, y: pod.room.y + pod.room.h - 48, color: pod.seat.color, ribbon: "#ffffff" }
        : { g, x: 104 + k * 16, y: L.ceo.y + 84, color: S.GIFT_BOX[g.from] || S.GIFT_BOX.daily, ribbon: "#ffd24a" });
    }
    return out;
  }
  // The ship board: a chalkboard in the lobby with today's commits, PRs opened and PRs merged (read from the
  // transcripts), the outbox tray that envelopes fly into as commits land, and a brass ship's bell that rings on a merge.
  const BOARD = () => ({ x: 10, y: L.ceo.y + 70 });
  const TRAY = () => { const b = BOARD(); return { x: b.x + 43, y: b.y + 34 }; };
  const STRIKE = 560;                                  // one swing of the bell, ms
  const bell = { start: 0, strikes: 0 };
  let slate = null, slateKey = null, chalkSeen = null;
  const bellRinging = (now = performance.now()) => now - bell.start < bell.strikes * STRIKE;
  function drawShipBoard(t, lights) {
    const { x, y } = BOARD(), sh = snap.office.shipped_today || null;
    S.rect(ctx, x + 2, y - 14, 2, 14, "#5a3b22"); S.rect(ctx, x + 2, y - 14, 15, 2, "#6e4a2b"); S.rect(ctx, x + 3, y - 14, 13, 1, "#8f6238");   // the bell's arm
    S.rect(ctx, x + 18, y + 31, 2, 8, "#3f2816"); S.rect(ctx, x + 3, y + 31, 2, 11, "#5a3b22"); S.rect(ctx, x + 35, y + 31, 2, 11, "#5a3b22");   // the easel
    S.rect(ctx, x, y, 40, 30, "#6e4a2b"); S.rect(ctx, x, y, 40, 1, "#8f6238");
    const key = sh ? `${sh.commits}|${sh.prs_opened}|${sh.prs_merged}` : "-";
    if (key !== slateKey) {
      if (chalkSeen && sh && game === "full" && !reduced) {      // a number went up: chalk dust where it was rewritten
        [sh.commits, sh.prs_opened, sh.prs_merged].forEach((n, i) => {
          if (n > (chalkSeen[i] || 0)) for (let k = 0; k < 6; k++) particles.push({ x: x + 8 + i * 12 + Math.random() * 6, y: y + 22, vx: (Math.random() - 0.5) * 14, vy: -6 - Math.random() * 8, g: 18, life: 0, max: 0.7 + Math.random() * 0.4, c: "#eef2ea", s: 1 });
        });
      }
      slate = S.chalkSlate(sh); slateKey = key; chalkSeen = sh ? [sh.commits, sh.prs_opened, sh.prs_merged] : null;
    }
    ctx.drawImage(slate, x + 2, y + 2, 36, 26);
    S.rect(ctx, x - 1, y + 29, 42, 2, "#8a5e36"); S.rect(ctx, x + 27, y + 28, 4, 1, "#f2f2e6"); S.rect(ctx, x + 32, y + 28, 2, 1, "#ffb3c8");   // the ledge, two chalks
    drawTray(sh);
    const now = performance.now(), cx = x + 14, by = y - 12;
    let sw = 0, wave = -1;
    if (bellRinging(now) && !reduced && game !== "off") {
      const k = (now - bell.start) / STRIKE;
      sw = Math.round(Math.sin(k * Math.PI * 2) * 1.4);
      wave = ((k + 0.75) % 0.5) / 0.5;                         // the clapper strikes at each end of the swing
      lights.push({ x: cx, y: by + 5, r: 22, c: "#ffd24a", i: 0.45 });
    } else if (!bell.start && sh && sh.prs_merged) lights.push({ x: cx, y: by + 5, r: 10, c: "#ffd24a", i: 0.15 });
    S.drawShipBell(ctx, cx, by, sw, wave);
  }
  // The outbox: a wire tray on the floor by the board, holding an envelope for every few of today's commits.
  function drawTray(sh) {
    const { x, y } = TRAY(), n = sh && sh.commits ? Math.min(4, Math.ceil(sh.commits / 10)) : 0;
    S.rect(ctx, x, y - 1, 14, 1, "#4a5070");
    for (let i = 0; i < n; i++) { S.rect(ctx, x + 2 + (i % 2), y - 2 - i * 2, 10, 2, i % 2 ? "#e6e0cf" : "#f7f3e6"); S.rect(ctx, x + 6 + (i % 2), y - 2 - i * 2, 2, 1, "#b9b2a0"); }
    S.rect(ctx, x, y, 14, 6, "#3a3f4f"); S.rect(ctx, x, y, 14, 1, "#6b7488");
    for (let i = 0; i < 4; i++) S.rect(ctx, x + 2 + i * 3, y + 2, 1, 3, "#2a2f3a");
  }
  function shipLabel() {
    const sh = snap.office.shipped_today;
    if (!sh) return "Ship board: today's commits, PRs and merges (reading the transcripts)";
    const pl = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
    return `Ship board: ${pl(sh.commits, "commit", "commits")}, ${pl(sh.prs_opened, "PR", "PRs")} opened and ${pl(sh.prs_merged, "merge", "merges")} today. Open the PR shelf`;
  }

  // Happy hour: coloured spots wander over the lobby floor and along the corridors.
  function drawParty(t) {
    const dot = (x, y, i) => { ctx.fillStyle = `hsl(${(t / 18 + i * 53) % 360} 95% 62%)`; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill(); };
    ctx.globalAlpha = 0.2;
    const top = WALL + 12, h = Math.max(20, L.server.y - top - 12), w = LOBBY_W - 40;
    for (let i = 0; i < 7; i++) dot(14 + w * (0.5 + 0.45 * Math.sin(t / 1700 + i * 1.9)), top + h * (0.5 + 0.45 * Math.cos(t / 2100 + i * 2.3)), i);
    L.corridors.forEach((cy, j) => { for (let i = 0; i < 4; i++) dot(LOBBY_W + 10 + (W - LOBBY_W - 20) * (0.5 + 0.48 * Math.sin(t / 2300 + i * 1.6 + j)), cy + 6, i + j * 4 + 7); });
    ctx.globalAlpha = 1;
  }
  function drawGifts(t) {
    giftSpots().forEach((p, i) => S.drawGift(ctx, p.x, p.y, p.color, p.ribbon, reduced ? 0 : t, i));
  }

  // The lobby wall: the neon sign (a page element), the elevator, the trophy cabinet and the employee-of-the-day frame.
  function drawLobbyWall(t, lights) {
    S.rect(ctx, 6, 8, 70, 22, "#140f1f"); S.rect(ctx, 7, 9, 68, 20, "#1d1530");
    lights.push({ x: 41, y: 19, r: 40, c: "#ff4fd8", i: 0.55 });
    const open = performance.now() < elevator.until ? 1 : 0;
    elevator.open += (open - elevator.open) * 0.12;
    S.drawElevator(ctx, ELEVATOR.x, ELEVATOR.y, elevator.open, "", t, has("goldlift"));
    lights.push({ x: ELEVATOR.x + 13, y: ELEVATOR.y - 2, r: 12, c: "#ff8f3d", i: 0.5 });
    const cups = trophies();
    S.drawCabinet(ctx, 116, 8, cups, t);
    if (sets.has("common")) drawStickerWall();
    if (cups.length) lights.push({ x: 144, y: 22, r: 26, c: "#ffd24a", i: cups.some(c => c.glint) ? 0.4 : 0.22 });
    S.drawFrame(ctx, 176, 12, 16, 22, !!mvp);
    if (mvp) {
      const seat = snap.seats.find(s => s.id === mvp.seat);
      if (seat) S.drawSeated(ctx, 179, 18, S.lookFor("mascot-" + seat.id, seat.color), "down", "idle", t);
      if (Math.floor(t / 600) % 4 === 0) S.rect(ctx, 178 + (Math.floor(t / 150) % 12), 13, 1, 1, "#fff8c0");
      lights.push({ x: 184, y: 22, r: 18, c: "#ffd24a", i: 0.35 });
    }
  }

  // Token burn on the floor: embers rise off a desk while its seat burns tokens, more and faster the harder it burns
  // (tokens processed in the last hour). Part of the game: none at Calm or Off, and still under reduced motion.
  function drawEmbers(s, desk, t, lights) {
    const b = s.tokens_1h_all || 0, level = b >= 60e6 ? 3 : b >= 15e6 ? 2 : b >= 2e6 ? 1 : 0;   // tokens in the last hour
    if (!level || game !== "full" || s.status === "limited") return;
    const n = [0, 5, 9, 14][level], cols = ["#ffd24a", "#ff9b3d", "#ff7a45"], speed = [0, 2.4, 1.8, 1.3][level];
    for (let i = 0; i < n; i++) {
      const h = S.hashOf(s.id + "e" + i), ph = reduced ? ((h >>> 3) % 100) / 100 : ((t / 1000 + (h % 1000) / 1000 * speed) % speed) / speed;
      const x = desk.x + 4 + ((h >>> 8) % Math.max(1, desk.w - 8)) + Math.round(Math.sin(ph * 6 + i) * 1.5), y = Math.round(desk.y + 4 - ph * (18 + level * 5));
      ctx.globalAlpha = Math.max(0, 1 - ph);
      const big = ph < 0.5;
      S.rect(ctx, x, y, big ? 2 : 1, big ? 2 : 1, cols[(h >>> 4) % 3]);
      if (big) S.rect(ctx, x, y, 1, 1, "#fff2c0");                 // a hot core while it is young
    }
    ctx.globalAlpha = 1;
    lights.push({ x: desk.x + desk.w / 2, y: desk.y, r: 18 + level * 8, c: "#ff7a45", i: 0.12 + level * 0.08 });
  }

  // The office radio's boombox on the CEO desk; while it plays, its speakers pulse and notes drift up.
  function drawBoombox(x, y, t) {
    const beat = radioOn && !reduced && Math.floor(t / (60000 / 76)) % 2 === 0;
    S.rect(ctx, x + 2, y - 1, 6, 1, "#5d6476"); S.rect(ctx, x, y, 10, 6, "#2b2f3a"); S.rect(ctx, x, y, 10, 1, "#454a5c");
    S.rect(ctx, x + 1, y + 2, 3, 3, beat ? "#8a92a8" : "#5d6476"); S.rect(ctx, x + 6, y + 2, 3, 3, beat ? "#8a92a8" : "#5d6476");
    S.rect(ctx, x + 4, y + 2, 2, 1, radioOn ? "#38e07b" : "#1a1c2b");
    if (!radioOn || reduced) return;
    for (let i = 0; i < 3; i++) {
      const ph = ((t / 1000 + i * 0.73) % 2.2) / 2.2, nx = Math.round(x + 4 + Math.sin(ph * 6 + i) * 4), ny = Math.round(y - 3 - ph * 18);
      ctx.globalAlpha = 1 - ph; const c = ["#ff9fd8", "#ffd24a", "#7fdbe6"][i];
      S.rect(ctx, nx, ny + 2, 2, 2, c); S.rect(ctx, nx + 1, ny - 1, 1, 3, c); S.rect(ctx, nx + 2, ny - 1, 1, 1, c);
    }
    ctx.globalAlpha = 1;
  }

  // The common set: stickers slapped all along the lobby's wainscot, and two by the elevator.
  const DECALS = ["#ffd24a", "#e8475a", "#4fc36a", "#4f86c0", "#ff7ac8", "#ff8f3d", "#9b6bff", "#7fdbe6"];
  function drawStickerWall() {
    for (let i = 0, x = 3; x < LOBBY_W - 8; i++) {
      const hx = S.hashOf("decal" + i), y = WALL - 9 + (hx % 4), c = DECALS[(hx >>> 4) % DECALS.length];
      const onLift = x + 5 > ELEVATOR.x - 4 && x < ELEVATOR.x + 30;   // never over the elevator doors
      if (!onLift) {
        S.rect(ctx, x, y, 5, 5, "#ffffff"); S.rect(ctx, x + 1, y + 1, 3, 3, c);
        if ((hx >>> 9) % 3 === 0) S.rect(ctx, x + 2, y + 2, 1, 1, "#ffffff");
      }
      x += 8 + (hx >>> 12) % 7;
    }
    S.rect(ctx, 77, 14, 5, 5, "#ffffff"); S.rect(ctx, 78, 15, 3, 3, "#ffd24a");
    S.rect(ctx, 78, 24, 5, 5, "#ffffff"); S.rect(ctx, 79, 25, 3, 3, "#4f86c0");
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

  // The capacity board in the CEO corner flips channels every 8 seconds: plan left on every seat, tokens burned in the
  // last hour, the all-time burners, and who gets the next lane. A label under it names the channel.
  const TV = () => ({ x: 8, y: L.ceo.y + 8, w: 58, h: 30 });
  const TV_CHANNELS = ["Plan left", "Burn 1 h", "Top burners", "Next lane"];
  let burnBoard = [], tvLabel = null, tvShown = -1;
  const tvChannel = () => Math.floor(Date.now() / 8000) % TV_CHANNELS.length;
  function drawTV(t, lights) {
    const { x, y, w, h } = TV();
    S.rect(ctx, x + w / 2 - 2, y + h + 2, 4, 14, "#2b2f3a"); S.rect(ctx, x + w / 2 - 10, y + h + 15, 20, 3, "#2b2f3a");
    S.rect(ctx, x - 2, y - 2, w + 4, h + 4, "#0a0b10"); S.rect(ctx, x, y, w, h, "#0f1424");
    const ch = tvChannel();
    if (tvLabel && ch !== tvShown) { tvShown = ch; tvLabel.textContent = tvText(ch); }
    if (!reduced && Date.now() % 8000 < 260) {            // a moment of static between channels
      for (let i = 0; i < 90; i++) { const k = (i * 7919 + Math.floor(t / 40) * 104729) % (w * h); S.rect(ctx, x + (k % w), y + Math.floor(k / w), 1, 1, i % 3 ? "#8a93a8" : "#d7dce8"); }
      lights.push({ x: x + w / 2, y: y + h / 2, r: 40, c: "#9aa6c4", i: 0.4 });
      return;
    }
    for (let i = 0; i < TV_CHANNELS.length; i++) S.rect(ctx, x + w - 3 - (TV_CHANNELS.length - 1 - i) * 3, y + 1, 2, 1, i === ch ? "#ffffff" : "#3a4258");
    if (ch === 1) drawTvBurn(x, y, w, h);
    else if (ch === 2) drawTvBoard(x, y, w, h);
    else if (ch === 3) drawTvNext(x, y, w, h, t);
    else drawTvPlan(x, y, w, h);
    S.rect(ctx, x, y + (Math.floor(t / 40) % h), w, 1, "rgba(255,255,255,0.05)");
    lights.push({ x: x + w / 2, y: y + h / 2, r: 40, c: "#5b8def", i: 0.45 });
  }
  function tvText(ch) {
    if (ch === 3) { const p = snap.next_pick && snap.next_pick.seat, s = p && snap.seats.find(x => x.id === p); return s ? `Next: ${persona ? persona(s).name : s.label}` : "No seat free"; }
    return TV_CHANNELS[ch];
  }
  // Tokens each seat burned in the last hour, as bars against the hungriest.
  function drawTvBurn(x, y, w, h) {
    const seats = snap.seats, max = Math.max(1, ...seats.map(s => s.tokens_1h_all || 0));
    const bw = Math.max(4, Math.floor((w - 6) / Math.max(1, seats.length)) - 3), hh = h - 9;
    seats.forEach((s, i) => {
      const bx = x + 4 + i * (bw + 3), v = s.tokens_1h_all || 0, bh = v > 0 ? Math.max(1, Math.round(hh * v / max)) : 0;
      S.rect(ctx, bx, y + 3, bw, hh, "#1b2236");
      if (bh) { S.rect(ctx, bx, y + 3 + hh - bh, bw, bh, s.color); S.rect(ctx, bx, y + 3 + hh - bh, bw, 1, "#ffb35c"); }
      S.rect(ctx, bx, y + h - 4, bw, 2, s.color);
    });
  }
  // The all-time board: the top four burners as bars, longest first.
  function drawTvBoard(x, y, w, h) {
    const rows = burnBoard.slice(0, 4), max = Math.max(1, ...rows.map(r => r.all));
    rows.forEach((r, i) => {
      const s = snap.seats.find(z => z.id === r.seat), by = y + 4 + i * 6, bw = Math.max(2, Math.round((w - 12) * r.all / max));
      S.rect(ctx, x + 3, by, 2, 4, i === 0 ? "#ffd24a" : "#3a4258");
      S.rect(ctx, x + 7, by, bw, 4, s ? s.color : "#82889f");
    });
  }
  // The next lane's seat: its colour and a pixel arrow pointing at it.
  function drawTvNext(x, y, w, h, t) {
    const p = snap.next_pick && snap.next_pick.seat, s = p && snap.seats.find(z => z.id === p);
    if (!s) { S.rect(ctx, x + w / 2 - 6, y + h / 2 - 1, 12, 2, "#3a4258"); return; }
    S.rect(ctx, x + 4, y + 5, w - 8, h - 12, s.color);
    S.rect(ctx, x + 5, y + 6, w - 10, h - 14, "rgba(0,0,0,0.25)");
    const ax = x + w / 2 - 4 + (reduced ? 0 : Math.round(Math.sin(t / 300) * 2)), ay = y + h / 2 - 4;
    for (let r = 0; r < 4; r++) S.rect(ctx, ax + r, ay + r, 2, 8 - 2 * r, "#ffffff");
  }
  function drawTvPlan(x, y, w, h) {
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
    if (sets.has("legendary")) S.drawGoldDuck(ctx, dx + 51, dy + 3, t);   // the legendary set
    drawBoombox(dx + 2, dy + 14, t);
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
    S.drawWindow(ctx, wr.x, wr.y, wr.w, wr.h, env.sky, reduced ? 0 : t, env.night, weatherOf(s), windowExtras());   // still under reduced motion
    // the wall clock, with a wedge to when the 5-hour plan comes back (red if it runs out first)
    const f5 = (s.usage || {}).five_hour, fc = ((s.forecast || {}).five_hour || {}).state;
    S.drawClock(ctx, room.x + 112, room.y + 12, clockAt ? new Date(clockAt * 1000) : new Date(),
      f5 && f5.resets_at ? { to: new Date(f5.resets_at * 1000), color: st === "limited" || fc === "runs_out" ? "#e8475a" : s.color } : null);
    if (env.night) lights.push({ x: wr.x + wr.w / 2, y: wr.y + wr.h + 6, r: 24, c: "#9bb8ff", i: 0.2 });
    const live = s.sessions.filter(x => x.live !== false);
    const dark = st === "offline" ? 0.5 : st === "limited" ? 0.42 : st === "benched" ? 0.3 : !live.length ? 0.2 : 0;
    drawDecorLive(ctx, room, pod.arch, t, dark < 0.25);
    drawPod(pod, t, lights);
    drawEmbers(s, deskFor(pod), t, lights);          // over the people, so they read as rising off the desk
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

  function windowExtras() { return has("balloon") || has("fireworks") ? { balloon: has("balloon"), fireworks: has("fireworks") } : null; }
  // A room's mood weather in its window: rain while the seat is out of plan, clouds while its plan runs low.
  function weatherOf(s) {
    if (s.status === "limited") return "rain";
    if (s.status === "benched" || s.status === "offline") return "clear";
    const lefts = ["five_hour", "weekly"].map(k => { const w = (s.usage || {})[k]; return w && w.pct != null ? 100 - w.pct : null; }).filter(v => v != null);
    return lefts.length && Math.min(...lefts) < 20 ? "cloudy" : "clear";
  }

  // A worker's look with its character's gear (engine/sprites.js GEAR_LEVELS), cached per look and level.
  const gearCache = new WeakMap();
  function gear(look, s) {
    const lv = s.career ? s.career.level : 0;
    if (lv < 5) return look;
    let g = gearCache.get(look);
    if (!g || g.gear !== lv) { g = { ...look, gear: lv }; gearCache.set(look, g); }
    return g;
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
    if (s.ghost) {                                   // someone else is using this login: a ghost floats by the wall
      const gx = pod.room.x + pod.room.w - 30, gy = pod.room.y + 34;
      S.drawGhost(ctx, gx, gy, t + s.id.length * 900, reduced);
      lights.push({ x: gx + 4, y: gy + 4, r: 14, c: "#c8d4ff", i: 0.35 });
    }
    if (busy) lights.push({ x: mid, y: pod.y + 54, r: 62, c: "#ffd59a", i: 0.5 });
    const lv = s.career ? s.career.level : 1;
    if (lv >= 3) S.drawDeskPerks(ctx, desk, lv, s.color, t);
    if (sets.has("rare")) {                          // a lava lamp at whichever end of the desk the plant leaves free
      const lx = desk.gaps.length > 1 ? desk.x + 2 : desk.x + desk.w - 14;   // where the plant is not (drawDeskPerks)
      S.drawLavaLamp(ctx, lx, desk.y + 6, t + s.id.length * 700); lights.push({ x: lx + 2, y: desk.y + 9, r: 10, c: "#ff7ac8", i: 0.35 });
    }
    if (lv >= 15) lights.push({ x: mid, y: desk.y + desk.h, r: 40, c: s.color, i: 0.3 });
    for (let slot = 0; slot < pod.cap; slot++) {
      const sp = seatSpot(pod, slot), a = bySlot.get(slot), x = sp.cx + (a ? Math.round(a.shift || 0) : 0);
      const pose = a ? poseFor(a.sess, status) : null;
      if (sp.top) {
        S.drawChairFront(ctx, x - 2, pod.y + 16);
        if (a) {
          S.drawSeated(ctx, x, sp.seatY, gear(a.look, s), "down", pose, t + slot * 777);
          if (a.sess.kind === "desk") { S.rect(ctx, x - 1, sp.seatY + 3, 1, 3, "#2a2d38"); S.rect(ctx, x + 10, sp.seatY + 3, 1, 3, "#2a2d38"); S.rect(ctx, x, sp.seatY - 1, 10, 1, "#2a2d38"); }
        }
        S.drawMonitorBack(ctx, x - 3, pod.y + 31);
        if (a) drawDeskBits(a, x, true, pod, t, lights);
        if (a && pose !== "sleep") S.drawHands(ctx, x, pod.y + 42, a.look, pose, t + slot * 333);
        if (a && pose === "sleep") S.drawZ(ctx, x + 8, sp.seatY - 6, t + slot * 500);
        // The mug steams while its owner waits on a long tool, or while an idle session's prompt cache is still warm.
        if (a && (pose === "idle" || pose === "wait")) S.drawMug(ctx, x + 12, pod.y + 43, t, pose === "wait" || !!(a.sess.cache && a.sess.cache.until > Date.now() / 1000));
        if (a && pose === "stuck") S.drawMark(ctx, x + 3, sp.seatY - 9, "?", t);
        if (a && pose === "think") S.drawThought(ctx, x + 8, sp.seatY - 8, t);
        if (a && pose !== "sleep" && !off) lights.push({ x: x + 5, y: pod.y + 30, r: 12, c: "#9fd0ff", i: 0.35 });
      } else {
        S.drawMonitorFront(ctx, x - 3, pod.y + 51, a && !off ? pose : "off", s.color, t + slot * 1234);
        if (a) drawDeskBits(a, x, false, pod, t, lights);
        if (a) {
          S.drawSeated(ctx, x, sp.seatY, gear(a.look, s), "up", pose, t + slot * 777);
          if (a.sess.kind === "desk") { S.rect(ctx, x, sp.seatY + 1, 10, 1, "#2a2d38"); S.rect(ctx, x - 1, sp.seatY + 3, 1, 3, "#2a2d38"); S.rect(ctx, x + 10, sp.seatY + 3, 1, 3, "#2a2d38"); }
          if (pose === "sleep") S.drawZ(ctx, x + 8, sp.seatY - 4, t + slot * 500);
          if (pose === "stuck") S.drawMark(ctx, x + 3, sp.seatY - 8, "?", t);
          if (pose === "think") S.drawThought(ctx, x + 8, sp.seatY - 10, t);
          if (!off && pose !== "sleep") lights.push({ x: x + 5, y: pod.y + 57, r: 16, c: pose === "read" ? "#e8f0ff" : "#7ec8ff", i: 0.5 });
          if (pose === "sleep") lights.push({ x: x + 5, y: pod.y + 57, r: 10, c: "#ff4d5e", i: 0.3 });
        }
        S.drawChairBack(ctx, x - 1, pod.y + 74);
      }
      const helpers = a ? (a.sess.helpers || []).length : 0;
      if (helpers) {                                    // one drone per helper at work, orbiting its owner
        const cx = x + 2, cy = sp.top ? sp.seatY - 4 : sp.seatY - 8, n = Math.min(6, helpers);
        for (let i = 0; i < n; i++) {
          const ang = (reduced ? 0 : t / 1100) + i * 2 * Math.PI / n, hx = Math.round(cx + Math.cos(ang) * 13), hy = Math.round(cy + Math.sin(ang) * 6);
          S.drawDrone(ctx, hx, hy, s.color, t + slot * 400 + i * 170);
        }
        lights.push({ x: cx + 3, y: cy + 2, r: 16, c: s.color, i: 0.45 });
      } else if (a && pose === "delegate") {
        const hx = x + 11, hy = sp.top ? sp.seatY - 2 : sp.seatY - 6;
        S.drawDrone(ctx, hx, hy, s.color, t + slot * 400);
        lights.push({ x: hx + 3, y: hy + 2, r: 10, c: s.color, i: 0.5 });
      }
      if (a) {                                          // a helper finished: its drone docks with a spark
        const done = a.sess.helpers_done || 0, was = helpersDone.get(a.id);
        if (was != null && done > was && !reduced && game !== "off") {
          const [ax, ay] = anchorFor(a); burst(ax, ay - 4, 12, "spark");
          if (game === "full") pops.push({ el: div("pop good", done - was > 1 ? `${done - was} helpers done` : "Helper done", ax, ay - 10), until: performance.now() + 2200 });
        }
        helpersDone.set(a.id, done);
      }
    }
    if (off) { S.rect(ctx, pod.x + 56, pod.y + 46, 16, 13, "#ffe066"); S.rect(ctx, pod.x + 58, pod.y + 49, 12, 1, "#8a6d00"); S.rect(ctx, pod.x + 58, pod.y + 52, 8, 1, "#8a6d00"); S.rect(ctx, pod.x + 58, pod.y + 55, 10, 1, "#8a6d00"); }
    const lamp = { working: "#38e07b", idle: "#e5c07b", limited: "#ff3b4e", benched: "#5b8def", offline: "#6b7080" }[status] || "#6b7080";
    if (status === "limited") { S.drawBeacon(ctx, pod.x + POD_W - 18, pod.y + 36, t); lights.push({ x: pod.x + POD_W - 16, y: pod.y + 37, r: 34 + Math.sin(t / 220) * 6, c: "#ff3b4e", i: 0.6 }); }
    else { S.rect(ctx, pod.x + POD_W - 17, pod.y + 40, 3, 3, lamp); if (status === "working" && Math.floor(t / 600) % 2) S.rect(ctx, pod.x + POD_W - 18, pod.y + 39, 5, 5, S.alpha(lamp, 0.3)); }
  }

  // What a desk says about its session at a glance: the CI lamp on the screen's corner (its PR's checks), the task
  // list as a strip, and its context as a pile of paper that grows towards the model's window (red when nearly full).
  function drawDeskBits(a, x, top, pod, t, lights) {
    const ci = a.sess.ci, ly = top ? pod.y + 30 : pod.y + 50;
    if (ci && ci.checks) {
      const blink = ci.checks !== "pass" && !reduced && Math.floor(t / 600) % 2;
      S.rect(ctx, x + 10, ly, 3, 3, "#0a0b10");
      S.rect(ctx, x + 11, ly + 1, 1, 1, blink ? "#5b6378" : { pass: "#3ddc84", pending: "#ffc24b", fail: "#ff4d5e" }[ci.checks]);
      if (ci.checks === "fail" && !blink) lights.push({ x: x + 11, y: ly + 1, r: 8, c: "#ff4d5e", i: 0.6 });
    }
    const tk = a.sess.tasks, sy = top ? pod.y + 33 : pod.y + 63;
    if (tk && tk.total) { S.rect(ctx, x - 1, sy, 12, 2, "#5b6378"); S.rect(ctx, x - 1, sy, Math.round(12 * tk.done / tk.total), 2, tk.done === tk.total ? "#ffd24a" : "#3ddc84"); }
    const c = a.sess.cache;
    if (c && c.window && c.context) {
      const fill = Math.min(1, c.context / c.window), sheets = Math.max(1, Math.round(fill * 7)), px = x + 16, py = top ? pod.y + 46 : pod.y + 61;
      for (let i = 0; i < sheets; i++) S.rect(ctx, px + (i % 2), py - i, 4, 1, fill >= 0.9 && i >= sheets - 2 ? "#ff8a8a" : i % 2 ? "#eef1f7" : "#cdd3e0");
    }
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
    b.addEventListener("click", (e) => { e.stopPropagation(); if (dragMoved) return; peek(null); if (secondTap(e)) { if (handlers.onDouble) handlers.onDouble(); onDouble ? onDouble() : zoomToEvent(e); return; } onClick(); });
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
      (snap.units || []).map(x => x.unit + x.active), waiting().map(l => l.id), gifts.map(g => g.id + g.label), radioOn, burner, belt, lean, odometer, game, snap.office.shipped_today && [snap.office.shipped_today.commits, snap.office.shipped_today.prs_opened, snap.office.shipped_today.prs_merged],
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
    if (handlers.onRadio) hot("wallhot", radioOn ? "Office radio: playing, click to stop" : "Office radio: click for lo-fi", 96, L.ceo.y + 70, 15, 12, () => handlers.onRadio());
    hot("room", "Server closet: background services", L.server.x, L.server.y, L.server.w - 26, L.server.h, () => handlers.openServices());
    if (L.meet) hot("room", "Meeting room: programmes", L.meet.x, L.meet.y, L.meet.w, L.meet.h, () => handlers.openProgrammes());
    if (L.lounge) hot("room", "Lounge: seats on a break", L.lounge.x, L.lounge.y, L.lounge.w, L.lounge.h, () => handlers.openLounge());
    if (L.lounge && handlers.openArcade) hot("wallhot", "Arcade: play Bug Squash", L.lounge.x + 163, L.lounge.y + 106, 20, 28, () => handlers.openArcade());
    const tv = TV();
    hot("wallhot", "Capacity board: plan left on every seat", tv.x - 2, tv.y - 2, tv.w + 4, tv.h + 20, () => handlers.openDivider());
    hot("wallhot", "Elevator: office news", ELEVATOR.x - 3, ELEVATOR.y - 6, 32, 46, () => handlers.openNews());
    hot("wallhot", "Employee of the day", 172, 8, 24, 32, () => handlers.openStats());
    hot("wallhot", "Trophy cabinet: everyone's achievements", 114, 6, 60, 34, () => handlers.openTrophies());
    if (handlers.openShipped) { const b = BOARD(); hot("wallhot", shipLabel(), b.x - 1, b.y - 14, 60, 56, () => handlers.openShipped()); }
    if (L.lounge) div("room-label", "LOUNGE", L.lounge.x + 8, L.lounge.y + BACK_LABEL);
    if (L.meet) div("room-label", "MEETING", L.meet.x + 8, L.meet.y + BACK_LABEL);
    for (const o of L.open) div("room-label", "GARDEN", o.x + 8, o.y + BACK_LABEL);

    const neon = div("neon" + (has("neon") ? " show" : ""), snap.office.name || "Claude Office", 6, 8); place(neon, 6, 8, 70, 22);
    tvLabel = div("tv-label", tvText(tvChannel()), 4, 0); place(tvLabel, 2, L.ceo.y + 38, 70, null); tvShown = tvChannel();
    tvLabel.setAttribute("aria-hidden", "true");
    if (odometer) {
      const od = div("odometer", null, 6, 31);
      od.innerHTML = `<b class="${odometer !== odoShown ? "roll" : ""}">${esc(odometer)}</b> tokens`; odoShown = odometer;   // rolls in once per number
      od.title = `The office has processed ${odometer} tokens (the Tokens tab has the story)`; place(od, 6, 31, 70, null);
    }
    overlay.classList.toggle("gold-plates", has("goldplates"));
    if (mvp) place(div("mvp-tag", "MVP", 172, 36), 172, 36, 24, null);
    const closet = closetUnits();
    closet.shown.forEach((un, i) => { const [x, y] = rackPos(i); hot("rack", `${un.unit}: ${un.active}`, x, y, 18, 42, () => handlers.openServices()); });
    if (closet.hidden) div("room-label more", `+${closet.hidden} more`, LOBBY_W - 70, L.server.y - 12);
    hot("hire", "Hiring desk: start a new lane", L.hire.x + 8, L.hire.y + 8, POD_W - 16, POD_H - 14, () => handlers.openHire());
    place(div("plate hire-plate", "Hiring desk", 0, 0), L.hire.x + 24, L.hire.y + 98, POD_W - 48, null);
    waiting().forEach((l, i) => { const tg = div("tag queue", "⏳ " + short(l.title, 12), L.hire.x + 39 + i * 14, L.hire.y + 80); tg.title = l.waiting_reason || "Waiting for a seat"; });
    for (const pod of L.pods) renderPod(pod);
    for (const p of giftSpots()) { const b = hot("gift", p.g.label || "A gift: open it", p.x - 3, p.y - 4, 18, 18, () => handlers.onGift && handlers.onGift(p.g.id)); b.dataset.k = "gift:" + p.g.id; }
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
    const lv = (s.career ? `<em class="lv" title="Level ${s.career.level} ${esc(s.career.title)}">${s.career.level}</em>` : "")
      + (burner === s.id ? `<em class="pl-burn" title="The office's top token burner, all time">${icon("flame", 12)}</em>` : "")
      + (belt === s.id && game !== "off" ? `<em class="pl-belt" title="Burner Belt: the most tokens last week">${icon("belt", 12)}</em>` : "")
      + (lean === s.id && game !== "off" ? `<em class="pl-lean" title="Lean ribbon: the fewest tokens per commit last week">${icon("check", 11)}</em>` : "");
    const need = handlers.needsFor ? handlers.needsFor(s.id) : (snap.attention || []).filter(a => a.seat === s.id).length;   // as Needs you groups them
    if (need) plate.classList.add("needs");
    plate.innerHTML = `<span class="pl-line"><b><i></i><span class="pl-name">${esc(who.name)}</span>${lv}</b><span class="pl-chip ${line.tone}">${esc(line.main)}</span></span>` +
      `<span class="pl-line pl-sub"><span class="bar ${line.left != null && line.left < 15 ? "low" : line.left != null && line.left < 35 ? "mid" : ""}"><i style="width:${line.left ?? 0}%"></i></span><span>${esc(line.side)}</span></span>` +
      (need ? `<span class="pl-need" title="${need} thing${need === 1 ? "" : "s"} in Needs you">${need}</span>` : "");
    const honours = [burner === s.id && "top burner", belt === s.id && game !== "off" && "holds the Burner Belt", lean === s.id && game !== "off" && "holds the Lean ribbon"].filter(Boolean);
    plate.setAttribute("aria-label", `${who.name}${s.career ? `, level ${s.career.level}` : ""}${honours.length ? ", " + honours.join(", ") : ""}: ${line.main}, ${line.side}`);
    plate.addEventListener("click", (e) => { e.stopPropagation(); if (dragMoved) return; peek(null); if (secondTap(e)) { if (handlers.onDouble) handlers.onDouble(); focusSeat(s.id); return; } handlers.openSeat(s.id); });
    plate.addEventListener("dblclick", (e) => e.stopPropagation());
    overlay.appendChild(plate);
    const podHot = hot("pod", `${who.name}'s desks`, pod.room.x + 2, pod.room.y + 2, pod.room.w - 4, pod.room.h - 30, () => handlers.openSeat(s.id), () => focusSeat(s.id));
    podHot.dataset.k = "pod:" + s.id;
    const f5 = (s.usage || {}).five_hour, wk = (s.usage || {}).weekly, when = (ts) => new Date(ts * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
    if (f5 && f5.resets_at) {                          // the wall clock says when the plan comes back
      const ck = hot("wallhot clock", `${who.name}'s clock: the 5-hour plan ${s.status === "limited" ? "is back" : "resets"} ${when(f5.resets_at)}${wk && wk.resets_at ? `, the week resets ${when(wk.resets_at)}` : ""}`,
        pod.room.x + 111, pod.room.y + 11, 17, 17, () => handlers.openSeat(s.id));
      ck.dataset.k = "clock:" + s.id;
    }
    const roomMenu = (el) => el.addEventListener("contextmenu", (e) => { if (!handlers.onRoomMenu) return; e.preventDefault(); e.stopPropagation(); peek(null); handlers.onRoomMenu(s.id, e.clientX, e.clientY, el); });
    for (const el of [podHot, plate]) {
      roomMenu(el);
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
      roomMenu(b);                               // people sit mid-room: a right-click on them is a right-click on the room
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

  function petHot(p) {
    if (p.el && p.el.isConnected) return p.el;
    p.el = document.createElement("button");
    p.el.className = "hot cat"; p.el.type = "button"; p.el.setAttribute("aria-label", p.name);
    p.el.addEventListener("click", (e) => {
      e.stopPropagation();
      const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
      if (p.mode === "sleep") { p.mode = "sit"; p.until = performance.now() + 5000; }
      if (!reduced) burst(p.x + 6, p.y + 2, 7, "heart");
      // One tip at a time; it waits for the hearts to float up first.
      for (let i = pops.length - 1; i >= 0; i--) if (pops[i].el.classList.contains("cat-says")) { pops[i].el.remove(); pops.splice(i, 1); }
      clearTimeout(p.tipT);
      p.tipT = setTimeout(() => pops.push({ el: div("bubble cat-says", p.says + tip, p.x + 5, p.y - 2), until: performance.now() + 5600 }), reduced ? 0 : 700);
      if (handlers.onCat) handlers.onCat(tip);
    });
    overlay.appendChild(p.el);
    return p.el;
  }
  function moveDynamicDom() {
    place(petHot(cat), cat.x - 2, cat.y - 3, 15, 12);
    if (has("dog")) place(petHot(dog), dog.x - 2, dog.y - 3, 16, 12); else if (dog.el) { dog.el.remove(); dog.el = null; }
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

  // The minimap: while zoomed in, a small picture of the whole floor with the visible part outlined; a click there
  // moves the camera. Redrawn a few times a second from the floor canvas itself.
  const mini = document.createElement("canvas");
  mini.className = "minimap"; mini.hidden = true; mini.setAttribute("role", "img"); mini.setAttribute("aria-label", "Minimap: click to move the camera");
  stage.closest(".floor-frame") ? stage.closest(".floor-frame").appendChild(mini) : stage.appendChild(mini);
  const mg = mini.getContext("2d");
  function drawMini() {
    const on = cam.tz > 1.05 && !!L;
    mini.hidden = !on;
    if (!on) return;
    const w = 168, h = Math.round(w * H / W);
    if (mini.width !== w * 2 || mini.height !== h * 2) { mini.width = w * 2; mini.height = h * 2; mini.style.width = w + "px"; mini.style.height = h + "px"; }
    mg.imageSmoothingEnabled = true;
    mg.drawImage(canvas, 0, 0, mini.width, mini.height);
    const k = mini.width / (W * F * cam.z), { sw, sh } = sizes();
    const x = -cam.x * k, y = -cam.y * k, vw = sw * k, vh = sh * k;
    mg.fillStyle = "rgba(4,6,14,0.45)";                                   // dim what is off screen
    mg.fillRect(0, 0, mini.width, Math.max(0, y)); mg.fillRect(0, y + vh, mini.width, mini.height - y - vh);
    mg.fillRect(0, y, Math.max(0, x), vh); mg.fillRect(x + vw, y, mini.width - x - vw, vh);
    mg.strokeStyle = "#ffffff"; mg.lineWidth = 3; mg.strokeRect(x + 1.5, y + 1.5, vw - 3, vh - 3);
  }
  setInterval(drawMini, 250);
  mini.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const r = mini.getBoundingClientRect(), wx = (e.clientX - r.left) / r.width * W, wy = (e.clientY - r.top) / r.height * H, { sw, sh } = sizes();
    cam.tx = sw / 2 - wx * F * cam.tz; cam.ty = sh / 2 - wy * F * cam.tz; clampCam(cam);
  });

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
    L = computeLayout(snap.seats, arch, plan); W = L.W; H = L.H; L.unlocked = ol.unlocked;
    L.pods.forEach(p => { p.y = null; });
    for (const a of agents.values()) if (a.mode === "walking") { a.mode = "seated"; a.path = []; }   // walkers on the old plan sit down
    leavers = leavers.filter(l => { if (l.tagEl) l.tagEl.remove(); return false; });
    cat.x = cat.tx = 140; cat.y = cat.ty = WALK_Y + 10; cat.path = []; cat.mode = "sit"; cat.until = 0;
    dog.x = dog.tx = 40; dog.y = dog.ty = WALK_Y + 10; dog.path = []; dog.mode = "sit"; dog.until = 0;
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
      const moving = applyCam(false);
      if (moving) { clearTimeout(reresTimer); reresTimer = setTimeout(() => reres(false), 160); }
      stepAgents(dt); stepParticles(dt); stepPet(cat, dt, t); if (has("dog")) stepPet(dog, dt, t);
      // Full speed while something moves (walkers, confetti, the camera, the cat); a calm floor needs ~15 frames a second.
      // Full speed for the camera, people walking and confetti; pets, the vacuum and the drone look fine at the calm rate.
      const lively = moving || particles.length || pops.length || leavers.length || planes.length || bellRinging() || walkingNow();
      const every = reduced ? 250 : lively ? (RES <= 2 ? 33 : RES <= 4 ? 50 : 66) : (RES <= 2 ? 66 : 90);
      if (t - lastDraw >= every && onScreen) { drawFrame(t); lastDraw = t; }   // nothing to paint while the floor is hidden
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
    ol = officeLevel(snap.seats);
    const key = JSON.stringify(snap.seats.map(s => [s.id, s.color, arch(s)])) + "|" + (snap.units || []).length + "|" + ["palms", "flowers", "statue"].filter(has).join();
    const relayout = key !== staticKey;
    if (relayout) { L = computeLayout(snap.seats, arch, plan); W = L.W; H = L.H; staticKey = key; L.pods.forEach(p => { p.y = null; }); }
    else L.pods.forEach((p, i) => { p.seat = snap.seats[i]; });
    L.unlocked = ol.unlocked;
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
      if (game !== "full") { st.pending = 0; continue; }       // tracked, so Full later floats only what is new
      if (st.pending < 5 || t - st.at < 20000 || reduced || document.hidden) continue;
      const p = L && L.pods.find(p => p.seat.id === s.id);
      if (p) { const el = div("pop xp", `+${st.pending} XP`, p.x + POD_W - 26, p.y + 94); el.style.setProperty("--seat", s.color); pops.push({ el, until: t + 2600 }); }
      st.pending = 0; st.at = t;
    }
  }

  // A full-width "LEVEL UP" banner over the visible floor (on a phone the stage is wider than the screen). Banners that
  // arrive while one shows wait their turn, so a busy moment (a level up during a happy hour) shows each in full.
  // onShow runs when the banner appears (at once when banners are off), so a toast can arrive with its banner.
  const bannerQ = [];
  function dropBanners() {
    while (bannerQ.length) { const q = bannerQ.shift(); if (q[3]) q[3](); }
    if (!(stage.closest(".floor-frame") || stage).querySelector(".lvl-banner")) stage.classList.remove("bannering");
  }
  function banner(title, sub, color, onShow) {
    if (reduced || game !== "full") { dropBanners(); if (onShow) onShow(); return; }
    const host = stage.closest(".floor-frame") || stage;
    if (host.querySelector(".lvl-banner")) { if (bannerQ.length < 3) bannerQ.push([title, sub, color, onShow]); else if (onShow) onShow(); return; }
    const b = document.createElement("div");
    b.className = "lvl-banner"; b.setAttribute("aria-hidden", "true");
    b.style.setProperty("--seat", color || "#ffd24a");
    b.innerHTML = `<div class="lb-in"><span class="lb-stars">✦ ✦ ✦</span><b>${esc(title)}</b><span class="lb-sub">${esc(sub)}</span></div>`;
    host.appendChild(b);
    stage.classList.add("bannering");
    if (onShow) onShow();
    setTimeout(() => {
      b.remove();
      if (bannerQ.length) banner(...bannerQ.shift());
      else stage.classList.remove("bannering");
    }, 3400);
  }

  function celebrate(seatId, sessionId, text) {
    if (!L || game === "off") return;
    let x, y;
    const a = sessionId && agents.get(sessionId);
    if (a) [x, y] = anchorFor(a);
    else { const p = L.pods.find(p => p.seat.id === seatId); if (!p) return; x = p.x + POD_W / 2; y = p.y + 40; }
    if (!reduced && game === "full") burst(x, y, 46, "confetti");   // calm keeps the quiet "Shipped!" tag only
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
    setReducedMotion(on) { reduced = on; if (on) dropBanners(); },
    setMvp(m) { mvp = m && m.seat ? m : null; ovKey = ""; renderOverlay(); },
    setPersonas(fn) { persona = fn; staticKey = ""; ovKey = ""; if (snap) update(snap); },
    say(sessionId, text, ms = 6000) { if (!sessionId || !text || game !== "full") return; said.set(sessionId, { text, until: performance.now() + ms, at: performance.now() }); renderBubbles(); },
    sayAtSeat(seatId, text, ms = 6000) {
      if (game !== "full") return;
      const a = [...agents.values()].find(x => x.seatId === seatId && x.mode === "seated");
      if (a) { said.set(a.id, { text, until: performance.now() + ms, at: performance.now() }); renderBubbles(); }
    },
    focusSeat, focusSession, fit, celebrate, alarm, banner,
    officeLevel: () => ol,
    spotlight(id) { spot = id || null; },
    setSeasonal(on) { seasonal = !!on; },
    setGifts(list) {
      gifts = list || [];
      const ids = new Set(gifts.map(g => g.id));
      for (const id of [...carried]) if (!ids.has(id)) carried.delete(id);
      if (giftsSeen && L && !reduced && !clockAt) for (const p of giftSpots(true)) if (!giftsSeen.has(p.g.id) && !(p.g.seat && L.pods.some(q => q.seat.id === p.g.seat))) sendCourier(p);
      giftsSeen = ids;
      ovKey = ""; renderOverlay();
    },
    setHappy(on) { happy = !!on && game === "full"; },
    // Full: everything. Calm: no banners, confetti, character lines, party lights or XP floaters (real alerts stay).
    // Off: also no gifts, level-up pops or game chrome.
    setGameLevel(level) {
      game = ["full", "calm", "off"].includes(level) ? level : "full";
      if (game !== "full") { happy = false; dropBanners(); said.clear(); renderBubbles(); }       // speech is a Full-only thing
      ovKey = ""; renderOverlay();
    },
    gameLevel: () => game,
    setOdometer(text) { if (text !== odometer) { odometer = text || null; ovKey = ""; renderOverlay(); } },
    setLean(id) { if (id !== lean) { lean = id || null; ovKey = ""; renderOverlay(); } },
    setBelt(id) { if (id !== belt) { belt = id || null; ovKey = ""; renderOverlay(); } },
    setBurnBoard(rows) { burnBoard = (rows || []).filter(r => r.seat && r.all > 0); },
    setTopBurner(id) { if (id !== burner) { burner = id || null; ovKey = ""; renderOverlay(); } },
    setRadio(on) { radioOn = !!on; ovKey = ""; renderOverlay(); },
    setSets(s) { sets = new Set(s || []); },
    // Confetti where a gift was, as it opens.
    plane(seatId, sessionId) {
      if (!L || reduced || game !== "full") return;
      const a = sessionId && agents.get(sessionId), p = L.pods.find(x => x.seat.id === seatId);
      const to = a ? anchorFor(a) : p ? [p.x + POD_W / 2, p.y + 40] : null;
      if (!to) return;
      const from = [96 + 34, L.ceo.y + 52], dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
      planes.push({ from, to, start: performance.now(), dur: Math.min(2600, 700 + dist * 3), arc: Math.min(60, 14 + dist / 8) });
    },
    // Shipped work flies to the lobby's ship board: an envelope per commit (up to three), a parcel for a PR.
    mail(seatId, n = 1, kind = "mail") {
      if (!L || reduced || game !== "full") return;
      const p = L.pods.find(x => x.seat.id === seatId);
      if (!p) return;
      const tr = TRAY(), from = [p.x + POD_W / 2 - 3, p.y + 56], to = [tr.x + 4, tr.y - 8], dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
      for (let i = 0; i < Math.min(3, Math.max(1, n)); i++)
        planes.push({ from, to, kind, start: performance.now() + i * 280, dur: Math.min(2800, 900 + dist * 3), arc: Math.min(70, 20 + dist / 7) });
    },
    // A merge rings the ship's bell: two strikes a merge (ding-ding), more merges join a bell already ringing, six at most.
    ringBell(n = 1) {
      if (!L) return;
      const now = performance.now(), k = 2 * Math.max(1, n);
      if (bellRinging(now)) bell.strikes = Math.min(bell.strikes + k, 6);
      else { bell.start = now; bell.strikes = Math.min(k, 6); }
      if (!reduced && game !== "off") { const b = BOARD(); burst(b.x + 14, b.y - 4, 10, "spark"); }
    },
    // "+3 commits" rises from a seat's desk: shipped work, quieter than a celebration (commits come often).
    shipPop(seatId, text) {
      if (!L || reduced || game !== "full") return;
      const p = L.pods.find(x => x.seat.id === seatId);
      if (p) pops.push({ el: div("pop ship", text, p.x + POD_W / 2 - 16, p.y + 70), until: performance.now() + 2800 });
    },
    unwrap(id) { const p = L && giftSpots().find(x => x.g.id === id); if (p && !reduced && game === "full") burst(p.x + 6, p.y + 4, 40, "confetti"); },
    season: () => (seasonal ? seasonFor(new Date()) : null),
    setClock(ts) { clockAt = ts || null; },
    setWalkBoost(k) { walkBoost = Math.max(1, Math.min(8, k || 1)); },
    // The next update seats everyone where they belong at once (no walking in or out): for jumps in time (replay).
    reset() { for (const a of agents.values()) if (a.tagEl) a.tagEl.remove(); agents.clear(); leavers = leavers.filter(l => { if (l.tagEl) l.tagEl.remove(); return false; }); fresh.clear(); first = true; },
    picture: () => ({ canvas, W }),   // W is the current plan's width    // the whole floor, whatever the camera shows (for "Save a picture")
    zoom(dir) { const { sw, sh } = sizes(); zoomAt(dir > 0 ? cam.tz * 1.4 : cam.tz / 1.4, sw / 2, sh / 2); },
    pan(dx, dy) { cam.tx += dx; cam.ty += dy; clampCam(cam); },
  };
}

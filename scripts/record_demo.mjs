#!/usr/bin/env node
// Records the demo office into docs/demo.mp4 and docs/demo.gif, for the README and the landing page.
//
// It starts a fresh demo office on a free port (or uses --url), launches headless Chrome with a throwaway
// profile and drives it over the DevTools protocol. The cut opens on the "LEVEL UP!" banner the demo office
// shows about 20 s after it starts, then follows a visitor lane: the floor overview, a zoom into the pod it is
// walking to (its character's card opens in the panel), the walk-in, a zoom back out, a session's Chat, then a
// few seconds each of the Team view and the Timeline. Frames are resampled to a steady rate and encoded with
// ffmpeg. Chrome, its profile, the frames and any server it started are cleaned up on exit, also after an
// error or Ctrl-C.
//
//   node scripts/record_demo.mjs                  write docs/demo.mp4, docs/demo.gif and docs/demo-poster.jpg
//   node scripts/record_demo.mjs --previews DIR   also write a few PNG stills to DIR, to check the cut
//   node scripts/record_demo.mjs --help           every option
//
// Needs Node 22 or newer (global fetch and WebSocket; written against 24), google-chrome and ffmpeg. No npm packages.
// The UI hooks it relies on are listed in UI below; update them there if the page changes.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The office page as the recorder sees it. Everything it touches is here.
const UI = {
  floorReady: "#stage canvas",         // the floor has been drawn
  dismissWelcome: "[data-dismiss-welcome]",   // the first-visit hint's close button on the floor (a fresh profile sees it)
  banner: ".lvl-banner",               // the "LEVEL UP!" banner across the floor; it shows for about 3.4 s, and only
                                       // on the Floor view
  stage: "#stage",                     // the floor's viewport; Ctrl + wheel over it zooms the camera
  walking: ".tag.walking",             // the name tag of a session walking in from the elevator; other name tags
                                       // only show on hover or when zoomed in, but this one always shows
  pod: ".hot.pod",                     // a seat's desk pod; its aria-label is "<character name>'s desks" (the
                                       // name is also on the desk's nameplate; there is no sign above the pod)
  personas: "/static/ui/personas.js",  // the page's own module: personaFor(seat, index in seats).name is that name
  fit: '[data-cam="fit"]',             // camera button: fit the whole office
  zoomIn: '[data-cam="in"]',           // camera button: zoom in (fallback when the wheel does nothing)
  worker: ".hot.worker",               // a session at its desk; its aria-label is "<session name>, <state>: open"
                                       // and a click opens that session on its Chat tab
  teamTab: '[data-view="board"]',      // the Team view (?view=board)
  timelineTab: '[data-view="timeline"]',
  wheelZoom: 0.0025,                   // the camera zooms by exp(-deltaY * this) per wheel event (office.js)
};

// The demo session whose made-up chat (DEMO_CHAT in office/demo.py, a rate limiter rewrite) fits its name.
const CHAT_WITH = "api-rate-limits";

// The cut, in seconds. The floor part comes out at about 10 s; the middle of the walk is sped up to get there.
// Set chat, team or timeline to 0 to leave that part out.
const SHOT = {
  bannerWait: 45,     // how long to wait for the level-up banner once the page is open (the demo's comes ~20 s in)
  bannerPre: 0.6,     // floor kept from before the banner sweeps in...
  bannerPost: 0.3,    // ...and after it has gone
  posterAt: 1.0,      // the poster is this long after the banner appears (the first frame if there was no banner)
  preroll: 1.2,       // overview kept from before the visitor appears
  stepOut: 0.8,       // the visitor steps out of the elevator at normal speed...
  walkSpeed: 3,       // ...then crosses the floor this many times faster, until the camera moves
  zoomIn: 1.3,        // the camera glides into the visitor's pod...
  lead: 2.3,          // ...landing about this long before the visitor sits down (the estimate runs early)
  maxWalk: 14,        // stop waiting for the visitor to sit down after this
  seated: 1.3,        // hold on the visitor at its desk
  zoomOut: 1.1,       // the camera glides back out
  overview: 0.7,      // hold on the whole floor
  chat: 2.8,          // a session's Chat, next to the floor
  team: 2.3,          // the Team view
  timeline: 2.3,      // the Timeline view
};

const LIMITS = { mp4: 6 * 1024 * 1024, gif: 6.6 * 1024 * 1024 };   // the GIF stays under 7 MB (decimal) too

const HELP = `Usage: node scripts/record_demo.mjs [options]

  --url URL         office to record (default: a fresh demo office on a free loopback port, so its first
                    level-up comes about 20 s in); a server already answering there is used as it is, and
                    one is started there if nothing answers and the host is loopback
  --out DIR         where demo.mp4, demo.gif and demo-poster.jpg go (default docs/)
  --fps N           frame rate of the MP4 (default 24); the GIF is always 12 fps
  --width N         viewport width (default 1600)
  --height N        viewport height (default 900)
  --wait N          seconds to wait for a visitor to walk in (default 150; the demo sends one every 90 s)
  --chrome PATH     Chrome binary (default $CHROME or google-chrome)
  --ffmpeg PATH     ffmpeg binary (default $FFMPEG or ffmpeg)
  --previews DIR    write a few PNG stills of the cut to DIR
  --keep-frames     keep the raw frames and print where they are
  --allow-live      record even if the page is not in demo mode (it will show real seats)
  -h, --help        this text`;

const { values: opt } = parseArgs({
  options: {
    url: { type: "string" },
    out: { type: "string", default: join(ROOT, "docs") },
    fps: { type: "string", default: "24" },
    width: { type: "string", default: "1600" },
    height: { type: "string", default: "900" },
    wait: { type: "string", default: "150" },
    chrome: { type: "string", default: process.env.CHROME || "google-chrome" },
    ffmpeg: { type: "string", default: process.env.FFMPEG || "ffmpeg" },
    previews: { type: "string" },
    "keep-frames": { type: "boolean", default: false },
    "allow-live": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (opt.help) { console.log(HELP); process.exit(0); }

let BASE = opt.url ? opt.url.replace(/\/+$/, "") : null;    // set in main() when no --url is given
const FPS = Number(opt.fps), VW = Number(opt.width), VH = Number(opt.height), WAIT = Number(opt.wait);
for (const [k, v] of Object.entries({ fps: FPS, width: VW, height: VH, wait: WAIT })) {
  if (!Number.isFinite(v) || v <= 0) fail(`--${k} must be a positive number`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now() / 1000;
const log = (...a) => console.log("·", ...a);
function fail(msg) { console.error(`record_demo: ${msg}`); process.exit(1); }

// ------------------------------------------------------------------------------------------------ cleanup
// Every resource registers an undo step. They run in reverse order, synchronously, on any exit path.
const undo = [];
function cleanup() {
  while (undo.length) { try { undo.pop()(); } catch { /* best effort */ } }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { console.error(`\nrecord_demo: ${sig}, cleaning up`); cleanup(); process.exit(130); });
}

function alive(child) { return child.exitCode === null && child.signalCode === null; }
function killGroup(child, sig) {
  if (!alive(child)) return;
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
}
async function stopGroup(child, graceMs = 3000) {
  if (!alive(child)) return;
  const done = new Promise((r) => child.once("exit", r));
  killGroup(child, "SIGTERM");
  await Promise.race([done, sleep(graceMs)]);
  killGroup(child, "SIGKILL");
}

// ------------------------------------------------------------------------------------------------- server
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

async function reachable(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

async function ensureServer() {
  if (await reachable(`${BASE}/api/state`)) { log(`using the office already running at ${BASE}`); return null; }
  const u = new URL(BASE);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) fail(`nothing answers at ${BASE}`);
  const port = u.port || "80";
  log(`starting the demo office on port ${port}`);
  const server = spawn("python3", ["-m", "office", "serve", "--demo", "--port", port], {
    cwd: ROOT, detached: true, stdio: ["ignore", "ignore", "pipe"],
  });
  let errText = "";
  server.stderr.on("data", (d) => { errText = (errText + d).slice(-2000); });
  undo.push(() => killGroup(server, "SIGTERM"));
  for (let i = 0; i < 100; i++) {
    if (await reachable(`${BASE}/api/state`)) return server;
    if (!alive(server)) fail(`the demo server exited:\n${errText}`);
    await sleep(100);
  }
  fail(`the demo server did not come up on ${BASE}:\n${errText}`);
}

// ------------------------------------------------------------------------------------------------- chrome
async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), "claude-office-chrome-"));
  undo.push(() => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { ...process.env };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const chrome = spawn(opt.chrome, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${VW},${VH}`,
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  undo.push(() => killGroup(chrome, "SIGKILL"));
  chrome.on("error", (e) => fail(`cannot start ${opt.chrome}: ${e.message}`));

  let errText = "";
  const wsUrl = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`Chrome did not open DevTools:\n${errText}`)), 20000);
    chrome.stderr.on("data", (d) => {
      errText = (errText + d).slice(-4000);
      const m = errText.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); res(m[1]); }
    });
    chrome.once("exit", (code) => { clearTimeout(timer); rej(new Error(`Chrome exited (${code}):\n${errText}`)); });
  });
  chrome.stderr.resume();
  return { chrome, wsUrl };
}

class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error(`cannot reach Chrome DevTools at ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener("message", (ev) => this.#onMessage(JSON.parse(ev.data)));
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("the DevTools connection closed"));
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch { /* closed */ } }
  #onMessage(m) {
    if (m.id) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
      return;
    }
    for (const fn of this.listeners) fn(m);
  }
}

// A page target, with the few helpers the cut needs.
function pageOf(cdp, sessionId) {
  const send = (method, params) => cdp.send(method, params, sessionId);
  async function evaluate(expression) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  async function waitFor(expression, timeoutS, what) {
    const end = now() + timeoutS;
    while (now() < end) {
      if (await evaluate(expression).catch(() => false)) return true;
      await sleep(100);
    }
    if (what) throw new Error(`timed out after ${timeoutS} s waiting for ${what}`);
    return false;
  }
  const centre = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
    const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  async function mouse(x, y, clicks = 1) {         // clicks = 0 only moves the pointer
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (let c = 1; c <= clicks; c++) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: c });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: c });
    }
  }
  async function key(k) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k.length === 1 ? undefined : k, text: k.length === 1 ? k : undefined });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k.length === 1 ? undefined : k });
  }
  // Ctrl + wheel at p, eased over `seconds`, multiplying the camera zoom by `factor`. Paced by the clock, not by
  // step count: a busy renderer is slow to take each wheel event, so each step sends whatever is due by then.
  async function wheelZoom(p, factor, seconds) {
    const start = now();
    let done = 0;
    while (done < 1) {
      const s = Math.min(1, (now() - start) / seconds), eased = s * s * (3 - 2 * s);
      if (eased > done) {
        const deltaY = -Math.log(factor) * (eased - done) / UI.wheelZoom;
        done = eased;
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: 0, deltaY, modifiers: 2 });
      }
      if (done < 1) await sleep(30);
    }
    await sleep(250);                               // the camera eases after the last step
  }
  async function click(sel, clicks = 1) {
    const p = await centre(sel);
    if (!p) return false;
    await mouse(p.x, p.y, clicks);
    return true;
  }
  const domClick = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.click(); return !!e; })()`);
  return { send, evaluate, waitFor, mouse, key, click, domClick, wheelZoom };
}

// The visitor that just walked in: its name, its seat, the character at that seat, the rect of that seat's pod
// (null if it cannot be found), its name tag and the floor's viewport. Rects are {x, y, w, h, cx, cy} in viewport
// pixels. The pod is labelled with the seat's character name, so the name comes from the page's own persona module
// (a nickname set in Settings wins there too); the nickname or label is only a fallback if that import fails.
const rectJs = `const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect();
  return r.width ? { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 } : null; };`;
const podJs = (who) => `[...document.querySelectorAll(${JSON.stringify(UI.pod)})].find(p => p.getAttribute("aria-label") === ${who} + "'s desks")`;
const VISITOR = `(async () => { ${rectJs}
  const tag = document.querySelector(${JSON.stringify(UI.walking)});
  if (!tag) return null;
  const name = tag.textContent.trim().replace(/…$/, "");
  let seat = null, who = null;
  try {
    const seats = (await (await fetch("/api/state", { cache: "no-store" })).json()).seats || [];
    const i = seats.findIndex(s => (s.sessions || []).some(x => (x.name || "").replace(/^wt-/, "").startsWith(name)));
    if (i >= 0) {
      seat = seats[i].id;
      who = seats[i].nickname || seats[i].label;
      try { who = (await import(${JSON.stringify(UI.personas)})).personaFor(seats[i], i).name; } catch {}
    }
  } catch {}
  return { name, seat, who, pod: who ? rect(${podJs("who")}) : null, tag: rect(tag), stage: rect(document.querySelector(${JSON.stringify(UI.stage)})) };
})()`;
const TAG_POS = `(() => { ${rectJs} return rect(document.querySelector(${JSON.stringify(UI.walking)})); })()`;
const POD_RECT = (who) => `(() => { ${rectJs} return rect(${podJs(JSON.stringify(who))}); })()`;
const WALKING = `document.querySelectorAll(${JSON.stringify(UI.walking)}).length`;

// Waits until the walker is about `leadS` seconds from `goal`, judging its speed from how its name tag moves.
async function waitForApproach(page, goal, leadS, maxS) {
  const end = now() + maxS;
  let last = null, speed = 0;
  while (now() < end) {
    const p = await page.evaluate(TAG_POS);
    if (!p) return;                                  // already sat down
    const t = now();
    if (last && t > last.t) {
      const v = Math.hypot(p.cx - last.cx, p.cy - last.cy) / (t - last.t);
      speed = speed ? speed * 0.6 + v * 0.4 : v;
    }
    last = { ...p, t };
    const left = Math.abs(goal.cx - p.cx) + Math.abs(goal.cy - p.cy);    // paths run along corridors
    if (speed > 5 && left / speed <= leadS) return;
    await sleep(80);
  }
}

// The point to zoom about so that `goal` ends up in the middle of the stage at zoom z.
function pivotFor(goal, stage, z) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sx = stage.cx, sy = stage.cy;
  return {
    x: clamp((goal.cx * z - sx) / (z - 1), stage.x + 4, stage.x + stage.w - 4),
    y: clamp((goal.cy * z - sy) / (z - 1), stage.y + 4, stage.y + stage.h - 4),
  };
}

// -------------------------------------------------------------------------------------------------- frames
// Chrome pushes a frame whenever the page repaints. Until the visitor shows up only the last few seconds are
// kept in memory; from then on every frame goes to disk with the time it arrived.
function frameRecorder(cdp, page, sessionId, rawDir) {
  let mode = "buffer", n = 0;
  const ring = [], frames = [];
  const store = (t, buf) => {
    const file = join(rawDir, `${String(n++).padStart(6, "0")}.jpg`);
    writeFileSync(file, buf);
    frames.push({ t, file, bytes: buf.length });
  };
  cdp.on((m) => {
    if (m.method !== "Page.screencastFrame" || m.sessionId !== sessionId) return;
    page.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {});
    if (mode === "off") return;
    const t = now(), buf = Buffer.from(m.params.data, "base64");
    if (mode === "record") { store(t, buf); return; }
    ring.push({ t, buf });
    while (ring.length > 2 && ring[0].t < t - SHOT.preroll - 1) ring.shift();
  });
  return {
    start: () => page.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: VW, maxHeight: VH, everyNthFrame: 1 }),
    record() { for (const f of ring.splice(0)) store(f.t, f.buf); mode = "record"; },
    buffer() { mode = "buffer"; },        // back to keeping only the last few seconds in memory
    async stop() { mode = "off"; await page.send("Page.stopScreencast").catch(() => {}); },
    frames,
  };
}

// The page clears its canvas when the camera zoom crosses a resolution step and redraws it a frame later, and
// Chrome sometimes sends that blank frame. It shows up as a JPEG much smaller than the frames on both sides of it.
function dropBlankFrames(frames) {
  const median = (a) => { const s = a.map((f) => f.bytes).sort((x, y) => x - y); return s[s.length >> 1]; };
  const keep = frames.filter((f, i) => {
    const before = frames.slice(Math.max(0, i - 4), i), after = frames.slice(i + 1, i + 5);
    return before.length < 2 || after.length < 2 || f.bytes >= 0.85 * median(before) || f.bytes >= 0.85 * median(after);
  });
  return { keep, dropped: frames.length - keep.length };
}

// Lays the frames on a steady clock: for every output tick, the newest frame that had arrived by then.
// Each segment is {from, to, speed}; speed 2 plays that stretch twice as fast.
function resample(frames, segments, fps, seqDir) {
  let j = 0, k = 0;
  for (const { from, to, speed } of segments) {
    for (let t = from; t < to; t += speed / fps) {
      while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
      const dest = join(seqDir, `${String(k++).padStart(5, "0")}.jpg`);
      try { linkSync(frames[j].file, dest); } catch { copyFileSync(frames[j].file, dest); }
    }
  }
  return k;
}

// ------------------------------------------------------------------------------------------------- encoding
function ffmpeg(args) {
  const r = spawnSync(opt.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.error) throw new Error(`cannot run ${opt.ffmpeg}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg failed:\n${r.stderr}`);
}
const size = (f) => statSync(f).size;
const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;

function h264Encoder() {
  const r = spawnSync(opt.ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (/\blibx264\b/.test(r.stdout || "")) return "libx264";
  if (/\blibopenh264\b/.test(r.stdout || "")) return "libopenh264";
  throw new Error("this ffmpeg has no H.264 encoder (libx264 or libopenh264)");
}

function encodeMp4(seq, out) {
  const enc = h264Encoder();
  const input = ["-framerate", String(FPS), "-i", join(seq, "%05d.jpg")];
  // The frames are full-range JPEGs; browsers expect limited-range 4:2:0.
  const common = ["-an", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=tv,format=yuv420p", "-color_range", "tv", "-movflags", "+faststart"];
  const tries = enc === "libx264"
    ? [20, 23, 26, 29, 32].map((crf) => ["-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", String(crf)])
    : ["4M", "2.5M", "1.5M"].map((b) => ["-c:v", "libopenh264", "-b:v", b]);
  for (const t of tries) {
    ffmpeg([...input, ...t, ...common, out]);
    if (size(out) <= LIMITS.mp4) { log(`mp4: ${t.join(" ")}`); return; }
  }
  console.warn(`! ${out} is ${mb(size(out))}, over the ${mb(LIMITS.mp4)} budget`);
}

function encodeGif(seq, out) {
  // 192 colours with a Bayer dither first. Frames where the camera moves cost the most, and fewer colours and
  // coarser dithering are what shrink them, so the later tries trade those (and then width) for size.
  const tries = [
    { w: 960, gen: "max_colors=192", use: "dither=bayer" },
    { w: 960, gen: "max_colors=160", use: "dither=bayer:bayer_scale=3" },
    { w: 960, gen: "max_colors=128", use: "dither=bayer:bayer_scale=4" },
    { w: 960, gen: "max_colors=128", use: "dither=none" },
    { w: 800, gen: "max_colors=128", use: "dither=none" },
  ];
  for (const t of tries) {
    ffmpeg(["-framerate", String(FPS), "-i", join(seq, "%05d.jpg"),
      "-vf", `fps=12,scale=${t.w}:-1:flags=lanczos,split[a][b];[a]palettegen=${t.gen}[p];[b][p]paletteuse=${t.use}`,
      "-loop", "0", out]);
    if (size(out) <= LIMITS.gif) { log(`gif: ${t.w} px, palettegen=${t.gen}, paletteuse=${t.use}`); return; }
  }
  console.warn(`! ${out} is ${mb(size(out))}, over the ${mb(LIMITS.gif)} budget`);
}

// ----------------------------------------------------------------------------------------------------- main
async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22 || typeof WebSocket !== "function") fail("needs Node 22 or newer (global WebSocket)");
  mkdirSync(opt.out, { recursive: true });
  if (!BASE) BASE = `http://127.0.0.1:${await freePort()}`;
  await ensureServer();

  const work = mkdtempSync(join(tmpdir(), "claude-office-frames-"));
  if (!opt["keep-frames"]) undo.push(() => rmSync(work, { recursive: true, force: true }));
  const rawDir = join(work, "raw"), seqDir = join(work, "seq");
  mkdirSync(rawDir); mkdirSync(seqDir);

  const { chrome, wsUrl } = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);
  undo.push(() => cdp.close());
  const targets = (await cdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "page");
  const targetId = targets.length ? targets[0].targetId : (await cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = pageOf(cdp, sessionId);

  let posterTick = 0;
  try {
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });

    log(`opening ${BASE}/?poll=1`);
    await page.send("Page.navigate", { url: `${BASE}/?poll=1` });
    await page.waitFor(`!!document.querySelector(${JSON.stringify(UI.floorReady)}) && document.readyState === "complete"`, 30, "the floor to render");
    await page.evaluate("document.fonts.ready.then(() => true)");
    const demo = await page.evaluate(`document.querySelector('meta[name="office-demo"]')?.content`);
    if (demo !== "1" && !opt["allow-live"]) {
      throw new Error("the page is not in demo mode, so it would show real seats; use a --demo server or pass --allow-live");
    }
    if (await page.waitFor(`!!document.querySelector(${JSON.stringify(UI.dismissWelcome)})`, 3)) await page.domClick(UI.dismissWelcome);
    await sleep(1500);       // let the first walkers settle and the HUD fill in

    const rec = frameRecorder(cdp, page, sessionId, rawDir);
    await rec.start();
    const park = () => page.mouse(VW - 2, Math.round(VH * 0.12), 0);   // out of the way, over the tab bar
    await park();

    // 0. The level-up. A fresh demo office celebrates its first one about 20 s after it starts; an older one
    // may be past it, and then the cut starts with the walk-in.
    let bannerSeg = null;
    const bannerUp = `!!document.querySelector(${JSON.stringify(UI.banner)})`;
    log(`waiting up to ${SHOT.bannerWait} s for the level-up banner`);
    if (await page.waitFor(bannerUp, SHOT.bannerWait)) {
      const tb = now() - 0.05;
      rec.record();
      await page.waitFor(`!${bannerUp}`, 8);
      await sleep(SHOT.bannerPost * 1000);
      bannerSeg = { from: tb - SHOT.bannerPre, to: now(), speed: 1 };
      rec.buffer();
      log(`level-up banner: ${(bannerSeg.to - tb).toFixed(1)} s`);
    } else log("no level-up banner came; the cut starts with the walk-in");

    // A visitor already on its way may be half-way to its desk; wait for a fresh arrival instead.
    if (await page.evaluate(WALKING)) await page.waitFor(`${WALKING} === 0`, SHOT.maxWalk);
    await sleep(SHOT.preroll * 1000);    // so the pre-roll is full even if one arrives at once
    log(`waiting up to ${WAIT} s for a visitor to walk in`);
    await page.waitFor(`${WALKING} > 0`, WAIT, "a visitor to walk in");
    const t0 = now() - 0.05;
    rec.record();
    const marks = [];
    const mark = (name) => marks.push(`${name} ${(now() - t0).toFixed(1)}`);

    // 1. The whole floor while the visitor crosses it; the camera glides into its pod as it gets close.
    const v = await page.evaluate(VISITOR);
    log(`visitor ${v ? `"${v.name}" heading for ${v.who ? `${v.who}'s desks (${v.seat})` : "a desk"}` : "seen"}`);
    let zoomed = false, pivot = null, zoom = 1, tZoom = now();
    if (v && v.stage) {
      const goal = v.pod || v.tag;
      await waitForApproach(page, goal, SHOT.zoomIn + SHOT.lead, SHOT.maxWalk);
      tZoom = now();
      mark("approach");
      if (v.pod) await page.mouse(goal.cx, goal.cy, 1);           // a click on the pod opens the seat's panel
      zoom = v.pod ? Math.min(3, v.stage.h / (v.pod.h * 1.75), v.stage.w / (v.pod.w * 1.35)) : 2.2;
      pivot = pivotFor(goal, v.stage, zoom);
      await page.wheelZoom(pivot, zoom, SHOT.zoomIn);
      mark("zoomed-in");
      await park();
      const after = v.pod ? await page.evaluate(POD_RECT(v.who)) : null;
      zoomed = !!after && after.w / v.pod.w > 1.3;
    }
    if (!zoomed) {                                    // the wheel did nothing: fall back to the camera controls
      log("the wheel did not zoom; using the camera buttons");
      if (v && v.pod) await page.mouse(v.pod.cx, v.pod.cy, 2);
      else if (!(await page.click(UI.zoomIn))) await page.key("+");
      await park();
    }
    await page.waitFor(`${WALKING} === 0`, SHOT.maxWalk);
    mark("seated");
    await sleep(SHOT.seated * 1000);

    // 2. Back out to the whole floor, with the CEO briefing in the panel again.
    if (zoomed) await page.wheelZoom(pivot, 1 / zoom, SHOT.zoomOut);
    if (!(await page.domClick(UI.fit))) await page.key("0");
    await page.key("Escape");
    mark("zoomed-out");
    await park();
    await sleep(SHOT.overview * 1000);

    // 3. Talk to a task: a click on a worker opens its session's Chat in the panel.
    const chat = `${UI.worker}[aria-label^=${JSON.stringify(CHAT_WITH + ",")}]`;
    if (SHOT.chat && (await page.click(chat))) {
      mark("chat");
      await park();
      await sleep(SHOT.chat * 1000);
      await page.key("Escape");
      await page.evaluate("scrollTo(0, 0), true");   // opening the chat scrolls the page down a little
    } else if (SHOT.chat) log(`no worker for ${CHAT_WITH} on the floor; leaving the Chat out`);

    // 4. The Team view, then the Timeline.
    for (const [name, tab, view, secs] of [["team", UI.teamTab, "board", SHOT.team], ["timeline", UI.timelineTab, "timeline", SHOT.timeline]]) {
      if (!secs) continue;
      if (!(await page.click(tab))) await page.send("Page.navigate", { url: `${BASE}/?poll=1&view=${view}` });
      mark(name);
      await park();
      await sleep(secs * 1000);
    }
    const t1 = now();
    mark("end");
    await rec.stop();

    const got = rec.frames.length, tour = rec.frames.filter((f) => f.t >= t0 - SHOT.preroll), span = t1 - (t0 - SHOT.preroll);
    if (got < 10) throw new Error(`only ${got} frames arrived from Chrome`);
    const lvl = bannerSeg ? rec.frames.filter((f) => f.t <= bannerSeg.to).length : 0;
    log(`captured ${got} frames${lvl ? `, ${lvl} of them during the level-up` : ""} ` +
      `(${(tour.length / Math.max(span, 0.001)).toFixed(1)} fps from Chrome during the tour)`);
    rec.frames.sort((a, b) => a.t - b.t);
    const { keep, dropped } = dropBlankFrames(rec.frames);
    if (dropped) log(`dropped ${dropped} blank frame${dropped > 1 ? "s" : ""} from canvas redraws`);
    const tFast = Math.min(t0 + SHOT.stepOut, tZoom);
    const ticks = resample(keep, [
      ...(bannerSeg ? [bannerSeg] : []),
      { from: Math.max(t0 - SHOT.preroll, rec.frames[0].t), to: tFast, speed: 1 },
      { from: tFast, to: tZoom, speed: SHOT.walkSpeed },
      { from: tZoom, to: t1, speed: 1 },
    ], FPS, seqDir);
    log(`seconds after the visitor appeared: ${marks.join(", ")}`);
    log(`cut ${ticks} frames at ${FPS} fps (${(ticks / FPS).toFixed(1)} s)`);
    if (bannerSeg) posterTick = Math.min(ticks - 1, Math.round((SHOT.bannerPre + SHOT.posterAt) * FPS));
  } finally {
    await page.send("Page.stopScreencast").catch(() => {});
    await cdp.send("Browser.close").catch(() => {});
    await stopGroup(chrome);
  }

  const mp4 = join(opt.out, "demo.mp4"), gif = join(opt.out, "demo.gif"), poster = join(opt.out, "demo-poster.jpg");
  encodeMp4(seqDir, mp4);
  encodeGif(seqDir, gif);
  ffmpeg(["-i", join(seqDir, `${String(posterTick).padStart(5, "0")}.jpg`), "-q:v", "3", poster]);
  if (opt.previews) {
    mkdirSync(opt.previews, { recursive: true });
    for (const f of readdirSync(opt.previews)) if (/^still-\d+\.png$/.test(f)) rmSync(join(opt.previews, f));
    ffmpeg(["-i", mp4, "-vf", "fps=2/3", join(opt.previews, "still-%02d.png")]);
  }

  console.log("\nWrote:");
  for (const f of [mp4, gif, poster]) console.log(`  ${f}  ${mb(size(f))}`);
  if (opt.previews) console.log(`  ${opt.previews}/  ${readdirSync(opt.previews).filter((f) => f.startsWith("still-")).length} PNG stills`);
  if (opt["keep-frames"]) console.log(`  ${work}/  raw and resampled frames (kept)`);
}

main().then(() => process.exit(0), (e) => { console.error(`record_demo: ${e.message}`); process.exit(1); });

// Bug Squash, the lounge's arcade game: 30 seconds of squashing bugs that crawl over a code editor. Green bugs are
// worth 1, fast red ones 3, the rare golden bug 10; blue features cost 5 (don't squash features). Mouse, touch or
// keyboard (arrows move the crosshair, space squashes, P pauses). The Daily run spawns the same bugs, in the same
// places, for everyone all day (seeded by the date); free play is random. The best score, and each day's best Daily
// run for 30 days, live in this browser; beating the best brings a gift, once a day.
import { $ } from "./util.js";
import { icon } from "./icons.js";
import { sound } from "./sound.js";
import { localDay } from "./goals.js";

const GW = 160, GH = 104, ROUND = 30;           // the game's own pixels, and seconds per round
export const KINDS = {
  bug: { pts: 1, speed: 16, life: 9, color: "#4fc36a", dark: "#2f8a48" },
  red: { pts: 3, speed: 34, life: 6, color: "#e8475a", dark: "#a32a3a" },
  gold: { pts: 10, speed: 46, life: 3.2, color: "#ffcf3a", dark: "#d99a1a" },
  feature: { pts: -5, speed: 10, life: 5, color: "#4f9cf0", dark: "#2a4f7a" },
};

// What spawns next, from a roll in [0, 1) and the seconds played (more red bugs and features as the round goes on).
export function spawnKind(roll, t) {
  const red = 0.18 + Math.min(0.17, t / 120), gold = 0.04, feature = 0.1 + Math.min(0.08, t / 200);
  if (roll < gold) return "gold";
  if (roll < gold + feature) return "feature";
  if (roll < gold + feature + red) return "red";
  return "bug";
}
// Seconds between spawns: quicker as the round goes on.
export const spawnGap = (t) => Math.max(0.28, 0.85 - t * 0.02);

// A small seeded random source (mulberry32), and a day's seed from its date: the Daily run's spawns.
export function seeded(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export const daySeed = (day) => [...String(day)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
// The Daily runs kept: {day: best}, the last 30 days; and the run of days in a row with one, up to today.
export function keepDays(days, day, score) {
  const out = { ...days, [day]: Math.max(days[day] || 0, score) };
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a < b ? -1 : 1).slice(-30));
}
export function dailyStreak(days, today) {
  let n = 0;
  for (let d = new Date(today + "T12:00:00"); days[localDay(d)] != null; d.setDate(d.getDate() - 1)) n++;
  return n;
}

export function makeArcade(ctx) {
  const { store, onBest, onDaily } = ctx;
  let raf = 0;
  const today = () => store.get("squashDays", {})[localDay()] ?? null;

  // The last 14 days' Daily runs as little bars, today's lit, and the days in a row.
  function historyHtml() {
    const days = store.get("squashDays", {}), now = new Date(), cells = [];
    for (let i = 13; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); const k = localDay(d); cells.push([k, days[k]]); }
    const top = Math.max(10, ...cells.map(([, v]) => v || 0)), streak = dailyStreak(days, localDay());
    if (!cells.some(([, v]) => v != null)) return "";
    return `<div class="arc-days" aria-label="Daily runs, the last 14 days">${cells.map(([k, v], i) => `<i class="${i === 13 ? "today" : ""}" style="height:${v == null ? 2 : 4 + Math.round(v / top * 22)}px" title="${k}: ${v == null ? "no run" : v}"></i>`).join("")}</div>
      <p class="arc-streak">${streak > 1 ? `${streak} days in a row` : "Play the Daily run each day for a streak"}</p>`;
  }
  function open() {
    const d = $("dialog");
    d.classList.add("arcade");
    const best = store.get("squashBest", 0);
    $("dialogBody").innerHTML = `<div class="arc">
      <div class="arc-h"><b>Bug Squash</b><span class="arc-best">Best ${best}${today() != null ? ` · today's Daily ${today()}` : ""}</span><button class="btn sm ghost" data-arc-pause aria-label="Pause" title="Pause (P)" hidden>${icon("pause", 16)}</button><button class="btn sm ghost" data-arc-close aria-label="Close">${icon("x", 16)}</button></div>
      <div class="arc-screen"><canvas width="${GW}" height="${GH}" tabindex="0" aria-label="Bug Squash: squash bugs, not features. Arrows move, space squashes."></canvas>
        <div class="arc-over"><div class="arc-title">BUG SQUASH</div><p>Squash the bugs before they ship. <b class="g">Green 1</b> · <b class="r">Red 3</b> · <b class="y">Gold 10</b><br>Don't squash the <b class="b">features</b> (−5).</p>
          <div class="row" style="gap:8px;justify-content:center"><button class="btn primary" data-arc-start="daily">${icon("calendar", 15)}Daily run</button><button class="btn" data-arc-start>${icon("play", 15)}Free play</button></div>${historyHtml()}</div></div>
      <div class="arc-hud"><span>Score <b data-arc-score>0</b></span><span>Time <b data-arc-time>${ROUND}</b></span><span class="muted">Click or tap a bug · arrows + space · P pauses</span></div></div>`;
    const cv = d.querySelector("canvas"), g = cv.getContext("2d"), over = d.querySelector(".arc-over");
    g.imageSmoothingEnabled = false;
    const st = { on: false, t: 0, score: 0, bugs: [], splats: [], pops: [], next: 0, cx: GW / 2, cy: GH / 2, keys: new Set(), last: 0 };
    const code = Array.from({ length: 14 }, (_, i) => ({ indent: (i * 7) % 4, parts: Array.from({ length: 2 + (i * 5) % 4 }, (_, k) => ({ w: 6 + ((i * 13 + k * 7) % 22), c: ["#c678dd", "#56b6c2", "#e5c07b", "#98c379", "#7f848e"][(i + k) % 5] })) }));

    function start(daily) {
      const day = localDay();                         // a run started before midnight counts for the day it began
      Object.assign(st, { on: true, t: 0, score: 0, bugs: [], splats: [], pops: [], next: 0.4, last: performance.now(), t0: performance.now(),
                          daily: !!daily, day, rng: daily ? seeded(daySeed(day)) : Math.random, paused: null });   // the Daily run: today's bugs
      over.hidden = true; cv.focus(); pauseBtn.hidden = false;
      cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
    }
    function pause() {                                   // the clock stops; the bugs freeze where they are
      if (!st.on) return;
      if (st.paused == null) { st.paused = performance.now(); over.innerHTML = `<div class="arc-title">PAUSED</div><p>P or the button to go on.</p>`; over.hidden = false; }
      else { st.t0 += performance.now() - st.paused; st.paused = null; st.last = performance.now(); over.hidden = true; cv.focus(); raf = requestAnimationFrame(loop); }
    }
    const pauseBtn = d.querySelector("[data-arc-pause]");
    pauseBtn.addEventListener("click", pause);
    const bindStarts = (root) => root.querySelectorAll("[data-arc-start]").forEach(b => b.addEventListener("click", () => start(b.dataset.arcStart === "daily")));
    function finish() {
      st.on = false; pauseBtn.hidden = true;
      const prev = store.get("squashBest", 0), best = Math.max(prev, st.score);
      store.set("squashBest", best);
      const dayPrev = (store.get("squashDays", {}) || {})[st.day] ?? null;
      if (st.daily) { store.set("squashDays", keepDays(store.get("squashDays", {}), st.day, st.score)); if (onDaily) onDaily(today()); }
      d.querySelector(".arc-best").textContent = `Best ${best}${today() != null ? ` · today's Daily ${today()}` : ""}`;
      const fresh = st.score > prev && st.score > 0;
      let gift = false;
      if (fresh && store.get("squashGiftDay", "") !== localDay()) { store.set("squashGiftDay", localDay()); gift = onBest(st.score); }
      sound.play(fresh ? "levelup" : "report");
      const dayBest = st.daily && st.score > (dayPrev ?? -1);
      over.innerHTML = `<div class="arc-title">${fresh ? "NEW BEST!" : dayBest ? "TODAY'S BEST!" : "TIME!"}</div><p>You scored <b>${st.score}</b> point${st.score === 1 ? "" : "s"}${st.daily ? " on today's Daily run" : ""}.${fresh && prev ? ` Your old best was ${prev}.` : ""}${gift ? `<br><b class="y">A gift is waiting ${gift.mail ? "in the mailroom" : "on the floor"}.</b>` : ""}</p>
        <div class="row" style="gap:8px;justify-content:center"><button class="btn ${st.daily ? "primary" : ""}" data-arc-start="daily">${icon("calendar", 15)}Daily run</button><button class="btn ${st.daily ? "" : "primary"}" data-arc-start>${icon("play", 15)}Free play</button></div>${historyHtml()}`;
      over.hidden = false;
      bindStarts(over);
      over.querySelector(st.daily ? "[data-arc-start=daily]" : "[data-arc-start]:not([data-arc-start=daily])").focus();
    }
    function squash(x, y) {
      if (!st.on || st.paused != null) return;
      let hit = null;
      for (const b of st.bugs) if (!b.dead && Math.abs(b.x - x) <= 5 && Math.abs(b.y - y) <= 5) { hit = b; break; }
      if (!hit) { st.splats.push({ x, y, life: 0.25, miss: true }); return; }
      hit.dead = true;
      const k = KINDS[hit.kind];
      st.score = Math.max(0, st.score + k.pts);
      st.splats.push({ x: hit.x, y: hit.y, life: 1.2, color: k.dark });
      st.pops.push({ x: hit.x, y: hit.y - 4, text: (k.pts > 0 ? "+" : "") + k.pts, life: 0.9, bad: k.pts < 0 });
      sound.play(hit.kind === "feature" ? "bad" : hit.kind === "gold" ? "achievement" : "click");
      d.querySelector("[data-arc-score]").textContent = st.score;
    }
    function loop(now) {
      const dt = Math.min(0.05, (now - st.last) / 1000); st.last = now;
      if (st.on && st.paused != null) return;          // paused: no frames until it goes on
      if (st.on) {
        st.t = (now - st.t0) / 1000;                     // the clock is real time, however slow the frames
        if (st.t >= ROUND) { d.querySelector("[data-arc-time]").textContent = 0; draw(); finish(); return; }
        st.next -= dt;
        if (st.next <= 0) {                              // four draws a spawn, so the Daily run's spawns never drift
          const kind = spawnKind(st.rng(), st.t), a = st.rng() * Math.PI * 2, k = KINDS[kind];
          st.bugs.push({ kind, x: 8 + st.rng() * (GW - 16), y: 10 + st.rng() * (GH - 18), vx: Math.cos(a) * k.speed, vy: Math.sin(a) * k.speed, age: 0 });
          st.next = spawnGap(st.t);
        }
        for (const b of st.bugs) {
          b.age += dt;
          if (Math.random() < dt * 0.8) { const a = Math.atan2(b.vy, b.vx) + (Math.random() - 0.5) * 1.6, sp = Math.hypot(b.vx, b.vy); b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp; }
          b.x += b.vx * dt; b.y += b.vy * dt;
          if (b.x < 4 || b.x > GW - 4) b.vx *= -1;
          if (b.y < 8 || b.y > GH - 4) b.vy *= -1;
          b.x = Math.max(4, Math.min(GW - 4, b.x)); b.y = Math.max(8, Math.min(GH - 4, b.y));
        }
        st.bugs = st.bugs.filter(b => !b.dead && b.age < KINDS[b.kind].life);
        const sp = 70 * dt;
        if (st.keys.has("ArrowLeft")) st.cx -= sp; if (st.keys.has("ArrowRight")) st.cx += sp;
        if (st.keys.has("ArrowUp")) st.cy -= sp; if (st.keys.has("ArrowDown")) st.cy += sp;
        st.cx = Math.max(2, Math.min(GW - 2, st.cx)); st.cy = Math.max(2, Math.min(GH - 2, st.cy));
        d.querySelector("[data-arc-time]").textContent = Math.ceil(ROUND - st.t);
      }
      for (const s of st.splats) s.life -= dt;
      for (const p of st.pops) { p.life -= dt; p.y -= dt * 10; }
      st.splats = st.splats.filter(s => s.life > 0); st.pops = st.pops.filter(p => p.life > 0);
      draw();
      if (st.on || st.splats.length || st.pops.length) raf = requestAnimationFrame(loop);
    }
    const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
    function drawBug(b) {
      const k = KINDS[b.kind], x = Math.round(b.x), y = Math.round(b.y), leg = Math.floor(b.age * 10) % 2;
      if (b.kind === "feature") {                       // a blue gift-like "feature" with a sparkle
        R(x - 3, y - 2, 7, 5, k.color); R(x - 3, y - 2, 7, 1, "#9cc9ff"); R(x, y - 2, 1, 5, "#ffffff"); R(x - 1, y - 4, 3, 2, "#ffffff");
        if (Math.floor(b.age * 6) % 2) R(x + 4, y - 4, 1, 1, "#ffffff");
        return;
      }
      const L = "#aab0c4";                                // a 7×7 beetle: antennae, head, a spotted shell and six legs
      R(x - 2, y - 4, 1, 1, L); R(x + 2, y - 4, 1, 1, L);
      R(x - 1, y - 3, 3, 1, k.dark);
      R(x - 2, y - 2, 5, 5, k.color); R(x - 1, y + 3, 3, 1, k.color); R(x, y - 2, 1, 5, k.dark);
      R(x - 1, y - 1, 1, 1, k.dark); R(x + 1, y + 1, 1, 1, k.dark);
      for (let i = 0; i < 3; i++) { const o = (i + leg) % 2; R(x - 3 - o, y - 1 + i * 2, 1, 1, L); R(x + 3 + o, y - 1 + i * 2, 1, 1, L); }
      if (b.kind === "gold" && Math.floor(b.age * 8) % 2) R(x + 2, y - 2, 1, 1, "#ffffff");
    }
    function draw() {
      R(0, 0, GW, GH, "#1e2130"); R(0, 0, GW, 6, "#2a2e42"); R(3, 2, 2, 2, "#ff5f57"); R(7, 2, 2, 2, "#febc2e"); R(11, 2, 2, 2, "#28c840");
      code.forEach((ln, i) => { R(2, 9 + i * 7, 6, 2, "#3b4058"); let x = 12 + ln.indent * 5; ln.parts.forEach(p => { R(x, 9 + i * 7, p.w, 2, p.c); x += p.w + 3; }); });
      for (const s of st.splats) { g.globalAlpha = Math.min(1, s.life * 2); if (s.miss) R(s.x - 1, s.y - 1, 3, 3, "#ffffff"); else { R(s.x - 3, s.y - 1, 7, 3, s.color); R(s.x - 1, s.y - 3, 3, 7, s.color); } g.globalAlpha = 1; }
      st.bugs.forEach(drawBug);
      g.font = "6px monospace"; g.textAlign = "center";
      for (const p of st.pops) { g.globalAlpha = Math.min(1, p.life * 2); g.fillStyle = p.bad ? "#ff6b6b" : "#ffffff"; g.fillText(p.text, p.x, p.y); g.globalAlpha = 1; }
      if (st.on) { R(st.cx - 4, st.cy, 3, 1, "#ffffff"); R(st.cx + 2, st.cy, 3, 1, "#ffffff"); R(st.cx, st.cy - 4, 1, 3, "#ffffff"); R(st.cx, st.cy + 2, 1, 3, "#ffffff"); }
      const f = st.on ? 1 - st.t / ROUND : 1; R(0, GH - 1, GW * f, 1, f < 0.2 ? "#ff5f57" : "#ff7a45");
    }
    const at = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * GW, (e.clientY - r.top) / r.height * GH]; };
    cv.addEventListener("pointerdown", (e) => { e.preventDefault(); const [x, y] = at(e); st.cx = x; st.cy = y; squash(x, y); });
    const keydown = (e) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) && st.on) { e.preventDefault(); st.keys.add(e.key); }
      else if (e.key === " " && st.on && st.paused == null) { e.preventDefault(); squash(st.cx, st.cy); }
      else if ((e.key === "p" || e.key === "P") && st.on) { e.preventDefault(); pause(); }
    };
    const keyup = (e) => st.keys.delete(e.key);
    d.addEventListener("keydown", keydown); d.addEventListener("keyup", keyup);
    bindStarts(d);
    d.querySelector("[data-arc-close]").addEventListener("click", () => d.close());
    d.addEventListener("close", () => { cancelAnimationFrame(raf); st.on = false; d.removeEventListener("keydown", keydown); d.removeEventListener("keyup", keyup); d.classList.remove("arcade"); }, { once: true });
    draw();
    d.showModal();
    d.querySelector("[data-arc-start]").focus();
  }
  return { open };
}

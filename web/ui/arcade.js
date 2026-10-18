// Bug Squash, the lounge's arcade game: 30 seconds of squashing bugs that crawl over a code editor. Green bugs are
// worth 1, fast red ones 3, the rare golden bug 10; blue features cost 5 (don't squash features). Mouse, touch or
// keyboard (arrows move the crosshair, space squashes). The best score lives in this browser; beating it brings a
// gift, once a day.
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

export function makeArcade(ctx) {
  const { store, onBest } = ctx;
  let raf = 0;

  function open() {
    const d = $("dialog");
    d.classList.add("arcade");
    const best = store.get("squashBest", 0);
    $("dialogBody").innerHTML = `<div class="arc">
      <div class="arc-h"><b>Bug Squash</b><span class="arc-best">Best ${best}</span><button class="btn sm ghost" data-arc-close aria-label="Close">${icon("x", 16)}</button></div>
      <div class="arc-screen"><canvas width="${GW}" height="${GH}" tabindex="0" aria-label="Bug Squash: squash bugs, not features. Arrows move, space squashes."></canvas>
        <div class="arc-over"><div class="arc-title">BUG SQUASH</div><p>Squash the bugs before they ship. <b class="g">Green 1</b> · <b class="r">Red 3</b> · <b class="y">Gold 10</b><br>Don't squash the <b class="b">features</b> (−5).</p>
          <button class="btn primary" data-arc-start>${icon("play", 15)}Start · 30 s</button></div></div>
      <div class="arc-hud"><span>Score <b data-arc-score>0</b></span><span>Time <b data-arc-time>${ROUND}</b></span><span class="muted">Click or tap a bug · arrows + space</span></div></div>`;
    const cv = d.querySelector("canvas"), g = cv.getContext("2d"), over = d.querySelector(".arc-over");
    g.imageSmoothingEnabled = false;
    const st = { on: false, t: 0, score: 0, bugs: [], splats: [], pops: [], next: 0, cx: GW / 2, cy: GH / 2, keys: new Set(), last: 0 };
    const code = Array.from({ length: 14 }, (_, i) => ({ indent: (i * 7) % 4, parts: Array.from({ length: 2 + (i * 5) % 4 }, (_, k) => ({ w: 6 + ((i * 13 + k * 7) % 22), c: ["#c678dd", "#56b6c2", "#e5c07b", "#98c379", "#7f848e"][(i + k) % 5] })) }));

    function start() {
      Object.assign(st, { on: true, t: 0, score: 0, bugs: [], splats: [], pops: [], next: 0.4, last: performance.now() });
      over.hidden = true; cv.focus();
      cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
    }
    function finish() {
      st.on = false;
      const prev = store.get("squashBest", 0), best = Math.max(prev, st.score);
      store.set("squashBest", best);
      d.querySelector(".arc-best").textContent = `Best ${best}`;
      const fresh = st.score > prev && st.score > 0;
      let gift = false;
      if (fresh && store.get("squashGiftDay", "") !== localDay()) { store.set("squashGiftDay", localDay()); gift = onBest(st.score); }
      sound.play(fresh ? "levelup" : "report");
      over.innerHTML = `<div class="arc-title">${fresh ? "NEW BEST!" : "TIME!"}</div><p>You scored <b>${st.score}</b> point${st.score === 1 ? "" : "s"}.${fresh && prev ? ` Your old best was ${prev}.` : ""}${gift ? "<br><b class=\"y\">A gift is waiting on the floor.</b>" : ""}</p>
        <button class="btn primary" data-arc-start>${icon("play", 15)}Play again</button>`;
      over.hidden = false;
      over.querySelector("[data-arc-start]").addEventListener("click", start);
      over.querySelector("[data-arc-start]").focus();
    }
    function squash(x, y) {
      if (!st.on) return;
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
      if (st.on) {
        st.t += dt;
        if (st.t >= ROUND) { draw(); finish(); return; }
        st.next -= dt;
        if (st.next <= 0) {
          const kind = spawnKind(Math.random(), st.t), a = Math.random() * Math.PI * 2, k = KINDS[kind];
          st.bugs.push({ kind, x: 8 + Math.random() * (GW - 16), y: 10 + Math.random() * (GH - 18), vx: Math.cos(a) * k.speed, vy: Math.sin(a) * k.speed, age: 0 });
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
      else if (e.key === " " && st.on) { e.preventDefault(); squash(st.cx, st.cy); }
    };
    const keyup = (e) => st.keys.delete(e.key);
    d.addEventListener("keydown", keydown); d.addEventListener("keyup", keyup);
    d.querySelector("[data-arc-start]").addEventListener("click", start);
    d.querySelector("[data-arc-close]").addEventListener("click", () => d.close());
    d.addEventListener("close", () => { cancelAnimationFrame(raf); st.on = false; d.removeEventListener("keydown", keydown); d.removeEventListener("keyup", keyup); d.classList.remove("arcade"); }, { once: true });
    draw();
    d.showModal();
    d.querySelector("[data-arc-start]").focus();
  }
  return { open };
}

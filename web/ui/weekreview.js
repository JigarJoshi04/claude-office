// "Your week": the last seven days as a short story, one big number at a time (reports, agent hours, the star of the
// week, what you collected), then a picture to keep. It plays itself on the first visit of a Monday and from the menu,
// the palette or the week chart. weekSummary() is the pure part; the rest is the dialog and the picture.
import { $, esc, avatar, hydratePortraits, portrait } from "./util.js";
import { icon } from "./icons.js";
import { localDay } from "./goals.js";
import { BADGES } from "./badges.js";
import { STICKERS, stickerCanvas } from "../engine/stickers.js";
import { fit, roundRect } from "./daycard.js";

// days: the last 14 days from /api/week, oldest first. album: sticker id -> {n, first}; badges: id -> earned at (s);
// goalDays: days on which every goal was done. Everything is counted over the last seven days.
// end: the last day to count (default: the last in days). On a Monday the review tells last week, ending yesterday.
export function weekSummary(days, { album = {}, badges = {}, goalDays = [], end = null } = {}) {
  if (end && days) days = days.filter(d => d.day <= end);
  if (!days || days.length < 7) return null;
  const last = days.slice(-7), before = days.slice(-14, -7);
  const sum = (xs, f) => xs.reduce((a, d) => a + f(d), 0);
  const from = last[0].day, to = last[6].day;
  const t0 = new Date(from + "T00:00:00").getTime() / 1000, t1 = new Date(to + "T00:00:00").getTime() / 1000 + 86400;
  const reports = sum(last, d => d.reports), prev = before.length === 7 ? sum(before, d => d.reports) : null;
  const best = [...last].sort((a, b) => b.reports - a.reports || b.active_min - a.active_min)[0];
  const stars = {}; for (const d of last) if (d.mvp) stars[d.mvp] = (stars[d.mvp] || 0) + 1;
  const top = Math.max(0, ...Object.values(stars));
  // The week's awards: who led on hours, reports, tool calls and fresh tokens (a lead of nothing is no award).
  const per = {};
  for (const d of last) for (const [id, v] of Object.entries(d.per_seat || {})) { const e = per[id] || (per[id] = [0, 0, 0, 0]); v.forEach((x, i) => { e[i] += x || 0; }); }
  const awards = AWARDS.map(([key, i]) => {             // a lead shared by two is no one's award
    const [first, second] = Object.entries(per).sort((a, b) => b[1][i] - a[1][i]);
    return first && first[1][i] > 0 && !(second && second[1][i] === first[1][i]) ? { key, seat: first[0], value: first[1][i] } : null;
  }).filter(Boolean);
  return {
    awards,
    from, to, reports, prev,
    delta: prev ? Math.round((reports - prev) / prev * 100) : null,
    hours: sum(last, d => d.active_min) / 60,
    calls: sum(last, d => d.tool_calls),
    sessions: sum(last, d => d.sessions),
    activeDays: last.filter(d => d.sessions || d.reports).length,
    best: best && best.reports ? best : null,
    stars: top ? Object.keys(stars).filter(id => stars[id] === top) : [], starDays: top,
    stickers: Object.entries(album).filter(([, x]) => x.first >= t0 && x.first < t1).map(([id]) => id),
    badges: Object.entries(badges).filter(([, at]) => at >= t0 && at < t1).map(([id]) => id),
    goalDays: goalDays.filter(d => d >= from && d <= to).length,
    empty: !last.some(d => d.sessions || d.reports || d.tool_calls),
  };
}

// [key, index in a day's per_seat row, title, the number in words]
const AWARDS = [["hours", 0, "The long haul", (v) => `${(v / 60).toFixed(v >= 600 ? 0 : 1)} hours at work`],
  ["reports", 1, "The closer", (v) => `${v} report${v === 1 ? "" : "s"} filed`],
  ["calls", 2, "Busy hands", (v) => `${v.toLocaleString()} tool calls`],
  ["tokens", 3, "The furnace", (v) => `${v >= 1e9 ? (v / 1e9).toFixed(1) + " B" : v >= 1e6 ? (v / 1e6).toFixed(1) + " M" : Math.round(v / 1e3) + " k"} fresh tokens`]];
const SLIDE_MS = 5500;
const fmtH = (h) => (h >= 10 ? Math.round(h).toLocaleString() : h.toFixed(1));
const dayName = (d, o = { weekday: "long" }) => new Date(d + "T12:00:00").toLocaleDateString([], o);

export function makeWeekReview(ctx) {
  const { app, panels, store, DEMO, prefs, gifts, earned, toast } = ctx;
  const persona = (s) => panels.persona(s);

  function summary() {
    // On a Monday the story is last week, Monday to Sunday (as the weekly challenge counts it); other days, the last seven.
    const d = new Date(); d.setDate(d.getDate() - 1);
    const end = new Date().getDay() === 1 ? localDay(d) : null;
    return weekSummary(app.weekCache(), { album: gifts.album(), badges: DEMO ? {} : earned(), goalDays: store.get("goalDays", []), end });
  }

  function slides(w) {
    const snap = app.snap(), seat = (id) => snap.seats.find(s => s.id === id);
    const range = `${dayName(w.from, { day: "numeric", month: "short" })} – ${dayName(w.to, { day: "numeric", month: "short" })}`;
    const out = [];
    out.push({ k: "intro", html: `<div class="wr-eyebrow">Your week</div><h2 class="wr-title">${esc(snap.office.name || "Claude Office")}</h2>
      <p class="wr-sub">${esc(range)}</p><div class="wr-team">${snap.seats.slice(0, 8).map(s => avatar("mascot-" + s.id, s.color, s.career ? "lv" + s.career.level : "")).join("")}</div>
      <p class="wr-hint">${w.empty ? "A quiet week. Here is what there is." : `${w.activeDays} day${w.activeDays === 1 ? "" : "s"} with work, ${w.sessions.toLocaleString()} sessions.`}</p>` });
    out.push({ k: "reports", html: `<div class="wr-eyebrow">Reports filed</div><div class="wr-big" data-count="${w.reports}">${w.reports}</div>
      <p class="wr-sub">${w.delta == null ? "Your first week on record." : w.delta >= 0 ? `<b class="up">▲ ${w.delta}%</b> on the week before (${w.prev}).` : `<b class="down">▼ ${-w.delta}%</b> on the week before (${w.prev}).`}</p>
      ${w.best ? `<p class="wr-hint">Best day: <b>${esc(dayName(w.best.day))}</b>, with ${w.best.reports} report${w.best.reports === 1 ? "" : "s"}.</p>` : ""}` });
    out.push({ k: "hours", html: `<div class="wr-eyebrow">Agent work</div><div class="wr-big"><span data-count="${w.hours}" data-dec="${w.hours < 10 ? 1 : 0}">${fmtH(w.hours)}</span><small> h</small></div>
      <p class="wr-sub">That is ${(w.hours / 8).toFixed(1)} working days for one person.</p><p class="wr-hint">${w.calls.toLocaleString()} tool calls along the way.</p>` });
    const stars = w.stars.map(seat).filter(Boolean);
    if (stars.length) out.push({ k: "star", html: `<div class="wr-eyebrow">${stars.length > 1 ? "Stars of the week" : "Star of the week"}</div>
      <div class="wr-stars">${stars.slice(0, 3).map(s => `<div class="wr-star" style="--seat:${esc(s.color)}">${avatar("mascot-" + s.id, s.color, "crown")}<b>${esc(persona(s).name)}</b></div>`).join("")}</div>
      <p class="wr-sub">${w.starDays} day${w.starDays === 1 ? "" : "s"} as employee of the day.</p>` });
    const won = (w.awards || []).map(a => ({ ...a, s: seat(a.seat) })).filter(a => a.s);
    const bySeat = [];                                    // one card a character, with every award it took
    for (const a of won) { const g = bySeat.find(x => x.s.id === a.s.id); if (g) g.list.push(a); else bySeat.push({ s: a.s, list: [a] }); }
    const sweep = bySeat.length === 1 && won.length === AWARDS.length;   // every award, none shared, none to someone who left
    if (won.length >= 2) out.push({ k: "awards", html: `<div class="wr-eyebrow">${sweep ? "A clean sweep" : "The week's awards"}</div>
      <div class="wr-awards ${bySeat.length === 1 ? "one" : ""}">${bySeat.map(g => `<div class="wr-award" style="--seat:${esc(g.s.color)}">${avatar("mascot-" + g.s.id, g.s.color, sweep ? "crown" : "")}<span><b>${esc(persona(g.s).name)}</b>
        ${g.list.map(a => { const [, , title, words] = AWARDS.find(x => x[0] === a.key); return `<small><em>${esc(title)}</em> ${esc(words(a.value))}</small>`; }).join("")}</span></div>`).join("")}</div>` });
    const st = w.stickers.map(id => STICKERS.find(s => s.id === id)).filter(Boolean), bs = w.badges.map(id => BADGES.find(b => b.id === id)).filter(Boolean);
    out.push({ k: "collection", html: `<div class="wr-eyebrow">Your collection</div>
      <div class="wr-tiles"><div><b data-count="${st.length}">${st.length}</b><span>new sticker${st.length === 1 ? "" : "s"}</span></div>
        <div><b data-count="${bs.length}">${bs.length}</b><span>badge${bs.length === 1 ? "" : "s"}</span></div>
        <div><b data-count="${w.goalDays}">${w.goalDays}</b><span>day${w.goalDays === 1 ? "" : "s"} with every goal</span></div></div>
      ${st.length ? `<div class="wr-stickers">${st.slice(0, 6).map(s => `<i data-sticker="${esc(s.id)}|4|"></i>`).join("")}</div>` : ""}
      ${bs.length ? `<p class="wr-hint">${bs.slice(0, 4).map(b => `${icon(b.icon, 14)} ${esc(b.name)}`).join(" · ")}</p>` : `<p class="wr-hint">Open gifts from your agents to fill the album.</p>`}` });
    out.push({ k: "outro", html: `<div class="wr-eyebrow">That's the week</div><h2 class="wr-title">See you next week.</h2>
      <p class="wr-sub">Keep a picture of it, or post it for the team.</p>
      <div class="wr-act"><button class="btn primary" data-wr-save>${icon("download", 15)}Save the picture</button><button class="btn" data-wr-copy>${icon("copy", 15)}Copy</button><button class="btn ghost" data-wr-done>Done</button></div>` });
    return out;
  }

  // The count-up on big numbers.
  function countUp(root) {
    root.querySelectorAll("[data-count]").forEach(el => {
      const to = +el.dataset.count, dec = +(el.dataset.dec || 0), fmt = (v) => dec ? v.toFixed(dec) : Math.round(v).toLocaleString();
      if (prefs.motion === "reduced" || !to) { el.textContent = fmt(to); return; }
      const t0 = performance.now(), dur = 900;
      const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(to * e); if (k < 1 && el.isConnected) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }

  function play() {
    const w = summary();
    if (!w) { toast("The week needs a few more days on record. Try again soon.", "info"); app.weekCache(); return false; }
    const list = slides(w), d = $("dialog");
    let i = 0, timer = 0, startedAt = 0, paused = false, left = SLIDE_MS;
    d.classList.add("week-review");
    $("dialogBody").innerHTML = `<div class="wr" role="group" aria-roledescription="story" aria-label="Your week. Arrows move between slides, Space pauses." tabindex="-1">
      <div class="wr-bars">${list.map(() => `<i><b></b></i>`).join("")}</div>
      <button class="btn sm ghost wr-x" data-wr-close aria-label="Close">${icon("x", 16)}</button>
      <div class="wr-stage" aria-live="polite"></div>
      <button class="wr-tap prev" data-wr-prev aria-label="Previous" tabindex="-1"></button><button class="wr-tap next" data-wr-next aria-label="Next" tabindex="-1"></button></div>`;
    const stage = d.querySelector(".wr-stage"), bars = [...d.querySelectorAll(".wr-bars b")];
    const show = (n) => {
      i = Math.max(0, Math.min(list.length - 1, n));
      paused = false; left = SLIDE_MS;
      stage.innerHTML = `<div class="wr-slide k-${list[i].k}">${list[i].html}</div>`;
      hydratePortraits(stage, 6);
      stage.querySelectorAll("i[data-sticker]").forEach(el => { const st = STICKERS.find(s => s.id === el.dataset.sticker.split("|")[0]); if (st) el.replaceWith(stickerCanvas(st, 4, { t: 900 })); });
      countUp(stage);
      bars.forEach((b, k) => { b.style.transition = "none"; b.style.width = k < i ? "100%" : "0%"; });
      bind();
      clearTimeout(timer);
      if (prefs.motion !== "reduced" && i < list.length - 1) {
        startedAt = performance.now();
        requestAnimationFrame(() => { bars[i].style.transition = `width ${SLIDE_MS}ms linear`; bars[i].style.width = "100%"; });
        timer = setTimeout(() => show(i + 1), SLIDE_MS);
      } else bars[i].style.width = "100%";
    };
    // Resume the paused slide where it stopped, not from the start.
    const resume = () => {
      if (prefs.motion === "reduced" || i >= list.length - 1) return;
      startedAt = performance.now() - (SLIDE_MS - left);
      requestAnimationFrame(() => { bars[i].style.transition = `width ${left}ms linear`; bars[i].style.width = "100%"; });
      timer = setTimeout(() => show(i + 1), left);
    };
    const bind = () => {
      const q = (s) => stage.querySelector(s);
      if (q("[data-wr-done]")) q("[data-wr-done]").addEventListener("click", () => d.close());
      if (q("[data-wr-save]")) q("[data-wr-save]").addEventListener("click", () => picture(w).then(c => { const a = document.createElement("a"); a.download = `week-${w.to}.png`; a.href = c.toDataURL("image/png"); a.click(); }));
      if (q("[data-wr-copy]")) q("[data-wr-copy]").addEventListener("click", () => picture(w).then(c => c.toBlob(b => {
        if (!b || !navigator.clipboard || !window.ClipboardItem) { toast("Copying pictures is not supported here: use Save.", "info"); return; }
        navigator.clipboard.write([new ClipboardItem({ "image/png": b })]).then(() => toast("The week is on the clipboard.", "good"), () => toast("Could not copy: use Save.", "warn"));
      })));
      const act = q(".wr-act .btn"); if (act) act.focus({ preventScroll: true });
    };
    d.querySelector("[data-wr-close]").addEventListener("click", () => d.close());
    d.querySelector("[data-wr-prev]").addEventListener("click", () => show(i - 1));
    d.querySelector("[data-wr-next]").addEventListener("click", () => (i < list.length - 1 ? show(i + 1) : d.close()));
    const keys = (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); show(i + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); show(i - 1); }
      else if (e.key === " " && !(e.target instanceof HTMLButtonElement && e.target.closest(".wr-act, .wr-x"))) {   // Space pauses and resumes
        e.preventDefault(); paused = !paused;
        if (paused) { clearTimeout(timer); left = Math.max(0, SLIDE_MS - (performance.now() - startedAt)); const b = bars[i], wpx = getComputedStyle(b).width; b.style.transition = "none"; b.style.width = wpx; }
        else resume();
      }
    };
    d.addEventListener("keydown", keys);
    d.addEventListener("close", () => { clearTimeout(timer); d.removeEventListener("keydown", keys); d.classList.remove("week-review"); }, { once: true });
    d.showModal();
    show(0);
    d.querySelector(".wr").focus({ preventScroll: true });
    if (!DEMO) store.set("weekShown", localDay());
    return true;
  }

  // The first visit of a Monday plays last week (once), when there is a week to show and nothing else is open.
  function maybeMonday(tries = 0) {
    if (DEMO || new Date().getDay() !== 1 || store.get("weekShown", "") === localDay()) return;
    const w = summary();
    if (!w) { if (tries < 5) setTimeout(() => maybeMonday(tries + 1), 4000); return; }   // the week is still loading (or too short)
    if (w.empty || $("dialog").open || document.querySelector(".tour-card")) return;
    play();
  }

  // The picture: 1200×630, like today's card, with the week's numbers and the star.
  async function picture(w) {
    try { await Promise.all([document.fonts.load("40px Silkscreen"), document.fonts.load("700 56px Inter")]); } catch { /* system fonts */ }
    const W = 1200, H = 630, c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d"), snap = app.snap();
    const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, "#160d2b"); bg.addColorStop(1, "#0b1a2e");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const glow = g.createRadialGradient(950, 120, 0, 950, 120, 560); glow.addColorStop(0, "rgba(255,79,216,0.22)"); glow.addColorStop(1, "rgba(255,79,216,0)");
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
    g.font = "40px Silkscreen, monospace"; g.fillStyle = "#ffd8fb"; g.shadowColor = "#ff4fd8"; g.shadowBlur = 16;
    g.fillText(fit(g, (snap.office.name || "Claude Office").toUpperCase(), W - 120), 60, 92); g.shadowBlur = 0;
    g.font = "500 22px Inter, sans-serif"; g.fillStyle = "#a1a7bc";
    g.fillText(`My AI team's week · ${dayName(w.from, { day: "numeric", month: "long" })} – ${dayName(w.to, { day: "numeric", month: "long" })}`, 60, 130);
    const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e4 ? Math.round(n / 1000) + "k" : n.toLocaleString());
    const big = [[short(w.reports), "reports filed", w.delta == null ? "" : `${w.delta >= 0 ? "▲" : "▼"} ${Math.abs(w.delta)}% on the week before`],
      [fmtH(w.hours) + " h", "of agent work", `${(w.hours / 8).toFixed(1)} working days`], [short(w.calls), "tool calls", ""],
      [`${w.activeDays}/7`, "days with work", w.goalDays ? `${w.goalDays} with every goal` : ""]];
    big.forEach(([v, l, s], k) => {
      const x = 60 + (k % 2) * 300, y = 170 + Math.floor(k / 2) * 170;
      g.fillStyle = "rgba(255,255,255,0.05)"; roundRect(g, x, y, 284, 150, 18); g.fill();
      g.fillStyle = "#ffffff"; g.font = "800 56px Inter, sans-serif"; g.fillText(v, x + 22, y + 72);
      g.fillStyle = "#c6cad8"; g.font = "600 19px Inter, sans-serif"; g.fillText(l, x + 22, y + 104);
      if (s) { g.fillStyle = "#ff9fd8"; g.font = "500 16px Inter, sans-serif"; g.fillText(s, x + 22, y + 130); }
    });
    const tied = w.stars.map(id => snap.seats.find(s => s.id === id)).filter(Boolean), star = tied[0];
    const sx = 700, sy = 170;
    g.fillStyle = "rgba(255,210,74,0.10)"; roundRect(g, sx, sy, 440, 320, 22); g.fill();
    g.strokeStyle = "rgba(255,210,74,0.45)"; g.lineWidth = 2; roundRect(g, sx, sy, 440, 320, 22); g.stroke();
    g.fillStyle = "#ffd24a"; g.font = "700 15px Inter, sans-serif"; g.fillText(tied.length > 1 ? "STARS OF THE WEEK" : "STAR OF THE WEEK", sx + 28, sy + 40);
    if (star) {
      g.imageSmoothingEnabled = false; g.drawImage(portrait("mascot-" + star.id, star.color, { scale: 10, crown: true }), sx + 28, sy + 64);
      g.fillStyle = "#ffffff"; g.font = `800 ${tied.length > 1 ? 28 : 36}px Inter, sans-serif`;
      g.fillText(fit(g, tied.slice(0, 3).map(s => persona(s).name).join(" and "), 240), sx + 170, sy + 130);
      g.fillStyle = "#c6cad8"; g.font = "500 18px Inter, sans-serif"; g.fillText(`${w.starDays} day${w.starDays === 1 ? "" : "s"} on top`, sx + 170, sy + 162);
    } else { g.fillStyle = "#a1a7bc"; g.font = "500 20px Inter, sans-serif"; g.fillText("Nobody on top this week.", sx + 28, sy + 100); }
    const st = w.stickers.map(id => STICKERS.find(s => s.id === id)).filter(Boolean).slice(0, 5);
    if (st.length) {
      g.fillStyle = "#a1a7bc"; g.font = "700 13px Inter, sans-serif"; g.fillText("NEW STICKERS", sx + 28, sy + 236);
      st.forEach((s, k) => g.drawImage(stickerCanvas(s, 3, { t: 900 }), sx + 24 + k * 50, sy + 248));
    }
    // the team along the bottom
    const team = snap.seats.slice(0, 7);
    g.fillStyle = "#a1a7bc"; g.font = "700 13px Inter, sans-serif"; g.fillText("THE TEAM", 60, 524);
    team.forEach((s, k) => {
      const x = 60 + k * 150;
      g.imageSmoothingEnabled = false; g.drawImage(portrait("mascot-" + s.id, s.color, { scale: 3 }), x, 536);
      g.fillStyle = s.color; g.fillRect(x + 44, 548, 4, 18);
      g.fillStyle = "#ffffff"; g.font = "700 17px Inter, sans-serif"; g.fillText(fit(g, persona(s).name, 90), x + 54, 562);
    });
    g.fillStyle = "#6f7590"; g.font = "500 15px Inter, sans-serif"; g.textAlign = "right";
    g.fillText("Claude Office · github.com/JigarJoshi04/claude-office", W - 60, H - 30); g.textAlign = "left";
    return c;
  }

  return { play, maybeMonday, summary };
}

// "Wrapped": a calendar month as a short story, like the week review but bigger: every token the office burned against
// the month before, a podium of the top three burners, what it shipped, the biggest day and the models, ending in a
// picture. It plays on the first visit of a new month (for the month that ended), and from the menu or the palette.
import { $, esc, avatar, hydratePortraits } from "./util.js";
import { icon } from "./icons.js";
import { modelName, tokensPicture } from "./tokens.js";

const SLIDE_MS = 6000;
const big = (n) => (n >= 1e12 ? (n / 1e12).toFixed(1) + " T" : n >= 1e9 ? (n / 1e9).toFixed(n >= 1e11 ? 0 : 1) + " B" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + " M" : Math.round(n).toLocaleString());
// The month that ended before `now` ("2026-09" on any day of October).
export function lastMonth(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function makeWrapped(ctx) {
  const { app, panels, store, DEMO, prefs, toast } = ctx;
  const nameOf = (id) => { const s = app.snap().seats.find(x => x.id === id); return s ? panels.persona(s).name : "Unknown seat"; };
  const seatOf = (id) => app.snap().seats.find(x => x.id === id);

  async function play(month = lastMonth()) {
    const rng = "m:" + month;
    let t;
    try { t = await (await fetch(`/api/tokens?range=${encodeURIComponent(rng)}`)).json(); } catch { t = null; }
    if (!t || !t.total || !t.total.all) { toast(`Nothing on record for ${monthName(month)} yet.`, "info"); return false; }
    const prev = t.prev_total ? t.prev_total.all : 0, delta = prev ? Math.round((t.total.all - prev) / prev * 100) : null;
    const days = t.days || [], bd = days.reduce((a, d) => (d.all > (a ? a.all : 0) ? d : a), null);
    const top3 = (t.seats || []).filter(s => s.seat && s.all > 0).slice(0, 3), sh = t.shipped || {};
    const slides = [];
    slides.push(`<div class="wr-eyebrow">${esc(monthName(month))}, wrapped</div><h2 class="wr-title">${esc(app.snap().office.name || "Claude Office")}</h2>
      <div class="wr-team">${app.snap().seats.slice(0, 8).map(s => avatar("mascot-" + s.id, s.color, s.career ? "lv" + s.career.level : "")).join("")}</div>
      <p class="wr-hint">${(t.total.sessions || 0).toLocaleString()} sessions this month.</p>`);
    slides.push(`<div class="wr-eyebrow">Tokens</div><div class="wr-big">${esc(big(t.total.all).split(" ")[0])}<small> ${esc(big(t.total.all).split(" ")[1] || "")}</small></div>
      <p class="wr-sub">${delta == null ? "Your first month on record." : delta >= 0 ? `<b class="up">▲ ${delta}%</b> on the month before.` : `<b class="down">▼ ${-delta}%</b> on the month before.`}</p>
      <p class="wr-hint">About ${esc(big(t.total.all / Math.max(1, days.filter(d => d.all > 0).length)))} on a working day. ${esc(big(t.total.output))} of it written by the models.</p>`);
    if (top3.length) {
      const order = top3.length === 3 ? [top3[1], top3[0], top3[2]] : top3.length === 2 ? [top3[1], top3[0]] : [top3[0]];
      slides.push(`<div class="wr-eyebrow">The podium</div><div class="wr-podium">${order.map(s => { const st = seatOf(s.seat), place = top3.indexOf(s) + 1;
        return `<div class="pd p${place}" style="--seat:${esc(st ? st.color : "#888")}">${st ? avatar("mascot-" + s.seat, st.color, place === 1 ? "crown" : "") : ""}<b>${esc(nameOf(s.seat))}</b><span>${esc(big(s.all))}</span><i>${place}</i></div>`; }).join("")}</div>
        <p class="wr-hint">${esc(nameOf(top3[0].seat))} burned ${Math.round(top3[0].all / t.total.all * 100)}% of the office's tokens.</p>`);
    }
    if (sh.commits || sh.prs_merged) slides.push(`<div class="wr-eyebrow">What it shipped</div>
      <div class="wr-tiles"><div><b>${sh.commits.toLocaleString()}</b><span>commits</span></div><div><b>${sh.prs_merged}</b><span>PRs merged</span></div><div><b>+${big(sh.insertions)}</b><span>lines added</span></div></div>
      <p class="wr-hint">${esc(big(t.total.all / Math.max(1, sh.commits)))} tokens a commit.</p>`);
    const models = (t.models || []).filter(m => m.all > 0).slice(0, 4), mt = models.reduce((a, m) => a + m.all, 0) || 1;
    slides.push(`<div class="wr-eyebrow">The month's shape</div>${bd ? `<p class="wr-sub">The biggest day was <b>${esc(new Date(bd.day + "T12:00:00").toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }))}</b>, with ${esc(big(bd.all))}.</p>` : ""}
      <div class="wr-models">${models.map(m => `<div><span>${esc(modelName(m.model))}</span><i style="width:${Math.max(3, Math.round(m.all / mt * 100))}%"></i><b>${Math.round(m.all / mt * 100)}%</b></div>`).join("")}</div>`);
    slides.push(`<div class="wr-eyebrow">That's ${esc(monthName(month).split(" ")[0])}</div><h2 class="wr-title">On to the next one.</h2>
      <p class="wr-sub">Keep a picture of the month, or post it for the team.</p>
      <div class="wr-act"><button class="btn primary" data-wr-save>${icon("download", 15)}Save the picture</button><button class="btn ghost" data-wr-done>Done</button></div>`);
    open(slides, month, t, rng);
    if (!DEMO) store.set("wrappedShown", month);
    return true;
  }

  function open(slides, month, t, rng) {
    const d = $("dialog");
    if (d.open) d.close();
    let i = 0, timer = 0;
    d.classList.add("week-review");
    $("dialogBody").innerHTML = `<div class="wr" role="group" aria-roledescription="story" aria-label="${esc(monthName(month))}, wrapped. Arrows move between slides." tabindex="-1">
      <div class="wr-bars">${slides.map(() => `<i><b></b></i>`).join("")}</div>
      <button class="btn sm ghost wr-x" data-wr-close aria-label="Close">${icon("x", 16)}</button>
      <div class="wr-stage" aria-live="polite"></div>
      <button class="wr-tap prev" data-wr-prev aria-label="Previous" tabindex="-1"></button><button class="wr-tap next" data-wr-next aria-label="Next" tabindex="-1"></button></div>`;
    const stage = d.querySelector(".wr-stage"), bars = [...d.querySelectorAll(".wr-bars b")];
    const show = (n) => {
      i = Math.max(0, Math.min(slides.length - 1, n));
      stage.innerHTML = `<div class="wr-slide">${slides[i]}</div>`;
      hydratePortraits(stage, 6);
      bars.forEach((b, k) => { b.style.transition = "none"; b.style.width = k < i ? "100%" : "0%"; });
      clearTimeout(timer);
      if (prefs.motion !== "reduced" && i < slides.length - 1) {
        requestAnimationFrame(() => { bars[i].style.transition = `width ${SLIDE_MS}ms linear`; bars[i].style.width = "100%"; });
        timer = setTimeout(() => show(i + 1), SLIDE_MS);
      } else bars[i].style.width = "100%";
      const save = stage.querySelector("[data-wr-save]");
      if (save) save.addEventListener("click", () => tokensPicture(app, t, rng).then(c => { const a = document.createElement("a"); a.download = `wrapped-${month}.png`; a.href = c.toDataURL("image/png"); a.click(); }));
      const done = stage.querySelector("[data-wr-done]"); if (done) done.addEventListener("click", () => d.close());
    };
    const keys = (e) => { if (e.key === "ArrowRight") { e.preventDefault(); show(i + 1); } else if (e.key === "ArrowLeft") { e.preventDefault(); show(i - 1); } };
    d.querySelector("[data-wr-close]").addEventListener("click", () => d.close());
    d.querySelector("[data-wr-prev]").addEventListener("click", () => show(i - 1));
    d.querySelector("[data-wr-next]").addEventListener("click", () => (i < slides.length - 1 ? show(i + 1) : d.close()));
    d.addEventListener("keydown", keys);
    d.addEventListener("close", () => { clearTimeout(timer); d.removeEventListener("keydown", keys); d.classList.remove("week-review"); }, { once: true });
    d.showModal();
    show(0);
    d.querySelector(".wr").focus({ preventScroll: true });
  }

  // The first visit in the first three days of a month plays the month that ended (once, never in the demo).
  function maybeNewMonth() {
    const now = new Date();
    if (DEMO || now.getDate() > 3 || store.get("wrappedShown", "") === lastMonth(now) || $("dialog").open) return;
    play(lastMonth(now));
  }
  return { play, maybeNewMonth };
}

export function monthName(month) { return new Date(month + "-15T12:00:00").toLocaleDateString([], { month: "long", year: "numeric" }); }

// The game on top of the office: today's goals and their streak, CEO badges, the weekly challenge, the visit streak,
// work anniversaries, combos and the office level chip. Celebrations go to the floor (never over a replay), with a
// chime and a toast; earned-for-sure gifts go to the gift box. The rules live in goals.js, badges.js and unlocks.js.
import { $, toast } from "./util.js";
import { icon } from "./icons.js";
import { sound } from "./sound.js";
import { goals, streak, weekly, quests, PUNCH, localDay } from "./goals.js";
import { award } from "./badges.js";
import { officeLevel, UNLOCKS } from "../engine/unlocks.js";
import * as scrapbook from "./scrapbook.js";

const NOFX = { celebrate() {}, alarm() {}, banner() {}, say() {}, sayAtSeat() {} };
const UNLOCKS_BY_LEVEL = (from, to) => UNLOCKS.filter(u => u.level > from && u.level <= to);

// The visit streak, with freezes: every 7 days in a row earns one (two at most), and a first visit after missed days
// spends one per missed day to keep the run going. With weekdays-only streaks, Saturdays and Sundays never break it.
export const MAX_FREEZES = 2;
export function streakStep(st, now, weekdays = false, demo = false) {
  const key = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const today = key(now), days = new Set(st.visits || []), frozen = new Set(st.frozen || []);
  let freezes = Math.min(MAX_FREEZES, st.freezes || 0), used = 0, earned = false;
  const known = [...days, ...frozen].sort();
  if (!days.has(today) && known.length) {
    const last = known[known.length - 1], missed = [], c = new Date(now);
    c.setDate(c.getDate() - 1);
    for (let i = 0; i < 60 && key(c) > last; i++, c.setDate(c.getDate() - 1)) {
      if (weekdays && (c.getDay() === 0 || c.getDay() === 6)) frozen.add(key(c));     // a free weekend
      else missed.push(key(c));
    }
    if (missed.length && missed.length <= freezes && !demo) { missed.forEach(k => frozen.add(k)); freezes -= missed.length; used = missed.length; }
  }
  days.add(today);
  let n = 0, start = today;
  const c = new Date(now);
  while (days.has(key(c)) || frozen.has(key(c))) { if (days.has(key(c))) n++; start = key(c); c.setDate(c.getDate() - 1); }
  if (n && n % 7 === 0 && st.freezeDay !== today && freezes < MAX_FREEZES && !demo) { freezes++; earned = true; }
  return { visits: [...days].filter(k => k >= start).sort(), frozen: [...frozen].filter(k => k >= start).sort(), freezes,
           freezeDay: earned ? today : st.freezeDay || null, n, used, earned };
}

export function makeGame(ctx) {
  const { app, office, panels, replay, store, DEMO, prefs, gifts, view, renderPanel } = ctx;
  const fxNow = () => (replay.active() ? NOFX : office);   // floor effects for live news: none while replaying
  // Game intensity (Settings, Z): chimes only at Full; game toasts hidden at Off (real alerts live elsewhere).
  const level = () => prefs.game || "full";
  const chime = (...a) => { if (level() === "full") sound.play(...a); };
  const note = (...a) => { if (level() !== "off") toast(...a); };

  // A daily goal finishing while the office is open gets a banner, a chime and a toast. Goals already done when the page
  // opens are only noted, so a reload never re-celebrates them.
  let goalsSeen = null;
  function cheerGoals(st) {
    const gl = goals(st);
    if (!gl) return;
    const day = st.day || "";
    if (!goalsSeen || goalsSeen.day !== day) {
      const kept = store.get("goalsSeen", {});
      goalsSeen = { day, ids: new Set(kept.day === day ? kept.ids || [] : gl.filter(g => g.done).map(g => g.id)) };
      store.set("goalsSeen", { day, ids: [...goalsSeen.ids] });
    }
    if (gl.every(g => g.done) && day) {   // remember finished days for the streak
      const days = store.get("goalDays", []);
      if (!days.includes(day)) store.set("goalDays", [...days, day].slice(-90));
    }
    const fresh = gl.filter(g => g.done && !goalsSeen.ids.has(g.id));
    if (fresh.length && gl.every(x => x.done) && !DEMO) { badge(award("clean_sweep")); if (streak(store.get("goalDays", []), day) >= 3) badge(award("consistent")); }
    if (fresh.length) {   // one celebration per refresh, however many goals finished in it
      fresh.forEach(g => goalsSeen.ids.add(g.id));
      const all = gl.every(x => x.done), what = fresh.map(g => g.label).join(" and ");
      if (prefs.view === "floor") fxNow().banner(all ? "All goals!" : "Goal!", all ? "Every goal for today is done" : what, "#ffd24a");
      if (all) { gifts.grant(null, "goals", "rare", null, "goals-" + day); if (!replay.active()) scrapbook.capture(office, prefs, "goals", "Every goal done today", null); }
      chime(all ? "levelup" : "achievement");
      note(all ? "All three goals done today." : `Goal done: ${what}.`, "good", { ic: "goal" });
    }
    if (fresh.length) { store.set("goalsSeen", { day, ids: [...goalsSeen.ids] }); if (view().kind === "ceo") renderPanel(true); }
  }

  // A CEO badge (ui/badges.js) was earned: a chime and a toast that opens Your office.
  function badge(b) {
    if (!b) return;
    setTimeout(() => { chime("achievement"); note(`Badge earned: ${b.name}. ${b.desc}`, "good", { ic: b.icon, ms: 6500 }); if (view().kind === "office") renderPanel(true); }, 900);
  }
  // A quest finishing stamps the month's punch card (a rare gift each, an epic one with the card full); the reports
  // quest, or beating last week's reports outside the quests, is a record week.
  function cheerQuests() {
    const q = quests(app.weekCache());
    if (!q || !q.quests || DEMO) return;
    const stamps = store.get("questStamps", {}), month = localDay().slice(0, 7), mine = stamps[month] || [];
    const stamped = new Set(Object.values(stamps).flat());   // a week that spans two months is stamped once, in the month it finished
    for (const x of q.quests.filter(x => x.done && !stamped.has(x.id))) {
      stamped.add(x.id);
      mine.push(x.id); stamps[month] = mine; store.set("questStamps", stamps);
      const full = mine.length === PUNCH;
      if (prefs.view === "floor") fxNow().banner(full ? "Punch card full!" : "Quest done!", full ? `${PUNCH} quests this month` : x.label, "#ff7a45");
      chime(full ? "levelup" : "achievement");
      note(full ? `Punch card full: ${PUNCH} quests done this month.` : `Quest done: ${x.label}.`, "good", { ic: "flame", ms: 7000 });
      gifts.grant(null, "week", full ? "epic" : "rare", null, `quest-${month}-${x.id}`);
      if (x.kind === "reports") badge(award("record_week"));
    }
  }
  // The weekly challenge finishing: one celebration per week (per browser), never in the demo.
  // (When beating last week's reports is one of this week's quests, the quest is that celebration.)
  function cheerWeekly() {
    cheerQuests();
    const q = quests(app.weekCache());
    if (q && q.quests && q.quests.some(x => x.kind === "reports")) return;
    const w = weekly(app.weekCache());
    if (!w || w.calibrating || !w.done || DEMO) return;
    const seen = store.get("weeklyDone", "");
    if (seen === w.week) return;
    store.set("weeklyDone", w.week);
    if (prefs.view === "floor") fxNow().banner("Record week!", `${w.have} reports: you beat last week's ${w.last}`, "#ff7a45");
    chime("levelup");
    note(`Record week: ${w.have} reports, beating last week's ${w.last}.`, "good", { ic: "flame", ms: 7000 });
    badge(award("record_week"));
    gifts.grant(null, "week", "epic", null, "week-" + w.week);
  }

  // The visit streak: days in a row this browser has opened the office (a flame by the level chip from two days on).
  let visits = 0;
  function visitStreak() {
    const r = streakStep({ visits: store.get("visits", []), frozen: store.get("frozenDays", []), freezes: store.get("freezes", 0), freezeDay: store.get("freezeDay", null) },
      new Date(), !!prefs.streakWeekdays, DEMO);
    store.set("visits", r.visits); store.set("frozenDays", r.frozen); store.set("freezes", r.freezes); store.set("freezeDay", r.freezeDay);
    const n = r.n;
    if (r.used) note(`A streak freeze kept your ${n}-day streak going (you missed ${r.used === 1 ? "a day" : r.used + " days"}).${r.freezes ? ` ${r.freezes} left.` : ""}`, "good", { ic: "flame", ms: 7000 });
    if (r.earned) note(`${n} days in a row: you earned a streak freeze. A missed day will not break the streak (you can hold ${MAX_FREEZES}).`, "good", { ic: "flame", ms: 7000 });
    const el = $("visits");
    el.hidden = n < 2 || level() === "off";
    el.innerHTML = `${icon("flame", 14)}${n}${r.freezes ? `<small class="frz" aria-hidden="true">❄${r.freezes > 1 ? r.freezes : ""}</small>` : ""}`;
    el.title = `${n} days in a row: you have checked on the office every ${prefs.streakWeekdays ? "weekday" : "day"}.${r.freezes ? ` ${r.freezes} streak freeze${r.freezes === 1 ? "" : "s"} ready: a missed day uses one.` : " Every 7 days earns a streak freeze."}`;
    el.setAttribute("aria-label", el.title);
    if (n >= 7 && !DEMO) badge(award("regular"));
    visits = n;
    return n;
  }

  // Work anniversaries: a character's first week, month, 100 days and year at the office (from its career's start) get a
  // banner, confetti in its room and a line from it, once each (per browser), never in the demo.
  const ANNIVERSARIES = [[7, "one week"], [30, "one month"], [100, "100 days"], [365, "one year"]];
  function anniversaries() {
    if (DEMO || replay.active()) return;
    const seen = store.get("anniversaries", {});
    for (const s of app.snap().seats) {
      const since = s.career && s.career.since;
      if (!since) continue;
      const days = Math.floor((app.snap().now - since) / 86400);
      const hit = ANNIVERSARIES.filter(([d]) => days >= d && days < d + 2).pop();   // on the day (or the day after)
      if (!hit || seen[`${s.id}:${hit[0]}`]) continue;
      seen[`${s.id}:${hit[0]}`] = 1; store.set("anniversaries", seen);
      const who = panels.persona(s);
      office.celebrate(s.id, null, "Anniversary!");
      if (prefs.view === "floor") office.banner("Happy anniversary!", `${who.name}: ${hit[1]} at the office`, s.color);
      office.sayAtSeat(s.id, `${hit[1][0].toUpperCase() + hit[1].slice(1)} here. Thanks, boss!`, 6000);
      note(`${who.name} has been at the office for ${hit[1]}.`, "good", { ic: "calendar", ms: 6000 });
      break;                                            // one at a time
    }
  }

  function checkBadges() {
    const h = new Date().getHours();
    badge(award("welcome"));
    if (h < 4) badge(award("night_owl"));
    if (h >= 5 && h < 7) badge(award("early_bird"));
    if (app.snap().seats.length && panels.needsCount() === 0) badge(award("inbox_zero"));
  }

  // The combo: reports and finished lanes within 15 minutes of each other chain up (×2, ×3, …). The floor shows the
  // combo with a bar draining toward its end; the day's best combo is kept per browser.
  const COMBO_WINDOW = 15 * 60;
  let combo = store.get("combo", { n: 0, until: 0, best: 0, day: "" });
  function comboHit(e) {
    const now = e.ts || Date.now() / 1000, day = new Date().toDateString();
    if (combo.day !== day) combo = { n: 0, until: 0, best: 0, day };
    combo.n = now < combo.until ? combo.n + 1 : 1;
    combo.until = now + COMBO_WINDOW;
    const best = combo.n > combo.best && combo.n >= 2;
    combo.best = Math.max(combo.best, combo.n);
    store.set("combo", combo);
    if (combo.n >= 3 && !DEMO) badge(award("hot_streak"));
    if (combo.n === 3 || combo.n === 5) gifts.grant(e.seat, "combo");
    if (combo.n >= 2) {
      setTimeout(() => chime("combo", combo.n), 700);
      const word = combo.n >= 5 ? "Unstoppable!" : combo.n >= 4 ? "On fire!" : combo.n >= 3 ? "Hot streak!" : "Combo!";
      if (combo.n >= 3 && prefs.view === "floor") fxNow().banner(`Combo ×${combo.n}`, word + (best ? " A new best today." : ""), "#ff7a45");
      note(`Combo ×${combo.n}: ${word}`, "good", { ic: "flame", ms: 4500 });
    }
    renderCombo();
  }
  function renderCombo() {
    let el = document.querySelector(".combo");
    const now = Date.now() / 1000, live = combo.n >= 2 && now < combo.until && level() !== "off";
    if (!live) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div"); el.className = "combo"; el.setAttribute("role", "status");
      el.title = "Reports and finished lanes within 15 minutes of each other keep the combo going";
      document.querySelector(".floor-frame").appendChild(el);
    }
    const left = Math.max(0, combo.until - now), f = left / COMBO_WINDOW;
    const html = `<span class="cb-x">×${combo.n}</span><span class="cb-w"><b>Combo</b><small>${Math.ceil(left / 60)} min left${combo.best > combo.n ? ` · best ×${combo.best}` : ""}</small></span>`;
    if (el.dataset.html !== html) { el.innerHTML = html + '<i class="cb-bar"><i></i></i>'; el.dataset.html = html; }
    el.querySelector(".cb-bar i").style.width = (f * 100).toFixed(1) + "%";
    el.classList.toggle("blazing", combo.n >= 3);         // not "hot": that is the floor's clickable spots
  }

  // The office level chip in the header, and a celebration when the office levels up (never on a reload).
  let olSeen = store.get("officeLevel", 0);
  function renderOfficeLevel() {
    const ol = officeLevel(app.snap().seats), b = $("officeLvl");
    if (!app.snap().seats.some(s => s.career) || level() === "off") { b.hidden = true; return; }
    b.hidden = false;
    const r = 9, len = 2 * Math.PI * r;
    const html = `<svg viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="${r}" class="trk"/><circle cx="11" cy="11" r="${r}" class="val" stroke-dasharray="${(len * ol.progress).toFixed(1)} ${len.toFixed(1)}"/></svg><span>Lv ${ol.level}</span>`;
    if (b.dataset.html !== html) { b.innerHTML = html; b.dataset.html = html; }
    b.title = `Office level ${ol.level}: ${(ol.next - ol.xp).toLocaleString()} XP to level ${ol.level + 1}${ol.upcoming ? ` · next unlock: ${ol.upcoming.name} at level ${ol.upcoming.level}` : ""}`;
    b.setAttribute("aria-label", b.title);
    if (olSeen && ol.level > olSeen) {
      const got = UNLOCKS_BY_LEVEL(olSeen, ol.level);
      for (const s of app.snap().seats) fxNow().celebrate(s.id, null, "Level up!");     // confetti in every room
      if (prefs.view === "floor") fxNow().banner("Office level up!", got.length ? `Unlocked: ${got.map(u => u.name).join(", ")}` : `The office is now level ${ol.level}`, "#ffd24a");
      chime("levelup");
      note(got.length ? `Office level ${ol.level}! Unlocked ${got.map(u => u.name).join(", ")}.` : `Office level ${ol.level}!`, "good", { ic: "star", ms: 7000 });
      gifts.grant(null, "office", "epic", null, "office-" + ol.level);
      if (!replay.active()) scrapbook.capture(office, prefs, "office", `The office reached level ${ol.level}`, null);
    }
    if (ol.level > olSeen) { olSeen = ol.level; store.set("officeLevel", ol.level); }   // only rises: a dip never re-celebrates
  }

  setInterval(renderCombo, 5000);
  setTimeout(renderCombo, 1500);
  return { cheerGoals, badge, cheerWeekly, visitStreak, anniversaries, checkBadges, comboHit, renderCombo, renderOfficeLevel, visits: () => visits };
}

// Unit tests for the browser's pure logic (no DOM): office levels, daily goals and streaks, desk sizing and the
// building plan. Run with `node --test tests/js`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { officeLevel, xpForOffice, UNLOCKS } from "../../web/engine/unlocks.js";
import { goals, goalsFor, streak, POOL } from "../../web/ui/goals.js";
import { capFor, seatsOf, seatSpot, deskFor, planFor, computeLayout, pathTo } from "../../web/engine/scene.js";

const seat = (xp, id = "s" + xp) => ({ id, career: xp == null ? null : { xp } });

test("office level grows with the sum of everyone's XP", () => {
  assert.equal(officeLevel([]).level, 1);
  assert.equal(officeLevel([seat(399)]).level, 1);
  assert.equal(officeLevel([seat(200), seat(200)]).level, 2);        // 400 XP across two seats
  assert.equal(officeLevel([seat(xpForOffice(10))]).level, 10);
  assert.equal(officeLevel([seat(xpForOffice(10) - 1)]).level, 9);
  assert.equal(officeLevel([seat(null), seat(1600)]).level, 3);       // a seat without a career counts as 0
  const ol = officeLevel([seat(xpForOffice(5) + 100)]);
  assert.ok(ol.progress > 0 && ol.progress < 1);
  assert.ok(ol.unlocked.has("drone") && !ol.unlocked.has("goldlift"));
  assert.equal(ol.upcoming.id, "goldlift");
});

test("unlocks are ordered and unique", () => {
  const levels = UNLOCKS.map(u => u.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b));
  assert.equal(new Set(UNLOCKS.map(u => u.id)).size, UNLOCKS.length);
  assert.equal(officeLevel([seat(xpForOffice(99))]).upcoming, null);
});

test("each day draws three different goals, the same for everyone", () => {
  const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10));   // just labels: any time zone
  const seen = new Set();
  for (const d of days) {
    const g = goalsFor(d);
    assert.equal(g.length, 3);
    assert.equal(new Set(g.map(x => x.id.split("-")[0])).size, 3, `${d}: three different kinds`);
    assert.deepEqual(goalsFor(d).map(x => x.id), g.map(x => x.id));
    g.forEach(x => seen.add(x.id.split("-")[0]));
  }
  assert.equal(seen.size, POOL.length, "every kind of goal comes up over two months");
});

test("goals read the Today numbers", () => {
  assert.equal(goals(null), null);
  assert.equal(goals({ unavailable: true }), null);
  const st = { day: "2026-10-18", office: { reports: 50, sessions: 50, lanes_hired: 9 }, seats: { a: { tool_calls: 5000, active_min: 900 }, b: { tool_calls: 1, active_min: 5 }, c: { active_min: 1 }, d: { active_min: 1 } } };
  assert.ok(goals(st).every(g => g.done && g.text === "Done" && g.f === 1));
  const none = goals({ day: "2026-10-18", office: {}, seats: {} });
  assert.ok(none.every(g => !g.done && g.f === 0 && / of /.test(g.text)));
});

test("a goal streak counts consecutive finished days, today or up to yesterday", () => {
  assert.equal(streak([], "2026-10-18"), 0);
  assert.equal(streak(["2026-10-16", "2026-10-17", "2026-10-18"], "2026-10-18"), 3);
  assert.equal(streak(["2026-10-16", "2026-10-17"], "2026-10-18"), 2);            // today still open
  assert.equal(streak(["2026-10-15", "2026-10-17"], "2026-10-18"), 1);
  assert.equal(streak(["2026-10-31", "2026-11-01"], "2026-11-01"), 2);            // across a month end
});

test("desks fit the people at them", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(capFor), [2, 1, 2, 3, 4, 6, 6, 6]);
  for (const cap of [1, 2, 3, 4, 6]) {
    const pod = { x: 100, y: 50, cap };
    assert.equal(seatsOf(pod).length, cap);
    const d = deskFor(pod);
    for (let i = 0; i < cap; i++) {
      const sp = seatSpot(pod, i);
      assert.ok(sp.cx >= d.x && sp.cx + 10 <= d.x + d.w, `seat ${i} of ${cap} sits at the desk`);
    }
    assert.equal(d.two, cap >= 4);
  }
});

test("the building plan fills wide and tall boxes differently", () => {
  const wide = planFor(5, 1800, 600), tall = planFor(5, 700, 900);
  assert.ok(wide.cols >= tall.cols);
  for (const p of [wide, tall]) { assert.ok([2, 3, 4].includes(p.cols)); assert.ok(p.roomH >= 160 && p.roomH <= 240); }
});

test("a walker's path ends at its seat and never leaves the building", () => {
  const seats = Array.from({ length: 5 }, (_, i) => ({ id: "s" + i, sessions: [] }));
  for (const plan of [{ cols: 2, roomH: 200 }, { cols: 3, roomH: 160 }, { cols: 4, roomH: 240 }]) {
    const L = computeLayout(seats, () => null, plan);
    for (const pod of L.pods) for (const cap of [1, 3, 6]) {
      pod.cap = cap;
      for (let slot = 0; slot < cap; slot++) {
        const p = pathTo(L, pod, slot), last = p[p.length - 1], sp = seatSpot(pod, slot);
        assert.deepEqual(last, [sp.cx, sp.standY]);
        for (const [x, y] of p) assert.ok(x >= 0 && x <= L.W && y >= 0 && y <= L.H, `point ${x},${y} inside ${L.W}x${L.H}`);
      }
    }
  }
});

test("seasons: Halloween, Diwali and the winter holidays", async () => {
  const { seasonFor } = await import("../../web/engine/season.js");
  const at = (s) => seasonFor(new Date(s + "T12:00:00"));
  assert.equal(at("2026-10-18"), "halloween");
  assert.equal(at("2026-11-01"), "halloween");
  assert.equal(at("2026-11-06"), "diwali");                // Diwali 2026 is 8 November
  assert.equal(at("2026-11-11"), "diwali");
  assert.equal(at("2026-11-20"), null);
  assert.equal(at("2026-12-24"), "winter");
  assert.equal(at("2027-01-02"), "winter");
  assert.equal(at("2027-01-05"), null);
  assert.equal(at("2027-10-29"), "diwali");                // in 2027 Diwali falls inside the Halloween weeks and wins
  assert.equal(at("2026-07-01"), null);
});

test("a personality picked in Settings sets the voice and room style", async () => {
  const { personaFor, PERSONALITIES } = await import("../../web/ui/personas.js");
  assert.equal(PERSONALITIES.length, 7);
  const auto = personaFor({ id: "a", kind: "claude" }, 0), owl = personaFor({ id: "a", kind: "claude", style: "The Night Owl" }, 0);
  assert.notEqual(auto.archetype, "The Night Owl");
  assert.equal(owl.archetype, "The Night Owl");
  assert.equal(owl.role, "The Night Owl");
  assert.equal(personaFor({ id: "a", kind: "claude", style: "The Night Owl", role: "Lead" }, 0).role, "Lead");   // a custom role still wins
  assert.equal(personaFor({ id: "a", kind: "claude", style: "Nonsense" }, 0).archetype, auto.archetype);          // unknown → automatic
  assert.equal(personaFor({ id: "x", kind: "claude" }, -1).name, personaFor({ id: "x", kind: "claude" }, 0).name);  // a seat not in the list
});

test("banter is two filled-in lines that fit the moment", async () => {
  const { banter } = await import("../../web/ui/personas.js");
  for (let i = 0; i < 200; i++) {
    const o = { a: "Atlas", b: "Vega", napper: i % 3 === 0 ? "Orion" : "", busy: i % 5, recentReport: i % 4 === 0, reporter: i % 8 === 0 ? "Main" : "",
      low: i % 7 === 0 ? "Codex" : "", night: i % 6 === 0 };
    const [x, y] = banter(o);
    assert.ok(x && y && !/[{}]/.test(x + y), `filled: ${x} / ${y}`);
    if (!o.napper) assert.ok(!/napping|out of plan/i.test(x), "never says someone is napping when nobody is");
    if (/report\?/.test(x)) assert.ok(x.includes("Main"), "a report line names who reported");
    assert.ok(!/(^|\W)(Atlas|Vega)'s/.test(x), "never talks about one of the two speakers");
  }
});

test("the weekly challenge beats last week by 10%, Monday to Sunday", async () => {
  const { weekly } = await import("../../web/ui/goals.js");
  const mk = (end, n, reports) => Array.from({ length: n }, (_, i) => { const d = new Date(end + "T12:00:00"); d.setDate(d.getDate() - (n - 1 - i)); return { day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, reports: reports(d), sessions: 1 }; });
  assert.equal(weekly(mk("2026-10-18", 7, () => 1)), null);
  const w = weekly(mk("2026-10-14", 14, (d) => d.getDate() <= 11 ? 4 : 10));   // Wednesday 14 Oct; last week Mon 5 – Sun 11
  assert.equal(w.week, "2026-10-12");
  assert.equal(w.last, 28);
  assert.equal(w.target, 31);
  assert.equal(w.have, 30);
  assert.equal(w.daysLeft, 4);
  assert.equal(w.done, false);
  assert.equal(weekly(mk("2026-10-12", 14, () => 0)).target, 5);                 // a quiet week still has a goal
  const fresh = mk("2026-10-18", 14, () => 0).map((d, i) => i < 12 ? { ...d, sessions: 0 } : d);
  assert.equal(weekly(fresh).calibrating, true);                                   // no record of last week: nothing to beat yet
  assert.ok(weekly(mk("2026-10-18", 14, (d) => d.getDate() >= 12 ? 9 : 1)).done);
});

test("stickers: 24 pieces of 12×12 art in four rarities, rolled by weight", async () => {
  const { STICKERS, RARITY, rollSticker } = await import("../../web/engine/stickers.js");
  assert.equal(STICKERS.length, 24);
  assert.equal(new Set(STICKERS.map(s => s.id)).size, 24);
  for (const s of STICKERS) {
    assert.ok(RARITY[s.rarity], s.id);
    assert.equal(s.art.length, 12, s.id);
    for (const row of s.art) assert.equal(row.length, 12, s.id);
  }
  let i = 0; const seq = (xs) => () => xs[i++ % xs.length];
  assert.equal(rollSticker(seq([0, 0])).rarity, "common");
  assert.equal(rollSticker(seq([0.99, 0])).rarity, "legendary");
  assert.equal(rollSticker(seq([0.7, 0])).rarity, "rare");                      // 62 + 27: rare runs to 0.89
});

test("gifts: a pity timer, a cap on waiting gifts, a daily delivery and swaps", async () => {
  const { makeGifts, MAX_WAITING, PITY, KEEP_S, SWAP } = await import("../../web/ui/gifts.js");
  const mem = new Map(), store = { get: (k, d) => (mem.has(k) ? mem.get(k) : d), set: (k, v) => mem.set(k, v) };
  let t = 1_000_000, r = 0.99;
  const g = makeGifts({ store, now: () => t, rand: () => r });
  for (let n = 1; n < PITY; n++) assert.equal(g.earn("s1"), null);               // unlucky…
  assert.ok(g.earn("s1"));                                                        // …but never PITY reports without one
  r = 0;
  while (g.waiting().length < MAX_WAITING) assert.ok(g.earn("s2"));
  assert.equal(g.earn("s2"), null);                                               // the floor holds three at most
  t += KEEP_S + 1;
  assert.equal(g.waiting().length, 0);                                            // unopened gifts go back after a day
  assert.ok(g.daily("2026-10-18"));
  assert.equal(g.daily("2026-10-18"), null);                                      // one morning delivery a day
  const opened = g.open(g.waiting()[0].id);
  assert.equal(opened.sticker.rarity, "common");
  assert.ok(opened.isNew);
  assert.equal(g.open(opened.gift.id), null);                                     // a gift opens once
  for (let k = 0; k < SWAP; k++) { assert.ok(g.earn("s1")); g.open(g.waiting()[0].id); }
  assert.equal(g.spares(), SWAP);                                                 // the same common each time
  const sw = g.swap();
  assert.equal(sw.min, "rare");
  assert.equal(g.spares(), 0);
  r = 0.01; const got = g.open(sw.id);                                            // a roll that would be common is lifted
  assert.notEqual(got.sticker.rarity, "common");
  const demo = makeGifts({ store, demo: true, now: () => t, rand: () => 0 });
  const before = JSON.stringify([...mem]);
  demo.earn("s1"); demo.open(demo.waiting()[0].id);
  assert.equal(JSON.stringify([...mem]), before);                                 // the demo never writes to the browser
});

test("happy hour: one half hour a day between 11:00 and 18:00, the same all day", async () => {
  const { happyHourFor, happyNow } = await import("../../web/ui/gifts.js");
  const seen = new Set();
  for (let d = 1; d <= 60; d++) {
    const day = `2026-${String(9 + Math.floor((d - 1) / 30)).padStart(2, "0")}-${String((d - 1) % 30 + 1).padStart(2, "0")}`, h = happyHourFor(day);
    assert.ok(h.hour >= 11 && h.hour <= 17 && [0, 30].includes(h.minute) && h.minutes === 30, day);
    assert.deepEqual(happyHourFor(day), h);
    seen.add(h.hour * 60 + h.minute);
  }
  assert.ok(seen.size >= 6, "the time moves from day to day");
  const h = happyHourFor("2026-10-18"), at = new Date(2026, 9, 18, h.hour, h.minute + 10);
  assert.equal(happyNow(at).on, true);
  assert.equal(happyNow(at).left, 20);
  assert.equal(happyNow(new Date(2026, 9, 18, h.hour, h.minute + 30)).on, false);
});

test("gifts: grants go past the cap a little; sets finish with every sticker of a rarity", async () => {
  const { makeGifts, MAX_WAITING, GRANT_ROOM, setsDone } = await import("../../web/ui/gifts.js");
  const { STICKERS } = await import("../../web/engine/stickers.js");
  const mem = new Map(), store = { get: (k, d) => (mem.has(k) ? mem.get(k) : d), set: (k, v) => mem.set(k, v) };
  const g = makeGifts({ store, rand: () => 0, happy: () => true });
  while (g.waiting().length < MAX_WAITING) assert.ok(g.earn("s1"));
  assert.equal(g.earn("s1"), null);
  for (let i = 0; i < GRANT_ROOM; i++) assert.ok(g.grant(null, "goals", "rare"));
  assert.equal(g.grant(null, "goals"), null);
  const got = g.open(g.waiting().find(x => x.from === "goals").id);
  assert.notEqual(got.sticker.rarity, "common");
  const commons = Object.fromEntries(STICKERS.filter(s => s.rarity === "common").map(s => [s.id, { n: 1 }]));
  assert.deepEqual([...setsDone(commons)], ["common"]);
  assert.equal(setsDone({ ...commons, rocket: { n: 2 } }).has("rare"), false);
  assert.equal(setsDone(Object.fromEntries(STICKERS.map(s => [s.id, { n: 1 }]))).size, 4);
});

test("the week in review sums the last seven days and what was collected in them", async () => {
  const { weekSummary } = await import("../../web/ui/weekreview.js");
  const days = Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(5 + i).padStart(2, "0")}`, reports: i < 7 ? 2 : 3, sessions: 1, active_min: 60, tool_calls: 10, mvp: i >= 7 ? (i % 2 ? "a" : "b") : null }));
  days[9].mvp = "a";
  const at = (d) => new Date(d + "T12:00:00").getTime() / 1000;
  const w = weekSummary(days, { album: { duck: { n: 1, first: at("2026-10-13") }, mug: { n: 2, first: at("2026-10-01") } }, badges: { welcome: at("2026-10-18") }, goalDays: ["2026-10-04", "2026-10-15"] });
  assert.equal(w.from, "2026-10-12");
  assert.equal(w.to, "2026-10-18");
  assert.equal(w.reports, 21);
  assert.equal(w.prev, 14);
  assert.equal(w.delta, 50);
  assert.equal(w.hours, 7);
  assert.deepEqual(w.stars, ["a"]);
  assert.deepEqual(w.stickers, ["duck"]);
  assert.deepEqual(w.badges, ["welcome"]);
  assert.equal(w.goalDays, 1);
  assert.equal(weekSummary(days.slice(-6)), null);
});

test("Bug Squash: features and red bugs grow more common, spawns speed up, golden bugs stay rare", async () => {
  const { spawnKind, spawnGap, KINDS } = await import("../../web/ui/arcade.js");
  const share = (t, kind) => { let n = 0; for (let i = 0; i < 1000; i++) if (spawnKind(i / 1000, t) === kind) n++; return n / 1000; };
  assert.ok(Math.abs(share(0, "gold") - 0.04) < 0.002);
  assert.ok(share(30, "red") > share(0, "red"));
  assert.ok(share(30, "feature") > share(0, "feature"));
  assert.ok(share(30, "bug") > 0.4, "green bugs stay the most common");
  assert.ok(spawnGap(30) < spawnGap(0) && spawnGap(1000) === 0.28);
  assert.ok(KINDS.feature.pts < 0 && KINDS.gold.pts > KINDS.red.pts && KINDS.red.pts > KINDS.bug.pts);
});

test("the radio's chords: four-note sevenths, a new progression every eight bars", async () => {
  const { chordAt } = await import("../../web/ui/radio.js");
  for (let bar = 0; bar < 64; bar++) {
    const c = chordAt(bar);
    assert.equal(c.length, 4);
    assert.ok(c.every((n, i) => i === 0 || n > c[i - 1]), "voiced upwards");
    assert.ok(c[0] >= 50 && c[3] <= 82, "in a comfortable register");
  }
  assert.deepEqual(chordAt(3), chordAt(7));                   // the same four bars repeat…
  assert.notDeepEqual(chordAt(0), chordAt(8));                // …until the progression changes
});

test("the morning delivery gets better with a visit streak", async () => {
  const { makeGifts } = await import("../../web/ui/gifts.js");
  const mem = new Map(), store = { get: (k, d) => (mem.has(k) ? mem.get(k) : d), set: (k, v) => mem.set(k, v) };
  const g = makeGifts({ store, rand: () => 0 });
  assert.equal(g.daily("2026-10-01", 1).min, undefined);
  assert.equal(g.daily("2026-10-02", 3).min, "rare");
  assert.equal(g.daily("2026-10-03", 7).min, "epic");
  assert.equal(g.daily("2026-10-04", 8), null, "the floor is full…");
  for (const x of g.waiting()) g.open(x.id);
  assert.equal(g.daily("2026-10-04", 8).min, "rare", "…so the day's delivery waits for room");
  g.open(g.waiting()[0].id);
  assert.equal(g.daily("2026-10-05", 14).min, "epic");
  assert.equal(g.open(g.waiting()[0].id).sticker.rarity, "epic");
});

test("the next badge is the unearned one closest to done, from a third of the way", async () => {
  const { nextBadge } = await import("../../web/ui/badges.js");
  assert.equal(nextBadge({ talker: [2, 10], collector: [3, 12] }, {}), null);              // nothing a third of the way yet
  assert.equal(nextBadge({ talker: [7, 10], collector: [11, 12] }, {}).badge.id, "collector");
  assert.equal(nextBadge({ talker: [7, 10], collector: [11, 12] }, { collector: 1 }).badge.id, "talker");
  assert.equal(nextBadge({ talker: [10, 10] }, {}), null);                                  // done, waiting to be awarded
});

test("character card tiers by level", async () => {
  const { tierFor } = await import("../../web/ui/charcard.js");
  assert.deepEqual([1, 4, 5, 9, 10, 15, 19, 20, 40].map(l => tierFor(l).name), ["Rookie", "Rookie", "Bronze", "Bronze", "Silver", "Gold", "Gold", "Holo", "Holo"]);
  assert.equal(tierFor(undefined).name, "Rookie");
});

test("on a Monday the week review tells last week, Monday to Sunday", async () => {
  const { weekSummary } = await import("../../web/ui/weekreview.js");
  const days = Array.from({ length: 15 }, (_, i) => ({ day: `2026-10-${String(5 + i).padStart(2, "0")}`, reports: 1, sessions: 1, active_min: 0, tool_calls: 0 }));   // Mon 5 … Mon 19
  const w = weekSummary(days, { end: "2026-10-18" });
  assert.equal(w.from, "2026-10-12");
  assert.equal(w.to, "2026-10-18");
  assert.equal(w.prev, 7);                                                      // the week before is complete too
});

test("weekly pace: ahead, behind, running out before the reset", async () => {
  const { weekPace } = await import("../../web/ui/personas.js");
  const now = 1_000_000, day = 86400, fmt = (t) => String(t);
  const seat = (pct, daysLeft) => ({ usage: { weekly: { pct, resets_at: now + daysLeft * day } } });
  assert.equal(weekPace({ usage: {} }, now), null);
  const half = weekPace(seat(50, 3.5), now, fmt);                 // half the week gone, half the plan used
  assert.equal(half.tone, "good"); assert.match(half.text, /^On pace/);
  const hot = weekPace(seat(80, 3.5), now, fmt);                  // 80% used at the half: runs out early
  assert.equal(hot.tone, "bad"); assert.match(hot.text, /runs out/);
  assert.ok(hot.out < now + 3.5 * day);
  const slow = weekPace(seat(20, 3.5), now, fmt);
  assert.match(slow.text, /30% behind pace/); assert.match(slow.text, /about 60% left/);
  assert.match(weekPace(seat(2, 6.9), now, fmt).text, /fresh week/);
  const nearly = weekPace(seat(51.5, 3.5), now, fmt);             // a hair ahead: out about the reset, not an alarm
  assert.equal(nearly.tone, "good"); assert.match(nearly.text, /^On pace this week: runs out about the reset/);
  const brisk = weekPace(seat(55, 3.5), now, fmt);                // out about 15 hours early: a warning
  assert.equal(brisk.tone, "warn"); assert.match(brisk.text, /^5% ahead of pace this week: runs out/);
  assert.equal(weekPace(seat(62, 3.5), now, fmt).tone, "bad");
  const spent = weekPace(seat(100, 2), now, fmt);                 // nothing left: no "runs out <now>"
  assert.equal(spent.tone, "bad"); assert.match(spent.text, /^Out of plan for the week: back at the reset/);
  assert.match(weekPace(seat(100, 6.99), now, fmt).text, /^Out of plan/);
  for (let pct = 0; pct < 100; pct += 0.5) for (const d of [0.5, 2, 3.5, 5, 6.5]) {   // "On pace" never comes in red
    const r = weekPace(seat(pct, d), now, fmt);
    if (r && /^On pace/.test(r.text)) assert.notEqual(r.tone, "bad", `${pct}% with ${d} days left`);
  }
});

test("the Burner Belt goes to last week's top seat; milestones climb 1-2-5", async () => {
  const { beltHolders } = await import("../../web/ui/tokens.js");
  const { rungWords } = await import("../../web/ui/burn.js");
  const weeks = [{ week: "2026-10-05", seats: { a: 9, b: 5 } }, { week: "2026-10-12", seats: { b: 7, a: 6 } }, { week: "2026-10-19", seats: { c: 1 } }];
  assert.deepEqual(beltHolders(weeks), { holder: "b", week: "2026-10-12", leader: "c" });
  assert.deepEqual(beltHolders([]), { holder: null, week: null, leader: null });
  assert.equal(rungWords(50e9), "50 billion");
  assert.equal(rungWords(2e6), "2 million");
});

test("Wrapped tells the month that ended", async () => {
  const { lastMonth } = await import("../../web/ui/wrapped.js");
  assert.equal(lastMonth(new Date(2026, 9, 2)), "2026-09");
  assert.equal(lastMonth(new Date(2027, 0, 1)), "2026-12");
});

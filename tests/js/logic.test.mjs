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
  const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10));
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
    const o = { a: "Atlas", b: "Vega", c: "Orion", napping: i % 3 === 0, busy: i % 5, recentReport: i % 4 === 0, lowPlan: i % 7 === 0, night: i % 6 === 0 };
    const [x, y] = banter(o);
    assert.ok(x && y && !/[{}]/.test(x + y), `filled: ${x} / ${y}`);
    if (!o.napping) assert.ok(!/napping|out of plan/i.test(x), "never says someone is napping when nobody is");
  }
});

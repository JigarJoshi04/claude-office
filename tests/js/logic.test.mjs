// Unit tests for the browser's pure logic (no DOM): office levels, daily goals and streaks, desk sizing and the
// building plan. Run with `node --test tests/js`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { officeLevel, xpForOffice, UNLOCKS } from "../../web/engine/unlocks.js";
import { goals, streak } from "../../web/ui/goals.js";
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

test("daily goals read the Today numbers", () => {
  assert.equal(goals(null), null);
  assert.equal(goals({ unavailable: true }), null);
  const g = goals({ office: { reports: 5 }, seats: { a: { tool_calls: 600, active_min: 100 }, b: { tool_calls: 399, active_min: 10 } } });
  assert.deepEqual(g.map(x => x.done), [true, false, false]);
  assert.equal(g[1].text, "999 of 1,000");
  assert.equal(g[2].text, "1 h 50 of 5 h");
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

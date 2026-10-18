// The director cam: while it is on, the camera flies to whatever just happened on the floor (a report, a merge at the
// ship's bell, a level up, a lane done, a limit, a fresh plan, an arrival), holds it for a few seconds, then shows the
// whole office again. The biggest moments go first and at most three wait. It stands down for 20 seconds after the
// CEO moves the camera, and never runs under reduced motion, during a replay or off the floor.
const PRIO = { report: 3, levelup: 3, shipped: 3, achievement: 2, lane: 2, limit: 2, par: 2, reset: 1, arrive: 1 };
const HOLD = 6000, HANDS_OFF = 20000;

export function makeDirector({ office, prefs, replay }) {
  const queue = [];
  let busy = false, timer = 0;
  const on = () => !!prefs.director && prefs.motion !== "reduced" && !replay.active() && prefs.view === "floor" && !document.hidden;
  const handsOff = () => performance.now() - office.userCamAt() < HANDS_OFF;

  function next() {
    if (busy || !queue.length) return;
    if (!on()) { queue.length = 0; return; }
    if (handsOff()) { timer = setTimeout(next, 4000); return; }
    const ev = queue.shift();
    busy = true;
    if (ev.kind === "shipped" && ev.merged) office.focusShipBoard();
    else if (ev.session) office.focusSession(ev.session, { director: true });
    else if (ev.seat) office.focusSeat(ev.seat, { director: true });
    timer = setTimeout(() => {
      busy = false;
      if (queue.length) next();
      else if (on() && !handsOff()) office.fit({ director: true });
    }, HOLD);
  }
  // One event of news (app.js onNews): its kind, its seat, the session it is about, whether a PR merged.
  function push(ev) {
    if (!on() || !PRIO[ev.kind] || (!ev.seat && !(ev.kind === "shipped" && ev.merged))) return;
    if (queue.some(q => q.seat === ev.seat && q.kind === ev.kind)) return;   // the same news for the same seat: once
    queue.push({ ...ev, p: PRIO[ev.kind] });
    queue.sort((a, b) => b.p - a.p);
    queue.splice(3);
    next();
  }
  function stop() { queue.length = 0; clearTimeout(timer); busy = false; }
  return { push, stop, on };
}

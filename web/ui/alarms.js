// Burn alarms: number rules this viewer sets in Settings, checked on every snapshot. A seat burning more than N
// million tokens an hour, a plan window running out within N minutes, the office passing a milestone, the top burner
// changing hands. Each says so once (a toast, a chime and a desktop notification) and again only after it clears or an
// hour passes. Alarms are not part of the game, so they work at every game level; the demo never rings them.
export const ALARM_DEFAULTS = { alarmBurnM: null, alarmRunoutMin: null, alarmMilestone: false, alarmTopBurner: false };

export function makeAlarms(ctx) {
  const { app, prefs, toast, notify, sound, panels, DEMO } = ctx;
  const rung = new Map();                     // rule key -> when it last rang
  const name = (s) => (s ? panels.persona(s).name : "A seat");
  function ring(key, text, level = "warn", every = 3600e3) {
    const at = rung.get(key);
    if (at && Date.now() - at < every) return;
    rung.set(key, Date.now());
    toast(text, level, { ic: "bell", ms: 8000 });
    sound.play(level === "bad" ? "bad" : "limit");
    notify("Claude Office alarm", text);
  }
  const clear = (prefix) => { for (const k of [...rung.keys()]) if (k.startsWith(prefix)) rung.delete(k); };

  // On every snapshot: burn per hour and run-out, per seat.
  function check(snap) {
    if (DEMO || !snap) return;
    const burn = +prefs.alarmBurnM > 0 ? +prefs.alarmBurnM * 1e6 : null, mins = +prefs.alarmRunoutMin > 0 ? +prefs.alarmRunoutMin : null;
    for (const s of snap.seats) {
      if (burn && (s.tokens_1h_all || 0) >= burn) ring(`burn:${s.id}`, `${name(s)} burned ${((s.tokens_1h_all || 0) / 1e6).toFixed(0)} M tokens in the last hour, over your ${prefs.alarmBurnM} M alarm.`);
      else if (burn && (s.tokens_1h_all || 0) < burn * 0.8) clear(`burn:${s.id}`);       // rings again once it has cooled off
      const f = s.forecast && s.forecast.five_hour;
      const left = f && f.state === "runs_out" && f.out_at ? (f.out_at - snap.now) / 60 : null;
      if (mins && left != null && left > 0 && left <= mins && s.status === "working") ring(`out:${s.id}`, `${name(s)} runs out of its 5-hour window in about ${Math.max(1, Math.round(left))} min at this pace.`, "bad");
      else if (left == null || left > mins * 1.5) clear(`out:${s.id}`);
    }
  }
  // From the token numbers (burn.js): a new milestone, and the top burner changing hands.
  function milestone(words) { if (!DEMO && prefs.alarmMilestone) ring(`ms:${words}`, `The office has processed ${words} tokens.`, "good", 864e5); }
  function topBurner(id, was) {
    if (DEMO || !prefs.alarmTopBurner || !id || !was || id === was) return;
    const s = app.snap() && app.snap().seats.find(x => x.id === id), w = app.snap() && app.snap().seats.find(x => x.id === was);
    ring(`top:${id}`, `${name(s)} is now the office's top burner of all time, ahead of ${name(w)}.`, "info", 6 * 3600e3);
  }
  return { check, milestone, topBurner };
}

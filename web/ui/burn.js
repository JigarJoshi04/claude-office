// What the all-time token numbers put on the floor and celebrate: the Top burner flame, the lobby odometer, the Burner
// Belt (last week's heaviest burner, Monday to Sunday) and its handover, milestones on the 1-2-5 ladder (1 M, 2 M,
// 5 M, 10 M, …) with a plaque and an epic gift, and broken records. Ceremonies happen in a real office at Full game
// intensity; the first look only remembers where things stand, so a reload never re-celebrates.
import { topBurner, beltHolders, leanHolder } from "./tokens.js";

export const big = (n) => (n >= 1e12 ? (n / 1e12).toFixed(n >= 1e13 ? 0 : 1) + " T" : n >= 1e9 ? (n / 1e9).toFixed(n >= 1e11 ? 0 : 1) + " B"
  : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + " M" : String(Math.round(n)));
// A milestone in words: 50 000 000 000 -> "50 billion".
export const rungWords = (n) => n >= 1e12 ? `${n / 1e12} trillion` : n >= 1e9 ? `${n / 1e9} billion` : `${n / 1e6} million`;

export function makeBurn(ctx) {
  const { app, office, panels, store, DEMO, prefs, giftBox, toast, sound } = ctx;
  const full = () => (prefs.game || "full") === "full" && !DEMO;
  const name = (id) => { const s = app.snap() && app.snap().seats.find(x => x.id === id); return s ? panels.persona(s).name : id; };
  const color = (id) => { const s = app.snap() && app.snap().seats.find(x => x.id === id); return s ? s.color : "#ffd24a"; };

  function onAll(d) {
    if (!d || !d.total) return;
    office.setTopBurner(topBurner(d));
    office.setOdometer(d.total.all ? big(d.total.all) : null);
    const b = beltHolders(d.weeks);
    office.setBelt(b.holder);
    const lean = leanHolder(d.weeks);
    office.setLean(lean ? lean.seat : null);
    if (d.scanning) return;                              // no ceremonies on half-read numbers
    belt(b); milestone(d.milestones || []); records(d.records || {});
  }

  function belt(b) {
    if (!b.holder) return;
    const seen = store.get("belt", null);
    store.set("belt", { week: b.week, seat: b.holder });
    if (!seen || seen.week === b.week || !full()) return;
    const was = seen.seat !== b.holder ? seen.seat : null;
    office.banner("Burner Belt", was ? `${name(b.holder)} takes it from ${name(was)}` : `${name(b.holder)} keeps it another week`, color(b.holder));
    office.celebrate(b.holder, null, "Burner Belt!");
    sound.play("levelup");
    toast(was ? `${name(b.holder)} burned the most tokens last week and takes the Burner Belt from ${name(was)}.` : `${name(b.holder)} burned the most tokens again last week and keeps the Burner Belt.`, "good", { ic: "flame", ms: 7000 });
  }

  function milestone(list) {
    const top = list.length ? list[list.length - 1].at : 0, seen = store.get("milestone", null);
    if (top) store.set("milestone", top);
    if (seen == null || top <= seen || !full()) return;
    const words = rungWords(top);
    office.banner(`${words} tokens`, "A new plaque goes up in the lobby", "#ffd24a");
    for (const s of app.snap().seats) office.celebrate(s.id, null, "Milestone!");
    sound.play("levelup");
    toast(`The office has processed ${words} tokens. A plaque goes up on Your office, and a gift waits at your desk.`, "good", { ic: "trophy", ms: 8000 });
    giftBox.grant(null, "milestone", "epic");
  }

  function records(r) {
    const now = { day: r.biggest_day && r.biggest_day.all, session: r.hungriest_session && r.hungriest_session.all, run: r.longest_run && r.longest_run.days };
    const seen = store.get("tokRecords", null);
    store.set("tokRecords", { ...(seen || {}), ...Object.fromEntries(Object.entries(now).filter(([, v]) => v != null)) });
    if (!seen || !full()) return;
    // Each record is celebrated at most once a day: today's total keeps climbing past the old one.
    const today = new Date().toDateString(), done = store.get("tokRecordsDay", {}), broke = [];
    const check = (k, beat, text) => { if (beat && done[k] !== today) { broke.push(text); done[k] = today; } };
    check("day", seen.day && now.day > seen.day * 1.05, `the biggest day (${big(now.day)})`);
    check("session", seen.session && now.session > seen.session * 1.05, `the hungriest session (${big(now.session)})`);
    check("run", seen.run && now.run > seen.run, `the longest run (${now.run} days in a row)`);
    store.set("tokRecordsDay", done);
    if (!broke.length) return;
    office.banner("New record", broke[0].replace(/^the /, "").replace(/^./, c => c.toUpperCase()), "#7aa8ff");
    toast(`New record: ${broke.join(" and ")}. See the Tokens tab.`, "good", { ic: "trophy", ms: 7000 });
  }

  return { onAll };
}

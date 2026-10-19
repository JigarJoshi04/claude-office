// The gift boxes on the floor, from the CEO's side: who left each one, the chip that counts them, opening one (confetti,
// a reveal card with the sticker), the day's happy hour, finished album sets and the badges that come with the album.
// The rules live in gifts.js.
import { $, esc, toast } from "./util.js";
import { icon } from "./icons.js";
import { sound } from "./sound.js";
import { localDay } from "./goals.js";
import { makeGifts, SWAP, SETS, setsDone, teamDone, happyNow } from "./gifts.js";
import { STICKERS, RARITY, TEAM, stickerCanvas } from "../engine/stickers.js";
import { drawGift, GIFT_BOX } from "../engine/sprites.js";

export function makeGiftBox(ctx) {
  const { app, office, panels, replay, store, DEMO, setView, badge, award, onAlbum, prefs, forceHappy } = ctx;
  const happy = () => forceHappy || happyNow().on;
  const gifts = makeGifts({ store, demo: DEMO, happy, team: (id) => { const sn = app.snap(), s = sn && sn.seats.length >= 2 && sn.seats.find(x => x.id === id); return s ? { id, name: panels.persona(s).name, color: s.color } : null; } });   // a team needs two
  if (ctx.fullAlbum) { gifts.fillDemo(); const t = setInterval(() => { const sn = app.snap(); if (sn) { clearInterval(t); gifts.fillDemo(sn.seats.map(s => s.id)); sync(); } }, 200); }   // ?stickers=all: the team set too, once the seats are known
  if (DEMO && ctx.demoGifts > 0) for (let i = 0; i < Math.min(30, ctx.demoGifts); i++) gifts.grant(null, i % 2 ? "goals" : "daily");   // the demo's ?gifts=N: a full floor and a mailroom
  const seatName = (seatId) => { const s = seatId && app.snap() && app.snap().seats.find(x => x.id === seatId); return s ? panels.persona(s).name : null; };
  const nameOf = (seatId, g) => seatName(seatId) || (g && g.name) || null;   // a seat that has left keeps its name on its gifts
  // What a gift is called on the floor, and on its reveal card.
  const KINDS = { daily: ["Morning delivery", "This morning's delivery"], swap: ["A swapped gift, rare or better", "Swapped for five spares"],
    goals: ["A gift for today's goals, rare or better", "For finishing today's goals"], office: ["An office level-up gift, epic or better", "For the office's level up"],
    week: ["A record-week gift, epic or better", "For a record week"], arcade: ["An arcade prize", "For a new best at Bug Squash"],
    milestone: ["A milestone gift, epic or better", "For a token milestone"], promise: ["A promise-kept gift, rare or better", "For a promise kept"], chapter: ["A chapter gift", "For a new tier of the chapter"] };
  const label = (g) => {
    const who = nameOf(g.seat, g);
    if (g.from === "daily" && g.min) return `Morning delivery, day ${g.streak} of your streak (${g.min} or better): open it`;
    if (KINDS[g.from]) return KINDS[g.from][0] + ": open it";
    if (who && g.from === "levelup") return `${who}'s level-up gift: open it`;
    if (who && g.from === "combo") return `A combo gift from ${who}: open it`;
    if (who && g.from === "shipped") return `${who}'s shipping gift: open it`;
    return who ? `A gift from ${who}: open it` : "A gift: open it";
  };
  const fromLine = (g) => g.from === "daily" && g.streak ? `Day ${g.streak} of your visit streak` : KINDS[g.from] ? KINDS[g.from][1] : nameOf(g.seat, g) ? `From ${nameOf(g.seat, g)}${g.from === "levelup" ? ", for levelling up" : g.from === "combo" ? ", for the combo" : ""}` : "";

  const off = () => (prefs.game || "full") === "off";
  // The finished sets, with the team set when every character's sticker is in.
  const doneSets = () => { const al = gifts.album(), d = setsDone(al), ids = ((app.snap() || {}).seats || []).map(s => s.id); if (teamDone(al, ids)) d.add("team"); return d; };
  function sync() {
    if (!off() && !replay.active()) while (gifts.restock()) { /* room on the floor: the mailroom's oldest come out */ }
    const list = off() ? [] : gifts.waiting();
    office.setGifts(list.map(g => ({ ...g, label: label(g) })));
    if (office.setMailroom) office.setMailroom(off() ? [] : gifts.mailroom().map(g => ({ id: g.id, color: boxColor(g) })));
    office.setSets(doneSets());
    renderChip();
  }
  // The top-bar chip: gifts waiting, and the happy hour while it lasts.
  function renderChip() {
    const chip = $("giftChip");
    if (!chip) return;
    const n = off() ? 0 : gifts.waiting().length, m = off() ? 0 : gifts.mailroom().length, h = happyNow(), on = happy() && !off();
    chip.hidden = !n && !m && !on;
    chip.classList.toggle("happy", on);
    const html = `${icon("gift", 14)}${n + m ? n + m : ""}${on ? `<span class="gc-happy">Happy hour${forceHappy ? "" : ` · ${h.left}m`}</span>` : ""}`;
    if (chip.dataset.html !== html) { chip.innerHTML = html; chip.dataset.html = html; }
    chip.title = (n ? (n === 1 ? "A gift is waiting on the floor." : `${n} gifts are waiting on the floor.`) : "")
      + (m ? ` ${m === 1 ? "One more is" : `${m} more are`} in the mailroom.` : "")
      + (on ? ` Happy hour: gifts are twice as likely${forceHappy ? "" : ` for ${h.left} more minutes`}.` : "");
    chip.setAttribute("aria-label", chip.title.trim());
    document.dispatchEvent(new Event("office:gifts"));     // TV mode's strip shows the same count
  }
  // Happy hour starts once a day at a time picked for that day: party lights on the floor, a banner if the office is
  // open, and twice the chance of a gift for half an hour.
  let happyOn = null;
  function happyTick() {
    const on = happy();
    office.setHappy(on);
    if (on !== happyOn) {
      happyOn = on;
      // Announced once a day (the demo, which keeps nothing, once a visit).
      if (on && (forceHappy || DEMO || store.get("happyDay", "") !== localDay())) {
        if (!forceHappy && !DEMO) store.set("happyDay", localDay());
        if (prefs.view === "floor" && !replay.active()) office.banner("Happy hour!", "Gifts are twice as likely for half an hour", "#ff7ac8");
        if ((prefs.game || "full") === "full") sound.play("happy");
        if (!off()) toast("Happy hour: for the next half hour, reports are twice as likely to leave a gift.", "good", { ic: "gift", ms: 7000 });
      }
    }
    renderChip();
  }
  setInterval(happyTick, 20000);
  setTimeout(happyTick, 1200);

  // A report or a finished lane may leave a gift (never while replaying: the floor shows the past).
  function earn(seatId, from) {
    if (replay.active() || off()) return;
    const g = gifts.earn(seatId, from, seatName(seatId));
    if (!g) return;
    sync();
    sound.play("drop");
    if (g.mail) {
      if (!store.get("mailHint", false)) {
        store.set("mailHint", true);
        toast(`The floor is full, so ${nameOf(seatId) ? nameOf(seatId) + "'s" : "this"} gift went to the mailroom by the hiring desk. It comes out as you open the others.`, "info", { ic: "gift", ms: 8000 });
      }
      return;                                          // not "left you a gift on the floor"
    }
    if (!store.get("giftHint", false)) {
      store.set("giftHint", true);
      toast(`${nameOf(seatId) || "Someone"} left you a gift on the floor. Click the box to open it.`, "good", { ic: "gift", ms: 7000 });
    }
  }
  function daily(streak) { if (!off() && gifts.daily(localDay(), streak)) sync(); }
  // A gift earned for sure (all goals, a big combo, a level up, a record week); never from a replay.
  function grant(seatId, from, min, _name, id) {          // id: a once-only gift (today's goals, a week, an office level)
    if (replay.active() || off()) return false;
    const g = gifts.grant(seatId, from, min, seatName(seatId), id);
    if (g) { sync(); sound.play("drop"); }
    return g || false;                                  // the gift ({ mail: true } when it went to the mailroom)
  }

  let opening = false;
  function open(id) {
    if (opening) return;
    if (app.locked && app.locked()) { toast("The screen is locked: the gift waits until it is unlocked.", "info", { ic: "lock" }); return; }
    office.unwrap(id);
    const before = doneSets();
    const res = gifts.open(id);
    sync();
    if (!res) return;
    sound.play("gift", res.sticker.rarity);
    const done = [...doneSets()].filter(k => !before.has(k));
    // The confetti gets a moment on the floor before the reveal dims it.
    opening = true;
    setTimeout(() => { opening = false; reveal(res, done); }, prefs.motion === "reduced" || (prefs.game || "full") !== "full" ? 0 : 520);   // the wait is for the confetti
    if (!DEMO) {
      if (res.have >= 12) badge(award("collector"));
      if (res.sticker.rarity === "legendary") badge(award("golden"));
    }
  }

  const boxColor = (g) => { const s = g.seat && app.snap() && app.snap().seats.find(q => q.id === g.seat); return s ? s.color : GIFT_BOX[g.from] || GIFT_BOX.daily; };
  // The mailroom's next gift, opened where it is (the pigeonholes, or the album's Mailroom row).
  function openNext() { const g = gifts.mailroom()[0]; if (g) open(g.id); else seek(); }

  function boxCanvas(g) {
    const c = document.createElement("canvas"), k = 7;
    c.width = 14 * k; c.height = 16 * k;
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = false; x.scale(k, k);
    const s = g.seat && app.snap() && app.snap().seats.find(q => q.id === g.seat);
    drawGift(x, 1, 2, s ? s.color : GIFT_BOX[g.from] || GIFT_BOX.daily, s ? "#ffffff" : "#ffd24a", 0);
    return c;
  }

  function reveal(res, done = []) {
    const st = res.sticker, r = st.rarity === "team" ? TEAM : RARITY[st.rarity], from = fromLine(res.gift);
    const d = $("dialog");
    if (d.open) d.close();
    d.classList.add("gift");
    let glint = 0;
    d.addEventListener("close", () => {
      d.classList.remove("gift"); clearInterval(glint);
      // Focus goes on to the next waiting gift, or the gift chip, never back to the page.
      const next = document.querySelector(".hot.gift"), chip = $("giftChip");
      if (next) next.focus({ preventScroll: true }); else if (chip && !chip.hidden) chip.focus({ preventScroll: true }); else $("stage").focus({ preventScroll: true });
    }, { once: true });
    $("dialogBody").innerHTML = `<div class="gift-rev r-${esc(st.rarity)}" style="--rar:${esc(r.color)}">
      <button class="btn sm ghost gr-x" id="grClose" aria-label="Close">${icon("x", 16)}</button>
      <div class="gr-stage" aria-hidden="true"><div class="gr-rays"></div><div class="gr-box"></div><div class="gr-st"></div></div>
      <div class="gr-rar">${esc(r.name)}</div>
      <h3 class="gr-name">${esc(st.name)}</h3>
      <p class="gr-sub">${res.isNew ? `<b>New for your album</b> · ${res.have} of ${res.total}` : `Another one: you have ${res.count}`}${from ? ` · ${esc(from)}` : ""}</p>
      ${done.map(k => k === "team" ? `<p class="gr-set">${icon("trophy", 15)}<span><b>Team set complete: the team photo.</b> It hangs in the lounge now.</span></p>`
        : `<p class="gr-set">${icon("trophy", 15)}<span><b>${esc(RARITY[k].name)} set complete: ${esc(SETS[k].name)}.</b> ${esc(SETS[k].desc)}</span></p>`).join("")}
      ${DEMO ? `<p class="gr-demo">The demo office keeps stickers until you reload.</p>` : ""}
      <div class="gr-act"><button class="btn primary" id="grOk">Keep it</button><button class="btn" id="grAlbum">${icon("star", 15)}Open the album</button></div></div>`;
    d.querySelector(".gr-box").appendChild(boxCanvas(res.gift));
    const art = d.querySelector(".gr-st");
    art.appendChild(stickerCanvas(st, 8));
    if (st.gold && prefs.motion !== "reduced") {          // the golden duck's glint sweeps across it
      const t0 = performance.now();
      glint = setInterval(() => art.replaceChildren(stickerCanvas(st, 8, { t: performance.now() - t0 })), 90);
    }
    d.showModal();
    $("grClose").addEventListener("click", () => d.close());
    $("grOk").addEventListener("click", () => d.close());
    $("grAlbum").addEventListener("click", () => { d.close(); onAlbum(); });
    $("grOk").focus();
  }

  function swap() {
    const g = gifts.swap();
    if (!g) {
      toast(`Collect ${SWAP} spare stickers to swap them.`, "info");
      return false;
    }
    sync();
    toast(`Swapped: a rare-or-better gift is waiting ${g.mail ? "in the mailroom" : "at the CEO desk"}.`, "good", { ic: "gift" });
    return true;
  }

  // The chip in the top bar flies to the first waiting gift.
  function seek() {
    const g = gifts.waiting()[0];
    if (!g) { if (gifts.mailroom().length) onAlbum(); return; }   // only the mailroom has some: the album shows it
    setView("floor");
    if (g.seat && app.snap().seats.some(s => s.id === g.seat)) office.focusSeat(g.seat); else office.fit();
    // A courier may still be carrying it: wait for the box to land (a walk takes a few seconds), then show it.
    let tries = 0;
    const find = () => {
      const b = document.querySelector(`.hot.gift[data-k="gift:${CSS.escape(g.id)}"]`);
      if (!b) { if (++tries < 40 && gifts.waiting().some(x => x.id === g.id)) setTimeout(find, 150); return; }
      // On a phone or a narrow window the floor scrolls with the page (and sideways): bring the box on screen.
      const r = b.getBoundingClientRect();
      if (r.top < 60 || r.bottom > innerHeight - 20 || r.left < 0 || r.right > innerWidth) b.scrollIntoView({ block: "center", inline: "center", behavior: prefs.motion === "reduced" ? "auto" : "smooth" });
      b.focus({ preventScroll: true });
    };
    setTimeout(find, 450);
  }
  const chip = $("giftChip");
  if (chip) chip.addEventListener("click", seek);

  return { sync, earn, grant, daily, open, openNext, swap, seek, album: gifts.album, spares: gifts.spares, log: gifts.log, label, fromLine,
    waiting: () => (off() ? [] : gifts.waiting()), mailroom: () => (off() ? [] : gifts.mailroom()), happy: () => happy() && !off(), STICKERS };
}

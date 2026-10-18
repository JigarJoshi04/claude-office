// The gift boxes on the floor, from the CEO's side: who left each one, the chip that counts them, opening one (confetti,
// a reveal card with the sticker), the day's happy hour, finished album sets and the badges that come with the album.
// The rules live in gifts.js.
import { $, esc, toast } from "./util.js";
import { icon } from "./icons.js";
import { sound } from "./sound.js";
import { localDay } from "./goals.js";
import { makeGifts, SWAP, SETS, setsDone, happyNow } from "./gifts.js";
import { STICKERS, RARITY, stickerCanvas } from "../engine/stickers.js";
import { drawGift, GIFT_BOX } from "../engine/sprites.js";

export function makeGiftBox(ctx) {
  const { app, office, panels, replay, store, DEMO, setView, badge, award, onAlbum, prefs, forceHappy } = ctx;
  const happy = () => forceHappy || happyNow().on;
  const gifts = makeGifts({ store, demo: DEMO, happy });
  if (ctx.fullAlbum) gifts.fillDemo();
  const nameOf = (seatId) => { const s = seatId && app.snap() && app.snap().seats.find(x => x.id === seatId); return s ? panels.persona(s).name : null; };
  // What a gift is called on the floor, and on its reveal card.
  const KINDS = { daily: ["Morning delivery", "This morning's delivery"], swap: ["A swapped gift, rare or better", "Swapped for five spares"],
    goals: ["A gift for today's goals, rare or better", "For finishing today's goals"], office: ["An office level-up gift, epic or better", "For the office's level up"],
    week: ["A record-week gift, epic or better", "For a record week"], arcade: ["An arcade prize", "For a new best at Bug Squash"] };
  const label = (g) => {
    const who = nameOf(g.seat);
    if (g.from === "daily" && g.min) return `Morning delivery, day ${g.streak} of your streak (${g.min} or better): open it`;
    if (KINDS[g.from]) return KINDS[g.from][0] + ": open it";
    if (who && g.from === "levelup") return `${who}'s level-up gift: open it`;
    if (who && g.from === "combo") return `A combo gift from ${who}: open it`;
    return who ? `A gift from ${who}: open it` : "A gift: open it";
  };
  const fromLine = (g) => g.from === "daily" && g.streak ? `Day ${g.streak} of your visit streak` : KINDS[g.from] ? KINDS[g.from][1] : nameOf(g.seat) ? `From ${nameOf(g.seat)}${g.from === "levelup" ? ", for levelling up" : g.from === "combo" ? ", for the combo" : ""}` : "";

  function sync() {
    const list = gifts.waiting();
    office.setGifts(list.map(g => ({ ...g, label: label(g) })));
    office.setSets(setsDone(gifts.album()));
    renderChip();
  }
  // The top-bar chip: gifts waiting, and the happy hour while it lasts.
  function renderChip() {
    const chip = $("giftChip");
    if (!chip) return;
    const n = gifts.waiting().length, h = happyNow(), on = happy();
    chip.hidden = !n && !on;
    chip.classList.toggle("happy", on);
    const html = `${icon("gift", 14)}${n ? n : ""}${on ? `<span class="gc-happy">Happy hour${forceHappy ? "" : ` · ${h.left}m`}</span>` : ""}`;
    if (chip.dataset.html !== html) { chip.innerHTML = html; chip.dataset.html = html; }
    chip.title = (n ? (n === 1 ? "A gift is waiting on the floor." : `${n} gifts are waiting on the floor.`) : "") + (on ? ` Happy hour: gifts are twice as likely${forceHappy ? "" : ` for ${h.left} more minutes`}.` : "");
    chip.setAttribute("aria-label", chip.title.trim());
  }
  // Happy hour starts once a day at a time picked for that day: party lights on the floor, a banner if the office is
  // open, and twice the chance of a gift for half an hour.
  let happyOn = null;
  function happyTick() {
    const on = happy();
    office.setHappy(on);
    if (on !== happyOn) {
      happyOn = on;
      if (on && (forceHappy || (!DEMO && store.get("happyDay", "") !== localDay()))) {   // announced once a day
        if (!forceHappy) store.set("happyDay", localDay());
        if (prefs.view === "floor" && !replay.active()) office.banner("Happy hour!", "Gifts are twice as likely for half an hour", "#ff7ac8");
        sound.play("happy");
        toast("Happy hour: for the next half hour, reports are twice as likely to leave a gift.", "good", { ic: "gift", ms: 7000 });
      }
    }
    renderChip();
  }
  setInterval(happyTick, 20000);
  setTimeout(happyTick, 1200);

  // A report or a finished lane may leave a gift (never while replaying: the floor shows the past).
  function earn(seatId, from) {
    if (replay.active()) return;
    const g = gifts.earn(seatId, from);
    if (!g) return;
    sync();
    sound.play("drop");
    if (!store.get("giftHint", false)) {
      store.set("giftHint", true);
      toast(`${nameOf(seatId) || "Someone"} left you a gift on the floor. Click the box to open it.`, "good", { ic: "gift", ms: 7000 });
    }
  }
  function daily(streak) { if (gifts.daily(localDay(), streak)) sync(); }
  // A gift earned for sure (all goals, a big combo, a level up, a record week); never from a replay.
  function grant(seatId, from, min) {
    if (replay.active()) return false;
    const g = gifts.grant(seatId, from, min);
    if (g) { sync(); sound.play("drop"); }
    return !!g;
  }

  function open(id) {
    office.unwrap(id);
    const before = setsDone(gifts.album());
    const res = gifts.open(id);
    sync();
    if (!res) return;
    sound.play("gift", res.sticker.rarity);
    const done = [...setsDone(gifts.album())].filter(k => !before.has(k));
    reveal(res, done);
    if (!DEMO) {
      if (res.have >= 12) badge(award("collector"));
      if (res.sticker.rarity === "legendary") badge(award("golden"));
    }
  }

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
    const st = res.sticker, r = RARITY[st.rarity], from = fromLine(res.gift);
    const d = $("dialog");
    d.classList.add("gift");
    d.addEventListener("close", () => d.classList.remove("gift"), { once: true });
    $("dialogBody").innerHTML = `<div class="gift-rev r-${esc(st.rarity)}" style="--rar:${esc(r.color)}">
      <button class="btn sm ghost gr-x" id="grClose" aria-label="Close">${icon("x", 16)}</button>
      <div class="gr-stage" aria-hidden="true"><div class="gr-rays"></div><div class="gr-box"></div><div class="gr-st"></div></div>
      <div class="gr-rar">${esc(r.name)}</div>
      <h3 class="gr-name">${esc(st.name)}</h3>
      <p class="gr-sub">${res.isNew ? `<b>New for your album</b> · ${res.have} of ${res.total}` : `Another one: you have ${res.count}`}${from ? ` · ${esc(from)}` : ""}</p>
      ${done.map(k => `<p class="gr-set">${icon("trophy", 15)}<span><b>${esc(RARITY[k].name)} set complete: ${esc(SETS[k].name)}.</b> ${esc(SETS[k].desc)}</span></p>`).join("")}
      ${DEMO ? `<p class="gr-demo">The demo office keeps stickers until you reload.</p>` : ""}
      <div class="gr-act"><button class="btn primary" id="grOk">Keep it</button><button class="btn" id="grAlbum">${icon("star", 15)}Open the album</button></div></div>`;
    d.querySelector(".gr-box").appendChild(boxCanvas(res.gift));
    d.querySelector(".gr-st").appendChild(stickerCanvas(st, 8, { t: 900 }));
    d.showModal();
    $("grClose").addEventListener("click", () => d.close());
    $("grOk").addEventListener("click", () => d.close());
    $("grAlbum").addEventListener("click", () => { d.close(); onAlbum(); });
    $("grOk").focus();
  }

  function swap() {
    const g = gifts.swap();
    if (!g) { toast(`Collect ${SWAP} spare stickers to swap them.`, "info"); return false; }
    sync();
    toast("Swapped: a rare-or-better gift is waiting at the CEO desk.", "good", { ic: "gift" });
    return true;
  }

  // The chip in the top bar flies to the first waiting gift.
  function seek() {
    const g = gifts.waiting()[0];
    if (!g) return;
    setView("floor");
    if (g.seat && app.snap().seats.some(s => s.id === g.seat)) office.focusSeat(g.seat); else office.fit();
    setTimeout(() => { const b = document.querySelector(`.hot.gift[data-k="gift:${CSS.escape(g.id)}"]`); if (b) b.focus({ preventScroll: true }); }, 450);
  }
  const chip = $("giftChip");
  if (chip) chip.addEventListener("click", seek);

  return { sync, earn, grant, daily, open, swap, seek, album: gifts.album, spares: gifts.spares, waiting: gifts.waiting, happy, STICKERS };
}

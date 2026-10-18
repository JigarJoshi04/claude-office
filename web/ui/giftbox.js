// The gift boxes on the floor, from the CEO's side: who left each one, the chip that counts them, opening one (confetti,
// a reveal card with the sticker) and the badges that come with the album. The rules live in gifts.js.
import { $, esc, toast } from "./util.js";
import { icon } from "./icons.js";
import { sound } from "./sound.js";
import { localDay } from "./goals.js";
import { makeGifts, SWAP } from "./gifts.js";
import { STICKERS, RARITY, stickerCanvas } from "../engine/stickers.js";
import { drawGift } from "../engine/sprites.js";

export function makeGiftBox(ctx) {
  const { app, office, panels, replay, store, DEMO, setView, badge, award, onAlbum } = ctx;
  const gifts = makeGifts({ store, demo: DEMO });
  const nameOf = (seatId) => { const s = seatId && app.snap() && app.snap().seats.find(x => x.id === seatId); return s ? panels.persona(s).name : null; };
  const label = (g) => g.from === "daily" ? "Morning delivery: open it" : g.from === "swap" ? "A swapped gift, rare or better: open it"
    : nameOf(g.seat) ? `A gift from ${nameOf(g.seat)}: open it` : "A gift: open it";

  function sync() {
    const list = gifts.waiting();
    office.setGifts(list.map(g => ({ ...g, label: label(g) })));
    const chip = $("giftChip");
    if (!chip) return;
    chip.hidden = !list.length;
    chip.innerHTML = `${icon("gift", 14)}${list.length}`;
    chip.title = list.length === 1 ? "A gift is waiting on the floor" : `${list.length} gifts are waiting on the floor`;
    chip.setAttribute("aria-label", chip.title);
  }

  // A report or a finished lane may leave a gift (never while replaying: the floor shows the past).
  function earn(seatId, from) {
    if (replay.active()) return;
    const g = gifts.earn(seatId, from);
    if (!g) return;
    sync();
    if (!store.get("giftHint", false)) {
      store.set("giftHint", true);
      toast(`${nameOf(seatId) || "Someone"} left you a gift on the floor. Click the box to open it.`, "good", { ic: "gift", ms: 7000 });
    }
  }
  function daily() { if (gifts.daily(localDay())) sync(); }

  function open(id) {
    office.unwrap(id);
    const res = gifts.open(id);
    sync();
    if (!res) return;
    sound.play("gift", res.sticker.rarity);
    reveal(res);
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
    drawGift(x, 1, 2, s ? s.color : g.from === "swap" ? "#7d5cff" : "#e8475a", s ? "#ffffff" : "#ffd24a", 0);
    return c;
  }

  function reveal(res) {
    const st = res.sticker, r = RARITY[st.rarity], from = res.gift.from === "daily" ? "This morning's delivery" : res.gift.from === "swap" ? "Swapped for five spares" : nameOf(res.gift.seat) ? `From ${nameOf(res.gift.seat)}` : "";
    const d = $("dialog");
    d.classList.add("gift");
    d.addEventListener("close", () => d.classList.remove("gift"), { once: true });
    $("dialogBody").innerHTML = `<div class="gift-rev r-${esc(st.rarity)}" style="--rar:${esc(r.color)}">
      <button class="btn sm ghost gr-x" id="grClose" aria-label="Close">${icon("x", 16)}</button>
      <div class="gr-stage" aria-hidden="true"><div class="gr-rays"></div><div class="gr-box"></div><div class="gr-st"></div></div>
      <div class="gr-rar">${esc(r.name)}</div>
      <h3 class="gr-name">${esc(st.name)}</h3>
      <p class="gr-sub">${res.isNew ? `<b>New for your album</b> · ${res.have} of ${res.total}` : `Another one: you have ${res.count}`}${from ? ` · ${esc(from)}` : ""}</p>
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

  return { sync, earn, daily, open, swap, seek, album: gifts.album, spares: gifts.spares, waiting: gifts.waiting, STICKERS };
}

// Character cards: a collectible card for each character, 600×840, framed by level (Rookie, Bronze, Silver, Gold and,
// from level 20, Holo), with the portrait, the title, the motto, four stats and the latest achievements. It opens in a
// dialog where it tilts toward the pointer, and saves or copies as a picture. Names, levels and counts only.
import { $, esc, toast, portrait } from "./util.js";
import { icon } from "./icons.js";
import { fit, roundRect, wrap } from "./daycard.js";

export const TIERS = [
  { min: 20, name: "Holo", edge: ["#ff4fd8", "#ffd24a", "#38e07b", "#5b8def", "#c678dd"] },
  { min: 15, name: "Gold", edge: ["#fff0a8", "#ffd24a", "#c9962a"] },
  { min: 10, name: "Silver", edge: ["#f4f7fb", "#c9d1e0", "#8a93a8"] },
  { min: 5, name: "Bronze", edge: ["#f0b27a", "#c27a3a", "#7a4520"] },
  { min: 0, name: "Rookie", edge: ["#9aa3b8", "#5d6476", "#3b4054"] },
];
export const tierFor = (level) => TIERS.find(t => (level || 0) >= t.min);
const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e4 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));

export async function cardCanvas({ seat, persona, achievements = [], number = 1, total = 1 }) {
  try { await Promise.all([document.fonts.load("28px Silkscreen"), document.fonts.load("800 40px Inter")]); } catch { /* system fonts */ }
  const W = 600, H = 840, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d"), car = seat.career || { level: 1, title: "Intern", xp: 0, unlocked: {}, stats: {} }, st = car.stats || {};
  const tier = tierFor(car.level), col = seat.color;
  // the frame: a gradient edge in the tier's colours
  const edge = g.createLinearGradient(0, 0, W, H);
  tier.edge.forEach((e, i) => edge.addColorStop(i / Math.max(1, tier.edge.length - 1), e));
  g.fillStyle = edge; roundRect(g, 0, 0, W, H, 34); g.fill();
  const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, "#151a2e"); bg.addColorStop(1, "#0c0f1c");
  g.fillStyle = bg; roundRect(g, 16, 16, W - 32, H - 32, 24); g.fill();
  // name and level
  g.fillStyle = "#ffffff"; g.font = "800 40px Inter, sans-serif"; g.fillText(fit(g, persona.name, 360), 44, 78);
  g.fillStyle = "#a1a7bc"; g.font = "600 17px Inter, sans-serif"; g.fillText(fit(g, `${persona.role} · ${car.title}`, 380), 44, 106);
  g.fillStyle = col; g.beginPath(); g.arc(W - 84, 76, 40, 0, Math.PI * 2); g.fill();
  g.fillStyle = "rgba(0,0,0,0.25)"; g.beginPath(); g.arc(W - 84, 76, 32, 0, Math.PI * 2); g.fill();
  g.textAlign = "center"; g.fillStyle = "#ffffff"; g.font = "700 12px Inter, sans-serif"; g.fillText("LV", W - 84, 64);
  g.font = "800 30px Inter, sans-serif"; g.fillText(String(car.level), W - 84, 96); g.textAlign = "left";
  // the portrait window: the seat's colour, a floor, a pixel skyline and the character, big
  const px = 44, py = 130, pw = W - 88, ph = 330;
  const win = g.createLinearGradient(0, py, 0, py + ph); win.addColorStop(0, col); win.addColorStop(1, "#1a1f35");
  g.save(); roundRect(g, px, py, pw, ph, 18); g.clip();
  g.fillStyle = win; g.fillRect(px, py, pw, ph);
  g.fillStyle = "rgba(255,255,255,0.08)"; for (let i = 0; i < 9; i++) g.fillRect(px + 20 + i * 58, py + 30 + (i * 37) % 60, 30, ph);
  g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(px, py + ph - 70, pw, 70);
  const pic = portrait("mascot-" + seat.id, col, { scale: 18, level: car.level, crown: car.level >= 20 });
  g.imageSmoothingEnabled = false; g.drawImage(pic, px + pw / 2 - pic.width / 2, py + ph - pic.height - 6);
  if (tier.name === "Holo") {                       // a rainbow sheen across the window
    const sheen = g.createLinearGradient(px, py, px + pw, py + ph);
    ["rgba(255,79,216,0.18)", "rgba(255,210,74,0.12)", "rgba(56,224,123,0.14)", "rgba(91,141,239,0.18)"].forEach((s, i) => sheen.addColorStop(i / 3, s));
    g.fillStyle = sheen; g.fillRect(px, py, pw, ph);
  }
  g.restore();
  g.strokeStyle = "rgba(255,255,255,0.18)"; g.lineWidth = 2; roundRect(g, px, py, pw, ph, 18); g.stroke();
  // the motto
  g.fillStyle = "#e6e1f5"; g.font = "italic 500 19px Inter, sans-serif";
  wrap(g, `“${persona.motto}”`, 44, py + ph + 40, W - 88, 25, 2);
  // four stats
  const stats = [[short(st.hours || 0), "hours"], [short(st.reports || 0), "reports"], [short(st.tool_calls || 0), "tool calls"], [short(st.sessions || 0), "sessions"]];
  stats.forEach(([v, l], i) => {
    const x = 44 + i * 130, y = py + ph + 84;
    g.fillStyle = "rgba(255,255,255,0.06)"; roundRect(g, x, y, 122, 84, 14); g.fill();
    g.fillStyle = "#ffffff"; g.font = "800 30px Inter, sans-serif"; g.fillText(v, x + 14, y + 44);
    g.fillStyle = "#a1a7bc"; g.font = "600 14px Inter, sans-serif"; g.fillText(l, x + 14, y + 68);
  });
  // achievements: how many, and the latest three
  const got = Object.entries(car.unlocked || {}).sort((a, b) => b[1] - a[1]).map(([id]) => achievements.find(a => a.id === id)).filter(Boolean);
  const ay = py + ph + 200;
  g.fillStyle = tier.edge[Math.min(1, tier.edge.length - 1)]; g.font = "800 13px Inter, sans-serif";
  g.fillText(`${got.length}${achievements.length ? " OF " + achievements.length : ""} ACHIEVEMENTS`, 44, ay);
  let ax = 44;
  g.font = "600 15px Inter, sans-serif";
  for (const a of got.slice(0, 3)) {
    const w = Math.min(g.measureText(a.name).width + 26, W - 44 - ax);
    if (w < 60) break;
    g.fillStyle = "rgba(255,255,255,0.08)"; roundRect(g, ax, ay + 12, w, 32, 16); g.fill();
    g.fillStyle = "#ffffff"; g.fillText(fit(g, a.name, w - 26), ax + 13, ay + 33);
    ax += w + 8;
  }
  // footer
  g.fillStyle = tier.edge[Math.min(1, tier.edge.length - 1)]; g.font = "22px Silkscreen, monospace"; g.fillText(tier.name.toUpperCase(), 44, H - 44);
  g.fillStyle = "#6f7590"; g.font = "500 14px Inter, sans-serif"; g.textAlign = "right";
  g.fillText(`Claude Office · ${String(number).padStart(2, "0")}/${String(total).padStart(2, "0")}${car.since ? " · since " + new Date(car.since * 1000).toLocaleDateString([], { day: "numeric", month: "short" }) : ""}`, W - 44, H - 46);
  g.textAlign = "left";
  return c;
}

export function makeCards(ctx) {
  const { app, panels, prefs } = ctx;
  async function open(seatId) {
    const snap = app.snap(), seats = snap.seats, i = seats.findIndex(s => s.id === seatId);
    if (i < 0) return;
    const seat = seats[i], persona = panels.persona(seat);
    const c = await cardCanvas({ seat, persona, achievements: snap.achievements || [], number: i + 1, total: seats.length });
    const url = c.toDataURL("image/png"), tier = tierFor(seat.career && seat.career.level);
    const d = $("dialog");
    d.classList.add("card-view");
    d.addEventListener("close", () => d.classList.remove("card-view"), { once: true });
    $("dialogBody").innerHTML = `<div class="ccv"><button class="btn sm ghost ccv-x" data-cc-close aria-label="Close">${icon("x", 16)}</button>
      <div class="ccv-stage"><div class="ccv-card t-${esc(tier.name.toLowerCase())}"><img src="${url}" alt="${esc(persona.name)}'s character card: ${esc(tier.name)}, level ${seat.career ? seat.career.level : 1}"><i class="ccv-glare"></i></div></div>
      <div class="ccv-nav">${seats.length > 1 ? `<button class="btn sm" data-cc-go="-1" aria-label="Previous card">${icon("back", 15)}</button>` : ""}
        <span class="grow">${esc(persona.name)} · ${esc(tier.name)}</span>${seats.length > 1 ? `<button class="btn sm" data-cc-go="1" aria-label="Next card">${icon("chevronRight", 15)}</button>` : ""}</div>
      <div class="ccv-act"><button class="btn primary" data-cc-save>${icon("download", 15)}Save</button><button class="btn" data-cc-copy>${icon("copy", 15)}Copy</button></div></div>`;
    const card = d.querySelector(".ccv-card");
    if (prefs.motion !== "reduced") {                // the card tilts toward the pointer, and the light follows it
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = `rotateY(${(x * 16).toFixed(1)}deg) rotateX(${(-y * 16).toFixed(1)}deg)`;
        card.style.setProperty("--gx", `${((x + 0.5) * 100).toFixed(0)}%`); card.style.setProperty("--gy", `${((y + 0.5) * 100).toFixed(0)}%`);
      });
      card.addEventListener("pointerleave", () => { card.style.transform = ""; });
    }
    d.querySelector("[data-cc-close]").addEventListener("click", () => d.close());
    d.querySelectorAll("[data-cc-go]").forEach(b => b.addEventListener("click", () => open(seats[(i + Number(b.dataset.ccGo) + seats.length) % seats.length].id)));
    d.querySelector("[data-cc-save]").addEventListener("click", () => { const a = document.createElement("a"); a.download = `${persona.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-card.png`; a.href = url; a.click(); });
    d.querySelector("[data-cc-copy]").addEventListener("click", () => c.toBlob(b => {
      if (!b || !navigator.clipboard || !window.ClipboardItem) { toast("Copying pictures is not supported here: use Save.", "info"); return; }
      navigator.clipboard.write([new ClipboardItem({ "image/png": b })]).then(() => toast(`${persona.name}'s card is on the clipboard.`, "good"), () => toast("Could not copy: use Save.", "warn"));
    }));
    if (!d.open) d.showModal();
    (d.querySelector("[data-cc-go='1']") || d.querySelector("[data-cc-save]")).focus({ preventScroll: true });
  }
  return { open };
}

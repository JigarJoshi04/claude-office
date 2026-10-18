// "Save a picture of the office": the floor as a poster. The canvas has no page text on it, so the office's sign, the
// nameplates and the room labels are painted in where they stand on the floor. Presets fit it to a post: the floor as
// it is, a 16:9 slide, a square post or a phone story; a date can go in the corner. No session names or accounts.
import { esc, toast, SEAT_LABEL } from "./util.js";
import { icon } from "./icons.js";

export const PRESETS = { floor: ["As it is", null, null], slide: ["Slide 16:9", 1600, 900], square: ["Square", 1080, 1080], story: ["Phone story", 1080, 1920] };
const TONE = { good: "#3ddc84", warn: "#ffc24b", bad: "#ff6170", info: "#7aa8ff", idle: "#9298ae" };

function round(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

// The floor, sign and plates painted in, at scale k (canvas pixels per floor-canvas pixel).
function floorLayer(pic, snap, persona, k) {
  const { canvas: src, W: worldW } = pic, w = Math.round(src.width * k), h = Math.round(src.height * k), u = w / worldW;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false; g.drawImage(src, 0, 0, w, h);
  const n = pic.neon;                                     // the sign over the lobby (a page element on the floor)
  g.save(); g.font = `${Math.round(6.2 * u)}px Silkscreen, monospace`; g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = "#ff4fd8"; g.shadowBlur = 5 * u; g.fillStyle = "#ffd8fb";
  g.fillText((snap.office.name || "Claude Office").toUpperCase(), (n.x + n.w / 2) * u, (n.y + n.h / 2) * u, (n.w - 4) * u); g.restore();
  g.save(); g.font = `${Math.round(4.6 * u)}px Silkscreen, monospace`; g.fillStyle = "rgba(238,240,246,.55)"; g.textBaseline = "top";
  for (const l of pic.labels) g.fillText(l.text, l.x * u, l.y * u);
  g.restore();
  for (const p of pic.plates) {                           // each room's nameplate: name and level, status, plan left
    const s = snap.seats.find(x => x.id === p.seat);
    if (!s) continue;
    const x = p.x * u, y = p.y * u, pw = p.w * u, ph = 22 * u, pad = 3 * u;
    g.save(); round(g, x, y, pw, ph, 3 * u); g.fillStyle = "rgba(10,12,20,.84)"; g.fill();
    g.fillStyle = s.color; g.fillRect(x, y + 3 * u, 1.6 * u, ph - 6 * u);
    g.textBaseline = "middle"; g.font = `600 ${(6.2 * u).toFixed(1)}px Inter, sans-serif`; g.fillStyle = "#eef0f6";
    const name = persona(s).name + (s.career ? `  Lv ${s.career.level}` : "");
    g.fillText(name, x + pad + 2 * u, y + 7 * u, pw * 0.55);
    g.font = `600 ${(5 * u).toFixed(1)}px Inter, sans-serif`; g.fillStyle = TONE[p.line.tone] || TONE.idle; g.textAlign = "right";
    g.fillText(p.line.main, x + pw - pad, y + 7 * u, pw * 0.4); g.textAlign = "left";
    const bw = pw * 0.42, by = y + 15 * u;
    g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(x + pad + 2 * u, by - 1 * u, bw, 2 * u);
    const left = p.line.left == null ? 0 : p.line.left;
    g.fillStyle = left < 15 ? "#ff6170" : left < 35 ? "#ffc24b" : "#3ddc84"; g.fillRect(x + pad + 2 * u, by - 1 * u, bw * left / 100, 2 * u);
    g.font = `500 ${(4.6 * u).toFixed(1)}px Inter, sans-serif`; g.fillStyle = "#9298ae";
    g.fillText(p.line.side, x + pad + 6 * u + bw, by, pw - bw - 9 * u);
    g.restore();
  }
  return c;
}

// The office in one picture for a preset ("floor", "slide", "square", "story"); `dated` puts the date in a corner.
export async function makePoster(app, office, persona, preset = "floor", dated = false) {
  const snap = app.snap(), pic = office.picture();
  if (!pic.canvas || !snap) return null;
  try { await Promise.all([document.fonts.load("26px Silkscreen"), document.fonts.load("600 17px Inter"), document.fonts.load("500 15px Inter")]); } catch { /* system fonts */ }
  const [, TW, TH] = PRESETS[preset] || PRESETS.floor, tall = TH && TH > TW;
  const foot = tall ? 300 : TW && TW <= 1100 ? 190 : 132;
  let fl, W, H;
  if (!TW) { fl = floorLayer(pic, snap, persona, Math.max(1, Math.round(1600 / pic.canvas.width))); W = fl.width; H = fl.height + foot; }
  else { W = TW; H = TH; const room = [W, H - foot], k = Math.min(room[0] / pic.canvas.width, room[1] / pic.canvas.height); fl = floorLayer(pic, snap, persona, k); }
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#0a0c12"; g.fillRect(0, 0, W, H);
  // The floor is centred above the footer; on a tall poster the footer follows right under it, so they sit together.
  const fx = Math.round((W - fl.width) / 2), fy = TW ? Math.round((H - foot - fl.height) / 2) : 0;
  g.drawImage(fl, fx, fy);
  if (dated) {
    const text = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
    g.font = "600 18px Inter, sans-serif"; const tw = g.measureText(text).width;
    round(g, fx + 16, fy + 16, tw + 28, 34, 10); g.fillStyle = "rgba(10,12,20,.78)"; g.fill();
    g.fillStyle = "#eef0f6"; g.textBaseline = "middle"; g.fillText(text, fx + 30, fy + 33); g.textBaseline = "alphabetic";
  }
  // The footer: the office's name, when, and every character with level and mood (wrapping when narrow).
  const y0 = tall ? fy + fl.height : H - foot, t = snap.totals || {};
  g.fillStyle = "#eef0f6"; g.font = `${tall ? 40 : 26}px Silkscreen, monospace`;
  g.fillText((snap.office.name || "Claude Office").toUpperCase(), 32, y0 + (tall ? 64 : 50), W - 64);
  g.font = `500 ${tall ? 20 : 15}px Inter, sans-serif`; g.fillStyle = "#9298ae";
  g.fillText(`${new Date().toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · ${t.working || 0} working, ${t.sessions || 0} sessions`, 32, y0 + (tall ? 100 : 78));
  if (!tall && W > 1100) { g.textAlign = "right"; g.fillText("github.com/JigarJoshi04/claude-office", W - 32, y0 + 50); g.textAlign = "left"; }
  let x = 32, y = y0 + (tall ? 160 : 113);
  const big = tall ? 24 : 17, small = tall ? 19 : 14, lineH = tall ? 46 : 34;
  for (const s of snap.seats) {
    const label = `${persona(s).name}${s.career ? ` · Lv ${s.career.level}` : ""}`, mood = (SEAT_LABEL[s.status] || s.status || "").toLowerCase();
    g.font = `600 ${big}px Inter, sans-serif`; const lw = g.measureText(label).width;
    g.font = `500 ${small}px Inter, sans-serif`; const mw = g.measureText(mood).width;
    if (x + 22 + lw + 8 + mw > W - 32) { x = 32; y += lineH; if (y > H - 12) break; }
    g.fillStyle = s.color; g.beginPath(); g.arc(x + 6, y - big * 0.35, tall ? 8 : 6, 0, Math.PI * 2); g.fill();
    g.font = `600 ${big}px Inter, sans-serif`; g.fillStyle = "#eef0f6"; g.fillText(label, x + 20, y);
    g.font = `500 ${small}px Inter, sans-serif`; g.fillStyle = "#9298ae"; g.fillText(mood, x + 20 + lw + 8, y);
    x += 20 + lw + 8 + mw + 34;
  }
  if (tall || W <= 1100) { g.font = `500 ${tall ? 18 : 14}px Inter, sans-serif`; g.fillStyle = "#5d6378"; g.fillText("github.com/JigarJoshi04/claude-office", 32, tall ? Math.min(H - 24, y + lineH + 10) : H - 24); }
  return c;
}

// The dialog: pick a preset (and the date), see it, save or copy it.
export function openPoster(app, office, persona) {
  const d = document.getElementById("dialog"), body = document.getElementById("dialogBody");
  let preset = "floor", dated = false, current = null;
  const draw = async () => {
    current = await makePoster(app, office, persona, preset, dated);
    if (!current) { toast("Could not make the picture.", "bad"); return; }
    const img = body.querySelector("[data-poster-img]"); if (img) img.src = current.toDataURL("image/png");
  };
  body.innerHTML = `<div class="dh"><b>A picture of the office</b><button class="btn sm ghost" data-poster-close aria-label="Close">${icon("x", 16)}</button></div>
    <div class="db"><div class="seg-ctl" role="group" aria-label="Size">${Object.entries(PRESETS).map(([k, [l]]) => `<button data-poster="${k}" class="${k === preset ? "on" : ""}">${esc(l)}</button>`).join("")}</div>
      <label class="row" style="gap:8px;margin:10px 0;font-size:13px"><input type="checkbox" data-poster-date> The date in the corner</label>
      <img class="daycard poster-img" data-poster-img alt="The office floor with every character's nameplate, level and status">
      <p class="hint">No session names or accounts are in it, so it is safe to post.</p>
      <div class="row" style="margin-top:10px;gap:8px"><button class="btn primary" data-poster-save>${icon("download", 15)}Save</button><button class="btn" data-poster-copy>${icon("copy", 15)}Copy</button></div></div>`;
  body.querySelectorAll("[data-poster]").forEach(b => b.addEventListener("click", () => { preset = b.dataset.poster; body.querySelectorAll("[data-poster]").forEach(x => x.classList.toggle("on", x === b)); draw(); }));
  body.querySelector("[data-poster-date]").addEventListener("change", (e) => { dated = e.target.checked; draw(); });
  body.querySelector("[data-poster-close]").addEventListener("click", () => d.close());
  body.querySelector("[data-poster-save]").addEventListener("click", () => {
    if (!current) return;
    const a = document.createElement("a"), day = new Date();
    a.download = `claude-office-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}${preset === "floor" ? "" : "-" + preset}.png`;
    a.href = current.toDataURL("image/png"); a.click(); toast("Saved a picture of the office.", "good");
  });
  body.querySelector("[data-poster-copy]").addEventListener("click", () => current && current.toBlob(b => {
    if (!b || !navigator.clipboard || !window.ClipboardItem) { toast("Copying pictures is not supported here: use Save.", "info"); return; }
    navigator.clipboard.write([new ClipboardItem({ "image/png": b })]).then(() => toast("The office is on the clipboard.", "good"), () => toast("Could not copy: use Save.", "warn"));
  }));
  if (!d.open) d.showModal();
  draw();
  body.querySelector("[data-poster-save]").focus({ preventScroll: true });
}

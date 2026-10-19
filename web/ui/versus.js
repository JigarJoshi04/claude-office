// The versus card: two characters head to head over the last seven days (tokens, API value, commits, PRs merged,
// sessions, tokens per commit), a tick for whoever leads each row, on a 1200×630 picture to save or copy. Names,
// levels and counts only, so it is safe to share.
import { portrait, fmtTok, esc, toast } from "./util.js";
import { icon } from "./icons.js";
import { fit, roundRect } from "./daycard.js";

const W = 1200, H = 630;

// The rows: label, value of a board row ({all, usd, commits, prs_merged, sessions, fresh}), format, and whether less wins.
export const ROWS = [
  ["Tokens", (r) => r.all || 0, (v) => fmtTok(v), false],
  ["API value", (r) => r.usd || 0, (v) => "$" + Math.round(v).toLocaleString(), false],
  ["Commits", (r) => r.commits || 0, (v) => String(v), false],
  ["PRs merged", (r) => r.prs_merged || 0, (v) => String(v), false],
  ["Sessions", (r) => r.sessions || 0, (v) => String(v), false],
  ["Fresh tokens a commit", (r) => (r.commits ? (r.fresh || 0) / r.commits : null), (v) => v == null ? "–" : fmtTok(v), true],
];
// Who leads each row: "a", "b" or null (a tie, or nothing to compare); and the overall score.
export function duel(ra, rb) {
  const marks = ROWS.map(([, get, , less]) => {
    const x = get(ra || {}), y = get(rb || {});
    if (x == null || y == null || x === y) return null;
    return (less ? x < y : x > y) ? "a" : "b";
  });
  return { marks, a: marks.filter(m => m === "a").length, b: marks.filter(m => m === "b").length };
}

export async function versusCanvas({ a, b, ra, rb, pa, pb }) {
  try { await Promise.all([document.fonts.load("40px Silkscreen"), document.fonts.load("700 40px Inter"), document.fonts.load("500 20px Inter")]); } catch { /* system fonts */ }
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  const bg = g.createLinearGradient(0, 0, W, 0); bg.addColorStop(0, a.color + "55"); bg.addColorStop(0.5, "#0d1020"); bg.addColorStop(1, b.color + "55");
  g.fillStyle = "#0d1020"; g.fillRect(0, 0, W, H); g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const d = duel(ra, rb);
  g.font = "36px Silkscreen, monospace"; g.textAlign = "center"; g.fillStyle = "#ffd24a"; g.shadowColor = "#ff7a45"; g.shadowBlur = 18;
  g.fillText("VERSUS", W / 2, 70); g.shadowBlur = 0;
  g.font = "500 18px Inter, sans-serif"; g.fillStyle = "#a1a7bc"; g.fillText("The last 7 days", W / 2, 98);
  const side = (s, p, x, score, won) => {
    const img = portrait("mascot-" + s.id, s.color, { crown: won, scale: 8, level: s.career ? s.career.level : 0 });
    g.imageSmoothingEnabled = false; g.drawImage(img, x - 48, 116, 96, 120);
    g.font = "700 34px Inter, sans-serif"; g.fillStyle = "#f2f4fa"; g.fillText(fit(g, p.name, 300), x, 290);
    g.font = "500 18px Inter, sans-serif"; g.fillStyle = s.color; g.fillText(`Level ${s.career ? s.career.level : 1}${s.career ? " · " + s.career.title : ""}`, x, 316);
    g.font = "700 56px Inter, sans-serif"; g.fillStyle = won ? "#ffd24a" : "#7d8496"; g.fillText(String(score), x, 380);
  };
  side(a, pa, 220, d.a, d.a > d.b); side(b, pb, W - 220, d.b, d.b > d.a);
  ROWS.forEach(([label, get, fmt], i) => {
    const y = 150 + i * 62, m = d.marks[i];
    g.fillStyle = "rgba(255,255,255,0.05)"; roundRect(g, 420, y - 34, 360, 50, 12); g.fill();
    g.font = "500 15px Inter, sans-serif"; g.fillStyle = "#a1a7bc"; g.fillText(label, W / 2, y - 14);
    g.font = "700 22px Inter, sans-serif";
    g.fillStyle = m === "a" ? "#3ddc84" : "#d7dbea"; g.textAlign = "left"; g.fillText((m === "a" ? "✓ " : "") + fmt(get(ra || {})), 436, y + 8);
    g.fillStyle = m === "b" ? "#3ddc84" : "#d7dbea"; g.textAlign = "right"; g.fillText(fmt(get(rb || {})) + (m === "b" ? " ✓" : ""), 764, y + 8);
    g.textAlign = "center";
  });
  g.font = "500 16px Inter, sans-serif"; g.fillStyle = "#6f7690";
  g.fillText(d.a === d.b ? "Dead even." : `${(d.a > d.b ? pa : pb).name} takes it, ${Math.max(d.a, d.b)} to ${Math.min(d.a, d.b)}.`, W / 2, H - 40);
  return c;
}

// The dialog: pick the challenger, see the card, save or copy it.
export async function openVersus(app, panels, seatId, otherId) {
  const snap = app.snap(), seats = snap.seats.filter(s => s.career || s.kind);
  const a = seats.find(s => s.id === seatId);
  if (!a || seats.length < 2) { toast("A duel needs two characters.", "info"); return; }
  const b = seats.find(s => s.id === otherId && s.id !== seatId) || seats.find(s => s.id !== seatId);
  let t = app.tokensCache("7");
  for (let i = 0; !t && i < 20; i++) { await new Promise(r => setTimeout(r, 150)); t = app.tokensCache("7"); }   // the week's board loads once
  const board = Object.fromEntries(((t || {}).seats || []).map(r => [r.seat, r]));
  const pa = panels.persona(a), pb = panels.persona(b);
  const c = await versusCanvas({ a, b, ra: board[a.id], rb: board[b.id], pa, pb });
  const url = c.toDataURL("image/png"), d = document.getElementById("dialog");
  document.getElementById("dialogBody").innerHTML = `<div class="dh"><b>${esc(pa.name)} versus ${esc(pb.name)}</b><button class="btn sm ghost" data-vs-close aria-label="Close">${icon("x", 16)}</button></div>
    <div class="db"><img class="vs-img" src="${url}" alt="${esc(pa.name)} versus ${esc(pb.name)} over the last seven days">
    <div class="row wrap" style="gap:6px;margin-top:10px"><label class="f" style="margin:0">Against<select data-vs-other>${seats.filter(s => s.id !== a.id).map(s => `<option value="${esc(s.id)}" ${s.id === b.id ? "selected" : ""}>${esc(panels.persona(s).name)}</option>`).join("")}</select></label>
      <span class="grow"></span><button class="btn sm primary" data-vs-save>${icon("download", 14)}Save</button><button class="btn sm" data-vs-copy>${icon("copy", 14)}Copy</button></div>
    ${a.kind === "codex" || b.kind === "codex" ? `<p class="hint">Codex counts its tokens its own way, so a duel with Codex compares unlike things.</p>` : ""}</div>`;
  if (!d.open) d.showModal();
  d.querySelector("[data-vs-close]").addEventListener("click", () => d.close());
  d.querySelector("[data-vs-other]").addEventListener("change", async (e) => { await openVersus(app, panels, a.id, e.target.value); d.querySelector("[data-vs-other]")?.focus(); });   // the keyboard stays on the picker
  d.querySelector("[data-vs-save]").addEventListener("click", () => { const l = document.createElement("a"); l.download = `${pa.name}-vs-${pb.name}`.toLowerCase().replace(/[^\p{L}\p{N}.-]+/gu, "-").replace(/^-+|-+$/g, "") + ".png"; l.href = url; l.click(); });   // names in any alphabet
  d.querySelector("[data-vs-copy]").addEventListener("click", () => c.toBlob(bl => {
    if (!bl || !navigator.clipboard || !window.ClipboardItem) { toast("Copying pictures is not supported here: use Save.", "info"); return; }
    navigator.clipboard.write([new ClipboardItem({ "image/png": bl })]).then(() => toast("The versus card is on the clipboard.", "good"), () => toast("Could not copy: use Save.", "warn"));
  }));
}

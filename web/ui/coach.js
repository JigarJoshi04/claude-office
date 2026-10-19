// The brief coach on the hiring desk (office/coach.py): how big jobs like this one have been, from similar past lanes,
// and with the analyst on, what the brief is missing, a tighter rewrite shown as a diff, and a model to give it.
// Nothing changes on the form until the CEO picks it; the rewrite has a one-step undo.
import { esc, fmtTok } from "./util.js";
import { icon } from "./icons.js";

// Word-level diff of two texts: [{t: "same" | "add" | "del", s}], whitespace kept. Too long for the table: all of a
// out, all of b in.
export function wordDiff(a, b) {
  const A = String(a || "").split(/(\s+)/).filter(Boolean), B = String(b || "").split(/(\s+)/).filter(Boolean);
  if (A.length * B.length > 4e6) return [...(A.length ? [{ t: "del", s: A.join("") }] : []), ...(B.length ? [{ t: "add", s: B.join("") }] : [])];
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [], push = (t, s) => { const l = out[out.length - 1]; if (l && l.t === t) l.s += s; else out.push({ t, s }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push("same", A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push("del", A[i++]);
    else push("add", B[j++]);
  }
  while (i < n) push("del", A[i++]);
  while (j < m) push("add", B[j++]);
  return out;
}

const KIND = { missing: ["Missing", "plus"], vague: ["Vague", "search"], risky: ["Risky", "alert"], "too big": ["Too big", "layers"], good: ["Clear", "check"] };
const OUT = { done: "done", blocked: "blocked", stopped: "stopped", failed: "failed" };
const mins = (m) => m == null ? "" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
const MODEL = (m) => m ? m[0].toUpperCase() + m.slice(1) : "";

// state: null, {pending}, {error}, or {brief, data, applied}: brief is what was read, applied once its rewrite is on
// the form (Undo puts the brief back). now: the brief on the form, so a brief changed since says so. model: the
// model chosen on the form.
export function coachHtml(state, { now, model, privacy, nameOf = (id) => id }) {
  if (!state) return "";
  if (state.pending) return `<div class="coach"><p class="hint">${icon("sparkles", 14)} Reading the brief and looking for similar past lanes…</p></div>`;
  if (state.error) return `<div class="coach err"><button class="btn sm ghost icon" data-coach-x aria-label="Close">${icon("x", 14)}</button><p>${esc(state.error)}</p></div>`;
  const d = state.data || {}, est = d.estimate, sim = d.similar || [], c = d.coach;
  const rw = ((c || {}).rewrite || "").trim(), stale = (state.applied ? rw : state.brief) !== (now || "").trim();
  const past = est
    ? `<p><b>Jobs like this:</b> ${est.n} similar lanes ran${est.minutes != null ? ` a median <b>${mins(est.minutes)}</b>` : ""}${est.tokens ? `${est.minutes != null ? " and" : ""} <b>${fmtTok(est.tokens)}</b> tokens` : ""}; ${est.done} of ${est.n} ended done.${est.models.length > 1 ? ` By model: ${est.models.map(m => `${MODEL(m.model)} ${m.done} of ${m.n}`).join(", ")}.` : ""}</p>`
    : `<p class="muted">${sim.length ? `Only ${sim.length} similar past lane${sim.length > 1 ? "s" : ""}: too few to say how big this is.` : "No similar past lanes yet, so no estimate of its size."}</p>`;
  const pr = d.price, price = pr && (pr.five_hour || pr.weekly) ? `<p class="coach-price">${icon("coin", 14)} <b>Price tag:</b> about ${[pr.five_hour ? `<b>${pr.five_hour}%</b> of ${esc(nameOf(pr.seat))}'s 5-hour window` : "", pr.weekly ? `<b>${pr.weekly}%</b> of its week` : ""].filter(Boolean).join(" and ")}, at what 1% bought it lately.</p>` : "";
  const list = sim.length ? `<details class="coach-sim"><summary>The similar lanes</summary><ul>${sim.map(r => `<li><span class="${privacy ? "private" : ""}">${esc(privacy ? "A past lane" : r.title)}</span>
      <small>${esc(MODEL(r.model))}${r.minutes != null ? ` · ${mins(r.minutes)}` : ""}${r.tokens ? ` · ${fmtTok(r.tokens)}` : ""} · <b class="o-${esc(r.outcome)}">${esc(OUT[r.outcome] || r.outcome)}</b></small></li>`).join("")}</ul></details>` : "";
  let ai = "";
  if (c) {
    const fx = (c.findings || []).map(f => { const [w, ic] = KIND[f.kind] || KIND.vague; return `<li class="k-${f.kind.replace(" ", "-")}">${icon(ic, 14)}<b>${w}</b><span>${esc(f.text)}</span></li>`; }).join("");
    const same = !rw || rw === state.brief || state.applied;
    // A light edit shows as a diff; a brief mostly rewritten reads better whole.
    const parts = same ? [] : wordDiff(state.brief, rw), kept = parts.filter(p => p.t === "same").reduce((n, p) => n + p.s.trim().length, 0);
    const whole = kept < 0.4 * rw.replace(/\s/g, "").length;
    const diff = same ? "" : whole ? esc(rw) : parts.map(p => p.t === "same" ? esc(p.s) : p.t === "add" ? `<ins>${esc(p.s)}</ins>` : `<del>${esc(p.s)}</del>`).join("");
    ai = `${fx ? `<ul class="coach-f">${fx}</ul>` : ""}
      ${c.model ? `<p class="coach-m">${icon("bot", 14)} Suggests <b>${esc(MODEL(c.model))}</b>${c.model_why ? `: ${esc(c.model_why)}` : ""}${c.model !== model ? ` <button class="btn sm" data-coach-model="${esc(c.model)}">Use ${esc(MODEL(c.model))}</button>` : " (already chosen)"}</p>` : ""}
      ${diff ? `<details class="coach-rw" ${stale ? "" : "open"}><summary>A tighter brief${whole ? ` <small>(mostly rewritten, so shown whole)</small>` : ""}</summary><div class="diff">${diff}</div>
        <div class="row" style="gap:6px;margin-top:8px"><button class="btn sm primary" data-coach-use ${stale ? "disabled title=\"The brief changed since it was read\"" : ""}>${icon("check", 14)}Use this brief</button></div></details>` : ""}`;
  } else if (d.unavailable) {
    ai = `<p class="hint">${icon("sparkles", 13)} The analyst can also read the brief and suggest a tighter one: ${esc(d.unavailable)} ${/off/i.test(d.unavailable) ? `<button class="btn sm ghost" data-go="settings">Settings</button>` : ""}</p>`;
  }
  return `<div class="coach"><button class="btn sm ghost icon" data-coach-x aria-label="Close">${icon("x", 14)}</button>
    ${stale ? `<p class="hint">${icon("alert", 13)} The brief changed since this was read. Sharpen again for a fresh look.</p>` : ""}
    ${past}${price}${list}${ai}
    ${state.applied && !stale ? `<p class="row" style="gap:8px"><span class="hint">${icon("check", 13)} The tighter brief is on the form.</span><button class="btn sm ghost" data-coach-undo>Undo</button></p>` : ""}
    <p class="hint">${d.demo ? "Demo: nothing was read." : c ? `Read by the analyst${c.cached ? " (from the cache)" : c.tokens ? `, ${fmtTok(c.tokens)} tokens` : ""}. Nothing on the form changes until you pick it.` : "Counted from this office's past lanes, by the words their briefs share."}</p></div>`;
}

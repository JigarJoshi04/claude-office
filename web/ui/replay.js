// Replay: the floor plays back the last hours from the office's own history (/api/history): who was in which room,
// what state they were in, how much plan each seat had left, and the news as it happened (reports burst into confetti,
// level-ups get their banner). Live data keeps arriving underneath and takes over again when replay ends.
import { esc, clock, toast } from "./util.js";
import { icon } from "./icons.js";

const STATE_WORD = { working: "Working", waiting: "On a long tool", idle: "Idle", limited: "Out of plan", stuck: "Quiet a while" };
const SPEEDS = [60, 180, 360, 900];
const TICK = 200;                                   // ms between replay frames

export function makeReplay(app, office, frame) {
  let hist = null, t = 0, playing = false, speed = 360, timer = 0, bar = null, lastT = 0;

  // The office as it was at time `ts`: the live snapshot's seats (names, colours, careers, settings) with the sessions,
  // states and plan usage that history recorded for that minute.
  function snapAt(ts) {
    const live = app.snap();
    const rowAt = (sid) => {
      const r = (hist.seats[sid] || {}).series || [];
      let lo = 0, hi = r.length - 1, best = null;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (r[mid][0] <= ts) { best = r[mid]; lo = mid + 1; } else hi = mid - 1; }
      return best;
    };
    const sessionsAt = (sid) => hist.sessions.filter(x => x.seat === sid).map(x => {
      const seg = x.segments.find(g => g[0] <= ts && ts <= g[1]);
      if (!seg) return null;
      return { id: x.id, name: x.name, kind: x.kind, title: x.title, state: seg[2], live: true,
        activity: x.title || STATE_WORD[seg[2]] || seg[2], activity_kind: seg[2] === "working" ? "type" : null,
        report_status: null, started_at: x.first_seen };
    }).filter(Boolean);
    const seats = live.seats.map(s => {
      const r = rowAt(s.id), sessions = sessionsAt(s.id), u = s.usage || {};
      const win = (w, pct) => pct == null ? w || null : { ...(w || {}), pct, resets_at: null, reset_since_read: false };
      const usage = { ...u, five_hour: win(u.five_hour, r ? r[1] : null), weekly: win(u.weekly, r ? r[2] : null) };
      const status = s.status === "benched" || s.status === "offline" ? s.status
        : r && r[1] != null && r[1] >= 100 ? "limited"
        : sessions.some(x => x.state === "working" || x.state === "waiting") ? "working" : "idle";
      return { ...s, sessions, usage, status };
    });
    return { ...live, now: ts, seats, attention: [], lanes: [], events: [] };
  }

  // News between two moments plays on the floor as it did live.
  function fire(from, to) {
    for (const m of hist.markers || []) {
      if (m.ts <= from || m.ts > to) continue;
      if (m.kind === "report" && m.level === "good") office.celebrate(m.seat, null, "Shipped!");
      else if (m.kind === "levelup") { const s = app.snap().seats.find(x => x.id === m.seat); office.banner("Level up!", app.humanise(m.text), s ? s.color : "#ffd24a"); }
      else if (m.kind === "limit") office.alarm(m.seat, "Out of plan");
      if (bar && ["report", "levelup", "achievement", "limit", "lane", "login"].includes(m.kind)) {
        const cap = bar.querySelector(".rp-news");
        cap.textContent = `${clock(m.ts)} · ${app.humanise(m.text)}`; cap.classList.remove("flash"); void cap.offsetWidth; cap.classList.add("flash");
      }
    }
  }

  function render() {
    office.update(snapAt(t));
    if (!bar) return;
    const span = hist.now - hist.from;
    bar.querySelector(".rp-range").value = String(Math.round(((t - hist.from) / span) * 1000));
    bar.querySelector(".rp-time").textContent = clock(t);
    frame.querySelector(".rp-badge b").textContent = clock(t);
    const btn = bar.querySelector("[data-rp-play]");
    btn.innerHTML = icon(playing ? "pause" : "play", 16); btn.setAttribute("aria-label", playing ? "Pause" : "Play"); btn.title = playing ? "Pause (space)" : "Play (space)";
  }

  function tick() {
    const next = Math.min(hist.now, t + speed * TICK / 1000);
    fire(t, next);
    t = next;
    render();
    if (t >= hist.now) pause();
  }
  function play() { if (!hist) return; if (t >= hist.now) t = hist.from; playing = true; clearInterval(timer); timer = setInterval(tick, TICK); render(); }
  function pause() { playing = false; clearInterval(timer); if (hist) render(); }

  function buildBar() {
    const span = hist.now - hist.from;
    const ticks = (hist.markers || []).filter(m => ["report", "levelup", "achievement", "limit", "login"].includes(m.kind)).map(m => {
      const k = m.kind === "report" ? (m.level === "good" ? "good" : "warn") : m.kind === "limit" || m.kind === "login" ? "bad" : "gold";
      return `<i class="rp-tick ${k}" style="left:${(((m.ts - hist.from) / span) * 100).toFixed(2)}%" title="${esc(clock(m.ts) + " · " + app.humanise(m.text))}"></i>`;
    }).join("");
    bar = document.createElement("div");
    bar.className = "replay"; bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Replay");
    bar.innerHTML = `<button class="rp-btn" data-rp-play aria-label="Play"></button>
      <div class="rp-speed" role="group" aria-label="Speed">${SPEEDS.map(v => `<button data-rp-speed="${v}" class="${v === speed ? "on" : ""}">${v}×</button>`).join("")}</div>
      <div class="rp-track"><div class="rp-ticks">${ticks}</div><input class="rp-range" type="range" min="0" max="1000" step="1" aria-label="Time"><div class="rp-ends"><span>${esc(clock(hist.from))}</span><span>now</span></div></div>
      <span class="rp-time"></span>
      <button class="rp-btn rp-live" data-rp-close title="Back to live (Esc)">${icon("x", 15)}Live</button>
      <div class="rp-news" aria-live="polite"></div>`;
    frame.appendChild(bar);
    const badge = document.createElement("div");
    badge.className = "rp-badge"; badge.innerHTML = `<i></i>Replay <b></b>`;
    frame.appendChild(badge);
    bar.querySelector("[data-rp-play]").addEventListener("click", () => (playing ? pause() : play()));
    bar.querySelectorAll("[data-rp-speed]").forEach(b => b.addEventListener("click", () => {
      speed = +b.dataset.rpSpeed; bar.querySelectorAll("[data-rp-speed]").forEach(x => x.classList.toggle("on", x === b));
    }));
    const range = bar.querySelector(".rp-range");
    range.addEventListener("input", () => { pause(); t = hist.from + (+range.value / 1000) * (hist.now - hist.from); office.reset(); render(); });   // a jump: no walking
    bar.querySelector("[data-rp-close]").addEventListener("click", close);
    bar.addEventListener("keydown", (e) => {
      if (e.key === " " && e.target === range) { e.preventDefault(); playing ? pause() : play(); }
    });
  }

  async function open(hours = 6) {
    if (hist) return;
    try {
      const r = await fetch(`/api/history?hours=${hours}`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      if (!d || !d.sessions || !d.seats) throw new Error("no history");
      hist = d;
    } catch { toast("Replay needs the office history; it is not available yet.", "warn"); return; }
    if (!hist.sessions.length) { hist = null; toast("Nothing to replay yet: the history is empty.", "info"); return; }
    speed = SPEEDS.reduce((a, v) => Math.abs(v - (hist.now - hist.from) / 60) < Math.abs(a - (hist.now - hist.from) / 60) ? v : a, 360);   // about a minute end to end
    t = hist.from; lastT = 0;
    if (!app.demo && app.badge) app.badge("time_traveller");
    frame.classList.add("replaying");
    buildBar();
    office.reset();                                  // start with everyone already at their desks
    office.setWalkBoost(4);
    render();
    play();
    bar.querySelector("[data-rp-play]").focus();
  }
  function close() {
    if (!hist) return;
    pause();
    hist = null;
    if (bar) { bar.remove(); bar = null; }
    const badge = frame.querySelector(".rp-badge"); if (badge) badge.remove();
    frame.classList.remove("replaying");
    office.setWalkBoost(1);
    office.reset();
    if (app.snap()) office.update(app.snap());
  }
  return {
    open, close,
    active: () => !!hist,
    toggle: () => (hist ? (playing ? pause() : play()) : null),
    step: (min) => { if (!hist) return; pause(); t = Math.max(hist.from, Math.min(hist.now, t + min * 60)); office.reset(); render(); },
  };
}

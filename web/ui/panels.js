// The inspector: one renderer per view. Each returns { html, bind(root) }. Plain words first, numbers second.
import { esc, fmtTok, ago, until, clock, dur, pct, live, store, toast, debounce, avatar, relTime, inWords, dayTime,
  STATE_LABEL, SEAT_LABEL } from "./util.js";
import { usageSpark, bindSparks } from "./charts.js";
import { icon } from "./icons.js";
import { personaFor, binding, leftOf, voice, diary, PERSONALITIES } from "./personas.js";
import { sound } from "./sound.js";
import { goals, goalsFor, streak, weekly } from "./goals.js";
import { officeLevel, UNLOCKS } from "../engine/unlocks.js";
import { BADGES, earned } from "./badges.js";
import { md } from "./md.js";

const TEMPLATES = [
  { name: "Fix a failing test", ic: "check", title: "Fix failing test: ", brief: "Goal: make the failing test pass without weakening it.\nWhere: <test file or CI job>\nContext: <what changed recently>\nDone when: the test passes locally and the full suite is green.\nVerify: run the suite and paste the summary in the report." },
  { name: "Investigate a bug", ic: "search", title: "Investigate: ", brief: "Symptom: <what people see>\nWhere it shows: <page, endpoint or log>\nFind the root cause and propose the smallest safe fix. Prove the cause with evidence (logs, a failing test, a query).\nDone when: the report names the cause, the evidence and the fix (or a PR if the fix is small and safe)." },
  { name: "Review a PR", ic: "flag", title: "Review PR #", brief: "Review PR #<n> in <repo> for correctness, missed edge cases and risky changes. Run its tests.\nDo not merge. Report findings ranked by severity with file:line and a concrete failure scenario." },
  { name: "Write docs", ic: "news", title: "Docs: ", brief: "Write or update the docs for <feature>.\nAudience: <who>\nCover: what it does, how to use it, the gotchas.\nDone when: the doc is in the repo and every command in it was run once." },
  { name: "Research", ic: "sparkles", title: "Research: ", brief: "Question: <the decision this informs>\nLook at: <sources, code, data>\nReport: a direct answer first, then the evidence, then open questions. Read-only: change nothing." },
  { name: "Refactor", ic: "layers", title: "Refactor: ", brief: "Refactor <module> to <goal> with no behaviour change.\nKeep every existing test green and add tests where coverage is thin.\nDone when: a PR is open with a summary of what moved and why." },
];
const KIND_ICON = { type: "terminal", read: "search", think: "sparkles", talk: "chat", delegate: "bot", wait: "clock" };
const EVENT_ICON = { levelup: "star", achievement: "trophy", arrive: "play", leave: "reply", report: "check", limit: "sleep", reset: "refresh", usage: "zap", login: "alert",
  stuck: "clock", lane: "briefcase", divider: "sliders", checkpoint: "pin", message: "send", reply: "chat", error: "alert" };

export function makePanels(app) {
  let dv = null, dvDirty = false, dvPreview = null;
  let hireDraft = store.get("hireDraft", { title: "", brief: "", workdir: "", seat: "auto", model: "", permission_mode: "", allow_messages: true });
  let settingsData = null, settingsLoading = false, newsFilter = "all", showAllNeeds = false;
  let seatTab = store.get("seatTab", "now");   // the character page's open tab, the same for every character
  const sessTab = new Map();
  const openSteps = new Set();

  const S = () => app.snap();
  const seatById = (id) => S().seats.find(s => s.id === id);
  const P = (s) => personaFor(s, S().seats.findIndex(x => x.id === s.id));
  const nameOf = (id) => { const s = seatById(id); return s ? P(s).name : id; };
  const STATUS_WORD = { READY: "ready for review", DONE: "done", BLOCKED: "blocked", FAILED: "failed", PARTIAL: "partly done", COMPLETE: "done", SUCCESS: "done" };
  const humanise = (text) => {
    let t = String(text || "");
    for (const s of S().seats) {
      const n = P(s).name;   // seat labels and seat ids both read as the character's name
      for (const k of new Set([s.label, s.id])) if (k && k !== n) t = t.replace(new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(?![-\\w])`, "g"), n);
    }
    // Plain words for the machine-shaped lines: "wt-x filed its report: STATUS: READY #12" reads "x finished: ready for review · #12".
    return t.replace(/\bwt-(?=\w)/g, "")
      .replace(/ filed its report: STATUS:\s*([A-Za-z_]+)\s*(?:[-–—:·]\s*)?(.*)$/, (m, st, rest) => ` finished: ${STATUS_WORD[st.toUpperCase()] || st.toLowerCase().replace(/_/g, " ")}${rest.trim() ? " · " + rest.trim() : ""}`)
      .replace(/ sat down at ([\w .'-]+?) \((?:lane|terminal)\)$/, " started at $1's desk")
      .replace(/ left ([A-Z][\w'-]*)$/, " left $1's room")
      .replace(/^CEO (updated|changed|hired|stopped|sent)\b/, "You $1");
  };
  const crumbs = (...parts) => `<nav class="crumbs"><button data-go="ceo">Office</button>${parts.map(x => `${icon("chevronRight", 14)}${x}`).join("")}</nav>`;
  const priv = (sess, text) => app.privacy() && sess && sess.kind === "desk" ? `<span class="private">${esc(text || "")}</span>` : esc(text || "");
  const privMd = (sess, text) => app.privacy() && sess && sess.kind === "desk" ? `<span class="private">${esc(text || "")}</span>` : `<div class="md">${md(text)}</div>`;   // chat text, formatted
  const section = (title, body, extra = "") => `<div class="section"><div class="section-h"><h4>${title}</h4>${extra}</div>${body}</div>`;
  const pill = (text, tone = "", ic = "") => `<span class="pill ${tone}">${ic ? icon(ic, 14) : ""}${esc(text)}</span>`;
  const bar = (left, cls = "minibar") => `<div class="${cls} ${left != null && left < 15 ? "low" : left != null && left < 35 ? "mid" : ""}"><i style="width:${left == null ? 0 : left}%"></i></div>`;
  const tone = (lvl) => ({ bad: "bad", warn: "warn", good: "good" }[lvl] || "info");
  // A ring gauge: how much plan is left, coloured by the seat (red when nearly out).
  const ring = (left, color, size = 46, sub = "") => {
    const r = 18, len = 2 * Math.PI * r, f = left == null ? 0 : Math.max(0, Math.min(1, left / 100));
    const c = left != null && left < 15 ? "var(--bad)" : left != null && left < 35 ? "var(--warn)" : color;
    return `<span class="gring" style="--ring:${c};width:${size}px;height:${size}px"><svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="${r}" class="trk"/><circle cx="22" cy="22" r="${r}" class="val" stroke-dasharray="${(len * f).toFixed(1)} ${len.toFixed(1)}"/></svg><b>${left == null ? "–" : Math.round(left)}<small>%</small></b>${sub ? `<i>${esc(sub)}</i>` : ""}</span>`;
  };
  const say = (s) => voice(s, P(s), dayTime);
  // Writes in the demo office do nothing, so never claim they worked.
  const result = (r, msg, lvl = "good") => toast(r && r.demo ? "Demo office: nothing was changed." : msg, r && r.demo ? "info" : lvl);
  let dragging = false;   // a divider handle is held: refreshes must not rebuild the panel under the pointer

  function actRow(e) {
    return `<div class="act ${tone(e.level)} ${e.seat ? "click" : ""}" ${e.seat ? `data-seat="${esc(e.seat)}"` : ""}>${icon(EVENT_ICON[e.kind] || "dot", 16)}<span>${esc(humanise(e.text))}</span><span class="when">${relTime(e.ts)}</span></div>`;
  }
  function memberRow(s) {
    const p = P(s), v = say(s), m = { mood: v.word, tone: v.tone, detail: v.line }, b = binding(s);
    return `<div class="member" style="--seat:${s.color}" data-seat="${esc(s.id)}">
      ${avatar("mascot-" + s.id, s.color, (s.status === "offline" ? "dim," : "") + "lv" + (s.career ? s.career.level : 0))}
      <div class="nm">${esc(p.name)} <small>${esc(p.role)}</small></div>
      <div class="gauge"><div class="v">${b.left == null ? "–" : Math.round(b.left) + "%"}</div><div class="l">${b.left == null ? "no reading" : "of " + b.label + " left"}</div>${bar(b.left)}</div>
      <div class="md"><b class="${m.tone}">${esc(m.mood)}</b> · ${esc(m.detail)}</div>
    </div>`;
  }
  function laneRow(l) {
    const tn = { done: "good", finished: "good", running: "info", blocked: "warn", failed: "bad", waiting: "warn" }[l.status] || "info";
    return `<div class="need ${tn}" data-lane="${esc(l.id)}"><span class="ico">${icon({ done: "check", finished: "check", running: "play", blocked: "alert", failed: "alert", waiting: "clock", stopped: "stop" }[l.status] || "briefcase", 16)}</span>
      <div class="grow"><div class="t">${esc(l.title)}</div><div class="d">${esc(l.status)}${l.seat ? " on " + esc(nameOf(l.seat)) : ""} · ${relTime(l.created_at)}${l.report_status ? " · " + esc(l.report_status.replace(/^STATUS:\s*/, "")) : ""}</div></div></div>`;
  }

  // ---------------------------------------------------------------------------------------- briefing
  // "While you were away": one line with the counts; the few things worth reading first open on demand.
  let awayOpen = false;
  function awayHtml() {
    const a = app.away();
    if (!a) return "";
    const it = a.items, by = (k, pred = () => true) => it.filter(m => m.kind === k && pred(m)).length;
    const hrs = Math.max(1, Math.round((S().now - a.since) / 3600));
    const say = (n, one, many) => n === 1 ? one : many;
    const chips = [[by("report", m => m.level === "good"), "report filed", "reports filed"], [by("levelup"), "level-up", "level-ups"],
      [by("achievement"), "trophy", "trophies"], [by("lane", m => m.level === "good"), "lane finished", "lanes finished"],
      [by("limit"), "limit hit", "limits hit"], [by("report", m => m.level === "warn") + by("lane", m => m.level === "bad"), "blocked or failed", "blocked or failed"]]
      .filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${say(n, one, many)}`);
    const rank = (m) => (m.level === "bad" ? 0 : m.level === "warn" ? 1 : { report: 2, levelup: 3, achievement: 4, lane: 5 }[m.kind] ?? 6);
    const top = [...it].sort((x, y) => rank(x) - rank(y) || y.ts - x.ts).slice(0, 6);
    return `<div class="away${awayOpen ? " open" : ""}">
      <div class="away-top">${icon("sparkles", 18)}<div class="grow"><div class="eyebrow">While you were away · ${hrs} h</div>
        <b>${it.length ? esc(chips.slice(0, 3).join(", ") || `${it.length} updates`) : "Quiet: nothing changed."}</b></div>
        ${it.length ? `<button class="btn sm ghost" data-away-toggle aria-expanded="${awayOpen}">${awayOpen ? "Hide" : "What happened"}${icon(awayOpen ? "chevronDown" : "chevronRight", 14)}</button>` : ""}
        <button class="btn sm ghost icon" data-dismiss-away aria-label="Dismiss" title="Dismiss">${icon("x", 16)}</button></div>
      ${awayOpen ? `<div class="away-list">${top.map(m => `<div class="act ${tone(m.level)} ${m.seat ? "click" : ""}" ${m.seat ? `data-seat="${esc(m.seat)}"` : ""}>${icon(EVENT_ICON[m.kind] || "dot", 16)}<span>${esc(humanise(m.text))}</span><span class="when">${relTime(m.ts)}</span></div>`).join("")}</div>` : ""}</div>`;
  }
  // The day's rhythm: a morning card recaps yesterday and names today's goals; an evening card wraps the day up and
  // offers its picture. Each shows once a day until dismissed (per browser).
  function rhythmHtml() {
    const h = new Date().getHours(), st = app.statsCache(null), wk = app.weekCache(), ceo = (S().office.ceo || {}).name;
    if (!st || st.unavailable || !st.day) return "";
    const seen = store.get("rhythm", {}), sum = (o, k) => Object.values(o.seats || {}).reduce((a, x) => a + (x[k] || 0), 0);
    const hrs = (m) => m >= 600 ? Math.round(m / 60) + " h" : (m / 60).toFixed(1) + " h";
    if (h >= 5 && h < 11 && !seen["am-" + st.day]) {
      const y = wk && wk.length >= 2 ? wk[wk.length - 2] : null;
      const recap = y && (y.reports || y.active_min) ? `Yesterday: ${y.reports} report${y.reports === 1 ? "" : "s"} and ${hrs(y.active_min)} of agent work.` : "A fresh day.";
      return `<div class="rhythm am">${icon("sun", 20)}<div class="grow"><b>Good morning${ceo && ceo !== "CEO" ? ", " + esc(ceo) : ""}.</b>
        <span>${esc(recap)} Today's goals: ${goalsFor(st.day).map(g => esc(g.label.toLowerCase())).join(", ")}.</span></div>
        <button class="btn sm ghost icon" data-rhythm="am-${esc(st.day)}" aria-label="Dismiss" title="Dismiss">${icon("x", 15)}</button></div>`;
    }
    if (h >= 18 && !seen["pm-" + st.day] && ((st.office || {}).reports || sum(st, "active_min"))) {
      return `<div class="rhythm pm">${icon("moon", 20)}<div class="grow"><b>That's a wrap.</b>
        <span>Today: ${(st.office || {}).reports || 0} report${(st.office || {}).reports === 1 ? "" : "s"}, ${hrs(sum(st, "active_min"))} of agent work${st.mvp && seatById(st.mvp.seat) ? `, and ${esc(P(seatById(st.mvp.seat)).name)} was the star` : ""}.</span></div>
        <button class="btn sm" data-share-day>Share the day</button>
        <button class="btn sm ghost icon" data-rhythm="pm-${esc(st.day)}" aria-label="Dismiss" title="Dismiss">${icon("x", 15)}</button></div>`;
    }
    return "";
  }
  // The weekly challenge (goals.js weekly): beat last week's reports.
  function weeklyHtml() {
    const w = weekly(app.weekCache());
    if (!w) return "";
    if (w.calibrating) return `<div class="weekly calib"><span class="wk-ic">${icon("flame", 18)}</span><div class="grow"><div class="wk-t"><b>Weekly challenge</b></div>
      <div class="hint">Starts once the office has a week on record: then the goal is to beat last week.</div></div></div>`;
    return `<div class="weekly ${w.done ? "done" : ""}"><span class="wk-ic">${icon(w.done ? "trophy" : "flame", 18)}</span>
      <div class="grow"><div class="wk-t"><b>${w.done ? "Record week!" : "Beat last week"}</b><span>${w.have} of ${w.target} reports${w.done ? "" : ` · ${w.daysLeft === 0 ? "last day" : w.daysLeft + " day" + (w.daysLeft === 1 ? "" : "s") + " left"}`}</span></div>
      <div class="wk-bar"><i style="width:${Math.round(w.f * 100)}%"></i></div>
      <div class="hint">${w.done ? `Beat last week's ${w.last}. Keep going.` : `Last week: ${w.last} reports. The target is 10% more.`}</div></div></div>`;
  }
  // Today's goals as three small rings (web/ui/goals.js); a finished day folds into one gold line.
  function goalsHtml() {
    const st = app.statsCache(null), gl = goals(st);
    if (!gl) return "";
    const done = gl.filter(g => g.done).length, run = streak(store.get("goalDays", []), st.day);
    const flame = run >= 2 ? `<span class="streak" title="Days in a row with every goal done">${icon("flame", 14)}${run}-day streak</span>` : "";
    if (done === gl.length) return `<div class="goals-done">${icon("trophy", 18)}<span><b>All three goals done today.</b> New ones at midnight.</span>${flame}<button class="btn sm" data-share-day>Share the day</button></div>`;
    const r = 17, len = 2 * Math.PI * r;
    return `<section class="b-sec"><h3 class="b-h">Today's goals<span class="count">${done}/${gl.length}</span><span class="grow"></span>${flame}</h3><div class="goals">${gl.map(g => `
      <div class="goal${g.done ? " done" : ""}" title="${esc(g.label)}: ${esc(g.text)}"><span class="g-ring"><svg class="g-arc" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="${r}" class="trk"/><circle cx="20" cy="20" r="${r}" class="val" stroke-dasharray="${(len * g.f).toFixed(1)} ${len.toFixed(1)}"/></svg>${icon(g.done ? "check" : g.icon, 16)}</span>
        <span class="g-txt"><b>${esc(g.label)}</b><small>${esc(g.text)}</small></span></div>`).join("")}</div></section>`;
  }
  // One fix per kind of problem, so every item in Needs you has a next step.
  function needAction(a) {
    const st = a.seat && seatById(a.seat);
    if (/logged out/i.test(a.text) && st && st.kind === "claude") return `<button class="btn sm" data-copy="CLAUDE_CONFIG_DIR=${esc(st.config_dir)} claude" data-copy-note="Paste it in a terminal, then type /login.">${icon("copy", 14)}Login command</button>`;
    if (a.session) return `<button class="btn sm" data-open-session="${esc(a.seat)}|${esc(a.session)}">${icon("chat", 14)}Open</button>`;
    if (a.lane) return `<button class="btn sm" data-lane-go="${esc(a.lane)}">${icon("briefcase", 14)}Open</button>`;
    if (a.unit) return `<button class="btn sm" data-go="services">${icon("server", 14)}Open</button>`;
    if (a.seat) return `<button class="btn sm" data-seat-go="${esc(a.seat)}">Open</button>`;
    return "";
  }
  // One row per character: who, how they feel (in their words on hover), and how much plan is left.
  function mate(s) {
    const p = P(s), v = say(s), b = binding(s), c = s.career;
    const left = b.left == null ? null : Math.round(b.left);
    const lvl = left != null && left < 15 ? "low" : left != null && left < 35 ? "mid" : "";
    return `<button class="mate st-${v.state}" style="--seat:${esc(s.color)}" data-seat-go="${esc(s.id)}" data-spot="${esc(s.id)}" title="${esc(p.name)}: “${esc(v.line)}”">
      ${avatar("mascot-" + s.id, s.color, (s.status === "offline" ? "dim," : "") + "lv" + (s.career ? s.career.level : 0))}
      <span class="m-who"><span class="m-name">${esc(p.name)}${c ? `<em>Lv ${c.level}</em>` : ""}</span><span class="m-word ${v.tone}"><i></i>${esc(v.word)}</span></span>
      <span class="m-plan ${lvl}"><span class="m-num"><b>${left == null ? "–" : left + "%"}</b><small>${left == null ? "no reading" : b.key === "weekly" ? "week left" : "5 h left"}</small></span><span class="m-bar"><i style="width:${left ?? 0}%"></i></span></span>
    </button>`;
  }
  // Needs you, grouped: everything caused by one seat being out of plan becomes one line about that seat.
  function needs(snap) {
    const out = [], spent = new Map(), nearly = new Map();
    for (const a of snap.attention || []) {
      const st = a.seat && seatById(a.seat);
      const planItem = /usage at \d+%|stopped by the usage limit|runs out of its/i.test(a.text);
      // A seat close to its limit says so once: "Orion has 1% of its 5-hour window left, out in ~2 min".
      const use = /(5-hour|weekly|week) usage at (\d+)%/i.exec(a.text), eta = /runs out of its (5-hour|weekly|week)\S* window in (~?[\d.]+ \w+)/i.exec(a.text);
      if (st && st.status !== "limited" && (use || eta)) {
        const g = nearly.get(st.id) || { level: "warn", seat: st.id, grouped: false, nearly: true };
        if (a.level === "bad") g.level = "bad";
        if (use) { g.pct = +use[2]; g.win = use[1]; }
        if (eta) { g.eta = eta[2]; g.win = g.win || eta[1]; }
        g.resets_at = g.resets_at || a.resets_at;
        if (!nearly.has(st.id)) { nearly.set(st.id, g); out.push(g); }
        continue;
      }
      if (st && st.status === "limited" && planItem) {
        const g = spent.get(st.id) || { level: "bad", seat: st.id, paused: 0, resets_at: null, grouped: true };
        if (/stopped by the usage limit/i.test(a.text)) g.paused++;
        g.resets_at = g.resets_at || a.resets_at;
        if (!spent.has(st.id)) { spent.set(st.id, g); out.push(g); }
        continue;
      }
      out.push(a);
    }
    for (const g of nearly.values()) {
      const win = /week/i.test(g.win || "") ? "weekly plan" : "5-hour window", name = P(seatById(g.seat)).name;
      g.text = g.pct != null ? `${name} has ${Math.max(0, 100 - g.pct)}% of its ${win} left${g.eta ? `, out in ${g.eta}` : ""}`
        : `${name} runs out of its ${win} in ${g.eta} at this pace`;
    }
        for (const g of spent.values()) {
      const st = seatById(g.seat), w = binding(st), r = g.resets_at || (w.key && st.usage[w.key] && st.usage[w.key].resets_at);
      g.text = `${P(st).name} is out of plan${g.paused ? `: ${g.paused} session${g.paused === 1 ? "" : "s"} paused` : ""}`;
      g.resets_at = r;
    }
    return out;
  }
  function ceo() {
    const snap = S(), t = snap.totals || {};
    const att = needs(snap);
    const shown = showAllNeeds ? att : att.slice(0, 3);
    const np = snap.next_pick, next = np.seat && seatById(np.seat);
    // Sessions by what they are doing: stopped ones (out of plan, stuck) are not "idle".
    const all = snap.seats.flatMap(s => live(s));
    const working = all.filter(x => x.state === "working" || x.state === "waiting").length;
    const stopped = all.filter(x => x.state === "limited" || x.state === "stuck").length;
    const idle = all.length - working - stopped;
    const num = (n, label, dot, tip = "") => `<div class="b-n ${n ? "" : "zero"}"${tip ? ` title="${tip}"` : ""}><b>${n}</b><span><i class="sdot ${dot}"></i>${label}</span></div>`;
    // Three blocks, always in this order: how the office is doing, what needs you, who is on the team.
    return { html: `${awayHtml()}${rhythmHtml()}
      ${snap.office.config_error ? `<div class="need bad"><span class="ico">${icon("alert", 16)}</span><div class="grow"><div class="t">Config problem</div><div class="d">${esc(snap.office.config_error)}</div></div></div>` : ""}
      <section class="b-status" aria-label="Sessions right now">
        <div class="b-nums">${num(working, "Working", "working")}${num(idle, "Idle", "idle")}${num(stopped, "Stopped", "limited", "Out of plan or stuck")}</div>
        <button class="b-next" data-go="divider" title="How new lanes are divided">${icon("sliders", 16)}<span>${next ? `Next lane goes to <b style="color:${esc(next.color)}">${esc(P(next).name)}</b>` : "No seat can take a new lane right now"}</span>${icon("chevronRight", 16)}</button>
      </section>
      ${!snap.seats.length ? `<div class="welcome"><h3>No seats yet</h3><p>Claude Office looks for <code>~/.claude</code>, <code>~/.claude2</code>, … and <code>~/.codex</code>. Log in with <code>claude</code> (or <code>CLAUDE_CONFIG_DIR=~/.claude2 claude</code> for a second account) and the desks appear here within a few seconds.</p></div>` : ""}
      ${att.length ? `<section class="b-sec"><h3 class="b-h needs">${icon("alert", 16)}Needs you<span class="count">${att.length}</span></h3>${shown.map(a => `<div class="g-need ${a.level}">
          <span class="grow"><span class="t">${esc(humanise(a.text))}</span>${a.resets_at ? `<span class="d">${a.grouped ? "Back" : "Resets"} ${dayTime(a.resets_at)} · ${inWords(a.resets_at)}</span>` : ""}</span>${needAction(a)}</div>`).join("")}
          ${att.length > 3 ? `<button class="btn sm ghost b-more" data-toggle-needs>${showAllNeeds ? "Show less" : `Show all ${att.length}`}</button>` : ""}</section>`
        : `<div class="g-clear">${icon("check", 16)}All clear. Nothing needs you.</div>`}
      ${goalsHtml()}
      ${weeklyHtml()}
      ${snap.seats.length ? `<section class="b-sec"><h3 class="b-h">Team<span class="count">${snap.seats.length}</span></h3>
      <div class="crew">${snap.seats.map(mate).join("")}</div></section>` : ""}
      <nav class="b-links" aria-label="More">
        <button data-go="news">${icon("news", 16)}News</button><button data-go="trophies">${icon("trophy", 16)}Trophies</button>
        <button data-go="services">${icon("server", 16)}Services</button><button data-go="divider">${icon("sliders", 16)}Divider</button></nav>`,
      bind(root) {
        const da = root.querySelector("[data-dismiss-away]"); if (da) da.addEventListener("click", () => app.dismissAway());
        root.querySelectorAll("[data-share-day]").forEach(b => b.addEventListener("click", () => app.shareDay()));
        root.querySelectorAll("[data-rhythm]").forEach(b => b.addEventListener("click", () => { store.set("rhythm", { ...store.get("rhythm", {}), [b.dataset.rhythm]: 1 }); app.rerender(true); }));
        const at = root.querySelector("[data-away-toggle]"); if (at) at.addEventListener("click", () => { awayOpen = !awayOpen; app.rerender(true); });
        const t2 = root.querySelector("[data-toggle-needs]"); if (t2) t2.addEventListener("click", () => { showAllNeeds = !showAllNeeds; app.rerender(true); });
        root.querySelectorAll("[data-open-session]").forEach(b => b.addEventListener("click", () => { const [seat, id] = b.dataset.openSession.split("|"); app.go({ kind: "session", seat, id }); }));
        root.querySelectorAll("[data-lane-go]").forEach(b => b.addEventListener("click", () => app.go({ kind: "lane", id: b.dataset.laneGo })));
      } };
  }
  function progCard(p) {
    const done = p.sessions.filter(s => s.report_status).length;
    return `<div class="card" style="margin-bottom:8px"><div class="row between"><b>${esc(p.name)}</b>${p.url ? `<a class="pill info" href="${esc(p.url)}" target="_blank" rel="noopener">${icon("external", 13)}Mission Control</a>` : ""}</div>
      <div class="muted" style="font-size:13px;margin-top:4px">${p.sessions.length} at work${done ? ` · ${done} reported` : ""} · ${[...new Set(p.sessions.map(s => nameOf(s.seat)))].map(esc).join(", ")}</div></div>`;
  }

  // -------------------------------------------------------------------------------------------- seat
  function seat(v) {
    const s = seatById(v.seat);
    if (!s) return { html: crumbs("Gone") + `<div class="allclear">That seat is no longer here.</div>` };
    const p = P(s), u = s.usage || {}, a = s.account || {}, h = s.health || {}, sc = s.divider || {}, fc = s.forecast || {};
    const L = live(s);
    const hist = app.historyCache(6);
    const ser = hist && hist.seats && hist.seats[s.id] ? hist.seats[s.id].series : [];
    const recent = (S().events || []).filter(e => e.seat === s.id).slice(-5).reverse();
    const f5 = fc.five_hour || {};
    const paceText = s.status === "limited" ? { cls: "bad", ic: "sleep", t: "Out of plan. The desk wakes up when the window resets." }
      : f5.state === "runs_out" ? { cls: "bad", ic: "zap", t: `At ${f5.per_hour}% an hour it runs out ${dayTime(f5.out_at)}, ${until(S().now + (f5.margin_s || 0))} before the reset.` }
      : f5.state === "lasts" ? { cls: "good", ic: "check", t: `At ${f5.per_hour}% an hour it lasts until the reset.` }
      : f5.state === "paused" ? { cls: "", ic: "coffee", t: `Resting now. It was burning ${f5.per_hour}% an hour.` }
      : f5.state === "flat" ? { cls: "good", ic: "coffee", t: "Not using its plan right now." }
      : { cls: "", ic: "clock", t: "Learning the pace: a reading every few minutes." };
    const vo = say(s), today = (app.statsCache(null) || {}).seats, dstats = today && today[s.id];
    const planRing = (key, label) => {
      const w = u[key], left = leftOf(s, key);
      const when = w && w.resets_at ? `${s.status === "limited" && key === binding(s).key ? "Back" : "Resets"} ${dayTime(w.resets_at)}` : w && w.reset_since_read ? "Reset since the last reading" : left == null ? "No reading yet" : "Reset time unknown";
      return `<div class="pring">${ring(left, s.color, 58)}<div><b>${label}</b><small>${when}</small>${w && w.resets_at ? `<small>${inWords(w.resets_at)}</small>` : ""}</div></div>`;
    };
    const cmd = s.kind === "claude" ? `CLAUDE_CONFIG_DIR=${s.config_dir} claude` : `gpt -w -C <folder> "task"`;
    const tabs = [["now", "Now", "clock"], ["career", "Career", "trophy"], ["settings", "Settings", "sliders"]];
    const tab = tabs.some(([k]) => k === seatTab) && (s.career || seatTab !== "career") ? seatTab : "now";
    const body = tab === "career" ? `${levelRow(s)}${careerHtml(s)}`
      : tab === "settings" ? `${section("Duty", `<div class="duty"><div class="grow"><b>${sc.enabled ? "On duty" : "On holiday"}</b>
          <span>${sc.enabled ? `Gets ${sc.weight}% of new lanes, up to ${sc.max_lanes} at once. Running ${s.lanes} now.` : "No new lanes go here."}${sc.note ? " " + esc(sc.note) : ""}</span></div>
          <label class="switch" title="On duty"><input type="checkbox" id="seatDuty" ${sc.enabled ? "checked" : ""} aria-label="On duty"><span></span></label></div>`)}
        ${section(s.kind === "claude" ? "Open this seat in a terminal" : "Give Codex a task", `<div class="copy"><code>${esc(cmd)}</code><button class="btn sm" data-copy="${esc(cmd)}">${icon("copy", 14)}Copy</button></div>`)}
        ${section("Account", `<dl class="facts">${app.privacy() ? `<dt>Account</dt><dd>Hidden (share-safe)</dd>` : [["Name", a.name], ["Email", a.email]].filter(([, x]) => x).map(([k, x]) => `<dt>${k}</dt><dd>${esc(x)}</dd>`).join("")}
          ${h.tier ? `<dt>Plan</dt><dd>${esc(h.tier)}</dd>` : ""}${h.detail ? `<dt>Status</dt><dd>${esc(h.detail)}</dd>` : ""}<dt>Seat</dt><dd>${esc(s.label)}</dd></dl>`)}`
      : `${section(`At the desk · ${L.length}`, L.length ? L.map(x => sessRow(s, x)).join("") : `<div class="empty">${s.status === "limited" ? "Everyone went home: the seat is out of plan." : "Nobody here right now."}</div>`)}
        ${section("Today", `<div class="diary">${icon("news", 16)}<span>${esc(diary(p, dstats))}</span></div>`)}
        ${section("Plan, last 6 hours", `<div class="card">${usageSpark(ser.map(r => [r[0], r[1]]), { color: s.color, now: S().now, reset: u.five_hour && u.five_hour.resets_at, forecast: fc.five_hour, label: p.name + " 5-hour window" })}
          <div class="hint" style="margin-top:6px">5-hour window used; the dashed line is the current pace.${u.fetched_at ? ` Read ${relTime(u.fetched_at)}${u.stale ? " (stale: the login refreshes on its next run)" : ""}.` : ""}</div></div>`)}
        ${recent.length ? section("Recently", recent.slice(0, 3).map(actRow).join("")) : ""}`;
    return { html: `${crumbs(esc(p.name))}
      <div class="hero st-${vo.state}" style="--seat:${esc(s.color)}">
        <button class="btn sm ghost icon h-find" data-focus-seat="${esc(s.id)}" title="Show on the floor" aria-label="Show on the floor">${icon("target", 16)}</button>
        <div class="h-top">${avatar("mascot-" + s.id, s.color, (s.status === "offline" ? "dim," : "") + "lv" + (s.career ? s.career.level : 0), "big")}
          <div class="grow"><h2>${esc(p.name)}</h2><div class="role">${esc(p.role)}${s.career ? ` · Level ${s.career.level} ${esc(s.career.title)}` : ""}</div>
          <span class="m-word ${vo.tone}"><i></i>${esc(vo.word)}</span></div></div>
        <blockquote class="voice">“${esc(vo.line)}”</blockquote>
      </div>
      <div class="prings">${planRing("five_hour", "5 hours")}${planRing("weekly", "This week")}</div>
      <div class="pace ${paceText.cls}">${icon(paceText.ic, 17)}<span>${esc(paceText.t)}</span>${s.kind === "claude" ? `<button class="btn sm ghost" data-refresh="${esc(s.id)}" title="Read the plan now" aria-label="Read the plan now">${icon("refresh", 14)}</button>` : ""}</div>
      <div class="stabs" role="tablist" aria-label="${esc(p.name)}">${tabs.filter(([k]) => k !== "career" || s.career).map(([k, label, ic]) => `<button role="tab" data-seat-tab="${k}" aria-selected="${tab === k}" class="${tab === k ? "on" : ""}">${icon(ic, 15)}${label}</button>`).join("")}</div>
      <div class="stabs-body" role="tabpanel">${body}</div>`,
      bind(root) {
        bindSparks(root);
        const pick = (k) => { seatTab = k; store.set("seatTab", k); app.rerender(true); const t = root.querySelector(`[data-seat-tab="${k}"]`); if (t) t.focus(); };
        root.querySelectorAll("[data-seat-tab]").forEach((b, i, all) => {
          b.addEventListener("click", () => pick(b.dataset.seatTab));
          b.addEventListener("keydown", (e) => {   // arrow keys move between tabs, as in any tab list
            const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (d) { e.preventDefault(); pick(all[(i + d + all.length) % all.length].dataset.seatTab); }
          });
        });
        root.querySelectorAll("[data-badge]").forEach(b => b.addEventListener("click", () => { badgeSel = badgeSel === b.dataset.badge ? null : b.dataset.badge; app.rerender(true); }));
        const duty = root.querySelector("#seatDuty");
        if (duty) duty.addEventListener("change", async () => {
          const cfg = JSON.parse(JSON.stringify(S().divider)); cfg.seats[s.id].enabled = duty.checked;
          try { const r = await app.post("/api/divider", cfg); result(r, duty.checked ? `${p.name} is back on duty.` : `${p.name} is on holiday: no new lanes go there.`); app.refresh(); }
          catch (e) { toast(e.message, "bad"); duty.checked = !duty.checked; }
        });
      } };
  }
  // Career: level, XP and achievements, earned from real work (office/career.py).
  const PERKS = [[3, "a mug"], [5, "a team badge for everyone at the desk"], [6, "a desk plant"], [9, "team caps"], [10, "a gold cup"], [13, "sunglasses"],
    [15, "a glowing desk"], [18, "gold headphones"], [20, "a pennant"], [30, "gold trim"]];   // web/engine/sprites.js drawDeskPerks and GEAR_LEVELS
  function levelRow(s) {
    const c = s.career;
    if (!c) return "";
    const perk = PERKS.find(([lv]) => lv > c.level);
    const pct = Math.round(c.progress * 100), r = 19, len = 2 * Math.PI * r;
    return `<div class="level" style="--seat:${esc(s.color)}">
      <svg class="ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="${r}" class="trk"/><circle cx="24" cy="24" r="${r}" class="val" stroke-dasharray="${(len * c.progress).toFixed(1)} ${len.toFixed(1)}"/><text x="24" y="28.5">${c.level}</text></svg>
      <div class="grow"><div class="lt"><b>Level ${c.level} · ${esc(c.title)}</b><span>${c.xp.toLocaleString()} XP</span></div>
        <div class="xpbar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress to level ${c.level + 1}"><i style="width:${pct}%"></i></div>
        <div class="hint">${(c.next_xp - c.xp).toLocaleString()} XP to level ${c.level + 1}${c.streak > 1 ? ` · ${icon("flame", 13)} ${c.streak}-day streak` : ""}</div>
        ${perk ? `<div class="hint perk">${icon("sparkles", 13)} At level ${perk[0]}: ${perk[1]}</div>` : ""}</div></div>`;
  }
  let badgeSel = null;   // the trophy whose details are open, kept across refreshes
  // How close each countable achievement is, for the "next up" nudge.
  const GOALS = { first_hour: (c) => [c.stats.hours, 1, "hour at work"], paper_trail: (c) => [c.stats.reports, 10, "reports"],
    first_report: (c) => [c.stats.reports, 1, "report"], hands_1k: (c) => [c.stats.tool_calls, 1000, "tool calls"],
    hands_10k: (c) => [c.stats.tool_calls, 10000, "tool calls"], tokens_10m: (c) => [c.stats.tokens, 1e7, "tokens"],
    regular: (c) => [c.streak, 3, "days in a row"], week_streak: (c) => [c.streak, 7, "days in a row"], level_10: (c) => [c.level, 10, "levels"] };
  function careerHtml(s) {
    const c = s.career, cat = S().achievements || [];
    if (!c) return "";
    const st = c.stats, got = cat.filter(a => c.unlocked[a.id]);
    const big = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : (+n).toLocaleString();
    const tiles = [["At work", Math.round(st.hours).toLocaleString() + " h"], ["Tool calls", big(st.tool_calls)], ["Reports", big(st.reports)], ["Tokens", big(st.tokens)]];
    const order = [...got.sort((a, b) => c.unlocked[b.id] - c.unlocked[a.id]), ...cat.filter(a => !c.unlocked[a.id])];
    const next = cat.filter(a => !c.unlocked[a.id] && GOALS[a.id]).map(a => { const [have, need, unit] = GOALS[a.id](c); return { a, have, need, unit, f: Math.min(0.99, have / need) }; })
      .sort((x, y) => y.f - x.f)[0];
    const sel = order.find(a => a.id === badgeSel);
    const info = sel ? `<div class="badge-info"><b>${esc(sel.name)}</b> · ${esc(sel.desc)}${c.unlocked[sel.id] ? ` · unlocked ${esc(dayTime(c.unlocked[sel.id]))}` : " · not yet"}</div>` : "";
    return `<div class="career" style="--seat:${esc(s.color)}">` + section(`Achievements · ${got.length} of ${cat.length}`,
      `<div class="cstats">${tiles.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join("")}</div>
      ${next ? `<div class="nextup">${icon("target", 16)}<div class="grow"><div><b>Next up: ${esc(next.a.name)}</b> <span>${big(Math.floor(next.have))} of ${big(next.need)} ${esc(next.unit)}</span></div><div class="xpbar"><i style="width:${Math.round(next.f * 100)}%"></i></div></div></div>` : ""}
      <div class="badges" role="list">${order.map(a => { const at = c.unlocked[a.id];
        return `<button class="badge ${at ? "on" : ""} ${a.id === badgeSel ? "sel" : ""}" data-badge="${esc(a.id)}" role="listitem" title="${esc(a.name)}: ${esc(a.desc)}" aria-label="${esc(a.name)}, ${at ? "unlocked" : "locked"}: ${esc(a.desc)}"><span class="b-ic">${icon(at ? a.icon : "lock", 18)}</span><b>${esc(a.name)}</b></button>`; }).join("")}</div>
      ${info}
      <div class="hint" style="margin-top:10px">XP: 1 per tool call, 2 per minute at work, 10 per session, 100 per report.${c.since ? ` Counting since ${esc(new Date(c.since * 1000).toLocaleDateString([], { day: "numeric", month: "short" }))}.` : ""}</div>`) + "</div>";
  }
  function sessRow(s, x) {
    const label = x.title && x.kind === "desk" ? x.title : x.activity;
    return `<div class="sess" data-seat="${esc(s.id)}" data-id="${esc(x.id)}">${avatar(x.id, s.color, x.kind === "desk" ? "headset" : "")}
      <span class="nm"><span class="sdot ${x.state}"></span>${esc(x.name)}</span><span class="pill">${x.kind === "lane" ? "Lane" : "Terminal"}</span>
      <span class="ac">${priv(x, label)}</span></div>`;
  }

  // ----------------------------------------------------------------------------------------- session
  function session(v) {
    const s = seatById(v.seat), x = s && s.sessions.find(z => z.id === v.id);
    const conv = app.chatFor(v.seat, v.id);
    if (!s) return { html: crumbs("Gone") };
    if (!x && !conv) return { html: crumbs(`<button data-seat-go="${esc(s.id)}">${esc(P(s).name)}</button>`) + `<div class="skeleton"></div><div class="skeleton" style="width:60%"></div>` };
    const name = x ? x.name : (conv && conv.name) || v.id.slice(0, 8);
    const talk = x ? x.talk : conv ? conv.delivery : "followup";
    const tab = sessTab.get(v.id) || (talk === "none" ? "overview" : "chat");
    return { html: `${crumbs(`<button data-seat-go="${esc(s.id)}">${esc(P(s).name)}</button>`, esc(name))}
      <div class="row" style="gap:14px">${avatar(x ? x.id : v.id, s.color, x && x.kind === "desk" ? "headset" : "", "big")}
        <div class="grow"><h2 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</h2>
        <div class="row wrap" style="gap:6px;margin-top:6px">
          ${x ? pill(STATE_LABEL[x.state] || x.state, { working: "good", waiting: "info", idle: "idle", limited: "bad", stuck: "warn" }[x.state] || "") : pill("Finished")}
          ${x ? pill(x.kind === "lane" ? "Lane" : "Terminal") : ""}
          ${x && x.model ? pill(x.model.replace(/^claude-/, "")) : ""}
          ${x && x.programme ? pill(x.programme.name, "info") : ""}</div></div></div>
      <div class="subtabs" role="tablist"><button data-stab="chat" class="${tab === "chat" ? "on" : ""}">${icon("chat", 16)}Chat</button><button data-stab="overview" class="${tab === "overview" ? "on" : ""}">${icon("layers", 16)}Overview</button></div>
      ${tab === "chat" ? chatHtml(s, x, conv, talk) : overviewHtml(s, x)}`,
      bind(root) {
        root.querySelectorAll("[data-stab]").forEach(b => b.addEventListener("click", () => {
          sessTab.set(v.id, b.dataset.stab); app.rerender(true);
          if (b.dataset.stab === "chat") { const c = root.querySelector(".chat"); if (c && getComputedStyle(c).overflowY !== "visible") c.scrollTop = c.scrollHeight; else root.scrollTop = root.scrollHeight; }   // Chat opens at the newest
        }));
        root.querySelectorAll("[data-steps]").forEach(b => b.addEventListener("click", () => { const k = b.dataset.steps; if (openSteps.has(k)) openSteps.delete(k); else openSteps.add(k); app.rerender(true); }));
        root.querySelectorAll(".msg .md pre").forEach(pre => {   // a Copy button on every code block
          const b = document.createElement("button");
          b.className = "btn sm ghost md-copy"; b.type = "button"; b.innerHTML = `${icon("copy", 13)}Copy`; b.setAttribute("aria-label", "Copy the code");
          b.addEventListener("click", () => navigator.clipboard.writeText(pre.textContent.replace(/Copy$/, "")).then(() => toast("Copied.", "good", 1500), () => toast("Copy failed: select the text instead.", "warn")));
          pre.appendChild(b);
        });
        const ta = root.querySelector("#chatBox"), send = root.querySelector("#chatSend");
        if (ta && send) {
          ta.value = app.draftFor(v.id);
          const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(160, ta.scrollHeight) + "px"; };
          grow();
          ta.addEventListener("input", () => { app.setDraft(v.id, ta.value); grow(); });
          ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send.click(); } });
          root.querySelectorAll("[data-quick]").forEach(b => b.addEventListener("click", () => {
            const q = QUICK[+b.dataset.quick][1];
            ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, "") + "\n\n" + q : q;   // never throw away a draft
            app.setDraft(v.id, ta.value); grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
          }));
          send.addEventListener("click", async () => {
            const text = ta.value.trim();
            if (!text) return;
            send.disabled = true;
            try {
              const r = await app.post("/api/message", { seat: v.seat, id: v.id, text, followup: talk === "followup" });
              app.setDraft(v.id, ""); ta.value = "";
              sound.play("hire");
              if (r.demo) toast("Demo office: nothing was sent.");
              else if (r.delivery === "followup") toast("Follow-up started as a new lane. It will resume this conversation.", "good");
              else if (r.delivery === "review") toast("Sent. It is waiting for approval in that session's terminal.", "info");
              else toast("Delivered.", "good");
              if (!r.demo) app.chatSent(v.seat, v.id, text, r);   // the demo sends nothing, so it shows nothing sent
            } catch (e) { toast("Could not send: " + e.message, "bad"); }
            send.disabled = false;
            const box = document.getElementById("chatBox"); if (box) box.focus();   // ready for the next message
          });
          const end = root.querySelector("#chatEnd");
          // Open at the newest message by scrolling the chat (phones) or the panel (desktop), never the whole page.
          if (end && app.chatJustOpened(v.id)) requestAnimationFrame(() => {
            const chat = root.querySelector(".chat");
            if (chat && getComputedStyle(chat).overflowY !== "visible") chat.scrollTop = chat.scrollHeight;
            else root.scrollTop = root.scrollHeight;
          });
        }
      } };
  }

  // One-tap messages a CEO sends all the time. They fill the box (never send on their own) so they can be edited.
  const QUICK = [
    ["Status?", "Quick status check: what are you doing right now, what is left, and is anything blocking you?"],
    ["Write your notes", "Please write your notes now (what is done, what is next, anything I should know), in case this session stops."],
    ["Wrap up", "Please wrap up: finish the step you are on, commit or save your work, write your report, and stop."],
    ["Pause", "Please pause after the current step and wait for my next message before doing anything else."],
  ];
  function chatHtml(s, x, conv, talk) {
    if (!conv) return `<div class="chat"><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:50%;align-self:flex-end"></div><div class="skeleton" style="width:60%"></div></div>`;
    const who = s ? P(s).name : x ? x.name : conv.name || "agent";   // replies are signed by the seat's character
    const items = [...(conv.items || [])];
    const inTranscript = new Set(items.filter(i => i.role === "peer").map(i => (i.text || "").trim()));
    for (const t of conv.thread || []) {
      if (t.dir === "out" && !inTranscript.has((t.text || "").trim())) items.push({ ts: t.ts, role: "ceo-pending", text: t.text, status: x ? x.talk : "followup" });
      if (t.dir === "in") items.push({ ts: t.ts, role: "reply", text: t.text });
    }
    for (const p of app.pendingFor(s.id, x ? x.id : conv.id)) if (!inTranscript.has(p.text.trim()) && !(conv.thread || []).some(t => t.dir === "out" && t.text === p.text)) items.push({ ts: p.ts, role: "ceo-pending", text: p.text, status: p.delivery });
    items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    let html = "", steps = [];
    const flush = (k) => {
      if (!steps.length) return;
      const key = "st:" + (steps[0].ts || k) + ":" + (steps[0].text || "").slice(0, 24);   // stable while the group grows
      html += `<button class="steps-chip" data-steps="${esc(key)}">${icon(openSteps.has(key) ? "chevronDown" : "chevronRight", 14)}<span>${steps.length} step${steps.length === 1 ? "" : "s"} · ${esc(steps[steps.length - 1].text)}</span></button>`;
      if (openSteps.has(key)) html += `<div class="steps-list">${steps.map(st => `<div>${esc(st.text)}</div>`).join("")}</div>`;
      steps = [];
    };
    items.forEach((it, i) => {
      if (it.role === "step") { steps.push(it); return; }
      flush(i);
      const time = it.ts ? `<span class="meta">${clock(it.ts)}</span>` : "";
      if (it.role === "user") html += `<div class="msg user"><span class="who">Prompt</span>${privMd(x, it.text)}${time}</div>`;
      else if (it.role === "assistant") html += `<div class="msg agent clip"><span class="who">${esc(who)}</span>${privMd(x, it.text)}${time}</div>`;
      else if (it.role === "peer") {
        const ceo = /Claude Office/i.test(it.from_name || "");
        html += `<div class="msg ${ceo ? "ceo" : "peer"}"><span class="who">${ceo ? "You, from the office" : esc(it.from_name || "Another session")}</span>${esc(it.text)}${time}</div>`;
      } else if (it.role === "reply") html += `<div class="msg agent"><span class="who">${esc(who)} replied to you</span><div class="md">${md(it.text)}</div>${time}</div>`;
      else if (it.role === "ceo-pending") html += `<div class="msg ceo"><span class="who">You, from the office</span>${esc(it.text)}<span class="meta">${it.status === "review" ? "Waiting for approval in its terminal" : it.status === "followup" ? "Sent as a follow-up lane" : "Sent"} · ${relTime(it.ts)}</span></div>`;
      else if (it.role === "brief") {
        const key = "brief:" + (it.ts || i), open = openSteps.has(key);
        html += `<div class="msg ceo brief${open ? " open" : ""}"><span class="who">${icon("briefcase", 13)} Brief from the office${it.title ? ` · ${esc(it.title)}` : ""}</span><div class="body">${esc(it.text)}</div><button class="more" data-steps="${esc(key)}">${open ? "Show less" : "Show the whole brief"}</button>${time}</div>`;
      }
      else if (it.role === "notice") html += `<div class="notice">${esc(it.text)}</div>`;
    });
    flush("end");
    if (!html) html = `<div class="notice">No conversation yet.</div>`;
    // While the agent works, a typing line says what it is doing right now (hidden for terminals in share-safe).
    if (x && (x.state === "working" || x.state === "waiting") && x.live !== false) {
      const doing = app.privacy() && x.kind === "desk" ? "Working" : (x.activity || "Working");   // activities read as titles ("Merge PR #482")
      html += `<div class="typing" aria-live="off"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span><b>${esc(who)}</b> · ${esc(doing)}</span></div>`;
    }
    const hint = { direct: ["zap", "Goes straight to this lane."],
      review: ["eye", "Claude Code holds messages from the office until someone approves them in that terminal."],
      followup: ["reply", x ? "This session cannot take live messages. Sending starts a follow-up lane that resumes it." : "This session has ended. Sending starts a follow-up lane that resumes it."],
      none: ["x", "Codex sessions cannot take messages yet."],
      later: ["clock", "This session has no message socket, so it cannot take messages while it runs. Follow up once it finishes."] }[talk] || ["dot", ""];
    return `<div class="chat">${html}<span id="chatEnd"></span></div>
      <div class="composer">${!(talk === "none" || talk === "later") ? `<div class="quick">${QUICK.map(([label], i) => `<button class="chip" data-quick="${i}">${esc(label)}</button>`).join("")}</div>` : ""}<div class="box"><textarea id="chatBox" rows="1" placeholder="${talk === "none" || talk === "later" ? "Messaging is not available here" : `Message ${esc(who)}…`}" ${talk === "none" || talk === "later" ? "disabled" : ""} aria-label="Message"></textarea>
        <button class="btn primary icon" id="chatSend" ${talk === "none" || talk === "later" ? "disabled" : ""} title="Send (Enter)" aria-label="Send">${icon("send", 17)}</button></div>
        <div class="hint">${icon(hint[0], 14)}<span>${hint[1]}</span></div></div>`;
  }

  function overviewHtml(s, x) {
    if (!x) return section("Overview", `<div class="muted">This session has ended. Its conversation is in the Chat tab.</div>`);
    const d = app.detailFor("s:" + s.id + "/" + x.id);
    const t1 = x.tokens_1h || {}, t5 = x.tokens_5h || {};
    const lane = (S().lanes || []).find(l => l.pid && l.pid === x.pid);
    return `${section("Right now", `<div class="now ${x.state}"><span class="caret"></span>${icon(KIND_ICON[x.activity_kind] || "dot", 18)}<span style="min-width:0;overflow-wrap:anywhere">${priv(x, x.activity)}</span></div>
        <div class="hint" style="margin-top:6px">${x.quiet_s != null ? `Last sign of life ${dur(x.quiet_s)} ago.` : ""}${x.limit_text ? " " + esc(x.limit_text) : ""}</div>`)}
      ${x.title || x.task ? section("Working on", `${x.title ? `<div style="font-weight:600;margin-bottom:8px">${priv(x, x.title)}</div>` : ""}${x.task ? `<div class="quote">${priv(x, x.task)}</div>` : ""}`) : ""}
      ${x.state_file ? section("Progress notes", d && d.state_tail ? `<pre class="pre">${esc(d.state_tail)}</pre>` : `<div class="hint">${d ? "Empty so far." : "Loading…"}</div>`) : ""}
      ${x.report_status ? section("Report", d && d.report ? `<pre class="pre">${esc(d.report)}</pre>` : `<div class="quote">${esc(x.report_status)}</div>`) : ""}
      ${section("Burn", `<div class="tiles"><div class="tile"><div class="v">${fmtTok(t1.fresh)}</div><div class="tk">fresh tokens, last hour</div></div>
        <div class="tile"><div class="v">${fmtTok(t5.fresh)}</div><div class="tk">last 5 hours</div></div><div class="tile"><div class="v">${x.tool_calls ?? "–"}</div><div class="tk">tool calls</div></div></div>`)}
      ${section("Details", `<dl class="facts">
        <dt>Seat</dt><dd>${esc(P(s).name)} (${esc(s.label)})</dd>
        <dt>Started</dt><dd>${x.started_at ? `${dayTime(x.started_at)} (${relTime(x.started_at)})` : "–"}</dd>
        ${x.unit ? `<dt>Runs in</dt><dd><code>${esc(x.unit)}</code></dd>` : x.terminal ? `<dt>Runs in</dt><dd>a terminal</dd>` : ""}
        <dt>Folder</dt><dd><code>${esc(x.cwd || "–")}</code></dd>
        ${x.pid ? `<dt>Process</dt><dd>${x.pid}${x.cpu_s != null ? ` · ${dur(x.cpu_s)} CPU` : ""}</dd>` : ""}
        ${x.state_file ? `<dt>Notes file</dt><dd><code>${esc(x.state_file)}</code></dd>` : ""}</dl>`)}
      ${x.resume_cmd ? section("Pick it up in a terminal", `<div class="copy"><code>${esc(x.resume_cmd)}</code><button class="btn sm" data-copy="${esc(x.resume_cmd)}">${icon("copy", 14)}Copy</button></div>`) : ""}
      <div class="row wrap" style="margin-top:18px"><button class="btn sm" data-focus-session="${esc(x.id)}">${icon("target", 15)}Show on the floor</button>${lane ? `<button class="btn sm" data-lane="${esc(lane.id)}">${icon("briefcase", 15)}Open office lane</button>` : ""}</div>`;
  }

  // ---------------------------------------------------------------------------------- rooms & news
  function services() {
    const rank = (u) => u.active === "failed" ? 0 : u.active === "active" ? 2 : 1;   // failures first, like the racks on the floor
    const units = [...(S().units || [])].sort((a, b) => rank(a) - rank(b));
    return { html: `${crumbs("Server room")}<h2>Server room</h2><p class="lede">Background services that keep lanes running: conductors, supervisors and the lanes themselves.</p>
      ${section(`Services · ${units.length}`, units.length ? units.map(u => `<div class="need ${u.active === "failed" ? "bad" : u.active === "active" ? "good" : "info"}"><span class="ico">${icon(u.active === "active" ? "play" : u.active === "failed" ? "alert" : "stop", 16)}</span>
        <div class="grow"><div class="t" style="overflow-wrap:anywhere">${esc(u.unit)}</div><div class="d">${esc(u.description)} · ${esc(u.active)}</div></div></div>`).join("") : `<div class="muted">No watched services. Add patterns to <code>watch_units</code> in the config.</div>`)}` };
  }
  function programmes() {
    return { html: `${crumbs("Meeting room")}<h2>Programmes</h2><p class="lede">Live work grouped by programme. Names and links come from your config.</p>
      ${section("On the whiteboard", (S().programmes || []).map(progCard).join("") || `<div class="muted">No running work belongs to a programme.</div>`)}` };
  }
  // The office's own level: everyone's XP adds up, and each level unlocks something on the floor.
  function office() {
    const snap = S(), ol = officeLevel(snap.seats), r = 30, len = 2 * Math.PI * r;
    const byXp = [...snap.seats].filter(s => s.career).sort((a, b) => b.career.xp - a.career.xp), top = Math.max(1, ...byXp.map(s => s.career.xp));
    const nxt = ol.upcoming;
    return { html: `${crumbs("Your office")}
      <div class="ol-hero">
        <svg class="ol-ring" viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="${r}" class="trk"/><circle cx="36" cy="36" r="${r}" class="val" stroke-dasharray="${(len * ol.progress).toFixed(1)} ${len.toFixed(1)}"/></svg>
        <div class="ol-num"><small>Level</small><b>${ol.level}</b></div>
        <div class="grow"><h2>${esc(snap.office.name || "Claude Office")}</h2>
          <div class="ol-sub">${ol.xp.toLocaleString()} XP · ${(ol.next - ol.xp).toLocaleString()} to level ${ol.level + 1}</div>
          <div class="ol-bar"><i style="width:${Math.round(ol.progress * 100)}%"></i></div>
          <p class="lede">Everyone's work adds up. Every office level unlocks something new on the floor.</p></div></div>
      ${nxt ? `<div class="ol-next">${icon(nxt.icon, 18)}<div class="grow"><b>Next: ${esc(nxt.name)}</b><span>${esc(nxt.desc)}</span></div><em>Level ${nxt.level}</em></div>` : `<div class="ol-next done">${icon("trophy", 18)}<div class="grow"><b>Everything is unlocked.</b><span>The office is complete. Keep the streak going.</span></div></div>`}
      ${section(`Unlocks · ${ol.unlocked.size} of ${UNLOCKS.length}`, `<div class="ol-grid">${UNLOCKS.map(u => { const on = ol.unlocked.has(u.id);
        return `<div class="ol-card ${on ? "on" : ""}"><span class="ol-ic">${icon(on ? u.icon : "lock", 18)}</span><b>${esc(u.name)}</b><span>${esc(on ? u.desc : `Unlocks at office level ${u.level}`)}</span></div>`; }).join("")}</div>`)}
      ${(() => { const have = earned(), n = BADGES.filter(b => have[b.id]).length;
        return section(`Your badges · ${n} of ${BADGES.length}`, `<div class="ol-grid">${BADGES.map(b => { const at = have[b.id];
          return `<div class="ol-card ${at ? "on" : ""}"><span class="ol-ic">${icon(at ? b.icon : "lock", 18)}</span><b>${esc(b.name)}</b><span>${esc(b.desc)}${at ? ` · ${esc(dayTime(at))}` : ""}</span></div>`; }).join("")}</div>
          <div class="hint" style="margin-top:8px">${app.demo ? "The demo office never awards badges. " : ""}Badges are kept in this browser.</div>`); })()}
      ${byXp.length ? section("Who built it", byXp.map(s => `<div class="ol-who" style="--seat:${esc(s.color)}" data-seat-go="${esc(s.id)}" data-spot="${esc(s.id)}">${avatar("mascot-" + s.id, s.color, "lv" + (s.career ? s.career.level : 0))}<b>${esc(P(s).name)}</b><span class="ol-wbar"><i style="width:${Math.round(s.career.xp / top * 100)}%"></i></span><em>${s.career.xp.toLocaleString()} XP</em></div>`).join("")) : ""}` };
  }
  function trophies() {
    const seats = S().seats.filter(s => s.career), cat = S().achievements || [];
    const byId = Object.fromEntries(cat.map(a => [a.id, a]));
    const ranked = [...seats].sort((a, b) => b.career.xp - a.career.xp);
    const total = seats.reduce((n, s) => n + Object.keys(s.career.unlocked).length, 0);
    const recent = seats.flatMap(s => Object.entries(s.career.unlocked).map(([id, at]) => ({ s, a: byId[id], at }))).filter(x => x.a)
      .sort((a, b) => b.at - a.at).slice(0, 8);
    const open = cat.filter(a => !seats.some(s => s.career.unlocked[a.id]));
    const medal = ["#ffd24a", "#c9d1e0", "#d08a4c"];
    return { html: `${crumbs("Trophy room")}<h2>Trophy room</h2>
      <p class="lede">${total} ${total === 1 ? "trophy" : "trophies"} across ${seats.length} characters. Everyone earns XP from real work: tool calls, time at work, sessions and reports.</p>
      ${section("Leaderboard", ranked.map((s, i) => { const c = s.career, p = P(s);
        return `<button class="lb-row" data-seat-go="${esc(s.id)}" style="--seat:${esc(s.color)}"><span class="rk" ${i < 3 ? `style="--medal:${medal[i]}"` : ""}>${i + 1}</span>${avatar("mascot-" + s.id, s.color, "lv" + (s.career ? s.career.level : 0))}
          <span class="grow"><span class="nm"><b>${esc(p.name)}</b><span class="lvchip">Lv ${c.level}</span><span class="muted">${esc(c.title)}</span></span>
          <span class="xpbar"><i style="width:${Math.round(c.progress * 100)}%"></i></span></span>
          <span class="sc"><b>${c.xp.toLocaleString()}</b><small>XP · ${icon("trophy", 12)} ${Object.keys(c.unlocked).length}</small></span></button>`; }).join(""))}
      ${recent.length ? section("Latest unlocks", recent.map(x => `<div class="act good click" data-seat="${esc(x.s.id)}">${icon(x.a.icon, 16)}<span><b>${esc(P(x.s).name)}</b> unlocked <b>${esc(x.a.name)}</b> <span class="muted">· ${esc(x.a.desc)}</span></span><span class="when">${relTime(x.at)}</span></div>`).join("")) : ""}
      ${open.length ? section(`Still up for grabs · ${open.length}`, `<div class="grabs">${open.map(a => `<span class="pill" title="${esc(a.desc)}">${icon(a.icon, 14)}${esc(a.name)}</span>`).join("")}</div>`) : section("Still up for grabs", `<div class="muted">Every achievement has been unlocked by someone. Legendary.</div>`)}` };
  }
  function lounge() {
    const resting = S().seats.filter(s => ["limited", "benched", "offline"].includes(s.status) || !live(s).length);
    return { html: `${crumbs("Lounge")}<h2>Lounge</h2><p class="lede">Seats with nobody at their desks take a break here. Out-of-plan seats nap on the couch; benched seats wear sunglasses.</p>
      ${section(`On a break · ${resting.length}`, resting.map(memberRow).join("") || `<div class="muted">Everyone is at their desk.</div>`)}` };
  }
  // News under time headings: the last 15 minutes, earlier today, yesterday, then by date.
  function newsGroups(ev) {
    const now = S().now, today = new Date(now * 1000).toDateString(), y = new Date(now * 1000); y.setDate(y.getDate() - 1);
    const label = (e) => {
      if (now - e.ts < 900) return "Just now";
      const d = new Date(e.ts * 1000).toDateString();
      return d === today ? "Earlier today" : d === y.toDateString() ? "Yesterday" : new Date(e.ts * 1000).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
    };
    let last = null, html = "";
    for (const e of ev) { const l = label(e); if (l !== last) { html += `<div class="news-h">${esc(l)}</div>`; last = l; } html += actRow(e); }
    return html;
  }
  function news() {
    const ev = (S().events || []).slice().reverse().filter(e => newsFilter === "all" || e.level === newsFilter);
    return { html: `${crumbs("News")}<h2>Office news</h2><p class="lede">Arrivals, departures, reports, limits, resets, messages and your own changes.</p>
      <div class="seg-ctl" style="margin-top:16px">${[["all", "All"], ["good", "Good"], ["warn", "Heads-up"], ["bad", "Problems"]].map(([f, l]) => `<button data-news="${f}" class="${newsFilter === f ? "on" : ""}">${l}</button>`).join("")}</div>
      <div style="margin-top:12px">${ev.length ? newsGroups(ev) : `<div class="muted">Nothing yet.</div>`}</div>`,
      bind(root) { root.querySelectorAll("[data-news]").forEach(b => b.addEventListener("click", () => { newsFilter = b.dataset.news; app.rerender(true); })); } };
  }

  // -------------------------------------------------------------------------------------------- lane
  function lane(v) {
    const d = app.detailFor("l:" + v.id);
    const l = (S().lanes || []).find(x => x.id === v.id) || (d && d.lane);
    if (!l && d && d.missing) return { html: crumbs("Lane") + `<div class="allclear">That lane is no longer here.</div><div class="row" style="margin-top:12px"><button class="btn sm" data-go="hire">${icon("briefcase", 15)}Hiring desk</button></div>` };
    if (!l) return { html: crumbs("Lane") + `<div class="skeleton"></div><div class="skeleton" style="width:70%"></div>` };
    const runs = (d && d.lane.runs) || l.runs || [];
    const running = l.unit_active || ["running", "starting", "waiting"].includes(l.status);
    const sid = l.last_session_id;
    return { html: `${crumbs(`<button data-go="hire">Hiring desk</button>`, esc(l.title))}
      <h2>${esc(l.title)}</h2>
      <div class="row wrap" style="gap:6px;margin-top:8px">${pill(l.status, { done: "good", finished: "good", running: "info", failed: "bad", blocked: "warn", waiting: "warn" }[l.status] || "")}
        ${l.seat ? pill("on " + nameOf(l.seat)) : ""}${pill(l.model)}${pill(l.seat_pref === "auto" ? "divider picks the seat" : "pinned to " + nameOf(l.seat_pref))}${l.allow_messages === true ? pill("takes messages", "good", "chat") : ""}</div>
      ${l.waiting_reason ? `<div class="need warn" style="margin-top:12px"><span class="ico">${icon("clock", 16)}</span><div class="grow"><div class="t">Waiting for a seat</div><div class="d">${esc(humanise(l.waiting_reason))}</div></div></div>` : ""}
      <div class="row wrap" style="gap:8px;margin-top:16px">
        ${sid && l.seat ? `<button class="btn sm primary" data-chat-session="${esc(l.seat)}|${esc(sid)}">${icon("chat", 15)}${running ? "Chat with it" : "Follow up"}</button>` : ""}
        ${running ? `<button class="btn sm danger" id="lStop">${icon("stop", 15)}Stop</button>` : `<button class="btn sm" id="lResume">${icon("play", 15)}Resume</button>`}
        <select id="lSeat" style="width:auto;height:30px;padding:0 8px"><option value="">As before</option><option value="auto">Let the divider pick</option>${S().seats.map(s => `<option value="${esc(s.id)}">${esc(P(s).name)}</option>`).join("")}</select>
        <button class="btn sm" id="lClone">${icon("copy", 15)}Re-hire</button>
      </div>
      ${l.report_status ? section("Report", `<pre class="pre">${esc((d && d.report) || l.report_status)}</pre>`) : ""}
      ${section("Progress notes", `<pre class="pre">${esc((d && d.state) || l.state_tail || "Nothing yet.")}</pre>`)}
      ${section("Runs", runs.length ? runs.slice().reverse().map(r => `<div class="act ${r.ended_by === "limit" ? "warn" : r.rc === 0 ? "good" : r.rc == null ? "" : "bad"}">${icon(r.ended_by === "limit" ? "sleep" : r.rc === 0 ? "check" : r.rc == null ? "play" : "alert", 16)}<span>${esc(nameOf(r.seat))}${r.rc != null ? ` · exit ${r.rc}` : " · running"}${r.ended_by ? " · hit its limit, moved on" : ""}</span><span class="when">${clock(r.started_at)}</span></div>`).join("") : `<div class="muted">Not started yet.</div>`)}
      ${section("Brief", `<div class="quote">${esc(d ? d.brief : "")}</div>`)}
      ${section("Log", `<pre class="pre">${esc((d && d.log) || "")}</pre>`)}
      ${section("Details", `<dl class="facts"><dt>Lane id</dt><dd><code>${esc(l.id)}</code></dd><dt>Unit</dt><dd><code>${esc(l.unit)}</code></dd><dt>Folder</dt><dd><code>${esc(l.workdir)}</code></dd></dl>`)}`,
      bind(root) {
        const stop = root.querySelector("#lStop"), res = root.querySelector("#lResume"), clone = root.querySelector("#lClone"), chat = root.querySelector("[data-chat-session]");
        if (stop) stop.addEventListener("click", async () => { if (!confirm("Stop this lane? Its progress notes stay, so you can resume it.")) return; try { const r = await app.post("/api/lanes/stop", { id: v.id }); result(r, "Lane stopped.", "warn"); app.refresh(); } catch (e) { toast(e.message, "bad"); } });
        if (res) res.addEventListener("click", async () => { try { const r = await app.post("/api/lanes/resume", { id: v.id, seat: root.querySelector("#lSeat").value || null }); result(r, "Resuming the lane."); app.refresh(); } catch (e) { toast(e.message, "bad"); } });
        if (clone) clone.addEventListener("click", () => {
          hireDraft = { title: l.title, brief: d ? d.brief : "", workdir: l.workdir, seat: l.seat_pref || "auto", model: l.model, permission_mode: l.permission_mode, allow_messages: l.allow_messages !== false };
          store.set("hireDraft", hireDraft); app.go({ kind: "hire" }); toast("Brief copied to the hiring desk.");
        });
        if (chat) chat.addEventListener("click", () => { const [seatId, id] = chat.dataset.chatSession.split("|"); sessTab.set(id, "chat"); app.go({ kind: "session", seat: seatId, id }); });
      } };
  }

  // ----------------------------------------------------------------------------------------- divider
  const enabledIds = () => S().seats.map(s => s.id).filter(id => dv.seats[id] && dv.seats[id].enabled && dv.seats[id].weight > 0);
  function normalise() {
    const ids = S().seats.map(s => s.id).filter(id => dv.seats[id].enabled);
    if (!ids.length) return;
    const total = ids.reduce((a, id) => a + dv.seats[id].weight, 0);
    if (total <= 0) ids.forEach(id => dv.seats[id].weight = Math.floor(100 / ids.length));
    else ids.forEach(id => dv.seats[id].weight = Math.round(dv.seats[id].weight / total * 100));
    const drift = 100 - ids.reduce((a, id) => a + dv.seats[id].weight, 0);
    if (drift) { const top = ids.reduce((a, b) => dv.seats[a].weight >= dv.seats[b].weight ? a : b); dv.seats[top].weight += drift; }
  }
  const previewSoon = debounce(async () => {
    if (app.demo) { dvPreview = null; paintPick(); return; }
    try { dvPreview = (await app.post("/api/divider/preview", dv)).next_pick; } catch { dvPreview = null; }
    paintPick();
  }, 250);
  function markDirty() { dvDirty = true; previewSoon(); const sb = document.getElementById("dvSave"), rb = document.getElementById("dvReset"); if (sb) sb.disabled = false; if (rb) rb.disabled = false; }
  function pickHtml() {
    const np = dvPreview || S().next_pick, who = np.seat || np.pick;
    return `<div class="pick ${who ? "" : "none"}"><b>${who ? `Next lane → ${esc(nameOf(who))}` : "No seat can take a lane"}</b>${dvPreview ? ` ${pill("preview")}` : ""}
      <div class="why">${esc(humanise(np.why))}</div><div style="margin-top:8px">
      ${(np.ranking || []).map(r => `<div class="rk"><span>${r.eligible ? icon("check", 14) : icon("x", 14)}</span><span>${esc(nameOf(r.seat))}</span><span>${r.eligible ? `target ${Math.round((r.target ?? r.share) * 100)}% · runs ${r.lanes} · ${Math.round(r.headroom * 100)}% plan left` : esc(r.blockers.join(", "))}</span></div>`).join("")}</div></div>`;
  }
  function paintPick() { const el = document.getElementById("dvPick"); if (el) el.innerHTML = pickHtml(); }
  function divider() {
    if (!dv || !dvDirty) { dv = JSON.parse(JSON.stringify(S().divider)); normalise(); dvDirty = false; }
    const ids = enabledIds();
    return { html: `${crumbs("Load divider")}
      <h2>Load divider</h2>
      <p class="lede">How new work is shared between seats. Drag the white handles, send a seat on holiday, or cap how many lanes it runs.</p>
      ${section("Split", `<div class="split" id="split">${S().seats.map(s => { const c = dv.seats[s.id], on = c.enabled && c.weight > 0;
          return `<div class="seg ${on ? "" : "off"} ${c.weight < 14 ? "narrow" : ""}" title="${esc(P(s).name)} ${c.weight}%" data-seg="${esc(s.id)}" style="--seat:${s.color};flex:0 0 calc(${on ? c.weight : 0}% - 3px)"><i data-portrait="mascot-${esc(s.id)}|${esc(s.color)}|"></i><span>${esc(P(s).name)}<small>${c.weight}%</small></span></div>`; }).join("")}
          ${ids.slice(0, -1).map((id, i) => `<div class="handle" tabindex="0" role="slider" aria-label="Border after ${esc(nameOf(id))}" aria-valuemin="0" aria-valuemax="100" data-h="${i}"></div>`).join("")}</div>
        <div class="row between wrap" style="margin-top:12px"><div class="seg-ctl" role="group" aria-label="Mode"><button data-mode="headroom" class="${dv.mode === "headroom" ? "on" : ""}">Adapt to plan left</button><button data-mode="fixed" class="${dv.mode === "fixed" ? "on" : ""}">Fixed split</button></div>
          <button class="btn sm" id="dvSuggest">${icon("sparkles", 15)}Suggest</button></div>
        <div class="hint" style="margin-top:8px">${dv.mode === "headroom" ? "A seat's share shrinks as its plan runs out, so a nearly spent seat gets less." : "Shares are kept exactly as set, until a guard stops a seat."}</div>`)}
      <div id="dvPick" style="margin-top:14px">${pickHtml()}</div>
      ${section("Seats", S().seats.map(s => { const c = dv.seats[s.id], u = s.usage || {};
        return `<div class="dseat">${avatar("mascot-" + s.id, s.color, c.enabled ? "" : "dim")}
          <div><b>${esc(P(s).name)}</b> <span class="hint">${esc(SEAT_LABEL[s.status] || s.status)} · 5-hour ${pct(u, "five_hour") == null ? "–" : Math.round(100 - pct(u, "five_hour")) + "% left"} · week ${pct(u, "weekly") == null ? "–" : Math.round(100 - pct(u, "weekly")) + "% left"}</span></div>
          <label class="switch" title="On duty"><input type="checkbox" data-duty="${esc(s.id)}" ${c.enabled ? "checked" : ""} aria-label="${esc(P(s).name)} on duty"><span></span></label>
          <div class="ctl"><label>Share <input type="number" min="0" max="100" value="${c.weight}" data-w="${esc(s.id)}" ${c.enabled ? "" : "disabled"}> %</label>
            <label>At most <input type="number" min="0" max="16" value="${c.max_lanes}" data-cap="${esc(s.id)}"> lanes</label><span>running ${s.lanes}</span></div>
          <div class="ctl"><input type="text" placeholder="Note, e.g. keep free for interactive work" value="${esc(c.note || "")}" data-note="${esc(s.id)}" maxlength="200"></div></div>`; }).join(""))}
      ${section("Guards", `<div class="grid2">
        <label class="f">Stop new lanes at 5-hour use of<input type="number" min="10" max="100" id="dv5" value="${dv.five_hour_guard}"></label>
        <label class="f">Stop new lanes at weekly use of<input type="number" min="10" max="100" id="dvW" value="${dv.weekly_guard}"></label>
        <label class="f">Most lanes in the office at once<input type="number" min="0" max="32" id="dvG" value="${dv.global_max_lanes}"></label></div>`)}
      <div class="row" style="gap:8px;margin-top:6px"><button class="btn primary" id="dvSave" ${dvDirty ? "" : "disabled"}>Save split</button><button class="btn" id="dvReset" ${dvDirty ? "" : "disabled"}>Undo</button>
        ${!dvDirty && S().divider.updated_at ? `<span class="hint">Saved ${relTime(S().divider.updated_at)}</span>` : ""}</div>
      ${section("From scripts", `<div class="copy"><code>seat=$(claude-office pick-seat)</code><button class="btn sm" data-copy="seat=$(claude-office pick-seat)">${icon("copy", 14)}Copy</button></div><div class="hint" style="margin-top:8px">Exit code 3 means every seat is blocked; <code>--json</code> adds the reasoning.</div>`)}`,
      bind(root) {
        const split = root.querySelector("#split");
        const paint = () => {
          split.querySelectorAll(".seg").forEach(seg => { const c = dv.seats[seg.dataset.seg], on = c.enabled && c.weight > 0; seg.style.flexBasis = `calc(${on ? c.weight : 0}% - 3px)`; seg.classList.toggle("narrow", c.weight < 14); const sm = seg.querySelector("small"); if (sm) sm.textContent = c.weight + "%"; });
          let acc = 0; const ids2 = enabledIds();
          split.querySelectorAll(".handle").forEach((h, i) => { acc += dv.seats[ids2[i]] ? dv.seats[ids2[i]].weight : 0; h.style.left = `calc(${acc} * (100% - 6px) / 100 + 1.5px)`;   /* segments size against the bar minus its 3px padding */ h.setAttribute("aria-valuenow", String(acc)); });
          root.querySelectorAll("[data-w]").forEach(inp => { if (document.activeElement !== inp) inp.value = dv.seats[inp.dataset.w].weight; });
        };
        paint();
        split.querySelectorAll(".handle").forEach(h => {
          const i = +h.dataset.h;
          const move = (clientX) => {
            const ids2 = enabledIds(), r = split.getBoundingClientRect();
            let acc = 0; for (let k = 0; k < i; k++) acc += dv.seats[ids2[k]].weight;
            const pair = dv.seats[ids2[i]].weight + dv.seats[ids2[i + 1]].weight;
            const pos = Math.max(1, Math.min(pair - 1, Math.round((clientX - r.left) / r.width * 100) - acc));
            dv.seats[ids2[i]].weight = pos; dv.seats[ids2[i + 1]].weight = pair - pos;
            paint(); markDirty();
          };
          h.addEventListener("pointerdown", (e) => {
            h.setPointerCapture(e.pointerId);
            dragging = true;
            const mv = (ev) => move(ev.clientX);
            const up = () => { dragging = false; h.removeEventListener("pointermove", mv); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up); sound.play("click"); app.rerender(true); };
            h.addEventListener("pointermove", mv); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
          });
          h.addEventListener("keydown", (e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const ids2 = enabledIds(), a = dv.seats[ids2[i]], b = dv.seats[ids2[i + 1]];
            const dd = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1);
            if (a.weight + dd < 1 || b.weight - dd < 1) return;
            a.weight += dd; b.weight -= dd; paint(); markDirty();
          });
        });
        root.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => { dv.mode = b.dataset.mode; markDirty(); app.rerender(true); }));
        root.querySelectorAll("[data-duty]").forEach(c => c.addEventListener("change", () => {
          const id = c.dataset.duty; dv.seats[id].enabled = c.checked;
          if (c.checked && dv.seats[id].weight <= 0) dv.seats[id].weight = Math.max(5, Math.round(100 / Math.max(1, enabledIds().length + 1)));
          normalise(); markDirty(); app.rerender(true);
        }));
        root.querySelectorAll("[data-w]").forEach(inp => inp.addEventListener("change", () => {
          const id = inp.dataset.w, val = Math.max(0, Math.min(100, Math.round(+inp.value) || 0));
          const others = enabledIds().filter(x => x !== id), rest = 100 - val, ot = others.reduce((a, x) => a + dv.seats[x].weight, 0);
          dv.seats[id].weight = val;
          others.forEach(x => dv.seats[x].weight = ot ? Math.round(dv.seats[x].weight / ot * rest) : Math.round(rest / others.length));
          normalise(); markDirty();
          setTimeout(() => app.rerender(true), 0);   // after Tab has moved focus on, so the redraw keeps it there
        }));
        root.querySelectorAll("[data-cap]").forEach(inp => inp.addEventListener("change", () => { inp.value = dv.seats[inp.dataset.cap].max_lanes = Math.max(0, Math.min(16, Math.round(+inp.value) || 0)); markDirty(); }));
        root.querySelectorAll("[data-note]").forEach(inp => inp.addEventListener("input", () => { dv.seats[inp.dataset.note].note = inp.value; markDirty(); }));
        for (const [id, key, lo, hi] of [["dv5", "five_hour_guard", 10, 100], ["dvW", "weekly_guard", 10, 100], ["dvG", "global_max_lanes", 0, 32]]) {
          const el = root.querySelector("#" + id); el.addEventListener("change", () => { el.value = dv[key] = Math.max(lo, Math.min(hi, Math.round(+el.value) || 0)); markDirty(); });
        }
        root.querySelector("#dvSuggest").addEventListener("click", () => {
          let tot = 0; const raw = {};
          for (const s of S().seats) {
            const c = dv.seats[s.id];
            const left = ["five_hour", "weekly"].map(k => pct(s.usage, k)).filter(x => x != null).map(x => Math.max(0, 100 - x) / 100);
            raw[s.id] = c.enabled && s.status !== "offline" ? (left.length ? Math.min(...left) : 0.5) : 0; tot += raw[s.id];
          }
          for (const s of S().seats) dv.seats[s.id].weight = tot ? Math.round(raw[s.id] / tot * 100) : 0;
          normalise(); markDirty(); app.rerender(true); toast("Split set from the plan each seat has left. Save to apply.");
        });
        root.querySelector("#dvSave").addEventListener("click", async () => {
          try { const r = await app.post("/api/divider", dv); dvDirty = false; dvPreview = null; dv = null; sound.play("hire");
            result(r, `Saved. The next lane goes to ${r.next_pick && r.next_pick.seat ? nameOf(r.next_pick.seat) : "nobody"}.`); app.refresh(); }
          catch (e) { toast("Could not save: " + e.message, "bad"); }
        });
        root.querySelector("#dvReset").addEventListener("click", () => { dv = null; dvDirty = false; dvPreview = null; app.rerender(true); });
      } };
  }

  // ------------------------------------------------------------------------------------------ hiring
  function hire() {
    const snap = S(), ld = snap.office.lane_defaults || {}, np = snap.next_pick, d = hireDraft;
    const dirs = [...new Set([snap.office.default_workdir, ...snap.seats.flatMap(s => s.sessions.map(x => x.cwd))].filter(Boolean))];
    const isCodex = d.seat && seatById(d.seat) && seatById(d.seat).kind === "codex";
    return { html: `${crumbs("Hiring desk")}
      <h2>Hire a lane</h2>
      <p class="lede">A lane is an agent that works in the background on one brief. It keeps notes, moves to another seat if its seat runs out of plan, and files a report when it is done.</p>
      ${section("Start from a template", `<div class="templates">${TEMPLATES.map((t, i) => `<button data-tpl="${i}">${icon(t.ic, 16)}${esc(t.name)}</button>`).join("")}</div>`)}
      ${section("The brief", `
        <label class="f">Title<input type="text" id="hTitle" maxlength="80" placeholder="e.g. Fix the flaky export test" value="${esc(d.title)}"></label>
        <label class="f">What should it do?<textarea id="hBrief" placeholder="The goal, where to look, how to check the work, and what counts as done.">${esc(d.brief)}</textarea></label>
        <label class="f">Working folder<input type="text" id="hDir" list="hDirs" value="${esc(d.workdir || snap.office.default_workdir || "")}"><datalist id="hDirs">${dirs.map(x => `<option value="${esc(x)}">`).join("")}</datalist></label>
        <div class="grid2">
          <label class="f">Who does it<select id="hSeat"><option value="auto" ${d.seat === "auto" ? "selected" : ""}>Let the divider pick (now ${esc(np.seat ? nameOf(np.seat) : "nobody")})</option>
            ${snap.seats.map(s => `<option value="${esc(s.id)}" ${d.seat === s.id ? "selected" : ""}>${esc(P(s).name)} · ${esc(SEAT_LABEL[s.status] || s.status)}</option>`).join("")}</select></label>
          <label class="f">Model<select id="hModel" ${isCodex ? "disabled" : ""}>${["opus", "sonnet", "fable", "haiku"].map(m => `<option ${(d.model || ld.model) === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
        </div>
        <label class="f">Permissions<select id="hPerm" ${isCodex ? "disabled" : ""}>
          <option value="acceptEdits" ${(d.permission_mode || ld.permission_mode) === "acceptEdits" ? "selected" : ""}>Edit files, run listed tools</option>
          <option value="bypassPermissions" ${(d.permission_mode || ld.permission_mode) === "bypassPermissions" ? "selected" : ""}>Full trust (skips every permission check)</option></select></label>
        <div class="setrow" style="border-top:0;padding-top:0"><div class="grow">Let me message it while it works<small>Messages from the office reach this lane directly instead of waiting for approval.</small></div>
          <label class="switch"><input type="checkbox" id="hMsg" ${d.allow_messages !== false ? "checked" : ""} ${isCodex ? "disabled" : ""} aria-label="Allow messages"><span></span></label></div>
        <div class="hint">${isCodex ? "Codex seat: it runs through the gpt bridge, so model, permissions and messages do not apply." : "Runs as a background service at low priority, with no windows."}</div>
        <div class="row" style="margin-top:16px;gap:8px"><button class="btn primary" id="hGo">${icon("briefcase", 16)}Hire and start</button><button class="btn ghost" id="hClear">Clear</button></div>`)}
      ${section("Office lanes", `<div id="laneList">${laneListHtml()}</div>`)}`,
      bind(root) {
        const q = (id) => root.querySelector("#" + id);
        const save = () => { hireDraft = { title: q("hTitle").value, brief: q("hBrief").value, workdir: q("hDir").value, seat: q("hSeat").value, model: q("hModel").value, permission_mode: q("hPerm").value, allow_messages: q("hMsg").checked }; store.set("hireDraft", hireDraft); };
        ["hTitle", "hBrief", "hDir", "hModel", "hPerm"].forEach(id => q(id).addEventListener("input", save));
        q("hMsg").addEventListener("change", save);
        q("hSeat").addEventListener("change", () => { save(); app.rerender(true); });
        root.querySelectorAll("[data-tpl]").forEach(b => b.addEventListener("click", () => {
          const t = TEMPLATES[+b.dataset.tpl]; save();
          const mine = (hireDraft.title.trim() || hireDraft.brief.trim()) && !TEMPLATES.some(x => x.brief === hireDraft.brief);
          if (mine && !confirm(`Replace your title and brief with the "${t.name}" template?`)) return;   // never lose a written brief silently
          hireDraft.title = t.title; hireDraft.brief = t.brief; store.set("hireDraft", hireDraft); app.rerender(true);
          const ti = document.getElementById("hTitle"); if (ti) { ti.focus(); ti.setSelectionRange(ti.value.length, ti.value.length); }
        }));
        q("hClear").addEventListener("click", () => { hireDraft = { title: "", brief: "", workdir: "", seat: "auto", model: "", permission_mode: "", allow_messages: true }; store.set("hireDraft", hireDraft); app.rerender(true); });
        q("hGo").addEventListener("click", async () => {
          save();
          if (!hireDraft.title.trim() || !hireDraft.brief.trim()) {
            const miss = !hireDraft.title.trim() ? q("hTitle") : q("hBrief");
            for (const f of [q("hTitle"), q("hBrief")]) f.toggleAttribute("aria-invalid", !f.value.trim());
            miss.focus(); toast("Give the lane a title and a brief.", "warn"); return;
          }
          if (hireDraft.permission_mode === "bypassPermissions" && !confirm("Full trust lets the lane run any command without asking. Start it?")) return;
          q("hGo").disabled = true;
          try {
            const r = await app.post("/api/lanes", hireDraft);
            if (r.demo) toast("Demo office: no lane was started.");
            else { sound.play("hire"); toast(`Hired “${r.lane.title}”. Watch the elevator.`, "good"); app.badge("hiring"); hireDraft = { title: "", brief: "", workdir: hireDraft.workdir, seat: "auto", model: "", permission_mode: "", allow_messages: true }; store.set("hireDraft", hireDraft); }
            app.refresh(); app.rerender(true);
          } catch (e) { toast("Could not hire: " + e.message, "bad"); q("hGo").disabled = false; }
        });
      } };
  }
  function laneListHtml() { return S().lanes.length ? S().lanes.map(laneRow).join("") : `<div class="muted">No office lanes yet.</div>`; }

  // ----------------------------------------------------------------------------------------- settings
  function settings() {
    if (!settingsData && !settingsLoading) {
      settingsLoading = true;
      fetch("/api/settings").then(r => r.ok ? r.json() : null).then(j => { settingsData = j || { unavailable: true }; settingsLoading = false; app.rerender(true); })
        .catch(() => { settingsData = { unavailable: true }; settingsLoading = false; app.rerender(true); });
    }
    const p = app.prefs(), sd = settingsData && !settingsData.unavailable ? settingsData : null, voice = sd ? sd.voice || {} : {};
    const VOICE = [["report", "Reports filed"], ["limit", "Usage limits"], ["login", "Logouts"], ["lane", "Office lanes finished"], ["usage", "A seat nearly empty"], ["stuck", "Quiet lanes"]];
    const row = (title, sub, ctl) => `<div class="setrow"><div class="grow">${title}<small>${sub}</small></div>${ctl}</div>`;
    const sw = (key, on) => `<label class="switch"><input type="checkbox" data-pref="${key}" ${on ? "checked" : ""} aria-label="${key}"><span></span></label>`;
    return { html: `${crumbs("Settings")}<h2>Settings</h2>
      ${section("This screen", [
        row("Theme", "Night is the default.", `<div class="seg-ctl">${[["dark", "Night"], ["light", "Day"], ["system", "System"]].map(([t, l]) => `<button data-theme-set="${t}" class="${p.theme === t ? "on" : ""}">${l}</button>`).join("")}</div>`),
        row("Text size", (() => { const ts = app.textSize(); return ts.pref === "auto" ? `Auto shows text at ${Math.round(ts.zoom * 100)}% on this screen.` : "Bigger text for big or far-away screens."; })(),
          `<div class="seg-ctl">${[["auto", "Auto"], ["s", "S"], ["m", "M"], ["l", "L"], ["xl", "XL"]].map(([t, l]) => `<button data-text-set="${t}" class="${(p.textSize || "auto") === t ? "on" : ""}" aria-label="${esc(app.textSize().label[t])}">${l}</button>`).join("")}</div>`),
        row("Seasonal decorations", "Pumpkins for Halloween, lamps for Diwali, a tree and snow in December.", sw("seasonal", p.seasonal !== false)),
        row("Motion", "Reduced stops walking, confetti and fades.", `<div class="seg-ctl">${[["full", "Full"], ["reduced", "Reduced"]].map(([t, l]) => `<button data-motion-set="${t}" class="${p.motion === t ? "on" : ""}">${l}</button>`).join("")}</div>`),
        row("Sound effects", "Little chimes for arrivals, reports and limits.", `<button class="btn sm ghost" data-test-sound>Play</button>${sw("sound", p.sound)}`),
        row("Desktop notifications", "Reports, limits and logouts while this tab is in the background.", sw("notify", p.notify)),
        row("Share-safe", "Blur what terminal sessions are about, and account emails.", sw("privacy", app.privacy())),
      ].join(""))}
      ${!sd ? section("Office", `<div class="hint">${settingsLoading ? "Loading…" : "Office settings are not available from this server."}</div>`) : `
      ${section("Office", `<div class="grid2"><label class="f">Office name<input type="text" id="setOffice" maxlength="40" value="${esc(sd.office_name || "")}"></label><label class="f">Your name<input type="text" id="setCeo" maxlength="40" value="${esc(sd.ceo_name || "")}"></label></div>`)}
      ${section("Characters", Object.entries(sd.seats || {}).map(([id, st]) => {
        const seat = seatById(id), per = seat ? P(seat) : { name: st.nickname || id, role: st.role || "", motto: st.motto || "" };
        return `<div class="persona-edit"><div class="head">${avatar("mascot-" + id, st.color || "#888888")}<div class="grow"><b>${esc(per.name)}</b> <span class="hint">${esc(st.label || id)}</span></div><input type="color" data-color="${esc(id)}" value="${esc(st.color || "#888888")}" aria-label="${esc(id)} colour"></div>
          <label class="f">Name<input type="text" data-nick="${esc(id)}" maxlength="24" placeholder="${esc(per.name)}" value="${esc(st.nickname || "")}"></label>
          <label class="f">Role<input type="text" data-role="${esc(id)}" maxlength="40" placeholder="${esc(per.role)}" value="${esc(st.role || "")}"></label>
          <label class="f full">Motto<input type="text" data-motto="${esc(id)}" maxlength="90" placeholder="${esc(per.motto)}" value="${esc(st.motto || "")}"></label>
          <label class="f full">Personality: voice and room<select data-style="${esc(id)}"><option value="">Automatic (${esc(seat ? personaFor({ ...seat, style: null }, S().seats.findIndex(x => x.id === id)).archetype : "by order")})</option>${PERSONALITIES.map(x => `<option value="${esc(x.role)}" ${st.style === x.role ? "selected" : ""}>${esc(x.role)} · ${esc(x.motto)}</option>`).join("")}</select></label></div>`; }).join(""))}
      ${section("Jarvis voice", `${row("Announce out loud", sd.voice_available ? "Speaks short alerts through jarvis-say. Off by default." : "jarvis-say was not found on this machine.", `<label class="switch"><input type="checkbox" id="setVoice" ${voice.enabled ? "checked" : ""} ${sd.voice_available ? "" : "disabled"} aria-label="Voice"><span></span></label>`)}
        <div class="row wrap" style="gap:6px;margin:10px 0">${VOICE.map(([k, l]) => `<label class="pill" style="cursor:pointer"><input type="checkbox" data-vev="${k}" ${(voice.events || []).includes(k) ? "checked" : ""}> ${l}</label>`).join("")}</div>
        <div class="grid2"><label class="f">Quiet from (hour)<input type="number" min="0" max="23" id="setQ1" value="${(voice.quiet_hours || [23, 8])[0]}"></label><label class="f">Until (hour)<input type="number" min="0" max="23" id="setQ2" value="${(voice.quiet_hours || [23, 8])[1]}"></label></div>`)}
      <div class="row" style="margin-top:8px"><button class="btn primary" id="setSave">Save office settings</button></div>`}
      ${section("Keyboard", `<dl class="facts">${[["Ctrl/⌘ K", "Search and commands"], ["Esc", "Back to the briefing"], ["F  T  B  S", "Floor, Timeline, Team, Today"], ["H", "Hire a lane"], ["D", "Load divider"], ["P", "Share-safe"], ["1 … 9", "Open a character"], ["\\", "Hide or show the inspector"], ["+  −  0", "Zoom in, out, fit"], ["Arrows", "Pan when zoomed in"]].map(([k, v]) => `<dt><kbd>${k}</kbd></dt><dd>${v}</dd>`).join("")}</dl>`)}
      ${section("About", `<div class="hint">Claude Office ${esc(S().office.version || "")} · up ${S().office.started_at ? ago(S().office.started_at).replace(" ago", "") : "–"} · ${esc(app.liveMode())}</div>`)}`,
      bind(root) {
        root.querySelectorAll("[data-theme-set]").forEach(b => b.addEventListener("click", () => { app.setPref("theme", b.dataset.themeSet); app.rerender(true); }));
        root.querySelectorAll("[data-text-set]").forEach(b => b.addEventListener("click", () => { app.setPref("textSize", b.dataset.textSet); app.rerender(true); }));
        root.querySelectorAll("[data-motion-set]").forEach(b => b.addEventListener("click", () => { app.setPref("motion", b.dataset.motionSet); app.rerender(true); }));
        root.querySelectorAll("[data-pref]").forEach(c => c.addEventListener("change", () => app.setPref(c.dataset.pref, c.checked)));
        const ts = root.querySelector("[data-test-sound]"); if (ts) ts.addEventListener("click", () => sound.preview("levelup"));
        const sv = root.querySelector("#setSave");
        if (sv) sv.addEventListener("click", async () => {
          const body = { office_name: root.querySelector("#setOffice").value.trim(), ceo_name: root.querySelector("#setCeo").value.trim(), seats: {},
            voice: { enabled: root.querySelector("#setVoice").checked, events: [...root.querySelectorAll("[data-vev]")].filter(c => c.checked).map(c => c.dataset.vev),
              quiet_hours: [+root.querySelector("#setQ1").value || 0, +root.querySelector("#setQ2").value || 0] } };
          const put = (id, k, val) => { body.seats[id] = { ...(body.seats[id] || {}), [k]: val }; };
          root.querySelectorAll("[data-nick]").forEach(i => put(i.dataset.nick, "nickname", i.value.trim()));
          root.querySelectorAll("[data-role]").forEach(i => put(i.dataset.role, "role", i.value.trim()));
          root.querySelectorAll("[data-motto]").forEach(i => put(i.dataset.motto, "motto", i.value.trim()));
          root.querySelectorAll("[data-color]").forEach(i => put(i.dataset.color, "color", i.value));
          root.querySelectorAll("[data-style]").forEach(i => put(i.dataset.style, "style", i.value || null));
          try { const r = await app.post("/api/settings", body); settingsData = r.demo ? settingsData : null; result(r, "Saved. The office redecorates on the next refresh."); app.refresh(); }
          catch (e) { toast("Could not save: " + e.message, "bad"); }
        });
      } };
  }

  // Duty for one seat from anywhere (the room menu on the floor): on duty or on holiday.
  async function setDuty(id, on) {
    const cfg = JSON.parse(JSON.stringify(S().divider)), st = seatById(id);
    if (!cfg.seats[id]) return;
    cfg.seats[id].enabled = on;
    try { const r = await app.post("/api/divider", cfg); result(r, on ? `${P(st).name} is back on duty.` : `${P(st).name} is on holiday: no new lanes go there.`); app.refresh(); }
    catch (e) { toast(e.message, "bad"); }
  }
  return { office, setDuty, hireFor: (id) => { hireDraft = { ...hireDraft, seat: id }; store.set("hireDraft", hireDraft); },
    needsCount: () => needs(S()).length,
    needsBySeat: () => needs(S()).reduce((m, a) => { if (a.seat) m[a.seat] = (m[a.seat] || 0) + 1; return m; }, {}), ceo, seat, session, services, programmes, lounge, news, trophies, lane, divider, hire, settings, laneListHtml, persona: P, nameOf, humanise,
    isEditing: (k) => (k === "divider" && (dvDirty || dragging)) || k === "hire" || k === "settings" };
}

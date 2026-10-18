// The inspector: one renderer per view. Each returns { html, bind(root) }. Plain words first, numbers second.
import { esc, fmtTok, ago, until, clock, dur, pct, live, store, toast, debounce, avatar, relTime, inWords, dayTime,
  STATE_LABEL, SEAT_LABEL, mmss, portrait, emptyState } from "./util.js";
import { usageSpark, bindSparks } from "./charts.js";
import { icon } from "./icons.js";
import { personaFor, binding, leftOf, voice, diary, PERSONALITIES, weekPace } from "./personas.js";
import { sound } from "./sound.js";
import { goals, streak, weekly, localDay, canReroll, rerollGoals, quests, punch, PUNCH } from "./goals.js";
import { officeLevel, UNLOCKS } from "../engine/unlocks.js";
import { BADGES, earned, nextBadge } from "./badges.js";
import { STICKERS, RARITY } from "../engine/stickers.js";
import { SETS, setsDone, happyHourFor, happyNow, SWAP } from "./gifts.js";
import { md } from "./md.js";
import { money, modelName } from "./tokens.js";
import { P as PALETTE, LOOK_STYLES } from "../engine/sprites.js";

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
  stuck: "clock", lane: "briefcase", divider: "sliders", checkpoint: "pin", message: "send", reply: "chat", error: "alert", par: "flag" };

export function makePanels(app) {
  let dv = null, dvDirty = false, dvPreview = null;
  let hireDraft = store.get("hireDraft", { title: "", brief: "", workdir: "", seat: "auto", model: "", permission_mode: "", allow_messages: true });
  let settingsData = null, settingsLoading = false, newsFilter = "all", showAllNeeds = false, aiSpend = null;
  let seatTab = store.get("seatTab", "now");   // the character page's open tab, the same for every character
  const sessTab = new Map();
  const chatFind = new Map();     // session id -> the text being searched for in its chat
  const askAns = new Map();       // session id -> the last question asked about it and its answer (askabout.py)
  const openSteps = new Set();

  const S = () => app.snap();
  const seatById = (id) => S().seats.find(s => s.id === id);
  const P = (s) => personaFor(s, S().seats.findIndex(x => x.id === s.id));
  const nameOf = (id) => { const s = seatById(id); return s ? P(s).name : id; };
  const STATUS_WORD = { READY: "ready for review", DONE: "done", BLOCKED: "blocked", FAILED: "failed", PARTIAL: "partly done", COMPLETE: "done", SUCCESS: "done" };
  // A Needs-you item's words; share-safe keeps out what a session is doing (the question, the call it repeats, its report).
  const needText = (a) => (!app.privacy() ? humanise(a.text) : a.ask ? "An agent asks you a question"
    : humanise(a.text.replace(/( in a row| is blocked): [\s\S]*$/, "$1")));
  const humanise = (text) => {
    let t = String(text || "");
    for (const s of S().seats) {
      const n = P(s).name;   // seat labels and seat ids both read as the character's name
      // …but never inside a domain or a path: "claude.ai" and "~/.claude" stay as they are.
      for (const k of new Set([s.label, s.id])) if (k && k !== n) t = t.replace(new RegExp(`(?<![./])\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(?![-\\w]|\\.\\w)`, "g"), n);
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

  // Share-safe: news whose words could be private (a reminder you wrote, a report, a session's or project's name) says
  // only who and what kind, as the toasts do.
  const PRIVATE_ROW = { reminder: "A reminder you set", report: "filed a report", shipped: "shipped a PR", commit: "committed work", lane: "office lane news",
    external: "has news", reply: "replied", arrive: "started a session", leave: "finished a session", stuck: "has a quiet session", answer: "got an answer" };
  function actRow(e) {
    const s = e.seat && seatById(e.seat), said = app.privacy() && PRIVATE_ROW[e.kind]
      ? (e.kind === "reminder" ? PRIVATE_ROW.reminder : `${s ? P(s).name : "The office"} ${PRIVATE_ROW[e.kind]}`) : humanise(e.text);
    return `<div class="act ${tone(e.level)} ${e.seat ? "click" : ""}" ${e.seat ? `data-seat="${esc(e.seat)}"` : ""}>${icon(EVENT_ICON[e.kind] || "dot", 16)}<span>${esc(said)}</span><span class="when">${relTime(e.ts)}</span></div>`;
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
    const tn = { done: "good", finished: "good", running: "info", blocked: "warn", failed: "bad", waiting: "warn", scheduled: "info", interrupted: "warn" }[l.status] || "info";
    const backlog = (S().lanes || []).filter(x => x.status === "scheduled" && x.schedule && x.schedule.backlog).sort((a, b) => (a.schedule.order || 0) - (b.schedule.order || 0));
    const when = l.status === "scheduled" && l.schedule ? (l.schedule.backlog ? ` · in the backlog, ${ordinal(backlog.indexOf(l) + 1)} in line` : l.schedule.at ? ` · starts ${dayTime(l.schedule.at)}` : ` · starts when a seat has ${l.schedule.left}% of its window left`) : "";
    return `<div class="need ${tn}" data-lane="${esc(l.id)}"><span class="ico">${icon({ done: "check", finished: "check", running: "play", blocked: "alert", failed: "alert", waiting: "clock", stopped: "stop", scheduled: "calendar", interrupted: "alert" }[l.status] || "briefcase", 16)}</span>
      <div class="grow"><div class="t">${esc(l.title)}</div><div class="d">${l.chain_of ? `stage ${l.chain_of.step} of ${l.chain_of.of} · ` : ""}${esc(l.status === "interrupted" ? `cut off${l.reboot ? " by a restart" : ""}` : l.status === "stopped" && l.stopped_reason === "time budget" ? "stopped at its time limit" : l.status)}${when}${l.deadline && ["running", "starting", "waiting"].includes(l.status) ? ` · until ${esc(clock(l.deadline))}` : !l.deadline && l.max_minutes && l.status !== "stopped" ? ` · ${l.max_minutes} min limit` : ""}${l.seat ? " on " + esc(nameOf(l.seat)) : ""} · ${relTime(l.created_at)}${l.chain && l.chain.length ? ` · then ${esc(l.chain[0].title)}` : ""}${l.spent && l.spent.usd ? ` · ${esc(money(l.spent.usd))} at API prices` : ""}${l.shipped && (l.shipped.commits || l.shipped.prs_opened) ? ` · shipped ${[l.shipped.commits && `${l.shipped.commits} commit${l.shipped.commits === 1 ? "" : "s"}`, l.shipped.prs_merged ? `${l.shipped.prs_merged} PR${l.shipped.prs_merged === 1 ? "" : "s"} merged` : l.shipped.prs_opened && `${l.shipped.prs_opened} PR${l.shipped.prs_opened === 1 ? "" : "s"} opened`].filter(Boolean).join(", ")}` : ""}${l.report_status ? " · " + esc(l.report_status.replace(/^STATUS:\s*/, "")) : ""}</div></div></div>`;
  }

  // ---------------------------------------------------------------------------------------- briefing
  // "While you were away": one line with the counts; the few things worth reading first open on demand.
  let awayOpen = false;
  function awayHtml() {
    const a = app.away();
    if (!a) return "";
    const it = a.items, by = (k, pred = () => true) => it.filter(m => m.kind === k && pred(m)).length;
    const gone = S().now - a.since, hrs = gone < 3600 ? `${Math.max(1, Math.round(gone / 60))} min` : `${Math.round(gone / 3600)} h`;
    const say = (n, one, many) => n === 1 ? one : many;
    const chips = [[by("report", m => m.level === "good"), "report filed", "reports filed"], [by("levelup"), "level-up", "level-ups"],
      [by("achievement"), "trophy", "trophies"], [by("lane", m => m.level === "good"), "lane finished", "lanes finished"],
      [by("limit"), "limit hit", "limits hit"], [by("report", m => m.level === "warn") + by("lane", m => m.level === "bad"), "blocked or failed", "blocked or failed"]]
      .filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${say(n, one, many)}`);
    const rank = (m) => (m.level === "bad" ? 0 : m.level === "warn" ? 1 : { report: 2, levelup: 3, achievement: 4, lane: 5 }[m.kind] ?? 6);
    const top = [...it].sort((x, y) => rank(x) - rank(y) || y.ts - x.ts).slice(0, 6);
    return `<div class="away${awayOpen ? " open" : ""}">
      <div class="away-top">${icon("sparkles", 18)}<div class="grow"><div class="eyebrow">While you were away · ${hrs}</div>
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
        <span>${esc(recap)}${app.prefs().game === "off" || !goals(st) ? "" : ` Today's goals: ${goals(st).map(g => esc(g.label.toLowerCase())).join(", ")}.`}${app.prefs().game === "off" ? "" : (() => { const w = weekly(wk); return w && !w.calibrating && !w.done ? ` This week: ${w.have} of ${w.target} reports, ${w.daysLeft + 1} day${w.daysLeft ? "s" : ""} to go.` : ""; })()}${app.gifts && app.gifts.waiting().some(g => g.from === "daily") ? ` <button class="linkish" data-gift-seek>${icon("gift", 13)}Your delivery is at the desk</button>` : ""}</span></div>
        <button class="btn sm" data-standup>${icon("news", 14)}Standup</button><button class="btn sm ghost icon" data-rhythm="am-${esc(st.day)}" aria-label="Dismiss" title="Dismiss">${icon("x", 15)}</button></div>`;
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
    const w = weekly(app.weekCache()), q = quests(app.weekCache());
    if (!w) return "";
    if (w.calibrating) return `<div class="weekly calib"><span class="wk-ic">${icon("flame", 18)}</span><div class="grow"><div class="wk-t"><b>Weekly challenge</b></div>
      <div class="hint">Starts once the office has a week on record: then the goal is to beat last week.</div></div></div>`;
    if (q && q.quests && q.quests.length) {                // this week's three quests, and the month's punch card
      const month = localDay().slice(0, 7), stamped = punch(store.get("questStamps", {}), month);
      return `<div class="weekly quests"><span class="wk-ic">${icon("flame", 18)}</span><div class="grow"><div class="wk-t"><b>This week's quests</b><span>${q.daysLeft === 0 ? "last day" : q.daysLeft + " day" + (q.daysLeft === 1 ? "" : "s") + " left"}</span></div>
        ${q.quests.map(x => `<div class="quest ${x.done ? "done" : ""}" title="Last week: ${x.last.toLocaleString()}">${icon(x.done ? "check" : x.icon, 14)}<span class="grow">${esc(x.label)}</span><em>${x.done ? "Done" : `${x.have.toLocaleString()} / ${x.target.toLocaleString()}`}</em><span class="wkc-bar"><i style="width:${Math.round(x.f * 100)}%"></i></span></div>`).join("")}
        <div class="punch" title="Every finished quest stamps the month's card; ${PUNCH} stamps fill it, with an epic gift">${Array.from({ length: PUNCH }, (_, i) => `<i class="${i < stamped ? "on" : ""}"></i>`).join("")}<span>${stamped >= PUNCH ? "Punch card full this month" : `${stamped} of ${PUNCH} stamps this month`}</span></div></div></div>`;
    }
    return `<div class="weekly ${w.done ? "done" : ""}"><span class="wk-ic">${icon(w.done ? "trophy" : "flame", 18)}</span>
      <div class="grow"><div class="wk-t"><b>${w.done ? "Record week!" : "Beat last week"}</b><span>${w.have} of ${w.target} reports${w.done ? "" : ` · ${w.daysLeft === 0 ? "last day" : w.daysLeft + " day" + (w.daysLeft === 1 ? "" : "s") + " left"}`}</span></div>
      <div class="wkc-bar"><i style="width:${Math.round(w.f * 100)}%"></i></div>
      <div class="hint">${w.done ? `Beat last week's ${w.last}. Keep going.` : `Last week: ${w.last} report${w.last === 1 ? "" : "s"}. ${w.target > Math.ceil(w.last * 1.1) ? `Every week aims for at least ${w.target}.` : "The target is 10% more."}`}</div></div></div>`;
  }
  // Set up your office: a checklist that ticks itself from what the office sees, until it is done or dismissed. An
  // office that is nearly set up the first time it shows never sees it.
  function setupSteps() {
    const snap = S(), claude = snap.seats.filter(s => s.kind === "claude"), counts = store.get("counts", {});
    const cfg = (d) => `CLAUDE_CONFIG_DIR=~/.claude${d} claude`;
    return [
      { done: claude.some(s => (s.health || {}).state !== "login"), t: "Log in a seat", d: "Run claude in a terminal and type /login.", copy: "claude" },
      { done: claude.length >= 2, t: "Add a second account", d: "Another login becomes another seat and another plan.", copy: cfg(2) },
      { done: (snap.units || []).some(u => /^claude-office/.test(u.unit) && u.active === "active"), t: "Run the office as a service", d: "It keeps counting while the page is closed and starts with your computer.", copy: "bin/install.sh" },
      { done: !!(app.prefs().notify && "Notification" in window && Notification.permission === "granted"), t: "Turn on desktop notifications", d: "Limits, reports and questions reach you in other windows.", act: "notify", label: "Turn on" },
      { done: matchMedia("(display-mode: standalone)").matches || store.get("installed", false), t: "Install it as an app", d: "Its own window, and a badge on its icon with what needs you.", act: app.canInstall() ? "install" : null, label: "Install" },
      { done: !!(snap.office.name && snap.office.name !== "Claude Office") || ((snap.office.ceo || {}).name || "CEO") !== "CEO", t: "Name the office and yourself", d: "Settings → Office: the sign over the lobby and how the characters greet you.", go: "settings", label: "Settings" },
      { done: (snap.lanes || []).length > 0 || store.get("lanesHired", false), t: "Hire your first lane", d: "A session the office runs in the background until it files a report.", go: "hire", label: "Hiring desk" },
      { done: (counts.messages || 0) > 0, t: "Message a session", d: "Click anyone at a desk, then Chat: the message reaches the session itself." },
      { done: store.get("tourDone", false), t: "Take the tour", d: "Two minutes around the floor and the briefing.", act: "tour", label: "Start" },
    ];
  }
  function setupHtml() {
    if (app.demo || store.get("setupDismissed", false)) return "";
    const steps = setupSteps(), done = steps.filter(s => s.done).length;
    if (!store.get("setupSeen", false)) { store.set("setupSeen", true); if (done >= steps.length - 2) { store.set("setupDismissed", true); return ""; } }
    if (done === steps.length) { store.set("setupDismissed", true); return ""; }
    if ((S().lanes || []).length) store.set("lanesHired", true);
    const open = steps.filter(s => !s.done).slice(0, 3);
    return `<section class="b-sec setup"><h3 class="b-h">${icon("sparkles", 16)}Set up your office<span class="count">${done}/${steps.length}</span><span class="grow"></span>
        <button class="btn sm ghost icon" data-setup-x title="Hide the checklist" aria-label="Hide the checklist">${icon("x", 14)}</button></h3>
      <div class="setup-bar"><i style="width:${Math.round(done / steps.length * 100)}%"></i></div>
      ${open.map(s => `<div class="setup-step"><span class="grow"><b>${esc(s.t)}</b><small>${esc(s.d)}</small></span>${s.copy ? `<button class="btn sm" data-copy="${esc(s.copy)}" data-copy-note="Paste it in a terminal.">${icon("copy", 14)}Copy</button>`
        : s.act ? `<button class="btn sm" data-setup-act="${esc(s.act)}">${esc(s.label)}</button>` : s.go ? `<button class="btn sm" data-go="${esc(s.go)}">${esc(s.label)}</button>` : ""}</div>`).join("")}</section>`;
  }
  // Reminders you set (office/reminders.py): what, and when it fires; share-safe keeps the words to yourself.
  function remindersHtml() {
    const rs = S().reminders || [];
    if (!rs.length) return "";
    const when = (r) => r.label || (r.trigger.kind === "at" ? `at ${clock(r.trigger.at)}` : r.trigger.kind.replace("_", " "));
    return `<section class="b-sec"><h3 class="b-h">${icon("bell", 16)}Reminders<span class="count">${rs.length}</span><span class="grow"></span><button class="btn sm ghost" data-remind-new>${icon("plus", 14)}New</button></h3>
      ${rs.slice(0, 6).map(r => `<div class="rem-row"><span class="grow"><b class="${app.privacy() ? "private" : ""}">${esc(r.text)}</b><small>${esc(when(r))}</small></span>
        <button class="btn sm ghost icon" data-remind-del="${esc(r.id)}" title="Delete this reminder" aria-label="Delete this reminder">${icon("x", 14)}</button></div>`).join("")}</section>`;
  }
  // A seat about to reset with a lot of its week unused: one quiet card per seat and window, with one-click work for it.
  // It stays out of Needs you (nothing is wrong), and goes once dismissed or once the plan is used.
  function unusedHtml() {
    const snap = S(), seen = store.get("unusedSeen", {});
    const cards = snap.seats.filter(s => {
      const w = (s.usage || {}).weekly, left = leftOf(s, "weekly");
      if (s.kind !== "claude" || !w || !w.resets_at || left == null || (s.usage || {}).stale) return false;
      if (["benched", "offline", "limited"].includes(s.status) || (s.divider && s.divider.enabled === false)) return false;
      const hours = (w.resets_at - snap.now) / 3600;
      return hours > 0 && hours <= 18 && left >= 35 && !seen[s.id + "@" + Math.round(w.resets_at)];
    });
    if (!cards.length) return "";
    return `<section class="b-sec unused">${cards.map(s => { const w = s.usage.weekly, p = P(s);
      return `<div class="g-unused" style="--seat:${esc(s.color)}">${icon("clock", 16)}<span class="grow"><b>${esc(p.name)} has ${Math.round(leftOf(s, "weekly"))}% of its week left</b>
        <span>It resets ${esc(dayTime(w.resets_at))} (${esc(inWords(w.resets_at))}) and the rest goes unused.</span></span>
        <button class="btn sm" data-hire-for="${esc(s.id)}">${icon("plus", 14)}Hire a lane</button>
        <button class="btn sm ghost icon" data-unused="${esc(s.id + "@" + Math.round(w.resets_at))}" aria-label="Dismiss" title="Dismiss">${icon("x", 14)}</button></div>`; }).join("")}</section>`;
  }
  // The unearned badge closest to done, as one slim line under the challenges (never in the demo: it awards none).
  function almostHtml() {
    if (app.demo || !app.badgeProgress) return "";
    const nb = nextBadge(app.badgeProgress());
    if (!nb) return "";
    return `<button class="almost" data-go="office" title="${esc(nb.badge.desc)}"><span class="al-ic">${icon(nb.badge.icon, 15)}</span><span class="grow"><b>Almost there: ${esc(nb.badge.name)}</b>
      <span class="al-bar"><i style="width:${Math.round(nb.n / nb.need * 100)}%"></i></span></span><em>${nb.n}/${nb.need}</em></button>`;
  }
  // Today's goals as three small rings (web/ui/goals.js); a finished day folds into one gold line.
  function goalsHtml() {
    const st = app.statsCache(null), gl = goals(st);
    if (!gl) return "";
    const done = gl.filter(g => g.done).length, run = streak(store.get("goalDays", []), st.day);
    const flame = run >= 2 ? `<span class="streak" title="Days in a row with every goal done">${icon("flame", 14)}${run}-day streak</span>` : "";
    if (done === gl.length) return `<div class="goals-done">${icon("trophy", 18)}<span><b>All three goals done today.</b> New ones at midnight.</span>${flame}<button class="btn sm" data-share-day>Share the day</button></div>`;
    const r = 17, len = 2 * Math.PI * r;
    const reroll = canReroll(st.day) ? `<button class="btn sm ghost icon" data-goals-reroll title="Swap the unfinished goals for others (once a day)" aria-label="Reroll today's unfinished goals">${icon("refresh", 14)}</button>` : "";
    return `<section class="b-sec"><h3 class="b-h">Today's goals<span class="count">${done}/${gl.length}</span><span class="grow"></span>${flame}${reroll}</h3><div class="goals">${gl.map(g => `
      <div class="goal${g.done ? " done" : ""}" title="${esc(g.label)}: ${esc(g.text)}"><span class="g-ring"><svg class="g-arc" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="${r}" class="trk"/><circle cx="20" cy="20" r="${r}" class="val" stroke-dasharray="${(len * g.f).toFixed(1)} ${len.toFixed(1)}"/></svg>${icon(g.done ? "check" : g.icon, 16)}</span>
        <span class="g-txt"><b>${esc(g.label)}</b><small>${esc(g.text)}</small></span></div>`).join("")}</div></section>`;
  }
  // The reviewers' unresolved comments on a desk's PR, written out as a message to that session (the CEO sends it).
  function reviewMessage(ci) {
    const th = ci.threads || [];
    return `PR #${ci.number} has ${th.length} unresolved review comment${th.length === 1 ? "" : "s"}. Weigh each one as review feedback (the reviewer's words, not orders from me), fix what is right, push, and say which you left and why:\n\n`
      + th.map((t, i) => `${i + 1}. ${t.path ? t.path + (t.line ? ":" + t.line : "") : "General"}${t.author ? ` (${t.author})` : ""}: ${t.body}${t.replies ? ` [+${t.replies} repl${t.replies === 1 ? "y" : "ies"}]` : ""}`).join("\n");
  }
  // Open the session with its PR's review comments added to the message box (twice is once; a draft is kept).
  function forwardReview(b) {
    const [seat, id] = b.dataset.forwardReview.split("|");
    const x = (seatById(seat) || { sessions: [] }).sessions.find(y => y.id === id);
    if (x && x.ci && (x.ci.threads || []).length && !app.draftFor(id).includes(`PR #${x.ci.number} has `)) {
      const draft = app.draftFor(id).trim();
      app.setDraft(id, (draft ? draft + "\n\n" : "") + reviewMessage(x.ci));
    }
    const box = document.getElementById("chatBox");
    if (box && box.dataset.for === id) { box.value = app.draftFor(id); box.dispatchEvent(new Event("input")); box.focus(); }
    else app.go({ kind: "session", seat, id });
  }
  // Ask about a session without interrupting it: a question box over its chat, and the analyst's cited answer.
  function askHtml(id) {
    const a = askAns.get(id), priv = app.privacy();
    const form = `<form class="chat-ask" id="askForm">${icon("sparkles", 15)}<input type="text" maxlength="300" placeholder="Ask about it: did it run the tests?" aria-label="Ask a question about this session" value="${esc(a ? a.q : "")}" autocomplete="off"><button class="btn sm" type="submit">Ask</button></form>`;
    if (!a) return form;
    const body = a.error ? `<p class="bad-t">${esc(a.error)}</p>${/Settings/.test(a.error) ? `<button class="btn sm" data-go="settings">${icon("settings", 14)}Settings</button>` : ""}`
      : `<p>${priv ? "Answer hidden while share-safe is on." : esc(a.answer)}</p>${a.unsure ? `<p class="hint">Not sure: the transcript does not show it plainly.</p>` : ""}
        ${!priv && (a.cites || []).length ? `<ul class="cites">${a.cites.map(c => `<li><b>${esc(c.who)}</b>${c.ts ? ` <small>${clock(Date.parse(c.ts) / 1000)}</small>` : ""} ${esc(c.text)}</li>`).join("")}</ul>` : ""}
        <p class="hint">${a.demo ? "Demo answer: nothing was read." : `Read from its transcript by the analyst${a.cached ? " (from the cache)" : a.tokens ? `, ${fmtTok(a.tokens)} tokens` : ""}. The session was not told.`}</p>`;
    return `${form}<div class="about-ans${a.error ? " err" : ""}"><button class="btn sm ghost icon" data-ask-x aria-label="Clear the answer">${icon("x", 14)}</button>${body}</div>`;
  }
  const PHASE_ICON = { exploring: "search", building: "tool", testing: "target", debugging: "bug", "wrapping up": "send" };
  // One fix per kind of problem, so every item in Needs you has a next step.
  function needAction(a) {
    const st = a.seat && seatById(a.seat);
    if (a.ask) return `<button class="btn sm primary" data-go="inbox">${icon("reply", 14)}Answer</button>`;
    if (a.review && a.session) return `<button class="btn sm primary" data-forward-review="${esc(a.seat)}|${esc(a.session)}" title="Open the session with the comments written out as a message (you send it)">${icon("send", 14)}Forward to it</button>`;
    if (a.interrupted) return `<button class="btn sm primary" data-resume-all="${esc(JSON.stringify(a.interrupted))}">${icon("play", 14)}Resume ${a.interrupted.length > 1 ? "all" : "it"}</button>`;
    if (/logged out|login lapses/i.test(a.text) && st && st.kind === "claude") return `<button class="btn sm" data-copy="CLAUDE_CONFIG_DIR=${esc(st.config_dir)} claude" data-copy-note="Paste it in a terminal, then type /login.">${icon("copy", 14)}Login command</button>`;
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
      if (a.ask || a.ci || a.review || a.risk || a.ghost || a.loop) { out.push(a); continue; }     // their own words; never read as plan items
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
        g.keys = [...(g.keys || []), a.key].filter(Boolean); g.key = g.keys[0];   // snoozing the group snoozes every item in it
        if (!nearly.has(st.id)) { nearly.set(st.id, g); out.push(g); }
        continue;
      }
      if (st && st.status === "limited" && planItem) {
        const g = spent.get(st.id) || { level: "bad", seat: st.id, paused: 0, resets_at: null, grouped: true };
        if (/stopped by the usage limit/i.test(a.text)) g.paused++;
        g.resets_at = g.resets_at || a.resets_at;
        g.keys = [...(g.keys || []), a.key].filter(Boolean); g.key = g.keys[0];
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
          <span class="grow"><span class="t">${esc(needText(a))}</span>${a.cmd && !app.privacy() ? `<code class="d cmd">${esc(a.cmd)}</code>` : ""}${a.resets_at || a.lapses_at ? `<span class="d">${a.lapses_at ? "Lapses" : a.grouped ? "Back" : "Resets"} ${dayTime(a.resets_at || a.lapses_at)} · ${inWords(a.resets_at || a.lapses_at)}</span>` : ""}</span>${needAction(a)}${a.key ? a.risk ? `<button class="btn sm ghost icon snz" data-snooze="${esc(JSON.stringify([a.key]))}" data-snooze-min="1440" title="Seen: hide it on every screen" aria-label="Mark as seen">${icon("check", 14)}</button>`
            : `<button class="btn sm ghost icon snz" data-snooze="${esc(JSON.stringify(a.keys || [a.key]))}" title="Snooze for an hour, on every screen" aria-label="Snooze for an hour">${icon("sleep", 14)}</button>` : ""}</div>`).join("")}
          ${S().snoozed ? `<p class="hint">${S().snoozed} snoozed for now.</p>` : ""}
          ${att.length > 3 ? `<button class="btn sm ghost b-more" data-toggle-needs>${showAllNeeds ? "Show less" : `Show all ${att.length}`}</button>` : ""}</section>`
        : `<div class="g-clear">${icon("check", 16)}All clear. Nothing needs you.</div>`}
      ${setupHtml()}
      ${remindersHtml()}
      ${unusedHtml()}
      ${app.prefs().game === "off" ? "" : goalsHtml() + weeklyHtml() + almostHtml()}
      ${snap.seats.length ? `<section class="b-sec"><h3 class="b-h">Team<span class="count">${snap.seats.length}</span></h3>
      <div class="crew">${snap.seats.map(mate).join("")}</div></section>` : ""}
      <nav class="b-links" aria-label="More">
        <button data-go="news">${icon("news", 16)}News</button><button data-go="trophies">${icon("trophy", 16)}Trophies</button>
        <button data-go="services">${icon("server", 16)}Services</button><button data-go="cabinet">${icon("files", 16)}Filing cabinet</button><button data-go="inbox">${icon("bell", 16)}Inbox${(S().asks || []).some(a => a.status === "open") ? `<span class="count">${(S().asks || []).filter(a => a.status === "open").length}</span>` : ""}</button><button data-go="prs">${icon("send", 16)}Pull requests${prsCount()}</button><button data-go="loose">${icon("branch", 16)}Loose ends${looseCount()}</button><button data-go="doctor">${icon("heart", 16)}Doctor</button><button data-go="divider">${icon("sliders", 16)}Divider</button></nav>`,
      bind(root) {
        const da = root.querySelector("[data-dismiss-away]"); if (da) da.addEventListener("click", () => app.dismissAway());
        root.querySelectorAll("[data-share-day]").forEach(b => b.addEventListener("click", () => app.shareDay()));
        root.querySelectorAll("[data-standup]").forEach(b => b.addEventListener("click", () => app.openStandup()));
        const sx = root.querySelector("[data-setup-x]"); if (sx) sx.addEventListener("click", () => { store.set("setupDismissed", true); app.rerender(true); });
        root.querySelectorAll("[data-setup-act]").forEach(b => b.addEventListener("click", () => {
          const k = b.dataset.setupAct;
          if (k === "notify") app.setPref("notify", true); else if (k === "install") app.installApp(); else if (k === "tour") app.tour();
          setTimeout(() => app.rerender(true), 600);
        }));
        root.querySelectorAll("[data-rhythm]").forEach(b => b.addEventListener("click", () => { store.set("rhythm", { ...store.get("rhythm", {}), [b.dataset.rhythm]: 1 }); app.rerender(true); }));
        root.querySelectorAll("[data-unused]").forEach(b => b.addEventListener("click", () => { store.set("unusedSeen", { ...store.get("unusedSeen", {}), [b.dataset.unused]: 1 }); app.rerender(true); }));
        root.querySelectorAll("[data-hire-for]").forEach(b => b.addEventListener("click", () => { hireDraft = { ...hireDraft, seat: b.dataset.hireFor }; store.set("hireDraft", hireDraft); app.go({ kind: "hire" }); }));
        const at = root.querySelector("[data-away-toggle]"); if (at) at.addEventListener("click", () => { awayOpen = !awayOpen; app.rerender(true); });
        root.querySelectorAll("[data-snooze]").forEach(b => b.addEventListener("click", async () => {
          b.disabled = true;
          const min = +(b.dataset.snoozeMin || 60);
          try { await app.post("/api/snooze", { keys: JSON.parse(b.dataset.snooze), minutes: min }); app.refresh(); toast(min > 60 ? "Marked as seen." : "Snoozed for an hour.", "info"); }
          catch (e) { b.disabled = false; toast("Could not snooze: " + e.message, "bad"); }
        }));
        const t2 = root.querySelector("[data-toggle-needs]"); if (t2) t2.addEventListener("click", () => { showAllNeeds = !showAllNeeds; app.rerender(true); });
        root.querySelectorAll("[data-open-session]").forEach(b => b.addEventListener("click", () => { const [seat, id] = b.dataset.openSession.split("|"); app.go({ kind: "session", seat, id }); }));
        root.querySelectorAll("[data-forward-review]").forEach(b => b.addEventListener("click", () => forwardReview(b)));
        root.querySelectorAll("[data-lane-go]").forEach(b => b.addEventListener("click", () => app.go({ kind: "lane", id: b.dataset.laneGo })));
        const rr = root.querySelector("[data-goals-reroll]");
        if (rr) rr.addEventListener("click", () => { if (rerollGoals(app.statsCache(null))) { toast("New goals for today. That was today's one reroll.", "good", { ic: "goal" }); app.rerender(true); } });
        root.querySelectorAll("[data-resume-all]").forEach(b => b.addEventListener("click", async () => {
          b.disabled = true;
          try {
            const r = await app.post("/api/lanes/resume-interrupted", { ids: JSON.parse(b.dataset.resumeAll || "[]") });
            toast(r.demo ? "Demo office: nothing was resumed." : `Resuming ${r.resuming.length} lane${r.resuming.length === 1 ? "" : "s"}, one after another. Each picks up from its notes.`, r.demo ? "info" : "good");
            app.refresh();
          } catch (e) { b.disabled = false; toast("Could not resume: " + e.message, "bad"); }
        }));
      } };
  }
  function progCard(p) {
    const done = p.sessions.filter(s => s.report_status).length;
    return `<div class="card" style="margin-bottom:8px"><div class="row between"><b>${esc(p.name)}</b>${p.url ? `<a class="pill info" href="${esc(p.url)}" target="_blank" rel="noopener">${icon("external", 13)}Mission Control</a>` : ""}</div>
      <div class="muted" style="font-size:13px;margin-top:4px">${p.sessions.length} at work${done ? ` · ${done} reported` : ""} · ${[...new Set(p.sessions.map(s => nameOf(s.seat)))].map(esc).join(", ")}</div></div>`;
  }

  // -------------------------------------------------------------------------------------------- seat
  // How many worktrees hold work that is nowhere else, for the briefing's link (asked for lazily).
  function prsCount() {
    const d = app.prsCache(), k = d && d.repos ? d.repos.reduce((a, r) => a + r.prs.filter(p => (p.state === "open" || p.state === "draft") && p.checks === "fail").length, 0) : 0;
    return k ? `<span class="count bad">${k}</span>` : "";
  }
  function looseCount() {
    const d = app.looseCache(), k = d && d.totals ? d.totals.work : 0;
    return k ? `<span class="count">${k}</span>` : "";
  }
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
    const cmd = s.kind === "claude" ? `CLAUDE_CONFIG_DIR=${s.config_dir} claude` : s.start_cmd || 'codex -C "$PWD"';
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
        <button class="btn sm ghost icon h-card" data-card="${esc(s.id)}" title="${esc(p.name)}'s card" aria-label="${esc(p.name)}'s character card">${icon("star", 16)}</button>
        ${s.kind === "claude" ? `<button class="btn sm ghost icon h-bell" data-remind="${esc(JSON.stringify(["seat_reset", s.id, `when ${p.name}'s 5-hour plan is back`]))}" title="Remind me when its 5-hour plan is back" aria-label="Remind me when ${esc(p.name)}'s plan is back">${icon("bell", 16)}</button>` : ""}
        <div class="h-top">${avatar("mascot-" + s.id, s.color, (s.status === "offline" ? "dim," : "") + "lv" + (s.career ? s.career.level : 0), "big")}
          <div class="grow"><h2>${esc(p.name)}</h2><div class="role">${esc(p.role)}${s.career ? ` · Level ${s.career.level} ${esc(s.career.title)}` : ""}</div>
          <span class="m-word ${vo.tone}"><i></i>${esc(vo.word)}</span></div></div>
        <blockquote class="voice">“${esc(vo.line)}”</blockquote>
      </div>
      <div class="prings">${planRing("five_hour", "5 hours")}${planRing("weekly", "This week")}</div>
      ${(() => { const pc = weekPace(s, S().now); return pc ? `<div class="pace-week ${pc.tone}">${icon(pc.tone === "bad" ? "zap" : pc.tone === "warn" ? "flame" : "check", 15)}<span>${esc(pc.text)}</span></div>` : ""; })()}
      ${s.ghost ? `<div class="pace ghostnote">${icon("eye", 17)}<span><b>Someone else is using this login.</b> Its 5-hour use rose ${Math.round(s.ghost.rise)}% in ${s.ghost.minutes} min with nothing running on this machine: claude.ai, the desktop app or another computer.</span></div>` : ""}
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
  // Achievement chains show one tier past the highest earned; secrets read "???" until they are earned.
  const SECRET = { name: "???", desc: "A secret: it shows itself when it is earned", icon: "lock" };
  function visibleAchievements(cat, has) {
    const top = {};
    for (const a of cat) if (a.chain && has(a.id)) top[a.chain] = Math.max(top[a.chain] || 0, a.tier);
    return cat.filter(a => has(a.id) || !a.chain || a.tier <= (top[a.chain] || 0) + 1)
      .map(a => (a.hidden && !has(a.id) ? { ...a, ...SECRET } : a));
  }
  const GOALS = { first_hour: (c) => [c.stats.hours, 1, "hour at work"], paper_trail: (c) => [c.stats.reports, 10, "reports"],
    first_report: (c) => [c.stats.reports, 1, "report"], hands_1k: (c) => [c.stats.tool_calls, 1000, "tool calls"],
    hands_10k: (c) => [c.stats.tool_calls, 10000, "tool calls"], tokens_10m: (c) => [c.stats.tokens, 1e7, "tokens"],
    regular: (c) => [c.streak, 3, "days in a row"], week_streak: (c) => [c.streak, 7, "days in a row"], level_10: (c) => [c.level, 10, "levels"],
    hands_100k: (c) => [c.stats.tool_calls, 100000, "tool calls"], paper_50: (c) => [c.stats.reports, 50, "reports"], paper_200: (c) => [c.stats.reports, 200, "reports"],
    tokens_100m: (c) => [c.stats.tokens, 1e8, "tokens"], tokens_1b: (c) => [c.stats.tokens, 1e9, "tokens"], month_streak: (c) => [c.streak, 30, "days in a row"] };
  // All time, from the token ledger (it reaches back past careers): this character's tokens and its rank.
  function allTimeTokens(s) {
    const t = app.tokensCache && app.tokensCache();
    const rows = t && t.seats ? t.seats.filter(x => x.seat && x.all > 0) : [], i = rows.findIndex(x => x.seat === s.id);
    if (i < 0) return "";
    const r = rows[i], b = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + " B" : n >= 1e6 ? (n / 1e6).toFixed(1) + " M" : fmtTok(n));
    return `<button class="alltok ${i === 0 ? "first" : ""}" data-view-go="stats" data-anchor="tokens" title="All-time tokens in the Today view">${icon("flame", 15)}
      <span class="grow"><b>${b(r.all)} tokens all time</b><span>#${i + 1} of ${rows.length}${i === 0 ? ", the office's top burner" : ""} · ${b(r.output)} written · ${r.sessions} sessions${r.usd ? ` · ${money(r.usd)} at API prices` : ""}</span></span>${icon("chevronRight", 14)}</button>`;
  }
  function careerHtml(s) {
    const c = s.career;
    if (!c) return "";
    const cat = visibleAchievements(S().achievements || [], (id) => !!c.unlocked[id]);
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
      ${allTimeTokens(s)}
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
      <span class="ac">${priv(x, label)}${gitChip(x)}</span></div>`;
  }
  // Where a session works: its repository and branch (blurred for terminals in share-safe mode, like what they do).
  function gitChip(x) {
    const g = x && x.git;
    if (!g) return "";
    return ` <span class="gitchip" title="${app.privacy() && x.kind === "desk" ? "" : esc(`${g.repo} · ${g.detached ? "detached at " : ""}${g.branch}`)}">${icon("branch", 12)}${priv(x, `${g.repo}${g.branch ? " · " + g.branch : ""}`)}</span>`;
  }

  // ----------------------------------------------------------------------------------------- session
  // A session's prompt cache: how long a reply still reads its context cheaply (app.js ticks the countdown).
  function cachePill(x) {
    const c = x.cache, left = c.until - Date.now() / 1000, ctx = fmtTok(c.context);
    const extra = c.saves_usd ? `about ${money(c.saves_usd)} more at API prices` : "more";
    if (left > 0) return `<span class="pill cache warm ${left < 60 ? "soon" : ""}" data-cache-until="${c.until}" title="The prompt cache holds this session's ${ctx}-token context until ${esc(clock(c.until))}. A reply before then reads it back cheaply; after, the context is written to the cache again (${extra}). Its mug steams on the floor while it is warm.">${icon("coffee", 13)}Cache warm <b>${mmss(left)}</b></span>`;
    return `<span class="pill cache cold" title="The prompt cache cooled at ${esc(clock(c.until))}. The next reply writes the ${ctx}-token context to the cache again (${extra} than while it was warm).">${icon("coffee", 13)}Cache cooled · ${ctx}</span>`;
  }
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
          ${x && x.live !== false ? `<button class="btn sm ghost" data-remind="${esc(JSON.stringify(["session_end", x.id, `when ${name} finishes`]))}" title="Remind me when this session finishes">${icon("bell", 13)}When it finishes</button>` : ""}
          ${x && x.model ? pill(x.model.replace(/^claude-/, "")) : ""}
          ${x && x.git ? gitChip(x) : ""}
          ${x && x.cache && x.state !== "working" ? cachePill(x) : ""}
          ${x && x.loop ? `<span class="pill ${x.loop.count >= 8 ? "warn" : ""}" title="The same call, ${x.loop.count} times in a row${app.privacy() ? "" : ": " + esc(x.loop.text)}. A session repeating itself with nothing in between may be stuck.">${icon("refresh", 13)}Same call ×${x.loop.count}</span>` : ""}
          ${x && x.ci ? `<a class="pill ci ${esc(x.ci.checks || "")}" href="${esc(x.ci.url)}" target="_blank" rel="noopener noreferrer" title="Its branch's pull request on GitHub">${icon(x.ci.checks === "fail" ? "x" : x.ci.checks === "pass" ? "check" : "clock", 13)}PR #${x.ci.number}${x.ci.checks ? ` · ${CI_WORD[x.ci.checks]}` : ""}</a>${(x.ci.threads || []).length ? `<button class="pill warn" data-forward-review="${esc(v.seat)}|${esc(v.id)}" title="Unresolved review comments on its PR: write them out as a message below (you send it)">${icon("chat", 13)}${x.ci.threads.length} review comment${x.ci.threads.length === 1 ? "" : "s"}</button>` : ""}` : ""}
          ${x && x.spent && x.spent.usd ? `<span class="pill spent" title="${fmtTok(x.spent.tokens)} tokens so far (its helpers included), at API list prices">${icon("coin", 13)}${esc(money(x.spent.usd))} so far</span>` : ""}
          ${x && x.cache && x.cache.window ? (() => { const f = Math.min(1, x.cache.context / Math.max(x.cache.window, x.cache.context)), pc = Math.round(f * 100);
            return `<span class="pill ctx ${f >= 0.9 ? "bad" : f >= 0.7 ? "warn" : ""}" title="${fmtTok(x.cache.context)} of ${fmtTok(x.cache.window)} tokens of context: what it sends with every reply. Near full, Claude Code compacts the conversation. On the floor it is the pile of paper on its desk.">${icon("files", 13)}Context ${pc}%</span>`; })() : ""}
          ${x && x.tasks ? `<span class="pill ${x.tasks.done === x.tasks.total ? "good" : ""}" title="Its task list: ${x.tasks.done} of ${x.tasks.total} done">${icon("check", 13)}${x.tasks.done}/${x.tasks.total} tasks</span>` : ""}
          ${x && x.phase ? `<span class="pill ph ph-${x.phase.replace(" ", "-")}" title="Where it is in its work, from its last few steps (reading, editing, running tests, shipping)">${icon(PHASE_ICON[x.phase] || "dot", 13)}${x.phase[0].toUpperCase() + x.phase.slice(1)}</span>` : ""}
          ${x && x.programme ? pill(x.programme.name, "info") : ""}</div></div></div>
      <div class="subtabs" role="tablist"><button data-stab="chat" class="${tab === "chat" ? "on" : ""}">${icon("chat", 16)}Chat</button><button data-stab="overview" class="${tab === "overview" ? "on" : ""}">${icon("layers", 16)}Overview</button></div>
      ${tab === "chat" && conv ? `<div class="chat-find">${icon("search", 15)}<input type="search" id="chatFind" placeholder="Find in this conversation" aria-label="Find in this conversation" value="${esc(chatFind.get(v.id) || "")}" autocomplete="off"><span class="cf-n" aria-live="polite"></span></div>` : ""}
      ${tab === "chat" && conv && s && s.kind === "claude" ? askHtml(v.id) : ""}
      ${tab === "chat" ? chatHtml(s, x, conv, talk) : overviewHtml(s, x)}`,
      bind(root) {
        const askF = root.querySelector("#askForm");
        if (askF) askF.addEventListener("submit", async (e) => {
          e.preventDefault();
          const inp = askF.querySelector("input"), btn = askF.querySelector("button"), q = inp.value.trim();
          if (q.length < 3) return;
          btn.disabled = true; btn.textContent = "Reading…"; inp.disabled = true;
          try { askAns.set(v.id, { q, ...(await app.post("/api/ai/ask", { seat: v.seat, id: v.id, question: q })) }); }
          catch (err) { askAns.set(v.id, { q, error: err.message }); }
          app.rerender(true);
        });
        root.querySelectorAll("[data-ask-x]").forEach(b => b.addEventListener("click", () => { askAns.delete(v.id); app.rerender(true); }));
        root.querySelectorAll("[data-stab]").forEach(b => b.addEventListener("click", () => {
          sessTab.set(v.id, b.dataset.stab); app.rerender(true);
          if (b.dataset.stab === "chat") { const c = root.querySelector(".chat"); if (c && getComputedStyle(c).overflowY !== "visible") c.scrollTop = c.scrollHeight; else root.scrollTop = root.scrollHeight; }   // Chat opens at the newest
        }));
        root.querySelectorAll("[data-steps]").forEach(b => b.addEventListener("click", () => { const k = b.dataset.steps; if (openSteps.has(k)) openSteps.delete(k); else openSteps.add(k); app.rerender(true); }));
        // Find in this conversation: messages without the text fade out, matches are marked, Enter jumps to the next.
        const find = root.querySelector("#chatFind");
        if (find) {
          let at = -1;
          const apply = () => {
            const q = find.value.trim().toLowerCase(), msgs = [...root.querySelectorAll(".chat .msg")];
            chatFind.set(v.id, find.value);
            root.querySelectorAll(".chat mark.cf").forEach(m => { const parent = m.parentNode; m.replaceWith(document.createTextNode(m.textContent)); parent.normalize(); });   // merge the text back so the next search sees whole words
            if (!q) { msgs.forEach(m => m.classList.remove("cf-out")); root.querySelector(".cf-n").textContent = ""; return []; }
            const hits = [];
            for (const m of msgs) {
              const has = m.textContent.toLowerCase().includes(q);
              m.classList.toggle("cf-out", !has);
              if (!has) continue;
              hits.push(m);
              const walk = document.createTreeWalker(m, NodeFilter.SHOW_TEXT), nodes = [];
              while (walk.nextNode()) if (!walk.currentNode.parentElement.closest(".who, .meta, button")) nodes.push(walk.currentNode);
              for (const n of nodes) {
                const i = n.textContent.toLowerCase().indexOf(q);
                if (i < 0) continue;
                const mark = document.createElement("mark"); mark.className = "cf";
                const after = n.splitText(i); after.splitText(q.length);
                mark.textContent = after.textContent; after.replaceWith(mark);
              }
            }
            root.querySelector(".cf-n").textContent = `${hits.length} message${hits.length === 1 ? "" : "s"}`;
            return hits;
          };
          let hits = apply();
          find.addEventListener("input", () => { at = -1; hits = apply(); });
          find.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && hits.length) { e.preventDefault(); at = (at + (e.shiftKey ? -1 : 1) + hits.length) % hits.length; hits[at].scrollIntoView({ block: "center", behavior: "smooth" }); }
            else if (e.key === "Escape" && find.value) { e.preventDefault(); e.stopPropagation(); find.value = ""; hits = apply(); }
          });
        }
        root.querySelectorAll(".msg .md pre").forEach(pre => {   // a Copy button on every code block
          const b = document.createElement("button");
          b.className = "btn sm ghost md-copy"; b.type = "button"; b.innerHTML = `${icon("copy", 13)}Copy`; b.setAttribute("aria-label", "Copy the code");
          b.addEventListener("click", () => navigator.clipboard.writeText(pre.textContent.replace(/Copy$/, "")).then(() => toast("Copied.", "good", 1500), () => toast("Copy failed: select the text instead.", "warn")));
          pre.appendChild(b);
        });
        root.querySelectorAll("[data-forward-review]").forEach(b => b.addEventListener("click", () => forwardReview(b)));
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
              if (r.delivery !== "followup") app.plane(v.seat, v.id);    // a paper plane carries it (the demo flies one too)
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
      <div class="composer">${!(talk === "none" || talk === "later") ? `<div class="quick">${QUICK.map(([label], i) => `<button class="chip" data-quick="${i}">${esc(label)}</button>`).join("")}</div>` : ""}<div class="box"><textarea id="chatBox" data-for="${esc(x ? x.id : "")}" rows="1" placeholder="${talk === "none" || talk === "later" ? "Messaging is not available here" : `Message ${esc(who)}…`}" ${talk === "none" || talk === "later" ? "disabled" : ""} aria-label="Message"></textarea>
        <button class="btn primary icon" id="chatSend" ${talk === "none" || talk === "later" ? "disabled" : ""} title="Send (Enter)" aria-label="Send">${icon("send", 17)}</button></div>
        <div class="hint">${icon(hint[0], 14)}<span>${hint[1]}</span></div></div>`;
  }

  // Why is it burning? When a session burns hard (all tokens in the last hour, cache reads included), the likely causes
  // from what the office sees: a big context re-read on every call, helpers fanning out, the same call over and over,
  // the prompt cache missing, many turns. With what to do about each. Nothing leaves the machine.
  function burnWhy(x, now = S().now) {
    const t1 = x.tokens_1h || {}, all = (t1.fresh || 0) + (t1.cached || 0);
    if (all < 5e6) return null;
    const hours = x.started_at ? Math.max(1, (now - x.started_at) / 3600) : null, lifetime = x.spent && x.spent.tokens;
    const usual = hours && lifetime ? lifetime / hours : null;
    const why = [], ctx = x.cache && x.cache.context;
    if (ctx >= 150000) why.push([`Its context is ${fmtTok(ctx)} tokens, read again on every call.`, "Ask it to /compact, or to finish this part and start a fresh session."]);
    if ((x.helpers || []).length >= 3) why.push([`${x.helpers.length} helpers are at work at once, each with its own context.`, "Fewer helpers at a time, or smaller jobs for each."]);
    if (x.loop && x.loop.count >= 5) why.push([`It has made the same call ${x.loop.count} times in a row.`, "It may be stuck: open the chat and point it another way."]);
    if (t1.fresh && all && t1.fresh / all > 0.3) why.push([`${Math.round(t1.fresh / all * 100)}% of the hour was fresh tokens: the prompt cache keeps missing.`, "Long pauses let the cache expire; steadier work keeps it warm."]);
    if (t1.turns >= 120) why.push([`${t1.turns} turns in the hour.`, "Many small steps: a clearer plan in the brief means fewer."]);
    return { all, usual, ratio: usual ? all / usual : null, why };
  }
  function burnWhyHtml(x) {
    const b = burnWhy(x);
    if (!b) return "";
    const pace = b.ratio && b.ratio >= 1.5 ? `, ${b.ratio.toFixed(1)}× its usual pace` : "";
    return `<div class="burnwhy"><b>${icon("flame", 15)}${fmtTok(b.all)} tokens in the last hour${pace}.</b>
      ${b.why.length ? `<ul>${b.why.map(([w, fix]) => `<li><span>${esc(w)}</span><small>${esc(fix)}</small></li>`).join("")}</ul>` : `<p class="hint">Nothing unusual in how it works: it is simply busy.</p>`}</div>`;
  }
  function overviewHtml(s, x) {
    if (!x) return section("Overview", `<div class="muted">This session has ended. Its conversation is in the Chat tab.</div>`);
    const d = app.detailFor("s:" + s.id + "/" + x.id);
    const t1 = x.tokens_1h || {}, t5 = x.tokens_5h || {};
    const lane = (S().lanes || []).find(l => l.pid && l.pid === x.pid);
    return `${section("Right now", `<div class="now ${x.state}"><span class="caret"></span>${icon(KIND_ICON[x.activity_kind] || "dot", 18)}<span style="min-width:0;overflow-wrap:anywhere">${priv(x, x.activity)}</span></div>
        <div class="hint" style="margin-top:6px">${x.quiet_s != null ? `Last sign of life ${dur(x.quiet_s)} ago.` : ""}${x.limit_text ? " " + esc(x.limit_text) : ""}</div>`)}
      ${(x.risks || []).length ? section(`Risky actions · ${x.risks.length}`, `<ul class="tasklist risks">${x.risks.slice().reverse().map(r => `<li class="${(S().office.risk_mute || []).includes(r.rule) ? "muted" : "bad"}">${icon("alert", 14)}<span><b>${esc(r.label || r.rule)}</b>${r.helper ? " (a helper)" : ""}${app.privacy() ? "" : `<code>${esc(r.text)}</code>`}</span>${r.ts ? `<small>${ago(r.ts)}</small>` : ""}</li>`).join("")}</ul>
        <div class="hint">Read from its transcript after they ran: the office warns, it does not block. Mute a kind in Settings.</div>`) : ""}
      ${x.title || x.task ? section("Working on", `${x.title ? `<div style="font-weight:600;margin-bottom:8px">${priv(x, x.title)}</div>` : ""}${x.task ? `<div class="quote">${priv(x, x.task)}</div>` : ""}`) : ""}
      ${x.helpers && x.helpers.length ? section(`Helpers at work · ${x.helpers.length}`, `<ul class="tasklist">${x.helpers.map(h => `<li class="in_progress">${icon("bot", 14)}<span>${priv(x, h.desc)}</span>${h.since ? `<em>${esc(dur(S().now - h.since))}</em>` : ""}</li>`).join("")}</ul>
        <div class="hint">Each one is a drone orbiting its desk on the floor; it docks with a spark when its helper finishes.</div>`) : ""}
      ${x.tasks ? section(`Tasks · ${x.tasks.done} of ${x.tasks.total} done`, `<div class="taskbar" role="progressbar" aria-valuemin="0" aria-valuemax="${x.tasks.total}" aria-valuenow="${x.tasks.done}" aria-label="Tasks done"><i style="width:${Math.round(x.tasks.done / x.tasks.total * 100)}%"></i></div>
        <ul class="tasklist">${x.tasks.items.map(t => `<li class="${t.status}">${icon(t.status === "completed" ? "check" : t.status === "in_progress" ? "play" : "dot", 14)}<span>${priv(x, t.subject)}</span>${t.status === "in_progress" ? `<em>now</em>` : ""}</li>`).join("")}</ul>
        ${x.tasks.total > x.tasks.items.length ? `<div class="hint">and ${x.tasks.total - x.tasks.items.length} more</div>` : ""}`) : ""}
      ${x.state_file ? section("Progress notes", d && d.state_tail ? `<pre class="pre">${esc(d.state_tail)}</pre>` : `<div class="hint">${d ? "Empty so far." : "Loading…"}</div>`) : ""}
      ${x.report_status ? section("Report", d && d.report ? `<div class="doc md">${md(d.report)}</div>` : `<div class="quote">${esc(x.report_status)}</div>`, d && d.report ? `<button class="btn sm ghost" data-copy="${esc(d.report)}">${icon("copy", 14)}Copy</button>` : "") : ""}
      ${section("Burn", `<div class="tiles"><div class="tile"><div class="v">${fmtTok(t1.fresh)}</div><div class="tk">fresh tokens, last hour</div></div>
        <div class="tile"><div class="v">${fmtTok(t5.fresh)}</div><div class="tk">last 5 hours</div></div><div class="tile"><div class="v">${x.tool_calls ?? "–"}</div><div class="tk">tool calls</div></div></div>
        ${burnWhyHtml(x)}`)}
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
  // The office doctor (office/doctor.py): health checks, each with what to do about it.
  let doctorData = null, doctorAt = 0;
  function doctorPanel() {
    if (Date.now() - doctorAt > 15000) {
      doctorAt = Date.now();
      fetch("/api/doctor").then(r => r.ok ? r.json() : null).then(d => { doctorData = d; app.rerender(true); }).catch(() => {});
    }
    const checks = (doctorData && doctorData.checks) || [], bad = checks.filter(c => c.state === "bad").length, warn = checks.filter(c => c.state === "warn").length;
    const ic = { ok: "check", warn: "alert", bad: "alert", info: "dot" };
    return { html: `${crumbs("Office doctor")}<h2>Office doctor</h2><p class="lede">${!doctorData ? "Checking…" : bad ? `${bad} problem${bad === 1 ? "" : "s"} to fix${warn ? ` and ${warn} to watch` : ""}.` : warn ? `All working; ${warn} thing${warn === 1 ? "" : "s"} to watch.` : "Everything checks out."}</p>
      ${checks.map(c => `<div class="need ${c.state === "ok" ? "good" : c.state === "info" ? "info" : c.state}"><span class="ico">${icon(ic[c.state] || "dot", 16)}</span><div class="grow"><div class="t">${esc(humanise(c.name))}</div><div class="d">${esc(humanise(c.detail))}</div>${c.fix ? `<div class="d" style="margin-top:4px"><b>Fix:</b> ${md(c.fix)}</div>` : ""}</div></div>`).join("")}` };
  }
  // The filing cabinet (office/cabinet.py): every past session, searchable, to open or resume.
  let cabQ = "", cabRaw = "", cabSeat = "", cabMore = 0;   // cabRaw is what the box shows (a trailing space survives)
  function cabinetPanel() {
    const pages = [...Array(cabMore + 1).keys()].map(i => app.cabinetCache(cabQ, cabSeat, i * 50));
    const d = pages[0], rows = pages.filter(Boolean).flatMap(p => p.rows), pv = app.privacy();
    const big = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + " B" : n >= 1e6 ? (n / 1e6).toFixed(1) + " M" : fmtTok(n));
    const row = (r) => { const st = r.seat && seatById(r.seat), title = r.title || r.prompt || r.project || "A session";
      return `<li class="cab"><span class="grow"><b class="${pv ? "private" : ""}">${esc(title)}</b>
        <small>${r.project ? `<span class="${pv ? "private" : ""}">${esc(r.project)}</span> · ` : ""}${st ? esc(P(st).name) + " · " : ""}${r.last ? esc(relTime(r.last)) : ""} · ${big(r.tokens)} tokens${r.usd ? " · " + esc(money(r.usd)) : ""}</small></span>
        <span class="cab-act">${r.has_transcript && st ? `<button class="btn sm ghost" data-open-session="${esc(r.seat)}|${esc(r.id)}">${icon("chat", 14)}Open</button>` : ""}
          ${r.resume ? `<button class="btn sm ghost icon" data-copy="${esc(r.resume)}" data-copy-note="Paste it in a terminal: the session picks up where it left off." title="Copy the command that resumes it" aria-label="Copy the resume command">${icon("copy", 14)}</button>` : ""}</span></li>`; };
    const chips = [["", "Everyone"], ...S().seats.map(s => [s.id, P(s).name])].map(([id, l]) => `<button data-cab-seat="${esc(id)}" class="${cabSeat === id ? "on" : ""}" aria-pressed="${cabSeat === id}">${esc(l)}</button>`).join("");
    return { html: `${crumbs("Filing cabinet")}<h2>Filing cabinet</h2><p class="lede">Every session on this machine, newest first: search its title, its first instruction or its project, open its conversation, or copy the command that resumes it.</p>
      <div class="cab-search">${icon("search", 16)}<input type="search" id="cabQ" placeholder="Search past sessions" aria-label="Search past sessions" value="${esc(cabRaw)}" maxlength="200" autocomplete="off"></div>
      <div class="seg-ctl cab-seats" role="group" aria-label="Character">${chips}</div>
      ${!d ? `<div class="skeleton"></div><div class="skeleton" style="width:70%"></div>`
        : `<p class="hint">${d.building ? "Reading the transcripts' first lines… " : ""}${d.total.toLocaleString()} session${d.total === 1 ? "" : "s"}${cabQ ? ` matching “${esc(cabQ)}”` : ""}.</p>
           ${rows.length ? `<ul class="loose cabs">${rows.map(row).join("")}</ul>` : cabQ || cabSeat
             ? emptyState("search", cabQ ? `Nothing matches “${cabQ}”` : "No sessions for this character", "Every word has to match a session's title, first instruction, project or folder.", `<button class="btn sm" data-cab-clear>Clear the search</button>`)
             : emptyState("files", "No past sessions yet", "Every session on this machine lands here once it has a transcript.")}
           ${rows.length < d.total ? `<button class="btn sm" data-cab-more>${icon("chevronDown", 14)}Show more</button>` : ""}`}`,
      bind(root) {
        const qi = root.querySelector("#cabQ");
        const run = debounce(() => { if (cabRaw.trim() === cabQ) return; cabQ = cabRaw.trim(); cabMore = 0; app.rerender(true); }, 250);
        qi.addEventListener("input", () => { cabRaw = qi.value; run(); });
        qi.addEventListener("keydown", (e) => { if (e.key === "Escape" && qi.value) { e.stopPropagation(); qi.value = cabRaw = ""; run(); } });
        root.querySelectorAll("[data-cab-seat]").forEach(b => b.addEventListener("click", () => { cabSeat = b.dataset.cabSeat; cabMore = 0; app.rerender(true); }));
        const cc = root.querySelector("[data-cab-clear]"); if (cc) cc.addEventListener("click", () => { cabQ = cabRaw = cabSeat = ""; cabMore = 0; app.rerender(true); });
        const more = root.querySelector("[data-cab-more]"); if (more) more.addEventListener("click", () => { cabMore++; app.rerender(true); });
        root.querySelectorAll("[data-open-session]").forEach(b => b.addEventListener("click", () => { const [seat, id] = b.dataset.openSession.split("|"); app.go({ kind: "session", seat, id }); }));
      } };
  }
  // The Inbox (office/asks.py): questions agents asked with `python3 -m office ask`, and the CEO's answers, which go
  // back to the asking session as a message. A half-written answer survives redraws.
  const askDrafts = new Map();
  function inbox() {
    const list = S().asks || [], open = list.filter(a => a.status === "open"), done = list.filter(a => a.status !== "open");
    const from = (a) => { const s = a.seat && seatById(a.seat); return `${s ? avatar("mascot-" + s.id, s.color) : `<span class="ask-av">${icon("bot", 16)}</span>`}<span class="grow"><b>${esc(a.name || a.where || "An agent")}</b><small>${s ? esc(P(s).name) + " · " : ""}${esc(relTime(a.ts))}</small></span>`; };
    const pv = app.privacy();
    const card = (a) => `<div class="ask open"><div class="ask-h">${from(a)}</div><p class="ask-q ${pv ? "private" : ""}">${esc(a.text)}</p>
      <textarea class="ask-a" rows="3" maxlength="1000" data-ask-draft="${esc(a.id)}" placeholder="Your answer goes back to ${a.session ? "this session as a message" : "the Inbox (the office could not tell which session asked)"}" aria-label="Your answer">${esc(askDrafts.get(a.id) || "")}</textarea>
      <div class="row wrap" style="gap:8px;margin-top:8px"><button class="btn sm primary" data-ask-send="${esc(a.id)}">${icon("send", 14)}Send the answer</button>
        ${a.session && a.seat ? `<button class="btn sm ghost" data-open-session="${esc(a.seat)}|${esc(a.session)}">${icon("chat", 14)}Open the session</button>` : ""}
        <button class="btn sm ghost" data-ask-dismiss="${esc(a.id)}">Dismiss</button></div></div>`;
    const past = (a) => `<div class="ask done"><div class="ask-h">${from(a)}<span class="lc ${a.status === "answered" ? "good" : ""}">${a.status}</span></div><p class="ask-q ${pv ? "private" : ""}">${esc(a.text)}</p>
      ${a.answer ? `<p class="ask-ans">${icon("reply", 14)}<span class="${pv ? "private" : ""}">${esc(a.answer)}</span></p>` : ""}</div>`;
    return { html: `${crumbs("Inbox")}<h2>Inbox</h2><p class="lede">Questions your agents asked you. An agent asks with <code>python3 -m office ask "…"</code> and keeps working; your answer goes back to its session as a message.</p>
      ${section(`Waiting for you · ${open.length}`, open.map(card).join("") || `<div class="g-clear">${icon("check", 16)}No questions waiting.</div>`)}
      ${done.length ? section("Answered", done.slice(0, 20).map(past).join("")) : ""}`,
      bind(root) {
        root.querySelectorAll("[data-ask-draft]").forEach(t => t.addEventListener("input", () => askDrafts.set(t.dataset.askDraft, t.value)));
        root.querySelectorAll("[data-open-session]").forEach(b => b.addEventListener("click", () => { const [seat, id] = b.dataset.openSession.split("|"); app.go({ kind: "session", seat, id }); }));
        root.querySelectorAll("[data-ask-send]").forEach(b => b.addEventListener("click", async () => {
          const id = b.dataset.askSend, text = (askDrafts.get(id) || "").trim();
          if (!text) { toast("Write an answer first.", "info"); return; }
          b.disabled = true;
          try {
            const r = await app.post("/api/ask/answer", { id, text });
            askDrafts.delete(id);
            const q = (S().asks || []).find(x => x.id === id);
            if (q && q.seat && r.delivery) app.plane(q.seat, q.session);
            toast(r.demo ? "Demo office: nothing was sent." : r.note ? `Answered. ${r.note}` : r.delivery === "review" ? "Sent. It waits for approval in that session's terminal." : "Sent to the session.", r.note || r.demo ? "info" : "good");
            app.refresh(); app.rerender(true);
          } catch (e) { b.disabled = false; toast("Could not send: " + e.message, "bad"); }
        }));
        root.querySelectorAll("[data-ask-dismiss]").forEach(b => b.addEventListener("click", async () => {
          try { await app.post("/api/ask/dismiss", { id: b.dataset.askDismiss }); askDrafts.delete(b.dataset.askDismiss); app.refresh(); app.rerender(true); }
          catch (e) { toast("Could not dismiss: " + e.message, "bad"); }
        }));
      } };
  }
  // The PR shelf (office/prs.py): the repositories' recent pull requests, which desk works on each, and their checks.
  const CI_WORD = { pass: "checks pass", pending: "checks running", fail: "checks failed" };
  function prsPanel() {
    const d = app.prsCache(), pv = app.privacy();
    const head = `${crumbs("Pull requests")}<h2>Pull requests</h2><p class="lede">The recent pull requests in the repositories your sessions use, with their checks and reviews, and the desk working on each branch. Read with the GitHub CLI; the office never changes a PR.</p>`;
    if (!d) return { html: head + `<div class="skeleton"></div><div class="skeleton" style="width:70%"></div>` };
    if (!d.available) return { html: head + `<div class="muted">The GitHub CLI (<code>gh</code>) is not installed here, so there is nothing to show.</div>` };
    if (!d.repos.length) return { html: head + `<div class="muted">${d.scanning ? "Asking GitHub…" : "No GitHub repositories yet: the office learns them from the folders its sessions work in."}</div>` };
    const REVIEW = { approved: ["good", "approved"], changes_requested: ["bad", "changes requested"], review_required: ["", "needs review"] };
    const row = (p, repo) => {
      const desk = p.at_desk && seatById(p.at_desk.seat);
      const cwd = desk && ((desk.sessions || []).find(x => x.id === p.at_desk.session) || {}).cwd;
      const fix = p.checks === "fail" && (p.state === "open" || p.state === "draft") ? `<button class="lc bad" data-fix-pr="${esc(JSON.stringify([repo, p.number, p.title, p.branch || "", cwd || ""]))}" title="Fill the hiring desk with a brief to fix it (nothing starts until you hire)">Fix the checks</button>` : "";
      return `<li class="pr ${esc(p.state)}"><span class="ci-dot ${esc(p.checks || "none")}" title="${p.checks ? "Checks " + CI_WORD[p.checks] : "No checks"}"></span>
        <span class="grow"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer"><b>#${p.number}</b> <span class="${pv ? "private" : ""}">${esc(p.title)}</span></a>
        <small><span class="${pv ? "private" : ""}">${esc(p.branch || "")}</span>${p.updated ? " · " + esc(relTime(Date.parse(p.updated) / 1000)) : ""}</small></span>
        <span class="lc-tags">${p.state === "draft" ? `<em class="lc">draft</em>` : ""}${p.review && REVIEW[p.review] ? `<em class="lc ${REVIEW[p.review][0]}">${REVIEW[p.review][1]}</em>` : ""}
          ${desk ? `<button class="lc info" data-open-session="${esc(desk.id)}|${esc(p.at_desk.session)}" title="The session on this branch">${esc(P(desk).name)}'s desk</button>` : ""}${fix}</span></li>`; };
    const repos = d.repos.map(r => {
      const open = r.prs.filter(p => p.state === "open" || p.state === "draft"), merged = r.prs.filter(p => p.state === "merged"), closed = r.prs.filter(p => p.state === "closed");
      const failing = open.filter(p => p.checks === "fail").length;
      return section(`${esc(r.repo)}${r.error ? ` · <span class="hint">could not reach GitHub</span>` : ""}`, `
        <h5 class="lh">Open · ${open.length}${failing ? ` · <span style="color:var(--bad)">${failing} failing</span>` : ""}</h5>${open.length ? `<ul class="loose prs">${open.map(p => row(p, r.repo)).join("")}</ul>` : `<div class="hint">No open pull requests.</div>`}
        ${merged.length ? `<h5 class="lh">Merged · ${merged.length}</h5><ul class="loose prs">${merged.slice(0, 8).map(p => row(p, r.repo)).join("")}</ul>${merged.length > 8 ? `<p class="hint">and ${merged.length - 8} more of the last ${r.prs.length}.</p>` : ""}` : ""}
        ${closed.length ? `<p class="hint">${closed.length} closed without merging.</p>` : ""}`); }).join("");
    // What changed this week, in plain words: every PR merged in the last 7 days, to read or to paste into a standup.
    const weekAgo = Date.now() - 7 * 86400e3;
    const week = d.repos.map(r => ({ repo: r.repo, prs: r.prs.filter(p => p.state === "merged" && p.merged && Date.parse(p.merged) >= weekAgo) })).filter(r => r.prs.length);
    const nWeek = week.reduce((a, r) => a + r.prs.length, 0);
    const notes = week.map(r => `${r.repo}\n${r.prs.map(p => `- ${p.title} (#${p.number})`).join("\n")}`).join("\n\n");
    const weekHtml = nWeek ? section(`Merged this week · ${nWeek}`, `${week.map(r => `<h5 class="lh">${esc(r.repo)} · ${r.prs.length}</h5><ul class="tasklist">${r.prs.map(p => `<li class="completed-ok">${icon("check", 14)}<span class="${pv ? "private" : ""}">${esc(p.title)}</span><em>#${p.number}</em></li>`).join("")}</ul>`).join("")}
      <div class="row" style="margin-top:10px"><button class="btn sm" data-copy="${esc(notes)}" data-copy-note="This week's merged pull requests are on the clipboard.">${icon("copy", 14)}Copy as notes</button></div>`) : "";
    return { html: `${head}<p class="hint">${d.scanning ? "Asking GitHub…" : "Refreshed every few minutes."}</p>${weekHtml}${repos}`,
      bind(root) {
        root.querySelectorAll("[data-open-session]").forEach(b => b.addEventListener("click", () => { const [seat, id] = b.dataset.openSession.split("|"); app.go({ kind: "session", seat, id }); }));
        // A failing PR: the hiring desk gets a ready brief to fix it, in the folder of the desk on its branch.
        root.querySelectorAll("[data-fix-pr]").forEach(b => b.addEventListener("click", () => {
          const [repo, n, title, branch, cwd] = JSON.parse(b.dataset.fixPr);
          if ((hireDraft.title.trim() || hireDraft.brief.trim()) && !confirm("Replace the brief on the hiring desk with one to fix this PR?")) return;
          hireDraft = { ...hireDraft, title: `Fix the checks on PR #${n}`, workdir: cwd || hireDraft.workdir,
            brief: `Pull request #${n} ("${title}") in ${repo} has failing checks${branch ? ` on the branch ${branch}` : ""}.\n\nWork on that branch${cwd ? " (this folder has it checked out)" : " (switch to it, or use its worktree)"}. Read the failing checks with \`gh pr checks ${n} -R ${repo}\` and the failing job's log (\`gh run view --log-failed\`), fix the cause, push, and confirm the checks pass. Do not merge.` };
          store.set("hireDraft", hireDraft); app.go({ kind: "hire" });
        }));
      } };
  }
  // Loose ends (office/loose.py): work left in git that is nowhere else, and worktrees that are safe to remove.
  function loose() {
    const d = app.looseCache(), pv = app.privacy();
    const head = `${crumbs("Loose ends")}<h2>Loose ends</h2><p class="lede">Work the agents left in git, and worktrees you can remove. The office only reads: removing is a command you copy and run yourself.</p>`;
    if (!d) return { html: head + `<div class="skeleton"></div><div class="skeleton" style="width:70%"></div>` };
    if (!d.at) return { html: head + `<div class="muted">${d.scanning ? "Looking through the repositories…" : "No repositories yet: the office learns them from the folders its sessions and lanes work in (or add <code>\"repos\"</code> to config.json)."}</div>` };
    const t = d.totals || {}, n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
    const row = (w, tags) => `<li><span class="grow"><b class="${pv ? "private" : ""}" title="${pv ? "" : esc(w.path)}">${esc(w.name)}</b><small><span class="${pv ? "private" : ""}">${esc(w.branch || "detached at " + w.head)}</span>${w.touched ? " · touched " + esc(relTime(w.touched)) : ""}</small></span><span class="lc-tags">${tags}</span></li>`;
    const tags = (w) => [w.files && `<em class="lc bad">${n(w.files, "file")} not committed</em>`, w.unpushed && !w.merged && `<em class="lc warn">${n(w.unpushed, "commit")} on no remote</em>`,
      w.unknown && `<em class="lc warn">could not check its commits</em>`, w.detached && w.unpushed && !w.merged && `<em class="lc">detached: on no branch</em>`,
      w.unpushed && !w.upstream && !w.detached && `<em class="lc">never pushed</em>`, w.live && `<em class="lc info">a session works here</em>`].filter(Boolean).join("");
    const ign = (w) => (w.ignored && w.ignored.length ? `<em class="lc" title="Removing the worktree deletes these ignored files too">deletes ${esc(w.ignored.slice(0, 2).join(", "))}${w.ignored.length > 2 ? "…" : ""}</em>` : "");
    const copyAll = (cmds, what) => cmds && cmds.length ? `<button class="btn sm" data-copy="${esc(cmds.join("\n"))}" data-copy-note="${cmds.length} commands on the clipboard: paste them in a terminal.">${icon("copy", 14)}Copy ${n(cmds.length, what)}</button>` : "";
    const repos = (d.repos || []).map(r => section(`${esc(r.name)} · ${n(r.worktrees, "worktree")}`, `
      ${r.error ? `<p class="hint">Git could not read this repository: it may be empty, or owned by another user.</p>` : ""}
      ${r.error ? "" : r.work.length ? `<h5 class="lh">Work that is nowhere else · ${r.work.length}</h5><ul class="loose">${r.work.slice(0, 40).map(w => row(w, tags(w))).join("")}</ul>${r.work.length > 40 ? `<p class="hint">and ${r.work.length - 40} more</p>` : ""}`
        : `<div class="g-clear">${icon("check", 16)}Nothing left behind here.</div>`}
      ${r.safe.length ? `<h5 class="lh">Safe to remove · ${r.safe.length}</h5><p class="hint">Clean, and every commit is on a remote or, every one of them, on ${esc(r.base || "the default branch")} by name (a squash merge). Removing a worktree keeps its branch, but deletes the files git ignores in it (build output, .env files): the rows say which.</p>
        <ul class="loose">${r.safe.slice(0, 6).map(w => row(w, (w.merged ? `<em class="lc good">merged</em>` : `<em class="lc good">pushed</em>`) + ign(w))).join("")}</ul>${r.safe.length > 6 ? `<p class="hint">and ${r.safe.length - 6} more, oldest first.</p>` : ""}${copyAll(r.remove_cmds, "remove command")}` : ""}
      ${r.deleted.length ? `<h5 class="lh">Remote branch deleted · ${r.deleted.length}</h5><p class="hint">Their remote branches were deleted, usually after a merge, but their commits are not on ${esc(r.base || "the default branch")} by name. Look before you remove: removing keeps the branch and its commits.</p>
        <ul class="loose">${r.deleted.slice(0, 5).map(w => row(w, `<em class="lc">${n(w.unpushed, "commit")}</em>`)).join("")}</ul>${r.deleted.length > 5 ? `<p class="hint">and ${r.deleted.length - 5} more.</p>` : ""}${copyAll(r.deleted_cmds, "remove command")}` : ""}
      ${r.prune_cmd ? `<p class="hint">${n(r.gone, "worktree")} whose folder is gone: <button class="btn sm ghost" data-copy="${esc(r.prune_cmd)}">${icon("copy", 13)}Copy the prune command</button></p>` : ""}`)).join("");
    return { html: `${head}<div class="tiles"><div class="tile"><div class="v">${t.work}</div><div class="tk">hold work that is nowhere else</div></div>
        <div class="tile"><div class="v">${t.safe}</div><div class="tk">safe to remove</div></div><div class="tile"><div class="v">${t.worktrees}</div><div class="tk">${t.worktrees === 1 ? "worktree" : "worktrees"} in ${t.repos === 1 ? "one repository" : `${t.repos} repositories`}</div></div></div>
      <div class="row" style="gap:8px;margin:10px 0 4px"><span class="hint">${d.scanning ? "Checking again…" : `Checked ${esc(relTime(d.at))}.`}</span><button class="btn sm ghost" data-loose-refresh ${d.scanning ? "disabled" : ""}>${icon("refresh", 14)}Check again</button></div>
      ${repos}`,
      bind(root) { const b = root.querySelector("[data-loose-refresh]"); if (b) b.addEventListener("click", () => { app.looseCache(true); b.disabled = true; }); } };
  }
  // ------------------------------------------------------------------------------------------- one project
  // Every session that worked in a folder of this name: tokens and API value per day, who worked on it, with which
  // models, its biggest sessions and lanes, what it shipped; and the days as CSV, for billing or for the week's notes.
  let prjDays = 30;
  function project(v) {
    const d = app.projectCache(v.name, prjDays), pv = app.privacy();
    const big = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + " B" : n >= 1e6 ? (n / 1e6).toFixed(1) + " M" : fmtTok(n));
    const head = `${crumbs("Project")}<h2 class="${pv ? "private" : ""}">${esc(v.name)}</h2><p class="lede">Every session that worked in a folder of this name: what it cost at API prices, who worked on it and what it shipped.</p>
      <div class="seg-ctl" role="group" aria-label="Range" style="margin-top:12px">${[7, 30, 90].map(n => `<button data-prj-days="${n}" class="${prjDays === n ? "on" : ""}">${n} days</button>`).join("")}</div>`;
    const bind = (root) => root.querySelectorAll("[data-prj-days]").forEach(b => b.addEventListener("click", () => { prjDays = +b.dataset.prjDays; app.rerender(true); }));
    if (!d) return { html: head + `<div class="skeleton" style="margin-top:14px"></div><div class="skeleton" style="width:70%"></div>`, bind };
    if (!d.all_time.sessions) return { html: head + emptyState("search", "No sessions with this project", "The office knows a project by the name of the folder its sessions worked in."), bind };
    const t = d.total, max = Math.max(1, ...d.days.map(x => x.all)), n = d.days.length, bw = 100 / n;
    const bars = d.days.map((x, i) => { const h = x.all ? Math.max(1.5, x.all / max * 92) : 0;
      return `<rect x="${(i * bw + bw * 0.15).toFixed(2)}" y="${(100 - h).toFixed(2)}" width="${(bw * 0.7).toFixed(2)}" height="${h.toFixed(2)}" rx="0.6"><title>${esc(new Date(x.day + "T12:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }))}: ${big(x.all)} tokens · ${money(x.usd)}</title></rect>`; }).join("");
    const seatRow = (x) => { const st = x.seat && seatById(x.seat), w = (x.all / Math.max(1, d.seats[0].all) * 100).toFixed(1);
      return `<li style="--seat:${esc(st ? st.color : "#888")}"><span class="grow"><b>${esc(st ? P(st).name : "Unknown seat")}</b><span class="tb-bar"><i style="width:${w}%"></i></span></span><em>${big(x.all)} · ${esc(money(x.usd))}</em></li>`; };
    const sess = d.sessions.map(x => { const st = x.seat && seatById(x.seat);
      return `<li><span class="grow"><b>${esc(st ? P(st).name : "Unknown seat")} · ${esc(x.id)}</b><small>${x.last ? esc(relTime(x.last)) : ""}</small></span><em>${big(x.all)} · ${esc(money(x.usd))}</em></li>`; }).join("");
    const sh = d.shipped || {};
    const csv = ["day,tokens,fresh,output,usd", ...d.days.map(x => [x.day, x.all, x.fresh, x.output, x.usd.toFixed(2)].join(","))].join("\n");
    return { html: head + `
      <div class="tiles" style="margin-top:14px"><div class="tile"><div class="v">${big(t.all)}</div><div class="tk">tokens in ${prjDays} days</div></div>
        <div class="tile"><div class="v">${esc(money(t.usd))}</div><div class="tk">at API prices</div></div><div class="tile"><div class="v">${t.sessions}</div><div class="tk">session${t.sessions === 1 ? "" : "s"}</div></div>
        <div class="tile"><div class="v">${sh.commits || 0}</div><div class="tk">commits${sh.prs_merged ? `, ${sh.prs_merged} PR${sh.prs_merged === 1 ? "" : "s"} merged` : ""}</div></div></div>
      ${section("Per day", `<svg class="prj-bars" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Tokens per day">${bars}</svg>
        <div class="prj-axis"><span>${esc(new Date(d.since + "T12:00:00").toLocaleDateString([], { day: "numeric", month: "short" }))}</span><span>today</span></div>`)}
      ${d.seats.length ? section("Who worked on it", `<ul class="prj-list">${d.seats.map(seatRow).join("")}</ul>`) : ""}
      ${d.models.length ? section("Models", `<ul class="prj-list">${d.models.slice(0, 6).map(m => `<li><span class="grow"><b>${esc(modelName(m.model))}</b></span><em>${big(m.all)}</em></li>`).join("")}</ul>`) : ""}
      ${sess ? section("Biggest sessions", `<ul class="prj-list">${sess}</ul>`) : ""}
      ${(d.lanes || []).length ? section("Office lanes", d.lanes.map(l => `<button class="need info" data-lane-go="${esc(l.id)}" style="width:100%;text-align:left"><span class="ico">${icon("briefcase", 16)}</span><div class="grow"><div class="t">${esc(l.title || l.id)}</div><div class="d">${esc(l.status || "")}${l.spent && l.spent.usd ? ` · ${esc(money(l.spent.usd))}` : ""}</div></div></button>`).join("")) : ""}
      <p class="hint" style="margin-top:12px">All time: ${big(d.all_time.all)} tokens, ${esc(money(d.all_time.usd))} at API prices, in ${d.all_time.sessions} session${d.all_time.sessions === 1 ? "" : "s"}${d.all_time.first ? ` since ${esc(new Date(d.all_time.first * 1000).toLocaleDateString([], { day: "numeric", month: "short" }))}` : ""}.</p>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-copy="${esc(csv)}" data-copy-note="The days are on the clipboard as CSV.">${icon("copy", 14)}Copy the days as CSV</button></div>`,
      bind(root) { bind(root); root.querySelectorAll("[data-lane-go]").forEach(b => b.addEventListener("click", () => app.go({ kind: "lane", id: b.dataset.laneGo }))); } };
  }
  const PROG_SNIPPET = '"programmes": [{"match": "apollo", "name": "Apollo launch", "url": "https://example.com/board"}]';
  function programmes() {
    return { html: `${crumbs("Meeting room")}<h2>Programmes</h2><p class="lede">Live work grouped by programme. Names and links come from your config.</p>
      ${section("On the whiteboard", (S().programmes || []).map(progCard).join("") || emptyState("flag", "Nothing on the whiteboard",
        `Programmes group live work under one name: a session or lane whose folder, unit or task matches goes up here. Add one to <code>~/.config/claude-office/config.json</code>:<code class="es-code">${esc(PROG_SNIPPET)}</code>`,
        `<button class="btn sm" data-copy="${esc(PROG_SNIPPET)}" data-copy-note="Paste it into config.json, then restart the office.">${icon("copy", 14)}Copy the example</button>`))}` };
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
          <p class="lede">Everyone's work adds up. Every office level unlocks something new on the floor.${(() => { const since = Math.min(...snap.seats.map(x => (x.career && x.career.since) || Infinity));
            if (!isFinite(since)) return ""; const days = Math.max(0, Math.floor((snap.now - since) / 86400));
            return ` Open since ${esc(new Date(since * 1000).toLocaleDateString([], { day: "numeric", month: "long" }))} (${days === 0 ? "today" : days === 1 ? "1 day" : days + " days"}).`; })()}</p></div></div>
      ${nxt ? `<div class="ol-next">${icon(nxt.icon, 18)}<div class="grow"><b>Next: ${esc(nxt.name)}</b><span>${esc(nxt.desc)}</span></div><em>Level ${nxt.level}</em></div>` : `<div class="ol-next done">${icon("trophy", 18)}<div class="grow"><b>Everything is unlocked.</b><span>The office is complete. Keep the streak going.</span></div></div>`}
      ${section(`Unlocks · ${ol.unlocked.size} of ${UNLOCKS.length}`, `<div class="ol-grid">${UNLOCKS.map(u => { const on = ol.unlocked.has(u.id);
        return `<div class="ol-card ${on ? "on" : ""}"><span class="ol-ic">${icon(on ? u.icon : "lock", 18)}</span><b>${esc(u.name)}</b><span>${esc(on ? u.desc : `Unlocks at office level ${u.level}`)}</span></div>`; }).join("")}</div>`)}
      ${(() => { const have = earned(), n = BADGES.filter(b => have[b.id]).length;
        const prog = !app.demo && app.badgeProgress ? app.badgeProgress() : {};
        return section(`Your badges · ${n} of ${BADGES.length}`, `<div class="ol-grid">${BADGES.map(b => { const at = have[b.id], p = !at && prog[b.id];
          const hide = b.secret && !at;                       // a secret badge stays a mystery until it is found
          return `<div class="ol-card ${at ? "on" : ""}"><span class="ol-ic">${icon(at ? b.icon : "lock", 18)}</span><b>${esc(hide ? "Secret badge" : b.name)}</b><span>${esc(hide ? "Some codes never get old." : b.desc)}${at ? ` · ${esc(dayTime(at))}` : ""}</span>
            ${p && p[0] > 0 ? `<span class="ol-prog"><i style="width:${Math.min(100, Math.round(p[0] / p[1] * 100))}%"></i></span><em class="ol-pn">${Math.min(p[0], p[1])} of ${p[1]}</em>` : ""}</div>`; }).join("")}</div>
          <div class="hint" style="margin-top:8px">${app.demo ? "The demo office never awards badges. " : ""}Badges are kept in this browser.</div>`); })()}
      ${album()}
      ${plaques()}
      ${byXp.length ? section("Who built it", byXp.map(s => `<div class="ol-who" style="--seat:${esc(s.color)}" data-seat-go="${esc(s.id)}" data-spot="${esc(s.id)}">${avatar("mascot-" + s.id, s.color, "lv" + (s.career ? s.career.level : 0))}<b>${esc(P(s).name)}</b><span class="ol-wbar"><i style="width:${Math.round(s.career.xp / top * 100)}%"></i></span><em>${s.career.xp.toLocaleString()} XP</em></div>`).join("")) : ""}`,
      bind(root) {
        const b = root.querySelector("[data-swap]"); if (b) b.addEventListener("click", () => { if (app.gifts.swap()) app.rerender(true); });
        const m = root.querySelector("[data-mail-open]"); if (m) m.addEventListener("click", () => { app.gifts.openNext(); app.rerender(true); });
      } };
  }
  // Token milestones on the 1-2-5 ladder, as brass plaques with the day each was crossed.
  function plaques() {
    const t = app.tokensCache && app.tokensCache(), list = (t && t.milestones) || [];
    if (!list.length) return "";
    const words = (n) => n >= 1e12 ? `${n / 1e12} T` : n >= 1e9 ? `${n / 1e9} B` : `${n / 1e6} M`;
    return section(`Milestones · ${list.length}`, `<div class="plaques">${list.slice(-12).reverse().map(m => `<div class="plaque"><b>${words(m.at)}</b><span>tokens</span>
      <small>${esc(new Date(m.day + "T12:00:00").toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }))}</small></div>`).join("")}</div>
      <div class="hint" style="margin-top:8px">The office's running total of tokens, from its transcripts. Each new one gets a ceremony and a gift.</div>`);
  }
  // The sticker album: every sticker a gift can hold, found ones in colour with how many, the rest as shadows.
  function album() {
    const g = app.gifts;
    if (!g) return "";
    const al = g.album(), have = STICKERS.filter(s => al[s.id]).length, spares = g.spares(), waiting = g.waiting().length, mail = g.mailroom();
    const tiles = STICKERS.map(s => { const x = al[s.id], r = RARITY[s.rarity];
      return `<div class="alb ${x ? "on" : ""} r-${s.rarity}" style="--rar:${r.color}" title="${esc(x ? `${s.name} · ${r.name}${x.n > 1 ? ` · ×${x.n}` : ""}` : `${r.name} · not found yet`)}">
        <i data-sticker="${esc(s.id)}|4|${x ? "" : "sil"}"></i><b>${esc(x ? s.name : "?")}</b>${x && x.n > 1 ? `<em>×${x.n}</em>` : ""}</div>`; }).join("");
    const done = setsDone(al);
    const counts = Object.keys(RARITY).map(k => { const all = STICKERS.filter(s => s.rarity === k), got = all.filter(s => al[s.id]).length;
      return `<div class="alb-set ${done.has(k) ? "on" : ""}" style="--rar:${RARITY[k].color}"><span class="as-ic">${icon(done.has(k) ? "trophy" : "lock", 15)}</span>
        <span class="grow"><b>${esc(RARITY[k].name)} ${got}/${all.length} · ${esc(SETS[k].name)}</b><small>${done.has(k) ? "On the floor now: " : "Finish the set: "}${esc(SETS[k].desc.charAt(0).toLowerCase() + SETS[k].desc.slice(1))}</small></span>
        <span class="as-bar"><i style="width:${Math.round(got / all.length * 100)}%"></i></span></div>`; }).join("");
    // The happy hour, as it stands now: coming up today, on, or (once it is over) tomorrow's.
    const hn = happyNow(), tm = new Date(); tm.setDate(tm.getDate() + 1);
    const th = happyHourFor(localDay(tm)), tAt = new Date(tm); tAt.setHours(th.hour, th.minute, 0, 0);
    const hm = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const happyLine = hn.on ? `Happy hour is on now (${hn.left} min left): gifts are twice as likely.`
      : new Date() < hn.start ? `Today's happy hour (${hm(hn.start)}, half an hour) doubles the odds.` : `Tomorrow's happy hour (${hm(tAt)}, half an hour) doubles the odds.`;
    // The mailroom (gifts that found the floor full, or waited a day) and where the last stickers came from.
    const byId = Object.fromEntries(STICKERS.map(x => [x.id, x]));
    const log = (g.log() || []).filter(x => byId[x.sticker]).slice(0, 8);
    const mailRow = mail.length ? `<div class="alb-mail"><span class="as-ic">${icon("gift", 15)}</span><span class="grow"><b>Mailroom · ${mail.length} gift${mail.length === 1 ? "" : "s"}</b>
        <small>${esc(g.label(mail[0]).replace(/: open it$/, ""))}${mail.length > 1 ? ` and ${mail.length - 1} more` : ""}. They come out to the floor as you open the ones there.</small></span>
        <button class="btn sm primary" data-mail-open>${icon("gift", 14)}Open the next</button></div>` : "";
    const logRows = log.length ? `<h5 class="lh" style="margin-top:14px">Where they came from</h5><ul class="alb-log">${log.map(x => { const st = byId[x.sticker], r = RARITY[st.rarity];
      return `<li style="--rar:${r.color}"><i data-sticker="${esc(st.id)}|2|"></i><span class="grow"><b>${esc(st.name)}</b>${x.isNew ? ` <em class="lc good">new</em>` : ""}<small>${esc(g.fromLine({ from: x.from, seat: x.seat, name: x.name }) || "A gift")} · ${esc(relTime(x.at))}</small></span><em class="rar">${esc(r.name)}</em></li>`; }).join("")}</ul>` : "";
    return `<div id="album">${section(`Sticker album · ${have} of ${STICKERS.length}`, `${mailRow}<div class="alb-sets">${counts}</div><div class="alb-grid">${tiles}</div>${logRows}
      <div class="alb-foot"><span class="hint">Your agents sometimes leave a gift when they file a report or finish a lane, and every morning a delivery waits at the CEO desk. Finishing today's goals, a ×3 combo or a level up always brings one. ${esc(happyLine)}${waiting ? ` <b>${waiting} waiting on the floor.</b>` : ""}${mail.length ? ` <b>${mail.length} in the mailroom.</b>` : ""}${app.demo ? " The demo office keeps stickers until you reload." : " Stickers are kept in this browser."}</span>
        <button class="btn sm" data-swap ${spares >= SWAP ? "" : "disabled"} title="Five spare stickers for one gift that is rare or better">${icon("gift", 14)}Swap 5 spares${spares ? ` (${spares})` : ""}</button></div>`)}</div>`;
  }
  function trophies() {
    const seats = S().seats.filter(s => s.career), cat = S().achievements || [];
    const byId = Object.fromEntries(cat.map(a => [a.id, a]));
    const ranked = [...seats].sort((a, b) => b.career.xp - a.career.xp);
    const total = seats.reduce((n, s) => n + Object.keys(s.career.unlocked).length, 0);
    const recent = seats.flatMap(s => Object.entries(s.career.unlocked).map(([id, at]) => ({ s, a: byId[id], at }))).filter(x => x.a)
      .sort((a, b) => b.at - a.at).slice(0, 8);
    const anyone = (id) => seats.some(s => s.career.unlocked[id]);
    const open = visibleAchievements(cat, anyone).filter(a => !anyone(a.id));
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
      <div style="margin-top:12px">${ev.length ? newsGroups(ev) : newsFilter !== "all"
        ? emptyState("news", "Nothing under this filter", "", `<button class="btn sm" data-news="all">Show all the news</button>`)
        : emptyState("news", "No news yet", "Arrivals, reports, limits, resets and what you change show up here as they happen.")}</div>`,
      bind(root) { root.querySelectorAll("[data-news]").forEach(b => b.addEventListener("click", () => { newsFilter = b.dataset.news; app.rerender(true); })); } };
  }

  // -------------------------------------------------------------------------------------------- lane
  function lane(v) {
    const d = app.detailFor("l:" + v.id);
    const l = (S().lanes || []).find(x => x.id === v.id) || (d && d.lane);
    if (!l && d && d.missing) return { html: crumbs("Lane") + `<div class="allclear">That lane is no longer here.</div><div class="row" style="margin-top:12px"><button class="btn sm" data-go="hire">${icon("briefcase", 15)}Hiring desk</button></div>` };
    if (!l) return { html: crumbs("Lane") + `<div class="skeleton"></div><div class="skeleton" style="width:70%"></div>` };
    const runs = (d && d.lane.runs) || l.runs || [];
    const running = l.unit_active || ["running", "starting", "waiting", "queued"].includes(l.status);
    const scheduled = l.status === "scheduled", sch = l.schedule || {};
    const sid = l.last_session_id;
    return { html: `${crumbs(`<button data-go="hire">Hiring desk</button>`, esc(l.title))}
      <h2>${esc(l.title)}</h2>
      <div class="row wrap" style="gap:6px;margin-top:8px">${pill(l.status, { done: "good", finished: "good", running: "info", failed: "bad", blocked: "warn", waiting: "warn", interrupted: "warn" }[l.status] || "")}
        ${l.seat ? pill("on " + nameOf(l.seat)) : ""}${pill(l.model)}${pill(l.seat_pref === "auto" ? "divider picks the seat" : "pinned to " + nameOf(l.seat_pref))}${l.allow_messages === true ? pill("takes messages", "good", "chat") : ""}</div>
      ${scheduled ? `<div class="need info" style="margin-top:12px"><span class="ico">${icon("clock", 16)}</span><div class="grow"><div class="t">${sch.backlog ? "In the backlog" : "Hired for later"}</div><div class="d">${sch.backlog
        ? "Starts when the divider has a seat for it, oldest first, one at a time"
        : sch.at ? `Starts ${esc(new Date(sch.at * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }))}`
        : `Starts when a seat has ${esc(String(sch.left))}% of its 5-hour plan left`}. Cancel it, or start it now.</div></div>${sch.backlog ? `<button class="btn sm" id="lFront">${icon("chevronRight", 14)}Move to the front</button>` : ""}</div>` : ""}
      ${l.waiting_reason ? `<div class="need warn" style="margin-top:12px"><span class="ico">${icon("clock", 16)}</span><div class="grow"><div class="t">Waiting for a seat</div><div class="d">${esc(humanise(l.waiting_reason))}</div></div></div>` : ""}
      <div class="row wrap" style="gap:8px;margin-top:16px">
        ${sid && l.seat ? `<button class="btn sm primary" data-chat-session="${esc(l.seat)}|${esc(sid)}">${icon("chat", 15)}${running ? "Chat with it" : "Follow up"}</button>` : ""}
        ${running || scheduled || l.status === "interrupted" ? `<button class="btn sm danger" id="lStop">${icon("stop", 15)}${scheduled ? "Cancel" : l.status === "interrupted" ? "Dismiss" : "Stop"}</button>` : ""}
        ${!running ? `<button class="btn sm" id="lResume">${icon("play", 15)}${scheduled ? "Start now" : "Resume"}</button>` : ""}
        <select id="lSeat" style="width:auto;height:30px;padding:0 8px"><option value="">As before</option><option value="auto">Let the divider pick</option>${S().seats.map(s => `<option value="${esc(s.id)}">${esc(P(s).name)}</option>`).join("")}</select>
        <button class="btn sm" id="lClone">${icon("copy", 15)}Re-hire</button>
        ${running || scheduled ? `<button class="btn sm ghost" data-remind="${esc(JSON.stringify(["lane_end", l.id, `when lane '${l.title}' ends`]))}">${icon("bell", 14)}Remind me when it ends</button>` : ""}
      </div>
      ${l.report_status ? section("Report", `<div class="doc md">${md((d && d.report) || l.report_status)}</div>`, `<button class="btn sm ghost" data-copy="${esc((d && d.report) || l.report_status)}">${icon("copy", 14)}Copy</button>`) : ""}
      ${section("Progress notes", `<div class="doc md">${md((d && d.state) || l.state_tail || "Nothing yet.")}</div>`)}
      ${section("Runs", runs.length ? runs.slice().reverse().map(r => `<div class="act ${r.ended_by === "limit" ? "warn" : r.rc === 0 ? "good" : r.rc == null ? "" : "bad"}">${icon(r.ended_by === "limit" ? "sleep" : r.rc === 0 ? "check" : r.rc == null ? "play" : "alert", 16)}<span>${esc(nameOf(r.seat))}${r.rc != null ? ` · exit ${r.rc}` : " · running"}${r.ended_by ? " · hit its limit, moved on" : ""}</span><span class="when">${clock(r.started_at)}</span></div>`).join("") : `<div class="muted">Not started yet.</div>`)}
      ${section("Brief", `<div class="quote">${esc(d ? d.brief : "")}</div>`)}
      ${section("Log", `<pre class="pre">${esc((d && d.log) || "")}</pre>`)}
      ${section("Details", `<dl class="facts"><dt>Lane id</dt><dd><code>${esc(l.id)}</code></dd><dt>Unit</dt><dd><code>${esc(l.unit)}</code></dd><dt>Folder</dt><dd><code>${esc(l.workdir)}</code></dd></dl>`)}`,
      bind(root) {
        const stop = root.querySelector("#lStop"), res = root.querySelector("#lResume"), clone = root.querySelector("#lClone"), chat = root.querySelector("[data-chat-session]");
        const front = root.querySelector("#lFront");
        if (front) front.addEventListener("click", async () => {
          try { const r = await app.post("/api/lanes/front", { id: l.id }); toast(r.demo ? "Demo office: nothing was moved." : "First in line now.", r.demo ? "info" : "good"); app.refresh(); } catch (e) { toast("Could not move it: " + e.message, "bad"); }
        });
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
  // The lane safety policy (config.json lane_policy), as chips under Permissions: where lanes may work and their caps.
  function policyHtml(pol) {
    if (!pol || pol.roots == null) return "";
    const chips = [pol.roots.length ? `Only under ${pol.roots.map(r => app.privacy() ? "a project folder" : r.replace(/^\/home\/[^/]+/, "~")).join(", ")}` : "Any folder",
      pol.allow_full_trust === false ? "No full trust" : "Never full trust in ~ or /",
      pol.memory_max ? `Memory capped at ${pol.memory_max}${/%$/.test(pol.memory_max) ? " of RAM" : ""}` : "",
      pol.tasks_max ? `At most ${pol.tasks_max.toLocaleString()} processes` : ""].filter(Boolean);
    return `<div class="pol" title="The lane policy, set in config.json (lane_policy)">${icon("lock", 13)}${chips.map(c => `<span>${esc(c)}</span>`).join("")}</div>`;
  }
  // A seat's week against spending it evenly (divider.py pace): plan left per share of the week left.
  const FREE_HOURS = [["", "Never"], ["9-18", "9:00–18:00"], ["10-19", "10:00–19:00"], ["8-20", "8:00–20:00"], ["9-23", "9:00–23:00"], ["0-24", "All day"]];
  function seatPace(s) {
    const w = (s.usage || {}).weekly;
    if (!w || w.pct == null || !w.resets_at) return null;
    const leftT = Math.min(1, Math.max(0.02, (w.resets_at - Date.now() / 1000) / (7 * 86400)));
    return Math.max(0, Math.min(3, (100 - w.pct) / 100 / leftT));
  }
  const paceWords = (p) => p <= 0 ? "its week spent" : p >= 0.85 && p <= 1.15 ? "on pace for its week"
    : p > 1 ? `${p.toFixed(1)}× behind its week` : "ahead of its week";
  function pickHtml() {
    const np = dvPreview || S().next_pick, who = np.seat || np.pick;
    return `<div class="pick ${who ? "" : "none"}"><b>${who ? `Next lane → ${esc(nameOf(who))}` : "No seat can take a lane"}</b>${dvPreview ? ` ${pill("preview")}` : ""}
      <div class="why">${esc(humanise(np.why))}</div><div style="margin-top:8px">
      ${(np.ranking || []).map(r => `<div class="rk"><span>${r.eligible ? icon("check", 14) : icon("x", 14)}</span><span>${esc(nameOf(r.seat))}</span><span>${r.eligible ? `target ${Math.round((r.target ?? r.share) * 100)}% · runs ${r.lanes} · ${Math.round(r.headroom * 100)}% plan left${(dvPreview ? dv.mode : S().divider.mode) === "pace" && r.pace != null ? " · " + paceWords(r.pace) : ""}` : esc(r.blockers.join(", "))}</span></div>`).join("")}</div></div>`;
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
        <div class="row between wrap" style="margin-top:12px"><div class="seg-ctl" role="group" aria-label="Mode"><button data-mode="headroom" class="${dv.mode === "headroom" ? "on" : ""}">Adapt to plan left</button><button data-mode="pace" class="${dv.mode === "pace" ? "on" : ""}">Spend the week evenly</button><button data-mode="fixed" class="${dv.mode === "fixed" ? "on" : ""}">Fixed split</button></div>
          <button class="btn sm" id="dvSuggest">${icon("sparkles", 15)}Suggest</button></div>
        <div class="hint" style="margin-top:8px">${dv.mode === "headroom" ? "A seat's share shrinks as its plan runs out, so a nearly spent seat gets less." : dv.mode === "pace" ? "Each seat's share follows its week: one behind (plenty left, reset soon) gets more so its plan is not wasted, one ahead of its week gets less." : "Shares are kept exactly as set, until a guard stops a seat."}</div>`)}
      <div id="dvPick" style="margin-top:14px">${pickHtml()}</div>
      ${section("Seats", S().seats.map(s => { const c = dv.seats[s.id], u = s.usage || {};
        return `<div class="dseat">${avatar("mascot-" + s.id, s.color, c.enabled ? "" : "dim")}
          <div><b>${esc(P(s).name)}</b> <span class="hint">${esc(SEAT_LABEL[s.status] || s.status)} · 5-hour ${pct(u, "five_hour") == null ? "–" : Math.round(100 - pct(u, "five_hour")) + "% left"} · week ${pct(u, "weekly") == null ? "–" : Math.round(100 - pct(u, "weekly")) + "% left"}${dv.mode === "pace" && seatPace(s) != null ? " · " + paceWords(seatPace(s)) : ""}</span></div>
          <label class="switch" title="On duty"><input type="checkbox" data-duty="${esc(s.id)}" ${c.enabled ? "checked" : ""} aria-label="${esc(P(s).name)} on duty"><span></span></label>
          <div class="ctl"><label>Share <input type="number" min="0" max="100" value="${c.weight}" data-w="${esc(s.id)}" ${c.enabled ? "" : "disabled"}> %</label>
            <label>At most <input type="number" min="0" max="16" value="${c.max_lanes}" data-cap="${esc(s.id)}"> lanes</label><span>running ${s.lanes}</span></div>
          <div class="ctl"><label>Keep free <select data-free="${esc(s.id)}" title="No new lanes on this seat in these hours, so it is yours for interactive work">${FREE_HOURS.map(([v, l]) => `<option value="${v}" ${(c.free_hours || []).join("-") === v ? "selected" : ""}>${l}</option>`).join("")}${c.free_hours && !FREE_HOURS.some(([v]) => v === c.free_hours.join("-")) ? `<option value="${c.free_hours.join("-")}" selected>${c.free_hours[0]}:00–${c.free_hours[1]}:00</option>` : ""}</select></label>
            <input type="text" placeholder="Note, e.g. keep free for interactive work" value="${esc(c.note || "")}" data-note="${esc(s.id)}" maxlength="200"></div></div>`; }).join(""))}
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
        root.querySelectorAll("[data-free]").forEach(sel => sel.addEventListener("change", () => { dv.seats[sel.dataset.free].free_hours = sel.value ? sel.value.split("-").map(Number) : null; markDirty(); }));
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
  // Templates of your own (Hire → Save as a template), kept in this browser.
  const myTemplates = () => { const l = store.get("myTemplates", []); return Array.isArray(l) ? l.filter(t => t && t.name && t.brief) : []; };
  // What a good brief has: a goal, where to look, and how to know it is done. The chips light up as the brief says so.
  const BRIEF_PARTS = [["Goal", /\b(goal|fix|make|build|add|write|find|investigate|review|refactor|update|remove|migrate)\b/i],
    ["Where to look", /(\bwhere\b|\bin (the )?\w+\/|[\w-]+\.(py|js|ts|go|rs|md|json|sql|ya?ml)\b|\brepo\b|\bfolder\b|\bfile\b|\bendpoint\b|\bpage\b|#\d+)/i],
    ["Done when", /(done when|\bdone:|\bverify\b|\bpasses?\b|\bgreen\b|\breport\b|\buntil\b|\bcounts as done\b|\bPR\b)/i]];
  function briefCheck(text) {
    const t = text || "";
    return BRIEF_PARTS.map(([label, re]) => { const ok = re.test(t); return `<span class="bc ${ok ? "ok" : ""}">${icon(ok ? "check" : "dot", 13)}${label}</span>`; }).join("") +
      `<span class="bc-n">${t.trim() ? t.trim().split(/\s+/).length + " words" : ""}</span>`;
  }
  function hire() {
    const snap = S(), ld = snap.office.lane_defaults || {}, np = snap.next_pick, d = hireDraft, pol = snap.office.lane_policy || {};
    const dirs = [...new Set([snap.office.default_workdir, ...snap.seats.flatMap(s => s.sessions.map(x => x.cwd))].filter(Boolean))];
    const isCodex = d.seat && seatById(d.seat) && seatById(d.seat).kind === "codex";
    return { html: `${crumbs("Hiring desk")}
      <h2>Hire a lane</h2>
      <p class="lede">A lane is an agent that works in the background on one brief. It keeps notes, moves to another seat if its seat runs out of plan, and files a report when it is done.</p>
      ${(() => { const nx = nextUp(); return nx.length ? section("Next up", `<div class="nextup">${nx.map((n, i) => `<span class="nx"><button data-next="${esc(n.key)}" title="${esc(app.privacy() ? "A suggestion from what the office saw" : n.why)}">${icon(n.ic, 16)}<span class="${app.privacy() ? "private" : ""}">${esc(n.title)}</span></button><button class="tpl-x" data-next-x="${esc(n.key)}" aria-label="Not now" title="Not now">${icon("x", 13)}</button></span>`).join("")}</div>
        <p class="hint">From what the office saw: blocked reports, lanes that failed and PRs whose checks fail. A click fills the form; nothing starts until you hire.</p>`) : ""; })()}
      ${section("Start from a template", `<div class="templates">${myTemplates().map((t, i) => `<span class="tpl-mine"><button data-mytpl="${i}" title="${esc(t.title)}">${icon("star", 16)}${esc(t.name)}</button><button class="tpl-x" data-mytpl-del="${i}" aria-label="Delete the template ${esc(t.name)}" title="Delete">${icon("x", 13)}</button></span>`).join("")}${TEMPLATES.map((t, i) => `<button data-tpl="${i}">${icon(t.ic, 16)}${esc(t.name)}</button>`).join("")}</div>`)}
      ${section("The brief", `
        <label class="f">Title<input type="text" id="hTitle" maxlength="80" placeholder="e.g. Fix the flaky export test" value="${esc(d.title)}"></label>
        <label class="f">What should it do?<textarea id="hBrief" placeholder="The goal, where to look, how to check the work, and what counts as done.">${esc(d.brief)}</textarea></label>
        <details class="fanout" ${d.each ? "open" : ""}><summary>${icon("layers", 14)}One lane for each of a list…</summary>
          <label class="f">For each (one per line: PRs, failing tests, files)<textarea id="hEach" placeholder="#481&#10;#482&#10;tests/test_export.py" style="min-height:76px">${esc(d.each || "")}</textarea></label>
          <p class="hint">Each line becomes its own lane in the backlog (at most 20), running in waves as seats free up. Write {{item}} in the title or the brief where the line goes; otherwise it is added to both.</p></details>
        <div class="brief-check" id="hCheck" aria-live="polite">${briefCheck(d.brief)}</div>
        <label class="f">Working folder<input type="text" id="hDir" list="hDirs" value="${esc(d.workdir || snap.office.default_workdir || "")}"><datalist id="hDirs">${dirs.map(x => `<option value="${esc(x)}">`).join("")}</datalist></label>
        <div class="grid2">
          <label class="f">Who does it<select id="hSeat"><option value="auto" ${d.seat === "auto" ? "selected" : ""}>Let the divider pick (now ${esc(np.seat ? nameOf(np.seat) : "nobody")})</option>
            ${snap.seats.map(s => `<option value="${esc(s.id)}" ${d.seat === s.id ? "selected" : ""}>${esc(P(s).name)} · ${esc(SEAT_LABEL[s.status] || s.status)}</option>`).join("")}</select></label>
          <label class="f">Model<select id="hModel" ${isCodex ? "disabled" : ""}>${["opus", "sonnet", "fable", "haiku"].map(m => `<option ${(d.model || ld.model) === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
        </div>
        <label class="f">Permissions<select id="hPerm" ${isCodex ? "disabled" : ""}>
          <option value="acceptEdits" ${(d.permission_mode || ld.permission_mode) === "acceptEdits" ? "selected" : ""}>Edit files, run listed tools</option>
          <option value="bypassPermissions" ${(d.permission_mode || ld.permission_mode) === "bypassPermissions" ? "selected" : ""} ${pol.allow_full_trust === false ? "disabled" : ""}>Full trust (skips every permission check)${pol.allow_full_trust === false ? ": off by policy" : ""}</option></select></label>
        ${policyHtml(pol)}
        <div class="grid2"><label class="f">Start<select id="hStart">
          <option value="" ${!d.start ? "selected" : ""}>Now</option>
          <option value="at" ${d.start === "at" ? "selected" : ""}>At a time…</option>
          <option value="left" ${d.start === "left" ? "selected" : ""}>When a seat has 30% of its window left</option>
          <option value="backlog" ${d.start === "backlog" ? "selected" : ""}>Add to the backlog (oldest first, as seats free up)</option></select></label>
          ${d.start === "at" ? `<label class="f">At<input type="datetime-local" id="hStartAt" value="${esc(d.startAt || "")}"></label>` : "<span></span>"}</div>
        <label class="f">Time limit<select id="hMax">${[["", "None"], ["30", "30 minutes"], ["60", "1 hour"], ["120", "2 hours"], ["240", "4 hours"]].map(([v, l]) => `<option value="${v}" ${String(d.max_minutes || "") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="f">Then, in the same folder<select id="hThen">
          <option value="" ${!d.chain ? "selected" : ""}>Nothing: it reports and stops</option>
          <option value="review" ${d.chain === "review" ? "selected" : ""}>A second lane reviews its work</option>
          <option value="fix-review" ${d.chain === "fix-review" ? "selected" : ""}>A lane fixes what it found, then another reviews the fix</option>
          ${snap.seats.some(s => s.kind === "codex") ? `<option value="second-opinion" ${d.chain === "second-opinion" ? "selected" : ""}>Codex gives a second opinion on its work</option>` : ""}</select></label>
        <div class="hint" style="margin:-6px 0 14px">Each stage starts when the one before reports done, with that report in its brief. A blocked report stops the chain.</div>
        <div class="setrow" style="border-top:0;padding-top:0"><div class="grow">Let me message it while it works<small>Messages from the office reach this lane directly instead of waiting for approval.</small></div>
          <label class="switch"><input type="checkbox" id="hMsg" ${d.allow_messages !== false ? "checked" : ""} ${isCodex ? "disabled" : ""} aria-label="Allow messages"><span></span></label></div>
        <div class="hint">${isCodex ? "Codex seat: it runs through the gpt bridge, so model, permissions and messages do not apply." : "Runs as a background service at low priority, with no windows."}</div>
        <div class="row" style="margin-top:16px;gap:8px"><button class="btn primary" id="hGo">${icon("briefcase", 16)}Hire and start</button><button class="btn" id="hSaveTpl" title="Keep this title and brief as a template (in this browser)">${icon("star", 15)}Save as a template</button><button class="btn ghost" id="hClear">Clear</button></div>`)}
      ${section("Office lanes", `<div id="laneList">${laneListHtml()}</div>`)}`,
      bind(root) {
        const q = (id) => root.querySelector("#" + id);
        const save = () => { hireDraft = { title: q("hTitle").value, brief: q("hBrief").value, workdir: q("hDir").value, seat: q("hSeat").value, model: q("hModel").value, permission_mode: q("hPerm").value, allow_messages: q("hMsg").checked, chain: q("hThen").value || "",
          start: q("hStart").value || "", startAt: q("hStartAt") ? q("hStartAt").value : hireDraft.startAt || "", each: q("hEach").value, max_minutes: +q("hMax").value || null }; store.set("hireDraft", hireDraft); };
        ["hTitle", "hBrief", "hDir", "hModel", "hPerm", "hThen", "hEach"].forEach(id => q(id).addEventListener("input", save));
        const items = () => [...new Set(q("hEach").value.split("\n").map(x => x.trim()).filter(Boolean))];
        const goLabel = () => { const n = items().length; q("hGo").innerHTML = `${icon("briefcase", 16)}${n >= 2 ? `Hire ${Math.min(n, 20)} lanes into the backlog` : "Hire and start"}`; };
        q("hEach").addEventListener("input", goLabel); goLabel();
        q("hBrief").addEventListener("input", () => { q("hCheck").innerHTML = briefCheck(q("hBrief").value); });
        q("hMsg").addEventListener("change", save);
        q("hMax").addEventListener("change", save);
        q("hSeat").addEventListener("change", () => { save(); app.rerender(true); });
        q("hStart").addEventListener("change", () => { save(); app.rerender(true); });
        if (q("hStartAt")) q("hStartAt").addEventListener("input", save);
        const useTpl = (t) => {
          save();
          const mine = (hireDraft.title.trim() || hireDraft.brief.trim()) && ![...TEMPLATES, ...myTemplates()].some(x => x.brief === hireDraft.brief);
          if (mine && !confirm(`Replace your title and brief with the "${t.name}" template?`)) return;
          hireDraft.title = t.title; hireDraft.brief = t.brief; store.set("hireDraft", hireDraft); app.rerender(true);
          const ti = document.getElementById("hTitle"); if (ti) { ti.focus(); ti.setSelectionRange(ti.value.length, ti.value.length); }
        };
        root.querySelectorAll("[data-mytpl]").forEach(b => b.addEventListener("click", () => useTpl(myTemplates()[+b.dataset.mytpl])));
        root.querySelectorAll("[data-mytpl-del]").forEach(b => b.addEventListener("click", () => {
          const list = myTemplates(), t = list[+b.dataset.mytplDel];
          if (!t || !confirm(`Delete the template "${t.name}"?`)) return;
          list.splice(+b.dataset.mytplDel, 1); store.set("myTemplates", list); app.rerender(true);
        }));
        q("hSaveTpl").addEventListener("click", () => {
          save();
          if (!hireDraft.title.trim() || !hireDraft.brief.trim()) { toast("Write a title and a brief first.", "warn"); return; }
          const name = (prompt("A short name for this template:", hireDraft.title.trim().slice(0, 40)) || "").trim().slice(0, 40);
          if (!name) return;
          const list = myTemplates().filter(t => t.name !== name);
          list.unshift({ name, title: hireDraft.title, brief: hireDraft.brief });
          store.set("myTemplates", list.slice(0, 12)); app.rerender(true); toast(`Saved the template "${name}".`, "good");
        });
        root.querySelectorAll("[data-next]").forEach(b => b.addEventListener("click", () => {
          const n = nextUp().find(x => x.key === b.dataset.next);        // by key: the list may have changed since it was drawn
          if (!n) { toast("That suggestion is gone now.", "info"); app.rerender(true); return; } save();
          if ((hireDraft.title.trim() || hireDraft.brief.trim()) && !confirm("Replace your title and brief with this suggestion?")) return;
          hireDraft = { ...hireDraft, title: n.title, brief: n.brief, workdir: n.workdir || hireDraft.workdir }; store.set("hireDraft", hireDraft); app.rerender(true);
          const ti = document.getElementById("hBrief"); if (ti) ti.focus();
        }));
        root.querySelectorAll("[data-next-x]").forEach(b => b.addEventListener("click", () => {
          store.set("nextSkip", [...store.get("nextSkip", []), b.dataset.nextX].slice(-60)); app.rerender(true);
        }));
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
          const list = items();
          if (list.length >= 2) {                     // fan out: one lane per line, all into the backlog
            const n = Math.min(20, list.length);
            if (!confirm(`Hire ${n} lanes, one for each line${list.length > 20 ? " (the first 20)" : ""}, into the backlog?`)) return;
            q("hGo").disabled = true;
            const fill = (t, item, sep) => (t.includes("{{item}}") ? t.split("{{item}}").join(item) : t + sep + item);
            let ok = 0, demo = false;
            for (const item of list.slice(0, 20)) {
              try {
                const r = await app.post("/api/lanes", { ...hireDraft, title: fill(hireDraft.title, item, " · ").slice(0, 80), brief: fill(hireDraft.brief, item, "\n\nThis lane's item: "), start: { backlog: true } });
                if (r.demo) { demo = true; break; } ok++;
              } catch (e) { toast(`Could not hire for “${item}”: ${e.message}`, "bad"); }
            }
            if (demo) toast("Demo office: no lanes were hired.");
            else { sound.play("hire"); toast(`${ok} lane${ok === 1 ? "" : "s"} in the backlog: they start as seats free up.`, "good"); app.badge("hiring"); hireDraft = { ...hireDraft, title: "", brief: "", each: "" }; store.set("hireDraft", hireDraft); }
            q("hGo").disabled = false; app.refresh(); app.rerender(true);
            return;
          }
          q("hGo").disabled = true;
          try {
            const startAt = hireDraft.start === "at" && hireDraft.startAt ? Date.parse(hireDraft.startAt) / 1000 : null;
            if (hireDraft.start === "at" && !startAt) { q("hGo").disabled = false; toast("Pick when it should start.", "warn"); return; }
            const r = await app.post("/api/lanes", { ...hireDraft, start: hireDraft.start === "at" ? { at: startAt } : hireDraft.start === "left" ? { left: 30 } : hireDraft.start === "backlog" ? { backlog: true } : null });
            if (r.demo) toast("Demo office: no lane was started.");
            else { sound.play("hire"); toast(`Hired “${r.lane.title}”. Watch the elevator.`, "good"); app.badge("hiring"); hireDraft = { title: "", brief: "", workdir: hireDraft.workdir, seat: "auto", model: "", permission_mode: "", allow_messages: true, chain: "" }; store.set("hireDraft", hireDraft); }
            app.refresh(); app.rerender(true);
          } catch (e) { toast("Could not hire: " + e.message, "bad"); q("hGo").disabled = false; }
        });
      } };
  }
  const UNFINISHED = ["scheduled", "queued", "starting", "running", "waiting", "interrupted"];   // lanes.UNFINISHED, and the cut-off ones
  const ordinal = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");
  // Next up: lanes worth hiring, from what the office saw (blocked reports, failed lanes, PRs whose checks fail), as
  // ready briefs in the folder they concern. Three at most; "Not now" hides one in this browser.
  function nextUp() {
    const skip = new Set(store.get("nextSkip", [])), out = [], seen = new Set();
    const add = (n) => { if (!skip.has(n.key) && !seen.has(n.key) && n.workdir !== undefined) { seen.add(n.key); out.push(n); } };
    for (const l of S().lanes || []) {
      if (l.status === "blocked" && l.report_status) add({ key: "lane-blocked:" + l.id, ic: "alert", title: `Unblock: ${l.title}`.slice(0, 80), workdir: l.workdir || "",
        why: `Lane '${l.title}' reported: ${l.report_status}`,
        brief: `The office lane "${l.title}" stopped with this report:\n\n${l.report_status}\n\nRead its REPORT.md and STATE.md in this folder, find what blocks it and fix that. If you need a decision from the CEO, ask with \`python3 -m office ask\` and keep going on what you can.` });
      if (l.status === "failed") add({ key: "lane-failed:" + l.id, ic: "refresh", title: `Retry: ${l.title}`.slice(0, 80), workdir: l.workdir || "",
        why: `Lane '${l.title}' failed${l.error ? ": " + l.error : ""}`, brief: `The office lane "${l.title}" failed before it finished. Read its notes in this folder (STATE.md, lane.log), work out why, and finish the job it was given.` });
    }
    for (const st of S().seats) for (const x of st.sessions || []) {
      if (x.live === false) continue;
      if (x.ci && x.ci.checks === "fail") add({ key: "ci:" + x.ci.number, ic: "x", title: `Fix the checks on PR #${x.ci.number}`, workdir: x.cwd || "",
        why: `PR #${x.ci.number}'s checks fail on ${x.ci.branch || "its branch"}`,
        brief: `Pull request #${x.ci.number}${x.ci.title ? ` ("${x.ci.title}")` : ""} has failing checks. Read them with \`gh pr checks ${x.ci.number}\` and the failing job's log, fix the cause on its branch, push, and confirm the checks pass.` });
      if (x.report_status && /^[\W\d_]*(?:STATUS\W*)?BLOCKED\b/i.test(x.report_status)) add({ key: "session-blocked:" + x.id, ic: "alert", title: `Unblock: ${x.name}`.slice(0, 80), workdir: x.cwd || "",
        why: `${x.name} reported: ${x.report_status}`, brief: `The session "${x.name}" in this folder reported:\n\n${x.report_status}\n\nFind what blocks it and fix that, or say clearly what you need from the CEO.` });
    }
    return out.slice(0, 3);
  }
  function laneListHtml() {
    const active = S().lanes.filter(l => UNFINISHED.includes(l.status)).length;
    return (active > 1 ? `<div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="btn sm danger" data-stop-all>${icon("stop", 14)}Stop all ${active}</button></div>` : "")
      + (S().lanes.length ? S().lanes.map(laneRow).join("") : emptyState("briefcase", "No office lanes yet", "A lane is a session the office runs for you in the background: write a brief, pick a seat or let the divider pick, and it works until it files a report."));
  }
  // The panic button: every office lane that is still going stops (your own terminals are never touched).
  async function stopAllLanes() {
    const active = S().lanes.filter(l => UNFINISHED.includes(l.status)).length;
    if (!active) { toast("No office lane is running.", "info"); return; }
    if (!confirm(`Stop all ${active} office lane${active === 1 ? "" : "s"}? Each one keeps its notes and can be resumed. Sessions in your own terminals are not touched.`)) return;
    try {
      const r = await app.post("/api/lanes/stop-all", { ids: S().lanes.filter(l => UNFINISHED.includes(l.status)).map(l => l.id) });
      toast(r.demo ? "Demo office: nothing was stopped." : `Stopped ${r.stopped.length} lane${r.stopped.length === 1 ? "" : "s"}.`, r.demo ? "info" : "warn");
      app.refresh();
    } catch (e) { toast("Could not stop them: " + e.message, "bad"); }
  }

  // ----------------------------------------------------------------------------------------- settings
  // The character creator: skin, hair colour, hairstyle and glasses, with a live portrait; "Automatic" goes back to the
  // look the character was born with. Chosen looks wait in lookDraft until "Save office settings".
  const lookDraft = new Map();
  function lookEditor(portraitId, color, saved, key) {
    const cur = lookDraft.has(key) ? lookDraft.get(key) || {} : saved || {};
    const sw = (k, list) => list.map((c, i) => `<button type="button" class="lk-sw ${cur[k] === i ? "on" : ""}" style="--c:${c}" data-lk="${esc(key)}|${k}|${i}" aria-label="${k} ${i + 1}" aria-pressed="${cur[k] === i}"></button>`).join("");
    return `<div class="look-edit" data-look-for="${esc(key)}" data-look-id="${esc(portraitId)}" data-look-color="${esc(color)}" data-saved="${esc(JSON.stringify(saved || null))}">
      <div class="lk-prev" aria-hidden="true"></div>
      <div class="lk-rows"><div class="lk-row"><span>Skin</span>${sw("skin", PALETTE.skin)}</div><div class="lk-row"><span>Hair</span>${sw("hair", PALETTE.hair)}</div>
        <div class="lk-row"><span>Style</span>${LOOK_STYLES.map((n, i) => `<button type="button" class="lk-st ${cur.style === i ? "on" : ""}" data-lk="${esc(key)}|style|${i}" aria-pressed="${cur.style === i}">${n}</button>`).join("")}</div>
        <div class="lk-row"><span>Glasses</span><button type="button" class="lk-st ${cur.glasses === true ? "on" : ""}" data-lk="${esc(key)}|glasses|1" aria-pressed="${cur.glasses === true}">On</button><button type="button" class="lk-st ${cur.glasses === false ? "on" : ""}" data-lk="${esc(key)}|glasses|0" aria-pressed="${cur.glasses === false}">Off</button>
          <button type="button" class="btn sm ghost" data-lk-reset="${esc(key)}">Automatic</button></div></div></div>`;
  }
  function bindLooks(root) {
    const paint = (w) => { const box = w.querySelector(".lk-prev"), l = lookDraft.has(w.dataset.lookFor) ? lookDraft.get(w.dataset.lookFor) : undefined;
      box.replaceChildren(portrait(w.dataset.lookId, w.dataset.lookColor, { scale: 4, look: l === undefined ? undefined : (l || {}) })); };
    root.querySelectorAll("[data-look-for]").forEach(paint);
    root.querySelectorAll("[data-lk]").forEach(b => b.addEventListener("click", () => {
      const [key, k, v] = b.dataset.lk.split("|"), w = root.querySelector(`[data-look-for="${CSS.escape(key)}"]`);
      const base = lookDraft.has(key) ? { ...(lookDraft.get(key) || {}) } : { ...(JSON.parse(w.dataset.saved || "null") || {}) };
      base[k] = k === "glasses" ? v === "1" : +v;
      lookDraft.set(key, base);
      w.querySelectorAll(`[data-lk^="${CSS.escape(key)}|${k}|"]`).forEach(x => { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); });
      paint(w);
    }));
    root.querySelectorAll("[data-lk-reset]").forEach(b => b.addEventListener("click", () => {
      const key = b.dataset.lkReset, w = root.querySelector(`[data-look-for="${CSS.escape(key)}"]`);
      lookDraft.set(key, null);
      w.querySelectorAll("[data-lk]").forEach(x => { x.classList.remove("on"); x.setAttribute("aria-pressed", "false"); });
      paint(w);
    }));
  }
  function settings() {
    if (!settingsData && !settingsLoading) {
      settingsLoading = true;
      fetch("/api/ai").then(r => r.ok ? r.json() : null).then(j => { aiSpend = j && j.spent; }).catch(() => {});
      fetch("/api/settings").then(r => r.ok ? r.json() : null).then(j => { settingsData = j || { unavailable: true }; settingsLoading = false; app.rerender(true); })
        .catch(() => { settingsData = { unavailable: true }; settingsLoading = false; app.rerender(true); });
    }
    const p = app.prefs(), sd = settingsData && !settingsData.unavailable ? settingsData : null, voice = sd ? sd.voice || {} : {};
    const VOICE = [["report", "Reports filed"], ["limit", "Usage limits"], ["login", "Logouts"], ["lane", "Office lanes finished"], ["usage", "A seat nearly empty"], ["stuck", "Quiet lanes"], ["risk", "Risky actions"]];
    const row = (title, sub, ctl) => `<div class="setrow"><div class="grow">${title}<small>${sub}</small></div>${ctl}</div>`;
    const sw = (key, on, label) => `<label class="switch"><input type="checkbox" data-pref="${key}" ${on ? "checked" : ""} aria-label="${esc(label)}"><span></span></label>`;
    return { html: `${crumbs("Settings")}<h2>Settings</h2>
      ${section("This screen", [
        row("Theme", "Night is the default.", `<div class="seg-ctl" role="group" aria-label="Theme">${[["dark", "Night"], ["light", "Day"], ["system", "System"]].map(([t, l]) => `<button data-theme-set="${t}" class="${p.theme === t ? "on" : ""}" aria-pressed="${p.theme === t}">${l}</button>`).join("")}</div>`),
        row("Text size", (() => { const ts = app.textSize(); return ts.pref === "auto" ? `Auto shows text at ${Math.round(ts.zoom * 100)}% on this screen.` : "Bigger text for big or far-away screens."; })(),
          `<div class="seg-ctl" role="group" aria-label="Text size">${[["auto", "Auto"], ["s", "S"], ["m", "M"], ["l", "L"], ["xl", "XL"]].map(([t, l]) => `<button data-text-set="${t}" class="${(p.textSize || "auto") === t ? "on" : ""}" aria-pressed="${(p.textSize || "auto") === t}" aria-label="${esc(app.textSize().label[t])}">${l}</button>`).join("")}</div>`),
        row("Game", "Full: gifts, banners and banter. Calm: no banners, confetti or chatter. Off: no game at all. Alerts stay at every level. Z cycles.",
          `<div class="seg-ctl" role="group" aria-label="Game">${[["full", "Full"], ["calm", "Calm"], ["off", "Off"]].map(([t, l]) => `<button data-game-set="${t}" class="${(p.game || "full") === t ? "on" : ""}" aria-pressed="${(p.game || "full") === t}">${l}</button>`).join("")}</div>`),
        row("Weekdays-only streak", "Saturdays and Sundays never break your visit streak.", sw("streakWeekdays", !!p.streakWeekdays, "Weekdays-only streak")),
        row("Seasonal decorations", "Pumpkins for Halloween, lamps for Diwali, a tree and snow in December.", sw("seasonal", p.seasonal !== false, "Seasonal decorations")),
        row("Motion", "Reduced stops walking, confetti and fades.", `<div class="seg-ctl" role="group" aria-label="Motion">${[["full", "Full"], ["reduced", "Reduced"]].map(([t, l]) => `<button data-motion-set="${t}" class="${p.motion === t ? "on" : ""}" aria-pressed="${p.motion === t}">${l}</button>`).join("")}</div>`),
        row("Sound effects", "Little chimes for arrivals, reports and limits.", `<button class="btn sm ghost" data-test-sound>Play</button>${sw("sound", p.sound, "Sound effects")}`),
        row("Desktop notifications", "Reports, limits and logouts while this tab is in the background.", sw("notify", p.notify, "Desktop notifications")),
        row("Share-safe", "Blur what terminal sessions are about, and account emails.", sw("privacy", app.privacy(), "Share-safe")),
      ].join(""))}
      ${section("Alarms", [
        row("Burn alarm", "Say so when a seat burns more than this many million tokens in an hour. Empty is off.",
          `<span class="numwrap"><input type="number" min="1" max="100000" step="1" class="numin" data-alarm-num="alarmBurnM" value="${p.alarmBurnM ?? ""}" placeholder="off" aria-label="Burn alarm, million tokens an hour"><span class="unit">M/h</span></span>`),
        row("Run-out alarm", "Say so when a working seat's 5-hour window will run out within this many minutes. Empty is off.",
          `<span class="numwrap"><input type="number" min="1" max="300" step="1" class="numin" data-alarm-num="alarmRunoutMin" value="${p.alarmRunoutMin ?? ""}" placeholder="off" aria-label="Run-out alarm, minutes"><span class="unit">min</span></span>`),
        row("Milestones", "Say so when the office passes 1, 2 or 5 times a power of ten in tokens.", sw("alarmMilestone", !!p.alarmMilestone, "Milestone alarm")),
        row("Top burner", "Say so when another character becomes the top burner of all time.", sw("alarmTopBurner", !!p.alarmTopBurner, "Top burner alarm")),
      ].join("") + `<div class="hint">Alarms ring at every game level: a toast, a chime, and a desktop notification when this tab is in the background. Each rings once an hour at most.</div>`)}
      ${!sd ? section("Office", `<div class="hint">${settingsLoading ? "Loading…" : "Office settings are not available from this server."}</div>`) : `
      ${section("Office", `<div class="grid2"><label class="f">Office name<input type="text" id="setOffice" maxlength="40" value="${esc(sd.office_name || "")}"></label><label class="f">Your name<input type="text" id="setCeo" maxlength="40" value="${esc(sd.ceo_name || "")}"></label></div>
        <div class="persona-edit"><div class="head"><b>You, at the CEO's desk</b></div>${lookEditor("ceo-" + (sd.ceo_name || "CEO"), "#22304f", sd.ceo_look, "ceo")}</div>`)}
      ${section("Characters", Object.entries(sd.seats || {}).map(([id, st]) => {
        const seat = seatById(id), per = seat ? P(seat) : { name: st.nickname || id, role: st.role || "", motto: st.motto || "" };
        return `<div class="persona-edit"><div class="head">${avatar("mascot-" + id, st.color || "#888888")}<div class="grow"><b>${esc(per.name)}</b> <span class="hint">${esc(st.label || id)}</span></div><input type="color" data-color="${esc(id)}" value="${esc(st.color || "#888888")}" aria-label="${esc(id)} colour"></div>
          <label class="f">Name<input type="text" data-nick="${esc(id)}" aria-label="Name for ${esc(st.label || id)}" maxlength="24" placeholder="${esc(per.name)}" value="${esc(st.nickname || "")}"></label>
          <label class="f">Role<input type="text" data-role="${esc(id)}" aria-label="Role for ${esc(per.name)}" maxlength="40" placeholder="${esc(per.role)}" value="${esc(st.role || "")}"></label>
          <label class="f">Plan, USD a month<input type="number" min="0" max="10000" step="1" inputmode="decimal" data-plan="${esc(id)}" aria-label="Plan price a month for ${esc(per.name)}" placeholder="${st.plan_default != null ? esc(String(st.plan_default)) + " (list price)" : "not set"}" value="${st.plan_usd != null ? esc(String(st.plan_usd)) : ""}"></label>
          <label class="f full">Motto<input type="text" data-motto="${esc(id)}" aria-label="Motto for ${esc(per.name)}" maxlength="90" placeholder="${esc(per.motto)}" value="${esc(st.motto || "")}"></label>
          ${lookEditor("mascot-" + id, st.color || "#888888", st.look, id)}
          <label class="f full">Personality: voice and room<select data-style="${esc(id)}" aria-label="Personality for ${esc(per.name)}: voice and room"><option value="">Automatic (${esc(seat ? personaFor({ ...seat, style: null }, S().seats.findIndex(x => x.id === id)).archetype : "by order")})</option>${PERSONALITIES.map(x => `<option value="${esc(x.role)}" ${st.style === x.role ? "selected" : ""}>${esc(x.role)} · ${esc(x.motto)}</option>`).join("")}</select></label></div>`; }).join(""))}
      ${section("Jarvis voice", `${row("Announce out loud", sd.voice_available ? "Speaks short alerts through jarvis-say. Off by default." : "jarvis-say was not found on this machine.", `<label class="switch"><input type="checkbox" id="setVoice" ${voice.enabled ? "checked" : ""} ${sd.voice_available ? "" : "disabled"} aria-label="Voice"><span></span></label>`)}
        <div class="row wrap" style="gap:6px;margin:10px 0">${VOICE.map(([k, l]) => `<label class="pill" style="cursor:pointer"><input type="checkbox" data-vev="${k}" ${(voice.events || []).includes(k) ? "checked" : ""}> ${l}</label>`).join("")}</div>
        <div class="grid2"><label class="f">Quiet from (hour)<input type="number" min="0" max="23" id="setQ1" value="${(voice.quiet_hours || [23, 8])[0]}"></label><label class="f">Until (hour)<input type="number" min="0" max="23" id="setQ2" value="${(voice.quiet_hours || [23, 8])[1]}"></label></div>`)}
      ${sd.ai ? section("Office analyst", `<p class="hint" style="margin-top:0">Small questions to Claude on one of your seats, such as asking a session's transcript whether it ran its tests. Off until you turn it on: it uses a little of a seat's plan, runs with no tools and nothing saved, and keeps to a daily budget.</p>
        ${row("Turn on the analyst", "Runs claude -p on a seat with plan left (Haiku unless you pick Sonnet).", `<label class="switch"><input type="checkbox" id="setAi" ${sd.ai.enabled ? "checked" : ""} aria-label="Office analyst"><span></span></label>`)}
        ${row("Let it read transcripts", "Needed for Ask about it. The transcript goes to the session's own seat, with credentials masked.", `<label class="switch"><input type="checkbox" id="setAiTx" ${sd.ai.allow_transcripts ? "checked" : ""} aria-label="Let the analyst read transcripts"><span></span></label>`)}
        <div class="grid2"><label class="f">Model<select id="setAiModel">${["haiku", "sonnet"].map(m => `<option ${sd.ai.model === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
          <label class="f">Daily budget (tokens)<input type="number" id="setAiBudget" min="10000" max="10000000" step="10000" value="${sd.ai.daily_tokens}"></label></div>
        ${aiSpend ? `<div class="hint">Today: ${aiSpend.calls} call${aiSpend.calls === 1 ? "" : "s"}, ${fmtTok(aiSpend.tokens)} of ${fmtTok(sd.ai.daily_tokens)} tokens.</div>
          ${aiSpend.recent.length ? `<details class="ai-log"><summary>What was sent</summary><ul>${aiSpend.recent.map(r => `<li><small>${r.ts ? relTime(r.ts) : ""}</small> ${esc(r.kind || "")}${r.about && !app.privacy() ? `: ${esc(r.about)}` : ""} · ${r.cached ? "from the cache" : `${fmtTok(r.tokens || 0)} tokens on ${esc(nameOf(r.seat))}, ${(r.chars || 0).toLocaleString()} characters`}</li>`).join("")}</ul></details>` : ""}` : ""}`) : ""}
      ${sd.risk_watch ? section("Risky-action watch", `<p class="hint" style="margin-top:0">A session that does one of these shows up in Needs you within seconds, with the command. It warns after the fact; it cannot stop anything. Untick what your agents do on purpose.</p>
        <div class="row wrap" style="gap:6px;margin:10px 0">${Object.entries(sd.risk_watch.rules || {}).map(([k, l]) => `<label class="pill" style="cursor:pointer"><input type="checkbox" data-rwatch="${esc(k)}" ${(sd.risk_watch.mute || []).includes(k) ? "" : "checked"}> ${esc(l)}</label>`).join("")}</div>`) : ""}
      <div class="row" style="margin-top:8px"><button class="btn primary" id="setSave">Save office settings</button></div>`}
      ${section("Keyboard", `<dl class="facts">${[["Ctrl/⌘ K", "Search and commands"], ["Esc", "Back to the briefing"], ["F  T  B  S", "Floor, Timeline, Team, Today"], ["H", "Hire a lane"], ["D", "Load divider"], ["P", "Share-safe"], ["1 … 9", "Open a character"], ["\\", "Hide or show the inspector"], ["+  −  0", "Zoom in, out, fit"], ["Arrows", "Pan when zoomed in"]].map(([k, v]) => `<dt><kbd>${k}</kbd></dt><dd>${v}</dd>`).join("")}</dl>`)}
      ${section("About", `<div class="hint">Claude Office ${esc(S().office.version || "")} · up ${S().office.started_at ? ago(S().office.started_at).replace(" ago", "") : "–"} · ${esc(app.liveMode())}</div>`)}`,
      bind(root) {
        root.querySelectorAll("[data-theme-set]").forEach(b => b.addEventListener("click", () => { app.setPref("theme", b.dataset.themeSet); app.rerender(true); }));
        root.querySelectorAll("[data-text-set]").forEach(b => b.addEventListener("click", () => { app.setPref("textSize", b.dataset.textSet); app.rerender(true); }));
        root.querySelectorAll("[data-motion-set]").forEach(b => b.addEventListener("click", () => { app.setPref("motion", b.dataset.motionSet); app.rerender(true); }));
        root.querySelectorAll("[data-game-set]").forEach(b => b.addEventListener("click", () => { app.setPref("game", b.dataset.gameSet); app.rerender(true); }));
        root.querySelectorAll("[data-pref]").forEach(c => c.addEventListener("change", () => app.setPref(c.dataset.pref, c.checked)));
        root.querySelectorAll("[data-alarm-num]").forEach(i => i.addEventListener("change", () => { const v = i.value.trim(); app.setPref(i.dataset.alarmNum, v === "" || !(+v > 0) ? null : Math.round(+v)); }));
        const ts = root.querySelector("[data-test-sound]"); if (ts) ts.addEventListener("click", () => sound.preview("levelup"));
        bindLooks(root);
        const sv = root.querySelector("#setSave");
        if (sv) sv.addEventListener("click", async () => {
          const body = { office_name: root.querySelector("#setOffice").value.trim(), ceo_name: root.querySelector("#setCeo").value.trim(), seats: {},
            voice: { enabled: root.querySelector("#setVoice").checked, events: [...root.querySelectorAll("[data-vev]")].filter(c => c.checked).map(c => c.dataset.vev),
              quiet_hours: [+root.querySelector("#setQ1").value || 0, +root.querySelector("#setQ2").value || 0] } };
          if (root.querySelector("#setAi")) body.ai = { enabled: root.querySelector("#setAi").checked, allow_transcripts: root.querySelector("#setAiTx").checked,
            model: root.querySelector("#setAiModel").value, daily_tokens: Math.min(10000000, Math.max(10000, Math.round(+root.querySelector("#setAiBudget").value || 300000))) };
          if (root.querySelector("[data-rwatch]")) body.risk_watch = { mute: [...root.querySelectorAll("[data-rwatch]")].filter(c => !c.checked).map(c => c.dataset.rwatch) };
          const put = (id, k, val) => { body.seats[id] = { ...(body.seats[id] || {}), [k]: val }; };
          root.querySelectorAll("[data-nick]").forEach(i => put(i.dataset.nick, "nickname", i.value.trim()));
          root.querySelectorAll("[data-role]").forEach(i => put(i.dataset.role, "role", i.value.trim()));
          root.querySelectorAll("[data-motto]").forEach(i => put(i.dataset.motto, "motto", i.value.trim()));
          root.querySelectorAll("[data-color]").forEach(i => put(i.dataset.color, "color", i.value));
          root.querySelectorAll("[data-style]").forEach(i => put(i.dataset.style, "style", i.value || null));
          root.querySelectorAll("[data-look-for]").forEach(w => { const l = lookDraft.get(w.dataset.lookFor); if (l === undefined) return;
            if (w.dataset.lookFor === "ceo") body.ceo_look = l; else put(w.dataset.lookFor, "look", l); });
          root.querySelectorAll("[data-plan]").forEach(i => put(i.dataset.plan, "plan_usd", i.value.trim() === "" ? null : Math.min(10000, Math.max(0, +i.value || 0))));
          try { const r = await app.post("/api/settings", body); settingsData = r.demo ? settingsData : null; if (!r.demo) lookDraft.clear(); result(r, "Saved. The office redecorates on the next refresh."); app.refresh(); }
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
    draftHire: (d) => { hireDraft = { ...hireDraft, ...d }; store.set("hireDraft", hireDraft); },
    needsBySeat: () => needs(S()).reduce((m, a) => { if (a.seat) m[a.seat] = (m[a.seat] || 0) + 1; return m; }, {}), needsList: () => needs(S()), ceo, seat, session, services, programmes, loose, prs: prsPanel, inbox, cabinet: cabinetPanel, doctor: doctorPanel, project, stopAllLanes, lounge, news, trophies, lane, divider, hire, settings, laneListHtml, persona: P, nameOf, humanise,
    isEditing: (k) => (k === "divider" && (dvDirty || dragging)) || k === "hire" || k === "settings"
      || (k === "inbox" && ([...askDrafts.values()].some(v => v.trim()) || !!(document.activeElement && document.activeElement.matches("[data-ask-draft]")))) };
}

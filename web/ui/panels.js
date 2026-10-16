// The inspector: one renderer per view. Each returns { html, bind(root) }. Plain words first, numbers second.
import { esc, fmtTok, ago, until, clock, dur, pct, live, store, toast, debounce, avatar, relTime, inWords, dayTime,
  STATE_LABEL, SEAT_LABEL } from "./util.js";
import { usageSpark, bindSparks } from "./charts.js";
import { icon } from "./icons.js";
import { personaFor, moodFor, binding, leftOf, pulse } from "./personas.js";
import { sound } from "./sound.js";

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
  const sessTab = new Map();
  const openSteps = new Set();

  const S = () => app.snap();
  const seatById = (id) => S().seats.find(s => s.id === id);
  const P = (s) => personaFor(s, S().seats.indexOf(s));
  const nameOf = (id) => { const s = seatById(id); return s ? P(s).name : id; };
  const humanise = (text) => {
    let t = String(text || "");
    for (const s of S().seats) { const n = P(s).name; if (n !== s.label) t = t.replace(new RegExp(`\\b${s.label}\\b(?![-\\w])`, "g"), n); }
    return t;
  };
  const crumbs = (...parts) => `<nav class="crumbs"><button data-go="ceo">Office</button>${parts.map(x => `${icon("chevronRight", 14)}${x}`).join("")}</nav>`;
  const priv = (sess, text) => app.privacy() && sess && sess.kind === "desk" ? `<span class="private">${esc(text || "")}</span>` : esc(text || "");
  const section = (title, body, extra = "") => `<div class="section"><div class="section-h"><h4>${title}</h4>${extra}</div>${body}</div>`;
  const pill = (text, tone = "", ic = "") => `<span class="pill ${tone}">${ic ? icon(ic, 14) : ""}${esc(text)}</span>`;
  const bar = (left, cls = "minibar") => `<div class="${cls} ${left != null && left < 15 ? "low" : left != null && left < 35 ? "mid" : ""}"><i style="width:${left == null ? 0 : left}%"></i></div>`;
  const tone = (lvl) => ({ bad: "bad", warn: "warn", good: "good" }[lvl] || "info");

  function actRow(e) {
    return `<div class="act ${tone(e.level)} ${e.seat ? "click" : ""}" ${e.seat ? `data-seat="${esc(e.seat)}"` : ""}>${icon(EVENT_ICON[e.kind] || "dot", 16)}<span>${esc(humanise(e.text))}</span><span class="when">${relTime(e.ts)}</span></div>`;
  }
  function memberRow(s) {
    const p = P(s), m = moodFor(s, dayTime), b = binding(s);
    return `<div class="member" style="--seat:${s.color}" data-seat="${esc(s.id)}">
      ${avatar("mascot-" + s.id, s.color, s.status === "offline" ? "dim" : "")}
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
  function ceo() {
    const snap = S(), name = (snap.office.ceo || {}).name || "there";
    const h = new Date().getHours();
    const greet = h < 5 ? "Burning the midnight oil" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    const att = snap.attention || [];
    const shown = showAllNeeds ? att : att.slice(0, 3);
    const np = snap.next_pick, next = np.seat && seatById(np.seat);
    const welcome = !store.get("welcomed", false);
    const ev = (snap.events || []).slice(-6).reverse();
    return { html: `
      ${welcome ? `<div class="welcome"><button class="btn sm ghost x" data-dismiss-welcome aria-label="Dismiss">${icon("x", 16)}</button>
        <h3>Welcome to your office</h3><p>Every AI seat on this machine has a desk. Everyone at a desk is a real session, live.</p>
        <ol><li>Click a person to see what they are doing, and chat with them.</li><li>Click a desk's nameplate to meet that seat's character and its plan.</li>
        <li>Hire a lane at the front desk; the load divider picks who does it.</li></ol></div>` : ""}
      <h2>${greet}, ${esc(name)}.</h2>
      <p class="lede">${esc(pulse(snap, P, dayTime))}</p>
      ${!snap.seats.length ? `<div class="welcome" style="margin-top:16px"><h3>No seats yet</h3><p>Claude Office looks for <code>~/.claude</code>, <code>~/.claude2</code>, … and <code>~/.codex</code>. Log in with <code>claude</code> (or <code>CLAUDE_CONFIG_DIR=~/.claude2 claude</code> for a second account) and the desks appear here within a few seconds.</p></div>` : ""}
      ${snap.office.config_error ? `<div class="need bad" style="margin-top:14px"><span class="ico">${icon("alert", 16)}</span><div><div class="t">Config problem</div><div class="d">${esc(snap.office.config_error)}</div></div></div>` : ""}
      ${section(`Needs you${att.length ? ` · ${att.length}` : ""}`, att.length ? shown.map(a => `<div class="need ${a.level}" ${a.seat ? `data-seat="${esc(a.seat)}"` : ""} ${a.session ? `data-id="${esc(a.session)}"` : ""} ${a.lane ? `data-lane="${esc(a.lane)}"` : ""}>
          <span class="ico">${icon(a.level === "bad" ? "alert" : a.lane ? "briefcase" : a.resets_at ? "zap" : "clock", 16)}</span>
          <div class="grow"><div class="t">${esc(humanise(a.text))}</div>${a.resets_at ? `<div class="d">Plan resets ${dayTime(a.resets_at)} (${inWords(a.resets_at)})</div>` : ""}</div></div>`).join("")
        : `<div class="allclear">${icon("check", 18)}All clear. Nothing needs you right now.</div>`,
        att.length > 3 ? `<button class="btn sm ghost" data-toggle-needs>${showAllNeeds ? "Show less" : `Show all ${att.length}`}</button>` : "")}
      ${section("Your team", snap.seats.map(memberRow).join(""), `<span class="row" style="gap:4px"><button class="btn sm ghost" data-go="trophies">${icon("trophy", 14)}Trophies</button><button class="btn sm ghost" data-view-go="board">Team view</button></span>`)}
      ${section("Up next", `<div class="pick ${next ? "" : "none"}"><b>${next ? `The next lane goes to ${esc(P(next).name)}.` : "No seat can take a new lane right now."}</b>
        <div class="why">${esc(humanise(np.why))}</div>
        <div class="row wrap" style="margin-top:12px"><button class="btn sm primary" data-go="hire">${icon("plus", 15)}Hire a lane</button><button class="btn sm" data-go="divider">${icon("sliders", 15)}Adjust the split</button><button class="btn sm" data-broadcast>${icon("send", 15)}Message all lanes</button></div></div>`)}
      ${(snap.programmes || []).length ? section("Programmes", snap.programmes.map(progCard).join("")) : ""}
      ${snap.lanes.length ? section("Office lanes", snap.lanes.slice(0, 4).map(laneRow).join(""), `<button class="btn sm ghost" data-go="hire">All</button>`) : ""}
      ${section("Activity", ev.length ? ev.map(actRow).join("") : `<div class="muted">Nothing has happened yet.</div>`, `<button class="btn sm ghost" data-go="news">All news</button>`)}`,
      bind(root) {
        const d = root.querySelector("[data-dismiss-welcome]"); if (d) d.addEventListener("click", () => { store.set("welcomed", true); app.rerender(true); });
        const t = root.querySelector("[data-toggle-needs]"); if (t) t.addEventListener("click", () => { showAllNeeds = !showAllNeeds; app.rerender(true); });
        const b = root.querySelector("[data-broadcast]"); if (b) b.addEventListener("click", () => app.broadcast());
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
    const p = P(s), m = moodFor(s, dayTime), u = s.usage || {}, a = s.account || {}, h = s.health || {}, sc = s.divider || {}, fc = s.forecast || {};
    const L = live(s);
    const hist = app.historyCache(6);
    const ser = hist && hist.seats && hist.seats[s.id] ? hist.seats[s.id].series : [];
    const recent = (S().events || []).filter(e => e.seat === s.id).slice(-5).reverse();
    const meter = (key, label) => {
      const w = u[key], left = leftOf(s, key);
      return `<div class="m"><div class="mt"><b>${label}</b><span>${left == null ? "no reading yet" : Math.round(left) + "% left"}</span></div>
        ${bar(left, "bar")}<div class="sub">${w && w.resets_at ? `Resets ${dayTime(w.resets_at)} (${inWords(w.resets_at)})` : w && w.reset_since_read ? "Reset since the last reading" : "Reset time unknown"}</div></div>`;
    };
    const f5 = fc.five_hour || {};
    const paceText = s.status === "limited" ? { cls: "bad", ic: "sleep", t: "Out of plan. The desk wakes up when the window resets." }
      : f5.state === "runs_out" ? { cls: "bad", ic: "zap", t: `At ${f5.per_hour}% an hour it runs out ${dayTime(f5.out_at)}, ${until(S().now + (f5.margin_s || 0))} before the reset.` }
      : f5.state === "lasts" ? { cls: "good", ic: "check", t: `At ${f5.per_hour}% an hour it lasts until the reset.` }
      : f5.state === "paused" ? { cls: "", ic: "coffee", t: `Resting now. It was burning ${f5.per_hour}% an hour.` }
      : f5.state === "flat" ? { cls: "good", ic: "coffee", t: "Not using its plan right now." }
      : { cls: "", ic: "clock", t: "Learning the pace: a reading every few minutes." };
    return { html: `${crumbs(esc(p.name))}
      <div class="persona" style="--seat:${s.color}">
        <div class="who">${avatar("mascot-" + s.id, s.color, s.status === "offline" ? "dim" : "", "big")}
          <div><h2>${esc(p.name)}</h2><div class="role">${esc(p.role)} · ${esc(s.label)}</div>
          <div style="margin-top:8px">${pill(m.mood, m.tone)}</div></div></div>
        <div class="motto">“${esc(p.motto)}”</div>
        ${levelRow(s)}
        <div class="traits">${p.traits.map(t => pill(t)).join("")}</div>
        <div class="acct">${app.privacy() ? "Account hidden" : esc([a.name, a.email].filter(Boolean).join(" · "))}${h.tier ? " · " + esc(h.tier) : ""} · ${esc(h.detail || "")}</div>
      </div>
      ${section("Plan", `<div class="plan">${meter("five_hour", "5-hour window")}${meter("weekly", "This week")}
        <div class="pace ${paceText.cls}">${icon(paceText.ic, 18)}<span>${esc(paceText.t)}</span></div></div>`,
        s.kind === "claude" ? `<button class="btn sm ghost" data-refresh="${esc(s.id)}">${icon("refresh", 14)}Read now</button>` : "")}
      ${section("Last 6 hours", `<div class="card">${usageSpark(ser.map(r => [r[0], r[1]]), { color: s.color, now: S().now, reset: u.five_hour && u.five_hour.resets_at, forecast: fc.five_hour, label: p.name + " 5-hour window" })}
        <div class="hint" style="margin-top:6px">5-hour window used; the dashed line is the current pace.${u.fetched_at ? ` Read ${relTime(u.fetched_at)}${u.stale ? " (stale: the login refreshes on its next run)" : ""}.` : ""}</div></div>`)}
      ${section(`At the desks · ${L.length}`, L.length ? L.map(x => sessRow(s, x)).join("") : `<div class="muted">${s.status === "limited" ? "Everyone went home: the seat is out of plan." : "Nobody here right now."}</div>`)}
      ${careerHtml(s)}
      ${section("Load divider", `<div class="row between"><div class="grow"><div style="font-weight:550">${sc.enabled ? "On duty" : "On holiday (benched)"}</div>
        <div class="hint">${sc.enabled ? `Gets ${sc.weight}% of new lanes, up to ${sc.max_lanes} at once. Running ${s.lanes} now.` : "No new lanes go here."}${sc.note ? " " + esc(sc.note) : ""}</div></div>
        <label class="switch" title="On duty"><input type="checkbox" id="seatDuty" ${sc.enabled ? "checked" : ""} aria-label="On duty"><span></span></label></div>`)}
      ${recent.length ? section("Recently", recent.map(actRow).join("")) : ""}
      ${section(s.kind === "claude" ? "Work on this seat yourself" : "Use this seat", s.kind === "claude"
        ? `<div class="copy"><code>CLAUDE_CONFIG_DIR=${esc(s.config_dir)} claude</code><button class="btn sm" data-copy="CLAUDE_CONFIG_DIR=${esc(s.config_dir)} claude">${icon("copy", 14)}Copy</button></div>`
        : `<div class="copy"><code>gpt -w -C &lt;folder&gt; "task"</code></div>`)}
      <div class="row" style="margin-top:18px"><button class="btn sm" data-focus-seat="${esc(s.id)}">${icon("target", 15)}Show on the floor</button></div>`,
      bind(root) {
        bindSparks(root);
        root.querySelectorAll("[data-badge]").forEach(b => b.addEventListener("click", () => { badgeSel = badgeSel === b.dataset.badge ? null : b.dataset.badge; app.rerender(true); }));
        const duty = root.querySelector("#seatDuty");
        if (duty) duty.addEventListener("change", async () => {
          const cfg = JSON.parse(JSON.stringify(S().divider)); cfg.seats[s.id].enabled = duty.checked;
          try { await app.post("/api/divider", cfg); toast(duty.checked ? `${p.name} is back on duty.` : `${p.name} is on holiday: no new lanes go there.`, "good"); app.refresh(); }
          catch (e) { toast(e.message, "bad"); duty.checked = !duty.checked; }
        });
      } };
  }
  // Career: level, XP and achievements, earned from real work (office/career.py).
  const PERKS = [[3, "a mug"], [6, "a desk plant"], [10, "a gold cup"], [15, "a glowing desk"], [20, "a pennant"], [30, "gold trim"]];   // web/engine/sprites.js drawDeskPerks
  function levelRow(s) {
    const c = s.career;
    if (!c) return "";
    const perk = PERKS.find(([lv]) => lv > c.level);
    const pct = Math.round(c.progress * 100), r = 19, len = 2 * Math.PI * r;
    return `<div class="level">
      <svg class="ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="${r}" class="trk"/><circle cx="24" cy="24" r="${r}" class="val" stroke-dasharray="${(len * c.progress).toFixed(1)} ${len.toFixed(1)}"/><text x="24" y="28.5">${c.level}</text></svg>
      <div class="grow"><div class="lt"><b>Level ${c.level} · ${esc(c.title)}</b><span>${c.xp.toLocaleString()} XP</span></div>
        <div class="xpbar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress to level ${c.level + 1}"><i style="width:${pct}%"></i></div>
        <div class="hint">${(c.next_xp - c.xp).toLocaleString()} XP to level ${c.level + 1}${c.streak > 1 ? ` · ${icon("flame", 13)} ${c.streak}-day streak` : ""}</div>
        ${perk ? `<div class="hint perk">${icon("sparkles", 13)} Desk upgrade at level ${perk[0]}: ${perk[1]}</div>` : ""}</div></div>`;
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
    return `<div class="career" style="--seat:${esc(s.color)}">` + section(`Career · ${got.length} of ${cat.length} achievements`,
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
        root.querySelectorAll("[data-stab]").forEach(b => b.addEventListener("click", () => { sessTab.set(v.id, b.dataset.stab); app.rerender(true); }));
        root.querySelectorAll("[data-steps]").forEach(b => b.addEventListener("click", () => { const k = b.dataset.steps; if (openSteps.has(k)) openSteps.delete(k); else openSteps.add(k); app.rerender(true); }));
        const ta = root.querySelector("#chatBox"), send = root.querySelector("#chatSend");
        if (ta && send) {
          ta.value = app.draftFor(v.id);
          const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(160, ta.scrollHeight) + "px"; };
          grow();
          ta.addEventListener("input", () => { app.setDraft(v.id, ta.value); grow(); });
          ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send.click(); } });
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
              app.chatSent(v.seat, v.id, text, r);
            } catch (e) { toast("Could not send: " + e.message, "bad"); }
            send.disabled = false;
          });
          const end = root.querySelector("#chatEnd");
          if (end && app.chatJustOpened(v.id)) requestAnimationFrame(() => end.scrollIntoView({ block: "end" }));
        }
      } };
  }

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
      const key = k + ":" + steps.length;
      html += `<button class="steps-chip" data-steps="${esc(key)}">${icon(openSteps.has(key) ? "chevronDown" : "chevronRight", 14)}<span>${steps.length} step${steps.length === 1 ? "" : "s"} · ${esc(steps[steps.length - 1].text)}</span></button>`;
      if (openSteps.has(key)) html += `<div class="steps-list">${steps.map(st => `<div>${esc(st.text)}</div>`).join("")}</div>`;
      steps = [];
    };
    items.forEach((it, i) => {
      if (it.role === "step") { steps.push(it); return; }
      flush(i);
      const time = it.ts ? `<span class="meta">${clock(it.ts)}</span>` : "";
      if (it.role === "user") html += `<div class="msg user"><span class="who">Prompt</span>${priv(x, it.text)}${time}</div>`;
      else if (it.role === "assistant") html += `<div class="msg agent clip"><span class="who">${esc(who)}</span>${priv(x, it.text)}${time}</div>`;
      else if (it.role === "peer") {
        const ceo = /Claude Office/i.test(it.from_name || "");
        html += `<div class="msg ${ceo ? "ceo" : "peer"}"><span class="who">${ceo ? "You, from the office" : esc(it.from_name || "Another session")}</span>${esc(it.text)}${time}</div>`;
      } else if (it.role === "reply") html += `<div class="msg agent"><span class="who">${esc(who)} replied to you</span>${esc(it.text)}${time}</div>`;
      else if (it.role === "ceo-pending") html += `<div class="msg ceo"><span class="who">You, from the office</span>${esc(it.text)}<span class="meta">${it.status === "review" ? "Waiting for approval in its terminal" : it.status === "followup" ? "Sent as a follow-up lane" : "Sent"} · ${relTime(it.ts)}</span></div>`;
      else if (it.role === "brief") {
        const key = "brief:" + (it.ts || i), open = openSteps.has(key);
        html += `<div class="msg ceo brief${open ? " open" : ""}"><span class="who">${icon("briefcase", 13)} Brief from the office${it.title ? ` · ${esc(it.title)}` : ""}</span><div class="body">${esc(it.text)}</div><button class="more" data-steps="${esc(key)}">${open ? "Show less" : "Show the whole brief"}</button>${time}</div>`;
      }
      else if (it.role === "notice") html += `<div class="notice">${esc(it.text)}</div>`;
    });
    flush("end");
    if (!html) html = `<div class="notice">No conversation yet.</div>`;
    const hint = { direct: ["zap", "Goes straight to this lane."],
      review: ["eye", "Claude Code holds messages from the office until someone approves them in that terminal."],
      followup: ["reply", x ? "This session cannot take live messages. Sending starts a follow-up lane that resumes it." : "This session has ended. Sending starts a follow-up lane that resumes it."],
      none: ["x", "Codex sessions cannot take messages yet."] }[talk] || ["dot", ""];
    return `<div class="chat">${html}<span id="chatEnd"></span></div>
      <div class="composer"><div class="box"><textarea id="chatBox" rows="1" placeholder="${talk === "none" ? "Messaging is not available here" : `Message ${esc(who)}…`}" ${talk === "none" ? "disabled" : ""} aria-label="Message"></textarea>
        <button class="btn primary icon" id="chatSend" ${talk === "none" ? "disabled" : ""} title="Send (Enter)" aria-label="Send">${icon("send", 17)}</button></div>
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
    const units = S().units || [];
    return { html: `${crumbs("Server room")}<h2>Server room</h2><p class="lede">Background services that keep lanes running: conductors, supervisors and the lanes themselves.</p>
      ${section(`Services · ${units.length}`, units.length ? units.map(u => `<div class="need ${u.active === "failed" ? "bad" : u.active === "active" ? "good" : "info"}"><span class="ico">${icon(u.active === "active" ? "play" : u.active === "failed" ? "alert" : "stop", 16)}</span>
        <div class="grow"><div class="t" style="overflow-wrap:anywhere">${esc(u.unit)}</div><div class="d">${esc(u.description)} · ${esc(u.active)}</div></div></div>`).join("") : `<div class="muted">No watched services. Add patterns to <code>watch_units</code> in the config.</div>`)}` };
  }
  function programmes() {
    return { html: `${crumbs("Meeting room")}<h2>Programmes</h2><p class="lede">Live work grouped by programme. Names and links come from your config.</p>
      ${section("On the whiteboard", (S().programmes || []).map(progCard).join("") || `<div class="muted">No running work belongs to a programme.</div>`)}` };
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
        return `<button class="lb-row" data-seat-go="${esc(s.id)}" style="--seat:${esc(s.color)}"><span class="rk" ${i < 3 ? `style="--medal:${medal[i]}"` : ""}>${i + 1}</span>${avatar("mascot-" + s.id, s.color)}
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
  function news() {
    const ev = (S().events || []).slice().reverse().filter(e => newsFilter === "all" || e.level === newsFilter);
    return { html: `${crumbs("News")}<h2>Office news</h2><p class="lede">Arrivals, departures, reports, limits, resets, messages and your own changes.</p>
      <div class="seg-ctl" style="margin-top:16px">${[["all", "All"], ["good", "Good"], ["warn", "Heads-up"], ["bad", "Problems"]].map(([f, l]) => `<button data-news="${f}" class="${newsFilter === f ? "on" : ""}">${l}</button>`).join("")}</div>
      <div style="margin-top:12px">${ev.map(actRow).join("") || `<div class="muted">Nothing yet.</div>`}</div>`,
      bind(root) { root.querySelectorAll("[data-news]").forEach(b => b.addEventListener("click", () => { newsFilter = b.dataset.news; app.rerender(true); })); } };
  }

  // -------------------------------------------------------------------------------------------- lane
  function lane(v) {
    const d = app.detailFor("l:" + v.id);
    const l = (S().lanes || []).find(x => x.id === v.id) || (d && d.lane);
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
        <select id="lSeat" style="width:auto;height:30px;padding:0 8px"><option value="">same seat rule</option><option value="auto">Auto (divider)</option>${S().seats.map(s => `<option value="${esc(s.id)}">${esc(P(s).name)}</option>`).join("")}</select>
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
        if (stop) stop.addEventListener("click", async () => { if (!confirm("Stop this lane? Its progress notes stay, so you can resume it.")) return; try { await app.post("/api/lanes/stop", { id: v.id }); toast("Lane stopped.", "warn"); app.refresh(); } catch (e) { toast(e.message, "bad"); } });
        if (res) res.addEventListener("click", async () => { try { await app.post("/api/lanes/resume", { id: v.id, seat: root.querySelector("#lSeat").value || null }); toast("Resuming the lane.", "good"); app.refresh(); } catch (e) { toast(e.message, "bad"); } });
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
          split.querySelectorAll(".handle").forEach((h, i) => { acc += dv.seats[ids2[i]] ? dv.seats[ids2[i]].weight : 0; h.style.left = acc + "%"; h.setAttribute("aria-valuenow", String(acc)); });
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
            const mv = (ev) => move(ev.clientX);
            const up = () => { h.removeEventListener("pointermove", mv); h.removeEventListener("pointerup", up); sound.play("click"); app.rerender(true); };
            h.addEventListener("pointermove", mv); h.addEventListener("pointerup", up);
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
          const id = inp.dataset.w, val = Math.max(0, Math.min(100, +inp.value || 0));
          const others = enabledIds().filter(x => x !== id), rest = 100 - val, ot = others.reduce((a, x) => a + dv.seats[x].weight, 0);
          dv.seats[id].weight = val;
          others.forEach(x => dv.seats[x].weight = ot ? Math.round(dv.seats[x].weight / ot * rest) : Math.round(rest / others.length));
          normalise(); markDirty(); app.rerender(true);
        }));
        root.querySelectorAll("[data-cap]").forEach(inp => inp.addEventListener("change", () => { dv.seats[inp.dataset.cap].max_lanes = Math.max(0, Math.min(16, +inp.value || 0)); markDirty(); }));
        root.querySelectorAll("[data-note]").forEach(inp => inp.addEventListener("input", () => { dv.seats[inp.dataset.note].note = inp.value; markDirty(); }));
        for (const [id, key, lo, hi] of [["dv5", "five_hour_guard", 10, 100], ["dvW", "weekly_guard", 10, 100], ["dvG", "global_max_lanes", 0, 32]]) {
          const el = root.querySelector("#" + id); el.addEventListener("change", () => { dv[key] = Math.max(lo, Math.min(hi, +el.value || 0)); markDirty(); });
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
            toast(r.demo ? "Demo office: nothing saved." : `Saved. The next lane goes to ${r.next_pick && r.next_pick.seat ? nameOf(r.next_pick.seat) : "nobody"}.`, "good"); app.refresh(); }
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
          hireDraft.title = t.title; hireDraft.brief = t.brief; store.set("hireDraft", hireDraft); app.rerender(true);
          const ti = document.getElementById("hTitle"); if (ti) { ti.focus(); ti.setSelectionRange(ti.value.length, ti.value.length); }
        }));
        q("hClear").addEventListener("click", () => { hireDraft = { title: "", brief: "", workdir: "", seat: "auto", model: "", permission_mode: "", allow_messages: true }; store.set("hireDraft", hireDraft); app.rerender(true); });
        q("hGo").addEventListener("click", async () => {
          save();
          if (!hireDraft.title.trim() || !hireDraft.brief.trim()) { toast("Give the lane a title and a brief.", "warn"); return; }
          if (hireDraft.permission_mode === "bypassPermissions" && !confirm("Full trust lets the lane run any command without asking. Start it?")) return;
          q("hGo").disabled = true;
          try {
            const r = await app.post("/api/lanes", hireDraft);
            if (r.demo) toast("Demo office: no lane was started.");
            else { sound.play("hire"); toast(`Hired “${r.lane.title}”. Watch the elevator.`, "good"); hireDraft = { title: "", brief: "", workdir: hireDraft.workdir, seat: "auto", model: "", permission_mode: "", allow_messages: true }; store.set("hireDraft", hireDraft); }
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
          <label class="f full">Motto<input type="text" data-motto="${esc(id)}" maxlength="90" placeholder="${esc(per.motto)}" value="${esc(st.motto || "")}"></label></div>`; }).join(""))}
      ${section("Jarvis voice", `${row("Announce out loud", sd.voice_available ? "Speaks short alerts through jarvis-say. Off by default." : "jarvis-say was not found on this machine.", `<label class="switch"><input type="checkbox" id="setVoice" ${voice.enabled ? "checked" : ""} ${sd.voice_available ? "" : "disabled"} aria-label="Voice"><span></span></label>`)}
        <div class="row wrap" style="gap:6px;margin:10px 0">${VOICE.map(([k, l]) => `<label class="pill" style="cursor:pointer"><input type="checkbox" data-vev="${k}" ${(voice.events || []).includes(k) ? "checked" : ""}> ${l}</label>`).join("")}</div>
        <div class="grid2"><label class="f">Quiet from (hour)<input type="number" min="0" max="23" id="setQ1" value="${(voice.quiet_hours || [23, 8])[0]}"></label><label class="f">Until (hour)<input type="number" min="0" max="23" id="setQ2" value="${(voice.quiet_hours || [23, 8])[1]}"></label></div>`)}
      <div class="row" style="margin-top:8px"><button class="btn primary" id="setSave">Save office settings</button></div>`}
      ${section("Keyboard", `<dl class="facts">${[["Ctrl/⌘ K", "Search and commands"], ["Esc", "Back to the briefing"], ["F  T  B  S", "Floor, Timeline, Team, Today"], ["H", "Hire a lane"], ["D", "Load divider"], ["P", "Share-safe"], ["+  −  0", "Zoom in, out, fit"], ["Arrows", "Pan when zoomed in"]].map(([k, v]) => `<dt><kbd>${k}</kbd></dt><dd>${v}</dd>`).join("")}</dl>`)}
      ${section("About", `<div class="hint">Claude Office ${esc(S().office.version || "")} · up ${S().office.started_at ? ago(S().office.started_at).replace(" ago", "") : "–"} · ${esc(app.liveMode())}</div>`)}`,
      bind(root) {
        root.querySelectorAll("[data-theme-set]").forEach(b => b.addEventListener("click", () => { app.setPref("theme", b.dataset.themeSet); app.rerender(true); }));
        root.querySelectorAll("[data-motion-set]").forEach(b => b.addEventListener("click", () => { app.setPref("motion", b.dataset.motionSet); app.rerender(true); }));
        root.querySelectorAll("[data-pref]").forEach(c => c.addEventListener("change", () => app.setPref(c.dataset.pref, c.checked)));
        const ts = root.querySelector("[data-test-sound]"); if (ts) ts.addEventListener("click", () => { app.setPref("sound", true); sound.play("report"); app.rerender(true); });
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
          try { const r = await app.post("/api/settings", body); settingsData = r.demo ? settingsData : null; toast(r.demo ? "Demo office: nothing saved." : "Saved. The office redecorates on the next refresh.", "good"); app.refresh(); }
          catch (e) { toast("Could not save: " + e.message, "bad"); }
        });
      } };
  }

  return { ceo, seat, session, services, programmes, lounge, news, trophies, lane, divider, hire, settings, laneListHtml, persona: P, nameOf, humanise,
    isEditing: (k) => (k === "divider" && dvDirty) || k === "hire" || k === "settings" };
}

// The side panel: one renderer per view. Each returns { html, bind(root) }.
import { esc, fmtTok, ago, until, clock, dur, pct, live, store, toast, debounce, portraitTag, hydratePortraits,
  STATE_LABEL, SEAT_LABEL, KIND_ICON, LEVEL_ICON } from "./util.js";
import { ring, usageSpark, bindSparks } from "./charts.js";
import { sound } from "./sound.js";

const TEMPLATES = [
  { name: "Fix a failing test", title: "Fix failing test: ", brief: "Goal: make the failing test pass without weakening it.\nWhere: <test file / CI job link>\nContext: <what changed recently>\nDone when: the test passes locally and the full suite is green.\nVerify: run the suite and paste the summary in the report." },
  { name: "Investigate a bug", title: "Investigate: ", brief: "Symptom: <what users see>\nWhere it shows: <page / endpoint / log>\nFind the root cause and propose the smallest safe fix. Prove the cause with evidence (logs, a failing test, a query).\nDone when: the report names the cause, the evidence, and the fix (or a PR if the fix is small and safe)." },
  { name: "Review a PR", title: "Review PR #", brief: "Review PR #<n> in <repo> for correctness, missed edge cases and risky changes. Run its tests.\nDo not merge. Report findings ranked by severity with file:line and a concrete failure scenario." },
  { name: "Write docs", title: "Docs: ", brief: "Write or update the docs for <feature>.\nAudience: <who>\nCover: what it does, how to use it, the gotchas.\nDone when: the doc is in the repo and every command in it was run once to check it works." },
  { name: "Research", title: "Research: ", brief: "Question: <the decision this informs>\nLook at: <sources / code / data>\nReport: a direct answer first, then the evidence, then open questions. Read-only: change nothing." },
  { name: "Refactor", title: "Refactor: ", brief: "Refactor <module> to <goal> with no behaviour change.\nKeep every existing test green and add tests where coverage is thin.\nDone when: a PR is open with a summary of what moved and why." },
];

export function makePanels(app) {
  let dv = null, dvDirty = false, dvPreview = null;
  let hireDraft = store.get("hireDraft", { title: "", brief: "", workdir: "", seat: "auto", model: "", permission_mode: "" });
  let settingsData = null, settingsLoading = false;
  let newsFilter = "all";

  const S = () => app.snap();
  const seatById = (id) => S().seats.find(s => s.id === id);
  const crumbs = (...parts) => `<nav class="crumbs"><button data-go="ceo">Office</button>${parts.map(x => `<span>›</span>${x}`).join("")}</nav>`;
  const priv = (sess, text) => app.privacy() && sess && sess.kind === "desk" ? `<span class="private">${esc(text || "")}</span>` : esc(text || "");
  const hp = (p) => p == null ? 0 : Math.max(0, 100 - p);
  const meterRow = (label, p, color, extra = "") => `<div class="hpr" style="--seat:${color}"><span>${label}</span><span class="hpbar ${p != null && p >= 90 ? "low" : p != null && p >= 75 ? "mid" : ""}"><i style="width:${hp(p)}%"></i></span><b>${p == null ? "–" : Math.round(hp(p)) + "%"}</b></div>${extra}`;
  const alertRow = (a, cls = "") => `<div class="alert ${a.level} ${cls}" ${a.seat ? `data-seat="${esc(a.seat)}"` : ""} ${a.session ? `data-id="${esc(a.session)}"` : ""} ${a.lane ? `data-lane="${esc(a.lane)}"` : ""}><span class="ico">${LEVEL_ICON[a.level] || "i"}</span><span>${esc(a.text)}</span>${a.resets_at ? `<span class="when">reset ${until(a.resets_at)}</span>` : a.ts ? `<span class="when">${clock(a.ts)}</span>` : ""}</div>`;
  const sessRow = (s, x) => `<div class="sess" data-seat="${esc(s.id)}" data-id="${esc(x.id)}">${portraitTag(x.id, s.color, x.kind === "desk" ? "headset" : "")}
    <span class="nm"><span class="st-dot ${x.state}"></span>${esc(x.name)}</span><span class="chip">${x.kind === "lane" ? "lane" : "desk"}</span>
    <span class="act">${KIND_ICON[x.activity_kind] || ""} ${priv(x, x.title && x.kind === "desk" ? x.title : x.activity)}</span></div>`;
  const paceLine = (fc, used) => {
    if (used == null || used >= 100 || !fc) return "";
    if (fc.state === "learning") return `<div class="pace muted">Learning the pace…</div>`;
    if (fc.state === "flat") return `<div class="pace good">Not burning right now</div>`;
    if (fc.state === "paused") return `<div class="pace muted">Resting now (was burning ${fc.per_hour}%/h)</div>`;
    if (fc.state === "runs_out") return `<div class="pace bad">${fc.per_hour}%/h: out in ${until(fc.out_at)}${fc.margin_s ? `, ${until(S().now + fc.margin_s)} before reset` : ""}</div>`;
    return `<div class="pace good">${fc.per_hour}%/h: lasts to the reset</div>`;
  };

  // ------------------------------------------------------------------------------------------- CEO
  function ceo() {
    const snap = S(), t = snap.totals, ceoName = (snap.office.ceo || {}).name || "CEO";
    const h = new Date().getHours();
    const greet = h < 5 ? "Burning the midnight oil" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    const np = snap.next_pick, att = snap.attention || [];
    const st = app.statsCache();
    const npSeat = np.seat && seatById(np.seat);
    return { html: `
      <div class="hero"><i data-portrait="ceo-${esc(ceoName)}|#22304f|crown"></i><div>
        <h2>${greet}, ${esc(ceoName)}</h2>
        <div class="sub">${t.working} of ${t.sessions} sessions working on ${t.seats} seats${snap.office.version ? ` · v${esc(snap.office.version)}` : ""}</div></div></div>
      ${snap.office.config_error ? alertRow({ level: "bad", text: "Config problem: " + snap.office.config_error }) : ""}
      <div class="tiles" style="margin-top:12px">
        <div class="tile"><div class="v">${t.working}<small>/${t.sessions}</small></div><div class="k">working now</div></div>
        <div class="tile"><div class="v">${t.lanes}</div><div class="k">headless lanes</div></div>
        <div class="tile"><div class="v">${fmtTok(t.tokens_1h)}</div><div class="k">fresh tokens / hour</div></div>
        <div class="tile"><div class="v">${t.five_hour_left_seats}</div><div class="k">seats of 5-hour plan left</div></div>
        <div class="tile"><div class="v">${t.weekly_left_seats}</div><div class="k">seats of weekly plan left</div></div>
        <div class="tile"><div class="v">${st ? st.office.reports : "–"}</div><div class="k">reports filed today</div></div>
      </div>
      <h4>Needs you ${att.length ? `· ${att.length}` : ""}</h4>
      ${att.length ? att.map(a => alertRow(a, a.seat || a.lane ? "click" : "")).join("") : `<div class="alert good"><span class="ico">✓</span>All clear. Nothing needs you right now.</div>`}
      <div class="pick ${np.seat ? "" : "none"}"><b>${np.seat ? `Next lane goes to ${esc(npSeat ? npSeat.label : np.seat)}` : "No seat can take a lane right now"}</b>
        <div class="muted" style="font-size:12.5px;margin-top:3px">${esc(np.why)}</div>
        <div class="row" style="margin-top:10px"><button class="btn small" data-go="divider">Change the split</button><button class="btn small primary" data-go="hire">＋ Hire a lane</button></div></div>
      <h4>Capacity <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">plan left</span></h4>
      ${snap.seats.map(s => {
        const u = s.usage || {}, p5 = pct(u, "five_hour"), pw = pct(u, "weekly");
        const fc = (s.forecast || {}).five_hour;
        const warn = fc && fc.state === "runs_out" && p5 != null && p5 < 100 ? ` <b class="warn-t">· out ${until(fc.out_at)}</b>` : "";
        return `<div class="seatrow" style="--seat:${s.color}" data-seat="${esc(s.id)}">
          ${portraitTag("mascot-" + s.id, s.color, s.status === "offline" ? "dim" : "")}
          <span class="nm">${esc(s.nickname || s.label)}<small>${esc(SEAT_LABEL[s.status] || s.status)} · ${live(s).length} live</small></span>
          <span class="u">${meterRow("5h", p5, s.color)}<span>${u.five_hour && u.five_hour.resets_at ? "reset " + until(u.five_hour.resets_at) : "&nbsp;"}${warn}</span></span>
          <span class="u">${meterRow("wk", pw, s.color)}<span>${u.weekly && u.weekly.resets_at ? "reset " + until(u.weekly.resets_at) : "&nbsp;"}</span></span>
        </div>`;
      }).join("")}
      ${(snap.programmes || []).length ? `<h4>Programmes</h4>${snap.programmes.map(progBlock).join("")}` : ""}
      ${snap.lanes.length ? `<h4>Office lanes</h4>${snap.lanes.slice(0, 5).map(laneRow).join("")}` : ""}
      <h4>Latest news</h4>
      ${(snap.events || []).slice(-6).reverse().map(e => alertRow({ level: e.level, text: e.text, ts: e.ts, seat: e.seat }, e.seat ? "click" : "")).join("") || `<div class="muted">No news yet.</div>`}
      <div style="margin-top:8px"><button class="btn small" data-go="news">All news</button></div>` };
  }
  function progBlock(p) {
    const done = p.sessions.filter(s => s.report_status).length;
    return `<div class="alert"><span class="ico">◆</span><div style="min-width:0;flex:1">
      <div class="row between"><b>${esc(p.name)}</b>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="chip info">Mission Control ↗</a>` : ""}</div>
      <div class="muted" style="font-size:12.5px;margin-top:2px">${p.sessions.length} at work${done ? ` · ${done} reported` : ""}</div>
      <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px">${p.sessions.map(s => `<span class="chip"><span class="st-dot ${s.state}"></span>${esc(s.name.replace(/^wt-/, ""))} · ${esc(s.seat)}</span>`).join("")}</div>
    </div></div>`;
  }
  function laneRow(l) {
    const lvl = { done: "good", running: "info", blocked: "warn", failed: "bad", waiting: "warn", finished: "good" }[l.status] || "info";
    return `<div class="alert click ${lvl}" data-lane="${esc(l.id)}"><span class="ico">${{ done: "✓", running: "▶", blocked: "▲", failed: "!", waiting: "⏳" }[l.status] || "•"}</span><span style="min-width:0"><b>${esc(l.title)}</b><br><span class="muted" style="font-size:12px">${esc(l.status)}${l.seat ? " on " + esc(l.seat) : ""} · ${ago(l.created_at)}${l.report_status ? " · " + esc(l.report_status) : ""}</span></span></div>`;
  }

  // ------------------------------------------------------------------------------------------ seat
  function seat(v) {
    const s = seatById(v.seat);
    if (!s) return { html: crumbs("gone") + `<div class="muted">That seat is gone.</div>` };
    const u = s.usage || {}, a = s.account || {}, h = s.health || {}, sc = s.divider || {};
    const L = live(s), fc = s.forecast || {};
    const hist = app.historyCache(6);
    const ser = hist && hist.seats && hist.seats[s.id] ? hist.seats[s.id].series : [];
    const recent = (S().events || []).filter(e => e.seat === s.id).slice(-6).reverse();
    const gauge = (k, name) => {
      const w = u[k], p = w && w.pct != null ? w.pct : null;
      return `<div class="gauge">${ring(p, s.color, name)}<div><b>${name}</b>
        <div class="lbl">${p == null ? "no reading yet" : Math.round(p) + "% used"}</div>
        <div class="lbl">${w && w.resets_at ? "resets in " + until(w.resets_at) + " · " + clock(w.resets_at) : w && w.reset_since_read ? "reset since the last read" : "reset time unknown"}</div>
        ${paceLine(fc[k], p)}</div></div>`;
    };
    return { html: `${crumbs(esc(s.label))}
      <div class="hero" style="--seat:${s.color}">${portraitTag("mascot-" + s.id, s.color, s.status === "offline" ? "dim" : "")}<div>
        <h2>${esc(s.nickname || s.label)} <span class="chip"><span class="st-dot ${s.status}"></span>${esc(SEAT_LABEL[s.status] || s.status)}</span></h2>
        <div class="sub">${esc(s.label)}${a.name ? " · " + (app.privacy() ? `<span class="private">${esc(a.name)}</span>` : esc(a.name)) : ""}${a.email ? " · " + (app.privacy() ? `<span class="private">${esc(a.email)}</span>` : esc(a.email)) : ""}</div>
        <div class="sub">${esc([h.tier, h.subscription, a.role].filter(Boolean).join(" · "))} · ${esc(h.detail || "")}</div></div></div>
      <div class="gauges">${gauge("five_hour", "5-hour window")}${gauge("weekly", "Weekly")}</div>
      ${(u.scoped || []).length ? `<div class="hint" style="margin-top:6px">${u.scoped.map(x => `${esc(x.label)} ${Math.round(x.pct)}%`).join(" · ")}</div>` : ""}
      <h4>Plan used, last 6 hours</h4>
      <div class="spark-wrap"><div class="cap"><span>5-hour window</span><span>${fc.five_hour && fc.five_hour.per_hour ? fc.five_hour.per_hour + "%/h" : ""}</span></div>
        ${usageSpark(ser.map(r => [r[0], r[1]]), { color: s.color, now: S().now, reset: u.five_hour && u.five_hour.resets_at, forecast: fc.five_hour, label: s.label + " 5-hour" })}</div>
      <div class="spark-wrap" style="margin-top:8px"><div class="cap"><span>Weekly allowance</span><span>${fc.weekly && fc.weekly.per_hour ? fc.weekly.per_hour + "%/h" : ""}</span></div>
        ${usageSpark(ser.map(r => [r[0], r[2]]), { color: s.color, now: S().now, reset: null, forecast: null, label: s.label + " weekly" })}</div>
      <div class="hint" style="margin-top:6px">${u.fetched_at ? `Read ${ago(u.fetched_at)}${u.stale ? " · stale: the login refreshes when this seat next runs" : ""}` : "No usage read yet"}${u.error ? ` · last try: ${esc(u.error)}` : ""}</div>
      <div class="row wrap" style="margin-top:10px">
        <button class="btn small" data-focus-seat="${esc(s.id)}">◎ Show on the floor</button>
        ${s.kind === "claude" ? `<button class="btn small" data-refresh="${esc(s.id)}">↻ Read plan now</button>` : ""}
      </div>
      ${s.resting_until ? alertRow({ level: "warn", text: `Resting until ${clock(s.resting_until)} after an office lane hit its limit here.` }) : ""}
      <h4>On the divider</h4>
      <div class="row wrap" style="gap:10px;font-size:13px">
        <label class="switch" title="On duty"><input type="checkbox" id="seatDuty" ${sc.enabled ? "checked" : ""} aria-label="On duty"><span></span></label>
        <span>${sc.enabled ? "On duty" : "Benched"}</span>
        <span class="chip">share ${sc.weight}</span><span class="chip">cap ${sc.max_lanes} lanes</span><span class="chip">runs ${s.lanes}</span>
        <button class="btn small" data-go="divider">Open divider</button>
      </div>
      ${sc.note ? `<div class="hint" style="margin-top:6px">${esc(sc.note)}</div>` : ""}
      <h4>At the desks · ${L.length}</h4>
      ${L.length ? L.map(x => sessRow(s, x)).join("") : `<div class="muted">Nobody here right now${s.status === "limited" ? ": the seat is out of plan" : ""}.</div>`}
      <h4>${s.kind === "claude" ? "Open a terminal on this seat" : "Use this seat"}</h4>
      ${s.kind === "claude" ? `<div class="copy"><code>CLAUDE_CONFIG_DIR=${esc(s.config_dir)} claude</code><button class="btn small" data-copy="CLAUDE_CONFIG_DIR=${esc(s.config_dir)} claude">Copy</button></div>` : `<div class="copy"><code>gpt -w -C &lt;dir&gt; "task"</code></div>`}
      ${recent.length ? `<h4>Recent</h4>${recent.map(e => alertRow({ level: e.level, text: e.text, ts: e.ts })).join("")}` : ""}`,
      bind(root) {
        bindSparks(root);
        const duty = root.querySelector("#seatDuty");
        if (duty) duty.addEventListener("change", async () => {
          const cfg = JSON.parse(JSON.stringify(S().divider)); cfg.seats[s.id].enabled = duty.checked;
          try { await app.post("/api/divider", cfg); toast(duty.checked ? `${s.label} is back on duty.` : `${s.label} benched: no new lanes go there.`, "good"); app.refresh(); }
          catch (e) { toast(e.message, "bad"); duty.checked = !duty.checked; }
        });
      } };
  }

  // --------------------------------------------------------------------------------------- session
  function session(v) {
    const s = seatById(v.seat), x = s && s.sessions.find(z => z.id === v.id);
    if (!x) return { html: crumbs(s ? `<button data-seat-go="${esc(s.id)}">${esc(s.label)}</button>` : "") + `<div class="alert info" style="margin-top:12px"><span class="ico">👋</span>This session has left the office.</div>` };
    const d = app.detailFor("s:" + s.id + "/" + x.id);
    const t1 = x.tokens_1h || {}, t5 = x.tokens_5h || {};
    const lane = (S().lanes || []).find(l => x.cwd && l.workdir === x.cwd && l.status === "running" && l.seat === s.id);
    return { html: `${crumbs(`<button data-seat-go="${esc(s.id)}">${esc(s.label)}</button>`, esc(x.name))}
      <div class="hero" style="--seat:${s.color}">${portraitTag(x.id, s.color, x.kind === "desk" ? "headset" : "")}<div style="min-width:0">
        <h2 style="overflow:hidden;text-overflow:ellipsis">${esc(x.name)}</h2>
        <div class="row wrap" style="gap:6px;margin-top:6px">
          <span class="chip"><span class="st-dot ${x.state}"></span>${esc(STATE_LABEL[x.state] || x.state)}</span>
          <span class="chip">${x.kind === "lane" ? "Headless lane" : "Interactive 🎧"}</span>
          ${x.model ? `<span class="chip">${esc(x.model.replace(/^claude-/, ""))}</span>` : ""}
          ${x.programme ? `<span class="chip info">${esc(x.programme.name)}</span>` : ""}
          ${x.report_status ? `<span class="chip ${/BLOCKED/i.test(x.report_status) ? "warn" : "good"}">Reported</span>` : ""}
        </div></div></div>
      <h4>Right now</h4>
      <div class="now ${x.state}"><span class="caret"></span><span style="min-width:0;overflow-wrap:anywhere">${KIND_ICON[x.activity_kind] || ""} ${priv(x, x.activity)}</span></div>
      ${x.quiet_s != null ? `<div class="hint" style="margin-top:4px">last sign of life ${dur(x.quiet_s)} ago</div>` : ""}
      ${x.limit_text ? alertRow({ level: "bad", text: x.limit_text }) : ""}
      ${x.title || x.task ? `<h4>Working on</h4>${x.title ? `<div style="font-weight:650;margin-bottom:6px">${priv(x, x.title)}</div>` : ""}${x.task ? `<div class="quote">${priv(x, x.task)}</div>` : ""}` : ""}
      ${x.last_text ? `<h4>Last said</h4><div class="quote">${priv(x, x.last_text)}</div>` : ""}
      ${(x.recent || []).length ? `<h4>Last steps</h4><ul class="steps">${x.recent.slice().reverse().map(r => `<li><span class="k">${KIND_ICON[r.kind] || "•"}</span><span>${priv(x, r.text)}</span><span class="t">${r.ts ? clock(r.ts) : ""}</span></li>`).join("")}</ul>` : ""}
      ${x.state_file ? `<h4>Progress notes · STATE</h4>${d && d.state_tail ? `<pre class="pre">${esc(d.state_tail)}</pre>` : `<div class="hint">${d ? "Empty so far." : "Loading…"}</div>`}` : ""}
      ${x.report_status ? `<h4>Report</h4>${d && d.report ? `<pre class="pre">${esc(d.report)}</pre>` : `<div class="quote">${esc(x.report_status)}</div>`}` : ""}
      <h4>Burn</h4>
      <div class="tiles">
        <div class="tile"><div class="v">${fmtTok(t1.fresh)}</div><div class="k">fresh tokens, 1 h</div></div>
        <div class="tile"><div class="v">${fmtTok(t5.fresh)}</div><div class="k">fresh tokens, 5 h</div></div>
        <div class="tile"><div class="v">${x.tool_calls ?? "–"}</div><div class="k">tool calls</div></div>
      </div>
      <h4>Facts</h4>
      <dl class="kv">
        <dt>Seat</dt><dd>${esc(s.label)}</dd>
        <dt>Started</dt><dd>${x.started_at ? ago(x.started_at) + " (" + clock(x.started_at) + ")" : "–"}</dd>
        <dt>Cache reads, 1 h</dt><dd>${fmtTok(t1.cached)} · ${t1.turns ?? 0} turns</dd>
        ${x.tokens_total != null ? `<dt>Fresh, all time</dt><dd>${fmtTok(x.tokens_total)}</dd>` : ""}
        ${x.unit ? `<dt>Runs in</dt><dd><code>${esc(x.unit)}</code></dd>` : x.terminal ? `<dt>Runs in</dt><dd>a terminal</dd>` : ""}
        <dt>Folder</dt><dd><code>${esc(x.cwd || "–")}</code></dd>
        ${x.pid ? `<dt>Process</dt><dd>${x.pid}${x.cpu_s != null ? ` · ${dur(x.cpu_s)} CPU` : ""}</dd>` : ""}
        ${x.state_file ? `<dt>STATE</dt><dd><code>${esc(x.state_file)}</code></dd>` : ""}
      </dl>
      ${x.resume_cmd ? `<h4>Resume it later</h4><div class="copy"><code>${esc(x.resume_cmd)}</code><button class="btn small" data-copy="${esc(x.resume_cmd)}">Copy</button></div>` : ""}
      <div class="row wrap" style="margin-top:12px"><button class="btn small" data-focus-session="${esc(x.id)}">◎ Show on the floor</button>${lane ? `<button class="btn small" data-lane="${esc(lane.id)}">Open office lane</button>` : ""}</div>` };
  }

  // ----------------------------------------------------------------------------------- rooms & news
  function services() {
    const units = S().units || [];
    return { html: `${crumbs("Server room")}<h2>🖥 Server room</h2><div class="sub">Background services that keep the lanes going: conductors, supervisors and the lanes themselves.</div>
      <h4>Services · ${units.length}</h4>
      ${units.length ? units.map(u => `<div class="alert ${u.active === "failed" ? "bad" : u.active === "active" ? "good" : "info"}"><span class="ico">${u.active === "active" ? "▶" : u.active === "failed" ? "!" : "■"}</span><span style="min-width:0"><b style="overflow-wrap:anywhere">${esc(u.unit)}</b><br><span class="muted" style="font-size:12.5px">${esc(u.description)}</span></span><span class="when">${esc(u.active)}</span></div>`).join("")
        : `<div class="muted">No watched services. Add patterns to <code>watch_units</code> in the config.</div>`}` };
  }
  function programmes() {
    return { html: `${crumbs("Meeting room")}<h2>◆ Programmes</h2><div class="sub">Live work grouped by programme. Names and Mission Control links come from <code>~/.config/claude-office/config.json</code>.</div>
      <h4>On the whiteboard</h4>${(S().programmes || []).map(progBlock).join("") || `<div class="muted">No running work belongs to a programme.</div>`}` };
  }
  function lounge() {
    const resting = S().seats.filter(s => ["limited", "benched", "offline"].includes(s.status) || !live(s).length);
    return { html: `${crumbs("Lounge")}<h2>☕ Lounge</h2><div class="sub">Seats with nobody at their desks take a break here. A seat that is out of plan sleeps on the couch until it resets; a benched seat wears shades.</div>
      <h4>On a break · ${resting.length}</h4>
      ${resting.map(s => {
        const u = s.usage || {};
        const why = s.status === "limited" ? `out of plan${u.five_hour && u.five_hour.resets_at ? `, back in ${until(u.five_hour.resets_at)}` : ""}` :
          s.status === "benched" ? "benched on the divider 😎" : s.status === "offline" ? "logged out: needs /login" : "free for work";
        return `<div class="seatrow" style="--seat:${s.color}" data-seat="${esc(s.id)}">${portraitTag("mascot-" + s.id, s.color, s.status === "offline" ? "dim" : "")}<span class="nm">${esc(s.nickname || s.label)}<small>${esc(why)}</small></span><span></span><span></span></div>`;
      }).join("") || `<div class="muted">Everyone is at their desk.</div>`}` };
  }
  function news() {
    const ev = (S().events || []).slice().reverse().filter(e => newsFilter === "all" || e.level === newsFilter);
    return { html: `${crumbs("News")}<h2>📰 Office news</h2><div class="sub">Everything that happened: arrivals, departures, reports, limits, resets and your own changes.</div>
      <div class="seg-ctl" style="margin-top:12px">${["all", "good", "warn", "bad", "info"].map(f => `<button data-news="${f}" class="${newsFilter === f ? "on" : ""}">${f}</button>`).join("")}</div>
      <div style="margin-top:12px">${ev.map(e => alertRow({ level: e.level, text: e.text, ts: e.ts, seat: e.seat }, e.seat ? "click" : "")).join("") || `<div class="muted">Nothing yet.</div>`}</div>`,
      bind(root) { root.querySelectorAll("[data-news]").forEach(b => b.addEventListener("click", () => { newsFilter = b.dataset.news; app.rerender(true); })); } };
  }

  // ------------------------------------------------------------------------------------------ lane
  function lane(v) {
    const d = app.detailFor("l:" + v.id);
    const l = (S().lanes || []).find(x => x.id === v.id) || (d && d.lane);
    if (!l) return { html: crumbs("Lane") + `<div class="muted">Loading…</div>` };
    const runs = (d && d.lane.runs) || l.runs || [];
    const running = l.unit_active || ["running", "starting", "waiting"].includes(l.status);
    return { html: `${crumbs(`<button data-go="hire">Hiring desk</button>`, esc(l.title))}
      <h2>${esc(l.title)}</h2>
      <div class="row wrap" style="gap:6px;margin-top:6px"><span class="chip">${esc(l.status)}</span>${l.seat ? `<span class="chip">on ${esc(l.seat)}</span>` : ""}<span class="chip">${esc(l.model)}</span><span class="chip">${esc(l.seat_pref === "auto" ? "divider picks" : "pinned to " + l.seat_pref)}</span></div>
      ${l.waiting_reason ? alertRow({ level: "warn", text: l.waiting_reason }) : ""}
      <div class="row wrap" style="gap:8px;margin-top:12px">
        ${running ? `<button class="btn danger" id="lStop">■ Stop</button>` : `<button class="btn" id="lResume">▶ Resume</button>`}
        <select id="lSeat" style="width:auto"><option value="">same seat rule</option><option value="auto">Auto (divider)</option>${S().seats.map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join("")}</select>
        <button class="btn" id="lClone" title="Copy this brief into the hiring desk">⧉ Re-hire</button>
      </div>
      ${l.report_status ? `<h4>Report</h4><pre class="pre">${esc((d && d.report) || l.report_status)}</pre>` : ""}
      <h4>Progress notes</h4><pre class="pre">${esc((d && d.state) || l.state_tail || "Nothing yet.")}</pre>
      <h4>Runs</h4>${runs.length ? `<ul class="steps">${runs.slice().reverse().map(r => `<li><span class="k">${r.ended_by === "limit" ? "💤" : r.rc === 0 ? "✓" : r.rc == null ? "▶" : "!"}</span><span>${esc(r.seat)}${r.rc != null ? ` · exit ${r.rc}` : " · running"}${r.ended_by ? " · " + esc(r.ended_by) : ""}</span><span class="t">${clock(r.started_at)}</span></li>`).join("")}</ul>` : `<div class="muted">Not started yet.</div>`}
      <h4>Brief</h4><div class="quote">${esc(d ? d.brief : "")}</div>
      <h4>Log tail</h4><pre class="pre">${esc((d && d.log) || "")}</pre>
      <dl class="kv" style="margin-top:12px"><dt>Lane id</dt><dd><code>${esc(l.id)}</code></dd><dt>Unit</dt><dd><code>${esc(l.unit)}</code></dd><dt>Folder</dt><dd><code>${esc(l.workdir)}</code></dd></dl>`,
      bind(root) {
        const stop = root.querySelector("#lStop"), res = root.querySelector("#lResume"), clone = root.querySelector("#lClone");
        if (stop) stop.addEventListener("click", async () => { if (!confirm("Stop this lane? Its progress notes stay, so you can resume it.")) return; try { await app.post("/api/lanes/stop", { id: v.id }); toast("Lane stopped.", "warn"); app.refresh(); } catch (e) { toast(e.message, "bad"); } });
        if (res) res.addEventListener("click", async () => { try { await app.post("/api/lanes/resume", { id: v.id, seat: root.querySelector("#lSeat").value || null }); toast("Resuming the lane.", "good"); app.refresh(); } catch (e) { toast(e.message, "bad"); } });
        if (clone) clone.addEventListener("click", () => {
          hireDraft = { title: l.title, brief: d ? d.brief : "", workdir: l.workdir, seat: l.seat_pref || "auto", model: l.model, permission_mode: l.permission_mode };
          store.set("hireDraft", hireDraft); app.go({ kind: "hire" }); toast("Brief copied to the hiring desk.");
        });
      } };
  }

  // --------------------------------------------------------------------------------------- divider
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
    return `<div class="pick ${who ? "" : "none"}"><b>${who ? "Next lane → " + esc((seatById(who) || {}).label || who) : "No seat can take a lane"}</b>${dvPreview ? ` <span class="chip">preview</span>` : ""}
      <div class="muted" style="font-size:12.5px;margin:3px 0 6px">${esc(np.why)}</div>
      ${(np.ranking || []).map(r => `<div class="rk"><span>${r.eligible ? "✓" : "–"}</span><span>${esc((seatById(r.seat) || {}).label || r.seat)}</span><span class="muted">${r.eligible ? `target ${Math.round((r.target ?? r.share) * 100)}% · runs ${r.lanes} · ${Math.round(r.headroom * 100)}% left` : esc(r.blockers.join(", "))}</span></div>`).join("")}</div>`;
  }
  function paintPick() { const el = document.getElementById("dvPick"); if (el) el.innerHTML = pickHtml(); }
  function divider() {
    if (!dv || !dvDirty) { dv = JSON.parse(JSON.stringify(S().divider)); normalise(); dvDirty = false; }
    const ids = enabledIds();
    return { html: `${crumbs("Load divider")}
      <h2>⚖ Load divider</h2>
      <div class="sub">How new work is split across seats. Drag the white handles, bench a seat, cap its lanes. Office lanes and anything that calls <code>pick-seat</code> follow it.</div>
      <h4>Split</h4>
      <div class="split" id="split">${S().seats.map(s => { const c = dv.seats[s.id], on = c.enabled && c.weight > 0;
        return `<div class="seg ${on ? "" : "off"} ${c.weight < 14 ? "narrow" : ""}" title="${esc(s.nickname || s.label)} ${c.weight}%" data-seg="${esc(s.id)}" style="--seat:${s.color};flex:0 0 calc(${on ? c.weight : 0}% - 2px)">${portraitTag("mascot-" + s.id, s.color)}<span>${esc(s.nickname || s.label)}<small>${c.weight}%</small></span></div>`; }).join("")}
        ${ids.slice(0, -1).map((id, i) => `<div class="handle" tabindex="0" role="slider" aria-label="Border after ${esc(seatById(id).label)}" aria-valuemin="0" aria-valuemax="100" data-h="${i}"></div>`).join("")}</div>
      <div class="row between wrap" style="margin-top:10px">
        <div class="seg-ctl" role="group" aria-label="Mode"><button data-mode="fixed" class="${dv.mode === "fixed" ? "on" : ""}">Fixed split</button><button data-mode="headroom" class="${dv.mode === "headroom" ? "on" : ""}">Headroom-aware</button></div>
        <button class="btn small" id="dvSuggest" title="Shares proportional to the plan each on-duty seat has left">✦ Suggest from plan left</button>
      </div>
      <div class="hint" style="margin-top:6px">${dv.mode === "headroom" ? "Headroom-aware: a seat's share shrinks as its plan runs out, so a nearly spent seat gets less." : "Fixed: shares are honoured as set, until a guard stops a seat."}</div>
      <div id="dvPick">${pickHtml()}</div>
      <h4>Seats</h4>
      ${S().seats.map(s => { const c = dv.seats[s.id], u = s.usage || {};
        return `<div class="dseat" style="--seat:${s.color}">${portraitTag("mascot-" + s.id, s.color, c.enabled ? "" : "dim")}
          <b>${esc(s.nickname || s.label)} <span class="muted" style="font-weight:450;font-size:12px">${esc(SEAT_LABEL[s.status] || s.status)} · 5h ${pct(u, "five_hour") == null ? "–" : Math.round(100 - pct(u, "five_hour")) + "% left"} · wk ${pct(u, "weekly") == null ? "–" : Math.round(100 - pct(u, "weekly")) + "% left"}</span></b>
          <label class="switch" title="On duty"><input type="checkbox" data-duty="${esc(s.id)}" ${c.enabled ? "checked" : ""} aria-label="${esc(s.label)} on duty"><span></span></label>
          <div class="ctl"><label>Share <input type="number" min="0" max="100" value="${c.weight}" data-w="${esc(s.id)}" ${c.enabled ? "" : "disabled"}>%</label>
            <label>Lane cap <input type="number" min="0" max="16" value="${c.max_lanes}" data-cap="${esc(s.id)}"></label><span>runs ${s.lanes} now</span></div>
          <div class="ctl"><input type="text" placeholder="Note, e.g. keep free for interactive work" value="${esc(c.note || "")}" data-note="${esc(s.id)}" maxlength="200"></div>
        </div>`; }).join("")}
      <h4>Guards</h4>
      <div class="grid2">
        <label class="f">No new lane at 5-hour usage ≥ <input type="number" min="10" max="100" id="dv5" value="${dv.five_hour_guard}"></label>
        <label class="f">No new lane at weekly usage ≥ <input type="number" min="10" max="100" id="dvW" value="${dv.weekly_guard}"></label>
        <label class="f">Office-wide lane cap <input type="number" min="0" max="32" id="dvG" value="${dv.global_max_lanes}"></label>
      </div>
      <div class="row" style="gap:8px;margin-top:4px">
        <button class="btn primary" id="dvSave" ${dvDirty ? "" : "disabled"}>Save split</button>
        <button class="btn" id="dvReset" ${dvDirty ? "" : "disabled"}>Undo changes</button>
        ${!dvDirty && S().divider.updated_at ? `<span class="hint">Saved ${ago(S().divider.updated_at)}</span>` : ""}
      </div>
      <h4>Use it from scripts</h4>
      <div class="copy"><code>seat=$(claude-office pick-seat) || echo "no seat free"</code><button class="btn small" data-copy='seat=$(claude-office pick-seat) || echo "no seat free"'>Copy</button></div>
      <div class="hint" style="margin-top:6px"><code>--json</code> adds the config dir and the reasoning; exit code 3 means every seat is blocked.</div>`,
      bind(root) {
        const split = root.querySelector("#split");
        const paint = () => {
          split.querySelectorAll(".seg").forEach(seg => { const c = dv.seats[seg.dataset.seg], on = c.enabled && c.weight > 0; seg.style.flexBasis = `calc(${on ? c.weight : 0}% - 2px)`; seg.classList.toggle("narrow", c.weight < 14); seg.querySelector("small").textContent = c.weight + "%"; });
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
            toast(r.demo ? "Demo office: nothing saved." : `Split saved. Next lane → ${r.next_pick && r.next_pick.seat ? r.next_pick.seat : "nobody"}.`, "good"); app.refresh(); }
          catch (e) { toast("Could not save: " + e.message, "bad"); }
        });
        root.querySelector("#dvReset").addEventListener("click", () => { dv = null; dvDirty = false; dvPreview = null; app.rerender(true); });
      } };
  }

  // ---------------------------------------------------------------------------------------- hiring
  function hire() {
    const snap = S(), ld = snap.office.lane_defaults || {}, np = snap.next_pick, d = hireDraft;
    const dirs = [...new Set([snap.office.default_workdir, ...snap.seats.flatMap(s => s.sessions.map(x => x.cwd))].filter(Boolean))];
    const isCodex = d.seat && seatById(d.seat) && seatById(d.seat).kind === "codex";
    return { html: `${crumbs("Hiring desk")}
      <h2>＋ Hire a lane</h2>
      <div class="sub">A lane is a headless agent with a brief. It keeps progress notes so it can move to another seat when its seat runs out of plan, and files a report when it is done.</div>
      <h4>Start from a template</h4>
      <div class="templates">${TEMPLATES.map((t, i) => `<button data-tpl="${i}">${esc(t.name)}</button>`).join("")}</div>
      <label class="f">Title <input type="text" id="hTitle" maxlength="80" placeholder="e.g. Fix the flaky export test" value="${esc(d.title)}"></label>
      <label class="f">Brief <textarea id="hBrief" placeholder="Goal, where to look, how to verify, what counts as done.">${esc(d.brief)}</textarea></label>
      <label class="f">Working folder <input type="text" id="hDir" list="hDirs" value="${esc(d.workdir || snap.office.default_workdir || "")}"><datalist id="hDirs">${dirs.map(x => `<option value="${esc(x)}">`).join("")}</datalist></label>
      <div class="grid2">
        <label class="f">Seat <select id="hSeat"><option value="auto" ${d.seat === "auto" ? "selected" : ""}>Auto: divider picks (now ${esc(np.seat || "nobody")})</option>
          ${snap.seats.map(s => `<option value="${esc(s.id)}" ${d.seat === s.id ? "selected" : ""}>${esc(s.nickname || s.label)} · ${esc(SEAT_LABEL[s.status] || s.status)}</option>`).join("")}</select></label>
        <label class="f">Model <select id="hModel" ${isCodex ? "disabled" : ""}>${["opus", "sonnet", "fable", "haiku"].map(m => `<option ${(d.model || ld.model) === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
      </div>
      <label class="f">Permissions <select id="hPerm" ${isCodex ? "disabled" : ""}>
        <option value="acceptEdits" ${(d.permission_mode || ld.permission_mode) === "acceptEdits" ? "selected" : ""}>Accept edits, listed tools only</option>
        <option value="bypassPermissions" ${(d.permission_mode || ld.permission_mode) === "bypassPermissions" ? "selected" : ""}>Full trust (skips every permission check)</option></select></label>
      <div class="hint">${isCodex ? "Codex seat: runs through the gpt bridge; model and permissions do not apply." : "Runs as a systemd user unit at low CPU priority with no display."}</div>
      <div class="row" style="margin-top:12px;gap:8px"><button class="btn primary" id="hGo">＋ Hire and start</button><button class="btn" id="hClear">Clear</button></div>
      <h4>Office lanes</h4><div id="laneList">${laneListHtml()}</div>`,
      bind(root) {
        const q = (id) => root.querySelector("#" + id);
        const save = () => { hireDraft = { title: q("hTitle").value, brief: q("hBrief").value, workdir: q("hDir").value, seat: q("hSeat").value, model: q("hModel").value, permission_mode: q("hPerm").value }; store.set("hireDraft", hireDraft); };
        ["hTitle", "hBrief", "hDir", "hModel", "hPerm"].forEach(id => q(id).addEventListener("input", save));
        q("hSeat").addEventListener("change", () => { save(); app.rerender(true); });
        root.querySelectorAll("[data-tpl]").forEach(b => b.addEventListener("click", () => {
          const t = TEMPLATES[+b.dataset.tpl]; save();
          hireDraft.title = t.title; hireDraft.brief = t.brief; store.set("hireDraft", hireDraft); app.rerender(true);
          const ti = document.getElementById("hTitle"); if (ti) { ti.focus(); ti.setSelectionRange(ti.value.length, ti.value.length); }
        }));
        q("hClear").addEventListener("click", () => { hireDraft = { title: "", brief: "", workdir: "", seat: "auto", model: "", permission_mode: "" }; store.set("hireDraft", hireDraft); app.rerender(true); });
        q("hGo").addEventListener("click", async () => {
          save();
          if (!hireDraft.title.trim() || !hireDraft.brief.trim()) { toast("Give the lane a title and a brief.", "warn"); return; }
          if (hireDraft.permission_mode === "bypassPermissions" && !confirm("Full trust lets the lane run any command without asking. Start it?")) return;
          q("hGo").disabled = true;
          try {
            const r = await app.post("/api/lanes", hireDraft);
            if (r.demo) toast("Demo office: no lane was started.");
            else { sound.play("hire"); toast(`Hired “${r.lane.title}”. Watch the elevator.`, "good"); hireDraft = { title: "", brief: "", workdir: hireDraft.workdir, seat: "auto", model: "", permission_mode: "" }; store.set("hireDraft", hireDraft); }
            app.refresh(); app.rerender(true);
          } catch (e) { toast("Could not hire: " + e.message, "bad"); q("hGo").disabled = false; }
        });
      } };
  }

  // -------------------------------------------------------------------------------------- settings
  function settings() {
    if (!settingsData && !settingsLoading) {
      settingsLoading = true;
      fetch("/api/settings").then(r => r.ok ? r.json() : null).then(j => { settingsData = j || { unavailable: true }; settingsLoading = false; app.rerender(true); })
        .catch(() => { settingsData = { unavailable: true }; settingsLoading = false; app.rerender(true); });
    }
    const p = app.prefs();
    const sd = settingsData && !settingsData.unavailable ? settingsData : null;
    const voice = sd ? sd.voice || {} : {};
    const VOICE_EVENTS = [["report", "Reports filed"], ["limit", "Usage limits hit"], ["login", "Logouts"], ["lane", "Office lanes done or failed"], ["usage", "A seat near empty"], ["stuck", "Quiet lanes"]];
    return { html: `${crumbs("Settings")}
      <h2>⚙ Settings</h2>
      <h4>On this screen</h4>
      <div class="setrow"><div class="grow">Theme<small>Night ops is the default.</small></div><div class="seg-ctl">${["dark", "light", "system"].map(t => `<button data-theme-set="${t}" class="${p.theme === t ? "on" : ""}">${t}</button>`).join("")}</div></div>
      <div class="setrow"><div class="grow">Motion<small>Reduced stops walking, confetti and the ticker.</small></div><div class="seg-ctl">${["full", "reduced"].map(t => `<button data-motion-set="${t}" class="${p.motion === t ? "on" : ""}">${t}</button>`).join("")}</div></div>
      <div class="setrow"><div class="grow">Sound effects<small>8-bit blips for arrivals, reports and limits.</small></div><button class="btn small" data-test-sound>Test</button><label class="switch"><input type="checkbox" data-pref="sound" ${p.sound ? "checked" : ""} aria-label="Sound"><span></span></label></div>
      <div class="setrow"><div class="grow">Desktop notifications<small>Reports, limits and logouts while this tab is in the background.</small></div><label class="switch"><input type="checkbox" data-pref="notify" ${p.notify ? "checked" : ""} aria-label="Notifications"><span></span></label></div>
      <div class="setrow"><div class="grow">Share-safe<small>Blur what interactive sessions are about, and account emails.</small></div><label class="switch"><input type="checkbox" data-pref="privacy" ${app.privacy() ? "checked" : ""} aria-label="Share-safe"><span></span></label></div>
      ${!sd ? `<h4>Office</h4><div class="hint">${settingsLoading ? "Loading…" : "Office settings are not available from this server."}</div>` : `
      <h4>Office</h4>
      <label class="f">Office name <input type="text" id="setOffice" maxlength="40" value="${esc(sd.office_name || "")}"></label>
      <label class="f">CEO name <input type="text" id="setCeo" maxlength="40" value="${esc(sd.ceo_name || "")}"></label>
      <h4>Seats</h4>
      ${Object.entries(sd.seats || {}).map(([id, s]) => `<div class="setrow">${portraitTag("mascot-" + id, s.color || "#888888")}<div class="grow"><b>${esc(s.label || id)}</b><small>${esc(id)}</small></div>
        <input type="text" data-nick="${esc(id)}" maxlength="24" placeholder="Nickname" value="${esc(s.nickname || "")}"><input type="color" data-color="${esc(id)}" value="${esc(s.color || "#888888")}" aria-label="${esc(id)} colour"></div>`).join("")}
      <h4>Jarvis voice ${sd.voice_available ? "" : `<span class="chip warn" style="text-transform:none;letter-spacing:0">jarvis-say not found</span>`}</h4>
      <div class="setrow"><div class="grow">Announce out loud<small>Speaks short alerts through Jarvis (your Echo). Off by default.</small></div><label class="switch"><input type="checkbox" id="setVoice" ${voice.enabled ? "checked" : ""} ${sd.voice_available ? "" : "disabled"} aria-label="Voice"><span></span></label></div>
      <div class="row wrap" style="gap:6px;margin:8px 0">${VOICE_EVENTS.map(([k, label]) => `<label class="chip" style="cursor:pointer"><input type="checkbox" data-vev="${k}" ${(voice.events || []).includes(k) ? "checked" : ""}> ${label}</label>`).join("")}</div>
      <div class="grid2"><label class="f">Quiet from (hour) <input type="number" min="0" max="23" id="setQ1" value="${(voice.quiet_hours || [23, 8])[0]}"></label><label class="f">until (hour) <input type="number" min="0" max="23" id="setQ2" value="${(voice.quiet_hours || [23, 8])[1]}"></label></div>
      <div class="row" style="gap:8px"><button class="btn primary" id="setSave">Save office settings</button></div>`}
      <h4>Keyboard</h4>
      <dl class="kv">${[["Ctrl/⌘ K", "Search and commands"], ["Esc", "Back to the CEO briefing"], ["F T B S", "Floor, Timeline, Board, Today"], ["H", "Hire a lane"], ["D", "Load divider"], ["P", "Share-safe"], ["+ − 0", "Zoom in, out, fit"], ["Arrows", "Pan when zoomed"], ["?", "This list"]].map(([k, v]) => `<dt><kbd>${k}</kbd></dt><dd>${v}</dd>`).join("")}</dl>
      <h4>About</h4><div class="hint">Claude Office ${esc(S().office.version || "")} · started ${S().office.started_at ? ago(S().office.started_at) : "–"} · ${app.liveMode()}</div>`,
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
          root.querySelectorAll("[data-nick]").forEach(i => { body.seats[i.dataset.nick] = { ...(body.seats[i.dataset.nick] || {}), nickname: i.value.trim() }; });
          root.querySelectorAll("[data-color]").forEach(i => { body.seats[i.dataset.color] = { ...(body.seats[i.dataset.color] || {}), color: i.value }; });
          try { const r = await app.post("/api/settings", body); settingsData = r.demo ? settingsData : (r.settings || r); toast(r.demo ? "Demo office: nothing saved." : "Settings saved. The office redecorates on the next refresh.", "good"); app.refresh(); }
          catch (e) { toast("Could not save: " + e.message, "bad"); }
        });
      } };
  }

  function laneListHtml() { return S().lanes.length ? S().lanes.map(laneRow).join("") : `<div class="muted">No office lanes yet.</div>`; }

  return { ceo, seat, session, services, programmes, lounge, news, lane, divider, hire, settings, laneListHtml,
    isEditing: (k) => (k === "divider" && dvDirty) || k === "hire" || k === "settings" };
}

export { hydratePortraits };

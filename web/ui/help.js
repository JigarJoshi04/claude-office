// Help: short topics on how the office works, searchable, each with a way to see it. The page is #help (or
// #help=<topic>), and Ctrl+K finds every topic by its words.
import { esc } from "./util.js";
import { icon } from "./icons.js";

export const TOPICS = [
  { id: "seats", title: "Seats and characters", icon: "users", go: { kind: "office" },
    text: "Every Claude Code login on this machine (~/.claude, ~/.claude2, …) and Codex is a seat, and every seat is a character with a room, a name, a personality and a career. Their sessions are the people at their desks: one worker per live session." },
  { id: "plans", title: "Plan windows", icon: "battery", go: { kind: "office" },
    text: "Each seat has a 5-hour window and a weekly allowance. The nameplate shows the tighter one, the room's clock has a wedge to the 5-hour reset, and the window rains while the seat is out. Some plans also cap one model's week on its own: the seat's page lists those." },
  { id: "needs", title: "Needs you", icon: "alert", go: { kind: "ceo" },
    text: "Everything that wants a decision, grouped per seat, each with a one-click fix: questions from agents, failing checks, unresolved review comments (Forward to it), risky actions, two sessions in one working tree, a report whose tests contradict it, lanes cut off or waiting, logins about to lapse. Snooze hides an item for an hour on every screen." },
  { id: "lanes", title: "Lanes", icon: "briefcase", go: { kind: "hire" },
    text: "A lane is a background agent the office hires and supervises. It keeps notes in STATE.md, moves to another seat if its seat hits a limit, files REPORT.md when done, and can be messaged, stopped and resumed. Hire one now, at a time, into the backlog, with a time limit, as a chain of stages, one per line of a list, or as a bake-off between two contenders." },
  { id: "divider", title: "The load divider", icon: "sliders", go: { kind: "divider" },
    text: "The divider decides which seat gets the next lane: each seat's share, its cap, the usage guards, hours it is kept free for you, and the mode: Adapt to plan left, Spend the week evenly (more to a seat behind its week), or a fixed split. Scripts use it too: claude-office pick-seat." },
  { id: "talk", title: "Talking to a session", icon: "chat", go: null,
    text: "Open a session's Chat to read the conversation and send a message. Office lanes get it at once; terminal sessions hold it for approval at that terminal (Claude Code's own rule). Ask about it (with the analyst on) answers a question from the transcript without telling the session." },
  { id: "tokens", title: "Tokens and API value", icon: "flame", go: { kind: "tokens" },
    text: "Every token since the oldest transcript on the machine, per character, project, model and day, priced at the providers' list prices against what the plans cost. The burn meter shows the last hour; a session's page says why it is burning when it burns hard." },
  { id: "trust", title: "Trust check", icon: "check", go: null,
    text: "When a session or lane reports DONE, its own transcript is checked: its last test run passed after its last code change (Verified), failed (Contradicted, which needs you), or nothing shows it (Unverified)." },
  { id: "risk", title: "Risky-action watch", icon: "alert", go: { kind: "settings" },
    text: "A session that force-pushes, deletes outside a temp folder, applies or destroys infrastructure, drops a table, pipes a download into a shell, puts a credential on a command line, or writes a secrets file, ~/.ssh or Claude Code's settings shows up in Needs you with the command. It warns after the fact; each kind can be muted in Settings." },
  { id: "analyst", title: "The office analyst", icon: "sparkles", go: { kind: "settings" },
    text: "Off until you turn it on in Settings. It asks Claude small questions on one of your seats (Haiku by default, no tools, nothing saved, a daily token budget): Ask about it on a session, and the written While you were away card." },
  { id: "game", title: "Levels, gifts and the album", icon: "trophy", go: { kind: "trophies" },
    text: "Real work earns XP: characters level up and earn trophies, the office levels up and unlocks things on the floor, goals and quests give gifts, gifts hold stickers for the album (seasonal ones only in their season), and big moments go in the scrapbook. One save is kept by the office for every screen; Settings exports it. Game intensity (Z) turns it down or off." },
  { id: "share", title: "Share-safe and pictures", icon: "eyeOff", go: null,
    text: "Share-safe (P) hides what sessions are doing, questions, reports, commands and names in the news before a screen share. Pictures of the floor, the day card, standup mode and clips carry only names, levels and counts." },
  { id: "screens", title: "TV mode, replay and clips", icon: "tv", go: null,
    text: "TV mode (V, or /?tv=1) puts the floor full screen with a slow tour and slides. Replay (R) plays the last 6 or 24 hours back. The menu records a 15-second clip or today's timelapse; standup mode presents the morning's standup in two minutes." },
  { id: "privacy", title: "What leaves this machine", icon: "lock", go: { kind: "settings" },
    text: "The office listens on 127.0.0.1 only, writes need a per-install token, and the page loads nothing from elsewhere. Its own outbound calls are plan usage readings, GitHub through gh, and the analyst when on: Settings lists the last day's." },
  { id: "terminal", title: "In a terminal", icon: "terminal", go: null,
    text: "claude-office top shows the office in a terminal (SSH, tmux). claude-office status, pick-seat, hire, lanes, stop, resume, checkpoint, ask and post do the rest; agents can ask you a question with python3 -m office ask." },
  { id: "keys", title: "Keyboard", icon: "sliders", go: null,
    text: "Ctrl or Cmd K: search and commands. F T B S: floor, timeline, team, today. H hire, D divider, P share-safe, R replay, V TV mode, G goodnight, M radio, Z game intensity, 1 to 9 a character, Esc back, \\ hide the inspector, + − 0 zoom." },
];

export function findTopics(q) {
  const w = String(q || "").toLowerCase().trim();
  return w ? TOPICS.filter(t => (t.title + " " + t.text).toLowerCase().includes(w)) : TOPICS;
}

export function helpHtml({ crumbs, topic, query }) {
  const list = findTopics(query);
  return `${crumbs("Help")}<h2>Help</h2>
    <div class="chat-find" style="margin:0 0 12px">${icon("search", 15)}<input type="search" id="helpFind" placeholder="Search the help" aria-label="Search the help" value="${esc(query || "")}" autocomplete="off"></div>
    ${list.length ? list.map(t => `<details class="help-t" data-topic="${t.id}" ${t.id === topic || (query && list.length <= 3) ? "open" : ""}><summary>${icon(t.icon, 16)}<b>${esc(t.title)}</b></summary>
      <p>${esc(t.text)}</p>${t.go ? `<button class="btn sm" data-help-go='${esc(JSON.stringify(t.go))}'>${icon("chevronRight", 14)}Show me</button>` : ""}</details>`).join("")
      : `<p class="muted">Nothing matches "${esc(query)}".</p>`}`;
}

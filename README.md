# Claude Office

[![CI](https://github.com/JigarJoshi04/claude-office/actions/workflows/ci.yml/badge.svg)](https://github.com/JigarJoshi04/claude-office/actions/workflows/ci.yml) [![MIT license](https://img.shields.io/badge/license-MIT-ff7a45?style=flat-square)](LICENSE) ![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-3776ab?style=flat-square&logo=python&logoColor=white) ![Zero dependencies](https://img.shields.io/badge/zero_dependencies-standard_library_only-38e07b?style=flat-square) ![Local-first](https://img.shields.io/badge/local--first-127.0.0.1_only-5b8def?style=flat-square)

**Your AI coding seats, as a living office.** Every Claude Code account on your machine becomes a character with
its own room, and so does the Codex CLI. Every running session is a little worker at a desk in that room, acting out
what it is doing right now. New sessions walk in from the elevator; spent seats nap on the couch. You run the place from the CEO's chair: see who is
working and who is stuck, talk to any task, split new work across seats, and hire background lanes from the front
desk.

And the office grows with the work: characters level up and earn gear, the office itself levels up and unlocks palms,
a robot vacuum, a dog and fireworks, and there are daily goals, a weekly "beat last week" challenge, combos, gifts
with stickers to collect and badges to chase. Replay the day on the floor, put it on a spare screen in TV mode, or share a picture of the day.

![Claude Office in demo mode: a level-up banner, a visitor lane walking in from the elevator, a character card, a session's Chat, the Team view, the Timeline and a gift opening on the floor](docs/demo.gif)

*Every screenshot and recording is demo mode (`python3 -m office serve --demo`): made-up seats, no real accounts.*

| The floor | Talk to a task | Your team |
|---|---|---|
| ![The office floor](docs/office.png) | ![Chat](docs/session.png) | ![Team](docs/team.png) |
| **Level up** | **Trophy room** | **Trophy wall** |
| ![A LEVEL UP banner sweeps the floor](docs/levelup.png) | ![The trophy room leaderboard](docs/trophies.png) | ![A character's career and trophy wall](docs/career.png) |
| **Room peek** | **Day theme** | **Timeline** |
| ![Hovering a room shows who is doing what](docs/peek.png) | ![The office in the day theme](docs/light.png) | ![Every session over the last hours](docs/timeline.png) |
| **Replay the day** | **TV mode** | **The office levels up** |
| ![The floor plays back the last six hours](docs/replay.png) | ![The floor full screen with a news ticker](docs/tv.png) | ![Office level and unlocks](docs/office-level.png) |

![Today's card: a picture of the day to share](docs/daycard.png)

## Why

If you run several Claude Code accounts (and maybe Codex) at once, the questions are always the same: *Is anything
working? What is each one doing? Which seat is about to run out, and when does it reset? Where should the next job
go?* Claude Office answers them in one glance, in plain English, and lets you act on the answer.

## What's inside

**A living floor: a room per character**
- Every seat, found automatically (`~/.claude`, `~/.claude2`, … and `~/.codex`), gets its own room. The room has its
  name on the door, a floor in its colour, a window, and decor that matches its personality. The Investigator has a
  corkboard with red string, the Builder a tool pegboard and a hard hat, the Night Owl a moon poster, string lights
  and a coffee machine, and so on.
- One worker per live session, at a desk sized to the people actually there (one, two, three, four or six seats) on
  a rug in the seat's colour. They type, read, think, wait on long tools, sweat when stuck, and fall asleep when their
  seat is out of plan. Terminal sessions wear headsets; a subagent shows up as a little helper drone.
- Every personality has its own floor (oak planks, carpet tiles, library green, pale tiles, a starry navy carpet, a
  chequered floor, parquet) and its own furniture corner: a 3D printer, an armchair under a lamp, a sand garden.
- Rooms tell you their state at a glance: lights on while people work, dim while the seat naps (with when it is back),
  a beach umbrella when it is on holiday, a padlock on the door when it is logged out. Each nameplate shows the name,
  level, a coloured status chip and the plan left, with a pulsing badge when something about that seat needs you.
- **Room peek**: hover a room for a moment and a card shows its voice, both plans and who is doing what. The `?` by the
  camera buttons explains every colour, badge and icon on the floor.
- A lobby holds the elevator, the CEO's desk with the capacity board, the hiring desk, the trophy cabinet and the
  server closet. A spare room becomes the lounge, where seats on a break hang out.
- Arrivals walk in from the elevator, down the corridor and through their room's door. Filed reports burst into
  confetti, and night lighting follows your clock. Pixel the office cat wanders the corridors and naps in the lounge;
  click her for a tip.
- The building fits your screen. On a desktop window the office fills it edge to edge: the floor re-plans itself
  (two, three or four rooms to a row, taller rooms) for whatever space it has, spare cells become gardens, and a
  little night city fills anything left. Drag the inspector wider and the building rearranges itself live.
- Under the floor, a dock shows everyone at work right now: who, what they are doing and for how long. A click
  opens their chat and flies the camera to their desk.
- Zoom and pan the camera (a minimap appears while zoomed), double-click a room to fly to it, right-click it for quick
  actions: open, zoom in, hire a lane for that seat, send it on holiday, copy its terminal command. Point at a character anywhere (the team list, the dock,
  a room) and their room lights up on the floor while their row lights up in the list.
- Every room has its own weather: its window rains while the seat is out of plan and clouds over while its plan runs
  low.
- Screens show the tool: a turning globe while an agent browses the web, a prompt for the shell, a crawling bar while
  tests run, a plug for another service. A flask by the desk turns green or red with its last test run.
- **The ship board** in the lobby keeps today's commits, PRs and merges in chalk. Commits fly to its outbox as
  envelopes, and every merge rings the brass ship's bell.
- When a lane moves to another seat after a limit, its worker picks up a box and walks down the corridor to the new
  room. Gifts that find the floor full wait in the mailroom's pigeonholes behind the hiring counter.
- When you step away from the computer (the screen locks, or no input for five minutes), the CEO's chair empties and
  banners wait for you. **Director cam** (🎬 by the zoom buttons) flies the camera to whatever just happened, and
  stands back while you move it yourself.
- **Pets with routines**: Pixel naps by the warmest desk (the room burning the most tokens), Biscuit walks newcomers
  from the elevator to their room, and both visit whoever just shipped. **The night shift**: from 9 pm empty rooms
  switch off one by one and a janitor mops the corridors; the morning's first session gets a "First one in" banner.
- **Who is doing what, at a glance**: each desk's name tag carries its model's colour (Opus, Sonnet, Haiku, Fable,
  Codex), and every working session has a phase (exploring, building, testing, debugging, wrapping up) read from
  its last few steps.
- **Replay** (`R`): the floor plays back the last 6 or 24 hours from the office's own history, at up to 900×. People
  come and go, reports burst into confetti and level-ups get their banner as they happened; scrub with the timeline,
  `Space` pauses, the arrows step, `Esc` returns to live.
- **Install it as an app** (☰ → Install as an app, in Chrome or Edge): its own window, and a badge on its icon with the
  number of things that need you.
- **TV mode** (`V`, or open `/?tv=1` on a spare screen): the floor alone, full screen, with a status strip and a clock,
  while a slow tour lights up each room and shows its card. Every third step a slide in big type takes the screen:
  today's burners, the day so far, what shipped and how many things need you (counts only). The screen stays awake,
  the cursor hides, it dims at night and reloads itself after an update. `&slides=burn,today,shipped,needs` (or
  `none`), `&every=12` (seconds) and `&dim=22-7` (or `0`) tune it.

**The office levels up**
- Everyone's XP adds up to an office level (the gold ring next to the name). Each level unlocks something on the floor:
  lobby palms, a robot vacuum, flowers in every room, a delivery drone, gold elevator doors, Biscuit the office dog, a
  neon show, a hot-air balloon, fireworks at night, gold nameplates and a golden statue of you. "Your office" lists
  them all, what comes next and who built the most.
- **Beat last week**: a weekly challenge to file 10% more reports than last week, with a Record week celebration.
- **The day's rhythm**: a morning card recaps yesterday and names today's goals; an evening card wraps the day up.
- **Gifts and a sticker album**: a report or a finished lane sometimes leaves a gift box in that character's room,
  and a delivery waits at the CEO desk every morning. Open them for 28 pixel-art stickers in four rarities, plus
  seasonal ones (a pumpkin, a diya, a snowflake, a firework) that only turn up in their season; five
  spares swap for a rare-or-better gift. Only one sticker is Legendary. Finishing all goals, a big combo or a level
  up always brings a gift, a daily happy hour doubles the odds, and each finished rarity puts something on the floor.
- **Tokens** (K): every token since the oldest transcript on the machine, by range (today to all time) and per
  character: who burns the most and who moved, a calendar, the hours of the week, records, the hungriest sessions,
  projects and models, what it shipped (commits, PRs, lines, tokens per commit), CSV export, and a live burn meter. Counted from the transcripts and attributed to the seat that
  ran each session. Click a project for its own page: tokens and API value per day, who worked on it, its biggest
  sessions and lanes, what it shipped, and the days as CSV.
- **Shipped work earns XP**: commits (25), pushes (5), opened (50) and merged (150) pull requests, read from the
  transcripts, with "+3 commits" rising from the desk and five shipping achievements.
- **Pull requests and CI lamps**: the recent PRs of your repositories with checks, reviews and the desk on each
  branch, and a lamp on every desk whose PR's checks pass, run or fail (with the GitHub CLI, when it is signed in).
- **Burn alarms**: your own number rules (tokens an hour, minutes to run-out, milestones, the top burner changing)
  ring as a toast, a chime and a desktop notification.
- **Character creator**: give each character (and yourself) a skin, hair, hairstyle and glasses.
- **Lane chains**: hire "investigate, then fix, then review" at once; each stage gets the last one's report.
- **Filing cabinet**: every past session, searchable, to open or resume.
- **Loose ends**: work the agents left in git (uncommitted files, commits on no remote) and worktrees that are safe to
  remove, with the remove commands to copy. The office only reads.
- **Ghost use**: a ghost floats in a room when its plan use climbs with nothing running on this machine (claude.ai,
  the desktop app or another computer on the same login).
- **Context gauge**: how full each session's context window is, on its page and as a paper pile on its desk.
- **Task lists**: a session's own task list as a progress bar on the back of its screen and a checklist on its page.
- **Prompt cache countdown**: a waiting session shows how long its prompt cache stays warm ("Cache warm 4:12") and
  what a reply saves before it cools; its mug steams on the floor until then.
- **API value**: every response priced at Anthropic's and OpenAI's list prices (5-minute and 1-hour cache writes,
  cache reads, output, fast mode), per character, model, project, day and month, against what the plans cost for the
  same days: "$9,030 at API list prices, 15× what the plans cost". A plan is priced by its tier (Pro, Max 5x, Max 20x)
  unless you set it per character in Settings.
- **Character cards**: each character as a collectible card, framed Bronze to Holo by level, to save or post.
- **Your week in review**: on Mondays (or from the menu) the last seven days play as a short story, ending in a
  picture to post: reports against the week before, agent hours, the star of the week and what you collected.
- **Office radio**: press M (or click the boombox on the CEO desk) for endless lo-fi, made up as it plays. No files,
  nothing fetched.
- **Bug Squash**: the lounge's arcade cabinet plays a 30-second game of squashing bugs (not features) on a code
  editor, for a gift when you beat your best. The **Daily run** spawns the same bugs for everyone all day; each day's
  best is kept for 30 days and today's glows on the cabinet.
- **The scrapbook**: level-ups, trophies, office levels and all-goals days are photographed on the floor as they
  happen, as captioned polaroids to flip through.
- **Badges for you**: nineteen of them (one a secret), from *Inbox zero* and *Hiring manager* to *Collector* and *Night owl*.
- **Seasons**: pumpkins and bats for Halloween, lamps and a rangoli for Diwali, a tree and snow in December.
- **Combos**: reports and finished lanes within 15 minutes of each other chain into a combo (×2, ×3, …) with a timer
  draining on the floor and rising chimes.
- **Today's card**: one picture of the day (reports, hours, tool calls, employee of the day, goals, streak and the
  team) to save or copy into a post or a channel. Only names, levels and counts go in.

**Every seat is a character**
- A name, a role, a motto and a few traits ("Atlas, The Investigator: *Show me the evidence.*"). You can rename them
  and change their colours in Settings.
- They talk about themselves in their own voice ("Napping until 11:10. The clues will keep.", "3 builds going. Hard
  hat on.") and write a one-line diary of their day.
- Pick a personality for each one in Settings (or keep the automatic one): it sets their voice, their floor and their
  furniture.
- They speak up when it matters: when they arrive, when they ship, when they hit a limit, and when a fresh window
  opens. Now and then two of them trade a line about what is going on. Teammates react too: they cheer a report or a level-up, and offer to cover when someone runs out of plan.
- A career that grows with real work. XP comes from tool calls (1 each), minutes at work (2), sessions (10) and
  filed reports (100). Levels run from Intern to Legend, with a "LEVEL UP!" banner across the floor and "+XP"
  rising from busy desks.
- Desks upgrade as their character levels up: a mug, a plant, a gold cup, a glowing desk edge, a pennant, gold
  trim. Their people get gear too: a team badge, caps in the seat's colour, sunglasses and gold headphones.
- Fifteen achievements, such as *Night shift*, *Marathon*, *Juggler* and *Week streak*. They sit on each
  character's trophy wall with a "next up" goal, and fill the trophy cabinet in the lobby. The cabinet opens
  the Trophy room, with an XP leaderboard.

**Talk to a task**
- Open any session and use the **Chat** tab. It shows the conversation: prompts, replies (formatted: lists, code,
  tables), collapsed tool steps, messages from other sessions, and replies sent to you.
- Send a message from the office. Lanes you hire here get it straight away. Terminal sessions hold it for approval
  at that terminal, because that is Claude Code's own safety rule and the office respects it.
- Agents can answer you: the office has its own inbox, and replies show up in the chat and as a toast.
- **Find** anything in a conversation: matches are highlighted and Enter jumps between them.
- **Ask about it** (with the office analyst on): ask a question about any session ("did it run the tests?") and get
  an answer from its transcript, citing the entries it relied on, without the session knowing.
- **Follow up** on a finished session. Your message starts a lane that resumes that exact conversation.
- **Message all lanes** at once, for example "limits reset in 20 minutes: write your notes now".

**The CEO's briefing**
- Always in the same order: how many sessions are working, idle and stopped (and who gets the next lane), what
  needs you, today's goals, and your team.
- *Needs you*, grouped per seat ("Vega is out of plan: 2 sessions paused"), and each item with a one-click fix: copy
  the login command, open the chat, open the lane. It also catches: **unresolved review comments** on a desk's PR
  (Forward to it writes them into that session's message box), **risky actions** (a force-push, a delete outside a
  temp folder, an infrastructure apply, a secrets file written: see Safety), **two sessions writing in one working
  tree**, and a **report that says done while its last test run failed** (every report gets a Verified, Unverified
  or Contradicted chip from its own transcript).
- **Your review queue**: the PRs waiting for your review, each with a Reviewer button that fills the hiring desk with a
  read-only review brief.
- Your team as one row per character: face, level, mood in a word, and a bar for the plan it has left.
- **Today's goals**: three targets every day, drawn from six kinds (reports, tool calls, agent hours, sessions,
  lanes hired, characters at work) and sized to your office's own pace over the last two weeks, as rings. Finishing
  one celebrates on the floor; finishing all three every day builds a streak. One reroll a day swaps the unfinished.
- **This morning's standup**: Yesterday, Today and Blockers, written from the office's own records and ready to copy
  into Slack, or **present it** as a two-minute set of slides for a screen share. **Reminders**: a note for a time, or for when a seat's plan is back, a session or lane finishes, or a
  PR merges. A new office gets a **set-up checklist** that ticks itself off.
- *While you were away*: after an hour or more away (or ten minutes away from the computer with the page left open), one line says what happened since you last looked (reports
  filed, level-ups, trophies, lanes finished, limits hit, anything blocked); open it for the items to read first.
- News reads like people talk: "tpl-fix finished: ready for review · #1679", "visitor-lane started at Orion's desk".
- Each character's page: its voice and two plan rings with their resets, then three tabs: **Now** (who is at the
  desk, today's diary, the plan chart), **Career** (level, stats, trophies) and **Settings** (duty, terminal command,
  account).
- **Resizable**: drag the handle between the floor and the inspector, or focus it and use the arrow keys.
  Double-click puts it back. The width is remembered, and the inspector lays itself out for the space it has.
  Hide it with the button by the clock (or `\`) for a full-width floor; opening anything brings it back.
- **Text size**: Auto, Small, Medium, Large or Extra large, from the menu or Settings. Auto uses larger text on big
  screens, so a 27-inch monitor reads as well as a laptop.
- Keys: `1`–`9` open characters, `Esc` goes back to the briefing, `?` lists the rest.

**Views**
- **Timeline**: every session on every seat over the last 1 to 24 hours, coloured by state. It also shows usage,
  news markers, upcoming resets, and a ✕ where a seat runs out at its current pace.
- **Team**: persona cards with both plan windows and everyone at each desk.
- **Today**: the last seven days as a chart (reports, agent hours or tool calls, against the week before), employee of
  the day, a league table (time at work, sessions, reports, limits, tool calls, tokens, peak
  usage) and a short digest of the day. **Par for the week** scores each seat's weekly plan like golf (use most of it
  without running out), and **Waiting on you** says how long sessions sat waiting for your reply, with the median.

**Running the office**
- **Load divider**: drag the borders of the split bar to share new lanes between seats. Send a seat on holiday, cap
  its lanes, or set usage guards. Adapt-to-plan mode shrinks a seat's share as its plan runs out; Spend-the-week-evenly
  gives more to a seat behind its week (use it or lose it). Keep a seat free in your working hours, and a lane that
  asks for a model stays off a seat whose week for that model is spent (each seat's page shows its per-model limits).
  Scripts follow it too: `seat=$(claude-office pick-seat --model opus)`.
- **Hiring desk**: six brief templates, plus your own (Save as a template). *Next up* suggests ready briefs from
  blocked reports, failed lanes and PRs whose checks fail.
  - Lanes run as low-priority background services.
  - A lane keeps notes, moves to another seat if its seat hits a limit, and files a report when done.
  - You can stop, resume, re-hire or chat with any lane.
  - Give a lane a time limit, start it later or put it in the backlog, or write a list in "For each" for one lane
    per line.
  - After a restart or a crash, lanes that were cut off say so in Needs you, with one button to resume them all.
- **Checkpoint**: writes every session and its resume command to a file, for before you restart. Every hour the office
  also keeps `office-checkpoint-latest.md` and `resume-latest.sh` up to date while terminal sessions are live; after a
  restart, `sh resume-latest.sh` reopens each of them in a tmux window.
- **Save a picture of the office**: a PNG of the floor with each character's nameplate, sized as it is, for a 16:9
  slide, a square post or a phone story, with the date if you like. It has no session names or accounts in it, so it
  is safe to post.
- **In a terminal**: `claude-office top` shows the seats, what needs you, every session with its phase, the lanes and
  the news, and messages a session or stops a lane from the keyboard.
- **Everything else**: Ctrl/⌘ K command palette, share-safe mode for screen sharing, 8-bit sound effects, desktop
  notifications, optional Jarvis voice alerts, a day theme, and reduced motion.

## Quick start

```bash
git clone https://github.com/JigarJoshi04/claude-office && cd claude-office
python3 -m office serve --demo    # look around a made-up office first
python3 -m office serve           # your real office at http://127.0.0.1:7420
bin/install.sh                    # keep it running as a systemd user service
```

You need Python 3.10 or newer and nothing else: the server uses only the standard library, and the page needs no
build step. The live view needs Linux, because sessions are read from `/proc` and lanes run under `systemd --user`.

Handy links: `/?view=timeline`, `/?view=board`, `/?view=stats`, `/#hire`, `/#divider`, `/#trophies`, `/#seat=claude2`, `/?theme=light`.

## How talking to a session works

Claude Code sessions listen on a private Unix socket for messages from other sessions (the mechanism behind its
SendMessage tool). The office writes the same one-line frame to that socket. The message is labelled as coming from
"Claude Office (CEO)", and the office's own inbox socket is given as the reply address.

The receiving session decides what happens:

| Session | What happens |
|---|---|
| A lane hired from the office, with "Let me message it" on (the default) | Started with `crossSessionInbound: "accept"`, so the message is delivered straight away |
| A terminal session | Held. The terminal shows "Held message from another session" until someone approves it there |
| A finished session | The office starts a follow-up lane: `claude --resume <id> -p "<your message>"` |

The office never claims a permission mode, so it cannot get around that review.

## Command line

```text
claude-office status                 one line per seat and per session
claude-office pick-seat [--json]     the seat the divider gives the next lane (exit 3 when none can)
claude-office hire --title T --brief-file F [--workdir D] [--seat auto|ID] [--model opus]
claude-office lanes | stop ID | resume ID [--seat ID]
claude-office checkpoint             write the office down
claude-office top                    the office in this terminal (SSH, tmux): seats, Needs you, sessions, lanes, news
```

## Configuration

Everything personal stays outside the repo, in `~/.config/claude-office/`:

| File | What it holds |
|---|---|
| `config.json` | Office and CEO name, seat names, roles, mottos and colours, programmes (`{"match": "apollo", "name": "Apollo launch", "url": "..."}`), watched services, lane defaults and preamble, voice, checkpoint folder, port. The Settings panel edits the common parts. |
| `divider.json` | The load divider, written by the page |
| `token` | The per-install secret the page uses for writes |

The office keeps its own records in `~/.local/state/claude-office/`: the usage cache, 24 hours of minute
samples, the news, the message log and each seat's career. Lanes and checkpoints go in `~/.local/share/claude-office/`.

## Agents can ask you

An agent that needs a decision runs, from inside its session:

```sh
python3 -m office ask "Ship the rate limiter behind a flag today, or wait for review?"
```

and keeps working on what does not depend on it. The CEO's desk phone rings, Needs you shows the question with an
Answer button, and the Inbox keeps it; your answer goes back to that session as a message. Office lanes are told they
may ask, once, when a decision is truly yours.

## News from your scripts

Deploy scripts, make targets, cron jobs and CI runners can put news on the floor: a toast, a line in the news, a
marker on the seat's timeline, and with `--banner` a banner across the floor.

```sh
python3 -m office post "Prod deploy done: v2.4.1" --level good --source deploy --banner
python3 -m office post "Nightly build failed" --level bad --source CI --seat claude2
```

Or straight over HTTP, with the per-install token (readable only by you):

```sh
curl -X POST http://127.0.0.1:7420/api/event -H "Content-Type: application/json" \
  -H "X-Office-Token: $(cat ~/.config/claude-office/token)" \
  -d '{"text": "Backup finished", "level": "good", "source": "cron"}'
```

`level` is good, info, warn or bad; `seat` puts it at a character's desk; at most 30 events a minute.

## A status line for your terminal

`GET /api/status.txt` returns one line: how many sessions work, what needs you, the burn and the tightest plan
(`?style=plain` drops the symbols). For tmux:

```
set -g status-right '#(curl -s 127.0.0.1:7420/api/status.txt?style=plain)'
```

## How it knows things

| What | Where it comes from |
|---|---|
| Seats | `~/.claude*/` folders with a login, plus `~/.codex` |
| Plan usage | The plan's usage endpoint, called with each seat's current access token every few minutes. The office never refreshes a login itself; while a seat's token is expired, it shows the last reading, marked stale. |
| Live sessions | `<seat>/sessions/<pid>.json`. A session counts only if its pid runs and its kernel start time matches. |
| What a session is doing | Its transcript, read incrementally |
| History and stats | One sample a minute, kept for 24 hours |
| All-time tokens | The `usage` of every response in the transcripts, read once and then incrementally; a session's seat from its `session-env` folder |
| API value | Each response's `usage` (cache write split, speed, inference region) at the list prices in `office/prices.py` |
| Codex seat | `~/.codex/sessions` rollouts and the rate limits Codex records. Codex lanes run `codex exec` with a workspace-write sandbox (or a `gpt` wrapper, when one is installed). |

## Safety

- **Network:** the server listens on `127.0.0.1` only, and rejects any request whose `Host` is not loopback.
- **Writes:** every write needs the per-install token, which only the office's own page receives.
- **The page:** a strict Content-Security-Policy is set. Transcript text is escaped, and credential-shaped strings
  are masked before they reach it.
- **Credentials:** read only at the moment of a usage call. They are never sent to the page, logged or cached.
- **Messages:** the office's inbox accepts only connections from your own user. It never claims a permission mode,
  and it never sends a message without your action.
- **Lanes:** `lane_policy` in `config.json` sets the folders lanes may work under (`roots`) and whether they may
  have full trust (`allow_full_trust`). A full-trust lane is never started in `/` or your whole home folder. Each
  lane's systemd unit is capped at `memory_max` (default `50%` of RAM) and `tasks_max` processes (default 4096).
- **Risky-action watch:** a session that force-pushes, deletes outside a temp folder, applies or destroys
  infrastructure, drops a table, pipes a download into a shell, puts a credential on a command line, or writes a key,
  a `.env` file, `~/.ssh` or Claude Code's own settings shows up in Needs you within seconds, with the command
  (credentials masked). It reads transcripts after the fact: it warns, it cannot stop anything. Each kind can be
  muted in Settings; admin merges are watched only when you turn them on.
- **Office analyst (off by default):** when you turn it on in Settings, a few features ask Claude small questions on
  one of your seats (`claude -p` with Haiku, `--safe-mode`, no tools, nothing saved), within a daily token budget,
  with a log of what was sent. Ask about it, on a session's Chat tab, also needs "Let it read transcripts": the
  transcript goes to that session's own seat with credentials masked, and the session itself is never told.
- **Demo mode:** reads no accounts, and every write does nothing.

## Uninstall

```bash
bin/install.sh --remove
rm -rf ~/.config/claude-office ~/.local/state/claude-office ~/.local/share/claude-office
```

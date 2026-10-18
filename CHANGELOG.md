# Changelog

All notable changes to Claude Office are documented here, following Keep a Changelog.
Version entries describe the implemented milestones in repository history, not published GitHub releases.

## [3.22.0] - 2026-10-18

### Added
- Game intensity (Settings, Z, palette, `?game=calm`): Full; Calm, with no banners, confetti, character chatter, party
  lights, XP floaters or game chimes; Off, with no game at all (no gifts, goals, combos, level chip or game toasts).
  Real alerts, reports and Needs you stay at every level.
- The week's pace on each character's page: ahead of or behind an even pace to the weekly reset, when it runs out if
  it will, or how much will be left.
- A quiet "week left" card in the briefing when a seat resets within 18 hours with at least 35% of its week unused,
  with Hire a lane for that seat. Once per seat and window; never in Needs you.

## [3.21.0] - 2026-10-18

### Added
- A Tokens tab (K): today, 7, 30 or 90 days or all time, and all tokens, fresh or output. It has the total against
  the period before, a leaderboard that shows who moved up or down, a drill-in for one character, the days in the
  range, a 26-week calendar, a weekday-by-hour heatmap, records (the biggest day, the hungriest session, the longest
  run of days, the busiest hour), and the hungriest sessions, projects and models. Sessions export as CSV (project
  names left out in share-safe mode).
- A live burn meter by the Live badge: the tokens the sessions at work processed in the last hour.
- `GET /api/tokens?range=today|7|30|90|all&seat=<id>&sessions=all`.

### Changed
- The token ledger (version 2) keeps each session's days split by measure and its hours of the week. A version 1
  ledger is rebuilt from the transcripts on disk on first start; sessions whose transcripts are gone keep their totals.
- The demo's token history runs through the real ledger view.

## [3.20.1] - 2026-10-18

### Fixed
- Since 3.16, a successful hire showed "Could not hire" (inviting a second, duplicate lane) and a delivered message
  showed "Could not send": moving the game layer out of `app.js` dropped `app.badge` and `app.bump`. A new static test
  (`tests/js/wiring.test.mjs`) checks that every `app.X()` the UI calls is defined.
- The token ledger read each transcript's new part whole (up to hundreds of MB at once, about 800 MB peak); it now
  reads line by line (31 MB peak for a full first read).

## [3.20.0] - 2026-10-18

### Fixed
- Ten bugs from the 3.11–3.16 QA pass: Space in the week review skipped instead of pausing (and focus sat on invisible
  tap areas); its Copy button was invisible in the light theme; the Monday review covered Tuesday to today instead of
  last week; a focus box cut through every slide; a tie for star of the week showed one name on the picture; badge
  icons broke the collection slide; the secret code ran behind dialogs and flipped to the Team view; the Codex command
  did not paste into a shell; Bug Squash's start screen overflowed phones at large text and showed "Time 1" at the end.
- Pausing the week review resumes where it stopped; the week picture formats big numbers; couriers no longer step on
  waiting gifts; Bug Squash rounds last 30 real seconds on slow machines; the radio's audio engine sleeps when off.

## [3.19.0] - 2026-10-18

### Added
- All-time tokens (Today view): every token the models processed since the oldest transcript on this machine, with
  cache reads, fresh tokens and output apart; who burns the most (characters, with a Top burner flame), the hungriest
  sessions, projects and models, the last 60 days and month totals. One measure at a time: All, Fresh or Output.
- A token ledger on the server (`office/tokens.py`, `state/tokens.json`, `GET /api/tokens`): reads the transcripts once
  (about 15 s for 7 GB), then only what was appended, every 2 minutes. Sessions are attributed to the seat whose config
  dir holds their `session-env` folder, so it works when seats share one projects dir. Codex rollouts count for the
  Codex seat. Totals are kept after Claude Code deletes old transcripts.
- The top burner's nameplate on the floor carries a flame; each character's Career tab shows its all-time tokens and
  rank.

## [3.18.0] - 2026-10-18

### Fixed
- Ten bugs from the gifts QA pass: "Open the album" landed on the top of the page below 1240 px and did nothing in
  TV mode; the gift chip left the box off screen on phones; long cat tips were clipped and stacked; the confetti hid
  behind the reveal; "Swap 5 spares" misled with a full floor; floor banners were cut off on phones; lava lamps sat
  on the desk plant; focus fell to the page after a reveal.
- Banners queue instead of replacing each other; the party horn and the gift chime are never dropped by the sound
  throttle; the album footer gives today's, the current or tomorrow's happy hour; the happy-hour chip has readable
  contrast; TV mode shows waiting gifts and the happy hour; a departed seat's gifts keep its name; the golden duck's
  glint moves on its reveal; the cat has a finger-sized target on touch screens; no wall stickers over the elevator;
  the demo announces its happy hour once a visit; album stickers have an outline on light tiles; the Monday review
  stops retrying when there is no week; a remembered radio resumes on the first gesture without switching off.

### Added
- The morning card points at the day's delivery while it waits.

## [3.17.0] - 2026-10-18

### Added
- Character cards: a collectible card for each character, framed by level (Rookie, Bronze, Silver, Gold, and Holo
  from level 20), with the portrait, title, motto, hours, reports, tool calls, sessions and latest achievements. It
  tilts toward the pointer, flips through the team, and saves or copies as a picture. Open it from the star on a
  character's page, the room menu or the palette.

## [3.16.0] - 2026-10-18

### Added
- Codex lanes run on any machine with the Codex CLI: `codex exec` with a workspace-write sandbox, or the `gpt` wrapper
  when one is installed. Before, hiring on the Codex seat needed that wrapper.
- A secret badge, and a party on the floor for whoever enters the code everybody knows.

### Changed
- The game layer (goals, badges, the weekly challenge, streaks, anniversaries, combos and the level chip) moved from
  `web/app.js` into `web/ui/game.js`.

## [3.15.0] - 2026-10-18

### Added
- Badge progress: counted badges (messages, pets, stickers, visit streak, Bug Squash score) show how far along they
  are on "Your office", and the briefing names the one closest to done ("Almost there: Open door 7/10").

## [3.14.0] - 2026-10-18

### Added
- A visit streak improves the morning delivery: rare or better from three days in a row, epic or better every seventh
  day. With the floor full, the day's delivery waits for room instead of being lost.
- A soft drop sound when a gift lands on the floor.
- The project page shows gifts, the sticker album, Bug Squash, the radio and the week in review.

### Changed
- The pet badge is now "Pet person" and counts the dog too.

## [3.13.0] - 2026-10-18

### Added
- The office radio: endless lo-fi made up in the browser with WebAudio (seventh chords on an electric piano, a round
  bass, swung drums, a sparse melody, vinyl crackle; a new progression every eight bars). Click the boombox on the
  CEO desk, press M, or use the menu or palette. It remembers being on and starts again at the first click or key.

## [3.12.0] - 2026-10-18

### Added
- Bug Squash, the lounge's arcade game (click the arcade cabinet, or ☰ → Play Bug Squash): 30 seconds of squashing
  bugs on a code editor. Green bugs are worth 1, red 3, the rare golden bug 10, and squashing a feature costs 5. Mouse,
  touch or keyboard. A new best score brings a gift once a day; 40 points earns the Exterminator badge.

## [3.11.0] - 2026-10-18

### Added
- Your week in review: the last seven days as a short story (reports and the change on the week before, agent hours,
  the star of the week, new stickers, badges and goal days), with a picture to save or copy. It plays on the first
  visit of a Monday, and from the menu, the palette or "Play the week" on the week chart. `?week=1` plays it in the
  demo.
- A courier brings gifts for the CEO desk out of the elevator and drops them off, including the morning delivery.

## [3.10.0] - 2026-10-18

### Added
- Gifts you earn for sure: finishing all three goals (rare or better), a ×3 or ×5 combo, a character's level up, the
  office's level up and a record week (epic or better).
- Happy hour: half an hour a day, at a time that moves from day to day, when gifts are twice as likely. Party lights
  wander over the lobby and the corridors, and the gift chip turns into a rainbow with the minutes left.
- Album sets: finishing every sticker of a rarity puts something on the floor: a sticker wall in the lobby (Common),
  a lava lamp on every desk (Rare), a UFO that crosses the sky (Epic) and the golden duck on the CEO's desk
  (Legendary).
- Pet the office cat: hearts and a purr, and a Cat person badge at ten.
- Demo switches for screenshots: `?happy=1` and `?stickers=all`.

## [3.9.0] - 2026-10-18

### Added
- Gifts: a report or a finished lane sometimes leaves a gift box in that character's room (never three reports in a
  row without one), and the first visit of each day finds a delivery at the CEO desk. Click a box to open it.
- A sticker album on "Your office": 24 pixel-art stickers in four rarities (Common, Rare, Epic, and one Legendary).
  Five spare stickers swap for a gift that is rare or better. Two new badges: Collector and Golden duck.
- A gift chip in the top bar that flies the camera to the next waiting gift.

### Changed
- The Codex seat's commands use the `gpt` wrapper when it is installed and the standard `codex` CLI otherwise.
- The week chart is called "Last 7 days" (the weekly challenge stays Monday to Sunday); a tie for star of the week
  names everyone tied; earlier days are titled with their date.

### Fixed
- Ten bugs from the 3.6 QA pass: the tour stranded phones at step 3 (now it scrolls to each target and keeps its card on
  screen), the tour card overflowed phones at large text, Enter on Skip or Back went forward, shortcuts ran under the
  tour, the tour left a hidden inspector open, right-clicking a person gave the browser's menu, Enter on a week bar
  dropped focus, the visit streak stopped at 60, `/api/week` and `/api/history` accepted non-ASCII digits, and the
  weekly hint misstated a target of 5.
- Banter talked about one of the two speakers; a failing news item could stop the rest of a snapshot.

## [3.8.0] - 2026-10-18

### Added
- Install as an app (Chrome and Edge): a web app manifest and icons; an installed office shows the Needs-you count
  on its dock icon.
- Find in a conversation: matches highlighted, other messages faded, Enter and Shift+Enter between matches.
- Save your own lane templates in Hire (up to 12, per browser).
- What's new after an update, once.
- Open a character and someone at their desk says hello in their voice.
- Office news grouped under Just now, Earlier today, Yesterday and dates; the floor legend explains weather, gear and
  unlocks; the morning card shows the weekly challenge.

### Changed
- Reduced motion also holds window weather, the balloon, fireworks and seasonal bats still.

## [3.7.0] - 2026-10-18

### Added
- Gear with a character's level: a team badge (5), caps in the seat's colour (9), sunglasses (13), gold headphones (18).
- A right-click menu on rooms: open, zoom in, hire a lane for that seat, holiday or duty, copy the terminal command.
- A minimap while the floor is zoomed in.
- Chat text renders as safe markdown (escaped first), with a Copy button on code blocks.
- A visit streak by the level chip, and a Regular badge at seven days; confetti in every room on an office level-up.

### Fixed
- Thirteen bugs from the 3.4 QA pass (replay seeking, double replays, replay keys, live news over a replay, combo
  double counting, TV keys, overlaps in TV mode and on phones, UTC dates at the date line, the day card's long names).

## [3.6.0] - 2026-10-18

### Added
- A day ledger (`state/days.json`, 120 days): each day's Today numbers are kept, so earlier days and the week are real.
  `GET /api/week?days=N` serves the last N days (1–90). Yesterday is backfilled from history when missing.
- "This week" in Today: the last seven days as bars, one measure at a time, the change against the week before, the
  best day, the star of the week and the totals.
- The weekly challenge: beat last week's reports by 10%, with a Record week celebration and badge. It waits until the
  office has a week on record.
- The day's rhythm: a morning card recaps yesterday and names today's goals; an evening card wraps the day up.

### Fixed
- Session avatars in Team cards overlapped their text.
- The replay bar wraps on phones; dock cards stop at 440 px wide.

## [3.5.0] - 2026-10-18

### Added
- Seasonal decorations: pumpkins and bats for Halloween, lamps and a rangoli for Diwali, a tree, lights and snow in
  December (Settings to turn off).
- CEO badges: twelve badges for the person at the screen (Inbox zero, Hiring manager, Time traveller, Clean sweep,
  Night owl, …), listed on "Your office".
- A five-step guided tour from the first-visit hint, the menu or the palette.
- Pick each character's personality (voice, room floor and furniture) in Settings, or keep it automatic.
- Banter: characters at their desks trade a line about what is going on.
- A news ticker in TV mode.
- A new set of three daily goals every day, from six kinds at three difficulties.
- JavaScript unit tests for the floor and game logic, run in CI.

## [3.4.0] - 2026-10-18

### Added
- Replay: the floor plays back the last 6 or 24 hours from the office history (60× to 900×), with news firing as it
  happened, a scrubber with the day's events and keyboard control.
- TV mode for a spare screen (`V` or `?tv=1`): the floor full screen with a status strip, a clock and a room tour.
- Office levels from everyone's XP, with eleven unlocks drawn on the floor and a "Your office" page.
- Mood weather: rain in a room's window while its seat is out of plan, clouds while its plan runs low.
- Combos for reports and finished lanes within 15 minutes of each other.
- Today's card: a 1200×630 picture of the day to save or copy.

### Changed
- Calmer frame rate while nothing moves, no painting while the floor is hidden, compositor-only pulses.

### Fixed
- Seven floor bugs from the 3.3.0 QA pass: the room peek off screen under large text, the legend clipped on phones,
  the Needs-you badge count, walkers crossing corner furniture, people jumping when a desk resizes, Esc with the legend
  open, and the peek staying up after a click.
- Character lookups broke on copied seat objects.

## [3.3.0] - 2026-10-17

### Changed
- The floor, reworked: desks sized to the people at them, a floor and a furniture corner per personality, lighter
  walls, brighter lighting, corridors with a runner, a terrazzo lobby with a red carpet and a teal hiring counter, and a
  soft outline around people.
- Nameplates: bigger, with a coloured status chip, a plan bar and a pulsing Needs-you badge.

### Added
- Room peek: hovering a room shows a card with its voice, plans and who is doing what.
- A floor legend behind the `?` camera button.

### Fixed
- The load divider's split bar (a class clash hid its segments), the camera aim and double-click when the inspector was
  hidden, the Career level ring colour, double goal celebrations, the header's Needs-you count, focus after `\`, Esc and
  dismissals, toast position under text zoom, the phone dock news line, the chat hint, the Career tab at narrow widths,
  timeline marker names, and "Waiting for you" shown for a long tool call.

## [3.2.0] - 2026-10-17

### Added
- Full-height desktop layout: the floor, a dock of agents at work and the inspector fill the window; other views
  scroll inside the left column. Laptops and phones keep the stacked layout.
- An adaptive building: two, three or four rooms to a row and taller rooms, chosen to draw the office as large as the
  space allows; it re-plans live as the inspector is resized. Spare cells become gardens; a night-city backdrop
  (following the time of day) fills what is left.
- The dock: one row of agent cards under the floor with the news line in its header; a click opens the chat and flies
  the camera to the desk.
- Spotlight: pointing at a character in the team list or the dock outlines its room; pointing at a room highlights its row.
- Today's goals (reports, tool calls, agent hours) with a celebration when one finishes and a daily streak.
- Text size (Auto, Small, Medium, Large, Extra large); Auto scales the chrome up on wide screens. The inspector's
  width limits grow with it.
- Hide or show the inspector (button or `\`); `1`–`9` open characters.

### Changed
- News in plain words ("finished: ready for review · #1679", "started at Orion's desk", "You updated…").
- "While you were away" is one line that expands; toasts sit at the top of the floor, clear of the dock.

### Fixed
- The chat's typing line read "Atlas is merge PR #482"; it now reads "Atlas · Merge PR #482".

## [3.1.0] - 2026-10-17

### Changed
- The inspector is resizable: a handle between the floor and the inspector (drag, arrow keys, double-click to reset),
  remembered per browser. The briefing and character pages adapt to the width with container queries.
- The briefing is three blocks: status numbers with the next lane, Needs you, and one team row per character.
  The welcome card became a one-time hint on the floor; the latest-news line moved to the floor only.
- Character pages keep the voice and plan rings on top and split the rest into Now, Career and Settings tabs.
- Larger, sentence-case section headings and body text in the inspector; the terminal command wraps instead of
  scrolling; the header line says one sentence (the whole story is in its tooltip).

### Fixed
- The plan chart's future zone and gauge track used an undefined colour and drew as a black block.
- The server room lists failed services first.

## [3.0.0] - 2026-10-17

### Added
- Calm studio interface, seat personalities, moods and a “Right now” briefing; Pixel the office cat.
- Task conversations, messages to live Claude sessions, an office reply inbox and delivery receipts.
- Follow-up lanes that resume finished conversations; messaging all lanes and quick message buttons.
- Careers, XP, levels, achievements, desk upgrades, trophy cabinet and trophy room.
- Office picture export, demo recording and updated screenshots.
- Python 3.10–3.13 CI, JavaScript syntax checks, demo HTTP smoke checks and contributor/security templates.

### Fixed
- Socket symlinks and ownership validation, inbox resource limits and shutdown, malformed records,
  wrapper escaping, early receipt association and credential masking in conversation metadata.
- Follow-ups cannot silently replace messaging to a running session; resume identifiers are validated strictly.
- Transcript reads stay inside project roots; HTTP request framing and origin validation are stricter.
- Lane runners start in the office repository to avoid importing code from a lane's working directory.
- Message delivery labels, conversation depth, UI focus, layering, number clamping and notification errors.

## [2.0.0] - 2026-10-16

### Added
- Living office with a zoomable, pannable camera and walking agents.
- Timeline, Today view, league table and employee of the day.
- Server-sent events, history and statistics, settings and optional voice alerts.
- Demo visitor lane that arrives and departs.

## [1.0.0] - 2026-10-16

### Added
- First pixel office for Claude seats and Codex, with live session and plan usage views.
- Load divider, seat selection, headless office lanes and checkpoints.
- Python standard-library server, vanilla JavaScript page and systemd user installation.
- Loopback HTTP service, token-protected writes and credential redaction.

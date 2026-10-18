# Changelog

All notable changes to Claude Office are documented here, following Keep a Changelog.
Version entries describe the implemented milestones in repository history, not published GitHub releases.

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

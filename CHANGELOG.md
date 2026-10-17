# Changelog

All notable changes to Claude Office are documented here, following Keep a Changelog.
Version entries describe the implemented milestones in repository history, not published GitHub releases.

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

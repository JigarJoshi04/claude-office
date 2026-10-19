# Changelog

All notable changes to Claude Office are documented here, following Keep a Changelog.
Version entries describe the implemented milestones in repository history, not published GitHub releases.

## [3.163.0] - 2026-10-19

### Added
- `claude-office events`: the office's news in a terminal, the last lines and with `--follow` every new one as it
  comes; `--kind` keeps one kind, `--json` prints the records for scripts.
- `claude-office token --rotate` makes a new write token (the old one stops working when the office restarts);
  without `--rotate` it says where the token is kept, never the token itself.
- A plan calendar: Your data → Plan calendar (or the palette) downloads an .ics file with each Claude seat's
  5-hour and weekly resets in the next eight days and, at the pace it runs now, when one would run out first.

### Security
- On start the office makes its folders 0700 and the files in its config and state folders 0600 (links are never
  followed). A new token is written 0600 from its first byte, so it is never readable by others, even briefly.

### Fixed
- The export dialog, the Markdown dialog and the versus card had no side margins; the export dialog now fits its
  report and its downloads in one view.

## [3.162.0] - 2026-10-19

### Fixed (QA round 23)
- Continue on another seat never showed: a terminal session out of plan was folded into the seat's "out of plan"
  row. It keeps its own row now (lanes move on by themselves), Continue works for a session without a message
  socket, it refuses a seat that cannot see the conversation, and a retry carries on the fork instead of forking again.
- Why it ran out could blame the wrong sessions: a session whose counter fell when its transcript was read again,
  or one resumed with a long past, was counted wrongly. Only what each session added minute by minute counts. A
  lockout older than the day the history keeps says so, and a busiest hour of 0% is not shown.
- The game save: an office copy older than this screen's (a reply that crossed this screen's write, or an office
  that lost its save to a stale screen) no longer undoes anything; a conflict merges against the base as it is after
  the wait, and no pull runs while a write is in flight. Saving a template no longer cuts the list back to 12.
- Lanes: a warm hand-off is used once (a restart or a resume starts from the notes), a run's limit check reads only
  its own output (an old limit line no longer benches a seat for hours), a stopped lane records when, re-hiring a
  worktree lane starts from its repository, a failed worktree hire removes its branch, a worktree hired from inside
  another goes beside the main checkout, and a bake-off that could not start is not offered for judging.
- A report that does not claim the work done (FAILED, PARTIAL, NOT DONE) no longer keeps a promise or counts as done
  in the brief coach.
- The nudge is for stuck or looping sessions only, a new stuck spell starts at the nudge again, and "1 minute".
- Share-safe: `top` hides stuck, loop, blocked and cut-off sessions' names and its prompts; timeline markers,
  session rows and replay ticks show kinds only; the lanes board's Find is off.
- The lanes board no longer scrambles typing in Find when lanes change, its times move on, and its filters keep the
  keyboard. Stopped and cut-off lanes show when they ended.
- An escaped quote (`it\'s`) no longer hides the rest of a command from the session reader (3.147).
- The token ledger keeps a slow tool call across its scans, skips a tool id that is not text, and a synthetic first
  reply no longer leaves a session out of start-up weight.
- One gift per level up, merged PR, kept promise and milestone, however many screens are open; team stickers only
  with two characters or more; the chapter badge comes with tier 30 even when a vault key lands with it, and a screen
  a day behind never rewinds the chapter.
- A bake-off is not promised (one contender would break it); templates clear the brief coach.
- The spend log masks before it shortens, the tools card never says "1 min 60 s", and hatched days on the plan
  chart open like the others.

## [3.161.0] - 2026-10-19

### Added
- The versus card: two characters head to head over the last seven days (tokens, API value, commits, PRs merged,
  sessions and fresh tokens a commit), a tick for whoever leads each row and the score, on a picture to save or copy.
  From a character's Career tab or Ctrl+K; names, levels and counts only, so it is safe to share.

## [3.160.0] - 2026-10-19

### Added
- The steering log, on the tokens page: the turns you interrupted (Esc), the conversations compacted to make room
  and the replies the model refused, for the range and per character. The ledger reads its transcripts once more.

## [3.159.0] - 2026-10-19

### Added
- A price tag before you hire: Sharpen the brief now also says what a job like it costs the seat it would go to,
  as a share of that seat's 5-hour window and week, from the similar lanes' typical fresh tokens and what 1% of the
  seat's plan bought lately (the exchange rate).

## [3.158.0] - 2026-10-19

### Added
- The plan's exchange rate, on a character's page: how many fresh tokens 1% of its 5-hour window, and of its week,
  bought over the last day (the tokens its sessions spent against the points its windows rose, resets left out;
  shown once it has three points to go on).

### Fixed
- The rate first counted only the tokens of the minutes a usage reading moved, which come every few minutes, so it
  read far too low (and the week no dearer than the 5-hour window). Every minute's tokens count now.

## [3.157.0] - 2026-10-19

### Added
- Wear and tear: a long session leaves its desk messier, with crumpled paper after two hours, a cold cup after four
  and a takeaway box after eight.
- The moon in the night windows is tonight's real one, waxing, full or waning, from the date.

## [3.156.0] - 2026-10-19

### Added
- Export a conversation: a Claude session's Chat has Export, the conversation as Markdown (its brief, the messages
  with their times, the steps between them as short lists, credentials masked), to copy or save.
- A lane's handoff pack: its status and trust verdict, seat and model, folder and branch, tokens and what it
  shipped, then the brief, the report, its notes and its runs, as Markdown to pass on.

## [3.155.0] - 2026-10-19

### Added
- The connection's weather. API errors that sessions meet (the service failing or overloaded, the connection
  dropping, a login expiring; not usage limits, which are the plan) are read from the transcripts. With one or two in
  the last half hour an "API cloudy" chip shows in the header; with three or more it is "API stormy" and a storm
  (rain and lightning) passes over every window on the floor. The tokens page counts them per kind and per day. The
  ledger reads its transcripts once more. The demo shows the storm with `?storm=1`.

## [3.154.0] - 2026-10-19

### Added
- The week chart on Today measures Tokens and API value too, from the token ledger (every transcript, so the days
  before the office's own day records count), with the change on the week before.

## [3.153.0] - 2026-10-19

### Added
- Your data (Export on Today, or Ctrl+K): the month's report in Markdown for a status update (reports, hours,
  sessions, tokens and their list price, what shipped, limits hit, promises kept, who did what, the best days and
  the lanes finished), any month back, to copy or save; and downloads of the days per character, careers, tokens per
  day and character, lanes (CSV) and the news (JSON). They need the office token, cells a spreadsheet could run are
  quoted, and share-safe leaves out titles, reports and news text.

## [3.152.0] - 2026-10-19

### Added
- Ctrl+K takes verbs: `msg <who> <text>` (a live session on that character, or one whose name has the word), `stop
  <lane>` and `resume <lane>`. Each match is its own row naming the exact session or lane, so Enter on it is the
  confirmation (stopping asks once more). Share-safe keeps terminal sessions' names out of the rows.
- With nothing typed, what you used most recently comes first, marked recent. The search is a proper combobox for
  screen readers, which follow the selection.

## [3.151.0] - 2026-10-19

### Added
- Warm hand-offs. A lane can be told, on the hiring desk, to carry on the same conversation on the next seat when its
  seat hits a limit, instead of starting fresh from its notes (the new seat re-reads the whole conversation into its
  cache, so it costs more). It falls back to a fresh start when the next seat cannot see the transcript.
- Continue on another seat: a terminal session stopped by its usage limit gets a Continue on <name> button in Needs
  you. It copies the conversation into a new session on the divider's pick (Claude Code's --fork-session, so the
  original stays where it is) and carries on there as a lane.

## [3.150.0] - 2026-10-19

### Added
- Chapters. Every six weeks a free 30-tier track, filled by the XP the whole team earns from real work. Each tier
  brings a gift (rare every fifth, epic at 15 and 25, and at 30 the chapter's trophy, an epic gift and the Chapter
  complete badge); past tier 30 every 25,000 XP is a vault key, another rare gift. The briefing shows the chapter,
  its tiers and what the next one brings. A chapter's start and the tiers claimed are kept in the game save, so every
  screen counts from the same XP and no tier's gift is given twice.

## [3.149.0] - 2026-10-19

### Added
- The lanes board (L, or the Lanes tab): every office lane as a card in four columns, up next, at work, needs you
  and done, each with its character, model, how long, its report's first line and tags (trust verdict, promise,
  bake-off side, own worktree, chain stage, tokens). Find by title or report, filter by character and model, and
  finished lanes older than a week are archived unless you show them. A card opens its lane; backlog cards move to
  the front and cut-off or failed ones resume in place.

## [3.148.0] - 2026-10-19

### Added
- A lane in its own git worktree. A switch on the hiring desk gives the lane a new branch (`lane/<id>`) checked out
  beside the repository (`<repo>.lanes/<id>`, never inside it, where tests and searches would find the copy), and the
  lane works at the same place inside the copy. A list hire gives each lane its own. The lane's page names the branch
  and how to remove the worktree; it stays when the lane is done. The lane policy applies to the copy too.
- The hiring desk's collision guard: when live sessions wrote in the working tree of the chosen folder lately, it
  says who, and suggests a worktree or another folder.

## [3.147.0] - 2026-10-19

### Fixed (QA round 22)
- The game save could bring back what another screen removed: a gift opened on one screen came back from another
  and could be opened twice, and removed templates returned. Gifts opened on any screen are now kept in the save for
  every screen, a removal elsewhere is never undone, and once-a-day or once-a-week gifts (the morning delivery, all
  goals, a record week, a quest, an office level) have fixed ids, so two screens never both give one.
- Counters in the save (stickers, counts, freezes) could be added twice when a reply was lost, a write was slow or
  an older tab sent it. Each write carries the screen that made it, so the office's copy of this screen's own write
  is never added again, and writes go one at a time. Screens in view merge every minute, an office that lost its
  save gets it back from the next screen, and the template cap no longer drops this screen's own.
- A lane that exited without a report kept its promise; it needs its DONE report now. Share-safe hid promise titles
  nowhere (news, Needs you, notifications); it does now. "Promise it by" is honoured for bake-offs and list hires.
  Today 6 pm and Monday 10 am mean today when there is time; an unseated lane's promise no longer opens a seat
  called auto; the Reliable badge comes with the fifth kept promise; Help's Show me opens the briefing.
- The analyst's spend log kept a coached brief's credentials in clear; they are masked.
- A `>` inside quotes hid later commands from the session reader (`echo "==>" && pytest` missed the test run), since
  3.135. Quotes and redirect targets are read in one pass.
- `claude-office top` in share-safe still showed some lane titles, commands and activities.
- What leaves this machine did not refresh while Settings was open; it has its own clock now.
- The brief coach: Undo puts back what was typed, the panel clears with a new draft, buttons keep keyboard focus,
  medians need three lanes, and a report that does not claim done is not counted as done.
- Standup mode opened with focus on End, so Space ended it.
- A bake-off whose second contender could not start left the first running alone; both stop now.
- Egress counts are kept at exit, and damaged egress or utilities files no longer break the snapshot.
- The prompt cache card says rebuilds are not measured for Codex; rebuild cost counts fast mode and regional prices.
- The week chart's plan measure hatches days without readings, and its tooltips give the share.
- Starting a bake-off showed an error toast after it started.

## [3.146.0] - 2026-10-19

### Added
- Start-up weight, on the tokens page: the whole prompt of each session's first response (Claude Code's system prompt
  and tools, the MCP servers' tools, CLAUDE.md and the first message), as a typical size and a total for the range,
  and per character, since seats with more MCP servers start heavier. The ledger reads its transcripts once more.

### Fixed
- The utilities' first disk reading started with the office and could write its state while the folder was being
  replaced (a flaky test); it starts half a minute in and never makes the state folder again.

## [3.145.0] - 2026-10-19

### Added
- The team set. A gift from a character holds that character's own sticker one time in four, drawn in its colour;
  the album has a Team row with one slot per character, and when every character on the floor is in, the team photo
  hangs in the lounge (and the gift reveal says so). Team stickers count as rare and are never swapped as spares.
  The demo's `?stickers=all` fills the team set too.

## [3.144.0] - 2026-10-19

### Added
- Where the time goes, on the tokens page: each tool's calls in the range, from the call to its result, with the time
  in all, the average and the longest, slowest first; MCP tools grouped by their server and helpers (Agent) on their
  own. Main conversations only; a call left open more than four hours is not counted, and in a terminal the time
  includes waiting for approval. The ledger reads its transcripts once more to count them.

## [3.143.0] - 2026-10-19

### Added
- The help desk on the floor. When a session goes quiet in the background, files a blocked or contradicted report,
  or the CEO nudges it, an IT helper with a toolbox comes up in the elevator, walks to that room, offers a hand and
  goes back down. One at a time, each room at most once in ten minutes; full game intensity only. The demo shows it
  with `?help=1`.

### Fixed
- Collab visitors were drawn carrying a parcel (the courier's box); and they now stand above the room's name plate.

## [3.142.0] - 2026-10-19

### Added
- The stuck rescuer. A session that has gone quiet in the background, or keeps making the same call, gets a ladder
  in Needs you: Nudge it sends a standard note saying what the office sees and what to do (write the STATE notes, then
  carry on or report BLOCKED); the item then says when it was nudged, and if an office lane is still stuck ten minutes
  later the next step is Restart it, which stops the lane and starts it again from its notes. A terminal session's
  nudge waits for approval there, as every office message does.

## [3.141.0] - 2026-10-19

### Added
- Collab visits on the floor. When two characters have people at work in the same repository, every few minutes one
  of them walks over to the other's room (along the corridor, through the lobby only between rows), stands a moment
  with a line ("Got a minute on billing?", "Mind if I look at your diff?") and walks back. Full game intensity only,
  never in replay or reduced motion; share-safe leaves out the repository. The demo shows one with `?visit=1`.

## [3.140.1] - 2026-10-19

### Fixed
- Why it ran out counted from five hours back even when the window had reset in between, so the chart began at 100%,
  the fill rate read 0% an hour and sessions from the window before were counted. It starts at the window's reset.
- Its busiest hour was counted in UTC hours, so it could read "from 4:30" where the clock is not on UTC.

## [3.140.0] - 2026-10-19

### Added
- Why it ran out, on a character's page for a day after it runs out of plan: when, how fast its window filled against
  the pace that lasts a whole window, its busiest hour, a chart of the window filling, and which sessions burned the
  fresh tokens in the five hours before, with what would have spread the load. From the office's own minute history.

## [3.139.0] - 2026-10-19

### Added
- Promises. Promise a lane's work by a time (in 2 hours, today at 6 pm, tomorrow, Friday, Monday) from its page or the
  hiring desk. The lane's own report keeps the promise: kept when it, or the last stage of its chain, reports done
  before the time; broken when the time passes first (a blocked report does not break it while there is time to
  resume). A promise due within two hours on work still out shows in Needs you, a kept one brings a rare gift and the
  Word kept and Reliable badges, and the briefing keeps the record: kept of made, and how many in a row. The office
  keeps promises for every screen.

### Fixed
- Typing in the hiring desk's brief dropped the bake-off switch from the saved draft.

## [3.138.0] - 2026-10-19

### Added
- The prompt cache, on the tokens page: how much of the input came from the cache, and the cold rebuilds — a session
  coming back after its cache expired (5 minutes, or an hour on 1-hour caching) writes its whole conversation to the
  cache again. Each is counted with the tokens written and what it cost over a warm cache at list prices, for the
  office and per character. Main conversations only; the ledger reads its transcripts once more to count them.

## [3.137.0] - 2026-10-19

### Added
- Save notes before a limit (Settings → Automation, off until turned on). When a seat is about to run out of its
  5-hour window or its week at the pace it is going (5 to 30 minutes ahead, or nearly full), the office asks each lane
  working on it to write its STATE notes now: what is done, what is in progress and the exact next step, so the seat
  that picks the lane up next loses nothing. Only lanes that take the office's messages directly are asked, each once
  per window, and the news says who was asked.

## [3.136.0] - 2026-10-19

### Fixed
- The Team view lost keyboard focus every few seconds as sessions moved; it keeps it now. News, unlock and away rows
  that share a character found focus again on that character's first row; they find the same row.
- Standup mode's buttons ignored Enter and Space.
- Help's "Show me" for Tokens opened the briefing instead of the Tokens page, and a Help topic opened from Ctrl+K could
  be hidden by an old search.
- Removing a scrapbook photo also removed others that shared its id (albums from before 3.125).
- What leaves this machine showed the counts from when the page was loaded; it refreshes each minute Settings is open.
- "Remember when you covered my limit?" played between teammates who never covered one.
- A seasonal sticker opened with the common chime.
- Fonts were fetched again on every load; they are kept for a week.

## [3.135.0] - 2026-10-19

### Fixed
- A seat could be its own closest teammate when one seat's id starts another's (claude in claude|claude2).
- A bake-off with a bad contender B started contender A anyway behind the error, and an empty title and brief were
  accepted. Both contenders are now checked first, and both written down before either starts.
- A quoted write to a lane's STATE or REPORT notes (`echo … >> "/x/STATE.md"`) counted as a code change, so a passing
  report read Unverified.
- Shipped showed a quiet commit's whole message, and Claude Code's own `-m "$(cat <<'EOF' …)"` form as `$(cat )`. It
  shows the subject line, and subjects and branches are masked like everything else. The ledger reads its transcripts
  once more.
- The risky-action watch skips the options of `env -i/-u`, `time -p`, `xargs -0/-n`, `stdbuf -oL` and `ionice -c3`,
  and finds a database client anywhere in a command (`docker exec … psql`, `kubectl exec … -- psql`).
- `claude-office top` in share-safe showed bake-off titles, collision repositories and lane titles; it uses share-safe
  words for them now, and nicknames for seats.
- Disk growth per day divided by the number of readings instead of the days between them.
- What leaves this machine counted calls up to a cap of 5,000, forgot them at a restart and left out timed-out calls.
  It counts per hour now, keeps the counts across restarts, and counts a timeout as a failed call.

## [3.134.0] - 2026-10-19

### Fixed
- Credentials after a prefix were shown in clear again since 3.125 (`PGPASSWORD=…`, `authToken=…`, `clientSecret: …`,
  `"SessionToken": …`) in risk alerts, notifications and activity lines. They are masked again.
- The game save no longer loses anything between screens. Each screen keeps the office's copy it last saw and merges
  three ways, so what it changed goes on top of what the others did: templates, gifts and the mailroom keep everyone's
  additions and removals, a sticker swapped away stays swapped and two screens' finds add up, and the visit streak
  joins. A browser's own progress from before the save survives its first sync. A write carries the version it was
  based on; the office refuses a stale one with its copy, and the screen merges and sends again. Screens merge again
  when they come back into view, unchanged values are not sent, and importing an older save keeps the streak.

## [3.133.0] - 2026-10-19

### Added
- Plan in use: of the minutes a seat had plan left and could take work, the share someone was at work on it. Today
  shows it as a tile (with the seat that sat idle longest with plan left), the League as a column per seat, and the
  week chart as a measure pooled over the week's minutes that moves by points. Counted while the office runs.

## [3.132.0] - 2026-10-19

### Added
- Gets the most done: the tokens page's leaderboard switches between who burns the most and who ships the most per
  token, ranked by fresh tokens (input, cache writes, output) per commit or merged PR, among characters past a million
  tokens in the range. The leanest wears a ribbon; each row shows what it shipped and its cache share. Codex is listed
  apart, since it counts its tokens its own way, and characters with nothing shipped are listed last.

## [3.131.0] - 2026-10-19

### Fixed
- The brief coach found almost no similar lanes among real, long briefs: plain word overlap rated a lane sharing most
  of a brief's words near zero. It now measures how much of the new brief a past one covers, weighting rare words above
  ones every brief has, and blends in how alike the titles are, so a long brief does not outrank the same kind of job.
  Short words such as QA, UI and PR count.

## [3.130.0] - 2026-10-19

### Added
- The brief coach. Sharpen the brief on the hiring desk to see how big jobs like it have been: the finished lanes whose
  briefs share the most words with it, how long they ran, the tokens they took, how they ended and on which model
  (medians from three or more). This part is counted, not asked, and works with the analyst off. With the analyst on,
  it also reads the brief and says what is missing, vague, risky or too big, suggests a model with a reason, and
  offers a tighter brief as a word diff (or whole, when mostly rewritten). Nothing on the form changes until you pick
  it, and Undo puts your brief back. Only the brief and past lanes' titles and outcomes are sent, never their briefs.

## [3.129.0] - 2026-10-19

### Fixed
- Shipped could take a quiet commit's subject from text inside a script or file the same command wrote; it now reads
  the command itself. The ledger reads its transcripts once more.

## [3.128.0] - 2026-10-19

### Fixed
- Shipped missed every quiet commit (`git commit -q` prints no "[branch sha] subject" line, and agents commit that
  way): the subject now comes from the command's own message. A busy session keeps its newest 60 items a day (not its
  first 40). The ledger reads its transcripts once more.

## [3.127.0] - 2026-10-19

### Added
- Shipped, item by item: the Today view lists what the agents shipped that day, per project: each commit's short sha
  and subject, each PR opened with its title, each PR merged, and who did it (read from the transcripts, as the
  counts are). Share-safe keeps to counts. `GET /api/shipped?day=YYYY-MM-DD`. The ledger reads its transcripts again
  once to fill in the days still on disk.

## [3.126.0] - 2026-10-19

### Added
- Utilities, in the Server room: the memory the AI team uses right now (each live session with everything it started,
  per character, against what the machine has free), and its files on disk by kind (Claude Code transcripts counted
  once however many seats share them, Codex rollouts, file history, the office's own state) with the free space and
  how fast it grows a day over the last month. Memory is read every half minute, disk every ten minutes on a
  low-priority thread. Read only: the page points at Claude Code's `cleanupPeriodDays` rather than deleting anything.

## [3.125.0] - 2026-10-19

### Fixed
- Opening a scrapbook photo broke every other dialog until a reload; the arrow keys worked once; the last photo
  could not be removed and two photos could share an id; share-safe now hides captions in labels too.
- Codex risk alerts could show a patch's contents (a private key) and missed most patched files: escaped patches are
  read line by line, and Codex risks keep their own ids across restarts (no repeat after Seen).
- The risk rules missed commands with something in front (`AWS_PROFILE=… aws …`, `sudo -E`, `timeout 600`,
  `then git push -f`, `docker exec db psql …`), flagged "curl … | bash" inside a commit message, and flagged SQL that
  was not sent to the database client.
- Trust: a verdict never updated (a report that turned Verified stayed Contradicted in Needs you); a report written
  just before its session left got no news or verdict (how lanes end); a test run in the background read as passed;
  shell writes to STATE.md or REPORT.md, and stderr redirects, counted as code changes; "STATUS: FAILED - could not
  complete" was read as a claim of done; a jest test named "… when 1 failed" read as a failing run.
- The collision alarm compared files across repositories and outside any repository, and a folder that became a
  repository was never seen.
- `claude-office top` spun at 100% CPU after a prompt, crashed on multi-line text in a small terminal, could pick a
  session it did not show, and printed seat ids instead of names.
- Credentials: AWS secret keys in JSON and in `aws configure set` were not masked; masking was slow on long text and
  hid harmless things (`input_tokens: 1234567`, `docker run -u 1000:1000`, `localhost:5173/@vite`).
- The per-model hint promised a re-route for pinned lanes and used a fixed 90%; a lane pinned to a seat whose model
  week is spent now waits.
- "First one in" fired with the office full and before the night shift ended.
- Standup mode: keys reached the page underneath, a second open stacked a second deck, pause restarted the slide, and
  the count included summary lines.
- The away brief gave up when the divider's pick was too busy for the analyst, left out queued lanes, accepted a
  non-number `since`, and its list showed words in share-safe.
- A lane blocked by the policy could not be resumed after the policy changed.
- Smaller: the contradicted report's notification title, collision and bake-off items in share-safe, "100+ of yours
  open", Codex commands quoted as the shell sees them, `git --no-pager -C x push` read as shipping, pets cutting
  through walls when called mid-walk, Daily Squash runs across midnight and the cabinet after midnight, o3/o4 named on
  the hover card.

## [3.124.0] - 2026-10-19

### Added
- Help: sixteen short topics on how the office works (seats and plan windows, Needs you, lanes, the divider, talking
  to a session, tokens, the trust check, the risky-action watch, the analyst, the game, share-safe, screens and clips,
  what leaves the machine, the terminal, the keyboard), searchable, each with Show me where there is a page for it.
  From the briefing's links, `#help`, or Ctrl+K ("Help: …").

## [3.123.0] - 2026-10-19

### Added
- One save for your game, kept by the office: the sticker album, badges, gifts and the mailroom, streaks and goal
  days, quest stamps, Bug Squash bests, hire templates and the rest of your progress are the same on the desktop, the
  TV screen and the phone. Each change goes to the office; on load each screen merges in what the office keeps (adding
  up stickers, badges, goal days, quest stamps and bests, the newer write otherwise) and reloads once if anything
  changed. Layout, drafts and dismissed cards stay per screen. Settings → Your data exports the save to a file and
  merges one back in. `GET/POST /api/save`, kept in `state/save.json`.

## [3.122.0] - 2026-10-19

### Added
- Bake-offs: one brief, two contenders. Tick Bake-off on the hiring desk and pick a second seat and model: two lanes
  get the same brief, each told to work on its own branch in its own worktree (bakeoff/<id>-a and -b) and to lead its
  report with a one-line summary. When both have reported, Needs you asks for a verdict; the bake-off's page shows
  them side by side (who, model, status and trust check, time taken, cost, commits, the report) with A wins, B wins
  or a tie. The verdict goes in the news. `POST /api/lanes/bakeoff` and `/api/lanes/bakeoff/judge`.

## [3.121.0] - 2026-10-19

### Changed
- The page fetches nothing from elsewhere: its three fonts (Inter, JetBrains Mono, Silkscreen; SIL Open Font License,
  in `web/fonts/` with their licences) are served by the office, and the Content-Security-Policy now allows fonts
  and styles from the office only. Opening the office no longer contacts Google.

### Added
- What leaves this machine: Settings lists the office's own outbound calls of the last day, by kind, with counts,
  failures and when the last one was: plan usage readings (Anthropic), pull requests, checks and review comments
  (GitHub through gh), and the analyst's questions when it is on. `GET /api/egress`.

## [3.120.0] - 2026-10-19

### Added
- Clips of the floor: record 15 seconds of the office as it is, or today's timelapse (the last 24 hours played back
  at speed and recorded end to end, about a minute), saved as a .webm. From the menu or Ctrl+K; a red REC badge
  counts the time and stops it early. Only the pixel floor is recorded (names and bubbles are not in the video), and
  nothing leaves the machine. Chrome and Edge.

## [3.119.0] - 2026-10-19

### Added
- The morning standup, on the floor. On the day's first visit between 5 and 11, a "Morning standup" banner calls
  everyone on duty to the lounge: each character walks out of their room and down the corridors, they line up by the
  lounge door, each says what they did yesterday (reports and hours at work) in turn, and everyone walks back. Once a
  day per browser, at Full game intensity; Ctrl+K "Standup on the floor" runs it any time.

## [3.118.0] - 2026-10-19

### Added
- Teammate bonds, from real shared history: two characters grow closer for every half hour they work in the same
  repository (not merely at the same time), for reports filed within 15 minutes of each other, and when one takes
  over a lane the other's limit cut short. Bonds go Teammates, Good friends, Best friends (at 10, 30 and 80
  points), with confetti and a toast; each character's Career tab shows its closest teammate and why, and bonded
  pairs chat more, about each other.

## [3.117.0] - 2026-10-19

### Added
- Seasonal stickers: a pumpkin for Halloween, a diya for Diwali, and a snowflake and a firework for the winter
  holidays. In its season one gift in five is that season's sticker (they count as rare), and they come back every
  year; the album has a fifth set, "Through the year", that says which season is on now.

## [3.116.0] - 2026-10-19

### Fixed
- The office in words works from the keyboard: the Team view (the floor as text: each character, their plan left and
  who is doing what) had characters and sessions you could only click. They, the news rows and the trophy rows are
  buttons now: Tab reaches them, Enter or Space opens them, with a visible focus ring and a spoken name.
- The review queue says "50+ of yours open" when the search hit its limit.

## [3.115.0] - 2026-10-19

### Added
- Your review queue: the briefing lists the open PRs that ask for your review (newest first, from `gh search`, every
  ten minutes) and how many of your own PRs are open. Each has Open and Reviewer, which fills the hiring desk with a
  read-only review brief (in a local clone when the office knows one): read the PR, run what covers it in a worktree,
  and write the review as the report, never posting, pushing or merging. Share-safe shows numbers only.

## [3.114.0] - 2026-10-19

### Added
- Standup mode: the morning's standup as a two-minute story for a screen share. Five big slides over the live floor
  (the day and the team, yesterday, today, what needs a decision, who carried it), twenty seconds each with a
  progress bar; space or the arrows move, P pauses, Esc ends it. From the standup dialog (Present) or Ctrl+K
  (Standup mode). Share-safe shows counts only.

## [3.113.0] - 2026-10-19

### Fixed
- Risky actions: the page now plays the bad sound, shows a toast and a desktop notification (and the voice says it,
  on by default for this kind); an item stays in Needs you after its session ends, until Seen or 12 hours; every
  risky call is announced, not only the last five; Codex sessions are watched too (shell calls and patched files).
- Risk rules read each command's words instead of long regexes, so they no longer backtrack for seconds on long
  lines, and they now catch `aws --profile … terminate-instances`, `aws s3 rb`, SQL sent to a database client in a
  heredoc, commands after `<<EOF` on the same line, scripts run with `bash -c`/`sh -c` or sent over `ssh`,
  `bash -c "$(curl …)"` and `bash <(curl …)`, and shell writes (`>>`, `cp`, `tee`) to `.env`, `~/.ssh`, start-up
  files and Claude Code's settings. No longer flagged: `git rm -r --cached`, `terraform plan -destroy`,
  `kubectl auth can-i delete`, a grep for "DROP TABLE".
- Credentials masked in more places: AWS secret keys, `mysql -p…`, `curl -u user:pass`, and passwords in URLs.
- A failing vitest or Playwright run (`1 failed | 41 passed`) read as passed since 3.103.
- A lane whose time limit ran out while it waited for a seat was started anyway; the lane policy was only checked at
  hire time, so a resumed, backlog or scheduled lane could run with full trust outside the allowed folders.
- Review comments: the count stopped at six, PRs with the same number in two repositories became one item, and one
  failed `gh` read hid the comments for five minutes.
- Phases: `git -C <dir> commit` and `cat > file <<EOF` read wrong; `find -delete` and `gh pr comment` read as looking.
- Ask about it lost "Reading…" on the next refresh (inviting a second, paid question), and could send one account's
  transcript through another seat.
- `memory_max` of "0" capped lanes at zero (now no cap); "8g" was ignored.
- PR-merged reminders can name their repository (`owner/name#12`, and a bell on each open PR on the shelf), so
  another repository's #12 never sets them off.

## [3.112.0] - 2026-10-19

### Added
- `claude-office top`: the office in a terminal, for SSH and tmux. Seats with their 5-hour and weekly plan left, what
  needs you, every live session with its phase and what it is doing, the lanes still out and the latest news,
  refreshed every two seconds. Up and down pick a session, m messages it, s stops its lane (after you type yes), p
  is share-safe, q quits. Standard library curses, no install.

## [3.111.0] - 2026-10-19

### Added
- The same-repo collision alarm. When two live sessions have written files in the same git working tree in the last
  15 minutes, Needs you says so ("api-rate-limits and checkout-tests are both editing apollo right now"), as bad news
  when they wrote the same file, with a news line once an hour. Lanes in their own worktrees never collide; files
  outside a repository are left out, and no file path reaches the page (files are compared by a short hash).

## [3.110.0] - 2026-10-19

### Added
- Per-model weekly limits. When a plan caps a model's week on its own (Opus, say), the seat's page shows each
  model's bar, how much of it is used and when it resets. The hiring desk warns when the chosen model's week is past
  60% on the chosen seat (or the divider's pick), and says the divider will send the lane elsewhere past the guard.

## [3.109.0] - 2026-10-19

### Added
- Daily Squash. Bug Squash has a Daily run: the same bugs, in the same places, for everyone all day (seeded by the
  date), beside free play. Each day's best Daily run is kept for 30 days, shown as two weeks of bars with your run of
  days in a row, and today's best glows on the lounge's arcade cabinet. The game pauses with P or a button.

## [3.108.0] - 2026-10-19

### Added
- The scrapbook: the office's big moments as captioned polaroids. A character's level-up or trophy is photographed
  in their room a moment after it happens, confetti and all; an office level or a day with every goal done is a
  photo of the whole floor. Flip through them from Trophies or Ctrl+K (Scrapbook), full size with the arrow keys,
  and remove any you do not want. Kept in this browser, the newest 36; share-safe shows only what kind of moment.

## [3.107.0] - 2026-10-19

### Added
- The night shift. From 9 pm the empty rooms switch their lights off one by one (one every six minutes), a janitor
  mops the corridors one after another until 6 am, leaving a wet shine, and in the morning the first session to sit
  down gets a "First one in" banner (once a day, not when game intensity is Off).

## [3.106.0] - 2026-10-19

### Added
- Pets with routines. Pixel the cat now and then walks into the room burning the most tokens this hour and naps by
  the warmest desk; Biscuit the dog walks a newcomer from the elevator to their room; and whoever ships a PR or files
  a good report gets a visit from both, with a little heart. Pets go in and out through the doors, like everyone.
- Which model sits at a desk: each desk's name tag carries the model's colour (Opus purple, Sonnet blue, Haiku green,
  Fable gold, Codex teal), the room's hover card names it, and Haiku types faster.

## [3.105.0] - 2026-10-19

### Added
- "While you were away", written for you. With the office analyst on, the away card leads with a headline, what
  needs your decision now (at most three lines) and what got done (at most four), with the routine news (sessions
  coming and going, usage readings, commits) folded into a count. The counts and the full list stay under "What
  happened"; share-safe shows only the counts. Off, the card is as before.

## [3.104.0] - 2026-10-19

### Added
- Trust check on reports. When a session or lane reports DONE (or READY, COMPLETE, SHIPPED…), the office compares the
  claim with its own transcript: its last test run passed after its last code change is Verified; failed is
  Contradicted; no test run seen, or code changed after the last pass, is Unverified. The verdict and why show above
  the report on the session and lane pages and on the lane list, the report news says it, and a Contradicted claim
  lands in Needs you for 12 hours (opening the lane when its session has gone). No AI; verdicts are kept in
  `state/trust.json`.

## [3.103.0] - 2026-10-19

### Fixed
- A long Bash command full of `<<` (C++'s `cout << x`, a shift in a Python one-liner) could freeze the office for
  seconds to minutes: the heredoc regex backtracked. Heredocs are now taken out in one pass, shared by the desks'
  screens, the risky-action watch and the token ledger (a 38 KB command: from minutes to 25 ms).
- Share-safe: the Goodnight dialog showed what needs you word for word (and seat ids); News rows for questions, usage
  limits and messages named the session; a lane event with no seat read "The office office lane news".
- "For each": a single line left `{{item}}` in the title and brief; when hires failed it still said "0 lanes in the
  backlog", played the hire sound, gave the badge and wiped the list. Failed lines now stay in the list.
- Quests: a week that spans two months was stamped (and gifted) twice.
- The director cam took the camera back after the CEO picked a person, a session or Zoom to fit.
- Touch: after a long press, the next tap was swallowed; on Chrome for Android the room menu opened twice.
- The backlog: older backlog lanes could drop out of the list (only the 40 most recent were listed), and "Nth in
  line" counted within what was shown. Every unfinished lane stays listed, with its place from the server.
- Failover walks: a lane whose old and new sessions changed in the same refresh got two workers; a worker already
  walking out snapped back to the chair when the lane came back late.
- Reminders from the palette: "in 48 hours" and a time that rolled to tomorrow showed no day; "at 5" at 6 pm meant
  5 in the morning without saying so. A bare hour is the next one coming up, and the list shows the day.
- The 7-day forecast called a stretch dry while a Codex seat, or a seat with no weekly reading, was on duty.
- "OK (expected failures=1)" and "2 failed attempts" turned the desk's test light red.
- "Move to the front" could undo a lane the scheduler had just started.
- Goodnight and Lights on are in the menu (the hint pointed there); G before the first refresh no longer throws.
- A reminder for PR #12 fired when another repository's #12 had merged long before.
- "Fix the checks" briefs named `gh run view --log-failed` without a run id, which fails outside a terminal.
- The palette's "hire …" replaced a draft's title without asking; it now asks and lands on the brief.
- Copy: the capacity card's colours, and the seat bell (the plan back may be the week, not the 5-hour window).

## [3.102.0] - 2026-10-19

### Added
- Each working session has a phase: exploring, building, testing, debugging or wrapping up, read from its last few
  steps (reading and searching, editing and running, a test run and whether it passed, a commit, push, PR or report).
  No AI and nothing sent: it shows on the Right-now cards and as a coloured pill on the session page.

## [3.101.0] - 2026-10-19

### Added
- The office analyst: an opt-in engine for features that need reading rather than counting. Off by default; when on,
  it runs `claude -p` on a seat with plan left (Haiku, or Sonnet if you pick it) with every customisation off
  (`--safe-mode`), no tools and no saved session, so it can only answer. It keeps to a daily token budget (300k by
  default), caches answers for a day, never runs on a seat past 85% of its 5-hour window, and Settings shows today's
  spend and what was sent. Its processes never appear on the floor or count as lanes.
- Ask about it: a question box on any Claude session's Chat tab ("did it run the tests?", "what did it change in
  the API?"). The office reads the transcript into a numbered digest (prompts, replies, tool calls and the start and
  end of each result, credentials masked), the analyst answers from that alone on the session's own seat, and the
  answer cites the entries it relied on. The session is never told. Needs "Let it read transcripts" in Settings.

## [3.100.0] - 2026-10-19

### Added
- The risky-action watch. When any session force-pushes, runs `rm -r` on / , the home folder, a parent folder or an
  absolute path outside the temp folders, applies or destroys infrastructure (terraform, kubectl delete, helm
  uninstall), deletes cloud resources, drops a table through a database client, pipes a download into a shell, puts a
  real credential on a command line, or writes a secrets file, `~/.ssh`, a shell start-up file or Claude Code's
  settings, it lands in Needs you within seconds with the command (credentials masked), as bad news with a sound and
  a voice line if voice is on. Seen hides it on every screen. The session's Overview lists its risky actions.
- Settings has a toggle per kind; admin merges (`gh pr merge --admin`) are off until turned on. Calls already
  announced are remembered across restarts, and ones that happened while the office was down are noted, not
  announced. Commit messages, heredoc bodies and JSON payloads are not read as commands.

## [3.99.0] - 2026-10-19

### Added
- A lane safety policy (`lane_policy` in config.json). `roots` limits the folders lanes may work under (empty:
  anywhere), `allow_full_trust` turns full trust off for lanes, and a full-trust lane is never started in / or the
  whole home folder whatever the policy says. Every lane's systemd unit is capped at `memory_max` (default 50% of
  RAM) and `tasks_max` processes (default 4096), so a runaway lane cannot take the machine down. The hiring desk
  shows the policy as chips under Permissions and greys out Full trust when it is off; a refused hire says why.

## [3.98.0] - 2026-10-19

### Added
- Divider v2. A third mode, Spend the week evenly: each seat's share follows how far its week is from being spent
  evenly, so a seat with plenty left and a reset coming gets more lanes (use it or lose it) and one ahead of its week
  gets fewer, still within its 5-hour window. The seat rows and the ranking say "on pace", "1.6× behind its week" or
  "ahead of its week".
- Keep free: per seat, hours when no new lane goes to it (9:00–18:00, 10:00–19:00, all day…), so a seat stays yours
  for interactive work; the ranking says "kept free for you until 18:00".
- A lane that names its model is kept off a seat whose own weekly cap for that model (Opus, say) is past the weekly
  guard. `claude-office pick-seat --model opus` does the same from scripts.

## [3.97.0] - 2026-10-19

### Added
- The review-comment watcher: when a desk's branch has an open PR with unresolved review comments, Needs you says so
  ("PR #482 has 2 unresolved review comments") with Forward to it, which opens that session with the comments written
  out in its message box (file, line, reviewer, what they said) for you to send. The session page shows the count on
  its PR, and the desk gets a yellow sticky note by its CI lamp. Read with `gh` every five minutes for at most ten
  PRs at a time; credential-shaped text in a comment is masked, and nothing is sent without you.

## [3.96.0] - 2026-10-19

### Added
- Why is it burning? A session that burned 5 M tokens or more in the last hour says so on its Overview, against its
  usual pace, with the likely causes from what the office sees (a big context read again on every call, helpers
  fanning out, the same call over and over, the prompt cache missing, many turns) and what to do about each.

## [3.95.0] - 2026-10-19

### Added
- A time limit for a lane (30 minutes to 4 hours, on the hiring desk): the budget runs from its first start, its
  brief names the deadline so it wraps up and writes its report in time (or a BLOCKED one saying how far it got), and
  five minutes past it the lane is stopped with its notes kept. The lane list shows "until 15:40", or "stopped at its
  time limit"; resuming it by hand gives a fresh budget. `max_minutes` on `POST /api/lanes`.

## [3.94.0] - 2026-10-19

### Changed
- Lanes waiting for a seat start the moment one is free: they used to sleep until their next guess (up to half an
  hour); now the office wakes them when the divider has a seat again, and the oldest waiting lane goes first.

## [3.93.0] - 2026-10-19

### Added
- Plain-language commands in the palette (Ctrl/⌘ K): type "remind me in 20 min to check the PR", "remind me at
  5:30pm to reply to Vega", "hire fix the flaky export test" (the hiring desk with that title) or "project
  api-gateway" (its page), and the action comes first; Enter does it.

## [3.92.0] - 2026-10-19

### Fixed
From an adversarial review of 3.69–3.81 (every finding reproduced first):
- Presence reads idle time right on GNOME (it read the "64" of "uint64"), so five minutes without input is away,
  not only a locked screen.
- "When this session finishes" and "when its plan is back" reminders survive an office restart; a seat's reminder
  waits until the seat is really back (out of its week, it counts from the weekly reset); a PR seen merged on the PR
  shelf fires its reminder.
- The test flask reads failures from the output too: a run piped through `tail` that failed is red, not green; a
  commit message or heredoc mentioning pytest is not a test run.
- A "Next up" chip fills in the suggestion you clicked, even when the list changed since it was drawn.
- Share-safe mode: Office news says "A reminder you set" (and who and what kind for reports, PRs and sessions); the
  project and Next-up tooltips leave out names and report text.
- "While you were away" says minutes for an absence under an hour; the "Remind me" times wrap on a phone; teammates
  cheer an eagle, a birdie and a par each in their own words.

## [3.91.0] - 2026-10-19

### Added
- Fan-out hiring: "One lane for each of a list…" on the hiring desk takes a list (PRs, failing tests, files, one per
  line) and hires a lane for each line into the backlog (at most 20), so they run in waves as seats free up. `{{item}}`
  in the title or brief marks where each line goes; otherwise it is added to both.

## [3.90.0] - 2026-10-19

### Added
- The backlog: hire a lane with "Add to the backlog" and the office starts it when the divider has a seat for a lane,
  oldest first and one at a time (each finds its seat before the next goes). The lane list says where each is in
  line; a lane's page has "Move to the front", Cancel and Start now. `{"start": {"backlog": true}}` on
  `POST /api/lanes`, `POST /api/lanes/front`.

## [3.89.0] - 2026-10-19

### Added
- This week's quests: three a week, drawn from six kinds (reports, agent hours, tool calls, sessions, days with work,
  lanes for an office that hires them), each aiming 10% past last week. A finished quest stamps the month's punch
  card with a rare gift; four stamps fill it, with an epic one. Beating last week's reports is one of the kinds.

## [3.88.0] - 2026-10-19

### Added
- The next 7 days, on Today: each seat's weekly plan as a bar: plan left, when it runs dry at this week's pace
  (drawn as a projection), its weekly reset, and the fresh week after; with a warning for any stretch when no seat on
  duty could take work. `capacity` in the snapshot (office/forecast.py), using the divider's weekly guard.

## [3.87.0] - 2026-10-19

### Added
- Fix the red build in one click: a failing open PR on the PR shelf has "Fix the checks", which fills the hiring desk
  with a ready brief (read the failing checks and the failed job's log, fix the cause on its branch, push, confirm,
  never merge) in the folder of the desk working on that branch. Nothing starts until you hire.

## [3.86.0] - 2026-10-19

### Added
- Goodnight (`G`, or the palette): before you go, what still needs you, who works on overnight (with one click to ask
  the lanes to write their notes), which seats get their 5-hour plan back before morning, a checkpoint, and lights
  out: the floor dims until 7 in the morning (rooms at work keep their lights) and the CEO's chair is empty. `G`
  again, or the palette, turns the lights back on.

## [3.85.0] - 2026-10-19

### Added
- Touch that works on the floor: pinch with two fingers to zoom (around the point between them, panning as they
  move), and hold a finger on a room for its menu (open, card, zoom in, hire a lane, holiday, terminal command).

### Fixed
- On a touch screen the page scrolls from the floor at normal zoom (the floor took every touch); zoomed in, one
  finger still pans the floor.

## [3.84.0] - 2026-10-19

### Added
- Set up your office: a checklist at the top of the briefing that ticks itself from what the office sees (a seat
  logged in, a second account, running as a service, desktop notifications, installed as an app, the office and you
  named, the first lane hired, the first message sent, the tour taken). Each open step has the command to copy or a
  button. It goes away when everything is done or you hide it, and an office that is nearly set up never sees it.

## [3.83.0] - 2026-10-19

### Added
- The seat failover walk: when a lane's seat runs out and the lane moves to another seat, its worker waits by the
  old chair, picks up a box and walks down the corridors (and the spine, between rows) to the new room, saying
  where it is going, instead of leaving by the elevator and someone new walking in. If the lane comes back on the
  same seat, the worker sits back down; if it does not come back within 45 seconds, the worker leaves as before.

## [3.82.0] - 2026-10-19

### Added
- The director cam (🎬 by the zoom buttons, or the palette): the camera flies to whatever just happened (a report, a
  merge at the ship's bell, a level up, a lane done, a limit, a fresh plan, an arrival), holds it for six seconds and
  shows the whole office again. The biggest moments go first, at most three wait, and it stands down for 20 seconds
  whenever you move the camera yourself. Off under reduced motion, during a replay and away from the floor.

## [3.81.0] - 2026-10-19

### Added
- Next up on the hiring desk: up to three lanes worth hiring, from what the office saw (a lane or a session that
  reported BLOCKED, a lane that failed, a PR whose checks fail), each a ready brief in the folder it concerns. A
  click fills the form and nothing starts until you hire; "Not now" hides one in this browser. Each desk's CI info
  now carries the PR's title and branch.

## [3.80.0] - 2026-10-19

### Added
- Reminders without a calendar: a note to yourself for a time ("Remind me…" in the palette: in 15 min, an hour, or
  at a time), or for when something happens: a seat's 5-hour plan is back (the bell on its page), a session
  finishes, a lane ends, or a PR merges. It fires once as office news (a chime, a toast, a desktop notification),
  says "Late" when the office was down at the time, and is forgotten a week after it was set. The briefing lists the
  ones waiting. Share-safe keeps their words off the screen. `POST /api/reminders`; kept in `state/reminders.json`.

## [3.79.0] - 2026-10-19

### Added
- This morning's standup: Yesterday (reports filed, PRs merged, commits, limits hit), Today (lanes running and
  scheduled, terminal sessions at work) and Blockers (what Needs you holds), every line from the office's own
  records, with the characters' names, ready to copy into Slack. From the morning card ("Standup") or the palette.
  `GET /api/standup`.

## [3.78.0] - 2026-10-19

### Fixed
From an adversarial review of 3.63–3.68 (every finding reproduced first):
- The checkpoint from before a restart survives it: the first hourly write after a restart moves it to
  `resume-before-restart.sh` (and the .md) instead of writing over it.
- The resume script is safe with any session name (tmux ran `#(...)` in window names), leaves `CLAUDE_CONFIG_DIR`
  out for the main seat (whose settings live in your home folder), and skips a session that is already open.
- "Resume all" reads each lane again just before starting it, so one stopped meanwhile stays stopped; it and "Stop
  every office lane" act on the lanes the page shows, and stop-all covers lanes cut off by a restart.
- An interrupted lane can be dismissed from its page.
- A lane started by hand while the scheduler looked at it, or resumed while the office decided it was cut off, is no
  longer written back as scheduled or interrupted.
- The mailroom never drops a gift with a promise attached (a swap, a rarity): over its cap (now 30) the oldest plain
  one goes.
- Keyboard focus stays on the ship board and the mailroom when their counts change.
- Share-safe mode: news toasts say who and what kind, never a session's or project's words (as the TV ticker does).
- TV mode in full screen asks before reloading after an update (a reload leaves full screen).
- Waits read "2 h 00 min", never "1 h 60 min"; turns that end on a stop sequence and accepted suggestions count.
- A report starting "⛔ STATUS: BLOCKED", "[BLOCKED]" or "1. STATUS: BLOCKED" reads as blocked again.
- Smaller words: the needs slide says "1 question", the first mailroom notice names whose gift it is (and comes
  alone), the arcade and milestone gifts say when they went to the mailroom, and TV mode's gift count includes it.

## [3.77.0] - 2026-10-19

### Added
- Poster mode for "Save a picture of the office": pick a size (as it is, a 16:9 slide, a square post or a phone
  story), add the date in a corner if you like, then save or copy. Each room's nameplate (name, level, status and
  plan left) and the lounge, meeting and garden labels are painted into the picture.

### Fixed
- The office's name in the picture is painted on the lobby sign, where it belongs (it landed over the rooms).

## [3.76.0] - 2026-10-19

### Added
- A presence-aware office: it reads from the desktop whether you are at the computer (GNOME's screensaver and idle
  monitor over D-Bus, else logind's idle hint, every half minute; nothing leaves the machine). While you are away (the
  screen locked, or five minutes without input) the CEO's chair is empty with a card on the desk, and banners wait
  to play when you are back. Back after ten minutes or more, "While you were away" tells that absence even with the
  page left open. `ceo` in the snapshot; on a desktop it cannot read, nothing changes.

## [3.75.0] - 2026-10-19

### Added
- A page for each project: click a project on the Tokens page (or open `#project=NAME`) for its tokens and API
  value per day over 7, 30 or 90 days, who worked on it and with which models, its biggest sessions, the office
  lanes that worked on it, what it shipped and its all-time totals. "Copy the days as CSV" puts the days on the
  clipboard, for billing or the week's notes. `GET /api/tokens/project?name=&days=`.

## [3.74.0] - 2026-10-19

### Added
- Four office levels that unlocked nothing now do: level 7 hangs a rocket and a heart poster in the lounge, level 9
  strings fairy lights along the lobby wall (they twinkle and glow at night), level 11 gives every corridor its own
  robot vacuum, and level 13 lays a welcome mat in each character's colour outside its door.

## [3.73.0] - 2026-10-19

### Added
- Teammates react to more of each other's news: trophies, fresh plans after a reset, merged PRs and a good week
  (par or better), on top of reports, level ups and limits. Each personality has lines in its own voice, which it
  says twice as often as the common ones.
- Banter knows the day: who tops today's burner board, how many goals are left (or that all are done), happy hour,
  the merges ringing the bell, Mondays, Fridays and the season. Lines said lately are not said again soon.

## [3.72.0] - 2026-10-19

### Added
- Today's goals follow this office's pace: with five days or more on record, targets come from the median of the
  last two weeks (×0.8, ×1 and ×1.3, rounded), a team goal never asks for more characters than can work, and the
  lane goal comes up only for an office that hires lanes. A day's goals are kept once drawn.
- One reroll a day (the arrow by Today's goals): the unfinished goals make way for new ones, each finished goal keeps
  its place, and a rerolled goal is never one that is already met.

## [3.71.0] - 2026-10-19

### Added
- Empty states that teach the next step: an empty whiteboard shows the config line for a programme (with a copy
  button), a search in the filing cabinet that finds nothing offers to clear it, a news filter with nothing in it
  offers all the news, and the hiring desk explains what a lane is before the first one.
- The week chart hatches the days before the office opened instead of drawing them as zero.

## [3.70.1] - 2026-10-19

### Fixed
- Par for the week: a week whose reading reaches 100% has run out (a bogey, not an eagle), and a seat that is
  already out when its window is first seen counts as having run out.

## [3.70.0] - 2026-10-19

### Added
- Par for the week: each seat's weekly plan is played like a round of golf. Using most of it without running out
  scores par (60%), a birdie (90%) or an eagle (97%); running out of the week is a bogey (a double after six hours
  waiting), and so is leaving most of it unused. A seat on holiday rests. Today shows the last six weeks, this week
  so far with where its pace is heading, and the season total; a week that closes is news. The 5-hour wall is noted,
  not scored. Kept in `state/weeks.json` (and in the daily backup); `par` on each Claude seat in the snapshot.

## [3.69.0] - 2026-10-19

### Added
- Screens that show the tool: a desk's monitor shows a turning globe while its agent browses the web, a terminal
  prompt for shell commands, dots and a crawling bar while tests run, a plug for another service (MCP) and a page
  going up while it publishes. Monitors seen from behind carry the same sign on the lid.
- The test flask: a desk whose last test run passed has a green flask by its screen; a failed run turns it red and
  bubbling, until the next run. Test runs are commands that start with a test runner (pytest, unittest, npm test,
  go test, node --test, make check and the like), so `grep pytest` is not one. Sessions carry `screen` and `test_ok`.

## [3.68.0] - 2026-10-19

### Added
- Reboot recovery. A lane whose service vanished without being stopped (a restart, a crash, the OOM killer) is now
  marked interrupted and kept, noting a restart of the machine when there was one. Needs you lists them as one item
  with "Resume all" (`POST /api/lanes/resume-interrupted`), and each lane picks up from its notes.
- The hourly checkpoint: `office-checkpoint-latest.md` and `resume-latest.sh` in the checkpoint folder, written
  while terminal sessions are live, so the one from before a restart survives it. The script reopens every session
  in a tmux window of its own (its folder, then `claude --resume`), noting the branch without switching anything.
- The doctor lists interrupted lanes and when the hourly checkpoint was written.

### Changed
- A lane is only called interrupted when systemd could be asked and the lane has been up for more than 90 seconds,
  so a slow start or a systemctl hiccup never marks one.

## [3.67.0] - 2026-10-19

### Added
- TV mode plays a playlist: between room tours, a slide in big type takes the screen (today's burners, the day so
  far, what shipped, and how many things need you, as counts only). `?slides=`, `?every=` and `?dim=` tune it.
- TV mode keeps the screen awake (asked again when the tab comes back), hides the cursor when idle, dims at night,
  drifts a pixel every ten minutes against burn-in, and reloads itself (still on TV) after the office updates.

### Fixed
- TV mode's news ticker follows share-safe mode: who, and what kind of news, never what it says.

## [3.66.0] - 2026-10-19

### Added
- The mailroom: no gift is lost any more. A gift that finds the floor full, or waits there a day unopened, goes to
  the pigeonholes behind the hiring counter (up to 20) and comes back out to the floor as you open the others.
  Click the pigeonholes, or "Open the next" in the album, to open one where it is. The gift chip counts both.
- Where they came from: the album lists the last stickers you opened, with who left each gift and when (the last
  50 are kept).
- The demo takes `?gifts=N` to start with a full floor and a mailroom.

### Changed
- Swapping spares works with a full floor (the gift goes to the mailroom); a milestone says where its gift waits.

## [3.65.0] - 2026-10-19

### Fixed
From an adversarial review of 3.45–3.62 (every finding reproduced first):
- A lane hired for later can be cancelled or started now; its page says when it starts. Starting it early takes it
  off the schedule, so it never starts twice.
- "Stop every office lane" stops lanes that are starting or scheduled too, and counts them.
- A finished chain stage that is run again no longer starts its next stage a second time; a report that says
  "STATUS: DONE - unblocked …" no longer reads as blocked (one test for BLOCKED everywhere).
- Scheduled lanes older than the 40 newest start when due; a "when a seat has N% left" schedule ignores seats that
  are benched, offline or logged out.
- Helper drones dock when a helper finishes while its session is busy (the notice arrives queued).
- "Merged this week" counts every PR merged in the last week, not just those among the newest 40.
- Snoozing a grouped Needs-you item ("2 sessions paused") snoozes all it holds; a lane waiting for a seat and the
  same lane failing are separate items to snooze.
- Do not disturb quiets the Jarvis voice too, keeps the toasts that answer your own clicks, and alarms that came up
  during it ring once it ends.
- Share-safe mode keeps a session's repeated call and its report out of Needs you.
- A question whose answer failed to send for any reason opens again (it no longer stays "sending").
- A state file that is not UTF-8, or a hand-edited quiet.json, is set aside instead of stopping the office; the
  daily backup includes quiet.json.
- Web searches and page fetches are counted from the calls themselves (the usage field was always zero); the
  ledger reads the transcripts once more to count them.
- "Hours lost to limits" counts minutes when the other seats were benched or offline anyway.

## [3.64.0] - 2026-10-19

### Added
- Waiting on you: how long sessions sat finished, waiting for the next prompt you typed, with the median reply and
  the longest waits. On Today and on the Tokens page for any range (with a bar per day), and in "Copy as text".
  Read by the token ledger from the transcripts (a turn's end to the next typed prompt); lanes and helpers never
  wait on you, and a gap over two hours is time away. `waits` in `/api/tokens`.

### Changed
- The ledger reads every transcript once more after this update (about half a minute), to count the waits from
  the start; it shows the numbers from before until it is done.

### Fixed
- The ledger and price tests read their dates in UTC, so they pass in any timezone (they failed far from UTC).

## [3.63.0] - 2026-10-19

### Added
- The ship board in the lobby: a chalkboard with today's commits, PRs opened and PRs merged (read from the
  transcripts), chalk dust when a number goes up, and an outbox tray that fills as commits land. Click it for the PR
  shelf. The snapshot carries `office.shipped_today` (the office and each seat).
- Commits fly from the desk to the outbox as envelopes, a new PR as a parcel, and a merge rings the brass ship's bell
  over the board (two strikes, sound rings out, with its own bell sound).

## [3.62.0] - 2026-10-18

### Added
- Do not disturb, on every screen at once: from the menu or the palette (an hour, or until 9 tomorrow), it stops
  sounds and desktop notifications and lets only serious toasts through; a "Quiet until…" chip in the top bar ends it.
- Snooze a Needs-you item for an hour, on every screen; Needs you says how many are snoozed. An item keeps its key
  while its numbers tick ("usage at 91%" and "at 94%" are one item). `POST /api/dnd` and `POST /api/snooze`.

## [3.61.0] - 2026-10-18

### Added
- Scheduled hires: a lane can start at a time you pick (up to a week ahead) or as soon as some Claude seat has 30% of
  its 5-hour window left, so work waits for plan instead of stalling on an empty seat. It waits as "scheduled" in the
  lane list, with when it starts, and the office starts it within a minute of it being due. `POST /api/lanes` takes
  `start` (`{"at": epoch}` or `{"left": 30}`).

## [3.60.0] - 2026-10-18

### Added
- A second opinion: a hire can be followed by "Codex gives a second opinion on its work", a review stage that runs on
  the Codex seat, so a different model reads the report and the changes. A chain stage can name its own seat.
- Each office lane's row says what it shipped: commits, and PRs opened or merged, from the token ledger (`shipped`).

## [3.59.0] - 2026-10-18

### Added
- Daily backups of the office's state (tokens, careers, questions, the day ledger, usage history, known
  repositories), the last 7 days kept under `state/backups/`. `python3 -m office backups` lists them and
  `python3 -m office restore <day>` puts one back (with the office stopped; the current files are kept beside them).

### Fixed
- A state file that no longer parsed (cut off by a crash or a full disk) was started fresh and then written over:
  careers, questions or the day ledger could be lost for good. It is now set aside as `<name>.broken-<when>`, and
  the doctor says so, with how to restore yesterday's.

## [3.58.0] - 2026-10-18

### Added
- When something breaks on the page, it says so once, quietly ("It keeps working; reload if something looks off"),
  and reports the error to the office, where the doctor lists it. Errors from browser extensions and network blips
  are left alone; at most 20 reports a minute (`POST /api/client-error`).

## [3.57.0] - 2026-10-18

### Added
- Office doctor: one page of health checks (the config, each seat's login and plan reading, the token ledger, free
  disk, systemd for lanes, the GitHub CLI, lanes waiting for hours, the version), worst first, each with what to do
  about it. From the briefing, the palette or `GET /api/doctor`.

## [3.56.0] - 2026-10-18

### Added
- Achievement chains and secrets: Factory (100,000 tool calls), Filing clerk (50 reports), Archivist (200), Hundred
  million and Billionaire (tokens), Iron will (30 days in a row), and two secrets (Speedrun, Ultramarathon) that read
  "???" until someone earns them. Chains show one tier past the highest earned, here and in the Trophy room.

### Fixed
- Loose ends could call work "safe to remove": a count git could not make read as zero commits, one commit found on
  the default branch by name made a whole branch "merged", and a detached HEAD with commits found nowhere else was
  offered for removal (which orphans those commits). Now every commit must be on the default branch by name, a count
  that fails means "could not check", and a detached HEAD with its own commits is always work. Safe rows name the
  ignored files a removal deletes; submodules are not swept; a folder git cannot read says so instead of "all clear".
- The filing cabinet's resume command quotes the folder, the config dir and the session, so pasting it can never run
  anything else (and works for folders with accents).
- The PR shelf lists every open pull request, not only those among the last 40; a fork's PR, or one whose head is the
  default branch, lights no desk; one failing PR is one Needs-you item.
- Answering a question: the question closes only when the answer is delivered (a failure keeps it open, with the
  reason), two answers cannot both go out, an ended session's follow-up lane is said, and the demo says it sent nothing.
  Questions are limited to 10 a minute, and open ones are never trimmed away.
- Needs you no longer reads a question, a CI item, ghost use or a loop as a plan item or a logout.
- Share-safe hides questions and answers (in Needs you, the Inbox, toasts and notifications) and blurs branch names on
  the PR shelf and in Loose ends.
- Claude Haiku 5.5 reads a million tokens of context; the context gauge never shows more than 100%.
- `office ask` and `office post` fail cleanly when something other than the office answers; lanes call
  `python3 -P -m office ask`, so a project's own `office` package cannot stand in.
- Light theme: the status tags in Loose ends and the PR shelf are readable.

## [3.55.0] - 2026-10-18

### Added
- Character creator, in Settings: pick each character's skin, hair colour, hairstyle (short, long, bun, spiky, cap,
  crop) and glasses, and your own at the CEO's desk, with a live portrait; "Automatic" goes back to the look it was
  born with. Saved with the office settings (`look` per seat, `ceo.look`), so every screen shows it: portraits,
  cards, the lounge, the employee of the day and the CEO's desk.

## [3.54.0] - 2026-10-18

### Added
- What changed this week, in plain words: the PR shelf opens with every pull request merged in the last 7 days, by
  repository, and "Copy as notes" puts them on the clipboard as a list for a standup or a changelog.

## [3.53.0] - 2026-10-18

### Added
- Hours lost to limits, on the Today view: how long each seat sat out of plan over the last 7 days, and how long no
  Claude seat could take work at all. The history samples whether each seat is limited each minute and the day
  ledger keeps `limited_min` per seat and `all_out_min` for the office; `/api/week` returns them.

## [3.52.0] - 2026-10-18

### Added
- Loop detector: a session that makes the very same call (the same tool, the same input) eight times in a row while it
  works lands in Needs you ("has made the same call 9 times in a row: Run the tests"), and its page shows "Same call
  ×9" from five. Waiting and polling tools never count, and different edits to one file are not a loop.

## [3.51.0] - 2026-10-18

### Added
- When the office restarts on a newer version, an open page says so ("Claude Office was updated to 3.51.0") with a
  Reload button, instead of running yesterday's code against today's server.

## [3.50.0] - 2026-10-18

### Added
- Where the tokens go, on the Tokens tab: the main conversations against their helpers (subagents), how much of the
  output was thinking, and how many web searches and page fetches the sessions made, for any range or character. The
  ledger (version 4) keeps these per day and rebuilds itself once from the transcripts, showing the old numbers until
  it is done. `/api/tokens` has `where`.

## [3.49.0] - 2026-10-18

### Added
- Streak freezes: every 7 days in a row earns one (you can hold two, shown as ❄ by the streak), and the first visit after
  a missed day spends one per missed day to keep the streak going, with a toast saying so. A weekdays-only streak (in
  Settings) never breaks over a weekend.

## [3.48.0] - 2026-10-18

### Added
- A desktop notification takes you to its subject when clicked: a question opens the Inbox, a report its session, a
  PR the PR shelf, anything about a seat its character page.
- Stop every office lane: a panic button over the lane list (with two or more running) and in the palette, after a
  confirmation. Each lane keeps its notes and can be resumed; sessions in your own terminals are never touched.
  `POST /api/lanes/stop-all`.

## [3.47.0] - 2026-10-18

### Added
- What it cost so far: each session's page shows its API value so far ("$12.40 so far", its helpers included), and
  each office lane's row its receipt across all its runs. Sessions and lanes carry `spent` (tokens, output, usd).

## [3.46.0] - 2026-10-18

### Added
- A drone swarm: each helper a session sends off (the Agent tool, in the foreground or the background) is a drone
  orbiting its desk until it finishes, when it docks with a spark and "Helper done". The session's page lists the
  helpers at work and for how long. Sessions carry `helpers` and `helpers_done`.

## [3.45.0] - 2026-10-18

### Added
- Lane chains: a hire can carry on in the same folder with "a second lane reviews its work" or "a lane fixes what it
  found, then another reviews the fix". Each stage starts when the one before reports done, with that report in its
  brief, on the same seat preference, model and permissions; a blocked report stops the chain. The lane list shows
  "stage 2 of 3" and what comes next. `POST /api/lanes` takes `chain` (a preset name or up to four stages).

### Fixed
- The hire form's "Let me message it while it works" switch was ignored: every lane took messages directly.

## [3.44.0] - 2026-10-18

### Added
- Filing cabinet: every session on this machine, newest first, searchable by its title, its first instruction, its
  project or its folder and filtered by character, with its dates, tokens and API value; open its conversation or copy
  the command that resumes it in its folder on its seat. Titles and first instructions are read from the start of each
  transcript into memory only (the token ledger still keeps no content). From the briefing, the palette or
  `GET /api/cabinet?q=`.

### Fixed
- A text field keeps its caret when the inspector redraws under it, not only the chat box.

## [3.43.0] - 2026-10-18

### Added
- Paper planes: a message you send a session, and an answer from the Inbox, flies from the CEO's desk to its desk in
  an arc and lands with a spark (Full game intensity, full motion).

## [3.42.0] - 2026-10-18

### Added
- Context gauge: each session's context (what it sends with every reply) against its model's window (a million tokens
  for Claude 4.6 and later, 200k before; Codex's own), as "Context 38%" on its page (amber from 70%, red from 90%, when
  Claude Code is about to compact) and as a pile of paper on its desk that grows with it, red on top when nearly full.

### Changed
- The CI lamp and the task strip show on the desks of the second row too.

## [3.41.0] - 2026-10-18

### Added
- Agents can ask you: `python3 -m office ask "Ship it behind a flag or wait for review?"`, run from inside a session,
  rings the CEO's desk phone, raises a toast, a desktop notification and a Needs-you item with an Answer button, and
  keeps the question in a new Inbox. The answer goes back to the asking session as a message (found by the command's
  parent processes, or by its folder); the session keeps working meanwhile. Office lanes are told they may ask, once,
  for decisions that are truly the CEO's. A half-written answer survives the page's redraws.
- `POST /api/ask`, `/api/ask/answer` and `/api/ask/dismiss`; open questions ride in the snapshot as `asks`.

## [3.40.0] - 2026-10-18

### Fixed
- Token counts and API value took a response at its first line: Claude Code writes one response as several lines while
  its output grows, so output was a third too low and the API value about 5 to 8% low. Each response now counts by
  its final usage (ledger version 3), and a forked subagent's copy of its parent's lines counts once. The ledger
  rebuilds itself from the transcripts once, showing the old numbers until it is done; sessions whose transcripts are
  gone keep what they had, shipped work included (and a later change to the shipping rules keeps theirs too).
- Shipped work: a script written in a heredoc no longer counts as running its `git commit` or `gh pr merge`, a command
  moved to the background counts nothing yet, forced pushes and quiet pushes count (most pushes were missed), "(Bash
  completed with no output)" reads as empty, and a commit without git's "[branch abc1234]" line counts only when it
  was quiet (`-q`, `-qm`, `>/dev/null`) and no pre-commit hook failed; `git commit-tree` is plumbing, not a commit.
- The Tokens tab's leaderboard, ranks and arrows follow the measure shown (API value, fresh, output), not all tokens.
- Keyboard focus stays on the leaderboard when drilling into a character and back.
- A session's task list counts updates made in the middle of a long transcript.
- "API value" keeps its capitals in sentences; Wrapped says what the plans paid only when a plan is known;
  `office post` reports an error from something that is not the office on that port instead of crashing.

## [3.39.0] - 2026-10-18

### Added
- Pull requests: a shelf of the recent PRs in the repositories your sessions use (open, draft, merged, closed), with
  their checks, reviews and the desk working on each branch, read with the GitHub CLI every few minutes. From the
  briefing (with a count of open PRs whose checks failed), the palette or `GET /api/prs`.
- A CI lamp on each desk whose branch has an open PR: green when the checks pass, amber while they run, red and
  blinking when they fail; the session's page links the PR, and failed checks land in Needs you.

## [3.38.0] - 2026-10-18

### Added
- Burn alarms in Settings, for this screen: a seat burning more than N million tokens in an hour, a working seat's
  5-hour window running out within N minutes, the office passing a milestone, and the top burner changing hands.
  Each rings once (a toast, a chime, a desktop notification when the tab is in the background) and again only after
  it cools off or an hour passes. Alarms are not part of the game, so they ring at every game level.

## [3.37.1] - 2026-10-18

### Fixed
- Loose ends finds the repositories every project's sessions have worked in (from the first lines of each project's
  newest transcript, once a start, and from the transcripts as they are read), not only those of the sessions running
  now; scratch folders under the temp directory are never swept.

## [3.37.0] - 2026-10-18

### Added
- Loose ends: every worktree of the repositories the office's sessions and lanes use, sorted into work that is
  nowhere else (files not committed, commits on no remote, branches never pushed), worktrees safe to remove (clean,
  and every commit on a remote or on the default branch by name, as a squash merge leaves it), and worktrees whose
  remote branch was deleted but whose commits are not on the default branch. Copy the remove commands for a whole
  list; the office only reads, at low priority, and never changes a repository. From the briefing (with a count of
  worktrees holding work), the palette, or `GET /api/loose`. Repositories are remembered from every session and lane,
  plus `"repos"` in config.json.

## [3.36.0] - 2026-10-18

### Added
- The lobby TV flips channels every 8 seconds, with a flash of static between them: plan left on every seat, tokens
  burned in the last hour, the all-time top burners, and who gets the next lane in its colour. Dots on the screen
  show which channel is on and a label under it names it.

## [3.35.1] - 2026-10-18

### Fixed
- Ghost use waits for the first read of the transcripts after a start, so the office's own sessions are never taken
  for someone else's.

## [3.35.0] - 2026-10-18

### Added
- Ghost use: when a seat's 5-hour use rises 3 points or more while no session on this machine makes an API call, the
  office says someone else is using the login (claude.ai, the desktop app or another computer). A ghost floats in the
  seat's room, Needs you and the character page say what happened, and the news and timeline mark it (once an hour).

### Fixed
- Character names no longer replace a seat id inside a domain or a path ("claude.ai", "~/.claude").

## [3.34.0] - 2026-10-18

### Added
- Each session's own task list (TaskCreate and TaskUpdate, or TodoWrite before them), read from its transcript: a
  progress bar across the back of its screen on the floor (gold when every task is done), "2/5 tasks" on its page and
  its dock card, and a checklist on its Overview with the task in progress marked "now". Helpers' lists stay theirs.
  Blurred for terminals in share-safe mode.

## [3.33.0] - 2026-10-18

### Added
- News from your scripts: `python3 -m office post "Prod deploy done" --level good --source deploy --banner`, or
  `POST /api/event` with the per-install token. A toast, a line in the news, a timeline marker at the seat's desk,
  confetti at the seat for good news, a desktop notification for bad, and with `--banner` a banner across the floor.
  Text is 1 to 140 characters; at most 30 events a minute.

## [3.32.0] - 2026-10-18

### Added
- Prompt cache countdown: a session that is not working shows "Cache warm 4:12" on its page, ticking every second
  and urging in the last minute, then "Cache cooled · 395k". The title says what a reply saves while it is warm (the
  context read back at the cache-read price instead of written again: "about $1.90 at API prices"). On the floor, an
  idle desk's mug steams while its cache is warm.
- Sessions carry `cache` (`until`, `ttl`, `context`, `saves_usd`), from the main chain's last response: 5 minutes,
  or an hour once the session writes 1-hour cache entries.

## [3.31.0] - 2026-10-18

### Added
- Shipped work is game currency: a commit earns 25 XP, a push 5, an opened pull request 50 and a merged one 150,
  from now on (no back pay, so levels keep their meaning). Commits rise from the desk as "+3 commits" and land in the
  news as one line per seat and project a read; PRs keep their celebration, combo step and gift.
- Five shipping achievements: Shipped it (a first commit), Committer (100), Prolific (1,000), Merged (a first PR
  merged) and Release train (50 merged). History unlocks them quietly on the first read.

## [3.30.0] - 2026-10-18

### Added
- API value: what every response would cost at API list prices (Anthropic's and OpenAI's pricing pages, October
  2026), counting 5-minute and 1-hour cache writes, cache reads and output, fast mode, US-only inference and Haiku
  5.5's long-prompt tier. A fourth measure on the Today card and the Tokens tab, next to All, Fresh and Output: the
  leaderboard, days, months, calendar, models, projects and sessions all switch to dollars.
- What the plans bought: a card on the Tokens tab with the range's value against what the plans cost for the same
  days ("15× what the plans cost") and each character's payback. Plans are priced by tier (Pro $20, Max 5x $100,
  Max 20x $200 a month) unless set per character in Settings (`plan_usd`); the Codex seat has no price until set.
- The value on the picture, on Wrapped (a slide of its own), on the character page and in the CSV (`api_usd`).
- `/api/tokens` returns `usd` on every row, `value` (`usd`, `plan_usd`, `multiple`, `plans`, `estimated`) and
  `prev_total.usd`.

### Changed
- The ledger prices each response as it reads it, once per response. Shipped work and prices share a rules version,
  and this one recounts both from the transcripts on disk (about 25 seconds on a month of four busy seats). Sessions
  whose transcripts are gone are estimated from their totals, and the page says how much is estimated.

## [3.29.2] - 2026-10-18

### Fixed
- No more "▲ 1111% on the 30 days before" when the transcripts start inside that period: the Tokens tab says the
  period before is not all on record, and Wrapped says the month before is only partly on record.
  `/api/tokens` has `prev_partial`.

## [3.29.1] - 2026-10-18

### Fixed
- A quiet `git commit -q` followed by other commands counts again when those commands print "error:" or "fatal:"
  lines (tests, lint, a rebase): only git's own "nothing to commit" words mean no commit. Shipped work is recounted.

## [3.29.0] - 2026-10-18

### Added
- The token picture follows the character you picked on the Tokens tab: their total, shipped work and models, their
  row lit in the ranking, and their place ("rank #3 of 5").
- `today_by` on `/api/tokens` (and on each leaderboard row): today in every measure, so the "today" chip follows Fresh
  and Output too.

### Changed
- Shipped work reads gh's own words: `gh pr merge` with no output (no terminal) or a failed branch clean-up after the
  merge counts as merged; `--auto` counts only once the PR shows as merged; a PR title with "failed" in it, a branch
  named "…rejected…" or a commit message saying "nothing to commit" no longer hide real work. The rules have a version,
  and a new version recounts shipped work from the transcripts still on disk.
- PR news carries its number from the merge command or gh's "owner/repo#N" when there is no link.
- Codex sessions get distinct short ids in the CSV; its first, last and responses columns are named `session_*`
  because they cover the whole session whatever the range.
- System theme follows the OS for every light-theme rule (the page wears "light" or "dark"), and `?theme=` and
  `?game=` last for the visit instead of being saved.
- The weekly pace line only goes red when a seat is ahead of pace and runs out well before the reset; a projection
  close to the reset says "runs out about the reset"; a spent week says "Out of plan for the week".
- Ceremonies (Burner Belt, milestones, records) bring their toast with their banner, skip the floor when it is hidden or
  replaying, and keep no state in the demo. A milestone gift that finds no room comes later instead of being lost.
- The lobby odometer reads at 8 px or more and rolls in only for a new number; nameplates shrink the name, never the
  Top burner flame, Burner Belt or Lean ribbon, and say them to screen readers.

### Fixed
- The Tokens tab's 30 and 90 day ranges showed only 7 days whenever someone had committed this week.
- The 26-week calendar put every Monday in the week before's column.
- The Tokens tab overflowed a phone sideways, and the #1 leaderboard row picked up the header's sticky styles.
- Text size now applies to the Tokens tab; keyboard focus stays on the control you used there and on the Today card.
- At Calm and Off: no XP floaters, gift confetti, arrival lines, secret-code horn, or Belt and Lean on the Tokens tab;
  the morning card leaves out goals at Off; queued banners no longer hide speech bubbles after switching to Calm.
- Login lapses say "Lapses" (not "Resets") with "17 min", "1 hour" and "6 hours".
- Light theme contrast on the Today card's chip and the green deltas; the TV strip's gift count stays light.
- TV mode's gift count updates at once, and the room peek card hides when a replay starts.
- "Your delivery is at the desk" waits for the courier to land before showing the box.
- Settings toggles expose which option is on; focus stays in the inspector when a card's button goes away.

## [3.28.0] - 2026-10-18

### Added
- Wrapped: a calendar month as a story (the tokens against the month before, a podium of the top three burners, what
  it shipped, the biggest day and the model mix), ending in a picture. It plays on the first visit in a month's first
  three days, for the month that ended, and from the menu or the palette; `?wrapped=1` in the demo.
- `GET /api/tokens?range=m:YYYY-MM` for a calendar month.

## [3.27.0] - 2026-10-18

### Added
- Embers rise off a desk while its seat burns tokens, more and faster the harder it burns (2 M, 15 M and 60 M tokens
  in the last hour), with a warm glow at night. Part of the game: none at Calm or Off.

## [3.26.0] - 2026-10-18

### Added
- Every session shows its git repository and branch (read from `.git`, worktrees included, without running git), on
  the character page and the session page; blurred for terminals in share-safe mode.
- Copy as text on the Today view: the day as a few lines for a standup or a channel (reports, hours, shipped work,
  tokens, the employee of the day and who did what).
- `GET /api/status.txt`: one line for a tmux status bar or a shell prompt (`?style=plain` drops the symbols).

## [3.25.0] - 2026-10-18

### Added
- A wall clock in every room, with a wedge from now to when the 5-hour plan comes back (red if it runs out first);
  pointing at it says when the plan and the week reset.
- Needs you warns three days before a seat's login lapses (urgent from 12 hours), with the login command to copy.
- A token picture from the Tokens tab: the range's total, every character ranked with the top one crowned, shipped
  work and the model split, 1200×630, to save or copy. Names and counts only.

## [3.24.0] - 2026-10-18

### Added
- What the tokens shipped: commits, pushes, PRs opened and merged, and lines changed, read from the git and gh
  commands sessions ran (counted when the command succeeded), per character and range in the Tokens tab, with
  tokens per commit.
- The Lean ribbon: last week's fewest tokens per commit (at least three commits), on the nameplate and in the Tokens tab.
- A PR opened or merged in a session becomes office news within a minute: confetti, a line from the character, a
  combo step and a gift for a merge.

### Changed
- The token ledger reads every minute; shipped work has its own offset, so existing ledgers read their transcripts
  once more for it without counting tokens twice.

## [3.23.0] - 2026-10-18

### Added
- The Burner Belt: last week's heaviest token burner (Monday to Sunday) wears a belt on its nameplate, the Tokens tab
  says who holds it and who leads this week, and a handover gets a banner and confetti.
- A token odometer on the lobby wall under the neon sign: the office's all-time total.
- Milestones on the 1-2-5 ladder (1 M, 2 M, 5 M, 10 M, …): crossing one gets a banner, confetti in every room and an
  epic gift, and every milestone hangs as a dated brass plaque on "Your office".
- Record ceremonies: a new biggest day, hungriest session or longest run of days gets a banner (once a day each).
- `/api/tokens` returns the last eight weeks per seat and the milestones.

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

# Claude Office

A pixel-art office for every AI seat on your machine. Each Claude Code account gets a desk pod and the Codex CLI
gets one too. Every running session is a little worker at a desk, and what it is doing right now appears over its
head. You sit in the CEO's office: you see who is working, who is stuck and who is out of plan, you split new work
across seats with a load divider, and you hire new lanes from the front desk.

![The office floor](docs/office.png)

| Load divider | A session up close |
|---|---|
| ![Load divider](docs/divider.png) | ![Session panel](docs/session.png) |

*The screenshot is demo mode (`--demo`): made-up seats, no real accounts.*

## What you get

**The floor**
- **One desk pod per seat.** `~/.claude`, `~/.claude2`, `~/.claude3`, ... are found automatically, plus `~/.codex`.
  The pod's nameplate shows how much of the 5-hour window and the weekly allowance that seat has used.
- **One worker per live session.** Headless lanes (`claude -p`) and interactive terminals both appear;
  interactive ones wear headsets. Workers animate by what the session is doing: typing for edits and commands,
  reading for reads and searches, a helper standing by for delegation, a progress bar on a long tool call,
  a question mark after 15 quiet minutes, and asleep with Zzz when the seat is out of plan.
- **Speech bubbles** pop up when a worker starts something new, and when you hover.
- **CEO office.** The phone rings when something needs you.
- **Wall TV.** Plan left on every seat, as bars.
- **Whiteboard and meeting room.** Running work grouped into programmes, with one representative per programme
  at the table.
- **Server room.** One rack per watched systemd service (conductors, supervisors, lanes); a red rack has failed.
- **Lounge.** Seats with nobody at their desks take a break here, and a seat that is out of plan sleeps on the couch.
- **Day and night.** The windows follow your clock, and at night the desk lamps come on.

**The CEO's panel**
- **Needs you:** logouts, seats at 90%+ of a window, sessions stopped by a limit, quiet lanes, blocked reports,
  failed services.
- **Capacity:** every seat's 5-hour and weekly usage with reset countdowns, read live from the plan's usage endpoint.
- **Burn-rate forecast:** from recent readings, each seat's pace in %/hour and whether it lasts until its reset
  ("at 22%/h: out in 1h10, 50m before the reset"). A seat about to run dry raises an alert.
- **Seat view:** login health, tier, usage gauges, and everyone at that seat's desks.
- **Session view:** what it is working on, what it is doing now, its last steps, its STATE notes and REPORT,
  tokens in the last hour and five hours, and the exact command to resume it.
- **Board view (B):** the same information as cards, with no pixels.
- **Share-safe mode (P):** blurs what interactive sessions are about, for screen sharing.
- **Checkpoint:** writes the whole office to a Markdown file, with a resume command for every session.
  Take one before restarting the laptop.

**The load divider (D)**
- Drag the borders of the split bar to decide what share of new lanes each seat gets. Bench a seat to take it off
  duty. Cap how many lanes a seat may run.
- **Headroom-aware** mode shrinks a seat's share as its plan runs out. **Fixed** mode honours the split exactly.
- **Guards** stop new lanes on a seat at a chosen % of its 5-hour or weekly usage, with an office-wide lane cap
  on top.
- Next to the controls you see who gets the next lane and why, and what blocks every other seat.
- Scripts can follow the divider too: `seat=$(claude-office pick-seat)` (exit code 3 when no seat is free).

**The hiring desk (H)**
- Write a brief, pick a folder, and let the divider choose the seat, or pin one. The lane starts as a systemd user
  unit at low CPU priority with no display.
- The lane keeps progress notes in its STATE file. If its seat hits the usage limit, the runner rests that seat
  until its reset, and the divider moves the lane to another seat, which resumes from the notes.
- When the work is done the lane files a REPORT (`STATUS: DONE` or `STATUS: BLOCKED`). You can stop a lane and
  resume it on any seat.

## Quick start

```bash
git clone https://github.com/JigarJoshi04/claude-office && cd claude-office
python3 -m office serve           # http://127.0.0.1:7420
python3 -m office serve --demo    # a made-up office, to look around safely
bin/install.sh                    # keep it running as a systemd user service
```

You need Python 3.10 or newer and nothing else: the office uses only the standard library. Linux is required for the live
view, because sessions are read from `/proc` and lanes run under `systemd --user`.

## Command line

```text
claude-office status                 one line per seat and per session
claude-office pick-seat [--json]     the seat the divider gives the next lane
claude-office hire --title T --brief-file F [--workdir D] [--seat auto|ID] [--model opus]
claude-office lanes | stop ID | resume ID [--seat ID]
claude-office checkpoint             write the office down
```

`bin/claude-office` runs these from anywhere. Inside the repo, `python3 -m office ...` does the same.

## Configuration

Everything personal lives outside the repo, in `~/.config/claude-office/`:

| File | What it holds |
|---|---|
| `config.json` | CEO name, seat labels and colours, programmes (`{"match": "apollo", "name": "Apollo launch", "url": "..."}`), watched units, lane defaults and preamble, checkpoint folder, port |
| `divider.json` | The load divider, written by the page |
| `token` | The per-install secret the page uses for writes |

The office's own state goes to `~/.local/state/claude-office/` (usage cache and news) and
`~/.local/share/claude-office/` (lanes and checkpoints).

## How it knows things

| What | Where it comes from |
|---|---|
| Seats | `~/.claude*/` folders that hold a login, plus `~/.codex` |
| Login health and tier | `.credentials.json` metadata: expiry and rate-limit tier. The tokens themselves never leave the server. |
| Usage | The plan's usage endpoint, called with the seat's current access token every few minutes. The office never refreshes a login: a refresh would rotate the token under Claude Code. While a seat's token is expired, the office shows the last reading, marked stale. |
| Live sessions | `<seat>/sessions/<pid>.json`. A session counts only if the pid runs and its kernel start time matches, so a reused pid is never mistaken for it. |
| What a session is doing | Its transcript, read incrementally: only the new bytes since the last look. |
| Programmes and services | The session's systemd unit (from its cgroup), its folder and its task, matched against your config |
| Codex seat | `~/.codex/sessions` rollouts and the rate limits Codex records |

## Safety

- The server listens on `127.0.0.1` only. It rejects any request whose `Host` is not loopback, which stops
  DNS-rebinding pages. Every write must carry the per-install token, which only the office's own page receives.
- A strict Content-Security-Policy is set, and every string from a transcript is escaped before it reaches the page.
- Credentials are read only at the moment of a usage call. They are never sent to the page, logged or cached.
- Demo mode reads no accounts and turns every write into a no-op.

## Uninstall

```bash
bin/install.sh --remove
rm -rf ~/.config/claude-office ~/.local/state/claude-office ~/.local/share/claude-office
```

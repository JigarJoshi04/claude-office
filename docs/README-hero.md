<!-- Paste at the top of README.md. Paths are relative to the repository root. -->

[![MIT license](https://img.shields.io/badge/license-MIT-ff7a45?style=flat-square)](LICENSE) ![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-3776ab?style=flat-square&logo=python&logoColor=white) ![Zero dependencies](https://img.shields.io/badge/zero_dependencies-standard_library_only-38e07b?style=flat-square) ![Local-first](https://img.shields.io/badge/local--first-127.0.0.1_only-5b8def?style=flat-square)

![Claude Office in demo mode: a visitor lane walks from the elevator to Orion's desks while the camera zooms in and Orion's character card opens, then a session's Chat, the Team view and the Timeline](docs/demo.gif)

**Claude Office is a living pixel office for every AI coding seat on your machine.** Each Claude Code account gets a
desk, and so does the Codex CLI; every running session is a little worker at that desk, acting out what it is doing
right now. Every seat is a character with a name, a role, a motto and a mood that follows its live state. The header
sums up the office in plain English. Open any session to talk to it, follow up on one that has finished, or message
all your lanes at once. Split new work across seats with the load divider, and hire background lanes from the front
desk. It runs on `127.0.0.1` with nothing but the Python standard library, and `python3 -m office serve --demo` shows
you a made-up office before you point it at your real seats.

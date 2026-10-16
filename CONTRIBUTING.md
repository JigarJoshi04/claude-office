# Contributing

Use Python 3.10 or newer. The application has no third-party runtime dependencies and no frontend build step.
Linux is required for the live process view and Unix socket messaging; hiring background lanes requires a
working systemd user manager and the relevant CLI.

```bash
python3 -m office serve --demo
python3 -m unittest discover -s tests -v
find web -type f -name '*.js' -print0 | xargs -0 -r -n 1 node --check
bash .github/scripts/smoke.sh
```

Node 22 is used for JavaScript checks in CI. The smoke check needs Bash, curl and fuser; it uses port 7499 and
an isolated temporary home. If that port is occupied, run `SMOKE_PORT=17499 bash .github/scripts/smoke.sh`.
Tests use temporary data and mocks; they do not need Claude credentials, real agents,
`/run/user/<uid>/cc-socks`, or systemd. Demo mode is the best way to reproduce UI issues without personal data.
To inspect real sessions, run `python3 -m office serve` and visit http://127.0.0.1:7420.

Keep changes focused, add regression tests for backend bugs, and run the checks above. Describe the problem,
resulting behavior and validation in your pull request. Keep generated recordings, account data and personal
configuration out of commits. Report vulnerabilities through SECURITY.md instead of public bug reports.

## Safety rules

- Bind only to loopback. Keep Host and Origin checks on every API and page route; do not expose the service
  through a public proxy or add permissive CORS.
- Require the per-install token on every write, including messages and lane actions. GET requests must not send
  messages or launch work.
- Never claim a sender permission mode in a message or bypass Claude Code's terminal review. A lane's explicitly
  configured execution permissions are separate from message provenance. Follow-ups resume finished sessions.
- Never send account credentials to the page, logs or usage cache. Redact transcript text and metadata; the
  office's own write token is the intentional exception needed by its local page.
- Treat socket frames, transcripts and session files as untrusted input. Bound reads and concurrency, validate
  paths and peer ownership, and keep subprocess arguments separate without a shell.
- Preserve demo mode's lack of account access and operational writes. Test fixtures must not launch real agents.

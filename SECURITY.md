# Security policy

Report a vulnerability privately using GitHub's “Report a vulnerability” option under the repository Security
tab: https://github.com/JigarJoshi04/claude-office/security/advisories/new. If private reporting is unavailable,
open an issue asking for a private contact channel without including exploit details, personal data or secrets.
Include the affected commit, reproduction using fake data, expected behavior and likely impact. Do not attach
real credentials or unredacted transcripts. There is no guaranteed response time or supported-version SLA;
fixes target the current repository version.

## Threat model

- **Local service:** HTTP binds to 127.0.0.1. Host and Origin validation defend against foreign pages and DNS
  rebinding; exposing it through a public proxy is outside the supported deployment model.
- **Other accounts on the machine:** a loopback port has no notion of who is asking, so the office looks up the
  owner of each client socket in `/proc/net/tcp` and answers only the user it runs as. Another Unix account gets a
  refusal for every request, reads included (conversations, briefs, the cabinet). `"same_user_only": false` in
  `config.json` turns this off.
- **Write authority:** all HTTP writes require the per-install office token and JSON. The local page receives
  that token; a remote page must never receive it through CORS or caching.
- **Account secrets:** account credentials are used locally for usage queries, never intentionally exposed to
  the browser or cached. Credential-shaped transcript strings are masked; this is not a guarantee that all
  sensitive prose is detected, so do not share raw snapshots or conversations.
- **Session sockets:** targets must be owned by the current UID in its private canonical cc-socks directory,
  without symlink aliases. The connected peer UID is checked before sending; the inbox rejects other UIDs.
- **Local trust boundary:** processes running as the same user can read local tokens and change account files.
  They are not isolated principals. Inbox sender labels and receipts are advisory, not cryptographic identity.
- **Resource abuse:** inbox frames, connection concurrency, read deadlines, message rates and stored history
  are bounded. Malformed records are ignored. This reduces abuse but does not promise resistance to every
  same-user denial of service.
- **Agent authority:** messages never attest a sender permission mode. Terminal sessions retain Claude Code's
  review rule. Only office lanes configured to accept messages receive them directly; follow-ups are for
  finished sessions and run with the configured lane permissions and access of the local user.
- **Untrusted content:** transcripts and replies are data, not executable code. The page escapes content and
  uses a CSP; follow-up IDs and paths are validated and child processes use argv arrays. Demo mode reads no
  real accounts and performs no operational writes.

#!/usr/bin/env bash
# Install Claude Office as an always-on systemd user service on http://127.0.0.1:<port> (default 7420).
#   bin/install.sh            install or update, then (re)start
#   bin/install.sh --remove   stop and remove the service (your config and lanes stay)
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
unit="$HOME/.config/systemd/user/claude-office.service"
if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now claude-office.service 2>/dev/null || true
  rm -f "$unit" && systemctl --user daemon-reload
  echo "Removed. Config stays in ~/.config/claude-office, lanes in ~/.local/share/claude-office."
  exit 0
fi
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
py="$(command -v python3)"
mkdir -p "$(dirname "$unit")"
# The office starts lanes, so it needs the PATH that finds `claude` and `gpt`: take the one you have now.
sed -e "s#@REPO@#$repo#g" -e "s#@PYTHON@#$py#g" -e "s#@PATH@#$PATH#g" -e "s#@HOME@#$HOME#g" \
  "$repo/systemd/claude-office.service.in" > "$unit"
systemctl --user daemon-reload
systemctl --user enable claude-office.service >/dev/null
systemctl --user restart claude-office.service
port="$(cd "$repo" && "$py" -c 'from office import config; print(config.load_config().get("port", config.DEFAULT_PORT))')"
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$port/healthz" 2>/dev/null; then
    echo "Claude Office is open at http://127.0.0.1:$port"; exit 0
  fi
  sleep 0.5
done
echo "Service started but is not answering yet: journalctl --user -u claude-office -n 50" >&2
exit 1

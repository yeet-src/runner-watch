#!/usr/bin/env bash
# Install the hub on this host: a yeet service whose web server serves
# the dashboard at /, an agent-readable index at /llms.txt, and proxies each runner's agent at /r/<name>/, so
# the browser only ever talks to the hub. Runners are discovered from
# `tailscale status` by hostname prefix, or given explicitly.
#
#   scripts/install-hub.sh [--port PORT] [--agent-port PORT] [--prefix PREFIX]
#                          [--runner NAME=HOST ...] [--dry-run]
#
#   --port        hub web server port (default: 9430)
#   --agent-port  port the agents listen on (default: 9420)
#   --prefix      tailscale hostname prefix to match (default: github-actions-runner-)
#   --runner      add a runner by hand, as NAME=HOST (repeatable); with any
#                 --runner, tailscale is not consulted
#   --dry-run     print the service file instead of installing it
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
PORT=9430
AGENT_PORT=9420
PREFIX=github-actions-runner-
DRY=
declare -a RUNNERS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT=$2; shift 2 ;;
    --agent-port) AGENT_PORT=$2; shift 2 ;;
    --prefix) PREFIX=$2; shift 2 ;;
    --runner) RUNNERS+=("$2"); shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done

if [ ${#RUNNERS[@]} -eq 0 ]; then
  # MagicDNS names resolve to whichever address tailscale prefers; the
  # hub daemon dials them, so no addresses are baked into the service.
  # The upstream is http:// so plain requests (/metrics) forward too,
  # not only the dashboard's websocket upgrades.
  mapfile -t RUNNERS < <(tailscale status --json | python3 -I -c '
import json, sys
prefix = sys.argv[1]
peers = json.load(sys.stdin)["Peer"].values()
names = sorted((p["HostName"] for p in peers if p["HostName"].startswith(prefix)),
               key=lambda s: [int(t) if t.isdigit() else t for t in __import__("re").split(r"(\d+)", s)])
for n in names: print(f"{n}={n}")
' "$PREFIX")
fi
[ ${#RUNNERS[@]} -gt 0 ] || { echo "no runners found (prefix '$PREFIX'); pass --runner NAME=HOST" >&2; exit 1; }

names=$(printf '%s\n' "${RUNNERS[@]}" | cut -d= -f1 | python3 -I -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
llms_args=$(printf '"--port", "%s"' "$PORT"; for entry in "${RUNNERS[@]}"; do printf ', "--runner", "%s"' "${entry%%=*}"; done)
toml=$(
  cat <<T
alias = "runner-watch-hub"
restart = "always"
enabled = true
working-directory = "$HERE"

[units.llms]
isolate = "$HERE/hub-llms.js"
lazy = true
args = [$llms_args]

[units.web]
web-server = "http://0.0.0.0:$PORT/"

[units.web.routes."/"]
static = "$HERE/public"
description = "the dashboard"

[units.web.routes."/llms.txt"]
target = "llms"
portal = "console"
tenancy = "per-connection"
description = "plain-text index for agents, one request each"
T
  for entry in "${RUNNERS[@]}"; do
    name=${entry%%=*}; host=${entry#*=}
    printf '\n[units.web.routes."/r/%s"]\nupstream = "http://%s:%s/"\ndescription = "agent on %s"\n' "$name" "$host" "$AGENT_PORT" "$name"
  done
)

if [ -n "$DRY" ]; then echo "$toml"; echo; echo "runners.json: $names"; exit 0; fi

echo "$names" > "$HERE/public/runners.json"
# `apply` rolls the change out without dropping the web server and
# takes route changes live; older CLIs recreate the service instead.
if yeet service apply --help >/dev/null 2>&1; then
  echo "$toml" | yeet service apply -f - >/dev/null
  yeet service enable runner-watch-hub >/dev/null 2>&1 || true
  yeet service start runner-watch-hub >/dev/null 2>&1 || true
else
  yeet service stop runner-watch-hub >/dev/null 2>&1 || true
  yeet service remove runner-watch-hub >/dev/null 2>&1 || true
  echo "$toml" | yeet service new --dev -q -y -f - >/dev/null
  yeet service start runner-watch-hub
fi
echo "hub: http://localhost:$PORT/  (${#RUNNERS[@]} runners)"

#!/usr/bin/env bash
# Install the runner-watch agent on this host: `yeet service apply` of
# service.toml, with a name or another port swapped in first. Run it
# from a checkout on the runner box; deploy.sh does over ssh.
#
#   scripts/install-agent.sh [--name NAME] [--port PORT]
#
#   --name  what /metrics and /llms.txt call this runner (default: the
#           hostname; the dashboard names runners by their hub route)
#   --port  web server port (default: 9420)
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NAME=$(hostname -s 2>/dev/null || hostname)
PORT=9420
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done
cd "$HERE"

# Isolate paths resolve relative to the service file, so the rendered
# copy sits beside service.toml.
sed -e "s|^args = \[|args = [\"--name\", \"$NAME\", |" -e "s|0\.0\.0\.0:9420|0.0.0.0:$PORT|" service.toml > .deploy.toml
trap 'rm -f .deploy.toml' EXIT
yeet service apply -y -f .deploy.toml runner-watch
echo "runner-watch agent '$NAME' serving ws://0.0.0.0:$PORT/tty"

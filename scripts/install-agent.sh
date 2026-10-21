#!/usr/bin/env bash
# Install the runner-watch agent on this host as a yeet service: an
# isolate that samples the system graph and a web server that serves
# its tty portal at /tty, plus per-request /metrics and /llms.txt. Run it on each runner box from a checkout of
# this directory.
#
#   scripts/install-agent.sh [--name NAME] [--port PORT] [--dev] [--dir DIR]
#
#   --name  what the dashboard calls this runner (default: hostname)
#   --port  web server port (default: 9420)
#   --dev   run the files in place so an edit shows up on restart
#   --dir   install location when not --dev (default: /opt/runner-watch)
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NAME=$(hostname -s 2>/dev/null || hostname)
PORT=9420
DEV=
DIR=/opt/runner-watch
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --dev) DEV=1; shift ;;
    --dir) DIR=$2; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done

if [ -n "$DEV" ]; then
  DIR=$HERE
else
  mkdir -p "$DIR"
  cp -r "$HERE/agent.js" "$HERE/metrics.js" "$HERE/llms.js" "$HERE/portal.js" "$HERE/lib" "$HERE/hooks" "$HERE/agent.service.toml" "$DIR/"
fi

yeet service stop runner-watch >/dev/null 2>&1 || true
yeet service remove runner-watch >/dev/null 2>&1 || true
sed -e "s|__DIR__|$DIR|g" -e "s|__NAME__|$NAME|g" -e "s|__PORT__|$PORT|g" "$DIR/agent.service.toml" \
  | yeet service new ${DEV:+--dev} -q -y -f - >/dev/null
yeet service start runner-watch
echo "runner-watch agent '$NAME' serving ws://0.0.0.0:$PORT/tty"
yeet service tree | grep -A3 "runner-watch)"

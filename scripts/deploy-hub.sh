#!/usr/bin/env bash
# Put the hub on a host over SSH: copy the committed tree there and run
# install-hub.sh. The host only needs yeet (logged in), tailscale and
# python3; it does not need to reach GitHub. A yeet too old for
# `service apply` is upgraded first, which needs sudo there.
#
#   scripts/deploy-hub.sh [user@]HOST [install-hub.sh flags…]
#
#   SSH_OPTS=…     extra ssh flags
#   HUB_DIR=…      where to put the tree on the host (default: ~/runner-watch)
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
[ $# -ge 1 ] || { echo "usage: scripts/deploy-hub.sh [user@]HOST [install-hub.sh flags…]" >&2; exit 2; }
HOST=$1; shift
FLAGS=${*:---prefix github-actions-runner-}
DIR=${HUB_DIR:-\~/runner-watch}

echo "== $HOST"
git -C "$HERE" archive --format=tar HEAD \
  | ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new ${SSH_OPTS:-} "$HOST" \
      "set -e; rm -rf $DIR && mkdir -p $DIR && tar -x -C $DIR && cd $DIR \
       && (yeet service apply --help >/dev/null 2>&1 || curl -fsSL https://yeet.cx | sh -s -- --no-phone-home) \
       && scripts/install-hub.sh $FLAGS"

port=$(printf '%s\n' "$FLAGS" | grep -oE -- '--port [0-9]+' | awk '{print $2}' || true); port=${port:-9430}
plain=${HOST#*@}
for i in 1 2 3 4 5 6; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$plain:$port/" || true)
  [ "$code" = 200 ] && break; sleep 2
done
[ "$code" = 200 ] || { echo "hub installed but http://$plain:$port/ answered $code" >&2; exit 1; }
n=$(curl -s --max-time 20 "http://$plain:$port/.well-known/yeet/manifest.json" | grep -o '"/r/[^/"]*/tty"' | wc -l)
echo "hub: http://$plain:$port/  reaching $n runners"

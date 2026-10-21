#!/usr/bin/env bash
# Put the runner-watch agent on runner hosts over SSH. Each host already
# runs yeet; this copies the project into ~/runner-watch there, installs
# the agent service in place, and then checks the agent from here over
# the tailnet.
#
#   scripts/deploy.sh HOST [HOST ...]           named hosts
#   scripts/deploy.sh --all                     every github-actions-runner-* in tailscale
#   scripts/deploy.sh --prefix my-runner- --all
#
#   --no-hub           do not (re)install the hub on this host afterwards
#   --hub-port 9430    hub web server port
#
#   SSH_USER=ci   user to log in as (default: your own)
#   SSH_OPTS=…    extra ssh flags, e.g. "-i ~/.ssh/runners"
#   PORT=9420     agent port
#   SUDO=sudo     prefix yeet with sudo on the remote, if the service
#                 socket needs it
#   --restart-runner   after wiring the job hook into the runner's .env,
#                 restart the runner service when it is idle so the hook
#                 takes effect (otherwise it waits for the next restart)
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-9420}
PREFIX=github-actions-runner-
ALL=
RESTART=
HUB=1
HUB_PORT=9430
declare -a HOSTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1; shift ;;
    --prefix) PREFIX=$2; shift 2 ;;
    --restart-runner) RESTART=--restart; shift ;;
    --no-hub) HUB=; shift ;;
    --hub-port) HUB_PORT=$2; shift 2 ;;
    -*) echo "unknown flag $1" >&2; exit 2 ;;
    *) HOSTS+=("$1"); shift ;;
  esac
done
if [ -n "$ALL" ]; then
  mapfile -t HOSTS < <(tailscale status --json | python3 -I -c '
import json, re, sys
prefix = sys.argv[1]
peers = json.load(sys.stdin)["Peer"].values()
names = [p["HostName"] for p in peers if p["HostName"].startswith(prefix) and p.get("Online")]
for n in sorted(names, key=lambda s: [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]): print(n)
' "$PREFIX")
fi
[ ${#HOSTS[@]} -gt 0 ] || { echo "no hosts: pass HOST… or --all" >&2; exit 1; }

ssh_to() { # host, command…
  local host=$1; shift
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${SSH_OPTS:-} "${SSH_USER:+$SSH_USER@}$host" "$@"
}

ok=(); failed=()
for host in "${HOSTS[@]}"; do
  echo "== $host"
  if tar -C "$HERE" -czf - agent.js metrics.js llms.js portal.js lib agent.service.toml hooks scripts/install-agent.sh scripts/install-hooks.sh \
    | ssh_to "$host" "set -e; mkdir -p ~/runner-watch && tar -C ~/runner-watch -xzf - \
        && cd ~/runner-watch && ${SUDO:-} scripts/install-agent.sh --dev --port $PORT --name \$(hostname -s) \
        && (scripts/install-hooks.sh $RESTART || echo '   (job hook not installed: no runner found or restart refused)')"; then
    if yeet dial -m "ws://$host:$PORT/" 2>/dev/null | grep -q '/tty'; then
      echo "   agent up: ws://$host:$PORT/tty"; ok+=("$host")
    else
      echo "   installed, but ws://$host:$PORT/ is not answering from here (firewall on tailscale0?)" >&2; failed+=("$host")
    fi
  else
    echo "   deploy failed" >&2; failed+=("$host")
  fi
done

echo
echo "ok: ${#ok[@]}  failed: ${#failed[@]}${failed[*]:+ (${failed[*]})}"

# The hub on this host, with the same roster: by prefix when the hosts
# came from tailscale (so a runner that was down today is still listed),
# otherwise the hosts as given.
if [ -n "$HUB" ] && [ ${#ok[@]} -gt 0 ]; then
  echo
  if [ -n "$ALL" ]; then
    "$HERE/scripts/install-hub.sh" --port "$HUB_PORT" --agent-port "$PORT" --prefix "$PREFIX"
  else
    args=(); for h in "${HOSTS[@]}"; do n=${h#*@}; args+=(--runner "$n=$n"); done
    "$HERE/scripts/install-hub.sh" --port "$HUB_PORT" --agent-port "$PORT" "${args[@]}"
  fi
elif [ ${#ok[@]} -gt 0 ]; then
  echo "hub skipped; install it with scripts/install-hub.sh${ALL:+ --prefix $PREFIX}$([ -n "$ALL" ] || for h in "${HOSTS[@]}"; do printf ' --runner %s=%s' "${h#*@}" "${h#*@}"; done)"
fi
[ ${#failed[@]} -eq 0 ]

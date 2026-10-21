#!/usr/bin/env bash
# Wire runner-watch's job hook into the GitHub Actions runner on this
# host. Finds the runner root from its Runner.Listener process, points
# ACTIONS_RUNNER_HOOK_JOB_STARTED / _COMPLETED in <root>/.env at
# hooks/job-hook.sh, and (with --restart) restarts the runner service
# while it is idle so the new .env is read.
#
#   scripts/install-hooks.sh [--root DIR] [--restart]
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
HOOKS=$HERE/hooks
ROOT=
RESTART=
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2 ;;
    --restart) RESTART=1; shift ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done
if [ -z "$ROOT" ]; then
  pid=$(pgrep -o -x Runner.Listener || true)
  [ -n "$pid" ] || { echo "no Runner.Listener running; pass --root <runner dir>" >&2; exit 1; }
  ROOT=$(dirname "$(dirname "$(readlink -f "/proc/$pid/exe")")")
fi
[ -d "$ROOT/bin" ] || { echo "$ROOT does not look like a runner root (no bin/)" >&2; exit 1; }
chmod +x "$HOOKS"/*.sh
# The runner runs the hook as its own user, which may not be the one
# deploying; the path has to be reachable and executable for it.
owner=$(stat -c %U "$ROOT")
if [ "$owner" != "$(id -un)" ] && command -v sudo >/dev/null && sudo -n -u "$owner" test -x "$HOOKS/job-started.sh" 2>/dev/null; then :
elif [ "$owner" != "$(id -un)" ]; then echo "note: runner runs as '$owner'; make sure it can read $HOOKS (chmod o+rx on the path)" >&2; fi

ENV_FILE=$ROOT/.env
touch "$ENV_FILE"
grep -v -E '^ACTIONS_RUNNER_HOOK_JOB_(STARTED|COMPLETED)=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s/job-started.sh\nACTIONS_RUNNER_HOOK_JOB_COMPLETED=%s/job-completed.sh\n' "$HOOKS" "$HOOKS" >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
echo "hooks: $ENV_FILE -> $HOOKS/job-started.sh, job-completed.sh"

unit=$(systemctl list-units --plain --no-legend 'actions.runner.*' 2>/dev/null | awk '{print $1}' | head -1 || true)
if [ -z "$RESTART" ]; then
  echo "restart the runner to load .env: ${unit:+sudo systemctl restart $unit  (or) }cd $ROOT && sudo ./svc.sh stop && sudo ./svc.sh start"
  exit 0
fi
if pgrep -x Runner.Worker >/dev/null; then echo "a job is running; not restarting the runner now" >&2; exit 3; fi
SUDO=$([ "$(id -u)" = 0 ] || echo sudo)
if [ -n "$unit" ]; then $SUDO systemctl restart "$unit"; echo "restarted $unit"
elif [ -x "$ROOT/svc.sh" ]; then (cd "$ROOT" && $SUDO ./svc.sh stop && $SUDO ./svc.sh start); echo "restarted via svc.sh"
else echo "no runner service found to restart; restart it by hand" >&2; exit 4; fi

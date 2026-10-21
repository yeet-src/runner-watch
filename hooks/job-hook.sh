#!/usr/bin/env bash
# GitHub Actions runner job hook for runner-watch. Wired through the
# runner's `.env` as ACTIONS_RUNNER_HOOK_JOB_STARTED / _COMPLETED (see
# scripts/install-hooks.sh), so the runner runs it with the job's
# GITHUB_* environment at the start and end of every job. It sends the
# job's identity to the local agent through its tty, one JSON line per
# message, and on start leaves a tailer behind that follows the worker's
# own log for the job's lifetime and relays each step's name and result.
#
#   job-hook.sh started|completed
set -u
PHASE=${1:-started}
AGENT=${RUNNER_WATCH_URL:-ws://127.0.0.1:9420/tty}
YEET=${RUNNER_WATCH_YEET:-$(command -v yeet || echo /usr/bin/yeet)}

json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'; }
now_ms() { date +%s%3N; }

# `yeet dial` turns its stdin's EOF into the tty's end-of-input key,
# and the daemon then hangs up the shared tty for every peer, dashboard
# included. A SIGTERM makes dial send that key on its way out too. So
# a connection is fed through a fifo and SIGKILLed, never closed:
# dial_open / dial_say / dial_close.
dial_open() {
  DIAL_FIFO=$(mktemp -u /tmp/runner-watch.XXXXXX); mkfifo -m 600 "$DIAL_FIFO"
  "$YEET" dial "$AGENT" < "$DIAL_FIFO" >/dev/null 2>&1 & DIAL_PID=$!; disown "$DIAL_PID"
  exec 3> "$DIAL_FIFO"
}
dial_say() { printf '%s\n' "$1" >&3; }
dial_close() { sleep 0.5; kill -9 "$DIAL_PID" 2>/dev/null; exec 3>&-; rm -f "$DIAL_FIFO"; }
send() { dial_open; dial_say "$1"; dial_close; }

JOB_KEY="${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-1}-${GITHUB_JOB:-}"
send "$(printf '{"t":"job","phase":"%s","key":"%s","ts":%s,"repo":"%s","runId":"%s","runNumber":"%s","runAttempt":"%s","job":"%s","workflow":"%s","serverUrl":"%s","sha":"%s","ref":"%s","actor":"%s","event":"%s","runner":"%s"}' \
  "$PHASE" "$(json_str "$JOB_KEY")" "$(now_ms)" "$(json_str "${GITHUB_REPOSITORY:-}")" "$(json_str "${GITHUB_RUN_ID:-}")" \
  "$(json_str "${GITHUB_RUN_NUMBER:-}")" "$(json_str "${GITHUB_RUN_ATTEMPT:-}")" "$(json_str "${GITHUB_JOB:-}")" \
  "$(json_str "${GITHUB_WORKFLOW:-}")" "$(json_str "${GITHUB_SERVER_URL:-https://github.com}")" "$(json_str "${GITHUB_SHA:-}")" \
  "$(json_str "${GITHUB_REF_NAME:-${GITHUB_REF:-}}")" "$(json_str "${GITHUB_ACTOR:-}")" "$(json_str "${GITHUB_EVENT_NAME:-}")" "$(json_str "${RUNNER_NAME:-}")")"

[ "$PHASE" = started ] || exit 0

# The worker that is running this job is the newest Runner.Worker; its
# binary sits in <root>/bin, and its log is the newest Worker_*.log in
# <root>/_diag. The tailer dies with the worker (`--pid`).
WORKER_PID=$(pgrep -n -x Runner.Worker 2>/dev/null || true)
[ -n "$WORKER_PID" ] || exit 0
ROOT=${RUNNER_WATCH_RUNNER_ROOT:-$(dirname "$(dirname "$(readlink -f "/proc/$WORKER_PID/exe")")")}
LOG=$(ls -t "$ROOT"/_diag/Worker_*.log 2>/dev/null | head -1)
[ -n "$LOG" ] || exit 0

setsid nohup bash -c '
  WORKER_PID=$1; LOG=$2; KEY=$3; AGENT=$4; YEET=$5
  json_str() { printf "%s" "$1" | sed -e "s/\\\\/\\\\\\\\/g" -e "s/\"/\\\\\"/g" | tr -d "\n\r"; }
  Q=$(printf "\x27")
  FIFO=$(mktemp -u /tmp/runner-watch.XXXXXX); mkfifo -m 600 "$FIFO"
  "$YEET" dial "$AGENT" < "$FIFO" >/dev/null 2>&1 & DIAL=$!; disown "$DIAL"
  exec 3> "$FIFO"
  trap "kill -9 $DIAL 2>/dev/null; rm -f $FIFO" EXIT
  # The worker log is per job, so replaying it from the top only adds
  # the steps that ran before this hook (Set up job).
  tail -n +1 --pid="$WORKER_PID" -F "$LOG" 2>/dev/null \
  | while IFS= read -r line; do
      # A replayed line is older than this read; its own timestamp is
      # the truth. A live line is fresher than the second the log keeps.
      now=$(date +%s%3N); ts=$now
      logged=$(date -d "${line:1:20}" +%s%3N 2>/dev/null) && [ $((now - logged)) -gt 2000 ] && ts=$logged
      case "$line" in
        *"Processing step: DisplayName="*)
          name=${line#*DisplayName=$Q}; name=${name%%$Q, ContinueOnError=*}
          printf "{\"t\":\"step\",\"key\":\"%s\",\"ts\":%s,\"name\":\"%s\"}\n" "$KEY" "$ts" "$(json_str "$name")" >&3 ;;
        *"Step result: "*)
          result=${line##*Step result: }
          printf "{\"t\":\"stepResult\",\"key\":\"%s\",\"ts\":%s,\"result\":\"%s\"}\n" "$KEY" "$ts" "$(json_str "${result%%[[:space:]]*}")" >&3 ;;
      esac
    done
  sleep 0.5
' tailer "$WORKER_PID" "$LOG" "$JOB_KEY" "$AGENT" "$YEET" >/dev/null 2>&1 < /dev/null &
disown
exit 0

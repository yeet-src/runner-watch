#!/usr/bin/env bash
# A stand-in runner process tree for developing the agent without a real
# GitHub Actions runner. The agent matches on the process name, so bash
# is copied in as `Runner.Listener` and `Runner.Worker`: a listener that
# every few seconds forks a worker whose steps burn cpu in
# `_work/<repo>/<repo>`. Ctrl-C stops it.
#
#   scripts/fake-runner.sh [root-dir] [repo-name]
#   CONTAINER=1 scripts/fake-runner.sh      # run the build step through docker exec like a container: job
set -euo pipefail
ROOT=${1:-/tmp/fake-actions-runner}
REPO=${2:-demo-repo}
mkdir -p "$ROOT/bin" "$ROOT/_work/$REPO/$REPO"
cp "$(command -v bash)" "$ROOT/bin/Runner.Listener"
cp "$(command -v bash)" "$ROOT/bin/Runner.Worker"

mkdir -p "$ROOT/_diag"
HOOK=$(cd "$(dirname "$0")/.." && pwd)/hooks/job-hook.sh
cat > "$ROOT/bin/worker.sh" <<W
cd "\$1"
export GITHUB_REPOSITORY=yeet-cx/$REPO GITHUB_RUN_ID=\$((RANDOM + 1000000)) GITHUB_RUN_NUMBER=\$((RANDOM % 900 + 100)) GITHUB_RUN_ATTEMPT=1
export GITHUB_JOB=build GITHUB_WORKFLOW=ci GITHUB_SERVER_URL=https://github.com GITHUB_SHA=\$(head -c 20 /dev/urandom | od -An -tx1 | tr -d ' \\n')
export GITHUB_REF_NAME=main GITHUB_ACTOR=\$(id -un) GITHUB_EVENT_NAME=push RUNNER_NAME=\$(hostname -s)
LOG=$ROOT/_diag/Worker_\$(date -u +%Y%m%d-%H%M%S)-utc.log
: > "\$LOG"
step() { echo "[\$(date -u +%Y-%m-%d\ %H:%M:%SZ) INFO StepsRunner] Processing step: DisplayName='\$1', ContinueOnError=False, Condition=success()" >> "\$LOG"; }
done_step() { echo "[\$(date -u +%Y-%m-%d\ %H:%M:%SZ) INFO StepsRunner] Step result: \$1" >> "\$LOG"; }
"$HOOK" started
step "Set up job"; sleep 1; done_step Succeeded
step "Run actions/checkout@v4"; sleep 1; done_step Succeeded
step "Build"
if [ -n "${CONTAINER:-}" ]; then
  CID=\$(docker run -d --rm -v "$ROOT/_work:/__w" --workdir /__w/$REPO/$REPO alpine:latest sleep 60)
  docker exec -i --workdir /__w/$REPO/$REPO "\$CID" sh -c 'end=\$((\$(date +%s)+4)); while [ \$(date +%s) -lt \$end ]; do :; done; sleep 3'
  docker rm -f "\$CID" >/dev/null
else
  sh -c 'end=\$((SECONDS+3)); while [ \$SECONDS -lt \$end ]; do :; done'
fi
done_step Succeeded
step "Run tests"; sh -c 'end=\$((SECONDS+2)); while [ \$SECONDS -lt \$end ]; do :; done'; done_step Failed
step "Upload artifacts"; sleep 1; done_step Skipped
"$HOOK" completed
W
cat > "$ROOT/bin/listener.sh" <<'L'
trap 'kill 0' EXIT
while :; do
  sleep "$((RANDOM % 5 + 3))"
  "$(dirname "$0")/Runner.Worker" "$(dirname "$0")/worker.sh" "$1"
done
L
echo "fake runner at $ROOT (repo $REPO); Ctrl-C to stop"
exec "$ROOT/bin/Runner.Listener" "$ROOT/bin/listener.sh" "$ROOT/_work/$REPO/$REPO"

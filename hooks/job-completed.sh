#!/usr/bin/env bash
# A hook that fails fails the job, so this never does.
"$(dirname "$0")/job-hook.sh" completed || true
exit 0

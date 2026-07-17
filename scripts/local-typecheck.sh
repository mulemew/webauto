#!/usr/bin/env bash
# Local mirror of the CI typecheck gate.
#
# `pnpm run typecheck` can't be used here: pnpm runs a deps-status check that fires
# the root `preinstall` hook (`sh -c ...`), which exits non-zero under Git Bash on
# Windows and takes the whole command down before tsc ever starts. Calling tsc
# directly does exactly what CI does — build the workspace libs so their .d.ts exist,
# then typecheck each app against them.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ ! -x ./node_modules/.bin/tsc ]; then
  echo "deps missing — run: pnpm install" >&2
  exit 1
fi

fail=0
echo "── building libs (tsc --build) ──"
./node_modules/.bin/tsc --build || fail=1

for app in api-server web-ui; do
  echo "── typecheck: $app ──"
  (cd "artifacts/$app" && ../../node_modules/.bin/tsc -p tsconfig.json --noEmit) || fail=1
done

if [ "$fail" -eq 0 ]; then
  echo "✓ typecheck clean"
else
  echo "✗ typecheck FAILED" >&2
fi
exit "$fail"

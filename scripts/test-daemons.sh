#!/bin/sh
# Runs the Go tests of yaac's daemons (daemons/acpd and daemons/streamd)
# under the race detector. Needs Go on PATH, as `pnpm build` does; extra
# arguments go to `go test`.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
for dir in "$root"/daemons/*/; do
  echo "== ${dir#"$root"/}"
  (cd "$dir" && go vet ./... && go test -race "$@" ./...)
done

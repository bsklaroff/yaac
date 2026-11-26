#!/bin/sh
# Runs acpd's Go tests (dockerfiles/acpd) under the race detector. Needs Go
# on PATH, as `pnpm build` does; extra arguments go to `go test`.
set -eu
cd "$(dirname "$0")/../dockerfiles/acpd"
go vet ./...
exec go test -race "$@" ./...

#!/bin/sh
# Cross-compiles acpd (dockerfiles/acpd) into dockerfiles/acpd/bin, one
# static binary per host the containerless driver runs on, named
# acpd-<GOOS>-<GOARCH> (`acpdBinary` in the containerless driver picks one).
# `build:assets` copies them into dist/. The image builds its own in
# Dockerfile.default. Needs Go 1.21 or newer on PATH. -buildvcs=false keeps
# the commit out of the binaries, so they change only when acpd does.
#
# Skipped when bin/ already holds every binary built from these sources
# (bin/.input-hash), so `pnpm watch` does not rebuild on every save.
set -eu
cd "$(dirname "$0")/../dockerfiles/acpd"
targets='linux/amd64 linux/arm64 darwin/amd64 darwin/arm64'
inputs=$(cat go.mod $(ls *.go | grep -v '_test\.go$') | cksum)
built=true
for target in $targets; do
  [ -x "bin/acpd-${target%/*}-${target#*/}" ] || built=false
done
if $built && [ "$(cat bin/.input-hash 2>/dev/null || true)" = "$inputs" ]; then
  exit 0
fi
if ! command -v go >/dev/null 2>&1; then
  echo 'build:acpd: Go 1.21 or newer is not on PATH. Install it (https://go.dev/dl, brew install go, apt install golang-go).' >&2
  exit 1
fi
rm -rf bin
for target in $targets; do
  GOOS=${target%/*} GOARCH=${target#*/} CGO_ENABLED=0 \
    go build -trimpath -buildvcs=false -ldflags='-s -w' -o "bin/acpd-${target%/*}-${target#*/}" .
done
printf '%s\n' "$inputs" > bin/.input-hash

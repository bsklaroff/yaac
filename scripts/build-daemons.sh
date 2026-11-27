#!/bin/sh
# Cross-compiles yaac's Go daemons (daemons/) into each one's bin/, named
# <daemon>-<GOOS>-<GOARCH>: acpd for every host the containerless driver
# runs on (`acpdBinary` picks one), and streamd for the Linux nodes a
# cluster runs on. `build:assets` copies them into dist/, and the server
# stages the Linux pair matching its own architecture in its helpers folder
# for k8s pods (`stageHelpers`). Needs Go 1.22 or newer on PATH, and the Go
# module proxy the first time, for streamd's one dependency. -buildvcs=false
# keeps the commit out of the binaries, so they change only when their
# source does.
#
# A daemon is skipped when its bin/ already holds every binary built from
# its current sources (bin/.input-hash), so `pnpm watch` does not rebuild on
# every save.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)

build() {
  name=$1
  shift
  cd "$root/daemons/$name"
  inputs=$(cat go.mod $(ls go.sum 2>/dev/null || true) $(ls *.go | grep -v '_test\.go$') | cksum)
  built=true
  for target; do
    [ -x "bin/$name-${target%/*}-${target#*/}" ] || built=false
  done
  if $built && [ "$(cat bin/.input-hash 2>/dev/null || true)" = "$inputs" ]; then
    return
  fi
  if ! command -v go >/dev/null 2>&1; then
    echo 'build:daemons: Go 1.22 or newer is not on PATH. Install it (https://go.dev/dl, brew install go, apt install golang-go).' >&2
    exit 1
  fi
  rm -rf bin
  for target; do
    GOOS=${target%/*} GOARCH=${target#*/} CGO_ENABLED=0 \
      go build -trimpath -buildvcs=false -ldflags='-s -w' -o "bin/$name-${target%/*}-${target#*/}" .
  done
  printf '%s\n' "$inputs" > bin/.input-hash
}

build acpd linux/amd64 linux/arm64 darwin/amd64 darwin/arm64
build streamd linux/amd64 linux/arm64

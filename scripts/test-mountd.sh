#!/bin/sh
# Runs the Go tests of mountd, the arborist and sandbox-bind (k8s/mountd)
# in the Go image their Dockerfile builds with, so no Go toolchain is needed
# on the host. git is added for the arborist's tests. `--userns=keep-id` runs them as the
# checkout's owner: a test that checks file permissions would pass for
# anything as root. Needs podman; extra arguments go to `go test`.
set -eu
cd "$(dirname "$0")/../k8s/mountd"
image=$(sed -n 's/^FROM \(docker.io\/library\/golang[^ ]*\) AS build$/\1/p' Dockerfile)
exec podman run --rm --userns=keep-id --user 0 -v "$PWD:/src:Z" -w /src -e CGO_ENABLED=0 "$image" \
  sh -c 'apk add -q git >/dev/null && adduser -D -H -u '"$(id -u)"' tester && exec su -s /bin/sh tester -c "export HOME=/tmp GOPATH=/tmp/go GOCACHE=/tmp/cache; go vet ./... && go test \"\$@\" ./..." -- sh "$@"' -- "$@"

#!/bin/bash
# Answers: does a POSIX lock taken inside a gVisor sandbox reach the shared
# filesystem, so a process on another node would see it?
#
# Four cells per lock flavour. The control (node holds -> node tries) must
# BLOCK, proving the filesystem's own lock manager works; if a sandboxed
# holder is then invisible to that same unsandboxed process, the sentry is
# emulating the lock internally and it never reached the server.
#
# Run: test-storage-probes/lockscope.sh [dir-in-pod] [dir-on-node]
# Needs: run-all.sh to have created the probe pods.
set -uo pipefail
cd "$(dirname "$0")"
. ./lib.sh

POD_DIR="${1:-/shared}"
NODE_DIR="${2:-$SHARED_MNT}"

for p in probe-gvisor probe-gvisor-b; do
  kubectl exec -i "$p" -n "$NS" -- sh -c 'cat > /tmp/lockhold.py' < lockhold.py
  kubectl exec -i "$p" -n "$NS" -- sh -c 'cat > /tmp/locktry.py' < locktry.py
done
podman exec -i "$NODE" sh -c 'cat > /tmp/lockhold.py' < lockhold.py
podman exec -i "$NODE" sh -c 'cat > /tmp/locktry.py' < locktry.py
nodesh "mkdir -p '$NODE_DIR/lockscope' && chown 1000:1000 '$NODE_DIR/lockscope'"

for MODE in flock fcntl; do
  echo "======== $MODE ========"
  F="lock-$MODE"

  nodesh "python3 /tmp/lockhold.py '$NODE_DIR/lockscope/$F.ctl' $MODE 8" >/dev/null 2>&1 &
  sleep 2
  printf '  %-38s ' "control: node holds -> node tries"
  nodesh "python3 /tmp/locktry.py '$NODE_DIR/lockscope/$F.ctl' $MODE"
  wait

  kubectl exec probe-gvisor -n "$NS" -- python3 /tmp/lockhold.py "$POD_DIR/lockscope/$F.snd" $MODE 10 >/dev/null 2>&1 &
  sleep 3
  printf '  %-38s ' "sandbox A holds -> node tries"
  nodesh "python3 /tmp/locktry.py '$NODE_DIR/lockscope/$F.snd' $MODE"
  printf '  %-38s ' "sandbox A holds -> sandbox B tries"
  kubectl exec probe-gvisor-b -n "$NS" -- python3 /tmp/locktry.py "$POD_DIR/lockscope/$F.snd" $MODE
  printf '  %-38s ' "sandbox A holds -> same sandbox tries"
  kubectl exec probe-gvisor -n "$NS" -- python3 /tmp/locktry.py "$POD_DIR/lockscope/$F.snd" $MODE
  wait
  echo
done

echo "ACQUIRED against a live holder means the lock never reached the server."

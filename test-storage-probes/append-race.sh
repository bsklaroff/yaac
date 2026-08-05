#!/bin/bash
# Is concurrent O_APPEND atomic when two sandboxes share one file?
#
# This is the probe that found a live bug: two gVisor sandboxes appending to the
# same file on a gofer-backed ext4 hostPath lose and interleave writes (~5% of
# lines), while the same test is clean unsandboxed, and clean on NFS. gVisor
# stamps `disable_file_handle_sharing` on remote-filesystem mounts, which is
# apparently what keeps the NFS arm honest; on ext4 each sentry appears to
# append at its own cached offset.
#
# The unsandboxed node arms are the controls -- without them you cannot tell a
# sentry bug from a filesystem one.
#
# Run: test-storage-probes/append-race.sh          (TRIALS=5 by default)
# Needs: run-all.sh to have created the probe pods.
set -uo pipefail
cd "$(dirname "$0")"
. ./lib.sh

TRIALS="${TRIALS:-5}"
LINES=200
EXPECT=$(( LINES * 2 ))

pod_trial() { # $1 label, $2 podA, $3 podB, $4 path
  local lost=0 garbled=0 t n g
  for t in $(seq 1 "$TRIALS"); do
    kubectl exec "$2" -n "$NS" -- sh -c "rm -f $4/ap.log; touch $4/ap.log" >/dev/null 2>&1
    kubectl exec "$2" -n "$NS" -- sh -c "for i in \$(seq 1 $LINES); do echo A-\$i >> $4/ap.log; done" >/dev/null 2>&1 &
    kubectl exec "$3" -n "$NS" -- sh -c "for i in \$(seq 1 $LINES); do echo B-\$i >> $4/ap.log; done" >/dev/null 2>&1 &
    wait
    sleep 1   # let attribute caches settle so the count is not itself stale
    n=$(kubectl exec "$2" -n "$NS" -- sh -c "wc -l < $4/ap.log" 2>/dev/null | tr -d ' \r')
    g=$(kubectl exec "$2" -n "$NS" -- sh -c "grep -cvE '^[AB]-[0-9]+\$' $4/ap.log" 2>/dev/null | tr -d ' \r')
    lost=$(( lost + EXPECT - ${n:-0} )); garbled=$(( garbled + ${g:-0} ))
  done
  printf '  %-48s lost %4d / %d, %d garbled\n' "$1" "$lost" "$((EXPECT*TRIALS))" "$garbled"
}

node_trial() { # $1 label, $2 path -- two unsandboxed processes on the node
  local lost=0 garbled=0 t n g
  for t in $(seq 1 "$TRIALS"); do
    nodesh "rm -f $2/ap.log; touch $2/ap.log" >/dev/null 2>&1
    nodesh "for i in \$(seq 1 $LINES); do echo A-\$i >> $2/ap.log; done" >/dev/null 2>&1 &
    nodesh "for i in \$(seq 1 $LINES); do echo B-\$i >> $2/ap.log; done" >/dev/null 2>&1 &
    wait
    n=$(nodesh "wc -l < $2/ap.log" 2>/dev/null | tr -d ' \r')
    g=$(nodesh "grep -cvE '^[AB]-[0-9]+\$' $2/ap.log" 2>/dev/null | tr -d ' \r')
    lost=$(( lost + EXPECT - ${n:-0} )); garbled=$(( garbled + ${g:-0} ))
  done
  printf '  %-48s lost %4d / %d, %d garbled\n' "$1" "$lost" "$((EXPECT*TRIALS))" "$garbled"
}

echo "=== $TRIALS trials per arm, $EXPECT lines expected per trial ==="
echo "-- two separate gVisor sandboxes --"
pod_trial  "shared filesystem" probe-gvisor probe-gvisor-b /shared
pod_trial  "node-local ext4"   probe-gvisor probe-gvisor-b /baseline
echo "-- unsandboxed controls, two processes on the node --"
node_trial "shared filesystem" "$SHARED_MNT"
node_trial "node-local ext4"   "$BASELINE_DIR"

#!/bin/bash
# Measures how long an externally-made change takes to become visible inside a
# gVisor sandbox, for the five shapes yaac actually depends on: overwrite,
# atomic rename, new directory entry, append (transcript tailing), and delete.
#
# Two writer arms, because they stress different caches:
#   backing  the writer writes straight to the export's backing store, i.e. the
#            server host writing to its own export -- yaac's initial topology.
#            Only the reader's client cache is in play.
#   client   the writer goes through probe-nfs-writer, an independent NFS client
#            with its own netns and clientaddr -- a faithful second node.
#
# Each observation is timed against a stamp the writer embeds, so the number is
# producer->consumer visibility, not poll overhead. Both sides share a clock.
#
# Run: test-storage-probes/coherence.sh <backing|client> [pod]
# Needs: run-all.sh to have created the probe pods.
set -uo pipefail
cd "$(dirname "$0")"
. ./lib.sh

ARM="${1:-backing}"
POD="${2:-probe-gvisor}"
TO="${TO:-90}"
SUB="coh-$ARM"
PODDIR="/shared/$SUB"

case "$ARM" in
  backing) WRITE() { nodesh "$1"; };            WDIR="$EXPORT_DIR/$SUB" ;;
  client)  WRITE() { kubectl exec probe-nfs-writer -n "$NS" -- sh -c "$1"; }
           WDIR="/nfs/$SUB" ;;
  *) echo "arm must be 'backing' or 'client'"; exit 1 ;;
esac

kubectl exec -i "$POD" -n "$NS" -- sh -c 'cat > /tmp/cohere.py' < cohere.py
WRITE "rm -rf '$WDIR'; mkdir -p '$WDIR'; chown -R 1000:1000 '$WDIR'"
sleep 1

echo "======== coherence: writer=$ARM  reader=$POD (gVisor) ========"

# Priming reads must not race the writer: with a cross-client writer, a file it
# just created can take acdirmin (30s by default) to become visible here, and
# priming too early fails the probe before it starts.
wait_visible() {
  for _ in $(seq 1 120); do
    kubectl exec "$POD" -n "$NS" -- test -e "$1" 2>/dev/null && return 0
    sleep 1
  done
  echo "  WARNING: $1 never became visible to $POD" >&2
  return 1
}

probe() { # $1 label, $2 cohere.py args, $3 writer command
  kubectl exec "$POD" -n "$NS" -- python3 /tmp/cohere.py $2 "$TO" > /tmp/.coh.$$ 2>&1 &
  local w=$!
  sleep 1
  WRITE "$3" >/dev/null 2>&1
  wait $w
  printf '  %-38s %s\n' "$1" "$(cat /tmp/.coh.$$)"
  rm -f /tmp/.coh.$$
}

WRITE "echo 0 > '$WDIR/f1'; chown 1000:1000 '$WDIR/f1'"
wait_visible "$PODDIR/f1"; kubectl exec "$POD" -n "$NS" -- cat "$PODDIR/f1" >/dev/null 2>&1
probe "in-place overwrite" "watch-content $PODDIR/f1" \
      "python3 -c \"import time;open('$WDIR/f1','w').write(str(time.time()))\""

WRITE "echo 0 > '$WDIR/f2'; chown 1000:1000 '$WDIR/f2'"
wait_visible "$PODDIR/f2"; kubectl exec "$POD" -n "$NS" -- cat "$PODDIR/f2" >/dev/null 2>&1
probe "atomic rename over existing" "watch-content $PODDIR/f2" \
      "python3 -c \"import time,os;open('$WDIR/f2.tmp','w').write(str(time.time()));os.rename('$WDIR/f2.tmp','$WDIR/f2')\""

kubectl exec "$POD" -n "$NS" -- ls "$PODDIR" >/dev/null 2>&1
probe "new entry in a primed directory" "watch-appear $PODDIR newfile" \
      "python3 -c \"import time;open('$WDIR/newfile','w').write(str(time.time()))\""

WRITE "python3 -c \"import time;open('$WDIR/log','w').write(str(time.time())+' start\n')\"; chown 1000:1000 '$WDIR/log'"
wait_visible "$PODDIR/log"; kubectl exec "$POD" -n "$NS" -- cat "$PODDIR/log" >/dev/null 2>&1
probe "append to a primed file (transcript)" "watch-size $PODDIR/log" \
      "python3 -c \"import time;open('$WDIR/log','a').write(str(time.time())+' appended\n')\""

WRITE "echo gone > '$WDIR/f5'; chown 1000:1000 '$WDIR/f5'"
wait_visible "$PODDIR/f5"; kubectl exec "$POD" -n "$NS" -- cat "$PODDIR/f5" >/dev/null 2>&1
probe "deletion of a primed file" "watch-vanish $PODDIR/f5" \
      "python3 -c \"import time;open('$WDIR/f5.stamp','w').write(str(time.time()))\"; rm -f '$WDIR/f5'"
echo

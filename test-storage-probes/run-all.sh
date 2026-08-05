#!/bin/bash
# Drives the whole probe chain and prints one report. Assumes the shared
# filesystem is already mounted at $SHARED_MNT on the node -- run
# setup-nfs-export.sh (or the equivalent for another backend) first.
#
# Stages: pods -> semantics -> locks -> append -> coherence -> performance -> RWX.
# Pass a stage name to run just that one.
#
# Run: test-storage-probes/run-all.sh [pods|semantics|locks|append|coherence|perf|rwx]
set -uo pipefail
cd "$(dirname "$0")"
. ./lib.sh

STAGE="${1:-all}"
want() { [ "$STAGE" = all ] || [ "$STAGE" = "$1" ]; }

if want pods; then
  IMAGE=$(probe_image) || exit 1
  SERVER=$(node_ip)
  echo "==> probe image: $IMAGE"
  sed -e "s|__IMAGE__|$IMAGE|g" -e "s|__SHARED__|$SHARED_MNT|g" \
      -e "s|__BASELINE__|$BASELINE_DIR|g" probe-pods.yaml | kubectl apply -f - >/dev/null
  sed -e "s|__SERVER__|$SERVER|g" nfs-writer-pod.yaml | kubectl apply -f - >/dev/null
  kubectl wait --for=condition=Ready pod/probe-gvisor pod/probe-gvisor-b pod/probe-runc \
    -n "$NS" --timeout=300s >/dev/null || { echo "probe pods did not start"; exit 1; }
  echo "==> waiting for the independent NFS client to mount"
  for _ in $(seq 1 60); do
    kubectl logs probe-nfs-writer -n "$NS" 2>/dev/null | grep -q MOUNTED && break
    sleep 3
  done
  kubectl logs probe-nfs-writer -n "$NS" 2>/dev/null | grep -q MOUNTED \
    || echo "WARNING: independent NFS client did not mount; the 'client' coherence arm will fail"

  # The baseline arm needs to be writable by the session uid; kubelet creates a
  # DirectoryOrCreate hostPath as root.
  nodesh "chown 1000:1000 '$BASELINE_DIR'" >/dev/null 2>&1

  echo "==> staging the clone source on the ext4 baseline"
  rm -rf "$BASELINE_DIR/src.git"
  git clone --bare --quiet "$(git -C .. rev-parse --show-toplevel)" "$BASELINE_DIR/src.git"
  echo "    $(git -C "$BASELINE_DIR/src.git" rev-list --count HEAD) commits"

  echo -n "==> sandbox confirmed: "
  kubectl exec probe-gvisor -n "$NS" -- sh -c 'dmesg 2>/dev/null | head -1' || echo "NO SENTRY BANNER"
fi

if want semantics; then
  echo; echo "################ POSIX semantics ################"
  kubectl exec -i probe-gvisor -n "$NS" -- sh -c 'cat > /tmp/fsprobe.py' < fsprobe.py
  echo "-- shared filesystem, under gVisor --"
  kubectl exec probe-gvisor -n "$NS" -- python3 /tmp/fsprobe.py /shared
  echo "-- node-local ext4, under gVisor (baseline) --"
  kubectl exec probe-gvisor -n "$NS" -- python3 /tmp/fsprobe.py /baseline
fi

if want locks; then
  echo; echo "################ lock scope ################"
  ./lockscope.sh /shared "$SHARED_MNT"
fi

if want append; then
  echo; echo "################ concurrent append atomicity ################"
  ./append-race.sh
fi

if want coherence; then
  echo; echo "################ cache coherence ################"
  ./coherence.sh backing
  ./coherence.sh client
fi

if want perf; then
  echo; echo "################ performance ################"
  for pod in probe-runc probe-gvisor; do
    kubectl exec -i "$pod" -n "$NS" -- sh -c 'cat > /tmp/gitprobe.sh' < gitprobe.sh
  done
  kubectl exec -i probe-gvisor -n "$NS" -- sh -c 'cat > /tmp/hybrid.sh' < hybrid.sh
  kubectl exec probe-runc   -n "$NS" -- bash /tmp/gitprobe.sh /baseline/gpr "runc   + ext4 (no sandbox)"
  kubectl exec probe-runc   -n "$NS" -- bash /tmp/gitprobe.sh /shared/gpr   "runc   + shared FS"
  kubectl exec probe-gvisor -n "$NS" -- bash /tmp/gitprobe.sh /baseline/gp  "gVisor + ext4 (today's baseline)"
  kubectl exec probe-gvisor -n "$NS" -- bash /tmp/gitprobe.sh /shared/gp    "gVisor + shared FS"
  kubectl exec probe-gvisor -n "$NS" -- bash /tmp/hybrid.sh
fi

if want rwx; then
  echo; echo "################ RWX via CSI ################"
  ./csi-rwx.sh
fi

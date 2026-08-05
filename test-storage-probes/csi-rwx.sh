#!/bin/bash
# The RWX arm: installs csi-driver-nfs, provisions a ReadWriteMany PVC against
# the export, and checks that two gVisor pods can share it -- POSIX semantics
# through the CSI mount, cross-pod visibility latency, and whether concurrent
# O_APPEND from two sandboxes loses or garbles writes.
#
# Also demonstrates the provisioning permission trap: csi-driver-nfs creates
# each volume's subdir 0755 root:root, so a pod running as the session uid
# cannot write unless fsGroup or mountPermissions widens it.
#
# Run: test-storage-probes/csi-rwx.sh
# Needs: setup-nfs-export.sh, and outbound network for the driver manifests.
set -uo pipefail
cd "$(dirname "$0")"
. ./lib.sh

CSI_VERSION="${CSI_VERSION:-v4.11.0}"
IMAGE=$(probe_image) || exit 1
SERVER=$(node_ip)

echo "==> installing csi-driver-nfs $CSI_VERSION"
mkdir -p .csi
BASE="https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/$CSI_VERSION/deploy"
for f in rbac-csi-nfs.yaml csi-nfs-driverinfo.yaml csi-nfs-controller.yaml csi-nfs-node.yaml; do
  [ -f ".csi/$f" ] || curl -sSfL -o ".csi/$f" "$BASE/$f" || { echo "fetch failed: $f"; exit 1; }
done
kubectl apply -f .csi/ >/dev/null || exit 1
kubectl -n kube-system rollout status daemonset/csi-nfs-node --timeout=300s >/dev/null || exit 1
kubectl -n kube-system rollout status deployment/csi-nfs-controller --timeout=300s >/dev/null || exit 1

echo "==> provisioning the RWX volumes"
sed -e "s|__SERVER__|$SERVER|g" -e "s|__IMAGE__|$IMAGE|g" csi-rwx.yaml | kubectl apply -f - >/dev/null
kubectl wait --for=condition=Ready pod/probe-rwx-a pod/probe-rwx-b pod/probe-rwx-plain \
  -n "$NS" --timeout=300s >/dev/null || { echo "RWX pods did not start"; exit 1; }

echo
echo "======== RWX under gVisor ========"
printf '  %-38s ' "mount type inside the sandbox"
kubectl exec probe-rwx-a -n "$NS" -- sh -c 'mount | grep " /rwx " | awk "{print \$5}"'

echo
echo "-- POSIX semantics through the CSI volume --"
kubectl exec -i probe-rwx-a -n "$NS" -- sh -c 'cat > /tmp/fsprobe.py' < fsprobe.py
kubectl exec probe-rwx-a -n "$NS" -- python3 /tmp/fsprobe.py /rwx

echo
echo "-- cross-pod sharing (two separate sandboxes, one volume) --"
kubectl exec -i probe-rwx-b -n "$NS" -- sh -c 'cat > /tmp/cohere.py' < cohere.py
kubectl exec probe-rwx-a -n "$NS" -- sh -c 'mkdir -p /rwx/x && echo 0 > /rwx/x/g' >/dev/null 2>&1
kubectl exec probe-rwx-b -n "$NS" -- cat /rwx/x/g >/dev/null 2>&1
kubectl exec probe-rwx-b -n "$NS" -- python3 /tmp/cohere.py watch-content /rwx/x/g 60 > /tmp/.rwx.$$ 2>&1 &
W=$!; sleep 1
kubectl exec probe-rwx-a -n "$NS" -- python3 -c "
import time,os
open('/rwx/x/g.tmp','w').write(str(time.time()))
os.rename('/rwx/x/g.tmp','/rwx/x/g')" >/dev/null 2>&1
wait $W
printf '  %-38s %s\n' "A writes (atomic) -> B observes" "$(cat /tmp/.rwx.$$)"; rm -f /tmp/.rwx.$$

echo
echo "-- concurrent O_APPEND from both sandboxes --"
kubectl exec probe-rwx-a -n "$NS" -- sh -c 'rm -f /rwx/x/both.log; touch /rwx/x/both.log' >/dev/null 2>&1
kubectl exec probe-rwx-a -n "$NS" -- sh -c 'for i in $(seq 1 200); do echo "A-$i" >> /rwx/x/both.log; done' &
kubectl exec probe-rwx-b -n "$NS" -- sh -c 'for i in $(seq 1 200); do echo "B-$i" >> /rwx/x/both.log; done' &
wait
kubectl exec probe-rwx-a -n "$NS" -- sh -c '
  echo "  total lines: $(wc -l < /rwx/x/both.log)  (400 means no lost writes)"
  echo "  from A: $(grep -c "^A-" /rwx/x/both.log)   from B: $(grep -c "^B-" /rwx/x/both.log)"
  echo "  garbled lines: $(grep -cvE "^[AB]-[0-9]+$" /rwx/x/both.log)"'

echo
echo "-- provisioning permissions (no fsGroup, no mountPermissions) --"
printf '  %-38s ' "volume dir as provisioned"
kubectl exec probe-rwx-plain -n "$NS" -- sh -c 'ls -ldn /rwx | awk "{print \$1, \$3, \$4}"'
printf '  %-38s ' "can the session uid write?"
kubectl exec probe-rwx-plain -n "$NS" -- sh -c 'touch /rwx/probe 2>/dev/null && echo YES || echo "NO (EACCES)"'
echo

#!/bin/bash
# Reverses setup-nfs-export.sh and deletes every object the probe chain creates:
# probe pods, the RWX PVCs/StorageClasses, the csi-driver-nfs install, the node
# mounts, the export, and the scratch dirs.
#
# Leaves behind only the nfs/nfsd kernel modules (host kernel, clear on reboot)
# and the apt packages inside the node container (clear on cluster recreate).
#
# Run: test-storage-probes/teardown-nfs-export.sh
set -uo pipefail
cd "$(dirname "$0")"
. ./lib.sh

echo "==> deleting probe pods and volumes"
kubectl delete pod -n "$NS" -l storage-probe=yes --force --grace-period=0 >/dev/null 2>&1
kubectl delete pvc -n "$NS" -l storage-probe=yes --wait=false >/dev/null 2>&1
sleep 3
kubectl delete sc storage-probe-rwx storage-probe-rwx-default >/dev/null 2>&1

echo "==> removing csi-driver-nfs (if this chain installed it)"
if [ -d .csi ]; then
  kubectl delete -f .csi/ >/dev/null 2>&1
  rm -rf .csi
fi

echo "==> unmounting and unexporting"
nodesh "umount -f '$SHARED_MNT' 2>/dev/null; rmdir '$SHARED_MNT' 2>/dev/null
        systemctl stop nfs-server 2>/dev/null; rm -f /etc/exports; exportfs -ra 2>/dev/null" >/dev/null 2>&1

echo "==> removing scratch dirs"
nodesh "rm -rf '$HOME/.yaac-storage-probe'" >/dev/null 2>&1
rm -rf "$HOME/.yaac-storage-probe"

echo "==> residual state"
nodesh "echo -n '  nfs mounts on the node: '; mount | grep -c nfs4 || true"
echo -n "  probe pods: "; kubectl get pods -n "$NS" -l storage-probe=yes --no-headers 2>/dev/null | wc -l

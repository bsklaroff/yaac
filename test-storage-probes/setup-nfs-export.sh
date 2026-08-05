#!/bin/bash
# Stands up the NFS backend the probe chain measures: a kernel nfsd export
# served from inside the kind node container, mounted back at a fixed absolute
# path on that node so kubelet can resolve hostPath volumes into it.
#
# The export deliberately uses sec=sys with no root- or all-squashing, because
# the multi-node storage plan requires numeric uids to pass through raw (there
# is no userns and no idmapped mount under gVisor to remap them).
#
# Everything lands inside the node container or under $HOME/.yaac-storage-probe,
# so teardown-nfs-export.sh fully reverses it. The nfs/nfsd kernel modules are
# loaded on the HOST kernel (the node container shares it) and are left loaded;
# they clear on reboot.
#
# Run: test-storage-probes/setup-nfs-export.sh
# Needs: a running kind cluster and access to the rootful podman socket.
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh

echo "==> loading NFS kernel modules (host kernel, via the node container)"
nodesh "modprobe nfsd && modprobe nfs" >/dev/null
nodesh "grep -q nfsd /proc/filesystems" || { echo "nfsd not registered"; exit 1; }

echo "==> installing the NFS server + client inside the node"
if ! nodesh "command -v rpc.nfsd >/dev/null 2>&1"; then
  nodesh "DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 &&
          DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
            nfs-kernel-server nfs-common python3 >/dev/null 2>&1"
fi

echo "==> creating the export at $EXPORT_DIR and the baseline at $BASELINE_DIR"
mkdir -p "$EXPORT_DIR" "$BASELINE_DIR"
nodesh "chown $(id -u):$(id -g) '$EXPORT_DIR' '$BASELINE_DIR'"

# sec=sys, no squashing: uids must survive the wire unchanged.
nodesh "echo '$EXPORT_DIR *(rw,sync,no_subtree_check,no_root_squash,insecure,fsid=0)' > /etc/exports"
nodesh "systemctl restart nfs-server"
sleep 2
nodesh "systemctl is-active nfs-server" >/dev/null || { echo "nfs-server failed"; exit 1; }

IP=$(node_ip)
echo "==> mounting the export at $SHARED_MNT on the node (server $IP)"
nodesh "mkdir -p '$SHARED_MNT'"
nodesh "mountpoint -q '$SHARED_MNT'" 2>/dev/null \
  || nodesh "mount -t nfs4 -o vers=4.2,rw,hard,sec=sys $IP:/ '$SHARED_MNT'"

echo
nodesh "exportfs -v"
nodesh "mount | grep ' $SHARED_MNT '"
echo
echo "export dir : $EXPORT_DIR   (backing store, visible to the host)"
echo "node mount : $SHARED_MNT   (what hostPath volumes resolve into)"
echo "baseline   : $BASELINE_DIR (node-local ext4, the comparison arm)"

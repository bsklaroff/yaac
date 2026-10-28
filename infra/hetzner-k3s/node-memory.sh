#!/bin/bash
# Memory setup for a node that runs workspaces (docs/cluster-setup.md
# "Memory pressure"): swap the size of RAM behind zswap, the host's own
# services kept off it, and the kubelet settings that bound each pod's
# swap. node.sh.tftpl
# and control.sh.tftpl run it; on a node that predates it, run it by hand
# (README.md "Upgrading"). Every step is idempotent, and k3s restarts only
# when the kubelet's settings change, which leaves running pods alone.
set -euo pipefail

# A file on the local disk, encrypted with a key drawn at each boot, so
# swapped pages never outlive the boot: a runc pod may swap too, and the
# egress proxy holds real credentials. systemd-cryptsetup puts the file on
# a loop device and runs mkswap on the mapping at every boot.
swapfile=/var/lib/yaac-swap
if [ ! -f "$swapfile" ]; then
  fallocate -l "$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)k" "$swapfile"
  chmod 600 "$swapfile"
fi
grep -q '^yaac-swap ' /etc/crypttab 2>/dev/null \
  || echo "yaac-swap $swapfile /dev/urandom swap,cipher=aes-xts-plain64,size=512,sector-size=4096" >> /etc/crypttab
grep -q '^/dev/mapper/yaac-swap ' /etc/fstab \
  || echo '/dev/mapper/yaac-swap none swap defaults 0 0' >> /etc/fstab

# zswap keeps swapped pages compressed in RAM (in zsmalloc, the kernel's
# only zswap allocator since 7.0), up to a fifth of it, and writes only the
# coldest to the file, so most swap-ins are a decompression rather than a
# disk read. Set at boot before swap comes up.
cat > /etc/systemd/system/yaac-zswap.service <<'EOF'
[Unit]
Description=Enable zswap for yaac workspaces
DefaultDependencies=no
Before=swap.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'cd /sys/module/zswap/parameters && echo lz4 > compressor && echo 20 > max_pool_percent && echo Y > shrinker_enabled && echo Y > enabled'

[Install]
WantedBy=swap.target
EOF
systemctl daemon-reload
systemctl enable --now yaac-zswap.service
systemctl start cryptsetup.target swap.target
swapon --show=NAME | grep -q '^/dev/dm-' || swapon /dev/mapper/yaac-swap

# The k3s server or agent, containerd and, on the control node, the
# datastore and the NFS server: a stall in any of them stalls the node.
systemctl set-property system.slice MemorySwapMax=0

# kubelet: LimitedSwap bounds a runc container's swap by its request (netd
# bounds gVisor pods'), and pod stats come from the CRI, which keeps
# cAdvisor off pod cgroups (docs/cluster-setup.md "Memory pressure"). No
# memory eviction threshold: netd kills the workspace thrashing the node,
# on memory pressure.
dropin=/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/50-yaac-memory.conf
mkdir -p "$(dirname "$dropin")"
want='apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
featureGates:
  PodAndContainerStatsFromCRI: true
memorySwap:
  swapBehavior: LimitedSwap'
if [ "$(cat "$dropin" 2>/dev/null)" != "$want" ]; then
  printf '%s\n' "$want" > "$dropin"
  for unit in k3s k3s-agent; do
    if systemctl is-active --quiet "$unit"; then systemctl restart "$unit"; fi
  done
fi

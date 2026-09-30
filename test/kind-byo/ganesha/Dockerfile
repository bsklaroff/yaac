# NFS server for kind-byo's RWX storage class (docs/cluster-setup.md,
# "Running byo locally: kind-byo"). Userspace nfs-ganesha needs no kernel
# nfsd and leaves no host state. `pnpm kind-byo up` builds and sideloads it,
# tagged by this directory's content hash.
#
# Needs Ganesha 9: current kernel NFS clients send GET_DIR_DELEGATION, which
# 6.x rejects with NFS4ERR_OP_ILLEGAL, and the client then fails every lookup
# in a new directory with EREMOTEIO. Fedora packages a pinned 9.x.
FROM docker.io/library/fedora:44@sha256:43b29f65a41eb9c35e1cd5323e3bdf3b655c2357a9f4f1ff2f9c2798e5045d80
RUN dnf -y install nfs-ganesha-9.16-4.fc44 nfs-ganesha-vfs-9.16-4.fc44 \
  && dnf clean all \
  && mkdir -p /var/run/ganesha /var/lib/nfs/ganesha
# ganesha.conf comes from a ConfigMap that the script renders with the node
# addresses the export allows.
ENTRYPOINT ["/usr/bin/ganesha.nfsd", "-F", "-L", "/dev/stdout", "-f", "/etc/ganesha/ganesha.conf"]

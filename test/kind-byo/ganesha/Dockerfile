# The NFS server behind kind-byo's RWX class (docs/cluster-setup.md
# "Running byo locally: kind-byo"): userspace nfs-ganesha over FSAL_VFS,
# so the stand-in cloud needs no kernel nfsd and leaves no host state.
# Built and sideloaded by `pnpm kind-byo up`; tagged by this directory's
# content hash, so an edit here is a new image.
#
# Ganesha 9, not an older release: a current kernel's NFS client sends
# GET_DIR_DELEGATION, which 6.x answers NFS4ERR_OP_ILLEGAL rather than
# NOTSUPP — the client reports that as EREMOTEIO on every lookup in a
# fresh directory. Fedora is where a pinned 9.x is packaged on a stable
# release.
FROM docker.io/library/fedora:44@sha256:43b29f65a41eb9c35e1cd5323e3bdf3b655c2357a9f4f1ff2f9c2798e5045d80
RUN dnf -y install nfs-ganesha-9.16-4.fc44 nfs-ganesha-vfs-9.16-4.fc44 \
  && dnf clean all \
  && mkdir -p /var/run/ganesha /var/lib/nfs/ganesha
# The config is the pod's (a ConfigMap), rendered by the script with the
# node addresses the export admits.
ENTRYPOINT ["/usr/bin/ganesha.nfsd", "-F", "-L", "/dev/stdout", "-f", "/etc/ganesha/ganesha.conf"]

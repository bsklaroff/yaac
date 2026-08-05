# Shared settings and helpers for the storage probe chain.
# Sourced by every script here; not runnable on its own.
#
# Overridable via the environment:
#   NODE          kind node container holding the cluster (and the client mount)
#   SHARED_MNT    absolute path of the shared-filesystem mount ON THE NODE
#   BASELINE_DIR  node-local ext4 dir used as the comparison baseline
#   PROBE_IMAGE   image for the probe pods; must carry git, python3, bash
#   NS            namespace the probe pods live in

export CONTAINER_HOST="${CONTAINER_HOST:-unix:///run/podman/podman.sock}"

NODE="${NODE:-yaac-control-plane}"
SHARED_MNT="${SHARED_MNT:-/mnt/yaac-shared}"
BASELINE_DIR="${BASELINE_DIR:-$HOME/.yaac-storage-probe/baseline}"
NS="${NS:-default}"
EXPORT_DIR="${EXPORT_DIR:-$HOME/.yaac-storage-probe/export}"

# Run a command as root inside the node container.
nodesh() { podman exec "$NODE" sh -c "$1"; }

# The node's own address, which is also the NFS server address when the export
# is served from inside the node container.
node_ip() {
  nodesh "ip -4 addr show eth0 | awk '/inet /{print \$2}' | cut -d/ -f1" | tr -d '\r\n'
}

# Pick a probe image. Any image with git + python3 + bash works; the yaac
# session image is the convenient one because it is already on the node and
# its uid matches the session uid the probes assert on.
probe_image() {
  if [ -n "${PROBE_IMAGE:-}" ]; then echo "$PROBE_IMAGE"; return; fi
  local found
  found=$(nodesh "crictl images 2>/dev/null | awk '/yaac-user-yaac/{print \$1\":\"\$2; exit}'" | tr -d '\r\n')
  if [ -z "$found" ]; then
    echo "no yaac-user-yaac image on the node; set PROBE_IMAGE" >&2
    return 1
  fi
  echo "$found"
}

# Millisecond clock + a start/stop timer pair, used by the benchmark scripts.
_ms() { python3 -c "import time;print('%.0f' % (time.time()*1000))"; }

#!/bin/sh
# Create a kind cluster wired for yaac: local registry on 127.0.0.1:5001,
# containerd hosts.toml so pods can pull `localhost:5001/...`, and the
# home-directory extraMount session pods need for hostPath volumes.
# Idempotent: safe to re-run; deletes and recreates the cluster.
#
# Host port 5001 (not 5000): macOS AirPlay Receiver squats on `::1:5000`,
# which intercepts `localhost:5000` registry probes. The container-internal
# port stays 5000.
set -eu

CLUSTER_NAME="${YAAC_KIND_CLUSTER:-yaac}"
REGISTRY_NAME="${YAAC_REGISTRY_NAME:-yaac-registry}"
REGISTRY_PORT="${YAAC_REGISTRY_PORT:-5001}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Everything runs under podman — yaac's image build engine, and what the
# daemon's ensureLocalRegistry uses. A single engine keeps the kind nodes
# and the registry on one network with one lifecycle (kind's default
# docker provider caused mixed-engine setups where nodes could not reach
# the podman-hosted registry). KIND_EXPERIMENTAL_PROVIDER is kind's own
# knob for selecting podman as its node engine. Note: kind's podman
# provider needs a rootful machine on macOS (podman machine set --rootful).
export KIND_EXPERIMENTAL_PROVIDER=podman

# 1. Local registry container (reused if already running). Runs under the
# same engine as the kind nodes so step 4 can put both on one network.
if ! curl -fsS "http://127.0.0.1:${REGISTRY_PORT}/v2/" >/dev/null 2>&1; then
  podman rm -f "${REGISTRY_NAME}" 2>/dev/null || true
  podman run -d --name "${REGISTRY_NAME}" \
    -p "127.0.0.1:${REGISTRY_PORT}:5000" \
    docker.io/library/registry:2
fi

# 2. kind cluster with the yaac config ($HOME substituted). No --wait:
# the config disables the default CNI, so nodes cannot go Ready until
# Calico is installed in step 3.
kind delete cluster --name "${CLUSTER_NAME}" 2>/dev/null || true
sed "s|\$HOME|${HOME}|g" "${SCRIPT_DIR}/../k8s/kind-config.yaml" \
  | kind create cluster --name "${CLUSTER_NAME}" --config -

# 3. CNI: Cilium (pinned), in place of kind's default kindnet. kindnet's
# NetworkPolicy engine fails OPEN — it only queues packets from pod IPs
# in an nftables set it syncs asynchronously, so every pod's first
# seconds bypass policy, and its nfqueue rules carry the bypass flag, so
# policy vanishes entirely if the agent dies. Session egress lockdown
# needs fail CLOSED: Cilium's CNI ADD does not return until the pod's
# eBPF policy programs are attached, so a session container cannot start
# (let alone egress) before its policy is enforced. ipam.mode=kubernetes
# allocates pod IPs from the node's PodCIDR (kind's default podSubnet).
# Cilium has no static manifest, so installation goes
# through the cilium CLI — downloaded (pinned) when not already on PATH.
CILIUM_VERSION="1.19.4"
CILIUM_CLI_VERSION="v0.19.4"
KCTL="kubectl --context kind-${CLUSTER_NAME}"
if command -v cilium >/dev/null 2>&1; then
  CILIUM_CLI="cilium"
else
  CLI_DIR="${HOME}/.cache/yaac/bin"
  CILIUM_CLI="${CLI_DIR}/cilium-${CILIUM_CLI_VERSION}"
  if [ ! -x "${CILIUM_CLI}" ]; then
    OS="$(uname | tr '[:upper:]' '[:lower:]')"
    ARCH="$(uname -m)"
    case "${ARCH}" in x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; esac
    mkdir -p "${CLI_DIR}"
    curl -fsSL "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-${OS}-${ARCH}.tar.gz" \
      | tar -xz -C "${CLI_DIR}" cilium
    mv "${CLI_DIR}/cilium" "${CILIUM_CLI}"
  fi
fi
# envoyConfig.enabled installs the CiliumEnvoyConfig/CiliumClusterwideEnvoyConfig
# CRDs and lets policy-referenced custom Envoy listeners load — yaac uses one to
# redirect session-pod egress to the proxy (replaces the per-pod relay; see
# src/lib/k8s/bootstrap.ts buildEgressRedirectCecManifest).
"${CILIUM_CLI}" install --context "kind-${CLUSTER_NAME}" \
  --version "${CILIUM_VERSION}" \
  --set ipam.mode=kubernetes \
  --set envoyConfig.enabled=true
"${CILIUM_CLI}" status --context "kind-${CLUSTER_NAME}" --wait --wait-duration 5m
${KCTL} wait --for=condition=Ready node --all --timeout=120s

# 4. Tell the node's containerd that localhost:5001 is the registry, and
# mount an extra unmasked sysfs so userns pods (hostUsers: false — every
# yaac session pod) can start: the kernel refuses sysfs mounts inside a
# user namespace while kind's product-file masks make the node's /sys
# "not fully visible" (kind#3436). The mount lives in the node's mount
# namespace, so re-run this script after a node container restart.
# userns pods also need idmapped-mount support on the fs behind hostPath
# volumes: ext4/xfs/btrfs on Linux; on macOS the libkrun podman-machine
# provider with libkrun-efi >= 1.17 (see "Install" in the README —
# applehv's virtiofs does not support idmapped mounts).
REGISTRY_DIR="/etc/containerd/certs.d/localhost:${REGISTRY_PORT}"
for node in $(kind get nodes --name "${CLUSTER_NAME}"); do
  podman exec "${node}" mkdir -p "${REGISTRY_DIR}"
  printf '[host."http://%s:5000"]\n' "${REGISTRY_NAME}" \
    | podman exec -i "${node}" sh -c "cat > ${REGISTRY_DIR}/hosts.toml"
  podman exec "${node}" sh -c 'mkdir -p /mnt/sysfs && mount -t sysfs none /mnt/sysfs'
done

# 5. Put the registry on the kind network so nodes can reach it by name.
# No-ops when a pre-existing registry runs under another engine (e.g. an
# old docker-hosted one) — recreate it under podman (same name/port) and
# re-run this script in that case.
podman network connect kind "${REGISTRY_NAME}" 2>/dev/null || true

echo "Cluster '${CLUSTER_NAME}' ready. Verify with: yaac cluster check"

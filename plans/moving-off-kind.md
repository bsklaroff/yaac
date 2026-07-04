# Moving off kind: delete the node-in-a-container layer

## Goal

Collapse the macOS stack from three nested layers — Mac → podman-machine
VM (libkrun) → kind node **container** → session pods — to two ("the VM
*is* the node"), and make Linux node == host with native k3s. Nearly every
install/repair hack yaac carries exists because the Kubernetes node is a
container rather than a machine.

Status and boundaries:

- Brew packaging and `yaac cluster setup` (Phases 1–2 of the retired
  brew-packaging plan) shipped: the formula installs the toolchain, setup
  provisions the machine/cluster/Cilium/fixups idempotently, `--repair`
  re-applies the volatile node fixups, and the tap pins the kind+podman
  pair around the podman-6 skew (kind#4201).
- The last *runtime* kind coupling is gone: the `podman exec <node>`
  writes in `src/lib/k8s/project-registry.ts` were replaced by one-shot
  in-cluster node-write pods (hostPath + `nodeName`), so kind specificity
  lives only in `src/lib/k8s/cluster-setup.ts` and the self-skipping
  node-fixups check.
- This plan is the spike-and-migrate track. It commits to nothing until
  the spikes pass; kind + podman-libkrun stays the supported backend
  throughout.

## Why the node-in-a-container is the problem

Everything below is applied by `yaac cluster setup`, lives in node/VM
state that resets on restart, and would not exist on a real (VM or host)
node:

- **sysfs unmask** for userns pods (kind#3436): the kernel refuses sysfs
  mounts in a userns while the node container's `/sys` is masked
  (`src/lib/k8s/cluster-setup.ts:424`). A VM node has a real sysfs.
- **`DefaultTasksMax=infinity` + vm sysctls + `podman update
  --pids-limit`** (`cluster-setup.ts:427-434`): without them, subagent
  fan-out dies with `fork: resource temporarily unavailable`. The
  container-level PID/task caps disappear with the container; the vm
  sysctls may still be wanted inside a VM.
- **Registry wiring**: the podman-hosted `registry:2` container joined to
  the kind network plus per-node `hosts.toml`
  (`cluster-setup.ts:419,443`).
- **kind↔podman version skew**: podman 6.x breaks kind ≤ v0.32.0, hence
  the tap-pinned `yaac-kind` build and the preflight
  (`diagnoseKindPodmanSkew`, `cluster-setup.ts:244-305`). Goes away
  entirely without kind.
- The whole reason `--repair` and the warn-level `node-fixups` check
  exist is that these vanish silently on node/VM restart.

## Constraints any backend must satisfy

Probed by `src/lib/k8s/cluster-check.ts`:

- **Single node**, with the daemon's `$HOME` visible on the node at the
  same path (hostPath model — `src/daemon/session-create.ts` mounts,
  kind's extraMount today).
- **Userns pods**: `hostUsers: false` on every session pod
  (`src/lib/k8s/pod-spec.ts`) ⇒ containerd 2.0+ and idmapped-mount
  support on the filesystem backing hostPaths (ext4/xfs/btrfs on Linux;
  libkrun virtiofs ≥ 1.17 on macOS — applehv/vz virtiofs does not have
  it).
- **Cilium, non-negotiable**: fail-closed NetworkPolicy is the
  session-egress security model and the redirect is Cilium-native
  (`CiliumNetworkPolicy` + `CiliumEnvoyConfig`,
  `src/lib/k8s/bootstrap.ts`; installed with `envoyConfig.enabled=true`).
- **Local registry** at `registryHost()` (default `localhost:5001`,
  `src/lib/k8s/registry.ts`) pullable by the node's containerd.
- **Runtime binaries**: `kubectl` (context-agnostic), `podman` (build
  engine — unless spike 2 below removes it), `helm` (vcluster only,
  auto-downloaded).
- **Clock sanity after host sleep** (krunkit `--timesync`; podman 6
  passes it itself today — a non-podman VM manager must too).
- ~~Service CIDR `10.96.0.0/16`~~ — **no longer a constraint**: commit
  c7306bc replaced every deterministic ClusterIP pin with live resolution
  through the proxy's split-horizon DNS and deleted the serviceSubnet
  check. k3s's default `10.43.0.0/16` is fine as-is; no `--service-cidr`
  flag, no kubeadm requirement.

## Backends

Rejected (unchanged verdicts from the original survey):

- **Docker-backed kind**: Docker Desktop virtiofs has no idmapped-mount
  support and long-standing ownership bugs (docker/for-mac#6243) — userns
  pods writing hostPath `$HOME` break, the exact reason the README
  mandates libkrun. Buys nothing on Linux.
- **k3d**: podman support officially experimental, same
  node-in-container model — the sysfs/PID/TasksMax hack class survives —
  plus k3s-in-a-container quirks for zero structural gain. Same verdict
  for kind's even-more-experimental nerdctl provider.

Candidates:

- **Native k3s (Linux): the end-state Linux backend.** Node == host
  literally: no extraMounts, no sysfs masking, no container PID caps,
  host podman builds with no machine. Cilium-on-k3s
  (`--flannel-backend=none --disable-network-policy`) is well-trodden;
  recent k3s embeds containerd 2.x (userns pods). Not brew-manageable
  (root systemd service) — install stays a documented one-liner, with
  `yaac cluster setup` doing the rest.
- **macOS two-layer (VM is the node): needs a spike.** Two credible
  routes, both deleting the sysfs hack, the node-container PID cap, and
  the kind/podman skew:
  - **minikube krunkit driver** (minikube ≥ 1.37, homebrew-core; krunkit
    ≥ 1.0): `--cni=false` + the existing Cilium install path,
    `--mount-string` uses virtiofs on modern drivers. Friction: requires
    `vmnet-helper` installed with sudo.
  - **Lima template** (Lima ≥ 2.0, homebrew-core) with the experimental
    krunkit vmtype + virtiofs mounts, running k3s inside — "podman
    machine, but the VM is the Kubernetes node." No sudo networking,
    fully scriptable from `yaac cluster setup`.

## Spikes

Time-boxed, on real macOS/arm64 hardware, before any commitment.

1. **minikube krunkit vs Lima+k3s**, each evaluated against the
   constraint list, in order of kill-likelihood:
   - idmapped-mount-capable virtiofs on a `$HOME` mount — a userns pod
     writes a hostPath at the session uid (reuse the `cluster check`
     probe pod). This is the load-bearing requirement and is unverified:
     podman-machine-libkrun ≥ 1.17 has it, but whether minikube/Lima
     surface the same virtiofs capability is unknown;
   - `hostUsers: false` pod admission (containerd 2.x in the node
     image/distro);
   - Cilium 1.19 + `envoyConfig.enabled` + the egress enforcement probe;
   - registry reachability from node containerd;
   - sleep/clock behavior (krunkit `--timesync` must be passed by the VM
     manager the way podman 6 passes it).
2. **Builds without podman machine** (only if a macOS spike passes):
   prototype buildkitd-in-cluster + `buildctl` (homebrew-core) behind a
   builder abstraction — both `src/lib/container/image-builder.ts:105`
   and `src/lib/container/proxy-client.ts:491` spawn `podman build`
   directly, and the push paths in `src/lib/k8s/registry.ts` assume host
   podman. Passing would remove host podman entirely on both platforms.
3. **Linux end-state**: validate native k3s + Cilium against
   `yaac cluster check`; `yaac cluster setup` grows a k3s path.

## Main registry in-cluster (deferred from the old Phase 3)

Moving the `localhost:5001` podman registry container in-cluster —
mirroring the per-project in-cluster registries, with daemon-side pushes
over the existing `kubectl port-forward` pattern
(`src/lib/k8s/port-forward.ts`) — kills `connectRegistryToKindNetwork`
and the localhost hosts.toml fixup entirely. Today's podman-network
registry works fine under kind, so this lands with (and only with) the
first backend that needs it.

## setup/check integration

- `yaac cluster setup` grows backend selection; kind stays the default
  until a spike winner exists. The kind-specific fixups become a
  kind-backend path rather than unconditional steps.
- `cluster check` needs no structural change: the node-fixups probe
  already self-skips nodes that are not podman containers
  (`src/lib/k8s/cluster-check.ts:289-293`), and every other check is
  backend-agnostic. Fix messages that say "kind" should become
  backend-aware once a second backend exists.
- Per repo conventions, any new `cluster setup` arguments get gated
  `test/e2e/` coverage like the existing cluster-mutating tests.

## Exit criteria

If spike 1 fails on idmapped mounts everywhere, stop: kind +
podman-libkrun stays the macOS backend, and the shipped packaging plus
the backend-agnostic refactors are still the whole win. If it passes,
pick the winner as the macOS default and demote kind to
supported-but-legacy.

## Deliberately out of scope

- Multi-node clusters (hostPath model assumes node == host; unchanged v1
  limit).
- Windows/WSL2.
- Replacing Cilium or the egress model — every backend choice bends
  around it, not the reverse.
- Distro packages (apt/rpm) for the Linux k3s path — README one-liners
  first.
- Homebrew-core submission (krunkit tap dependency rules it out).

## Sources

- krunkit + `libkrun/krun` tap: https://github.com/containers/krunkit
- kind releases (v0.32.0 latest; podman 6 fix kind#4203 unreleased):
  https://github.com/kubernetes-sigs/kind/releases
- k3d podman support (experimental):
  https://k3d.io/v5.4.1/usage/advanced/podman/
- minikube krunkit driver (1.37+, vmnet-helper/sudo):
  https://minikube.sigs.k8s.io/docs/drivers/krunkit/
- minikube mount methods (virtiofs on modern drivers):
  https://minikube.sigs.k8s.io/docs/handbook/mount/
- Lima krunkit vmtype (Lima ≥ 2.0, experimental):
  https://lima-vm.io/docs/config/vmtype/krunkit/
- Docker Desktop virtiofs ownership issues:
  https://github.com/docker/for-mac/issues/6243
- containerd user-namespaces (2.0+ required):
  https://github.com/containerd/containerd/blob/main/docs/user-namespaces/README.md
- podman releases (v6.0.0 out; Intel-Mac support dropped):
  https://github.com/containers/podman/releases
- krunkit releases (`--timesync` added in v1.2.0):
  https://github.com/containers/krunkit/releases
- podman machine clock-drift after sleep (motivated the 6.0 pin):
  https://github.com/containers/podman/issues/27736

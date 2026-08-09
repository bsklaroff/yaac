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
  provisions the machine/cluster/CNI/fixups idempotently, `--repair`
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
- ~~**Registry wiring**~~ — **done**: the main registry is an in-cluster
  Deployment + Service like the per-project ones, so the kind-network join
  and the `localhost:5001` `hosts.toml` fixup are gone. The server pushes
  through a `kubectl port-forward` (docs/trust-split-builds.md).
- **kind↔podman version skew**: podman 6.x breaks kind ≤ v0.32.0, hence
  the tap-pinned `yaac-kind` build and the preflight
  (`diagnoseKindPodmanSkew`, `cluster-setup.ts:244-305`). Goes away
  entirely without kind.
- The whole reason `--repair` and the warn-level `node-fixups` check
  exist is that these vanish silently on node/VM restart.

## Constraints any backend must satisfy

Probed by `src/lib/k8s/cluster-check.ts`:

- **Single node**, with the server's `$HOME` visible on the node at the
  same path (hostPath model — `src/server/session-create.ts` mounts,
  kind's extraMount today).
- **gVisor session pods** (`src/lib/k8s/pod-spec.ts`) ⇒ the filesystem
  backing hostPaths must report **real file ownership** to the node: the
  runsc gofer does hostPath I/O as node root while the sentry enforces
  DAC on the ownership the gofer sees. Any normal Linux filesystem on
  Linux; on macOS only LinuxComplete-semantics libkrun virtiofs (the
  tap's `yaac-krunkit`). applehv/vz virtiofs and stock krunkit's
  `Simplified` semantics both report the accessing process as every
  file's owner, so the root gofer sees root-owned files and non-root
  session uids cannot write hostPath mounts (verified 2026-07: an applehv
  machine passes every cluster-setup step but fails the cluster-check
  probe exactly this way; chown is swallowed and idmapped mounts EINVAL,
  so there is no node-side remap short of a bindfs layer).
- **Fail-closed NetworkPolicy + a veth-peer redirect, non-negotiable**:
  fail-closed enforcement is the session-egress security model. Any target
  must run a CNI whose policy engine fails CLOSED at pod birth and whose
  datapath traverses host netfilter, so netd's nat redirect at the veth
  peer sees pod egress. Calico (iptables) satisfies both; kindnet's engine
  fails open, and eBPF CNIs that short-circuit the host stack (Cilium's
  default host-routing) consume the frame before netfilter — see
  docs/worktree-egress.md. Policy itself is plain `networking.k8s.io/v1`
  NetworkPolicy only, which is what keeps managed-cloud ports cheap.
- **An image registry the node's containerd can pull from.** No longer a
  host-side constraint: the registry is an in-cluster Service, reached by
  the node through a containerd `hosts.toml` that a one-shot pod writes, so
  a backend only has to admit privileged hostPath pods and let containerd
  read `/etc/containerd/certs.d` (the `config_path` patch).
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

- **Docker-backed kind**: Docker Desktop virtiofs has long-standing
  dynamic-ownership behavior (docker/for-mac#6243, VZ-based) — gVisor
  session pods writing hostPath `$HOME` break, the exact reason the
  README mandates the patched libkrun. Buys nothing on Linux.
- **k3d**: podman support officially experimental, same
  node-in-container model — the sysfs/PID/TasksMax hack class survives —
  plus k3s-in-a-container quirks for zero structural gain. Same verdict
  for kind's even-more-experimental nerdctl provider.

Candidates:

- **Native k3s (Linux): the end-state Linux backend.** Node == host
  literally: no extraMounts, no sysfs masking, no container PID caps,
  host podman builds with no machine. Calico-on-k3s
  (`--flannel-backend=none --disable-network-policy`) is well-trodden;
  recent k3s embeds containerd 2.x (userns pods). Not brew-manageable
  (root systemd service) — install stays a documented one-liner, with
  `yaac cluster setup` doing the rest.
- **macOS two-layer (VM is the node): needs a spike.** Two credible
  routes, both deleting the sysfs hack, the node-container PID cap, and
  the kind/podman skew:
  - **minikube krunkit driver** (minikube ≥ 1.37, homebrew-core; krunkit
    ≥ 1.0): `--cni=false` + the existing Calico install path,
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
   - ownership-preserving virtiofs on a `$HOME` mount — a gVisor pod
     writes a hostPath at the session uid (reuse the `cluster check`
     probe pod). This is the load-bearing requirement and is unverified:
     it needs LinuxComplete-semantics libkrun (the tap's `yaac-krunkit`);
     whether minikube/Lima drive krunkit with those semantics — or can be
     pointed at the patched build at all — is unknown, and their stock
     krunkit's `Simplified` semantics fail the probe;
   - `hostUsers: false` pod admission (containerd 2.x in the node
     image/distro);
   - Calico + netd + the egress enforcement probe;
   - registry reachability from node containerd;
   - sleep/clock behavior (krunkit `--timesync` must be passed by the VM
     manager the way podman 6 passes it).
2. **Builds without podman machine** (only if a macOS spike passes):
   prototype buildkitd-in-cluster + `buildctl` (homebrew-core) behind a
   builder abstraction — both `src/lib/container/image-builder.ts:105`
   and `src/lib/container/proxy-client.ts:491` spawn `podman build`
   directly, and the push paths in `src/lib/k8s/registry.ts` assume host
   podman. Passing would remove host podman entirely on both platforms.
3. **Linux end-state**: validate native k3s + Calico against
   `yaac cluster check`; `yaac cluster setup` grows a k3s path.

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

If spike 1 fails on ownership-preserving virtiofs everywhere, stop: kind +
podman-libkrun stays the macOS backend, and the shipped packaging plus
the backend-agnostic refactors are still the whole win. If it passes,
pick the winner as the macOS default and demote kind to
supported-but-legacy.

## Deliberately out of scope

- Multi-node clusters (hostPath model assumes node == host; unchanged v1
  limit).
- Windows/WSL2.
- Replacing the CNI or the egress model — every backend choice bends
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

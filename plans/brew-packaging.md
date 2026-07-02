# Ship yaac via Homebrew, and clean up the kind install path

## Goal

`brew install bsklaroff/yaac/yaac && yaac cluster setup` replaces today's
install story (clone → `pnpm build` → `npm i -g .` → hand-run
`scripts/setup-kind-cluster.sh` → a README wall of podman-machine caveats).

Two tracks, deliberately decoupled:

1. **Package what exists.** yaac stays on kind + podman; the formula installs
   the toolchain and a new `yaac cluster setup` command absorbs the setup
   script. No runtime changes. This is Phases 1–2 and is worth shipping on
   its own.
2. **Make the runtime itself cleaner to install.** Kill the node-in-a-container
   layer that causes most of the setup hacks: native k3s on Linux, "the VM
   *is* the node" on macOS. This needs spikes (Phase 4) and backend-agnostic
   refactors that are useful regardless (Phase 3).

## Why the current install is messy

On macOS the stack is three nested layers — Mac → podman-machine VM (libkrun)
→ kind node **container** → session pods — and nearly every hack in
`scripts/setup-kind-cluster.sh` exists because the Kubernetes node is a
container rather than a machine:

- **sysfs unmask** for userns pods (kind#3436): the kernel refuses sysfs
  mounts in a userns while the node container's `/sys` is masked. Applied
  with `podman exec … mount -t sysfs` (`setup-kind-cluster.sh:97`), lives in
  the node's mount namespace, silently vanishes on node restart.
- **`DefaultTasksMax=infinity` + VM memory sysctls** written into the node
  (`setup-kind-cluster.sh:107-113`) and **`podman update --pids-limit 32768`**
  on the node container (`setup-kind-cluster.sh:118`) — without these,
  subagent fan-out dies with `fork: resource temporarily unavailable`. Also
  reset on restart.
- **Registry wiring**: a podman-hosted `registry:2` container joined to the
  kind network, plus `hosts.toml` written into the node via `podman exec`
  so containerd resolves `localhost:5001`.
- **kind↔podman version skew**: podman 6.x breaks kind ≤ v0.32.0
  (`kind get clusters` → exit 125; fixed by kind#4203, unreleased — latest
  stable is still v0.32.0). The README currently tells users to build kind
  from `main`.
- **App distribution**: none. Clone-and-build only, with a `postinstall`
  hook that would break consumer installs (see Phase 1).

## What the code actually requires (survey results)

At **runtime** the daemon/CLI shells out to exactly three binaries. `kind`
and the `cilium` CLI are **setup-time only** — nothing in `src/` invokes
them:

| binary | where | when |
|--------|-------|------|
| `kubectl` | `src/lib/k8s/kubectl.ts:94` (all cluster access), `src/lib/k8s/port-forward.ts:44`, `src/lib/k8s/exec.ts:24` | always; context-agnostic (never passes `--context`) |
| `podman` | `src/lib/container/image-builder.ts:105`, `src/lib/k8s/registry.ts:103,133`, `src/lib/container/runtime.ts:26` | always (build engine + registry host) |
| `helm` | `src/lib/k8s/vcluster.ts:134,195` | `virtualCluster` sessions only; auto-downloaded (pinned) if absent (`vcluster.ts:149`) |

Hard constraints any cluster backend must satisfy (probed by
`src/lib/k8s/cluster-check.ts`):

- **Single node**, with the daemon's `$HOME` visible on the node at the same
  path (hostPath resolves on the node — `src/daemon/session-create.ts:1075`,
  `k8s/kind-config.yaml` extraMount).
- **Userns pods**: `hostUsers: false` on every session pod
  (`src/lib/k8s/pod-spec.ts:221`) ⇒ containerd 2.0+ and idmapped-mount
  support on the filesystem backing hostPaths (ext4/xfs/btrfs on Linux;
  libkrun virtiofs ≥ 1.17 on macOS — applehv/vz virtiofs does not have it).
- **Cilium, non-negotiable**: fail-closed NetworkPolicy is the session-egress
  security model, and the egress redirect is Cilium-native
  (`CiliumNetworkPolicy` + `CiliumEnvoyConfig`/`CiliumClusterwideEnvoyConfig`,
  `src/lib/k8s/bootstrap.ts`; installed with `envoyConfig.enabled=true`).
  kindnet / flannel / kube-network-policies fail open.
- **Local registry** at `registryHost()` (default `localhost:5001`,
  `src/shared/env.ts:76`); pods pull `localhost:5001/<tag>` via node
  containerd `hosts.toml`.
- **Service CIDR `10.96.0.0/16`** — `CLUSTER_SERVICE_CIDR`
  (`src/lib/k8s/bootstrap.ts:148`) hashes per-namespace proxy VIPs into it.
  Every alternative backend below can be configured to match.

One **runtime** (not setup-time) kind coupling to know about:
`src/lib/k8s/project-registry.ts:306-310` assumes Kubernetes node names
double as podman container names and runs `podman exec <node>` to write
per-project-registry `hosts.toml` entries (`:326`, `:384`). Any non-kind
backend breaks this — Phase 3 removes the assumption.

## Backend alternatives considered

- **Docker-backed kind: rejected.** On macOS, Docker Desktop's virtiofs has
  no idmapped-mount support and long-standing ownership-mapping bugs
  (docker/for-mac#6243), so userns session pods writing hostPath `$HOME`
  break — the exact reason the README mandates libkrun. It also breaks the
  runtime `podman exec <node>` assumption and reintroduces the mixed-engine
  registry/network split the setup script comment warns about
  (`setup-kind-cluster.sh:19-23`). On Linux it buys nothing over podman.
- **k3d: rejected.** Podman support is officially experimental ("not
  guaranteed to work"), it's the same node-in-container model — the
  sysfs/PID/TasksMax hack class survives — and it adds k3s-in-a-container
  quirks (disable flannel + its network-policy engine to install Cilium)
  for zero structural gain. Same verdict for kind's even-more-experimental
  nerdctl/containerd provider.
- **Native k3s (Linux): the end-state Linux backend.** Node == host
  literally: no extraMounts, no sysfs masking, no container PID caps, host
  podman builds with no machine. Cilium-on-k3s
  (`--flannel-backend=none --disable-network-policy`) is well-trodden;
  recent k3s embeds containerd 2.x (userns pods); `--service-cidr` matches
  the pin. Not brew-manageable (root systemd service) — install stays a
  documented one-liner, with `yaac cluster setup` doing the rest.
- **macOS two-layer (VM is the node): the prize, needs a spike.** Two
  credible routes, both collapsing Mac → VM-node → pods and deleting the
  sysfs hack (a VM has real sysfs), the node-container PID cap, and the
  kind/podman skew:
  - **minikube krunkit driver** (minikube ≥ 1.37, homebrew-core; krunkit
    ≥ 1.0): kubeadm-based (the `kubeadm-config` serviceSubnet check keeps
    working), `--cni=false` + the existing Cilium install path,
    `--mount-string` uses virtiofs on modern drivers. Friction: requires
    `vmnet-helper` installed with sudo.
  - **Lima template** (Lima ≥ 2.0, homebrew-core) with the experimental
    krunkit vmtype + virtiofs mounts, running k3s inside — "podman machine,
    but the VM is the Kubernetes node." No sudo networking, fully
    scriptable from `yaac cluster setup`.

  Open questions gating both (Phase 4 spike): (a) do these stacks expose
  **idmapped-mount-capable** virtiofs the way podman-machine-libkrun ≥ 1.17
  does? This is the load-bearing requirement and is unverified. (b) Where do
  image builds run once podman machine is gone? Clean answer: buildkitd
  Deployment in-cluster driven by `buildctl` (homebrew-core), which would
  remove host podman entirely on both platforms — but requires a builder
  abstraction in `src/lib/container/image-builder.ts` /
  `proxy-client.ts:491`. (c) VM clock drift after sleep: krunkit
  `--timesync` applies to any krunkit VM, but minikube/Lima must pass the
  flag the way podman 6.0 will.

## Phase 1 — package what exists (no runtime changes)

1. **Fix the `postinstall` packaging bug.** `package.json` runs
   `./setup-git.sh` on install; for a published tarball this executes a
   git-hooks installer against whatever repo encloses the install dir, or
   dies on `git rev-parse` under `set -e` (and `setup-git.sh` isn't even in
   `files: ["dist"]`). Move it to a dev-only hook: pnpm supports
   `"prepare": "./setup-git.sh"` (runs on dev `pnpm install`, not on
   consumer installs from a tarball) or guard with a repo-presence check.
2. **Publish `yaac` to npm.** The package is already formula-friendly:
   `files: ["dist"]`, `bin` entry, dockerfiles/`k8s/` assets copied into
   `dist/` by the build and resolved via `PACKAGE_ROOT`
   (`src/shared/paths.ts:23` → bundle `__dirname`), `@lydell/node-pty`
   ships prebuilds. Publishing gives brew a stable tarball + integrity hash
   per release (a GitHub release tarball also works, but then the formula
   must run the pnpm/tsup/vite build; npm keeps the formula dumb).
3. **Create the tap** (`bsklaroff/homebrew-yaac`). Homebrew-core is not an
   option: the macOS path depends on `krunkit` from the `libkrun/krun` tap
   (the old `slp/krunkit` tap is deprecated), and core formulas cannot
   depend on tap formulas — a tap formula can. Formula sketch:
   - `depends_on "node"`, `"kubernetes-cli"`, `"cilium-cli"` (homebrew-core)
     plus the tap-pinned kind + podman pair from step 4.
   - `depends_on "libkrun/krun/krunkit"` on macOS/arm64 (≥ 1.2.0 for
     `--timesync`).
   - install = `npm install -g` of the published tarball into `libexec`,
     symlink `bin/yaac` (the standard node-formula pattern).
   - `caveats` prints the macOS podman-machine one-time setup until Phase 2
     step 2 absorbs it, and points at `yaac cluster setup`.
4. **Pin the kind + podman pair in the tap.** The two move together
   (podman 6.x breaks kind ≤ v0.32.0, kind#4201), and both current core
   formulas are on the wrong side: core `kind` is v0.32.0 (no #4203 fix)
   and core `podman` is 5.8.x (none of the upstreamed timesync work). Ship
   both pinned in the tap:
   - `yaac-kind`: built from the pinned post-kind#4203 commit on `main`
     (`go install`-style build from a git rev; `@latest` resolves to the
     broken v0.32.0 tag).
   - `yaac-podman`: podman 6.0.x (released upstream), a copy of core's
     formula with version/sha bumped, `conflicts_with "podman"`. Moving to
     6.0 is not just forward-compat: it deletes the **entire clock-drift
     manual wiring section** from the README — podman 6 passes
     `--timesync vsockPort=1234` to krunkit itself (podman#28527) and the
     6.0 machine image ships the vsock qemu-guest-agent + SELinux policy
     (podman-machine-os#238). Note podman 6.0 drops Intel-Mac support —
     no loss; the libkrun requirement already made yaac arm64-only on
     macOS.
   - Both formulas are temporary: delete each once homebrew-core ships
     kind ≥ v0.33.0 / podman ≥ 6.x, switching `depends_on` back to core.
5. **Optional:** `brew services` plist running the daemon in the foreground.
   Skippable — `yaac open` already self-starts the daemon.

## Phase 2 — `yaac cluster setup` (retire the shell script)

Port `scripts/setup-kind-cluster.sh` into a first-class command next to
`yaac cluster check`. Brew can only install binaries — it cannot init a
rootful podman machine, create a cluster, or install Cilium, and shouldn't
(per-user runtime state). The CLI can, idempotently and with real error
messages.

1. **`yaac cluster setup`** reproduces the script: ensure registry
   container, (re)create the kind cluster from the bundled
   `k8s/kind-config.yaml` (already shipped in `dist/k8s/`), install pinned
   Cilium with `envoyConfig.enabled=true` (reuse the existing
   download-pinned-CLI-if-absent pattern from `vcluster.ts:149`), apply the
   node fixups (sysfs mount, TasksMax, sysctls, pids-limit, hosts.toml,
   network connect), finish by running the existing `runClusterCheck`.
   Preflight the kind/podman version skew explicitly (podman ≥ 6 requires
   the pinned kind) instead of letting `kind` fail with exit 125.
2. **macOS machine bootstrap**: `setup` detects a missing/misconfigured
   podman machine and drives `containers.conf` provider = libkrun +
   `podman machine init --rootful` + start (today's README block). With
   `yaac-podman` at 6.0 (Phase 1 step 4) there is no timesync caveat at
   all — but `setup` must handle migration from a pre-brew install:
   - a machine provisioned under podman 5.x lacks the 6.0 machine image's
     guest wiring → prompt `podman machine rm` + re-init (destructive to
     the machine, so prompt, don't auto-run);
   - the README's manual krunkit wrapper (`krunkit-real` on PATH) would
     duplicate `--timesync` and break machine start under 6.0 → detect and
     instruct removal.
3. **Self-healing node fixups**: the sysfs/TasksMax/sysctl fixups vanish on
   node or VM restart and today users must remember to re-run the script.
   Teach `cluster check` to detect the missing fixups (it already probes
   userns pod admission) and either point at `yaac cluster setup --repair`
   or re-apply them directly.
4. Update the README install section; per e2e conventions the new command's
   arguments get `test/e2e/` coverage (gated like other cluster-mutating
   tests).

## Phase 3 — backend-agnostic refactors (useful regardless)

These shrink the kind coupling whether or not Phase 4 ever lands, and each
has an in-scope consumer today:

1. **Replace runtime `podman exec <node>`**
   (`src/lib/k8s/project-registry.ts:326,384`) with a privileged one-shot
   pod (or tiny DaemonSet) that writes `/etc/containerd/certs.d/...` via
   hostPath. Consumer: `virtualCluster` sessions stop depending on
   node-name == podman-container-name; also fixes the case where the daemon
   host's podman isn't the engine hosting the node.
2. **Tolerate non-kubeadm clusters in `cluster check`**: the serviceSubnet
   drift check reads the `kubeadm-config` ConfigMap
   (`src/lib/k8s/cluster-check.ts:744`); fall back to probing an allocated
   Service ClusterIP when the ConfigMap is absent (k3s).
3. **(Deferred until Phase 4 picks a backend)** moving the main registry
   in-cluster — pushed over the daemon's existing `kubectl port-forward`
   pattern, mirroring the per-project in-cluster registries — would kill
   the registry-container network wiring entirely, but today's
   podman-network registry works fine under kind, so this waits for the
   backend that needs it.

## Phase 4 — spike: delete the node-in-a-container layer

Time-boxed spikes, on real hardware (macOS/arm64), before any commitment:

1. **minikube krunkit vs Lima+k3s**, each evaluated against the constraint
   list above, in order of kill-likelihood:
   - idmapped-mount-capable virtiofs on a `$HOME` mount (userns pod writes
     hostPath at the session uid — reuse the `cluster check` probe pod);
   - `hostUsers: false` pod admission (containerd 2.x in the node image);
   - Cilium 1.19 + `envoyConfig.enabled` + the egress probe;
   - service CIDR pinning; registry reachability; sleep/clock behavior.
2. **Builds without podman machine**: prototype buildkitd-in-cluster +
   `buildctl` behind a builder abstraction in
   `src/lib/container/image-builder.ts`. Only needed if a spike passes.
3. **Linux end-state**: validate native k3s (`--flannel-backend=none
   --disable-network-policy --service-cidr 10.96.0.0/16` + Cilium) against
   `cluster check`; `yaac cluster setup` grows a k3s path.

Exit criteria: if (1) fails on idmapped mounts everywhere, stop — kind +
podman-libkrun stays the macOS backend and Phases 1–3 are still the whole
win. If it passes, pick the winner as the macOS default and demote kind to
supported-but-legacy.

## Deliberately out of scope

- Multi-node clusters (hostPath model assumes node == host; unchanged v1
  limit).
- Homebrew-core submission (krunkit tap dependency rules it out; revisit if
  krunkit lands in core).
- Windows/WSL2.
- Replacing Cilium or the egress model — every backend choice above bends
  around it, not the reverse.
- Distro packages (apt/rpm) for the Linux k3s path — README one-liners
  first.

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
- podman releases (v6.0.0 out; breaking changes, Intel-Mac support dropped):
  https://github.com/containers/podman/releases
- krunkit releases (`--timesync` added in v1.2.0):
  https://github.com/containers/krunkit/releases
- podman machine clock-drift after sleep (motivates the 6.0 pin):
  https://github.com/containers/podman/issues/27736

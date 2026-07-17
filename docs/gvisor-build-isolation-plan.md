# Plan: gVisor-isolated image builds

Status: superseded by **docs/trust-split-builds-plan.md** (the clean
final plan, including the additionalimagestores parent-store
optimization). This document is retained as history: research, the
phase-0 spike (the original all-layers design **failed its cold gate
at 3.0x**), the KVM/microVM follow-ups, and all measurements.

## Goal and threat model

Today every image build runs as **rootful podman on the host** —
`buildImage()` (`packages/server/src/lib/container/image-builder.ts`) and
`pushImageToRegistry()` (`packages/server/src/lib/k8s/registry.ts`) shell out
to the host engine. Dockerfile RUN steps execute arbitrary code: the
per-project `Dockerfile.yaac` and `~/.yaac/Dockerfile.user` are
user/agent-editable, so a malicious or compromised Dockerfile currently gets
root-adjacent code execution on the host. The goal is to move the build
execution into a runsc (gVisor) sandbox — a pod on the existing cluster —
so RUN steps can at worst compromise the sandbox, while keeping build
latency close to today's host-podman baseline.

Out of scope: podman as *node/infra* engine (kind node management, the
`yaac-registry` container, digest-pinned upstream mirror pulls). Those run
yaac-shipped commands against pinned refs, not untrusted code, and stay on
the host.

## Research summary

### What the industry does

- Nearly every commercial build service isolates untrusted builds with
  **per-build VMs/microVMs plus an externalized persistent layer cache**,
  not gVisor: Google Cloud Build and GitHub Actions (fresh VM per build),
  Depot (ephemeral EC2 + reattachable NVMe cache volume), Fly.io
  (Firecracker builders, now outsourced to Depot), Railway (BuildKit in
  microVMs with a ring scheduler keeping per-user buildkitd caches warm),
  Northflank and E2B (Firecracker/Cloud Hypervisor). Modal is the gVisor
  outlier — it runs everything under gVisor but replaced Docker builds with
  a bespoke builder. We don't control a hypervisor (single-node kind on
  podman, possibly itself nested), so the VM path is out; the transferable
  lesson is the **cache strategy**: warm builder + externalized layers.
- **gVisor upstream officially supports nested builds**: first-party
  tutorials run full dockerd + `docker build` (i.e. BuildKit) inside a
  runsc sandbox, including as a GKE Sandbox pod
  (gvisor.dev/docs/tutorials/docker-in-gvisor/,
  …/docker-in-gke-sandbox/). The tutorials' key trick: the nested engine's
  storage must sit on **tmpfs inside the sandbox**, because the sentry's
  overlayfs restricts application-created overlay upper layers to tmpfs
  (see gvisor#12475, Jan 2026: Docker 29's containerd-snapshotter fails
  with `mount: invalid argument` unless `/var/lib/docker` is tmpfs).
- **Capabilities granted to a runsc pod never reach the host** — "gVisor
  never runs with capabilities on the host kernel". A builder pod can get
  SYS_ADMIN/SYS_CHROOT/unconfined seccomp with no host exposure. This is
  what makes "privileged-looking builder pod, but sandboxed" coherent.
- **kaniko is dead** (archived read-only 2025-06-03; Chainguard fork
  exists). Consensus replacements: rootless BuildKit or buildah/podman.
- buildah/podman under runsc is actively exercised and actively fixed
  upstream (e.g. gvisor#13148, May 2026: ro-`/dev` remount EROFS bug filed
  and patched within a day). fuse-overlayfs under runsc has zero published
  success reports — treat as broken; use sentry overlay-on-tmpfs or vfs.
- Expected overhead with systrap + directfs + storage-on-tmpfs (all
  current runsc defaults, all already configured in
  `packages/server/src/lib/k8s/gvisor.ts`): roughly **1.2–2x on
  FS-heavy Dockerfile steps, near parity on compile/network-bound steps**.
  Google's rootfs-overlay work explicitly targeted build workloads
  (halved sandboxing overhead on a bazel build). No published
  `podman build`-under-runsc benchmark exists — we must measure our own.

### What this repo already proves

- Nested-container sessions **already run rootful `podman build` inside a
  gVisor sandbox in production**: `session-create.ts` starts a podman
  `system service` in `gvisor-nested` pods with
  `BUILDAH_ISOLATION=chroot` (oci isolation breaks RUN-step stdio under
  the sentry), `NESTED_ENGINE_CAPS = SYS_ADMIN, SYS_CHROOT, MKNOD,
  SETFCAP` (`pod-spec.ts`), and a **disk-backed sentry-internal tmpfs
  graphroot** at `/var/lib/containers` (`NESTED_GRAPHROOT_ANNOTATIONS`,
  via the `dev.gvisor.*` annotation passthrough installed by
  `ensureGvisorRuntime()`). See docs/nested-containers-plan.md.
- The salvage writer pod (`image-promoter.ts`) proves the podman-in-pod
  mechanics (mirrored `quay.io/podman/stable`, `podman --root` against a
  mounted store) — and its design doc records why hostPath through the
  gofer is the thing to avoid: per-file extraction inside the sentry ran
  ~2ms/file (16+ min for 4GB). **The layer cache must not live on a
  gofer-backed hostPath volume.**
- The host-podman surface on the build critical path is narrow: only
  `buildImage()` and `pushImageToRegistry()`, both plain CLI shell-outs,
  both funneled through `build-coordinator.ts` (single-flight per
  content-hash tag). Content-hash tags, the layered `ARG BASE_IMAGE`
  chain, prewarm, and the build-tracking UI are all engine-agnostic.

## Design decision: trust-split builds + per-tag ephemeral runsc builders

Revised after the phase-0 spike (results below). The original choice — a
long-lived warm builder pod building **all** layers — failed its cold
gate at 3.0x, and the follow-ups established the overhead is the runsc
platform itself (systrap process spawns, 8.7x on fork/exec), unreachable
by engine choice, kind topology, or (on this host) KVM/microVMs. The
revision cuts along the threat model instead:

- **Trusted layers stay on the host engine.** `Dockerfile.default`,
  `Dockerfile.tools`, `Dockerfile.nestable` are yaac-shipped content
  running pinned upstreams — the same trust tier as the node/infra
  podman work already declared out of scope. Built and pushed exactly as
  today.
- **Untrusted layers build in ephemeral runsc builder pods.** The
  user/agent-editable `Dockerfile.yaac` (layered or standalone) and
  `Dockerfile.user` — 100% of the code the threat model distrusts. One
  pod per build request (the coordinator already single-flights per
  content-hash tag), created on demand, deleted after the push;
  adjacent untrusted layers in one chain share the pod.
- **The registry is the write-through cache and the only image bus.**
  Builder pods pull their parent from it and push their product back
  (delta-only — measured 1.2s, cross-repo blob mounting works); the
  graphroot is pure scratch. The common path — tag already present —
  stays a registry HEAD that touches no pod. No builder-side cache
  state, no cache GC, no warm-pod lifecycle, and builds of different
  tags parallelize naturally.

Why the change from the long-lived warm builder: the warm graphroot's
value was amortizing cold builds of the big trusted layers — which no
longer build in the sandbox at all. The remaining sandboxed work is
small (39s measured for a representative project layer); a per-build
pod pays ~5s spinup + a 66s parent pull instead of carrying warm-cache
upkeep, in-pod image GC, and a concurrency-serializing singleton. The
original rejection of per-build pods ("a cold graphroot per build
guarantees the worst-case slowdown") was written for full-chain sandbox
builds; under the trust split the worst case is bounded by the small
untrusted suffix.

Why not the salvage/promoter transport (shared hostPath store + writer
pod) as the image bus:

- The write path needs no help — the delta push is 1.2s. A promoter
  would replace it with save-to-tar → writer pod → `podman --root
  load` → host-side push: strictly more machinery arriving at the same
  registry.
- The read path (the 66s parent pull) is the one leg a salvage-style
  read-only `additionalimagestores` mount could win, by making
  host-built parents visible in-pod with no pull — nested sessions
  prove gofer-backed additional stores work in production. But the
  host engine's store is not node-visible in kind (needs an extraMount
  and a cluster recreate) and couples podman versions/storage formats
  across host and pod. Kept as a named optimization if parent-pull
  latency ever matters; cheaper first levers are zstd host pushes and
  a keep-warm TTL (see Performance).

BuildKit and kaniko remain rejected as before — and the spike showed
engine choice cannot move the dominant sandbox cost anyway.

Why exec-per-build rather than a build API/daemon: it matches the repo's
shell-out convention (kubectl only, no client libraries), keeps stdio log
streaming identical to today's piped `podman build`, and the CLI-writes-OCI
cache property that motivated CLI-over-API on the host holds in-pod too.

## Architecture

### Ephemeral builder pods

- One pod per untrusted build request, named
  `yaac-builder-<tag-hash8>-<rand>`, labeled `yaac.role: builder` plus
  install labels so the existing background sweep reaps leaks (same
  pattern as salvage-writer pods), in the yaac namespace. Image: the
  mirrored `podman-stable` digest pin (already in the registry for the
  salvage writer; consider a thin derived image later).
- `runtimeClassName: gvisor` (plain, not `-nested`: chroot isolation
  needs no raw sockets), `NESTED_ENGINE_CAPS`,
  `automountServiceAccountToken: false`, seccomp RuntimeDefault,
  memory limit ~8Gi, `activeDeadlineSeconds` as a hard whole-pod bound
  on top of per-phase exec timeouts.
- Graphroot `/var/lib/containers` on **disk-backed sentry tmpfs** via
  the same `dev.gvisor.*` mount annotations as nested sessions
  (spike-verified under the plain `gvisor` handler). Pure scratch —
  sized for parent + build (~16Gi cap), dies with the pod. Zero gofer
  RPCs on the build hot path, and no cache GC to run ever.
- Entrypoint: sleep. First exec writes `/etc/containers/storage.conf`
  (native overlay on the tmpfs graphroot — the stock image forces
  fuse-overlayfs, broken under runsc; keep `pull_options` partial-image
  support). Then, per build, all via `kubectl exec` with log streaming
  identical to today's piped build:
  1. `podman pull` the parent ref from the registry, retag to the bare
     parent tag so `--build-arg BASE_IMAGE=<tag>` semantics match host
     builds exactly (measured 65.6s for the 4.7GB tools chain — the
     dominant fixed cost).
  2. Stream the context in as a tar honoring `.containerignore`
     exactly like `contextHash()` (the `getDataDir()` context for
     `Dockerfile.user` needs a size sanity check), then
     `podman build --isolation chroot -t <tag> -f <dockerfile> …`.
  3. `podman push --tls-verify=false` back to the registry — delta
     only (measured 1.2s: podman's blob-info cache cross-repo-mounts
     the parent blobs it just pulled, so only new layers upload).
  4. Delete the pod. A chain with two untrusted layers (project then
     `Dockerfile.user`) reuses the pod — the second parent is already
     local.
- Optional later: a keep-warm TTL keyed by parent tag (skip spinup +
  parent pull during Dockerfile edit loops), bounded and reaped by the
  same label sweep.

### Registry access (pull + push path)

Builder pods both pull parents from and push products to the local
registry. Trusted-layer pushes stay host-side as today; the untrusted
layer's push relocates into the pod (and shrinks to a delta).
The `yaac-registry` container lives on the podman `kind` network, not in
cluster DNS. Expose it to pods via a selectorless Service +
EndpointSlice pointing at the registry's kind-network IP, written during
cluster setup/repair (setup already runs `podman network connect kind
yaac-registry`, so discovering the IP host-side at setup time is
consistent with existing conventions). Push with `--tls-verify=false` to
`yaac-registry.<ns>.svc:5000/...`; node containerd `hosts.toml` mapping
for pulls is unchanged. The existing `registryHasTag()` skip check runs
server-side over HTTP exactly as today.

### Egress for RUN steps

`Dockerfile.yaac`/`Dockerfile.user` RUN steps need apt/npm/curl (and a
standalone `Dockerfile.yaac` pulls its upstream FROM image). Phase 1:
allow direct egress from the builder pod via NetworkPolicy — strictly
better than today (host builds have unfiltered host-network egress). Phase 2
(optional hardening): route builder egress through the session proxy with
the combined `{public roots} ∪ {proxy CA}` bundle — this exact problem is
already solved for nested build RUN steps (docs/nested-ca-combined-bundle.md).

### Server wiring

- Introduce a build-engine seam behind the two call sites: a
  `BuildEngine` with `build()`, `push()`, `imageExists()`, `remove()` —
  implementations `host-podman` (current code) and `cluster-pod`.
  Routing is **per layer, by trust**: `ImageLayer.name` already encodes
  it — `base`/`tools`/`nestable` → `host-podman`; `project`/`user` →
  `cluster-pod`. A new `env.ts` flag (`YAAC_BUILD_ENGINE`: `host` |
  `trust-split`) defaults to `host` until rollout completes, then
  flips; `host` remains the explicit fallback. [Implemented without the
  flag: trust-split shipped always-on, routing by a trusted-name
  whitelist — see docs/trust-split-builds-plan.md.]
- `build-coordinator.ts`, content-hash tagging, `resolveImageChain()`,
  prewarm, and the build-tracking/log-ingest UI are untouched — the
  engine streams the same stdio.
- `ensureImage()`'s existence check for untrusted layers moves to
  `registryHasTag()` (authoritative — the write-through property: the
  host store never sees these tags). Trusted layers keep the host
  `podman image inspect` path unchanged.
- `gcHostImages()` no longer sees untrusted tags; the registry becomes
  the only place untrusted generations accumulate (see open questions:
  registry-side generation GC).
- Timeouts: keep 600s per build; add budgets for pod-ready (~60s),
  parent pull (~180s), delta push (~120s); `activeDeadlineSeconds`
  bounds the whole pod. Failure at any step deletes the pod; the label
  sweep catches anything the server missed.

### Couplings and edge cases

- Untrusted-layer builds now require a healthy cluster. Both current
  triggers (session create, prewarm) already do; a `yaac project
  rebuild` that touches `Dockerfile.yaac`/`Dockerfile.user` gains that
  dependency — acceptable, with a clear error pointing at
  `yaac cluster check`. Trusted-layer builds (including the tools
  `--no-cache` refresh) stay host-only.
- Nested yaac (`YAAC_NESTED=1`): the inner server's builder pod would be
  a vcluster pod synced to the host cluster; `runtimeClassSpec('inner')`
  handling exists, but keep nested installs on the `host-podman` engine
  (in-pod podman, already sandboxed by the outer session) until the
  synced-builder path is validated.
- macOS: cluster runs inside the podman machine; the builder pod works
  the same, and actually removes host-arch coupling.
- e2e: `test/global-setup.ts` builds through the same seam;
  `requirePrebuilt` semantics unchanged.

## Performance plan (measured)

All sandbox-side numbers are spike measurements (sections below), not
estimates:

| Path | Today (host) | Trust-split | Delta |
|---|---|---|---|
| No-op (tag in registry) | registry HEAD ~0s | identical | none — and this is the common path |
| Trusted layers cold (default + tools) | ~160s build + push | identical (host) | none |
| Untrusted layer rebuild (representative layered yaac) | ~10s | ~5s spinup + 66s parent pull + 39s build + 1s delta push ≈ **~110s** | +100s absolute; rare (content-hash gated), per-tag parallel, prewarm keeps it off session create |
| Full cold chain incl. untrusted suffix | ~210s | ~310s | ≈**1.48x** — inside the original 1.5x gate |
| Standalone `Dockerfile.yaac` (fully untrusted) | native | ~3x | the maximally untrusted input pays the full sandbox price |

Levers if the +100s rebuild ever matters, in cost order: keep-warm TTL
pods (skips spinup + parent pull in Dockerfile edit loops); zstd /
zstd:chunked compression on host pushes (decompression dominates the
66s pull; partial pulls need chunked layers); a read-only
`additionalimagestores` parent store fed salvage-style (eliminates the
pull entirely, at the cost of kind extraMounts and podman version
pinning). Push-side needs nothing: cross-repo blob mounting already
makes pushes delta-only.

## Rollout phases

0. **Spike + benchmark** — done 2026-07-17 (see results below): all
   mechanics validated (annotations under plain `gvisor`, chroot builds
   with egress, native overlay on sentry tmpfs, tar-context exec,
   registry pull/push from the pod); the all-layers design failed its
   cold gate; the trust-split ephemeral flow measured at ~110s per
   untrusted rebuild / ~1.48x full-cold-chain.
1. **Engine seam** — extract `BuildEngine` with per-layer trust routing
   (`host-podman` impl only at first), `YAAC_BUILD_ENGINE` flag, unit
   tests. No behavior change. [The flag was ultimately dropped —
   always-on.]
2. **Builder infrastructure** — ephemeral builder pod manifest builder,
   reap-by-label in the background sweep, registry
   Service/EndpointSlice, NetworkPolicy, storage.conf bootstrap.
   Unit-test manifests; e2e for pull-build-push-in-pod.
3. **`cluster-pod` engine for untrusted layers** — pull/retag,
   tar-context exec build, delta push, log streaming into the existing
   build-tracking registry; flip the default to `trust-split`; keep
   `host` as explicit fallback for one release. [Shipped always-on
   instead; no fallback engine for untrusted layers.]
4. **Hardening (optional)** — proxy-routed builder egress with the
   combined CA bundle; registry write-scoping (any pusher can write any
   tag today — no worse than host builds, but a builder pod runs
   untrusted RUN steps nearer the push path, so e.g. a per-build
   staging repo + server-side copy is worth considering); keep-warm
   TTL. Note: the old goal of dropping the rootful-host-podman
   requirement dies with the trust split — trusted layers still build
   on the host by design.

## Phase 0 spike results (2026-07-17)

Setup: 8-core host (15GB RAM), kind-on-podman node, runsc 20260706.0
(systrap, directfs, overlay2=root:self). Builder pod: mirrored
`podman-stable:v5.5` under plain `gvisor`, `NESTED_ENGINE_CAPS`,
graphroot on a disk-backed sentry tmpfs via the
`NESTED_GRAPHROOT_ANNOTATIONS` mechanism, builds exec'd with
`--isolation chroot`, context streamed via `tar | kubectl exec -i`.
Host baseline: `podman build` against the rootful socket (the exact
`buildImage()` path), `--no-cache` for cold. Chain: `Dockerfile.default`
→ `Dockerfile.tools` → representative layered `Dockerfile.yaac`
(apt + npm-global steps).

| Leg | Host | Builder pod | Ratio |
|---|---|---|---|
| Cold base / tools / yaac | 104.0s / 55.9s / 10.1s | 345.0s / 116.1s / 42.1s | 3.3x / 2.1x / 4.2x |
| Cold chain end-to-end | 170.0s | 503.2s | **3.0x** |
| Warm rebuild, per layer (median of 3) | 0.7s | 1.8s | +1.1s absolute |
| Push tools chain → registry | 33.1s | 39.8s | 1.2x |
| ubuntu:24.04 pull (off-gate) | — | 5.0s | — |

**Gate verdict: cold FAILS (3.0x vs the ≤1.5x gate).** Push passes.
Warm fails the ≤1.1x ratio as written, but the absolute cost is ~1.1s
per layer of kubectl-exec + tar round-trip — and the production warm
no-op path (`registryHasTag` HEAD) never reaches the pod at all, so the
warm gate arguably needs restating in absolute terms.

Attribution (phase-instrumented identical Dockerfile, both sides):

- `apt-get install` is the outlier: 87.2s vs 10.7s (**8.2x**).
- tar-extract and `npm install -g`: 2.2–2.3x (slightly above the
  predicted 1.2–2x band).
- Network: parity (26MB node tarball 0.7s vs 0.3s; `apt-get update`
  7.1s in-pod vs 9.9s host — netstack throughput is not a factor).
- Layer commit/snapshot overhead: ~29s vs ~10s per 5-layer chain (2.9x).
- Microbench pins the apt outlier on process creation: 500× fork+exec
  of `/bin/true` = 4.9s in-pod vs 0.56s on host (**8.7x**, ~9ms per
  spawn under systrap). dpkg maintainer scripts and triggers spawn
  hundreds of processes; that — not file I/O — dominates the cold gap.

Implications:

- **The prescribed BuildKit fallback benchmark was skipped as moot**:
  the dominant cost is RUN-step execution inside the sentry (fork/exec
  + syscall overhead), identical under any in-sandbox builder. Only the
  ~19s/chain commit delta is engine-dependent — not enough to close
  3.0x to 1.5x.
- Paths to revisit: (a) accept ~3x cold — cold builds happen once per
  Dockerfile/uid change, prewarm keeps them off session create, and the
  common path (tag exists → registry HEAD) is unchanged; (b) runsc KVM
  platform where `/dev/kvm` is available (systrap is the portability
  choice for kind nodes); (c) ship the builder pod as opt-in hardening
  (`YAAC_BUILD_ENGINE`) while `host-podman` stays the default;
  (d) **split by trust** — only `Dockerfile.yaac`/`Dockerfile.user`
  (the user/agent-editable inputs the threat model actually names) build
  in the sandbox, FROM the host-built, registry-pushed parent;
  `Dockerfile.default`/`.tools` are yaac-shipped pinned-upstream content
  (same trust tier as the out-of-scope node-infra podman work) and stay
  on the host engine. Build-only arithmetic: 104s + 56s native + 42s
  sandboxed ≈ 202s vs 170s all-native ≈ 1.19x (with the later-measured
  parent pull + spinup included it is ~1.48x — see "Ephemeral-builder
  flow measurements" — still inside the 1.5x gate, with 100% of
  untrusted Dockerfile code sandboxed). A
  standalone `Dockerfile.yaac` (replaces base+tools, fully untrusted)
  still pays the full ~3x — correctly, as the maximally untrusted case.
  Microvm/KVM alternatives were ruled out on this host (see follow-up
  below); a KVM-free microVM does not exist — QEMU TCG and UML are both
  slower than systrap on precisely this workload profile.
- All mechanics validated: the `dev.gvisor.*` annotation passthrough
  works under the plain `gvisor` handler (not just `gvisor-nested`);
  chroot-isolation builds with working in-RUN egress/DNS; the overlay
  driver runs natively on the sentry tmpfs graphroot — but
  `podman-stable`'s stock storage.conf forces `mount_program =
  fuse-overlayfs` and must be overridden (builder lifecycle must write
  a storage.conf, or use a thin derived image); in-pod push to the
  registry's kind-network IP works (`--tls-verify=false`, 1.2x host
  push time).
- Spike residue: the registry now holds `spike-pod-tools`,
  `spike-host-tools` (~3GB compressed each), and `spike-user-proj`
  (small — its parent blobs are cross-repo mounts; no delete API is enabled,
  so removal means recreating the registry container or exec-deleting
  the repo dirs + `registry garbage-collect`). Host store and the
  spike namespace were cleaned up.

### KVM / outside-kind follow-up (2026-07-17)

- **runsc's KVM platform is unavailable on this dev host**: `/dev/kvm`
  does not exist, `systemd-detect-virt` reports the machine is itself a
  KVM guest, and `/proc/cpuinfo` shows no vmx/svm — nested
  virtualization is not exposed, so the kvm module cannot load. This
  also rules out every microVM-style alternative (Firecracker etc.) on
  this box. The KVM-platform benchmark needs bare metal or a
  nested-virt-enabled VM; on real user machines `/dev/kvm` is common,
  so a setup-time platform probe (kvm where available, systrap
  fallback) remains the interesting lever.
- **Running the builder outside kind would not help**: fork+exec ×500
  A/B — host native 562ms, plain runc pod on the kind node 595ms,
  runsc(systrap) pod 4895ms. The kind container layer costs ~6%; the
  entire overhead is the runsc platform, which would be the same
  systrap when run host-level (no `/dev/kvm`). "Outside kind" only
  matters as a route to KVM, which this host cannot take.
- Operational note for any host-level (non-k8s) runsc design: rootless
  runsc is blocked by the Debian 13 / Ubuntu 24.04+ AppArmor
  `unprivileged_userns` restriction (`fork/exec /proc/self/exe:
  permission denied` on the namespace re-exec), and podman-remote does
  not accept `--runtime`, so host-level runsc means root privileges
  and local (non-socket) engine invocation — a worse privilege posture
  than the builder pod.

### Ephemeral-builder flow measurements (2026-07-17)

Same spike pod recreated with an empty graphroot — i.e. exactly the
per-tag ephemeral scenario:

- Pod create → Ready (builder image already on the node): ~5s.
- Parent pull (the 4.7GB-uncompressed tools chain from the local
  registry over the kind network, gzip layers): **65.6s** —
  decompress-bound, the dominant fixed cost of an ephemeral build.
- Representative layered `Dockerfile.yaac` build on the pulled parent:
  **38.7s** (vs 10.1s host-native; consistent with the cold-chain run).
- Delta push of the result to a fresh repo: **1.2s** — podman's
  blob-info cache cross-repo-mounts the parent blobs it just pulled,
  so only the new layers upload. Registry-as-write-through-cache
  needs no special layout for push dedup.

Follow-up measurements (same day, for the step-cache/zstd plan
revision):

- zstd compression swap: host push of the 4.7GB tools image with
  `--compression-format zstd` = 34.8s (vs 33.1s gzip — free), and the
  empty-graphroot pod pull drops from 65.6s to **40.4s** (1.6x; the
  remainder is layer extraction, not decompression).
- Registry step cache under the runsc builder (podman 5.5
  `--cache-to`/`--cache-from`, chroot isolation): first build of a
  two-step Dockerfile with `--cache-to` = 13.1s (includes a 5s RUN and
  the cache-image pushes); after `rmi` + `image prune -f` (simulating
  a fresh pod, parent still present), the `--cache-from` rebuild =
  **1.3s** with every step reported "Using cache" — cache manifests
  pulled from the registry instead of re-executing. Step cache cannot
  remove the parent pull, though: `FROM ${BASE_IMAGE}` must be
  materialized locally before any step, cached or not, can apply.

### BuildKit-under-runsc benchmark (2026-07-17)

Requested comparison for the trust-split ephemeral flow: buildkitd
(moby/buildkit v0.31.2, OCI worker, overlayfs snapshotter on the same
disk-backed sentry-tmpfs state volume) in an identical runsc pod, vs
the podman numbers above.

| Leg | podman 5.5 | BuildKit v0.31.2 |
|---|---|---|
| Parent pull+extract (4.7GB zstd) | 40.4s | 42.5s |
| Representative yaac build (apt+npm) | 38.7s | **27s** |
| Cached build + delta push | 1.2s (push only) | 6s |
| Remote step-cache all-hit rebuild (local cache wiped) | 1.3s | 1s |

Findings:

- **Stock BuildKit fails under runsc out of the box**: its runc
  executor (runc ≥1.2) masks `/sys/firmware` with a tmpfs mount
  carrying `nr_blocks`/`nr_inodes` options the sentry rejects
  (`invalid argument`) — every RUN step fails.
  `--oci-worker-no-process-sandbox` is rootless-only. **Swapping in
  runc 1.1.15** (plain-tmpfs masking) fixes it; RUN steps then work
  under the full runc sandbox, and chatty apt output streams fine (no
  buildah-oci-style stdio break).
- Where it's faster: the 27s vs 38.7s build is snapshot/commit
  machinery (buildah's per-step commits were the measured ~29s/chain
  overhead; BuildKit snapshots are lighter). The sentry-bound RUN
  execution and the pull/extract leg are engine-equal, as predicted.
- End-to-end ephemeral rebuild: ~80s vs ~85s — the 12s build win is
  mostly diluted by the shared pull cost.
- Cost of adopting it: a second engine (buildkitd daemon + buildctl,
  different cache/GC/log semantics, no in-repo precedent) plus a
  **runc 1.1 pin against current gVisor** — exactly the
  upstream-drift fragility the podman path avoids (its chroot
  isolation needs no OCI runtime in the RUN path at all). Verdict:
  stay on podman for the trust-split rollout; revisit BuildKit only
  if the masked-path mount options gain sentry support upstream (or
  rootless-BuildKit-under-runsc is validated) and the ~12s/build
  matters.

## Open questions

- ~~Exact runsc behavior of podman's overlay storage driver on the tmpfs
  graphroot vs falling back to vfs~~ — answered by the spike: native
  overlay works under plain `gvisor` with chroot isolation, provided the
  stock `podman-stable` storage.conf (which forces fuse-overlayfs) is
  overridden.
- ~~Whether `podman build` cache probing does enough metadata syscalls to
  matter on warm builds under systrap~~ — answered by the spike: warm
  rebuilds are ~1.8s end-to-end per layer including the kubectl-exec +
  tar round-trip; cache probing itself is negligible.
- ~~Builder concurrency~~ — dissolved by per-tag ephemeral pods: builds
  parallelize per tag like the host engine did, at the cost of a parent
  pull per pod instead of duplicated warm caches.
- Registry-side generation GC: untrusted-layer repos now accumulate
  generations in the registry with no delete API enabled (the
  host-store generation sweep never sees these tags). Options: enable
  `REGISTRY_STORAGE_DELETE_ENABLED` + a manifest-delete/garbage-collect
  cycle in the background loop, or periodic registry recreation (blunt;
  costs re-pushes).
- Keep-warm TTL policy: whether Dockerfile edit-loop latency (~110s
  per iteration, dominated by the 66s parent pull) is annoying enough
  in practice to warrant it, and the right idle timeout.
- zstd / zstd:chunked host-push compression: cuts the parent-pull
  decompress cost and enables partial pulls, but needs a
  compatibility check against the node containerd pull path and the
  pinned builder podman.
- Whether image-salvage's shared store (`additionalimagestores`) should
  also feed the builder pod as a read-only layer source — now framed as
  the pull-elimination optimization (see design decision); only worth
  its extraMount + version-pinning cost if keep-warm and zstd prove
  insufficient.

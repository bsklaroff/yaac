# Plan: gVisor-isolated image builds

Status: proposal (researched 2026-07-17, not yet implemented).

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

## Design decision: podman in a long-lived runsc builder pod

Chosen: a **long-lived builder pod** (one per server install) running the
mirrored `podman-stable` image under `runtimeClassName: gvisor`, with the
graphroot on disk-backed sentry tmpfs, driven by `kubectl exec` per build —
`podman build --isolation chroot` with the context streamed in as a tar.

Why not the alternatives:

- **Rootless BuildKit deployment** — the industry-consensus builder and a
  fine fallback, but it's a second engine: different CLI, different cache
  semantics (`--cache-to/--cache-from type=registry`), and no in-repo
  precedent. Podman-in-runsc reuses the exact `podman build -t -f
  --build-arg` semantics of `buildImage()`, the proven
  `gvisor-nested`/chroot/tmpfs configuration, and the already-mirrored
  builder image. Revisit BuildKit only if the perf gate (below) fails.
- **kaniko** — archived; also slower and memory-hungry on large images.
- **Per-build ephemeral pods + registry cache export** — the least
  stateful design, but podman's registry cache-image support is weaker
  than BuildKit's `mode=max`, and a cold graphroot per build guarantees
  the worst-case slowdown. A single warm builder matches our topology
  (single node, single server process, coordinator already serializes per
  tag) and is the Railway pattern in miniature.

Why exec-per-build rather than a build API/daemon: it matches the repo's
shell-out convention (kubectl only, no client libraries), keeps stdio log
streaming identical to today's piped `podman build`, and the CLI-writes-OCI
cache property that motivated CLI-over-API on the host holds in-pod too.

## Architecture

### Builder pod

- One `yaac-builder` pod (Deployment, replicas 1) in the yaac namespace.
  Image: the mirrored `podman-stable` (same digest pin as the salvage
  writer; consider a thin derived image later if we need extra tools).
- `runtimeClassName: gvisor` (plain, not `-nested`: chroot isolation needs
  no raw sockets; add `gvisor-nested` only if something demands it),
  `NESTED_ENGINE_CAPS`, seccomp/apparmor unconfined if needed — all
  sandbox-local under runsc.
- Graphroot `/var/lib/containers` on **disk-backed sentry tmpfs** via the
  same `dev.gvisor.*` mount annotations as nested sessions. This is the
  warm layer cache; it lives as long as the pod. Zero gofer RPCs on the
  build hot path.
- Entrypoint: sleep/pause. Builds arrive via
  `kubectl exec -i yaac-builder -- sh -c 'tar -x -C <ctx> && podman build
  --isolation chroot -t <tag> -f <dockerfile> …'` with the context tarred
  on the server side. Contexts are small today (`dockerfiles/`, project
  config dir); the tar stream must honor `.containerignore` exactly like
  `contextHash()` does, and the `getDataDir()` context for
  `Dockerfile.user` needs a size sanity check.
- `automountServiceAccountToken: false`; NetworkPolicy as below.
- Lifecycle: created/refreshed by cluster setup + the background loop
  (recreate on builder-image or runsc upgrade — pin the spec hash in an
  annotation). Cache GC: port the `image-gc.ts` generation sweep to a
  periodic exec (`podman image ls` / `rmi` / `prune`) in the pod;
  restarting the pod is the blunt fallback (cost: one cold rebuild).

### Registry access (push path)

The builder pushes straight to the local registry — replacing today's
host-side `podman push`, so this leg is not added latency, it's relocated.
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

`Dockerfile.default`/`.tools` RUN steps need apt/npm/curl. Phase 1: allow
direct egress from the builder pod via NetworkPolicy — strictly better
than today (host builds have unfiltered host-network egress). Phase 2
(optional hardening): route builder egress through the session proxy with
the combined `{public roots} ∪ {proxy CA}` bundle — this exact problem is
already solved for nested build RUN steps (docs/nested-ca-combined-bundle.md).

### Server wiring

- Introduce a build-engine seam behind the two call sites: a
  `BuildEngine` with `build()`, `push()`, `imageExists()`, `remove()` —
  implementations `host-podman` (current code) and `cluster-pod`.
  Selected by a new `env.ts` flag (e.g. `YAAC_BUILD_ENGINE`), default
  `host-podman` until the perf gate passes, then flipped.
- `build-coordinator.ts`, content-hash tagging, `resolveImageChain()`,
  prewarm, and the build-tracking/log-ingest UI are untouched — the
  engine streams the same stdio.
- `ensureImage()`'s existence check moves from host `podman image
  inspect` to `registryHasTag()` (authoritative once builds no longer
  populate the host store) with a builder-pod `podman image exists`
  fallback for unpushed intermediates.
- `gcHostImages()` gains a cluster-pod twin; host GC stays while the host
  engine remains a fallback.
- Timeouts: keep 600s per build/push, plus a bounded wait for builder-pod
  readiness (cold create on first build after setup).

### Couplings and edge cases

- Builds now require a healthy cluster. Both current triggers (session
  create, prewarm) already do; `yaac project rebuild` gains that
  dependency — acceptable, with a clear error pointing at
  `yaac cluster check`.
- Nested yaac (`YAAC_NESTED=1`): the inner server's builder pod would be
  a vcluster pod synced to the host cluster; `runtimeClassSpec('inner')`
  handling exists, but keep nested installs on the `host-podman` engine
  (in-pod podman, already sandboxed by the outer session) until the
  synced-builder path is validated.
- macOS: cluster runs inside the podman machine; the builder pod works
  the same, and actually removes host-arch coupling.
- e2e: `test/global-setup.ts` builds through the same seam;
  `requirePrebuilt` semantics unchanged.

## Performance plan (the "minimum slowdown" argument)

Where time goes today, and what changes:

| Path | Today | After | Expected delta |
|---|---|---|---|
| Warm no-op (tag exists) | host `image inspect` + registry HEAD | registry HEAD | ~zero |
| Warm layer-cache build | host podman cache | builder tmpfs cache | ~zero to small (sentry syscall overhead on cache probing) |
| Cold build, FS-heavy steps | host native FS | sentry tmpfs FS | 1.2–2x on those steps |
| Cold build, network/compile steps | host | sandbox | near parity |
| Push to registry | host → podman network | pod → same registry | comparable |

Levers, all in the design: warm long-lived builder (never rebuild the
cache per build), graphroot on sentry-internal tmpfs (no gofer on the hot
path), registry skip-check before any pod exec, runsc defaults already
tuned (systrap, directfs, `overlay2=root:self`), base layers mirrored
locally, prewarm keeping session-create off the cold path, and keeping
runsc pinned-but-current (`GVISOR_VERSION`) since builder-compat fixes
land upstream monthly.

**Benchmark gate (phase 0, before any wiring):** manually run the real
chain (`Dockerfile.default` → `.tools` → a representative
`Dockerfile.yaac`) in a hand-built builder pod vs the host baseline;
record cold and warm times. Proceed if warm ≤1.1x and cold ≤1.5x
end-to-end; if cold is worse, benchmark the same chain under rootless
BuildKit-in-runsc before falling back.

## Rollout phases

0. **Spike + benchmark** — hand-built pod (mirrored podman image, gvisor
   runtime class, tmpfs graphroot annotations, exec'd chroot builds);
   collect the gate numbers above. Also validates the tar-context and
   registry-push legs.
1. **Engine seam** — extract `BuildEngine`, `host-podman` impl, env flag,
   unit tests. No behavior change.
2. **Builder infrastructure** — pod manifest builder + lifecycle in
   cluster setup/background loop, registry Service/EndpointSlice,
   NetworkPolicy, builder GC. Unit-test manifests; e2e for
   build-and-push-in-pod.
3. **`cluster-pod` engine** — exec-based build/push/exists/remove with
   log streaming into the existing build-tracking registry; flip the
   default flag; keep `host-podman` as explicit fallback for one release.
4. **Hardening (optional)** — proxy-routed builder egress with the
   combined CA bundle; drop rootful-host-podman requirement from
   `ensureContainerRuntime()` for installs that never need the fallback.

## Open questions

- Exact runsc behavior of podman's overlay storage driver on the tmpfs
  graphroot vs falling back to vfs — the nested-session engine already
  answers this in production, but verify the same holds under plain
  `gvisor` (non-nested) with chroot isolation during the spike.
- Whether `podman build` cache probing does enough metadata syscalls to
  matter on warm builds under systrap (spike measures this).
- Builder concurrency: one pod serializes heavy builds across projects
  more than the host engine did (host parallelism was per-tag). If prewarm
  contention shows up, scale to N builder pods keyed by layer family —
  at the cost of cache duplication.
- Whether image-salvage's shared store (`additionalimagestores`) should
  also feed the builder pod as a read-only layer source.

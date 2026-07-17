# Plan: trust-split image builds (ephemeral gVisor builder pods)

Status: implemented and always on — there is no engine flag; untrusted
layers unconditionally build in sandboxed builder pods (nested installs
excepted, whose in-pod engine is the outer sandbox). This is the clean
final design; research, rejected alternatives, and all spike
measurements live in docs/gvisor-build-isolation-plan.md.
Implementation notes at the end of this doc.

## Goal

Move execution of **untrusted** Dockerfiles off the host engine and into
runsc-sandboxed builder pods, so a malicious or compromised
`Dockerfile.yaac`/`Dockerfile.user` RUN step can at worst compromise a
throwaway sandbox instead of getting root-adjacent execution on the
host — at an acceptable latency cost on a path that is rare and
prewarm-hidden.

## Build routing (the trust split)

Routing is per layer, by trust, keyed on `ImageLayer.name` from
`resolveImageChain()`:

| Layers | Trust | Engine |
|---|---|---|
| `base`, `tools`, `nestable` (yaac-shipped Dockerfiles, pinned upstreams) | trusted | host podman, unchanged (build + push exactly as today) |
| `project` (`Dockerfile.yaac`, layered or standalone), `user` (`Dockerfile.user`) | untrusted (user/agent-editable) | ephemeral runsc builder pod |

Routing is a WHITELIST and is not configurable: only the exact layer
names `base`, `tools`, `nestable` build on host podman; every other
name — including any future layer — is sandboxed by default. The
trusted names cannot be faked: `resolveImageChain()` is the only
producer of layer names and assigns those three exclusively to the
yaac-shipped Dockerfiles; `Dockerfile.yaac` is always `project`
(layered or standalone) and `Dockerfile.user` always `user`, regardless
of content. Nested yaac installs (`YAAC_NESTED=1`) are the one
exception and build on their in-pod engine (already sandboxed by the
outer session).

## Ephemeral builder pods

One pod per untrusted build request — the build coordinator already
single-flights per content-hash tag. Adjacent untrusted layers in one
chain (`project` then `user`) reuse the same pod.

Pod spec:

- Name `yaac-builder-<tag-hash8>-<rand>`, label `yaac.role: builder` +
  install labels (reaped by the existing background sweep, like
  salvage-writer pods), yaac namespace.
- Image: the mirrored `podman-stable` digest pin (same as the salvage
  writer). `runtimeClassName: gvisor`, `NESTED_ENGINE_CAPS`,
  `automountServiceAccountToken: false`, seccomp RuntimeDefault,
  memory limit ~8Gi, `activeDeadlineSeconds` bounding the whole pod.
- Graphroot `/var/lib/containers` on a **disk-backed sentry-internal
  tmpfs** (~16Gi cap): emptyDir + the `dev.gvisor.spec.mount.*`
  annotations (the `NESTED_GRAPHROOT_ANNOTATIONS` mechanism; verified
  under the plain `gvisor` handler). Pure scratch, dies with the pod.
- Entrypoint sleep; driven by `kubectl exec` (repo convention; build
  logs stream into the existing build-tracking registry exactly like
  today's piped `podman build`).

Build flow, per layer tag `T` with parent tag `P`:

1. First exec bootstraps `/etc/containers/storage.conf`: overlay
   driver on the tmpfs graphroot (the stock image forces
   fuse-overlayfs, which is broken under runsc), `pull_options`
   partial-image support kept.
2. Materialize the parent: `podman pull --tls-verify=false
   <registry>/P` + retag to the bare tag `P` (measured 40.4s for the
   zstd-pushed tools chain — see Parent pull). Standalone
   `Dockerfile.yaac` has no yaac parent — its upstream FROM is pulled
   over pod egress.
3. Stream the build context in as a tar over `exec -i`, honoring
   `.containerignore` exactly like `contextHash()`; size sanity check
   on the `getDataDir()` context for `Dockerfile.user`. Then
   `podman build --isolation chroot --tls-verify=false
   --cache-from <registry>/yaac-buildcache-<slug>
   --cache-to <registry>/yaac-buildcache-<slug> --cache-ttl=<bound>
   -t T -f <dockerfile> --build-arg BASE_IMAGE=P …` — otherwise
   identical CLI semantics to `buildImage()`.
4. `podman push --tls-verify=false T <registry>/T` — delta-only
   (cross-repo blob mounting; parent blobs never re-upload).
5. Delete the pod on success or failure; the label sweep catches
   leaks.

## Registry access

The registry is the only image bus: builder pods pull parents from it
and push products to it; session pods pull final images from it
unchanged.

The registry holds two things per untrusted build:

- **Final images** — every per-instruction layer is pushed as a blob
  of the final manifest; parent blobs dedupe via cross-repo mounts, so
  product pushes are delta-only (1.2s measured).
- **Per-step cache images**, via `--cache-to`/`--cache-from` on every
  builder-pod build (validated under the runsc builder: a rebuild in a
  wiped store cache-hits every unchanged step from the registry in
  ~1.3s instead of re-executing). This restores the instruction-prefix
  caching that today's persistent host store provides — an edited
  `Dockerfile.yaac` re-runs only its changed steps, in any fresh pod.

Cache repos are **per project** (`yaac-buildcache-<slug>`;
`Dockerfile.user` steps cache into the repo of the project being
built). Scoping matters: cache entries are consumed by key with no
provenance check, so a hostile build can poison future cache hits —
per-project repos confine that to the project whose image the attacker
already controls. `--cache-ttl` bounds reads; cache repos join the
registry GC story (open question in the history doc).

The `yaac-registry` container lives on the podman
`kind` network, not in cluster DNS — expose it via a selectorless
Service + EndpointSlice pointing at its kind-network IP, written during
cluster setup/repair. The existing `registryHasTag()` HEAD stays the
server-side skip check, so the common path (tag already present)
touches no pod.

## Parent pull

An ephemeral pod must materialize its parent image before any step —
cached or not — can apply: `FROM ${BASE_IMAGE}` resolves against the
local store, so step cache cannot remove this leg. It is bounded
instead:

- **Trusted-layer pushes use `--compression-format zstd`.** Free on
  the host side (34.8s vs 33.1s gzip for the tools image) and it cuts
  the empty-graphroot pod pull from 65.6s to **40.4s** measured — the
  remainder is layer extraction, not decompression. Session-pod pulls
  of trusted images come from the same manifests, so node containerd
  zstd support must be confirmed first (validation item).
- The pull is paid once per pod, and the common path (tag exists →
  registry HEAD) never creates a pod at all.

If parent-pull latency ever dominates real usage, the escalation is a
node-local read-only `additionalimagestores` parent store seeded by
salvage-style writer pods — designed in
docs/gvisor-build-isolation-plan.md, deliberately omitted here: it
adds writer-pod seeding, store GC, and read-only-store validation to
save ~40s on a rare, prewarm-hidden path.

## Performance (all sandbox numbers measured)

| Path | Today (host) | Trust-split | Notes |
|---|---|---|---|
| No-op (tag in registry) | ~0s (registry HEAD) | identical | the common path; touches no pod |
| Trusted layers | native | identical | unchanged code path |
| Untrusted rebuild, one step edited | ~10s | ~50s: ~5s spinup + 40.4s zstd parent pull + ~1.3s cached prefix + the changed step + 1.2s push | the typical Dockerfile-iteration case |
| Untrusted rebuild, all steps changed | ~10s | ~85s: as above with the full 38.7s representative build | rare, per-tag parallel, prewarm-hidden |
| Full cold chain (base + tools + yaac) | ~210s | ~280s | ≈1.35x |

## Server wiring

- A `BuildEngine` seam behind `buildImage()`/`pushImageToRegistry()`:
  `build()`, `push()`, `imageExists()`, `remove()`; implementations
  `host-podman` (current code) and `cluster-pod`; routed per layer as
  above. Coordinator, content-hash tags, `resolveImageChain()`,
  prewarm, and the build-tracking UI are untouched.
- `ensureImage()` for untrusted layers uses `registryHasTag()`
  (authoritative — the host store never sees these tags); trusted
  layers keep the host inspect path.
- Timeouts: 600s build (unchanged) + budgets for pod-ready (~60s),
  parent pull (~180s), push (~120s); `activeDeadlineSeconds` above
  their sum.
- Untrusted-layer builds require a healthy cluster; `yaac project
  rebuild` touching `Dockerfile.yaac`/`Dockerfile.user` errors with a
  pointer to `yaac cluster check` when it isn't.
- Builder egress: NetworkPolicy allowing direct egress (strictly
  better than today's unfiltered host-network builds); optionally
  proxy-routed later with the combined CA bundle
  (docs/nested-ca-combined-bundle.md solves this for nested builds).
- e2e: `test/global-setup.ts` keeps building trusted test images
  host-side with `requirePrebuilt` semantics unchanged; new e2e covers
  parent pull → step-cached build across two pods → delta push.

## Rollout phases

1. **Engine seam** — `BuildEngine` with per-layer trust routing
   (`host-podman` impl only), unit tests. No behavior change.
2. **Builder infrastructure** — builder pod manifest builder,
   reap-by-label sweep, registry Service/EndpointSlice, NetworkPolicy,
   storage.conf bootstrap. Unit-test manifests; e2e for
   pull-build-push-in-pod.
3. **`cluster-pod` engine** — parent pull/retag, tar-context exec
   build, delta push, log streaming; switch trusted-layer pushes to
   zstd (after the containerd validation below). Implemented always-on
   from the start — no host fallback for untrusted layers.
4. **Registry step cache** — `--cache-from`/`--cache-to` with
   per-project cache repos and a `--cache-ttl` bound; fold cache repos
   into the registry GC story.
5. **Hardening (optional)** — proxy-routed builder egress; registry
   write-scoping (e.g. per-build staging repo + server-side copy);
   keep-warm TTL pods only if pull latency in Dockerfile edit loops
   still warrants it after step cache.

## Validation items

- Already validated in the spike (see history doc): the `dev.gvisor.*`
  graphroot annotations under plain `gvisor`; chroot builds with
  egress; native overlay on sentry tmpfs; delta pushes;
  `--cache-to`/`--cache-from` under the runsc builder (1.3s all-hit
  rebuild in a wiped store); zstd pull 40.4s.
- Node containerd pulling zstd-compressed trusted images (session-pod
  path) — **validated 2026-07-17**: a zstd-layer image
  (`application/vnd.oci.image.layer.v1.tar+zstd`) pushed to the local
  registry was pulled by node containerd and ran to completion under the
  `gvisor` RuntimeClass.
- Step-cache key stability across genuinely distinct pods — **validated
  2026-07-17** by `test/e2e/trust-split-build.test.ts`: an edited
  Dockerfile's unchanged prefix cache-hits (`Using cache`) in a fresh
  builder pod that had never built anything.
- Cache-repo growth rate under real Dockerfile iteration, to size the
  `--cache-ttl` bound (currently 168h) and the registry GC cadence —
  still open; observe under real usage.

## Implementation notes (2026-07-17)

- Engine seam: `packages/server/src/lib/container/build-engine.ts`
  (`engineForLayer` keyed on `ImageLayer.name`; `host-podman` wraps the
  existing build/inspect/remove, `cluster-pod` delegates to the builder
  pod). The seam is build/imageExists/remove — push is deliberately NOT
  routed per layer: a cluster-pod build's delta push is an inseparable
  build step, and `pushImageShared` instead learned to treat a forced
  push of a registry-only tag as already satisfied.
- Builder pods: `packages/server/src/lib/container/builder-pod.ts` —
  manifest, storage.conf bootstrap, parent pull/retag, `.containerignore`
  faithful tar streaming over `exec -i` (512MiB context cap), chroot
  build with per-project `--cache-from`/`--cache-to`
  (`yaac-buildcache-<slug>`, `--cache-ttl 168h`), delta push, and
  `BuilderPodLease` for pod reuse across adjacent untrusted layers.
- The "existing background sweep" the plan assumed did not exist;
  `reconcileBuilderPodGc` (same module) now reaps leaked
  `yaac.role=builder` pods from the background loop.
- Registry exposure: `packages/server/src/lib/k8s/registry-service.ts`
  (selectorless Service + EndpointSlice at the registry's kind-network
  IP), written by cluster setup/repair and re-ensured lazily before each
  untrusted build.
- Builder egress: the pods are excluded from the world-deny CNP's
  selector (a Cilium deny beats any allow) and carry an explicit
  allow-all egress NetworkPolicy.
- zstd is applied to trusted-parent pushes (the blobs builder pods and
  session pods pull); node containerd zstd pulls are validated (see
  above).
- Routing is a trusted-name whitelist (`isTrustedLayer` in
  build-engine.ts) — an unknown layer name sandboxes rather than
  host-builds. There is no engine flag; the original `YAAC_BUILD_ENGINE`
  rollout knob was dropped in favor of always-on.
- The `yaac.role=builder` label (which carves builder pods out of the
  world-deny egress policy) is reserved by a cluster-wide
  ValidatingAdmissionPolicy (`yaac-builder-role-guard`, bootstrap.ts):
  no ServiceAccount may create or update a pod carrying it — the only
  API identities untrusted code can hold (session pods have no token;
  a vcluster's syncer is an SA) — and carriers must run under the
  `gvisor` RuntimeClass. Applied fail-closed before any builder pod is
  created, and by `yaac cluster setup`.
- e2e: `test/e2e/trust-split-build.test.ts` covers Service/EndpointSlice
  wiring, pod-built untrusted layers (registry-only tags), cross-pod
  step cache, pod reuse (project+user in one request), the product
  running as a pod (containerd pull of the cross-repo-mounted manifest),
  and no leaked builder pods. Passed against the dev cluster in ~111s.
- Trust-split is unconditional: `ensureImage`/`rebuildProjectImage`
  route every non-whitelisted layer through builder pods on every
  install with a cluster (i.e. all of them — sessions already require
  one).

# Trust-split image builds

How yaac keeps untrusted Dockerfile execution off the host. This is a
current-state reference for the shipped subsystem.

## The problem

Image builds shell out to rootful podman on the host. Dockerfile `RUN`
steps execute arbitrary code, and two Dockerfiles in the build chain are
user/agent-editable:

- `Dockerfile.yaac` — the per-project Dockerfile (layered or standalone).
- `Dockerfile.user` — the per-user Dockerfile (`~/.yaac/Dockerfile.user`).

A malicious or compromised step in either would get root-adjacent code
execution on the host. Everything else in the chain
(`Dockerfile.default`, `Dockerfile.tools`, `Dockerfile.nestable`) is
yaac-shipped content over pinned upstreams — the same trust tier as the
node/registry podman that manages the cluster itself.

## The split

Build routing is per layer, by trust, keyed on `ImageLayer.name` from
`resolveImageChain()`:

| Layers | Trust | Engine |
|---|---|---|
| `base`, `tools`, `nestable` (yaac-shipped, pinned upstreams) | trusted | host podman, built and pushed exactly as before |
| `project` (`Dockerfile.yaac`), `user` (`Dockerfile.user`) | untrusted (user/agent-editable) | ephemeral runsc builder pod |

Routing is a **whitelist** and is not configurable. Only the exact names
`base`, `tools`, `nestable` build on the host; every other name —
including any future layer — is sandboxed by default. The trusted names
cannot be faked: `resolveImageChain()` is their only producer and assigns
them exclusively to the yaac-shipped Dockerfiles, regardless of file
content. Untrusted layers build against their host-built, registry-pushed
parent, so the sandbox only ever executes the untrusted suffix of a chain.

Nested yaac installs (`YAAC_NESTED=1`) are the one exception: they build
on their in-pod engine, already sandboxed by the outer session.

## Why sandbox only the untrusted layers

The dominant cost of building under runsc is `RUN`-step process creation
under the systrap platform (~9ms/spawn, ~8x host), which no engine choice,
kind topology, or (on hosts without `/dev/kvm`) KVM platform can move —
apt/dpkg maintainer scripts that spawn hundreds of processes pay it in
full, so sandboxing a whole chain runs ~3x slower cold. Most of that cost
is the big *trusted* layers, which carry no untrusted code, so the split
sandboxes only the untrusted suffix.

The trust split cuts along the threat model: trusted layers keep native
host speed, and only the small untrusted suffix pays the sandbox tax. That
tax is bounded — a standalone fully-untrusted `Dockerfile.yaac` is the
worst case and correctly pays the most. A full cold chain runs ~1.35x
host; the common path (tag already in the registry) touches no pod at all.

## Ephemeral builder pods

One pod per untrusted build request — the build coordinator already
single-flights per content-hash tag. Adjacent untrusted layers in one
chain (`project` then `user`) reuse the same pod, since the second
parent is already local.

Pod spec:

- Name `yaac-builder-<tag-hash8>-<rand>`, label `yaac.role: builder` plus
  install labels, in the yaac namespace. Image: the mirrored
  `podman-stable` digest pin (same as the image-salvage writer).
- `runtimeClassName: gvisor` (plain chroot isolation needs no raw
  sockets), `NESTED_ENGINE_CAPS`, `automountServiceAccountToken: false`,
  seccomp RuntimeDefault, memory limit ~8Gi, `activeDeadlineSeconds`
  bounding the whole pod.
- Graphroot `/var/lib/containers` on a disk-backed sentry-internal tmpfs
  (~16Gi cap) via the `dev.gvisor.spec.mount.*` graphroot annotations.
  Pure scratch, dies with the pod — zero gofer RPCs on the build hot path
  and no cache GC to run.
- Entrypoint sleep; driven by `kubectl exec` so build logs stream into
  the existing build-tracking registry exactly like a piped host build.

Build flow, per layer tag `T` with parent tag `P`:

1. First exec bootstraps `/etc/containers/storage.conf` for the native
   overlay driver on the tmpfs graphroot (the stock image forces
   fuse-overlayfs, which is broken under runsc).
2. Materialize the parent: `podman pull` `<registry>/P` and retag to the
   bare tag `P`, so `--build-arg BASE_IMAGE=P` semantics match a host
   build exactly. A standalone `Dockerfile.yaac` has no yaac parent — its
   upstream `FROM` is pulled over pod egress.
3. Stream the build context in as a tar over `exec -i`, honoring
   `.containerignore` exactly like `contextHash()`. Then `podman build
   --isolation chroot` with per-project `--cache-from`/`--cache-to` and a
   `--cache-ttl` bound — otherwise identical CLI semantics to a host build.
   Chroot isolation is required: buildah's default OCI isolation breaks
   the `RUN`-step stdio relay under the sentry after tens of KB of output.
4. `podman push` `T` back to the registry — delta-only (cross-repo blob
   mounting means parent blobs never re-upload).
5. Delete the pod on success or failure; a background reconcile
   (`reconcileBuilderPodGc`) reaps any leaked `yaac.role=builder` pods.

## The registry is the only image bus

Builder pods pull parents from the local registry and push products back;
session pods pull final images from it unchanged. It holds two things per
untrusted build:

- **Final images** — pushed delta-only via cross-repo blob mounts.
- **Per-step cache images** — `--cache-from`/`--cache-to` on every builder
  build restore the instruction-prefix caching that a persistent host
  store would give: an edited `Dockerfile.yaac` re-runs only its changed
  steps, in any fresh pod. Cache repos are **per project**
  (`yaac-buildcache-<slug>`): cache entries are consumed by key with no
  provenance check, so per-project scoping confines a poisoned entry to
  the project whose image the attacker already controls. `--cache-ttl`
  bounds reads.

The `yaac-registry` container lives on the podman `kind` network, not in
cluster DNS, so it is exposed to pods via a selectorless Service +
EndpointSlice pointing at its kind-network IP, written by cluster
setup/repair and re-ensured before each untrusted build. The existing
`registryHasTag()` HEAD stays the server-side skip check, so the common
path (tag already present) never creates a pod.

## Parent pull

An ephemeral pod must materialize its parent before any step — cached or
not — can apply, since `FROM ${BASE_IMAGE}` resolves against the local
store. Step cache cannot remove this leg; it is bounded instead:

- Trusted-layer pushes use `--compression-format zstd`. It is free on the
  host side and roughly halves the empty-graphroot pod pull (the remainder
  is layer extraction, not decompression). Session pods pull the same
  manifests, so node containerd zstd support was confirmed before this
  shipped.
- The pull is paid once per pod, and the common no-op path never creates
  a pod.

If parent-pull latency ever dominates real usage, the escalation is a
node-local read-only `additionalimagestores` parent store seeded by
salvage-style writer pods (as image-salvage already proves gofer-backed
additional stores work). It is deliberately not built: it adds writer-pod
seeding, store GC, and version pinning across host and pod to save the
pull on a rare, prewarm-hidden path.

## Server wiring

- A `BuildEngine` seam (`features/images/build-engine.ts`,
  `engineForLayer` keyed on `ImageLayer.name`): `host-podman` wraps the
  existing build/imageExists/remove; `cluster-pod`
  (`features/images/builder-pod.ts`) drives the builder pod. Push is
  deliberately not routed per layer — a cluster-pod build's delta push is
  an inseparable build step, and the shared push path treats a forced push
  of a registry-only tag as already satisfied. The coordinator,
  content-hash tags, `resolveImageChain()`, prewarm, and the
  build-tracking UI are untouched.
- Existence checks for untrusted layers use `registryHasTag()`
  (authoritative — the host store never sees these tags); trusted layers
  keep the host inspect path. The host image GC never sees untrusted tags,
  so untrusted generations accumulate only in the registry.
- Untrusted-layer builds require a healthy cluster; `yaac project rebuild`
  touching `Dockerfile.yaac`/`Dockerfile.user` errors with a pointer to
  `yaac cluster check` when it isn't. Trusted-layer builds (including the
  tools `--no-cache` refresh) stay host-only.

## Security hardening

- **Builder egress.** Builder pods are excluded from the world-deny
  NetworkPolicy and carry an explicit allow-all egress
  NetworkPolicy — strictly better than a host build's unfiltered
  host-network egress. Optionally routable through the session proxy later
  with the combined CA bundle (see docs/nested-containers.md), the same
  mechanism nested builds already use.
- **The `yaac.role=builder` label** (which carves builder pods out of the
  world-deny egress policy) is reserved by a cluster-wide
  ValidatingAdmissionPolicy (`yaac-builder-role-guard`): no ServiceAccount
  may create or update a pod carrying it — the only API identities
  untrusted code can hold — and carriers must run under the `gvisor`
  RuntimeClass. Applied fail-closed before any builder pod is created, and
  by `yaac cluster setup`.

## Open items

- **Registry-side generation GC** — untrusted-layer repos and per-project
  cache repos accumulate generations in the registry with no host-store
  sweep to catch them. Options: enable the registry delete API +
  manifest-delete/garbage-collect in the background loop, or periodic
  registry recreation. Size the `--cache-ttl` bound (currently 168h) and
  GC cadence against observed cache-repo growth.
- **Setup-time platform probe** — the runsc KVM platform, where
  `/dev/kvm` is available, would cut the RUN-step tax that systrap pays;
  systrap stays the portable fallback for kind nodes without it.
- **BuildKit** was measured ~12s/build faster than podman under runsc
  (lighter snapshot/commit), but needs a runc 1.1 pin against current
  gVisor and a second engine's cache/GC/log semantics; podman's chroot
  isolation needs no OCI runtime in the RUN path at all. Revisit only if
  that per-build delta starts to matter.

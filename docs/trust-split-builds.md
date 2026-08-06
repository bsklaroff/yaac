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
  `podman-stable` digest pin.
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

Every build — in a pod or on the host engine — is bounded by a pair of
timeouts, run by the shared `platform/streaming-proc.ts`:

- An **idle** timeout per exec step, the primary signal: the clock resets
  on every byte the step writes, and while the context tar streams in, on
  every byte accepted. A build has no honest *total* duration — a cold
  chain compiling a toolchain runs many times longer than a warm rebuild,
  and a total cap kills exactly those, mid-progress — whereas silence
  reliably means wedged, since podman emits a line per step, layer and
  progress tick.
- A **total** backstop, for the case idle cannot see: a build wedged but
  chatty (a `RUN` step retrying in a loop) never goes silent, and would
  otherwise hold the image-store lock forever. In a pod that backstop is
  the pod's `activeDeadlineSeconds`; on the host it is `buildImage`'s own
  total budget, which is shorter — the host only ever builds yaac-shipped
  layers over pinned upstreams.

Either expiry signals the child's whole process group — builds spawn
grandchildren that would otherwise keep the lock — and the failure is
raised as soon as the process is dead, without waiting for pipes a
surviving grandchild can hold open. A pod killed by its deadline shows up
to the caller only as a signalled `kubectl`, so that failure is annotated
from the pod's own status (`builderPodBlockReason`).

## The registry is the only image bus

The registry is an in-cluster `registry:2` Deployment behind a normal
ClusterIP Service, mirroring the per-project registries' topology (blobs on
a node hostPath, a containerd `hosts.toml` per node holding the live
ClusterIP so the node can resolve a name cluster DNS never serves it). It
sits in the *default* install namespace rather than the per-run one, so
concurrent e2e namespaces share one image store.

Its ingress is locked to its two caller classes: the node (an `ipBlock` —
containerd pulls, the kubelet probe, and the server's port-forward all
arrive from the host netns, which plain NetworkPolicy cannot name any other
way) and `yaac.role=builder` pods in any namespace. See the open risk below
for what that lock does and does not buy.

Every party addresses it the same way — by its Service FQDN
(`yaac-registry.<default-ns>.svc.cluster.local:5000`), which is the prefix
every yaac image ref carries. Builder pods pull parents from it and push
products back; session pods pull final images from it unchanged. The one
exception is the yaac SERVER, which is a host process with no route into
the pod network: it reaches the registry over a long-lived `kubectl
port-forward` (the same mechanism the stream relay uses) and pushes through
that loopback port. Blob storage is keyed by repository path, so the bytes a
push puts there are exactly what a node later pulls by the cluster ref. The
existing `registryHasTag()` HEAD, over the same forward, stays the
server-side skip check, so the common path (tag already present) never
creates a pod.

The registry holds two things per untrusted build:

- **Final images** — pushed delta-only via cross-repo blob mounts.
- **Per-step cache images** — `--cache-from`/`--cache-to` on every builder
  build restore the instruction-prefix caching that a persistent host
  store would give: an edited `Dockerfile.yaac` re-runs only its changed
  steps, in any fresh pod. Cache repos are **per project**
  (`yaac-buildcache-<slug>`): cache entries are consumed by key with no
  provenance check, so per-project scoping confines a poisoned entry to
  the project whose image the attacker already controls — but only against
  a build that stays in its own cache repo, not against one that writes
  another project's directly (see the open risk below). `--cache-ttl`
  bounds reads.

### Collecting the step cache

Each Dockerfile edit mints fresh cache keys and strands the old ones, so
the cache repos need a sweep of their own (`reconcileBuildCacheGc`, every
few hours). It retires cache tags no build has written for one
`--cache-ttl` — already misses on the read side, so retirement costs no
hit — and reads that age off the tag link's mtime, which a cache hit
refreshes when it re-pushes the entry: retention is last-used, not
first-built.

Like the per-project registries' collect (docs/nested-containers.md), the
sweep untags by removing the tag directory in the registry's own storage
and reclaims blobs with the registry binary's `garbage-collect
--delete-untagged` — the delete API answers 405 until the container is
recreated with `REGISTRY_STORAGE_DELETE_ENABLED`. That collect is global
rather than scoped to the cache repos, which makes one property of this
registry load-bearing: **nothing may live in it untagged or as an index.**
Blobs shared with a still-tagged image survive because the mark phase
walks that manifest, and the digest-pinned mirrors are stored as
single-arch children under tags of their own. A digest-only push, or a
manifest list whose children the mark phase never walks, would be
collected out from under its users.

What the sweep does not take is that collect's read-only maintenance
window, which is how the per-project one makes a live collect safe. Nothing
prevents it — this registry is a Deployment over a PVC too, so rolling it
with the read-only env costs a restart and no images — but
adopting it is a behaviour change of its own (every push and delete inside
the window answers 405), so it is a follow-up. Until then the two hazards of
collecting a live registry are handled directly:

- A push racing the collect can lose blobs between upload and manifest
  `PUT`, leaving an image that pulls broken forever — the `registryHasTag`
  skip means nothing re-pushes it. Three signals hold the collect off: an
  in-progress upload, any link file written in the last few minutes (a
  just-committed blob, a cross-repo mount, a just-PUT manifest — none of
  which leave an upload dir behind), and this server's own in-flight
  builds and pushes. The first two are read off the registry's filesystem,
  so they cover builder pods and e2e servers too, and both are re-read
  immediately before the collect, since the untag that precedes it takes
  time. A push that *starts* inside the collect is the one window left
  open; only the maintenance window would close it, so the collect is kept
  rare and short instead.
- The registry caches blob descriptors in memory, so after a collect a
  re-pushed digest writes a link with no blob behind it and the tag 404s
  permanently. The restart that clears them runs in an unconditional
  `finally` — a collect that failed part-way through deleting is when it
  matters most. Restarting is a Deployment rollout, which the Service's
  stable ClusterIP survives, so no node rewiring is owed; only the server's
  own port-forward, bound to the pod that went away, is dropped. A marker
  file in the registry's storage records that a collect began, so a restart
  lost to a failed rollout or to the server dying mid-collect is redone by
  the next sweep; nothing else would, since the tags that pass retired are
  already gone and a later sweep finds nothing to retire.

The pass detaches and never overlaps itself, like the per-project collect
and for the same reason: reconcile passes are serialized, and a collecting
pass is minutes of exec plus a restart.

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
per-node image cache seeded ahead of the pod. It is deliberately not
built: it adds a node-local store, its GC, and version pinning across
host and pod to save the pull on a rare, prewarm-hidden path.

## A restart aborts every in-flight build

Podman commits an image tag only when the build finishes, so a build that
outlives its server is invisible to the successor's existence check: it
starts a second build of the same tag, and the two fight over the shared
layer cache and the image-store lock. Both halves of the split therefore
die with the server.

- **Builder pods.** `reconcileBuilderPodGc` deletes any
  `yaac.role=builder` pod created before this process started (the
  data-dir lock admits one server per install, so an older pod can only
  belong to a dead one). The reconciler runs it ahead of the prewarm
  step on the boot pass, so the leaked pod's memory reservation is
  released before anything tries to schedule a replacement.
- **Host podman.** `podman build`/`podman push` children run through
  `platform/container/host-procs.ts`, which SIGTERMs them from the
  shutdown handler and records each pid in `<data dir>/host-podman.json`
  first. A host pid carries no label to select on, so the file is what
  makes the crash path reapable: `reapOrphanedPodmanProcs` reads it once
  at boot, confirms via `ps` that the pid is still a podman invocation
  carrying the recorded tag (a pid-reuse guard), and terminates it —
  SIGTERM so podman releases the store lock, escalating to SIGKILL after
  a grace period.

The in-memory build registry that feeds the webapp's build list is *not*
persisted: with the build itself aborted there is no live work to
reattach to, and the next prewarm sweep re-derives what is missing.

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

## Open risk: builder-origin writes to the shared registry

Builder pods are the untrusted principal here, and they must be able to
push — so **an attacker-authored `RUN` step can write any `repo:tag` in the
shared registry**. It is unauthenticated `registry:2` with mutable tags and
no path ACLs, and the builder's egress is necessarily allow-all (builds
fetch upstream packages). Nothing network-level closes this: the ingress
lock above pins *which pods* may be callers, not *what a legitimate caller
may write*. The reachable blast radius is the whole store — the
yaac-shipped `base`/`tools`/`nestable` content-hash tags, other projects'
final images, and any project's `yaac-buildcache-<slug>` repo.

Two consequences worth stating plainly:

- The per-project scoping of cache repos confines a poisoned entry only
  against a build that stays inside its own cache. It is **not** a boundary
  against a builder that writes another project's cache repo directly,
  which it can.
- An overwritten tag is consumed: a builder pod pulls its parent fresh on
  every build (no local store to shield it), and node containerd re-pulls
  once kubelet image GC has evicted a tag.

Closing this needs authentication or path scoping — a push-side proxy that
mints per-build, repo-scoped credentials is the obvious shape. Until then
the containment that does hold is the sentry around the `RUN` step itself
and the trust split that keeps yaac-shipped layers off that path.

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

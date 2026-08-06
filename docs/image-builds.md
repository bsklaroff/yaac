# Image builds

How yaac turns a Dockerfile into an image a session pod can pull. This is a
current-state reference for the shipped subsystem.

## The seam

`ImageBuilder` (`features/image-engine/builder.ts`) is the one interface
over "realize this image": build, mirror an upstream ref, ask whether a tag
is already realized, remove one, publish one. Two backends implement it.

| Backend | Where a build runs | Where the product lands |
|---|---|---|
| `cluster-pod` (default) | an ephemeral gVisor pod running the pinned podman-stable image | the registry — the pod's store dies with it |
| `host-podman` | `podman build` on the machine the server runs on | that machine's image store, published by a separate push |

`imageBuilderKind()` picks: `YAAC_IMAGE_BUILDER` overrides outright,
otherwise builder pods — except in a **nested** install (`YAAC_NESTED`),
whose engine is the session's own in-pod podman. Nested is not a preference
but the only correct answer there: an inner builder pod would be a vcluster
pod, unvalidated and strictly worse than the sandbox the inner server is
already running inside.

Everything yaac builds goes through the seam: the session image chain
(`base`/`tools`/`nestable`, `Dockerfile.yaac`, `Dockerfile.user`), netd's
image, the proxy's image, and the digest-pinned upstream mirrors.

Two things every caller has to know, because the backends differ in kind
and not only in speed:

- **`imageExists` answers "realized where THIS backend puts things."** For
  `cluster-pod` that is a registry HEAD; the host store is never consulted
  and a stale copy in it means nothing.
- **`publish` is a no-op for `cluster-pod`.** Its builds *are* registry
  pushes. A host build's product, by contrast, exists only locally until it
  is pushed.

### Why builder pods, and why podman in them

The server must be able to run as a pod (docs/plans/stock-k8s-multi-node.md
§1), and a pod has no host podman. That is the forcing reason; the
single-node payoffs are that concurrent chains no longer queue behind one
machine's global image-store lock, and that a build no longer executes
anything on the host at all.

The engine inside the pod is the podman CLI rather than a second build
engine, because yaac already shells out to `podman build` deliberately:
podman's Docker-compat endpoint writes Docker v2 manifests while the CLI
writes OCI ones, so layer digests — and therefore caches — do not carry
across. Adopting a second engine would reintroduce exactly that split at the
seam between the two builders. The cost accepted in exchange is that podman
has no BuildKit-style lock-free concurrency *within* one engine; per-build
pods sidestep it anyway, and the seam is what keeps swapping the engine a
change of backend rather than a rewrite.

### Bootstrap ordering

A builder needs a cluster; a cluster needs images. That is not a cycle,
because everything a builder pod needs is stood up from **digest-pinned
upstream images that node containerd pulls directly**:

- the main registry Deployment runs upstream `registry:2` — it cannot be
  the source of its own image;
- the gVisor installer DaemonSet runs upstream `curlimages/curl` — it
  cannot install the runtime through a pod that needs that runtime;
- a builder pod runs the mirrored `podman-stable` tag *if the registry
  already holds it*, and the upstream digest otherwise.

So `yaac cluster setup` installs the registry, the builder-role guard and
the gVisor runtime — none of which needs a yaac-built image — and only then
builds netd's image, in a pod. netd itself is not in the way: builder pods
get direct egress, not the redirect netd programs. The proxy image is built
the same way, later, from a server whose cluster is already up.

`ensureClusterBuilderHost` (`features/cluster/builder-host.ts`) is that
guarantee in code, and it is *injected* into the builder rather than
imported by it: `#features/image-engine` sits below `#features/cluster`
precisely because cluster setup builds an image, and an import the other way
puts the two features in a cycle (`pnpm modularity` checks it).

The one machine-scoped exception is the **e2e global setup**, which
prebuilds and mirrors through `host-podman` explicitly. It is not the
server: it runs on a developer machine that has podman by definition, and
prebuilding the whole chain through the sandbox would put its cold-build tax
on the critical path of every suite run. The products are identical bytes
either way — same CLI, same OCI manifests — so the choice is a scheduling
one, and it keeps the host backend exercised. It is passed as an argument,
never through `YAAC_IMAGE_BUILDER`, because the servers the suite spawns
inherit its environment and must run the default backend.

### Build context transfer

The context is **streamed into the pod** as a tar over `kubectl exec -i`,
honoring `.containerignore` exactly like `contextHash()` (plus the
Dockerfile itself, which podman reads outside the ignore rules).
`BUILDER_CONTEXT_MAX_BYTES` caps it; the contexts that exist are a
Dockerfile plus support files.

Mounting the data dir into the builder instead — practical once project
state is a PVC — would be faster for a large context and is deliberately not
done: it couples the builder to the storage layout, needs the volume to be
RWX and mountable by a sandboxed pod, and buys nothing on contexts this
size. Streaming assumes only an apiserver, which is the same thing every
other call already assumes.

## One pod per chain

A build request leases one builder pod and every layer of the chain builds
in it, in dependency order. That is what makes a cold chain cheap: layer
N+1's `FROM ${BASE_IMAGE}` resolves against the product layer N just built,
with no registry round-trip in between. Each layer still pushes its own
product as the last step of its build — the graphroot is scratch, so an
unpushed layer is a lost one.

It is also why the order matters: a pod that has executed an untrusted `RUN`
step must never go on to build a yaac-shipped layer. `resolveImageChain()`
emits the shipped layers first, each pushed before the next layer starts.

Per layer the flow is:

1. bootstrap `/etc/containers/storage.conf` for the native overlay driver
   on the tmpfs graphroot (the stock image forces fuse-overlayfs, which is
   broken under runsc) — once per pod;
2. materialize the parent: `podman pull` `<registry>/P` and retag to the
   bare tag `P` so `--build-arg BASE_IMAGE` semantics match, skipped when
   the pod already holds it (the common case in a chain);
3. stream the context in, then `podman build --isolation chroot` with the
   registry step cache. Chroot isolation is required: buildah's default OCI
   isolation breaks the `RUN`-step stdio relay under the sentry after tens
   of KB of output;
4. `podman push` the product — delta-only, since cross-repo blob mounting
   means the parent's blobs never re-upload;
5. delete the pod when the request ends, on success or failure; a
   background reconcile (`reconcileBuilderPodGc`) reaps leaks.

Pod spec: name `yaac-builder-<tag-hash8>-<rand>`, label `yaac.role: builder`
plus install labels, `runtimeClassName: gvisor` (chroot builds need no raw
sockets), the nested-engine cap set, `automountServiceAccountToken: false`,
seccomp RuntimeDefault, an explicit memory request well under its ~8Gi
limit, and `activeDeadlineSeconds` bounding the whole pod. The graphroot
lives on a disk-backed sentry-internal tmpfs (~16Gi) via the
`dev.gvisor.spec.mount.*` annotations — zero gofer RPCs on the build hot
path, and no cache GC to run. The entrypoint sleeps; the server drives it
with `kubectl exec` so build logs stream into the build-tracking registry
exactly like a piped host build's.

Every step is bounded by a pair of timeouts, run by the shared
`platform/streaming-proc.ts`:

- an **idle** timeout per exec step, the primary signal: the clock resets on
  every byte the step writes, and while the context tar streams in, on every
  byte accepted. A build has no honest *total* duration — a cold chain
  compiling a toolchain runs many times longer than a warm rebuild, and a
  total cap kills exactly those, mid-progress — whereas silence reliably
  means wedged, since podman emits a line per step, layer and progress tick;
- a **total** backstop for what idle cannot see: a build wedged but chatty
  (a `RUN` step retrying in a loop) never goes silent. In a pod that
  backstop is the pod's `activeDeadlineSeconds`; on the host backend it is
  `buildImage`'s own total budget.

Either expiry signals the child's whole process group — builds spawn
grandchildren that would otherwise keep the lock — and the failure is raised
as soon as the process is dead, without waiting for pipes a surviving
grandchild can hold open. A pod killed by its deadline shows up to the
caller only as a signalled `kubectl`, so that failure is annotated from the
pod's own status (`builderPodBlockReason`).

## Trust

Two Dockerfiles in the chain are user- and agent-editable — `Dockerfile.yaac`
(per project) and `Dockerfile.user` (per user) — and their `RUN` steps are
arbitrary code. Everything else (`Dockerfile.default`, `Dockerfile.tools`,
`Dockerfile.nestable`, netd, the proxy) is yaac-shipped content over pinned
upstreams.

Since every layer now builds inside a gVisor sandbox, that distinction no
longer decides *where* a build runs. What it still decides is **which step
cache a build may read**:

| Layers | Cache repo |
|---|---|
| `base`, `tools`, `nestable`, netd, proxy | `yaac-buildcache-shipped` — one per install, since these layers are identical across projects |
| `project`, `user`, any future name | `yaac-buildcache-project-<slug>` |

The whitelist cannot be faked: `resolveImageChain()` is the only producer of
`ImageLayerName`, and assigns `base`/`tools`/`nestable` exclusively to the
yaac-shipped Dockerfiles regardless of what a project's own file contains. A
future layer name lands in the project repo by default rather than sharing
the shipped layers' cache, and no project slug can be sanitized into the
shipped repo's name.

This is scoping, not a boundary — see the open risk below.

## The registry is the only image bus

The registry is an in-cluster `registry:2` Deployment behind a normal
ClusterIP Service, mirroring the per-project registries' topology (blobs on
an RWO PVC, a containerd `hosts.toml` per node holding the live ClusterIP so
the node can resolve a name cluster DNS never serves it). It
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
exception is the yaac SERVER when it runs outside the cluster: it reaches
the registry over a long-lived `kubectl port-forward` (the same mechanism
the stream relay uses). Blob storage is keyed by repository path, so the
bytes a push puts there are exactly what a node later pulls by the cluster
ref. `registryHasTag()` over that same forward is the skip check for every
build and mirror, so the common path (tag already present) never creates a
pod.

Upstream images yaac does not build — Envoy, `registry:2` for the
per-project registries, the vcluster image set, the cluster-check probe —
are **mirrored** into it under a tag carrying their pin, so a re-pin
re-mirrors and nodes pull them with no upstream egress. On the cluster
backend a mirror is a builder pod doing pull → arch check → tag → push; the
arch check runs against the *node's* architecture, which is the one that
matters, so a pin naming one platform's child manifest instead of the
multi-arch index fails at mirror time rather than as an `exec format error`
in whatever pod pulls it later.

### Collecting the step cache

Each Dockerfile edit mints fresh cache keys and strands the old ones, so the
cache repos need a sweep of their own (`reconcileBuildCacheGc`, every few
hours). It retires cache tags no build has written for one `--cache-ttl` —
already misses on the read side, so retirement costs no hit — and reads that
age off the tag link's mtime, which a cache hit refreshes when it re-pushes
the entry: retention is last-used, not first-built.

Like the per-project registries' collect (docs/nested-containers.md), the
sweep untags by removing the tag directory in the registry's own storage and
reclaims blobs with the registry binary's `garbage-collect
--delete-untagged` — the delete API answers 405 until the container is
recreated with `REGISTRY_STORAGE_DELETE_ENABLED`. That collect is global
rather than scoped to the cache repos, which makes one property of this
registry load-bearing: **nothing may live in it untagged or as an index.**
Blobs shared with a still-tagged image survive because the mark phase walks
that manifest, and the digest-pinned mirrors are stored as single-arch
children under tags of their own. A digest-only push, or a manifest list
whose children the mark phase never walks, would be collected out from under
its users.

What the sweep does not take is that collect's read-only maintenance window,
which is how the per-project one makes a live collect safe. Nothing prevents
it — this registry is a Deployment over a PVC too, so rolling it with the
read-only env costs a restart and no images — but adopting it is a behaviour
change of its own (every push and delete inside the window answers 405), so
it is a follow-up. Until then the two hazards of collecting
a live registry are handled directly:

- A push racing the collect can lose blobs between upload and manifest
  `PUT`, leaving an image that pulls broken forever — the `registryHasTag`
  skip means nothing re-pushes it. Three signals hold the collect off: an
  in-progress upload, any link file written in the last few minutes (a
  just-committed blob, a cross-repo mount, a just-PUT manifest — none of
  which leave an upload dir behind), and this server's own in-flight builds
  and pushes. The first two are read off the registry's filesystem, so they
  cover builder pods and e2e servers too, and both are re-read immediately
  before the collect, since the untag that precedes it takes time. A push
  that *starts* inside the collect is the one window left open; only the
  maintenance window would close it, so the collect is kept rare and short
  instead.
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

## A restart aborts every in-flight build

Podman commits an image tag only when the build finishes, so a build that
outlives its server is invisible to the successor's existence check: it
starts a second build of the same tag, and the two fight over the shared
layer cache and the image-store lock. Both backends therefore die with the
server.

- **Builder pods.** `reconcileBuilderPodGc` deletes any `yaac.role=builder`
  pod created before this process started (the data-dir lock admits one
  server per install, so an older pod can only belong to a dead one). The
  reconciler runs it ahead of the prewarm step on the boot pass, so the
  leaked pod's memory reservation is released before anything tries to
  schedule a replacement.
- **Host podman**, where it is what builds. `podman build`/`podman push`
  children run through `platform/container/host-procs.ts`, which SIGTERMs
  them from the shutdown handler and records each pid in
  `<data dir>/host-podman.json` first. A host pid carries no label to select
  on, so the file is what makes the crash path reapable:
  `reapOrphanedPodmanProcs` reads it once at boot, confirms via `ps` that the
  pid is still a podman invocation carrying the recorded tag (a pid-reuse
  guard), and terminates it — SIGTERM so podman releases the store lock,
  escalating to SIGKILL after a grace period.

The in-memory build registry that feeds the webapp's build list is *not*
persisted: with the build itself aborted there is no live work to reattach
to, and the next prewarm sweep re-derives what is missing.

The host image GC (`reconcileHostImageGc`) still runs, and is deliberately
not gated on the backend: a machine that builds in pods may still *have* a
host store that fills up — the e2e global setup prebuilds the whole chain
into one — and this sweep is the only thing that reclaims it. Where there is
no host engine at all, it finds no store and stands down.

## Open risk: builder-origin writes to the shared registry

Builder pods are the untrusted principal here, and they must be able to push
— so **an attacker-authored `RUN` step can write any `repo:tag` in the
shared registry**. It is unauthenticated `registry:2` with mutable tags and
no path ACLs, and the builder's egress is necessarily allow-all (builds
fetch upstream packages). Nothing network-level closes this: the ingress
lock above pins *which pods* may be callers, not *what a legitimate caller
may write*. The reachable blast radius is the whole store — the yaac-shipped
content-hash tags, other projects' final images, and any cache repo,
including `yaac-buildcache-shipped`.

Two consequences worth stating plainly:

- The separation of cache repos confines a poisoned entry only against a
  build that stays inside its own cache. It is **not** a boundary against a
  builder that writes another repo directly, which it can — including the
  shipped layers' cache, whose entries the session base image is built from.
- An overwritten tag is consumed: a builder pod pulls its parent fresh
  whenever it is not already local, and node containerd re-pulls once
  kubelet image GC has evicted a tag.

Closing this needs authentication or path scoping — a push-side proxy that
mints per-build, repo-scoped credentials is the obvious shape. Until then
the containment that does hold is the sentry around every `RUN` step, and
the fact that nothing in the build path executes on the host at all.

## Security hardening

- **Builder egress.** Builder pods are excluded from the world-deny
  NetworkPolicy and carry an explicit allow-all egress NetworkPolicy —
  strictly better than a host build's unfiltered host-network egress.
  Optionally routable through the session proxy later with the combined CA
  bundle (see docs/nested-containers.md), the same mechanism nested builds
  already use.
- **The `yaac.role=builder` label** (which carves builder pods out of the
  world-deny egress policy) is reserved by a cluster-wide
  ValidatingAdmissionPolicy (`yaac-builder-role-guard`): no ServiceAccount
  may create or update a pod carrying it — the only API identities untrusted
  code can hold — and carriers must run under the `gvisor` RuntimeClass.
  Applied fail-closed before any builder pod is created, and by
  `yaac cluster setup`.

## Cost

Building under runsc is dominated by `RUN`-step process creation under the
systrap platform (~9ms/spawn, ~8x host), which no engine choice, kind
topology, or (on hosts without `/dev/kvm`) KVM platform can move — apt/dpkg
maintainer scripts that spawn hundreds of processes pay it in full, and a
cold chain built entirely in a pod runs ~3x a host build. That is the price
of the server not being a machine with an engine on it, and it is paid on
first install, on a Dockerfile edit, and on `yaac project rebuild` — not on
a session create, which finds its content-hash tag already in the registry.
Partly offsetting it: builds no longer serialize behind one machine's global
image-store lock.

## Open items

- **Registry-side generation GC** — image repos and cache repos accumulate
  generations in the registry with no host-store sweep to catch them. Size
  the `--cache-ttl` bound (currently 168h) and the GC cadence against
  observed growth.
- **zstd for in-pod pushes.** Host-side trusted pushes used
  `--compression-format zstd`, which roughly halved an empty-graphroot
  parent pull (65.6s → 40.4s measured). Now that every parent pull is a
  builder pod's, the same flag belongs on the in-pod push; it is not there
  yet.
- **Setup-time platform probe** — the runsc KVM platform, where `/dev/kvm`
  is available, would cut the RUN-step tax that systrap pays; systrap stays
  the portable fallback for kind nodes without it.
- **BuildKit** was measured ~12s/build faster than podman under runsc
  (lighter snapshot/commit), but needs a runc 1.1 pin against current gVisor
  and a second engine's cache/GC/log semantics; podman's chroot isolation
  needs no OCI runtime in the RUN path at all. The seam is where it would
  land if that per-build delta, or many-projects-one-builder, ever starts to
  matter.

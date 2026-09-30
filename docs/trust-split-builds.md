# Trust-split image builds

How yaac keeps untrusted Dockerfile execution inside a sandbox. This is a
current-state reference for the shipped subsystem.

## The problem

Building an image shells out to rootful podman. Dockerfile `RUN` steps
execute arbitrary code, and two Dockerfiles in the build chain are
user/agent-editable:

- `Dockerfile.yaac` — the per-project Dockerfile (layered or standalone).
- `Dockerfile.user` — the per-user Dockerfile (`~/.yaac/Dockerfile.user`).

A malicious or compromised step in either would get root-adjacent code
execution wherever it ran. Everything else in the chain
(`Dockerfile.default`, `Dockerfile.tools`, `Dockerfile.nestable`) is
yaac-shipped content over pinned upstreams — the same trust tier as the
node/registry podman that manages the cluster itself.

## The split

Build routing is per layer, by trust, keyed on `ImageLayer.name` from
`resolveImageChain()`:

| Layers | Trust | Where it is realized |
|---|---|---|
| `base`, `tools`, `nestable` (yaac-shipped, pinned upstreams) | trusted | `yaac cluster install`, on the machine running the CLI |
| `project` (`Dockerfile.yaac`), `user` (`Dockerfile.user`) | untrusted (user/agent-editable) | ephemeral runsc builder pod, driven by the server |

Routing is a **whitelist** and is not configurable. Only the exact names
`base`, `tools`, `nestable` come prebuilt; every other name — including
any future layer — is sandboxed by default. The trusted names cannot be
faked: `resolveImageChain()` is their only producer and assigns them
exclusively to the yaac-shipped Dockerfiles, regardless of file content.
Untrusted layers build against their prebuilt, registry-resident parent,
so the sandbox only ever executes the untrusted suffix of a chain.

The untrusted layers live in repos of their project's own, named by its
immutable id — `yaac-proj-<id>` and `yaac-user-<id>` — never beside the
trusted chain or another project's, so a project re-added under a freed
slug resolves none of the old one's tags. The main registry's GC removes a
project repo whose id no live project holds.

**The server builds no trusted layer.** It resolves each one from the
in-cluster registry by content-hash tag, and a missing tag is an
actionable "run `yaac cluster install`" rather than a build trigger. That
is what lets a server run with no container engine at all — every image
yaac ships (these three plus the egress proxy, netd, and the digest-pinned
upstream mirrors) is produced on the CLI machine and pushed, and the
registry is the only bus between the two.

## Why sandbox only the untrusted layers

The dominant cost of building under runsc is `RUN`-step process creation
under the systrap platform (~9ms/spawn, ~8x host), which no engine choice,
kind topology, or (on hosts without `/dev/kvm`) KVM platform can move —
apt/dpkg maintainer scripts that spawn hundreds of processes pay it in
full, so sandboxing a whole chain runs ~3x slower cold. Most of that cost
is the big *trusted* layers, which carry no untrusted code, so the split
sandboxes only the untrusted suffix.

The trust split cuts along the threat model: trusted layers keep native
build-machine speed, and only the small untrusted suffix pays the sandbox
tax. That
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
   `.containerignore` exactly like `contextHash()`, and write the layer's
   registry write grant (see "The write gate") as an authfile over stdin.
   Then `podman build
   --isolation chroot` with per-project `--cache-from`/`--cache-to` and a
   `--cache-ttl` bound — otherwise identical CLI semantics to a host build.
   Chroot isolation is required: buildah's default OCI isolation breaks
   the `RUN`-step stdio relay under the sentry after tens of KB of output.
4. `podman push` `T` back to the registry — delta-only (cross-repo blob
   mounting means parent blobs never re-upload).
5. Delete the pod on success or failure; a background reconcile
   (`reconcileBuilderPodGc`) reaps any leaked `yaac.role=builder` pods.

Every build — in a pod or on the install machine's engine — is bounded by
a pair of timeouts, run by the shared
`drivers/k8s/container/streaming-proc.ts`:

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
  the pod's `activeDeadlineSeconds`; on the install machine it is
  `buildImage`'s own total budget, which is shorter — install only ever
  builds yaac-shipped layers over pinned upstreams.

Either expiry signals the child's whole process group — builds spawn
grandchildren that would otherwise keep the lock — and the failure is
raised as soon as the process is dead, without waiting for pipes a
surviving grandchild can hold open. A pod killed by its deadline shows up
to the caller only as a signalled `kubectl`, so that failure is annotated
from the pod's own status (`builderPodBlockReason`).

## The registry is the only image bus

The registry is an in-cluster `registry:2` Deployment behind a normal
ClusterIP Service, mirroring the per-project registries' topology (blobs on
an RWO claim, a containerd `hosts.toml` per node holding the live ClusterIP
so the node can resolve a name cluster DNS never serves it). It sits in the
*default* install namespace rather than the per-run one, so concurrent e2e
namespaces share one image store. Writes pass a gate in front of it (see
"The write gate" below).

Its ingress is locked to its three caller classes: the node (an `ipBlock` —
containerd pulls, the kubelet probe, and a host process's port-forward all
arrive from the host netns, which plain NetworkPolicy cannot name any other
way), `yaac.role=builder` pods in any namespace, and the server's own pods.
The lock pins *which pods* may be callers, not *what a caller may write*;
the gate does that.

Every party addresses it the same way — by its Service FQDN
(`yaac-registry.<default-ns>.svc.cluster.local:5000`), which is the prefix
every yaac image ref carries. Builder pods pull parents from it and push
products back; workspace pods pull final images from it unchanged; the
in-cluster server dials the same name for its HEADs. The one exception is a
host process — `yaac cluster install`, `cluster check`, the e2e global setup
— which has no route into the pod network: it reaches the registry over a
long-lived `kubectl port-forward` and pushes through that loopback port.
Blob storage is keyed by repository path, so the bytes a push puts there are
exactly what a node later pulls by the cluster ref. `registryHasTag()`, a
HEAD, stays the server-side skip check, so the common path (tag already
present) never creates a pod.

The registry holds two things per untrusted build:

- **Final images** — pushed delta-only via cross-repo blob mounts.
- **Per-step cache images** — `--cache-from`/`--cache-to` on every builder
  build restore the instruction-prefix caching that a persistent host
  store would give: an edited `Dockerfile.yaac` re-runs only its changed
  steps, in any fresh pod. Cache repos are **per project**
  (`yaac-buildcache-<id>`, by project id): cache entries are consumed by key with no
  provenance check, so per-project scoping confines a poisoned entry to
  the project whose image the attacker already controls. The build's write
  grant names only its own project's cache repo, so the scoping holds
  against a hostile `RUN` step too. `--cache-ttl` bounds reads.

### Collecting the step cache

Each Dockerfile edit mints fresh cache keys and strands the old ones, so
the cache repos need a sweep of their own (the main registry's GC,
docs/image-gc.md, every few hours). It retires cache tags no build has
written for one `--cache-ttl` — already misses on the read side, so
retirement costs no hit — and reads that age off the tag link's mtime, which a cache hit
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
  pushing side and roughly halves the empty-graphroot pod pull (the remainder
  is layer extraction, not decompression). Workspace pods pull the same
  manifests, so node containerd zstd support was confirmed before this
  shipped.
- The pull is paid once per pod, and the common no-op path never creates
  a pod.

If parent-pull latency ever dominates real usage, the escalation is a
per-node image cache seeded ahead of the pod. It is deliberately not
built: it adds a node-local store, its GC, and version pinning across
build machine and pod to save the pull on a rare, prewarm-hidden path.

## An interrupted run never leaves a build behind it

Podman commits an image tag only when the build finishes, so a build that
outlives the process that started it is invisible to the successor's
existence check: it starts a second build of the same tag, and the two
fight over the shared layer cache and the image-store lock. Both halves of
the split are swept, each by whatever restarts around it.

- **Builder pods.** `reconcileBuilderPodGc` deletes any
  `yaac.role=builder` pod created before this process started (the
  data-dir lock admits one server per install, so an older pod can only
  belong to a dead one). The reconciler runs it ahead of the prewarm
  step on the boot pass, so the leaked pod's memory reservation is
  released before anything tries to schedule a replacement.
- **Host podman.** `podman build`/`podman push` children — all of them
  inside `yaac cluster install` — run through
  `drivers/k8s/container/host-procs.ts`, which records each pid in
  `<data dir>/host-podman.json` before it can be orphaned. A host pid
  carries no label to select on, so the file is what makes an interrupted
  install reapable: the next install reads it first, confirms via `ps`
  that the pid is still a podman invocation carrying the recorded tag (a
  pid-reuse guard), and terminates it — SIGTERM so podman releases the
  store lock, escalating to SIGKILL after a grace period — before it
  decides which tags are missing.

The in-memory build registry that feeds the webapp's build list is *not*
persisted: with the build itself aborted there is no live work to
reattach to, and the next prewarm sweep re-derives what is missing.

## Server wiring

- The production side lives in `drivers/k8s/install`, a folder no `src/`
  module may import (an eslint zone enforces it). Each shipped image's
  *identity* — its digest pin, or the content-hash tag its build context
  hashes to — stays in `drivers/k8s/cluster` beside the lookup the server
  does, because both halves need the same name for the same bytes; what
  the install folder owns is the production, which only the CLI performs.
- A `BuildEngine` seam (`drivers/k8s/images/build-engine.ts`,
  `engineForLayer` keyed on `ImageLayer.name`): `prebuilt` looks the tag
  up in the registry and refuses to build; `cluster-pod`
  (`drivers/k8s/images/builder-pod.ts`) drives the builder pod. Push is
  deliberately not routed per layer — a cluster-pod build's delta push is
  an inseparable build step, and a prebuilt layer was pushed by the
  install that built it. The coordinator, content-hash tags,
  `resolveImageChain()`, prewarm, and the build-tracking UI are untouched.
- Existence checks go to `registryHasTag()` for every layer: the registry
  is what a pod pulls from, and on an in-cluster server the host store is
  not even reachable. The install machine's own store is a build cache
  only, swept by `gcHostImages` at the end of each install — all but the
  e2e suite's `yaac-test-*` repos, which a concurrent test run on the same
  engine may be building or pushing. The suite reclaims those itself: its
  global setup ends with `gcTestImages()`, or, where several test rigs
  share one engine (`YAAC_TEST_SHARED_ENGINE=1`), the host runs
  `pnpm gc:test-images` while every rig is idle.
- Untrusted-layer builds require a healthy cluster: a chain reaching
  `Dockerfile.yaac`/`Dockerfile.user` errors with a pointer to `yaac cluster
  check` when there isn't one.

## The write gate

Builder pods are the untrusted principal here, and they must be able to
push — so the registry cannot tell a hostile `RUN` step from the build it
runs in by network position. What it checks instead is a **grant**. The
registry pod runs `registry:2` on its loopback (`127.0.0.1:5001`) and an
Envoy container on the Service port, whose Lua filter (the cluster
folder's `registry-gate.ts`) is the only way in:

- `GET` and `HEAD` pass untouched, so node containerd, the kubelet, every
  pull and every `registryHasTag()` stay anonymous.
- Every other method needs a grant, presented as a Basic credential: a
  payload `v1|<expiry>|<scope>` and an RSA-SHA256 signature over it. The
  gate verifies it against the public key rendered into its ConfigMap,
  checks the expiry, and requires the repository in the path to be in the
  scope — `*`, or an exact list of repo names. The repository is read the
  way distribution routes it, as everything before a write route's tail
  (`/manifests/<ref>`, `/blobs/uploads/<id>`), since `blobs` is a legal
  name component; a write of any other shape names no repo and is refused. A bad or missing grant is
  `401`, an out-of-scope repo `403`. A cross-repo mount is checked against
  its destination only; the source is readable anyway.
- `DELETE` is refused for every grant: this registry never deletes over the
  API (its GC works on storage).
- A bare `/v2/` without credentials is answered `401` with a Basic
  challenge. podman (containers/image) attaches the credentials it holds
  only to a registry that asked for them; containerd never requests `/v2/`
  itself, and an anonymous podman pull then sends an empty credential that
  a read never checks.
- A script error refuses the request: Envoy's Lua filter otherwise passes a
  request whose script raised, so the gate runs under `pcall`. The script
  runs for real in the unit suite, under fengari with a stub `handle`.
- Paths reach the filter normalized — dot segments resolved, slashes
  merged, escaped slashes rejected — so the repo it checks is the repo the
  registry writes.

The key is one RSA-2048 keypair per cluster, the Secret
`yaac-registry-grant-key`, created by whichever caller needs it first (in
practice `ensureMainRegistry` on install) with a `create` so two racing
creators converge on one key. It sits in a namespace of its own,
`yaac-registry-keys`, not the registry's: that is also the default install
namespace, where the egress proxy's Role reads every Secret, and the proxy
parses untrusted traffic. So only cluster-wide readers reach it — the host
CLI by its kubeconfig and the in-cluster server by its ClusterRole — and
nothing mounts or copies it. The gate holds only the public half:
compromising the registry pod mints nothing, and that pod was already all
of the registry.

Two kinds of grant are minted (`#drivers/k8s/container`, registry-grant.ts):

- **Admin (`*`)**, one hour, for every host push (`pushImageToRegistry`,
  as a private temp `--authfile`, never argv, where any local `ps` would
  read it): install's builtin images and mirrors, `cluster
  check`'s probe image, the e2e global setup. Those are the trusted
  writers; the in-cluster server pushes nothing itself.
- **Per layer**, for a builder pod: the layer's own repo and the project's
  `yaac-buildcache-<id>`, valid until the pod's own deadline plus a minute.
  It is written into the pod as an authfile over exec stdin before each
  layer's build, and `podman build` (for `--cache-to`) and `podman push`
  are given `--authfile`. The build's `RUN` steps may be able to read it
  — a root chroot is not a boundary — and that is accepted: it writes only
  repos that project's own Dockerfiles already control.

What this buys: the trusted chain (`yaac-base`/`yaac-tools`/`yaac-nestable`),
every digest-pinned mirror (including the images that privileged and node
pods boot), the proxy, netd, the server image, and every other project's
images and step cache are out of a builder's reach. The digest in a mirror
tag's name is still a label nothing checks; it is the gate that keeps the
bytes under it the ones install pushed.

A registry rolled by an install that predates the gate accepts anonymous
writes while answering every read, so `cluster check`'s registry step
starts an anonymous upload and fails when it is not refused. Re-running
`yaac cluster install` rolls the Deployment (`Recreate`, so pulls fail for
the seconds that takes); the template carries a hash of the gate config, so
a new key or gate rolls it too.

## Security hardening

- **Builder egress.** Builder pods are excluded from the world-deny
  NetworkPolicy and carry an egress NetworkPolicy that admits everywhere
  except the kind fronting's node port, where a `RUN` step would reach the
  server as its owner (docs/server-in-cluster.md "The ingress policy is the
  wall") — strictly better than a host build's unfiltered host-network
  egress. Optionally routable through the workspace proxy later
  with the combined CA bundle (see docs/nested-containers.md), the same
  mechanism nested builds already use.
- **The `yaac.role=builder` label** (which carves builder pods out of the
  world-deny egress policy) is reserved by a cluster-wide
  ValidatingAdmissionPolicy (`yaac-builder-role-guard`): only a server's
  in-cluster identity — a ServiceAccount named `yaac-server`, in any
  namespace — may create or update a pod carrying it, and carriers must
  run under the `gvisor` RuntimeClass. The server creates every builder
  pod, so admitting that identity shape denies both the other
  ServiceAccounts — the identity class untrusted code can hold — and cert
  users such as a cluster operator. The shape rather than one install's
  exact username because the policy is cluster-scoped under a fixed name
  and re-applied by every install sharing the cluster (each e2e file is
  one), so its text must be install-agnostic; untrusted code holds no API
  identity at all, so it can neither act as nor mint a `yaac-server`
  ServiceAccount. Applied fail-closed before any builder pod is created,
  and by `yaac cluster install`.

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

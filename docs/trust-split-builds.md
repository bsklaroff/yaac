# Trust-split image builds

How yaac keeps untrusted Dockerfile code inside a sandbox when it builds
workspace images on the Kubernetes backend.

## The problem

Dockerfile `RUN` steps execute arbitrary code, and two Dockerfiles in the
image chain can be edited by a user or an agent:

- `Dockerfile.yaac`, the per-project Dockerfile (layered or standalone);
- `Dockerfile.user`, each user's own Dockerfile
  (`server-local/users/<user id>/build/`), which tops the image of every
  project that user owns.

A hostile step in either would get root-level code execution wherever it
ran. The rest of the chain (`Dockerfile.default`, `Dockerfile.tools`,
`Dockerfile.nestable`) is yaac's own content over pinned upstream images,
as trusted as the tooling that manages the cluster.

## The split

Each layer is routed by trust, keyed on `ImageLayer.name` from
`resolveImageChain()`:

| Layers | Trust | Built by |
|---|---|---|
| `base`, `tools`, `nestable` | trusted | `yaac cluster install`, on the machine running the CLI |
| `project` (`Dockerfile.yaac`), `user` (`Dockerfile.user`) | untrusted | a short-lived gVisor builder pod, driven by the server |

Routing is an allowlist and cannot be configured. Only the exact names
`base`, `tools` and `nestable` are prebuilt; any other name, including a
future one, is sandboxed. The trusted names cannot be faked:
`resolveImageChain()` is their only producer, and it assigns them to the
yaac-shipped Dockerfiles regardless of file content. An untrusted layer
builds on its prebuilt parent from the registry, so the sandbox only runs
the untrusted end of the chain.

Untrusted layers go into repos named by the project's immutable id,
`yaac-proj-<id>` and `yaac-user-<id>`, never next to the trusted chain or
another project's repos. A project has one owner, so `yaac-user-<id>` is
always built from that owner's `Dockerfile.user`; two users' files never
meet in one repo. Ids are never reused, so a project added again
sees none of the old project's tags. The main registry's GC removes project
repos whose id no live project holds (docs/image-gc.md).

**The server builds no trusted layer.** It looks each one up in the
in-cluster registry by content-hash tag. A missing tag produces an error
telling the user to run `yaac cluster install`, not a build. This is what
lets the server run with no container engine: every image yaac ships
(these three, the egress proxy, netd, and the digest-pinned upstream
mirrors) is built on the CLI machine and pushed to the registry.

## Why only the untrusted layers are sandboxed

Under gVisor (runsc), process creation in `RUN` steps costs about 9ms per
spawn on the systrap platform, roughly 8x the host, so sandboxing a whole
chain runs about 3x slower cold. Most of that cost is in the large trusted
layers, which run no untrusted code. Sandboxing only the untrusted end
brings a full cold chain to about 1.35x host time. The common path, where
the tag is already in the registry, starts no pod at all.

## Builder pods

The server creates one pod per untrusted build request. The build
coordinator already deduplicates builds per content-hash tag. When a chain
has both `project` and `user` layers, they share one pod, since the second
layer's parent is already local.

Pod spec (`drivers/k8s/images/builder-pod.ts`):

- Name `yaac-builder-<tag-hash8>-<rand>`, label `yaac.role: builder` plus
  install labels, in the yaac namespace. Image: the mirrored, digest-pinned
  `quay.io/podman/stable`.
- `runtimeClassName: gvisor` (chroot isolation needs no raw sockets),
  `NESTED_ENGINE_CAPS`, `automountServiceAccountToken: false`, seccomp
  `RuntimeDefault`, an 8Gi memory limit, and `activeDeadlineSeconds`
  bounding the pod's whole life.
- Graphroot `/var/lib/containers` on a disk-backed tmpfs inside the gVisor
  sentry (16Gi cap), set up by the `dev.gvisor.spec.mount.*` annotations.
  Scratch that dies with the pod: no gofer I/O and nothing to GC.
- The entrypoint sleeps; the server drives the pod with `kubectl exec` and
  streams the logs into the build list.

Build flow, for a layer tag `T` with parent tag `P`:

1. Write `/etc/containers/storage.conf` to use the native overlay driver on
   the tmpfs graphroot. The stock image uses fuse-overlayfs, which does not
   work under gVisor.
2. Pull `<registry>/P` and retag it as the bare tag `P`, so
   `--build-arg BASE_IMAGE=P` behaves as in a local build. A standalone
   `Dockerfile.yaac` has no yaac parent; its upstream `FROM` is pulled
   over the pod's network.
3. Stream the build context in as a tar over `exec -i`, honoring
   `.containerignore` exactly as `contextHash()` does, and write the
   layer's registry write grant (see "The write gate") as an authfile over
   stdin. Then run `podman build --isolation chroot` with per-project
   `--cache-from`/`--cache-to` and a `--cache-ttl` bound. Chroot isolation
   is required: under buildah's default OCI isolation, gVisor breaks the
   `RUN` step's output relay after tens of KB.
4. `podman push` `T` to the registry. Only new layers upload; cross-repo
   blob mounts reuse the parent's blobs.
5. Delete the pod whether the build succeeded or failed. A pod leaked by
   a server that died mid-build is deleted when the next server starts
   (`deleteLeakedBuilderPods`).

### Timeouts

Every build, in a pod or on the install machine, has two timeouts,
enforced by `drivers/k8s/container/streaming-proc.ts`:

- An **idle** timeout per exec step, reset on every byte of output. This
  is the main signal: podman prints constantly, so silence means stuck,
  while a total cap would kill long but healthy cold builds.
- A **total** backstop for a build stuck in a noisy loop, which would
  otherwise hold the image store lock forever. In a pod this is
  `activeDeadlineSeconds`; on the install machine it is `buildImage`'s
  shorter budget.

Either one kills the child's whole process group, since grandchildren
would otherwise keep holding the lock. A pod killed by its deadline looks
like a signalled `kubectl`, so `builderPodBlockReason` adds the reason from
the pod's status.

## The registry

The main registry is an in-cluster `registry:2` Deployment behind a
ClusterIP Service, set up like the per-project registries
(docs/nested-containers.md): blobs on an RWO claim, and a containerd
`hosts.toml` on each node mapping its name to the live ClusterIP, because
nodes do not use cluster DNS. It lives in the default install namespace
rather than a per-run one, so concurrent e2e namespaces share one image
store. Writes pass through the write gate (below).

Its ingress policy admits three kinds of caller:

- the node, as an `ipBlock` (containerd pulls, the kubelet probe, and host
  processes' `kubectl port-forward` all arrive from the host network);
- `yaac.role=builder` pods, in any namespace;
- the server's own pods.

The policy decides who may call; the gate decides what a caller may write.

Every image ref carries the Service's FQDN
(`yaac-registry.<default-ns>.svc.cluster.local:5000`), and every pod and
the in-cluster server dial that name. Host processes (`yaac cluster
install`, `cluster check`, the e2e global setup) have no route into the pod
network and push through a `kubectl port-forward` instead; blobs are
stored by repository path, so the result is the same image. A HEAD request,
`registryHasTag()`, is what skips a build whose tag already exists.

For each untrusted build the registry holds:

- **Final images**, pushed with cross-repo blob mounts so only new layers
  upload.
- **Per-step cache images.** `--cache-from`/`--cache-to` give a fresh pod
  the same step caching a persistent local store would: an edited
  `Dockerfile.yaac` re-runs only the changed steps. Cache repos are per
  project (`yaac-buildcache-<id>`), because cache entries are used by key
  with no check of where they came from. Scoping them per project limits a
  poisoned entry to the project whose image the attacker already controls.
  A build's write grant names only its own project's cache repo, so a
  hostile `RUN` step cannot break that scoping. `--cache-ttl` (168h)
  bounds how old an entry a read will use.

### Collecting the step cache

Each Dockerfile edit creates new cache keys and strands the old ones, so
the main registry's GC (docs/image-gc.md, every few hours) retires cache
tags no build has written for one `--cache-ttl`. Reads already miss on
those, so retiring them loses no hits. The age comes from the tag link's
mtime, which a cache hit refreshes when it re-pushes the entry, so
retention is by last use, not first build.

The GC untags by deleting the tag directory in the registry's storage and
reclaims blobs with `registry garbage-collect --delete-untagged`, the same
approach as the per-project registries. The collect is global, not limited
to cache repos, so **nothing in this registry may be stored untagged or as
a manifest list.** Blobs shared with a tagged image survive because the
mark phase walks that manifest, and the digest-pinned mirrors are stored
as single-arch images under tags of their own. A digest-only push or a
manifest list would be collected out from under its users.

Unlike the per-project collect, this one takes no read-only maintenance
window (adopting one is a possible follow-up). It handles the two hazards
of collecting a live registry directly:

- **A push racing the collect** can lose blobs between upload and manifest
  `PUT`, leaving an image that never pulls and that the `registryHasTag`
  skip never re-pushes. The collect waits while there is an upload in
  progress, any link file written in the last few minutes, or an
  in-flight build in this server. The first two are read from the
  registry's filesystem, so they also see builder pods and e2e servers,
  and are re-checked just before the collect. A push that starts during
  the collect is still possible, so the collect is kept rare and short.
- **Stale blob descriptors.** registry:2 caches them in memory by
  default, so after a collect a re-pushed digest would write a link with no
  blob and the tag would 404 permanently. The main registry runs with that
  cache turned off (`REGISTRY_STORAGE_CACHE_BLOBDESCRIPTOR` set empty), so
  every lookup reads the storage the collect just changed.

The pass runs detached and never overlaps itself, because reconcile passes
run one at a time and a collect takes minutes.

## Parent pull

A fresh pod must pull its parent before any step, cached or not, can run,
because `FROM ${BASE_IMAGE}` resolves against the local store. Step caching
cannot remove this, so it is kept small:

- Trusted layers are pushed with `--compression-format zstd`, which roughly
  halves a pod's parent pull into an empty graphroot (most of the rest is
  layer extraction). Workspace pods pull the same manifests, and node
  containerd supports zstd.
- The pull happens once per pod, and the common no-op path creates no pod.

A per-node image cache seeded ahead of the pod would remove the pull, but
it would add a store, its GC and version pinning to save time on a rare
path that prewarming already hides, so it is not built.

## Interrupted builds are cleaned up

Podman commits a tag only when a build finishes, so a build that outlives
its starter is invisible to the next process, which starts a second build
of the same tag that then fights the first over the image store lock. Both
halves of the split clean up after an interrupted run:

- **Builder pods.** The k8s driver's start deletes every
  `yaac.role=builder` pod of the install (`deleteLeakedBuilderPods`). The
  data-dir lock allows one server per install, so any builder pod then
  belongs to a dead server, and its memory reservation is freed before the
  first build is scheduled. A pod leaked later is bounded by its
  `activeDeadlineSeconds`.
- **Host podman.** `yaac cluster install` runs its `podman build` and
  `podman push` children through `drivers/k8s/container/host-procs.ts`,
  which records each pid in `<data dir>/host-podman.json`. The next install
  reads that file first, confirms with `ps` that each pid is still a podman
  process for the recorded tag (to guard against pid reuse), and stops it
  (SIGTERM so podman releases the store lock, then SIGKILL after a grace
  period) before deciding which tags are missing.

The webapp's in-memory build list is not persisted: the build is gone, and
the next prewarm sweep recomputes what is missing.

## Server wiring

- Image production lives in `drivers/k8s/install`, which no `src/` module
  may import (an eslint zone enforces this). Each shipped image's identity
  (its digest pin, or the content-hash tag of its build context) lives in
  `drivers/k8s/cluster` next to the server's lookup, because both sides
  must agree on the name for the same bytes. The install folder owns only
  the building, which only the CLI does.
- The build coordinator (`drivers/k8s/images/build-coordinator.ts`)
  routes each missing layer by `ImageLayer.name`: a trusted layer is
  refused with a pointer to `yaac cluster install`, and any other layer
  drives a builder pod (`builder-pod.ts`). There is no separate push: a
  builder pod's push is part of its build, and a trusted layer was pushed
  by the install that built it.
- Every layer's existence check is `registryHasTag()`, because the
  registry is what pods pull from and an in-cluster server cannot see the
  install machine's local store. That local store is only a build cache,
  swept by `gcHostImages` at the end of each install. The sweep skips the
  e2e suite's `yaac-test-*` repos, which a concurrent test run may be
  using; the suite cleans those itself (`gcTestImages`, or `pnpm
  gc:test-images` on hosts that set `YAAC_TEST_SHARED_ENGINE=1`).
- Untrusted-layer builds need a healthy cluster. Without one, a chain that
  reaches `Dockerfile.yaac` or `Dockerfile.user` fails with a pointer to
  `yaac cluster check`.

## The write gate

Builder pods are untrusted and must be able to push, so the registry cannot
tell a hostile `RUN` step from its build by network position. It checks a
signed **grant** instead. The registry pod runs `registry:2` on its
loopback (`127.0.0.1:5001`) and an Envoy container on the Service port.
Envoy's Lua filter (`registry-gate.ts` in the cluster folder) is the only
way in:

- `GET` and `HEAD` pass through untouched, so containerd, the kubelet,
  every pull and every `registryHasTag()` stay anonymous.
- Every other method needs a grant, sent as a Basic credential: a payload
  `v1|<expiry>|<scope>` plus an RSA-SHA256 signature. The gate verifies it
  against the public key in its ConfigMap, checks the expiry, and requires
  the repository in the path to be in the scope (`*`, or an exact list of
  repo names). The repository is read the way the registry routes it:
  everything before a write route's tail (`/manifests/<ref>`,
  `/blobs/uploads/<id>`), since `blobs` is a legal name component. A write
  of any other shape names no repo and is refused. A bad or missing grant
  gets `401`; a repo outside the scope gets `403`. A cross-repo mount is
  checked against its destination only, since the source is readable
  anyway.
- `DELETE` is refused for every grant. This registry never deletes over
  the API; its GC works on storage directly.
- A bare `/v2/` without credentials gets a `401` Basic challenge, because
  podman only sends credentials to a registry that asks. containerd never
  requests `/v2/`, and reads ignore the empty credential an anonymous pull
  then sends.
- A script error refuses the request (the gate runs under `pcall`, since
  Envoy would otherwise pass it). The unit suite runs the real script
  under fengari.
- Paths arrive normalized (dot segments resolved, slashes merged, escaped
  slashes rejected), so the repo the gate checks is the repo the registry
  writes.

The signing key is one RSA-2048 keypair per cluster, in the Secret
`yaac-registry-grant-key`, created with `create` by whichever caller needs
it first (in practice `ensureMainRegistry` during install) so racing
creators converge on one key. It lives in its own namespace,
`yaac-registry-keys`, because the registry's namespace is also where the
egress proxy, which parses untrusted traffic, can read every Secret. Only
the host CLI (by kubeconfig) and the in-cluster server (by its
ClusterRole) can read it. The gate holds only the public key, so
compromising the registry pod mints nothing.

Two kinds of grant are minted (`registry-grant.ts` in
`#drivers/k8s/container`):

- **Admin (`*`)**, valid one hour, for every host push
  (`pushImageToRegistry`: install, `cluster check`'s probe, the e2e global
  setup), passed as a private temp `--authfile` so `ps` never shows it.
  The in-cluster server pushes nothing itself.
- **Per layer**, for a builder pod: the layer's own repo and the project's
  `yaac-buildcache-<id>`, valid until the pod's deadline plus a minute,
  written into the pod as an authfile before each layer's build. `RUN`
  steps may be able to read it (a root chroot is no boundary), which is
  accepted: it only writes repos the project's Dockerfiles already
  control.

As a result, a builder cannot write the trusted chain
(`yaac-base`/`yaac-tools`/`yaac-nestable`), any digest-pinned mirror
(including images that privileged and node pods boot), the proxy, netd,
the server image, or any other project's images and step cache. Nothing
verifies the digest in a mirror's tag name; the gate is what keeps the
bytes under it the ones install pushed.

`yaac cluster check` starts an anonymous upload and fails if the registry
accepts it, which catches a registry deployed without the gate. Re-running
`yaac cluster install` rolls the Deployment (`Recreate`, so pulls fail for
a few seconds). The pod template carries a hash of the gate config, so a
new key or gate also triggers a roll.

## Security hardening

- **Builder egress.** Builder pods are excluded from the world-deny
  NetworkPolicy and get their own egress policy, `yaac-builder-egress`,
  which allows everything except the kind fronting's node port. From there
  a `RUN` step could reach the server with its owner's authority
  (docs/server-in-cluster.md "The ingress policy is the wall"). That is
  still stricter than a local build's unfiltered host network. Builds
  could later be routed through the workspace proxy using the combined CA
  bundle (docs/nested-containers.md), as nested builds already are.
- **The `yaac.role=builder` label** exempts a pod from the world-deny
  policy, so a cluster-wide ValidatingAdmissionPolicy
  (`yaac-builder-role-guard`) reserves it. Only a ServiceAccount named
  `yaac-server`, in any namespace, may create or update a pod carrying the
  label, and such pods must use the `gvisor` RuntimeClass. It matches that
  name rather than one install's username because every install sharing
  the cluster (each e2e file is one) re-applies the same cluster-scoped
  policy. Untrusted code holds no API identity, so it cannot act as or
  create a `yaac-server` ServiceAccount. `yaac cluster install` applies the
  policy, as does the server before creating any builder pod, and it
  denies when it cannot evaluate (`failurePolicy: Fail`).

## Open items

- **Build cache sizing.** Size the `--cache-ttl` bound (168h) and the GC
  interval against observed cache-repo growth.
- **Platform probe at setup.** Where `/dev/kvm` is available, the runsc KVM
  platform would cut the `RUN`-step cost that systrap pays. systrap stays
  the fallback for kind nodes without it.
- **BuildKit** measured about 12s per build faster than podman under runsc
  (lighter snapshot and commit), but needs a runc 1.1 pin against current
  gVisor and brings a second engine's cache, GC and log behavior. podman's
  chroot isolation needs no OCI runtime in the `RUN` path at all. Revisit
  only if that difference starts to matter.

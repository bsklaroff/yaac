# Image builds

How yaac builds workspace images on the Kubernetes backend: a project's
named images and a user's own, their revisions and builds, the sandboxed
BuildKit pods that run untrusted Dockerfiles, and the registry gate and
egress path that keep one project's build from reaching another's. The
containerless driver runs no images; every image route answers
`NOT_SUPPORTED` there.

## Images, revisions and builds

A project keeps several named Dockerfiles ("images"), each with a revision
history; a user keeps one, `Dockerfile.user`, which tops the image of every
project they own. A create chooses an image (the project's default when it
names none), and the stock `yaac` image is always one of the choices.

| Table | Holds |
|---|---|
| `images` | scope (project or user), name, current revision, last built revision and the final tag it built |
| `image_revisions` | the Dockerfile, a file manifest (`path → sha256, size`), a content hash, author, note. Immutable |
| `image_builds` | one layer of one chain: tag, revision, reason, status, times, error, check warnings, parent tag, resolved `FROM` digests, BuildKit version, cache hits, blocked hosts, log path |

Support files live in a content-addressed store per scope
(`global/projects/<id>/image-blobs/`, a user's under server-local
`users/<id>/image-blobs/`). A client uploads a file's bytes once and a save
names it by hash, so a revision is one request. A revision's content hash
comes from its Dockerfile and manifest, so resolving a chain reads no file;
a build materializes the revision into a fresh context dir, group-writable.

`#domain/images` owns all of this. The driver is handed a chain's sources
(`ImageChainSpec`: each layer's Dockerfile text, context dir and content
hash) and never looks a revision up; it resolves tags, says which layers
the registry lacks, and builds them, reporting progress back through the
request's callbacks.

### Behavior

- **Every save that changes content is a revision, and starts a build at
  once** (reason `save`). Saving identical content is a no-op. A user image
  must be layered (`ARG BASE_IMAGE` / `FROM ${BASE_IMAGE}`); a save of a
  user image builds it on each owned project's default image.
- **A create takes the image's last built revision**, so a save or rebuild
  in progress never holds one up. With `awaitBuild` it builds the current
  revision and waits, failing with that build. An image with nothing built
  yet always waits for its first build.
- **Restore** appends a revision with an old one's content. Support files
  whose bytes were collected are dropped and named.
- **The image sweep** (reconcile, every resync) queues a build of each
  project's default image and the image its last create used whenever the
  registry lacks its chain: a new trusted chain after an upgrade gives every
  project image a new tag. A recent failure of that tag holds it off for
  ten minutes. It is skipped in e2e.
- **The spare** is warmed on the image the project's last create used, at
  its last built revision. A create naming another image, or waiting for a
  build, starts cold.
- **Sites** name an image in their settings; a release still pins the image
  it launched, which a replacement or restart launches again.
- **Retention.** Image GC keeps each image's two newest builds per project
  and layer, every build in progress, and each image's last built chain
  (docs/image-gc.md). Support-file bytes are kept for an image's two newest
  revisions and any revision a kept build was made from.

### The queue

A build request names a chain; the layers the registry lacks become rows,
queued until a slot is free. At most `build-concurrency` builds run at once
across the install (default 2; Settings, or `yaac config
build-concurrency`), so an upgrade or saves in ten projects do not start
ten builder pods. Each running build takes about 10GB of node disk for its
parent chain (see "Builder pods"), so the limit is also what bounds a
burst of builds' disk. A create someone waits on goes first, then a person's
save or manual build, then the sweep's. Two requests for the same final tag
share one job until its build ends, unless only one of them skips the
cache: a rebuild without cache never joins a build that reuses it. A build
in progress when the server stops is marked failed at the next start; its
builder pod is deleted then too.

A row's log is a file under server-local `image-builds/`, BuildKit's plain
progress as it printed; the build page polls it by byte offset and groups
it into steps by the `#n` prefix. Step progress, cache hits, check warnings
(`#n WARN: … (line N)`) and the digest each `FROM` resolved to are read from
it as it streams, held in memory while the build runs and stored when it
ends.

## Trust

Two Dockerfiles in a chain can be edited by a user or an agent: a project's
images and a user's `Dockerfile.user`. A hostile `RUN` step in either would
get root-level code execution wherever it ran. The rest of the chain
(`Dockerfile.default`, `Dockerfile.tools`) is yaac's own content over pinned
upstream images.

| Layers | Trust | Built by |
|---|---|---|
| `base`, `tools` | trusted | `yaac cluster install`, with a BuildKit container on the CLI's machine |
| `project`, `user` | untrusted | a short-lived gVisor builder pod running its own buildkitd, driven by the server |

Routing is an allowlist keyed on `ImageLayer.name`: only `base` and `tools`
are prebuilt, and `resolveImageChain()` is their only producer. The server
builds no trusted layer; a missing one is an error naming `yaac cluster
install`. Untrusted layers go into repos named by the project's immutable id
(`yaac-proj-<id>`, `yaac-user-<id>`), so a project added again sees none of
the old one's tags.

## The trusted chain

`yaac cluster install` builds `base` and `tools` with BuildKit, not podman:
an image podman pushes has an OCI config, which has no `SHELL`, and
`Dockerfile.default`'s `SHELL` is what gives every derived image its umask
(docs/arbitrary-uid-images.md). The daemon is the builder image run as a
container on the host engine (`host-buildkit.ts`) for one install, then
removed; its state lives in a named volume, pruned to 3GB before the
daemon goes, so a later install hits the cache of its newest steps without
the volume keeping every layer of the chain. The next install removes a container an interrupted
one left, which also ends a build still running in it. Container and volume
are named by the data dir, so installs and test rigs sharing an engine never
share a daemon. Every image ends with the normalize step, the trusted chain
too, so a project's build finds nothing of the chain's to fix, and a shipped
step that leaves files without group write shows in the install log.

## Builder pods

One pod per build request, running its own buildkitd: projects share
nothing but the registry, nothing sits idle, and a build's cache cannot be
read by another project's. A request with both a project and a user layer
builds both in one pod, so the user layer finds its parent local.

Pod spec (`drivers/k8s/images/builder-pod.ts`):

- The builder image (`yaac-buildkit:<hash>`, `k8s/buildkit/`), by the digest
  install recorded. It rebuilds buildkitd from the pinned release's source
  for one patch: `moby/sys/userns` decides it is in a user namespace unless
  `/proc/self/ns/user` has the kernel's init inode, and gVisor reports
  another. containerd then refuses its direct layer unpack and extracts each
  layer through an overlay of every layer below it, several times slower
  under gVisor (a cold `tools` parent took 234s instead of 75s). The patch
  reads `uid_map`, which is accurate in the sandbox.
- `runtimeClassName: gvisor`, the engine capabilities (which grant nothing
  on the host), no service account token, seccomp `RuntimeDefault`, an 8Gi
  memory limit and `activeDeadlineSeconds`. Labels `yaac.role: builder`,
  `yaac.project-id` and `yaac.build-id`.
- buildkitd's state on a sentry-internal tmpfs (24Gi cap), set up by the
  `dev.gvisor.spec.mount.*` annotations and paged to a file in the pod's
  emptyDir, so it costs node disk rather than pod memory. It holds the
  parent twice (blobs and unpacked snapshots, about 10GB for the stock
  tools image), freed when the pod is deleted.
- buildkitd is the entrypoint, its config written from the pod's env at
  start (`buildkitdConfig`): the overlayfs snapshotter, no GC, gateway
  frontends off, the registry's pod port over plain HTTP, and no cap on a
  step's log. `RUN` steps share the pod's network (`--oci-worker-net=host`)
  and run under runc in their own containers inside the sandbox.

For each layer the server streams the context in as a tar over `kubectl
exec -i`, writes the Dockerfile with the normalize step appended, the source
policy and the registry grant (over stdin, never argv), then runs one
`buildctl build`:

- `BASE_IMAGE` is the parent's pod-port ref, so BuildKit pulls it only if a
  step has to run; a fully cached build never pulls it.
- `--opt cmdline=dockerfile.v0`, so the built-in, pinned frontend parses
  every file: with gateway frontends off a `# syntax=` line would otherwise
  fail the build.
- `--import-cache`/`--export-cache type=registry,mode=max,image-manifest=true`
  on the layer's cache ref (below); `--no-cache` for a rebuild without cache.
- `--output type=image,push=true,compression=zstd` with no attestations, so
  the result, like the cache export, is one tagged manifest, never an index.
- `--source-policy-file` and `--progress plain`.

The pod is deleted when the request ends, and the next server's start
deletes any a dead server left (`deleteLeakedBuilderPods`), with their
egress registrations.

### Timeouts

Every exec has an **idle** timeout, reset on every byte of output (BuildKit
prints steadily, so silence means stuck), and the pod's
`activeDeadlineSeconds` is the **total** backstop for a build stuck in a
noisy loop. A pod killed by its deadline looks like a signalled `kubectl`,
so `builderPodBlockReason` adds the reason from the pod's status.

## The registry

The main registry is an in-cluster `registry:2` Deployment behind a
ClusterIP Service, in the default install namespace so concurrent e2e
namespaces share one image store. It listens on two ports, both through the
gate (below), and its ingress policy hands them to different callers:

| Port | Admitted by policy | Reads |
|---|---|---|
| node port, 5000 | node addresses: containerd, the kubelet probe, a host `port-forward` | anonymous |
| pod port, 5002 | builder pods and the server, in any namespace | a project, user or build-cache repo needs a grant naming it; the catalog is refused; the trusted chain and mirrors stay anonymous |

Workspace pods are admitted to neither, and their images are pulled by the
node without credentials. Image refs name the node port; builders and the
server address the same repos on the pod port, and blobs are stored by
repository path, so it is the same image. Host processes (install, `cluster
check`, the e2e setup) push through a `kubectl port-forward`.

### Build caches

Each layer of each image has one cache ref, in its project's repo:
`yaac-buildcache-<project id>:<layer>-<key>-<window>`, where the key is the
image's id for a project layer and the project image it tops (or `stock`)
for a user layer, so two images of a project never overwrite each other's
cache. Time is cut into windows of the project's cache age
(28 days unless it sets its own: Settings, or `yaac config image-cache-days
<project>`), offset per project, and a window's cache is never read after
it ends. That bounds how long a poisoned entry can outlive the Dockerfile
that planted it, with no stored start date. The registry GC keeps only each
cache's newest window. A `RUN` step is not handed the grant, but the
boundary is a container inside the sandbox, not gVisor: a step that breaks
out of it can write its own project's cache, which gains persistence, not
reach, and the window and "rebuild without cache" bound that. Builder
daemons start empty, so no leftover state feeds a step.

The **source policy** denies every image on the main registry, at either
port, except the layer's own parent, so a Dockerfile cannot `FROM` or `COPY
--from` another project's image through the daemon. The gate is what
holds; the policy makes a hostile Dockerfile fail early and clearly.

### The gate

Builder pods are untrusted and must push, so the registry cannot tell a
hostile `RUN` step from its build by network position. It checks a signed
**grant** instead. The registry pod runs `registry:2` on its loopback and an
Envoy container on the Service ports; Envoy's Lua filter
(`registry-gate.ts`) is the only way in:

- Every write (any method but GET and HEAD) needs a grant, sent as a Basic
  credential: `v1|<expiry>|<scope>` plus an RSA-SHA256 signature, verified
  against the public key in the gate's ConfigMap. The repository in the
  path must be in the scope (`*`, or an exact list). A write of any other
  shape names no repo and is refused. A cross-repo mount also needs its
  source in scope when the source is a protected repo, since a mount reads
  it. A bad or missing grant gets `401`; a repo outside the scope `403`.
- On the pod port, a read of a protected repo needs a grant naming it too,
  and only manifest, blob and tag reads are served.
- `DELETE` is refused for every grant; the GC works on storage directly.
- Every 401, and a bare `/v2/` without credentials, carries a Basic
  challenge, because podman and BuildKit send credentials only to a
  registry that asks.
- A script error refuses the request (the gate runs under `pcall`). The unit
  suite runs the real script under fengari. Paths arrive normalized, so the
  repo the gate checks is the repo the registry writes.

The signing key is one RSA-2048 keypair per cluster, in the Secret
`yaac-registry-grant-key` in its own namespace, `yaac-registry-keys`
(the registry's namespace is also the egress proxy's, which can read every
Secret there). Only the host CLI and the in-cluster server can read it. The
gate holds only the public key. Grants:

- **Admin (`*`)**, one hour, for every host push, in a private temp authfile.
- **Per build**, for a builder pod: the layer's own repo, the project's cache
  repo, and its parent's repo when that is protected (a user layer over its
  project's), valid until the pod's deadline plus a minute.
- **Per read**, five minutes, for the server's own tag checks of a
  protected repo.

`yaac cluster check` starts an anonymous upload on the node port and an
anonymous read of a project repo on the pod port, and fails if either is
admitted. The digest-pinned mirrors and the builder image are pulled by the
digest install recorded in `yaac-mirror-digests` by the pods that run them
as root (builder pods, the node-local sweeps, the utility pods), so
containerd checks the bytes.

## Build egress

A builder pod is redirected and policed like a workspace pod
(docs/workspace-egress.md), with its own identity:

- **Policy.** `yaac-builder-egress` allows what a workspace's does (the node
  on netd's listener range, DNS to the proxy's stub) plus the registry's pod
  port. A builder whose redirect is missing has no egress.
- **Redirect.** netd redirects pods labelled `yaac.workspace-id` and those
  labelled `yaac.build-id`.
- **Identity.** The server writes a registration (`yaac-proxy-reg-<build
  id>`, labelled by build id) before the pod and deletes it with the pod;
  the proxy's pod watch maps the builder's address to it. It carries the
  project's allowlist and nothing more. The proxy's DNS stub resolves the
  registry's name for it and sinkholes the rest.
- **A build only tunnels.** The proxy knows a builder by its label and
  tunnels every allowed host, injecting nothing and terminating no TLS, so
  no CA is needed inside `RUN` steps and no credential can end up in a
  cached layer. It refuses `yaac.internal` to a build. A parent comes from
  the main registry, so most builds pull from no outside registry; one that
  does (a standalone `FROM`, a `COPY --from=<image>`) needs that registry's
  hosts in the project's allowlist (`ghcr.io` is a default; Docker Hub and
  quay are not).
- **Blocked hosts** a build hits are read from the proxy before its
  registration goes and recorded on the build. Its page offers "allow for
  this project", which allows the host together with the rest of its
  registry's hosts (Docker Hub's registry, token and CDN hosts) and builds
  again.

## Open items

- **Repos as build sources, and cache refs split by trust**:
  docs/plans/build-repo-sources.md.
- **Credentials in builds**: either the proxy's injection (which needs the
  proxy CA inside `RUN` steps) or `RUN --mount=type=secret` fed from named
  project secrets.
- **A warm per-project cache**, kept between builds so a cold one skips the
  parent pull. Needs `BUILDKIT_CACHE_MOUNT_NS`, BuildKit's own GC limits, and
  an answer for multi-node clusters.
- **The userns patch** goes once gVisor reports the init namespace's inode
  or `moby/sys/userns` cross-checks `uid_map` beyond OpenVZ.
- **KVM platform** for runsc where `/dev/kvm` exists.

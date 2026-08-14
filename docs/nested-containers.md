# Nested containers on the Kubernetes backend

How in-pod podman, the combined CA bundle, and the per-project push
registries work on yaac's Kubernetes backend. This is a current-state
reference for the shipped subsystem.

One opt-in capability is layered here: **`nestedContainers`** — an in-pod
rootful podman (real root inside the gVisor sentry, the upstream
docker-in-gvisor shape) so `docker build` / `docker run` / `docker compose
up --build` work inside a worktree exactly as a project README instructs
(the `docker` CLI talks to podman's Docker-API socket). Non-nested
worktrees are byte-for-byte unchanged.

It is config-only, set in `yaac-config.json`; there is no CLI flag.

## Image layer

`dockerfiles/Dockerfile.nestable` (in-pod rootful podman + the `docker`
CLI + the compose plugin) is inserted into the image chain
(default → tools → **nestable** → project `Dockerfile.yaac`) only when
`nestedContainers` is set, and skipped for a standalone `Dockerfile.yaac`.
The nestable tag is a content hash of the Dockerfile, so it rebuilds on
change. This image also carries the proxy-CA trust wiring below.

## In-pod rootful podman

The engine runs as **real root inside the gVisor sentry** (the
`gvisor-nested` RuntimeClass). In-sandbox root is a sentry fiction with no
host authority, so none of the rootless apparatus (subuid maps, id-map
helper caps, keyring/pivot_root workarounds) is needed. When a worktree is
nested, its pod gains:

- **securityContext**: `seccompProfile: RuntimeDefault` plus
  `capabilities.add: NESTED_ENGINE_CAPS` (SYS_ADMIN, SYS_CHROOT, MKNOD,
  SETFCAP, NET_RAW, NET_ADMIN, SYS_PTRACE, SYS_RESOURCE). Under the sentry
  these grant no host authority — they are the upstream docker-in-gvisor
  posture, and the `gvisor-nested` handler additionally allows the raw
  sockets the engine needs.
- **graphroot**: podman's rootful default (`/var/lib/containers/storage`)
  on a disk-backed sentry-internal tmpfs. gVisor's gofer filesystem
  refuses writes to the `security.*` xattr namespace, so `docker build`
  setcap steps only work on a sentry tmpfs; the disk filestore keeps layer
  data out of pod memory (reclaimable node page cache, not cgroup-pinned
  tmpfs pages). Root-owned, so no fsGroup/chown. The sentry's `size=` cap
  ENOSPCs oversized builds before kubelet eviction can fire.
- **cross-worktree image cache**: the project's registry is the cache
  (below), so a nested worktree can be scheduled on any node. A pod
  additionally mounts its node's *generation* of that cache read-only at
  `/var/lib/shared-images`, which storage.conf names as the engine's one
  `additionalimagestores` lower — a per-node materialization of the same
  registry, never a second source of truth.

The pod's postStart setup script (`worktree-bin/yaac-worktree-init`) starts
the engine in the background with one sudo'd shell: `podman system
service` as root, a socket wait with a log-tail diagnostic on timeout,
then handing the socket to the `yaac` user so both CLIs
(`DOCKER_HOST`/`CONTAINER_HOST` → `/run/podman/podman.sock`) drive it;
worktree-create gates on `docker version` over the stream relay before
handing the worktree over. The service exports `BUILDAH_ISOLATION=chroot`:
under buildah's default OCI isolation the sentry breaks the `RUN`-step
stdio relay after tens of KB of output (EPIPE kills chatty steps like
`apt-get`), while chroot isolation streams fine, keeps `RUN` on the pod
netns, and holds setcap file caps on the tmpfs graphroot. Nothing
supervises the engine: if it dies mid-worktree, the worktree is degraded
until recreated.

### Image cache (cross-worktree build cache)

A worktree's built and pulled images are salvaged into the **project's own
registry**, and reach the next worktree's engine as a read-only lower layer
store, so `docker build` gets real layer-cache hits across a project's
worktrees. The registry is the source of truth and the only thing that
travels between nodes; the node store below is a cache of it, so a worktree
landing on a cold node just runs cold rather than being tied to the node
its predecessor ran on. Every nested worktree therefore ensures the
per-project registry.

The push runs **inside the sandbox**, and the constraint it respects is
that no layer may be extracted file-by-file through the gVisor gofer
(~2ms/file — a 4GB node_modules-heavy chain took 16+ minutes that way).
Nothing in this path touches the gofer: the graphroot is a
sentry-internal tmpfs, so `podman push` reads layers at native speed,
compresses them in-sandbox, and streams them out over netstack as bulk
blob uploads — the same shape the trust-split builder pods already push
their products with.

The push compresses with **gzip**, and that is a correctness constraint
rather than a tuning choice. buildah only considers a cache candidate
whose manifest type equals the format the running build emits, and the
store holds both types: the worktree's `docker` is the real Docker CLI
against podman's Docker-compatible API, so `docker build` emits
docker-schema2, while a bare `podman build` emits OCI. A push must
therefore hand each image back as what it was, and the compression format
decides that — schema2 has no zstd layer media type, so a zstd push
silently rewrites a schema2 image as OCI and every later `docker build`
skips the whole cache. gzip has media types in both schemas, so it
leaves either in place and the image id survives the round trip
unchanged. Level 1 within gzip, because this compression runs inside the
worktree sandbox where CPU is the scarce resource and the bytes land in a
node-local registry.

One salvage is two sudo-gated execs:

1. **Survey** — list the engine's images with their parents, names, and
   the pod's ledger of refs it has already pushed or pulled.
2. **Push** — the server plans `id → destination` pairs from that survey
   and hands them to a push script as validated argv. Each named image
   goes under its own name (`<registry>/<repo>:<tag>`), stripped of
   podman's `localhost/` local-registry prefix so that one image is one
   repo whichever side pushed it — the server's own pushes into this
   registry use the bare tag, and the store builder's restore
   round-trips back through the prefix. Its ancestor chain goes into the SAME repo
   under `yaac-cache-<tag>-<n>` tags: those
   intermediates are what a step-by-step `docker build` matches, and
   tagging them per named image keeps the tag set bounded — a rebuilt
   `app:v1` overwrites its own chain tags instead of adding a generation.
   Blobs are already in the repo by then, so the chain uploads manifests
   only. Successful pushes append to the ledger, so the 10-minute
   reconciler never re-compresses what it already sent.

### The node-local image store

The read side is not a per-worktree pull at all: the registry's contents
are materialized ONCE PER NODE as a read-only containers/storage directory that
every nested worktree of the project mounts at `/var/lib/shared-images`.
A fresh worktree therefore sees the project's warm layers at first touch —
no per-worktree pull, no decompression competing with the agent, and none
of the 12GiB sentry graphroot spent on layers it did not build. Concurrent
worktrees on a node share one copy of the bytes.

`store-writer.ts` owns it. A **generation** is a complete store under
`<node-local root>/shared-images/<project>/gen-<stamp>/`, written by a
node-side pod and made publishable only by the `.yaac-store-done` marker
written last. It sits outside the project tree, alone among per-project
paths, because a node-side pod writes it as root and the server's own uid
could not `rm -rf` it at project removal; a one-shot pod does that instead. Generations are write-once: worktree create pins the newest
complete generation's *path* into the pod, so a running worktree's store
can never change underneath it, and the writer's GC can read the live set
straight off pod specs — a generation is droppable exactly when no pod
mounts it.

The writer pod **builds nothing** — it pulls what the registry already
holds and rearranges it on a node path — which is why it is not one of the
trust-split *builder* pods and carries none of their identity; it borrows
only their pinned `quay.io/podman/stable` image. Its shape is the
registry's `hosts.toml` writers': runc, plain root, `nodeName`, tolerating
everything, store parent hostPath-mounted rw. Two of its properties are
deliberate:

- **hostNetwork**, because the project registry's ingress policy already
  admits the node's own address range for containerd's pulls. In the host
  netns the pod *is* the node, so the store needs no NetworkPolicy of its
  own — and must name the registry by ClusterIP, the node not being a
  cluster-DNS client.
- **no CAP_SYS_ADMIN**, because `podman pull --root` needs none (a pull
  untars into the layer's diff dir; nothing is mounted) and withholding it
  is load-bearing for the xattr shape below.

Each refresh seeds from the previous generation with `cp -al`, so a
generation costs disk proportional to what changed — a pull only adds layer
directories and rewrites metadata via temp+rename, never mutating a layer
diff in place. (podman's own state is dropped from the copy: its database
records the absolute graphroot it was created under and refuses to open
under another.) It then pulls the project's working set under the same
ranking rule as the registry's retention pass, restores each named image's
bare name, and leaves the `yaac-cache-` chain slots dangling exactly as a
local `--layers` build's intermediates are.

What that ranking is: a repo holds up to `REGISTRY_GENERATIONS_KEPT`
content-hash generations and the catalog walk reaches them in no meaningful
order, so a repo's content-hash tags are ranked newest-first — by the build
time in each image's own config, the same "content-hash tags are
write-once, so creation order is generation order" the retention pass leans
on — and only the newest `CACHED_GENERATIONS_KEPT` are taken, dropping the
chain slots of the generations dropped with them: an old generation's
intermediates cache-hit nothing once its named image is gone. What counts
as a generation is the retention pass's guard, both halves: a yaac-built
repo (optionally under a push prefix) carrying a content-hash tag. The
upstream mirrors and a worktree's own repo are left alone even when their
tags happen to have the content-hash shape — a repo retention has no say
over is not one this narrows either. A generation whose config will not
scrape ranks NEWEST rather than oldest: ranking is best-effort, and one
transient fetch failure must not be what costs a worktree the generation
its next build would have cache-hit.

Two post-passes run before the marker. A **metadata assertion** fails the
build if any layer lacks a recorded diff size — without one `podman images`
reconstructs it by decompressing the layer's tar-split, which across the
gofer is the classic "images takes minutes" bug. And an **opaque-directory
rewrite**, which is the one place this design is not simply "the registry,
locally":

> A layer that REPLACES a directory records that as an overlay xattr on the
> diff dir rather than as a file, and neither spelling survives the trip
> into a worktree. `trusted.overlay.opaque` is invisible through gVisor's
> gofer filesystem — every read of the `trusted.` namespace answers
> EOPNOTSUPP. `user.overlay.opaque` *is* readable through the gofer, but the
> worktree engine holds CAP_SYS_ADMIN in-sandbox, so containers/storage
> takes its rootful path and mounts overlay without `userxattr`, reading
> the `trusted.` name. Either way the marker goes unhonored and the
> replaced directory's old entries resurrect in the merged view — a
> silently wrong image, not a slow one.
>
> So the builder rewrites every opaque marker into the explicit per-entry
> whiteouts it stands for, computed against the layer's own (fixed,
> write-once) parent chain. Those are 0:0 character devices — plain
> metadata, which the gofer passes through, as do `security.capability`
> file caps. This is why the writer runs without CAP_SYS_ADMIN: that is
> what makes containers/storage record the markers in the `user.` namespace
> the rewrite can read back. The pass is incremental (a per-layer marker
> file, hardlinked forward by `cp -al`), so each layer is walked once in
> the life of a store.

The store is refreshed by a reconcile step, throttled per project, and
immediately after a salvage that actually pushed — the one moment the
registry gained content. A refresh that publishes nothing retries on a
shorter backoff, because the commonest cause is racing the registry's own
maintenance rollout, which lasts seconds; an unreachable registry fails the
refresh outright rather than publishing an empty result, so the last good
generation stays mounted.

Because the mount is chosen at pod create, a PREWARMED spare carries the
generation that existed when the spare was created, not when it is claimed
— a spare that predates a refresh runs slightly colder than a fresh create
would. That is the same trade the pinning buys everywhere else: a store
that cannot change under a running engine. A cold node has no generation, mounts nothing, and
warms on the next build; `/var/lib/shared-images` is baked into the image
as an empty directory so that case needs no special-casing (containers/
storage treats an empty additional store as no images). The engine loads an
additional store once and afterwards revalidates by statting its lockfile,
so the postStart script pays the single cold walk with a background
`podman image ls` and every later `image ls` is answered from the daemon's
memory.

Both halves are best-effort and self-gating (no engine, no sudo, or no
registry ⇒ a single cheap exec that does nothing; no generation ⇒ an empty
store); a cold cache only ever costs a rebuild. Salvage runs
**mid-worktree** (a periodic reconciler, so a project's large first salvage
lands during the run) and at **worktree cleanup**, before the Job is
deleted.

"No engine" is the pod's own `YAAC_NESTED_ENGINE`, tested before the sudo
that every in-pod leg runs behind, and the reconciler additionally skips
pods without the `yaac.nested` label so a non-nested worktree is not sent a
probe at all. The test is deliberately not "is podman installed" — a
binary's presence never implied an engine, and pods from images built
before podman left the base ship it engineless. Running podman without one
is not a no-op: unconfigured rootless podman under sudo resolves its
runtime dir to a relative `libpod/tmp`, and an in-pod exec inherits the
container's workingDir, so the probe plants a root-owned directory in the
user's checkout.

Destinations carry no content hash: they are name-for-name, and the chain
tags are slots keyed by (repo, tag, depth). That is what bounds the tag
set, and it makes concurrent worktrees of one project last-salvage-wins on
a shared name — and the node store, being a materialization of the
registry, inherits exactly those semantics.
Nothing corrupts (layers are content-addressed and a manifest PUT is
atomic), and a chain left interleaved between two worktrees costs a wasted
pull, never a wrong cache hit: buildah matches a cache candidate on layer
parentage *and* history, so a foreign intermediate never matches.

### Registry GC

A salvage also retires chain slots a shorter rebuild no longer fills
(`DELETE /manifests/<digest>`, bounded by contiguity), so a stranded tail
cannot make every future store generation carry dead intermediates.

Because both flows reuse tags, every rebuild leaves the previous manifest
referenced by no tag — so the reclaim is just `registry garbage-collect
--delete-untagged`, run by the `registry-gc` reconcile step against the
storage hostPath.

That alone cannot bound a repo whose every build mints a NEW tag, though:
yaac's own chain is content-hash tagged (`yaac-tools:<hash>`), so each
source change adds a generation that stays tagged and therefore collectable
by nothing. The collect runs a retention pass first, keeping the newest
`REGISTRY_GENERATIONS_KEPT` — the same policy `image-gc.ts` applies to the
host engine — and letting `--delete-untagged` reclaim the rest. It is the
only thing here that drops a name someone could still pull, so it is
doubly guarded: the repo must be yaac-built (mirroring image-gc's
`YAAC_IMAGE_REPO`), and the tag must have the content-hash shape, so a
worktree's own `myapp:v1` and the cache's `yaac-cache-…` slots can never
match. Everything else tagged is left alone: a tag in this registry is a
promise to whoever pulls it.

Retention is age-based, not liveness-based: a worktree pinned to a
generation that has since been passed by `REGISTRY_GENERATIONS_KEPT` newer
ones loses pullability, and a pod naming a retired tag would
ImagePullBackOff on a restart. The budget is sized to make that rare — it
is the width of the concurrently-live fleet, not a rebuild depth — but
closing it properly would mean checking the tags live worktrees actually
reference before retiring.

`garbage-collect` is only safe when nothing can be pushing — a push that
has uploaded blobs but not yet its manifest is indistinguishable from
garbage. Upstream's answer is "read-only mode, or not running at all", and
not-running is unusable here: an active project's worktree count never
reaches zero, so a collect gated on idleness would never run for the
registries that actually grow. The collect therefore takes a **read-only
maintenance window** — the Deployment is rolled with
`REGISTRY_STORAGE_MAINTENANCE_READONLY` on, which keeps pulls and the
catalog serving while pushes and deletes answer 405. A salvage push or
retire that lands in the window fails best-effort and is retried next
cycle (the ledger and the retired-shape memo only record what succeeded),
while pulls — what a live worktree and its synced pods depend on — keep
working. The cost is two `Recreate` rollouts, a few seconds of
unavailability at each edge of the window.

It holds the same per-project mutex `ensureProjectRegistry` takes, so a
worktree create cannot start mid-collect; it is throttled per project, runs
one project per pass, detaches (reconcile steps run sequentially), and the
restore to serving mode is unconditional so a failed collect never strands
a registry in maintenance mode.

That env var is spelled as an inline YAML map: the `…_READONLY_ENABLED`
form collapses the key to a scalar and registry 2.8 panics at boot.

## CA trust: the combined bundle

Nested containers must trust the worktree's MITM proxy on the hosts it
intercepts **without** losing trust in the real public roots for the hosts
it tunnels. CA-trust config splits into two incompatible shapes:

- **Additive** vars layer our CA *on top of* the image's roots:
  `SSL_CERT_FILE` (OpenSSL still also reads `/etc/ssl/certs`) and
  `NODE_EXTRA_CA_CERTS`. These cover OpenSSL-default tooling and Node.
- **Replace** vars point at a *single file* that becomes the tool's entire
  trust set: `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `CARGO_HTTP_CAINFO`,
  `GIT_SSL_CAINFO` — the only knobs curl, Python `requests`, Cargo's
  libcurl, and git's libcurl honor.

The trap: pointing the replace vars at our lone proxy CA makes the tool
trust the MITM cert but reject the real cert of every host the proxy
*tunnels* (npm, PyPI, crates.io, distro mirrors, docker.io/quay). Pointing
them at only the public roots fails the other way on intercepted hosts.
Neither single-source bundle is correct — the replace vars need the union
`{public roots} ∪ {proxy CA}`.

### Shipped design

A single PEM that is `{public roots} + {proxy CA}` is produced at runtime
and the replace vars point at it. Because it is a *superset* of the real
roots, replace semantics become correct: the tool trusts the proxy on
intercepted hosts and the real upstreams on tunnelled hosts.

- **Roots source** is the proxy image's own `ca-certificates` bundle, so
  the roots track the package with no separate staleness burden.
  `combineCaBundle(roots, ca)` concatenates them (pure, unit-tested), and
  the proxy serves the result at `GET /ca-bundle.pem` (the bare CA stays
  at `GET /ca.pem`).
- The server fetches it and writes both keys — `proxy-ca.pem` (bare) and
  `ca-bundle.pem` (combined) — into the existing `yaac-proxy-ca`
  ConfigMap, skipping the write when both already match, so CA rotation is
  just a file write, no image rebuild.
- The ConfigMap mounts at `/etc/yaac/certs`; the nestable image's
  `containers.conf` re-exposes both files to nested containers via
  `[containers] volumes`. The env-var split is emitted per shape: additive
  → bare CA, replace → combined bundle (plus `podman run`'s
  `containers.conf [containers] env` for the same split inside the pod).

### Build-time drop-in

`docker build` RUN steps are not covered by env vars: buildah applies
`containers.conf [containers] volumes` to builds but not `[containers]
env`. So build-time trust rides a volume: the bare proxy CA is
bind-mounted as a source cert at
`/usr/local/share/ca-certificates/yaac-proxy-ca.crt`. When a build runs
`update-ca-certificates` (as `apt-get install ca-certificates` and many
package triggers do), it folds the drop-in into the image's real roots,
producing the correct union that curl reads by default with no env.

The drop-in is a source cert, not a bind-mount over
`/etc/ssl/certs/ca-certificates.crt` itself: that file is what
`update-ca-certificates` rewrites via `rename()`, which fails EBUSY onto a
bind-mountpoint, so the drop-in composes with `update-ca-certificates`
instead of fighting it. A build that runs curl against a MITM'd host
without ever refreshing `ca-certificates` is still covered at run time by
the env vars.

Still manual: Java/JVM (own `cacerts` keystore), rustls-based clients, and
OS-store-only tools with no env knob (GnuTLS `wget`) honor neither the OS
store nor any CA env var, and need their own per-tool import.

## Per-project push registries

A plain `registry:2` per project serves as the push-and-serve bus for the
cross-worktree image cache: a worktree's built layers are salvaged and
pushed there at teardown, and the next worktree pulls them. It has no
upstream egress — nested `docker pull` goes through the MITM proxy, not
this registry.

- Plain HTTP on **:5000**, blobs on a per-project RWO PVC, plain root
  (trusted infra, like the proxy). The `registry:2` image is digest-pinned
  and mirrored into the yaac registry.
- Ensured for every **nested** worktree — it is what carries their
  cross-worktree image cache.
- **Per project, not shared**, because `registry:2` has no path ACLs: a
  shared writable registry would let one project overwrite another's tags.
- Three policies: a worktrees→registry allow k8s NetworkPolicy (podSelector
  requires the project label *and* a `yaac.worktree-id`, keeping it off the
  registry pod itself), a deny-all egress k8s NetworkPolicy on the registry
  pod, and a NetworkPolicy ingress lock confining the registry pod's
  ingress to same-project worktrees plus the host/remote-node entities.
- Node containerd reaches it via a `hosts.toml` under
  `/etc/containerd/certs.d/` (see Service addressing below).
- Lifecycle: created from worktree-create for a `nestedContainers`
  worktree, removed on project removal, orphan-GC'd at server start.

### Service addressing

The proxy and per-project registry Services both use
**allocator-assigned ClusterIPs**. They are stable because the Services
are never deleted or recreated: `kubectl apply` reconciles drift in place,
so the immutable ClusterIP is allocated once and never migrates. The
server reads the live IP whenever it needs one (at pod-create, and when
writing the node `hosts.toml`).

- **In-cluster clients** (worktree pods) reach these Services
  by their service-DNS names, resolved through the proxy's split-horizon
  DNS: the proxy forwards `*.cluster.local` to cluster CoreDNS and
  sinkholes bare `.svc` to avoid a DNS-exfil channel. No `hostAliases`,
  no pinned VIP.
- **The node** is not a cluster-DNS client, so containerd needs the IP
  directly: the registry's `hosts.toml` maps its service-DNS host to the
  live ClusterIP, rewritten on every ensure (read per-pull, no containerd
  restart) so it always tracks the allocator-assigned IP.

## Egress integration

Worktree egress is the netd / pod-watch model, not in-pod iptables. netd
DNATs a worktree pod's outbound 443/80/ssh-sentinel at its veth to a
node-local Envoy, which stamps the source IP into a PROXY-protocol
preamble and forwards to the proxy's transparent listeners; the proxy
resolves source-IP → worktree by reading the pod's `yaac.worktree-id` label
off a pod-watch. Nested containers share the worktree pod's netns, so their
`docker pull`/build traffic rides the same path with zero extra wiring;
the proxy auto-appends the upstream registry + CDN hosts (docker.io,
ghcr.io, quay.io and their CDNs) to the allowlist for nested worktrees, and
anything else is denied fail-closed. The in-cluster destination that
matters (the project registry on :5000) is reached by its service-DNS name
(Service addressing above) and admitted by the per-project NetworkPolicy.

## cluster-check probes

`yaac cluster check` gains a warn-level `nested-mount` probe: in-sandbox
root runs `mount -t tmpfs` under the real nested containment, the sentry
prerequisite for the rootful engine. It sits alongside the `gvisor` gate
and the `runtime-stamp` sweep, which apply to every worktree.

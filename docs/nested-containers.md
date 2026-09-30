# Nested containers on the Kubernetes backend

How in-pod podman, the combined CA bundle and the per-project push
registries work on yaac's Kubernetes backend.

`nestedContainers` is an opt-in setting in `yaac-config.json` (there is no
CLI flag). It gives a workspace a rootful podman engine inside its gVisor
sandbox, so `docker build`, `docker run` and `docker compose up --build`
work as a project README expects. The `docker` CLI talks to podman's
Docker-API socket. Workspaces without the setting are unchanged.

## Image layer

`dockerfiles/Dockerfile.nestable` adds rootful podman, the `docker` CLI and
the compose plugin. It sits in the image chain (default → tools →
nestable → project `Dockerfile.yaac`) only when `nestedContainers` is set,
and is skipped for a standalone `Dockerfile.yaac`. Its tag is a content
hash of the Dockerfile. It also carries the CA trust wiring described
below.

## In-pod rootful podman

The engine runs as root inside the gVisor sandbox, under the
`gvisor-nested` RuntimeClass. Root inside gVisor has no authority on the
host, so none of rootless podman's setup (subuid maps, id-map helpers,
keyring and pivot_root workarounds) is needed. A nested pod gets:

- **securityContext**: `seccompProfile: RuntimeDefault` and
  `NESTED_ENGINE_CAPS` (SYS_ADMIN, SYS_CHROOT, MKNOD, SETFCAP, NET_RAW,
  NET_ADMIN, SYS_PTRACE, SYS_RESOURCE). These grant nothing on the host;
  they match upstream's docker-in-gVisor setup. The `gvisor-nested` handler
  also allows the raw sockets the engine needs.
- **graphroot**: podman's default `/var/lib/containers/storage`, on a
  disk-backed tmpfs inside the gVisor sentry. It has to be a sentry tmpfs:
  gVisor's gofer filesystem refuses `security.*` xattrs, so `setcap` steps
  in `docker build` fail anywhere else. Disk backing keeps layer data in
  reclaimable page cache rather than pod memory. The tmpfs `size=` cap
  makes an oversized build fail with ENOSPC before kubelet eviction fires.
- **image cache**: the node's current store generation (below), mounted
  read-only at `/var/lib/shared-images` and listed in storage.conf as the
  engine's one `additionalimagestores` entry.

The pod's postStart hook (`workspace-bin/yaac-workspace-init`) starts
`podman system service` as root, waits for the socket (printing the engine
log tail on timeout), and hands the socket to the `yaac` user.
`DOCKER_HOST` and `CONTAINER_HOST` point both CLIs at
`/run/podman/podman.sock`. Workspace create then runs `docker version` in
the pod and fails the create if the engine does not answer.

The service exports `BUILDAH_ISOLATION=chroot`. Under buildah's default OCI
isolation, gVisor breaks the `RUN` step's stdio relay after tens of KB of
output, which kills chatty steps like `apt-get` with EPIPE. Chroot
isolation streams fine, keeps `RUN` in the pod's network namespace, and
keeps file capabilities on the tmpfs graphroot.

Nothing supervises the engine. If it dies, the workspace stays degraded
until it is recreated.

## Cross-workspace image cache

Images a workspace builds or pulls are **salvaged** (pushed) into the
project's own registry. The next workspace sees them as a read-only image
store, so `docker build` gets real layer-cache hits across a project's
workspaces. The registry is the source of truth and the only thing shared
between nodes. The per-node store is a cache of it, so a workspace on a
cold node just starts cold. Every nested workspace therefore ensures its
project registry exists.

### Salvage (the write side)

The push runs inside the sandbox. Extracting layers file by file through
the gVisor gofer costs about 2ms per file (a 4GB chain heavy with
node_modules took over 16 minutes), so salvage avoids the gofer entirely.
The graphroot is a sentry tmpfs, so `podman push` reads layers at native
speed, compresses them in the sandbox, and streams them out over the
network.

Salvage pushes use **gzip, level 1**. The format is required for
correctness. buildah only uses a cache candidate whose manifest type
matches what the current build emits. `docker build` through podman's
Docker API emits docker-schema2, while `podman build` emits OCI. Schema2
has no zstd media type, so a zstd push silently turns a schema2 image into
OCI and every later `docker build` misses the cache. gzip exists in both
schemas, so images round-trip unchanged. Level 1 because the compression
runs on the workspace's CPU and the bytes only travel to a node-local
registry.

One salvage is two sudo'd execs into the pod:

1. **Survey**: list the engine's images with their parents and names, plus
   the pod's ledger of refs already pushed or pulled.
2. **Push**: the server plans `id → destination` pairs and passes them to a
   push script as validated argv.
   - Each named image goes to `<registry>/<repo>:<tag>`, with podman's
     `localhost/` prefix stripped so one image is one repo whichever side
     pushed it.
   - Its ancestor chain goes into the same repo as `yaac-cache-<tag>-<n>`
     tags. Step-by-step `docker build` matches these intermediates. Keying
     them per named image bounds the tag set: rebuilding `app:v1`
     overwrites its own chain tags. The chain pushes are manifest-only,
     since the blobs are already there.
   - Each successful push is appended to the ledger, so the next salvage
     skips it.

Salvage runs every 10 minutes per live workspace (the `image-salvage`
reconcile step, detached, so a project's large first salvage lands during
the run) and again at workspace cleanup, before the Job is deleted.

The reconciler only visits pods labeled `yaac.nested`, and the in-pod
script checks the pod's `YAAC_NESTED_ENGINE` variable before any sudo. It
does not just test whether podman is installed: unconfigured podman under
sudo creates a root-owned `libpod/tmp` in the user's checkout.

Destinations carry no content hash. Named images map name for name, and
chain tags are slots keyed by (repo, tag, depth). So when two workspaces of
one project push the same name, the last salvage wins. Nothing is
corrupted, because layers are content-addressed and a manifest PUT is
atomic. A chain left interleaved between two workspaces costs a wasted
pull, never a wrong cache hit: buildah matches on both layer parentage and
history, so a foreign intermediate never matches.

### The node-local image store (the read side)

Workspaces do not pull from the registry. Instead, the registry's contents
are materialized once per node as a read-only containers/storage directory
that every nested workspace of the project on that node mounts at
`/var/lib/shared-images`. A new workspace sees the project's layers
immediately, with no pull, no decompression competing with the agent, and
no graphroot space spent on layers it did not build. Workspaces on the
same node share one copy.

`store-writer.ts` owns it. A **generation** is a complete store at
`<node-local root>/shared-images/<project id>/gen-<stamp>/` (on the node,
`/var/lib/yaac/node/<install hash>/…`; see docs/server-in-cluster.md). A
node-side pod writes it and marks it complete with a `.yaac-store-done`
file written last. It lives outside the project tree because that pod
writes it as root, and the server's uid could not delete it on project
removal. A one-shot cleanup pod removes a project's node-local tree
instead.

Generations are write-once. Workspace create pins the newest complete
generation's path into the pod spec, so a running engine's store never
changes. The writer's GC reads the live set from pod specs: a generation
can be deleted once no pod mounts it.

**The writer pod** builds nothing. It pulls what the registry holds and
lays it out on a node path, so it is not a trust-split builder pod and has
none of their identity. It only reuses their pinned `quay.io/podman/stable`
image. Like the pods that write `hosts.toml`, it runs on runc as plain
root, pinned with `nodeName`, tolerating every taint, with the store path
hostPath-mounted read-write. Two choices matter:

- **hostNetwork.** The project registry's ingress policy already admits the
  node's addresses for containerd pulls. On the host network the writer is
  the node, so it needs no NetworkPolicy of its own. It addresses the
  registry by ClusterIP, because the node does not use cluster DNS.
- **No CAP_SYS_ADMIN.** `podman pull --root` does not need it (a pull
  untars into the layer directory and mounts nothing). Withholding it is
  what makes the opaque-directory rewrite below possible.

**A refresh** works like this:

1. Seed from the previous generation with `cp -al`, so a new generation
   costs disk only for what changed. A pull only adds layer directories
   and rewrites metadata by temp file and rename, never editing a layer in
   place. podman's own database is not copied, because it records the
   graphroot path it was created under and refuses to open anywhere else.
2. Pull the project's working set, restore each named image's bare name,
   and leave the `yaac-cache-` chain entries untagged, as a local
   `--layers` build leaves its intermediates.
3. Assert every layer has a recorded diff size. Without one, `podman
   images` recomputes it by decompressing the layer through the gofer,
   which makes `images` take minutes.
4. Rewrite opaque directories (below).
5. Write the `.yaac-store-done` marker.

**Which generations are pulled.** In yaac-built repos with content-hash
tags (the repos registry retention governs), the writer takes only the
newest `CACHED_GENERATIONS_KEPT` tags, ranked by the build time in each
image's config, and skips the chain slots of the rest. Other repos are
pulled whole. A generation whose config cannot be fetched ranks as newest,
so a transient failure never drops the one the next build would hit.

**The opaque-directory rewrite.** A layer that replaces a directory records
that as an overlay xattr on the directory, and neither spelling survives
into a workspace:

- `trusted.overlay.opaque` cannot be read through gVisor's gofer (every
  `trusted.` read returns EOPNOTSUPP).
- `user.overlay.opaque` is readable, but the workspace engine holds
  CAP_SYS_ADMIN in the sandbox, so containers/storage mounts overlay
  without `userxattr` and looks for the `trusted.` name.

Either way the marker is ignored and the replaced directory's old files
reappear. The image is silently wrong, not just slow. So the writer
replaces every opaque marker with the explicit per-entry whiteouts it
stands for, computed against the layer's own (write-once) parent chain.
Whiteouts are 0:0 character devices, which the gofer passes through, as it
does `security.capability` file caps. The writer runs without
CAP_SYS_ADMIN so that containers/storage records the markers in the
`user.` namespace, where the rewrite can read them. A per-layer marker
file, hardlinked forward by `cp -al`, makes the pass walk each layer once
in the store's life.

**When it refreshes.** The `image-store` reconcile step refreshes each
project on a throttle, and immediately after a salvage that pushed
something. A refresh that publishes nothing retries sooner, because the
usual cause is racing the registry's maintenance rollout, which lasts
seconds. If the registry is unreachable the refresh fails rather than
publishing an empty store, so the last good generation stays mounted.

A prewarmed spare carries the generation that existed when it was
created, so it may run slightly colder than a fresh create. A cold node
mounts nothing; the image bakes in an empty `/var/lib/shared-images`, which
containers/storage treats as no images. The postStart script runs a
background `podman image ls` so the engine's one-time walk of the store
happens before the agent needs it.

Both halves are best-effort. A cold cache only ever costs a rebuild.

### Registry GC

Salvage reuses tags, so each rebuild leaves the previous manifest
untagged. A salvage also deletes chain slots a shorter rebuild no longer
fills. The `registry-gc` reconcile step then reclaims untagged manifests
with `registry garbage-collect --delete-untagged`.

Content-hash tagged repos (`yaac-tools:<hash>`) add a new tag per source
change, so the collect first runs a retention pass keeping the newest
`REGISTRY_GENERATIONS_KEPT` per repo. It only touches yaac-built repos and
content-hash tags, so a workspace's `myapp:v1` and the `yaac-cache-…`
slots are never retired. Retention is by age, not use: a workspace whose
generation has been passed by that many newer ones would fail to pull on
a pod restart. The budget is sized to make that rare.

`garbage-collect` is only safe when nothing is pushing, since a push that
has uploaded blobs but not its manifest looks like garbage. An active
project never goes idle, so the collect uses a **read-only maintenance
window** instead: the Deployment is rolled with
`REGISTRY_STORAGE_MAINTENANCE_READONLY` set, so pulls keep working while
pushes and deletes return 405. A salvage that lands in the window fails
and retries next cycle. The cost is two `Recreate` rollouts, a few seconds
of downtime each. The env var is written as an inline YAML map, because
the `…_READONLY_ENABLED` form makes registry 2.8 panic at boot.

The collect holds `ensureProjectRegistry`'s per-project mutex (so no
workspace create starts mid-collect), handles one project per pass, runs
detached, and always restores serving mode. Its throttle is timed from the
registry Service's `creationTimestamp` rather than server uptime. A new
registry has no garbage yet and is busy serving the workspace that created
it, and a server restart neither triggers nor delays a collect.

## CA trust: the combined bundle

Nested containers must trust the workspace's MITM proxy for hosts it
intercepts, and the real public roots for hosts it tunnels. CA settings
come in two incompatible shapes:

- **Additive** variables add our CA to the image's roots: `SSL_CERT_FILE`
  (OpenSSL still reads `/etc/ssl/certs`) and `NODE_EXTRA_CA_CERTS`.
- **Replacing** variables name a single file that becomes the tool's whole
  trust set: `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `CARGO_HTTP_CAINFO`,
  `GIT_SSL_CAINFO`. These are the only settings curl, Python `requests`,
  Cargo and git honor.

Pointing a replacing variable at the proxy CA alone breaks every tunnelled
host (npm, PyPI, crates.io, distro mirrors, docker.io, quay). Pointing it
at the public roots alone breaks every intercepted host. It needs the
union.

So a PEM of `{public roots} + {proxy CA}` is built at runtime and the
replacing variables point at it:

- The roots come from the proxy image's `ca-certificates` package, so they
  stay current with no separate upkeep. `combineCaBundle(roots, ca)`
  (`k8s/proxy/ca-bundle.ts`) concatenates them, and the proxy writes the
  result next to its CA in the `yaac-proxy-ca` Secret on every boot
  (docs/workspace-egress.md).
- The server copies `proxy-ca.pem` (bare CA) and `ca-bundle.pem`
  (combined) from that Secret into the `yaac-proxy-ca` ConfigMap that
  workspace pods mount, skipping the write when nothing changed. A roots
  update needs no image rebuild.
- The ConfigMap mounts at `/etc/yaac/certs`. The nestable image's
  `containers.conf` passes both files into nested containers through
  `[containers] volumes`, and sets the same variables through
  `[containers] env`: additive ones to the bare CA, replacing ones to the
  combined bundle.

### Build-time drop-in

Environment variables do not reach `docker build` RUN steps: buildah
applies `containers.conf [containers] volumes` to builds but not
`[containers] env`. So the bare proxy CA is also bind-mounted into builds
as `/usr/local/share/ca-certificates/yaac-proxy-ca.crt`. When a build runs
`update-ca-certificates` (as `apt-get install ca-certificates` and many
package triggers do), it merges the drop-in into the image's roots, and
curl then trusts both by default.

The drop-in is a source cert rather than a bind mount over
`/etc/ssl/certs/ca-certificates.crt`, because `update-ca-certificates`
replaces that file with `rename()`, which fails with EBUSY on a mount
point. A build that calls a MITM'd host without ever refreshing
`ca-certificates` is not covered at build time.

Tools that ignore both the OS store and every CA variable need their own
import: Java (its own `cacerts` keystore), rustls-based clients, and GnuTLS
`wget`.

## Per-project push registries

Each project gets a plain `registry:2` that carries the cross-workspace
image cache. It has no upstream access; nested `docker pull` goes through
the MITM proxy, not this registry.

- Plain HTTP on port 5000, blobs on a per-project RWO PVC, running as plain
  root (trusted infrastructure, like the proxy). The image is
  digest-pinned and mirrored into the main yaac registry.
- **One per project**, because `registry:2` has no per-path access control:
  a shared writable registry would let one project overwrite another's
  tags. Within a project it is a shared namespace by design: any workspace
  can push a name (including an upstream one like `postgres:16`) that
  later nested workspaces of the project then resolve locally.
- **Named by the project's immutable id** (`yaac-reg-<id>`, with its PVC,
  policies and one-shot pods named after it), as is the node-local store
  (`shared-images/<id>`). A project re-added under a freed slug gets a new,
  empty registry and store, even if the old project's removal failed.
- **Three NetworkPolicies**:
  - an allow policy from the project's workspaces to its registry (the pod
    must carry the project's `yaac.project-id` label and a
    `yaac.workspace-id` label, which keeps the registry pod itself out);
  - deny-all egress on the registry pod;
  - an ingress lock on the registry pod admitting only same-project
    workspaces and the nodes' addresses (an `ipBlock`, for containerd
    pulls and the kubelet probe).
- **Lifecycle**: `ensureProjectRegistry` creates it when a
  `nestedContainers` workspace is created; project removal deletes it. The
  `orphan-registry-gc` reconcile step deletes any of this install's
  registries whose project id no live project holds (or that have no id),
  which catches every removal that failed.

### Service addressing

The proxy and project registry Services keep their allocator-assigned
ClusterIPs because they are never deleted (`kubectl apply` updates them in
place). Workspace pods reach them by service-DNS name through the proxy's
DNS, which forwards `*.cluster.local` to CoreDNS and blocks bare `.svc`
names so DNS cannot carry data out. The node does not use cluster DNS, so
the registry's `hosts.toml` under `/etc/containerd/certs.d/` maps its
service-DNS host to the live ClusterIP. It is rewritten on every ensure
and read on every pull, so containerd never needs a restart.

## Egress

Nested containers share the workspace pod's network namespace, so their
pulls and build traffic take the normal workspace egress path with no
extra wiring. netd redirects the pod's outbound 443/80/ssh traffic at its
veth to a node-local Envoy, which adds a PROXY-protocol header carrying the
source IP and forwards to the proxy. The proxy maps that IP to a workspace
by the pod's `yaac.workspace-id` label (docs/workspace-egress.md).

For nested workspaces, the server's proxy registration adds
`NESTED_PULL_HOSTS` (docker.io, ghcr.io, quay.io and their CDNs) to the
allowlist. Anything else not on the allowlist is denied. The project
registry on port 5000 bypasses the proxy: it is reached by service-DNS name
and admitted by the per-project NetworkPolicy.

## cluster check

`yaac cluster check` has a warn-level `nested-mount` probe: under the
nested securityContext, root inside the sandbox must be able to `mount -t
tmpfs`, which the rootful engine requires. The `gvisor` gate and the
`runtime-stamp` sweep cover all workspaces, nested or not.

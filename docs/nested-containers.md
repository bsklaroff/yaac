# Nested containers on the Kubernetes backend

How in-pod podman, the combined CA bundle, per-project push registries,
per-session vclusters, and yaac-in-yaac work on yaac's Kubernetes backend.
This is a current-state reference for the shipped subsystem.

Two opt-in capabilities are layered here:

- **`nestedContainers`** — an in-pod rootful podman (real root inside the
  gVisor sentry, the upstream docker-in-gvisor shape) so `docker build` /
  `docker run` / `docker compose up --build` work inside a session exactly
  as a project README instructs (the `docker` CLI talks to podman's
  Docker-API socket). Non-nested sessions are byte-for-byte unchanged.
- **`virtualCluster`** — each session also gets its own vcluster plus a
  per-project push registry. Implies `nestedContainers` (the in-pod podman
  is the session's only build engine).

Both are config-only, set in `yaac-config.json`; there is no `--vcluster`
CLI flag. `virtualCluster: true` forces `nestedContainers: true`, and an
explicit `virtualCluster: true, nestedContainers: false` is a parse error.

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
helper caps, keyring/pivot_root workarounds) is needed. When a session is
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
- **cross-session image cache**: no extra mount — the project's registry
  is the cache (below), so a nested session can be scheduled on any node.

The pod's postStart setup script (`session-bin/yaac-session-init`) starts
the engine in the background with one sudo'd shell: `podman system
service` as root, a socket wait with a log-tail diagnostic on timeout,
then handing the socket to the `yaac` user so both CLIs
(`DOCKER_HOST`/`CONTAINER_HOST` → `/run/podman/podman.sock`) drive it;
session-create gates on `docker version` over the stream relay before
handing the session over. The service exports `BUILDAH_ISOLATION=chroot`:
under buildah's default OCI isolation the sentry breaks the `RUN`-step
stdio relay after tens of KB of output (EPIPE kills chatty steps like
`apt-get`), while chroot isolation streams fine, keeps `RUN` on the pod
netns, and holds setcap file caps on the tmpfs graphroot. Nothing
supervises the engine: if it dies mid-session, the session is degraded
until recreated.

### Image cache (cross-session build cache)

A session's built and pulled images are salvaged into the **project's own
registry**, and pulled back into the next session's engine, so `docker
build` gets real layer-cache hits across a project's sessions. The registry
is the only distribution mechanism: there is no node-local store, so
nothing ties a session to the node its predecessor ran on. Every nested
session therefore ensures the per-project registry, not just
`virtualCluster` ones — an inner yaac is the exception (its vcluster
denies the registry's node hostPath), and its sessions run uncached.

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
store holds both types: the session's `docker` is the real Docker CLI
against podman's Docker-compatible API, so `docker build` emits
docker-schema2, while a bare `podman build` emits OCI. A push must
therefore hand each image back as what it was, and the compression format
decides that — schema2 has no zstd layer media type, so a zstd push
silently rewrites a schema2 image as OCI and every later `docker build`
skips the whole primed cache. gzip has media types in both schemas, so it
leaves either in place and the image id survives the round trip
unchanged. Level 1 within gzip, because this compression runs inside the
session sandbox where CPU is the scarce resource and the bytes land in a
node-local registry.

One salvage is two sudo-gated execs:

1. **Survey** — list the engine's images with their parents, names, and
   the pod's ledger of refs it has already pushed or pulled.
2. **Push** — the server plans `id → destination` pairs from that survey
   and hands them to a push script as validated argv. Each named image
   goes under its own name (`<registry>/<repo>:<tag>`), stripped of
   podman's `localhost/` local-registry prefix so that one image is one
   repo whichever side pushed it — the server's own pushes into this
   registry use the bare tag, and the pull side's restore round-trips
   back through the prefix. Its ancestor chain goes into the SAME repo
   under `yaac-cache-<tag>-<n>` tags: those
   intermediates are what a step-by-step `docker build` matches, and
   tagging them per named image keeps the tag set bounded — a rebuilt
   `app:v1` overwrites its own chain tags instead of adding a generation.
   Blobs are already in the repo by then, so the chain uploads manifests
   only. Successful pushes append to the ledger, so the 10-minute
   reconciler never re-compresses what it already sent.

The pull side (`primeSessionImages`) runs once during session setup, right
after the engine-ready gate: it walks the registry catalog, pulls each
tag, restores each named image's original name, and untags the
`yaac-cache-` entries so they sit in the store as dangling cache entries
exactly like a local `--layers` build's. It stops early once the graphroot
passes half full — pulled layers live in the session's 10GiB sentry tmpfs,
which the session's own builds have to share, so an oversized project
cache degrades to a partial warm-up instead of ENOSPC'ing the engine.

Stopping at half full bounds what the prime *spends*; a second rule bounds
what it spends it *on*. A repo holds up to `REGISTRY_GENERATIONS_KEPT`
content-hash generations and the catalog walk reaches them in no
meaningful order, so the prime first ranks a repo's content-hash tags
newest-first — by the build time in each image's own config, the same
"content-hash tags are write-once, so creation order is generation order"
the retention pass leans on — and keeps only the newest
`PRIME_GENERATIONS_KEPT`, dropping the chain slots of the generations it
drops with them. Without it a session can spend its whole budget on
generations no build will cache-hit and then ENOSPC building the one it
needs.

What counts as a generation is the retention pass's guard, both halves:
a yaac-built repo (optionally under a push prefix) carrying a content-hash
tag. The upstream mirrors and a session's own repo are left alone even
when their tags happen to have the content-hash shape — a repo retention
has no say over is not one the prime narrows either. A generation whose
config will not scrape ranks NEWEST rather than oldest: ranking is
best-effort, and one transient fetch failure must not be what costs a
session the generation its next build would have cache-hit.

Both directions are best-effort and self-gating (no podman, no sudo, or no
registry ⇒ a single cheap exec that does nothing); a cold cache only ever
costs a rebuild. Salvage runs **mid-session** (a periodic reconciler, so a
project's large first salvage lands during the run) and at **session
cleanup**, before the Job is deleted.

Destinations carry no content hash: they are name-for-name, and the chain
tags are slots keyed by (repo, tag, depth). That is what bounds the tag
set, and it makes concurrent sessions of one project last-salvage-wins on
a shared name — the same semantics the node-local store's tag restore had.
Nothing corrupts (layers are content-addressed and a manifest PUT is
atomic), and a chain left interleaved between two sessions costs a wasted
pull, never a wrong cache hit: buildah matches a cache candidate on layer
parentage *and* history, so a foreign intermediate never matches.

### Registry GC

A salvage also retires chain slots a shorter rebuild no longer fills
(`DELETE /manifests/<digest>`, bounded by contiguity), so a stranded tail
cannot make every future prime pull dead intermediates.

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
session's own `myapp:v1` and the cache's `yaac-cache-…` slots can never
match. Everything else tagged is left alone: a tag in this registry is a
promise to whoever pulls it.

Retention is age-based, not liveness-based: a session pinned to a
generation that has since been passed by `REGISTRY_GENERATIONS_KEPT` newer
ones loses pullability, and its vcluster's synced pods would
ImagePullBackOff on a restart. The budget is sized to make that rare — it
is the width of the concurrently-live fleet, not a rebuild depth — but
closing it properly would mean checking the tags live sessions actually
reference before retiring.

`garbage-collect` is only safe when nothing can be pushing — a push that
has uploaded blobs but not yet its manifest is indistinguishable from
garbage. Upstream's answer is "read-only mode, or not running at all", and
not-running is unusable here: an active project's session count never
reaches zero, so a collect gated on idleness would never run for the
registries that actually grow. The collect therefore takes a **read-only
maintenance window** — the Deployment is rolled with
`REGISTRY_STORAGE_MAINTENANCE_READONLY` on, which keeps pulls and the
catalog serving while pushes and deletes answer 405. A salvage push or
retire that lands in the window fails best-effort and is retried next
cycle (the ledger and the retired-shape memo only record what succeeded),
while pulls — what a live session and its synced pods depend on — keep
working. The cost is two `Recreate` rollouts, a few seconds of
unavailability at each edge of the window.

It holds the same per-project mutex `ensureProjectRegistry` takes, so a
session create cannot start mid-collect; it is throttled per project, runs
one project per pass, detaches (reconcile steps run sequentially), and the
restore to serving mode is unconditional so a failed collect never strands
a registry in maintenance mode.

That env var is spelled as an inline YAML map: the `…_READONLY_ENABLED`
form collapses the key to a scalar and registry 2.8 panics at boot.

## CA trust: the combined bundle

Nested containers must trust the session's MITM proxy on the hosts it
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

A plain `registry:2` per project serves as the push-and-serve image source
for vcluster synced pods and yaac-in-yaac. It has no upstream egress —
nested `docker pull` goes through the MITM proxy, not this registry.

- Plain HTTP on **:5000**, node-local hostPath storage, plain root
  (trusted infra, like the proxy). The `registry:2` image is digest-pinned
  and mirrored into the yaac registry.
- Ensured for every **nested** session (it also carries their cross-session
  image cache), not only `virtualCluster` ones — except inside an inner
  yaac, whose vcluster denies the node hostPath the registry storage needs;
  those sessions simply run without a cross-session cache.
- **Per project, not shared**, because `registry:2` has no path ACLs: a
  shared writable registry would let one project overwrite another's tags.
- Three policies: a sessions→registry allow k8s NetworkPolicy (podSelector
  requires the project label *and* a `yaac.session-id`, keeping it off the
  registry pod itself), a deny-all egress k8s NetworkPolicy on the registry
  pod, and a NetworkPolicy ingress lock confining the registry pod's
  ingress to same-project sessions plus the host/remote-node entities.
- Node containerd reaches it via a `hosts.toml` under
  `/etc/containerd/certs.d/` (see Service addressing below).
- Lifecycle: created from session-create when `virtualCluster` is on,
  removed on project removal, orphan-GC'd at server start.

### Service addressing

The proxy, per-project registry, and vcluster API Services all use
**allocator-assigned ClusterIPs**. They are stable because the Services
are never deleted or recreated: `kubectl apply` reconciles drift in place,
so the immutable ClusterIP is allocated once and never migrates. The
server reads the live IP whenever it needs one (at pod-create, and when
writing the node `hosts.toml`).

- **In-cluster clients** (session pods, synced pods) reach these Services
  by their service-DNS names, resolved through the proxy's split-horizon
  DNS: the proxy forwards `*.cluster.local` to cluster CoreDNS and
  sinkholes bare `.svc` to avoid a DNS-exfil channel. No `hostAliases`,
  no pinned VIP.
- **The node** is not a cluster-DNS client, so containerd needs the IP
  directly: the registry's `hosts.toml` maps its service-DNS host to the
  live ClusterIP, rewritten on every ensure (read per-pull, no containerd
  restart) so it always tracks the allocator-assigned IP.

## Per-session vclusters (`virtualCluster`)

An OSS vcluster (k8s distro, embedded SQLite on an emptyDir, no PVC) per
session:

- **Render**: `helm template` against a vendored, pinned chart tarball
  (`k8s/vcluster/`) with per-session `--set` overrides; helm is fetched on
  demand. The API Service exposes the API on **8443**, reached by its
  service-DNS name (see Service addressing); the serving-cert SAN and the
  exported kubeconfig use that name, so the ClusterIP need not be pinned.
  `defaultImageRegistry` points at the yaac registry; vcluster images are
  digest-pinned and mirrored. Every synced pod is stamped with
  `yaac.session-id` so the egress backstop confines it for free.
- **VAP guard** (synced-pod containment): a ValidatingAdmissionPolicy +
  per-session binding restricts hostPath volumes to the session's
  nested-yaac dir and denies hostNetwork/hostPID/hostIPC/hostPorts/
  privileged; added capabilities are allowed only behind the gVisor sentry
  tier (except `NET_BIND_SERVICE`). It is applied **before** the syncer
  exists (so the first synced
  pod, CoreDNS, is already covered) and fails closed when the VAP API is
  missing.
- **Policies**: a per-session NetworkPolicy admitting the session pod to
  the vcluster API and intra-session traffic, plus a NetworkPolicy
  locking the control-plane pod's egress (it holds host-API creds).
- **Wiring**: created from session-create; the kubeconfig is polled out of
  the `vc-<name>` Secret and dir-mounted at `~/.kube`. Orphan GC +
  kubeconfig heal run as a background-loop tick; `SessionDetail` carries a
  `virtualCluster` status block. The tmux-keyed reaper is untouched, so a
  vcluster pod OOM never kills the session.

## yaac-in-yaac

A `virtualCluster` session can run an **inner yaac** (`YAAC_NESTED=1`)
against its vcluster, creating inner sessions with their own proxy and
allowlist. session-create mounts the nested-yaac data dir at the identical
absolute path in the pod (so inner synced-pod hostPaths resolve and match
the VAP allowlist prefix) and sets `YAAC_NESTED=1` plus the registry
override. The recursion cap rejects `virtualCluster && YAAC_NESTED` — no
vcluster-in-vcluster, so there is exactly one nesting level.

### Inner egress: the inner install claims, the host programs

Each inner session's egress is **transparently** redirected to the inner
proxy, and chains through the outer proxy for anything the inner allowlist
doesn't specially handle. Allowlists compose by intersection (inner ∩
outer), fail-closed at both layers. "Transparent" means the inner yaac runs
the **same** code path as a top-level yaac (one API target, its vcluster)
with **no host-cluster credentials in the session pod**.

The redirect itself is netfilter on a node, which a vcluster does not have
and whose tenant must never be given authority over. So the decision and the
enforcement are split, and the inner install owns the decision:

- The inner install applies the **same netd DaemonSet** the outer one does,
  in **claim mode**: one unprivileged container (no `hostNetwork`, no
  capabilities, no Envoy) that runs the same rule-1 selection over its own
  API and writes the result to a ConfigMap in its own namespace. Its
  readiness means "my claim is published", so `cluster check`'s `datapath`
  row means something inside a vcluster too.
- The **vcluster syncer** copies that ConfigMap to the host namespace — the
  claim-mode pod references it as a volume, which is what makes a
  `configMaps.all: false` syncer copy it. Nothing reads the mount. No
  component ever dials a vcluster's API for this, so the bridge cannot wake
  a sleeping vcluster.
- The **outer server** validates each claim against the host's own pod list
  and republishes the survivors as `yaac-redirect-claims` in the install
  namespace. netd's rule-2 input is therefore an outer-authored object: a
  privileged daemon never parses tenant data.
- The **host netd** re-validates and programs. It picks one egress target
  per pod, recomputed on every relevant event:

1. A session pod in the install namespace → that install's **outer** proxy.
2. A vcluster-synced pod whose pod IP a validated claim names → the claiming
   install's proxy **pod**.
3. Any other synced pod — including a claimed proxy itself, and every pod no
   claim names → the vcluster's owning install's **outer** proxy.

Rules 2 and 3 are scoped to vcluster namespaces the install owns (the server
names them `<install namespace>-vc-<vcluster>`). netd sees every namespace,
and several installs share a node, so an unscoped netd would redirect a
sibling install's synced pods at its own proxy.

Rule 3 is what gives synced pods working, allowlisted egress from the moment
they exist (before any inner yaac), and what makes chaining loop-free: a
claimed proxy is never a source, so its own upstream dials ride rule 3 to
the outer proxy. Publishing a claim IS an install's opt-in signal —
publishing flips its pods to rule 2, withdrawing it (or losing the proxy pod
the claim names) reverts them on netd's next pass.

Several inner installs can share one vcluster (the ambient nested server
plus any per-run e2e servers). Each runs its own claim-mode netd in its own
namespace and publishes its own claim, identified by the `install` field
(its data-dir hash); when two claims name the same pod, the lowest hash wins
so the rendering never flaps.

Data path for an inner-session pod's outbound request:

1. netd's per-pod DNAT rule sends it to the install's node-local Envoy
   listener trio, where a filter chain matching the pod's source IP picks
   the **inner** proxy's cluster (rule 2 above).
2. Envoy recovers the original destination, stamps PROXY-protocol-v2 with
   the pod's real source IP, and forwards to the claimed inner proxy pod.
   The inner proxy resolves that IP to an inner session via its stock
   pod-watch on the vcluster API (a vcluster pod's `status.podIP` is its
   host IP) → inner allowlist → MITM/judge.
3. The inner proxy dials the upstream. Its own egress rides rule 3 →
   **outer proxy** → outer allowlist → internet. The inner proxy trusts
   the outer CA via a projected ConfigMap.
4. Net: inner ∩ outer, fail-closed at both layers, no proxy code change.

The vcluster namespace still carries its own **NetworkPolicy** objects,
applied by the outer server at vcluster-creation time: the synced-pod
egress floor (the unforgeable containment boundary), the inner-proxy
ingress lock, and the synced session-pod ingress lock. These are static —
they name only the vcluster and its owning session — so they ship with the
namespace rather than being reconciled per pass. A claim-mode netd needs no
policy object of its own: the egress floor already admits the vcluster API.

### Why claims, not a privileged inner netd

A netd that programs netfilter needs the node: `hostNetwork`, `NET_ADMIN`,
the node's route table. A synced pod asking for any of that is denied by the
vcluster's own ValidatingAdmissionPolicy, and must be — a netd driven by an
API whose tenant is cluster-admin could be told a sibling session's pod IP
(pod `status` is writable inside a vcluster) and would DNAT that session's
veth. Claim mode asks for nothing the guard would have to except.

Choosing exactly one target per pod also means there is no precedence to
reason about: the selection IS the decision, evaluated in ordinary code that
unit tests can pin, and adding a nesting level would change nothing. And an
inner yaac still applies **no** datapath object to the host — its claim is a
core-API ConfigMap, so its vcluster needs no CRD schemas of any kind.

### Trust model

- The inner yaac/session pod holds **no host credential**
  (`automountServiceAccountToken: false`, vcluster-only kubeconfig); it can
  only write to its vcluster. Tenant-authored NetworkPolicies inside the
  vcluster stay unsynced, so they never reach the host.
- **netd is not a policy engine.** It programs only the redirect, and its
  rules can only ever *add* reachability toward a proxy. Every allow/deny
  is a plain NetworkPolicy enforced by Calico's Felix, authored solely by
  the outer server from its own trusted builders.
- The synced-pod egress floor is the containment boundary, and it selects
  on the syncer-stamped `managed-by` label a tenant can neither forge nor
  shed. It admits only the node's netd listener range, the vcluster API,
  sibling synced pods, and the outer DNS stub — never raw world.
- **A claim is not authenticated, it is confined.** Inside one session the
  inner yaac and the agent code are the same trust domain, so no claim can
  be attributed to "the real inner yaac"; the claim document is
  tenant-writable and treated as such. What makes that harmless is the
  invariant both the server and netd enforce: a claim may only name pod IPs
  the HOST reports for that one vcluster's synced pods, which host IPAM
  assigns and a tenant cannot mint. The worst a forged claim achieves is
  aiming the tenant's own pods at the tenant's own pod, whose egress still
  rides rule 3 to the outer proxy under the outer allowlist.
- **Never a ClusterIP.** A claim naming a Service VIP would be dereferenced
  by kube-proxy from the node's host netns, where a tenant-authored
  Endpoints object can name any address on the internet and no
  NetworkPolicy applies — an egress tunnel with no allowlist. Targets are
  pod IPs, checked against the cluster pod CIDRs and against the live pod
  list, for exactly this reason.
- Bounded by construction: at most 64 claims per vcluster and 512 sources
  per claim, so a tenant-writable document cannot amplify netd's rule count.

## Egress integration

Session egress is the netd / pod-watch model, not in-pod iptables. netd
DNATs a session pod's outbound 443/80/ssh-sentinel at its veth to a
node-local Envoy, which stamps the source IP into a PROXY-protocol
preamble and forwards to the proxy's transparent listeners; the proxy
resolves source-IP → session by reading the pod's `yaac.session-id` label
off a pod-watch. Nested containers share the session pod's netns, so their
`docker pull`/build traffic rides the same path with zero extra wiring;
the proxy auto-appends the upstream registry + CDN hosts (docker.io,
ghcr.io, quay.io and their CDNs) to the allowlist for nested sessions, and
anything else is denied fail-closed. A vcluster's synced pods are confined by their
namespace's own synced-pod egress floor (they carry the syncer's
`managed-by` label, which no tenant can shed). In-cluster destinations (registry :5000, vcluster API :8443) are
reached by their service-DNS names (Service addressing above) and admitted
by the per-project / per-session NetworkPolicies.

## cluster-check probes

`yaac cluster check` gains a warn-level `nested-mount` probe (in-sandbox
root runs `mount -t tmpfs` under the real nested containment — the sentry
prerequisite for the rootful engine) and a `vap` row, on top of the
`gvisor` gate and `runtime-stamp` sweep. Nested (`YAAC_NESTED=1`)
cluster-check skips the host-only gates — except `datapath`, which becomes
the inner install's own half of it: its claim-mode netd must be publishing.
That is warn-level while nothing is deployed (netd lands with the inner
proxy on first session create) and a failure once a deployed one is not
Ready, which is the silent case — the install believes it governs its
sessions' egress and does not.

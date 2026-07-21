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
- **shared cross-session image store**: a node-local hostPath mounted rw
  at `/var/lib/shared-images` as a podman `additionalimagestores` entry.
  The rootful engine reads it and the promoter writes it, both as root.

session-create starts the engine with one sudo'd exec: `podman system
service` as root, a socket wait with a log-tail diagnostic on timeout,
then handing the socket to the `yaac` user so both CLIs
(`DOCKER_HOST`/`CONTAINER_HOST` → `/run/podman/podman.sock`) drive it. The
service exports `BUILDAH_ISOLATION=chroot`: under buildah's default OCI
isolation the sentry breaks the `RUN`-step stdio relay after tens of KB of
output (EPIPE kills chatty steps like `apt-get`), while chroot isolation
streams fine, keeps `RUN` on the pod netns, and holds setcap file caps on
the tmpfs graphroot. Nothing supervises the engine: if it dies
mid-session, the session is degraded until recreated.

### Image promoter (cross-session build cache)

The promoter salvages a session's built/pulled images into the project's
shared store, giving real `docker build` layer-cache hits across a
project's sessions. Extracting layers file-by-file through the gVisor
gofer is prohibitively slow (~2ms/file, so a 4GB node_modules-heavy chain
takes 16+ minutes), so the pipeline splits at the sandbox boundary:

1. **In-pod** (one sudo-gated exec): survey the engine's images, diff
   against the store (visible in-pod through the read-only additional-store
   mount), and `podman save` the missing ones as a single multi-image tar
   into the store directory — a bulk sequential gofer write, not a per-file
   storm.
2. **Node-side**: a one-shot writer pod on a digest-pinned
   `quay.io/podman/stable` image (hostPath-mounting the store) runs
   `podman --root <store> load` to extract at native speed, restore tags,
   and prune. It runs yaac-shipped commands on a pinned upstream image —
   never the session's user-customizable image, which must not execute as
   root outside the sandbox.

Serialization is a real host flock in the store directory (the writer is a
node-side runc pod, so kernel locks work). The store GC retires to two
tagged generations with a 2h dangling-prune floor (the floor keeps a
mid-build salvage's temporarily-dangling chain safe). Salvage runs
best-effort both **mid-session** (a periodic reconciler, so a project's
large first salvage lands during the run) and at **session cleanup**.

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

## Per-project push registries (`virtualCluster` only)

A plain `registry:2` per project serves as the push-and-serve image source
for vcluster synced pods and yaac-in-yaac. It has no upstream egress —
nested `docker pull` goes through the MITM proxy, not this registry.

- Plain HTTP on **:5000**, node-local hostPath storage, plain root
  (trusted infra, like the proxy). The `registry:2` image is digest-pinned
  and mirrored into the local registry.
- **Per project, not shared**, because `registry:2` has no path ACLs: a
  shared writable registry would let one project overwrite another's tags.
- Three policies: a sessions→registry allow k8s NetworkPolicy (podSelector
  requires the project label *and* a `yaac.session-id`, keeping it off the
  registry pod itself), a deny-all egress k8s NetworkPolicy on the registry
  pod, and a CiliumNetworkPolicy ingress lock confining the registry pod's
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
  `defaultImageRegistry` points at the local registry; vcluster images are
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
  the vcluster API and intra-session traffic, plus a CiliumNetworkPolicy
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

### Inner egress via server projection

Each inner session's egress is **transparently** redirected to the inner
proxy at higher precedence than the outer redirect, and chains through the
outer proxy for anything the inner allowlist doesn't specially handle.
Allowlists compose by intersection (inner ∩ outer), fail-closed at both
layers. "Transparent" means the inner yaac runs the **same** code path as
a top-level yaac (one API target, its vcluster) with no nesting-aware
branching and **no host-cluster credentials in the session pod**.

The inner yaac targets only its vcluster, including for its Cilium
redirect CRDs (CEC/CNP). Those CRDs don't sync (they are cluster
datapath), so the **outer server** — the sole host cluster-admin — watches
each managed vcluster, recognizes yaac's own redirect shapes, and
**rebuilds** the equivalent host CEC/CNP from its own trusted builders,
re-scoped to the vcluster's `managed-by` selector and retargeted at the
host-synced inner proxy. The session keeps zero host authority, and the
server never copies untrusted policy, so a tenant cannot author an escape.
The rejected alternative (handing the session a host SA token to write
host policy directly) couldn't be transparent and would put a host
credential in the agent's pod.

Data path for an inner-session pod's outbound request:

1. Cilium redirects it via the **override** CNP (higher precedence than
   the fallback) → node Envoy → the host-synced **inner proxy**.
2. The inner proxy reads the PP2 source IP (a vcluster pod's
   `status.podIP` is its host IP) and resolves it to an inner session via
   its stock pod-watch on the vcluster API → inner allowlist → MITM/judge.
3. The inner proxy dials the upstream. Its own egress
   (`yaac.role=inner-proxy`, excluded from the override) is caught by the
   **fallback** redirect → **outer proxy** → outer allowlist → internet.
   The inner proxy trusts the outer CA via a projected ConfigMap.
4. Net: inner ∩ outer, fail-closed at both layers, no proxy code change.

Several inner installs can share one vcluster (the ambient nested server
plus any per-run e2e servers), keyed by the `yaac.data-dir-hash` label
every server stamps on its session pods, proxy Deployment pods, and proxy
Service. A background-loop tick (`reconcileInnerRedirects`) runs one pass
per managed vcluster: discover the host-synced inner-proxy Services (a
Service's presence is that install's opt-in), rebuild one CEC + override
CNP per install plus a shared per-vcluster inner-proxy ingress lock, then
apply and prune by the `yaac.projection=inner-redirect` label (never by
`app` alone, which the untouchable egress floor shares).

### Priority and the fallback CCEC

`toPorts.listener.priority` is **lower = higher precedence**:

- `SESSION_REDIRECT_PRIORITY` (50) is the same value **every** yaac's
  session-egress redirect uses, outer and inner alike — so an inner yaac
  is fully transparent, with no per-level band or nesting-aware priority
  arithmetic. The projected override uses it.
- `VCLUSTER_FALLBACK_PRIORITY` (90) is the outer yaac's low-precedence
  fallback for a vcluster's synced pods → the outer proxy. It gives synced
  pods working, allowlisted egress from the moment they exist (before any
  inner yaac), and the override beats it for the session pods while the
  inner-proxy pod stays on it and chains to the outer proxy (loop-free).

`listener.priority` is undocumented and lower-wins is empirical; a
mandatory e2e pins the explicit-vs-explicit override case and must be
re-run on every Cilium upgrade — treat a regression as a release blocker.

The fallback's redirect **listeners** live in a single shared,
cluster-scoped `CiliumClusterwideEnvoyConfig` (one per install, so the
real install and ephemeral e2e installs coexist), not a per-vcluster CEC.
Creating/destroying a vcluster then adds/removes no Envoy listeners; a
per-vcluster CEC would churn listeners on every session and trigger a
node-wide endpoint regeneration that wedges every session's egress. Each
vcluster still keeps its **own** fallback CNP — the unforgeable egress
floor: default-deny + exactly 443/80/SSH → outer proxy + intracluster/DNS
— referencing the shared CCEC cross-namespace by kind.

### CRD registration in the vcluster

For the inner yaac's `kubectl apply CiliumEnvoyConfig/CiliumNetworkPolicy`
to succeed, the vcluster needs the Cilium CRD schemas — **definitions
only, no operator/agent** (the host Cilium is the only datapath).
`ensureCiliumCrds` installs **permissive**
(`x-kubernetes-preserve-unknown-fields`) CEC/CNP CRDs. In a vcluster these
objects are inert opt-in signals; the server projects the real,
host-enforced redirect. Permissive schemas are safe because the objects
come from yaac's own builders.

### Trust model

- The inner yaac/session pod holds **no host credential**
  (`automountServiceAccountToken: false`, vcluster-only kubeconfig); it can
  only write to its vcluster.
- The **server** is the only writer of host CEC/CNP and always **rebuilds**
  from trusted builders — it never copies tenant-authored policy, so no
  allow-all escape can reach the host. Scope is pinned to `managed-by=<vc>`,
  so a vcluster's override can only affect its own synced pods.
- The override CNPs are a *routing* preference, not the containment
  boundary: the fallback CNP floor already default-denies every synced
  pod's raw world. The override's `yaac.role != inner-proxy` exclusion and
  `yaac.data-dir-hash` key are tenant-forgeable, but forging either is
  non-escalating — a forged label lands the pod on the fallback → outer
  proxy (still allowlisted), or on a sibling install's proxy, which
  fail-closes unknown source IPs. Raw world is never reachable.

## Egress integration

Session egress is the Cilium / pod-watch model, not in-pod iptables. A
node-local Cilium Envoy redirects session-pod egress to the proxy's
transparent listeners and stamps the source IP; the proxy resolves
source-IP → session by reading the pod's `yaac.session-id` label off a
pod-watch. Nested containers share the session pod's netns, so their
`docker pull`/build traffic rides the same path with zero extra wiring;
the proxy auto-appends the upstream registry + CDN hosts (docker.io,
ghcr.io, quay.io and their CDNs) to the allowlist for nested sessions, and
anything else is denied fail-closed. A vcluster's synced pods inherit the
session's `yaac.session-id`, so the `yaac-session-egress-redirect` backstop confines
them. In-cluster destinations (registry :5000, vcluster API :8443) are
reached by their service-DNS names (Service addressing above) and admitted
by the per-project / per-session NetworkPolicies.

## cluster-check probes

`yaac cluster check` gains a warn-level `nested-mount` probe (in-sandbox
root runs `mount -t tmpfs` under the real nested containment — the sentry
prerequisite for the rootful engine) and a `vap` row, on top of the
`gvisor` gate and `runtime-stamp` sweep. Nested (`YAAC_NESTED=1`)
cluster-check skips the host-only gates.

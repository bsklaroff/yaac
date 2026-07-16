# Nested containers on the k8s backend (current-state reference)

How in-pod podman, per-project push registries, and per-session vclusters work
on yaac's kubernetes backend today. This is a reference for the shipped
subsystem, not a proposal — the original milestone plan has been fully
implemented (`6e1fd5d` M0+M1, `36e917b` M2–M4, plus follow-ups). For the
inner/chained-egress story of yaac-in-yaac, see
`docs/yaac-in-yaac-inner-egress.md`; for the proxy-CA trust mechanism in
nested containers, see `docs/nested-ca-combined-bundle.md`.

Two opt-in capabilities are layered here:

- **`nestedContainers`** — an in-pod ROOTFUL podman (real root inside the
  gVisor sentry — the upstream docker-in-gvisor shape) so `docker build` /
  `docker run` / `docker compose up --build` work inside a session exactly as a
  project README instructs (the `docker` CLI talks to podman's Docker-API
  socket). Non-nested sessions are byte-for-byte unchanged.
- **`virtualCluster`** — each session gets its own vcluster plus a per-project
  push registry. Implies `nestedContainers` (the in-pod podman is the session's
  only build engine).

## Config surface

`src/lib/project/config.ts` carries both keys in `KNOWN_KEYS` and parses them
(`config.ts:7,300-326`). `virtualCluster: true` forces `nestedContainers: true`;
an explicit `virtualCluster: true, nestedContainers: false` is a parse error.
`SessionCreateOptions`/`YaacConfig` expose both (`src/shared/types.ts:184-192`).
There is **no `--vcluster` CLI flag** — `virtualCluster` is config-only (set in
`yaac-config.json`); `session create` exposes only `-t/--tool`, `--add-dir`,
`--add-dir-rw` (`src/cli.ts:157-167`).

## Image layer

`dockerfiles/Dockerfile.nestable` (in-pod rootful podman + the `docker` CLI +
the compose plugin) is inserted conditionally into the image chain
(default → tools → **nestable** → project `Dockerfile.yaac`) only when
`nestedContainers` is set; it is skipped for a standalone `Dockerfile.yaac`.
Wiring is in `src/lib/container/image-builder.ts:162,228-238` (the nestable tag
is a content hash of the Dockerfile, so it rebuilds on change). The nestable
image also trusts the proxy CA for every nested container and `docker build` RUN
step via a combined CA bundle (`Dockerfile.nestable:114-137`, see
`docs/nested-ca-combined-bundle.md`).

## In-pod rootful podman (`nestedContainers`)

The engine runs as REAL root inside the gVisor sentry (`gvisor-nested`
RuntimeClass — see `src/lib/k8s/gvisor.ts`). In-sandbox root is a sentry
fiction with no host authority, so the rootless apparatus of the pre-gVisor
era (subuid maps, id-map helper caps, keyring/pivot_root workarounds, the
`/proc` bind) is gone. `src/lib/k8s/pod-spec.ts` gains an optional `nested`
branch; non-nested output is unchanged. When nested the session container/pod
gains:

- **securityContext**: `seccompProfile: RuntimeDefault` plus
  `capabilities.add: NESTED_ENGINE_CAPS` (SYS_ADMIN, SYS_CHROOT, MKNOD,
  SETFCAP, NET_RAW, NET_ADMIN, SYS_PTRACE, SYS_RESOURCE). Under the sentry
  these grant no host authority — the broad in-sandbox caps are the upstream
  docker-in-gvisor posture, and the `gvisor-nested` handler adds
  `net-raw`/`allow-packet-socket-write` for the engine's raw sockets.
- **graphroot**: podman's rootful default (`/var/lib/containers/storage`)
  on a DISK-backed sentry-internal tmpfs (`NESTED_GRAPHROOT_ANNOTATIONS`
  promotes a plain disk emptyDir; the `type: bind` annotation is what
  selects the disk-backed variant — runsc pages the tmpfs against a
  `.gvisor.filestore.*` file inside the emptyDir): gVisor's gofer
  filesystem refuses writes to the `security.*` xattr namespace, so
  `docker build` setcap steps only work on a sentry tmpfs — and the disk
  filestore keeps layer data out of pod memory (reclaimable node page
  cache, not cgroup-pinned tmpfs pages). Root-owned — no fsGroup/chown.
  The sentry's `size=` cap ENOSPCs oversized builds; the emptyDir
  sizeLimit sits above it so kubelet eviction can't fire first.
- **shared cross-session image store**: a node-local hostPath
  (`sharedImageStoreHostPath`) mounted rw at `/var/lib/shared-images`
  (`SHARED_IMAGE_STORE_PATH`) as a podman `additionalimagestores` entry.
  Root-owned `DirectoryOrCreate`; the rootful engine reads it and the
  promoter writes it, both as root, so no chown initContainer exists anymore.

session-create starts the engine with one sudo'd exec: `podman system
service` as root with `SSL_CERT_FILE` exported inside the sudo shell (env_reset
would strip it), a socket wait with a log-tail diagnostic on timeout, then
`chmod 0755 /run/podman && chown yaac` so the yaac user drives the engine
remotely — the image's `DOCKER_HOST`/`CONTAINER_HOST` point both CLIs at
`/run/podman/podman.sock`. The service also exports
`BUILDAH_ISOLATION=chroot`: under buildah's default oci isolation the sentry
breaks the RUN-step stdio relay after a few tens of KB of output (EPIPE kills
chatty steps like `apt-get`; quiet builds pass), while chroot isolation
streams fine, keeps RUN on the pod netns, and holds setcap file caps on the
tmpfs graphroot. Remote builds resolve isolation server-side, so the service
env covers every client (an inner yaac's podman, user `docker build`, compose
`--build`). Nothing supervises or revives the engine: if it dies mid-session,
the session is degraded until recreated.

### Image promoter (cross-session build cache)

`src/lib/container/image-promoter.ts` copies images out of the per-session
graphroot into the shared store with `skopeo copy containers-storage: →
containers-storage:` (run as root via the image's passwordless sudo), three
passes including a 168h dangling prune (the GC story for the store).
Cross-pod serialization is a host-side mkdir lock in the store — NOT flock,
which under gVisor is sentry-local and never reaches the host kernel. It runs
best-effort during cleanup from both paths — `promoteSessionImages` and the
detached `buildPromoterShellCommand` in `src/lib/session/cleanup.ts` — giving
real `docker build` layer-cache hits across a project's sessions.

## Per-project push registries (`virtualCluster` only)

`src/lib/k8s/project-registry.ts` stands up a plain `registry:2` per project as
a push-and-serve target (the image source for vcluster synced pods and
yaac-in-yaac). It has no upstream egress — nested `docker pull` goes through the
MITM proxy, not this registry. Key pieces:

- Deployment/Service builders (`buildProjectRegistryDeploymentManifest`,
  `buildProjectRegistryServiceManifest`); plain HTTP on **:5000**; node-local
  hostPath storage; runs as plain root (trusted infra, like the proxy).
- The registry:2 image is digest-pinned and mirrored into the local registry by
  `ensureRegistryImage` (`project-registry.ts:283`).
- Two NetworkPolicies: a sessions→registry allow (podSelector requires the
  project label **and** a `yaac.session-id`, keeping it off the registry pod
  itself) and a deny-all egress on the registry pod
  (`buildRegistrySessionsNetworkPolicyManifest`,
  `buildRegistryEgressNetworkPolicyManifest`). Per-project (not shared) because
  registry:2 has no path ACLs — a shared writable registry would let one project
  overwrite another's tags.
- Node containerd reachability: at registry creation a hosts.toml is written to
  `/etc/containerd/certs.d/<host>:5000/hosts.toml` → `http://<pinnedVIP>:5000` on
  the kind node (read per-pull, never needs healing — recreation reproduces the
  VIP). In-cluster clients reach the same host string via pod `hostAliases`.
- Lifecycle: `ensureProjectRegistry` from session-create when `virtualCluster`
  is on (`session-create.ts:781`), `removeProjectRegistry` on project removal
  (`src/lib/project/remove.ts:44`), `gcOrphanProjectRegistries` at server start
  (`src/server/cli.ts:335`).

### ClusterIP VIP pinning

Both the registry Service and the vcluster API Service pin their ClusterIP via
`clusterIpForService(namespace, serviceName)`
(`src/lib/k8s/bootstrap.ts:205`), a keyed generalization of the proxy's
`clusterIpForNamespace` that hashes `<namespace>/<serviceName>` across the same
service /16 band, so all pins share one collision budget (the birthday math in
`clusterIpForNamespace`'s docstring at `bootstrap.ts:171` covers them jointly;
`/` can't appear in a namespace name, so a service key never aliases the bare
namespace key). **Pinning is load-bearing, not hygiene**: these VIPs are baked
into pod `hostAliases`, the node hosts.toml, and the vcluster kubeconfig, so
Service recreation must reproduce the VIP by construction. The function is
FROZEN — re-keying it would strand every running session's references
(`bootstrap.ts:195-209`). A pin-vs-pin clash fails loudly at `kubectl apply`,
never a misroute; `yaac cluster check` warns on service-CIDR drift.

## Per-session vclusters (`virtualCluster`)

`src/lib/k8s/vcluster.ts` stands up an OSS vcluster (k8s distro, embedded SQLite
on an emptyDir, no PVC) per session:

- **Render**: `renderVclusterManifests` shells out to `helm template` against the
  vendored chart with per-session `--set` overrides; `ensureHelm` fetches helm
  on demand (`vcluster.ts:130,189`). The API Service pins its VIP via
  `clusterIpForService` and exposes the API on **8443** (`VCLUSTER_API_PORT`).
  `controlPlane.advanced.defaultImageRegistry` points at `localhost:5000`;
  images are digest-pinned in `k8s/vcluster/images.json` and mirrored by
  `ensureVclusterImages`. `sync.toHost.pods.patches` stamps every synced pod with
  `yaac.session-id` so the egress backstop confines it for free.
- **VAP guard** (synced-pod containment): one ValidatingAdmissionPolicy +
  per-session binding (`buildVclusterPodGuardPolicyManifest`,
  `buildVclusterPodGuardBindingManifest`, `vclusterGuardName`) restricts hostPath
  volumes to the session's nested-yaac dir and denies
  hostNetwork/hostPID/hostIPC/hostPorts/privileged; added capabilities are
  allowed only behind the gVisor sentry tier (`runtimeClassName` gvisor /
  gvisor-nested — the syncer stamps gvisor on every synced pod via
  values.yaml, and the VAP is the backstop if that stamp ever regresses).
  The guard is applied **before** the syncer exists (so the first synced pod,
  CoreDNS, is already covered) and `ensureSessionVcluster` fails closed when
  the VAP API is missing (`vcluster.ts:602`, `vapAvailable`).
- **Policies**: a per-session NetworkPolicy admitting the session pod to the
  vcluster API on 8443 and intra-session traffic
  (`buildVclusterSessionNetworkPolicyManifest`), plus a CiliumNetworkPolicy
  locking the control-plane pod's egress
  (`buildVclusterControlPlaneCnpManifest`) since it holds host-API creds.
- **Wiring**: `ensureSessionVcluster` from session-create
  (`session-create.ts:787`); the kubeconfig is polled out of the `vc-<name>`
  Secret, written to `sessionVclusterDir(slug, sid)`
  (`src/lib/project/paths.ts:190`), dir-mounted at `~/.kube` with `KUBECONFIG`
  set. Orphan GC + kubeconfig heal run as a `background-loop` tick
  (`reconcileVclusters`, `src/lib/session/vcluster-reconcile.ts:29`, registered
  at `src/server/background-loop.ts:66`). `SessionDetail` carries a
  `virtualCluster` status block (`src/lib/session/detail.ts:18-69`,
  `getVclusterStatus`). The tmux-keyed reaper is untouched, so a vcluster pod OOM
  never kills the session.

## yaac-in-yaac preset

When `virtualCluster` is on, session-create mounts
`nestedYaacDataDir(slug, sid)` (`src/lib/project/paths.ts:201`) at the identical
absolute path in the pod (so inner synced-pod hostPaths resolve and the path
matches the VAP allowlist prefix) and sets `YAAC_NESTED=1` and
`YAAC_K8S_REGISTRY=<projectRegistryHost>` (`session-create.ts:1071-1076`). The
recursion cap is enforced at `session-create.ts:705`: an inner yaac (running with
`YAAC_NESTED=1`) refuses `virtualCluster` — no vcluster-in-vcluster.
`yaac cluster check` applies `YAAC_NESTED`-gated relaxations
(`src/lib/k8s/cluster-check.ts:207-218`). Inner-session upstream egress (the
chained-egress path) is documented separately in
`docs/yaac-in-yaac-inner-egress.md`.

## Egress integration

Session egress is the **Cilium / pod-watch** model, not in-pod iptables. A
node-local Cilium Envoy redirects session-pod egress to the proxy's transparent
listeners and stamps the source IP; the proxy resolves source-IP → session by
reading the pod's `yaac.session-id` label, keeping a `podIP → sessionId` index
fresh off the pods API (`k8s/proxy/pod-watch.ts`). The CRDs and the
cluster-scoped Envoy config / network policies are managed in
`src/lib/k8s/cilium-crds.ts` (`ensureCiliumCrds`). Nested containers share the
session pod's netns, so their `docker pull` / build traffic rides the same path
with zero extra wiring; the proxy auto-appends the upstream registry + CDN hosts
(docker.io, ghcr.io, quay.io and their CDNs) to the session allowlist for nested
sessions (`src/lib/session/proxy-registration.ts:68-72`), and anything else is
denied fail-closed. The synced pods of a vcluster inherit the session's
`yaac.session-id` label, so the `yaac-session-egress` backstop confines them.
In-cluster destinations (registry :5000, vcluster API :8443) are reached by
their pinned VIPs, admitted by the per-project / per-session NetworkPolicies
above and named via `hostAliases` (in-cluster) / hosts.toml (the node).

## cluster-check probes

`yaac cluster check` gains a warn-level `nested-mount` probe (in-sandbox root
runs `mount -t tmpfs` under the real nested containment — `gvisor-nested` +
`NESTED_ENGINE_CAPS` — the core sentry prerequisite for the rootful engine)
and a `vap` row, plus the `gvisor` gate and `runtime-stamp` sweep described in
`cluster-check.ts`.

## Implementation notes (divergences from the original plan)

- **kubectl** is installed in `dockerfiles/Dockerfile.nestable:42-48`, not in
  `Dockerfile.tools` as originally specified (it is only needed by
  `virtualCluster` sessions, which always carry the nestable layer).
- **vcluster is vendored as a pinned Helm chart tarball**
  (`k8s/vcluster/vcluster-0.34.3.tgz` + `VERSION` + `values.yaml` +
  `images.json`) rendered at runtime via `helm template` (`renderVclusterManifests`
  / `ensureHelm`), regenerated by `scripts/fetch-vcluster-chart.sh` — there is no
  static `k8s/vcluster/manifests.yaml` and no `render-vcluster-manifests.sh`.
- **No `--vcluster` CLI flag** — descoped; `virtualCluster` is set in
  `yaac-config.json` only.
- **The `squat/generic-device-plugin` DaemonSet and `k8s/seccomp-nested.json`
  fallback profile were deliberately not built** — first the namespaced
  `SYS_ADMIN` + `RuntimeDefault` path and now the gVisor sentry (which ignores
  pod seccomp and installs its own host filter) made both fallbacks moot, and
  plain `docker run`/`docker build` need no `/dev/net/tun`.
- **The rootless era is over**: the userns (`hostUsers: false`) + subuid +
  fsGroup-graphroot design this plan originally specified was replaced
  wholesale by the rootful-in-sentry model above when the fleet moved to
  gVisor (`f3109f0`).
- The **obsolete sidecar egress layer** (`yaac-redirect-init` + `yaac-relay`,
  `k8s/redirect-init/`, `k8s/relay/`, `redirect.sh`'s `EXTRA_TCP_ACCEPT`) that
  the original plan composed against **no longer exists** — egress is now the
  Cilium / pod-watch model described above.

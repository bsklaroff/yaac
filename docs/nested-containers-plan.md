# Nested containers on the k8s backend (current-state reference)

How in-pod podman, per-project push registries, and per-session vclusters work
on yaac's kubernetes backend today. This is a reference for the shipped
subsystem, not a proposal — the original milestone plan has been fully
implemented (`6e1fd5d` M0+M1, `36e917b` M2–M4, plus follow-ups). For the
inner/chained-egress story of yaac-in-yaac, see
`docs/yaac-in-yaac-inner-egress.md`; for the proxy-CA trust mechanism in
nested containers, see `docs/nested-ca-combined-bundle.md`.

Two opt-in capabilities are layered here:

- **`nestedContainers`** — an in-pod rootless podman so `docker build` /
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

`dockerfiles/Dockerfile.nestable` (in-pod rootless podman + the `docker` CLI +
the compose plugin) is inserted conditionally into the image chain
(default → tools → **nestable** → project `Dockerfile.yaac`) only when
`nestedContainers` is set; it is skipped for a standalone `Dockerfile.yaac`.
Wiring is in `src/lib/container/image-builder.ts:162,228-238` (the nestable tag
is a content hash of the Dockerfile, so it rebuilds on change). The nestable
image also trusts the proxy CA for every nested container and `docker build` RUN
step via a combined CA bundle (`Dockerfile.nestable:114-137`, see
`docs/nested-ca-combined-bundle.md`).

## In-pod rootless podman (`nestedContainers`)

`src/lib/k8s/pod-spec.ts` gains an optional `nested` branch
(`pod-spec.ts:163-271`); non-nested output is unchanged. When nested the session
container/pod gains:

- **securityContext**: `seccompProfile: RuntimeDefault` plus
  `capabilities.add: ["SYS_ADMIN"]`. The cap is held in the pod's user namespace
  (`hostUsers: false` is already set), so it confers no host authority — it
  exists to let containerd's static RuntimeDefault profile compile the
  mount-family syscalls rootless podman needs for overlay/proc/tmpfs mounts in
  its userns. `allowPrivilegeEscalation` is forced true by the kubelet for any
  CAP_SYS_ADMIN holder (also the existing implicit default).
- **graphroot**: an `emptyDir` at `/home/yaac/.local/share/containers`
  (`NESTED_GRAPHROOT_PATH`), chowned to the session uid via the pod `fsGroup`
  (kubelet chowns ownership-managed volumes only, so hostPath worktree/cred
  mounts are untouched).
- **shared cross-session image store**: a node-local hostPath
  (`sharedImageStoreHostPath`) mounted rw at `/var/lib/shared-images`
  (`SHARED_IMAGE_STORE_PATH`) as a podman `additionalimagestores` entry. It is
  root-owned `DirectoryOrCreate`, so a tiny chown initContainer (`runAsUser: 0`
  = root-in-userns) hands it to the session uid; this init runs **first**, ahead
  of the egress machinery (`pod-spec.ts:235-246`).

A dedicated `podman` tmux window runs `podman system service` so the socket
stays alive across exec sessions; session-create reads `config.nestedContainers`
and passes the flag through `ensureImage` and the `nested` pod-spec params.

### Image promoter (cross-session build cache)

`src/lib/container/image-promoter.ts` copies images out of the per-session
graphroot into the shared store with `skopeo copy containers-storage: →
containers-storage:`, flock-serialized, three passes including a 168h dangling
prune (the GC story for the store). It runs best-effort during cleanup from both
paths — `promoteSessionImages` and the detached `buildPromoterShellCommand` in
`src/lib/session/cleanup.ts:162,238` — giving real `docker build` layer-cache
hits across a project's sessions.

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
  (`src/lib/project/remove.ts:44`), `gcOrphanProjectRegistries` at daemon start
  (`src/daemon/cli.ts:335`).

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
  allowed only under `hostUsers: false`. The guard is applied **before** the
  syncer exists (so the first synced pod, CoreDNS, is already covered) and
  `ensureSessionVcluster` fails closed when the VAP API is missing
  (`vcluster.ts:602`, `vapAvailable` at `vcluster.ts:526`).
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
  at `src/daemon/background-loop.ts:66`). `SessionDetail` carries a
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

`yaac cluster check` gains a warn-level `nested-mount` probe (runs
`mount -t tmpfs` under the nested securityContext in a userns to confirm rootless
podman's prerequisite) and a `vap` row (`cluster-check.ts:90-93,182-183`).

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
  fallback profile were deliberately not built** — the namespaced
  `SYS_ADMIN` + `RuntimeDefault` path unlocked the mount-family syscalls without
  either fallback, and plain `docker run`/`docker build` need no `/dev/net/tun`.
- The **obsolete sidecar egress layer** (`yaac-redirect-init` + `yaac-relay`,
  `k8s/redirect-init/`, `k8s/relay/`, `redirect.sh`'s `EXTRA_TCP_ACCEPT`) that
  the original plan composed against **no longer exists** — egress is now the
  Cilium / pod-watch model described above.

# Reinstate nested containers on the k8s backend (in-pod podman, per-project push registries, per-session vclusters)

## Context

The podman→kubernetes migration (2464a0a) removed `nestedContainers` — the ability to run
`docker build` / `docker run` / `docker compose up --build` inside a session exactly as a
project README instructs. It's currently rejected in `src/lib/project/config.ts`
(`REMOVED_KEYS`, "planned for v2"). This plan reinstates it and adds two adjacent capabilities.
Three user-decided architecture choices shape it:

1. **Nested podman runs directly in the session pod** (decided after weighing a separate
   engine pod / sidecar / kubedock). Builds, runs, and compose all execute in-pod against a
   local rootless-podman socket — a near-direct port of the pre-migration design onto the
   current k8s session spec. Chosen for **simplicity**: no extra Deployment/Service, no docker
   API over TCP, no published-port relay, no ingress policy. `localhost` ports and `-v` bind
   mounts work natively because everything shares the session pod's netns and filesystem.
   - **Accepted tradeoff:** when `nestedContainers` is enabled, the session pod (which also
     mounts the agent's credentials and worktree) carries the userns-scoped `SYS_ADMIN` grant
     and runs build/compose workloads. The containment boundary remains `hostUsers: false`
     (namespaced cap → no host authority) + the fail-closed transparent-egress layer (088bebd:
     in-pod default-deny + the `yaac-session-egress` backstop) +
     `automountServiceAccountToken: false`. We give up the credential/blast-radius isolation a
     separate pod would have bought, in exchange for far less machinery. Non-nested sessions
     are completely unchanged.
2. **Nested image pulls go straight through the yaac MITM proxy; the per-project registry is
   a plain push target** (decided after weighing zot as a multi-upstream pull-through cache).
   When `nestedContainers` is on, the session's proxy allowlist is auto-extended with the
   upstream registry + CDN hosts, so `docker pull` gets proxied, allowlisted, fail-closed
   egress with zero user action — no pull-through registry, no registries.conf remap. The
   per-project registry shrinks to a plain `registry:2` pod (the image the main registry
   already runs), created **only for `virtualCluster` sessions** as the push target node
   containerd can pull from — the image source for vcluster synced pods and yaac-in-yaac. It
   has no upstream egress at all (deny-all egress policy, no proxy pseudo-session, no zot
   config). Per-project NetworkPolicies mean a session only reaches its own project's
   registry (registry:2 has no path ACLs, so a shared writable registry would let one session
   overwrite another project's — or the infra — tags); under the landed egress layer that
   reachability additionally requires an explicit in-pod carve-out (see "In-cluster
   destinations" below) — session egress is default-denied inside the pod, not just at the
   CNI. zot's multi-upstream sync was only needed while the registry also fronted upstream
   pulls; dropping that role drops zot.
   - **Accepted tradeoff:** first pulls are uncached and docker.io rate limits pool on one
     egress IP; the cross-session shared image store + promoter covers repeat pulls.
3. **Per-session vclusters** (opt-in `virtualCluster: true`; implies `nestedContainers` — the
   in-pod podman is the session's only build engine, so a vcluster session without it could
   never build images for its own pods): a session gets a kubeconfig to
   its own virtual cluster; synced pods land in the host `yaac` namespace stamped with the
   session's `yaac.session-id` label → the `yaac-session-egress` backstop confines them
   automatically (fail-closed: no relay, no egress — see Goal C). Backs "a session manages
   its own pods that inherit its network policy" and yaac-in-yaac (no kind-in-kind).

**This plan is written against the landed transparent-egress layer (088bebd)** — not the
draft design that preceded it. The load-bearing facts: every session pod runs
`yaac-redirect-init` (NET_ADMIN under `hostUsers: false`; pod-netns nat REDIRECTs of udp/53 +
tcp/443/80 to loopback, then a filter default-deny whose only egress carve-out is the relay
uid dialing the proxy's pinned VIP — `k8s/redirect-init/redirect.sh`) and a `yaac-relay`
native sidecar (uid 1337, loopback-only listeners 15001/15002/15003 + UDP DNS stub 15004)
that forwards each connection to the proxy's transparent listeners (10256 https / 10257 http /
10258 tunnel) behind a PROXY-protocol-v2 `<sessionId>:<token>` identity; the proxy routes by
TLS SNI / Host header and judges each connection against the session allowlist. **There are
no in-cluster CIDR excludes** and **DNS never leaves the pod** (the stub answers every A
query with the dummy 198.18.0.1 — resolution is decorative; the REDIRECT ignores the dialed
IP and the proxy routes by name). Consequences threaded through this plan: any in-cluster
destination a nested session must reach (project registry, vcluster API) needs an explicit
pinned-VIP carve-out in the in-pod filter **and** a NetworkPolicy allowance, and must be
dialed by IP or a `hostAliases` name — never via kube-dns. The explicit proxy port 10255 is
daemon-control-only (kubectl port-forward).

Old code to port from git: `2464a0a^:dockerfiles/Dockerfile.nestable` (final form incl.
in-userns subuid ranges from b967130), `2464a0a^:src/lib/container/image-promoter.ts`,
e2e template `58682c7:test/e2e-cli/nested-containers-cache.test.ts`. Landed egress files this
plan composes with: `k8s/redirect-init/redirect.sh`, `k8s/relay/{relay.ts,dns-stub.ts,
pp2-frame.ts}`, `k8s/proxy/{transparent.ts,pp2.ts}`, `src/lib/k8s/pod-spec.ts`
(`EgressSidecarParams`; its init-container comment already reserves first slot for this
plan's chown init), `src/lib/k8s/bootstrap.ts` (transparent/relay port constants,
`clusterIpForNamespace`, `buildSessionNetworkPolicyManifest`). All relevant env hooks
already exist: `src/shared/paths.ts:28` honors `YAAC_DATA_DIR`; `src/lib/k8s/registry.ts:14`
honors `YAAC_K8S_REGISTRY`.

---

## Architecture

```
Session pod  (nestedContainers => extra securityContext + nestable image layer)
+-------------------------------------------------------------------+
| init 1 (nested only): chown shared image store (root-in-userns)    |
| init 2: yaac-redirect-init (NET_ADMIN) — landed; gains optional    |
|         EXTRA_TCP_ACCEPT carve-outs (pinned VIPs only)             |
| init 3: yaac-relay sidecar (uid 1337) — landed; loopback 15001-4,  |
|         PP2 <sid>:<token> per connection, DNS stub -> 198.18.0.1   |
| agent + docker CLI + compose + rootless podman (one pod, one netns)|
|   DOCKER_HOST=unix:///run/user/<uid>/podman/podman.sock           |
|   docker build / run / compose -> in-pod podman (a `podman` tmux   |
|                                    window runs `podman system      |
|                                    service`)                       |
|   docker pull -> nat REDIRECT :443 -> relay -> proxy transparent   |
|                  listener (SNI-routed MITM, CA trusted; registry   |
|                  + CDN hosts auto-appended to the allowlist)       |
|   DNS (incl. nested containers) -> stub: every A = 198.18.0.1      |
|                  (decorative — the proxy routes by SNI/Host)       |
|   curl localhost:8080  -> just works (-p binds in the pod netns)   |
|   -v ./x:/x            -> just works (same filesystem)             |
|   graphroot: emptyDir /home/yaac/.local/share/containers (overlay) |
|   shared cache: hostPath /var/lib/yaac/imagecache/<dd>/<proj>      |
|                 mounted ro as additionalimagestores               |
|   securityContext (ONLY when nested):                              |
|     seccompProfile: RuntimeDefault   (unchanged)                  |
|     capabilities.add: ["SYS_ADMIN"]  (userns-scoped; unlocks the  |
|       mount-family syscalls in containerd's default profile so    |
|       rootless podman can mount overlay/proc/tmpfs in its userns) |
|     allowPrivilegeEscalation: true   (newuidmap/newgidmap file caps;|
|       already k8s's implicit default — see Goal A)                  |
|     fsGroup: sessionUid()            (graphroot emptyDir ownership) |
+--------------------------------+----------------------------------+
        | yaac.session-id label  |  egress:
        v                        v  [yaac-session-egress backstop: proxy pods
   nested-container egress rides     10256/10257/10258 ONLY — no kube-dns
   the pod netns -> same redirect    (DNS is in-pod), no 10255 (control-only)]
        + (vcluster sessions) in-pod EXTRA_TCP_ACCEPT + per-project policy:
            -> yaac-reg-<proj> pinned VIP:5000, -> yvc-<sid8> pinned VIP:8443

Project registry  yaac-reg-<proj>  (registry:2 Deployment+Service, PINNED ClusterIP)
   created only for virtualCluster sessions; push target + serve only (vcluster
   synced pods, yaac-in-yaac); plain HTTP on :5000 — a port the nat layer never
   captures; sessions reach it via hostAliases (name) + EXTRA_TCP_ACCEPT (in-pod)
   + per-project NetworkPolicy (CNI); storage node-local hostPath; NO upstream
   egress (deny-all egress policy — nothing to fetch)
   node containerd pulls via a hosts.toml entry (svc-DNS host -> pinned-VIP URL;
   never needs healing — Service recreation reproduces the VIP by construction)

Per-session vcluster  yvc-<sid8>  (vendored helm-template render, kubectl apply)
   API Service: PINNED ClusterIP, port 8443 (NOT 443 — stays out of the nat
   capture); kubeconfig speaks to https://<VIP>:8443 (IP SAN; no DNS dependency)
   syncer stamps synced pods with yaac.session-id -> the egress backstop confines
   them for free (and the proxy's PP2 token check defeats even the allowed flow)
   VAP guard: synced-pod hostPaths restricted to the session's nested data dir;
   no hostNetwork/privileged. kubeconfig delivered via hostPath dir at ~/.kube
```

## Key design decisions (resolved)

### Goal A — docker transparency (in-pod podman)

- **Session pod spec** (`buildSessionJobManifest` in `src/lib/k8s/pod-spec.ts` gains an optional
  `nested` branch; non-nested output byte-identical to today). When nested:
  - `seccompProfile` stays **`RuntimeDefault`**; add `capabilities: { add: ["SYS_ADMIN"] }` on
    the session container. The cap is held in the pod's user namespace (`hostUsers: false` is
    already set), so it confers no host-level authority — it exists to make containerd's static
    RuntimeDefault profile compile the `mount`/`umount2`/`unshare`/`setns`/`pivot_root`/
    `move_mount` syscalls into the seccomp allowlist, which rootless podman needs for overlay/
    proc/tmpfs mounts inside the userns it creates (also required for `docker build` RUN steps —
    builds cannot avoid `mount()`). Fallbacks if a containerd version doesn't unlock the family
    via the namespaced cap: a custom Localhost profile `k8s/seccomp-nested.json` (mount family
    allowed without the cap; staged on the node by the setup script), then Unconfined as a last
    resort. The cluster-check probe (below) is the tripwire.
  - `allowPrivilegeEscalation: true` (file caps on newuidmap/newgidmap), no other added caps.
    **Not a new grant — this is today's implicit default.** The current session container sets
    no securityContext, and a nil `allowPrivilegeEscalation` means the kubelet does not set
    `no_new_privs`, i.e. escalation is already allowed (current sessions depend on it: the
    image's passwordless sudo is a setuid binary). It also could not be false here — the
    kubelet forces it true whenever a container holds CAP_SYS_ADMIN. Writing it explicitly
    documents the requirement and pins it against a future namespace-level "restricted" Pod
    Security label silently breaking nested sessions (the namespace carries no pod-security
    labels today).
  - `fsGroup: sessionUid()` for the graphroot emptyDir (kubelet chowns emptyDir to fsGroup;
    hostPath mounts are untouched by fsGroup, so existing worktree/cred mounts are unaffected).
  - Graphroot: `emptyDir` at `/home/yaac/.local/share/containers`. The kind node has
    `VOLUME /var`, so kubelet emptyDirs land on a real fs (not overlayfs) → **native rootless
    overlay** works (no fuse, no `/dev/fuse`); fallback `vfs` (one-line storage.conf change).
    Same lifetime as the session (single-pod Job) — matches the old per-session volume.
  - Shared cross-session image store: hostPath
    `/var/lib/yaac/imagecache/<dataDirHash>/<projectSlug>` mounted **rw** at
    `/var/lib/shared-images` (additionalimagestores creates lock dirs). Root-owned
    `DirectoryOrCreate` → a tiny initContainer (`runAsUser: 0` = root-in-userns) chowns it to
    `sessionUid()`. It runs **first, before `yaac-redirect-init`/`yaac-relay`** — the
    composition slot the landed `buildSessionJobManifest` comment already reserves for it.
    Idmapped-mount identity across pods is already proven by the cluster-check uid probe.
  - `/dev/net/tun` for pasta/compose private networks via a `squat/generic-device-plugin`
    DaemonSet (installed by the setup script); request `squat.ai/tun: 1` on nested pods. Plain
    `docker run`/`docker build` work without it (pod-netns via `netns="host"`); degrade with a
    one-line warning if the node reports no allocatable tun.
- **Image layer**: restore `dockerfiles/Dockerfile.nestable` from `2464a0a^` as a **conditional
  layer in the chain** (base → tools → **nestable** → project Dockerfile.yaac), built only when
  `nestedContainers` is set; skipped for a standalone Dockerfile.yaac (it owns its toolchain).
  Updates: `passt` (pasta) alongside slirp4netns with `default_rootless_network_cmd="pasta"`;
  parameterize subuid/subgid in-userns ranges around `ARG YAAC_UID` (`yaac:1:999`,
  `yaac:1001:64535`); `ENV XDG_RUNTIME_DIR=/run/user/${YAAC_UID}` +
  `DOCKER_HOST=unix:///run/user/${YAAC_UID}/podman/podman.sock`; keep setcap on
  newuidmap/newgidmap, docker CLI + compose plugin (no buildx — compose falls back to podman's
  classic build endpoint), system `containers.conf`
  (`netns/userns/ipcns/utsns/cgroupns=host`, `cgroups=disabled`, `cgroup_manager=cgroupfs`,
  `runtime=crun`, `base_hosts_file="/etc/hosts"` so nested containers inherit the pod's
  hostAliases — Goal B), storage.conf (`driver=overlay`,
  `additionalimagestores=["/var/lib/shared-images"]`), registries.conf
  (`unqualified-search-registries=["docker.io"]` for docker-CLI parity — static, baked; no
  per-project remap ConfigMap). User `containers.conf`: `volumes=["/proc:/proc",
  "/etc/yaac/certs/proxy-ca.pem:/etc/yaac/certs/proxy-ca.pem:ro"]` and
  `env=["SSL_CERT_FILE=/etc/yaac/certs/proxy-ca.pem", …]` so every nested container
  auto-mounts the proxy CA (`CA_CERT_PATH`, already ConfigMap-mounted into every session pod)
  and trusts it — mirroring `getCaTrustEnv` (`src/lib/container/proxy-client.ts`), the only
  proxy-related env that still exists. The same engine-level injection is what spares user
  **Dockerfiles** from per-file CA plumbing: buildah honors `containers.conf` volumes/env in
  `docker build` RUN steps too (the mechanism RHEL uses to feed entitlement certs into
  builds — verify on the pinned podman before relying on it), so a build step fetching from
  a host the proxy actually MITMs (e.g. `github.com` under credential injection) trusts the
  CA with zero `ARG`/`NODE_EXTRA_CA_CERTS` cooperation in the Dockerfile itself. Hosts that
  are merely allowlisted (npm's registry, distro mirrors) are tunneled, not MITM'd — builds
  see their real certificates — which is why yaac's own `k8s/proxy`/`k8s/relay` Dockerfiles
  carry no CA plumbing. Routing needs no env at all: nested containers share
  the pod netns, so the landed pod-netns redirect (`k8s/redirect-init/redirect.sh`)
  intercepts their `docker run`/`docker build` 80/443 traffic and the stub answers their DNS
  → proxied, allowlisted egress with **zero user action**. redirect.sh's OUTPUT-only design
  explicitly anticipates this: `netns="host"` nested containers generate locally-originated
  traffic, and pasta/compose private networks stay covered because pasta is a userspace
  process re-originating pod-local sockets (its closing comment requires PREROUTING/FORWARD
  mirrors before ever giving nested containers a kernel-routed netns — don't). Tag
  `<prefix>-nestable:<hash>` via `fileHash`/composed hashes; `ensureImage`/`resolveImageTag`
  gain a `nestedContainers` flag (passed from `createSession`). `kubectl` is added to
  `dockerfiles/Dockerfile.tools` (for vcluster/yaac-in-yaac; it has none today).
- **Podman socket startup**: a dedicated `podman` tmux window started in `startJobWithSetup`
  right after `new-session`
  (`podman system service --time=0 unix://$DOCKER_HOST_PATH`), then a bounded readiness poll
  (`docker version`). tmux ownership keeps it alive across exec sessions and its logs are
  inspectable — consistent with the existing initCommands window machinery. Add `podman` to
  `RESERVED_INIT_WINDOW_NAMES` in `src/lib/project/config.ts`.
- **Cross-session build cache (promoter)**: port `2464a0a^:src/lib/container/image-promoter.ts`
  — skopeo `containers-storage:` → `containers-storage:` copy from the session graphroot into
  `/var/lib/shared-images`, flock-serialized, 3 passes incl. a 7-day dangling prune (= the GC
  story for the store). Runs via `containerExec(jobName, …)` from `cleanupSession` / the
  detached cleanup script in `src/lib/session/cleanup.ts`, best-effort, before `kubectl delete
  job`. Gives true `docker build` layer-cache hits across sessions of a project.
- **Pull path (no registry in the middle)**: in-pod podman resolves the upstream registry via
  the relay's DNS stub (dummy answer — decorative), dials :443, and the pod's nat REDIRECT
  delivers the connection to the relay, which forwards it to the proxy's transparent HTTPS
  listener under the session's PP2 identity; the proxy routes by SNI, judges the session
  allowlist, and MITMs. CA trust: `SSL_CERT_FILE` already rides session env (`getCaTrustEnv`)
  and podman's Go TLS honors it; nested containers get the same via the user containers.conf
  volume+env above. When `nestedContainers` is on, `buildSessionRegistration`
  (`src/lib/session/proxy-registration.ts`) auto-appends the upstream registry + CDN hosts to
  the session allowlist: registry-1.docker.io, auth.docker.io,
  production.cloudflare.docker.com, ghcr.io, pkg-containers.githubusercontent.com, quay.io,
  cdn0?.quay.io — verify the CDN set in testing. Fail-closed: anything outside the allowlist
  is denied by the proxy at the SNI/Host judgment. Accepted costs: first pulls per project
  are uncached and rate limits pool on one egress IP (the shared image store + promoter
  covers repeat pulls).
- **In-cluster destinations are explicit pinned-VIP carve-outs** (replaces the draft design's
  service/pod-CIDR excludes, which did not land): the landed redirect.sh captures **all**
  443/80 uniformly, REJECTs everything else, and stubs DNS in-pod — kube-dns is unreachable
  by design. So the two in-cluster destinations this plan adds are deliberately admitted,
  with zero relay/proxy special cases:
  1. Both listen on ports the nat layer never captures (registry **5000**, vcluster API
     **8443** — deliberately not 443), so the nat rules stay untouched and redirect.sh's
     "every 443/80 is captured" invariant holds.
  2. `redirect.sh` gains an optional `EXTRA_TCP_ACCEPT` env (comma-separated `<ip>:<port>`
     pairs; same literal-IPv4 rule as `PROXY_CLUSTER_IP` — names would hang on the stubbed
     resolver) emitting filter ACCEPT rules above the REJECTs. Pinned VIPs only: the rules
     are frozen for the pod's lifetime, so the IPs must survive Service recreation.
  3. The matching NetworkPolicies (Goals B/C) admit the same flows at the CNI layer — both
     layers must agree; neither alone is sufficient.
  4. Names: the registry host rides pod `hostAliases` (glibc/musl consult files before the
     resolver, beating the stub; `base_hosts_file` extends this into nested containers); the
     vcluster kubeconfig simply speaks to its VIP, no name needed.

### Goal B — per-project push registry (registry:2, vcluster image source)

- Plain `docker.io/library/registry:2` (the image the main registry already runs), pinned by
  digest, mirrored into the local registry (`ensureRegistryImage`:
  pull→tag→`pushImageToRegistry`, skip via `registryHasTag`) so the node can pull it.
  Push-and-serve only: no sync extension, no pull-through, no registry config beyond storage
  (nested pulls go through the MITM proxy — Goal A). Storage: node-local hostPath
  `/var/lib/yaac/registry/<dataDirHash>/<projectSlug>` (avoids virtiofs rename hazards; loss
  on cluster recreate is fine — sessions just re-push). Known growth tradeoff: stale
  content-hash tags accumulate until project removal or cluster recreate (registry:2 GC wants
  a quiesced registry, so no in-place pruning in v1 — document, revisit on disk pressure).
  Runs as plain root, no hostUsers (trusted infra, like the proxy).
- **Pinned ClusterIP**: the Service pins its VIP via a keyed generalization of
  `clusterIpForNamespace` (`src/lib/k8s/bootstrap.ts`) — hash `<namespace>/<serviceName>`
  across the same /16 band; one band, one function, the existing docstring's collision math
  covers it. Pinning is load-bearing here, not hygiene: the VIP is frozen into running pods'
  iptables carve-outs (`EXTRA_TCP_ACCEPT`), pod `hostAliases`, and the node's hosts.toml, so
  Service recreation must reproduce it by construction — the same argument that pinned the
  proxy VIP.
- **Plain HTTP on :5000**: yaac's own pushes shell out with `--tls-verify=false` (the
  `pushImageToRegistry` convention); user-driven `docker push` from a session needs a
  registries.conf.d drop-in (`insecure = true` for the exact `yaac-reg-<proj>.<ns>.svc:5000`
  host) written during session setup — the host is per-project, so it cannot be baked into
  the shared nestable layer.
- **No upstream egress**: deny-all egress NetworkPolicy on the registry pod — it only ever
  serves pushes and pulls, nothing to fetch. No proxy pseudo-session, no pinned CDN
  allowlist, no healing in `proxy-reconcile`.
- **Node containerd reachability** (for vcluster/yaac-in-yaac pulls): at registry creation
  write `/etc/containerd/certs.d/yaac-reg-<proj>.<ns>.svc:5000/hosts.toml` on the kind node
  (podman exec, same mechanism as `scripts/setup-kind-cluster.sh`) →
  `http://<pinnedVIP>:5000`. hosts.toml is read per-pull (no restart) and never needs
  healing — recreation reproduces the VIP. In-cluster clients use the same host string via
  `hostAliases` — one string works from both perspectives without kube-dns.
- **Sessions→registry NetworkPolicy**: podSelector `{yaac.project=<slug>} AND yaac.session-id
  Exists` (the Exists term keeps it off the registry pod itself), egress to
  `{app=yaac-registry, yaac.project=<slug>}` TCP 5000. Per-project rather than shared because
  registry:2 has no path ACLs — a shared writable registry would let any session overwrite
  another project's (or the infra) tags. Pairs with the in-pod `EXTRA_TCP_ACCEPT` entry for
  the registry VIP:5000 — the policy admits the flow at the CNI, the carve-out admits it
  inside the pod.
- **Lifecycle**: `ensureProjectRegistry(slug)` (idempotent, pattern of `ensureProxyResources`
  in `src/lib/k8s/bootstrap.ts`) called from session-create **only when `virtualCluster` is
  enabled** — nested-only sessions need no registry, no carve-outs, no hostAliases; removed
  in project removal; orphan GC at daemon start (own scope label
  `yaac.registry-data-dir-hash`). Names: `yaac-reg-<safeSlug≤21>-<hash8>`.

### Goal C — per-session vclusters

- Vendor a `helm template` render of the pinned chart (OSS, k8s distro, embedded SQLite, no
  PVC) into `k8s/vcluster/manifests.yaml` with `__VC_NAME__`/`__VC_NAMESPACE__`/`__SESSION_ID__`
  placeholders; runtime = string substitution + `kubectl apply -f -` (no helm, no vcluster CLI
  at runtime; `scripts/render-vcluster-manifests.sh` regenerates on upgrades). The vendored
  Service pins its ClusterIP (same keyed pin as the registry) and exposes the API on **8443,
  not 443** — keeping it out of the nat 443 capture so no nat excludes are ever needed.
  Values: `controlPlane.advanced.defaultImageRegistry: localhost:5000` (vcluster images
  digest-pinned in `k8s/vcluster/images.json`, mirrored by `ensureVclusterImages`),
  `exportKubeConfig.server: https://<pinnedVIP>:8443` + `proxy.extraSANs: [<pinnedVIP>]` (an
  IP SAN — the kubeconfig has no DNS dependency at all),
  `sync.toHost.pods.patches: [{path: metadata.labels["yaac.session-id"], expression:
  '"<sid>"'}]` (policy inheritance; do NOT stamp data-dir-hash — keeps synced pods invisible to
  the reaper/list), `sync.toHost.networkPolicies.enabled: true` (inner NetworkPolicies enforced
  by host Cilium → inner yaac's egress probe is real), `sync.fromHost.nodes.enabled: true`,
  `telemetry.enabled: false`, resources `requests 100m/256Mi, limits 1Gi`.
- **Policies**: (1) per-session NetworkPolicy `yaac-vc-<sid8>`: pods with `yaac.session-id=<sid>`
  may reach the vcluster API pod (TCP 8443) and each other (intra-session; covers synced
  CoreDNS:1053). For the session pod itself this pairs with an `EXTRA_TCP_ACCEPT` entry for
  the vcluster VIP:8443 (synced pods carry no in-pod filter — the CNI policy alone governs
  them); (2) **CiliumNetworkPolicy** locking the vcluster control-plane pod to
  `toEntities: [kube-apiserver, host]` + kube-dns + synced pods (it holds host-API creds and
  could otherwise be an egress escape hatch via webhooks).
- **VAP guard** (synced-pod containment): one static ValidatingAdmissionPolicy
  `yaac-vcluster-pod-guard` (CEL: hostPath must start with an allowed prefix from a per-session
  param ConfigMap; deny hostNetwork/hostPID/hostIPC/privileged/hostPorts; **caps rule**
  (evaluated across BOTH `containers` and `initContainers` — every session pod now carries
  the landed `yaac-redirect-init` (NET_ADMIN under `hostUsers: false`) and `yaac-relay`
  (uid 1337, drop-ALL, `allowPrivilegeEscalation: false` — trivially admitted)):
  `capabilities.add` and `allowPrivilegeEscalation: true` only when `hostUsers: false`, and
  deny `seccompProfile: Unconfined` — without this a synced pod could combine the default
  `hostUsers: true` with SYS_ADMIN/NET_ADMIN + Unconfined into real node authority
  (NET_ADMIN-under-host-users would let a pod rewrite host netfilter — strictly worse than
  SYS_ADMIN-under-host-users, so the `hostUsers: false` gate is the load-bearing escape and
  the only one); the rule also exactly admits the nested-session securityContext and the
  redirect-init/relay shapes for the M4 stretch. CEL nil-handling: an
  absent `allowPrivilegeEscalation` defaults to **true** at runtime, so the rule deliberately
  matches only an explicit `true` — nil with no added caps is the stock pod default (file
  caps cannot exceed the container's bounding set), `capabilities.add` is the load-bearing
  gate, and requiring an explicit `false` on `hostUsers: true` pods would deny every
  ordinary synced pod), per-session binding matching `vcluster.loft.sh/managed-by=<vcName>`. Allowed prefix = the session's nested data
  dir only. Fail-closed: refuse vcluster creation if the VAP API is missing
  (`YAAC_VCLUSTER_ALLOW_UNCONFINED=1` escape hatch).
- **Wiring**: kubeconfig from Secret `vc-<vcName>` polled with `kubectlGetJson` (already
  pointing at the pinned VIP via `exportKubeConfig.server`), written to a
  new `sessionVclusterDir(slug,sid)` (under `projects/<slug>/sessions/<sid>/`), dir-mounted at
  `/home/yaac/.kube`, env `KUBECONFIG=/home/yaac/.kube/config`. Cold-start hidden behind image
  push/worktree work in `createSession`. Cleanup via label-selector deletes
  (`yaac.vcluster=<name>` + `vcluster.loft.sh/managed-by=<name>` + the `vc-<name>` secret) in
  both cleanup paths; orphan GC + kubeconfig heal as a new `background-loop` tick step. Cap:
  `YAAC_MAX_VCLUSTERS` (default 3). Datastore: SQLite on emptyDir (disposable per-session).
- **yaac-in-yaac env preset** (when `virtualCluster` on; inner image builds run on the
  session's in-pod podman, present because `virtualCluster` implies `nestedContainers`): mount
  `projectDir(slug)/sessions/<sid>/nested-yaac` at the **identical absolute path** in the pod
  (node sees it via the kind `$HOME` extraMount → inner synced-pod hostPaths resolve correctly;
  it's also the VAP allowlist prefix); env `YAAC_DATA_DIR=<that path>`, `YAAC_NESTED=1`,
  `YAAC_K8S_REGISTRY=yaac-reg-<proj>.<ns>.svc:5000/<proj>` (resolvable in-pod via hostAliases,
  on the node via hosts.toml; verify `registryRef` composes with a path-prefixed host). Inner
  cluster-check gets `YAAC_NESTED=1`-gated relaxations (skip podman-machine/registry-autostart
  paths). v1 non-goals (document): inner `setup-kind-cluster.sh`, Cilium-in-vcluster (CRDs
  don't sync), full inner e2e suite, inner *nested* sessions (stretch — see M4),
  vcluster-in-vcluster (refused outright: inner yaac rejects `virtualCluster` when
  `YAAC_NESTED=1`). Supported: inner unit suite, inner `yaac cluster check`, inner
  (non-nested) session create against the vcluster — note inner sessions have no working
  upstream egress in v1 until the stretch lands: synced pods are separate host pods without
  the redirect/relay pair, so they have no transparent path to the MITM, and even the one
  flow the backstop policy admits (proxy transparent ports) dead-ends at the proxy's PP2
  token check. Giving them egress later means a `sync.toHost.pods.patches` entry injecting
  both the redirect-init and relay containers with the session's relay token — derivable at
  any time as HMAC(proxyAuthSecret, `relay:<sessionId>`) (`ProxyClient.relayToken`); the
  amended VAP caps rule already admits both container shapes.
- **vcluster vs k3k**: vcluster chosen — synced pods land in the *same* host namespace (`yaac`)
  so existing policies/Cilium apply with no per-namespace duplication; it renders to plain
  manifests (kubectl-apply convention) vs k3k's operator+CRD model.
- **UX**: `SessionDetail` gains a `virtualCluster` status block (`src/lib/session/detail.ts`);
  `yaac cluster check` gains a VAP-availability line; the tmux-keyed reaper is untouched so a
  vcluster pod OOM never kills the session (pin with a unit test).

### Config surface
- Reinstate `nestedContainers: boolean` (drop from `REMOVED_KEYS`, add to `KNOWN_KEYS` + parse
  + `YaacConfig`). Add `virtualCluster: boolean` + a `--vcluster` CLI flag (ORs with config).
  No other CLI flags (matches the old design). `pgRelay` stays rejected.
- **`virtualCluster` always turns `nestedContainers` on** (nestable image layer + nested pod
  spec): the in-pod podman is the only build engine in a session, so vcluster workflows that
  build images (yaac-in-yaac, build-then-`kubectl run`) need the nested machinery. Setting
  `virtualCluster: true, nestedContainers: false` is a config parse error, and `--vcluster`
  against a config that pins `nestedContainers: false` is rejected at session create.

---

## Milestones

**M0 — config + image layer** (no runtime behavior)
- `src/lib/project/config.ts` (REMOVED_KEYS/KNOWN_KEYS/parse; `virtualCluster` implies
  `nestedContainers`, explicit `virtualCluster: true, nestedContainers: false` is a parse
  error; reserve `podman` window name), `src/shared/types.ts` (YaacConfig +
  SessionCreateOptions)
- `dockerfiles/Dockerfile.nestable` (restored + updated), `dockerfiles/Dockerfile.tools`
  (kubectl)
- `src/lib/container/image-builder.ts` (nestable layer in `resolveImageChain`/`ensureImage`/
  `resolveImageTag` behind the nested flag)
- `test/global-setup.ts` (nestable test image, content-hash — joining the landed proxy/relay/
  redirect-init test images). Unit: `config.test.ts` (incl. vcluster⇒nested implication +
  conflict error), `image-builder.test.ts`, `image-stacking.test.ts`; e2e `config.test.ts`
  (drop the nestedContainers-rejection case, keep pgRelay; add the vcluster/nested conflict
  error)

**M1 — nested podman in the session pod** (build + run + compose work; cross-session cache)
- `src/lib/k8s/pod-spec.ts`: optional `nested` branch (securityContext: RuntimeDefault + cap
  SYS_ADMIN + allowPrivilegeEscalation + fsGroup; graphroot emptyDir; shared-images hostPath +
  chown initContainer, ordered FIRST before the landed yaac-redirect-init/yaac-relay pair;
  `squat.ai/tun` limit). Non-nested output unchanged.
- `src/daemon/session-create.ts`: read `config.nestedContainers`; pass flag to `ensureImage`
  and `nested` params to `buildSessionJobManifest`; `podman` tmux window + readiness poll
- `src/lib/session/proxy-registration.ts`: auto-append the registry + CDN hosts to the
  session allowlist when nested (in `buildSessionRegistration`)
- Port `src/lib/container/image-promoter.ts`; hook into `src/lib/session/cleanup.ts` (both
  paths)
- `scripts/setup-kind-cluster.sh`: `squat/generic-device-plugin` DaemonSet
  (`k8s/generic-device-plugin.yaml`); stage `k8s/seccomp-nested.json` (fallback profile)
- `src/lib/k8s/cluster-check.ts`: warn-level userns-mount probe (pod with the nested
  securityContext running `unshare -U -r -m sh -c 'mount -t tmpfs none /mnt'` — reuse the
  landed session-shaped probe-pod machinery) + device-plugin check
- Unit: `pod-spec.test.ts`, `image-promoter.test.ts`, `cluster-check.test.ts`; e2e: restore
  `nested-containers-cache.test.ts` (build → delete → rebuild → identical image ID),
  `docker run -p` + `curl localhost`, `docker compose up --build`, allowlisted upstream pull
  succeeds through the relay→proxy path (reuse `mock-remotes.ts` +
  `YAAC_E2E_UPSTREAM_REDIRECTS` where a live upstream isn't required), blocked pull fails
  fast (proxy SNI denial)

**M2 — per-project push registry** (a thin prerequisite of M3; nested-only sessions skip it)
- `src/lib/k8s/bootstrap.ts`: generalize `clusterIpForNamespace` into a keyed pin
  (`<ns>/<name>` over the same band; proxy call site unchanged)
- `k8s/redirect-init/redirect.sh`: optional `EXTRA_TCP_ACCEPT` (`<ip>:<port>` list, literal
  IPv4s, filter ACCEPTs above the REJECTs) + `src/lib/k8s/redirect-init.ts`/`pod-spec.ts`
  plumbing; unit `redirect-init.test.ts`/`pod-spec.test.ts` assert emission and that
  non-nested pods carry none
- New `src/lib/k8s/project-registry.ts`: names/labels, pinned-VIP registry:2
  Deployment/Service builders, sessions→registry + deny-all registry-egress NetworkPolicy
  builders, `ensureRegistryImage`, `ensureProjectRegistry`, `removeProjectRegistry`,
  `gcOrphanProjectRegistries`, node hosts.toml writer (pinned-VIP URL)
- Wire into `src/daemon/session-create.ts` (ensure registry when `virtualCluster`; pod
  `hostAliases` + `EXTRA_TCP_ACCEPT` + registries.conf.d insecure drop-in in session setup),
  project removal, daemon-start GC
- `test/global-setup.ts`: registry:2 image mirror. Unit: `project-registry.test.ts`; e2e:
  `project-registry.test.ts` (registry appears/persists/GCs; push from a session by svc name,
  then a pod pulls the pushed ref via the node hosts.toml path)

**M3 — per-session vclusters**
- New `k8s/vcluster/{values.yaml,manifests.yaml,images.json,VERSION}`,
  `scripts/render-vcluster-manifests.sh` (Service patched to pinned VIP + port 8443)
- New `src/lib/k8s/vcluster.ts`: `vclusterName`, `renderVclusterManifests`, policy + VAP
  builders, `ensureVclusterImages`, `ensureSessionVcluster`, `waitForVclusterKubeconfig`,
  `vclusterCleanupCommands`, `getVclusterStatus`
- Wire: session-create (kubeconfig mount + env + vcluster-VIP `EXTRA_TCP_ACCEPT` entry),
  cleanup (both paths), new
  `src/lib/session/vcluster-reconcile.ts` background step, `src/lib/session/detail.ts` status,
  cluster-check VAP line, `--vcluster` flag plumbing (`src/cli.ts`, routes,
  `src/commands/session-create.ts`; rejected when config pins `nestedContainers: false`)
- `src/lib/project/paths.ts`: `sessionVclusterDir`, `nestedYaacDataDir`
- `test/global-setup.ts`: vcluster image mirror. Unit: `vcluster.test.ts`, cleanup/reconcile/
  list-classify tests; e2e `session-create-vcluster.test.ts` (kubectl get nodes; run a pod;
  **policy inheritance** — nc to blocked vs allowed from a synced pod; VAP hostPath rejection;
  VAP caps rejection (`hostUsers: true` + `capabilities.add` denied); `--vcluster` with
  pinned `nestedContainers: false` rejected; full teardown)

**M4 — yaac-in-yaac + docs**
- session-create: nested-yaac data-dir mount + env preset; cluster-check `YAAC_NESTED`
  relaxations; recursion cap — inner yaac rejects `virtualCluster` when `YAAC_NESTED=1` (no
  vcluster-in-vcluster); README (nested containers, registry caveats, vcluster, yaac-in-yaac,
  cluster setup additions); `CLAUDE.md` image-table update
- Env-gated e2e smoke: inner `yaac cluster check` + inner session create
- **Stretch (post-v1): inner nested sessions** — `docker build`/`run` inside an inner
  session. Runtime depth stays pod → rootless podman (synced pods run on the host node), so
  no new privilege model; the M3 VAP caps rule already admits the nested securityContext and
  the redirect-init/relay shapes. Enablers: (1) **transparent chaining** — sync the inner
  proxy pod to host with the redirect-init + relay pair injected under the *outer* session's
  identity (sync patch; the relay token is derivable per session). Its upstream dials are
  then transparently captured and judged against the outer session's allowlist, so
  allowlists compose by intersection with **no proxy code change** (this replaces the old
  draft's explicit HTTP-upstream-chaining mode); the inner proxy must trust the outer CA
  (NODE_EXTRA_CA_CERTS) and the outer allowlist must include the registry/CDN hosts. This is
  also what gives inner sessions working egress at all. (2) VAP params: allow the inner
  imagecache prefix (`/var/lib/yaac/imagecache/<innerDDhash>/…`, computable at vcluster
  creation since the preset pins `YAAC_DATA_DIR`) or skip additionalimagestores/promoter for
  inner sessions via `YAAC_NESTED`. (3) Verify the `squat.ai/tun` extended-resource request
  syncs to host pods.

---

## Risks (ranked)
1. containerd's profile/cap interaction differs on some version (mount family not unlocked by
   the namespaced SYS_ADMIN grant) → cluster-check probe is the tripwire; Localhost-profile
   fallback pre-designed; Unconfined only as a last resort.
2. vcluster chart churn / label-patch regressions → digest-pinned vendored render; e2e
   inheritance test fails loudly; fallback policy keyed on `vcluster.loft.sh/managed-by`.
3. Registry/CDN allowlist gaps (hosts change or vary by region) → e2e pull test per upstream;
   the host set is a single list in proxy-registration, cheap to extend. docker.io rate
   limits pool on the shared egress IP → promoter/shared store covers repeat pulls. Related:
   the proxy routes by SNI, so a nested tool doing TLS without SNI (or pinning resolved IPs —
   the stub answers 198.18.0.1 for everything) fails fast rather than escaping — acceptable,
   but document it as the failure signature.
4. Native overlay on the emptyDir backing fs (if kubelet dirs ever land on overlayfs) →
   `podman info`/`findmnt` smoke in M1; fallback `vfs`.
5. Reduced isolation from co-locating build workloads + agent creds in one pod (the accepted
   tradeoff) → boundary is hostUsers + the transparent-egress default-deny; document clearly;
   revisit a sidecar/separate pod if a concrete threat emerges.
6. Laptop memory (vcluster ~0.5Gi each) → opt-in flags, `YAAC_MAX_VCLUSTERS`.
7. **ClusterIP pinning & allocation (largely resolved by 088bebd; one residual).**
   `clusterIpForNamespace` landed hashing pins across the whole service /16 (~65.5k slots —
   its docstring carries the birthday math and the static-subrange tradeoff; the old /24
   band would not have survived this plan). This plan *requires* pinning for the per-project
   registry and the vcluster control-plane Service — their VIPs are frozen into running
   pods' iptables carve-outs, hostAliases, and node hosts.toml, so recreation must reproduce
   them — via the keyed generalization over the same band. With that, everything yaac-owned
   is pinned and pin-vs-pin collisions stay negligible (a clash fails loudly at `kubectl
   apply`, never a misroute). Residual, explicitly deferred to this plan by the bootstrap.ts
   docstring: Services the vcluster *syncer* creates are dynamically allocated
   (yaac-uncontrolled) and can collide with a pin. Confirm the worst-case Service count
   under `YAAC_MAX_VCLUSTERS` keeps the odds acceptable (a few dozen dynamics vs ~65.5k
   slots → <0.1% per pin); only if the math stops holding, carve an explicit reserved
   sub-band for pins. Treat the pin function as frozen — re-keying it would strand the
   carve-outs of running sessions; cluster-check's proxy-vip and service-cidr drift warnings
   are the tripwire.

## Verification
- Manual (nested session, `"nestedContainers": true`): `docker version` → in-pod podman;
  `getent hosts registry-1.docker.io` → 198.18.0.1 (the stub — decorative by design);
  `docker run --rm hello-world` (pulled via relay → proxy transparent listener, allowlisted);
  `docker run -d -p 8080:80 nginx && curl -s localhost:8080`; `docker run -v "$PWD":/src …`
  sees the workspace; `docker compose up --build`; `docker pull example.com/x` fails fast
  (proxy denies by SNI — fail-closed); build a tagged image, `yaac session delete`, new
  session, rebuild → identical image ID (promoter).
- Manual (vcluster session, `--vcluster`): `kubectl get nodes` (the kubeconfig dials the
  pinned VIP:8443 — no DNS involved); `kubectl run` a pod → host-side pod carries the session
  label; from that synced pod `nc` to the proxy VIP:10256 connects but yields nothing (no PP2
  token), anything else times out — fail-closed both ways; from the session, push a
  session-built image to `yaac-reg-<proj>.<ns>.svc:5000/<proj>/x` (hostAliases name, in-pod
  carve-out) and `kubectl run` that ref → node containerd pulls it via hosts.toml; hostPath
  outside the nested dir → VAP-rejected; a cap-add pod without `hostUsers: false` →
  VAP-rejected; `kubectl delete pod yvc-…-0` → session survives; `yaac session delete` → no
  objects left for `yaac.vcluster=<n>` / `managed-by=<n>`.
- `pnpm lint`, unit suite, e2e suites per milestone; `yaac cluster check` shows the new probe
  rows alongside the landed redirect/lockdown/dns-stub gates.

# Server-in-cluster (k8s driver)

Detailed plan for phase 3 of `stock-k8s-multi-node.md`: turn the yaac
server from a host process beside its cluster into a single-replica
in-cluster Deployment. This is the keystone move — once the server is a
pod, server and session pods can mount the *same* RWX claim, and the
entire hostPath model converts to PVC + subPath with no change to the
path layout the code sees.

**Scope: local kind, end to end.** The deliverable is the e2e suite
green against an in-cluster server on (multi-node) kind. Remote and
bring-your-own clusters are explicitly not planned here — but every
mechanism is chosen so the shape translates (PVC + subPath, Service
dials, a static PV for the shared tier, images pushed to the cluster
registry): nothing in this plan should need *re-design* for a remote
cluster, only the deferred work listed under "Out of scope".

Inputs: the codebase inventory below, and the NFS-under-gVisor spike on
the `nfs-gvisor-storage-spike` branch (`test-storage-probes/` + the
updated `multi-node-storage-plan.md`), whose verdict this plan treats as
settled: **NFS is a go, conditional on the shared/node-local tier
split**, with `actimeo=1` on the mount, `fsGroup` (or StorageClass
`mountPermissions`) on csi-driver-nfs claims, and node-local worktrees
+ pnpm store (shared worktrees cost ~10x on `git worktree add` and
`checkout`; the split brings both to near parity with ext4).

## Decisions

- **Placement is the driver.** A host-process server only ever runs
  the containerless driver; the k8s driver only ever runs as the
  in-cluster Deployment. There is no host-server k8s mode in the end
  state — `yaac server start` means containerless, `yaac cluster
  install` means k8s. The host-process k8s path exists during the
  transition only, and phase 2 ends by retiring it. Consequences:
  - The k8s driver's host-side shims are **deleted, not gated**: the
    stream-relay and registry port-forwards and the ExecTunnel class
    go away entirely (the CLI keeps a port-forward for its own
    registry pushes); the proxy Service dial and `registryHost()` DNS
    become the only path, not an in-cluster branch.
  - **Auth keeps today's rules** — credential-optional on a
    loopback-shaped local install, required the moment
    `YAAC_ALLOWED_HOSTS`/`YAAC_TRUST_PROXY` is set. No new mechanism:
    `isCredentialOptional` keys on config, not the bind address, so
    the local install simply sets neither and behaves exactly like
    today (the Host/Origin checks still force loopback-shaped
    requests), while a future remote install turns auth on by
    setting allowed hosts. Accepted consequence: on the local
    backend, what stands between an untrusted worktree pod and the
    unauthenticated API is the two policy walls — the session egress
    default-deny and the server's ingress NetworkPolicy, which is
    therefore **load-bearing, not optional hardening**.
  - `driver-choice.ts` simplifies: the recorded driver stops being a
    per-start decision and becomes "which kind of install this data
    dir is"; `--driver` disappears from `yaac server start`.
  - `config.bindMounts` and every other "the server can see your
    files" affordance is containerless-only by construction.
- **Built-in images build on the CLI machine, always.** Every image
  yaac itself owns — base, tools, nestable, netd, proxy, the server
  image — is built by host podman on the machine running the yaac CLI
  and pushed to the in-cluster registry. Never in-cluster. This is
  already how `yaac cluster setup` builds netd today, and the
  published npm artifact ships every build context (`build:assets`
  copies `dockerfiles/` and `k8s/` into `dist/`), so it works from an
  npm install. The delta is moving the builds the *server process*
  runs today (base/tools/nestable, proxy) out to the CLI, since an
  in-cluster server has no engine. (No cross-arch builds, ever — on
  the local backend builder and node arch match by construction; a
  future remote install must bring a same-arch build machine.)
- **Project/user layers are unchanged.** Untrusted dockerfile layers
  keep building in the sandboxed in-cluster runsc builder pods
  (docs/trust-split-builds.md) driven by the server — that is a
  security property, not an image-delivery choice, and the builder
  pods stay on gVisor (their broad cap grant is only safe under the
  sentry).
- **No public image hosting.** Publishing per-release images is off
  this plan; the CLI-machine build is the only delivery path.
- **One idempotent converge verb: `yaac cluster install`.** Replaces
  `yaac cluster setup` and `setup --repair` (see below). Teardown only
  ever happens via an explicit `yaac cluster delete`.
- **No support for pre-existing kind clusters.** The move to the
  in-cluster server (and later the extraPortMapping, the PVs) assumes
  a cluster created by `install`; an older cluster gets an actionable
  "run `yaac cluster delete`, then `yaac cluster install`" message.
  A recreate loses running worktrees (as `cluster delete` always has)
  but never project state — the data dir lives on the host, and the
  shared tier's static PV rebinds the same directory by design.
- **The server pod's egress is unrestricted**, matching the host
  process today: no egress NetworkPolicy on the server, git
  clones/fetches and title calls go direct. Default-deny + proxy
  mediation stay a worktree-pod property; routing the server's own
  git traffic through the egress proxy is explicitly not planned.
- **Port forwarding is client-side only.** The authenticated WS
  tunnel (`yaac forward`, plus the desktop app as resident forwarder)
  is the mechanism; per-worktree Services/Ingress are not planned.
- **A dead server is a message, not a spawn.** On a k8s install the
  desktop (and CLI) never start a server; an unreachable Deployment
  surfaces as an actionable message pointing at `yaac cluster
  install`.
- **Shared tier: the host's own NFS export, no backups.** The local
  backend's NFS server is the host's kernel nfsd exporting a
  directory (spike settings: `sec=sys`, `no_root_squash`,
  `no_all_squash`; export restricted to the kind network). The
  `yaac-shared` claim binds a **static PV at a fixed export path with
  `reclaimPolicy: Retain`** — never dynamic provisioning, so no
  PVC/namespace/cluster lifecycle event (including the recreate the
  migration requires) can delete the data or strand it behind a
  freshly provisioned empty subdir. No backup story: the loss mode is
  the host's own disk, which is exactly the risk the data dir already
  carries today.
- **DB migrations stay exactly today's behavior**: forward-only,
  applied automatically at server start. The in-cluster server
  changes nothing about this, so nothing is required for the move; a
  pre-migration cold snapshot of `<serverLocal>/db` is listed as a
  follow-up hardening, not a dependency.
- **No hot-reload dev loop for the k8s server.** `pnpm watch` remains
  the containerless/host workflow; iterating on the in-cluster server
  is build + push + roll (`yaac cluster install`, or a dev shortcut
  that does just the server image + rollout). The cycle is a bundle,
  an image layer, and a `Recreate` rollout — tens of seconds, not
  sub-second, accepted.
- **SSH-key git auth is disabled under k8s (v1).** The ingestion path
  reads the user's disk (`~/.ssh` paths via `expandTilde`,
  `ssh-keygen -y`), which is meaningless once the server is a pod.
  k8s projects use HTTPS + token credentials; an ssh remote is
  refused with a clear error. Follow-up: accept pasted/uploaded key
  *content* instead of a path, which restores parity with modest work
  (the proxy-side ssh-agent machinery is untouched by this — only
  ingestion is).

## `yaac cluster install`

One command, safe to run any time, that converges the machine and the
cluster to the current yaac version:

1. **Substrate, if necessary:** binaries preflight (podman, kind,
   kubectl), podman-machine bootstrap on macOS / rootful-socket check
   on Linux, then — only if the kind cluster does not exist — create
   it (`--nodes N` supported) and install Calico. An existing
   install-created cluster is never recreated; there is no
   destructive path in this command. A pre-install-era cluster is
   refused (see Decisions) rather than upgraded in place.
2. **Node state:** the node fixups (sysctls, TasksMax, pids-limit,
   kubelet flags) re-applied idempotently — today's `--repair` tail.
3. **Images:** build every built-in image on this machine
   (content-hash tags, so an unchanged image is a no-op) and push what
   the registry is missing (`registryHasTag()` HEAD-skip already
   dedupes). Mirror the digest-pinned upstream images (registry:2,
   Envoy, podman-stable, curl installer) the same way.
4. **In-cluster components:** namespace + PSS labels, PriorityClasses,
   main registry (+ node hosts.toml), builder-role VAP, gVisor
   installer DaemonSet + RuntimeClasses, netd — all already
   ensure-shaped.
5. **Server Deployment** (once phase 2 lands — the k8s server always
   runs in-cluster): apply/roll the Deployment to the freshly built
   server image. Upgrading yaac = `npm update` + `yaac cluster
   install`.
6. Finish with `cluster check`, as setup does today.

Existing-cluster runs are therefore exactly today's `setup --repair`
semantics; fresh runs are today's `setup`. `yaac cluster check` and
`yaac cluster delete` keep their jobs. (`--adopt-cni` survives as-is
for now; growing it into a full bring-your-own-cluster install mode is
out of scope — see below.)

Consequences worth naming:

- The **server never builds trusted layers**. `ensureImage` for
  base/tools/nestable becomes registry-lookup-only; a missing
  content-hash tag is an actionable error ("run `yaac cluster
  install`"), not a build trigger. The prewarm sweep keeps building
  only project/user layers (builder pods).
- The **host podman modules migrate from server runtime to install
  time**: the engine preflight, tracked-process reaping, and host
  image GC stop being server concerns (the GC becomes an install-time
  sweep on the CLI machine); the server's driver attach drops
  `reapOrphanedPodmanProcs()`/`killTrackedPodmanProcs()`.
- The **image uid build-arg is pinned, not inherited**: `podUid()` is
  `process.getuid()` today, which is correct when builder == server ==
  one host user, and wrong when the CLI builds for an in-cluster
  server. The uid becomes the constant 1000 end to end (image `yaac`
  user, server pod, session pods, fsGroup); a host whose uid differed
  re-tags images once (see Migration).

## Where the coupling actually is

The research pass found the host coupling is narrower than "the server
assumes a host" suggests. Six load-bearing seams, all already half-built:

1. **Mount sources.** `WorkspaceMount.source` already admits
   `hostPath | pvc+subPath | emptyDir` end to end (contract and
   `pod-spec.ts` renderer, subPath on the volumeMount so one claim backs
   many mounts). Exactly one site selects the source:
   `domain/worktrees/create.ts` builds the mount list with every entry
   hard-coded `hostPath`, and its comment block already tags each entry
   with its storage tier.
2. **Path tiers.** `sharedRoot()` / `nodeLocalRoot()` /
   `serverLocalRoot()` in `packages/shared/src/paths.ts` all return
   `getDataDir()` today; every helper in `project-paths.ts` is
   classified. Splitting the tiers is a change to three functions plus
   the mount-source decision — not a caller-by-caller migration.
3. **Host podman.** One trust seam (`images/build-engine.ts` routes
   `base`/`tools`/`nestable` to the host engine, everything else to
   runsc builder pods) plus five upstream-image mirror sites
   (netd, proxy, project-registry's `registry:2`, the gvisor installer's
   curl image, the builder pod's podman image) and the host image GC.
   All of it stays host-side under this plan — it just moves from the
   server process to `yaac cluster install`.
4. **Cluster reachability.** The typed client already falls back to
   in-cluster service-account config (`loadFromDefault()`); all writes
   and execs go through the `kubectl` binary, which works with an SA
   token. The two host-side network shims — the stream-relay
   port-forward and the registry port-forward — both have escape
   hatches: `YAAC_RELAY_ADDR` exists precisely for "a server with a
   direct TCP route to the proxy", and `registryHost()` is already the
   in-cluster DNS name the server just never dials. (The CLI keeps the
   registry port-forward for its own pushes.)
5. **Server reachability.** The bind address is hardcoded `127.0.0.1`;
   the CLI finds the server via the local lock file, falling back to
   `remote.json` (url + durable token) — which is already the shape an
   in-cluster server needs. Auth hardening is already keyed off
   `YAAC_ALLOWED_HOSTS`/`YAAC_TRUST_PROXY` (setting either turns the
   credential requirement on).
6. **Identity.** `podUid()` (= the server's own uid) is the pod
   `runAsUser`, the image build arg, and part of the base-layer hash;
   `dataDirHash()` (= the data-dir *path*) scopes every cluster query.
   Both become *stable constants* once the server is a container —
   run it as uid 1000 and fix the in-pod data-dir path — but both are
   migration hazards for an existing install (see Migration).

There are **no filesystem watchers** anywhere in the server: transcript
and session-start freshness is poll-on-reconcile-tick (`stat` + re-read),
which is exactly what an RWX volume wants (no inotify-over-NFS problem).
The spike's coherence numbers (`actimeo=1` → 25–57ms cross-client
visibility; `stat()`-polling of a same-host writer lags ~3s on
`acregmin`) bound the staleness those polls can see.

## Target shape

- **Deployment**, `replicas: 1`, `strategy: Recreate` (pglite is
  embedded single-writer), `yaac-infra` PriorityClass, plain runc (the
  server is trusted code; sessions keep gVisor), `runAsUser: 1000` to
  match the pinned image `yaac` uid.
- **Two claims + a node tier:**
  - `yaac-server-state` — RWO, default StorageClass: pglite `db/`,
    `server.log`, the lock, `driver`, `build/`, `models/`, caches.
    Never on a network FS.
  - `yaac-shared` — RWX over the host's NFS export via csi-driver-nfs
    (CephFS fallback re-runs `test-storage-probes/` unchanged): the
    `projects/` tree, `.credentials/`, `run/proxy-data`. Mounted by
    the server pod, every session pod (as subPath mounts), and the
    proxy. `fsGroup` set (the csi-driver-nfs subdir is provisioned
    `0755 root:root` otherwise — spike trap).
  - node-local — per-node disk or emptyDir for the hot dirs the
    storage plan carved out: `opencode-data/<sid>` (SQLite WAL),
    `.cached-packages` (pnpm hardlinks), ephemeral module dirs, and —
    in the perf phase — the worktrees themselves.
- **Images:** every yaac-built image comes from the CLI machine via
  `yaac cluster install`; the server consumes them from the registry
  by content-hash tag and builds only project/user layers (builder
  pods).
- **Networking:** a Service in front of the server, published to the
  host as a stable loopback endpoint (see phase 2). The CLI, desktop
  and auth-daemon all resolve it through `remote.json`; the
  auth-daemon is already a pure outbound client.
- **In-cluster shortcuts:** `YAAC_RELAY_ADDR` → the proxy Service
  (deletes the stream-relay port-forward and the ExecTunnel class);
  registry push/HEAD from the server → `registryHost()` service DNS
  directly.
- **RBAC:** a namespaced Role (pods, pods/exec, pods/log, jobs,
  services, deployments, configmaps, secrets, endpoints) plus a
  ClusterRole for what is genuinely cluster-scoped (nodes read,
  priorityclasses, runtimeclasses, the VAPs, namespace create for
  project registries). Enumerate against `substrate/kubectl.ts` call
  sites when building the manifest; the e2e namespace isolation
  (`YAAC_K8S_NAMESPACE`) keeps working since the SA can be granted per
  namespace.

The server pod mounts the volumes **at the paths the code already
uses** — the tier roots become distinct directories only under the
in-cluster server, and `getDataDir()` keeps working. Nothing above the
driver learns any of this. And since placement is the driver, this IS
the k8s driver's shape — not a variant of it: the local kind backend
runs the same Deployment, just with hostPath volumes until phase 3.

## Phasing

Ordered so every phase lands and pays off on the current local backend
before the next starts, per the repo's phasing discipline. The final
gate for each is unchanged from `stock-k8s-multi-node.md`: the e2e
suite on a multi-node (kind) cluster.

### Phase 1 — `yaac cluster install` + builds move to the CLI

Restructure the CLI surface and the build responsibility before any
Deployment exists:

- Introduce `yaac cluster install` with the converge semantics above;
  retire `setup`/`--repair` (alias them through a deprecation window
  if wanted). No behavior on the cluster changes yet — this is the
  same ensure-* tail behind one idempotent verb.
- Move the trusted-layer and proxy image builds from the server
  process into install: install builds and pushes base/tools/nestable
  + proxy + netd (+ the upstream mirrors); the server's
  `build-engine.ts` host route becomes registry-lookup-only with an
  actionable "run `yaac cluster install`" error, and the server sheds
  the podman preflight, the tracked-process reaping, and the host
  image GC (which becomes an install-time sweep).
- Pin the image uid build-arg (constant 1000) instead of deriving it
  from the building process's uid, so a CLI build and a server pod
  agree. On the current single-host backend this is a no-op for the
  common uid-1000 case; a host whose uid differs re-tags images once
  (content hash includes the uid — call it out in the changelog).

Pays off standalone: the *server process* no longer needs a container
engine even in host mode, upgrades get one obvious verb, and repair
stops being a flag people have to know about.

Verification: full e2e on the current backend with the server process
denied podman (only install may use it).

### Phase 2 — server image + Deployment, storage unchanged

Run the server as a pod with **hostPath storage exactly as today**.
kind nodes mount `$HOME`, so the server pod can hostPath-mount the
real data dir at the same absolute path — `dataDirHash()`, every
existing hostPath mount, and the session-pod view are all
byte-identical. This isolates the process/network/lifecycle work from
the storage work completely.

- **Server image** (`dockerfiles/Dockerfile.server` or the images
  folder's pattern): node + the bundled server + `kubectl`, `git`,
  tar, and the llama.cpp title binary baked in (auto-titles keep
  working; no runtime download); uid 1000. Built and pushed by
  install; content-hash tagged; added to `test/global-setup.ts` for
  e2e.
- **Bind + auth:** a bind-address env (`YAAC_BIND_ADDR`; the pod
  interface in the Deployment manifest); auth keeps today's
  config-keyed rules (see Decisions), so the local install stays
  credential-optional. That makes the server pod's **ingress
  NetworkPolicy load-bearing**: it admits only the node CIDRs
  (`nodeIpBlocks()`, the main-registry precedent) — NodePort traffic
  arrives from a node address and is admitted, while a pod dialing
  the server pod IP directly presents a pod source IP and is
  dropped. Together with the sessions' egress default-deny it is
  what keeps untrusted worktree pods off the unauthenticated API —
  so `cluster check`'s `egress` gate grows one assertion: a
  worktree-labelled probe pod must fail to dial the server Service
  and pod IP, proving the wall on every install the way the gate
  already proves the apiserver and transparent-proxy denials.
  (The kernel-enforced alternative — bind pod-loopback, reach it
  only through `kubectl port-forward`, which dials 127.0.0.1 inside
  the pod netns — is deliberately not taken: it reintroduces a
  babysat forward process and puts all traffic back on the
  apiserver streaming path.)
- **Reachability:** a Service, published to the host as a stable
  loopback endpoint via NodePort + a kind `extraPortMapping` (host
  `127.0.0.1:8787` → node port), reserved at cluster creation — the
  browser, the CLI, and the desktop app connect to a fixed loopback
  origin with no tunnel process to keep alive. Install writes
  `remote.json` (url + durable token) as every client's target.
  Pre-existing clusters are refused, not fallback-supported (see
  Decisions), so no interim port-forward path exists.
- **Cluster access:** in-cluster SA config (already the
  `loadFromDefault()` fallback) + the RBAC manifest; set
  `YAAC_RELAY_ADDR` to the proxy Service and dial `registryHost()`
  directly; delete `port-forward.ts`'s server-side consumers and
  `exec-tunnel.ts` in this mode.
- **Lifecycle:** install applies/rolls the Deployment (image roll =
  `Recreate` rollout); `yaac server stop|logs|status` grow
  Deployment-aware forms. The lock becomes a **lease**: pid liveness
  is meaningless across pods (every container's pid namespace hands
  out the same low pids, so "is pid N alive?" answers about the
  wrong process), so the lock file instead records the instance
  identity (pod uid) plus a heartbeat the running server renews; a
  starting server refuses while the heartbeat is fresh and takes
  over only once it is stale, and a clean shutdown removes it. On
  real block storage RWO attach + `Recreate` backstops this; on the
  local kind backend's hostPath volumes there is no attach
  exclusivity, so the lease IS the single-writer guard for pglite
  there.
- **Settled small calls:** the detached teardown `rm -rf` accepts
  pod-lifetime scoping — the reconcile sweeps already retry
  leftovers, so a pod death mid-cleanup costs a pass, not a leak
  (the other detached-process trick, prewarm builds, dissolves in
  phase 1 — builder pods already outlive the server).
  `YAAC_USE_TOR` points at the host's SOCKS via
  `YAAC_HOST_TOR_SOCKS_URL` — install computes the host's address on
  the kind network; note Tor must listen on that interface, not just
  loopback, which install checks and reports. `config.bindMounts` and
  ssh-key git auth are refused under k8s with clear errors (see
  Decisions).
- **Worktree port-forwarding** is the one real feature regression: the
  server can no longer bind ports on the user's machine. The server's
  relay machinery survives intact — it just stops terminating in a
  server-local listener and is instead exposed as an authenticated WS
  endpoint (`/forward/...`, the `/pty/attach` pattern) bridging to the
  same streamd stream the forwarders use today. The listener moves to
  the client: `yaac forward` in the CLI, and the **desktop app as the
  natural resident forwarder** — its main process is long-lived,
  tray-scoped, already consumes `/events`, so it can bind the
  configured ports on `127.0.0.1` and pipe each accepted connection
  over the WS endpoint, keeping the webapp's `127.0.0.1:<port>` links
  true whenever the desktop (or `yaac forward`) is running. The
  tunnel client lives in `@yaac/shared` (WS + net only), which is the
  only package the desktop may import. v1 frames one WS per forwarded
  TCP connection (the kubectl shape).
- **Desktop app**: no structural change. It already loads the server
  origin rather than bundling the SPA, resolves its target through
  the same `resolveServerTarget` chain as the CLI (`remote.json`
  first), and mints its session against the resolved origin — an
  in-cluster server is just another origin. Its additions here are
  the resident port-forwarder above and dropping its local-server
  spawn path for k8s installs (`server-process.ts` becomes
  containerless-only; unreachable server → the install message).
- **The e2e tiers.** `test/e2e`/`test/api`'s k8s half spawn a host
  server per file today. They move to the real shape: a dev server
  image built once in `test/global-setup.ts` (content-hashed like
  every test image), one Deployment applied per e2e file with the
  file's data dir passed by env, logs via `kubectl logs`. Apply-to-
  ready on a warm kind node is seconds — comparable to today's server
  boot — and the per-file fixture discipline is unchanged.

There is deliberately **no hot-reload dev loop** here (see Decisions):
developing the k8s server means build + push + roll, and a dev
shortcut that rebuilds only the server image and rolls the Deployment
keeps that cycle tight.

The phase ends by **retiring host-mode k8s**: once the in-cluster
suite is green, `yaac server start --driver k8s` is removed, the
host-side shims are deleted (not gated), and `yaac server start`
means containerless.

Verification: the k8s e2e tiers, now running against the deployed
server on kind.

### Phase 3 — storage: point the tiers at volumes

Now split what phase 2 deliberately left alone.

- **Claims** created by install: `yaac-server-state` (RWO, default
  StorageClass), and `yaac-shared` (RWX) bound through a **static PV**
  install renders from the host's NFS export (`reclaimPolicy:
  Retain`, `actimeo=1` mount options, `mountPermissions`/fsGroup per
  the spike), with csi-driver-nfs applied by install. The minimal
  chain is: the host nfsd export (spike settings, restricted to the
  kind network) → csi-driver-nfs → the static PV + claim. Install
  owns standing the export up (the spike's `setup-nfs-export.sh` is
  the prototype).
- **Roots split** in `paths.ts`, driven by the composition root (env
  set by the Deployment manifest): sharedRoot → the RWX mount,
  serverLocalRoot → the RWO mount, nodeLocalRoot → a fixed node path.
  Under containerless all three keep resolving to the data dir — the
  split is inert there.
- **Mount-source resolution:** the k8s driver maps a mount path by the
  tier root it lives under — under sharedRoot →
  `{pvc: yaac-shared, subPath: <relative>}`, under nodeLocalRoot →
  node hostPath (`DirectoryOrCreate`) with an init container doing
  `mkdir -p` + `chown` (hostPath ignores fsGroup; store-writer.ts is
  the precedent), everything else unchanged. Prefix mapping is sound
  precisely because the roots differ in this mode. The containerless
  driver is untouched (it already rejects `pvc`).
- **Server-side mkdirs move or survive:** `create.ts` pre-creates every
  shared dir — that keeps working since the server mounts the same RWX
  volume; the node-local pre-creates move into the init container.
  The session-starts `File` mount becomes a subPath-to-file mount
  (server still pre-creates the file; verify the never-renamed append
  contract over NFS — the spike's O_APPEND finding does not apply, the
  file has one writer).
- **Proxy mounts** (`.credentials`, `run/proxy-data`) become subPath
  mounts of the RWX claim; `proxyRunAsSecurityContext()` drops the
  `process.getuid()` coupling for the fixed uid + fsGroup.
- **e2e scratch:** `testTmpBase()` grows a PVC-backed branch for this
  mode (the host/node same-absolute-path contract is exactly what the
  subPath mount now provides).
- **Check gates:** the hostPath nonce probe becomes an RWX write
  probe, and the spike's `fsprobe.py` semantics chain + `coherence.sh`
  become `cluster check` gates (the storage plan's "the work is
  turning them into a gate"). Land `test-storage-probes/` from the
  spike branch onto main with this phase.
- **Still-open spike item**, run here: a full yaac session with
  `claude/` + `repo/.git` on NFS end to end, and the real
  server-pod-mounts-the-export topology (the spike measured
  writes-to-own-export instead).

Verification: e2e on multi-node kind (`--nodes N`) with the shared
tier on the host's NFS export, sessions scheduled across nodes.

### Phase 4 — node-local worktrees (perf)

The spike removed "keep worktrees shared" as an option worth keeping
long-term (7.6s `worktree add`, ~4s checkouts), but shared worktrees
are *correct*, so this is a separable perf phase:

- `addWorktree` splits: the server keeps writing the admin dir into
  the shared `repo/.git/worktrees/<sid>` (`--no-checkout` staging as
  today), and the checkout into the node-local worktree dir moves to a
  session init container (git is in the base image; the gitdir pointer
  across the tier boundary is spike-verified).
- Cleanup/GC learn that worktree dirs are per-node (the node-pinned
  sweep pattern from store-writer.ts), and `worktreeStateRoots`-style
  pairings are the single edit point the path layer already provides.
- Resume keeps node affinity while the worktree dir exists; a drained
  node costs a re-checkout, not data (repo, tool state, transcripts
  are shared).

## Out of scope: remote / bring-your-own clusters

Deliberately not planned here; listed so the deferral is visible and
the local design stays translatable. A future remote install adds:
the bring-your-own-cluster mode of `yaac cluster install` (the
`stock-k8s-multi-node.md` §7 `attach` role: node-OS probe for the
runsc install, storage-class probe, arch probe, recording the backend
client-side); ingress/TLS in front of the server Service instead of
the kind extraPortMapping; an NFS server that is not the host (a
dedicated same-network VM, firewalled to the nodes — `sec=sys` NFS is
trust-by-network); off-host backup; a same-arch build machine; and
re-measuring the spike's NFS numbers over a real network (every
current number is a single-node floor). Nothing in the local design
is expected to need re-design for any of these — only addition.

## Migration and compat

- **This is a migration, not a new mode.** Since host mode only runs
  containerless in the end state, every existing local k8s install
  moves to the in-cluster server when phase 2 ships — there is no
  opt-out to keep the host server on k8s.
- **The transition is a one-time cluster recreate** (`yaac cluster
  delete` + `yaac cluster install`), since pre-existing clusters are
  not supported (no extraPortMapping, pre-install node state).
  Running worktrees are lost, exactly as any `cluster delete` loses
  them today; project state is not: the data dir stays on the host,
  and the server pod hostPath-mounts it at the identical absolute
  path — so `dataDirHash()`, every label, and the DB carry over
  unchanged into the new cluster.
- The phase-1 uid pinning re-tags images once on hosts whose uid
  was not 1000 (the content hash includes the uid); the next
  `yaac cluster install` rebuilds them.
- `yaac server start` on a k8s data dir becomes an actionable error
  pointing at `yaac cluster install`; the recorded `driver` file is
  the tripwire.
- **Projects using ssh-key git credentials** lose that auth mode
  under k8s v1 (see Decisions): surfaced at migration as a per-
  project warning naming the HTTPS-token alternative, not a silent
  break.

## Follow-ups (deferred on purpose, none blocking)

- **SSH-key auth parity**: accept pasted/uploaded key content instead
  of a host path, restoring ssh remotes under k8s.
- **Credentials off NFS.** Phase 3 puts `.credentials/` and
  `run/proxy-data` on the export; acceptable on a host-local export,
  but the clean end state is Secrets or API-push delivery to the
  proxy, which demotes `.credentials` to server-local and keeps real
  credentials off the NFS wire and disk entirely. Revisit after
  phase 3.
- **Pre-migration DB snapshot** (`db-backup-<buildId>`, kept last-N,
  taken cold before `openDb` migrates) — makes an image roll
  reversible and doubles as the server-state backup primitive.
  Optional hardening; today's behavior is identical without it.
- **O_APPEND invariant into the storage docs** when phase 3 lands: a
  shared-tier file may have many readers but ONE appending writer —
  cross-sandbox O_APPEND on gofer-backed ext4 loses/interleaves ~5%
  of lines (`test-storage-probes/append-race.sh` is the reproducer);
  cross-session aggregation goes through per-session files merged by
  the server.
- **WS tunnel multiplexing** — v1 is one WS per forwarded TCP
  connection (the kubectl shape); a yamux-style mux over one socket
  only if chatty apps ever make the per-connection handshake cost
  visible.

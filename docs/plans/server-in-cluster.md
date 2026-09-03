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
  - Every "the server can see your files" affordance is containerless-only
    by construction.
- **Built-in images build on the CLI machine, always.** Every image
  yaac itself owns is built by host podman on the machine running the
  yaac CLI and pushed to the in-cluster registry, never in-cluster —
  `yaac cluster install` does it (docs/trust-split-builds.md), and the
  published npm artifact ships every build context (`build:assets`
  copies `dockerfiles/` and `k8s/` into `dist/`), so it works from an
  npm install. The server image joins that set in phase 2. (No
  cross-arch builds, ever — on the local backend builder and node arch
  match by construction; a future remote install must bring a
  same-arch build machine.)
- **Project/user layers are unchanged.** Untrusted dockerfile layers
  keep building in the sandboxed in-cluster runsc builder pods
  (docs/trust-split-builds.md) driven by the server — that is a
  security property, not an image-delivery choice, and the builder
  pods stay on gVisor (their broad cap grant is only safe under the
  sentry).
- **No public image hosting.** Publishing per-release images is off
  this plan; the CLI-machine build is the only delivery path.
- **One idempotent converge verb: `yaac cluster install`**
  (docs/cluster-setup.md). Teardown only ever happens via an explicit
  `yaac cluster delete`.
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
- **Server-local tier: a static hostPath PV, for the same reason.**
  `yaac-server-state` binds a static PV at a fixed path under the data
  dir, `reclaimPolicy: Retain`, hostPath rather than the export (pglite
  must not sit on a network FS). NOT the default StorageClass: on the
  local backend that is `local-path`, which provisions into the node
  container with `reclaimPolicy: Delete` — so `yaac cluster delete`
  would take the database with it, and `cluster delete`'s standing
  promise is that nothing under the data dir is touched. That is the
  line: dynamic provisioning is right for data a cluster can re-derive
  (the registry's blobs die with the cluster and cost only re-pushes),
  and wrong for the one tier that cannot be re-derived at all —
  worktrees can be re-checked-out, images re-pushed, caches refilled,
  the DB cannot. Install renders the PV with an explicit `claimRef` so
  binding is deterministic and a `Released` PV can never be shadowed by
  a freshly provisioned empty one. What makes hostPath safe here is the
  same node==host assumption every existing mount already rests on
  (kind binds `$HOME` into every node); a remote cluster needs a real
  block volume instead, which is part of the deferred work below.
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

The converge verb exists (docs/cluster-setup.md): substrate if necessary,
node state, every built-in image built on the CLI machine and pushed, then
the in-cluster components, finishing with `cluster check`.

`--adopt-cni` installs the in-cluster layers and deploys **no server**: an
adopted cluster has no kind port mapping to publish one through, and a
server outside the cluster is the containerless driver by construction. So
adoption is a groundwork mode until the bring-your-own-cluster install
exists (see "Out of scope"), and it says so at install time rather than
leaving an adopted cluster looking installed and idle. Whether the flag
should be refused outright until then is open.

What phases 2–3 add to it, in order:

- **Server Deployment.** Apply/roll it to the freshly built server image,
  after the components it depends on. Upgrading yaac then = `npm update`
  + `yaac cluster install`.
- **A pre-install-era cluster is refused** (see Decisions) rather than
  upgraded in place, once the extraPortMapping the Deployment is published
  through makes an old cluster genuinely unusable.
- **Claims and the NFS export** (phase 3): stand the host export up,
  apply csi-driver-nfs, render the static PV.

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
3. **Host podman.** Already resolved: every image yaac ships is built
   or mirrored by `yaac cluster install` on the CLI machine, and the
   server resolves all of them from the registry
   (docs/trust-split-builds.md). Nothing on the server's path touches a
   container engine.
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
6. **Identity.** `podUid()` (= the install host's uid) is the pod
   `runAsUser`, the image build arg, and part of the base-layer hash;
   `dataDirHash()` (= the data-dir *path*) scopes every cluster query.
   The data-dir path becomes a stable constant once the server is a
   container; the **uid does not**, and cannot while storage is a
   hostPath — virtiofs makes the host user's uid a ceiling on what any
   pod can write there (docs/server-in-cluster.md, "The uid everything
   runs as"). It stops being a free variable only when the storage stops
   being the host's filesystem, or when the images stop baking a uid at
   all.

There are **no filesystem watchers** anywhere in the server: transcript
and session-start freshness is poll-on-reconcile-tick (`stat` + re-read),
which is exactly what an RWX volume wants (no inotify-over-NFS problem).
The spike's coherence numbers (`actimeo=1` → 25–57ms cross-client
visibility; `stat()`-polling of a same-host writer lags ~3s on
`acregmin`) bound the staleness those polls can see.

## Target shape

- **Deployment**, `replicas: 1`, `strategy: Recreate` (pglite is
  embedded single-writer), `yaac-infra` PriorityClass, plain runc (the
  server is trusted code; sessions keep gVisor), `runAsUser` = the
  installing host's uid, matching the image `yaac` uid built for it.
- **Two claims + a node tier:**
  - `yaac-server-state` — RWO, a **static hostPath PV** at a fixed path
    under the data dir with `reclaimPolicy: Retain`: pglite `db/`,
    `server.log`, the lock, `driver`, `build/`, `models/`, caches.
    Never on a network FS, and never dynamically provisioned — see the
    decision above for why the one irreplaceable tier does not get the
    default StorageClass.
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

### Phase 2 — server image + Deployment, storage unchanged — **SHIPPED**

The whole of it is current-state reference now: docs/server-in-cluster.md
for the image, the Deployment/Service/RBAC/ingress-policy set, the fixed
loopback origin, the lease, the uid model, the Deployment-aware lifecycle verbs,
the Service dials that replaced every host-side shim, and the e2e tiers that
deploy the same workload per test file; docs/port-forward-tunnel.md for the
client-held forwarders; docs/containerless-driver.md and
docs/cluster-setup.md for what "placement is the driver" means at the two
commands.

Storage was deliberately untouched — the pod hostPath-mounts the real data
dir at its own absolute path — which is what phase 3 below now splits.

### Phase 3 — storage: point the tiers at volumes

Now split what phase 2 deliberately left alone.

- **Claims** created by install, both bound through **static PVs
  install renders** rather than dynamic provisioning:
  `yaac-server-state` (RWO) over a hostPath at a fixed path under the
  data dir, and `yaac-shared` (RWX) over the host's NFS export
  (`actimeo=1` mount options, `mountPermissions`/fsGroup per the
  spike), with csi-driver-nfs applied by install. Both carry
  `reclaimPolicy: Retain` and an explicit `claimRef`, so a recreate
  rebinds the same bytes and nothing can hand the install an empty
  volume instead. The shared chain is: the host nfsd export (spike
  settings, restricted to the kind network) → csi-driver-nfs → the
  static PV + claim; install owns standing the export up (the spike's
  `setup-nfs-export.sh` is the prototype).
- **Roots split** in `paths.ts`, driven by the composition root (env
  set by the Deployment manifest): sharedRoot → the RWX mount,
  serverLocalRoot → the RWO mount, nodeLocalRoot → a fixed node path.
  Under containerless all three keep resolving to the data dir — the
  split is inert there. `clientLocalRoot` is NOT one of them and never
  becomes a volume: it is the user's machine, which is the point of it
  (docs/server-in-cluster.md, "Client state lives beside the data dir").
  Moving the client's files out of serverLocalRoot is done — without it
  this step would have put `remote.json`, the auth-daemon lock and the
  `driver` record on a claim only the pod can mount, silently breaking
  `yaac remote`, `yaac auth` and the desktop server switcher.
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
  subPath mount now provides), and the server Deployment the e2e tiers
  apply per file mounts it the same way.
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
trust-by-network); real block storage for `yaac-server-state`, whose
static hostPath PV only holds where node==host; off-host backup; a
same-arch build machine; and
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
  unchanged into the new cluster. Phase 3 keeps that property rather
  than trading it away: both claims are static PVs over host paths
  with `reclaimPolicy: Retain`, so a recreated cluster rebinds the
  same directories and a `cluster delete` still touches nothing under
  the data dir.
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
  reversible. Hardening against a bad MIGRATION, not against losing
  the volume: the static hostPath PV is what keeps the database off
  the cluster's lifecycle, so this stays optional rather than becoming
  a phase-3 dependency. Today's behavior is identical without it.
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
- **Fence the lock with an OFD/`flock` file** instead of leaving the
  lease's resume window open. The lease is time-based, so a server
  stalled past `LEASE_STALE_MS` has its lock taken and then keeps
  writing until its next heartbeat notices — up to one tick of two
  open PGlite handles. A kernel lock closes that window outright, and
  it WOULD hold here: host and node share one kernel and the data dir
  crosses only a bind mount, so the two processes contend on one
  inode. Not free, though, and that is why it is deferred rather than
  folded in: Node has no `flock` in core, so it means a native
  dependency or a spawned `flock(1)` helper, and it changes the lock
  protocol for every reader rather than one call site. Nor does phase
  3 make it redundant the way "RWO claims bring attach exclusivity"
  suggests — server-state is a static hostPath PV there, and hostPath
  enforces nothing. Worth doing on its own, against both phases.

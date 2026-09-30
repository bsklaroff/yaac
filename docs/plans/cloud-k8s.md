# Cloud-hosted Kubernetes: what is left

Goal: run the k8s driver on a cluster somebody else hosts — a self-managed
node pool (k3s + Calico on VMs) first, EKS-AL / AKS-Ubuntu as per-provider
ports — using **the same code and the same in-cluster infrastructure as the
local kind install**. The local install keeps its data dir on the host's own
disk, exactly where it is today, so it never needs a network filesystem and
never needs a backup story beyond the one the host already has. Only the
cloud install pays for storage that can move between nodes, and it pays
for it in manifests, not in code paths.

This plan replaces four earlier ones. What shipped from them is
current-state reference now (docs/server-in-cluster.md,
docs/cluster-setup.md, docs/worktree-egress.md, docs/trust-split-builds.md);
what was dropped is listed at the end.

## Where things stand

Everything the earlier plans called "the keystone" has shipped on kind:

- The server is an in-cluster Deployment, published at a fixed loopback
  origin, registered in `server.json`; there is no host-process k8s server,
  and every in-cluster dial is a Service dial (docs/server-in-cluster.md).
- Every yaac pod runs under gVisor with no user namespace, which is what
  makes an NFS-backed volume usable at all — the sentry needs no idmapped
  mount (docs/cluster-setup.md "Runtimes and uids").
- Egress is Calico NetworkPolicy plus netd's veth-peer redirect, both
  per-node DaemonSets, both multi-node clean (docs/worktree-egress.md).
- The gVisor runtime is installed by a privileged DaemonSet, not by
  `podman exec` — the one mechanism that works on a node yaac has no shell
  on and survives node recycling.
- Both registries are in-cluster Deployments on RWO PVCs through the
  default StorageClass; the cross-session image cache travels through the
  per-project registry; builder pods are sandboxed and push to it.
- The path layer is classified into GLOBAL / NODE-LOCAL / SERVER-LOCAL /
  CLIENT-LOCAL tiers (`packages/shared/src/paths.ts`, one tier per helper in
  `project-paths.ts`), and the three in-install tiers are three folders of
  the data dir on every substrate. On kind the server pod mounts two
  claims, `yaac-global` (RWX) and `yaac-server-local` (RWO), bound to
  static hostPath volumes into those folders, plus the node's own
  node-local tree; every worktree pod mounts subPaths of `yaac-global`,
  resolved by the k8s driver from the tier a path declares, and its
  node-local directories are created by its own init container
  (docs/server-in-cluster.md "Storage is two claims"). The node-local
  sweeps are per-node pods, opencode works on a node-local copy of a
  global checkpoint, and `cluster check` proves the claim and the POSIX
  semantics of what backs it.
- Multi-node kind (`--nodes N`) exists, with per-node readiness gates.
- Node tuning (the sysctls, `DefaultTasksMax`) is the gVisor installer
  DaemonSet's, applied on every node it lands on and re-applied after a
  restart; install's `podman exec` loop holds only the kind-only pair (the
  node container's pids ceiling, the kubelet housekeeping flag), and
  `cluster check` reads the tuning back through the installer's pods.
- The server's fronting is a per-backend manifest set install renders
  (docs/server-in-cluster.md "Reachability"): a ClusterIP plus a
  hostNetwork forwarder behind the port mapping on kind, the same
  ClusterIP behind the Tailscale operator's TLS Ingress under `--tailnet`.
  Install reads the published origin off the fronting, states
  `YAAC_ALLOWED_HOSTS` from it and registers it; `yaac server
  start|restart` derive the origin from the live fronting. There are no
  tokens: the server identifies a caller from the request
  (docs/remote-hosting.md). The ingress wall is an explicit allow in two policies — node
  addresses (re-rendered by the server at attach) plus the fronting's
  peers — with no pod-CIDR snapshot left anywhere.
- Nothing a user configures names a path on the server any more:
  `bindMounts` is gone, an SSH git credential is ingested as key content,
  and project env and secrets live encrypted in the database.
- The egress proxy mounts nothing from the host and holds no state: its
  credentials, secret values and registrations are objects it watches, its
  CA, captured rotations and records are objects the server watches
  (docs/worktree-egress.md "What the proxy is told, and how"), and
  `.credentials/` is SERVER-LOCAL.
- The NFS-under-gVisor spike ran (branch `nfs-gvisor-storage-spike`,
  `test-storage-probes/`). Verdict: **go, conditional on the tier split.**
  `actimeo=1` on the mount (cross-client visibility 25–57ms), `fsGroup` on
  csi-driver-nfs claims, and worktrees + pnpm store kept node-local
  (`git worktree add` 7.6s → 0.75s, checkout 4.0s → 0.57s against an
  all-ext4 baseline of 0.5s). Sentry locks never reach the server, so
  single-writer discipline per file is the rule on the shared tier.

- **`yaac cluster install --byo` is the cloud install**
  (docs/cluster-setup.md "Bring your own cluster"): gated on the node pool,
  the CNI, the Tailscale operator, the storage classes, the install's
  identity and the recorded kube context; claims provisioned from named
  classes, owned by a binder pod, pinned `Retain` and re-adopted after a
  namespace delete (docs/server-in-cluster.md "Storage is two claims"); the
  server at uid 1000 behind the tailnet Ingress; `cluster check` with the
  storage gates fail-level on every backend.
- **kind-byo** (`pnpm kind-byo`, docs/cluster-setup.md "Running byo locally:
  kind-byo") stands a cloud-shaped cluster up on one Linux host — ganesha
  behind csi-driver-nfs, a `WaitForFirstConsumer` default class, the
  operator — and the `e2e-byo` project runs the e2e files against it.

What is left is the real targets and the operations around them.

## Decisions

- **kind stays the local backend.** No k3s-on-Linux, no Lima/minikube
  spike. What a node-in-a-container costs is a handful of install-time
  fixups, and those are cheaper than a second local backend. The
  cloud backend is the second backend, and the local one exists to test it.
- **Two backends, one driver, one Deployment.** `yaac cluster install
  --byo` is the cloud backend (docs/cluster-setup.md "Bring your own
  cluster"). Above install, nothing knows which
  backend it is on: the pod specs, the mount sources, the Service dials,
  the check probes are identical. Every difference is a manifest install
  renders — which PersistentVolume backs a claim, what fronts the server's
  Service, which uid the images bake — never a branch in the driver.
- **Storage is two named claims on every backend.** `yaac-global` (RWX:
  the `projects/` tree) and `yaac-server-local` (RWO: the PGlite DB, the
  lock, logs, `.credentials/`, `build/`, `models/`). The server pod and
  every worktree pod mount subPaths of `yaac-global`; only the server
  mounts `yaac-server-local`; the proxy mounts neither. The data dir has
  one layout on every substrate — three tier folders, `global/`,
  `server-local/` and `node-local/`, and nothing else of yaac's at its root
  — into which an older data dir is moved once, by a rename per row, at
  the first host process that touches it (docs/legacy-compat-shims.md).
  What differs per backend is the PV behind each claim:
  - **kind: static hostPath PVs into the data dir**, `reclaimPolicy:
    Retain`, explicit `claimRef`. `yaac-global` binds `<dataDir>/global`
    and `yaac-server-local` binds `<dataDir>/server-local` — so the bytes
    stay on the host's disk under `~/.yaac`, and `yaac cluster delete`
    keeps its standing promise of touching none of them. Kubernetes does
    not enforce access modes on hostPath, so the RWX claim spec is the
    same one the cloud backend uses. Multi-node kind keeps working because
    the extraMount binds `$HOME` into every node and the PV path resolves
    on each.
  - **byo: dynamically provisioned from named StorageClasses** — an
    NFS-family RWX class (csi-driver-nfs against an NFS server you run;
    EFS, Filestore and Azure Files NFS are the managed equivalents, all NFS
    behind a CSI driver, which is exactly what the spike measured) and any
    RWO block class for server state. Install patches each bound PV to
    `reclaimPolicy: Retain` after binding, so a claim or namespace delete
    can never take the data with it on either backend. The spike's two
    findings are applied by install to volumes it owns rather than
    demanded of the operator's classes: `actimeo=1` goes into the bound
    RWX volume's `mountOptions`, and a one-shot binder pod makes each
    volume root the install uid's (docs/server-in-cluster.md "Storage is
    two claims").
- **Nodes are disposable.** Nothing a worktree needs in order to resume
  may live only on the node it last ran on, and no pod is ever pinned to a
  node. The NODE-LOCAL tier therefore holds exactly two kinds of thing:
  caches that are re-derivable (package caches, the per-node image store)
  and **working copies of a checkpoint on the shared tier**. opencode's
  per-worktree SQLite is the second kind: SQLite is unusable on NFS (no
  WAL, a confirmed corruption issue), so the pod works on a node-local
  copy and checkpoints it to `<global>/projects/<slug>/opencode-data/<id>`
  on a timer and at stop, and a start restores from the checkpoint
  (docs/worktree-storage.md "opencode" is the record of what ships). The
  pod does both itself (the DB is in-pod and has one writer), so the
  server learns nothing new; a node lost mid-run costs at most one
  checkpoint interval of conversation.
- **The NODE-LOCAL tier is node disk on both backends**: a hostPath at a
  fixed node path (`/var/lib/yaac/node/<dataDirHash>/…`,
  `DirectoryOrCreate`) with an init container doing `mkdir -p` + `chown`,
  since hostPath ignores `fsGroup`. On kind that path is bound to
  `<dataDir>/node-local` by a second extraMount, so caches still live on
  the host disk and survive a cluster delete; on a cloud node it is the
  node's own disk, and a drained node costs a cold cache and nothing
  else.
- **The pod's tier roots are three mount points, and the install identity
  is stamped, not derived.** `globalRoot()`, `serverLocalRoot()` and
  `nodeLocalRoot()` read `YAAC_GLOBAL_ROOT` / `YAAC_SERVER_LOCAL_ROOT` /
  `YAAC_NODE_LOCAL_ROOT` when set (the Deployment sets them; containerless
  never does, so the split is inert there). `dataDirHash()` — every pod
  label, the registry claim name — hashes `getDataDir()`,
  which the Deployment keeps passing as the host's data dir path exactly as
  today, so no label, claim or row changes across the storage move. The
  data dir path is an identity string inside the pod and a directory only
  on the host.
- **Built-in images keep building off the cluster.** Every image yaac
  ships is built by podman on the machine running the CLI and pushed
  through the CLI's registry port-forward, on both backends, exactly as
  today (docs/cluster-setup.md "Images are built here, and only here"),
  and for the CLI machine's **own** architecture. What keeps those images
  matching the nodes is a refusal, not a cross-build: `--byo` reads the
  node architecture off the cluster and refuses, loudly, a pool that is
  mixed or that differs from the deploying machine's (an arm64 Mac cannot
  drive an amd64 pool). No `--platform`, no emulation, no platform in the
  content hash. Lifting that restriction means **published
  per-architecture images** per release that install pulls instead of
  building, which needs the images to stop baking a uid (below) and is
  outside this plan. Nothing in this plan builds an image inside the
  cluster beyond what the trust-split builder pods already do for project
  and user layers.
- **The tailnet is the only way onto a cloud server.** kind keeps the
  `extraPortMapping` → `127.0.0.1`, fronted by a hostNetwork forwarder so
  the ingress wall sees a node source on every host platform. byo publishes
  the server through the Tailscale Kubernetes operator's
  `ingressClassName: tailscale` Ingress, which gives a tailnet-only
  hostname on the same trust boundary docs/remote-hosting.md already draws,
  stamps every request with the caller's tailnet identity (the only
  authentication the server has — docs/remote-hosting.md), and terminates TLS for it — an `https://` origin and a secure
  context for the webapp — and nothing else: no public
  LoadBalancer, no public Ingress, no cert-manager, no DNS, and no option
  to add them. The operator is a prerequisite the cluster owner installs
  (one helm command, printed by the refusal); `--byo` implies the tailnet
  fronting. It is one fronting on both backends: `--tailnet` selects it on
  kind too, where it **replaces** the loopback origin rather than adding a
  second one, so an install has exactly one origin and every client —
  this machine's CLI included — reaches it the same way.
- **Node tuning moves into the gVisor installer DaemonSet.** The sysctls
  and `DefaultTasksMax` are real-node concerns as much as kind-node ones;
  the installer already runs privileged with `nsenter` on every node and
  reapplies on every new node, so it becomes the one node-tuning mechanism
  and the `podman exec` fixup loop is deleted. What stays kind-only is
  what only a node container has: the pids-limit on the container and the
  kubelet housekeeping flag (a managed pool's kubelet config is the
  provider's; document the flag as a pool setting).
- **Images bake no uid** (docs/arbitrary-uid-images.md): gid 0 with
  `g=u` on everything the process writes, an entrypoint that names the
  running uid in `/etc/passwd`, the uid out of every tag. `runAsUser` is
  therefore a runtime value install sets per backend: the host's uid on
  kind, where the virtiofs ceiling on macOS is real, and a fixed `1000` on
  byo, where NFS passes uids through raw and the binder's chown of each
  volume root does the rest. One image set per content hash is also what makes published
  per-architecture images possible, and with them the lifting of the
  architecture restriction on `--byo`.
- **The gVisor node install is the portability ceiling, accepted.**
  Mutating a managed node's containerd is vendor-unsupported but works on
  mutable-OS pools (self-managed, EKS AL2023, AKS Ubuntu); it is blocked
  on Bottlerocket, Autopilot and Fargate, and DOKS is out because its
  Cilium is mandatory and eBPF host-routing defeats the veth-peer
  redirect. GKE Standard would need a GKE Sandbox adapter and is not
  planned. `--byo` probes for these and refuses rather than installing
  something that silently loses egress enforcement.
- **Backups are a cloud concern and stay outside yaac**, except one:
  provider snapshots of the two volumes are the operator's schedule, and
  the server takes a cold copy of `<serverLocal>/db` before it runs a
  migration (last-N, keyed by build id) so an image roll is reversible.
  The local install needs neither — its loss mode is the host disk, as it
  has always been.

## The work, in order

Each step is gated by the e2e suite on kind (single and `--nodes 3`) and on
`e2e-byo`, plus `e2e-byo-install` green on kind-byo.

### 7. Real targets

Run in kill-order on a self-managed k3s + Calico pool (VMs, csi-driver-nfs
against an NFS VM firewalled to the nodes), then EKS-AL, then AKS-Ubuntu:

- The gVisor installer on the real node OS; sentry probe green; survives
  a node-pool upgrade.
- The `egress` gate against the provider's Calico (policy-only over VPC
  CNI on EKS) and `YAAC_KUBE_PROXY_EXTERNAL` on k3s.
- The storage gates over a real network — every spike number is a
  single-host floor, and `actimeo=1` is where staleness bugs would show.
- Worktree `pnpm install` time with the npm cache (docs/worktree-storage.md
  "Package installs") on another node — measured single-host only so far —
  and a node drain that moves the cache: installs fail until its claim
  reattaches, the same exposure the main registry has for pulls.
- A full worktree life: create, nested containers, prewarm claim, then
  drain the node and resume — every tool including opencode — on another
  (repo, transcripts and the opencode checkpoint are shared; the worktree
  dir is too until step 9, correct but slow on the first `worktree add`).
- Reboot and drain: a node drain kills a worktree Job — surface a
  "node draining" worktree state and document that in-flight scratch is
  lost while `repo/.git` and transcripts are not.
- Document each target in docs/cloud-hosting.md (a current-state doc,
  written as each target passes), with the provider table from
  docs/worktree-egress.md as its envelope.

### 8. Operations

- The pre-migration cold DB snapshot (`db-backup-<buildId>`, last-N).
- The lease-fenced lock stays; on byo the RWO claim's attach exclusivity
  is a second guard for free. An OFD/`flock` fence is still worth doing
  on kind, where hostPath enforces nothing.
- A dedicated worktrees node pool: the `nodeSelector` on the installer
  DaemonSet and the `tolerations` on the RuntimeClasses are plumbed and
  default to no-ops; `--byo` gets a `--worktree-pool-taint` knob that sets
  both and persists across re-installs (docs/cluster-setup.md "Which nodes
  count as worktree-eligible" describes why today's apply prunes it).

### 9. Node-local worktrees (perf, separable)

The spike showed shared worktrees are correct but ~10x slower on the git
write paths. Once the cloud install is real: `addWorktree` splits so the
server writes only the admin dir into the shared `repo/.git/worktrees/<id>`
(`--no-checkout` staging) and a worktree init container does the checkout
into the node-local worktree dir; cleanup and GC learn the dir is per node
(the node-pinned sweep pattern). Disposable nodes set the bar this step
has to clear: a node-local checkout holds uncommitted work, so it is a
working copy of a checkpoint like opencode's DB — a snapshot commit of the
tree (tracked, untracked and staged) written to `refs/yaac/checkpoint/<id>`
in the shared `repo/.git` on stop and on a timer, restored by the init
container when the node-local dir is absent. Without that, worktrees stay
shared: slow is acceptable, losing an hour of edits to a node upgrade is
not. The webapp's file editor (docs/file-editor.md) reads and writes
`worktreeDir` from the server's own filesystem, so a node-local checkout
also needs an in-pod file path for it. A stopped worktree's files would then
be reachable only through the checkpoint.

## Invariants to keep

- A shared-tier file may have many readers and ONE appending writer;
  cross-worktree aggregation goes through per-worktree files merged by the
  server. Sentry locks are sandbox-local, so nothing on the shared tier may
  rely on a cross-pod lock.
- Every path stored in a row is data-dir-relative (transcript paths
  already are, and no config names a server path any more); an audit of
  the schema for absolute paths is part of step 1.
- A driver is handed everything it needs; a byo install's storage classes,
  fronting and uid reach the driver as manifests install rendered, never as
  reads of the environment inside the driver.
- No filesystem watchers: freshness stays poll-on-reconcile, which is what
  an NFS mount wants.

## Dropped from the earlier plans

- **Moving off kind** (native k3s on Linux, Lima/minikube krunkit spikes,
  buildkitd-in-cluster as a podman replacement). kind is the local backend;
  its fixups are down to the kind-only pair and its host podman stays for
  the provider.
- **A host NFS export for the local install.** The kind install's data dir
  stays on disk behind static hostPath PVs. The only NFS on one machine is
  kind-byo's in-cluster ganesha, and that is a stand-in for a cloud
  cluster, not a mode of the kind install.
- **`yaac cluster attach` as a separate verb**; it is `--byo` on install.
- **In-cluster builds of the built-in images**, and a public Ingress or
  LoadBalancer in front of the server; the tailnet is the only fronting.
- **Multi-node kind as the acceptance gate for cloud.** It remains a
  supported topology and an e2e configuration, but kind-byo is what
  stands in for a cloud cluster.
- **DOCR / a provider registry**; the in-cluster registry carries over.
- **CephFS / JuiceFS fallbacks**, kept only as the note that the spike's
  probes take a mount path and run unchanged against another filesystem.
- **vcluster sessions**, already retired.
- **Multi-user access** — docs/plans/multi-user-deployment.md, unchanged
  by any of this.

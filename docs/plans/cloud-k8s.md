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
  per-node DaemonSets, both multi-node clean, and `--adopt-cni` already
  installs them into a cluster yaac did not create (docs/worktree-egress.md,
  docs/cluster-setup.md "Adopting a CNI").
- The gVisor runtime is installed by a privileged DaemonSet, not by
  `podman exec` — the one mechanism that works on a node yaac has no shell
  on and survives node recycling.
- Both registries are in-cluster Deployments on RWO PVCs through the
  default StorageClass; the cross-session image cache travels through the
  per-project registry; builder pods are sandboxed and push to it.
- The path layer is classified into SHARED / NODE-LOCAL / SERVER-LOCAL /
  CLIENT-LOCAL tiers (`packages/shared/src/paths.ts`, one tier per helper in
  `project-paths.ts`); CLIENT-LOCAL is already a separate directory. The
  worktree mount list declares a source per mount, and the pod-spec renderer
  already renders `hostPath | pvc+subPath | emptyDir`. Nothing selects
  `pvc` yet.
- Multi-node kind (`--nodes N`) exists, with per-node readiness gates.
- Nothing a user configures names a path on the server any more:
  `bindMounts` is gone, an SSH git credential is ingested as key content,
  project env and secrets live encrypted in the database, and a project's
  proxied secrets reach the egress proxy over its control API rather than
  a file it mounts.
- The NFS-under-gVisor spike ran (branch `nfs-gvisor-storage-spike`,
  `test-storage-probes/`). Verdict: **go, conditional on the tier split.**
  `actimeo=1` on the mount (cross-client visibility 25–57ms), `fsGroup` on
  csi-driver-nfs claims, and worktrees + pnpm store kept node-local
  (`git worktree add` 7.6s → 0.75s, checkout 4.0s → 0.57s against an
  all-ext4 baseline of 0.5s). Sentry locks never reach the server, so
  single-writer discipline per file is the rule on the shared tier.

What is NOT there: the tiers are still one directory, every mount is still
a hostPath resolved through kind's `$HOME` extraMount, the built-in images
are built for the CLI machine's own architecture and bake its uid, the
server is published only through a kind port mapping, and `--adopt-cni`
therefore deploys no server. Those four gaps are the whole of this plan.

## Decisions

- **kind stays the local backend.** No k3s-on-Linux, no Lima/minikube
  spike. What a node-in-a-container costs is a handful of install-time
  fixups, and those are cheaper than a second local backend. The
  cloud backend is the second backend, and the local one exists to test it.
- **Two backends, one driver, one Deployment.** `yaac cluster install`
  grows a `--byo` mode (bring your own cluster: what `--adopt-cni` does
  today, plus storage and the server). Above install, nothing knows which
  backend it is on: the pod specs, the mount sources, the Service dials,
  the check probes are identical. Every difference is a manifest install
  renders — which PersistentVolume backs a claim, what fronts the server's
  Service, which uid the images bake — never a branch in the driver.
- **Storage is two named claims on every backend.** `yaac-shared` (RWX:
  the `projects/` tree, `.credentials/`, `run/proxy-data`) and
  `yaac-server-state` (RWO: the PGlite DB, the lock, logs, `build/`,
  `models/`, caches). The server pod, every worktree pod and the proxy
  mount subPaths of `yaac-shared`; only the server mounts
  `yaac-server-state`. What differs per backend is the PV behind each
  claim:
  - **kind: static hostPath PVs into the data dir**, `reclaimPolicy:
    Retain`, explicit `claimRef`. `yaac-shared` binds `<dataDir>` itself
    and `yaac-server-state` binds `<dataDir>/server` — so the bytes stay on
    the host's disk at the paths they occupy today, nothing under the data
    dir is ever moved, and `yaac cluster delete` keeps its standing
    promise of touching none of it. Kubernetes does not enforce access
    modes on hostPath, so the RWX claim spec is the same one the cloud
    backend uses. Multi-node kind keeps working because the extraMount
    binds `$HOME` into every node and the PV path resolves on each.
  - **byo: dynamically provisioned from named StorageClasses** — an
    NFS-family RWX class (csi-driver-nfs against an NFS server you run;
    EFS, Filestore and Azure Files NFS are the managed equivalents, all NFS
    behind a CSI driver, which is exactly what the spike measured) and any
    RWO block class for server state. Install patches each bound PV to
    `reclaimPolicy: Retain` after binding, so a claim or namespace delete
    can never take the data with it on either backend. `actimeo=1` and
    `fsGroup` go on the claim/PV as the spike found.
- **Nodes are disposable.** Nothing a worktree needs in order to resume
  may live only on the node it last ran on, and no pod is ever pinned to a
  node. The NODE-LOCAL tier therefore holds exactly two kinds of thing:
  caches that are re-derivable (the pnpm store, the per-node image store)
  and **working copies of a checkpoint on the shared tier**. opencode's
  per-worktree SQLite is the second kind: SQLite is unusable on NFS (no
  WAL, a confirmed corruption issue), so the pod works on a node-local
  copy and checkpoints it to `<shared>/projects/<slug>/opencode-data/<id>`
  with `sqlite3 .backup` plus an atomic rename — on every stop, and on a
  timer while running — and a start restores from the checkpoint when the
  node-local copy is absent. The pod does both itself (the DB is in-pod
  and has one writer), so the server learns nothing new; a node lost
  mid-run costs at most one checkpoint interval of conversation.
- **The NODE-LOCAL tier is node disk on both backends**: a hostPath at a
  fixed node path (`/var/lib/yaac/node/<dataDirHash>/…`,
  `DirectoryOrCreate`) with an init container doing `mkdir -p` + `chown`,
  since hostPath ignores `fsGroup`. On kind that path is bound to
  `<dataDir>/node-local` by a second extraMount, so caches still live on
  the host disk and survive a cluster delete; on a cloud node it is the
  node's own disk, and a drained node costs a cold pnpm store and nothing
  else.
- **The pod's tier roots are three mount points, and the install identity
  is stamped, not derived.** `sharedRoot()`, `serverLocalRoot()` and
  `nodeLocalRoot()` read `YAAC_SHARED_ROOT` / `YAAC_SERVER_LOCAL_ROOT` /
  `YAAC_NODE_LOCAL_ROOT` when set (the Deployment sets them; containerless
  never does, so the split is inert there). `dataDirHash()` — every pod
  label, the registry claim name, the cookie name — hashes `getDataDir()`,
  which the Deployment keeps passing as the host's data dir path exactly as
  today, so no label, claim or row changes across the storage move. The
  data dir path is an identity string inside the pod and a directory only
  on the host.
- **Built-in images keep building off the cluster.** Every image yaac
  ships is built by podman on the machine running the CLI and pushed
  through the CLI's registry port-forward, on both backends, exactly as
  today (docs/cluster-setup.md "Images are built here, and only here").
  What changes is that the image is built for the **node's** architecture,
  which install reads off the cluster and passes as `--platform`; a
  mismatched host (an arm64 Mac driving an amd64 pool) pays for emulation
  once per content hash. That cost is accepted because it is temporary:
  the end state is **published per-architecture images** for every
  release, which install pulls (or the nodes pull directly) instead of
  building — reachable once the images stop baking a uid (below). Nothing
  in this plan builds an image inside the cluster beyond what the
  trust-split builder pods already do for project and user layers.
- **The tailnet is the only way onto a cloud server.** kind keeps
  NodePort + `extraPortMapping` → `127.0.0.1`. byo publishes the server
  through the Tailscale Kubernetes operator — a Service with
  `loadBalancerClass: tailscale` — which gives a tailnet-only hostname
  with real TLS on the same trust boundary docs/remote-hosting.md already
  draws, and nothing else: no public LoadBalancer, no Ingress, no
  cert-manager, no DNS, and no option to add them. The operator is a
  prerequisite the cluster owner installs (one helm command, documented);
  `--byo` probes for it and refuses without it. Install waits for the
  origin in the Service status, sets `YAAC_ALLOWED_HOSTS` +
  `YAAC_TRUST_PROXY` so a credential is required, mints the durable token
  and registers the origin in `server.json` — the same `registerServer`
  every start performs. The server's ingress NetworkPolicy is rewritten
  from "every address except the pod CIDRs" to an explicit allow: node
  CIDRs (the NodePort path) plus the operator's proxy pod selector — which
  also retires the pod-CIDR snapshot that goes stale as a cloud cluster's
  IPAM grows.
- **Node tuning moves into the gVisor installer DaemonSet.** The sysctls
  and `DefaultTasksMax` are real-node concerns as much as kind-node ones;
  the installer already runs privileged with `nsenter` on every node and
  reapplies on every new node, so it becomes the one node-tuning mechanism
  and the `podman exec` fixup loop is deleted. What stays kind-only is
  what only a node container has: the pids-limit on the container and the
  kubelet housekeeping flag (a managed pool's kubelet config is the
  provider's; document the flag as a pool setting).
- **Images stop baking a uid** — issue #150 (the arbitrary-uid pattern:
  gid 0 with `g=u` on everything the process writes, an entrypoint that
  names the running uid in `/etc/passwd`, the uid out of every tag) is a
  dependency of this plan, not part of it. With it, `runAsUser` is a
  runtime value install sets per backend: the host's uid on kind, where
  the virtiofs ceiling on macOS is real, and a fixed `1000` on byo, where
  NFS passes uids through raw and `fsGroup` on the claims does the rest.
  One image set per content hash is also what makes the published
  per-architecture images above possible at all.
- **Credentials leave the shared tier before any cloud install.** The proxy
  today hostPath-mounts `.credentials/` (the github/claude/codex/opencode
  bundles) and `run/proxy-data`. On a host-local disk that is fine; on an
  NFS export it is real credentials on the wire under `sec=sys`. Project
  secrets already arrive over the proxy's control API; the tool credential
  bundles take the same route, `.credentials/` demotes to SERVER-LOCAL,
  and `run/proxy-data` (the CA and its state) becomes the proxy's own RWO
  claim. This is a prerequisite of the byo storage step, not a follow-up.
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

Each step lands and pays off on kind before the next starts; the e2e suite
on kind (single and `--nodes 3`) is the gate for every one of them, and the
byo-on-kind tier described under step 6 joins that gate as soon as it
exists.

### 1. Storage: claims on kind, data dir untouched

- Install renders the two claims and, on kind, the two static hostPath PVs
  (`Retain`, `claimRef`) into the data dir. The server Deployment mounts
  them at three fixed pod paths and sets the three root env vars;
  `YAAC_DATA_DIR` stays the host path. `serverLocalRoot` writers
  (`db/`, the lock, `server.log`, `build/`, `models/`, caches) move under
  `<dataDir>/server` on the host as part of this — a one-shot rename at
  install time for an existing data dir, listed in
  docs/legacy-compat-shims.md.
- The k8s driver's mount-source resolution maps a path by the tier root it
  lives under: under `sharedRoot` → `{pvc: yaac-shared, subPath}`, under
  `nodeLocalRoot` → the node hostPath with the init container, `emptyDir`
  unchanged. Prefix mapping is sound because the roots differ inside the
  pod. The session-starts `File` mount becomes a subPath-to-file mount
  (one appending writer; verify the never-renamed contract on NFS with the
  spike's `append-race.sh`).
- Server-side `mkdir`s of node-local dirs move into the init container;
  the node-local sweeps (orphan modules GC, opencode-data cleanup) become
  per-node one-shot pods on the node-write-pod pattern (`store-writer.ts`).
- The opencode checkpoint/restore loop lands in the worktree init script,
  with the shared checkpoint path added to `project-paths.ts` as SHARED
  and the node-local dir re-documented as its working copy. An e2e case
  stops an opencode worktree, deletes its node-local dir, restarts it and
  resumes the conversation.
- The e2e harness mounts a file's scratch as a subPath of a per-namespace
  claim it renders (with a static PV into `testTmpBase()` on kind), the way
  it already renders per-namespace RBAC.
- `cluster check`: the hostPath nonce probe becomes an RWX write probe
  through the claim; `volume-nodes` writes through the claim from each
  node; `fsprobe.py`'s semantics chain and `coherence.sh` land from the
  spike branch as gates, so a byo install's storage class is judged by the
  same probes the spike used.
- Gate: e2e green on kind, one node and three.

### 2. Node tuning into the DaemonSet

- Sysctls and `DefaultTasksMax` move into `yaac-gvisor-install`; the
  `podman exec` loop in install keeps only the pids-limit and the kubelet
  flag, both kind-only and both skipped under `--byo`. The `node-fixups`
  check narrows to that pair and self-skips on a non-podman node as it
  already does.
- Gate: `cluster check` green after a podman-machine restart with no
  install re-run for the sysctls (the DaemonSet reapplied them).

### 3. Images for the node's architecture

- Depends on issue #150 having landed: no uid in any tag or build arg.
- Install reads the node architecture off the cluster (and refuses a
  mixed pool), and `#drivers/k8s/image-engine` builds with `--platform`
  for it; the platform joins the content hash so an arm64 and an amd64
  image of one tree never answer for each other. The upstream mirrors
  (registry:2, Envoy, podman-stable, curl) are copied for that platform.
  On kind the host and node architecture always agree, so nothing changes
  there but the tag.
- Gate: `yaac cluster install` from an arm64 Mac against an amd64 kind
  cluster on a Linux box (`KUBECONFIG` pointed at it, the registry
  reached through the port-forward), with every image pulling and a
  worktree starting.
- Follow-on, outside this plan's gate: publish per-architecture images per
  release and have install pull them, retiring the per-machine build.

### 4. Server publication and the ingress wall

- The Service's fronting is a per-backend manifest: NodePort + port
  mapping on kind, `loadBalancerClass: tailscale` under `--byo`. Install
  waits on the published origin from the Service status, sets the two
  remote-hosting variables, mints the token and registers the origin.
- The ingress NetworkPolicy becomes an explicit allow of node CIDRs plus
  the fronting pod selector; the `egress` gate's worktree-must-not-reach-
  the-server probe is unchanged and proves it on both backends.
- Gate: on kind the wall probe passes with the rewritten policy; on a
  tailnet-fronted kind cluster (the operator works on kind) `yaac remote
  set` from a second device reaches the server.

### 5. Credentials off the shared tier

- The tool credential bundles reach the proxy the way project secrets
  already do — pushed over its control API, re-pushed on every proxy
  attach — and the proxy never reads `.credentials/` from disk;
  `.credentials/` demotes to SERVER-LOCAL; the proxy's `/data` (CA and
  state) becomes its own RWO claim, provisioned by install like the
  registry's.
- Gate: the egress e2e tier green; a grep for hostPath in
  `proxy-manifests.ts` finds nothing.

### 6. `--byo`: the cloud install end to end

- `--adopt-cni` is renamed `--byo` outright — no alias, no deprecation
  window; it has no installs to be compatible with. `--byo` adds to what
  adoption does today: the node-OS/containerd probe (config include path,
  restart mechanism — k3s embeds containerd), the StorageClass probe
  (`--rwx-storage-class`, `--rwo-storage-class`, refused when absent or
  when the RWX class is not NFS-family), the Tailscale operator probe, the
  architecture probe that drives step 3's builds, the `runAsUser`
  decision, the claims and the Retain patch, the server with its tailnet
  fronting, and the registration.
  Every new argument gets its e2e-cli coverage.
- **byo-on-kind**: a kind cluster with Calico installed by hand, an
  in-cluster NFS server behind csi-driver-nfs for the RWX class, and
  `local-path` for RWO, installed with `--byo`. This is the tier that runs
  in CI and in a dev worktree with the outer host's podman; it exercises
  every byo code path but the provider-specific node OS. Add it as a
  vitest project beside the k8s tiers.
- Gate: the full e2e suite green on byo-on-kind.

### 7. Real targets

Run in kill-order on a self-managed k3s + Calico pool (VMs, csi-driver-nfs
against an NFS VM firewalled to the nodes), then EKS-AL, then AKS-Ubuntu:

- The gVisor installer on the real node OS; sentry probe green; survives
  a node-pool upgrade.
- The `egress` gate against the provider's Calico (policy-only over VPC
  CNI on EKS) and `YAAC_KUBE_PROXY_EXTERNAL` on k3s.
- The storage gates over a real network — every spike number is a
  single-host floor, and `actimeo=1` is where staleness bugs would show.
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
not.

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
  its fixups shrink under step 2 and its host podman stays for the provider.
- **A host NFS export for the local install.** The local data dir stays on
  disk behind static hostPath PVs; NFS is cloud-only.
- **`yaac cluster attach` as a separate verb**; it is `--byo` on install.
- **In-cluster builds of the built-in images**, and a public Ingress or
  LoadBalancer in front of the server; the tailnet is the only fronting.
- **Multi-node kind as the acceptance gate for cloud.** It remains a
  supported topology and an e2e configuration, but byo-on-kind is what
  stands in for a cloud cluster.
- **DOCR / a provider registry**; the in-cluster registry carries over.
- **CephFS / JuiceFS fallbacks**, kept only as the note that the spike's
  probes take a mount path and run unchanged against another filesystem.
- **vcluster sessions**, already retired.
- **Multi-user access** — docs/plans/multi-user-deployment.md, unchanged
  by any of this.

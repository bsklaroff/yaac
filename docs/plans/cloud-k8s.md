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

What is NOT there: `--adopt-cni` deploys no server, because nothing yet
selects the tailnet fronting together with the StorageClass-backed claims
a foreign cluster needs, and the static hostPath pair it applies today is
wrong for anything but a kind rehearsal. That gap is the whole of this
plan.

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
    volume root the install uid's (step 6b).
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

Each step lands and pays off on kind before the next starts; the e2e suite
on kind (single and `--nodes 3`) is the gate for every one of them, and the
kind-byo tier described under step 6 joins that gate as soon as it
exists.

### 1. Storage: claims on kind — shipped

docs/server-in-cluster.md "Storage is two claims" is the current-state
reference; the one-shot layout migration and the lock fallback are in
docs/legacy-compat-shims.md. What step 6 still owes storage is the byo
half: StorageClass-backed claims in place of the static pair, and
`storage-semantics` promoted from warn to fail.

### 2. Node tuning into the DaemonSet — shipped

docs/cluster-setup.md ("The gVisor runtime and the node tuning", "What
survives a restart, and what heals itself") is the current-state
reference. What the `podman exec` loop still applies is decided by whether
the nodes are podman containers, not by a flag; step 6 decides whether
`--byo` should refuse to touch a node container it can reach.

### 4. Server publication and the ingress wall — shipped

docs/server-in-cluster.md "Reachability" is the current-state reference.
`--tailnet` selects the tailnet fronting on any cluster today; step 6 makes
`--byo` imply it. The tailnet gate (a second device reaching a
`--tailnet` kind install through `yaac remote set`) runs with the operator
installed on the test rig.

### 6. `--byo`: the cloud install end to end

Today a foreign cluster gets the in-cluster layers (`--adopt-cni`) and no
server, and the tailnet fronting exists without the storage, uid and
architecture a foreign cluster needs. Step 6 closes that gap in five
pieces that land separately, in this order. 6a and 6b change nothing a
kind install does; 6c stands up kind-byo, the local stand-in for a cloud
cluster that gates everything after it. 6d, the TLS Ingress fronting, has
shipped together with the removal of the server's tokens, so `--byo` is
built and tested against the identity model from the start.

What a finished `yaac cluster install --byo --rwx-storage-class <c>` does:

1. **Gates, before anything is applied or built** — right after the
   binary shopping list, ahead of the podman machine bootstrap:
   architecture, node OS and containerd, CNI (today's adoption gate), the
   Tailscale operator and its IngressClass, the storage classes, the
   install's identity and its kube context. A refusal leaves the cluster
   and the host untouched.
2. **The in-cluster layers**, exactly as every mode applies them.
3. **The claims**, provisioned from the named classes, owned by the
   install uid, pinned `Retain`, labelled so a later install finds them.
4. **The server** at uid 1000, fronted by the operator's TLS Ingress at an
   `https://` origin, registered in `server.json` as that origin — no
   token; the Ingress's identity headers are the credential
   (docs/remote-hosting.md).
5. **`cluster check`**, with the storage gates fail-level.

#### 6a. Take the host's disk out of install and check

Three things still assume the install's bytes sit on the machine running
the CLI. Each is replaced by a path that works on both backends, so this
lands on kind with no behavior change, and afterwards the only host-disk
dependency left in install and check is the kind static PV pair itself.

- **The end-to-end probe and the multi-node `volume-nodes` sweep** write a
  nonce into `globalRoot()` on the host, read the pod's write back from it,
  and `measureRoundTrip` polls the host for the beacon. The host's half
  moves into a *peer pod*: runc, at the install uid, mounting `yaac-global`
  whole. It writes the nonce, waits for the probe's beacon, writes the
  second nonce, times the ack and prints the round trip; the check reads
  both pods' logs. On a multi-node cluster the peer carries anti-affinity
  against the probe, so the number is cross-node — the coherence number an
  NFS class is judged by. On kind the peer's bytes are still the host's,
  so kind's verdict does not change. `measureRoundTrip` and the host-side
  nonce files are deleted.
- **`yaac server logs`** reads `<dataDir>/server-local/server.log` off the
  host. It routes through `runDeployedServerVerb` for every k8s install:
  `kubectl exec deployment/yaac-server -- tail [-n N] [-F]
  "$YAAC_SERVER_LOCAL_ROOT/server.log"`. One path for both backends, and
  the existing `server logs` e2e-cli cases (`-f` and `-n` included) cover
  it against the deployed server.
- **The uid is an install decision, not a `getuid()`.**
  `hostUidSecurityContext()` reads the calling process's uid. That is
  right inside the server pod (which runs as whatever install stamped) and
  right on a kind host, and wrong for a byo install run from a laptop,
  where 501 means nothing to an NFS server. Install decides the uid — the
  host's on kind, because of the virtiofs ceiling; a fixed `1000` on byo,
  where NFS passes uids through raw and a constant keeps ownership stable
  no matter which machine re-installs — and stamps it on the server
  Deployment. Everything in the cluster keeps deriving from the server
  pod's own `getuid()`, as today. The host-side callers that are not
  install — `cluster check`'s probe pods and the e2e harness — read it
  back off the live Deployment's `runAsUser` (the Deployment is the record,
  as the Service is for fronting), falling back to `getuid()` only when
  there is no Deployment. The helper is renamed for what it now is
  (`installSecurityContext(uid)`); the `supplementalGroups: [0]` half is
  unchanged.

#### 6b. Claims provisioned from a StorageClass

`ensureStorageClaims` takes a storage shape — `static` (the two host paths)
on kind, `classes` (`rwx`, `rwo`) on byo. The class path:

1. **Re-adopts a Released volume of this install before provisioning.**
   `Retain` only protects data a later install can find again: a namespace
   delete leaves both PVs `Released`, and a fresh claim would otherwise
   provision two empty volumes beside them. So it looks first for a PV
   carrying this install's hash and the claim's name; if one is Released
   it clears the stale `claimRef` uid and pre-binds the new claim to it by
   `volumeName` — the recovery the static path already performs on its
   own volumes.
2. **Applies both claims** naming their class, RWX for `yaac-global`, RWO
   for `yaac-server-local`.
3. **Binds them with a short-lived binder pod** (`yaac-storage-bind`: runc,
   root, mounting both claims). A `WaitForFirstConsumer` class — the
   common case for block storage, and local-path's — binds nothing until a
   pod schedules, so install cannot wait on `Bound` alone; the binder is
   that consumer, for every class. It also makes each volume root the
   install uid's (`chown uid:gid`, `chmod 2775`), once, when it is not
   already: csi-driver-nfs provisions its subdirectory `0755 root:root`, a
   fresh block volume is root-owned, and every other path under the root
   is created by the server at the install uid. This replaces `fsGroup`,
   which is the kubelet doing the same chown as root on every mount
   (recursively, unless `OnRootMismatch`), would have to go on every pod
   that mounts the claim, and is defeated by root squash exactly as the
   binder is — the binder does it once and fails loudly. A chown the
   export refuses is a refusal naming the fix: an export that does not
   squash root, or the class's `mountPermissions`.
4. **Patches each PV after the binder exits**: `Retain`; on the RWX volume,
   `mountOptions` with `actimeo=1` and `hard` merged in — the spike's
   coherence finding, applied to the volume yaac owns rather than demanded
   of a class the operator owns; and the install's labels (namespace,
   data-dir hash, claim name), which are what the re-adoption above and the
   e2e sweep find it by. The binder's own mount predates the option and is
   gone before any real pod mounts the volume.
5. Leaves the registries and the npm cache binding through the default
   class, unchanged. A byo cluster without a default class is refused at
   the gate rather than discovered as a Pending registry claim.

`cluster check`'s `storage` gate learns the class-backed shape: both
claims Bound, both volumes `Retain` and labelled, the RWX volume's
`mountOptions` carrying `actimeo` ≤ 1, and the RWX class still NFS-family
(a class can be edited under an install). The `egress` gate gains one
probe: a worktree-labelled pod cannot open a connection to the RWX
volume's NFS server, where the volume names one (csi-driver-nfs's
`server` attribute). An NFS server speaking AUTH_SYS trusts whatever uid
a client claims, so a sandbox that could reach it could read and write
every project as anyone; the session policy is what stops that, and this
proves it holds on the cluster at hand. `storage-semantics` becomes
fail-level on every backend, not only byo — after confirming kind's current
result is green, since it has been warn-level since step 1. A kind-specific
failure is fixed, or waived by name; it never becomes a backend branch.

Unit tests (`test/drivers/k8s/install/storage.test.ts`) drive
`ensureStorageClaims` through both shapes against staged kubectl reads:
Released re-adoption, a `WaitForFirstConsumer` class, an already-bound
claim, a refused chown.

#### 6c. kind-byo: the cloud install, run locally on Linux

kind-byo is a second kind cluster set up to look like a cloud one, plus a
real `yaac cluster install --byo` into it. It is how the whole byo install
is run end to end on one Linux machine, by hand or by the e2e tier, and it
stays as close to the cloud target as a single host allows:

- yaac creates nothing in the cluster except what `--byo` applies;
- RWX storage is an NFS server behind the CSI driver the self-managed pool
  uses in step 7, and RWO storage is a provisioned class;
- the server is published on the tailnet only, and runs at uid 1000;
- the node-local tier is the node container's own disk, so deleting the
  cluster costs what a drained cloud node costs: cold caches.

It differs from a cloud install in one deliberate way: **its volumes are
backed by its own data dir**, in the layout a kind install uses —
`<dataDir>/global` and `<dataDir>/server-local` — so its bytes can be read,
backed up and removed the same way. It is a separate install with a data
dir of its own; it shares no directory with any other install, and nothing
of another install's data dir is visible to its nodes.

**Why a second cluster, not a second namespace in the existing one.** Two
installs already share a cluster in every e2e run, so this is a choice, and
two things decide it. Isolation: its mounts are `hard`, so a wedged ganesha
blocks every mount operation on those nodes — including the kubelet tearing
pods down — and in a shared cluster that would stall the kind install used
every day. Fidelity: the existing cluster carries everything the kind
install set up (the containerd patch, the node-container fixups, the port
mapping, the `$HOME` mount), so a `--byo` install landing there could not
show that it works without them, which is exactly what a cloud cluster
lacks. A kubeconfig and kube context of its own, with the recorded context
(6e), keep the two installs' commands off each other's cluster.

It is a repo tool, not a CLI mode: `pnpm kind-byo up|down|env`, in
`packages/test-utils`, with its manifests in `test/kind-byo/`. `up` stands
up the stand-in cloud, then runs the published CLI's `yaac cluster install
--byo` against it, as an operator would. Nothing in the CLI knows kind-byo
exists, which is what makes it a test of the cloud path rather than a third
backend. `env` prints the `KUBECONFIG` and `YAAC_DATA_DIR` (default
`~/.yaac-byo`) to export, because kind-byo is a separate install beside any
normal one, and the recorded kube context (6e) refuses cluster commands run
from the wrong shell. `up` is idempotent, like install. Until 6e lands it
installs with `--adopt-cni` — the layers and no server — which is already
all the e2e tier needs, since every test file deploys its own server. From
6e on it is `--byo`, and kind-byo is usable by hand.

| Piece | What | Why this one |
|---|---|---|
| Cluster | kind `yaac-byo`: one control-plane + two workers, `disableDefaultCNI`, none of yaac's kind-config patches, its own kubeconfig, never merged into the default one | two worktree-eligible nodes, so every NFS number is cross-node; yaac's containerd patch left out, so the installer's own `config_path` handling is what runs |
| Node mounts | one kind extraMount on every node: kind-byo's data dir, at its own absolute path | the backing store for both classes below, and — since the `e2e-byo` scratch base lives inside it — for the scratch mount the e2e harness adds to test servers; nothing else of the host is visible to the nodes |
| CNI | the pinned Calico manifest, applied by the script | the adoption gate's happy path, on a CNI yaac did not install |
| RWX | nfs-ganesha (a Deployment on the control-plane node) behind csi-driver-nfs, class `kind-byo-nfs` | the self-managed target's shape: an NFS server you run, provisioned by `nfs.csi.k8s.io` |
| RWO, default | local-path-provisioner, class `kind-byo-local`, marked default, `WaitForFirstConsumer` | a default block class of the kind a provider ships — node-pinned, like a zonal disk — and the reason the binder exists |
| Fronting | the Tailscale operator, its OAuth client from the environment | `--byo` implies the tailnet, and this is where that runs |
| Node fixups | the script sets its node containers' pids ceiling itself | `--byo` never execs a node (6e); the script made these containers, so their podman settings are its |

**The same layout as a kind install.** Ganesha exports the data dir, and
the RWX class names `subDir: global` — a fixed string rather than the usual
per-claim template, because the class belongs to this one install and has
one claim. The RWO class points local-path at the data dir with the
path pattern `server-local`. So `yaac-global` is provisioned at exactly
`<dataDir>/global` and `yaac-server-local` at exactly
`<dataDir>/server-local`, while still going through the provisioners, the
binder and the Retain patch. The classes are written as naively as an
operator would write them — `reclaimPolicy: Delete`, `mountOptions:
[nfsvers=4.1, hard]` and no `actimeo`, no `mountPermissions` — so every one
of 6b's steps is load-bearing here, and `cluster check` fails if any of them
regresses. The data dir holds no `node-local/`.

**Why nfs-ganesha rather than the kernel nfsd the spike used.** The spike
exported from kernel nfsd inside the kind node container: `apt-get install`
into the node, `modprobe nfsd` on the host kernel, and an export that is
host-kernel state shared with everything else on the machine. Ganesha is a
userspace server in an ordinary pod. kind-byo becomes manifests plus one
image; it needs no server-side kernel module and leaves no host state
behind; it restarts like any Deployment, which is how a real NFS server's
restart gets rehearsed; and it runs wherever a privileged pod runs,
including a dev worktree driving the outer host's podman. The NFS *client*
still comes from the host kernel (`nfs`/`nfsv4`, loaded by the
csi-driver-nfs node plugin's mount), as it does on every backend.

The ganesha specifics, each to confirm against the pinned build:

- **Image**: `yaac-kind-byo-ganesha:<contextHash>` from
  `test/kind-byo/ganesha/` (a digest-pinned Debian base with pinned
  `nfs-ganesha` and `nfs-ganesha-vfs`). The script builds it and sideloads
  it with `podman save` + `kind load image-archive` — the Calico sideload
  path — because it has to be serving before `cluster install` creates the
  registry.
- **Export**: one, NFSv4 only (`Protocols = 4`, minor versions 1–2, no
  NLM, RQUOTA or rpcbind), over kind-byo's data dir: `FSAL = VFS`, `SecType
  = sys`, `Squash = No_Root_Squash` — uids must pass through raw, and the binder's chown is
  root's — with `Filesystem_Id` set explicitly rather than left to
  ganesha's detection through the bind mounts. `Graceless = true`, so a
  restarted server does not stall every client through a 90s grace period.
- **Only nodes may mount**: the export's `Clients` is the node addresses,
  and a NetworkPolicy admits nothing but nodes to 2049. An AUTH_SYS server
  that does not squash root trusts whatever uid a client claims, so any pod
  that could reach it could act as any uid on every project. The session
  egress policy already denies worktree pods that dial; this is the second
  lock, and 6b's check proves the first on every cluster.
- **Server-side caching off**: `Attr_Expiration_Time = 0` on the exports and
  `MDCACHE { Dir_Chunk = 0 }`. The data dir is written from the host behind
  ganesha's back — by the e2e suite's seeding, and by you, a backup tool or
  an editor on a hand-run install — and its metadata cache would otherwise
  serve stale attributes and listings for up to a minute. Client-side
  staleness is what `actimeo=1` bounds and what kind-byo should measure;
  server-side staleness would be an artifact of running both ends on one
  host.
- **Backing store**: the extraMount, reached through a hostPath on the
  control-plane node. It must be a real filesystem: FSAL_VFS needs file
  handles that outlive the kernel's inode cache (`open_by_handle_at`),
  which ext4, xfs and btrfs provide, the node container's overlay root does
  not, and a macOS virtiofs share cannot — its FUSE server never offers
  export support, so a handle goes stale as soon as the VM evicts the
  inode. **kind-byo is Linux-only**; a macOS host runs the kind tiers.
- **Pod**: privileged (the handle syscalls need `CAP_DAC_READ_SEARCH`),
  runc, `Recreate`, in its own `kind-byo-nfs` namespace, behind a ClusterIP
  Service on 2049. The node plugin mounts through that Service's name — it
  is hostNetwork with `ClusterFirstWithHostNet` — and a kernel mount from
  the host netns meets no pod NetworkPolicy and no netd redirect.

csi-driver-nfs and local-path-provisioner are pinned the way Calico is: a
version constant, a committed sha256 of the release manifests, a
checksum-verified client-local cache.

**The install uid is 1000, the host's may not be.** Files under a
kind-byo data dir are owned by uid 1000, as they would be on a cloud NFS
server. On a host whose user is 1000 that is invisible; on one whose user is
not, they are readable but not writable from the host — the honest
consequence of running the cloud's uid decision locally.

**The `e2e-byo` project** runs the `e2e` project's files (`test/e2e`,
`test/e2e-cli`) against kind-byo, with `KUBECONFIG` pointed at it and
`YAAC_TEST_BACKEND=byo`. Its global setup refuses, naming `pnpm kind-byo
up`, when kind-byo is absent or its ganesha tag is stale — and when the host
uid is not 1000, since the suite seeds tier files from the host and pods
must be able to write them. The project's ambient data dir is kind-byo's,
so its scratch base is `<kind-byo data dir>/e2e-tmp`: every test file's
data dir sits inside the one export, and the kind tiers' scratch under
`~/.yaac/e2e-tmp` is never visible to it. The test files share the cluster
with the hand-run install, in namespaces of their own, exactly as the kind tiers
share the ordinary cluster with the real one. What changes in the harness
is storage, and only storage:

- `ensureTestStorageClaims` gives each file **its own pair of classes**,
  built the way kind-byo's are: the NFS class with `subDir: <the file's
  data dir, relative to kind-byo's data dir>/global`, the
  local-path class pointed at the file's data dir with the pattern
  `server-local`. Then it runs 6b's class path — the code an install runs —
  instead of rendering static PVs, when the file's data dir is created and
  before any test writes to it.
- So each file's claims land at exactly `testEnv.dataDir/global` and
  `testEnv.dataDir/server-local`. A dozen files read and write those from
  the host — seeding credentials, editing project config, asserting on
  transcripts — and every one keeps working unchanged, with no links, while
  every byte a pod sees goes through NFS or the RWO class.
- The classes are cluster-scoped, so they carry the install-namespace label
  and are swept with the file's PVs. The bytes stay in the file's data dir
  (`Retain`) and go with it.
- A case asserting a kind-only fact is skipped on byo through one helper,
  and the skip names the fact. The target is none outside `cluster-cli`'s
  kind-specific cases.

Gate for 6c: the whole `e2e-byo` project green, and `cluster check` green
on kind-byo with `storage-semantics` fail-level.

#### 6d. The tailnet fronting terminates TLS and identifies the caller — shipped

docs/server-in-cluster.md "Reachability" is the current-state reference:
the ClusterIP behind a `tailscale`-class Ingress named `yaac-server`, the
live Ingress as the record of the fronting, and the machine that runs
install warned when it is a tagged device the server cannot identify.

#### 6e. `--byo`

**Flags.** `--adopt-cni` becomes `--byo` outright. `--byo` takes
`--rwx-storage-class <name>` (required) and `--rwo-storage-class <name>`
(default: the cluster's default class). `--byo` implies the tailnet
fronting, since a cloud cluster has no loopback to publish at; `--tailnet`
stays as kind's way of selecting the same fronting (6d), and alongside
`--byo` it is accepted and changes nothing. `arg-guards` rejects, before
the k8s client is imported: `--nodes` with `--byo`, either class flag
without `--byo`, `--byo` without `--rwx-storage-class`.

**The gates**, in this order. Each reads through `deps.run` (kubectl), so a
unit test stages it and an e2e-cli case can shim it:

| Gate | Reads | Refuses |
|---|---|---|
| Architecture | every node's `status.nodeInfo.architecture`, against `process.arch` (x64 → amd64) | a mixed pool, or any node that differs from this machine — naming both architectures |
| Node OS and containerd | `osImage`, `containerRuntimeVersion`, the Fargate and Autopilot compute labels | a runtime that is not containerd; an immutable OS (Bottlerocket, Container-Optimized OS, Talos, Flatcar); Fargate and Autopilot; k3s and RKE2 by name, until step 7 adds them |
| CNI | today's adoption gate | as today |
| Operator | the operator Deployment (as `verifyTailnetOperator` reads it) and the `tailscale` IngressClass | either one absent — with "could not ask" kept distinct from absent |
| Storage | both classes, and the default class | a class that does not exist; an RWX class that is not NFS-family (`nfs.csi.k8s.io`, `efs.csi.aws.com`, `file.csi.azure.com` with `protocol: nfs`); no default class for the registries |
| Identity | the live `yaac-server` Deployment's `YAAC_DATA_DIR`, and what this data dir's `server.json` records | a Deployment made from a different data dir — installing would re-hash every label and claim name, so the fix is `YAAC_DATA_DIR=<that path>`; a data dir already recorded as a different install (the containerless driver, or another kube context) — one data dir, one install. Keyed on the record, not on whether tier folders exist on this machine: kind-byo's classes provision them there by design |
| Kube context | the context recorded in `server.json` (below) | a different current context |
| Environment | `YAAC_USE_TOR` | set — it names a listener on this machine, which a cloud pod cannot reach |

`cluster check` repeats the architecture and node-OS gates on every run,
so a pool that later gains a foreign node is reported instead of failing
to pull without explanation.

**The node-OS gate is a flavor table with one row.** What the installer
DaemonSet needs from a node is where containerd's config lives, how to
restart containerd, and that containerd reads per-registry `hosts.toml`
from `/etc/containerd/certs.d`, the directory both registries' hosts
writers mount. kind guarantees the last through its config patch; a stock
node may not set `config_path` at all. So the installer script learns to
ensure it: if the node's config sets `config_path`, it must be that
directory, and anything else fails the node's readiness with the reason;
if the config has no registry table, the script appends one,
marker-guarded like the runsc block; if it has one without `config_path`
(the deprecated `mirrors`, which containerd rejects alongside
`config_path`), it fails readiness rather than write a config containerd
will not start with. Stock containerd is the only row step 6 ships,
because it is the only one kind-byo can run. k3s — embedded containerd,
`config.toml.tmpl`, `systemctl restart k3s|k3s-agent`, its own `certs.d`
— is step 7's first addition, made where it can be run.

**What `--byo` applies**: the layers; the claims through 6b's class path at
uid 1000; the server behind the tailnet Ingress; `server.json`
registering its origin. **What it never does**: exec into a node container — the kind
node fixups key on the recorded install being the kind cluster, not on
podman happening to hold containers named like it, which today would apply
them to the wrong cluster on a host running both; run
`migrateDataDirLayout`, since the host data dir is not the install's bytes;
or create host directories for the tiers.

**The kube context is recorded.** Every cluster call uses the kubeconfig's
current context, and anyone with a cloud install very likely has other
contexts too. Install records the context it installed into in
`server.json`, on both backends, and each host-side verb that touches the
cluster — `cluster install|check|delete`, `server start|stop|restart|logs`
— refuses when the current context differs, naming `kubectl config
use-context <recorded>`. A refusal rather than pinning: nothing has to
thread `--context` through the substrate, and the check is one comparison
at the CLI's existing chokepoint. A `server.json` without the field
predates it and goes unchecked until the next install records it — a
read-time tolerance, so it gets its docs/legacy-compat-shims.md entry.

**`yaac cluster delete` refuses on byo**: the cluster is not yaac's to
delete. It prints the uninstall — delete the install namespace, delete the
install-labelled cluster-scoped objects — and says that the two `Retain`
volumes survive it, and how to remove them deliberately.

**Coverage.** Every gate is unit-tested against staged reads, extending
`install.test.ts` in place. In e2e-cli, `cluster-cli.test.ts` gets one case
per argument, each stopping before any mutation; where a refusal needs a
cluster that says something specific, a PATH-shimmed `kubectl` answers
canned node, class and Deployment reads:

| Argument | Cases |
|---|---|
| `--byo` | refuses a pool of the other architecture (faked node list), naming both; refuses without the operator; rejected with `--nodes` |
| `--rwx-storage-class` | refuses an absent class; refuses a non-NFS class; rejected without `--byo`; `--byo` without it rejected |
| `--rwo-storage-class` | refuses an absent class; rejected without `--byo` |

The happy path runs on kind-byo, which now installs with `--byo`. One rich
file, `test/e2e-cli/byo-install-suite.test.ts` (in `e2e-byo` only), drives
the installed server through its published `https://` origin: `yaac remote
set`, `/whoami` answering the rig's tailnet login (the Ingress's identity
reaching the pod), a worktree create, a terminal WS carrying that identity
on its upgrade, `yaac forward` through the tunnel,
`server stop|start|restart|logs`, `cluster check` green, `cluster delete`'s
refusal, and a re-install converging in place. Last, because it destroys
its subject: a namespace delete, then a re-install that re-adopts the
Released volumes and finds its projects. That file needs a tailnet — the
environment `pnpm kind-byo up` runs in carries an ephemeral, tagged
operator OAuth client, and without one `up` stops at the operator gate and
says so. The suite's own client, by contrast, must be a *user-owned* device:
the operator client is tagged by design, but a tagged client's requests
carry no user and the server refuses them until the `whois` follow-up
(docs/plans/multi-user-deployment.md) lands. The rest of
`e2e-byo` does not: its files deploy their own servers with no fronting.

#### 6f. Docs, in the same change as each piece

- docs/cluster-setup.md: "Adopting a CNI yaac did not install" becomes
  "Bring your own cluster" — the gates, the classes, what `--byo` never
  does, delete's refusal. "Runtimes and uids" gives the per-backend uid.
- docs/server-in-cluster.md: "Storage is two claims" gains the byo column
  (class-provisioned, binder-owned, Retain-patched, re-adopted);
  "The uid
  everything runs as" says install decides and the Deployment records;
  "Lifecycle" says `server logs` reads through the pod; "The e2e tiers run
  against this" adds the `e2e-byo` project and its per-file classes.
- docs/cluster-setup.md also gets "Running byo locally: kind-byo" — what
  `pnpm kind-byo` stands up and why each piece, why ganesha, why the
  volumes land in the data dir, why Linux only, and the uid-1000
  ownership.
- docs/remote-hosting.md: the k8s server setup becomes `yaac cluster
  install --tailnet` — install states the allowed host itself, so the
  `tailscale serve` + export + re-install recipe
  stays for containerless only. A byo install is remote-hosted from the
  start. Both publish at the Ingress's origin, and on kind that origin
  replaces `127.0.0.1`.
- This plan: step 6 is deleted when 6e lands, and steps 1, 2 and 4 lose
  their pointers to it.

**Gate for step 6**: the full e2e suite green on kind (single-node and
`--nodes 3`) and on `e2e-byo`, and `byo-install-suite` green on kind-byo.

**Retire these first.** Each is an hour against the pinned version, and
each has a fallback that changes the design above rather than the goal:

- A PV's `mountOptions` can be patched after binding, and csi-driver-nfs
  (and the EFS and Azure Files drivers) honor it at the next mount.
  Fallback: the storage gate refuses an RWX class without `actimeo` ≤ 1,
  and the operator sets it on the class.
- Ganesha's FSAL_VFS works over kind-byo's bind-mounted data dir on ext4,
  xfs and btrfs, with `Filesystem_Id` pinned, and its caching knobs behave
  as stated. Fallback for the caching: the harness seeds the tiers through
  a pod instead of from the host, at the cost of a helper per host write
  in the suite.
- csi-driver-nfs accepts a fixed `subDir`, and local-path-provisioner
  takes a per-class node path and path pattern (its `storageClassConfigs`
  and `pathPattern`). Fallback: kind-byo binds each claim to a static
  volume of the class's name at the same path — still `Retain`-patched and
  binder-owned, but no longer dynamically provisioned, which is the one
  step it would then stop rehearsing.
- The operator's Ingress proxy stamps `Tailscale-User-Login` /
  `Tailscale-User-Name` and `X-Forwarded-For` on every request it proxies
  (WebSocket upgrades included), strips client-supplied copies, preserves
  `Host`, and stamps the parent-resource labels the ingress peer selects
  on (docs/remote-hosting.md records what serve does). Fallback: a
  `tailscale serve` sidecar in the server pod, configured by
  `TS_SERVE_CONFIG` and holding its own auth key — it replaces the
  operator as the fronting rather than changing the goal.
- Whether kind's node image already sets `config_path` without yaac's
  kind-config patch. If it does, kind-byo exercises the installer's
  "already set" branch, and the "absent" branch is covered only by the
  installer script's unit test.

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

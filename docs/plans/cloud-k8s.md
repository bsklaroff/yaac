# Cloud-hosted Kubernetes: what is left

Goal: run the k8s driver on a cluster somebody else hosts. First EKS
(Amazon Linux), then AKS (Ubuntu) as a second provider port. They use the same code and the same
in-cluster infrastructure as the local kind install. The local install keeps
its data dir on the host's own disk, so it never needs a network filesystem
or a backup story beyond the host's. Only the cloud install pays for storage
that can move between nodes, and it pays in manifests, not in code paths.

## Where things stand

The cloud install itself has shipped and is tested locally:

- **`yaac cluster install --byo`** installs into an existing cluster
  (docs/cluster-setup.md "Bring your own cluster"). It gates on node pool,
  CNI, Tailscale operator, storage classes, install identity and kube
  context. It refuses immutable-OS nodes, Fargate and Autopilot, and a node
  pool whose architecture is mixed or differs from the CLI machine's
  (`byo-gates.ts`).
- **The server** is an in-cluster Deployment. Under `--byo` it is published
  only through the Tailscale operator's Ingress (`--tailnet` does the same on
  kind). See docs/server-in-cluster.md "Reachability".
- **Storage** is two claims on every backend: `yaac-global` (RWX) and
  `yaac-server-local` (RWO). kind binds them to static hostPath volumes in
  the data dir; byo provisions them from named classes and pins them
  `Retain` (docs/server-in-cluster.md "Storage is two claims"). The
  node-local tier is node disk on both (docs/workspace-storage.md "The
  node-local tree").
- **opencode's SQLite** runs on a node-local copy checkpointed to the shared
  tier (docs/workspace-storage.md "opencode").
- **Egress** (Calico NetworkPolicy plus netd's redirect) and the gVisor
  installer are per-node DaemonSets and work multi-node
  (docs/workspace-egress.md, docs/cluster-setup.md "Multi-node").
  The installer also applies node tuning on every node.
- **gVisor with no user namespace** is what makes an NFS-backed volume
  usable at all: the sandbox needs no idmapped mount (docs/cluster-setup.md
  "Runtimes and uids").
- **Images bake no uid** (docs/arbitrary-uid-images.md). `runAsUser` is the
  host uid on kind and `1000` on byo.
- **Built-in images** are built by podman on the CLI machine and pushed
  through the CLI's registry port-forward (docs/cluster-setup.md "Images
  are built here, and only here").
- **Test rigs:** multi-node kind (`--nodes N`); `pnpm kind-byo` stands up a
  cloud-shaped cluster on one Linux host (NFS through csi-driver-nfs, a
  `WaitForFirstConsumer` default class, the operator), and the `e2e-byo`
  and `e2e-byo-install` projects run against it (docs/cluster-setup.md
  "Running byo locally: kind-byo").

An NFS-under-gVisor spike (branch `nfs-gvisor-storage-spike`,
`test-storage-probes/`) found shared storage workable if checkouts and the
pnpm store stay node-local. Mount with `actimeo=1` (cross-client visibility
25–57ms). Checkout creation and git checkout were about 10x slower on NFS
than on node disk (7.6s vs 0.75s, 4.0s vs 0.57s). gVisor's sentry locks
never reach the server, so each file on the shared tier needs a single
writer.

What is left is running on real targets and the operations around them.

## Decisions

- **kind stays the local backend.** No k3s-on-Linux or Lima/minikube
  backend. kind's install-time fixups are cheaper than a second local
  backend, and kind-byo is what stands in for a cloud cluster.
- **Two backends, one driver.** Above install, nothing knows which backend
  it is on. Every difference (which volume backs a claim, what fronts the
  Service, which uid runs) is a manifest install renders, never a branch in
  the driver.
- **Nodes are disposable.** Nothing a workspace needs to resume may live
  only on the node it last ran on, and no workspace pod is pinned to a
  node. The node-local tier holds only re-derivable caches and working
  copies of a checkpoint on the shared tier.
- **The tailnet is the only way onto a cloud server.** No public
  LoadBalancer or Ingress, no cert-manager, no DNS.
- **One architecture per install.** Lifting the architecture refusal means
  publishing per-architecture images each release for install to pull.
  That is out of scope here.
- **The gVisor node install limits portability, and that is accepted.**
  Editing a managed node's containerd is unsupported by vendors but works on
  mutable-OS pools. Cilium-mandated platforms (GKE Dataplane V2, DOKS) break
  netd's redirect and are out (docs/workspace-egress.md "Managed-cloud
  portability"). A GKE Sandbox adapter is not planned.
- **Backups stay outside yaac,** with one exception. Provider snapshots of
  the two volumes are the operator's job. The server takes a cold copy of
  `<serverLocal>/db` before it runs a migration (last N, keyed by build id)
  so an image rollout can be reversed. The local install needs neither.

## The work, in order

Each step must pass the e2e suite on kind (single node and `--nodes 3`)
and `e2e-byo`, plus `e2e-byo-install` on kind-byo.

### 1. Real targets

In this order: EKS on Amazon Linux, then AKS on Ubuntu. On each:

- The gVisor installer on the real node OS: sentry probe green, and it
  survives a node-pool upgrade.
- The `egress` gate against each provider's Calico: ours in policy-only
  mode over VPC CNI on EKS, Microsoft's on AKS.
- The storage gates over a real network. The spike numbers are single-host
  best cases, and `actimeo=1` is where staleness bugs would show.
- Workspace `pnpm install` time with the npm cache
  (docs/workspace-storage.md "Package installs") from another node. Also a
  node drain that moves the cache: installs fail until its claim
  reattaches, the same exposure the main registry has for pulls.
- A full workspace life for every tool, opencode included: create, nested
  containers, prewarm claim, then drain the node and resume on another.
  Checkouts stay on the shared tier until step 3, which is correct but slow.
- Reboot and drain: a node drain kills a workspace Job. Surface a "node
  draining" workspace state, and document that in-flight scratch is lost
  while the checkout and transcripts are not.
- Audit the schema for absolute paths. Every path stored in a row must be
  data-dir-relative.
- Write docs/cloud-hosting.md (current-state) as each target passes, using
  the provider table in docs/workspace-egress.md as its scope.

### 2. Operations

- The pre-migration cold DB copy (`db-backup-<buildId>`, last N).
- The lock's lease stays. On byo the RWO claim's attach exclusivity is a
  second guard. On kind, where hostPath enforces nothing, an OFD/`flock`
  fence is still worth adding.
- A dedicated workspace node pool: a `--workspace-pool-taint` option for
  `--byo` that puts a `nodeSelector` on the installer DaemonSet and
  `tolerations` on the RuntimeClasses, and persists across re-installs. Today install's re-apply removes a
  toleration added with `kubectl apply` (docs/cluster-setup.md "Which nodes
  count as workspace-eligible").

### 3. Node-local checkouts (performance, separable)

Checkouts on the shared tier are correct but about 10x slower on git write
paths. A checkout is a clone whose `.git` borrows every object from the
main clone through `objects/info/alternates` (`createCheckout` in
`#domain/git`, docs/server-git.md). The main clone would stay shared; the
server would stage the checkout's `.git`, and a workspace init container
would place it and check out into a node-local directory. Cleanup and GC
then need to know the checkout lives on one node (the node-pinned sweep
pattern).

Disposable nodes set the bar. A node-local checkout holds uncommitted
work, so it must be a working copy of a checkpoint, like opencode's DB: on
stop and on a timer, commit a snapshot of the tree (tracked, untracked and
staged) to `refs/yaac/checkpoint/<id>` on the shared tier. The init
container restores from it when the node-local directory is missing.
Without that, checkouts stay shared: slow is acceptable, losing an hour of
edits to a node upgrade is not.

The file editor (docs/file-editor.md) reads and writes the checkout
through the server's filesystem, so a node-local checkout also needs an
in-pod path for it. A stopped workspace's files would then be reachable
only through the checkpoint.

## Invariants to keep

- A shared-tier file may have many readers and one appending writer.
  Cross-workspace aggregation goes through per-workspace files the server
  merges. Nothing on the shared tier may rely on a cross-pod lock.
- Every path stored in a row is data-dir-relative.
- A driver is handed everything it needs. A byo install's storage classes,
  fronting and uid reach the driver as manifests install rendered, never
  as environment reads inside the driver.
- No filesystem watchers. Freshness comes from polling on reconcile, which
  suits an NFS mount.

## Not planned

- A host NFS export for the local install.
- In-cluster builds of the built-in images.
- A provider registry (ECR, DOCR); the in-cluster registry is used on
  every backend.
- CephFS or JuiceFS. The spike's probes take a mount path and would run
  unchanged against them.
- Multi-user access: docs/plans/multi-user-deployment.md.

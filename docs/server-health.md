# Server health

The **Server health** overlay in the webapp (the pulse icon above Servers
and Settings in the rail, a row on the phone's projects screen) shows how
loaded an install is. It covers total CPU, memory and disk, which
infrastructure component uses what, and what each workspace uses, with an
hour of history. Any user may open it, since every user can read
everything (docs/multi-user.md).

Both drivers implement it. Under `k8s` it reads only what Kubernetes
already collects, so watching it adds almost no load to the nodes.

## What it shows

- **Totals.** CPU cores in use out of capacity. Memory in use out of
  capacity, plus swap. One meter per filesystem: a node's root and image
  filesystems, each PVC, or the data dir's filesystem under
  `containerless`. A single summed disk number would mean nothing. Under
  `k8s` there is also **Scheduled**: pod requests against allocatable
  capacity, which decides whether the next workspace can start.
- **Nodes** (`k8s` only). Usage, swap in use out of the node's swap,
  role (infrastructure only, workspaces, both, or gVisor pending, read
  from the `yaac.workspaces` and `yaac.gvisor` labels and taints), how
  many running workspaces it holds (prewarmed spares are counted under
  Infrastructure), any condition that is not as it should be (`NotReady`,
  `MemoryPressure`, …), and the age of the kubelet's sample.
  A node whose stats cannot be read shows why instead. Swap is shown only
  here and in the totals (see "What it does not do").
- **Infrastructure.** One row per component, with its CPU, memory, an
  hour of memory, and the volumes it owns.

  | `k8s` | `containerless` |
  |---|---|
  | yaac server, main registry, project registries (one row each when expanded), npm cache, crates.io cache, egress proxy, netd (summed over nodes), server front, image builders, prewarmed spares, maintenance pods (the installers, GC and sweeps), and "Kubernetes system and other" (what the nodes use beyond yaac's pods) | the yaac server process (PGlite runs inside it), the workspaces' ssh-agents, and "other host processes" (the host's usage beyond yaac's) |

- **Workspaces.** One row per workspace, sorted by memory: title, project,
  owner, node, CPU, memory against its limit, ephemeral storage, peak
  memory over the hour, and an hour of memory. A workspace that stopped
  keeps its row, with why it died, until its history ages out, so after an
  eviction or OOM kill the overlay still shows what it was doing.

## Where the numbers come from

### `k8s`

Every figure is an API object or the kubelet's Summary API
(`/api/v1/nodes/<node>/proxy/stats/summary`), read through the API server.
That needs `get` on `nodes/proxy` in the server's ClusterRole
(docs/server-in-cluster.md). Kubernetes cannot narrow that to `/stats`: it
reaches every kubelet endpoint, exec included. It adds nothing to a role
that already has cluster-wide `pods/exec`, and it should go if that ever
does. `nodes/stats` would be narrower, but it only authorizes dialing a
kubelet directly on its own port, which needs the server pod to reach every
node and trust each kubelet's serving certificate. The metrics API is not
installed on kind or EKS and has no disk figures.

A server whose role predates the rule gets a 403 for each node, and the
overlay says so in the node's row until the next `yaac cluster install`.

A node that is `NotReady` is not read at all, and every other node's read
is one attempt with a 5s deadline, so an unreachable kubelet costs a read
5s rather than the API server's own dial timeout, retried. While any node
is missing, the totals cover only the nodes that answered, capacity
included, and the overlay says how many that is.

- **Pods** are the install namespace's, classified by the labels yaac
  already sets: `app=` for the Deployments and DaemonSets, `yaac.role=builder`
  for builder pods, `yaac.workspace-id` for workspaces (and
  `yaac.prewarmed` for spares). Any other pod there is maintenance.
- **A pod's memory** is its pod cgroup's working set. The nodes yaac sets
  up run the kubelet's `PodAndContainerStatsFromCRI` gate, so containerd
  reads it from the cgroup on each request. Without the gate (a `--byo`
  pool, or a kind cluster created before yaac set it) the kubelet reads the
  same cgroup through cAdvisor, as old as its housekeeping interval, and a
  new pod's reads 0 until cAdvisor first samples it; the overlay shows the
  containers' sum until then. It is what the kubelet ranks pods by when it
  evicts. For a gVisor sandbox it is
  what the kernel charges and the limit is enforced against: the sentry and
  gofer included, and pages swapped to disk left out. The containers' sum
  would be runsc's own count of the sandbox, which still counts swapped
  pages, so a node that swaps would show its workspaces using more memory
  than the node.
- **A pod's CPU** is the sum of its containers. Without the gate the pod
  level reports no CPU rate until cAdvisor has taken two samples, since it
  computes one from consecutive samples.
- **A node's swap** is the kubelet's root-cgroup figure, whose limit is the
  machine's `SwapTotal` whatever the kubelet's `swapBehavior`. So a node can
  show swap that its pods may not use, and `none` means the machine has none.
- **A node's workspace count** comes from the workspace rows, which need the
  kubelet's stats, so a node whose stats are missing shows no count.
- **Volumes.** Each claim is listed once, under the first component that
  mounts it. `yaac-checkouts` is a second mount of `yaac-global`
  (`substrate/storage-constants.ts`) and is merged into it. hostPath and
  local-path volumes (kind) report no usage: for the two the server mounts
  itself it uses `statfs`, and any other shows its capacity only. Nothing
  walks a directory, since walking the shared volume on NFS would load the
  server every checkout depends on (docs/nfs-checkout-performance.md).
- **Scheduled** sums the requests of every running pod bound to a node,
  cluster-wide.
- **Cost.** A Summary read costs the kubelet about 10ms of CPU and
  containerd about 30ms on a node running a handful of pods, the cheaper
  read barely less; containerd's share grows with the pods on the node,
  since it asks each pod's runtime shim. At one read a minute that is well
  under 0.1% of a core.

### `containerless`

- **A workspace** is the process tree under its tmux server. The port sweep
  (`containerless/ports.ts`) already takes one `ps -axo pid=,ppid=,rss=,time=`
  table every 3s while a workspace runs, and keeps those from the last 30s.
  Usage reads the same tables, so it spawns nothing of its own. CPU is the
  CPU time between the oldest and newest table, because Linux `ps` reports
  whole seconds. Memory is RSS, which counts a page shared by several
  processes once for each, so the overlay calls it approximate.
- **The server** is `process.memoryUsage()` and `process.cpuUsage()`.
- **The host** is `os.cpus()` (CPU time since the previous read), `statfs`
  on the global tier's filesystem, and memory from `/proc/meminfo` on Linux
  or `vm_stat` and `sysctl vm.swapusage` on macOS, because `os.freemem()`
  on macOS leaves out reclaimable cache.

## History

`#runtime/usage` samples every minute whenever the server runs, because
history that started when the overlay opened would be of little use. It
asks the driver for the cheaper read (`resourceUsage({ full: false })`):
under `k8s` the Summary with `only_cpu_and_memory=true`, the install
namespace's pods only, and no claims or cluster-wide pod list. The full read
happens only while someone has the overlay open.

It keeps CPU and memory for the totals, each node, each component and each
workspace, 60 points per series in memory. Disk is not kept: it moves
slowly and is shown live. A keyed series is dropped once its newest point is
over an hour old, which is what keeps a stopped workspace's last hour
visible. History starts over when the server restarts (under `k8s`, at each
upgrade); storing it would cost a table and a write every minute.

What was not measured gets no point rather than a false zero: a node whose
stats are missing, and while any node is missing, the totals and the
components, which would be partial sums. A sample still running when the
next minute comes makes that tick skip, so a slow cluster never stacks
reads.

## Layers

- The contract verb `resourceUsage({ full })` returns the substrate's
  totals, nodes, components with their volumes, and usage keyed by
  workspace id (`SubstrateUsage`). Each driver implements it in its
  `usage.ts`.
- `#runtime/usage` is the sampler and its series, started and stopped with
  the driver (`#main/convergence`).
- `serverUsageReport` in `#domain/workspaces` joins the driver's full read
  and the history with the rows: workspace titles, project names, owners,
  and the death reason of a stopped workspace.
- `GET /api/server/usage` answers it. Every request that arrives while a
  read runs shares it, however long it takes, and its answer serves for 5s
  after it settles. The overlay polls it every 10s while open. It
  is not a snapshot feed: the snapshot hub re-broadcasts to every client on
  each change, and these numbers change on every read.

## What it does not do

- Sizes per project or per checkout. Kubernetes reports a volume as one
  total, and a directory walk would load the shared volume.
- Usage per agent conversation.
- Swap per pod. The kubelet's runtime stats have no pod-level swap, and
  runsc reports none for a sandbox's containers, so a gVisor workspace's
  swap would always read 0. Its pod cgroup's figure is reachable only
  through cAdvisor's metrics, minutes stale, or from a process on the
  node such as netd, which has no channel to the server. `ps` has no
  per-process swap either.
- Alerts, such as a workspace nearing its memory limit or a disk passing
  90%.
- A CLI command.
- metrics-server. It scrapes every node every 15s whether or not anyone is
  looking, keeps only the latest point, reports neither disk nor volumes,
  and kind and EKS do not ship it.

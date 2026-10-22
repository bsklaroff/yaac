# Server health view

Nothing in yaac shows how loaded a server is. When a node runs out of
memory, or a registry volume fills, the first sign is a workspace that
dies or a pull that fails. This plan adds a **Server health** overlay to
the webapp. It shows the install's total CPU, memory and disk, which
infrastructure component uses what, and what each workspace uses, with an
hour of history.

The view works under both drivers. Under `k8s` it reads only what
Kubernetes already collects, so watching it adds almost no load to the
nodes.

## What the overlay shows

**Totals**
- CPU: cores in use out of capacity.
- Memory: working set out of capacity, plus swap in use.
- Disk: one meter per filesystem (node root and image filesystems, the
  shared global volume, each PVC). A single summed number would mean
  nothing.
- Under `k8s` only, **Scheduled**: the sum of pod requests against
  allocatable capacity. This decides whether the next workspace can
  start, which raw usage does not show.

**Nodes** (`k8s` only, collapsible). Each node shows its usage, its role
(infrastructure only, workspaces, or gVisor pending), its pressure
conditions, and the age of its sample.

**Infrastructure.** One row per component, with CPU, memory and the
volumes it owns (used out of capacity).

| `k8s` | `containerless` |
|---|---|
| yaac server, main registry, project registries (grouped, expandable per project), npm cache, egress proxy, netd (summed over nodes), server front, image builders (summed, "N running"), maintenance pods (GC and sweeps), and "Kubernetes system and other" (node usage minus yaac's pods) | the yaac server process (PGlite runs inside it), the workspaces' ssh-agents, and "other host processes" (host usage minus yaac's) |

**Workspaces.** One row per workspace, sorted by memory: title, project,
owner, node, CPU, memory as a bar against its limit, swap, ephemeral
storage, peak memory over the hour, and a sparkline. A stopped workspace
keeps its row until its history ages out, so after an eviction or OOM
kill you can see what it was doing beforehand.

Every user with read access may open the overlay, matching the
multi-user model (docs/multi-user.md: any user can read everything).

## Where the numbers come from

### `k8s`: only what Kubernetes already collects

Every source is either an API object or the kubelet's Summary API
(`/api/v1/nodes/<node>/proxy/stats/summary`). The server reaches the
Summary API through the API server, so it needs one new ClusterRole rule:
`get` on `nodes/proxy` (`buildServerClusterRoleManifest`). The rule takes
effect at the next `yaac cluster install`, the same step that rolls the
server to a new version. Until then the node proxy answers 403, and the
overlay shows that message in place of the node's stats.

| Number | Source | Added load |
|---|---|---|
| Node capacity and allocatable; pod requests and limits | node and pod objects | none |
| Node pressure and Ready conditions | node status | none |
| Pod CPU rate | Summary API: the rate the eviction manager last computed (the handler reads with `forceStatsUpdate=false`) | ~none |
| Pod memory and swap | Summary API: read from containerd at request time | one pass of the eviction manager's own path |
| PVC used and capacity, pod ephemeral storage | Summary API: the kubelet's volume stats cache, refreshed in the background about once a minute | ~none |
| Node root and image filesystems | Summary API: cAdvisor's cached filesystem info | ~none |

The kubelet builds each Summary response when asked. For pod memory it
asks containerd, which asks each pod's runtime shim to read the pod's
cgroup counters. The eviction manager already does the same every 10
seconds, so one extra read per node per minute adds about a sixth to that
path. CPU rates are never recomputed by our reads, so they cannot disturb
the eviction manager's calculation. Eviction decides on memory, not CPU,
in any case.

Volume rules:
- A PVC mounted by several pods is shown once. `yaac-global` and
  `yaac-checkouts` are one backing volume and are merged using the
  install's claim names (`substrate/storage-constants.ts`), so the server
  needs no `persistentvolumes` read.
- hostPath and local-path volumes (kind) report no usage. For the volumes
  the server mounts itself it uses `statfs` instead. Others show capacity
  only.
- No directory walks. Sizes per project or per checkout are out of scope
  (see "Not in this plan").

Components are identified by the labels yaac already sets: `app=` for the
Deployments and DaemonSets (`yaac-server`, `yaac-main-registry`,
`yaac-registry` + `yaac.project-id`, `yaac-npm-cache`, `yaac-proxy`,
`yaac-netd`, `yaac-server-front`, `yaac-gvisor-install`, and the one-shot
`yaac-image-store`, `yaac-node-image-gc`, `yaac-node-local-sweep`), and
`yaac.role=builder` for builder pods. Workspaces are identified by
`yaac.workspace-id`. Any other pod counts toward "Kubernetes system and
other".

### `containerless`: the host

- **Per workspace:** the process tree under the marker's `tmuxPid`, plus
  its ssh-agent, summing RSS and the CPU time used between samples. The
  port sweep (`containerless/ports.ts`) already runs `ps -axo pid=,ppid=`
  every 3s. It grows to `pid=,ppid=,rss=,time=`, and the usage code reads
  the same snapshot, so no new process is spawned. `descendantPids` takes
  the parsed snapshot, so both callers share one parser. RSS counts shared
  pages once per process; the overlay labels it as an approximation.
- **The server process:** `process.memoryUsage()` and `process.cpuUsage()`.
- **Host totals:** `os.cpus()` (CPU time between samples) and `statfs` on
  the data dir's filesystem. Memory and swap come from `/proc/meminfo` on
  Linux and `vm_stat` / `sysctl vm.swapusage` on macOS, because
  `os.freemem()` on macOS leaves out reclaimable cache.

## History

A sampler runs whenever the server runs, because history that starts
when the overlay opens is of little use.

- **Cadence:** every 60s. Under `k8s` the sampler requests
  `?only_cpu_and_memory=true`, which skips the storage section. The full
  Summary is fetched only while the overlay is open. Under
  `containerless` the sampler reads the port sweep's latest snapshot.
- **What it keeps:** CPU, memory and swap for the totals, each node, each
  component and each workspace. Disk is not in the history: volume stats
  move slowly and are already shown live.
- **Where:** in-memory ring buffers, 60 points per series. About 100
  series fit in well under 1 MB. History resets when the server restarts
  (under `k8s`, at every upgrade). Persisting it would need a table, a
  migration, and a write every minute, which is not worth it.
- **Workspaces:** a series is keyed by workspace id and kept until its
  last point is older than an hour, so a stopped workspace's final hour
  stays visible.

## Architecture

Following docs/layered-server.md:

- **`@yaac/shared` types:** `ResourceReport`, containing `sampledAt`,
  `totals`, `nodes`, `components`, `workspaces` and a `history` per
  series.
- **Contract:** a new verb `resourceUsage(): Promise<SubstrateUsage>`.
  It returns the substrate's totals, nodes, components with their
  volumes, and usage keyed by workspace id. Both drivers implement it, so
  it needs no degraded answer.
- **`k8s`:**
  - a raw `getPath(path)` on `ObjectClient`, reusing its auth and
    transient retry, plus stub support in
    `packages/test-utils/src/k8s-stub.ts` (`fakeCluster` seeded with a
    Summary per node)
  - the RBAC rule
  - a module that classifies pods into components and merges volumes
- **`containerless`:** `usage.ts` over the shared `ps` snapshot, `os`
  and `statfs`.
- **Runtime:** the sampler and its ring buffers. It is driver-neutral and
  is started and stopped with the driver.
- **Domain:** an assembler that joins the driver's numbers with rows:
  workspace titles, owners, project names, and the workspace's death
  reason for stopped rows.
- **API:** `GET /api/server/usage`, memoized for 5s, with concurrent
  requests sharing one fetch. The overlay polls it every 10s while open.
  It is not a snapshot-hub feed: the hub re-broadcasts to every client
  whenever its contents change, and these numbers change every sample.

## Frontend

A `ServerHealthOverlay`, built like `ImageBuildsOverlay` and opened from
an item in the sidebar menu. It has meters for the totals, tables for
nodes, components and workspaces, and inline sparklines. There is no
charting library in the package; the meters and sparklines are small
components following the `dataviz` skill.

## Tests

- **unit:server:**
  - `k8s` usage against `fakeCluster` with seeded Summaries: component
    classification, the volume merge, a node answering 403
  - `containerless` usage, mocked at `spawn` and `statfs`
  - the sampler's retention and its stopped-workspace rule
  - the domain assembler
- **Route matrix:** `GET /api/server/usage`, access `reader`, 200 under
  both drivers.
- **e2e-containerless:** a case in `workspace-suite` checks that the live
  workspace has nonzero memory.
- **k8s e2e:** one case in the workspace suite checks the same, plus the
  server and registry component rows. This needs a host with a cluster.
- **Playwright:** a script in `test-playwright-scripts/` for the overlay.

## Docs

- A new reference, `docs/server-health.md`, replacing this plan once the
  feature ships.
- The RBAC rule in `docs/server-in-cluster.md`.

## Phases

0. **Verify on a real cluster** (kind and Hetzner; needs a host with a
   cluster):
   - Summary memory for a gVisor pod matches the pod cgroup's
     `memory.current`.
   - Node-level stats are fresh despite the 300s housekeeping interval
     (`NODE_KUBELET_HOUSEKEEPING_INTERVAL`). If they are not, derive node
     memory from the pod sums plus system, or show the sample's age.
   - Which volume plugins report usage on each platform.
   - The kubelet's and containerd's CPU cost with the 60s sampler
     running.
1. Shared types, contract verb, `containerless` implementation, sampler,
   assembler, route, tests.
2. `k8s` implementation: raw GET, stub, RBAC rule, classifier, tests.
3. The overlay and its Playwright script.
4. The reference doc.

## Not in this plan

- Sizes per project or per checkout. Kubernetes reports each volume as a
  single total, and walking the shared volume on NFS or EFS loads the
  server every checkout depends on (docs/nfs-checkout-performance.md).
- Per-session (per agent conversation) usage.
- Alerts, such as a workspace nearing its memory limit or a disk passing
  90%. docs/plans/storage-gc-gaps.md notes that nothing signals disk
  pressure today; this view's data could feed that later.
- A CLI command, and a link from the desktop Servers page.
- metrics-server. It scrapes every node every 15s whether or not anyone
  is looking, keeps only the latest point, and reports neither disk nor
  volumes. kind and EKS do not ship it.

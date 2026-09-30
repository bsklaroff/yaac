# Storage GC: the remaining gaps

docs/image-gc.md covers the image stores that are collected today: the host
engine, the main and per-project registries, and each node's containerd
store. This plan lists what is still unbounded or unsignalled on a `k8s`
install, most urgent first.

## 1. Node-local image stores keep every image they ever pulled

A project's store (docs/nested-containers.md "The node-local image store")
builds each generation by hardlinking its predecessor (`cp -al`) and then
pulling the current working set. Nothing removes an image that has left
that working set. Dropping old generation directories frees only what the
newest one does not also link, so a node's store for a project holds the
union of everything it has ever pulled until the project is removed. The
registry retention in `rankedRegistryTagsScript` decides what to pull. It
does not decide what to keep.

Proposal: after the pull loop, record the image id of each ref in the
working set. For a ref whose pull failed, record the seeded copy's id, found
by its restored bare name, so a transient registry error never costs the
node an image it had. Then `podman rmi -f` every other image in the new
generation. Removing an image in the new generation unlinks only that
generation's hardlinks, so workspaces still mounting the predecessor are
unaffected. This must be checked against the nested-containers e2e before
it lands, because the opaque-rewrite markers live inside layer dirs.

## 2. The npm cache is never pruned

The Verdaccio claim keeps every tarball any admitted workspace ever fetched
(`npm-cache.ts` accepts this in its header). The fix is an age-based prune
of tarballs by access time, run inside the Verdaccio pod. Verdaccio
re-fetches a missing tarball from its uplink, so a pruned entry costs
bandwidth, never a failed install. Check that it does before relying on it.

## 3. No disk-pressure signal, and no pressure tier

kind's kubelet config turns off image GC and sets every `evictionHard`
threshold to 0%, so a full node never reports `DiskPressure`. The disk
filled with no signal from node conditions, `yaac cluster check` or the
webapp.

- Set a real `imageGCHighThresholdPercent`/`imageGCLowThresholdPercent` and
  a non-zero `evictionHard.imagefs.available` in `k8s/kind-config.yaml`'s
  existing `KubeletConfiguration` patch. This only reaches clusters created
  after the change. Verify it by reading the rendered config on a new
  cluster.
- Every sweep uses a fixed keep count on a fixed timer, and nothing reads
  free space. Add a tier: below a free-space floor, shorten the intervals
  and drop to smaller keep counts. Express the floor in absolute bytes as
  well as percent, because one 5 GB image chain is a rounding error on a
  2 TB host and a crisis on a 100 GB laptop.

## 4. Nothing retires `yaac-test-*` generations in the main registry

The main-registry GC never touches the e2e suite's repos. A run resolves
them by tag from its global setup through its last file, and for long
stretches of that no pod and no namespace marks the run, so the server
cannot tell when they are free. Every e2e run on a cluster therefore leaves
its superseded `yaac-test-server` (nearly every commit) and base chain (every
Dockerfile change) in that cluster's registry. Each node keeps its unpacked
copy too, because the node pass only drops what the registry has dropped.

The suite knows when no worker is resolving anything. Its global setup could
retire them the way `gcTestImages` does on the host engine: keep this run's
own tags plus the newest two per repo, by running
`buildRegistryRetentionScript` for the `yaac-test-*` repos inside the
registry pod before its workers start. Each rig has its own cluster, so
there is no cross-rig hazard. Blob reclaim and the node copies then follow
from the next main-registry pass, on a cluster whose default install runs a
server. A rig that only ever runs e2e would also need the suite to collect.

## 5. E2e node-local trees leak inside the kind node

Each e2e run's server has its own data-dir hash, so its node-local tree
lands at `/var/lib/yaac/node/<hash>` inside the node container's `/var`,
not on the extraMount. The global setup's teardown deletes the run's
namespaces and PVs but never that directory. A one-shot node pod in the
teardown, run like `reapNodeLocal`, would reclaim it.

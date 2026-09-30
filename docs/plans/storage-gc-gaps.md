# Storage GC: remaining gaps

[image-gc.md](../image-gc.md) covers the image stores collected today: the
host engine, the main and per-project registries, and each node's containerd
store. This plan lists what still grows without bound, or fills without
warning, on a `k8s` install. Most urgent first.

## 1. Node-local image stores keep every image they ever pulled

A project's node-local image store
([nested-containers.md](../nested-containers.md) "The node-local image store")
builds each generation by hardlinking the previous one (`cp -al` in
`buildStoreWriterScript`) and then pulling the current working set. Nothing
removes an image that has left the working set. Deleting old generation
directories frees only what the newest one does not also link. So a node's
store for a project holds every image it has ever pulled, until the project is
removed. `rankedRegistryTagsScript` decides what to pull, not what to keep.

Proposal: after the pull loop, record the image id of each ref in the working
set. If a ref's pull failed, record the id of the copy seeded from the
previous generation (found by its restored bare name), so a transient registry
error never costs the node an image it had. Then `podman rmi -f` every other
image in the new generation. This only unlinks that generation's hardlinks, so
workspaces still mounting the previous generation are unaffected. Run the
nested-containers e2e before landing it, because the opaque-directory markers
live inside layer directories.

## 2. The npm cache is never pruned

The Verdaccio cache keeps every tarball any workspace ever fetched
(`npm-cache.ts` says so in its header). Fix: prune tarballs by access time,
inside the Verdaccio pod. Verdaccio should re-fetch a missing tarball from
npmjs, so a pruned entry costs bandwidth, not a failed install. Confirm that
before relying on it.

## 3. No disk-pressure signal and no low-space mode

kind's default kubelet config turns off image GC and sets every `evictionHard`
threshold to 0%, so a full node never reports `DiskPressure`. Nothing warns
the user: not node conditions, not `yaac cluster check`, not the webapp.

- Add real `imageGCHighThresholdPercent` / `imageGCLowThresholdPercent` values
  and a non-zero `evictionHard.imagefs.available` to the existing
  `KubeletConfiguration` patch in `k8s/kind-config.yaml`. This only reaches
  clusters created after the change. Verify by reading the rendered config on
  a new cluster.
- Every sweep uses a fixed keep count on a fixed timer, and nothing checks free
  space. Add a low-space mode: below a free-space floor, sweep more often and
  keep fewer generations. Set the floor in absolute bytes as well as percent.
  One 5 GB image chain is nothing on a 2 TB host and a crisis on a 100 GB
  laptop.

## 4. Nothing retires `yaac-test-*` images in the main registry

The main-registry GC skips the e2e suite's repos (`TEST_IMAGE_REPOS` in
`main-registry-gc.ts`). A run uses them by tag from its global setup to its
last file, and for long stretches of that no pod or namespace marks the run as
active, so the server cannot tell when they are free. Every e2e run therefore
leaves its superseded `yaac-test-server` (new on nearly every commit) and base
chain (new on every Dockerfile change) in the cluster's registry. Each node
keeps its unpacked copy too, because the node pass only drops what the
registry has dropped.

The suite knows when no worker is using them. Its global setup could retire
them the way `gcTestImages` does on the host engine: keep this run's tags plus
the newest two per repo, by running `buildRegistryRetentionScript` for the
`yaac-test-*` repos inside the registry pod before workers start. Each rig has
its own cluster, so one rig cannot delete another's images. Blob reclaim and
the node copies then follow from the next main-registry GC pass, which needs a
server running on that cluster. A rig that only ever runs e2e would need the
suite to run that collection too.

## 5. E2e node-local trees leak inside the kind node

Each install's node-local tree is `/var/lib/yaac/node/<hash>`
(`nodeLocalNodePath`), and only the real install's hash is bind-mounted to the
host by kind's extraMount. Each e2e run's server has its own data-dir hash, so
its tree lands in the node container's own `/var`. The global setup's teardown
deletes the run's namespaces and PVs but never that directory. A one-shot node
pod in the teardown could delete it.

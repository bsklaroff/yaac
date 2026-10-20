# Storage GC: remaining gaps

[image-gc.md](../image-gc.md) covers the image stores collected today: the
host engine, the main and per-project registries, and each node's containerd
store. This plan lists what still grows without bound, or fills without
warning: §1–6 on a `k8s` install, §7 on either driver, §8 under
`containerless`. Most urgent first within each group. The last section
proposes how to keep new stores from leaking.

## 1. The main-registry collect can be skipped indefinitely

`gcMainRegistry` (`main-registry-gc.ts`) runs `garbage-collect` only when
the same pass retired something. If a pass untags generations and then
stands down because a push started, its comment says "the next pass
collects these", but it does not: the next pass retires nothing new, so it
skips the collect too. The untagged blobs stay until some later pass
happens to retire something of its own. The same goes for anything
untagged outside the pass: a tag removed by hand, an orphan repo the sweep
deleted on a pass that then stood down, or a tag re-pushed with a different
manifest.

Fix: decide from the registry's storage, not from what this pass did. Run
`registry garbage-collect --dry-run --delete-untagged` and run the real
collect only if the dry run lists anything eligible for deletion. That uses
the registry's own definition of garbage, so it is exact. A dry run only
reads, so it does not widen the window in which a collect can race a push.
The existing busy re-check still runs just before the real collect.
`retired` is then needed only for `forgetVerifiedTags()` and the log line.

Before relying on it:

- Check the pinned `registry:2`'s dry-run output: the line format, and that
  with `--delete-untagged` it lists the blobs of untagged manifests as
  eligible.
- Time the dry run on a well-filled registry. It reads every manifest and
  lists every blob, the same reads as the collect itself, so it needs its
  own exec deadline.

Fix the stale comment, and give the test that stands down a second pass
that collects. Update step 6 of image-gc.md.

## 2. Node-local image stores keep every image they ever pulled

A project's node-local image store
([nested-containers.md](../nested-containers.md) "The node-local image store")
builds each generation by hardlinking the previous one (`cp -al` in
`buildStoreWriterScript`) and then pulling the current working set. Nothing
removes an image that has left the working set. Deleting old generation
directories frees only what the newest one does not also link. So a node's
store for a project holds every image it has ever pulled, until the project is
removed. `rankedRegistryTagsScript` decides what to pull, not what to keep.
The commonest case is a re-pointed tag: the store pulls the new image and
keeps the old one forever as a dangling image.

A failed run leaks too. Under `set -eu`, a failure after the seed skips the
generation cleanup, and the next run removes only its own new directory, so
incomplete generations pile up until a run succeeds.

Proposal:

- At the start of the script, delete every generation without the done
  marker. The per-project mutex makes that safe.
- After the pull loop, record the image id of each ref in the working set in
  a per-generation file, carried forward from the previous generation's.
  Chain-cache images have no name in the store, so the file is the only way
  to find the previous generation's copy when a pull fails. Write it as a new
  file, never by appending, since a hardlinked file is shared with the
  previous generation.
- `rankedRegistryTagsScript` treats a repo whose tag listing fails as empty.
  It must report the failure instead, and the writer keeps every id the
  previous generation recorded for that repo. Otherwise a transient registry
  error would cost the node images it still wants.
- Then `podman rmi -f --no-prune` every other image in the new generation,
  repeating until nothing changes (a parent cannot go before its child).
  Without `--no-prune`, podman also removes untagged parents, which the
  chain-cache images are. Check that every kept id still exists, and fail
  the run if one does not.
- Also remove the store's `layers.lock` and `images.lock` after the seed.
  podman writes them in place, so today they are shared with the previous
  generation.

Removing images only unlinks that generation's hardlinks, so workspaces
still mounting the previous generation are unaffected. Run the
nested-containers e2e before landing it, because the opaque-directory
markers live inside layer directories.

## 3. The npm cache is never pruned

The Verdaccio cache keeps every tarball any workspace ever fetched
(`npm-cache.ts` says so in its header), and one `package.json` of metadata
per package ever requested. On kind its volume ignores the claim's 20Gi
size and sits in the node's `/var/local-path-provisioner`, on the host disk
but outside the data dir. On a cluster yaac did not create, a real
provisioner enforces the size, and a full cache fails installs.

Fix: prune tarballs by access time, inside the Verdaccio pod, and drop
package directories left with no tarballs. Verdaccio's source shows it
re-fetches a missing tarball from npmjs, since every package proxies the
`npmjs` uplink, so a pruned entry costs bandwidth, not a failed install.
Confirm that with an e2e that deletes a tarball and reinstalls. Access
times are only as good as the host's mount options; fall back to
modification time under `noatime`.

## 4. No disk-pressure signal and no low-space mode

kind's default kubelet config turns off image GC and sets every `evictionHard`
threshold to 0%, so a full node never reports `DiskPressure`. Nothing warns
the user: not node conditions, not `yaac cluster check`, not the webapp.

- Do not turn on kubelet image GC or percent eviction thresholds on kind.
  kind turns them off because the node's disk is the host disk, mostly full
  of the user's own files: at 90% full, image GC would delete every unused
  image every few minutes, and eviction would destroy workspaces (their Jobs
  never retry). Image GC also fights the node rule in image-gc.md, since it
  would drop cached project chains and the digest-pinned mirrors. If a
  kubelet backstop is wanted, use small absolute `evictionHard` floors
  (e.g. 2Gi), set through `applyKindNodeFixups`, which reaches existing
  clusters too. That first needs `ephemeral-storage` requests on the infra
  pods; without them kubelet evicts the server and npm cache before any
  workspace.
- Every sweep uses a fixed keep count on a fixed timer, and nothing checks free
  space. Add a low-space mode: below a free-space floor, sweep more often and
  keep fewer generations. Set the floor in absolute bytes as well as percent.
  One 5 GB image chain is nothing on a 2 TB host and a crisis on a 100 GB
  laptop.

## 5. Nothing retires `yaac-test-*` images in the main registry

The main-registry GC skips the e2e suite's repos (`TEST_IMAGE_REPOS` in
`main-registry-gc.ts`). A run uses them by tag from its global setup to its
last file, and for long stretches of that no pod or namespace marks the run as
active, so the server cannot tell when they are free. Every e2e run therefore
leaves its superseded `yaac-test-server` (new on nearly every commit) and base
chain (new on every Dockerfile change) in the cluster's registry. Each node
keeps its unpacked copy too, because the node pass only drops what the
registry has dropped.

E2e servers' own project images leak the same way. They push under the
`yaac-test` prefix, to `yaac-test-proj-<id>` and `yaac-test-user-<id>` with a
fresh id each run. The orphan sweep matches only `yaac-proj-*` and
`yaac-user-*`, and keeping the newest two per repo never removes a repo.

The suite knows when no worker is using them. Its global setup could retire
them the way `gcTestImages` does on the host engine, keeping the newest two
per repo, by running `buildRegistryRetentionScript` for the `yaac-test-*`
repos inside the registry pod before workers start. But rigs are not one per
cluster: rigs sharing a podman engine (`YAAC_TEST_SHARED_ENGINE`) normally
share its kind cluster, and with it the main registry. So the retention must
protect every rig's tags, not just this run's, which means each rig has to
record the tags it uses where the others can read them. Blob reclaim and the
node copies then follow from the next main-registry GC pass, once §1 makes
that pass collect whatever is untagged. That needs a server running on the
cluster, which the k8s tiers already require.

## 6. E2e node-local trees leak inside the kind node

Each install's node-local tree is `/var/lib/yaac/node/<install id>`
(`nodeLocalNodePath`), and only the real install's is bind-mounted to the
host by kind's extraMount. Each e2e test env's server has its own install
id (`test-<hex>`), so its tree lands in the node container's own `/var`.
The global setup's teardown deletes the run's namespaces and PVs but never
that directory. A one-shot node pod in the teardown could delete it.
vitest does not run the teardown when a run is interrupted, so the pod
should remove every `test-*` tree no live pod is using, not just this
run's, the way the namespace sweep catches an interrupted run's leftovers.

## 7. `server.log` is never rotated

`serverLog` (`#lib/log`) appends every line to `server.log` in the
server-local tier, and `pipeToServerLog` appends the full output of every
podman and builder-pod build. Nothing truncates or rotates it. It sits on
the same volume as the database, so a full log fills the disk the database
writes to.

Fix: when `server.log` passes a size cap (e.g. 50 MB), rename it to
`server.log.1`, replacing any older one, and start a new file. Check the
size every few hundred lines rather than on every append. `yaac server logs`
prints `server.log.1` before `server.log` when asked for more lines than the
current file holds.

## 8. The containerless pnpm store is never pruned

Under `containerless`, each project's workspaces share one pnpm store in
`cachedPackagesDir` (node-local), so `node_modules` hardlinks into it. pnpm
never removes a package from it, and yaac never runs `pnpm store prune`, so
it holds every version any workspace of the project ever installed. A pod
keeps its store in its module dirs instead, which go when it stops, so
`k8s` is unaffected.

Fix: a reconcile step on containerless that runs `pnpm store prune` against
a project's store, about once a day, only while none of the project's
workspaces is running. Prune drops only packages no `node_modules` still
links, so it never breaks a checkout. A stopped workspace's ephemeral
module dirs are removed at stop, so their packages are freed and a restart
re-downloads them. Pruning only when the project is idle avoids racing an
install.

## Keeping new stores from leaking

Every gap above is a store someone added without deciding what removes its
contents. Make that decision part of adding a store, and have a test fail
when it is missing, the way `assertMatrixCoversEveryRoute` fails on a route
the route matrix does not name.

- **One table of stores**, in `packages/test-utils`. Each row is a path
  pattern under a data-dir tier (`global/projects/*/cache-volumes/*`,
  `server-local/server.log`) or a PVC name, plus what bounds it: the name of
  the reconcile step that collects it, "removed with its project", "kept
  with its workspace", or a one-line reason it stays small. A test checks
  step names against the steps the server registers.
- **Check what the suite actually wrote.** Before a test env's data dir is
  deleted (`removeScratchTree`), walk it and fail on any path no row
  matches. That catches files the agent tools write in their homes as well
  as yaac's own, without parsing source. The containerless e2e runs this
  check too, so it works inside a dev workspace.
- **Check cluster storage in unit tests.** The fake cluster stub fails a
  test that applies a PVC, or a pod with a `hostPath` volume or an
  `emptyDir` without `sizeLimit`, that the table does not name. That covers
  what lives outside the data dir: the registries and the npm cache.
- **A CLAUDE.md rule**, like the one for legacy-compat shims: a new store
  gets its row in the same change.

The table records that someone decided, not that the collector works.
§4's free-space check is the backstop: `yaac cluster check` can report the
size of each store in the table, so one that grows anyway shows up before
the disk fills.

# Image GC

Under the `k8s` driver an image passes through several stores, each with its
own lifetime and each needing a collector of its own. A store nothing
collects grows until the disk fills. On kind the disk is the host's, and
nothing warns first.

| Store | What accumulates | Collector | When |
|---|---|---|---|
| Host podman engine | one tagged generation per source change of each yaac-built repo | `gcHostImages` (`#drivers/k8s/image-engine`) | every `yaac cluster install` |
| Main registry, step cache | a cache tag per Dockerfile step per edit | main-registry GC | reconcile, 6 h |
| Main registry, images | one tagged generation per source change | main-registry GC | reconcile, 6 h |
| Node containerd store | every image the node ever pulled, unpacked | main-registry GC, node half | same pass |
| Per-project registries | superseded generations, re-pointed tags | `reconcileProjectRegistryGc` (docs/nested-containers.md "Registry GC") | reconcile, 6 h per project |
| Node-local image stores | whole generations of a project's store | the store writer's own drop (docs/nested-containers.md) | each store build |

The e2e suite's `yaac-test-*` generations belong to the suite, not to the
install: `gcTestImages` retires them on the host engine, and nothing yet
retires them in the main registry (docs/plans/storage-gc-gaps.md).

## The main registry

`reconcileMainRegistryGc` (`#drivers/k8s/images` main-registry-gc.ts)
runs once per 6 h, detached, and only on the default install (`yaac`
namespace). E2e servers share this registry, and a collect started from one
of them could delete a blob out from under another run's push. One pass:

1. **Reads the live set.** This is every `repo:tag` named by a pod, or by
   the template of a Deployment, ReplicaSet, DaemonSet or Job, in ANY
   namespace. Templates are included because a Deployment scaled to zero
   (`yaac server stop`) still needs its image the next time it scales up,
   and ReplicaSets because `kubectl rollout undo` brings an older template
   back. It also includes every layer of every project's current image
   chain, resolved exactly as the prewarm sweep resolves it. A project with
   no running workspace still has a current image, and losing it would cost
   a builder-pod rebuild on the next create. Both reads fail closed. An
   unreadable workload list stops the pass. A chain that cannot be
   resolved stops step 4 for every project, because the `yaac-base` repo
   holds every project's `Dockerfile.yaac` layer side by side, so newest-two
   is no cushion for any one of them. A non-layered `Dockerfile.user`
   mid-edit breaks every chain at once.
2. **Stands down** if the registry is taking a push: an upload in progress,
   or any link written in the last few minutes.
3. **Retires step-cache tags** that no build has written for one
   `--cache-ttl` (docs/trust-split-builds.md "Collecting the step cache").
4. **Retires content-hash generations** of every `yaac-*` repo.
   `buildRegistryRetentionScript`, the retention pass the project
   registries run, is handed the live set as tags it must never retire.
   The newest two per repo are kept as rollback. The project registries
   keep 8 because they have to guess their live set; this one knows it.
   Mirrors carry no 16-hex tag, so they are never candidates. `yaac-test-*`
   repos are never candidates either. An e2e run resolves them by tag from
   its global setup through its last file, with long stretches where no pod
   and no namespace marks it. A run on an older checkout also resolves
   generations that newest-two would not keep.
5. **Collects** with the registry binary's `garbage-collect
   --delete-untagged`, then restarts the registry. Before the collect it
   re-checks the push signals and this server's own builds and pushes.
   docs/trust-split-builds.md explains why the collect runs without a
   maintenance window, which push signals hold it off, and why the restart
   is owed even when the collect fails.
6. **Prunes the nodes** (below), against a fresh read of the workloads.

A retirement also clears the build coordinator's memory of tags it has
verified. Otherwise a create that resolves back to a retired tag, say after
a reverted Dockerfile edit, would hand its pod a ref that 404s. That covers
creates that start after the retirement. One small window stays open. A
create can resolve such a tag between the live-set read and the
retention, which takes seconds and needs a revert to a generation at least
three back. Its tag can then be retired under it: the pod fails to pull,
and the next create rebuilds.

## The node's containerd store

This is where the bytes are. A registry holds compressed blobs, while
containerd holds each image unpacked as overlayfs snapshots. On one host
that filled its disk, 110 GB of snapshots sat beside 1 GB of blobs.
kind turns the kubelet's own image GC off (`imageGCHighThresholdPercent:
100`), and a cluster yaac did not create may configure it any way, so yaac
collects this store itself.

The rule is that a node drops a yaac generation once the main registry no
longer holds its tag and no workload names it. That makes the registry's
retention the only policy for both stores:

- Whatever the registry keeps (current, live, rollback) stays warm on the
  node, so a create never pays a multi-GB pull for an image the install
  still wants.
- Nothing is dropped that a pod could still pull by name.
- Candidates are refs under the main registry host with a 16-hex tag in a
  `yaac-*` repo. So mirrors, the node's own preloaded images and project
  registry images are never touched.

The server reads each node's images from `node.status.images`. The kubelet
caps that list at the node's 50 largest images, and those are the ones worth
reclaiming; smaller images surface as the big ones go. An image goes only
when the registry answers 404 for every one of its tags. A timeout, a 5xx
or no route is not evidence of retirement, and the pass runs just after the
collect restarted the registry, when slow answers are most likely.

The removal runs on the node: a privileged `hostPID` pod calls
`nsenter -t 1 -m -- crictl -t 10m rmi` on the node's own `crictl`, the same
way the gVisor installer reaches the node's systemctl. That pod is node
root, so it runs the digest-pinned upstream `registry:2` (busybox has
`nsenter`) and never a tag in the main registry: a digest ref cannot be
redirected by an overwritten tag, whoever manages to write one. The timeout
is not decoration. crictl's default is 2 s, and a multi-GB delete under it reports
`DeadlineExceeded` and frees almost nothing.

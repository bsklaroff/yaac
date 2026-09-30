# Image GC

Under the `k8s` driver an image passes through several stores. Each has its
own lifetime and needs its own collector. A store nothing collects grows
until the disk fills, and on kind that disk is the host's, with no warning.

| Store | What accumulates | Collector | When |
|---|---|---|---|
| Host podman engine | one tagged generation per source change of each yaac-built repo | `gcHostImages` (`#drivers/k8s/image-engine`), keeps the newest 2 per repo | every `yaac cluster install` |
| Main registry, step cache | a cache tag per Dockerfile step per edit | main-registry GC | reconcile, every 6 h |
| Main registry, images | one tagged generation per source change | main-registry GC | reconcile, every 6 h |
| Main registry, project repos | the repos of removed projects | main-registry GC | reconcile, every 6 h |
| Node containerd store | every image the node ever pulled, unpacked | main-registry GC, node half | same pass |
| Per-project registries | superseded generations, re-pointed tags | `reconcileProjectRegistryGc` (docs/nested-containers.md "Registry GC") | reconcile, every 6 h per project |
| Node-local image stores | whole generations of a project's store | the store writer drops old ones (docs/nested-containers.md) | each store build |

The e2e suite's `yaac-test-*` images belong to the suite, not the install.
`gcTestImages` retires them on the host engine. Nothing retires them in the
main registry yet (docs/plans/storage-gc-gaps.md).

## The main registry

`reconcileMainRegistryGc` (`#drivers/k8s/images`, main-registry-gc.ts) runs
at most once per 6 h, in the background, and only on the default install
(the `yaac` namespace). E2e servers share this registry, and a collect
started by one of them could delete a blob another run is pushing. One pass:

1. **Reads the live set**: every `repo:tag` named by a pod, or by the
   template of a Deployment, ReplicaSet, DaemonSet or Job, in any
   namespace. Templates count because a Deployment scaled to zero (`yaac
   server stop`) still needs its image to scale back up, and ReplicaSets
   because `kubectl rollout undo` restores an older template. The live set
   also includes every layer of every project's current image chain (as the
   prewarm sweep resolves it): a project with no running workspace still
   has a current image, and losing it would cost a rebuild.

   Both reads are strict. If the workload list cannot be read, the pass
   stops. If any project's chain cannot be resolved, step 6 is skipped for
   every project: the `yaac-base` repo holds every project's
   `Dockerfile.yaac` layer side by side, so keeping the newest two protects
   none of them in particular. The usual cause, a non-layered
   `Dockerfile.user` mid-edit, breaks every chain at once.
2. **Finishes an owed restart.** A collect leaves a marker file in the
   registry's storage until the restart after it succeeds. A marker still
   there means a restart was lost (a failed rollout, or the server died
   mid-collect), so the registry is restarted now.
3. **Stands down** if the registry is taking a push: an upload in progress,
   or any link file written in the last 5 minutes.
4. **Retires step-cache tags** that no build has written for one
   `--cache-ttl` (docs/trust-split-builds.md "Collecting the step cache").
5. **Removes orphaned project repos**: `yaac-proj-<id>`, `yaac-user-<id>`
   and `yaac-buildcache-<id>` whose id belongs to no live project, unless a
   workload still names one of their tags. Repos younger than 10 minutes
   are skipped, since a newly added project may be pushing its first image.
6. **Retires old content-hash generations** of every `yaac-*` repo with
   `buildRegistryRetentionScript` (the retention the project registries
   use), passing the live set as tags it must never retire. Beyond the live
   set, the newest two per repo are kept for rollback (project registries
   keep 8, because they have to guess what is live). Mirrors carry no
   16-hex tag, so they are never candidates. Neither are `yaac-test-*`
   repos: an e2e run uses them from its global setup to its last file,
   often with no pod naming them.
7. **Collects** blobs with the registry's `garbage-collect
   --delete-untagged`, then restarts the registry, but only if something
   was retired and the push signals and this server's own builds are still
   quiet. docs/trust-split-builds.md explains why the collect needs no
   maintenance window and why the restart is needed even when it fails.
8. **Prunes the nodes** (below), against a fresh read of the workloads.
   This step runs even when the registry stood down.

Retiring tags also clears the build coordinator's cache of tags it has seen
in the registry, so a create that resolves back to a retired tag (after a
reverted Dockerfile edit) rebuilds it instead of handing its pod a ref that
404s. One race remains: a create that resolves such a tag in the seconds
between the live-set read and the retention. Its pod fails to pull, and the
next create rebuilds.

## The node's containerd store

This is where most of the bytes are. A registry holds compressed blobs;
containerd holds each image unpacked as overlayfs snapshots. On one host
that filled its disk, 110 GB of snapshots sat beside 1 GB of blobs. kind
turns the kubelet's own image GC off (`imageGCHighThresholdPercent: 100`),
and a cluster yaac did not create may configure it any way, so yaac
collects this store itself.

The rule: a node drops a yaac image once the main registry no longer holds
its tag and no workload names it. The registry's retention is therefore the
only policy for both stores:

- Whatever the registry keeps (current, live, rollback) stays cached on the
  node, so a create never pays a multi-GB pull for an image the install
  still wants.
- Nothing is dropped that a pod could still pull by name.
- Only refs under the main registry host, in a `yaac-*` repo, with a 16-hex
  tag are candidates. Mirrors, the node's preloaded images and project
  registry images are never touched.

The server reads each node's images from `node.status.images`, which lists
only the node's 50 largest images; smaller ones show up as the big ones go.
An image is removed only when the registry answers 404 for every one of its
tags. A timeout or 5xx is not proof, and the pass runs just after a registry
restart, when slow answers are most likely.

The removal runs on the node. A privileged `hostPID` pod runs
`nsenter -t 1 -m -- crictl -t 10m rmi` with the node's own `crictl`, the
same way the gVisor installer reaches the node's `systemctl`. That pod has
root on the node, so its image is the digest-pinned upstream `registry:2`
(its busybox includes `nsenter`), never a tag in the main registry: a
digest cannot be redirected by someone overwriting a tag. The 10-minute
timeout matters. crictl's default is 2 s, and a multi-GB delete under it
reports `DeadlineExceeded` and frees almost nothing.

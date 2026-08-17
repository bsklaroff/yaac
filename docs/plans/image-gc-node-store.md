# Image GC: the node's containerd store, and three smaller leaks

Goal: make the k8s driver's disk reclamation cover **every** store an image
passes through, and give it a reason to run harder when the disk is
actually filling. Today it covers three of four stores, and the one it
misses is the one that grows fastest.

This was written after a dev host filled its root filesystem to 100% (301 GB
disk, 2.2 GB free) with a healthy cluster and every existing GC step
enabled and firing. Nothing was broken; the coverage was just incomplete.

## The four stores, and which GC owns them

An image is built on the host, pushed to a registry, then pulled and
**unpacked** by the node. Each of those is a separate store with its own
lifetime:

| Store | Owner today | Reconcile step |
|---|---|---|
| Host podman engine | `#drivers/k8s/image-engine` `image-gc.ts` | swept by `yaac cluster install` |
| Main registry step-cache repos | `#drivers/k8s/images` `build-cache-gc.ts` | `build-cache-gc` |
| Per-project registry blobs | `#drivers/k8s/cluster` `project-registry.ts` | `registry-gc` |
| **Node containerd image store** | **nobody** | — |

The fourth is where the bytes are. Registries hold compressed blobs;
containerd holds them **unpacked** as overlayfs snapshots. Measured on the
node at the point the disk filled:

```
111G  /var/lib/containerd
110G  /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots
1023M /var/lib/containerd/io.containerd.content.v1.content/blobs/sha256
```

So the two registry collects were carefully reclaiming megabytes of blobs
while a ~100× larger unpacked copy of the same images accumulated beside
them, untouched. Of 129 images on the node, 107 were referenced by no
container at all. Pruning them took the store to 9.1 GB and the host from
100% to 62% full.

## Gap 1: nothing collects the node's containerd store

### Why the kubelet's own GC is not the backstop

Kubernetes has image GC built in, and on a stock cluster it would have
handled this. kind turns it off. Live on the node:

```yaml
imageGCHighThresholdPercent: 100
imageMinimumGCAge: 0s
evictionHard:
  imagefs.available: 0%
  nodefs.available: 0%
  nodefs.inodesFree: 0%
```

That is kind's default and it is deliberate — a throwaway CI cluster should
not evict pods or delete images out from under a test run. yaac inherits it
unexamined.

Two consequences, and the second is the worse one. The kubelet will never
reclaim an unused image at any disk level; and because `evictionHard` is
all zeroes it never sets `DiskPressure` either, so the node reported
`KubeletHasNoDiskPressure` on a filesystem with zero bytes free. There was
no reclamation *and* no signal — not in node conditions, not in
`yaac cluster check`, not in the webapp.

### Proposed: a `node-image-gc` reconcile step

A one-shot pod per node that hostPath-mounts the containerd socket and
prunes unreferenced images. This follows the pattern already used for the
registry hosts.toml writers (`buildNodeWritePodManifest` in
`project-registry.ts` / `main-registry.ts`) and the gVisor installer
DaemonSet: node-scoped work expressed as a pod, so it holds on any
cluster rather than only on kind.

It belongs in `#drivers/k8s/images` — the half of image handling that needs
a cluster — as `node-image-gc.ts` off the barrel, with a `node-image-gc`
entry in `steps.ts` beside the other three.

Safety is straightforward: the registries are the source of truth, so a
pruned node image costs one re-pull on next use, not a rebuild. The step is
therefore ordered *after* the registry collects conceptually but needs no
locking against them — the failure mode to avoid is the registry collect
deleting a blob whose only remaining copy was the node's unpacked snapshot,
which cannot happen because the retention pass keeps a tagged generation
in the registry regardless.

Two operational details that cost real time to discover:

- **`crictl`'s default timeout is 2 seconds**, and deleting a multi-gigabyte
  image takes far longer. A plain `crictl rmi --prune` reports
  `DeadlineExceeded` per image and silently accomplishes almost nothing —
  in the incident it freed 6 GB of the 100 available. It needs an explicit
  `-t` (10m was ample) and tolerates being run twice.
- Deletion is not instantaneous in `du` terms; measure after the pass
  settles, not during.

### Proposed: stop inheriting kind's kubelet defaults

`k8s/kind-config.yaml` already carries a `kubeadmConfigPatches` →
`KubeletConfiguration` block (for `swapBehavior: LimitedSwap`), so the hook
exists and only needs a second field set. Give it a real
`imageGCHighThresholdPercent` / `imageGCLowThresholdPercent` pair and a
non-zero `evictionHard.imagefs.available`, so the kubelet both reclaims and
*reports*.

This does not replace the reconcile step. A kubelet-config change applies
only to clusters created after it, so every existing install needs the step
anyway; and yaac aims to run on clusters it did not create, where it cannot
set kubelet config at all. Treat the patch as defence in depth and as the
thing that restores the `DiskPressure` signal — the step is what actually
ships the reclamation.

## Gap 2: retention is a fixed count on a fixed timer, blind to disk

`HOST_GENERATIONS_KEPT = 2`, `REGISTRY_GENERATIONS_KEPT = 8`, and every
sweep throttled to 6 h. A `grep` for `statfs`, `freeSpace` or `DiskPressure`
across `packages/server/src` returns nothing: no GC anywhere reads how much
disk is left.

So the policy keeps eight generations of a ~5 GB image chain per project
repo whether the host has 200 GB free or none, and a host at 99% waits the
same six hours as a host at 10%. After the incident cleanup the two registry
PVCs are still the largest single item on the box at 37 GB (21 GB project +
16 GB main) — that is `KEPT = 8` working exactly as specified.

Proposal: keep the counts as the *steady-state* policy, and add a pressure
tier — below some free-space floor, shorten the sweep interval and drop to
a smaller keep count. The floor wants to be expressed in absolute bytes as
well as percent; a percentage is meaningless across a 100 GB laptop and a
2 TB build host, and one 5 GB image chain is a rounding error on one and a
crisis on the other.

## Gap 3: orphaned anonymous podman volumes

Three dangling anonymous volumes on the host held `docker/registry/v2`
trees — registry storage left behind when their containers were removed
without `-v`. 5.35 GB, invisible as garbage: `podman system df` counts
volumes separately from its `RECLAIMABLE` image figure, and nothing in the
codebase runs `podman volume prune`.

This is small in bytes but unbounded in principle: one leaks per registry
container yaac ever retires. The fix belongs in `image-gc.ts` beside the
dangling-image prune — same store, same sweep, same age floor — and must be
filtered rather than a blanket `volume prune`, on the same reasoning that
scopes the image GC to `YAAC_IMAGE_REPO`: an unrelated volume on a
developer's machine is not yaac's to delete.

## Gap 4: two sweeps self-disable on the hosts that build the most

`reconcileHostImageGc` and `reconcileBuildCacheGc` both return early unless
`testEnv.k8sNamespace === 'yaac'`. The reasoning is sound and documented —
e2e servers share the host engine and the main registry, and a sweep firing
at test-server boot could retire generations a concurrent run's
`requirePrebuilt` worktrees still resolve.

But the consequence is that a machine used primarily for e2e never sweeps,
unless a default-namespace dev server also happens to be running to do the
cleanup for everyone. Those are precisely the machines that build the 5 GB
`yaac-test-*` images.

Proposal: keep the gate on the *retire* pass and let the safe half run
everywhere. A dangling-image prune with the existing 24 h age floor cannot
touch a prebuilt test image (it is tagged, and `requirePrebuilt` resolves it
by tag), so it is safe from any namespace. Alternatively, give the e2e
global setup an explicit end-of-run sweep, which knows when no worker is
still resolving anything.

## Order of work

1. **`node-image-gc` step.** Largest reclamation by two orders of magnitude,
   and the only gap that is unbounded on a live install.
2. **kubelet config patch in `kind-config.yaml`.** Cheap, restores the
   missing `DiskPressure` signal, but only helps clusters created after it.
3. **Volume prune in `image-gc.ts`.** Small and self-contained; fold in with
   whichever of the above lands first.
4. **Disk-pressure tier across all four sweeps.** Most design work, and the
   least urgent once (1) exists — but it is what turns "the GC has coverage"
   into "the GC responds".
5. **Relax the namespace gate.** Independent of the rest.

## Verifying

The k8s tiers are host-only, so this is not checkable from a yaac dev
worktree; it needs a wired-up cluster. Per-item:

- Unit tests for the new module go in
  `packages/server/test/drivers/k8s/images/node-image-gc.test.ts`, one
  `describe` per barrel function defined there, mocking at the process
  boundary (kubectl) rather than at a sibling module.
- The reclamation itself wants an end-to-end check on a real cluster: record
  `crictl images | wc -l` and `du -sh /var/lib/containerd` on the node before
  and after a sweep, and confirm every worktree pod stays Running and a
  fresh worktree create still resolves its image (from the registry, with a
  pull it did not need before — that re-pull is the expected cost).
- The kubelet patch is verified by reading the rendered config on a
  newly-created cluster, not by asserting on the YAML template.

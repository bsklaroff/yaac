# Checkout performance on NFS

On a byo install a workspace's checkout lives on the shared tier, an NFS
volume, and the workspace's git runs under gVisor. This doc records what
that costs, which settings make it cheap, and what stays slow.

## What yaac sets

| Setting | Where | Effect |
|---|---|---|
| runsc `dcache = "200000"` | the gVisor installer's runsc config (`SANDBOX_DENTRY_CACHE`) | the sandbox keeps every file of a large checkout looked up, instead of 1,000 per mount |
| `acregmin=3,acregmax=60,acdirmin=1,acdirmax=1` | the `yaac-checkouts` volume (docs/server-in-cluster.md "Storage claims") | a pod stats unchanged files from its cache; new, deleted and renamed entries still show within a second |
| open after an overwrite | the file editor (docs/file-editor.md) | the one case the cache hides, an edit to an existing file from outside the pod, is seen at once |
| `checkout.workers=8` | `createCheckout` and the workspace's git config | a large checkout or branch switch writes eight files at a time |
| a detached `git status` after each launch | `buildCloneLinkExec` | the sandbox's cache fills before the agent or the changes poll needs it |

The rest of the shared tier keeps `actimeo=1`, which its cross-pod
handoffs assume (docs/workspace-storage.md "The shared tier on a network
filesystem").

## Why `git status` is slow without them

`git status` stats every tracked file. gVisor caches at most 1,000 unused
file lookups per mount by default, so on a larger checkout each status
looks every file up again, through the sandbox's file proxy, as a network
call. The NFS client itself is not the problem:

| `git status`, 30k files | Time |
|---|---|
| a pod outside gVisor, on NFS | 1.6s |
| gVisor, on NFS | 11.5s |
| gVisor, on node disk | 1.0s |

A bigger cache alone does not fix it: with `actimeo=1`, every stat more
than a second after the last is still a network call. The changes polls
(every 3 seconds while the explorer is open, every 10 for the git status
bar; docs/file-editor.md) need both the cache and file attributes cached
for longer than the poll interval. The kernel grows an unchanged file's
attribute timeout from `acregmin` to `acregmax`, so an idle checkout is
cached for a minute.

The cache's cost is per entry looked up, not the cap: about one host file
descriptor and 4 KiB of sandbox memory each. After a 30k-file status the
sandbox held 32,224 descriptors (155 cold) and 169 MB (48 MB cold), so a
checkout at the 200,000 cap would cost about 780 MB of the workspace's
8 GiB memory limit. The sandbox's open-file limit is containerd's (on kind,
effectively unlimited).

## How it was measured

On a single-node kind cluster: nfs-ganesha 9 in a pod, exporting an ext4
directory of the host over NFSv4.2; workspace-like pods under runsc
release-20260706.0 (systrap, directfs on); git 2.53. Two repos: this one
(about 1,300 files in 180 folders) and a synthetic one of 30,000 files in
1,000 folders. Each case ran once. Times are in seconds.

The NFS server shares the host, so each NFS call costs well under a
millisecond. On a real network (EFS, a Hetzner volume) uncached work
(creating a checkout, bulk writes, the first status after a start) grows
with each call's latency, while warm `git status` and the poll, answered
from cache, should not.

## Results

| Operation (30k files / 1,300 files) | `actimeo=1`, default cache | yaac's settings | Node disk |
|---|---|---|---|
| `git status`, warm | 11.6 / 0.45 | 0.49–0.58 / 0.12–0.25 | 1.0 / 0.09 |
| changes poll (`add -A` into a private index) | 11.5 / 0.45–0.5 | 0.52–0.58 / 0.09–0.18 | 0.99 / 0.09 |
| commit 20 edited files | 18.1 / 1.06 | 1.25 / 0.51 | 1.7 / 0.15 |
| branch switch, 20 / 105 files | 6.5 / 1.2 | 0.81 / 0.89 | 0.79 / 0.14 |
| branch switch, 1,500 / 1,450 files, 1 worker | 15.5 / 7.4 | 8.9 / 6.9 | 1.4 / 0.6 |
| same, 8 workers | | 5.5 / 3.4 | |
| create, from the server (outside gVisor), 1 worker | 77 / 3.9 | | |
| same, 8 workers | | 18 / 1.2 | |
| create, inside gVisor, 8 workers (node disk: 1 worker) | | 33 / 1.9 | 5.9 / 0.7 |
| first `git status` in a fresh pod | 41 / 2.3 | 27 / 1.5 | 2.6 / 0.33 |

With 16 checkout workers a create took 16s (outside gVisor) and 33s
(inside), no better than 8: the limit moves to the NFS server.

Staleness, with the host changing a checkout from outside the pod:

| Change from outside the pod | `actimeo=1` | NFS defaults | yaac's settings |
|---|---|---|---|
| new file, deleted file, directory renamed in | 2s | 20–40s | 2s |
| edit to a file a running pod has not opened | 2s | 40–70s | 40–70s |
| edit to a file, then opened in the pod | 2s | at once | at once |
| edit while stopped, then a new pod (with or without `nosharecache`, another pod keeping the node's mount warm) | | | at once |

A new pod is a new gVisor sandbox, whose first look at each file opens it
on the host, and an NFS open revalidates the file's attributes. So only a
sandbox that has already looked at a file can see it stale, and a stopped
workspace's edits are seen on restart whatever the node's NFS client still
caches.

The NFS defaults (`acregmin=3,acregmax=60,acdirmin=30,acdirmax=60`) are as
fast as yaac's settings, but would hide a `.git` the server renames into a
checkout during pod boot for up to a minute.

## Settings that do not help

- **gVisor's per-mount `share: container` hint** on the checkout volume
  turns it into a sandbox-private overlay, backed by a
  `.gvisor.filestore.*` file in the volume itself: every write is discarded
  when the pod exits. yaac uses that hint only on pod-local scratch
  (`sentryTmpfsAnnotations`), never on a durable volume.
- **runsc `file-access-mounts = "exclusive"`** caches without revalidating
  and still writes through, but it applies to every mount in the sandbox,
  and a file another machine creates stays invisible to the pod. Without
  the bigger dentry cache it gains nothing.
- **`.git` on node disk, the working tree on NFS.** No gain: `status`,
  `commit` and `checkout` are dominated by walking and writing the working
  tree.
- **NFS caching without the bigger dentry cache.** About 7s for a 30k
  status, against 11.5s.

## What stays slow

For a large repository on NFS, three costs remain several times node
disk's: a cold create with no prewarmed spare to claim (18s against 6s for
30k files), a branch switch that rewrites thousands of files (5.5s against
1.4s), and the first `git status` within about 30 seconds of a start (27s
against 2.6s). The background status hides the last only when nothing asks
sooner; a prewarmed spare has finished warming before it is claimed. A
checkout on node disk, with the shared tier as its checkpoint, would remove
all three. It would also need a checkpoint protocol and an in-pod path for
the file editor, and is worth its cost only for repositories that size on a
slow shared tier, measured there.

# Git on NFS under gVisor

On a byo install the shared tier is an NFS volume, and a workspace's git
runs under gVisor. A k8s workspace's working tree is on its node
(docs/node-local-workspaces.md), because writing one onto NFS costs about
30 ms a file; what stays on the shared tier is each checkout's `.git` and
the main clones. This doc records what git over that costs and which
settings keep it cheap.

## What yaac sets

| Setting | Where | Effect |
|---|---|---|
| runsc `dcache = "200000"` | the gVisor installer's runsc config (`SANDBOX_DENTRY_CACHE`) | the sandbox keeps every file of a large repository looked up, instead of 1,000 per mount |
| `checkout.workers=8` | `createCheckout` and the workspace's git config | a large checkout or branch switch writes eight files at a time |
| a detached `git status` after each launch | `buildStatusWarmupExec` | the sandbox's cache fills before the agent or the changes poll needs it |

The shared tier keeps `actimeo=1`, which its cross-pod handoffs assume
(docs/workspace-storage.md "The shared tier on a network filesystem").

## Why the dentry cache matters

`git status` stats every tracked file. gVisor caches at most 1,000 unused
file lookups per mount by default, so on a larger repository each status
looks every file up again through the sandbox's file proxy:

| `git status`, 30k files | Time |
|---|---|
| a pod outside gVisor, on NFS | 1.6 s |
| gVisor, on NFS | 11.5 s |
| gVisor, on node disk | 1.0 s |

The cache's cost is per entry looked up, not the cap: about one host file
descriptor and 4 KiB of sandbox memory each, so 200,000 entries would cost
about 780 MB of a workspace's 8 GiB memory limit.

These figures came from a single-node kind cluster with nfs-ganesha in a
pod exporting a host ext4 directory over NFSv4.2, under runsc
release-20260706.0 (systrap, directfs on) and git 2.53. On a real network
each uncached call costs more.

## Settings that do not help

- **gVisor's per-mount `share: container` hint** on a shared-tier volume
  turns it into a sandbox-private overlay, backed by a `.gvisor.filestore.*`
  file in the volume itself: every write is discarded when the pod exits.
  yaac uses that hint only on pod-local scratch (`sentryTmpfsAnnotations`),
  never on a durable volume.
- **runsc `file-access-mounts = "exclusive"`** caches without revalidating,
  but applies to every mount in the sandbox, and a file another machine
  creates stays invisible to the pod.
- **Longer NFS attribute caching** on the shared tier would hide a file the
  server changes from a running pod for up to a minute.

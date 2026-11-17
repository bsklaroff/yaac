# Generic prewarmed pods

Under `k8s`, keep a pool of spare workspace pods that belong to no project,
one pool per image, and bind a spare to a workspace when it is claimed. A
per-node agent makes the binding and hands the workspace a working tree it
built natively on the node, kept ready ahead of time for busy repos.

The goal is that a new workspace (a create from the web app, a `yaac-mama`
spawn, a queued launch) starts about as fast as an agent opens in a running
workspace, for any project. A restart gets a pod made on demand and a tree
built on the node.

Nothing here is built. The mechanism was tested by hand on a kind rig in two
runs on 2026-11-16 and on a two-node k3s cluster the same day, and "What the
spike established" below records what was run.

## Why

A spare today (`domain/workspaces/prewarm.ts`) is a fully provisioned
workspace of one project. Its pod spec fixes the project, its repos, their
folders, the cwd, the image and the user's time zone, and its id becomes the
workspace's id. Two things follow:

- A project has a spare only while it has a running workspace, so the first
  create of the day is cold. A cold start takes about 8 seconds to the
  agent's window on kind, 6.5 of them the pod coming up.
- Only a start that has not named its workspace yet can take a spare, which
  is the web app's create alone. A `yaac-mama` spawn and a queued launch
  name theirs first and start cold.

A pod that names no project can be warmed once per image and claimed by
whichever new workspace comes next. With no custom Dockerfile, every project
of every owner resolves to the same image (`resolveImageChain` returns the
tools tag), so most installs need one pool.

## What this builds on

The plan assumes this work, in progress or queued when it was written, has
landed:

- **The claim waits three times, not ten.** One probe exec, the egress
  registration written beside a conditional label patch, and one exec that
  has a single tmux open the windows. It measured what a process costs
  inside a gVisor pod on a quiet rig: 12 ms for `/bin/true`, about 20 ms for
  a `git config`, 30 to 50 ms for a tmux client, 70 to 115 ms for one tmux
  that sources a file and opens a window.
- **The fetch is off the critical path.** A start takes its commit from the
  server's main clone without waiting for the fetch, and catches up when the
  fetch lands through one operation run in the workspace: move this checkout
  to origin's tip if that is safe (a fast-forward, or a reset when the
  checkout is untouched, with hooks off): the catch-up in
  `origin-catch-up.ts`, whose `moveSpare` also moves a spare.
- **No `node-dirs` init container.** The tree container hands the node-local
  directories its pod mounts to the install uid when a life starts, and
  `yaac cluster delete` hands the data dir's node-local folder back to the
  user on a Linux kind host.
- **A restore unpacks a chain with one git process a bundle.** One
  `index-pack` each, borrowing only from the main clones, in place of
  `git bundle verify` and `unbundle`.
- **The tree container's probe notices a filled tree at once**, by waiting
  in-process for the started marker.
- **Every start logs a per-phase timing line.**

Two decisions already made hold here: no agent is launched in a spare, and a
session's opening message stays an argument of the agent's launch.

## What the spike established

Kubernetes cannot add a volume or a mount to a running pod. What makes a pod
belong to a project is almost all mounts, so everything depends on making
content appear inside a sandbox that is already running. Measured on
Kubernetes v1.37.0, containerd 2.3.4 and runsc release-20261005.0:

| Finding | gVisor | runc |
|---|---|---|
| A bind or overlay mount made on the node under a subdirectory of a hostPath volume, with `mountPropagation: HostToContainer` | visible at once, even where the sandbox had cached "no such file" | same |
| The same with no propagation | not visible | not visible |
| A mount stacked on the volume's own root | not visible | visible |
| `runsc exec --cap CAP_SYS_ADMIN` from the node binds a node-mounts entry onto any path inside the sandbox | works; the container itself can neither mount nor unmount | n/a |
| A read-only volume | everything under it is read-only, mounts included | mounts under it stay writable |
| A read-only volume, re-bound read-write inside the sandbox | writable through the bind only | n/a |
| "Bind, then remount read-only" on the node | the pod's copy stays writable | same |
| A read-only mount staged elsewhere, then bound under the volume | read-only in the pod | same |
| Unmount on the node after the sandbox has looked inside | busy; a lazy unmount works | busy only while a file is open |
| Deleting the pod with node mounts still in place | clean, 1.2 s | not run |
| A container started later in the same pod | sees the node mounts made before it started | not run |
| In-place resize of a running pod's request | CPU applies; memory is refused on a node with swap | not run |

On a writable volume, root inside the sandbox (what `sudo` gives an agent)
replaced a root-owned mount point with a symlink into a neighbouring pod's
directory. A mount made there by path name would have landed in the
neighbour.

Timings, on a host at load 13 to 18:

| Step | Cost |
|---|---|
| One mount made by the node | 8 to 16 ms as a `mount` command; a syscall from a program is far less |
| One `runsc exec` entry | 25 to 29 ms |
| A checkout's `.git` created on the shared tier (kind) | 45 to 60 ms |
| Checking out a tree natively on node disk | 0.12 s for 1,820 files, 0.45 s for 14,490 |
| Checking the same trees out inside the sandbox, as today | 0.76 to 0.91 s and 4.6 to 5.6 s |

A hand-built generic pod, bound by shell scripts, reached an open tmux
window 0.53 to 0.81 s after the bind began when its tree was already on the
node, whatever the repo's size. (The spike mounted an overlay over a kept
tree, or bound in a copy; it did not build the rename described below.) When
the tree was checked out inside the sandbox the same claim took 1.5 s and
5.2 s.

### The second run

A second run tried the design's own pieces, on the same rig at host load 5
to 30, with the same two repos (1,820 and 14,490 files). Times below are the
low end of what it saw.

| Finding | Result |
|---|---|
| `runsc exec --env` | adds to the environment: the image's `ENV` and the pod's variables still reach the process |
| `runsc exec --process <spec> --exec-fd` | the process gets exactly the spec's environment (runsc adds `HOME`) and exactly its capabilities |
| A static musl binary passed by `--exec-fd` | runs; `/proc/self/exe` reads `host:[n]` |
| A static glibc binary passed the same way | aborts at startup in `_dl_get_origin`, since that path is not absolute |
| Root with no extra capability, against the read-only node-mounts directory | cannot write it, rename an entry, move the directory (busy) or mount |
| The same with `CAP_SYS_ADMIN` | a remount read-write "succeeds" and every write still fails; entries are not separate mounts in the sandbox, so they cannot be unmounted; unmounting `/node-mounts` itself shows the image's empty directory, and the node is untouched |
| A container with `CAP_SYS_ADMIN` binding from its read-only node-mounts directory | works; after re-running itself with the capability out of its bounding set it can neither mount, unmount nor regain it; a restart of the container redoes the binds |
| A single file bound into the node-mounts directory, then onto a file in the sandbox | works; writes on either side are seen on the other |
| A node-built tree renamed into a workspace's tree directory and bound in | first `git status` clean |
| containerd, then kubelet, restarted with node mounts and in-sandbox binds in place | no container restarts, every bind still works, the rig's own pods are unaffected; back in 2.2 s and 3.6 s |
| A bind the agent pod makes from its own volume (host disk, and NFS mounted on the node) | reaches the sandbox, and outlives the agent pod's replacement |
| A pod labelled as a workspace with no proxy registration | every host refused, allowlisted ones included; no DNS; no npm cache |

Racy index entries. A node-built tree is written in well under a second, so
every file's mtime falls in the same whole second as the index's, and git
treats such entries as possibly changed and hashes each on the next read.
On the big repo, a fresh pod's first `git status` took 6.7 s with the index
moved as written, and 1.2 s with the index copied a second or more after the
build (0.9 s for the second status either way). An index checked with git's
default stat checks in the sandbox, as the tree program's is, took 5.6 s on
its first status: gVisor numbers inodes itself, so every entry differs.

Restores onto a built tree, big repo, `read-tree -u --reset` against the
node-arborist's index under `core.checkStat=minimal`:

| Checkpoint | Written | Time | Today's write into an empty dir |
|---|---|---|---|
| 30 modified, 20 deleted, 2 made executable, 21 added | 53 files; deletions removed | 0.57 to 0.80 s | 8.7 to 14.5 s |
| 2,000 modified, the rest as above | 2,021 files | 7.7 s | 17 s |
| 30 modified, with default stat checks | all 14,491 files | 12.9 s | 6.7 s |

Each ended with the index equal to the checkpoint's tree and the work tree
equal to the index. A file edited before the command with its size and
whole-second mtime unchanged was not rewritten, and `git status` did not
show it.

A claim run as one script on the node, from the take to a tmux window open
at the tree (no API calls, shared-tier work or streamd):

| Step | Time |
|---|---|
| Build on demand in the node-arborist (runc, 4-core limit) | 0.14 s small, 0.30 to 0.52 s big |
| Take (two renames, the `.git` mount point) and four mounts | 31 to 42 ms |
| One `runsc exec` of the static helper making seven binds | 17 to 24 ms |
| One `runsc exec` copying the index and opening a tmux window | 75 to 93 ms |
| Window open, tree ready | 0.14 to 0.15 s |
| Window open, tree built on demand | 0.29 s small, 0.65 s big |
| First `git status` done, tree ready / built on demand | 0.37 / 1.26 s small, 1.3 / 3.7 s big |

Simultaneous builds in one node-arborist limited to 4 cores and 1 GiB: ten of
the small repo all finished in 0.76 to 0.83 s, four of the big one in 2.63 to
2.66 s. Their memory was page cache, not process memory: 409 MiB and 897 MiB
at peak, with almost no anonymous memory.

On a loopback NFS share (a userspace server in a pod, mounted on the node at
NFS 4.0), making a `.git` as `createCheckout` does, about 20 files, took 100
to 119 ms against 25 to 31 ms on node disk; one file create took 0.9 ms
against 0.2 ms.

### The third run, on k3s

A third run used a byo install (`infra/hetzner-k3s`: k3s v1.37.1 on the
host's containerd 2.2.2, runsc release-20261005.0, a control node and one
worker, the shared tier an NFS 4.2 export with `sync` on a Hetzner Cloud
Volume). It ran in a namespace of its own beside the live install, with a
privileged pod standing in for the node-mounter and a gVisor pod on the
workspace image, on the worker. The repos were the install's own main
clones, read over NFS: 1,810 and 16,512 files.

| Finding | Result |
|---|---|
| A bind under a read-only `HostToContainer` node-mounts directory | reaches the sandbox, including a single file; read-only sources stay read-only |
| `runsc exec --process <spec> --exec-fd` | works; state is under `/run/containerd/runsc/k8s.io`, since this k3s uses the host's containerd; the process gets exactly the spec's environment (and `HOME`) and capabilities |
| Binds the agent pod made from its own NFS volumes | still read and write after the agent pod is deleted and after its replacement starts; kubelet cleans up the old pod's volumes |
| A gVisor pod deleted with 17 node mounts in place | 2.0 s; afterwards every mount unmounts without `-l` |
| One NFS create (create, write, close) | 22 ms from the worker, 19 ms on the NFS server's own node (where the server pod writes), 0.03 ms on the volume's ext4 directly |
| A `.git` as `createCheckout` makes it, 25 entries | 0.60 to 0.78 s on NFS, 0.09 to 0.10 s on node disk |
| A native build reading the main clone over NFS | 0.27 to 0.47 s small, 0.56 to 0.93 s big |
| Backdating and rewriting the index | 0.02 s small, 0.19 s big |
| First `git status` in the sandbox, `.git` on NFS, backdated / as built | 0.35 / 0.60 s small, 0.59 / 6.05 s big; the backdated index was not rewritten, the other was; both clean, `write-tree` equal to HEAD's tree |
| The same with git's default stat checks | 5.45 s big |
| A same-size edit at a new mtime on a backdated tree | shown as modified |
| A take: four renames and the mount points | 55 ms |

The NFS cost is the export's `sync` on a network volume, not the network:
the server's own node pays nearly the same.

Unpacking real checkpoints (verify then unbundle, as `restore` did then), the
bundles on NFS and the scratch repository on node disk:

| Chain | gVisor | runc, main clone on NFS | runc, main clone on node disk |
|---|---|---|---|
| 16 bundles, 51 KiB in all | 12 to 21 s across runs | 9.2 s | 2.9 s (2.4 s repacked from 49 packs to one) |
| 1 bundle, 182 MB, no prerequisites | 10.1 to 11.0 s | 4.4 s | not run |

Each verify of a small bundle runs `rev-list --objects --not --all
--alternate-refs`, which starts a `for-each-ref` in each object store, and
each unbundle runs the same check again before its `index-pack`. The
scratch repository has no refs during a restore, so that walk covers every
file of every earlier pass. Over NFS that is 0.25 to 0.6 s per step natively
and 0.35 to 1 s in the sandbox, whatever the bundle's size.

Other ways to unpack the 16-bundle chain, each ending with the same
objects for the final pass, in gVisor (runc):

| Way | Time |
|---|---|
| Verify and unbundle each bundle, as `restore` did then | 16.4 to 21.2 s (9.3 s) |
| Unbundle only | 9.3 to 11.3 s (5.3 s) |
| Unbundle, with a scratch ref put on each pass once unpacked | 6.0 s |
| The same without the `for-each-ref` processes (`core.alternateRefsCommand`) | 3.3 s |
| Read the header, check the prerequisite is a pass already unpacked, one `index-pack --fix-thin --stdin` a bundle | 1.8 to 1.9 s (1.3 s) |
| The same, borrowing only from the main clones while unpacking | 1.5 s (1.05 s) |
| Every bundle's pack spliced into one pack for a single `index-pack` | 0.47 s (0.47 s); 0.25 s borrowing only from the main clones |
| The chain compacted to one bundle first (0.36 s, once) and that unpacked | 0.32 s |

`restore` now unpacks as the sixth row does. Built that way, `yaac-tree`
restored that workspace, from `run` to its started marker, in 3.1 s against
17.2 to 18.4 s, to an identical tree, and the workspace with the 182 MB
bundle in 14.4 s against 16.0 s. Of the 3.1 s, the sixteen `index-pack`
runs are about 1.5 s and writing the two checkouts 1.2 s. Given fifteen
kinds of damage to a copy of the chain (a bundle cut short, cut in its
header, emptied, lost, left out or out of order, and single flipped bits in
its header, pack and checksum), one `index-pack` a bundle and the two
commands it replaced refused the same bundle every time. The 182 MB bundle
is one `index-pack` either way: 8.6 to 10.5 s (4.1 to 4.5 s).

Not run there: restarts of containerd or kubelet, which the live install's
workspaces share.

## Design

### The pod

Every k8s workspace pod has the same shape. Its spec holds nothing a project
owns:

| Mounted at creation | Source | Notes |
|---|---|---|
| `/node-mounts`, in both containers | `<node-mounts root>/<workspace id>/<life>`, a hostPath made by `DirectoryOrCreate` | read-only, `HostToContainer`. Empty until the claim. |
| One scratch volume | an `emptyDir` with the sentry tmpfs annotations, of the size its pool is for | a folder of it is bound over each of the project's scratch dir paths at claim |
| The tmux socket dir, the tree trigger dir | `emptyDir` | as today |
| The proxy CA | ConfigMap | as today |
| Helper commands and bundled skills | a read-only directory on the shared tier, one per server build | today these are staged per workspace; their content is the same for every workspace of a build |

The workspace container starts streamd and an empty tmux server and waits.
It launches no agent. The tree container starts `yaac-tree` waiting for a
claim and passes its startup probe at once.

Each pod has a directory of its own on the node, its **node-mounts
directory**, where everything a workspace owns is mounted at the claim. The
pod sees it at `/node-mounts`. The node-mounts root is beside the node-local
root, not inside it (`/var/lib/yaac/node-mounts/<install id>`). It holds
mount points and nothing else. The sweep pod and the disk pod mount the
node-local root as a hostPath, which captures every mount beneath it that
exists when they start, and they walk it as root. Keeping it outside that
root means no walk of theirs can reach a project's data through a pod's
node-mounts directory.

A start that finds no spare creates the same pod on demand and binds it as
soon as it is ready. What stays in the spec for the few launches that need
it: a byo volume's claim (kubelet has to attach it), a site release's
priority class and node pin, and a run's `secretKeyRef` variables.

### One id

A workspace has one id, and its pod is named for it, as today. A spare is
created with an id, and the workspace that claims it takes that id. So a
start can claim a spare only if its workspace has no id yet:

- **A web create** claims as it does today: the request's own id is swapped
  for the spare's (`claimProvisioning`).
- **A `yaac-mama` create** answers with the workspace's id before
  provisioning finishes. It first takes a spare, which is one label patch,
  and answers with the spare's id. With no spare waiting it makes an id and
  a pod on demand named for it.
- **A queued or scheduled launch** gets its workspace id when it launches,
  so it claims the same way.
- **A restart** already has its id, which its history, its checkpoints and
  its `agent/<id>` branch carry. It gets a pod made on demand, named for the
  workspace. It still gets its tree from the node-arborist.
- **A site release** is made on demand, as today.

Nothing that is keyed by the workspace id changes: the Job's name, the
`yaac.workspace-id` label, the stream token and `YAAC_WORKSPACE_ID` are
right from the moment the pod is created.

A pod's node-mounts directory is named for the workspace and the life, as a
tree directory is. A workspace that restarts gets a new pod under the same
id, and it must never meet the directory of the pod before it.

Restarts could claim spares too if a pod were named for the life it runs
rather than for the workspace. That would bring back a second id on every
pod, and changes to the proxy's index and the stream token with it, so it is
left until restart time is shown to matter.

### The node agent

One DaemonSet, two containers, both from one Go binary.

**The node-mounter** is privileged and shares the host's pid namespace,
which `runsc exec` needs. It sees the node-mounts root and the node-local
root with `Bidirectional` propagation, so a mount it makes there reaches the
node and from there every pod's node-mounts directory. It mounts the shared
tier as an ordinary volume. It never reads repository content. It does four
things:

- **Take.** Moves a tree the node-arborist built into the workspace's tree
  directory, and makes every other node-local directory the workspace
  mounts: the life's scratch repository and opencode's working copy. Each is
  owned by the install uid, parents included ("Ownership on the node"
  below).
- **Bind.** Makes each mount of a workspace under its pod's node-mounts
  directory, then enters the workspace container once to bind each
  node-mounts entry onto its real path.
- **Release.** When a pod is gone, undoes its node-mounts directory (below).
- **Report.** Answers its build, whether the node-arborist answers it, its
  node's free space for trees, and the trees its node holds.

Take, bind and release for one pod hold a lock on that pod. A bind request
carries the claim's own token, so a retry of it is answered as the first
was.

**The node-arborist** runs as the install uid with every capability dropped.
It mounts the main clones read-only and `ready/` read-write, and nothing
else; the node-mounter moves a finished tree to where its workspace mounts
it. It builds working trees by running git natively: every tree a workspace
starts on, of any repo, at any branch or commit a start names.

The node-arborist has CPU and memory limits of its own, so a build cannot
slow a bind, and those limits are what bound a burst of builds. To start
with it requests 50m CPU and 128 MiB, as the tree container does, and is
limited to 4 cores and 1 GiB. A build runs git with eight checkout workers,
so 4 cores lets a burst finish quickly and leaves half of an 8-core node to
running workspaces; past the limit simultaneous builds share the cores and
each takes longer: under it, ten small builds at once all took about 0.8 s
and four big ones about 2.65 s. A build needs almost no process memory. What
the memory limit meets is the page cache of the files it writes, which the
cgroup counts (897 MiB at peak for four big builds) and the kernel reclaims
under the limit.

Only the server may dial the agent, as with the disk pod
(`cluster/disk-pod.ts`): a network policy admits the server alone, and each
request carries a token derived from the install's proxy secret.

### Trees

A workspace's tree is an ordinary directory at today's path
(`projects/<p>/trees/<w>/<life>/tree`), owned by that workspace alone, so
checkpoints, salvage, the disk pod and the node-local sweep work as they do
now. What changes is who fills it. The rule: the node builds trees of
commits the server's main clone has, and the sandbox only ever applies
differences to one. No tree is checked out from nothing inside a sandbox.

- **A built tree.** `<node-local root>/ready/<repo id>/<commit>.<n>/`
  holding `tree/` and the git index that describes it. The node-arborist
  builds under a temporary name and renames into place, so a directory with
  a final name is complete.
- **Kept ready.** The server decides which trees a node keeps (a
  `ready-trees` reconcile step) and the node-arborist converges on it. The
  rule: one tree for each repo that is checked out in a workspace running
  now, or in one that stopped less than a day ago, in any project. The tree
  is at the commit the main clone has for the repo's base branch. Only nodes
  that hold a spare keep trees. When a fetch lands and a base branch has
  moved, the same event that tells running workspaces to catch up tells the
  node-arborist to build the new commit and remove the old tree. A tree
  whose repo has been in no workspace for a day is removed.
- **Built on demand.** A claim that finds no tree for a repo, or names a
  branch or commit other than the base, has the node-arborist build one
  then, at the commit wanted. That is the native checkout measured above,
  0.12 s and 0.45 s, against 0.76 to 5.6 s inside the sandbox.
- **Taken.** A rename on the node's disk, so it costs the same for any repo
  size. A repo at the workspace root becomes the tree directory itself; a
  repo in a folder is renamed into a tree directory made for the claim. The
  index goes into the life's scratch directory beside it.
- **The commit.** The server picks each tree before it makes the `.git`, and
  makes the `.git` at the commit of the tree it picked. The workspace starts
  there, and the catch-up operation moves it to origin's tip when the fetch
  lands. A tree a base-branch start takes is usually at the commit the main
  clone has, since the node-arborist follows the same fetches.
- **Limits.** A build for a start is never queued: it runs at once, beside
  any others, and a pod made on demand has its build begin as soon as the
  pod has a node, while its containers are still starting. What bounds a
  burst is the node-arborist container's own CPU and memory limits. Builds
  ahead of time (a refresh after a fetch, a newly active repo) run one at a
  time and give way to a start's build, so many base branches moving
  together cannot crowd the node. The disk pod reports `ready/` apart from
  workspace trees, and the sweep leaves it to the node-arborist.
- **Low disk.** Under the disk pod's warn floor the node-arborist builds
  nothing ahead of time and the server sets the node's ready set to nothing,
  before `disk-guard` considers stopping a workspace. A build for a claim
  still goes ahead, since there is no other way to get a tree. Under the
  stop floor the node takes no new start at all (below).
- **A restart.** A stopped workspace's restart gets a pod made on demand,
  and its trees are built while that pod starts. For each checkout the
  node-arborist builds a tree at the commit the workspace started from,
  which the main clone holds and never deletes. The tree container then
  applies what the agent made on top of it: the checkout's HEAD and the
  checkpoint. A checkpoint is written by the agent, so that part stays
  inside the sandbox ("Restores" below).

The index is what makes the first `git status` find nothing to do. The
workspace's `.git` sets `core.checkStat=minimal`, which compares
whole-second mtime and size, and a rename changes neither. It does so
today, since the workspace container sees the tree under other inode
numbers than the tree container that wrote it.

Minimal also ignores ctime, so it misses a same-size write that keeps the
recorded whole-second mtime, which `cp -p`, `rsync -a` or an archive
extraction can make; git's default checks see the changed ctime. In the
workspace's `.git` that costs at most an agent's `git status` missing such a
write, as it can today. Nothing durable depends on that index: checkpoints
come from the tree program's own index, which keeps git's default checks.
With those, the inode numbers on an index the node-arborist wrote never
match, so the tree program's first pass hashes every file once (4.4 s of CPU
on the big repo), as it already does after a restart of the tree container.
That pass runs after the started marker, at a random point in the first pass
interval, so it adds nothing to a start.

The first status also hashes every file whose mtime falls in the same
second as the index's own: git cannot tell such a file from one written
after the index ("racy git"). A native build writes every file and the index
within one second, so without care every entry is racy. On the big repo the
first status took 6.7 s as built and 1.2 s with the index a second newer
than the files. So the node-arborist, once git has written the tree, sets
every file's mtime two seconds back and rewrites the stat fields of each
index entry from a fresh `lstat`, leaving the object ids alone. Every entry
is then older than the index, for a tree built on demand as much as one
kept ready, and nothing waits. It reads no content: a Python prototype took
0.17 to 0.19 s for 14,490 files, nearly all of it one `utimensat` and one
`lstat` per file. It is sound for the reason a restore is ("Restores"
below): git wrote every file from those object ids and nothing has touched
them since.

Git's own test suite backdates files the same way (`test-tool chmtime`) to
keep entries out of the racy window. What git offers outside its tests is a
refresh, which re-hashes every racy entry: 0.65 s natively on the big repo,
no faster than waiting for the next second. Setting the index's mtime
forward instead is what git's maintainers rule out, since a same-size edit
in the skipped second would then go unseen. Rewriting the index means the
node-arborist writes git's index format: fixed-size entries, extensions
kept as they are, and the trailing checksum recomputed. It builds with
`index.version=2`, since version 4 compresses paths and would have to be
decoded.

The prototype was checked with native git 2.53 on both repos, and on the
small one in a SHA-256 repository. After the rewrite git accepted the
index, `write-tree` gave the commit's tree, and the first status opened no
tracked file (14,490 as built), clean under both minimal and default
checks. A same-size edit at a new mtime showed as modified. A restore onto a
rewritten tree wrote only the 51 changed files and read nothing from the
tree but git objects.

### A claim

The server, in `#domain/workspaces`:

1. **Pick.** A spare of the wanted image and scratch size, on a node whose
   agent answered recently, preferring a node that holds a tree for every
   repo of the start. For each checkout, the tree to take, or a build on
   demand.
2. **Patch.** One conditional patch of the pod's labels takes the spare:
   project id set, `prewarmed` removed. Concurrent claims of one spare
   resolve as they do today. The Job's labels follow.
3. **Shared tier**, overlapping the patch: each checkout's `.git` directory
   made first and then filled (`createCheckout` with `gitOnly`, at the
   picked tree's commit, with `core.checkStat=minimal` in its config), the
   workspace's own directories, the egress registration, and the start
   instruction once every `.git` is complete.
4. **Agent request**, sent as soon as the directories exist: the trees to
   take or build, and the same ordered list of mounts `createWorkspace`
   builds today (`allMounts` and the tree's), each a source, a path in the
   pod and whether it is read-only.
5. **Claim call.** One streamd request, handled inside streamd's own
   process: wait for the tree container's started marker, write
   `~/.gitconfig` (identity and `safe.directory`) and `~/.npmrc`, restore
   opencode's data, and run one tmux that sets the claim's environment and
   creates the session at the cwd. It starts no process per file, since each
   costs 12 to 50 ms in the sandbox.
6. **Open.** The life's steps and the sessions' windows, as a claim opens
   them today.
7. **Refill.** The pool is refilled only once the claim's window is open,
   since a pod starting beside a claim slows the claim's exec by about 100
   ms.

The node-mounter, for one request:

1. Has the node-arborist build what is not ready, takes each tree, makes the
   life's scratch repository directory and opencode's working copy, and
   makes the mount points the tree needs (each `.git`, scratch dir and
   volume).
2. Makes each mount under the node-mounts directory, `<its node-mounts
   directory>/<n>` for the n-th entry. A read-only source is first mounted
   read-only in a private staging directory, and that mount is bound under
   the node-mounts directory, so the pod never holds a writable copy. Every
   path is opened beneath its root by descriptor and mounted by descriptor,
   never by name.
3. Writes the list of entries into the node-mounts directory, where the tree
   container reads it.
4. Enters the workspace container once (`runsc exec` with a process spec:
   root, `CAP_SYS_ADMIN`) and binds each node-mounts entry onto its path,
   parents first, remounting the writable ones read-write. It also makes a
   folder in the scratch volume for each scratch dir and binds it over that
   dir's path, and binds each bundled skill into the tool homes' skills
   roots. What it runs there is its own program, handed in by descriptor
   ("Entering a container whose image is not trusted" below).

The tree container holds `CAP_SYS_ADMIN` and makes its own binds from the
list in its node-mounts directory: the tree, the scratch directory, the
checkpoints, each `.git` and each main clone at the server's path, as
`yaac-tree` expects them today. It does this when the list appears and again
whenever the container restarts, before anything else, and it takes no pass
unless its tree is a mount. Once the binds are made it gives the capability
up for good, by re-running itself with `CAP_SYS_ADMIN` out of its bounding
set, so it holds the capability only before it has read anything an agent
wrote, and no git it starts can have it. Then it waits for the start
instruction as today. For a fresh life it copies the node-arborist's index
into the `.git` and its own scratch repository, marks the tree started on
the trigger volume and goes to its passes. For a restart it applies the
checkpoint first.

### Restores

Today a restore unpacks the checkpoint's bundles into the scratch
repository, works out each unit's final tree (a checkout's saved files
merged onto its HEAD), and writes every unit into an empty directory with
`git read-tree -u --reset`. With a tree the node-arborist built at the start
commit, a checkout's unit is written with the same command against the
node-arborist's index instead of an empty one, so git touches only the paths
that differ from the start commit. That one command runs with
`core.checkStat=minimal`: the node-arborist's index carries the node's inode
numbers, which differ inside the sandbox, and with git's default checks
every file would look changed and be written again (all 14,491 on the big
repo, slower than writing into an empty directory). Trusting mtime and size
is sound here because nothing has run on the tree between the
node-arborist's build and this command: the node-arborist builds under a
name of its own, and the take moves the tree straight to a life no process
has started in. That has to stay true. A file edited with its size and
whole-second mtime unchanged before the command is left as it was, and git
does not report it afterwards. With it true, a restore writes only what the
checkpoint changed: 53 files in 0.57 to 0.80 s for a checkpoint of 73 paths
on the big repo, against 8.7 to 14.5 s to write the whole tree.

What `yaac-tree` keeps: verifying and unpacking the chain, working out each
unit's tree, every refusal and `--restore-newest` rule, and writing in full
the units no main clone has a base for (a root that is no checkout, a
submodule, a repository the agent cloned or made, with its git dir). Those
are the agent's own files, so writing them is applying a difference from
nothing.

What it loses: `checkOut`, the fresh life's checkout into an empty
directory, and the writing of a checkout's unit into an empty directory on a
restore.

The start commit is the base because the server has it recorded and the main
clone is sure to hold it. A workspace that has moved far from where it
started has a larger difference to apply, never more than today's full
write.

### What moves out of the pod spec

| Today in the spec | Delivered at claim |
|---|---|
| Project id label | the label patch |
| npm-cache label, `YAAC_NPM_REGISTRY` | the label patch, and `~/.npmrc` in the claim call |
| `TZ`, project env and secret placeholders, API-key and `GH_TOKEN` placeholders, `YAAC_PORT_<n>`, `YAAC_CHECKOUTS`, `OPENCODE_CONFIG`, the pnpm store path | the tmux server's environment, set before the session exists, so every window inherits them |
| `YAAC_CWD` | the session's start directory |
| Git name and email | `~/.gitconfig`, written by the claim call |
| `YAAC_STATUS_RIGHT` | set live, as `refreshStatusRight` already does |
| Every mount | the node-mounts directory |
| The tree container's `--life` and paths | the list in its node-mounts directory and the start instruction |

A command the server runs through streamd outside tmux inherits the
container's environment, which holds none of the project's variables. Each
such call either needs none of them or passes its own.

Before a claim the pod has no proxy registration, and the proxy refuses a
pod it has no registration for, so a spare has no egress and holds no
credential.

### Release

A pod's node-mounts directory holds binds of the shared tier and of a
workspace's directories. A recursive delete of a node-mounts directory with
one bind still mounted would delete through it. So:

- The node-mounter finds the mounts under a pod's node-mounts directory in
  the node's mount table, never by walking the directory, and lazily
  unmounts each, deepest first. A sandbox that has looked inside a mount
  keeps it busy, which is why the unmount is lazy.
- It then removes the directory's entries one at a time: `unlink` for the
  files it wrote there, `rmdir` for directories, neither following a link. A
  directory that is not empty stays, and the directory is reported as stuck.
  Nothing under a node-mounts directory is ever deleted recursively.
- It releases a directory only once its pod is gone from the API. It learns
  that from its own watch of its node's pods, not from a request.
- A pod's node-mounts directory is named for one life of one workspace and
  never reused.

The sweep pod and the disk pod are kept to `projects/` and `ready/` under
the node-local root. A workspace's tree holds no mounts on the node: the
`.git`, scratch dirs and volumes inside it are plain empty directories
there, bound over only inside the sandbox.

### Entering a container whose image is not trusted

A workspace's image can come from a Dockerfile an agent edited, and its
files are in place, with code of its own possibly running as root, before
the claim. The node-mounter enters that container with `CAP_SYS_ADMIN`, so
nothing it runs or reads there may come from the image:

- **The program.** A static binary the node-mounter holds on the node,
  passed with `runsc exec --exec-fd`. Naming a path inside the container
  would not do, even a path on a read-only mount: root in the sandbox can
  rename the directory above the mount and put a program of its own at that
  path. A static binary also loads nothing from the container, where a
  dynamic one would take the image's loader and libraries. It must not
  depend on `/proc/self/exe` being a path, which it is not under
  `--exec-fd`: a static glibc binary aborts there, while a static musl one
  runs, and so does Go's.
- **The environment and capabilities.** Given in full in a process spec
  (`runsc exec --process`), with the arguments, the numeric user, every
  variable and the exact capability set. `--env` on the command line only
  adds to the image's `ENV`, where a Dockerfile can set `LD_PRELOAD` or
  `PATH`, and `--cap` only adds to the default set. The program gets
  `CAP_SYS_ADMIN`, plus `CAP_CHOWN` for the scratch folders it makes, and
  nothing else.
- **The arguments.** The list of binds is passed as data, never through a
  shell, since scratch dir and cache volume paths come from project config.
  The uid is numeric, so no `/etc/passwd` is read.
- **The answer.** What the program prints and its exit status come out of
  the sandbox, so the node-mounter treats them as a report from that project
  and nothing more. It decides nothing about the node or another pod from
  them, caps their size, and ends an exec that runs past a deadline, so a
  program that hangs holds only its own pod's lock.

What the image still controls is where a bind lands inside its own sandbox:
it can make a target path a symlink or swap a directory while the program
runs. Every such path leads to somewhere in the same sandbox, which holds
that one project's data and was built from that project's image, so the
project can only misplace its own files.

If the image did get code running with the capability, it could mount and
unmount inside its sandbox and reach more of the sentry's mount code. It
could rearrange the binds, which reach nothing the node-mounts directory
does not hold. It could not make a read-only source writable: those are
read-only mounts on the node, whatever the sandbox's own flag says. The same
holds for the node-mounts directory itself: with the capability, a remount
of it read-write succeeds inside the sandbox and every write still fails,
and unmounting it only uncovers the image's own empty directory. The
node-mounter still never resolves a path under a node-mounts directory by
name.

The tree container holds the capability too, but runs the base image, which
yaac builds, and never a project's.

### Scratch dirs

Today each scratch dir of each checkout is a volume of its own in the pod
spec, at the project's path and with its own size. A volume cannot be added
to a running pod, and gVisor sets these up only when the sandbox starts, so
a generic pod carries one scratch volume and a claim divides it:

- Every scratch dir of the workspace is a folder of the one volume, bound
  over the dir's path. Any number of dirs and checkouts fit.
- The volume's size is the cap for all of them together. A full volume fails
  writes in every scratch dir, and still never evicts the pod, since the
  pod's ephemeral-storage limit is sized above it as today.
- The size is a project setting, the total for the workspace, 32 GiB by
  default (today's two default dirs at 16 GiB each). A dir's own `sizeGiB`,
  and the `path:GiB` form of `yaac config scratch-dirs`, go away. The
  migration that adds the setting gives each project the sum of its dirs'
  sizes.
- The size is in the pod spec, so it is part of what a pool is for (below).
- pnpm's store stays inside the root `node_modules` when that is a scratch
  dir, as today.

### Ownership on the node

No workspace pod mounts anything from the node-local root when it is
created, so kubelet makes no directory there for one, and nothing there
starts out root-owned.

| On the node | Made by | Owner |
|---|---|---|
| `ready/` and the trees in it | the node-arborist | install uid |
| A workspace's tree path, its scratch repository directory, opencode's working copy, and their parents | the node-mounter | install uid |
| What the tree container writes into the scratch repository | the tree container, as root in the sandbox | root |
| What an agent's `sudo` writes into a tree | the agent | root |
| A pod's node-mounts directory | kubelet | root, outside the node-local root and the data dir |

The tree container's own hand-over of its directories (`ownRoots` and the
`--own` flag) has nothing left to do once every pod is generic, and is
deleted in phase 4.

`yaac cluster delete` keeps handing the data dir's node-local folder back to
the user on a Linux kind host. It no longer has kubelet's parent folders to
fix, but a scratch repository or an agent's root-owned files still on disk
at that moment (a workspace running, or killed and not yet salvaged) are
root's, and the user must be able to remove or move the data dir.

### Isolation

The boundary is the node's mount table under the node-mounts root, and only
the node-mounter writes it.

- A pod's spec mounts its own node-mounts directory, pod-local volumes and
  read-only helper directories. Before a claim the node-mounts directory is
  empty.
- After a claim the node-mounts directory holds the mounts of that
  workspace's project and nothing else. The sandbox's view of the node is
  rooted at the node-mounts directory, so a neighbour's node-mounts
  directory is not reachable by any path.
- Both containers mount the node-mounts directory read-only, so nothing in
  the pod can add, remove or replace a node-mounts entry. They write only
  through binds, into their own project's directories.
- The binds inside the sandbox restrict nothing. They put directories at the
  paths tools expect. An agent that undid them would reach nothing new.
- The tree container's `CAP_SYS_ADMIN` is a capability inside the sandbox,
  held by yaac's own program from its start until its binds are made, and
  dropped before it reads the tree, a `.git` or a checkpoint. After that the
  container has what it has today: no more privilege than an agent's `sudo`.
  It is still not a security boundary.
- The node-mounter takes requests only from the server, confines every
  source to the install's shared and node-local roots, and resolves nothing
  by name.
- A spare on a project's own image runs that image before the claim, but
  only that project can claim it, since the image ref is the project's.

### Server restarts and upgrades

A spare carries its build's streamd, tree program and helper directory, and
a claim is a conversation between the server and that streamd. So spares do
not outlive the server:

- At start the server deletes every spare it finds, as it does today, and
  the pool step refills. Every spare a claim meets was therefore made by the
  running server, on its build, and no spare needs to record which build
  made it.
- A claimed workspace is not touched. It finished its claim under the server
  that made it and runs on across restarts and upgrades.
- The helper directory is per build (`run/helpers/<build id>` on the shared
  tier), because those running workspaces keep mounting the one they started
  with. The server writes its own at start and removes another build's once
  no pod's volumes name it.
- The agent reports its build in every answer. `yaac cluster install`
  updates the DaemonSet before the server. A node whose agent is on another
  build than the server is treated as having no agent (below) until its pod
  is replaced.
- Release needs no request from the server, so an agent of any build
  releases pods of any build.

### When the agent is not there

Every start needs its node's node-mounter to bind it and its node-arborist
to build its tree, and there is no other way to do either. So a node without
a ready agent is out of use for new starts:

- The server dials each node's agent every few seconds, as it does the disk
  pod. A node counts as ready while, within the last 15 seconds, its
  node-mounter answered on the server's build, reported that the
  node-arborist answers too, and reported free space above the disk pod's
  stop floor.
- The server keeps a label on each ready node, and every workspace pod
  selects on it, so neither a spare nor a pod made on demand is scheduled
  anywhere else. The selector is the same in every pod.
- A claim takes spares only on ready nodes. A spare on a node that stopped
  being ready waits there, unclaimed.
- A start with no ready node waits about as long as a rolling update takes
  to replace one agent pod, then fails with an error that names the node and
  its agent. It does not leave a Pending pod behind.
- On a single-node install (kind) there is no other node. While the agent is
  down no workspace can start, and running ones carry on.
- The DaemonSet updates one node at a time.
- Mounts and in-sandbox binds live in the node's and the sandboxes' mount
  tables, not in the agent's pod. A running workspace needs nothing from the
  agent until it stops.
- An agent that starts rebuilds its picture before it acts: the node-mounts
  directories that exist, the mounts under each from the mount table, and
  its node's pods from the API. It releases nothing until it has all three,
  and nothing while it cannot reach the API.

### What still splits the pool

- **The image.** One pool per image ref. A project with a `Dockerfile.yaac`
  has an image of its own, and so does each project whose owner has a
  `Dockerfile.user`, because that repo is named per project
  (docs/trust-split-builds.md). For those a pool is a pool per project, as
  today, though it no longer depends on layout or time zone.
- **The scratch size.** A spare's scratch volume has one size, so a pool is
  for an image and a size. Projects that leave the size at its default share
  a pool; a project that changes it has a pool of its own, as one with its
  own image does.
- **A restart, a byo volume, run secrets, a site release.** Made on demand.
- **The node.** A spare is on one node, and trees are per node.

Repos, folders, cwd, time zone, cache volumes, a start at a commit and a
start with its own workflow do not affect which spare a claim can take.

### Pool policy

Pools follow the same rule as trees. The `prewarm-pool` step keeps one pool,
with one spare in it, for each pair of image and scratch size that a
workspace running now uses, or that a workspace which stopped less than a
day ago used. `YAAC_PREWARM_POOL_SIZE` stays as it is today: the number of
spares per pool, default 1, and 0 turns pools off.

"The image a workspace used" means the image its project builds now, and the
size its project has set now, which are what the next start of that project
will ask for. A spare on an image a Dockerfile edit has since replaced could
never be claimed.

- **Refill.** A claim leaves its pool empty and the step makes a new spare,
  which is a full pod start. Until it is ready, a start on that image gets a
  pod made on demand, so the second and later starts of a burst (a
  `yaac-mama` fan-out) are on demand.
- **Stale.** A spare whose image and size are no longer in that set is
  reaped.
- **A server restart.** Every spare is deleted and the pools refill, one pod
  start per image. Until a pool has refilled, a start on its image gets a
  pod made on demand.

A spare has nothing to remember but its image and scratch size, which are in
its pod's spec. `spareSettings`, the stale-spare rules, `spareMatches` and
`refreshSpares` are deleted.

### Cost

- A spare reserves a workspace's memory request (2 GiB) from creation,
  because a memory request cannot be raised in place on a node that runs
  with swap. Its CPU request starts low and is raised to 500m at claim; the
  spike raised one from 100m to 500m in place.
- The idle stand-in pod in the spike used 47 MiB. A real spare adds streamd.
  Today's spare uses about 196 MiB.
- An idle install reserves 2 GiB per pool rather than 2 GiB per project with
  a running workspace.
- Trees kept ready use node disk: 27 MB and 174 MB for the two repos
  measured.

### What a start should cost

An estimate from measured parts, on kind, for a claim that finds its tree
ready:

| Phase | Estimate | From |
|---|---|---|
| Pick and label patch | 20 ms | one API call |
| Shared-tier work, overlapping the next two | 50 ms | 45 to 60 ms measured for a `.git` |
| Agent request: take, mounts, enter | 60 ms | measured: take and four mounts 31 to 42 ms as commands, one `runsc exec` making seven binds 17 to 24 ms |
| Tree container: binds, index, marker | 40 ms | overlaps the agent request's end; its binds took 0.14 s as shell commands, and are a few syscalls in its own program |
| Claim call | 100 ms | one tmux at 70 to 115 ms; file writes in-process |
| Windows | 100 ms | one tmux, as today's claim |

That is about 0.37 s to an open window, against 0.26 to 0.32 s for a new
session in a running workspace. The node's part of it, run as one script
from the take to an open tmux window, took 0.14 to 0.15 s. A tree built on
demand adds its build, 0.14 s and 0.30 to 0.52 s measured, and up to 0.2 s
to take its index out of the racy window ("Trees" above).
The window opening is not what the user waits for: claude's first paint
takes a further 1.04 to 1.16 s under gVisor, so a claim shows a painted
agent about 1.5 s after the request. A restart pays a pod start first, which
today's parts put at 2.5 to 3 s (volumes, sandbox, container, init hook) and
which has not been measured for a generic pod. Its tree is built meanwhile,
and the checkpoint's difference then takes under a second for a typical
checkpoint on a 14,500-file repo, against 4 to 10 s for today's restore on a
16,500-file one; unpacking the checkpoint is not included. These phases are
reported through the per-start timing line.

## Phases

Each phase ships on its own and leaves the suite green.

1. **Claim-time identity.** Have a `yaac-mama` create and a queued launch
   take a spare before they name their workspace. Move the claim half of
   `yaac-workspace-init` into one streamd call and the variables in the
   table above into tmux. Today's spares stop depending on the time zone.
   This is the first item of docs/plans/snapshot-warm-pool.md "Before the
   KEP".
2. **The node agent and the generic pod.** Add the DaemonSet with both
   containers, the node-arborist building on demand, the node-mounts
   directories, the generic pod manifest and release. Add a `yaac cluster
   check` gate that binds into a gVisor probe pod and enters it. Where the
   gate passes, every new workspace claims a generic spare if one is
   waiting. A
   start that finds none, and every start on an install where the gate
   fails, uses today's pod spec. The per-project spare code is deleted.
3. **Trees kept ready, and restores onto a built tree.** The `ready-trees`
   step, the node-arborist's refresh on a landed fetch, and the restore that
   applies a checkpoint to a tree the node-arborist built.
4. **One pod shape.** Once the platforms below are proven, a start with no
   spare makes a generic pod on demand. Today's pod spec is deleted, and so
   is every checkout into an empty directory inside the sandbox (`checkOut`,
   and a restore's write of a checkout's unit), with no exception. The tree
   container's hand-over of its directories goes with them.
5. **Tuning.** The CPU resize, and the node-arborist's limits against real
   repos and real bursts, starting from the second run's figures.

Phase 2 does not make any start slower than today's: without a tree kept
ready, a claim builds one natively, which is faster than the tree container
checking out. Until phase 3 a restart restores as it does today, on a
generic pod.

## Platforms to prove

With one pod shape and no checkout inside the sandbox there is no other way
to run a workspace, so phase 4 waits until the cluster check's gate and the
e2e suite pass on each:

- kind on Linux (the spike's rig), where the three things below held, the
  third for a shared tier on node disk and for one on NFS mounted on the
  node;
- kind in a podman machine on macOS, where the node-local root is a file
  share and the shared tier is too;
- k3s (`infra/hetzner-k3s`), where the shared tier is NFS, and where the
  three things below held in the third run. That install runs the host's
  containerd; one on k3s's embedded containerd keeps its state under k3s's
  own directories, so the node-mounter has to find runsc's state directory
  rather than assume it.

On each, three things have to hold: a mount under a node-mounts directory
reaches a gVisor sandbox, the node-mounter finds runsc and its state
directory and can enter a container, and a bind of a shared-tier
subdirectory made from the agent's own mount reaches the sandbox and
outlives a restart of the agent's pod.

## Tests

- **Unit.** The pod manifest (pure), the pool planner and the tree planner
  (pure, like `computePrewarmPlan`), the claim's conditional patch against
  `fakeCluster`. The Go agent has tests of its own for path confinement,
  request checking, and release against a mount table that still holds a
  bind.
- **CLI.** The scratch size setting's option, in `test/e2e-cli/`.
- **apiserver.** The label patches on a pod and its Job.
- **e2e.** One `prewarm-pool-suite` file sharing one server:
  - two projects claiming from one pool;
  - a `yaac-mama` create and a queued launch claiming a spare, and a restart
    that gets a pod on demand under its own id and a fresh node-mounts
    directory;
  - a node-mounts directory empty before its claim;
  - a claimed pod that cannot read the other project's paths, write a main
    clone, write its node-mounts directory, or mount;
  - a claim with a tree kept ready and one built on demand;
  - a restart whose checkpoint is applied to a built tree, with committed,
    uncommitted, untracked and deleted files, a submodule and a cloned
    repository;
  - a server restart that deletes every spare, leaves claimed workspaces
    running, and refills the pool;
  - a start while the agent's pod is being replaced, and one with the agent
    down, whose error names it;
  - a release that leaves no mount on the node and the project's data
    intact;
  - a killed pod whose tree is salvaged.
- **Docs when it ships.** A reference in `docs/`, and updates to
  docs/workspace-storage.md, docs/node-local-workspaces.md,
  docs/server-in-cluster.md and docs/cluster-setup.md. This plan is then
  deleted, and docs/plans/snapshot-warm-pool.md and the "Spare pool" section
  of docs/plans/sandbox-driver.md are brought up to date.

## Not yet verified

The second run closed the rest of what a single kind node could show:
restarts of containerd and kubelet, the tree container binding for itself,
the take, restores and the tree program on a node-built tree, entering by
descriptor, file mounts, and a spare's egress. The third run proved k3s and
backdating inside a sandbox. What is left:

- **The `.git` on a byo shared tier.** It measured 0.6 to 0.8 s on NFS (22
  ms a create), the largest part of a claim there, against a take of 55 ms
  and a bind of under 0.1 s. So keep prepared git dirs per repo beside the
  trees, made ahead of time like a kept tree, and have a claim only rename
  one into place and write its branch. How a prepared `.git` gets its
  workspace's refs and branch in a few writes is not yet designed.
- **Unpacking a long or large checkpoint.** `restore` unpacks with one
  `index-pack` a bundle, about 0.1 s each on NFS in the sandbox, so a chain
  at its 20-bundle limit costs about 2 s, more than the write once that is
  a difference. If that matters, splice the chain's packs into one for a
  single `index-pack`, 0.25 to 0.5 s for any length, rather than compact
  more often: a compaction rewrites its bundles on the shared tier, and one
  from a chain's start stores every changed file whole (51 KiB became 473
  KiB). A large bundle is not helped by either: 182 MB takes 9 to 10 s to
  unpack, and only keeping packs where a restore can borrow them, with no
  unpack, would change that.
- **Real parts.** The claims used a small stand-in image, `runsc exec` in
  place of streamd, and a shell as the agent, and left out the API calls and
  the shared-tier work. The first real number comes from phase 2's timing
  line.
- **More than one node.** On the k3s install, 3 of 11 running workspaces
  were on the node that is not tainted for workspaces, so on-demand pods do
  land on both. A pod on a node with no tree pays a build on demand, 0.3 to
  0.9 s there, which bounds what a scheduling preference could save.
- **macOS under a podman machine.**

## Decisions

Each of these was weighed against an alternative and settled.

- **`runsc exec` for the workspace container's binds.** It was tested and
  keeps that container without `CAP_SYS_ADMIN`. It ties the node-mounter to
  runsc's command line and state directory and to the host's pid namespace.
  A single Go binary as each pod's first process is planned separately. If
  it exists, it is the natural holder of the capability, dropping it from
  everything it starts, and the node-mounter would then need neither runsc
  nor the host's pid namespace.
- **`CAP_SYS_ADMIN` in the tree container**, so it binds for itself and
  survives its own restart with a read-only node-mounts directory. Today the
  tree container has no more privilege than an agent's `sudo`; this gives it
  one capability the agent lacks, for the moments before it drops it. If the
  drop were missed, a flaw in git's parsing of an agent's objects would
  yield code that can mount inside the sandbox. The alternatives were a
  second `runsc exec` that the node-mounter repeats on every restart of that
  container, or a writable node-mounts directory read by its paths.
- **The node-arborist as an unprivileged container beside the
  node-mounter**, running git natively. This widens what runs outside a
  sandbox. Today a working tree is always written inside one. With no
  checkout left in the sandbox, native git in the node-arborist checks out
  every repo's content, including any branch or commit a start names, so a
  flaw in git's checkout would be reachable by whoever can push to a
  project's remote. What bounds it is the container: the install uid, no
  capabilities, no egress, the main clones read-only, and write access to
  `ready/` alone. The server already runs native git on the same objects
  when it fetches, but it never writes a working tree from them. The
  alternative was a separate DaemonSet under gVisor, which keeps today's
  rule at five to ten times the build time.
- **The node-arborist's limits of 4 cores and 1 GiB**, which are all that
  bound how many starts' builds run at once, and are a starting point until
  phase 5 measures them.

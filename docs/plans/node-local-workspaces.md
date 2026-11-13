# Workspace files on node disk

On a byo install everything under a workspace's `/workspace` is on the
shared tier, an NFS volume, where every file create costs about 30 ms.
Creating a workspace of a 16,500-file repository therefore takes two to
three minutes, and so does rewarming a spare, deleting a workspace,
switching a large branch, or an agent cloning a repository of its own
(docs/nfs-checkout-performance.md "What stays slow").

A fresh working tree holds nothing the main clone does not already have.
This plan moves a workspace's files to node disk and keeps on the shared
tier only what cannot be rebuilt: each checkout's `.git`, and a checkpoint
of the work git does not hold yet.

## The design in brief

- Each checkout's `.git` stays on the shared tier. Commits, branches, the
  stash and staged content are durable as git writes them, as today.
- Everything else under `/workspace` lives in one node-local directory. A
  second container in the pod, the **tree container**, fills it at start
  and the workspace's container starts once it is filled.
- The tree container checkpoints unsaved work to the shared tier every 30
  seconds, after each save from the file editor, and when the pod stops. A
  checkpoint is a git bundle appended to its checkpoint log.
- A restart checks out each checkout's HEAD and applies the log.
- A pod killed without warning leaves its tree on the node. A one-shot pod
  on that node takes the final checkpoint.
- A node whose disk is filling is noticed long before kubelet acts, and the
  workspace holding the most of it is stopped cleanly.
- Under `containerless` nothing changes: the files are already on local
  disk, and a stop still removes a checkout's ignored files as it does
  today. On kind the layout is the same as on byo, so there is one pod
  shape.

## Measurements

Taken inside a workspace pod on a byo cluster, against the public
`fluxerapp/fluxer` (16,519 files, 355 MB of working tree), with the git dir
on the NFS checkout mount. Each case ran once. The main clone was on pod
disk, so a cold read of its pack over NFS is not included.

| Step | Time |
|---|---|
| Write the tree onto NFS, 8 workers (a synthetic repo of the same file count) | 159 s |
| Create the git dir on the shared tier | 1.3 s |
| Check the tree out into a node-local directory, 8 workers | 4.2 s |
| Checkpoint after a 41-file edit (a 4.5 KB bundle) | 0.7 s |
| Checkpoint after a 3,000-file edit (1.4 MB; synthetic repo) | 5.5 s |
| Checkpoint pass with nothing changed, `core.preloadIndex=false` | 0.46 s wall, 0.45 s CPU |
| Restore into an empty tree | 3.8 s |
| First `git status` after a restore (hashes every file once) | 5.4 s |
| `git status` after that | 0.4 s |
| Remove 16,500 files from NFS, 16 at a time | 128 s |
| Stage a full clone's 1.5 GB git dir for the first time | 24 s |
| Write that clone as a 1.7 GB bundle to the shared tier (from a run that also recompressed it) | 40 s |
| Pass after a commit in that clone, its objects marked unchanged | 0.2 s |
| The same pass without the mark (git had touched the pack's mtime) | 22 s |

On this repository `git status` after a restore matched line for line. The
stricter checks ran on the synthetic repository: every restored file was
the same byte for byte, with its exec bit, symlink target and staged state,
including when HEAD had moved after the last checkpoint. A smaller test
covered the other two kinds of content below: loose files at a root that is
no checkout, and a repository cloned there, which came back with its
history, an uncommitted edit, its stash and its remote.

At 30 seconds a pass costs about 1.5% of one core for a repository this
size, so thirty such workspaces cost under half a core. Peak memory of a
pass over this tree was at most 117 MB; staging a large cloned repository
was not measured for memory. The CPU figure is what the sandbox reports and
leaves out gVisor's own host-side cost.

## Layout

| Path | Tier | Holds | Mounted |
|---|---|---|---|
| `projects/<p>/workspaces/<w>/[<folder>/].git` | GLOBAL | a checkout's git dir, as today | workspace container at the checkout's `.git`; tree container at a side path |
| `projects/<p>/checkpoints/<w>/bundles/` | GLOBAL | every bundle of the workspace's checkpoints, each under a name of its own | tree container only |
| `projects/<p>/checkpoints/<w>/lives/<life>/` | GLOBAL | that life's manifest and its start instruction | tree container only |
| `projects/<p>/trees/<w>/<life>/tree/` | NODE-LOCAL | everything else under `/workspace` | workspace container at `/workspace`; tree container at a side path |
| `projects/<p>/trees/<w>/<life>/scratch/` | NODE-LOCAL | the tree container's scratch repository | tree container only |

The whole of `/workspace` is one directory on one filesystem, whether the
workspace has a checkout at its root, each repo in a folder, or no repos. A
checkout in a folder is a plain subdirectory of it, with its `.git` mounted
in from the shared tier.

A life's directory on the node is made for one pod and named when that pod
is created.
For a create or a restart `<life>` is `lifeDirName` of the life's start
time, the name its log dir already has; `workspace_lives` has
`(workspaceId, startedAt)` as its primary key, so no two lives of a
workspace share one. A spare has no life until it is claimed, so its
directory is named for the time it was warmed. Either way the name is
recorded on the life, at its insert or at the claim, and read from there
ever after. A pod therefore always starts on an empty directory it was
given and never on files an earlier agent left. The node-dirs init
container creates its two leaves and nothing inside them.

Checkpoints are laid out so that no two pods ever write one file. A
bundle is written once, under a name of its own, and never changed, so all
of a workspace's bundles share one folder. The one file a pass replaces is
its manifest, and each life has its own. yaac starts a life only once the
last one's unit is gone, but an operator can declare an unreachable node
dead while its pods still run, and such a pod keeps taking passes; it can
then only add bundles and replace its own manifest, never the new life's.

The workspace container cannot see any of this, so an agent cannot damage
its own checkpoints.

The **scratch repository** is the repository the tree container does its
git work in: a private index for each thing it saves, which is what lets a
pass skip unchanged files, and the objects it has hashed but not yet
bundled. It is the tree container's alone and holds nothing that is not
also in the tree or in a bundle. It sits on the node beside the tree, not
on the pod's own disk: kubelet meters that disk, so staging a large cloned
repository there could get the pod evicted, and it is gone with the pod,
while here the salvage pod finds it and has only the last changes to
stage.

Scratch dirs stay as they are: one tmpfs volume each, mounted inside the
tree in the workspace container.

## The tree container

A native sidecar: an init container with `restartPolicy: Always`, which
Kubernetes starts before the workspace container and stops after it. It
runs the yaac base image with no credentials and no tool homes, and
declares limits like every container in the pod. Its script is staged from
`workspace-bin/` like the others. Every k8s workspace has one, a workspace
with no repos included, since its root is saved too.

It runs as root inside the sandbox, with every capability dropped but the
file-permission ones (`DAC_OVERRIDE`, `CHOWN`, `FOWNER`). An agent has
`sudo`, so it can leave files in its tree that its own uid cannot read (a
root-owned `0600` file, a `0700` directory); as the install uid a pass
would skip those, and they would be gone after a stop. Root reads them. It
gives the tree container nothing the agent's `sudo` does not already have.
Everything it writes is handed to the install uid: restored files, so the
agent can edit them, and the checkpoint log, so the server can delete it.

It mounts the tree and each checkout's git dir at separate paths (`/tree`,
`/git/<repo id>`) and names them to git explicitly, so it needs no mount
inside the tree. It also mounts each main clone read-only at its server
path, since a checkout's alternates line is absolute, the workspace's
checkpoints, and its scratch repository.

### Trust

The tree container is not a security boundary, and is built so that it does
not need to be one. It runs in the agent's sandbox, with no more privilege
there than the agent's own `sudo` gives, and with no credentials, no
service account token and the pod's own network policy. The one thing it
reaches that the agent cannot is this workspace's checkpoint log. So code
an agent managed to run in it would gain nothing the agent lacks, except
the means to spoil its own checkpoints.

Within that, it keeps the agent's `.git` at arm's length:

- It never uses the agent's `.git` as its repository. Every pass and
  restore runs against the scratch repository, whose config is yaac's, so
  no hook, filter, fsmonitor or helper the agent configured is in play.
  From a checkout's `.git` it takes three things as data: objects, through
  the scratch repository's alternates, the value of HEAD, and
  `info/exclude`, where yaac's own ignore lines are.
- It never reads the agent's index. Its private indexes descend from the
  ones its own checkout or restore wrote.
- Work that needs the agent's config runs in the workspace container, where
  it is the agent's own business, as git run for the changes view is today.
- Every call still pins the settings `yaac-clean-ignored` pins today
  (hooks, `core.fsmonitor`, transports, lazy fetches, the excludes file), as
  a second line.

git does parse objects the agent wrote, and a parsing bug there would run
code in the tree container. The first paragraph is what bounds that. A
reader written against isomorphic-git, as `yaac-mama fetch` uses, is the
right tool where the server reads a workspace's git, since the server holds
every project's secrets. Here it would cost the speed this plan is for (no
stat cache, no parallel checkout, no borrowed objects) to protect a
container that holds nothing.

The same reasoning has to hold for the two places outside the sandbox:

- **The salvage pod** is its own gVisor sandbox with no service account
  token and no egress at all. It mounts that workspace's tree, scratch
  repository, git dirs and checkpoints, and the main clones read-only.
- **The server** treats a manifest as agent-written data: opened through a
  confined root, size-capped and checked against a schema. It never opens a
  bundle with its own git.

### Start

1. Wait for the start instruction: a small file the server writes beside
   the life's manifest once its fetch has landed and every `.git` is
   complete. It names each checkout's branch and commit and, for a restart,
   the checkpoint to restore.
2. With no checkpoint to restore, check each commit out into its place in
   the tree through the scratch repository, and copy the index that leaves
   into the new `.git` as its first index. With one, restore (below).
3. Create the mount points the workspace container needs inside the tree:
   each checkout's `.git`, each scratch dir, and each cache volume or
   workspace volume the project mounts under `/workspace`.
4. Report ready through a startup probe. Kubernetes then starts the
   workspace container, so "the workspace container is running" implies
   "the tree is there". The probe allows hours, not seconds: restoring a
   large cloned repository takes minutes, and a probe that gave up would
   have Kubernetes restart the tree container in the middle of it. The
   server's own wait for the pod is as patient, and shows the restore as a
   step of the start.

The server makes each checkout's `.git` directory before applying the Job,
because a missing subPath is created root-owned, and fills it in place.
`createCheckout` no longer writes a tree under `k8s`.

### While running

A pass runs every 30 seconds, starting at a random offset so that
workspaces on a node do not coincide, and whenever the trigger file is
touched. The trigger file is on a small volume both containers mount; the
server touches it through the workspace container after an editor save.
Passes never overlap, and a trigger during a pass runs one more after it.

### Stop

When the workspace container has exited, the tree container takes a final
pass, compacts its bundles, marks the manifest final for this life, and
removes the tree and the scratch repository. The pod's grace period is
sized for the workspace container's own preStop hook plus an ordinary final
pass. One that needs longer, as for a large repository cloned moments
before, is cut off with the tree still on the node, and salvage finishes
it.

## Checkpoints

### What is saved, and how

A pass saves three kinds of thing, all through the same steps: stage a
directory into a private index in the scratch repository, and write that
index as a tree. Git's stat cache means only changed files are
hashed. Attributes are disabled (`--attr-source` of the empty tree), so
content is stored byte for byte whatever filters a repository configures.

| Kind | What is staged | Ignore rules |
|---|---|---|
| **A checkout**: a repo yaac checked out, or a submodule of one. Its git dir is on the shared tier | its tracked files as they are, its untracked files, and for the checkout the project's kept ignored paths (`projects.keptIgnoredPaths`); a commit whose parent is its HEAD | its own |
| **The root**, when it is no checkout | every file outside the checkouts and outside any repository | none: no repository owns these files, so all of them are saved |
| **Any other repository**: one the agent cloned or made, at the root or inside a checkout | two trees: its files, and its git dir staged as a plain folder of files | its own, for its files |

Git records only a pointer for a repository inside another, which is how a
pass finds them: each shows up as one entry of that kind when its parent is
staged. Saving the git dir as ordinary files means a pack is written once
and never again, and the repository comes back whole, any submodules of
its own included, since their git dirs are inside its.

A submodule of a checkout has its git dir in that checkout's `.git`, on the
shared tier, so a commit in it is durable when made, like the checkout's.
It is therefore saved as a checkout is, on top of its own HEAD, and its
`.git` pointer file is recorded with it. Saved as a bare snapshot of its
files, a submodule that was committed in after the last checkpoint would
come back with the older files under the newer commit, and show that
commit's changes as if they had been reverted.

Three rules apply to a git dir saved this way:

- **Refs before objects.** A pass stages `HEAD`, `packed-refs`, `refs/` and
  `logs/` first and the rest after, the reverse of the order git writes
  them. Every object a saved ref names was written before that ref, so the
  later walk finds it. Staged in one sweep, a commit landing mid-walk could
  leave a saved branch naming an object the walk had already passed.
- **Objects are staged once.** Everything under `objects/` is named for its
  content, so once staged an entry is marked unchanged and never hashed
  again; a pass only adds new files there and drops vanished ones. Without
  this the stat cache fails on packs: git touches a pack's mtime whenever a
  commit reuses an object in it.
- **No recompression.** Packs are compressed already, so a git dir is
  staged with `core.compression=0`.

There is no size limit. A repository the agent cloned takes the same room
in the checkpoint log that it takes on the shared tier today, and a limit
would add a way to lose one. What size costs is time, once: the 1.5 GB git
dir of a full clone of `fluxerapp/fluxer` took 24 seconds to stage, and the
clone about 40 to write to the shared tier; staging its files was not timed
apart. So a repository being saved for
the first time is saved in a pass of its own, after the checkpoint of
everything else is in place, and never delays it. One that fails to save is
named in the manifest, and the workspace shows that it will not survive a
stop.

A checkpoint does not hold:

- ignored files, except kept paths. They are gone after any stop, which is
  what a stop does today;
- scratch dirs, and volumes mounted under `/workspace`, which the tree
  container sees as empty folders. They are excluded by path, so tracked
  files under them keep HEAD's entries;
- empty directories, mtimes, hard links or special files;
- a file's owner, or its mode beyond the exec bit, which is all git
  records. Every restored file belongs to the install uid, as `0644` or
  `0755`, so a private key saved as `0600` needs its mode set again.

Three things a stop keeps today are therefore not kept:

- the ignored files of a submodule or of a repository the agent cloned;
- a repository inside an ignored folder, unless it is under a kept path. A
  pass does not walk ignored folders, which can be very large;
- empty directories and mtimes.

A `gc` or repack in such a repository can still delete a file under a
pass that is reading it. The pass then leaves that repository's last saved
state in place and tries again on the next one, and the final pass runs
after the workspace container has exited.

### The log

A workspace's bundles are immutable files in one folder. A life's
`manifest` names the life, the chain of bundles that make up its current
checkpoint, what each ref in them is (the root, a checkout, a repository
and its path), and whether the checkpoint is final. One manifest covers the
whole workspace, so its checkouts are saved at one moment. Replacing the
manifest by rename is the only commit point: a reader sees the old
checkpoint or the new one, never a mix.

A manifest may name bundles an earlier life wrote. A restart's first
manifest starts as the chain it restored from, so a new life writes only
what changes, and a cloned repository's packs are not written again at
every restart.

Each pass appends one bundle holding only the objects the new checkpoint
adds to the previous one, so a large file is written once. A pass in which
nothing changed, no tree and no checkout's HEAD, writes nothing.
Compaction merges the small bundles a life has written into one, at stop
and when the chain passes a length bound, and leaves a large bundle as it
is, so a cloned repository's packs are not rewritten at every stop.

Only the server deletes a bundle, and only one that no manifest it keeps
names. A tree container deletes nothing in the shared folder, so a stray
pod cannot remove what a later life depends on. The server keeps the
current life's manifest, the one before it until the current life has a
checkpoint of its own, and that of any life marked lost, in case its tree
is found.

The scratch repository keeps a large object only until the bundle holding
it is in place, so the node does not hold a second copy of a cloned
repository.

Three rules keep a node that dies mid-write from leaving a log that cannot
be restored:

- **Bytes before names.** A bundle is written to a temporary name, synced
  to the server with `fsync`, and only then renamed. The new manifest is
  written and synced the same way before it replaces the old one. A rename
  reaches the NFS server at once, while written bytes can sit in the node's
  cache for up to 30 seconds, so without the sync a manifest could name a
  bundle whose bytes never left the node.
- **A checkpoint leans only on the main clones.** Its chain holds every
  object of the checkpoint that no main clone has, the agent's own unpushed
  commits included. A main clone never deletes an object
  (docs/server-git.md), so no `gc`, history rewrite or damage in the
  agent's `.git` can leave a checkpoint without its base.
- **A pass that dies leaves the old checkpoint.** Until the manifest is
  replaced, everything it names is untouched. What it leaves behind, a
  temporary file or a bundle no manifest names, the server removes.

### Restore

1. Verify each bundle of the chain in the manifest the start instruction
   names, and unpack it into the scratch repository.
2. Write the root's tree.
3. For each checkout, and each submodule of one: if its HEAD is the
   checkpoint's parent, write the
   checkpoint's tree. If the agent committed after the last checkpoint,
   first merge the checkpoint onto HEAD with `git merge-tree`, with HEAD
   winning each conflict.
4. Write each other repository's files and git dir, outermost first.

The agent's own index is in `.git` and is not touched. Its stat data is
stale after a restore, so the launch ends with a detached `git status` in
the workspace container, which is what `buildStatusWarmupExec` runs today.

A chain that does not verify should not happen under the rules above; it
means the shared tier lost or damaged a file. It never leaves a workspace
that cannot start:

- The restart fails once, saying which checkpoint is unreadable, when the
  newest readable one was taken, and that work after it would be missing.
- The user can then restart from the newest state that does verify: the
  longest readable prefix of the chain, else the checkpoint of the life
  before if its manifest is still kept, else each checkout's HEAD alone.
  That is a choice, never a silent fallback, as a restart refuses rather
  than quietly starts a lost conversation over.
- The unreadable files are moved aside, not deleted, and the workspace's
  life records what it was restored from.

## Life cycle

- **Create.** The row, the fetch and the pod start as today. The server
  writes each `.git` and the start instruction; the tree container checks
  out.
- **Spare.** A spare is a pod with its tree on its node. A claim re-branches
  it inside the workspace container, as `rebranchSpare` does today.
- **Stop, drain, an eviction that gives its grace period.** The tree
  container's final pass. The server stamps the life `checkpointedAt` when
  it finds the manifest final for it.
- **Kill.** A sandbox ended with no warning (out of memory, a node reboot,
  kubelet's eviction for disk pressure, a final pass the grace period cut
  off) leaves no final manifest and leaves the tree on its node. The
  `tree-salvage` reconcile step, which under `k8s` takes the place of
  `ignored-file-clean`, runs the tree container's final pass in a one-shot
  gVisor pod pinned to that node, then stamps the life.
- **Node unreachable.** Nothing changes from today, and nothing is timed
  out. Kubernetes keeps the pod listed until the node answers again or is
  removed, and a restart is refused while the old unit can be found
  (`teardownForRestart`), because that pod may still be running and writing
  the workspace's `.git` and transcripts. yaac never force-deletes it. The
  workspace says its node is unreachable and when its last checkpoint was
  taken. If the node answers again, the pod is stopped in the ordinary way
  and takes its final pass.
- **Node gone.** Once the unit is gone and its node no longer exists, or
  exists but is not ready because an operator declared it dead, the step
  stamps the life as lost, with the time of its last checkpoint, and the
  workspace's death detail says unsaved work after that time is missing. An
  autoscaler removes a dead node by itself; on a fixed set of nodes an
  operator does.
- **A lost tree found later.** A node declared dead can come back with the
  tree still on it. If the workspace has not been restarted since, the
  salvage pass makes that tree its checkpoint and the lost mark is cleared.
  If it has, the two have diverged: the pass saves the tree under the old
  life's own manifest, which is kept and applied to nothing, and that
  life's detail says so.
- **Restart.** Waits for the stamp, then starts like a create with a
  checkpoint log to restore. A delete is refused until the stamp, as it is
  during an ignored-file clean today. The `tree-salvage` step, like a
  restart, acts only once the old unit is gone.
- **Delete.** Removes each `.git` and the workspace's checkpoints. The
  node-local sweep removes the tree and scratch repository of a life that
  is stamped.

| Event | Unsaved work lost |
|---|---|
| Stop, eviction, node drain | none |
| Sandbox killed, node still there | none |
| Node unreachable | none; no restart or delete until it answers or is removed |
| Node gone | changes since the last checkpoint, at most 30 seconds |
| Any of these | nothing committed in a checkout |

Today a file written at a root that is no checkout is durable at once. It
now has the same 30-second window as a checkout's uncommitted files, and so
does a commit made in a repository the agent cloned itself.

Two costs are accepted as they are. A restart restores everything from the
log, so a workspace holding a large repository the agent cloned takes
longer to restart, where today its files are already on the shared tier.
And nothing ignores files at a root that is no checkout, so a dataset or a
`node_modules` an agent puts there is saved: once, but in full.

## A full node

A tree has no size limit, as a checkout on the shared tier has none today.
What changes is whose disk fills: one node's, where today it is the volume
every workspace of the install writes to.

kubelet does not count a hostPath directory against any pod. So on a byo
node that falls under kubelet's free-space threshold:

- the node is marked `DiskPressure` and admits no new pod, a salvage pod
  included;
- kubelet deletes unused images, then evicts pods, ranked by the disk use
  it can see (writable layers, scratch dirs, logs). The workspace that
  filled the disk is not singled out, and evicting others frees little;
- such an eviction gives no grace period, so those pods take no final
  checkpoint. Their trees stay on the node, and salvage has to wait until
  the pressure clears.

At no free space at all, every write on that disk fails: the agents', the
tree containers' own scratch repositories (so passes stop), containerd's,
and the files that back scratch dirs, which can take a sandbox down. kind
sets kubelet's thresholds to zero (docs/plans/storage-gc-gaps.md §4), so a
kind node goes straight to this.

Nothing already in the log is at risk in any of this, and a tree on the
node is still there once space is freed. Work is lost only if the node is
replaced before its trees are salvaged.

So yaac acts first, long before kubelet would, and stops the workspace that
is using the space:

- **Measure.** A small yaac pod on every node, kind's included, reads the
  free space of the node-local root every second and, once it is under the
  warn floor, the size of each tree there. It mounts that root read-only,
  runs no workspace's code, and answers the server, which asks every few
  seconds. The numbers never come from a tree container: the step below
  stops one workspace on their strength, so a tree container that lied
  (understating its own tree, or claiming the node was low) could get a
  neighbour stopped.
- **Warn.** Under a first floor, the server's health report names the node
  and its largest trees, and each of those workspaces shows how much disk
  it holds.
- **Stop.** Under a second floor, a reconcile step stops the workspace with
  the largest tree on that node, one per pass until the node is back above
  the floor. That is an ordinary stop: a final checkpoint, the tree
  removed, and a death reason that names the disk it used. It stops nothing
  when no tree is large, since then something else filled the disk
  (images, a package store) and stopping a workspace would not help; the
  health report says so instead.
- **Reserve.** Where trees share the node's main disk, workspace pods
  request ephemeral storage for a typical tree, so the scheduler does not
  pack a node past that disk. It is an install setting, on by default and
  turned off by the two modules below: there trees have a filesystem of
  their own, and the request would hold back main-disk room they never
  use.

Both floors are settings. The stop floor starts at the larger of 15% of the
disk and 15 GiB free, against kubelet's 10% (5% on k3s), and the warn floor
at the larger of 25% and 25 GiB. The margin has to cover what a workspace
writes between the floor being crossed and its stop landing, which on a
fast disk is gigabytes. On kind the disk is the user's own and often mostly
full, so there the floors are the absolute sizes only: 15 GiB and 25 GiB.

That guard is a race the writer can still win: a stop takes seconds, and a
fast disk takes gigabytes in that time. It is the only protection a kind
node can have, and a cluster yaac did not build. Where yaac provisions the
nodes (`infra/hetzner-k3s`, `infra/aws-eks`), the node's bootstrap also
puts the node-local root on a filesystem of its own: a second disk, or a
fixed-size file mounted as one, half the node's disk to start with and a
variable of each module. Then there is no race. A tree write past
the limit fails with `ENOSPC` at that moment, kubelet, containerd and the
scratch dirs are on the other disk and never see the pressure, and the
guard only has to free space for the node's other workspaces. Its floors
then apply to that filesystem. `yaac cluster check` warns on a byo node
whose node-local root shares the kubelet's filesystem.

A kind node is a container on the user's own machine, and carving a
fixed-size filesystem out of that disk would need root there. A hard limit
per tree would need filesystem project quotas on every node, which a byo
install cannot count on.

## File routes

`#domain/workspaces/files.ts` reads and writes the workspace dir with plain
`fs` on the server's filesystem. Under `k8s` the files are no longer there,
so for a running workspace each route runs in the workspace container over
the stream relay: listing, read, write through a temporary file and a
rename, create, rename, delete and upload. A one-shot command's output is
capped at 4 MiB, so a large read and an upload go over a stream of their
own. A write ends by touching the trigger file. The `.git` exclusion
stays. The open-after-overwrite exec goes away, since the server no longer
writes behind the pod's back.

For a stopped `k8s` workspace the file routes answer `CONFLICT`, shown as
"Start the workspace to browse its files", as the changes routes do today.
The webapp shows a stopped workspace's transcript and logs and offers no
file pane, so nothing it does changes. That answer arrives with the pod
layout; until then a stopped workspace's files are still on the shared tier
and its routes keep reading them there. `containerless` keeps plain `fs`
for both.

## Server changes

- **Contract.** `WorkspaceSpec` names the workspace's tree and checkpoint
  directory, and each checkout's place in the tree, git dir and main clone.
  `containerless` ignores it, as it ignores `scratchDirs`. Two verbs are
  new, and both resolve to nothing under `containerless`: one salvages a
  life's tree on its node, the other answers each node's free space and
  tree sizes. `runInStoppedCheckout` stays, for `containerless` alone.
- **`#drivers/k8s`.** The tree container and its volumes in `pod-job.ts`;
  the salvage pod beside `root-pod.ts`, in place of the root pod that ran
  the ignored-file clean; the per-node disk pod, which runs the server
  image as the storage binder does, so no image is added; network policies
  that give the salvage pod no egress and let only the server dial the
  disk pod; the sweep learns `trees/`, and the removal of bundles no kept
  manifest names is a step of the server's.
- **`#domain/git`.** `createCheckout` gains a mode that stops after `.git`,
  writing the branch ref itself, which `checkout -B` does today.
- **`#domain/workspaces`.** Create, restart, stop and delete as above; the
  `tree-salvage` step and the full-node step; `files.ts` behind a small
  interface with a plain-`fs` and an in-workspace implementation. The
  ignored-file clean and its step run only where the tree is not
  node-local, which is `containerless`.
- **`#db`.** `workspace_lives` records the node the life ran on, the name
  of its tree directory, whether that tree is node-local, and
  `checkpointedAt` with its outcome. `ignoredCleanedAt` stays, for
  `containerless`. One migration.
- **`@yaac/shared`.** Two death reasons: a life lost with its node, and a
  workspace stopped for the disk it used. The server's health report gains
  each node's free space.
- **API and CLI.** The restart route and `yaac workspace restart` gain an
  option that accepts the newest state that verifies ("Restore"). The route
  keeps its row in the route matrix; the option needs its e2e-cli test.
- **Install.** `yaac-checkouts` is no longer created, and `cluster check`'s
  storage gate stops expecting it. Install applies the per-node disk pod,
  and `cluster check` warns on a byo node whose node-local root shares the
  kubelet's filesystem.
- **`infra/`.** Both modules' node bootstrap gives the node-local root a
  filesystem of its own.

## What goes away

- The `yaac-checkouts` volume, its per-driver CSI copy, `CHECKOUT_SUBPATH`
  and the checkout attribute-cache options.
- The open-after-overwrite exec.
- Under `k8s`, the ignored-file clean: the in-workspace clean at stop, the
  `ignored-file-clean` step and the root pod it ran in. `containerless`
  keeps all of it, `yaac-clean-ignored` included.
- Under `k8s`, the server-side removal of a workspace's files and scratch
  dirs at stop and delete.
- docs/nfs-checkout-performance.md, but for what it says about a git dir on
  the shared tier.

The claude and codex worktree denials stay for now: a worktree's files
would be on node disk, but nothing checkpoints one.

## Workspaces from before

- A life that started on the shared-tier layout keeps running as it is. Its
  file routes already work, since they run in the workspace. It never
  waits for a stamp: the migration marks every existing life as not
  node-local, whether running or long stopped, and only a node-local life
  has a tree to salvage.
- A stopped workspace whose shared directory still holds files and has no
  checkpoint log is imported at its next restart: the salvage pod runs a
  pass against the shared directory, which produces an ordinary checkpoint,
  and the restart then restores from it.
- The old files are never rewritten or removed by the import. They stay on
  the shared tier, unmounted and unread once a checkpoint log exists, until
  the workspace is deleted. So an import cannot lose anything: whatever a
  checkpoint does not carry is still there.
- `yaac-checkouts` is deleted once no pod mounts it.

Each of these gets a section in docs/legacy-compat-shims.md.

## Phases

1. **File routes through the workspace.** Works on today's layout and ships
   alone.
2. **The tree script.** Pass, compaction, restore and verification for all
   three kinds of content, with unit tests against temporary directories.
3. **The full-node guard.** The per-node disk pod, the health report and
   the stop step. With no trees on nodes yet the step finds nothing large
   and only reports; it starts stopping workspaces once phase 4 puts trees
   there. With an e2e case for a node under the stop floor.
4. **The pod layout.** The contract field, the tree container, create,
   restart, stop, delete, salvage, the migration and the import, with e2e
   cases for a clean stop, a killed pod, a restart on another node, a HEAD
   that moved, a spare claim, an editor save and a workspace with no repos.
   It starts only once everything under "To verify on a cluster first"
   holds.
5. **A filesystem for trees.** The node bootstrap of `infra/hetzner-k3s`
   and `infra/aws-eks`, and the `cluster check` warning. Independent of the
   rest, so it can land before phase 4 reaches those clusters.
6. **Removal.** Everything under "What goes away", and the reference docs.

## To verify on a cluster first

- A native sidecar under gVisor on kind, k3s and EKS: that the workspace
  container waits for its startup probe, that it is stopped only after the
  workspace container exits, and that both containers see one hostPath
  consistently.
- The salvage pod on the node of a killed sandbox, and that no network
  policy leaves it any egress (check how `yaac-root-run` pods are covered
  today).
- That root in the tree container, with only those three capabilities, can
  read a `0600` file and a `0700` directory another uid left in the tree.
- That `fsync` inside the sandbox reaches the NFS server: take a pass, cut
  the node off at once, and verify the log from another node.
- Whether an index the tree container writes is still current when read
  through the workspace container's mount of the same directory. If the two
  see different inode numbers, the first `git status` of a new workspace
  hashes every file once.
- The whole create, end to end, on a repository this size, with the main
  clone on NFS.
- How long the final pass and tree removal take against the grace period.
- The full-node guard: fill a node's disk from one workspace and confirm
  that workspace is the one stopped, how much is written between the floor
  and the stop, and that a tree's size read from outside matches what is
  there.
- A node-local root on its own filesystem, on a Hetzner and an EKS node,
  autoscaled ones included: that filling it gives `ENOSPC` in the tree,
  leaves kubelet's view of the node untouched, and survives a reboot.

## Not in this plan

- A pool of prewarmed tree directories per node. The tree path is chosen so
  that one can be added by renaming a sibling directory into place.
- An environment image holding the checkout and installed dependencies.
- Moving a yaac checkout's `.git` to the node as well. A repository the
  agent cloned already has its `.git` there, saved as a tree, so the means
  exist. A checkout's stays on the shared tier for two reasons: a commit in
  it is durable when made, not at the next pass, and the server reads it
  there for `yaac-mama fetch` and at restart.
- Browsing a stopped workspace's files from its checkpoint.

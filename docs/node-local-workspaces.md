# Workspace files on node disk

Under `k8s` a workspace's files live on its node's disk, not on the shared
tier. On a byo install the shared tier is an NFS volume where every file
create costs about 30 ms, so writing a 16,500-file working tree there took
two to three minutes, and so did deleting one or switching a large branch
(docs/nfs-checkout-performance.md). A fresh working tree holds nothing the
main clone lacks, so only what cannot be rebuilt stays on the shared tier:
each checkout's `.git`, and a checkpoint of the work git does not hold yet.

- Each checkout's `.git` is on the shared tier. Commits, branches, the
  stash and staged content are durable as git writes them.
- Everything else under `/workspace` is one node-local directory. A second
  container in the pod, the **tree container**, fills it at start, and the
  workspace's container starts once it is filled.
- The tree container checkpoints unsaved work to the shared tier every 30
  seconds, after each save from the file editor, and when the pod stops. A
  checkpoint is a git bundle appended to the workspace's checkpoint log.
- A restart checks out each checkout's HEAD and applies the log.
- A pod killed without warning leaves its tree on the node, and a one-shot
  pod on that node takes the final checkpoint.
- A node whose disk is filling is noticed before kubelet acts, and the
  workspace holding the most of it is stopped cleanly.

Under `containerless` none of this applies: the files are already on local
disk, and a stop removes a checkout's ignored files instead
(docs/workspace-storage.md). On kind the layout is the same as on byo.

On `fluxerapp/fluxer` (16,519 files) checking the tree out onto node disk
takes 4 to 6 seconds, a pass with nothing changed under half a second to a
second, a restore 4 to 10 seconds, and removing the tree under 2 seconds.

## Layout

| Path | Tier | Holds | Mounted |
|---|---|---|---|
| `projects/<p>/workspaces/<w>/[<folder>/].git` | GLOBAL | a checkout's git dir | workspace container at the checkout's `.git`; tree container at `/git/<repo id>` |
| `projects/<p>/checkpoints/<w>/bundles/` | GLOBAL | every bundle of the workspace's checkpoints | tree container only |
| `projects/<p>/checkpoints/<w>/lives/<life>/` | GLOBAL | that life's manifest and start instruction | tree container only |
| `projects/<p>/trees/<w>/<life>/tree/` | NODE-LOCAL | everything else under `/workspace` | workspace container at `/workspace`; tree container at `/tree` |
| `projects/<p>/trees/<w>/<life>/scratch/` | NODE-LOCAL | the tree container's scratch repository | tree container only |

A checkout in a folder is a plain subdirectory of the tree, with its `.git`
mounted in from the shared tier. The server makes each `.git` directory
before applying the Job, since a missing subPath is created root-owned, and
`createCheckout` fills it in place without writing a working tree.

A life's directory is made for one pod. For a create or a restart `<life>`
is `lifeDirName` of the life's start time; a spare's is named for the time
it was warmed. The name is recorded on the life (`workspace_lives.treeDir`)
and read from there ever after, so a pod always starts on an empty
directory and never on files an earlier agent left.

Checkpoints are laid out so no two pods ever write one file: a bundle is
written once under a name of its own, and the one file a pass replaces is
its own life's manifest. A pod still running on a node an operator
declared dead can only add bundles and replace its own manifest, never a
newer life's.

The **scratch repository** is where the tree container does its git work:
a private index per saved unit, which lets a pass skip unchanged files, and
objects hashed but not yet bundled. It holds nothing that is not also in the
tree or a bundle. It sits beside the tree rather than on the pod's own disk,
which kubelet meters and which is gone with the pod; here the salvage pod
finds it and has only the last changes to stage.

## The tree container

A native sidecar (an init container with `restartPolicy: Always`), so
Kubernetes starts it before the workspace container and stops it after. It
runs the bundled `yaac-tree` program (`drivers/k8s/workspaces/tree/`) from
the base image, with no credentials and no tool homes. Every k8s workspace
has one, a workspace with no repos included, since its root is saved too.

It runs as root inside the sandbox with every capability dropped but
`DAC_OVERRIDE`, `CHOWN`, `FOWNER`, `SETUID` and `SETGID`. An agent has
`sudo`, so it can leave files its own uid cannot read; as the install uid a
pass would skip them and they would be gone after a stop. Checkout and
restore run as the install uid through `setpriv`, so what they write is the
agent's to edit. It mounts the tree and each git dir at separate paths and
names them to git explicitly, each main clone read-only at its server path
(a checkout's alternates line is absolute), the checkpoints, and the
scratch repository.

### Trust

The tree container is not a security boundary and does not need to be one.
It has no more privilege in the sandbox than the agent's `sudo`, no
credentials, no service account token and the pod's own network policy.
The one thing it reaches that the agent cannot is this workspace's
checkpoint log, so code an agent ran in it could only spoil its own
checkpoints.

Within that, it keeps the agent's `.git` at arm's length. Every pass and
restore runs against the scratch repository, whose config is yaac's, so no
hook, filter or helper the agent configured is in play; from a `.git` it
takes only objects (through alternates), HEAD and `info/exclude`. It never
reads the agent's index. Every call also pins the settings
`yaac-clean-ignored` pins. git does parse objects the agent wrote; the
paragraph above is what bounds a parsing bug there.

Outside the sandbox:

- **The salvage pod** is its own gVisor sandbox with no service account
  token and no egress: it carries neither `yaac.workspace-id` nor
  `yaac.role=builder`, so the namespace's `yaac-egress-world-deny` covers
  it.
- **The server** treats a manifest as agent-written data: read through a
  confined root, size-capped and schema-checked. It never opens a bundle
  with its own git.

### Start

1. Wait for the start instruction, which the server writes beside the
   life's manifest once every `.git` is complete. It names each checkout's
   commit and, for a restart, the checkpoint to restore.
2. With nothing to restore, check each commit out through the scratch
   repository and copy the index that leaves into the `.git` as its first
   index; otherwise restore (below).
3. Set `core.checkStat=minimal` in each `.git`. gVisor numbers each
   container's mount's inodes on its own, so with git's default checks
   every entry the tree container wrote is stale in the workspace container
   and the first `git status` hashes every file. `minimal` compares only the
   whole-second mtime, size and mode; it misses a rewrite that keeps the
   size and restores the old mtime until the file changes again. The tree
   container's own indexes keep git's defaults, so a pass still saves such a
   rewrite.
4. Create the mount points the workspace container needs inside the tree
   (each `.git`, scratch dir and volume under `/workspace`), then report
   ready through a startup probe, so the workspace container starts only on
   a filled tree. The probe allows hours, since a large restore takes
   minutes and a probe that gave up would restart the container mid-way;
   the server's wait for the pod is as patient.

A restarted sidecar finds its life's marker in the scratch repository and
goes straight to its passes, never checking out over a tree in use.

### While running

A pass runs every 30 seconds from a random offset, and whenever the trigger
file is touched. The trigger is on a small volume both containers mount;
a write through the file routes touches it from the workspace container.
The tree container reads its mtime once a second, since under gVisor
inotify does not see a change made through another container's mount.
Passes never overlap; a trigger during one runs another after it.

### Stop

Once the workspace container has exited, the tree container takes a final
pass, compacts its bundles, marks the manifest final and removes the tree.
The grace period is one budget counted from the deletion, spent by the
preStop hook, the workspace container's exit and the final pass, so it is
the hook's allowance plus 30 seconds. A final pass cut off leaves the tree
on the node, and salvage finishes it.

## Checkpoints

### What is saved

A pass stages each unit into a private index in the scratch repository and
writes it as a tree; git's stat cache means only changed files are hashed.
Attributes are disabled (`--attr-source` of the empty tree), so content is
stored byte for byte.

| Unit | What is staged | Ignore rules |
|---|---|---|
| **A checkout**, or a submodule of one | tracked and untracked files, plus the project's kept ignored paths; a commit on top of its HEAD | its own |
| **The root**, when it is no checkout | every file outside the checkouts and any repository | none |
| **Any other repository** the agent cloned or made | its files, and its git dir staged as a plain folder | its own, for its files |

A nested repository shows up as a gitlink entry when its parent is staged.
Those entries are marked skip-worktree, or git would refresh the nested
repository's own index on every pass. Saving a git dir as files means a pack
is written once, and the repository comes back whole with its own
submodules. A submodule of a checkout keeps its git dir in the checkout's
`.git`, so it is saved on top of its own HEAD, like a checkout.

A git dir saved as files follows three rules: refs are staged before
objects (the reverse of git's write order, so every object a saved ref
names is found); objects are staged once and then marked unchanged, since
git touches a pack's mtime whenever a commit reuses it; and nothing is
recompressed (`core.compression=0`). There is no size limit. A unit that
fails to save is named in the manifest's `unsaved`.

A checkpoint does not hold ignored files beyond kept paths, scratch dirs or
volumes under `/workspace`, empty directories, mtimes, hard links, special
files, owners, or modes beyond the exec bit. So a stop loses the ignored
files of a submodule or cloned repository, and a repository inside an
ignored folder that is not a kept path.

### The log

A workspace's bundles are immutable files in one folder. A life's manifest
names the chain of bundles making up its current checkpoint, what each unit
in it is, and whether it is final. One manifest covers the whole workspace,
so its checkouts are saved at one moment, and replacing it by rename is
the only commit point. A restart's first manifest starts from the chain it
restored, so a new life writes only what changes.

Each pass appends one bundle with only the objects the new checkpoint adds;
a pass in which nothing changed writes nothing. Compaction merges a life's
small bundles into one at stop and when the chain passes 20, leaving large
ones as they are.

Only the server deletes a bundle (the hourly `checkpoint-gc` step), and
only an old one no kept manifest names. It keeps the newest two manifests
and any lost life's.

A node dying mid-write cannot leave a log that does not restore:

- **Bytes before names.** A bundle and a manifest are each written to a
  temporary name, `fsync`ed, then renamed, so a manifest never names bytes
  that never left the node.
- **A checkpoint leans only on the main clones.** Its chain holds every
  object no main clone has, the agent's unpushed commits included. A main
  clone never deletes an object (docs/server-git.md), so nothing in the
  agent's `.git` can leave a checkpoint without its base.
- **A pass that dies leaves the old checkpoint.** What it leaves behind,
  the server removes.

### Restore

Each bundle of the chain is verified and unpacked into the scratch
repository; then the root's tree is written, each checkout's and
submodule's on top of its HEAD (merged onto HEAD with `git merge-tree`,
HEAD winning, if the agent committed after the last checkpoint), and each
other repository's files and git dir, outermost first. The agent's own
index is not touched; the launch's detached `git status` refreshes its stat
data.

A chain that does not verify means the shared tier lost or damaged a file.
The restart then fails once, naming the unreadable bundle and when the
newest readable checkpoint was taken, and the unreadable file is renamed
aside. `yaac workspace restart --restore-newest` restarts from the longest
readable prefix of the chain, else each checkout's HEAD alone. That is a
choice, never a silent fallback.

## Life cycle

- **Create.** The server writes each `.git` and the start instruction; the
  tree container checks out. The life records the node it runs on.
- **Spare.** A pod with its tree on its node; a claim re-branches it inside
  the workspace container.
- **Stop, drain, an eviction with its grace period.** The final pass. The
  `tree-salvage` step stamps the life `final` (`checkpointedAt`) when it
  finds its manifest final.
- **Kill.** A sandbox ended without warning leaves no final manifest and
  the tree on its node. Once the unit is gone, the `tree-salvage` step
  (which under `k8s` takes the place of `ignored-file-clean`) runs the final
  pass in a one-shot gVisor pod pinned to that node, then stamps the life
  `salvaged`.
- **Node unreachable.** Nothing is timed out. A restart is refused while
  the old unit can be found, because its pod may still be writing the
  workspace's `.git`; yaac never force-deletes it.
- **Node gone.** Once the unit is gone and its node no longer exists, the
  step stamps the life `lost` with the time of its last checkpoint, and the
  death detail says unsaved work after it is missing.
- **Restart and delete** first wait for the stamp (or take it, for a life
  that left nothing to save).
- **Delete.** Removes each `.git` and the checkpoints.

The node-local sweep removes whatever trees a tree container left (one cut
off mid-removal, say) once their workspace is neither running nor waiting
for salvage.

| Event | Unsaved work lost |
|---|---|
| Stop, eviction, node drain | none |
| Sandbox killed, node still there | none |
| Node unreachable | none; no restart or delete until it answers or is removed |
| Node gone | changes since the last checkpoint, at most 30 seconds |

A file at a root that is no checkout, and a commit in a repository the
agent cloned, have the same 30-second window as a checkout's uncommitted
files. A restart restores everything from the log, so a workspace holding a
large cloned repository restarts more slowly. Nothing ignores files at a
root that is no checkout, so a dataset left there is saved, once, in full.

## A full node

A tree has no size limit, so one workspace can fill its node's disk.
kubelet does not count a hostPath against any pod: a byo node under
kubelet's threshold admits no new pod (a salvage pod included) and evicts
pods by the disk use it can see, not the workspace that filled it, with no
grace period. kind sets kubelet's thresholds to zero, so a kind node goes
straight to failing every write.

So yaac acts first:

- **Measure.** The `yaac-disk` DaemonSet (`cluster/disk-pod.ts`) runs the
  server image on every node, as root with only `DAC_READ_SEARCH` and the
  node-local root mounted read-only, so it can size a `0700` folder an
  agent's `sudo` made. It answers the node-local root's free space and,
  under the warn floor, each tree's allocated size. Only the server may dial
  it, and the server asks every 5 seconds. The numbers never come from a
  tree container, which could get a neighbour stopped by lying.
- **Warn.** Under the warn floor the health report names the node and its
  largest trees (docs/server-health.md "Node disks").
- **Stop.** Under the stop floor the `disk-guard` step stops the workspace
  with the largest tree on that node, at least 1 GiB, with death reason
  `disk-full`. With no large tree it stops nothing, since something else
  filled the disk.

The floors are 5 GiB (stop) and 10 GiB (warn) free by default
(`YAAC_DISK_STOP_FLOOR_GIB`, `YAAC_DISK_WARN_FLOOR_GIB`). Where trees share
kubelet's disk on a byo node they must sit above kubelet's own threshold
(10%, 5% on k3s). The guard races the writer, since a fast disk takes
gigabytes during a stop. Where yaac provisions nodes (`infra/hetzner-k3s`,
`infra/aws-eks`), the bootstrap puts the node-local root on a filesystem of
its own, so a tree write past it fails with `ENOSPC` while kubelet and
containerd never see pressure. `yaac cluster check`'s `node-local-fs` gate
warns on a byo node whose node-local root shares kubelet's filesystem.

## File routes

A running k8s workspace's file routes run inside it through `yaac-files`
(docs/file-editor.md), and a write touches the trigger file. A stopped k8s
workspace's files are nowhere the server can read, so its file routes
answer `CONFLICT` ("Start the workspace to browse its files").

## Workspaces from before

A life started on the shared-tier layout runs on as it is and has no tree
to salvage. A stopped workspace whose files are still on the shared tier is
imported at its next restart: a tree pod runs a pass over the shared
directory, and the restart restores from that checkpoint. The import never
rewrites or removes the old files. docs/legacy-compat-shims.md tracks both
this and the retired `yaac-checkouts` claim.

# Generic workspace pods

Under `k8s` every workspace pod has one shape, whose spec holds nothing a
project owns. mountd, a per-node daemon, makes a pod one workspace's once
it is running: it mounts what the workspace owns under the pod's node-mounts
directory and binds it inside the sandbox, and hands the workspace a working
tree it built natively on the node. Because a pod is no project's until then,
the server keeps spare pods warm, one pool per image and scratch size, and a
new workspace of any project takes one.

A start that finds no spare (a restart, a site release, a pool still
refilling) creates the same pod on demand and binds it as soon as it is up.

## The pod

| Mounted at creation | Source | Notes |
|---|---|---|
| `/node-mounts`, in both containers | `<node-mounts root>/<workspace id>.<random>`, a hostPath | read-only, `HostToContainer`; empty until the claim |
| `/opt/yaac/helpers`, in both containers | the shared tier's `run/helpers/<server build>` | helper commands, bundled skills and the Go daemons (streamd, acpd), read-only |
| `/yaac-scratch` | one `emptyDir` with the sentry tmpfs annotations | divided among the workspace's scratch dirs at the claim |
| `/yaac-local` | an `emptyDir` | folders bound where a workspace asks for an `emptyDir` (codex's `tmp`) |
| the tmux socket dir, the tree trigger dir | `emptyDir` | |
| the proxy CA | ConfigMap | |
| `/run/yaac`, in the netshim container only | `<socket root>/<workspace id>.<random>`, a hostPath named like the node-mounts directory | the sandbox's `egress.sock` and `ingress.sock` (docs/workspace-egress.md "The contract") |

The pod's environment holds only what any workspace of that id gets: the
stream token, CA trust, ssh's route to the proxy and `YAAC_WORKSPACE_ID`. A
spare is created with an id, and the workspace that takes it has that id, so
the Job's name, the workspace-id label and the stream token are right from
creation.

The pod runs on the `gvisor-nonet` runtime, with no network interface but
loopback. Its first init container is netshim (`restartPolicy: Always`,
root with only `NET_ADMIN` and `NET_RAW`, a startup probe that waits for
`ingress.sock`, and limits of one CPU and 128Mi like every container in the
pod), which carries every connection in and out through the socket
directory (docs/workspace-egress.md "netshim"). DNS names the sinkhole, which
netshim answers. A spare has no egress registration until its claim, and
the proxy refuses an id with none, so a spare is offline until then.

The workspace container's `postStart` hook (`yaac-workspace-init`) does only
the generic setup: the passwd entry, a tmux server with no session
(`exit-empty off`) and streamd. The tree container starts `yaac-tree start`,
which waits for mountd's list.

What stays in the spec, for the few pods made on demand that need it: a byo
volume's claim (kubelet has to attach it), a site release's priority class
and node, and a run's secret variables (`secretKeyRef`). The tree container
is left out of a site release's pod, whose files are on the shared tier.

The node-mounts root (`/var/lib/yaac/node-mounts/<install key>`) is beside
the node-local root, not inside it. It holds mount points and nothing else:
the sweep and disk pods walk the node-local root as root, and must never
reach a project's data through a pod's node-mounts directory. A pod's
directory is named for one life of one workspace and never reused.

## mountd

`yaac-mountd` is one DaemonSet, applied by the server when it starts, with
two containers, `mountd` and `arborist`. Its image holds three static Go
binaries (`k8s/mountd`): those two, and `sandbox-bind`, which runs inside
sandboxes. An init container makes `ready/` the install uid's, with
`CAP_CHOWN` alone, before the arborist starts.

**mountd** is privileged and shares the host's pid namespace, which
`runsc exec` needs. It sees the node-mounts root and the node-local root with
`Bidirectional` propagation, so a mount it makes reaches the node and from
there the pod's node-mounts directory, and mounts the shared tier (and on
kind the volumes claim) as ordinary volumes. It never reads repository
content. Only the server may call it: a network policy admits the server's
pods alone, and each request carries a bearer token from the
`yaac-mountd-token` Secret. Its one egress is the apiserver, for a watch
of its node's pods.

- `POST /bind` makes a pod its workspace's (below).
- `GET /report` answers its build, whether the arborist answers, free
  space on the node-local root, the trees kept ready, and node-mounts
  directories it could not release.
- `PUT /ready` passes the server's ready set to the arborist.

**The arborist** runs as the install uid with every capability dropped,
read-only on the main clones (at the server's own path, since a fork's main
clone borrows from its upstream's by that path) and read-write on `ready/`
alone. It builds working trees with native git. Its limits (4 cores, 1 GiB)
are all that bound a burst of starts' builds; its memory is the page cache of
what it writes.

Take, bind and release for one pod hold that pod's lock, and a bind answered
once is answered the same way again.

## Trees

A workspace's tree is an ordinary directory at
`projects/<p>/trees/<w>/<life>/tree` on the node-local root, owned by that
workspace alone, so checkpoints, salvage, the disk pod and the node-local
sweep treat it as before. The node builds trees of commits the server's main
clone has, and the sandbox only ever applies differences to one: nothing is
checked out from nothing inside a sandbox.

- **Built.** The arborist runs `git read-tree -u --reset` into a
  temporary folder of `ready/`, with `index.version=2`, and renames it into
  place, so a folder with a final name is complete.
- **Backdated.** git writes every file and the index within one second, so
  every entry would be racy and the first `git status` would hash every
  file. The arborist sets every file's mtime two seconds back and rewrites
  each index entry's stat fields from a fresh `lstat`, leaving the object
  ids alone (`cmd/arborist/gitindex.go`). Git's own test suite keeps entries
  out of the racy window the same way.
- **Kept ready** (the `ready-trees` step). One tree for each repo checked out
  in a workspace running now, or in one that stopped less than a day ago, at
  the commit the main clone has for the repo's default branch, on each node
  that holds a spare. Each pass reads the commits fresh, so a fetch that
  moves a branch has the new tree built and the old removed. Builds ahead of
  time run one at a time and wait while any start's build runs. Under the
  disk warn floor a node keeps none.
- **Taken.** `POST /take` to the arborist renames a kept tree out of the
  kept set, or builds one at once; mountd then renames it into the
  workspace's tree directory and its index into the life's scratch folder.
  A rename costs the same for any repo size.

The tree container copies the arborist's index into the checkout's
`.git` and its own scratch repository. A checkout whose HEAD is not the
built commit (a restart's, moved since) gets the difference written by one
`read-tree -u --reset` against that index with `core.checkStat=minimal`:
nothing has run on the tree since the build, so trusting whole-second mtime
and size is sound, and with git's default checks every file would differ,
since the index carries the node's inode numbers.

## A claim

The server's start is the same for a spare and a pod made on demand
(`createWorkspace`), and the k8s driver's `launch` and `awaitReady` do the
pod's part:

1. **Take** (before the workspace is named). A web or `yaac-mama` create
   takes a ready spare of its image and scratch size on a ready node, newest
   first, by the conditional removal of `yaac.prewarmed`; a concurrent take
   of the same spare loses. The create's provisioning entry records the
   spare's id as `claimedId`, and a stop or lookup by either id finds the
   create. A group's last free slot is checked after the take, in the same
   synchronous step as the provisioning entry's registration. A queued
   launch reserves its group slot first, then takes a spare and moves the
   reservation onto the spare's id, which names its workspace; a
   non-interactive run takes none, since it gets run secrets. A spare made
   before this server started is never taken. A spare carries no project
   label, so no workspace listing sees it; a launch gives it one once the
   workspace's row exists. A take no launch adopted is reaped, and a
   workspace that started never is.
2. **Launch.** For a taken pod, the egress registration is written
   alongside its labels and its in-place CPU raise, since nothing in a spare
   reaches out before its claim call. They land while mountd binds it,
   which needs only the workspace-id label the spare was made with, and the
   claim call waits for them. Otherwise the registration is written
   first and a pod is created on demand on a ready node. A start whose pod
   spec must carry something of its own (run secrets, a byo volume's claim,
   a release's priority), or whose image was built since the take, deletes
   the spare it took and is made on demand.
3. **Bind.** Once the life's start instruction names each checkout's commit,
   mountd takes or builds each tree, makes the life's node-local
   folders owned by the install uid, mounts every entry under the pod's
   node-mounts directory, writes the list the tree container binds from, and
   enters the workspace container once to bind its entries.
4. **Claim call.** One streamd request (`daemons/streamd/claim.go`)
   handled in streamd's own process: restore opencode's history, wait for
   the tree container's started marker on the trigger volume, write
   `~/.gitconfig` and `~/.npmrc`, and run one tmux that sets the workspace's
   variables in the server's environment and opens the session at the cwd.
   Every window inherits the variables, and no object in the cluster holds
   them. A start whose agents are all `acp` hands the call the tmux commands
   that open their windows; the session and those windows then open in that
   one tmux, before the wait for the marker, so the adapters boot while the
   tree is filled, and
   the server holds their handshakes until the checkouts are final
   (docs/agent-modes.md "tmux supervises both").
5. **Open.** The life's steps and any windows not opened yet, as any start.

mountd, for one bind:

1. Has the arborist take or build each tree, moves it into place, and
   makes the mount points the tree needs (each `.git`, scratch dir and
   volume under the workspace root).
2. Mounts each entry under the node-mounts directory as `<n>`, from a path
   opened beneath its root by descriptor with no symlink followed, cloned
   with `open_tree`, made read-only before it is attached when its source is
   read-only (so no propagated copy is ever writable), and attached with
   `move_mount`.
3. Writes `list.json` into the node-mounts directory, through a temporary
   name.
4. Enters the workspace container with `runsc exec`, its program (this
   binary) handed in by descriptor and an exact process spec, and binds each
   entry onto its path, parents first, remounting writable ones read-write,
   plus a folder of the scratch or local volume for each scratch dir or
   `emptyDir`.

The tree container holds `CAP_SYS_ADMIN` (and `CAP_SETPCAP`) only until it
has made its own binds from the list (`sandbox-bind tree-start`), which it does
again whenever it restarts; then it drops both from every set, the bounding
set included, and executes `yaac-tree run`, so it never reads what an agent
wrote with them. It fills or restores the tree, reports the files ready
beside its trigger file, and takes its passes.

## Entering a container whose image is not trusted

A workspace's image can come from a Dockerfile an agent edited, so nothing
mountd runs or reads there may come from the image:

- **The program** is `sandbox-bind`, a static binary from mountd's image,
  passed with `--exec-fd`: a path inside the container could be swapped by
  root in the sandbox, and a dynamic binary would load the image's
  libraries. Go's runs where `/proc/self/exe` is not a path.
- **The environment and capabilities** are given in full in a process spec
  (`--process`): `--env` would only add to the image's `ENV`, which can set
  `LD_PRELOAD`. The program gets `CAP_SYS_ADMIN`, `CAP_DAC_OVERRIDE` (mount
  points inside homes the install uid owns) and `CAP_CHOWN` (the volume
  folders it makes), and nothing else.
- **The arguments** are data, never a shell: scratch dir and cache volume
  paths come from project config.
- **The answer** is that project's report and nothing more: capped, quoted,
  and ended past a deadline, so a program that hangs holds only its own
  pod's lock.

The image can still decide where a bind lands inside its own sandbox (a
target that is a symlink), which only misplaces its own project's files. A
read-only source stays read-only whatever the sandbox does, since the node's
mount is read-only.

## Scratch dirs

A volume cannot be added to a running pod, so a pod carries one scratch
volume and the claim divides it: every scratch dir of the workspace is a
folder of it, bound over the dir's path, and they share its size, a project
setting (32 GiB by default; `yaac config scratch-dirs --size`). A full volume
fails writes in every scratch dir and never evicts the pod, whose
ephemeral-storage limit is sized above it. One filesystem also lets pnpm's
store hardlink into every scratch dir. The size is in the pod's spec, so it
is part of what a pool is for.

## Pool policy

The `prewarm-pool` step keeps `YAAC_PREWARM_POOL_SIZE` spares (default 1, 0
turns pools off) for each image and scratch size a workspace running now, or
one that stopped less than a day ago, would launch with now: the image its
project last chose, else its default, as a create naming no image would,
once the registry holds it: a spare of an image still to be built could
only wait on a pull that fails. A spare on an image a Dockerfile edit has
replaced is reaped. Spares do not
outlive the server: one made before it started carries another build's
programs and is reaped. A spare still up is reaped by the same conditional
removal of `yaac.prewarmed` a take makes, so a take between the pool's
listing and its reap keeps the pod. A spare's Job whose pod is not made yet
counts as still being asked for. The pool refills only while no start that
took a spare is still opening its windows, since a pod starting beside a
claim slows it.

## Release

A pod's node-mounts directory holds binds of the shared tier and of a
workspace's folders, so it is never deleted recursively. An informer on the
node's pods wakes mountd when one changes, but release acts on a fresh list:
an informer that fell behind could miss a new pod, and a list that fails
releases nothing. For a directory no listed pod mounts, mountd finds the
mounts under it in the node's mount table, lazily unmounts them deepest first, removes each entry with
`unlink` or `rmdir` without following a link, and reports a directory it
could not empty. A workspace's tree holds no mounts on the node: the `.git`,
scratch dirs and volumes inside it are plain folders there, bound over only
inside the sandbox.

## Server restarts and upgrades

A spare carries its build's helpers folder, with its streamd, acpd and tree
program, so the server reaps every spare older than itself and the pool
refills. A claimed workspace runs on across restarts and upgrades, with the
daemons of the build that made its pod; its helpers folder stays
until no pod mounts it (the `helpers-gc` step). mountd reports the build
it was applied with, and the server applies the DaemonSet with its own build
when it starts, so a node whose mountd is on another build takes no new start
until its mountd pod is replaced, one node at a time. Release needs no request
from the server, so a mountd of any build releases pods of any build.

## When mountd is not there

The server asks every node's mountd for its report every five seconds. A node
takes new starts while, within the last 15 seconds, its mountd
answered on the server's build, reported its arborist up, and reported
free space above the disk stop floor. New pods (spares and pods made on
demand) are pinned to those nodes. A start with no ready node waits about as
long as a rolling update takes, then fails with each node's reason. Running
workspaces need nothing from mountd until they stop.

## Cost

A spare reserves a workspace's memory request from creation, because a
memory request cannot be raised in place on a node with swap. Its CPU
request starts at 100m and is raised to a workspace's at the take, which a
gVisor sandbox applies in place. An idle install reserves one workspace's
memory per pool.

## Platforms

Each platform must give three things, which the `mountd` gate of
`yaac cluster check` proves by binding a gVisor probe pod for real: a mount
under a node-mounts directory reaches a gVisor sandbox, mountd
finds runsc (`/usr/local/bin/runsc`) and its state (under containerd's or
k3s's directory in `/run`) and can enter a container, and its own mounts
are what it binds from.

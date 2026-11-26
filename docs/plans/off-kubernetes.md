# Workspaces without Kubernetes

A proposal for a later step, not built and not scheduled. Nothing here
starts until the plans under "What this builds on" have shipped. It
replaces the `k8s` driver with a `pamir` driver: each workspace is a
gVisor sandbox that Pamir (docs/plans/pamir.md) starts on a machine's
containerd, with the egress of docs/plans/socket-egress.md. Like `k8s`, a
workspace gets an image, a sandbox and mediated egress, so credentials
stay sentinels and `bypass` stays the default permission mode. Unlike it,
there is no cluster, CNI, registry or kind to install.

Pamir is a small orchestrator in a repository of its own. The driver talks
only to Pamir, on one machine as on many, the way the `k8s` driver talks
only to the apiserver on kind and on a cloud cluster alike. containerd and
gVisor's `runsc` sit beneath Pamir, as they sit beneath the kubelet today.

The plan is staged so that each stage is worth having if the next never
happens. Stages 1 to 6 replace Kubernetes on one machine, which is every
local install, with Pamir running one node. Stage 7 adds machines. Stage 8
deletes the `k8s` driver. A second backend on Apple's `container` is a
follow-up, described last.

## What this builds on

- **Generic workspace pods have shipped** (docs/generic-workspace-pods.md).
  Every workspace pod has one shape whose spec holds nothing a project
  owns. A mountd makes a pod a workspace's by mounting on the node and
  entering the sandbox with `runsc exec`, and builds working trees
  natively. Identity arrives at the claim through one streamd call.
- **docs/plans/socket-egress.md has shipped.** A workspace or builder pod
  has no network interface. Its egress and its streams cross two sockets
  in a directory on its node, which netd relays to the proxy and from the
  server. kind runs its default CNI.
- **BuildKit builds have shipped** (docs/image-builds.md). An untrusted layer
  is built by a BuildKit daemon in a sandbox of its own, behind the proxy.
- **Pamir runs one node** (docs/plans/pamir.md "Milestones"): it starts,
  watches and stops units on one machine's containerd, carries their
  sockets, and serves its API.

The first three reduce what a workspace needs from whatever creates it to
a constant: one sandbox of a known shape, a few host directories and two
sockets. Everything that differs between workspaces is done by yaac's own
programs afterwards. This plan replaces the party that creates the
sandbox.

## Why

yaac uses Kubernetes to start one container and watch it.

- A workspace is a single-pod Job with `backoffLimit: 0` and
  `restartPolicy: Never`. Nothing is rescheduled; a restart is the server's
  own act.
- Admission, queues, retries, reaping and reconcile are the server's
  (`#domain`, `WorkspaceStatusWatcher`, `main/reconciler.ts`). On one node
  the scheduler has nothing to decide.

What it costs is larger than what it does:

- **Install.** kind, a privileged node container on rootful podman, an
  in-cluster registry with a write gate, the gVisor installer DaemonSet,
  and three sections of host troubleshooting in docs/cluster-setup.md. The
  install folder is about 9,000 lines and the driver 14,000 more.
- **Working around the kubelet.** netd writes pod cgroups because the
  kubelet neither bounds a gVisor pod's swap nor sees its memory pressure.
  mountd exists because Kubernetes cannot add a mount to a running
  pod, and it already does its work beside the kubelet rather than through
  it. docs/plans/snapshot-warm-pool.md waits on an upstream KEP because a
  restore would mean "driving runsc behind the kubelet's back".
- **Tests.** The k8s tiers need a wired-up cluster and a host to run on.

## End state

```
client ── origin ──► server ──► Pamir ──► containerd ──► generic sandboxes
                      │ │         ▲                        (runsc, no network)
                      │ │         │ carries /run/yaac/egress.sock, ingress.sock
                      │ └──► mountd: binds, trees
                      └──── feed ──► proxy ──► internet
```

Two drivers remain: `containerless` and `pamir`. An install is one server,
one proxy and one Pamir node on one machine. More machines are more nodes
of the same Pamir.

## Decisions

**The sandbox keeps the generic shape, and mountd keeps its job.**
The driver asks for the same sandbox a generic pod is, and mountd
binds it, builds its trees and releases it as it does under k8s. Trees,
checkpoints, restores and the three tiers therefore work as
docs/node-local-workspaces.md describes, on one machine as on kind, and
the two drivers share that code while both exist.

**The driver talks to Pamir, on one machine too.** A single-machine
install then runs the code a fleet runs, which is what kind gives today
and what catches a fleet's bugs on a laptop. It means Pamir's first
milestone comes before this driver has anything to run on. How Pamir calls
containerd is its own question (docs/plans/pamir.md, spike 1). containerd
is the integration gVisor documents and GKE Sandbox runs, and the one
every workspace pod goes through today, so the runtime entry, the runsc
flags and the `dev.gvisor.*` annotations carry over as they are.

**One backend to start: gVisor on Linux.** On macOS the same install runs
inside a Linux VM, which is how a Mac runs workspaces today, with kind
removed from the middle. Apple's `container` is a follow-up ("Follow-up:
an Apple `container` backend"), because it cannot keep the generic shape.

**Pamir carries the sockets.** A sandbox's `egress.sock` and `ingress.sock`
are sockets of its unit, which Pamir delivers to the proxy and opens for
the server, naming the unit each time. That is netd's relay, which this
driver does not use. netd's other two duties, the swap bound and the
memory-pressure kill, run as a unit on every node.

**Images are built by BuildKit on containerd, and podman is not a
dependency.** The images `install` builds from the bundle today with
`podman build` are built by a BuildKit daemon using its containerd worker,
so a result lands in containerd's store with no export or import, and a
layer can name its parent there. The daemon is a unit started from the
digest-pinned `moby/buildkit` image that builder sandboxes already use, so
nothing is added to the host. Upstream images yaac mirrors today are
pulled by containerd by digest.

On Linux that removes podman outright. On a Mac podman has a second job,
the VM, which the next decision covers.

**On a Mac the VM is Lima's, if spike 2 holds.** Lima is a VM manager
whose default guest already runs containerd and BuildKit, so the guest is
set up as a Linux host is, and yaac would have an instance of its own in
place of the user's podman machine.

The data dir stays on the Mac's disk, shared into the VM, as it is today:
the files are the user's to see, and they outlive the VM. So Lima has to
match the one thing the podman machine was set up for, a shared folder
that reports real file ownership to gVisor's gofer. Apple's virtiofs does
not, and krunkit's complete permission mode does (docs/cluster-setup.md
"macOS: the podman machine"). Lima has a krunkit VM type, marked
experimental, and whether it can carry that mode is what the spike finds
out. If it cannot, the podman machine stays as the VM, with containerd and
Pamir in one privileged container inside it, and podman remains a
dependency on macOS only. Keeping the data dir on the VM's own disk would
sidestep the question and is not taken, for the reason above.

**The server, the proxy and yaac's node programs are Pamir units**, as
they are pods of the cluster today (docs/server-in-cluster.md). One
install shape serves Linux and the Mac's VM, the images and their
content-hash rollout carry over, and so does the rule that the server
binds no host port for a forward (docs/port-forward-tunnel.md). The server
is a unit on the host's network and binds its loopback port itself. On a
Mac the VM's port forwarding publishes it, as kind's port mapping does
today. mountd and the memory unit are in the set Pamir runs on
every node.

**No registry on one machine.** containerd's image store is the store.
Tags stay content hashes, so "is a build needed" is a local lookup.

**The three tiers stay directories.** GLOBAL, SERVER-LOCAL and NODE-LOCAL
are folders of the data dir, as they already are on kind
(docs/server-in-cluster.md "Storage claims").

**Nothing is rescheduled automatically**, as today and as Pamir has it.

## What replaces what

| Kubernetes | The `pamir` driver |
|---|---|
| The apiserver, client-node and `ObjectClient` | Pamir's HTTP API and a client for it |
| Job and generic pod per workspace | a unit of the same shape, started under the workspace's id |
| A claim's conditional label patch | a conditional update of the spare's row |
| Informers and watches | Pamir's watch stream, plus a listing on resync |
| netd's relay, and its pod watch | Pamir's carrying of a unit's sockets |
| NetworkPolicy around yaac's own pods, and the CNI that enforces it | none: units have no interface, and yaac's parts reach each other through Pamir or the host's loopback |
| PVCs and static PVs | directories of the data dir |
| Main registry, write gate, mirror digests | containerd's image store |
| `podman build` and `push` at install | BuildKit on containerd, straight into its store |
| The netd and mountd DaemonSets | the set Pamir runs on every node |
| gVisor installer DaemonSet, node tuning | `yaac engine install`, once per machine |
| PriorityClasses | cgroup weights and OOM scores in a unit's spec |
| Server Deployment, rollout | the server unit, replaced by install |
| `kubectl exec` | Pamir's exec, used as rarely (streamd carries the rest) |
| One-shot pods (the root remover, sweeps, the disk probe) | one-shot units |
| Site router, tunnels and per-site Services | the same programs as units, reaching a release through its sockets |
| Tailscale operator Ingress | `tailscale serve` on the host, the form `--tailnet <host>` uses today |
| The token endpoint's Service, ingress policy and kind forwarder (docs/server-in-cluster.md "The token endpoint") | the server unit binding `--token-listen <addr>:<port>` itself, as a host server does; `yaac engine install` takes the flag, and the certificate stays a pair of files in the data dir |
| The scheduler, node pools and taints | Pamir's placement function over node labels (stage 7) |
| cluster-autoscaler and CSI | Pamir's provider interface (stage 7) |

Given up: installs into a cluster yaac did not create. Managed clusters
are the reason the CNI gate, the storage-class checks and most of
`byo-gates.ts` exist.

## Naming

| CLI group | Data dir | Driver |
|---|---|---|
| `yaac server` | `~/.yaac-server` | `containerless` |
| `yaac cluster` | `~/.yaac-cluster` | `k8s`, until stage 8 |
| `yaac engine` | `~/.yaac-engine` | `pamir` |

`DriverKind` gains `'pamir'`, in `packages/server/src/drivers/pamir/`, and
later `docs/pamir-driver.md`.

## The sandbox

What a unit's spec must carry for the generic shape, which is a
requirement on Pamir:

- the node-mounts directory bound read-only, with mounts made on the host
  afterwards appearing inside (`HostToContainer` in a pod spec);
- the scratch volume and the tmux dir as disk-backed sentry tmpfs, through
  the same `dev.gvisor.spec.mount.*` annotations the pod spec sets;
- the socket directory at `/run/yaac`, with its two sockets declared;
- runsc's state directory where mountd can find it, to enter the
  sandbox;
- the tree container beside the workspace container, in one sandbox as in
  a pod, or as two sandboxes over the same directories if Pamir's way of
  calling containerd has no pod.

The isolation and ownership rules are the generic pool's and do not
change: only named directories are mounted, read-only holds against root
inside, and every path is opened by descriptor. Two more apply here:

- **No host socket in a mounted dir except the workspace's own**
  (docs/plans/socket-egress.md "Risks").
- **What an agent writes through `sudo` is root's on the host**, as it is
  on the claim today, and is removed the same way: by a one-shot root unit
  that mounts that one directory (`root-pod.ts`).

## Stages

### 0. Spikes

See "Spikes", and those of docs/plans/pamir.md, whose first can end or
reshape both plans.

### 1. Traits in place of kind comparisons

About 45 sites compare the driver kind, most as `!== 'containerless'`
meaning "sandboxed with mediated egress", so a third kind would silently
inherit k8s behavior. Add one table in `@yaac/shared`:

```ts
/** What a substrate provides. Callers branch on these, never on the kind. */
export interface DriverTraits {
  /** Workspaces run behind an isolation boundary, with images and mediated
   *  egress: sentinel credentials, allowlists, `bypass` by default. */
  isolated: boolean
  /** Keeps prewarmed spares for fast creates. */
  sparePool: boolean
  /** The checkout reaches the workspace through a filesystem that caches
   *  attributes, so a server-side edit must be reopened inside. */
  cachedCheckout: boolean
}
export const DRIVER_TRAITS: Record<DriverKind, DriverTraits> = { … }
```

Domain, runtime, api and the frontend read traits. Install management (the
CLI, `install-record.ts`, the desktop's `server-control.ts`,
`assertHostServerAllowed`) switches exhaustively on the kind, ending in a
`never` check. `resolveDriverKind` answers `k8s` in a cluster, else what
`install.json` records, else `containerless`. This changes no behavior and
lands on its own.

### 2. Move what the container drivers share

A driver cannot import a sibling, so these move into `src/drivers/shared`
with no behavior change:

- the streamd client over a `dial(): Promise<Duplex>`;
- port forwarding (the allocator, the `ports` watcher, `dialWorkspacePort`);
- the fixed in-workspace paths (`containerWorkspacePaths`);
- the image chain (`resolveImageChain`, the hash helpers, build rows);
- the generic sandbox's shape and mountd's client;
- the egress encoding (registrations, credential files, the CA trust env,
  `GIT_SSH_COMMAND`);
- the gVisor mount annotations.

### 3. One Linux machine

- **Install.** `yaac engine install` validates a one-time root setup, which
  it prints as sudo steps when missing and never runs itself, as `yaac
  cluster install` does for the podman socket today: containerd, the
  pinned runsc and its shim with a runtime entry carrying `host-uds=all`,
  `network=none` and the overlay settings pods use, and a pinned Pamir as
  a system service, its control side and one node in one process. It then
  starts the BuildKit daemon, builds the trusted layers and yaac's own
  images with it, declares the every-node set, starts the proxy and the
  server, writes `install.json` and registers the origin. It refuses a
  data dir recorded as another kind.
- **The other commands.** `yaac engine start|stop|restart|logs|status|check|uninstall`.
  `check` runs mountd's gate (bind into a probe sandbox and enter
  it) and the socket plan's acceptance test.
- **Starts.** A start asks Pamir for a generic sandbox and binds it, the
  path a start with no spare takes under k8s.
- **Observation.** Pamir's watch stream, plus a listing on resync. Death
  cause comes from the exit status and OOM events it reports. The
  `pod-stopped` death cause becomes `unit-stopped`.
- **Refused for now.** Untrusted image layers, sites and volumes answer
  `NOT_SUPPORTED` until stage 5.

### 4. macOS

`yaac engine install` on a Mac creates the VM and runs stage 3 inside it.
With Lima that is an instance from a template yaac ships, pinned to a Lima
release, and the podman machine setup and its krunkit wrapper are deleted
with the kind path. The node tuning the gVisor installer applies to a kind
node becomes a step of this install.

### 5. Parity

Each item removes a `NOT_SUPPORTED` or a difference from k8s:

- **Spare pool.** The generic pool carries over with its policy
  (`sparePool: true`; docs/generic-workspace-pods.md "Pool policy"): one
  pool per image and scratch size, and ready trees on the nodes that hold
  a spare. A spare is a generic sandbox with no egress registration and
  nothing bound, idling on a small CPU share that the take raises. The
  take, a conditional label removal under k8s, becomes a conditional
  update of the spare's row. Spike 1's numbers size the pool.
- **Untrusted layers.** The trust split holds
  (docs/image-builds.md). Each untrusted build runs in a throwaway
  builder sandbox, as it runs in a builder pod. With no registry, its
  output is an image archive loaded into containerd's store and its cache
  a per-project directory. Prewarm reuses `reconcileImagePrewarm`. Image
  GC keeps the live set plus the newest two generations per repo
  (docs/image-gc.md).
- **Volumes.** A directory of the data dir, as on kind
  (docs/workspace-volumes.md), bound by mountd.
- **Sites.** The router and the tunnels run as units. The router reaches
  a release through Pamir and the release's `ingress.sock`, where today it
  dials a pod IP. The flip of a deploy becomes the server's
  write of the router's upstream.
- **npm cache.** Packages come through the proxy. A shared cache is added
  only if installs measure slower than under k8s.

### 6. The default on one machine

- New local installs are `pamir`. `yaac cluster install` without `--byo`
  is removed, and with it kind, the node fixups, the extraMounts checks
  and `yaac cluster delete`.
- An existing kind install is adopted in place: its data dir already holds
  the three tiers as directories. `yaac cluster delete`, then `yaac engine
  install` pointed at that data dir, which rewrites `install.json`. That
  conversion gets an entry in docs/legacy-compat-shims.md.

Gate: the `e2e-pamir` tier covers what `e2e` covers, and the isolation
case passes on Linux and on a Mac.

### 7. More than one machine

Pamir's later milestones (docs/plans/pamir.md): nodes that join, sockets
carried between machines, placement, and a provider that adds and removes
machines. What the driver adds on top:

- **Placement.** A start asks Pamir's placement function for a node with
  room for the workspace's memory request, among those labelled for
  workspaces, with a release or a volume pinned to its node.
- **The shared tier** is one NFS export mounted at the same path on every
  node, as the claim is mounted on every node today.
- **Images** reach a node from a registry Pamir runs as a unit on the
  control node, which the build pushes to.
- **A lost node** is a lost workspace, restarted elsewhere by its owner, as
  today.
- **`infra/hetzner-k3s`** becomes a stack that installs containerd, runsc
  and Pamir's node program, with its autoscaler replaced by Pamir's
  Hetzner provider.

Until this stage ships, a multi-machine install stays on the `k8s` driver
with `--byo`.

### 8. Delete the k8s driver

`packages/server/src/drivers/k8s`, `k8s/netd`'s relay,
`k8s/kind-config.yaml`, `k8s/tailscale-operator`, the object watches of
the proxy and mountd, `packages/test-utils`'s cluster stub, the
`api-k8s`, `e2e` and `apiserver` projects, `infra/hetzner-k3s` in its
present form, and docs/cluster-setup.md, docs/server-in-cluster.md and
docs/event-driven-reconcile.md. `yaac cluster` goes with them.

## Testing

- **Unit (`unit:server`).** `test/drivers/pamir/` mirrors the folder. The
  driver's Pamir client is faked at its transport by a `fakePamir` in
  `packages/test-utils` that a test seeds and asserts on, as `k8s-stub.ts`
  fakes the cluster today. One `describe` per barrel function defined in
  each module.
- **Route matrix.** A third column, `pamir`, on every row, with a `why`
  wherever it differs. A new project, `api-pamir`, runs the real driver
  against the fake, on any machine.
- **e2e.** `test/e2e-pamir/` runs on a host with containerd and Pamir. The
  global setup builds the `yaac-test-*` images there, using the same hash
  tags and `requirePrebuilt`. `test/e2e-cli/engine-cli-suite` covers every
  `yaac engine` option. From stage 7 the tier also runs against several
  Pamir nodes on one machine.
- **Isolation.** One e2e case tries, as root in the workspace, to write the
  read-only `.git` (also after a remount), to read another project's dir,
  to plant a link the server then reads, and the socket plan's acceptance
  test. All must fail.
- **Dev workspaces cannot run `e2e-pamir`.** It runs on a host, like the
  k8s tiers.

## Spikes

How Pamir starts a generic sandbox on containerd is spike 1 of
docs/plans/pamir.md. These are the driver's own:

1. **Start time.** Time a generic sandbox from the driver's request to
   streamd answering, against a generic pod's. This sizes the pool, and
   says what a restart, which never takes a spare, will cost.
2. **The Mac's VM.** Stage 3 inside a Lima instance on its krunkit VM
   type, with the data dir shared from the Mac. As a workspace uid, write
   through a bind and read back the real owner, which is what fails on
   Apple's virtiofs. If Lima's template cannot set krunkit's permission
   mode, find out what would: a wrapper as podman needs today, or a change
   upstream. Then check that the VM comes back after the Mac sleeps and
   reboots, that its clock holds, and that its memory and disk can be
   resized. If the ownership check cannot be made to pass, repeat stage 3
   in the podman machine, with containerd and Pamir in a container.
3. **BuildKit on containerd.** The daemon as a unit with the containerd
   worker: a build of the trusted chain lands in containerd's store, a
   layer builds on a parent that exists only there, and a rebuild of an
   unchanged tree is a cache hit.
4. **Checkpoint and restore.** `runsc checkpoint` and `restore` of an idle
   spare, since no kubelet stands between yaac's programs and runsc any
   more.

## Risks and open questions

- **Pamir has to exist first.** Its one-node milestone is new code in a
  new repository, and stage 3 has nothing to run on until it is done.
- **Pamir's API is root on the machine**, since a unit may mount any host
  path, and the server holds a token for it. A user granted the rootful
  podman socket holds as much today, and the server under k8s can already
  start root pods that mount host paths.
- **containerd replaces podman as the one thing a Linux host must have.**
  It is in every distribution's repositories, and `infra/hetzner-k3s`
  installs it from apt today.
- **Lima would be a new dependency on a Mac in podman's place**, and the
  plan needs its krunkit VM type, which is experimental. Spike 2 decides,
  and the podman machine is the fallback.
- **Checkpoint and restore is documented for `runsc` itself and for
  Docker, not for the containerd shim.** Spike 4 finds out what a restore
  takes.
- **containerd is the user's.** They can see and delete yaac's containers.
  Pamir's namespace and labels identify them, and a deleted one is an
  ordinary death.
- **The Mac's VM is one fixed-size VM.** That is today's behavior, not a
  regression.

## Other plans

- **docs/plans/snapshot-warm-pool.md** is blocked on Kubernetes creating a
  pod as a restore. Under this driver the blocker is gone (spike 4).
- **docs/plans/linux-packaging.md**'s `yaac-cluster` package becomes a
  `yaac-engine` package with no kind or kubectl to fetch.
- **docs/plans/cluster-backups.md** backs up tiers, which are unchanged.
- **docs/plans/node-drain.md**, **node-host-firewall.md** and the k8s
  sections of **storage-gc-gaps.md** apply while the k8s driver lives.

## Follow-up: an Apple `container` backend

After stage 6, a second backend could run each workspace as a micro-VM
under Apple's `container` on macOS 26 and Apple silicon, in place of the
shared VM. It would need no root and no shared VM: `container` talks
over XPC to a per-user launchd agent, and each container is a
Virtualization.framework VM with its own kernel.

It is a follow-up and not a stage because it cannot reuse the generic
shape. That shape depends on a mount made on a Linux host appearing inside
a running sandbox, and on entering the sandbox with `runsc exec`. macOS has
no bind mounts, and a VM's shares are fixed when it is created. So an
Apple sandbox is created for one workspace with its mounts named at
create, there is no spare pool, and trees are checked out inside the
guest. That is a second create path and a second mount model beside the
mountd's. Whether such a sandbox is a second kind of Pamir node or
sits outside Pamir is part of what the follow-up would decide.

What is known about `container` (from 1.5.0 and its source):

- Containers outlive the server, but not `container system stop` or a
  reboot.
- Memory the guest frees is not returned to the host, so a VM only grows
  toward its `--memory` limit.
- `container build` uses one shared builder VM with network access, so it
  is only for trusted layers.
- A named volume is a block device and must never be attached to two
  running VMs at once.
- There are no events: liveness is a per-container `logs -f` plus a poll.

How the mounts would map:

- **Directories** are one virtiofs share each. Nested targets work when
  mounted parent first.
- **Single files** cannot be bound. The launch stages them in one read-only
  directory and the image's entry point links each into place.
- **Scratch dirs** are one named ext4 volume each, and the tmux dir a small
  tmpfs.
- **Ownership.** Virtualization.framework's virtiofs reports every file as
  owned by whoever looks ([lima#1513](https://github.com/lima-vm/lima/issues/1513)),
  and does all host I/O as the Mac user. Writes succeed and `chown` is
  silently dropped. A tool that expects a file to belong to a different
  user is wrong there and nowhere else.

The socket contract was chosen to hold on a micro-VM too, so the proxy,
netshim and streamd would be reused unchanged. Only how the two sockets
cross the boundary differs:

| | gVisor | Apple `container` |
|---|---|---|
| No network | `network=none` (loopback only) | `--network none` (no NIC) |
| `egress.sock`, host to guest | `host-uds`, on a bind-mounted socket | a socket given as a `-v` source is relayed in |
| `ingress.sock`, guest to host | `host-uds`, in the bind-mounted dir | `--publish-socket` |

The two sockets are mounted and published one by one, under a short path,
because `sun_path` is about 104 bytes on macOS. The guest is a real Linux
kernel, so netshim's loopback route and NAT rule are ordinary `ip` and
`iptables` commands.

Spikes that decide whether to build it:

- **Read-only against guest root.** A read-only share must be enforced by
  the host-side virtiofs server, since root in the guest can remount. A
  failure here ends the follow-up, because the main clone's `.git` and
  attachments depend on it.
- **Coherence.** A tool home written by two VMs at once (claude's
  `.claude.json`), with caching no looser than NFS's today. Apple
  documents no cache settings.
- **The share-count limit per VM**, and whether `logs -f` ends on stop.
- **Memory growth** over a long session, to set a default limit.
- **Boot to ready**, which with no spare pool is the whole start.
- **Socket throughput** through Apple's relay, as the socket plan's
  spike 3 measures it for gVisor.

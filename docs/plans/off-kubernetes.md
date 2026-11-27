# Workspaces without Kubernetes

A proposal for a later step, not built and not scheduled. Nothing here
starts until the plans under "What this builds on" have shipped. It
replaces the `k8s` driver with a `pamir` driver: each workspace is a
gVisor sandbox that Pamir (docs/plans/pamir.md) starts on a machine's
containerd, with the socket egress of docs/workspace-egress.md. Like `k8s`, a
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
- **Socket egress has shipped** (docs/workspace-egress.md). A workspace or
  builder pod has no network interface. Its egress and its streams cross
  two sockets in a directory on its node, which netd relays to the proxy
  and from the server. kind running its default CNI is
  docs/plans/socket-egress.md, which is not built yet.
- **BuildKit builds have shipped** (docs/image-builds.md). An untrusted layer
  is built by a BuildKit daemon in a sandbox of its own, behind the proxy.
- **Pamir runs one node** (docs/plans/pamir.md "What is built"): it starts,
  watches and stops pods on one machine's containerd, carries their
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
                      │ │         │ carries sandbox egress to the proxy, streams in
                      │ └──► mountd: binds, trees
                      └──── feed ──► proxy ──► internet
```

Two drivers remain: `containerless` and `pamir`. An install is one server,
one proxy and one Pamir node on one machine. More machines are more nodes
of the same Pamir.

## Decisions

**The sandbox keeps the generic shape, and mountd keeps its job, less
one step.** The driver asks for the same sandbox a generic pod is, and
mountd builds its trees, mounts them on the node and releases it as it
does under k8s. The one step it gives up is entering the sandbox to bind
those mounts onto their paths: the server asks Pamir's exec to run the
same helper there, so mountd needs neither `runsc` nor the host's process
namespace (spike 5). Trees,
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

**Pamir carries the sockets, and the proxy is the broker.** A sandbox asks
Pamir for transparent egress with the proxy as its broker
(docs/plans/pamir.md "A pod can ask for transparent egress"). Pamir
injects its shim, which is netshim leaving yaac, and delivers each
connection to the proxy stamped with the pod's id, destination and name,
and it opens the sandbox's stream socket for the server alone, through
the namespace's streams socket, which Pamir's relay serves, so a terminal
outlives a restart of Pamir's node program. That is
netd's relay and netshim, which this driver does not ship. The proxy
stays yaac's, an `egress` pod the server feeds registrations and
credentials directly, with no Kubernetes objects to watch and no shared
secret on any network. Every socket one of yaac's own programs serves is
a path in its pod: the proxy's broker socket and the one the server feeds,
the server's own, its `api` among them, and mountd's. The server's
imports are paths too, as every import is, Pamir's management API and
streams socket
included (docs/plans/pamir.md "Inside a pod, a socket is a file"). So no
dial the proxy or the server makes for someone else, to a workspace's
destination or a URL a user supplied, reaches one, and the server knows
its owner by the stamp of its published port, not by a loopback address
anything in its pod could dial from. The proxy
also refuses loopback and its own addresses whatever an allowlist names,
where today an exact entry admits them. It goes on routing by the
request's own name, the TLS server name or the `Host`, and refuses a
connection whose stamp names another (docs/plans/pamir.md "A stamp's name
is what the pod looked up"). The stamp's name is all it has for a client
that waits for the server to speak first, which hangs today. Refusing a
stamp that disagrees also refuses a client told to connect to one host
while asking for another (`curl --connect-to`), which works today.
netd's other two duties, the swap bound and the memory-pressure kill, run
as a pod on every node.

**Images are built by BuildKit on containerd, and podman is not a
dependency.** The images `install` builds from the bundle today with
`podman build` are built by a BuildKit daemon using its containerd worker,
so a result lands in containerd's store with no export or import, and a
layer can name its parent there. Install runs the daemon itself, as a
process of its own for as long as the build takes, and it is no pod: to
share containerd's socket and storage a pod would have to be the host in
all but name, and install is root already. The daemon's programs are
static, so install takes them from the digest-pinned `moby/buildkit`
image that builder sandboxes already use, pulled through containerd and
copied out, and nothing is installed on the host. The daemon writes into
one containerd namespace, so install runs it once for yaac's and once for
`system`'s. The Dockerfiles are yaac's own, so there is nothing in them
to contain. Upstream images yaac mirrors today are pulled by containerd
by digest.

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

**The server, the proxy and yaac's node programs are declared Pamir
pods**, as they are pods of the cluster today (docs/server-in-cluster.md),
which install declares through Pamir's admin socket (docs/plans/pamir.md
"Pods are of two kinds"). The server starts only namespace pods, held to
the limits install sets (`gvisor-nonet` alone, the data dir's tiers, no
privilege, no `egress`, and no annotation but gVisor's mount hints), so it
is no longer root on the machine as its
service account is under k8s. One
install shape serves Linux and the Mac's VM, the images and their
content-hash rollout carry over, and so does the rule that the server
binds no host port for a forward (docs/port-forward-tunnel.md). The server
is an `egress` pod (docs/plans/pamir.md "A pod's network is one of two
modes"), and Pamir's relay listens on the host's loopback port and
carries each connection to the server's API socket. On a Mac the VM's port
forwarding publishes that port, as kind's port mapping does today. mountd
and the memory pod are declared on every node, the memory pod in Pamir's
`system` namespace since it serves the whole machine.

**The registry is Pamir's, over containerd's store.** containerd's image
store holds every image once, and Pamir serves it as a registry
(docs/plans/pamir.md "Images"), so builds push and pull as they do today
and another machine pulls from it. Tags stay content hashes, so "is a
build needed" is a local lookup. The registry checks a signed token on
every request, so today's write gate goes: the server issues each build
a token with the scopes its grant carries today (the layer's repo, its
project's cache repo, and a protected parent) and its lifetime, until the
build's deadline plus a minute, from a signing key kept
with its secrets in the server-local tier, and the proxy only forwards
them. Nothing else needs one: install builds yaac's images straight into
containerd's store, and the server checks whether an image is there
through Pamir's image API, never the registry. A
build reports its result's digest, which the server records and starts
pods by, and since a tag never moves there, an escaped build step cannot
swap a project's image under an existing tag. A rebuild without cache,
whose output differs from what the tag already names, has the server
remove the tag before its push.

Build caches keep their windows, but each build saves its cache under a
ref of its own (`yaac-buildcache-<project id>:<layer>-<key>-<window>-<build
id>`) instead of rewriting one per window. The server records each
build's cache ref, hands the last successful build's to the next build as
its `--import-cache` while it is in the current window, and has the image
GC remove superseded refs. The source policy and digest-pinned mirrors of
docs/image-builds.md carry over as they are.

**The three tiers stay directories.** GLOBAL, SERVER-LOCAL and NODE-LOCAL
are folders of the data dir, as they already are on kind
(docs/server-in-cluster.md "Storage claims").

**Nothing is rescheduled automatically**, as today and as Pamir has it.

## What replaces what

| Kubernetes | The `pamir` driver |
|---|---|
| The apiserver, client-node and `ObjectClient` | Pamir's HTTP API and a client for it |
| Job and generic pod per workspace | a pod of the same shape, started under the workspace's id |
| A claim's conditional label patch | a conditional update of the spare's row |
| Informers and watches | Pamir's watch stream, plus a listing on resync |
| netd's relay, its pod watch, and netshim | Pamir's relay and its injected shim, delivering to the proxy as each sandbox's broker |
| The proxy's object watches (registration ConfigMaps, credential Secrets) and its auth secret on the relay's connections | the server feeding the proxy directly, and a broker socket that is a path in the proxy's pod, where only Pamir's relay delivers |
| NetworkPolicy around yaac's own pods, and the CNI that enforces it | Pamir's two network modes: pods have no interface but loopback, the proxy, server and tunnels reach only public addresses through Pamir's floor, and yaac's parts reach each other through sockets Pamir carries |
| PVCs and static PVs | directories of the data dir |
| Main registry, write gate, mirror digests | Pamir's registry over containerd's store, checking the server's signed tokens |
| `podman build` and `push` at install | BuildKit on containerd, straight into its store |
| The netd and mountd DaemonSets | pods declared on every node |
| gVisor installer DaemonSet, node tuning | `yaac engine install`, once per machine |
| PriorityClasses | cgroup weights and OOM scores in a pod's spec |
| Server Deployment, rollout | a declared pod, replaced when install changes its declaration |
| `kubectl exec`, and mountd's `runsc exec` | Pamir's exec, used as rarely (streamd carries the rest), and for the bind helper, handed in by descriptor |
| One-shot pods (the root remover, sweeps, the disk probe) | one-shot pods |
| Site router, tunnels and per-site Services and EndpointSlices | the same programs as declared pods: one import of the router's leads to every release's `site` socket, and routes and credentials come from the server as files |
| Tailscale operator Ingress | `tailscale serve` on the host, the form `--tailnet <host>` uses today |
| The token endpoint's Service, ingress policy and kind forwarder (docs/server-in-cluster.md "The token endpoint") | a port Pamir publishes on that address to the server's token socket, which may be published off loopback because it authenticates every request (docs/plans/pamir.md "On the host, a socket is a published port"); `yaac engine install` takes `--token-listen <addr>:<port>` and declares it, the server ends TLS itself with the certificate that stays a pair of files in the data dir, and it reads the client's address from the relay's stamp |
| The scheduler, node pools and taints | Pamir's placement function over node labels (stage 7) |
| cluster-autoscaler and CSI | Pamir's provider, a program of its own that holds the cloud's token (stage 7) |

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

What a pod's spec must carry for the generic shape, which is a
requirement on Pamir:

- the node-mounts directory bound read-only, with mounts made on the host
  afterwards appearing inside (`HostToContainer` in a pod spec);
- the scratch volume and the tmux dir as disk-backed sentry tmpfs, through
  the same `dev.gvisor.spec.mount.*` annotations the pod spec sets;
- transparent egress with the proxy as its broker, a stream socket on
  streamd's port that the server opens through the namespace's streams
  socket, and for a release a
  `site` socket on its site's port that only the router may open;
- an exec that runs yaac's bind helper inside the workspace container,
  handed in by descriptor with its process given whole (docs/plans/pamir.md
  "An exec may bring its own program"), so that nothing outside Pamir
  enters the sandbox (spike 5); or, if that does not hold, the runtime's
  state directory and the container's id as fields of the pod's status,
  for mountd to enter with as it does today;
- the tree container beside the workspace container, in one sandbox as in
  a pod. Pamir's shim has to share that sandbox in any case
  (docs/plans/pamir.md, spike 1), so there is no form of this plan with a
  sandbox for each container.

The isolation and ownership rules are the generic pool's and do not
change: only named directories are mounted, read-only holds against root
inside, and every path is opened by descriptor. Two more apply here:

- **No host socket in a mounted dir except the workspace's own**
  (docs/workspace-egress.md "The contract": only the shim's container
  mounts the socket directory). A sandbox imports nothing and serves its
  sockets as ports, so it has no socket directory of the pod's own
  (docs/plans/pamir.md "Inside a pod, a socket is a file") to mount.
- **What an agent writes through `sudo` is root's on the host**, as it is
  on the claim today, and is removed the same way: by a one-shot root pod
  that mounts that one directory (`root-pod.ts`). It is no way to root
  there: the data dir's mount is `nosuid` and `nodev`, and so is every
  bind mountd makes beneath it.

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

- **Install.** `yaac engine install` runs as root, as `sudo yaac engine
  install`, on a first install and on every upgrade: it writes through
  Pamir's admin socket and builds into containerd's store, and both are
  root's. What is the user's it writes as the user who ran `sudo`, not as
  root: the data dir's own files, `install.json`, and the origin's
  registration in that user's `~/.yaac-client`. `yaac engine uninstall`
  runs as root for the same reason. Install still only checks the machine's
  one-time setup, and prints the steps for what is missing without taking
  them, since they change the machine and not yaac: containerd, the pinned
  runsc and its shim with a runtime entry carrying `host-uds=all`,
  `network=none` and the overlay settings pods use, a pinned Pamir as two
  system services (docs/plans/pamir.md "Two programs"), and the data dir as
  a mount of its own with `nosuid` and `nodev`, made at every boot: a bind
  of the folder onto itself where it is not already a filesystem of its
  own. Pamir requires both flags of every path a namespace's pods mount
  (docs/plans/pamir.md "A namespace's pods are held to its limits"). It
  then runs the BuildKit daemon as a process of its own, builds the trusted
  layers and yaac's own images with it, stops it, and declares through the
  admin socket yaac's namespace with its limits and yaac's declared pods
  (mountd, the server, the proxy, the site router and the tunnels, and the
  memory pod in Pamir's `system` namespace). A memory pod already declared
  differently is left as it is and reported, unless the operator passes the
  flag to replace it, and uninstall leaves it (docs/plans/pamir.md "Every
  pod belongs to a namespace"). It writes `install.json` and registers the
  origin. An upgrade changes the declarations, which replaces those pods.
  It refuses a data dir recorded as another kind.
- **Install runs where Pamir runs.** It builds yaac's images on that
  machine, into its containerd, so it never pushes an image and needs no
  registry token, and an image is always built for the architecture that
  runs it. On a Linux machine it runs locally; on a Mac it runs inside the
  VM (stage 4); for a remote server the user runs it there. Building on a
  laptop and pushing to a remote registry would mean emulating the server's
  architecture, moving gigabytes on every install, and a registry token
  before the server that issues them exists. With several machines it runs
  on the control node, and workers pull from its registry. - **The other
  commands.** `yaac engine start|stop|restart|logs|status|check|uninstall`.
  `restart`, `logs` and `status` need no root: the namespace's management
  socket restarts yaac's declared pods and reads their logs. `start` and
  `stop` change whether those pods are declared to run, and `uninstall`
  removes them, so they are root's, as install is. `check` runs mountd's
  gate (bind into a probe sandbox and enter it) and the socket plan's
  acceptance test.
- **Starts.** A start asks Pamir for a generic sandbox and binds it, the
  path a start with no spare takes under k8s.
- **Observation.** Pamir's watch stream, plus a listing on resync. Death
  cause comes from the exit status and OOM events it reports. The
  `pod-stopped` death cause keeps its name.
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
  builder sandbox, as it runs in a builder pod, and pulls its parent,
  pushes its result and exports its cache to Pamir's registry through the
  proxy, as it does to the main registry today. Prewarm reuses
  `reconcileImagePrewarm`. Image GC keeps the live set plus the newest
  two generations per repo (docs/image-gc.md), by removing the rest
  through Pamir's image API.
- **Volumes.** A directory of the data dir, as on kind
  (docs/workspace-volumes.md), bound by mountd.
- **Sites.** The router and the tunnels are declared pods, which the
  server neither creates nor changes, so publishing a site needs no root.
  - **A release's socket.** A release never takes a spare, so its spec
    declares a `site` socket on the port its site names, with the router
    as its one caller. It is a port, since a user's web server binds
    nothing else. The app goes on trusting the router's headers
    (docs/public-sites.md "Headers an app may trust") because only the
    router opens that socket and nothing in a sandbox dials for anyone
    else.
  - **The router's import.** One import leads to the `site` socket of
    every release (docs/plans/pamir.md "An import leads to one socket, or
    to every socket of a name"). Each release has a cluster in the
    router's CDS file whose one endpoint is that import's path, and whose
    upstream PROXY protocol header carries the release's pod id in the
    TLV that carries the site's id today. A site's virtual host routes to
    its live release's cluster.
  - **A deploy's flip** is two writes to the files the router watches,
    each swapped in whole as a ConfigMap's update is: the new release's
    cluster is added, then the site's route is pointed at it. The old
    release's cluster goes when that release stops, so its open
    connections finish. Pamir closes a connection that names a release
    which is gone, and the router answers 503, as it does for a site with
    no live release. Nothing follows a release's node or the relay's
    address, which the Service and its EndpointSlice do today.
  - **The tunnels.** cloudflared imports the router's `public` socket,
    and each public hostname in the Cloudflare dashboard names it as its
    origin: `unix:/run/pod/public.sock`, which `yaac site publish` prints
    where it prints the router's Service today. tailgate imports the
    router's `tailnet` socket and the server's `api`. A tunnel idles
    until the server writes its credentials.
  - **The router's own listeners** are paths if Envoy both reads the
    relay's stamp on one and still writes a release's pod id to the
    import from it (docs/plans/pamir.md, spike 2), and ports otherwise,
    which its pod allows, since Envoy dials nothing but its import.
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
- An install with public sites changes each one's origin in Cloudflare.
  The tunnel is remotely managed, so a public hostname's origin is a
  setting in the user's Cloudflare account, and yaac holds no API token to
  change it with (docs/public-sites.md "The edge"). Under k8s it is the
  router's Service, `http://yaac-site-router:8080`; under `pamir` it is
  cloudflared's import of the router, `unix:/run/pod/public.sock` (stage
  5, "Sites"). A hostname left as it was reaches nothing, so its site is
  down from the conversion until it is changed. The conversion ends by
  listing each published hostname with the origin to enter, which `yaac
  site publish` prints for a new one.

Gate: the `e2e-pamir` tier covers what `e2e` covers, and the isolation
case passes on Linux and on a Mac.

### 7. More than one machine

Pamir on several machines (docs/plans/pamir-multi-node.md): nodes that
join, sockets carried between machines, placement, and a provider that adds
and removes machines. What the driver adds on top:

- **Placement.** A start asks Pamir's placement function for a node with
  room for the workspace's memory request, among those labelled for
  workspaces, with a release or a volume pinned to its node.
- **The shared tier** is one NFS export mounted at the same path on every
  node, as the claim is mounted on every node today.
- **Images** reach a node from the control node's registry, which the
  build pushes to (docs/plans/pamir-multi-node.md "Storage and images").
- **A lost node** is a lost workspace, restarted elsewhere by its owner, as
  today. The restart's start is refused until the lost node is fenced,
  which the start asks for where the install's config lets it
  (docs/plans/pamir-multi-node.md "A pod id runs in at most one place"),
  so two copies of a workspace never write the shared tier at once.
- **`infra/hetzner-k3s`** becomes a stack that installs containerd, runsc
  and Pamir's node program, with its autoscaler replaced by Pamir's
  Hetzner provider.

Until this stage ships, a multi-machine install stays on the `k8s` driver
with `--byo`.

### 8. Delete the k8s driver

`packages/server/src/drivers/k8s`, `k8s/netd`, the relay and netshim
(`k8s/mountd/cmd`, whose successors are Pamir's),
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
  test. All must fail. It also writes a setuid-root program into its
  checkout, which the test then runs from the host's path as an ordinary
  user and finds running as that user.
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
3. **BuildKit on containerd.** The daemon as a process install runs, its
   programs copied out of the pinned image, with the containerd worker: a
   build of the trusted chain lands in the containerd namespace it was
   pointed at, a
   layer builds on a parent that exists only there, and a rebuild of an
   unchanged tree is a cache hit.
4. **Checkpoint and restore.** `runsc checkpoint` and `restore` of an idle
   spare, since no kubelet stands between yaac's programs and runsc any
   more.
5. **Binding with no entry from outside.** mountd makes a start's mounts
   on the node and returns; the server then has Pamir's exec run
   `sandbox-bind` in the workspace container, handed in by descriptor from
   the helpers folder, with the capabilities it has today and nothing of
   the image's. Check that the binds land as they do now and that a bind
   asked twice is answered the same; that a restart of Pamir's node
   program in the middle is met by asking again; and what the step adds
   to a start's time, against mountd's own `runsc exec`. If it holds,
   mountd drops `runsc` and the host's process namespace. If not, mountd
   enters as today, from the pod's status.

## Risks and open questions

- **Pamir has to exist first.** Its one-node milestone is new code in a
  new repository, and stage 3 has nothing to run on until it is done.
- **Pamir's admin socket is root on the machine**, and install writes
  through it. A user granted the rootful podman socket holds as much
  today. The server holds less than it does under k8s, where it can start
  root pods that mount any host path: its management socket starts only
  sandboxes over the data dir, whose mount lets nothing written there run
  as root (docs/plans/pamir.md "A namespace's pods are held to its
  limits").
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
- **cloudflared's `unix:` origin is documented for a public hostname.**
  That Cloudflare's dashboard offers it for a remotely managed tunnel,
  which yaac's is, is not checked. A forwarder in the tunnel's pod is the
  way round if it does not.

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
  owned by whoever looks
  ([lima#1513](https://github.com/lima-vm/lima/issues/1513)), and does all
  host I/O as the Mac user. Writes succeed and `chown` is silently dropped.
  A tool that expects a file to belong to a different user is wrong there
  and nowhere else.

The socket contract was chosen to hold on a micro-VM too, so the proxy,
Pamir's shim and streamd would be reused unchanged. Only how the two sockets
cross the boundary differs:

| | gVisor | Apple `container` |
|---|---|---|
| No network | `network=none` (loopback only) | `--network none` (no NIC) |
| `egress.sock`, host to guest | `host-uds`, on a bind-mounted socket | a socket given as a `-v` source is relayed in |
| `ingress.sock`, guest to host | `host-uds`, in the bind-mounted dir | `--publish-socket` |

The two sockets are mounted and published one by one, under a short path,
because `sun_path` is about 104 bytes on macOS. The guest is a real Linux
kernel, so the shim's loopback route and NAT rule are ordinary `ip` and
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

# Pamir: a small orchestrator for sandboxes on several machines

A proposal, not built or tried. Pamir is a Go library, and the two
programs built from it, that does for yaac what Kubernetes does today: it
starts sandboxes on machines, watches them, and carries connections to
them. It is what the `pamir` driver of docs/plans/off-kubernetes.md talks
to, on one machine and on many. It has far fewer features than Kubernetes
and only what yaac needs to start with. It lives in a repository of its
own and knows nothing of yaac, so it can be deployed without it and for
other things.

This document says what Pamir has to do and must not do, describes three
ways it could be built, and records which was chosen.

## What it replaces

Once the plans the `pamir` driver builds on have shipped, Kubernetes is
doing these things for yaac and nothing else:

| Job | Today |
|---|---|
| Machines join and leave, and their capacity is known | kubelet registration, the Node object |
| A sandbox is started on a chosen machine, watched and stopped | Job, pod, kubelet, informers |
| A machine is chosen for a sandbox | the scheduler: memory request, the workspace pool's taint, a release's node pin |
| Some programs run on every machine | DaemonSets: netd, mountd, the gVisor installer |
| The server reaches a sandbox on another machine | the pod network, then netd's relay |
| A machine has the image a sandbox needs | the in-cluster registry and containerd's pull |
| Machines are added when a sandbox does not fit and removed when empty | cluster-autoscaler with its Hetzner provider |
| A disk follows the sandbox that mounts it | CSI, for a volume's claim |
| Several installs and test runs share one cluster without meeting | namespaces |

What Kubernetes does that yaac does not use, and Pamir leaves out: an
overlay network, Services and cluster DNS, NetworkPolicy, replicas and
rollouts of user workloads, automatic rescheduling, RBAC, custom
resources, and a highly available control plane.

## Constraints

**It is generic.** Pamir runs units on nodes. It has no notion of a
workspace, a project, a spare, an allowlist or gVisor. A runtime handler
is a name it passes to containerd, and a mount annotation is a string it
copies. The test of this is a second user: a pool of machines running CI
jobs in sandboxes should need nothing from yaac.

**Units have no network. They have sockets.** After
docs/plans/socket-egress.md a sandbox's only links to the outside are unix
sockets in a directory on its node. Pamir makes that its model of
connectivity: a unit declares sockets, and Pamir carries a connection
between a unit's socket on one machine and a program on another, saying
which unit it came from. That is what netd's relay does today, made
general. It is also what keeps Pamir small, because it removes the CNI,
the pod network, Services, DNS and policy at once. A unit that wants the
host's network may have it; nothing in between is offered.

**A unit keeps running when everything else is down.** Restarting or
upgrading the control side, or the program that uses Pamir, must not stop
a sandbox. The part of Pamir on a node needs nothing from the rest to keep
its units alive.

**Nothing moves by itself.** A unit that dies is reported, not restarted
somewhere else, and a node that stops answering is reported as unknown.
yaac never relied on Kubernetes to reschedule a workspace, and a rule this
simple is what lets Pamir skip leader election and leases. The one hard
guarantee is that a unit id runs in at most one place: a node that comes
back stops any unit the control side has since started elsewhere, before
it does anything else.

**One control node, and no consensus.** yaac already has one server, one
database and one proxy on one machine. Pamir's control side sits there and
may be a single point too, as long as losing it stops no unit and it can
rebuild what it knows.

**Nodes dial out.** A node joins with a token, gets an identity of its
own, and holds one connection to the control side. The control side never
needs a node's address, so a node behind NAT, an autoscaled server and the
VM on a Mac all join the same way.

**The engine is containerd.** It is the integration gVisor documents and
the one yaac's pods go through today. Pamir passes through what the
generic sandbox needs: the runtime handler, annotations, mounts with
propagation, cgroup limits, exec, and exit and OOM events. Whether it
calls containerd's CRI service or its client API is spike 1.

**Storage is host paths.** Pamir mounts directories of the node. A shared
filesystem is the operator's, mounted at the same path on every node. A
disk that must be attached to the node first is a provider call (below),
not a storage system.

**Growing and shrinking is a provider interface**: create a node from a
template, delete a node, attach a disk. Pamir asks for a node when a unit
fits nowhere, and removes one only when it holds no unit marked as not to
be disturbed. Hetzner is the first provider.

**It is usable from TypeScript.** yaac's server is not a Go program. The
control side serves an HTTP API with a watch stream, and the Go library is
for embedding Pamir in a Go program and for a Go client.

**It can be tested without machines**: an in-memory fake for unit tests,
and several nodes on one machine for the e2e tier, as `--nodes N` gives
today.

**One path for one machine and for many.** The driver always talks to
Pamir, which on one machine is a control side and a node in one process. A
single-machine install then exercises the code a fleet does, which is what
kind gives today. It means Pamir's first milestone is one node, and comes
before the driver.

## Three ways to build it

### A. A small Kubernetes

The control side keeps desired state in a store of its own. A client
writes objects (a unit, a set of units for every node) and watches them.
A scheduler assigns each unit a node. The node side watches the units
assigned to it and converges on them, as a kubelet does.

- **For.** It is the model every client already knows. yaac's driver would
  port almost mechanically, since it already applies objects and watches
  them (docs/event-driven-reconcile.md). Convergence carries on while the
  client is down. It is the most useful shape for a user who is not yaac.
- **Against.** It is the apiserver, the scheduler and the kubelet again,
  in miniature: versioned objects, watch semantics that must never miss an
  event, a store to back up and migrate. It keeps two records of intent,
  yaac's database and Pamir's store, and the sweeps that reconcile them.
  It is the largest of the three by a wide margin.

### B. A fleet of engines

The control side holds no desired state. Each node is the record of what
runs on it: the unit's spec is kept on the node, beside the container that
carries its id. The control side knows the nodes, holds their connections
and adds up what they report. Its API is direct:

- list nodes, with capacity and labels;
- start a unit on a node, under an id the caller chooses, so a repeated
  call is answered as the first was;
- stop, exec into, and read the events of a unit;
- open a stream to a unit's socket, and receive the connections a unit
  makes;
- watch everything, as one stream assembled from the nodes.

Placement is a function, not a service: given a request, pick the node
with room that matches its labels. A caller may use it or name a node
itself. "Run this on every node" is a list the control side hands each
node when it joins.

- **For.** It is the smallest, and it matches how yaac already works: the
  database is the record of intent, the reconcile loop converges, and
  nothing is rescheduled. A control side with no store restarts by letting
  the nodes reconnect. There is one record of intent, not two. Fly.io
  replaced Nomad with an orchestrator of this shape, in which each worker
  is "solely responsible for its own state" and there is no global
  scheduler.
- **Against.** Every client has to bring its own record of intent and its
  own reconcile loop, which yaac has and another user may not. Nothing
  converges while the client is down, so a unit that dies is restarted
  only when its owner is back. Two callers placing at once can both pick
  the last free node, and one is refused and tries again.

### C. Peers, with no control side

Every node runs the same program, and they find each other by gossip. A
client embeds the library or talks to any node. There is no machine that
must be up.

- **For.** Nothing is a single point, and a fleet has no special machine
  to set up first.
- **Against.** Membership by gossip, and placement with no one place that
  knows the fleet, are the hardest parts of an orchestrator to get right,
  and yaac gains nothing from them: its server, database, proxy and shared
  filesystem already live on one machine. A connection between a unit and
  that machine would still have to be carried there.

## Decision

B, to start. It is the one whose shape yaac already has, and the only one
small enough to be finished before it is needed.

Two things are taken from A, and only these:

- **The node keeps each unit's spec on disk**, so a node that restarts
  brings its units back without being told, and the fleet's state can be
  rebuilt from the nodes alone.
- **The set that runs on every node is declared once** to the control
  side, which is the only desired state it holds.

A store of units, a scheduler that owns placement, and controllers that
act while the client is away wait until a second user needs them. B grows
into A by adding them. A does not shrink into B.

## Milestones

1. **One node.** The control side and a node in one process on one
   machine. Start, stop, exec and watch a unit under a caller's id, with
   its spec kept on disk. Carry a unit's sockets to and from programs on
   the same machine. The every-node set. The HTTP API, a Go client, and an
   in-memory fake. This is what the `pamir` driver needs for a
   single-machine install.
2. **Several nodes.** Joining by token, the node's one connection, sockets
   carried between machines, the placement function over capacity and
   labels, the rule for a node that comes back, and namespaces. Several
   nodes on one machine for tests.
3. **Providers.** Creating and deleting nodes and attaching disks, with
   Hetzner first, and the rule for when a node may be removed.

## Two choices that cut across all three

**How bytes cross machines.** Either every connection rides the one
connection a node holds to the control side, or nodes and the control side
dial each other directly over a private network, with identities Pamir
issues. The first needs one open port on one machine and works through
NAT. Its cost is that all traffic passes through the control node, which
for yaac it does already: the proxy, the server and the site router are
all there. The second scales further and needs every machine to be
reachable. Start with the first.

**Where yaac's own node programs live.** netd's relay becomes Pamir's
socket carrying, so it leaves yaac. What stays yaac's on every node is the
mountd, the arborist, the swap bound and the pressure kill.
They can run as units Pamir starts on every node, as DaemonSets do today,
or be compiled into yaac's own build of the node program through the
library. Units keep Pamir and yaac releasing separately, and are how
another user would add their own. Start with units.

## What Pamir does not settle

- **Images.** A node pulls from a registry the operator names, and Pamir
  can run that registry as a unit on the control node. Whether to carry
  images between nodes itself is left for later.
- **Tenants.** A namespace on every unit and node set, with a token per
  namespace, covers several installs and test runs on one fleet. Anything
  finer is not planned.
- **Upgrading the node program** without stopping its units, and how far
  apart the two sides' versions may be.
- **The memory rules.** Bounding each unit's swap and killing the unit
  furthest over its request under pressure are yaac's today
  (docs/cluster-setup.md "Memory pressure"). They are general enough to
  move into Pamir once they have run there as units.

## Spikes

1. **The node side alone.** One program on one machine starts yaac's
   generic sandbox on containerd from a spec, with no kubelet, once
   through containerd's CRI service and once through its own client API:
   - the runsc flags reach it, and the `dev.gvisor.spec.mount.*`
     annotations apply;
   - a mount made on the host under a bound directory appears inside;
   - a second container joins the first's sandbox, which the CRI service
     does for a pod, or runs as a sandbox of its own over the same
     directories;
   - runsc's state directory can be found, and the sandbox entered from
     the host;
   - cgroup limits hold, and exits and OOM kills are reported;
   - no CNI plugin is needed for a sandbox with no interface.

   Then keep the spec on disk, restart the program and the machine, and
   find the sandbox still running or brought back.
2. **Carrying a socket.** A unit's socket on one machine reached from a
   program on another over the node's one connection, in both directions,
   with the unit's id attached. Measure it against netd's relay with the
   socket plan's spike 3.
3. **Rejoining.** Cut a node off, start its unit's id elsewhere, reconnect
   it, and confirm the first copy is stopped before anything of it is
   reachable again.
4. **Several nodes on one machine**, each with a containerd of its own,
   for the e2e tier.

## What it changes elsewhere

- The `pamir` driver is built on milestone 1, and its stage 7 on
  milestones 2 and 3 (docs/plans/off-kubernetes.md).
- `infra/hetzner-k3s` becomes a stack that installs containerd and Pamir's
  node program, with its autoscaler replaced by Pamir's Hetzner provider.
- Under the `pamir` driver the proxy and the server reach a sandbox
  through Pamir, where under `k8s` they go through netd.

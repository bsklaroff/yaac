# Pamir on several machines

A proposal, not built or tried, and a follow-up to docs/plans/pamir.md,
which it builds on. It adds nodes to Pamir behind the same API, so the
`pamir` driver gains machines without changing how it starts, watches or
reaches a pod.

## What it adds

| Job | Today |
|---|---|
| Machines join and leave, and their capacity is known | kubelet registration, the Node object |
| A machine is chosen for a sandbox | the scheduler: memory request, the workspace pool's taint, a release's node pin |
| The server and the proxy reach a sandbox on another machine | the pod network, then netd's relay |
| A machine has the image a sandbox needs | the in-cluster registry and containerd's pull |
| Machines are added when a sandbox does not fit and removed when empty | cluster-autoscaler with its Hetzner provider |
| A disk follows the sandbox that mounts it | CSI, for a volume's claim |

## The control side

**One control node, and no consensus.** yaac already has one server, one
database and one proxy on one machine. Pamir's control side sits there,
in the node program that also runs that machine's pods, and may be a
single point too, as long as losing it stops no pod and it can rebuild
what it knows from the nodes, which keep their pods' specs.

**The same programs, two roles.** Every machine runs the same node
program and relay (docs/plans/pamir.md "Two programs"), and its config
says which roles the node program takes, as `k3s server` and `k3s agent`
or Nomad's server and client do. The control node takes both: it runs its
own pods, among them the declared pods scoped to it (yaac's server, proxy,
router and tunnels), and the control side, and it alone serves the
registry. A worker takes only the node role: it dials the control node with
its join token and identity, and runs its relay, its floor and the pods
placed on it. The control side reaches its own node through the
in-process link docs/plans/pamir.md describes and a worker through that
worker's connection, behind one interface, so the control node's pods are
pods on a node like any other.

The API and its sockets stay on the control node, and so does the control
side's private key.
Workers hold no control credentials and get no API socket, so a worker,
compromised or not, can start, stop or list nothing.

## Nodes

**Nodes dial out.** A node joins once with a join token and gets an
identity of its own. Its node program then holds one connection to the
control side, and its relay one link to the control node's relay
("Connections between machines"). The control node
never needs a node's address, so a node behind NAT, an autoscaled server
and the VM on a Mac all join the same way.

**Identities are pinned keys, with no certificate authority.** Every
connection runs to the control side, the only party that checks a node's
identity, so a list of keys does what a CA would without its root secret,
its expiry dates or its dependence on clocks:

| Credential | What it is | Who holds it | What it grants |
|---|---|---|---|
| Join material | the control side's address, a join token (a random secret good for one join), and the fingerprint of the control side's public key | the first-boot user data of the one machine the token was made for | becoming that worker node, nothing else |
| A node's key | a key pair made on the node, whose private key never leaves it | each node, in a root-only file its node program and its relay both read | holding that node's connections, its node program's and its relay's, and speaking for the pods placed on it |
| The control side's key | one key pair for the control side | the control node, root only | being the control side to every node |
| The node list | each node's name and public key | the control side | the one record of which nodes may connect |
| The cloud's token | what the cloud's API takes to create and delete servers and disks | the provider, a program of its own ("Providers"), and nothing else | growing, shrinking and fencing the fleet |

At join the node checks the control side's key against the fingerprint,
so no impostor can enroll it, and sends the token and its own public key,
which the control side adds to the node list. Every connection after that
is mutual TLS between raw public keys (RFC 7250), with no certificate on
either side: the control node accepts only a key in its list, and a node
only the key it pinned. That is TLS's own mode for peers that already
hold each other's keys, so none of its verification is turned off, and
the handshake's proof that each side holds its key stays the library's.
It covers both connections a node holds, its node program's and its
relay's.

- **Removing a node** removes its key from the list, and its next
  connection is refused.
- **A node re-keys periodically** over its authenticated connection,
  which bounds how long a stolen key works, as expiry would.
- **The control side rotates its key** by announcing the next one to
  every node over its connection before switching to it.

Join tokens and nodes are made, rotated and removed through the admin
socket. Tailscale works the same way: its devices and its coordination
server identify by keys the coordinator distributes, and a CA appears only
in the HTTPS fetch of the coordinator's own key, the part the fingerprint
plays here. A CA would earn its place only with parties that must check
identities without asking the control side: many nodes connecting
directly, or clients outside Pamir. Adding one then is additive, since
nodes keep their keys and the CA starts signing them.

**A join token is one machine's, and not enough on its own.** A provider
has a token made for each node it creates, bound to that server's id and
spent at its join, so a node template holds none and a token read later
joins nothing. An operator has one made the same way for a machine joined
by hand. An autoscaled worker's token still sits in its first-boot user
data until then, which a cloud's metadata service serves. So a provider
also checks at join that the machine is the one it created, by matching
its server id and address through the cloud's API. A stolen token then
adds no rogue worker. Sandboxes have no interface to read
metadata with, and the floor drops it for `egress` pods.

**A node speaks only for its own pods.** Every connection a node holds is
authenticated by its key, and the control side knows where each
pod runs because it placed it. A carried connection stamped with a pod id
is delivered only if that pod is placed on the node it came from, which
the control node's relay checks against the placements in its files; a status
report or an exec is accepted only for that node's own pods. A compromised
node can lie about its own pods and no one else's. Workers connect only to
the control node, so none reaches another directly.

**A pod id runs in at most one place.** A node whose node program has
been away longer than a restart takes is reported as unknown, never
rescheduled from. Its pods may be running still, with the shared tier
mounted, so their ids stay held: a start of one of them elsewhere is
refused, naming the node, until that node is one of two things.

- **Fenced.** The provider has powered it off. A start that meets a held
  id asks for this itself where Pamir's config lets it for that node, the
  operator's choice, since powering a machine off stops every namespace's
  pods on it. It is how a disk is moved off such a node ("Storage and
  images").
- **Declared dead**, by the operator through the admin socket, for a
  machine no provider can power off. It is the operator's word that
  nothing runs there.

Either way the node's pods are reported as died with it and their ids are
free. A node that comes back after that stops any pod the control side
has since started elsewhere, before it does anything else. Its relay may
reconnect before its node program does, and carries nothing of such a pod
meanwhile: the control node's relay holds the placement that moved, and
refuses what the old one sends.

## Connections between machines

Every carried connection between machines is a connection of its own
between the two machines' relays, encrypted in the kernel, so each end
splices it as it would a local one and one flow's bulk holds up no other.
The worker's relay dials every one, since nothing dials a worker. It also
keeps one small link to the control node's relay, over which that relay
asks it to dial in for a flow that starts at the control node's end, the
server opening a workspace's stream say.

The node programs' connection carries control messages only, as the pipe
does on one machine. So a restart of either node program stops no flow
between machines and no new one, as it stops none on one.

It takes two open ports on one machine, the node programs' and the
relays', and works through NAT, and all traffic passing through the
control node costs yaac little, since its proxy, server and site router
are there already.

Each node renders its own floor from Pamir's config and its own
settings. The floor gains the nodes' addresses, which a pod reaches past
the host's own `input` rule: a set every node's addresses fill, its own
node's and public ones included, rewritten as nodes join and leave, and
one rule in the floor's `forward`:

```
  set nodeaddrs { type ipv4_addr; }        # every node's addresses
  ...
    ip daddr @nodeaddrs drop
```

The set holds the node's own addresses too, so on several machines the
host's `input` rule is a second layer for them, not the only one.

## Placement

A function, not a service: given a request, pick the node with room that
matches its labels. A caller may use it or name a node itself. Two callers
placing at once can both pick the last free node; one is refused and tries
again. A declared pod is scoped to every node (yaac's mountd and memory
pod), handed to each node as it joins, or to the control node alone
(yaac's server, proxy, router and tunnels).

## Providers

Growing and shrinking is a provider's work: create a node from a
template, delete a node, power one off, and create, grow, attach and
detach a disk. Pamir asks for a node when a pod fits nowhere, and removes
one only when it holds no pod marked as not to be disturbed. Hetzner is
the first provider.

**A provider is a program of its own**, on the control node, under a user
of its own, as Kubernetes' autoscaler, cloud controller and disk drivers
are programs apart from its nodes. It holds the cloud's token, which can
create and delete servers, so that the token is not in the node program,
which is root and reads what builds send its registry. A fleet joined by
hand runs none, and a single machine is as it was.

The provider dials a socket the node program serves for it,
`/run/pamir/provider.sock`, not the admin socket, which is root on the
machine. Over it:

- **The node program asks**, and the provider answers: a node of this
  shape; this node deleted; this node powered off; this disk created,
  grown, attached to that node or detached; and whether a server joining
  with this id and address is one the provider created.
- **The provider asks for one thing**: a join token for the server it is
  about to create, bound to that server's id ("A join token is one
  machine's").

Every decision stays the node program's: that a pod fits nowhere, that a
node is empty, where a disk may attach, that a node is to be fenced. The
provider carries them out and decides none. While it is down nothing
grows, is fenced or has a disk moved, and what waits on those waits: a
start that needs a node, or a held id's node fenced, is answered as still
waiting, not as failed.

## Storage and images

Pamir still mounts only host paths. What is new is where they come from:

- **A shared filesystem is the operator's**, mounted once on every node at
  the same path, which Pamir passes into pods. yaac's global tier is one:
  on Hetzner the control node's NFS export, mounted by each worker's
  first-boot setup with today's options (NFSv4.2, `hard`, `actimeo=1`,
  delegations off) and with `nosuid` and `nodev`, which Pamir requires of
  every mount a namespace's pods reach (docs/plans/pamir.md "A
  namespace's pods are held to its limits"), in place of a volume driver
  mounting it per pod.
- **What lives on one machine stays a local path.** yaac's server-local
  tier is the control node's disk, or a cloud volume its infrastructure
  attaches and mounts at a fixed path, since the server never moves. A
  node-local tier is each node's own disk.
- **A disk that must follow a pod** is declared in the pod's spec, a disk
  and the path it appears at. Pamir places the pod only on a node the disk
  can attach to (a Hetzner volume attaches only within its location),
  has the provider attach it there, makes its filesystem on first use,
  mounts it, and passes the path in; at stop it unmounts and detaches it.
  The provider also creates, grows and deletes disks. yaac's project
  volumes are these, and yaac keeps which disk is whose in its database.
- **A disk is never attached to two nodes.** A node that goes unknown
  while holding one may still be writing to it, so Pamir has the provider
  power that node off before detaching the disk and attaching it
  elsewhere, and a node that comes back finds the disk gone with its pods.
  It takes about as long as Kubernetes takes to release such a disk from
  a node that stopped answering.

The NFS server trusts whatever uid a client claims, but sandboxes have no
interface to reach it with, `egress` pods' floor drops every node's
address, and a sandbox sees only the paths mountd binds in.

Images live in each node's containerd store, so a pod's image must be on
the node it is placed on. The control node's registry, served from its
containerd store (docs/plans/pamir.md "Images"), is what workers pull
from: each reaches it at a loopback port Pamir publishes on the worker
(`127.0.0.1:5000`), which the relays carry to the registry's socket as
they carry any flow. The worker's containerd pulls from localhost, so the
registry has no port on any network and the worker holds no token: the
node's identity authenticates the pull. It is not a pull of anything,
though. The control node's relay stamps each such connection with the
node it came from, and the registry serves that node only the manifests
and blobs of images that pods placed on it name, so a node pulls for its
own pods as it speaks for them. A pod is placed before its image is
pulled, so the first pull finds the placement there.

**The control node's store is the namespace's images; a worker's is a cache
Pamir keeps.** Install builds yaac's images there and builds push project
images there, so the image API addresses that store on several machines as
on one: listing, checking, pulling from an outside registry and removing
all act on it. A worker's store is never the caller's to manage. Before
starting a pod on a worker, Pamir has that worker pull the pod's image by
digest when it lacks it, a `system` pod's included, and it prunes each
worker's store of images no pod there uses that are gone from the control
node's store or long unused. A caller's view of its images is then the same
on one machine and on many, as today the main registry is the record and
each node's containerd a cache the image GC prunes.

## Performance

A flow between machines is spliced at both ends, as on one machine, if
kernel TLS allows it, which spike 1 finds out. A flow between two workers
crosses the control node's relay. Two choices stay open beyond that:

- **A pod's broker may run on its own node**, so its egress leaves there
  rather than through the control node.
- **Workers may dial each other for a flow.** The control side then hands
  each node the keys of the peers it may accept with the placements it
  already sends, as Tailscale's network map does, and each receiving relay
  makes the same placement check the control node's does.

## Testing

Several nodes on one machine for the e2e tier, as `--nodes N` gives today:
each the single-machine tier's privileged container (docs/plans/pamir.md
"Testing"), with its own network and mount namespaces and containerd, and
all of them on a test bridge, so each has an address of its own. It adds
to the single-machine tier exactly what this plan adds: the transport,
joining, the nodes' floor set, the placement check, and a node's
connection dropping and coming back, by pausing or disconnecting its
container. Machine-wide kernel settings and the kernel itself stay shared,
so no test may depend on nodes differing there.

## Milestones

1. **Several nodes.** Joining, node identities, the node programs'
   connection and the relays' link, a connection per flow carried between
   machines with the placement check, the
   placement function over capacity and labels, the rule for a node that
   comes back, and several nodes on one machine for tests.
2. **Providers.** The provider's program and its socket; creating and
   deleting nodes, and creating, growing, attaching and detaching disks,
   with Hetzner first; disks declared in a
   pod's spec, with placement by where they attach and fencing by power-off;
   the provider's check at join; and the rule for when a node may be
   removed.

## Spikes

1. **Carrying a socket between machines.** A pod's socket on one machine
   reached from a program on another over a connection of its own between
   the relays, in both directions, the one that starts at the control node
   dialed in by the worker when asked over the relays' link, with the
   pod's id attached, and a connection stamped with a pod placed elsewhere
   refused. Encrypt it with kernel TLS and splice it at both ends, and
   measure it against the same flow copied through user space. Stop the
   node program at each end while a flow runs and while a new one opens.
2. **Rejoining.** Cut a node off and start its pod's id elsewhere: the
   start is refused while the node is only unknown, and goes through once
   the node is fenced. Then declare a cut-off node dead without powering
   it off, start its pod's id elsewhere, reconnect it, and confirm the
   first copy is stopped before anything of it is reachable again.
3. **Moving a disk.** A pod holding a disk on a node that goes unknown: the
   node powered off through the provider, the disk detached and attached
   to another node, its filesystem intact, and the first node coming back
   without it. Time it against Kubernetes releasing a disk from a node
   that stopped answering.

## Not planned, for now

- **Carrying images between nodes** rather than pulling from a registry.
- **How far apart the control side's and a node's versions may be.**
- **How long a start waits for a provider that is down.** It is answered
  as still waiting ("Providers"), with no limit set.

## What it changes elsewhere

- The `pamir` driver's stage 7 is built on these milestones
  (docs/plans/off-kubernetes.md).
- `infra/hetzner-k3s` becomes a stack that installs containerd and Pamir's
  node program, with its autoscaler replaced by Pamir's Hetzner provider.

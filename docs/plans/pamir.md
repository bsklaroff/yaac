# Pamir: a small orchestrator for sandboxes

A proposal, not built or tried. Pamir is two Rust programs on a node
(the node program and the relay) and the shim it puts in pods, which do
for yaac what Kubernetes does today: they start
sandboxes, watch them, and carry connections to and from them. It is
what the `pamir` driver of docs/plans/off-kubernetes.md talks to. It lives
in a repository of its own and knows nothing of yaac, so it can be
deployed without it and for other things.

This plan is Pamir on one machine, where its control side and its node
side run in one process, the node program. Several machines are a follow-up,
docs/plans/pamir-multi-node.md, which adds nodes behind the same API.

**One path for one machine and for many.** The control side (the API,
namespaces, Pamir's config) reaches the node side (pods, the relay, the
floor) only through the protocol a remote node's connection will carry:
the node side serves it and the control side is its client, joined here by
an in-memory pipe instead of a network connection. Requests
are encoded, streams multiplexed and cancelled, and errors returned as
they will be between machines, so a single-machine install exercises the
code a fleet does, as kind does for Kubernetes today, and the follow-up
adds a transport and the joining machinery rather than a second way to run
pods. The protocol carries control messages only, on one machine and on
several. No carried connection rides it and none waits on it: the relay
decides each from the files the node program writes for it ("Two
programs"), and joins the two ends itself.

## What it replaces

On one machine, Kubernetes does these things for yaac and nothing else:

| Job | Today |
|---|---|
| A sandbox is started, watched and stopped | Job, pod, kubelet, informers |
| Some programs run beside the sandboxes | DaemonSets: netd, mountd, the gVisor installer |
| The server and the proxy reach a sandbox | the pod network, then netd's relay |
| A sandbox's image is on the machine | the in-cluster registry and containerd's pull |
| Several installs and test runs share one cluster without meeting | namespaces |

Pamir has no overlay network, Services, cluster DNS, NetworkPolicy,
replicas, rescheduling, RBAC or custom resources, and holds desired state
only for the few pods an operator declares (below).

## Two programs

On a node Pamir is two programs, each a system service of its own, so
that the node program's fault or restart is not the connections':

| Program | Does | Runs as | Hears from |
|---|---|---|---|
| The node program | the API, Pamir's config, pods through containerd, the floor, the image store and its registry | root | the callers of its API sockets, and builds no one trusts, through the registry |
| The relay | carries every connection: pods' sockets, imports, brokers, published ports, the namespaces' streams sockets, `egress` pods' DNS | root, with the few capabilities that binding and joining sockets take, and nothing of containerd's or the admin socket's | the header of each connection, from pods no one trusts |

**The node program is the only writer.** What may connect to what is
decided there and nowhere else: pods and their sockets, caller lists,
imports, brokers, published ports. It writes the outcome as files under
`/run/pamir/relay`, one for each pod and one for the published ports, as
containerd leaves each container's spec on disk for its shim. A pod's
file holds what the relay needs and no more: the pod's id and namespace,
its socket directory, its broker, its imports, and its declared sockets
with who may open each. It is not the pod's spec, which may hold the
pod's environment. Each file carries the version of its format and is
replaced whole, written under another name and renamed, so the relay
never reads half of one.

**The relay reads those files and decides every connection from them. It
never asks.** It watches the directory, and reads all of it when it
starts and every few seconds besides, since a watch can miss a change. So
no carried connection passes through the node program and none waits for
it: while the node program is down or being replaced, connections stay
up, new ones are carried and DNS answers. The files cannot be wrong for
being old, since nothing changes who may open what while the only writer
is down. Nothing has to be sent, resent or reconnected, and either
program finds the directory as it left it.

- **A pod's containers start only once the relay has bound the pod's
  socket**, which is its answer that it has taken the pod's file, so a
  pod's first connection finds it. A file the relay cannot apply it names
  in a status file of its own beside the directory, which the node
  program reads when a socket has not appeared in time.
- **A pod's file goes when the pod does**, and the relay then closes
  what it carried for the pod and removes its sockets.
- **The relay is root** because it binds in the socket root and joins the
  floor's namespace for its resolver socket. It holds nothing of
  containerd's or the admin socket's.

**What a restart costs:**

| Restarted | Stops meanwhile | Carries on | Comes back by |
|---|---|---|---|
| The node program | API calls, which a client retries; watches, which resume; pod starts and stops; an exec in flight; pushes and pulls in flight, which a build retries; reloading the host's table | pods; every carried connection, and new ones; DNS; the floor | reading its pods' specs and containerd, then writing the relay's files again, which changes none that was right |
| The relay | every connection it carries, which reconnect; published ports and DNS, for the moment | pods; the API; the floor | reading the directory |

The two are replaced apart, the files' format version being all they
share. Replacing the node program is a restart of it alone, which stops
no pod and no connection.

## Pods

**It is generic.** Pamir runs pods. A pod is what it is in Kubernetes and
podman: one or more containers that share a network namespace and are
started, watched and stopped together. It keeps none of the Kubernetes pod
network: a pod has no address another can dial. Pamir has no notion of a
workspace, a project, a spare, an allowlist or gVisor. A runtime handler is
a name it passes to containerd, and an annotation is a string it copies
when the pod's namespace allows it. The test of this is a second user: a
pool of machines running CI jobs in sandboxes should need nothing from
yaac.

**The node is the record.** Each pod's spec is kept on disk beside the
containers that carry its id. A node program that restarts finds its pods
still running and takes them up again without being told. A machine that
reboots has stopped every pod: the node program then starts the declared
ones again, and reports each namespace pod as died with the machine,
which is its caller's to start again or not.

**A pod keeps running when everything else is down.** Restarting or
upgrading the program that uses Pamir must not stop a pod, and neither
must restarting the node program.

**Pods are of two kinds**, told apart by who starts them:

| | Declared pods | Namespace pods |
|---|---|---|
| Started by | Pamir's config, written through the admin socket | a namespace's management socket |
| For yaac | mountd and the memory pod; the server, proxy, site router and tunnels | workspaces, spares, site releases, builders |
| May use | any runtime, any host path, privilege, the host's process namespace (mountd), `egress` | only what their namespace's limits allow (below) |
| Lifecycle | kept running, restarted in place when they exit, replaced when their declaration changes | started and stopped by their caller, and reported, never restarted, when they die |
| Through a management socket | watched, its logs read, and restarted as declared: no stop, exec or streams | everything the socket grants |

Namespace pods are where Pamir holds no desired state: their caller,
yaac's database for yaac, is the record of intent, and its reconcile loop
converges. A namespace pod's id is the caller's, so a repeated start is
answered as the first was, and nothing moves by itself.

**Every pod belongs to a namespace, declared pods included.** A
declaration names its namespace, so a declared pod's images are in that
namespace's containerd store, its management socket can watch it, and
caller lists can admit that namespace's pods to its sockets; what sets it
apart is that its declaration may grant more than the namespace's limits
and that the management socket can only watch it, read its logs and
restart it as it is declared, never stop it, exec into it or stream to
it. A
service for the whole machine rather than one install is declared in the
reserved `system` namespace, which has no management socket and is
changed only through the admin socket, so two installs on one machine
share it rather than each running their own. yaac's memory pod, which
bounds swap and kills the workspace furthest over its request across the
machine, is one; mountd, the server, the proxy, the router and the
tunnels are declared in yaac's own namespace.

`system`'s pods are the machine's, not any install's, and no owner is
recorded. Declaring one whose name is taken follows fixed rules:

- a declaration identical to the one there changes nothing;
- a different one is refused, with both specs in the error, unless the
  request says to replace it, which an install asks only when its
  operator passes a flag for it, never on its own;
- uninstalling an install removes none of them; one goes only by an
  explicit removal through the admin socket.

A `system` pod therefore serves installs of different versions, and keeps
what it relies on (the labels it reads, how it finds the pods it watches)
stable across them.

`system`'s images are in its own containerd store. Nothing builds or
pushes into it, so it has no registry socket: an install builds a
`system` pod's image straight into that store, and the admin socket
offers the image API for `system` (list, check, pull by digest, remove).
Layers it shares with another namespace's images are stored once.

Declared pods are the operator's, as Kubernetes' static pods and DaemonSets
are, and Pamir keeps them as desired state with two rules and no more. One
restart rule, always and in place, as systemd's, after a wait that doubles
from a second to a minute while the pod keeps failing and goes back to a
second once it has run for ten minutes, each restart an event on the watch;
and a changed declaration replaces the pod, stopped then started, with the
gap accepted. There are no rollouts, replicas, rollbacks, liveness probes,
start ordering or dependencies between them: a pod that needs another
retries until it is there, as a program under systemd does. Needing any of
those is the sign of growing into Kubernetes, and is refused.

**A declared pod takes what changes as data, never through its spec.**
Changing a spec takes the admin socket, so what a user turns on at run
time reaches a declared pod as files in a directory it mounts, or over a
socket it reads, from the caller that knows it. yaac's site router reads
its route table from a file the server writes, and a tunnel is declared
from the start and idles until the server writes its credentials. No user
action then needs root.

## The API

An HTTP API with a watch stream, served on unix sockets (below), so it is
usable from TypeScript or any other language. On a namespace's management
socket:

- start a namespace pod under the caller's id;
- stop, exec into, and read the events and the logs of a namespace pod;
- read the logs of a declared pod of the namespace, and restart it;
- watch everything in the namespace, declared pods included, as one
  stream.

Streams are not on it. A namespace has a streams socket beside it, which
the relay serves, so that a stream outlives a restart of the node
program. On it a caller opens a stream to a namespace pod's socket, with
a header that names the pod and the socket, and receives the connections
a pod makes.

It is REST with JSON, as Kubernetes', Docker's, podman's and Incus's APIs
are, rather than gRPC as containerd's, since its main caller is
TypeScript. It borrows three conventions:

- **Watching as Kubernetes does.** A watch is a long-lived response of
  one JSON event per line, each carrying a version, and a client that
  reconnects resumes from the last version it saw rather than missing
  events, with a full listing to resynchronize from when the version it
  holds is too old. Versions are kept on disk with the pods' specs, so a
  watch cut by the node program's restart resumes the same way, and a
  client holding a version the restarted program never wrote is told to
  list again. That is the list-then-watch a Kubernetes client does,
  and the "watch stream, plus a listing on resync" the `pamir` driver
  expects.
- **Exec as Docker does.** An exec is made, then started, and the start
  takes over its request's connection with an HTTP `Upgrade`. With a
  terminal the stream is raw both ways. Without one, what comes back is
  framed, each frame saying whether it is the command's output or its
  errors, as Docker frames it. Two more calls name the exec by its id:
  one answers whether it has ended and with what exit status, the other
  resizes its terminal. An exec runs through containerd and so through
  the node program, and ends when that restarts.
- **A published schema.** The API is described in OpenAPI 3.1, whose
  types are standard JSON Schema, so a client can be generated from it,
  and the in-memory fake yaac's unit tests use is checked against the same
  description the node program serves. It is generated from the node
  program's own code (`utoipa`), so it cannot drift from what is served.
  OpenAPI describes requests, responses and the watch event's type, but
  not a stream's behavior, so that is prose in the description, as
  Kubernetes writes it: how a watch resumes from a version, and how an
  exec's upgraded stream is framed. AsyncAPI could describe the
  watch formally, which one endpoint does not justify.

**An exec may bring its own program.** In place of a path in the
container, the request may name a file beneath one of the namespace's
prefixes. Pamir opens it by descriptor and has the runtime run that
descriptor (runsc's `--exec-fd`), with the process's arguments,
environment and capabilities given whole in the request. So a caller runs
a static helper of its own in a container whose image it does not trust,
with nothing of the image's on the way: not its files, its libraries or
its environment. And no program outside Pamir has to enter a sandbox, or
know where a runtime keeps one.

**Pamir keeps what each container prints.** With no CRI between them,
giving a container its output is Pamir's to do: it writes each
container's output and errors to a file of its own, capped at a size
Pamir's config sets (10 MB unless it says otherwise), the oldest lines
going first, so a pod no one trusts fills no disk by printing. The logs
call reads a container's file and may follow it. A pod's files go when
the pod is removed, not when it dies, so a caller reads why.

**Namespaces separate the users of one machine**, such as an install and
the test runs beside it, as Kubernetes namespaces do. Every pod belongs to
one namespace, and a pod's id is unique within it. Each Pamir namespace is
a containerd namespace of its own, so installs keep separate image and
snapshot records too.

**Access is a socket, not a token.** Every caller sits on the machine, so
identity is which socket a caller connected to. One admin socket serves
the machine, and each namespace has three:

| Socket | Who reaches it | What it grants |
|---|---|---|
| `/run/pamir/admin.sock`, root only | root, through `sudo pamir …` | namespaces and their limits, declared pods, published ports, the floor's openings |
| `/run/pamir/ns/<name>/api.sock`, the namespace's management socket | a program on the host that its file permissions admit (a test rig's user for a test run); a pod its config names, through an import (yaac's server) | that namespace's pods within its limits, and its images, and nothing else |
| `/run/pamir/ns/<name>/streams.sock`, the namespace's streams socket, which the relay serves | as the management socket: a host program its permissions admit, a pod its config names (yaac's server) | a stream to any socket of that namespace's namespace pods, stamped as the namespace's manager |
| `/run/pamir/ns/<name>/registry.sock`, the namespace's registry | a pod its config names, through an import or a broker (yaac's proxy, carrying builds); a program on the host, through a published port | what a signed token's scopes allow (below) |

The namespace is implied by which socket a request arrives on, so a
token is checked against that namespace's key, its repositories are that
namespace's containerd namespace's, and nothing aimed at one namespace
reaches another.

None of these sockets' files is mounted into a pod. A pod reaches one only
through an import, a socket file in its own pod that the shim serves
("Inside a pod, a socket is a file"), which the relay carries and checks
against that socket's caller list, as it does for every socket a pod
declares; a program on the host opens the file itself, as its permissions
allow. yaac's server thus reaches its management API at a path in its own
pod, like everything else it reaches, and a pod no config names reaches
none of them.

A namespace's sockets on the host are owned by root and a group the
namespace's config names, mode `0660`, as Docker's socket is owned by its
`docker` group, so a test rig's user is admitted by joining that group and
needs no root. Every connection to a host socket is logged with the
connecting process's user id, which the kernel reports (`SO_PEERCRED`),
so the log says who did what even where a group admits several users.
This is the model local daemons share (Docker, containerd, podman, Incus):
opening the socket is the credential.

**Pamir's config** holds what an operator sets: declared pods, namespaces,
the floor's openings, each with the pods it is for, and published ports.
The control side keeps it, the admin socket alone changes it, and it
applies to every node. Each namespace has a section of it: its limits, its
sockets' group and caller lists, and its registry's public key. A few
settings are a node's own, chosen by install on that machine because they
depend on it: its pods' address range.

**A namespace's pods are held to its limits**, set in its section of
Pamir's config:

- the runtimes they may use (for yaac, `gvisor-nonet` alone);
- the host paths they may mount, only beneath the prefixes named (for
  yaac, its data dir's tiers);
- no privilege, and capabilities from a short list (for yaac, a builder's
  engine capabilities and its bind helper's, inside gVisor), which an
  exec's process is held to as a container's is. The shim Pamir injects is
  Pamir's own container, not the caller's, so its `NET_ADMIN` is outside
  the limits;
- the network modes they may use (for yaac, `none` alone; a namespace
  whose pods need the internet directly, a CI pool's say, may be allowed
  `egress` too, behind the same floor);
- the annotations they may carry, by prefix, and none unless the
  namespace lists it (for yaac, `dev.gvisor.spec.mount.`, which shapes
  its scratch and tmux mounts). A runtime reads some annotations as
  instructions, gVisor's own settings for one sandbox among them, and
  containerd's CRI service, which filters them by such a list under
  Kubernetes, is not in Pamir's path. A pod carrying any other is
  refused, not started without it. The annotations Pamir writes itself,
  those that put a pod's containers in one sandbox above all, are taken
  from no spec, a declared pod's included, and no list can admit them.

So the management socket is not root on the machine. One taken can do
whatever its namespace's limits allow, which for yaac is to read and
change everything in the data dir, a compromised install, but not run
anything outside gVisor, mount anything outside the data dir, give a pod
a way out other than the brokers it is admitted to (since yaac's
namespace has no `egress`, the only one is the proxy), do more to a
declared pod than read what it logged and restart it as it is declared,
or change anything the admin socket guards. Root is left to
the admin socket, install that writes through it, and the declared pods.
For that to hold:

- **A host path is resolved beneath its prefix by descriptor, and the
  descriptor is what gets mounted.** Pamir opens the path with `openat2`
  and `RESOLVE_BENEATH`, so no link planted under the prefix reaches past
  it. A runtime mounts from a path in the container's spec, though, and
  would resolve that path again after Pamir's check, when a pod that
  writes under the prefix could have put a link in its way. So Pamir
  binds the opened descriptor at a path of its own,
  `/run/pamir/mounts/<namespace>/<pod>/<n>`, cloned with `open_tree` and
  attached with `move_mount`, and names that path in the spec. Nothing a
  pod can write lies on the way to it. The bind is made read-only before
  it is attached when the pod's mount is, keeps the propagation the pod
  asked for, so a mount made on the host beneath the directory afterwards
  still appears inside, and goes when the pod does. The kubelet mounts a
  volume's sub-path this way, and yaac's mountd its binds.
- **Every host path is on a mount with `nosuid` and `nodev`.** Root in a
  pod is root to the files it writes through a host path. Without
  `nosuid` it leaves a setuid-root program there, and a host user who
  reaches the path, one admitted to the namespace by group say, runs it
  as root; without `nodev` the same goes for a device file. Pamir reads
  the flags of the mount each prefix is on when the namespace is made,
  and of the mount a host path resolves to at every pod start, by its
  descriptor, and refuses either that lacks one. The flags are the
  host's mount's: on the pod's own view of the directory they would do
  nothing, since the file is run from the host's path. Mapping a pod's
  root to an unprivileged host uid would remove the cause, and spike 3
  tries it.
- **mountd, a declared pod that binds into sandboxes at the server's
  request, applies the same rules**: only named directories, each opened
  by descriptor beneath its root, and every bind made with `nosuid` and
  `nodev`. It is where the limits are most easily undone.
- **An image a declared pod names cannot be removed** through the image
  API, so a taken management socket cannot break the declared pods' next
  start.
- **A streams socket reaches namespace pods only.** yaac's server
  reaches the proxy and the router through their declared sockets, as any
  pod would.

A namespace is a boundary against collisions between its users, such as
an install and a test run, not against one who means harm: within the
same limits, two namespaces' pods can mount the same prefixes.

## Networking

**Pods have no network. They have sockets.** A yaac sandbox's only links
to the outside are unix sockets in a directory on its node
(docs/workspace-egress.md "The contract"). Pamir makes that its model of
connectivity: a pod declares sockets, and Pamir's relay carries a
connection between a pod's socket and a program, saying which pod it came
from. That is what netd's relay does today, made general, and it removes
the CNI, the pod network, Services, DNS and policy at once.

**A pod's network is one of two modes**, which Pamir enforces whatever
the runtime handler is:

- **`none`**, the default: a network namespace holding only loopback,
  which Pamir creates and pins before any of the pod's containers start,
  and which all of them join. No CNI is called. Under gVisor this holds
  beneath runsc's own `network = "none"`; under runc it is the whole of
  it; under a micro-VM it is why the guest gets no NIC.
- **`egress`**, for a pod that must reach the internet itself, declared
  (yaac's proxy, server and site tunnels) or in a namespace whose limits
  allow it: the same namespace plus one veth, whose other end is in the
  floor's namespace (below) and whose traffic leaves by the host's
  uplink, masqueraded. The floor passes public destinations and return
  traffic and drops the rest. It is kernel state outside the pod, so
  nothing in the pod can change it, and it holds while Pamir is down.
  Internal destinations are opened only in Pamir's config, each for the
  pods it names, never through a namespace's socket.

**The floor has a network namespace of its own.** nftables rules belong
to a network namespace, and the host's is shared with whatever else
manages its firewall: a distribution's tooling may wipe the whole ruleset
(`flush ruleset`, as Ubuntu's `nftables.service` config begins), and ufw,
firewalld and Docker rewrite theirs. So the node program makes one
namespace that nothing else enters, pinned at `/run/pamir/floor`, and
every `egress` pod's veth ends there, not in the host's. One more veth,
`pamir0` on the host's side and `up` on the floor's, joins it to the
host, which routes the pods' range to it and masquerades what comes out.

```
pod ── pmr… ──► floor's namespace (the rules) ── up / pamir0 ──► host (NAT) ──► uplink
```

- No other program's flush or reload reaches the rules, and they stand
  while the node program is down, so nothing has to watch them.
- Every interface there but `up` is a pod's, so the rules need no mark to
  tell a pod's veth from a stranger's, and Pamir restricts no interface
  it did not make.
- The host gives nothing up. Nothing on it dials a pod's address, since
  every connection into a pod is a socket the relay carries, which is
  what keeps a CNI's rules in the host's namespace.

The namespace and its table exist before any pod's veth does. The node
program renders the table as text and loads it whole with `nft -f` when
it starts, and adds and removes the `opened` set's entries as pods start
and stop, each change one transaction, so it needs no nftables library
and no packet meets half a table. `sudo
nsenter --net=/run/pamir/floor nft list ruleset` shows it.

A pod's veth is named `pmr` and 12 hex digits of a hash of the pod's id
on the floor's side, which fits Linux's 15-character limit and is only
for people reading `ip link`. It gets a `/31` from a private range
install picks after checking the host's routes for a free one
(`10.250.0.0/16` unless that is taken; the operator may name another
inside the non-public list, so that every pod's address and the link's is
one the floor drops as a destination). The `/31` gives the floor's
namespace its route back to the pod, which the reverse-path check relies
on. A veth there whose pod is gone is an orphan the node program deletes.

```
# in the floor's namespace
table inet pamir {
  set nonpublic { type ipv4_addr; flags interval;
                  elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
                               169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24,
                               192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15,
                               198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/3,
                               168.63.129.16 } }
  set opened    { type ipv4_addr . ipv4_addr . inet_service; flags interval; }   # a pod, and what is opened for it

  chain prerouting {                       # before any routing decision
    type filter hook prerouting priority -150;
    iifname != "up" fib saddr . iif oif missing drop   # a pod's source must route back via its own veth
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    iifname "up" ct state established,related accept                # replies to a pod, and nothing else in
    iifname != "up" oifname "up" ip saddr . ip daddr . tcp dport @opened accept
    iifname != "up" oifname "up" ip daddr @nonpublic drop
    iifname != "up" oifname "up" meta nfproto ipv4 accept           # a pod to a public address
  }
  chain input {                            # nothing is served in this namespace but DNS
    type filter hook input priority 0; policy drop;
    iifname != "up" ip daddr 10.250.0.1 meta l4proto { tcp, udp } th dport 53 accept
  }
}

# in the host's namespace
table inet pamir {
  chain input {                            # a pod to this host itself
    type filter hook input priority 0;
    iifname "pamir0" drop                  # no host service, on any of its addresses
  }
  chain nat {
    type nat hook postrouting priority srcnat;
    ip saddr 10.250.0.0/16 oifname != "pamir0" masquerade   # the pods' range
  }
}
```

- `nonpublic` is the proxy's own list (`NON_PUBLIC_V4` in
  `k8s/proxy/upstream.ts`), and must stay equal to it.
- `opened` holds the operator's internal openings, each as a pod's
  address with the address and port opened for it, checked before the
  drop. An opening in Pamir's config names who it is for, a declared pod
  or a namespace's `egress` pods, and the node program adds an entry for
  each such pod when it starts and removes it when it stops. The
  reverse-path check is what makes a pod's source address its own. So an
  internal mirror opened for yaac's proxy is opened for nothing else, a
  namespace's own `egress` pods least of all.
- The floor's `forward` drops by default, so what no rule names does not
  pass: IPv6, one pod to another, and anything the host or the internet
  would open into a pod.
- The host's `input` rule refuses a pod every service on the host,
  whichever of its addresses is dialed, its resolver included, so a pod's
  DNS is Pamir's to carry (below).
- The host forwards between `pamir0` and its uplink, so the node program
  turns on `net.ipv4.ip_forward` when it starts, as Docker does, and adds
  the route for the range. A firewall whose forward policy drops (ufw's,
  Docker's) must let `pamir0`'s traffic through, which install checks.
  Install refuses a host that already has an interface named `pamir0`.
- That switch is the whole host's. One that had it off now passes on a
  packet that a neighbour on one of its networks routes through it to
  another, a VPN's or a second card's. Pamir adds no rule against that
  and asks the operator for none: a rule dropping other interfaces'
  forwarding would restrict interfaces Pamir did not make and break the
  next program that needs them to forward. What gets across carries the
  neighbour's own source address, so a VPN's far end usually drops it and
  no answer finds its way back, and a host with a firewall manager or
  Docker refuses to forward for others already.

**An `egress` pod's DNS is the host's, carried by Pamir.** The resolver
a host uses is nearly always one the floor drops: a router's or a cloud
network's private address, a company's server, or a stub on the host's
own loopback. A public one is often blocked, and knows none of the names
a proxy must resolve for an internal mirror or a tailnet. So the relay
holds a socket in the floor's namespace, on port 53 of the range's first
address, which no pod is given, and Pamir writes that address into each
`egress` pod's `resolv.conf`. It sends each query on to whatever the host's own
`resolv.conf` names and returns the answer, without reading either, as
Docker's built-in resolver does, so a pod's names follow the host's when
a VPN connects or the network changes. A pod's queries are capped in
rate. An answer that names a private address opens nothing: the floor
still drops what is sent there unless an opening covers it.

**What is left on the host** is that table's two rules, in the namespace
other tooling flushes. The node program subscribes to nftables' change
events (as `nft monitor` does), checks every few seconds besides, since
netlink may drop events, and reloads the table when it is gone or
changed, and reports it. Until it has:

- `egress` pods have no internet, since nothing masquerades them. The
  floor is untouched, so a wipe costs the connection and not the wall.
- A pod reaches the host's own services at any of the host's addresses
  the floor passes, a public one it holds or one an opening covers, and
  nothing else. While the node program is down that lasts until it is
  back; systemd restarts it within seconds.

Nothing of Pamir's is among those services: its programs listen only on
loopback or unix sockets (the API sockets, the published ports below, and
health and metrics on `127.0.0.1`), and on the resolver's port inside the
floor's namespace, and the floor never passes `127.0.0.0/8`. A published
port on another address authenticates every request. Other services an
operator runs on the host are theirs to bind to the interfaces they mean.

**There is no host mode.** A pod in the host's own namespace would reach
the host's loopback, where a local server treats a caller as its owner,
and would have no floor. yaac needs none: the browser's port is the
relay's own listener, and node setup is an install step.

**A pod can ask for transparent egress, delivered to a broker.** Pamir
then adds a small shim container to the pod from its own image. The shim
takes every TCP connection the pod's other containers make, so they need
no proxy settings, and hands each to Pamir's relay. It answers their DNS
queries itself, each name with an address of its own from a reserved
block, so the name travels with the connection. Any other UDP goes
nowhere. The relay delivers each connection to the broker the pod's spec
names, a socket served by another pod of its namespace, stamped with:

- the pod's id, from where the connection arrived, never from the shim;
- the destination address and port, and the name when there is one.

That is one wire format: a PROXY protocol v2 header with the pod's id and
the name in TLVs, which is the header netd's relay writes to the proxy
today with the name added. Every stamp and every header below is one, so
a stock proxy (Envoy, HAProxy) reads and writes them. Pamir decides
nothing about the connection: the broker does, and the broker is the
caller's (for yaac, its egress proxy). Pamir may ship a small reference
broker, a name allowlist and a splice, for tests and for other users. A
broker's socket is a path (below), which nothing but the relay's
deliveries reaches, so no shared secret is needed.

**A stamp's name is what the pod looked up, not what the connection
says.** The shim gives each name a pod asks for an address of its own and
keeps the list, so a connection to that address is stamped with the name,
and a broker can act on a protocol that never says one, ssh's or a
database's. Two rules keep that name from misleading:

- **A request's own name comes first.** Where a connection carries a name
  of its own, TLS's server name or HTTP's `Host`, a broker acts on that
  one in everything it decides, and refuses a connection whose stamp
  names another. A pod can look one name up and ask for a second, and a
  broker that allowed by the one and chose a credential by the other
  would send a secret to the wrong place. The stamp decides alone only
  where the protocol carries no name.
- **An address means one name for the pod's life.** A program may keep an
  address long after it asked for it. So the shim keeps its list in the
  pod's directory under the socket root, where a restarted shim reads it
  back and the relay reads nothing, and never gives an address to a
  second name: once the block is used up, a new name gets no answer.

The shim is untrusted by position: whatever it writes only describes its
own pod's traffic. How it reaches the relay depends on the runtime, which
is why it is Pamir's and not the caller's: a host unix socket under gVisor
(`host-uds`) and runc, vsock under a micro-VM. Under runc Pamir can also
install the shim's loopback route and NAT rule from the host before the
pod starts, so there the shim needs no `CAP_NET_ADMIN`.

**A declared socket names its callers.** Each socket a pod declares lists
who may open it, and the relay checks the list before it connects. An
entry is one of two kinds, which the relay tells apart by how the pod was
started, not by anything the pod says of itself:

- **a declared pod, by its name.** No namespace pod can be one, whatever
  its labels.
- **namespace pods, by label.** Whoever holds the management socket
  writes a namespace pod's labels, so such an entry admits any pod that
  holder chooses to start, and is for sockets meant for them: a broker's,
  which yaac's proxy opens to every sandbox.

yaac's site router may open a release's site socket, by its name, and no
other pod may. The namespace's manager reaches any namespace pod's socket
through the streams socket ("The API"), which is how yaac's server opens a
workspace's stream socket. So a taken management socket reaches no socket a
declared pod keeps for another declared pod, such as the one the router
serves the tailnet tunnel.

**Nothing a pod names leaves its namespace.** Its broker, each import and
each entry of a caller list resolve among the pods of the pod's own
namespace and nowhere else. A pod's id is unique only there, and that is
enough for a stamp: a broker hears no pod of another namespace, so an
install's proxy never serves a test run's pod that carries a workspace's
id. `system` is a namespace like any other here: its pods name only one
another, so none serves another namespace's pods through a socket. What
one does for the whole machine it does with the host paths and privilege
its declaration grants.

**Inside a pod, a socket is a file.** Each pod whose programs use one has
a directory of its own for them, which Pamir mounts at `/run/pod` in the
shim and in each container whose spec asks for it. It is apart from the
pod's directory under the socket root, which holds the relay's end of
every connection and which only the shim mounts; the shim joins the two.
Which containers mount it decides who reaches a socket there, and each
file has the owner and mode the pod's spec gives it, since the shim binds
as root and a program such as cloudflared runs as a user of its own.
Under runc it is a directory Pamir makes for the pod, under a micro-VM
one in the guest, and under gVisor a tmpfs the sandbox's containers share
or a host directory through `host-uds`, whichever spike 2 finds.

- **An import**, for a program reaching out of its pod: the pod names a
  socket (the router's `public`), the shim binds a file for it
  (`/run/pod/public.sock`) and carries each connection through the relay,
  which checks the far socket's caller list. cloudflared reaches the
  router this way, as the origin `unix:/run/pod/public.sock`. An import is
  never a loopback port. A port answers anything in the pod that can be
  made to dial it, such as a program fetching a URL someone else supplied,
  and no URL names a file. A program that can only dial TCP gets a
  forwarder from whoever writes its pod, not from Pamir.
- **A declared socket** is served in one of two forms.
  - As a **path**, the program binds a file in `/run/pod`, and each
    connection the shim delivers there opens with the relay's stamp,
    which names the caller: a pod, or the published port a connection
    came in by, with the peer's address when that port is off loopback,
    or the namespace's manager for a stream opened through its streams
    socket. A
    program that acts on who is calling takes this form: a broker, or
    yaac's proxy taking its feed from the server.
  - As a **port**, the shim dials a loopback port and delivers the bytes
    alone, for a program that can neither bind a file nor read a stamp,
    such as a release's web server. That program cannot tell a delivery
    from a dial made inside its own pod, so a port belongs only in a pod
    where nothing dials on anyone else's behalf. A sandbox is such a pod;
    yaac's proxy and server are not.

**An import leads to one socket, or to every socket of a name.** One of
the first kind names a pod's socket (the router's `public`) or one of its
namespace's own (the management API, the registry), and the program just
connects. One of the second kind names only a socket (`site`), and leads
to that socket in whichever pods of its namespace declare it. The program
says which pod on each connection, by opening it with a header that
carries the pod's id in a TLV, which Envoy's upstream PROXY protocol
writes, as yaac's router does to netd's relay today. The relay takes the
header off, delivers what follows when that pod exists, declares the
socket and lists the caller, and closes the connection otherwise.

The far socket's caller list is the check in both kinds, so the second
reaches nothing an import of the first kind to each pod would not. It is
for a pod whose spec only the admin socket changes and whose peers come
and go: which peer is then data the pod reads, as everything that changes
for a declared pod is. yaac's router reaches every release through one
such import. It is to a pod what the streams socket is to a namespace's
manager, who names a pod on each connection there too.

**On the host, a socket is a published port.** Pamir's config maps a
loopback port on a node (for yaac's, the control node) to a pod's
declared socket (`127.0.0.1:8790` to the server's `api`), and the relay
carries each connection. The browser, the `yaac` CLI and
`tailscale serve` use these, so no program on the host is handed a path
under the socket root. Only a port whose socket authenticates every
request, such as the server's token listener, may be published on another
address.

The socket root is a root-owned directory of mode `0700`, and a pod's
directory there is mounted in its shim alone, so nothing but root on the
host reaches the relay's end of a pod's sockets. A published port is
reachable by every process on the host, whose user TCP does not report;
that is the trust the server's loopback owner already rests on, so on a
host with users who are not trusted, a port is published only if its
socket authenticates.

**The relay counts what it carries**, for each pod: connections, and
bytes each way, served with its metrics. No connection is an event on the
watch stream, which carries pods and nothing that comes and goes a
thousand times in one package install.

## Images

**containerd's image store is the store**, one containerd namespace per
Pamir namespace, so installs keep separate image records over shared
layer data.

**Pamir serves a registry over that store.** It speaks the OCI
distribution protocol (blob uploads, manifests, tags) on top of
containerd's content and image APIs, so nothing is kept twice: a pushed
blob is written into the content store and checked against its digest as
it lands, and pushing a manifest creates the image record, after which
the image is on the machine and runs with no pull. A pull reads straight
from the store. It is small enough to pass the distribution spec's
conformance tests, and it is what lets another machine pull a pod's image
(docs/plans/pamir-multi-node.md).

**The registry has a socket of its own** in each namespace, beside the
management socket ("The API"). A management socket is the credential for
everything its namespace's limits allow, while the
registry faces callers no one trusts, each held to its token's scopes;
one socket for both would let a build reach the management routes, or
put a second authorization scheme on every one of them. A caller with the
management socket has no need of the registry, since the image API
answers whether an image is there.

**Every request carries a signed token, and the registry checks it
itself.** It follows the registry token-authentication spec Docker and
OCI registries use: a signed token (a JWT) listing repositories and the
actions allowed on each, pull or push, checked against the public key the
namespace's config names. Its issuer sets how long it lasts, no longer
than the work it is for and no shorter: a client is given its token once
and pushes at the end, so a build's must outlast the build. The caller issues
the tokens (for yaac, its server, with the scopes its grants carry
today), and whoever carries a request, yaac's proxy for a build, only
forwards it, so taking the carrier grants no repository it does not
already have a token for. Only the node program pulls without one, being
Pamir itself. The socket also admits only the callers the config names,
as a second wall, and pushes are capped in size.

The registry always challenges with `Basic`, never `Bearer`: docker,
podman and BuildKit then send the credentials stored for it, and yaac
stores the token as the password, so no client is sent to a token endpoint
and none is needed. It never redirects, not even a blob download, since it
serves every blob from the store. What it answers when it refuses, with the
spec's error body (`{"errors":[{"code": …, "message": …}]}`) naming the
repository and the action:

| Request | Status | Code |
|---|---|---|
| no credentials, or a token that fails its signature, algorithm, issuer, audience or times | `401`, with `WWW-Authenticate: Basic realm="pamir"` | `UNAUTHORIZED` |
| a valid token whose scopes do not cover it | `403` | `DENIED` |
| a manifest pushed under a tag that names another one | `403` | `DENIED` |
| a blob read through a repository it is not in | `404` | `BLOB_UNKNOWN` |
| a manifest that names a blob its repository does not hold | `400` | `MANIFEST_BLOB_UNKNOWN` |
| a delete | `405` | `UNSUPPORTED` |
| the catalog of every repository | `403` | `DENIED` |
| a push over the size cap | `413`, or `400` for a declared size over it | `SIZE_INVALID` |
| a push while the store is below its reserve | `507` | `DENIED` |

A caller missing from the socket's caller list gets no answer at all: the
relay refuses its connection first.

**The registry reads what builds send, inside the node program.** A
mistake there is root's, and the likeliest is a wrong decision, a token
taken that should not be or a check made on one repository's name and a
write on another's, which no separate process would contain. So the care
goes where those are made:

- tokens are checked by a library in wide use, with the one signature
  algorithm fixed in the registry and never read from the token;
- a repository's name is parsed once, and the checked value is the one
  the store is given;
- every header, manifest and declared size has a hard limit, and a
  request that fails is that request's failure, not the program's;
- the request and manifest parsers are fuzzed, and the distribution
  spec's conformance tests run in the suite.

**A blob is served only through a repository it is in.** A token names
repositories, and containerd's content store has none: it is one pool of
blobs by digest. Left at that, a token for any repository would read any
blob of the namespace whose digest its holder had learned, another
project's layers among them. So the registry keeps which repositories a
blob is in. It is in one when:

- it was uploaded through that repository;
- a manifest there names it; or
- it was mounted there from a repository it is in, by a caller whose
  token may pull from that one too.

Through any other repository the blob does not exist:

- a read of it is answered as a read of a blob the store does not hold,
  so nothing is learned of what other repositories hold;
- a manifest that names it is refused;
- a mount the token or the source does not allow falls back to an
  ordinary upload, as the protocol provides, and the caller sends the
  bytes. They are stored once, however many repositories hold them.

A build that pushes an image over its parent holds a pull scope for the
parent's repository, so the parent's layers are mounted and not sent
again. The link is no second store: a manifest's references are the
labels containerd's collector follows from an image record, which the
registry writes with every manifest it takes, and an upload no manifest
names yet is tied to its repository by the lease that keeps it.

**A tag never moves.** The registry refuses to point an existing tag at a
manifest with a different digest; removing the tag is the only way to
change it. Pushing the manifest a tag already points at succeeds, since it
changes nothing, so retries and pushes of an unchanged image work as with
any registry. A caller that would overwrite a tag (a build cache saved
under one name, say) saves each version under a tag of its own and
records which is current, as GitHub Actions' cache does with its
immutable entries.

The rule earns that cost three ways. A build finds its parent by tag, so
a parent's tag that could move would be a way to swap what is built on
it. An image's record is what keeps its digest in the store, so a tag
moved to a new digest would leave the old one to be collected while its
caller still starts pods from it. And whatever resolves a tag, now or
later, is safe without having to remember to use a digest. What the rule
does not stop is a build claiming a tag in its own repository before the
rightful push arrives, which goes no further than that repository.

**A pod names an image by digest**, so the image cannot change between
the caller's check and the start. Starting a pod never fetches
one. Pamir does not vet images; the caller chooses them, and containment
comes from the runtime and the mounts, not from which image runs.

**The API manages images**, so no pod needs containerd's socket. Within a
namespace: list images and check whether one is there, pull one by digest
from an outside registry, and remove one that no declared pod names.

A pushed image is untrusted content when a sandboxed build made it. Pamir
checks only its digests and size; containerd's snapshotter unpacks it on
the host when a pod uses it, as a node unpacks an untrusted image it
pulls today.

Removing an image drops its record, and containerd reclaims any layer or
snapshot no record references, while its leases keep uploads in progress
and what a running pod uses. There is no separate registry storage to
collect.

**The store keeps a reserve of free space.** containerd's store is on
whatever filesystem the machine gives it, most often the host's own, and
Pamir counts on no other. So it holds back a reserve on that filesystem,
set in Pamir's config: 10 GB, or a tenth of the filesystem where that is
less. While less than the reserve is free:

- the registry refuses a push;
- the image API refuses a pull from an outside registry;
- no image is unpacked, so a pod whose image is not unpacked yet does not
  start. Pods already running are not touched.

The room comes back when images are removed, which is their caller's to
do through the image API. The reserve is checked as each of these begins
and as a push goes on, so the pushes of many builds cannot together take
the disk. It does not bound a layer that unpacks far larger than it
arrived, which is past the reserve before anything can stop it, as it is
for a node that unpacks an image no one vetted today.

## The engine

**containerd, through its own gRPC API.** It is the integration gVisor
documents and the one yaac's pods go through today. Pamir passes through
what the generic sandbox needs: the runtime handler, annotations, mounts
with propagation, cgroup limits, exec, each container's output, and exit
and OOM events. It creates
containers and tasks from an OCI spec it writes itself, so a pod's
containers join the network namespace Pamir pinned by its path; it pulls
and unpacks images through containerd's transfer service, which does both
on containerd's side; and its registry streams pushed blobs into the
content store. Pamir does not use containerd's CRI service, which would
call a CNI for every pod, put everything in one containerd namespace and
bring the kubelet's conventions.

What CRI would give that Pamir does itself is grouping: gVisor's and
Kata's shims put a pod's containers in one sandbox or VM by reading
annotations CRI sets (`io.kubernetes.cri.container-type`,
`io.kubernetes.cri.sandbox-id`). Pamir sets them itself, or uses
containerd's sandbox API; spike 1 says which, and one of them has to
work, since the shim must share its pod's sandbox.

**Storage is host paths.** Pamir mounts directories of the machine into
pods, with the propagation a pod asks for, and runs no storage system of
its own: no classes, claims or volume drivers. For yaac on one machine
every tier is a directory of the data dir on the local disk, as on kind
today: the server, a declared pod, gets its server-local and global
directories as host paths, mountd, another, binds what each sandbox may see
into its node-mounts directory, and a project volume is a folder under
`<dataDir>/volumes`, where a database is safe because the disk is local.

## Language and footprint

**Pamir is written in Rust**, the node program and the shim alike, with
the wire format between the shim and the relay in one crate both use. The
footprint matters on both sides of a node: the shim runs in every pod,
under gVisor, where each system call is trapped and costly, and the node
program runs on machines whose memory is for workspaces. A Go runtime is
never idle (a monitor thread, garbage collection, preemption by signal)
and keeps heap headroom for its collector; a single-threaded Rust event
loop makes no system call while nothing happens, and async tasks cost far
less than goroutines per connection. What Go would have given most, the
containerd client's pull and unpack helpers, containerd's transfer service
does on its own side, and the floor is text loaded by `nft`, so neither
needs Go's libraries. yaac's own programs (mountd, acpd) stay Go.

That is the case for Rust, not a measurement of it. Spike 5 builds both
parts both ways and decides each on its own, before either is written in
full.

Budgets, which the spikes replace with measured numbers:

- the shim under 2 MB resident per pod, and no system call while idle;
- the node program under 20 MB resident while idle, and the relay under
  5 MB, growing by little more than its buffers per carried connection;
- the relay moving spliced bytes at kernel-routing speed.

## Where yaac's node programs live

netd's relay becomes Pamir's relay and netshim its shim, so both leave
yaac, ported to Rust unless spike 5 keeps them Go. The relay's core is
small and written for that: a package that imports nothing of yaac or
Kubernetes (`k8s/mountd/internal/sockets`; docs/workspace-egress.md "The
relay, and the rest of netd"). netshim already ships in an image of its own
rather than the workspace's.

The proxy stays yaac's: it is the broker every sandbox names, a declared
`egress` pod, and what it decides (allowlists, credentials, git grants,
the `yaac.internal` routes) is yaac's policy.

mountd, the arborist, the swap bound and the pressure kill stay yaac's,
as declared pods, so Pamir and yaac release separately. The server, the
site router and the tunnels are declared pods too, and the server starts
only namespace pods.

## Performance

Carrying connections through sockets and a broker does not by itself keep
TCP below what a kernel-routed container gets:

- **The relay splices every hop.** Once it has written or read a
  connection's header it moves the bytes between the two sockets with
  `splice`, never through its own memory: a pod's socket to its broker's,
  the server to a workspace's stream socket, a published port to its pod,
  and an import's far end.
- **The shim splices too.** After it writes a connection's header it moves
  the bytes both ways with `splice`, for egress, for `ingress.sock` and
  for imports. Under runc both of its sockets are kernel sockets, so with
  the relay and the broker doing the same, a carried TCP connection never
  crosses user space after its header; a sockmap can drop even the pipe.
  Under gVisor the Sentry emulates `splice` over its own network stack,
  which saves only the shim's trapped system calls. Under a micro-VM it
  depends on vsock's splice support.
- **UDP is not carried.** A pod that needs it and can be trusted with an
  interface uses `egress`, which is kernel forwarding behind the floor.

The runtime's own cost (gVisor's network stack, vsock under a micro-VM) is
separate from all of this.

## Testing

An in-memory fake of the API for unit tests, and the real programs on one
machine for the e2e tier, the node program's control and node sides joined
by the in-memory pipe and speaking the real protocol.

The e2e tier runs the two programs inside a privileged container of
their own, as kind runs a node, so a test run never loads or wipes nftables
tables on the developer's or CI machine. Almost everything the node
program touches is per network namespace (nftables tables, interfaces,
routes, `ip_forward`, the floor's namespace beneath it), and the rest
(`/run/netns`, `/run/pamir`, the socket root, a containerd of its own) is
per mount namespace, so the container is a machine to it. gVisor already
runs inside kind's node containers. The node program therefore always uses
the namespaces it runs in, and never reaches for the machine's by any
other route. One case flushes the whole ruleset of the namespace the node
program runs in, and shows that a pod still reaches no non-public address
and gets the internet back once the host's table is reloaded. Another
restarts each program under load: a stream and an `egress` pod's
connection outlive the node program's restart while new ones open and DNS
answers, and the relay comes back from its files with the node program
stopped.

## What is built

The two programs on one machine: start, stop, exec and watch a pod under a
caller's id, with its spec kept on disk; namespaces and their sockets; the
two network modes and the floor; the shim, the relay and brokers; declared
sockets with their callers; published ports and imports; the
registry and the image API; logs; declared pods and namespace limits. The HTTP
API, and the in-memory fake of it the driver's unit tests use. This is
what the `pamir` driver needs for a single-machine install.

## Spikes

1. **The node side alone.** One Rust program on one machine starts
   yaac's generic sandbox on containerd from a spec through containerd's
   gRPC API and its Rust bindings, with no kubelet:
   - the runsc flags reach it, and the `dev.gvisor.spec.mount.*`
     annotations apply;
   - a mount made on the host under a bound directory appears inside,
     when the directory reaches the sandbox through Pamir's own bind of
     its descriptor ("A namespace's pods are held to its limits"), and a
     read-only one stays read-only against root inside;
   - a second container joins the first's gVisor sandbox, through the CRI
     grouping annotations Pamir sets or containerd's sandbox API. Nothing
     stands in for this: the shim takes a pod's connections only from
     inside the pod's own network stack, so if neither way works there is
     no transparent egress and the plan is reshaped;
   - an exec runs a program handed in by descriptor, with its process
     given whole, through containerd's exec if that can carry a
     descriptor, and otherwise by Pamir calling runsc's own exec with the
     state directory and ids that are Pamir's to know;
   - cgroup limits hold, and exits and OOM kills are reported;
   - no CNI plugin is needed for a sandbox with no interface;
   - an image pulls and unpacks through the transfer service, and a blob
     streams into the content store;
   - BuildKit pushing an image over a parent it may pull mounts the
     parent's layers and does not send them again ("A blob is served only
     through a repository it is in").

   Whatever containerd's Rust bindings fall short on here counts against
   Rust for the node program in spike 5.

   Then keep the spec on disk, restart the program and the machine, and
   find the sandbox still running or brought back.
2. **Carrying a socket.** The shim injected into a gVisor pod, its
   connections arriving at a broker with the pod's id, destination and
   name, and a declared socket refusing a caller its list leaves out.
   A socket file in a gVisor pod's own directory, bound in one container
   and opened from another, over a tmpfs the sandbox shares and over a
   host directory with `host-uds`. A stock Envoy at both ends of a path:
   listening on one and reading the relay's stamp, and naming a pod in the
   header it writes to an import, which its PROXY protocol support is not
   known to do when its own listener is a path. An `egress` pod's DNS
   through the relay's resolver socket, over UDP and over TCP, with an
   answer too large for one datagram.
   Measure the relay against netd's relay and kernel routing, with
   splicing on and off, under runc and under gVisor, and measure against
   the budgets ("Language and footprint"): the shim's memory per pod and
   its idle CPU across a hundred idle sandboxes, beside today's Go
   netshim; the node program's memory idle and under a thousand carried
   connections.
3. **A pod whose root is not the host's.** Spike 1's sandbox again, in a
   user namespace: its root mapped to a range of unprivileged host uids,
   and the uid its workload runs as mapped to the host uid that owns the
   directories it mounts (for yaac, the install uid), so those files keep
   one owner on both sides. A file a pod writes as root is then nobody's
   on the host, where `nosuid` only stops it running as root. Each of
   these is a way it could fail:
   - the image's files keep their owners inside. Try an id-mapped mount
     of the image through gVisor's shim first, which costs nothing.
     Failing that, measure a shifted copy in disk and start time: one per
     image for a namespace's one mapping, not one per pod, with any layer
     a declared pod also uses stored a second time, since declared pods
     run as the host's root;
   - a mount made on the host under a bound directory still appears
     inside, though the sandbox's mount namespace is the user
     namespace's;
   - the sandbox is still entered from the host, and a program entered
     with `CAP_DAC_OVERRIDE` and `CAP_CHOWN` still makes a directory
     inside one the mapped uid owns and chowns what it makes, which
     yaac's mountd does at every bind;
   - the shim still opens the pod's sockets, whose directory is root's;
   - a file host root owns, as everything a pod's root wrote before the
     mapping is, is out of the pod's reach, so say what shifting a data
     dir's owners takes;
   - on a Mac, all of it through the VM's shared folder.

   If it holds, a namespace's limits gain the mapping, and `nosuid` and
   `nodev` stay as the second wall. If it does not, they are the wall.
4. **What a listed annotation's value can do.** A namespace's list admits
   annotations by key, so yaac's admits any value under
   `dev.gvisor.spec.mount.`. Start spike 1's sandbox with hostile ones
   and look for anything the pod's own spec would have been refused:
   - a mount the spec makes read-only turned writable through its
     `options`;
   - a `source` that names a path outside the namespace's prefixes, or a
     mount the spec does not hold;
   - a `share` or `type` that lets a second pod see the first's files or
     memory.

   If any succeeds, Pamir stops copying these and writes them itself
   from a field of the pod's mount (a memory-backed directory and its
   size), and yaac's namespace lists no annotation at all.
5. **Go or Rust, for the shim and for the node program apart.** Build
   each part both ways, as far as spikes 1 and 2 take it, and decide each
   on its own:
   - **The shim.** Today's Go netshim beside spike 2's Rust one, in a
     hundred idle gVisor sandboxes: resident memory per pod, system calls
     and CPU while idle, which says whether a Go runtime with nothing to
     do wakes at all, and a spliced connection's throughput. Count the
     saving as a share of what an idle sandbox already holds in
     containerd's shim, the sentry and the gofer, which are Go whatever
     Pamir is.
   - **The node program.** Spike 1's list and spike 2's relay, in Go with
     containerd's own client and in Rust with its bindings: resident
     memory idle and under a thousand carried connections, with the
     kernel's pipe buffers for each splice counted, since they are the
     same in both and may be most of it; and what each had to write that
     the other was given, the spec, snapshots and leases on one side,
     whatever the registry needs on the other.

   Each part takes the language its numbers favor. Where they do not
   separate the two, which for the shim is a saving under a twentieth of
   what the sandbox already holds, it is Go: the relay's core, netshim
   and yaac's other node programs are Go today, and one more language in
   the build has to buy something. The parts may come out different, and
   the wire format is then a written format with a codec in each, not
   one crate. The shim's share is measured under gVisor, whose own
   processes in every sandbox are Go. A micro-VM runtime has none of
   those, and a process that wakes there keeps a whole guest awake, so a
   plan to run under one weighs the shim's tie toward Rust.

## Not planned, for now

- **Replacing the relay** without dropping the connections it carries.
- **How far apart the node program's and the relay's versions may be.**
  The relay's files carry their format's version, and that is all the
  two share.
- **A broker handing a connection back.** Once it has decided, a broker
  could return its connected upstream socket to the relay, which would
  move the bytes inside the kernel and leave the broker out of them. It
  needs a second protocol between broker and relay, cannot work for a
  broker under gVisor, and waits for a measurement that shows the need.
- **The registry as a program of its own**, under a user of its own,
  speaking the protocol and asking the node program to read and write the
  store. It would keep a parser's fault from being root's, at the price
  of a third program and a second interface between them, and would not
  contain a wrong decision about a token.
- **Carrying UDP for a `none` pod.** The header has a datagram kind, so a
  flow, the datagrams between one port in the pod and one destination,
  could ride a stream of its own with each datagram behind a two-byte
  length, closed when idle as a NAT forgets a mapping. PROXY protocol says
  nothing of carrying datagrams over a stream, so that framing would be
  Pamir's and a stock proxy could not be its broker. Every datagram would
  cross user space.
- **The memory rules.** Bounding each pod's swap and killing the pod
  furthest over its request under pressure are yaac's today
  (docs/cluster-setup.md "Memory pressure"). They are general enough to
  move into Pamir once they have run there as pods.
- **Name allowlists for `egress` pods**, much later and only for a user
  who needs them. The floor could take a per-pod set of allowed
  addresses filled from the pod's DNS answers, as Cilium's FQDN policy
  does, giving kernel-speed UDP under a name allowlist. It binds addresses,
  not names, so a name sharing an address with an allowed one gets through;
  yaac's pods do not need it, since its `egress` pods reach any public
  address and its sandboxes go through a broker.
- **Roles, read-only access or quotas** within a namespace.
- **Management from another machine.** Every socket is local, so install
  and anything else that uses one runs on the control node. If that is ever
  not enough, the standard addition is forwarding the sockets over ssh, as
  Docker contexts and `podman --remote` do, which needs no authentication
  of Pamir's own since ssh is it; an HTTPS listener with client
  certificates or pinned keys, as Incus and Kubernetes have, is the
  heavier one.
- **The host's table owned by the node program**, which a newer kernel
  offers, so that another program's flush skips it. It would close what
  is left of the gap on the host.
- **A token helper for operators.** `sudo pamir token --namespace <name>
  --scope <repo>:pull,push --ttl 1h`, with Pamir generating and keeping a
  namespace's private key root-only and minting tokens for whatever scopes
  the operator names. The operator still chooses the scopes, so Pamir
  decides nothing, and a user with no token service of its own, or a test,
  gets tokens without one. yaac does not need it, since its server issues
  its own.
- **Per-repository anonymous reads** in a namespace's config: repositories
  any caller the registry's socket admits may pull without a token, for
  content that is not confidential, such as shared base images. yaac does
  not need it, since its builds pull their parents with their tokens.

## What it changes elsewhere

- The `pamir` driver is built on this plan, and its stage 7 on
  docs/plans/pamir-multi-node.md (docs/plans/off-kubernetes.md).
- Under the `pamir` driver the proxy is the broker its sandboxes name and
  the server opens their stream sockets through Pamir, where under `k8s`
  both go through netd. netshim and the relay move into Pamir.

# Socket egress: sandboxes without a network interface

A proposal, not built. A workspace or builder sandbox gets no network
interface beyond loopback. Everything that crosses its boundary goes
through unix sockets in one directory the node mounts into it. That
replaces the datapath in docs/workspace-egress.md (a veth redirect on the
node, a NetworkPolicy wall around each pod, identity by pod IP) with one
that needs nothing from the network the sandbox runs on.

The proxy's allowlist, credential injection and MITM CA do not change. Only
how a connection gets from a sandbox to the proxy, and from the server to a
workspace, changes.

This is built under the `k8s` driver, on the clusters yaac runs on today.
Once no untrusted pod has an interface, the cluster's CNI no longer
matters to yaac, so kind and `infra/hetzner-k3s` go back to their defaults
and Calico is no longer installed on either. It is also what lets a later
driver run workspaces with no cluster at all
(docs/plans/off-kubernetes.md).

The spikes that decide the design have run ("Spike results"). One has not,
and it gates only the last phase ("Not run: the default CNIs").

## What this builds on

- **Generic workspace pods have shipped** (docs/generic-workspace-pods.md).
  Every workspace pod has one shape, with an id from creation, and a spare
  belongs to no project until its claim. The pod already carries a sidecar
  of yaac's own, the tree container: a root init container with
  `restartPolicy: Always`. netshim is a second one.
- **BuildKit builds have shipped** (docs/image-builds.md). A builder pod is
  redirected and policed like a workspace pod: it has a registration, the
  proxy tunnels its traffic under the project's allowlist and injects
  nothing, and the server drives it with `kubectl exec`. Its only direct
  dial is the main registry's pod port.

So every pod that runs code yaac did not write is already behind the
proxy, and this plan moves them all the same way.

## The contract

Each sandbox has one directory on its node, under the install's socket
root (`/var/lib/yaac/sockets/<install key>/<id>.<random>`, beside the
node-mounts root and named the same way). It is a fixed part of the pod's
shape. Only the pod's netshim container mounts it, at `/run/yaac`:

| Socket | Bound by | Carries |
|---|---|---|
| `egress.sock` | the relay, on the node | every outbound connection the sandbox makes |
| `ingress.sock` | netshim, inside the sandbox | every connection into it: the server's streams to streamd (docs/stream-relay.md) and the site router's requests to a release |

Three properties follow from there being no interface:

- **Deny by default needs no policy.** Nothing is routable, so there is no
  NetworkPolicy to apply late and no firewall rule to lose.
- **Identity cannot be forged.** A connection belongs to the sandbox whose
  directory it arrived in, and nothing inside one can reach another's
  directory.
- **Nothing in the cluster is reachable.** The server, the apiserver, the
  node and other sandboxes have no address a sandbox can dial.

## Why

The redirect works only when pod egress passes through host netfilter.
That one requirement is behind the Calico install on kind, the CNI gate
and `cni-adopt.ts`, the pod CIDR discovery, three environment variables
for clusters that hide what the gate looks for, and the exclusion of every
cluster that mandates Cilium (docs/workspace-egress.md "What this datapath
requires of a CNI"). On the node it takes netd's rule programming and an
Envoy. And every way it can go wrong is silent: a chain that matches
nothing looks like a healthy netd.

The wall around a pod is a NetworkPolicy, so it is only as good as the
engine that enforces it and only from the moment that engine has
programmed the pod. That is why kind's own CNI is unusable today and yaac
installs Calico in its place.

## What a sandbox sees

Egress stays transparent. No proxy variables are set, and a process dials
`github.com:443` as it does today.

- **DNS.** netshim answers every A query with the sinkhole address and
  every other query with an empty answer, whichever resolver address the
  query was sent to. The pod's `dnsConfig` names the sinkhole
  (`DNS_SINKHOLE`), where today it names the proxy. No name resolves to a
  real address, the install's own Services included.
- **Every address is local.** Loopback carries a default route, and one
  NAT rule sends every TCP connection that is not to `127.0.0.0/8` to
  netshim, which reads the address the client dialed. So a dial to a name,
  to a literal internet address or to a cluster address all arrive at
  netshim, on any port. A connect always succeeds; what happens next is
  the proxy's answer.
- **Routing by name.** The proxy routes by SNI on port 443, by the SSH
  sentinel, and by the Host header on every other port. Git over SSH, CA
  trust, the allowlist and `yaac.internal` behave as documented. Plain HTTP
  to an allowlisted literal address works on any port, where today only
  port 80 is redirected. HTTPS to a bare address still fails for lack of
  SNI.
- **UDP.** Port 53 reaches netshim's stub. Anything else goes nowhere.
- **IPv6.** Only `::1` has a route, so an IPv6 dial fails at once, as the
  proxy would refuse it.
- **`ip addr` shows only `lo`**, carrying `127.0.0.1` and the pod's own
  address. kubelet writes the pod's CNI address into `/etc/hosts` beside
  the hostname, so netshim assigns it to loopback: a program that binds or
  dials its own hostname (a JVM's `getLocalHost`, an Erlang node) works,
  and dev servers list it as their network address.
- **Nothing of netshim is visible** but one listening port on loopback. It
  runs in a container of its own, so the workspace's processes cannot see
  or signal it, and root in the workspace cannot change addresses, routes
  or NAT rules (it lacks `CAP_NET_ADMIN`) or open a raw socket (the
  workspace container drops `CAP_NET_RAW`).

## The parts

### The runtime

The gVisor installer registers a second containerd handler, `runsc-nonet`,
with its own flag file and RuntimeClass `gvisor-nonet`. Its flags are the
`runsc` handler's plus two:

```
network = "none"
net-raw = "true"
```

`network=none` gives the sandbox a netstack with loopback only. `net-raw`
is there for netshim: `iptables` writes its rules through a raw socket, and
without the flag runsc takes `CAP_NET_RAW` from every container. With no
interface a raw socket reaches nothing but the sandbox's own loopback.

Every sandboxed pod uses the new class once this ships. Workspaces, spares,
releases and builders also get netshim; salvage and import pods and the
check's file probes need no network and get none. A pod still has a CNI
address, which nothing uses: every probe and hook of these pods is an
exec.

A second handler, not a changed flag file, because the handler is
node-wide and installs share nodes: an e2e run's install and the install
beside it, on another release, must each get the shape their server asks
for.

### The pod

Workspace, spare, release and builder pods gain the same three things
(`netshimContainer` and `socketVolume` in `#drivers/k8s/substrate`'s
`pod-spec.ts`, used by `pod-job.ts` and `builder-pod.ts`):

- **A volume.** `hostPath` `<socket root>/<pod dir>`, `DirectoryOrCreate`,
  mounted at `/run/yaac` in the netshim container and nowhere else. The
  pod dir is the workspace's node-mounts dir name, or `<build id>.<random>`
  for a builder.
- **The netshim container.** An init container with `restartPolicy:
  Always`, placed before the tree container, so it is up before anything
  else in the pod starts and kubelet restarts it if it exits:

  ```yaml
  name: netshim
  image: <the mountd image, passed in as the tree image is>
  command: [/usr/local/bin/netshim]
  env: [{ name: POD_IP, valueFrom: { fieldRef: { fieldPath: status.podIP } } }]
  securityContext:
    runAsUser: 0
    runAsGroup: 0
    capabilities: { drop: [ALL], add: [NET_ADMIN, NET_RAW] }
  startupProbe: { exec: { command: [test, -S, /run/yaac/ingress.sock] }, periodSeconds: 1, failureThreshold: 30 }
  resources: { requests: { cpu: 10m, memory: 16Mi }, limits: { cpu: "1", memory: 128Mi } }
  volumeMounts: [{ name: sockets, mountPath: /run/yaac }]
  ```

  It declares limits like every container in the pod, since kubelet sets
  the pod's memory cap only when all of them do.
- **DNS.** `dnsPolicy: None` with `nameservers: [DNS_SINKHOLE]`, so
  `proxyServiceClusterIp()` and the `proxyHost` parameter of `pod-job.ts`,
  `spares.ts`, `launch.ts` and `builder-pod.ts` go.

`net-raw` is a flag of the whole sandbox, so with it every container
keeps whatever `CAP_NET_RAW` its spec grants, where today runsc removes it
from all of them. The workspace container therefore adds `capabilities:
{ drop: [NET_RAW] }`, and the builder container loses `NET_RAW` from its
list, which leaves both with exactly the capabilities they have in effect
today. The builder keeps `NET_ADMIN`: BuildKit gives a `RUN` step none,
and a step that had it could only cut its own network.

Nothing else in the pod changes. streamd keeps listening on
`0.0.0.0:10300`, which is now reachable from loopback alone, and the tree
container, mountd's bind and the claim are untouched.

### netshim

A static Go program, `k8s/mountd/cmd/netshim`, in the mountd module and
image beside `sandbox-bind`, the other program yaac runs inside sandboxes.
It uses the standard library only. The image gains Alpine's `iptables` and
`iptables-legacy` packages (the second alone lacks the extension libraries
the first carries); busybox's `ip` is already there. It ships in yaac's
image, not the workspace's, so a project's own Dockerfile gets it too.

At start, as root, it runs these commands and then listens:

```
ip route replace 0.0.0.0/0 dev lo
ip addr replace $POD_IP/32 dev lo
iptables-legacy -t nat -F OUTPUT
iptables-legacy -t nat -A OUTPUT -d $POD_IP/32 -j RETURN
iptables-legacy -t nat -A OUTPUT -p tcp ! -d 127.0.0.0/8 -j REDIRECT --to-ports 10301
iptables-legacy -t nat -A OUTPUT -p udp ! -d 127.0.0.0/8 --dport 53 -j REDIRECT --to-ports 10302
```

The route and rules live in the sandbox's netstack, not the container, so
they survive a netshim restart, and every command is safe to repeat. The
route is written as `0.0.0.0/0`: netstack rejects the `default` keyword.
gVisor has no nftables, so the legacy backend is the only one.

Then:

- **Out, TCP** (`127.0.0.1:10301`, `NETSHIM_TCP_PORT`). For each accepted
  connection it reads the dialed destination with `getsockopt(SOL_IP,
  SO_ORIGINAL_DST)`, connects to `/run/yaac/egress.sock`, writes a PROXY
  protocol v2 header ("Wire formats") naming that destination, and splices.
  A failed connect closes the client's connection.
- **Out, DNS** (`127.0.0.1:10302` UDP, `NETSHIM_DNS_PORT`). One question
  per query: an A query gets `DNS_SINKHOLE` with a 5 second TTL, anything
  else an empty NOERROR.
- **In** (`/run/yaac/ingress.sock`). It removes a stale socket, binds, and
  for each connection reads a two-byte port, connects to
  `127.0.0.1:<port>` and splices. Only the relay connects here, so the port is
  not checked.

Both listening ports sit below netstack's ephemeral range (16000 and up),
and both listeners are bound before the workspace container starts.

It is untrusted by position, though it is yaac's code: whatever header it
sends only chooses how the proxy reads the connection, and the proxy
applies the policy of the sandbox the connection came from.

The server's port detector hides `NETSHIM_TCP_PORT` with yaac's other infra
ports (`port-detector.ts`), since the workspace's `/proc/net/tcp` lists it.
streamd, and so the base image, does not change.

### The relay, and what is left of netd

The `yaac-netd` DaemonSet keeps two containers. A Go relay takes the place
of the Envoy, and the TypeScript program shrinks to the two jobs that
never touched the network, the swap bound and the memory-pressure kill,
with its node pod watch and the cgroup mount. netd's rule programming, its
listener ports and its watches of workspace pods and Services go.

The pod leaves the host network and no longer adds `NET_ADMIN` or
`NET_RAW`. The DaemonSet's Role is unchanged: the relay reads the
namespace's pods and Services with the same service account.

The relay is Go for three reasons. It is new code in either language. A Go
relay moved about 2.7 times what a Node one did upward, and the same down
and in bursts ("Spike results"). And the mountd module already has its two
awkward parts: a watch of a node's pods through client-go, and paths
opened by descriptor with no link followed.

It is two layers, in the mountd module and image:

- **`internal/sockets`**, which imports nothing of yaac or Kubernetes. It
  is given a root directory and told which units exist, each a directory
  name and an id. For each it binds `egress.sock` and hands every
  connection to a callback with the unit's id; it opens a unit's
  `ingress.sock` by descriptor on request; it rebinds a socket that goes
  missing; and it removes the directory of a unit that is gone. This is
  the half of the relay that docs/plans/pamir.md makes general, and the
  baseline its "carrying a socket" spike measures against. Nothing of
  Pamir's own (one connection per node, identities it issues, an API) is
  built here.
- **`cmd/relay`**, the glue for this driver: the pod and Service watch,
  the dial to the proxy, and the two listeners.

The relay container runs as root, mounts the socket root as a `hostPath`
at `/s`, and reads the proxy auth secret from `yaac-proxy-auth` as the
proxy does. The mount point is short on purpose. A unix socket's path is
capped at 107 bytes and is measured in the binder's own mount namespace.
The node path of an `egress.sock` can run past 110 with a UUID install
key, while `/s/<uuid>.<8 hex>/egress.sock` is 60.

Its units are the workspace and builder pods on its node, found by the
pod's `yaac.workspace-id` or `yaac.build-id` label and the `hostPath` of
its `sockets` volume (accepted only beneath the relay's own socket root):

- **Out.** It binds `egress.sock` in the pod's directory, mode `0666`,
  removing whatever is at the path first. For each connection it reads
  netshim's header, taking the destination and dropping every TLV, and
  opens one to the proxy's Service on `SOCKET_EGRESS_PORT` with a header
  of its own: the same destination, the pod's id and the proxy auth
  secret. A header that does not parse, or that arrives late, closes the
  connection. A running sandbox connects to a rebound socket with no
  restart.
- **In, streams** (`NETD_STREAM_PORT`). The server's dial starts with the
  same JSON line the proxy's relay takes today (`{token, workspaceId}`,
  compared in constant time). The relay connects to that workspace's
  `ingress.sock`, writes streamd's port and splices; streamd's own
  handshake and token follow, unchanged. Errors for one stream answer with
  an `{ok:false}` line, as the proxy's relay does, and the same deadline
  and keepalive apply.
- **In, sites** (`NETD_SITE_PORT`). See "Sites".

The descriptor open is `open(O_PATH | O_NOFOLLOW)`, an `fstat` that must
say socket, then a connect to `/proc/self/fd/<n>`. A connect by path
follows a link to any socket on the node.

A pod's directory is removed once a fresh list of the node's pods no
longer holds the pod, as mountd releases node-mounts directories. The
relay is ready once the socket root is mounted and its listeners are
bound, which it marks with a file an exec probe reads, as netd does
today. The PROXY header's reader and writer are `internal/pp2`, shared
with netshim.

### The proxy

- **One ingress port** (`socket-ingress.ts`, `SOCKET_EGRESS_PORT`). It
  reads netd's header, accepts it only when the secret TLV matches the
  proxy auth secret, takes the id from its TLV, and hands the connection to
  the handler the destination selects: port 443 to the SNI peek, the SSH
  sentinel address and port to the CONNECT reader, anything else to the
  HTTP server. The three handlers are today's, taking the id as an
  argument. The three transparent ports, and the source-address lookup
  behind them, go.
- **Identity is the registration.** A connection whose id has no
  registration is refused, which is also what keeps a spare offline until
  its claim. Whether an id is a build or a release comes from its
  registration: a build's ConfigMap carries the `yaac.build-id` label, as
  it does now, and a release's registration gains `release: true`
  (`buildProxyRegistration`, set where `launch.ts` sets the `yaac.site-id`
  label). `pod-watch.ts` and the Role's `pods` rule go.
- **Cluster services.** A registration gains `clusterServices`, a list of
  `host:port` the server lets this sandbox reach by name: the npm cache
  for a workspace that may use it, the main registry's pod port for a
  build. `forwardPlainHttp` dials an exact match as named, before the
  allowlist and exempt from the non-public guard, like every other
  destination the server names.
- **The DNS stub goes** (`dns-stub.ts`, the UDP listener). No pod resolves
  through the proxy.
- **The stream relay goes** (the listener on `RELAY_PORT`).

The registration feed, the allowlist, injection and the non-public guard
are untouched.

### The server's dial

`relayDial` (`substrate/stream-relay.ts`) keeps its protocol and changes
its address: the netd pod on the workspace's node, on `NETD_STREAM_PORT`.
The node comes from the workspace's pod in the cluster cache, and netd's
address per node from a cached list of netd pods refreshed on a miss or a
failed dial, as `mountdAddresses` does. A workspace whose pod has no node
yet, or whose node has no running netd, fails with `RelayDialError`, which
callers already treat as `unknown`.

### Sites

The router dials a release's pod IP today, through the site's headless
Service. A release has no address now, so:

- **The router's cluster for a site** dials `yaac-site-<id>` on
  `NETD_SITE_PORT` and sends a PROXY protocol v2 header with one TLV, the
  site id (Envoy's `upstream_proxy_protocol` transport socket with
  `added_tlvs`). The id is fixed for the site, so a flip changes nothing
  in the router's config.
- **The site's Service** loses its selector. The server writes its
  EndpointSlice: one address, the netd pod on the live release's node. The
  Service carries the live workspace id as an annotation
  (`yaac.live-workspace-id`) and the release's port as its `targetPort`.
- **The relay**, on a connection to `NETD_SITE_PORT`, reads the header, finds
  the site's Service in its watch, and splices to the `ingress.sock` of
  that workspace on its node with the Service's port. A site with no live
  release on this node gets a close.

A flip writes the annotation and, when the new release is on another node,
the address. The router re-resolves within a second, as now
(docs/public-sites.md "The router"). The site's own NetworkPolicy goes;
netd's ingress policy admits the router on the site port.

A netd pod's address changes whenever it restarts. The server's watch of
netd pods (the one behind the stream dial's address cache) raises the site
sync, which rewrites the EndpointSlice of every site whose live release is
on that node. Until it has, and the router has re-resolved, that node's
sites answer 503.

### The npm cache and the main registry

Both become destinations the proxy dials for a registration that names
them, by the same name and port as today, so `~/.npmrc`, `buildkitd.toml`
and the registry auth file do not change.

- **The npm cache.** `launch.ts` decides as it does now, and writes the
  cache's `host:port` into `clusterServices` instead of labelling the pod
  `yaac.npm-cache`. The cache's ingress policy admits the proxy in place of
  labelled workspaces, and `yaac-npm-cache-workspace-egress` goes. The
  cache's own egress policy becomes the shared floor (`wideEgress`) on
  port 443, so nothing reads pod CIDRs any more.
- **The main registry.** A build's registration names the registry's pod
  port. The registry's ingress policy admits the proxy's pods on that port
  in place of builders. The gate still asks for the build's grant, which
  travels in the request's `Authorization` header, so what a build may read
  and write is decided where it is today.

The proxy's egress policy gains both, by selector. So that the opening
adds no reach, the proxy refuses a destination named as a Service of the
install's namespace, or as the main registry, unless the registration's
`clusterServices` holds it (the test `dns-stub.ts` makes today, moved to
`upstream.ts`). One case is left, and docs/workspace-egress.md lists it
with the other exceptions to "takes both": an exact allowlist entry naming
the *address* of either reaches it. That exposes the npm cache, which
serves public packages, and the registry's pod port, which serves a
protected repo only to a grant.

### Policies

| Policy | Change |
|---|---|
| `yaac-workspace-egress`, `yaac-workspace-ingress-lock`, `yaac-builder-egress`, `yaac-npm-cache-workspace-egress`, the per-site policy | deleted |
| `yaac-netd-ingress` (new) | the server's pods on `NETD_STREAM_PORT`, the site router on `NETD_SITE_PORT` |
| `yaac-netd-egress` (new) | the proxy on `SOCKET_EGRESS_PORT`, the apiserver, DNS |
| `yaac-proxy-ingress` | netd's pods on `SOCKET_EGRESS_PORT`, the server on the control port; the node CIDRs and the DNS rule go |
| `yaac-proxy-egress` | adds the npm cache and the registry's pod port; loses workspaces on 10300 |
| `yaac-server-egress` | netd on `NETD_STREAM_PORT` in place of the proxy's relay port |
| `yaac-site-router-egress` | netd on `NETD_SITE_PORT` in place of pods labelled `yaac.site-id` |
| `yaac-npm-cache-ingress`, `yaac-registry-ingress` | the proxy in place of workspaces and builders |
| `yaac-egress-world-deny` | its selector stops leaving out workspace and builder pods, so policy too denies them all egress |

The builder role guard accepts the new RuntimeClass.

### Wire formats

All three headers are PROXY protocol v2 (`0D 0A 0D 0A 00 0D 0A 51 55 49 54
0A`, version and command `0x21`), which the proxy's `pp2.ts` already
parses, TLVs included.

| Hop | Family | Addresses | TLVs |
|---|---|---|---|
| netshim to the relay | `0x11` (TCP over IPv4) | source: the client's loopback address and port; destination: the address and port dialed | none; the relay drops any |
| the relay to the proxy | `0x11` | copied | `0xE0`: the workspace or build id; `0xE1`: the proxy auth secret |
| the router to the relay | as Envoy writes it | unused | `0xE0`: the site id |

`ingress.sock` takes a two-byte big-endian port before the stream.

New constants, in `substrate/proxy-constants.ts` and mirrored where a
sidecar cannot import it:

| Constant | Value |
|---|---|
| `SOCKET_EGRESS_PORT` | 10261 |
| `NETD_STREAM_PORT` | 10262 |
| `NETD_SITE_PORT` | 10263 |
| `NETSHIM_TCP_PORT` | 10301 |
| `NETSHIM_DNS_PORT` | 10302 |
| `SOCKETS_NODE_ROOT` | `/var/lib/yaac/sockets` (`storage-constants.ts`) |
| `RUNTIME_CLASS_GVISOR` | `gvisor-nonet`, handler `runsc-nonet` |

## Calico leaves kind and the Hetzner stack

kind's own CNI enforces NetworkPolicy but lets a new pod's first packets
through before the pod is programmed, which was disqualifying while a
workspace's wall was a policy. After this plan every pod that runs
untrusted code has no interface. The policies that remain surround yaac's
own pods (the server, the proxy, the registries, the npm cache, the site
router and tunnels, netd, mountd), and on a kind cluster nothing
else has an address to dial them from. A moment of open policy at one of
those pods' birth exposes it to no one, and the two checks that matter
most do not rest on policy at all: the proxy's non-public guard refuses a
steered dial to a cluster address, and the relay, mountd and the proxy
each ask their caller for a secret.

So `k8s/kind-config.yaml` drops `disableDefaultCNI`, and install drops the
Calico apply, its image sideload and the pinned manifest. A cluster made
earlier keeps the Calico it was created with, which goes on enforcing the
same policies.

`infra/hetzner-k3s` drops Calico for the same reason: the cluster is
yaac's own, and what else runs there (the cloud controller, the volume and
NFS drivers, the autoscaler, the Tailscale operator) is the stack's. It
goes back to what k3s ships:

- `flannel-backend: none` and `disable-network-policy: true` leave the k3s
  config, so flannel's VXLAN carries pod traffic over the private network
  and k3s's own controller enforces policy. Flannel is pinned to the
  private interface, and takes its MTU from it.
- The Tigera operator chart, the Calico CRD chart and the
  `FelixConfiguration` manifest go, and with the last the mark mask that
  kept Felix's bits off the ones tailscaled claims.
- `proxy-mode=iptables` is no longer pinned for netd's rules, and
  `YAAC_KUBE_PROXY_EXTERNAL=1` leaves the control node's environment.

A running cluster is switched in place. Its servers, their disks and the
k3s datastore on the control node stay as they are:

1. `tofu apply` rewrites the k3s config and removes the Calico manifests,
   through the step that already re-runs when either changes
   (`control.sh.tftpl`), and the operator's removal takes calico-node with
   it.
2. Each node is rebooted, workers first and the control node last. A
   reboot is what clears Calico's rules, routes and interfaces from the
   node and brings every pod back with an address from flannel. Pods that
   kept a Calico address beside flannel's would collide with them, since
   both allocate from the same pod range.

A node's reboot stops the workspaces on it, which restart from their
checkpoints, and the control node's takes the server down for as long as
it lasts. The stack's README gets these steps.

`--byo` into any other cluster asks only that NetworkPolicy be enforced,
by any engine, Cilium included, and `yaac cluster check` probes that
between two of yaac's own pods. A cluster shared with other workloads is
the one place a pod's first packets still matter, since a foreign pod
could dial the server's; the check's detail says so.

## Spike results

Run on 2026-11-25 on a kind rig: gVisor release-20261005.0 under
containerd 2.3.4, Kubernetes 1.37, Calico, with a second handler holding
the flags above. The prototypes were a Go netshim, a Go and a Node relay
on the node, and a relay mode that routed by SNI and Host header in the
proxy's place.

1. **No interface plus host sockets, in a pod.** Passed. A two-container
   pod turns Ready with only `lo`. A socket a node pod bound in the
   `hostPath` directory is connectable from inside (a caller running as
   uid 1000 was refused until the socket was mode `0666`), and one bound
   inside as root is connectable from the node. All containers of the pod
   share the one loopback.
2. **Addresses on loopback.** Passed, by a different route than planned.
   Assigning prefixes to `lo` is not needed: a `0.0.0.0/0` route on `lo`
   plus one `nat OUTPUT REDIRECT` rule sends a dial to any IPv4 address and
   port to a local listener, and `SO_ORIGINAL_DST` returns what was
   dialed. `127.0.0.1` behaves. UDP 53 redirects the same way, with the
   reply's source restored. The rule needs `CAP_NET_ADMIN`, `CAP_NET_RAW`
   and so the `net-raw` flag; without `net-raw`, `iptables` reports that
   the table does not exist.
3. **Throughput.** Passed, on a host that was running two other suites
   (load 9 to 13), so the figures are rough. Against a gVisor pod with an
   interface and one TCP hop standing in for netd's Envoy:

   | | Interface + hop | Socket path, Go relay | Socket path, Node relay |
   |---|---|---|---|
   | 1 GiB download | 430 to 460 MB/s | 230 to 280 MB/s | 160 to 250 MB/s |
   | 512 MiB upload | 117 MB/s | 154 MB/s | 58 MB/s |
   | 2000 fresh connections, 50 at a time | 530 to 550 /s | 560 to 650 /s | 490 to 590 /s |

   Through the name-routing relay to the internet, a `git clone --depth
   50` of `git/git` took 33 s against 35 s direct, and a cold `npm
   install` of a Vite app 19 s against 16.5 s. Inbound, 1000 requests to a
   Vite dev server ran at 99 /s through the relay against 125 /s on
   loopback inside the sandbox. A relay restart, which rebinds
   `egress.sock` at the same path, was picked up by running sandboxes with
   no restart. The proxy was not in either path, which is fair for
   internet egress, where both go through it.
4. **Supervision.** Passed, with netshim as its own container. Root in
   the workspace container cannot see its process, and gets `EPERM`
   changing addresses, routes or the link, and can neither read nor
   change the NAT table.
   When netshim is killed, dials fail at once with a refused connection,
   nothing else becomes reachable, and kubelet has it back within about a
   second; the route and rules were still in place. With no listener on
   `egress.sock`, a dial to the internet, the server, the apiserver, the
   kubelet and another sandbox all fail.
5. **Tools that want an interface.** Passed, once the pod's address is on
   loopback. Without it a JVM's bind to `getLocalHost()` fails with "Cannot
   assign requested address"; with it, and the `RETURN` rule, the JVM, an
   Erlang node (`erl -sname`, epmd registration and a self ping), Vite
   (`--host`) and Next start and serve. claude, codex, opencode, pi and omp
   each ran a prompt as far as their provider's rejection of a fake key. A
   dummy interface is not needed.
6. **Links in the directory.** Passed. With `ingress.sock` replaced by a
   link to another socket in the relay's mount namespace, a connect by
   path reached that socket; the descriptor open refused the link, a
   regular file and a directory, and still connected to the real socket.
   Since only netshim's container mounts the directory, code a project
   wrote cannot plant a link at all.
7. **A build.** Passed. With the rig's BuildKit image and
   `--oci-worker-net=host` under the no-interface handler, a build pulled
   its parent from Docker Hub, its `RUN` steps resolved names (the step's
   `resolv.conf` kept the sinkhole address) and reached hosts over HTTPS
   and plain HTTP, and its result was pushed to a plain-HTTP registry
   named by a cluster Service.

Two things the final pod shape taught: with a read-only root filesystem
`iptables` cannot create its lock under `/run`, so the netshim container
keeps a writable root; and Alpine's `iptables-legacy` package needs
`iptables` beside it. The pinned Envoy (v1.34.0) was also run with the
router's planned cluster config, and its upstream header carried the TLV.

Still true from the earlier check (2026-07-23): with no route off the
sandbox, raw and packet sockets give no way around.

### Not tried

- **Registry and npm cache traffic through the proxy.** A build's parent
  pull and layer push, and a workspace's cache fetches, reach their pods
  directly today. They will cross netshim, the relay and the proxy's
  `forwardPlainHttp`, and no multi-gigabyte layer was sent that way.
  Phase 2 measures it before anything else is built on it ("Phases").
- **mountd on the new handler.** The rig's install predates mountd, so a
  bind into a no-interface sandbox (`runsc exec` into the workspace
  container) and a claim were not run. Nothing in them touches the
  network, and phase 2 proves it with the check's `mountd` gate on
  `gvisor-nonet`.
- **A tighter socket.** `egress.sock` was mode `0666` in a directory
  kubelet made (`0755`, root).

### Not run: the default CNIs

Spike 8 needs a kind cluster created without `disableDefaultCNI`, which
would have been a fourth cluster on a host that runs three, and a throwaway
Hetzner stack. It gates phase 3 only, and runs first there:

- A kind cluster on kindnet, and a Hetzner stack on flannel and k3s's
  policy controller, each pass `yaac cluster check` and the `e2e` tier
  with phase 2 installed, and the policies around yaac's pods are enforced
  once each pod is up.
- On the Hetzner stack: flannel works against the host's containerd, which
  looks for CNI plugins and config in its own directories, not the ones
  k3s fills for its embedded one; the in-place switch above works on a
  throwaway stack that starts on Calico with workspaces running; and the
  server's tailnet Ingress works, with a pod's traffic to the tailnet
  taking the tailnet, which Calico needed a mark mask for.

## Phases

Three changes. The second is a cutover: one release makes every pod in the
new shape and deletes the redirect, and nothing carries both.

### 1. The parts, with no user

Everything that can exist beside today's datapath without changing it.

- **netshim.** `k8s/mountd/cmd/netshim/` (`main.go`, `netshim.go`,
  `netshim_test.go`), and the two packages in `k8s/mountd/Dockerfile`.
  Tests, under `pnpm test:mountd`, drive the three listeners over real
  loopback and unix sockets with the setup commands stubbed: the header it
  writes for a given destination, the stub's answers by query type, and
  the ingress preamble. Nothing runs it yet.
- **The second handler.** `gvisor-runtime.ts` writes `runsc-nonet.toml`
  and appends the handler's block under a marker of its own, since a node
  that already has the first block is never rewritten; `gvisor-installer.ts`
  applies the `gvisor-nonet` RuntimeClass. No pod names it.
- **The proxy.** The three handlers in `k8s/proxy/main.ts` take a resolved
  id. `socket-ingress.ts` listens on its port, which no policy admits yet.
  `objects.ts` decodes `release`, the build label and `clusterServices`,
  and `forwardPlainHttp` honors the last. `isBuild` and `isRelease` say yes
  when either the registration or the pod index does, since a registration
  an older server wrote has no `release`. `buildProxyRegistration` writes
  `release`.
- **The relay.** `k8s/mountd/internal/sockets`, `internal/pp2` and
  `cmd/relay`, built into the mountd image. No DaemonSet runs it.
- **Constants** from "Wire formats".
- **Tests.**
  - Go tests under `pnpm test:mountd`. `internal/sockets` against real
    unix sockets in a scratch directory: a bind, a rebind, a planted link,
    a regular file and a directory refused, a gone unit's directory
    removed. `cmd/relay` over client-go's fake and loopback TCP: the
    header it writes to the proxy, a refused header, a stream dial's auth
    line and its `{ok:false}` answers, a site connection routed by
    Service.
  - `k8s/proxy/test/socket-ingress.test.ts` (the secret, the id, the
    handler picked per destination), and `clusterServices` cases in the
    dispatch test.

### 2. The cutover

It merges as one change, since no half of it leaves a working install.

Built first on the branch, and measured before the rest: the relay in the
DaemonSet and the builder's pod shape, enough to build the stock tools
image in a no-interface builder. It passes if the build's parent pull and
its push each hold 100 MB/s on an idle rig, or the whole build takes no
more than a fifth longer than today's. If it does not, the proxy splices a
`clusterServices` connection after reading its first request head, which
every request on that connection shares, in place of re-serializing each
request.

- **Pod shape.** `pod-spec.ts` gains `netshimContainer`, `socketVolume`
  and `socketsNodePath()`, and `RUNTIME_CLASS_GVISOR` names the new class.
  `pod-job.ts`, `spares.ts`, `launch.ts` and `builder-pod.ts` add the
  container and volume and lose `proxyHost`.
- **netd.** `netd.ts` keeps the swap bound and the pressure kill, and
  `k8s-watch.ts` its node pod watch; the image loses `iptables`,
  `iproute2` and `conntrack`. `cluster/netd.ts` applies the DaemonSet in
  its new form under the same name, with the relay container on the
  mountd image, so the rollout replaces each node's pod; the old pod
  removes its own chain as it exits, as it does on any shutdown.
- **The proxy.** The transparent listeners, the pod watch, the DNS stub
  and the relay listener are deleted with their ports and the Role's
  `pods` rule. Identity is the header's, and build and release are the
  registration's alone.
- **The server.** `relayDial` dials netd. `launch.ts` and `builder-pod.ts`
  write `clusterServices`. `site-edge.ts` writes each site's Service,
  EndpointSlice and router cluster in the new form, and the server's Role
  gains write on EndpointSlices. `port-detector.ts` hides netshim's port.
  The policies change as in "Policies".
- **What the upgrade does to what is running.** A pod made before the
  upgrade has an interface and nothing left to carry its traffic, so the
  server stops it at its first start:
  - **Workspaces.** The driver answers which running workspaces are on a
    pod of an older shape (under `k8s`, the `gvisor` class; under
    `containerless`, none), and a startup step in `#domain/workspaces`
    stops each with `stopWorkspaces`, as a user's stop does. Its tree
    container takes the final checkpoint on the way down, and a restart
    brings the workspace back from it. A turn that was running is lost.
  - **Site releases.** A user's stop refuses a release, so the server
    removes the runtime of each live one itself, and the path that
    replaces an evicted release redeploys it in the new shape
    (docs/public-sites.md "A live release whose runtime is gone"). The
    site is down for the length of that deploy. A handoff with no gap
    would need the router to reach both shapes at once, which is the
    coexistence this cutover does without.
  - **Spares and builders.** Both are already reaped at start: a spare
    never outlives its server, and `deleteLeakedBuilderPods` removes the
    last server's builders.
  - **Retired objects.** The server deletes the four retired policies by
    name. Per-site policies go with the site sync's prune.
  - docs/legacy-compat-shims.md gets two entries. "Workspaces on the
    `gvisor` class": the stop reads pods by RuntimeClass; without it a
    workspace from before the upgrade lists as running with no egress and
    no terminal; it may go once no supported upgrade starts from a release
    with the redirect. "The redirect's policies": a delete-only sweep by
    name, harmless if it goes early on a cluster where it already ran, and
    safe to remove on the same condition. The `gvisor` RuntimeClass and
    `runsc` handler are no longer applied and, like `gvisor-nested` before
    them, are never deleted from a cluster; that entry gains both.
- **Deleted.** Everything under "What goes" but the kind and Hetzner
  items, with the tests of each: the byo CNI cases of `install.test.ts`
  and `cluster-cli`, `cluster-cidrs.test.ts`'s pod CIDR cases, the proxy's
  pod watch and DNS stub tests, and `netd-datapath.test.ts` and
  `transparent-egress.test.ts`, whose assertions about the allowlist, MITM
  and DNS move into `socket-egress-suite`. The Envoy mirror stays: the
  router, the registry gate, the fronting and the token endpoint use it.
- **Tests.**
  - Server unit tests in the files of the modules changed, over the
    cluster stub: `cluster/netd`, `cluster/policy-manifests`,
    `cluster/site-edge`, `cluster/npm-cache`, `cluster/main-registry`,
    `substrate/stream-relay`, `substrate/pod-spec`, `workspaces/pod-job`,
    `workspaces/port-detector`, `images/builder-pod`,
    `egress/proxy-registration`, and the startup stop in
    `domain/workspaces`.
  - `test/apiserver/object-api.test.ts` round-trips the new policies and
    the EndpointSlice.
  - `test/e2e/socket-egress-suite.test.ts`: the acceptance test below, a
    forwarded port, a restart of the relay and of netshim under a running
    workspace, a site served and flipped, a build that pulls and pushes,
    and an npm install through the cache.
  - `workspace-create-suite` asserts the ingress lock by dialing a pod on
    10300 from the proxy; it asserts instead that nothing answers at the
    pod's address. Nothing in `src` port-forwards into a workspace pod:
    forwards already ride streamd.
- **The check.** `egress` is the acceptance test. `mountd` binds its probe
  pod on `gvisor-nonet`, which is the proof that a bind and a claim need
  no interface. `sites` and `npm-cache` probe through netd and the proxy,
  with requests where they made connects. `datapath` waits on netd alone,
  and `veth-source` goes. `--byo`'s gate is the one enforcement probe.
- **By hand, on a rig, before it merges.** Install the release before
  this one, start a workspace with unsaved work and publish a site,
  upgrade, and confirm the workspace is stopped and restarts with its
  work, and the site is redeployed and serves again with no one touching
  it.
- **Docs** under "Docs when it ships".

### 3. The default CNIs

After the spike above passes. New kind clusters and the Hetzner stack are
created without Calico, and their items under "What goes" are deleted.

### The acceptance test

As an e2e case and as the check's `egress` gate: as root in a workspace
and in a `RUN` step, fail to reach the server, the apiserver, a node
address, a second sandbox, a literal internet address and a node socket
outside `/run/yaac`, while an allowlisted host succeeds. A dial here always
connects, so each failure is asserted on a completed request, never on a
connect (docs/workspace-egress.md "Probe egress with real requests").

## What goes

- `k8s/netd`'s `iptables.ts`, `rules.ts`, `routes.ts`, `listeners.ts`,
  `ports.ts`, `envoy-config.ts` and `envoy-admin.ts`, the reconcile in
  `netd.ts`, the pod and Service watches in `k8s-watch.ts`, their tests,
  the Envoy container, and `iptables`, `iproute2` and `conntrack` from its
  image.
- The proxy's `pod-watch.ts` and `dns-stub.ts`, its three transparent
  listeners and its relay listener, with `TRANSPARENT_*_PORT`,
  `RELAY_PORT`, `POD_STREAM_PORT` and `DNS_STUB_PORT`.
- The policies marked deleted in "Policies", `LABEL_NPM_CACHE`, and the
  `NETD_LISTENER_*` constants.
- `cni-adopt.ts` and the CNI gate, down to the one enforcement probe:
  the `veth-source` check, kube-proxy detection, the eBPF refusal,
  `YAAC_CNI_VETH_PREFIX`, `YAAC_POD_CIDRS`, `YAAC_KUBE_PROXY_EXTERNAL`,
  and `clusterPodCidrs` and `podCidrSources` in `cluster-cidrs.ts`.
- On kind: `installCalico`, `sideloadCalicoImages`, `k8s/calico`, and
  `disableDefaultCNI`.
- In `infra/hetzner-k3s`: the two Calico charts, the Felix manifest and
  its step in `control.sh.tftpl`, the flannel and policy switches, the
  kube-proxy pin and `YAAC_KUBE_PROXY_EXTERNAL`.
- From docs/workspace-egress.md: "The datapath", "Why DNAT and not
  TPROXY", "Which pods are redirected", "What this datapath requires of a
  CNI" and "Managed-cloud portability".

## Risks

- **The upgrade stops every running workspace once.** Each restarts from
  its checkpoint, and an agent's turn in flight is lost. Every site is
  down while its release is redeployed, the one upgrade that drops a site;
  the release notes say so.
- **`host-uds=all` lets a sandbox connect to any node socket it can see.**
  That is true today. The socket directory is the only mount that holds
  one, only netshim's container has it, and the acceptance test checks the
  workspace container sees none.
- **netshim is one more thing that can break a sandbox's network.** Its
  failure is closed, and kubelet restarts it. A workspace process that
  takes port 10301 while netshim is down keeps it down, which costs that
  workspace its own network and nothing else.
- **`egress.sock` is mode `0666` on the node.** That is the mode the spike
  ran with, and a connect from uid 1000 inside needed it. Anything on the
  node that can reach the directory gets that sandbox's egress. Whether
  netshim, as uid 0, connects to a `0600` socket, and whether the directory
  can be `0700`, were not tried; phase 2 tries both and takes the tightest
  that works.
- **Two relay hops through sockets** replace a kernel redirect and an
  Envoy. Internet egress measured at parity for real workloads.
- **Builds and cache fetches gain the proxy.** Every parent pull, layer
  push and npm cache fetch crosses the relay and the proxy's HTTP forwarder,
  where today each is one direct dial. It was not measured; phase 2 opens
  with it and names what changes if it is too slow.
- **The relay is on every stream and every site request.** A restart of
  a node's netd pod drops that node's terminals and forwards, which
  reconnect, where a proxy restart drops every node's today. It also takes
  that node's sites down until the server has rewritten their endpoints,
  where today netd is not in a site's path at all. The DaemonSet rolls one
  node at a time.
- **A site's release is guarded by policy alone.** The relay's site port takes
  no secret, so the router's identity checks hold only while policy keeps
  everything but the router off that port, as a release's own policy does
  today.
- **The policies around yaac's own pods become defense in depth on kind
  and the Hetzner stack.**
  That holds only while every pod with an interface is one yaac wrote. A
  new kind of pod that runs untrusted code must take the socket path, and
  the reference doc says so.
- **A client that waits for the server to speak first** (ssh to a port
  other than the sentinel's, a database) hangs on any address now, where a
  literal address is dropped today.

## Docs when it ships

`docs/workspace-egress.md` is rewritten around the socket datapath,
`docs/stream-relay.md` around the dial through netd, and
`docs/image-builds.md` "Build egress" around a build's path to the
registry. `docs/generic-workspace-pods.md` gains the netshim container and
the socket directory, `docs/public-sites.md` "The router" the dial through
netd, `docs/workspace-storage.md` "Package installs" the cache's new path,
and `docs/auto-forward-ports.md` the hidden port.
`docs/server-in-cluster.md` names netd where it names the proxy's relay.
`docs/cluster-setup.md` loses "The CNI gate" down to the enforcement
probe, and its Linux sections lose what they say about Calico.
`docs/environment-variables.md` loses the three CNI variables.
`infra/hetzner-k3s/README.md` loses its Calico and kube-proxy rows and
gains the in-place switch. docs/legacy-compat-shims.md gains the entries
phase 2 names.

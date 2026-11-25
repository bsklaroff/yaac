# Socket egress: sandboxes without a network interface

A proposal, not built. A workspace or builder sandbox gets no network
interface beyond loopback. Everything that crosses its boundary goes
through unix sockets in one directory the node mounts into it. That
replaces the datapath in docs/workspace-egress.md (a veth redirect on the
node, a NetworkPolicy wall around each pod, identity by pod IP) with one
that needs nothing from the network the sandbox runs on.

The proxy, the allowlist, credential injection and the MITM CA do not
change. Only how a connection gets from a sandbox to the proxy, and from
the server to a workspace, changes.

This is built under the `k8s` driver, on the clusters yaac runs on today.
Once no untrusted pod has an interface, the cluster's CNI no longer
matters to yaac, so kind and `infra/hetzner-k3s` go back to their defaults
and Calico is no longer installed on either. It is also what lets a later
driver run workspaces with no cluster at all
(docs/plans/off-kubernetes.md).

## What this builds on

- **Generic workspace pods have shipped** (docs/generic-workspace-pods.md).
  Every workspace pod has one shape, with an id from creation, and a spare
  belongs to no project until its claim.
- **BuildKit builds have shipped** (docs/image-builds.md). A builder pod is
  redirected and policed like a workspace pod: it has a registration, the
  proxy tunnels its traffic under the project's allowlist and injects
  nothing, and the server drives it with `kubectl exec`. Its only direct
  dial is the main registry's pod port.

So every pod that runs code yaac did not write is already behind the
proxy, and this plan moves them all the same way.

## The contract

Each sandbox has one directory on its node, mounted at `/run/yaac` and
named for the workspace or build id. It is a fixed part of the pod's
shape, beside its node-mounts directory:

| Socket | Bound by | Carries |
|---|---|---|
| `egress.sock` | netd, on the node | every outbound connection the sandbox makes |
| `stream.sock` | streamd, inside a workspace | exec, ctrl, pty, the `ports` stream and `tcp` dials to the workspace's ports (docs/stream-relay.md) |

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

- **DNS.** netshim (below) answers every name with the sinkhole address, as
  the proxy's stub does today for every name but the install's own
  Services. The pod's `dnsConfig` names a fixed address in the sinkhole
  range where netshim listens, where today it names the proxy.
- **Routing by name.** The proxy still routes by SNI, by the Host header,
  or by the SSH sentinel port. Git over SSH, CA trust, the allowlist and
  `yaac.internal` behave as documented.
- **Addresses.** The sinkhole range is assigned to loopback, so a dial to a
  name connects to netshim. A dial to a literal address should work the
  same way if the whole IPv4 space can be made local to loopback (spike 2).
  If it cannot, plain HTTP to an allowlisted address and TLS to a
  hard-coded address stop working. HTTPS to a bare address does not work
  today either, for lack of SNI.
- **`ip addr` shows only `lo`.** A tool that picks its bind or node address
  from a non-loopback interface needs configuring (spike 5).
- **One visible process.** netshim runs inside. Root in the sandbox can
  kill it, which costs that sandbox its network and opens nothing.

## The parts

### The runtime

The gVisor installer adds `network=none` to the runsc handler's flags
(`host-uds=all` is already among them). Workspace and builder pods are the
handler's only users, so there is still one handler and one RuntimeClass.
A pod still has a CNI address, which nothing uses: every probe and hook of
these pods is an exec.

### netshim

A small program started as root when the sandbox boots, mounted from the
install rather than baked into the image, so a project's own Dockerfile
gets it too. It:

- assigns the sinkhole range to loopback and answers DNS there;
- accepts connections on 443, 80, the SSH sentinel, and any other port of
  the sinkhole;
- forwards each to `/run/yaac/egress.sock`, prefixed with a PROXY-protocol
  v2 header naming the destination the client dialed;
- serves `SSH_AUTH_SOCK`.

It is untrusted. Whatever header it sends only selects which of the
proxy's listeners handles the connection, and the proxy applies the policy
of the sandbox the connection came from. In a workspace streamd supervises
it and restarts it under a name of its own, so a stray `pkill node`
neither matches it nor leaves the workspace offline. In a builder it runs
beside `buildkitd`, and the `RUN` steps' containers share the loopback it
listens on.

### netd becomes a relay

netd keeps its DaemonSet, its pod watch, the swap bound and the
memory-pressure kill. Its rule programming, its Envoy and its listener
ports go. In their place, for each workspace and builder pod on its node:

- **Out.** It binds `egress.sock` in the pod's directory. For each
  connection it reads netshim's header and opens one to the proxy's
  matching transparent port, with a header of its own carrying the
  workspace or build id and the install's proxy secret.
- **In.** It listens for the server. A dial names a workspace and carries
  the secret; netd connects to that workspace's `stream.sock` and splices.
  streamd's own handshake and token follow, unchanged.

The id comes from the pod's `yaac.workspace-id` or `yaac.build-id` label,
which only the server writes, as for the redirect today. A pod's directory
is writable by root inside it, so netd opens what it finds there by
descriptor and never follows a link: a planted `stream.sock` that points
at another socket on the node is refused. netd removes a directory when
its pod is gone.

netd no longer needs `hostNetwork`, `NET_ADMIN` or `NET_RAW`. It is a pod
on the pod network, so the policies that admit it select it by label where
today's name node addresses.

### The proxy

- **Identity** comes from netd's header: the id, accepted only with the
  secret. The pod watch and the PP2 source-address lookup go. What the
  proxy reads from a pod's labels today (a site release, a build) is
  already in the registration or moves there.
- **The DNS stub goes.** No pod resolves through the proxy.
- **The stream relay goes.** The server dials the workspace's node's netd
  directly, found as it finds a node's disk pod (`disk.ts`).

The registration feed (the Secret and ConfigMap watch), the allowlist,
injection and the non-public guard are untouched. A spare has no
registration, so its connections are refused: a spare has no egress until
its claim.

### streamd

One new option, `YAAC_STREAM_SOCKET`: listen on a unix socket in the
mounted directory in place of `0.0.0.0:10300`. The handshake, the stream
kinds and the token are unchanged.

### What else dials a sandbox, or is dialed by one

- **Sites.** The router dials a release's pod IP today, through the site's
  headless Service. A release gets a second socket, `site.sock`, where
  streamd accepts and splices to the site's port with no handshake, which
  is what a pod port offers today. netd gives each release on its node a
  port of its own and splices it to that socket. The server writes the
  site's endpoints to name that netd address, so the router and its
  re-resolving flip stay as they are (docs/public-sites.md "The router").
- **The npm cache.** A workspace dials the cache's pod today, under a
  label-scoped policy. It becomes a destination the proxy dials for a
  workspace whose registration allows it, by the same name and port, so
  `~/.npmrc` does not change.
- **The main registry.** A builder dials the gate's pod port today, under
  a policy that admits builders and the server. It becomes a destination
  the proxy dials for a build's registration and for nothing else. The
  gate still asks for the build's grant, so what a build may read and
  write is decided where it is today.

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
steered dial to a cluster address, and netd, mountd and the proxy
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

## What goes

- `k8s/netd`'s `iptables.ts`, `rules.ts`, `routes.ts`, `listeners.ts`,
  `ports.ts` and both Envoy modules, and the Envoy mirror image.
- The proxy's `pod-watch.ts` and `dns-stub.ts`, and its relay listener.
- The workspace egress and ingress-lock policies, the builder egress
  policy, the npm cache's per-workspace ones, and the registry's admission
  of builders.
- `cni-adopt.ts` and the CNI gate, down to the one enforcement probe:
  the `veth-source` check, kube-proxy detection, the eBPF refusal,
  `YAAC_CNI_VETH_PREFIX`, `YAAC_POD_CIDRS`, `YAAC_KUBE_PROXY_EXTERNAL`,
  and the pod-CIDR half of `cluster-cidrs.ts`.
- On kind: `installCalico`, `sideloadCalicoImages`, `k8s/calico`, and
  `disableDefaultCNI`.
- In `infra/hetzner-k3s`: the two Calico charts, the Felix manifest and
  its step in `control.sh.tftpl`, the flannel and policy switches, the
  kube-proxy pin and `YAAC_KUBE_PROXY_EXTERNAL`.
- From docs/workspace-egress.md: "The datapath", "Why DNAT and not
  TPROXY", "Which pods are redirected", "What this datapath requires of a
  CNI" and "Managed-cloud portability".

## What is already known

- `host-uds=all` is in production. The runsc handler sets it today
  (`gvisor-runtime.ts`), so sockets on a host-backed mount already cross
  the sandbox boundary in both directions.
- runsc's `--network=none` "sets up just loopback using netstack"
  (`runsc/config/config.go`), so in-sandbox TCP, UDP and iptables keep
  working without an interface.
- IPv4 loopback in netstack treats every address in an assigned prefix as
  local (`endpoint.AcquireAssignedAddress` in
  `pkg/tcpip/network/ipv4/ipv4.go`), and netlink handles `RTM_NEWADDR`
  and `RTM_NEWROUTE` for a caller with `CAP_NET_ADMIN`. Read from source,
  not run.
- Checked against a live runsc sandbox on 2026-07-23 (release-20260706.0):
  netstack has working `nat` rules and conntrack; `SO_ORIGINAL_DST` works
  for a listener in the same netstack; a destination with no route puts
  nothing on the wire; and raw and packet sockets give no way around
  either, even with `CAP_NET_RAW`.

## Spikes

Each decides something, so they run before any phase, on a kind rig.

1. **No interface plus host sockets, in a pod.** With `network=none` on
   the handler: a generic pod starts and turns Ready, connects out through
   a socket a node process bound in its hostPath directory, and accepts on
   one it bound itself.
2. **Addresses on loopback.** Assign the sinkhole prefix to `lo` as root
   inside and confirm a dial anywhere in it reaches a local listener. Then
   assign prefixes covering all of IPv4 and confirm that a dial to any
   literal address reaches netshim, that `getsockname` reports the address
   dialed, and that `127.0.0.1` still behaves. If that fails, try a `nat
   OUTPUT REDIRECT` rule with a route on `lo`. The result decides whether
   literal addresses keep working.
3. **Throughput.** A streaming model request, a large `git clone`, an `npm
   install` with 50 concurrent connections, a site under load, and a build
   that pulls and pushes a multi-gigabyte layer, against today's path.
   Confirm a netd restart, which rebinds the sockets at the same paths, is
   picked up without restarting the sandbox.
4. **Supervision.** Kill netshim as root inside and confirm egress stops,
   nothing else becomes reachable, and streamd brings it back.
5. **Tools that want an interface.** Run each agent CLI, a Vite and a Next
   dev server, and a JVM and an Erlang node with only `lo`. If something
   common breaks, try a dummy interface with no route.
6. **Links in the directory.** As root inside, replace each socket with a
   link to another socket on the node and confirm netd refuses it.
7. **A build.** A `RUN` step resolves a name and reaches an allowlisted
   host through netshim, and `buildkitd` pulls its parent and pushes its
   result through the proxy. BuildKit drops loopback resolvers from a
   step's `resolv.conf`, which is one reason netshim's DNS address is in
   the sinkhole range and not `127.0.0.1`.
8. **The default CNIs.** A kind cluster created without
   `disableDefaultCNI`, and a Hetzner stack on flannel and k3s's policy
   controller, each pass `yaac cluster check` and the `e2e` tier, with the
   policies around yaac's pods enforced once each pod is up. On the
   Hetzner stack, also confirm:
   - flannel works against the host's containerd. That stack runs k3s on
     the node's own containerd, which looks for CNI plugins and config in
     its own directories, not the ones k3s fills for its embedded one;
   - the in-place switch above, rehearsed on a throwaway stack that starts
     on Calico with workspaces running;
   - the server's tailnet Ingress works, and a pod's traffic to the
     tailnet takes the tailnet, which Calico needed a mark mask for.

## Phases

1. **The seams, with no behavior change.** A `WorkspaceIdentity` seam in
   the proxy with today's lookup behind it. streamd's socket option.
   netshim, with tests of its own and no user.
2. **The socket path beside the redirect.** `network=none` on a second
   handler for now, with its own RuntimeClass. netd's relay in both
   directions, the proxy's identity from netd's header, the server's dial
   through netd, `site.sock`, and the npm cache and the registry through
   the proxy. A pod is made in one shape or the other by an install
   setting that defaults to the redirect, and the `e2e` tier runs with it
   on.
3. **The default.** Every new workspace and builder pod has no interface.
   A pod made before the upgrade keeps the redirect until it stops, so
   netd carries both for one release, with an entry in
   docs/legacy-compat-shims.md saying when the redirect may go.
4. **Deletion.** Everything under "What goes" but the kind and Hetzner
   items, the setting, the first handler and the redirect's e2e suite.
   `yaac cluster check`'s `egress` gate becomes the acceptance test below.
5. **The default CNIs.** New kind clusters and the Hetzner stack are
   created without Calico, and their items under "What goes" are deleted.

The acceptance test, as an e2e case and as the check's gate: as root in a
workspace and in a `RUN` step, fail to reach the server, the apiserver, a
node address, a second sandbox, a literal internet address and a node
socket outside `/run/yaac`, while an allowlisted host succeeds.

## Risks

- **`host-uds=all` lets a sandbox connect to any node socket it can see.**
  That is true today. No mounted directory may hold a socket other than
  the sandbox's own, and the acceptance test checks it.
- **A sandbox can write its own socket directory.** Spike 6 and the
  by-descriptor rule cover what netd opens there.
- **Literal addresses** depend on spike 2.
- **netshim is one more thing that can break a sandbox's network.** Its
  failure is closed, visible in the workspace and restarted by streamd.
- **Two relay hops through sockets** replace a kernel redirect and an
  Envoy, and image layers now cross them too. Spike 3 measures it.
- **netd is on every stream.** A netd restart drops its node's terminals
  and forwards, which reconnect, where a proxy restart drops every node's
  today.
- **The policies around yaac's own pods become defense in depth on kind
  and the Hetzner stack.**
  That holds only while every pod with an interface is one yaac wrote. A
  new kind of pod that runs untrusted code must take the socket path, and
  the reference doc says so.

## Docs when it ships

`docs/workspace-egress.md` is rewritten around the socket datapath,
`docs/stream-relay.md` around the dial through netd, and
`docs/image-builds.md` (or its successor) around a build's egress.
`docs/cluster-setup.md` loses "The CNI gate" down to the enforcement
probe, and its Linux sections lose what they say about Calico.
`infra/hetzner-k3s/README.md` loses its Calico and kube-proxy rows and
gains the in-place switch.

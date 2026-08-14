# Worktree egress

Every worktree pod is default-denied and reaches the internet only through
the yaac MITM proxy, which enforces a per-worktree allowlist. Two
components make that true, with a deliberate split of responsibility:

- **Calico** (pinned by checksum in `k8s/calico/`, installed by `yaac
  cluster setup`) is the CNI and the policy engine. It enforces every
  allow and deny, expressed as plain `networking.k8s.io/v1`
  NetworkPolicy.
- **netd** (`k8s/netd/`, a DaemonSet) owns only the *redirect*: it steers
  a worktree's outbound 443/80/ssh-sentinel into the proxy. It decides
  nothing about what is permitted.

That split is the security argument. netd's rules can only ever *add*
reachability toward a proxy, so a netd that is down, late, or wrong costs
worktrees their egress rather than opening it. The deny path is Felix plus
kernel netfilter — audited upstream code — and yaac-authored datapath code
is confined to the redirect.

## The datapath

For a worktree pod with host-side veth `caliXXXX`, netd programs one chain
in the node's root netns:

```
nat YAAC_RDR_<install>:
  -d <podCIDR>                               -j RETURN     (once per CIDR)
  ...
  -i caliXXXX -p tcp --dport 443             -j DNAT --to <node>:<H>
  -i caliXXXX -p tcp --dport 80              -j DNAT --to <node>:<T>
  -i caliXXXX -p tcp -d 198.18.0.2 --dport 10259
                                             -j DNAT --to <node>:<S>
```

The pod-CIDR exclusions lead the chain, so in-cluster traffic leaves it
before any DNAT rule can match; they are RETURNs rather than a `! -d` on
each rule because iptables allows one destination per rule and a cluster
can allocate pods from several CIDRs.

`H/T/S` are the node-local **listener trio** — one trio per install,
shared by every pod it redirects. The co-located Envoy recovers the
pre-DNAT destination via the `original_dst` listener filter
(`SO_ORIGINAL_DST`, from conntrack) and forwards to the proxy's
transparent port behind a PROXY-protocol-v2 preamble carrying the pod's
real source IP. The proxy resolves that IP to a worktree with its
pod-watch, then routes by TLS SNI / Host header.

Identity is **which veth the frame arrived on**, not its source IP — the
one property a sandboxed workload cannot forge. (A gVisor netstack guest
cannot emit raw frames at all; Felix's per-endpoint anti-spoof and
`rp_filter` cover the runc case.)

netd resolves pod → veth from the per-workload host route Calico installs
(`<podIP> dev caliXXXX scope link`). The tidier `WorkloadEndpoint`
resource is served only by the optional Calico apiserver, which yaac does
not install.

The `cali` prefix is configuration (`NETD_VETH_PREFIX`, set by the server
from `YAAC_CNI_VETH_PREFIX`), because it is correct only where Calico does
the IPAM — policy-only Calico over the AWS VPC CNI gives `eni*`. It is
never relaxed to "any device": matching a prefix is what guarantees a
malformed routing table cannot make netd redirect a node interface, so an
empty or unusable value falls back to `cali` rather than becoming a
wildcard. A prefix that resolves nothing costs egress; a wildcard would
corrupt the node's own traffic.

## Why DNAT and not TPROXY

**netd must never compete with Felix for iptables chain position.** Felix
re-inserts its own jumps at the top of every base chain it manages on each
reprogram, so any yaac rule that has to run *before* `cali-*` is
guaranteed to be demoted the next time Calico resyncs — measured: after a
`calico-node` restart a mangle-PREROUTING TPROXY divert and a filter-INPUT
accept both landed below the Calico jumps and every worktree lost egress.

A TPROXY'd flow is delivered locally, which puts it on the workload→host
INPUT path (`cali-INPUT -i cali+ -g cali-wl-to-host →
cali-from-wl-dispatch → cali-fw-<iface>`) — so Felix applies the pod's
*egress* policy to it, and the worktree default-deny drops it. Escaping
that needs an accept above `cali-INPUT`, which is exactly the fight above.

`nat PREROUTING` has no such contention: Calico's `cali-PREROUTING` there
is an empty floating-IP DNAT chain that terminates nothing, so netd simply
**appends** its jump. NAT also applies only to a flow's first packet, with
conntrack replaying the translation and un-DNAT'ing replies — which
removes the entire TPROXY plumbing (fwmark, `-m socket` divert, policy
route, `accept_local`, `src_valid_mark`).

Appending has a second benefit: the jump lands after kube-proxy's
`KUBE-SERVICES`, whose DNAT is terminating, so ClusterIP traffic never
reaches the redirect. Together with the leading pod-CIDR RETURNs that
scopes the redirect to "world".

## Fail-closed

A worktree's NetworkPolicy grants exactly one world-ward rule: the node, on
netd's reserved listener range. 443/80-to-world is **absent**. So a pod
whose redirect netd has not programmed keeps its original destination,
takes the FORWARD path, matches nothing, and is dropped.

Fail-closed at pod birth is Felix's, for free: until it has programmed a
workload's endpoint, traffic on that veth hits `cali-from-wl-dispatch`'s
`"Unknown interface" -j DROP`.

Admitting the listener range is not a hole. Those ports reach Envoy, which
stamps the connection's real peer address regardless of how it arrived, so
a pod dialing a listener directly gets exactly what its redirected traffic
would get — it cannot impersonate another worktree. The proxy's transparent
ports are admitted from the **node CIDRs only**, so pods cannot reach them
at all and Envoy is the sole originator of PROXY-protocol preambles.

**Probing egress: test data, not reachability.** Because the redirect is a
DNAT on 443/80, a bare TCP connect to *any* address on a redirected port
completes — against the node's Envoy, not against the address dialed. A
probe like `nc -z 1.1.1.1 443` therefore proves nothing and reads as a
false "reachable". Assert on a completed request (the proxy refuses a host
no allowlist admits) and, for the NetworkPolicy layer, on a
non-redirected port, where the default-deny is what answers.

## The two direct pod→proxy dials

Not everything a worktree sends the proxy is redirected traffic. Two flows
address the proxy pod itself, admitted by name in the worktree policy
(`podSelector: app=yaac-proxy`) rather than through the node's listener
range:

- **DNS**, udp/53: the pod's only resolver (`dnsPolicy: None`), answered by
  the proxy's split-horizon stub.
- **ssh-agent**, tcp/10261: the proxy speaks the ssh-agent protocol here,
  spliced to the agent running in its own pod. A worktree pod whose project
  has an SSH remote runs a socat forwarder (started by `yaac-worktree-init`)
  that re-exposes it as the UNIX socket `SSH_AUTH_SOCK` names, so the ssh
  client in the pod is unmodified. Private keys stay in the proxy's memory,
  and each identity is loaded with `ssh-add -h <host>`, so it signs for one
  destination. The client→agent direction is parsed rather than spliced and
  admits two message types — list identities, and sign; add/remove/lock/
  extension are answered with the agent's own `SSH_AGENT_FAILURE` and never
  reach it, so one worktree cannot lock or empty the agent that every other
  worktree shares.

Neither reaches anything outside the cluster, and neither is a way around
the allowlist — git-over-SSH still tunnels through the proxy's transparent
tunnel listener like any other egress. The agent port is admitted from the
worktree selector alone, not from the node CIDRs.
The proxy re-checks each connection's source pod IP against its pod-watch
and refuses one it cannot place, or one whose worktree registered a
non-SSH remote — the same condition under which the server provisions
`SSH_AUTH_SOCK` at all.

The transport is TCP because a UNIX socket on a shared host directory only
rendezvous between pods on one node; nothing here assumes the proxy and the
worktree are co-scheduled.

## Egress target selection

netd has exactly **one** rule, recomputed on every relevant watch event, so
there is no precedence to reason about: a worktree pod (`yaac.worktree-id`)
in **this install's own namespace** is redirected to this install's proxy.
Nothing else on the node is redirected at all.

The scoping to netd's own namespace is what keeps installs sharing a node
out of each other's traffic — netd watches pods everywhere, but only the
install it serves can produce a target, so the first-appended PREROUTING
jump never decides whose pods go where.

The target address is the proxy **Service's ClusterIP**, read from netd's
own install namespace. That is the security line: netd reads **pods**
cluster-wide (a pod's veth is what it programs) but **Services** only in
its own namespace, where every object is yaac-authored and no worktree can
write one.

Which target a flow reaches is decided **inside Envoy**, by matching the
connection's source pod IP against a filter chain
(`filter_chain_match.source_prefix_ranges`), not by which port the packet
landed on. So all three listeners are shared by every target, and a
target appearing or disappearing never moves a port — which matters
because conntrack pins a flow's DNAT destination on its first packet, and
a port that moved under a live flow would strand it. A source netd has
not programmed matches no filter chain and Envoy closes the connection:
the same fail-closed direction as a missing DNAT rule.

The trio itself is chosen once per netd pod: netd probes from a
hash-derived preference over the reserved range, takes the first trio
nothing else on the node holds, and persists the choice beside the Envoy
config so a netd container restart cannot walk to a different trio while
its own Envoy still holds the old one.

## What this datapath requires of a CNI

The redirect is netfilter, so the CNI must let pod egress **reach host
netfilter at the veth peer**, and kube-proxy must still own ClusterIP
translation (netd's Envoy dials the proxy's ClusterIP from the host
netns). Two consequences:

- **Cilium is incompatible**, by default and in practice. Its eBPF
  host-routing (`bpf_redirect_peer`) short-circuits the host stack —
  "packets no longer hit the netfilter tables in the host namespace" — so
  netd's rule never sees the traffic, silently. `bpf.hostLegacyRouting`
  restores netfilter traversal, but Cilium's tc-ingress `from-container`
  program still runs *before* PREROUTING and may consume the packet
  first, and `kubeProxyReplacement` breaks the ClusterIP dial. No
  supported configuration guarantees the redirect sees all pod egress.
- **kindnet is unusable** for a different reason: its NetworkPolicy
  engine fails OPEN at pod birth, so a worktree would start with a window
  of unrestricted egress.

The **policy** half has no such constraint. Every policy is plain
`networking.k8s.io/v1` NetworkPolicy, which every engine — including
Cilium — enforces natively. Only the redirect is CNI-sensitive.

**Calico's own eBPF dataplane is the same refusal as Cilium.**
`FelixConfiguration.bpfEnabled` (or `FELIX_BPFENABLED` on the calico-node
container) bypasses iptables for pod traffic exactly the way Cilium's
host-routing does, and it can be turned on under a Calico install that
otherwise looks adoptable. `yaac cluster setup --adopt-cni` — the mode
that installs into a cluster whose Calico yaac did not install — refuses
it outright rather than warning, along with a replaced kube-proxy, an
empty pod-CIDR set, and a veth prefix that resolves no workload route.
The full gate is in docs/cluster-setup.md ("Adopting a CNI yaac did not
install"); the reason every one of them is a refusal is that each fails
*silently*, as "worktrees have no egress" or as a chain that counts packets
and never fires.

## Managed-cloud portability

netd is identical everywhere; what varies is who runs the policy engine.
This is why the plain-NP-only restriction is worth its cost: the
provider-managed Calicos below treat Calico CRDs as unsupported
territory, so any CRD we leaned on locally would fork the policy model
per provider.

| Platform | Policy engine | Notes |
|---|---|---|
| local kind, self-managed k3s | **our Calico** (CNI + policy) | what `yaac cluster setup` installs |
| GKE Standard, Dataplane V1 | **Google-managed Calico** (`--enable-network-policy`) | don't install our own. DPv2 is a create-time opt-in, so a Standard cluster created without the flag runs the legacy netfilter dataplane and works as-is |
| EKS (AWS VPC CNI) | **our Calico, policy-only mode** | do *not* use AWS's network-policy agent: it enforces via TC eBPF *before* netfilter, which would force world-allows on 443/80 into the worktree policy and destroy the netd-late fail-closed floor; its default mode is also fail-open at pod birth |
| AKS (Azure CNI, non-Cilium) | **Microsoft-managed Calico** (`--network-policy calico`) | plain NP enforced natively |
| GKE Dataplane V2 / Autopilot, AKS-Cilium, DOKS | — | **out of scope**: Cilium-mandated (DOKS's is not replaceable), which defeats the veth-peer redirect. Autopilot also blocks the privileged DaemonSet netd needs |

Every row but the first is an **adoption**: `yaac cluster setup
--adopt-cni` installs into the cluster without touching its CNI, after
verifying the dataplane it is about to depend on (docs/cluster-setup.md).

## Plain NetworkPolicy only

yaac installs no Calico CRs and depends on no CRD-shaped policy. What
plain NP cannot name by selector becomes an `ipBlock` CIDR resolved at
apply time (`cluster-cidrs.ts`): "the node" for anything arriving from the
host netns (netd's Envoy, kubelet probes, containerd registry pulls), and
the apiserver's real **endpoint** addresses — never its Service VIP, since
NetworkPolicy matches the post-DNAT destination.

The restriction is what keeps managed-cloud ports cheap: GKE Dataplane V1
and AKS enforce plain NP through provider-managed Calicos where Calico
CRDs are unsupported, so anything CRD-shaped would fork the policy model
per provider.

## Operational notes

- **Pod CIDRs are discovered, not assumed.** `clusterPodCidrs()` unions
  explicit config (`YAAC_POD_CIDRS`) with Calico's IPPools and every node's
  `spec.podCIDR`, and passes the list to netd. IPPools beat `spec.podCIDR`
  because Calico allocates /26 blocks anywhere in its pool, so a pod's IP
  routinely falls outside its own node's `spec.podCIDR`; the config source
  exists for a foreign IPAM that publishes neither (a VPC CNI hands out
  subnet addresses). Too narrow is the dangerous direction — a pod IP
  outside the list is treated as world and its pod-to-pod 443/80 is
  redirected into the proxy — so the sources union rather than compete,
  and netd refuses to start on an empty list. `disabled` IPPools are
  included for the same reason: the flag stops new allocations, and pods
  already holding an address from that pool keep it. An unusable
  `YAAC_POD_CIDRS` entry is reported rather than dropped, since a vanished
  typo narrows the set with nothing to say so. Resolved at apply time, so a
  CIDR added to a live cluster needs a re-apply.
- **iptables backend.** netd probes at startup for whichever backend
  carries Calico's chains (a kind node's `iptables` alternative points at
  **legacy**). Writing to the wrong backend produces a chain that exists,
  counts packets, and is never consulted — a silent failure that looks
  exactly like a broken redirect.
- **Readiness means programmed.** netd writes its readiness marker only
  after a reconcile reaches the dataplane and removes it on failure, so
  `yaac cluster check`'s `datapath` gate cannot pass on a cluster whose
  netd is failing every pass.
- **Several installs share a node.** The real `yaac` install and each e2e
  run's `yaac-test-<run-id>` install run their own netd. Each owns a
  per-install nat chain (`YAAC_RDR_<hash of namespace>`, logged at
  startup) with its own appended PREROUTING jump — a shared chain would
  have them flush each other's rules on every pass, flapping every
  install's egress. For the same reason their Envoys take
  `--use-dynamic-base-id` and put their admin endpoint on a unix socket in
  their own config volume: hostNetwork siblings cannot all claim base-id 0
  or a fixed loopback port. Listener trios are bind-probed for the same
  reason, and the listeners set `enable_reuse_port: false` — Envoy's
  default is true and these run as one uid in one netns, so two installs
  on the same trio would both bind it and the kernel would split
  connections between them. Disabled, the loser's listener is rejected,
  the gate below sees it, and netd re-probes for a free trio.
- **Reconcile is stateless.** Every pass recomputes the whole desired
  chain and Envoy config from cluster state and writes only on change, so
  there is no incremental state to drift and GC is implicit (a deleted pod
  stops appearing). The write-only-on-change memo describes what netd
  *wrote*, not what the kernel *kept*, so the 30s pass discards it and
  re-asserts — that, plus re-checking the PREROUTING jump every pass, is
  what heals an external flush or a deleted jump.
- **Envoy acknowledges before packets move.** A file rename is not an
  acknowledgement: Envoy still has to accept the document and bind the
  sockets. Each pass reads `/config_dump` on the admin socket and waits
  for `ListenersConfigDump.version_info` — the version Envoy last
  *applied* — to equal the one netd just wrote, with every listener bound
  on the trio, before it touches netfilter; the readiness marker follows
  that. The per-listener `active_state.version_info` is deliberately not
  the signal: Envoy updates filter chains in place and leaves that field
  at the version the listener was created at, so gating on it would pass
  once and then stall on every later pod change. A rejected listener is
  reported with Envoy's own `error_state` details rather than as a
  timeout.
- **Triage.** `kubectl -n <ns> logs ds/yaac-netd -c netd` for target
  selection, rule application, and the chain name; then
  `iptables-legacy -t nat -S <chain>` on the node for what is actually
  programmed (`-S PREROUTING` shows which chain this install jumps to).

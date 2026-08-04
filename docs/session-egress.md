# Session egress

Every session pod is default-denied and reaches the internet only through
the yaac MITM proxy, which enforces a per-session allowlist. Two
components make that true, with a deliberate split of responsibility:

- **Calico** (pinned by checksum in `k8s/calico/`, installed by `yaac
  cluster setup`) is the CNI and the policy engine. It enforces every
  allow and deny, expressed as plain `networking.k8s.io/v1`
  NetworkPolicy.
- **netd** (`k8s/netd/`, a DaemonSet) owns only the *redirect*: it steers
  a session's outbound 443/80/ssh-sentinel into the proxy. It decides
  nothing about what is permitted.

That split is the security argument. netd's rules can only ever *add*
reachability toward a proxy, so a netd that is down, late, or wrong costs
sessions their egress rather than opening it. The deny path is Felix plus
kernel netfilter — audited upstream code — and yaac-authored datapath code
is confined to the redirect.

## The datapath

For a session pod with host-side veth `caliXXXX`, netd programs one chain
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
real source IP. The proxy resolves that IP to a session with its
pod-watch, then routes by TLS SNI / Host header.

Identity is **which veth the frame arrived on**, not its source IP — the
one property a sandboxed workload cannot forge. (A gVisor netstack guest
cannot emit raw frames at all; Felix's per-endpoint anti-spoof and
`rp_filter` cover the runc case.)

netd resolves pod → veth from the per-workload host route Calico installs
(`<podIP> dev caliXXXX scope link`). The tidier `WorkloadEndpoint`
resource is served only by the optional Calico apiserver, which yaac does
not install.

## Why DNAT and not TPROXY

**netd must never compete with Felix for iptables chain position.** Felix
re-inserts its own jumps at the top of every base chain it manages on each
reprogram, so any yaac rule that has to run *before* `cali-*` is
guaranteed to be demoted the next time Calico resyncs — measured: after a
`calico-node` restart a mangle-PREROUTING TPROXY divert and a filter-INPUT
accept both landed below the Calico jumps and every session lost egress.

A TPROXY'd flow is delivered locally, which puts it on the workload→host
INPUT path (`cali-INPUT -i cali+ -g cali-wl-to-host →
cali-from-wl-dispatch → cali-fw-<iface>`) — so Felix applies the pod's
*egress* policy to it, and the session default-deny drops it. Escaping
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

A session's NetworkPolicy grants exactly one world-ward rule: the node, on
netd's reserved listener range. 443/80-to-world is **absent**. So a pod
whose redirect netd has not programmed keeps its original destination,
takes the FORWARD path, matches nothing, and is dropped.

Fail-closed at pod birth is Felix's, for free: until it has programmed a
workload's endpoint, traffic on that veth hits `cali-from-wl-dispatch`'s
`"Unknown interface" -j DROP`.

Admitting the listener range is not a hole. Those ports reach Envoy, which
stamps the connection's real peer address regardless of how it arrived, so
a pod dialing a listener directly gets exactly what its redirected traffic
would get — it cannot impersonate another session. The proxy's transparent
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

Not everything a session sends the proxy is redirected traffic. Two flows
address the proxy pod itself, admitted by name in the session policy
(`podSelector: app=yaac-proxy`) rather than through the node's listener
range:

- **DNS**, udp/53: the pod's only resolver (`dnsPolicy: None`), answered by
  the proxy's split-horizon stub.
- **ssh-agent**, tcp/10261: the proxy speaks the ssh-agent protocol here,
  spliced to the agent running in its own pod. A session pod whose project
  has an SSH remote runs a socat forwarder (started by `yaac-session-init`)
  that re-exposes it as the UNIX socket `SSH_AUTH_SOCK` names, so the ssh
  client in the pod is unmodified. Private keys stay in the proxy's memory,
  and each identity is loaded with `ssh-add -h <host>`, so it signs for one
  destination. The client→agent direction is parsed rather than spliced and
  admits two message types — list identities, and sign; add/remove/lock/
  extension are answered with the agent's own `SSH_AGENT_FAILURE` and never
  reach it, so one session cannot lock or empty the agent that every other
  session shares.

Neither reaches anything outside the cluster, and neither is a way around
the allowlist — git-over-SSH still tunnels through the proxy's transparent
tunnel listener like any other egress. The agent port is admitted from the
session selector alone: not from the node CIDRs, and not from
vcluster-synced pods, whose install forwards its own inner proxy's agent.
The proxy re-checks each connection's source pod IP against its pod-watch
and refuses one it cannot place, or one whose session registered a
non-SSH remote — the same condition under which the server provisions
`SSH_AUTH_SOCK` at all.

The transport is TCP because a UNIX socket on a shared host directory only
rendezvous between pods on one node; nothing here assumes the proxy and the
session are co-scheduled.

## Egress target selection

netd picks exactly **one** target per pod, recomputed on every relevant
watch event, so there is no precedence to reason about:

1. A session pod in the install namespace → that install's **outer** proxy.
2. A vcluster-synced pod whose pod IP a **validated redirect claim** names →
   the claiming install's proxy **pod**. This is the yaac-in-yaac override:
   the claim is published by the inner install's own netd and validated by
   the outer server (`docs/nested-containers.md`).
3. Any other synced pod — including a claimed proxy itself → the
   vcluster's owning install's **outer** proxy.

Rules 2 and 3 apply only in vcluster namespaces **this install owns**
(`<install namespace>-vc-<vcluster>`, the server's naming convention).
netd watches every namespace, so without that scoping each of the installs
sharing a node would claim the others' synced pods and DNAT them at its
own proxy; the first-appended PREROUTING jump would win, and the loser's
pods would reach a proxy that cannot resolve them.

Rule 3 gives synced pods working, allowlisted egress before any inner yaac
exists, and makes chaining loop-free (a claimed proxy is never redirected to
itself, so its own upstream dials ride rule 3 to the outer proxy).

One invariant is what makes rule 2 safe to expose to a tenant at all:

> Every address a claim can steer traffic **to** is the `status.podIP` of a
> pod the **host** apiserver reports in a vcluster namespace this install
> owns, and lies inside the cluster's pod CIDRs.

Pod IPs come from host IPAM and are reported in host pod status, so a
vcluster tenant cannot mint one: the worst a forged claim achieves is aiming
its own pods at its own pod, whose egress still rides rule 3 to the outer
proxy under the outer allowlist. A **ClusterIP** would not be safe here —
kube-proxy dereferences it from the node's host netns, where a
tenant-authored Endpoints object can name any address on the internet and no
NetworkPolicy applies. netd enforces the invariant itself rather than
trusting the server's validation; raw world stays denied by NetworkPolicy,
not by this selection.

netd's own reads follow from that split: **pods** cluster-wide (a pod's veth
is what it programs), and Services plus the claims ConfigMap in its **own**
namespace only, since both are yaac-authored objects there and a tenant can
write neither.

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
  engine fails OPEN at pod birth, so a session would start with a window
  of unrestricted egress.

The **policy** half has no such constraint. Every policy is plain
`networking.k8s.io/v1` NetworkPolicy, which every engine — including
Cilium — enforces natively. Only the redirect is CNI-sensitive.

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
| EKS (AWS VPC CNI) | **our Calico, policy-only mode** | do *not* use AWS's network-policy agent: it enforces via TC eBPF *before* netfilter, which would force world-allows on 443/80 into the session policy and destroy the netd-late fail-closed floor; its default mode is also fail-open at pod birth |
| AKS (Azure CNI, non-Cilium) | **Microsoft-managed Calico** (`--network-policy calico`) | plain NP enforced natively |
| GKE Dataplane V2 / Autopilot, AKS-Cilium, DOKS | — | **out of scope**: Cilium-mandated (DOKS's is not replaceable), which defeats the veth-peer redirect. Autopilot also blocks the privileged DaemonSet netd needs |

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
per provider. It also means a nested yaac registers no policy CRDs into
its vcluster — plain NetworkPolicy is a core API every vcluster serves.

## Operational notes

- **Pod CIDRs are discovered, not assumed.** `clusterPodCidrs()` unions
  Calico's IPPools with every node's `spec.podCIDR` and passes the list to
  netd. IPPools come first because Calico allocates /26 blocks anywhere in
  its pool, so a pod's IP routinely falls outside its own node's
  `spec.podCIDR`. Too narrow is the dangerous direction — a pod IP outside
  the list is treated as world and its pod-to-pod 443/80 is redirected
  into the proxy — so the sources union rather than compete, and netd
  refuses to start on an empty list.
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
  programmed (`-S PREROUTING` shows which chain this install jumps to). For
  a yaac-in-yaac question, `kubectl -n <ns> get cm yaac-redirect-claims -o
  yaml` is the whole answer to "what has the host been asked to redirect" —
  it is rewritten in full every time the claim set changes, so an absent
  entry means nobody claimed that vcluster's pods (or nothing they claimed
  survived validation) and they are on the outer proxy.

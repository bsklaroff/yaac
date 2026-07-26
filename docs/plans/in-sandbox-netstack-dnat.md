# In-sandbox netstack DNAT — coexisting with managed Cilium

**Status: not planned.** The mechanism is real and was validated against a
live runsc sandbox (results below), but adopting it means a second
datapath whose cost falls almost entirely on the yaac-in-yaac path, and it
weakens two properties the shipped redirect gets for free. It is written
down because it is **the only route we know of that lets yaac's
transparent proxy work on a Cilium-mandated platform** (GKE Dataplane V2 /
Autopilot, AKS "Azure CNI powered by Cilium", DOKS) — if that ever becomes
a requirement, this is the design to start from rather than re-derive.

Everything here is an alternative to the shipped datapath in
docs/session-egress.md, not a change to it. The proxy, the allowlist, and
the policy plane are untouched in both.

## Why Cilium defeats the shipped redirect

netd DNATs at the host-side veth peer, which requires pod egress to reach
host netfilter. Cilium's default eBPF host-routing (`bpf_redirect_peer`)
short-circuits the host stack — "packets no longer hit the netfilter
tables in the host namespace" — so the rule never sees the traffic, and
fails silently. `bpf.hostLegacyRouting=true` restores netfilter traversal,
but Cilium's tc-ingress `from-container` program still runs before
PREROUTING and may consume the packet first, and `kubeProxyReplacement`
breaks netd's ClusterIP dial. On the managed variants none of those knobs
are exposed anyway.

## The core move

Every other interception variant grabs the packet somewhere along its
path, which forces a fight with the CNI over the grab point. Netstack DNAT
instead **rewrites the destination before the packet leaves the sandbox**:
after the rewrite it is ordinary pod-to-pod traffic to the proxy's pod IP,
which any CNI routes normally. There is nothing left to intercept at the
veth peer. Interception becomes routing.

This is possible only because a gVisor pod runs a full userspace TCP/IP
stack inside the sentry, with its own iptables implementation, in the same
stack that carries the session's traffic — unlike the pod-netns kernel
iptables, which the sentry bypasses at L2.

A session container connecting to `example.com:443`:

1. The `nat` OUTPUT chain in netstack holds
   `-p tcp --dport 443 -j DNAT --to-destination <proxyPodIP>:<port>`.
2. Netstack rewrites the destination, re-runs routing for the new address,
   and egresses toward the proxy pod.
3. The frame leaves `eth0` already addressed `src=podIP → dst=proxyPodIP`;
   the CNI delivers it as normal pod-to-pod traffic.
4. On the reply, netstack's conntrack un-DNATs, so the application sees a
   normal connection to the host it dialed.

Netstack source facts behind this, all verified by reading gVisor:
`DNATTarget` (`pkg/tcpip/stack/iptables_targets.go`) carries an arbitrary
non-local addr+port and is valid on OUTPUT (unlike `RedirectTarget`, which
forces loopback); the `ip_route_me_harder` analog in
`pkg/tcpip/network/ipv4/ipv4.go` `writePacket` re-routes after the rewrite;
conntrack (`pkg/tcpip/stack/conntrack.go`) un-DNATs replies for TCP **and**
UDP, dport-53 included. Upstream-tested in `test/iptables/nat.go`
(`NATOutDNAT`, `NATOutDNATAddrOnly`, `NATOutDNATPortOnly`,
`NATOutRedirectUDPPort`). Netstack gates all iptables writes on guest
`CAP_NET_ADMIN`.

## What the spike verified (2026-07-23)

Run against a **real runsc sandbox** (`--network=sandbox`,
release-20260706.0) on the kind node, using hand-built veth/netns to
isolate the netstack question from the node's CNI.

- **Install path works via `--reproduce-nat`.** A `nat` OUTPUT DNAT rule
  written into the pod netns's *kernel* iptables is scraped at sandbox boot
  and becomes live in netstack. The sandbox dialed `203.0.113.7:443`
  (TEST-NET, unroutable) and the connection landed on the proxy listener at
  the proxy IP:port with `connect() rc=0 (ESTABLISHED)` — rewritten inside
  the sandbox before egress, with conntrack un-DNAT'ing the replies. So the
  chained-CNI-preinstalls-then-runsc-copies path is real; a `NET_ADMIN`
  init container is a fallback, not a necessity.
- **The original destination is not recoverable at the proxy.**
  `getsockname` at the proxy returns the *proxy's* IP:port, not
  `203.0.113.7`. `SO_ORIGINAL_DST` only works for an interceptor inside the
  same netstack. SNI / Host / the sentinel-port scheme are therefore
  mandatory for carrying the target — which the proxy already does.
- **Un-DNAT'd traffic fails closed.** `203.0.113.7:80`, with no rule,
  returned `connect() rc=-1` and put zero packets on the wire.
- **No bypass, even for the nested class.** With `-net-raw=true` *and*
  `-allow-packet-socket-write=true` (the exact flags the `gvisor-nested`
  handler sets) and `CAP_NET_RAW` in the bundle: a hand-crafted SYN on a
  `SOCK_RAW`/`IP_HDRINCL` socket returned **`ENETUNREACH`** for both an
  external and an on-link destination, and an `AF_PACKET` `SOCK_DGRAM`
  injection found `lo` (index 1) to be the only packet-writable device —
  `eth0` is not exposed at all (indexes 2–4 = `ENODEV`). The same dead
  paths also block source-IP spoofing from inside the sandbox, which is
  what makes a pod-IP identity basis tenable at all.

Left unverified, and each is a gate rather than a detail: a real gVisor pod
on **managed Cilium** end-to-end; the **nested class's inner container
engine**, which drives netstack NICs for inner pods and is a far richer
surface than the direct `AF_PACKET` write tested here; an explicit netstack
**filter default-deny** (fail-closed here was no-route, not an installed
DROP); and an empirical re-confirm of the `CAP_NET_ADMIN` tamper gate with
an in-sandbox iptables write.

## What adopting it would cost

### Getting a rule into every pod

The k8s-shaped option is an istio-init-style `NET_ADMIN` init container
running plain `iptables -t nat -A OUTPUT …`. That is genuinely elegant: the
same manifest writes the *pod-netns kernel* table for runc pods and the
*sandbox netstack* table for gVisor pods, so the inner proxy, builder,
registry, and vcluster control-plane pods need no second mechanism. The
`--reproduce-nat` variant the spike proved needs a node-level CNI conflist
edit plus a runsc flag, and on Cilium the conflist is agent-managed.

But session pods are the easy half. **Vcluster-synced pods are the
tenant's own PodSpec, copied verbatim by the syncer**, so injecting
anything into them needs a host mutating admission webhook with
`failurePolicy: Fail` — cert rotation, and a webhook whose outage blocks
pod creation. Today netd needs nothing on the pod at all.

### The egress target freezes at pod birth

This is the real loss. Today netd recomputes one target per pod on every
watch event, and docs/nested-containers.md makes an inner install's
published redirect claim the opt-in signal: publishing it flips that
install's pods to its own proxy, withdrawing it reverts them on the next
pass. A DNAT baked into the sandbox at boot cannot flip. The options are:

1. Always DNAT to the outer proxy and have it **splice** the connection to
   the inner proxy based on source-pod classification. Workable — it reuses
   the pod-watch the proxy already runs — but it makes the outer proxy a
   PROXY-protocol originator and adds a raw-forward path to proxy.ts.
2. Re-exec into the sandbox to rewrite the rule when the target changes.
   Racy, and needs a `NET_ADMIN` path into a running pod.
3. Accept staleness: inner sessions created before their inner proxy exists
   are never governed by the inner allowlist. That is a correctness
   regression, not a trade-off.

### The proxy's forgery lock has to be re-argued

With no node-local Envoy there is no PROXY-protocol preamble.
`resolveSessionBySourceIp` currently *requires* one and
`buildProxyIngressNpManifest` admits the transparent ports from node CIDRs
only — "Envoy is the sole originator of PP2 preambles" is the whole
argument that a pod cannot forge another session's identity. Direct DNAT
means pods must reach those ports, so the proxy needs a direct mode keyed
on the socket peer address **and** a guarantee that PP2 is refused on
pod-sourced connections. Cleanest is separate listener ports per mode.

### The nested class can delete its own rule

`NESTED_ENGINE_CAPS` grants the workload `NET_ADMIN`, and netstack gates
iptables writes on exactly that capability. So the spike's "tamper-proof
against a capability-dropped workload" — and its strongest hardening lever,
a per-session DNAT target the workload cannot rewrite — **do not hold for
nested sessions**, which is precisely the yaac-in-yaac class. Containment
survives, because NetworkPolicy is what denies world and a rule-less pod's
traffic keeps its real destination and is dropped. But interception
integrity would rest entirely on "the proxy is the only reachable thing"
rather than on a rule the tenant cannot touch.

### Nested containers lose their free ride

Today in-pod podman shares the session pod's netns, so `docker
pull`/`build` traffic rides the veth redirect with zero extra wiring. A
`nat OUTPUT` rule only catches locally-generated packets; anything podman
forwards off an in-sandbox bridge takes FORWARD and is never DNAT'd — fail
closed, but nested egress simply stops working. Fixing it means a
PREROUTING rule inside a netns that netavark also programs and rewrites.
This is the spike's biggest unverified gate.

### Everything else

A second datapath means a second e2e suite (the existing
`test/e2e/netd-datapath.test.ts` asserts host-side iptables) and a Cilium
cluster to run it on. Autopilot additionally blocks the privileged
DaemonSet, so the platform that most needs this is still out on other
grounds.

## Rejected alternative: hostinet

runsc `--network=host` makes the sentry create real kernel sockets inside
the pod netns, so egress traverses the pod-netns kernel IP stack and the
full Istio-ambient shape applies — in-pod netfilter, upstream of the veth
peer, invisible to any CNI including an immutable managed Cilium. Tamper
resistance holds for free (hostinet has no guest iptables path, and netlink
writes need `CAP_NET_ADMIN`).

It is rejected because it hands the host kernel's socket API back to the
guest — the attack surface netstack exists to remove, and gVisor positions
hostinet for "semi-trusted" workloads. It also breaks the nested class
specifically: under hostinet, `net-raw` grants real raw IP sockets in the
pod netns, weakening both interception and spoof resistance. Netstack DNAT
costs no isolation downgrade, which is why it is the variant written up
here.

## If this were ever revived

Scope it to **session pods only** and gate `virtualCluster` off on the
Cilium backend. That single move deletes the admission webhook, the
frozen-target problem, and the nested-container forwarding problem — the
three expensive items — and leaves a datapath that is plausibly a week's
work instead of a quarter's. yaac-in-yaac would remain a
netfilter-traversing-CNI feature.

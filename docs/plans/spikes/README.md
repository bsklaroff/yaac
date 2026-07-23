# §4 networking spikes — gVisor + peer-netns TPROXY

Reproducible validation for the "networking / egress" section of
[`../stock-k8s-multi-node.md`](../stock-k8s-multi-node.md): does the plan's
"default-deny + transparent TPROXY to a per-pod forwarder" datapath compose
with gVisor's `fdbased` netstack? **Yes — with one correction: the redirect
must sit at the host-side veth peer, not inside the pod netns.**

## What the spike found

A gVisor session pod (both `gvisor` and `gvisor-nested`) runs runsc with the
default `--network=sandbox` netstack. The sentry copies the pod's IP/routes
into its **userspace** netstack and drives `eth0` at layer 2 via an AF_PACKET
(`p_raw`) socket. So in the host kernel's view of the pod netns, `eth0` has **no
IP and no routes**, and the sandbox's egress leaves as raw Ethernet frames.
Those frames never enter the pod netns's IP stack, so **iptables/TPROXY placed
inside the pod netns cannot see egress**. Interception has to happen where the
frames re-enter a kernel IP stack: the **host-side veth peer**. Identity is
then "which veth did the frame arrive on" — unforgeable from inside the
sandbox, and unaffected by `net-raw` (which only governs the guest's own raw
sockets, not the fdbased transport).

## The scripts

These run **inside the kind node container** (they need `runsc`, `iptables`,
`ip netns`, root). From the host:

```sh
export CONTAINER_HOST=unix:///run/podman/podman.sock
# build the two static helpers on the host (kind node has no compiler):
gcc -O2 -static -o tproxy_probe tproxy_probe.c
gcc -O2 -static -o connect_probe connect_probe.c
podman cp tproxy_probe   yaac-control-plane:/tmp/tproxy_probe
podman cp connect_probe  yaac-control-plane:/tmp/connect_probe
podman cp gvisor_spike.sh yaac-control-plane:/tmp/gvisor_spike.sh
podman exec yaac-control-plane bash /tmp/gvisor_spike.sh
```

- **`tproxy_probe.c`** — the minimal core of the per-pod forwarder: an
  `IP_TRANSPARENT` listener that, on each accepted connection, recovers the
  original destination (`getsockname` on a TPROXY socket) and the source. This
  is what stamps session identity and hands `host:port` to `yaac-proxy`.
- **`connect_probe.c`** — a tiny static workload that runs *inside* the sandbox
  and `connect()`s to a hardcoded dst, so we can watch it get intercepted.
- **`peer_tproxy_spike.sh`** — mechanism-only check with a normal-kernel "sim
  pod" (veth) → peer netns TPROXY → forwarder. Proves the TPROXY recipe on this
  kernel independent of gVisor.
- **`gvisor_spike.sh`** — the faithful end-to-end test: a **real runsc
  sandbox** (fdbased netstack) → veth → peer-netns TPROXY → forwarder. Expected
  output: the sandbox reports `connect() rc=0 (ESTABLISHED)` and the forwarder
  prints `INTERCEPTED src=… -> origdst=203.0.113.7:443`.

## Working TPROXY recipe (for the node agent)

In the veth-peer netns:

```
sysctl: ip_forward=1, conf.all.rp_filter=0, conf.<peer>.rp_filter=0,
        conf.all.route_localnet=1, conf.all.accept_local=1
ip rule add fwmark 0x1/0x1 lookup 100
ip route add local 0.0.0.0/0 dev lo table 100
iptables -t mangle -N DIVERT
iptables -t mangle -A DIVERT -j MARK --set-mark 0x1/0x1 -j ACCEPT
iptables -t mangle -A PREROUTING -p tcp -m socket -j DIVERT
iptables -t mangle -A PREROUTING -i <peer> -p tcp --dport 443 \
  -j TPROXY --tproxy-mark 0x1/0x1 --on-port <forwarder>
```

The mark **mask** (`0x1/0x1`, not `0x1`) plus `accept_local=1` are load-bearing
— without them TPROXY matches but the SYN is never delivered to the socket.

## Caveat this spike does not cover

The kind cluster used here runs Cilium, whose eBPF sits on the real pod veth
peers, so these scripts use hand-built veth/netns pairs to isolate the
gVisor+netfilter question. On the real target the CNI must not consume the
frame in eBPF before netfilter — which is exactly why the plan drops Cilium for
a minimal/routed CNI. The remaining integration step (a real gVisor pod on a
minimal CNI, redirected by the node agent) is implementation work, not a
viability question. The desk research below settles what this spike could not:
whether any variant of the design composes with Cilium as the CNI.

## Desk research (2026-07-23): Cilium portability + the istio-ambient comparison

Follow-up research from primary sources (istio/ztunnel and gVisor source,
Cilium and cloud-provider docs) on the caveat above.

### Istio ambient's attach point is the mirror image of ours

Ambient (Istio ≥1.21 "in-pod redirection") intercepts **inside the pod
netns**: the istio-cni node agent enters each pod netns and installs nat-table
`REDIRECT` rules there (chains `ISTIO_PRERT`/`ISTIO_OUTPUT` → ports
15001/15006/15008 — plain REDIRECT, no TPROXY), and ztunnel receives the
pod's netns fd over a UDS and `setns()`-binds ordinary kernel listeners inside
the pod netns (`istio/ztunnel` `src/inpod/`;
<https://istio.io/latest/blog/2024/inpod-traffic-redirection-ambient/>). That
is CNI-independent precisely because it sits upstream of the veth peer where
eBPF CNIs attach — and it is exactly the attach point gVisor's sandbox
netstack bypasses (documented incompatible:
<https://github.com/istio/istio/issues/58573>). Under `--network=sandbox` the
two goals are mutually exclusive: gVisor-safe means veth peer, eBPF-CNI-safe
means in-pod, and no attach point is both.

Nor can interception move into the sentry's netstack: it supports nat
`REDIRECT` (istio-sidecar-tested) but has **no TPROXY target, no writable
mangle table, and `IP_TRANSPARENT` is silently ignored** (gVisor
`pkg/sentry/socket/netfilter/`, `pkg/sentry/socket/netstack/`) — and
in-sandbox rules would live in the guest's own stack anyway.

### Veth-peer TPROXY vs Cilium: incompatible, confirmed

- Default **eBPF host-routing** short-circuits the host stack
  (`bpf_redirect_peer`): "packets no longer hit the netfilter tables in the
  host namespace"
  (<https://docs.cilium.io/en/latest/operations/performance/tuning/>).
- `bpf.hostLegacyRouting=true` restores netfilter traversal, but Cilium's
  tc-ingress "from-container" program on the veth peer still runs **before**
  PREROUTING and can consume policy-selected traffic first (Cilium claims
  TPROXY for its own Envoy). No supported Cilium config guarantees a
  third-party veth-peer TPROXY sees all pod egress.
- Managed variants are immutable anyway: GKE Dataplane V2 exposes no Cilium
  config and forbids custom eBPF on `veth*`; AKS "Azure CNI powered by
  Cilium" permits editing nothing but label exclusion. Istio ambient itself is
  effectively unsupported on both for the same reason (the
  `cni.exclusive`/`socketLB.hostNamespaceOnly` knobs aren't exposed).
- EKS's default CNI is the AWS VPC CNI — netfilter-traversing, inside this
  design's envelope; Cilium on EKS is always customer-managed (knobs
  available, still brittle per the tc-ingress point above).

### The one variant that composes with managed Cilium: hostinet

runsc `--network=host` (hostinet) makes the sentry create **real kernel
sockets inside the pod netns** (guest `socket()`/`connect()` become mediated
host syscalls, `pkg/sentry/socket/hostinet/`), so egress traverses the
pod-netns kernel IP stack and the full ambient shape applies: node agent
installs default-deny + redirect in the pod netns (real kernel netfilter —
mangle/TPROXY available), forwarder socket teleported in ztunnel-style.
That is upstream of the veth peer, invisible to any CNI, including immutable
managed Cilium. Same proxy, same forwarder; only the attach point and the
runsc flag change.

- **Tamper-proofing holds without extra work**: hostinet has no guest
  iptables path at all (the netfilter sockopts exist only in the netstack
  code path; hostinet's sockopt layer never forwards unknown options), and
  netlink route/addr writes reach the host only if the guest holds
  `CAP_NET_ADMIN` — which session pods don't.
- **Cost**: the host kernel's Berkeley socket API becomes guest-reachable
  (per-argument seccomp'd, ~15 extra sentry syscalls) — the attack surface
  netstack exists to remove. gVisor positions hostinet for "semi-trusted"
  workloads (<https://gvisor.dev/blog/2020/04/02/gvisor-networking-security/>).
- **Tension**: under hostinet, `net-raw` grants real raw IP sockets in the
  pod netns (AF_PACKET stays read-only), weakening interception and
  spoof-resistance — the nested-session class, which relies on `net-raw`,
  needs redesign or exclusion in this mode.
- **Caveat**: managed Cilium's socket-LB (non-disableable on DPv2/AKS)
  rewrites ClusterIP `connect()`s at the cgroup layer before packets exist,
  so in-pod rules see backend pod IPs rather than service VIPs — fine for
  default-deny of external egress, but the DNS-stub allowance must be
  designed around it.

### A netstack-native alternative worth its own spike: in-sandbox DNAT

Netstack's nat table is more capable than "REDIRECT only": its `DNATTarget`
takes an **arbitrary non-local IP:port**, is valid on the OUTPUT hook,
re-routes after rewrite (the `ip_route_me_harder` analog in
`pkg/tcpip/network/ipv4/ipv4.go` `writePacket`), and conntrack un-DNATs
replies — for TCP **and UDP** (dport-53 capture included); all
upstream-tested (`test/iptables/nat.go` `NATOutDNAT*`,
`NATOutRedirectUDPPort`). So a third interception variant exists that keeps
`--network=sandbox`: put `DNAT --to-destination <proxy>:<port>` OUTPUT rules
plus default-deny filter rules **inside the sandbox's own netstack**. That is
upstream of everything in the kernel — CNI-independent (managed Cilium
included) *and* gVisor-native, with no hostinet surface. Netstack enforces
guest `CAP_NET_ADMIN` on iptables writes, so rules installed at pod setup are
tamper-proof against a capability-dropped workload.

Open questions that make this a spike, not a conclusion — install path
(`NET_ADMIN` init container vs `--reproduce-nat`), original-destination
recovery (DNAT gives the remote proxy no `SO_ORIGINAL_DST`, so SNI/Host/sentinel
must carry the target and identity falls back to source pod IP), and the
`net-raw` bypass surface. Full write-up, source references, and acceptance gate:
[`in-sandbox-netstack-dnat.md`](in-sandbox-netstack-dnat.md).

### GKE specifics

**GKE Standard does not force DPv2**: it is a create-time opt-in
(`--enable-dataplane-v2`); a new Standard cluster without the flag runs the
legacy netfilter dataplane (Calico/iptables), which traverses host netfilter
normally — so the veth-peer design works there as-is, no hostinet needed
(<https://docs.cloud.google.com/kubernetes-engine/docs/how-to/dataplane-v2>).
DPv2 is mandatory only on Autopilot (out entirely: no node access, no
privileged pods, `NET_RAW` blocked) and on clusters already created with it
(no documented migration off).

GKE Sandbox cannot run hostinet: `network` is not in runsc's per-pod
flag-override allowlist, overrides are gated behind `--allow-flag-override`
(default false, "for debugging"), and GKE exposes neither the shim config
(`runsc.toml`) nor the gate — its supported containerd customization
allowlist doesn't cover runtime handlers. On GKE Standard the route is
our own runsc runtime handler + RuntimeClass installed by the privileged node
agent (precedent: gVisor's `tools/gvisor_k8s_tool` installer — note it
defaults `allow-flag-override=true`, which session nodes must keep **off**).
Unsupported by Google and must survive node recreation via DaemonSet
reconciliation, but structurally permitted.

Two DPv2 facts for completeness: its NetworkPolicy enforcement (veth/eBPF
layer) does apply to gVisor pods — GKE's own guidance relies on it to block
metadata access from sandboxed workloads — so coarse L3/L4 default-deny is
available even where our TPROXY is not; and Cilium's source-IP verification
(on by default, not disableable on DPv2) drops forged-source frames at the
veth, which partially offsets the `net-raw` spoofing concern in any
hostinet-on-Cilium mode.

### Net result for the plan

- **netstack + veth-peer TPROXY** (this spike): viable on the node-local
  platform and any netfilter-traversing CNI — minimal CNIs, EKS's default
  VPC CNI, GKE Standard on the legacy dataplane.
- **Cilium-mandated environments** (GKE Autopilot/DPv2 clusters,
  AKS-Cilium): two candidate variants, both changing the attach point, not
  the proxy — **hostinet + in-pod ambient-shape rules** (proven mechanics,
  deliberate isolation downgrade) or **in-sandbox netstack DNAT** (no
  isolation downgrade, needs its own spike). The plan should adopt one as an
  explicit per-platform mode or declare these environments out of scope.
- The plan's §4 claim that veth-peer interception "works even on eBPF CNIs"
  held for the in-pod attach point and does not survive this spike's
  veth-peer correction; under netstack, kernel-side interception is either
  gVisor-safe (veth peer) or eBPF-CNI-safe (in-pod), never both.

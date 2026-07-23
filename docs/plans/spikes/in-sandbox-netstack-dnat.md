# In-sandbox netstack DNAT — a CNI-independent egress-interception variant

A candidate interception mechanism for **Cilium-mandated environments** (GKE
Autopilot / Dataplane V2, AKS "Azure CNI powered by Cilium") where the
[README](README.md)'s veth-peer TPROXY design cannot work — Cilium's eBPF on
the host-side veth peer consumes the frame before host netfilter runs. Unlike
the hostinet variant, this one keeps gVisor's default `--network=sandbox`
netstack, so it costs **no network-isolation downgrade**. It is a proposal, not
a validated result: the [open questions](#open-questions) are what make it a
spike.

## The core move: rewrite the destination, don't intercept the path

Every other variant treats interception as "grab the packet somewhere along
its path and transparently redirect it." That is what forces the fight with the
CNI — the grab point (the veth peer) is exactly where Cilium's eBPF lives.

Netstack DNAT does the opposite: it rewrites the packet's **destination
address** to the proxy's real, routable pod IP **before the packet leaves the
sandbox**. After that rewrite the packet is ordinary pod-to-pod traffic to an
in-cluster IP, and any CNI — Cilium included — routes it to the proxy pod the
normal way. There is nothing left to intercept at the veth peer, so it does not
matter that Cilium owns that hook. Interception has become routing.

This is available because a gVisor pod runs a full userspace TCP/IP stack
(netstack) inside the sentry, and that netstack has its own iptables
implementation. The rules live in **the same stack that carries the session's
traffic** — unlike the pod-netns kernel iptables, which the sentry bypasses at
L2 (the finding that started all of this; see the README).

## Why netstack can do this (source-verified)

Netstack's `nat` table is more than "REDIRECT to localhost":

- `DNATTarget` (`pkg/tcpip/stack/iptables_targets.go`) carries an **arbitrary
  non-local `Addr`+`Port`** and is valid on the **OUTPUT** hook — contrast
  `RedirectTarget`, which forces loopback.
- After the rewrite, netstack re-routes: the `ip_route_me_harder` analog in
  `pkg/tcpip/network/ipv4/ipv4.go` `writePacket` calls `FindRoute` for the new
  destination and egresses toward the proxy pod (IPv6 equivalent in `ipv6.go`).
- Conntrack stores the original/reply tuple pair and **un-DNATs replies
  automatically** (`pkg/tcpip/stack/conntrack.go`), so the app's socket sees a
  normal connection to the host it dialed.
- Works for **TCP and UDP**, dport-53 DNS capture included (conntrack tracks
  UDP tuples for NAT even without the TCP state machine).
- All upstream-tested: `test/iptables/nat.go` `NATOutDNAT`,
  `NATOutDNATAddrOnly`, `NATOutDNATPortOnly`, `NATOutRedirectUDPPort`.

Netstack requires guest `CAP_NET_ADMIN` for any iptables write, so rules set at
pod setup are **tamper-proof against a capability-dropped workload**.

## Packet walk-through

A session container connects to `example.com:443`:

1. The connect enters netstack. The `nat` OUTPUT chain holds
   `-p tcp --dport 443 -j DNAT --to-destination <proxyPodIP>:<port>`.
2. `DNATTarget` rewrites the destination to the proxy pod's IP:port.
3. Destination changed → netstack re-runs routing (`FindRoute`) and picks the
   egress path to the proxy pod.
4. The frame leaves eth0 (the sentry's AF_PACKET L2 transport, as always)
   already addressed `src=podIP → dst=proxyPodIP`. The CNI routes it to the
   proxy pod as ordinary pod-to-pod traffic.
5. The proxy replies to the pod IP. On re-entry, conntrack un-DNATs the reply —
   rewriting its source back to `example.com:443` — and the app sees a normal
   connection.

DNS (`udp/53`) uses the same mechanism with a UDP DNAT/REDIRECT rule.

## What this buys, versus the other variants

| | netstack + veth-peer TPROXY (README) | **in-sandbox netstack DNAT** | hostinet + in-pod rules |
|---|---|---|---|
| gVisor network mode | `--network=sandbox` | `--network=sandbox` | `--network=host` |
| Works on managed Cilium | ✗ (eBPF eats the frame) | **✓** (already routed to proxy) | ✓ (in-pod kernel stack) |
| Network-isolation downgrade | none | **none** | yes (host socket API) |
| Rules live in | host veth-peer netns (kernel) | sandbox netstack | pod netns (kernel) |
| Session identity | arrival veth (unforgeable) | **source pod IP** (weaker) | pod netns |
| Interception primitive | TPROXY (`IP_TRANSPARENT`) | **nat DNAT** | TPROXY |

The proxy and the per-session forwarding policy are unchanged in all three;
only the attach point and the identity basis move.

## Open questions (the spike)

1. **Install path.** The rules must be set inside the sandbox's netstack. A
   gVisor pod is one sandbox = one sentry = one netstack shared across its
   containers, so rules installed once persist for the workload containers.
   Two candidates, both needing a fidelity check:
   - a **`NET_ADMIN` init container** that writes the rules, with workload
     containers running without the capability; or
   - runsc's **`--reproduce-nat`**, which scrapes the pod netns's kernel NAT
     rules at boot and reproduces them in netstack — so the chained CNI plugin
     pre-installs them in the pod netns and runsc copies them in.
2. **Original-destination recovery.** DNAT rewrites the destination only, so
   the proxy receives a connection from the pod IP *to itself* and does not
   natively know the original target. `SO_ORIGINAL_DST` only works for an
   interceptor inside the **same** netstack (it reads that stack's conntrack); a
   separate proxy pod cannot call it. The target must be carried in-band: **SNI**
   for 443, **Host** header for 80, the plan's existing **sentinel-port** scheme
   for SSH/other. This also changes the **identity model** — the proxy knows the
   session by **source pod IP**, not by arrival veth, which is weaker unless the
   CNI anti-spoofs. Cilium's source-IP verification does, on by default and not
   disableable on DPv2 (here that helps us).
3. **Bypass surface.** Whether a `net-raw` session can use raw IP sockets or
   packet endpoints to emit traffic that **skips netstack's OUTPUT nat hook**
   needs testing — this is the analog of the `net-raw` concern the veth-peer
   scheme handled cleanly, and the thing most likely to sink the approach.
   (`--allow-packet-socket-write` stays off regardless.)

## Spike results (2026-07-23) — viable

Run against a **real runsc sandbox** (`--network=sandbox`, release-20260706.0)
on the kind node, using hand-built veth/netns to isolate the netstack question
from the node's Cilium (same rig as the veth-peer spike). Scripts and probes:
[`netstack_dnat_spike.sh`](netstack_dnat_spike.sh), `raw_send_probe.c`,
`pkt_send_probe.c` (reusing `connect_probe.c`, `tproxy_probe.c`). All four
phases reproduce. The three open questions resolve as follows.

**1. Install path — `--reproduce-nat` works.** A `nat` OUTPUT rule
`-p tcp --dport 443 -j DNAT --to-destination <proxy>:<port>` written into the
pod netns's *kernel* iptables is scraped at boot and becomes live in the
sandbox netstack. The sandbox dialed `203.0.113.7:443` (TEST-NET, unroutable
here) and the connection landed on the proxy listener at the proxy IP:port with
`connect() rc=0 (ESTABLISHED)` — the destination was rewritten *inside the
sandbox* before egress, and conntrack un-DNAT'd the replies (the handshake
completed). So the chained-CNI-preinstalls-then-runsc-copies path is real; the
`NET_ADMIN` init container is a fallback, not a necessity.

**2. Original-dst recovery + identity — as feared.** The proxy's `getsockname`
returns the *proxy* IP:port, not `203.0.113.7` — the original destination is
**not** recoverable at a separate proxy pod, confirming SNI/Host/sentinel is
mandatory. The proxy sees the connection sourced from the **pod IP**; that is
the identity basis (see hardening below). Un-DNAT'd traffic **fails closed**:
`203.0.113.7:80` (no rule) returned `connect() rc=-1`, zero packets on the wire.

**3. Bypass surface — did not materialize, even for the nested class.** The
concern most likely to sink the approach didn't. With `-net-raw=true` *and*
`-allow-packet-socket-write=true` (the exact flags yaac's `gvisor-nested`
handler sets) and `CAP_NET_RAW` granted in the bundle:
- a hand-crafted SYN on a `SOCK_RAW`/`IP_HDRINCL` socket returned
  **`ENETUNREACH`** — for the external dst *and* an on-link dst. Netstack's raw
  IP output path is non-functional for arbitrary egress; nothing reached the
  wire.
- an `AF_PACKET` `SOCK_DGRAM` L2 injection found that the **only** interface
  visible to guest packet sockets is `lo` (index 1); `eth0` is not exposed as a
  packet-writable NIC at all (indexes 2–4 = `ENODEV`). A write to `lo` "sends"
  but never reaches the peer.

Net: on this netstack a capability-dropped *and* a `net-raw`+`packet-write`
workload both fail to emit any frame that skips the OUTPUT `nat` hook onto
`eth0`. The same limitation also blocks **source-IP spoofing from inside the
sandbox** (the spoof needs exactly these dead paths), which directly bolsters
the pod-IP identity basis.

### Hardening the session identity

Pod IP alone is weaker than the veth scheme's arrival-veth basis because, in
principle, identity is *observed from the connection* rather than *established
by the datapath*. Recover most of that strength without leaving
`--network=sandbox`:

- **Per-session DNAT target = per-session identity (strongest lever).** Give
  each session a distinct proxy ingress (dedicated listener port, or dedicated
  proxy ClusterIP) and bake it into that session's netstack DNAT rule at pod
  setup. The workload lacks `CAP_NET_ADMIN`, so it cannot rewrite the netstack
  rule (netstack gates all netfilter writes on `CAP_NET_ADMIN` — source-
  established in `pkg/sentry/socket/netfilter`; empirical re-confirm is a small
  follow-up) and can only ever reach *its* ingress. Identity becomes "which
  trusted-provisioned ingress received the connection" — the direct analog of
  "which veth," and tamper-proof. Source pod IP drops to a corroborating check.
- **Authoritative IP→session resolution.** Map src pod IP → session via the k8s
  pod informer the server already runs, never by trusting the connection. Hold
  the binding for the conntrack lifetime; don't recycle a pod IP to a new
  session until its connections drain.
- **CNI anti-spoof + egress lockdown (defense in depth).** A NetworkPolicy
  (enforced on gVisor pods even under DPv2) permitting egress *only* to the
  proxy ingress means a confused/spoofed identity still can't reach another
  session or the outside. On managed Cilium, source-IP verification (on by
  default, non-disableable on DPv2) drops cross-pod forgery at the veth; on
  minimal CNIs add veth-level anti-spoof (rp_filter/ebtables) since they lack it.

Corollary for the plan: `allow-packet-socket-write` being **on** for the
nested class does **not** open a DNAT bypass (the flag governs the guest's
packet sockets, which can't reach `eth0`) — the "stays off regardless" note in
the table above is a belt-and-suspenders default, not a load-bearing
requirement.

## Acceptance gate — status

- ✅ egress to an allowlisted host reaches the proxy (dst rewritten in-sandbox,
  conntrack un-DNATs replies), original dst carried out-of-band (SNI/Host/
  sentinel confirmed necessary).
- ✅ un-allowlisted egress fails closed (no route / no rule → connect fails).
- ✅ a `net-raw` **and** `packet-write` session cannot bypass the OUTPUT hook
  (raw-IP `ENETUNREACH`; `eth0` not an `AF_PACKET`-writable device) and cannot
  forge its source pod IP from inside the sandbox (same dead paths).
- ⏳ **remaining**: (a) a real gVisor pod on **managed Cilium** (not the
  veth stand-in) end-to-end; (b) the **nested class's inner container engine** —
  it drives netstack NICs for inner pods, a richer surface than the direct
  `AF_PACKET` write tested here, and deserves its own targeted bypass check;
  (c) an explicit netstack **filter default-deny** (fail-closed here was
  no-route, not an installed `DROP`); (d) empirical re-confirm of the
  `CAP_NET_ADMIN` tamper gate with an in-sandbox iptables write.

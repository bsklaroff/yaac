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

## Acceptance gate (if spiked)

A real gVisor session pod on **managed Cilium** (or a faithful DPv2-like
eBPF-host-routing stand-in), with netstack DNAT rules installed by the chosen
path, such that:

- egress to an allowlisted host reaches it **through the proxy** (proxy sees
  the connection; original dst recovered from SNI/Host/sentinel), and
- egress to any un-allowlisted host **fails closed**, and
- a `net-raw` session cannot bypass the OUTPUT hook and cannot forge its source
  pod IP past the CNI's source-IP check — **plain and nested classes both**.

# In-sandbox netstack DNAT: coexisting with managed Cilium

**Status: not planned.** The mechanism works: it was checked against a live
runsc sandbox (results below). Adopting it would mean running a second
datapath, and it gives up properties the current redirect gets for free.
It is written down because it is the only route we know of that lets
yaac's transparent proxy work on a platform that mandates Cilium (GKE
Dataplane V2 / Autopilot, AKS "Azure CNI powered by Cilium", DOKS). If that
ever becomes a requirement, start from this design.

It is an alternative to the current datapath in docs/workspace-egress.md,
not a change to it. The proxy, the allowlist and the policy objects stay
the same either way.

## Current state

netd programs `nat PREROUTING` rules keyed on each workspace pod's
host-side veth (Calico's `cali*` interface). They DNAT the pod's outbound
443/80/ssh-sentinel traffic to a node-local Envoy. Envoy writes the source
pod IP into a PROXY-protocol v2 (PP2) preamble and forwards to the proxy's
transparent listeners. The proxy (`resolveWorkspaceBySourceIp` in
`k8s/proxy/main.ts`) requires that preamble and maps the source IP to a
workspace through its pod-watch.

## Why Cilium defeats this

The redirect only works if pod egress passes through host netfilter.
Cilium's default eBPF host routing (`bpf_redirect_peer`) skips the host
stack, so the PREROUTING rule never sees the traffic, and nothing reports
the miss. `bpf.hostLegacyRouting=true` brings netfilter back, but Cilium's
tc `from-container` program still runs first and may consume the packet,
and `kubeProxyReplacement` breaks Envoy's dial to the proxy's ClusterIP.
Managed Cilium offerings do not expose these settings anyway.

## The idea

Instead of intercepting the packet on its way out, rewrite its
destination before it leaves the sandbox. After the rewrite it is plain
pod-to-pod traffic to the proxy, which any CNI routes. There is nothing
left to intercept at the veth.

This works only because a gVisor pod runs its own userspace TCP/IP stack
(netstack) inside the sentry, with its own iptables. That stack carries
the workspace's traffic. The pod netns's kernel iptables does not, because
the sentry bypasses it.

A workspace container connecting to `example.com:443`:

1. Netstack's `nat` OUTPUT chain holds
   `-p tcp --dport 443 -j DNAT --to-destination <proxyPodIP>:<port>`.
2. Netstack rewrites the destination, re-routes for the new address, and
   sends the packet toward the proxy pod.
3. The frame leaves `eth0` as `src=podIP → dst=proxyPodIP`, and the CNI
   delivers it like any pod-to-pod packet.
4. Netstack's conntrack reverses the DNAT on replies, so the application
   sees a normal connection to the host it dialed.

gVisor source facts behind this: `DNATTarget`
(`pkg/tcpip/stack/iptables_targets.go`) accepts any non-local address and
port and is valid on OUTPUT (`RedirectTarget` forces loopback).
`writePacket` in `pkg/tcpip/network/ipv4/ipv4.go` re-routes after the
rewrite. Conntrack (`pkg/tcpip/stack/conntrack.go`) reverses DNAT for TCP
and UDP, port 53 included. Upstream tests cover it in `test/iptables/nat.go`
(`NATOutDNAT`, `NATOutDNATAddrOnly`, `NATOutDNATPortOnly`,
`NATOutRedirectUDPPort`). Netstack only allows iptables writes from a
process holding `CAP_NET_ADMIN` in the guest.

## What the spike verified (2026-07-23)

Run against a real runsc sandbox (`--network=sandbox`, release-20260706.0)
on the kind node, using a hand-built veth and netns to keep the node's CNI
out of the picture.

- **The rule can be installed with `--reproduce-nat`.** A `nat` OUTPUT DNAT
  rule written to the pod netns's kernel iptables is copied into netstack
  when the sandbox boots. The sandbox dialed `203.0.113.7:443` (TEST-NET,
  unroutable) and the connection reached the proxy listener
  (`connect() rc=0`). So a chained CNI plugin can pre-install the rule for
  runsc to copy. A `NET_ADMIN` init container is a fallback, not a
  requirement.
- **The proxy cannot recover the original destination.** `getsockname` at
  the proxy returns the proxy's own address. `SO_ORIGINAL_DST` only works
  for a listener inside the same netstack. The target has to come from
  SNI, the Host header, or the sentinel port, which the proxy already
  uses.
- **Traffic without a rule goes nowhere.** `203.0.113.7:80`, with no rule,
  failed to connect and put no packets on the wire.
- **Raw sockets give no bypass.** With `net-raw` and
  `allow-packet-socket-write` on and `CAP_NET_RAW` granted, a
  hand-crafted SYN on a `SOCK_RAW`/`IP_HDRINCL` socket got `ENETUNREACH`
  for both external and on-link destinations. An `AF_PACKET` `SOCK_DGRAM`
  write could only reach `lo`; `eth0` was not exposed. The same dead ends
  prevent source-IP spoofing from inside the sandbox, which is what lets
  the proxy trust the pod IP as identity.

Not verified, and each one blocks adoption:

- a real gVisor pod on managed Cilium, end to end;
- an explicit netstack default-deny filter (the failure above was "no
  route", not an installed DROP);
- an in-sandbox iptables write, to confirm the `CAP_NET_ADMIN` gate.

## What adopting it would cost

### Getting a rule into every pod

The Kubernetes-native option is an istio-init-style `NET_ADMIN` init
container running `iptables -t nat -A OUTPUT …`. One manifest then writes
the pod netns's kernel table for runc pods and netstack's table for gVisor
pods. The `--reproduce-nat` variant instead needs a node-level CNI conflist
edit plus a runsc flag, and on Cilium the agent owns the conflist. Today
netd needs nothing in the pod spec at all.

### The proxy's anti-forgery argument changes

With no Envoy in the path there is no PP2 preamble.
`resolveWorkspaceBySourceIp` requires one, and
`buildProxyIngressNpManifest` admits the transparent ports only from node
CIDRs. Together those make Envoy the only possible sender of a PP2
preamble, which is why a pod cannot claim another workspace's identity.
Direct DNAT means pods must reach those ports. The proxy would need a
direct mode that identifies the workspace by the socket's peer address,
plus a guarantee that it refuses PP2 on pod-sourced connections. Separate
listener ports per mode is the cleanest way to get that.

### A second test matrix

`test/e2e/netd-datapath.test.ts` asserts host-side iptables. A second
datapath needs its own e2e suite and a Cilium cluster to run it on.
Autopilot also blocks netd's privileged DaemonSet, so the platform that
most needs this would still be out for other reasons.

## Rejected alternative: hostinet

runsc `--network=host` makes the sentry open real kernel sockets in the pod
netns. Egress then goes through the pod netns's kernel stack, and an
Istio-ambient style in-pod netfilter rule works under any CNI, managed
Cilium included. The workload cannot tamper with it: hostinet has no guest
iptables, and netlink writes need `CAP_NET_ADMIN`.

It is rejected because it gives the guest the host kernel's socket API,
which is the attack surface netstack exists to remove. gVisor describes
hostinet as for "semi-trusted" workloads. Netstack DNAT keeps full
isolation, which is why it is the variant written up here.

## If this is ever revived

Workspace pods are granted no added capabilities, so even root in the
sandbox lacks the `CAP_NET_ADMIN` netstack requires to delete the rule, and
every packet a workspace sends is generated locally, so a `nat OUTPUT` rule
catches all of it. What remains is getting the rule into every pod, the
proxy's direct mode and a second test matrix: plausibly a week's work
rather than a quarter's.

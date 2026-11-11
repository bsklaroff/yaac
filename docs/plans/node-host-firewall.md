# A host firewall on every Hetzner node

`infra/hetzner-k3s` protects its nodes with a Hetzner Cloud firewall
(`hcloud_firewall.nodes` in `main.tf`): on the public interface it admits
only ICMP and ssh from `ssh_source_cidrs`, and the autoscaler attaches it
to every server it creates. That covers every node the stack makes today,
because every node is a Cloud server.

It stops covering them once a node comes from somewhere else. A Hetzner
dedicated server (an EX44 from Robot, say) cannot carry a Cloud firewall,
and Robot's own firewall cannot attach to a Cloud server, so neither
product's firewall spans a mixed cluster. Rules that apply to every node
have to live on the nodes themselves.

## Proposal

Add a small nftables ruleset to `node.sh.tftpl`. Every node, Cloud server
or dedicated, manual or autoscaled, runs that script, so every node gets
the same rules. Keep the Cloud firewall on the Cloud servers as an outer
layer: it is free and does no harm, but the nftables rules are the control
that holds on every node.

The policy matches the Cloud firewall's, applied to anything arriving on
the public interface:

- Accept established and related traffic.
- Accept ICMP and ICMPv6 (IPv6 neighbor discovery needs the latter).
- Accept DHCP replies (UDP 67 to 68), which a Cloud server's public
  address is configured by.
- Accept TCP 22 from `ssh_source_cidrs`, which tofu's provisioner uses to
  configure the control node.
- Accept UDP 41641, Tailscale's WireGuard port. Without it Tailscale still
  works, but relays through Tailscale's DERP servers, which is slower.
- Drop everything else.

Nothing else on these nodes needs to be reachable from the internet: the
Kubernetes API and the yaac server are tailnet-only, and k3s runs without
traefik or servicelb. So the policy never needs to change after it is
written.

### Filter the public interface, before NAT

The ruleset is its own table, `table inet yaac_host`, with one chain on
the `prerouting` hook at priority -150: after conntrack (-200), so
`ct state` is known, and before destination NAT (-100). Its first rule
returns on any interface other than the public one.

Two choices in that shape matter:

- **Filter by interface, not by address.** The private network, Calico's
  VXLAN device, the `cali*` pod interfaces and `tailscale0` are never
  touched, so node-to-node, pod-to-node (DNS, the kubelet) and tailnet
  traffic need no allow rules, and none can be forgotten. On a dedicated
  server the vSwitch link to the Cloud network is a VLAN interface, so it
  is not the public interface either.
- **Filter before NAT, not on the `input` hook.** An `input` chain sees
  only traffic addressed to the node itself. A connection to a NodePort or
  a pod `hostPort` on the public address is rewritten in prerouting and
  then forwarded to a pod, so it never reaches `input`. Nothing on these
  nodes publishes one today, but a `prerouting` chain closes that path
  regardless.

The table coexists with the iptables-nft tables kube-proxy and Calico
write: nftables runs every base chain on a hook, and a drop in any of them
is final, so these rules can only remove traffic, never admit something
Calico would refuse.

### Which interface is public

Cloud servers name it `eth0` and dedicated servers something like
`enp0s31f6`, so the script finds it the way it finds the private address:
the interface holding the IPv4 default route (`ip -4 route show default`).
It writes that name into the ruleset file, which is fixed for the life of
the node.

### Persisting it

The ruleset goes in its own file, applied by a `yaac-host-firewall`
oneshot unit ordered `Before=network-pre.target`, so after a reboot it is
in place before any interface comes up. The file opens with
`table inet yaac_host {}` and `delete table inet yaac_host` so reapplying
it replaces only this table.

Do not use Ubuntu's `nftables.service` and `/etc/nftables.conf`. Its
stock file opens with `flush ruleset`, which would wipe kube-proxy's and
Calico's tables whenever the unit restarts.

On first boot the rules go on as the script's first step, before apt or
containerd. Nothing listens on the public interface before k3s starts
except sshd, so there is no window where the kubelet or anything else is
exposed.

### Template inputs

`ssh_source_cidrs` may hold IPv4 and IPv6 entries, and nftables keeps them
in separate sets, so `main.tf` passes the template the two lists split on
`strcontains(c, ":")`. An empty set must still declare its type, so the
template emits the `elements` line only when the list is non-empty.

## Why not Calico host policy

Calico can create a HostEndpoint per node automatically
(`KubeControllersConfiguration` with `autoCreate: Enabled`), so one set of
`GlobalNetworkPolicy` objects would cover every node as Kubernetes objects.
It loses to nftables here:

- A node is protected only once calico-node has started and programmed its
  rules. Until then the kubelet's port (10250) and anything else listening
  is open on the public address, on every autoscaled node.
- Calico's default failsafe ports include 6443, so the control node's API
  stays publicly reachable unless `failsafeInboundHostPorts` in
  `FelixConfiguration` is cut down to ssh.
- Host policy also governs pods talking to their own node, so the pod range
  needs an explicit allow or DNS and other node-local traffic breaks.
- If Calico breaks, the nodes lose their firewall with it.

Calico is the better fit only for host policy that varies per node or
changes over time, and this cluster has neither.

## Out of scope

Adding a dedicated server as a node needs more than this. `node.sh.tftpl`
finds its private address through the Cloud metadata service, which a
dedicated server lacks, and a vSwitch link to the Cloud network needs its
own VLAN interface, subnet and MTU. This plan covers only the firewall
such a node would share with the rest.

## Verifying

- From an address outside `ssh_source_cidrs`, every port on a node's public
  address is closed; from inside, ssh answers. Test once with the Cloud
  firewall detached, so the nftables rules are what's measured.
- `yaac cluster check` passes, including its egress gate, and a workspace
  starts on an autoscaled worker.
- `tailscale netcheck` and `tailscale status` on the control node show a
  direct connection to a peer, not a DERP relay.
- After a reboot, `nft list table inet yaac_host` shows the table before
  k3s is running.

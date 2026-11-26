# The default CNIs on kind and the Hetzner stack

A proposal, not built. Workspace and builder sandboxes have no network
interface, and everything they send crosses unix sockets to netd's relay
and the proxy (docs/workspace-egress.md). Nothing yaac relies on for a
sandbox's egress or identity now depends on the CNI, so the clusters yaac
creates can go back to their defaults: kind's kindnet, and k3s's flannel
with its own policy controller on `infra/hetzner-k3s`. Calico would no
longer be installed on either.

## Calico leaves kind and the Hetzner stack

kind's own CNI enforces NetworkPolicy but lets a new pod's first packets
through before the pod is programmed, which was disqualifying while a
workspace's wall was a policy. Every pod that runs untrusted code has no
interface now. The policies that remain surround yaac's
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

## The spike that gates it

It needs a kind cluster created without `disableDefaultCNI` and a
throwaway Hetzner stack, and runs before anything below is built:

- A kind cluster on kindnet, and a Hetzner stack on flannel and k3s's
  policy controller, each pass `yaac cluster check` and the `e2e` tier
  with the socket datapath installed, and the policies around yaac's pods
  are enforced once each pod is up.
- On the Hetzner stack: flannel works against the host's containerd, which
  looks for CNI plugins and config in its own directories, not the ones
  k3s fills for its embedded one; the in-place switch above works on a
  throwaway stack that starts on Calico with workspaces running; and the
  server's tailnet Ingress works, with a pod's traffic to the tailnet
  taking the tailnet, which Calico needed a mark mask for.

## What goes

- On kind: `installCalico`, `sideloadCalicoImages`, `k8s/calico`, and
  `disableDefaultCNI` in `k8s/kind-config.yaml`.
- In `infra/hetzner-k3s`: the two Calico charts, the Felix manifest and its
  step in `control.sh.tftpl`, the flannel and policy switches, the
  kube-proxy pin and `YAAC_KUBE_PROXY_EXTERNAL`.
- From docs/workspace-egress.md, the Calico mark-mask paragraph under
  "Opening an internal destination"; from docs/cluster-setup.md, what its
  Linux sections say about Calico; and `infra/hetzner-k3s/README.md` loses
  its Calico and kube-proxy rows and gains the in-place switch above.

## Risks

- **The policies around yaac's own pods become defense in depth on kind
  and the Hetzner stack.** That holds only while every pod with an
  interface is one yaac wrote. A new kind of pod that runs untrusted code
  must take the socket path (docs/workspace-egress.md "The contract").
- **A node's reboot during the in-place switch** stops the workspaces on
  it, which restart from their checkpoints, and the control node's takes
  the server down while it lasts.

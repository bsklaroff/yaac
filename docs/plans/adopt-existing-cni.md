# Installing into a cluster whose CNI we don't own

`yaac cluster setup` installs Calico itself (pinned by checksum in
`k8s/calico/`) onto a kind cluster created with `disableDefaultCNI`. This
plan makes that step optional: adopt a **Calico the cluster already runs**
— our own, a self-managed one, or a provider-managed one (GKE Dataplane
V1, AKS `--network-policy calico`, or Calico policy-only over the AWS VPC
CNI on EKS).

There is no datapath change here. The netd redirect (docs/session-egress.md)
works unmodified on any CNI that traverses host netfilter and leaves
ClusterIP translation to kube-proxy; what has to change is that four
things yaac currently *assumes* become things it *detects*, plus a refusal
gate for the configurations that would fail silently.

Cilium is explicitly not in scope — see
[`in-sandbox-netstack-dnat.md`](in-sandbox-netstack-dnat.md) for why, and
for the only known way around it.

## What is coupled today

| Surface | Where | Assumption |
|---|---|---|
| CNI install | `features/cluster/setup.ts` (`installCalico`, `sideloadCalicoImages`) | we own the CNI; the cluster was created with no default CNI |
| pod → veth | `k8s/netd/routes.ts` | workload veths are named `cali*`, discoverable as `<podIP> dev X scope link` |
| redirect | `k8s/netd/rules.ts` | pod egress reaches the node's `nat PREROUTING`; kube-proxy owns ClusterIP DNAT |
| world scoping | `features/cluster/cluster-cidrs.ts` (`clusterPodCidrs`) | pod IPs come from Calico IPPools or node `spec.podCIDR` |

Everything else is already CNI-neutral: every policy is plain
`networking.k8s.io/v1` (`features/cluster/policy-manifests.ts`), and netd's
target selection reads only Pods and Services.

## Work

### 1. A bring-your-own-CNI setup mode

`cluster setup` grows a mode that skips `installCalico` and instead runs a
verification gate. The gate is the point of the mode — an unverified
adoption fails as "sessions have no egress" or, worse, as a redirect that
counts packets and never fires.

Verify, and refuse with a specific message on failure:

- **Calico present and in iptables dataplane mode.** Calico's eBPF
  dataplane (`FelixConfiguration.bpfEnabled`) bypasses iptables for pod
  traffic exactly the way Cilium does, so it must be a hard refusal, not a
  warning.
- **kube-proxy is running** and Calico is not replacing it
  (`bpfKubeProxyIptablesCleanupEnabled` / a missing kube-proxy DaemonSet).
  netd's Envoy dials the proxy's ClusterIP from the host netns; without
  kube-proxy that dial has nothing to translate it.
- **`chainInsertMode`** is the default `insert`. `Append` mode changes
  where Calico's own jumps land relative to ours; the append-only design
  is safe either way, but the verification should record which it saw.
- **NetworkPolicy is actually enforced** — a positive probe, not an
  inference from "Calico is installed". Policy-only Calico over a foreign
  IPAM is a supported topology and a misconfigured one looks identical
  until a session escapes. `cluster check`'s existing egress probe covers
  this; it needs to run in the adoption path too.

### 2. Generalize the veth prefix

`CALICO_VETH_PREFIX = 'cali'` in `k8s/netd/routes.ts` is correct only for
Calico's own IPAM. Policy-only Calico over the AWS VPC CNI gives `eni*`;
other pairings give other names.

Make the prefix configuration netd reads from its env (defaulting to
`cali`), set by the server at DaemonSet-apply time from what it detected in
step 1. Do **not** relax the parser to "any device": that prefix is what
guarantees a malformed routing table can never make netd redirect
something that is not a workload, and the file's header says so.

Where the adopted CNI writes no per-workload host route at all, netd has
no pod → veth source and the adoption must refuse. (Calico's
`WorkloadEndpoint` is the tidier source but is served only by the optional
Calico apiserver.)

### 3. Detect the real pod CIDR

`clusterPodCidrs()` already unions Calico IPPools with every node's
`spec.podCIDR` and renders one exclusion per CIDR, so the common adopted
shapes are covered. What is still missing for a cluster we don't own is an
**explicit config** source ahead of both, for allocations neither
publishes — a VPC CNI hands out VPC subnet addresses that appear in no
IPPool and no `spec.podCIDR`. Too-narrow is the dangerous direction: a pod
IP outside the list is treated as world and redirected into the proxy.

The list is resolved at apply time and passed to netd as env, so a CIDR
added to a live cluster needs a re-apply to take effect.

### 4. Namespace privilege and scheduling

netd is `hostNetwork` + `NET_ADMIN`/`NET_RAW` + `system-node-critical` with
a blanket toleration. On a cluster we don't own, that needs the install
namespace labelled for the `privileged` Pod Security Standard, and the
PriorityClass may be contested. Both belong in the preflight so they fail
at setup rather than at first session.

## What does not change

- **The policy plane.** Every manifest in `policy-manifests.ts` is plain
  NetworkPolicy, which every engine enforces natively.
- **Fail-closed.** The floor is the session's own NetworkPolicy (one
  world-ward rule: the node, on netd's listener range), so an adopted
  cluster inherits it unchanged. The extra Felix-specific gift —
  unknown-veth DROP at pod birth, before the endpoint is programmed — is
  what a non-Calico policy engine might not give, which is why kindnet
  stays unusable.
- **yaac-in-yaac.** Nothing in it is CNI-aware: target selection reads
  Pods and Services, the vcluster policies are plain NP, and the
  inner-proxy flip is a host-side reconcile. Adoption costs this
  subsystem nothing.

## Testing

- Unit: the detection helpers and the widened multi-CIDR renderer, in the
  usual `packages/server/test/features/cluster/` and `k8s/netd/test/`
  homes.
- e2e: `test/e2e/netd-datapath.test.ts` already asserts the host-side
  chain against a real cluster. The adoption path needs the same suite run
  against a cluster whose Calico yaac did not install — cheapest version
  is a kind cluster where Calico is applied out-of-band and setup is run
  in adopt mode.
- The refusal gate needs its own coverage: a cluster with Calico in eBPF
  mode must fail setup with the eBPF message, not proceed.

## Out of scope

- Cilium, in any configuration
  ([`in-sandbox-netstack-dnat.md`](in-sandbox-netstack-dnat.md)).
- Multi-node (netd is already a DaemonSet, but the hostPath session model
  is not).
- Installing *policy* for someone else's workloads. yaac's policies select
  only its own pods and vcluster namespaces.

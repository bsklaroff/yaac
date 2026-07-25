# Veth-peer egress: replace Cilium with Calico + netd

Goal: remove Cilium entirely and replace it with two layers:

- **Calico (iptables mode) as the CNI + policy engine**, enforcing policy
  declared as **plain Kubernetes NetworkPolicy objects only** — no Calico
  CRDs, no Cilium CRDs. Felix gives us, off the shelf, the security-critical
  machinery the alternative was to hand-build: fail-closed at pod birth
  (traffic on a workload veth Felix hasn't programmed yet hits the
  dispatch-chain "unknown interface" DROP), per-endpoint anti-spoof,
  label-selector→rule resolution, and rule GC.
- **netd**, a small per-node network daemon (named after `streamd`, and
  deliberately not "agent" — that word means AI agents in this app), which
  does the one thing no standard component ships: a transparent TPROXY
  redirect at the **host-side veth peer** steering session egress into the
  yaac MITM proxy. Validated in [`spikes/README.md`](spikes/README.md).

This implements §4 of [`stock-k8s-multi-node.md`](stock-k8s-multi-node.md)
on the current local (kind) backend. The proxy (`k8s/proxy`) is deliberately
untouched: it already reconstructs identity from a PROXY-protocol-v2
preamble plus SNI/Host/CONNECT and resolves source IP → session via its pod
watch. Only the thing that *stamps* PP2 and *steers* packets changes.

## Locked decisions

- **Calico only, plain-NP only — for now.** v1 supports exactly one policy
  engine: a yaac-installed Calico in iptables mode. We do not abstract over
  policy engines, and we restrict every policy we author to plain
  `networking.k8s.io/v1` NetworkPolicy. The restriction is what keeps the
  managed-cloud ports cheap later (see "Managed-cloud portability"): GKE
  Dataplane V1 and AKS enforce plain NP through *provider-managed* Calicos
  where Calico CRDs are unsupported territory, so any CRD we leaned on
  locally would fork the policy model per provider. Cilium-isms with no
  plain-NP equivalent (`fromEntities: host/remote-node`,
  `kube-apiserver`) become `ipBlock` CIDRs (node CIDR, apiserver
  endpoints) rendered at apply time.
- **No policy engine in netd.** netd programs only the redirect (per-pod
  TPROXY rules + Envoy config). All allow/deny policy is NetworkPolicy,
  built and applied by the server exactly like today's manifest builders.
  The existing plain-NP builders (registry, vcluster session) survive
  unchanged — Calico makes them *actually enforced* on this backend.
- **One datapath everywhere.** No per-backend Cilium/Calico split; the
  local kind backend cuts over completely. Two egress security models is
  double the audit surface, and the Cilium path blocks every managed
  target (spikes/README.md "Cilium portability").
- **Hard cutover, no dual-datapath cluster.** Cilium's eBPF consumes frames
  before host netfilter, so the two mechanisms cannot coexist for A/B
  testing on one cluster. The migration is `yaac cluster delete && yaac
  cluster setup`. The branch lands only with the full e2e suite plus the
  new forgery gate green.
- **The redirector is stock Envoy, not custom forwarder code.** Envoy
  supports exactly what Cilium's embedded Envoy did for us: TPROXY
  listeners (`transparent: true` + `original_dst`), bare `tcp_proxy`, and a
  PROXY-protocol-v2 upstream transport that stamps the original src/dst.
  `k8s/proxy/pp2.ts` is already tested against "the header Cilium's Envoy
  stamps", so the wire format is byte-identical. A hand-rolled Go/Rust
  forwarder is the fallback if the Envoy config surface fights us.
- **Fail-closed is layered, and netd is never load-bearing for deny.**
  A newborn pod is dropped by Felix until programmed; a programmed pod
  whose TPROXY rules netd hasn't installed yet falls through to its
  NetworkPolicy, which allows no world egress. netd being late means *no*
  egress, never open egress.

## Architecture

Two moving parts replace Cilium:

1. **Calico**, installed by cluster setup from vendored, pinned operator
   manifests (`k8s/calico/`, the same vendoring pattern as
   `k8s/vcluster/`). On kind it is the CNI (the kind config keeps
   `disableDefaultCNI: true`; the comment changes from "Cilium fails
   closed" to "Calico fails closed" — kindnet's fail-open enforcement
   remains the reason not to use it). Felix's per-endpoint anti-spoof
   replaces any hand-rolled src-IP check, and its `WorkloadEndpoint`
   resource (`spec.interfaceName`, the `caliXXXX` veth name) gives netd the
   pod→veth binding declaratively — no CRI inspection.
2. **netd DaemonSet** (`yaac-netd`), two containers, hostNetwork:
   - **netd** (`k8s/netd/netd.ts`, TS-on-tsx like `k8s/proxy`, "self only"
     imports; `NET_ADMIN`). Watches pods, Services, and WorkloadEndpoints;
     for each local pod that needs redirecting it installs mangle
     PREROUTING TPROXY rules on the pod's veth peer, and it renders Envoy's
     file-based LDS/CDS config. It also maintains the TPROXY plumbing
     sysctls/routes (fwmark policy route, `rp_filter=0` on peers,
     `src_valid_mark=0` — the recipe from `spikes/README.md` and
     `scripts/tproxy-host-test.sh`).
   - **Envoy redirector** (upstream `envoyproxy/envoy`, digest-pinned and
     mirrored like `registry:2`). For each egress target netd allocates a
     **listener trio** (https/http/tunnel ports from a reserved range):
     TPROXY `original_dst` listeners → `tcp_proxy` → a static cluster on
     the target proxy's ClusterIP:{10256,10257,10258}, with
     `proxy_protocol` upstream transport (PP2 src = pod IP, dst = original
     dst). Host-netns dials to ClusterIPs work because kube-proxy is back
     (Cilium's EDS workaround dies with Cilium).

### Per-pod datapath (session class)

For session pod P with veth peer `IF` (read from its WorkloadEndpoint) and
egress target trio H/T/S, netd installs in the node root netns:

```
mangle PREROUTING (per-pod chain, matched by -i IF):
  -p tcp --dport 443                 -j TPROXY --on-port H --tproxy-mark 0x1/0x1
  -p tcp --dport 80                  -j TPROXY --on-port T --tproxy-mark 0x1/0x1
  -p tcp -d 198.18.0.2 --dport 10259 -j TPROXY --on-port S --tproxy-mark 0x1/0x1
```

Everything else about the pod's connectivity is NetworkPolicy, enforced by
Felix in filter chains *after* the TPROXY divert: DNS direct-dial to the
proxy on 53/udp, registry :5000, vcluster API :8443, intra-session pods,
streamd ingress from the proxy only — and an otherwise-empty egress/ingress
set, i.e. default-deny. The redirected ports (443/80/sentinel) are
deliberately **absent** from the NetworkPolicy: TPROXY'd flows are diverted
before filter FORWARD, and un-redirected flows must die.

The TPROXY mark must sit outside Felix's `IptablesMarkMask`; delivery needs
the `-m socket`/fwmark/policy-route plumbing (mask `0x1/0x1`,
`accept_local=1`) exactly as in the spike. The `src_valid_mark=0` node
fixup stays — the martian-drop failure mode it prevents belongs to TPROXY
itself, not to Cilium (reword the comment in `setup.ts::applyNodeFixups`).

### Policy translation (Cilium objects → plain NetworkPolicy)

The server keeps its build-manifests-and-apply architecture; CNP builders
become NP builders in the same files, applied by the same ensure functions.

| Today (Cilium object) | Replacement |
|---|---|
| `buildEgressRedirectCecManifest` (CEC) | netd Envoy trio per install namespace (redirect layer, not policy) |
| `buildSessionEgressRedirectCnpManifest` | session NP: egress = 53/udp→proxy pods only (443/80/sentinel are TPROXY'd, so no world allows); default-deny by construction |
| `buildSessionIngressLockCnpManifest` | session NP ingress: proxy pods → 10300 only |
| `buildProxyIngressCnpManifest` | proxy NP ingress: node-CIDR `ipBlock` → 10256-58 (Envoy in the host netns is the only legal caller — pods can no longer reach the transparent ports at all, which *simplifies* the forgery lock), host → 10255/10260, session pods + labeled vcluster namespaces → 53/udp |
| `buildEgressWorldDenyCiliumPolicyManifest` | install-ns NP, podSelector matchExpressions (`app NotIn [yaac-proxy]`, `yaac.session-id DoesNotExist`, `yaac.role NotIn [builder]`), `policyTypes: [Egress]`, no rules |
| `buildVclusterFallbackRedirectCcecManifest` + `...CnpManifest` | netd: synced pods get the owning install's outer trio; NP in the vcluster ns: default-deny + 8443→CP + intra-ns + 53/udp→outer proxy (cross-ns via labeled namespaces) |
| inner CEC + override CNP (`buildInnerEgressRedirectCecManifest`, `buildInnerSessionEgressRedirectCnpManifest`) | netd target selection (see yaac-in-yaac below) — no policy object at all |
| `buildInnerProxyIngressCnpManifest` / `buildInnerSessionIngressLockCnpManifest` | NPs in the vcluster ns (owner session → 10260; inner-proxy → 10300; transparent-port ingress disappears — chaining arrives from the node, covered by the proxy NP's node-CIDR rule) |
| `buildVclusterControlPlaneCnpManifest` | NP: egress to apiserver-endpoint + node `ipBlock`s, kube-system `k8s-app=kube-dns`, own managed-by pods |
| `buildActivatorCnpManifest` | NP: ingress node `ipBlock` + sessions :8443; egress apiserver `ipBlock`s + `app=vcluster` CP pods :8443 |
| `buildRegistryIngressCnpManifest` | NP: ingress 5000 from same-project sessions + node-CIDR `ipBlock` |
| `buildRegistrySessionsNetworkPolicyManifest`, `buildRegistryEgressNetworkPolicyManifest`, `buildVclusterSessionNetworkPolicyManifest`, `buildBuilderEgressNetworkPolicyManifest` | **unchanged** — already plain NP, now actually enforced |

Two supporting changes: the server labels vcluster namespaces (plain NP
needs a `namespaceSelector`; Cilium could select on namespace existence),
and cross-namespace DNS/relay rules key on that label.

### Identity and trust model

- **Attested source IP.** Felix drops spoofed sources per endpoint (and the
  gVisor spike showed a netstack guest cannot emit raw/AF_PACKET frames at
  all), so by the time Envoy stamps PP2, src-IP is arrival-veth identity.
  The proxy's `resolveSessionBySourceIp` + pod-watch flow is unchanged, as
  is vcluster attribution (`reconcileVclusterAttribution`).
- **The forgery lock strengthens.** Pods cannot reach the transparent ports
  at all (node-CIDR-only ingress); only Envoy — a trusted DaemonSet — can
  originate PP2.
- **Tenants can't touch the datapath.** TPROXY rules live in the node root
  netns; NetworkPolicy objects are authored only by the server;
  tenant-authored NetworkPolicies in a vcluster stay unsynced
  (`sync.toHost.networkPolicies` disabled) — the tenant-escape e2e
  (`session-create-vcluster.test.ts`) keeps its assertion with the new
  mechanism cited.
- **Enforcement is audited code.** The deny path is Felix + kube-proxy +
  kernel netfilter; yaac-authored datapath code is confined to the
  redirect, which can only ever *add* reachability toward the proxy.

## yaac-in-yaac: override and fallback without priorities

The Cilium priority dance (`SESSION_REDIRECT_PRIORITY=50` vs
`VCLUSTER_FALLBACK_PRIORITY=90`, undocumented lower-wins) is replaced by
netd picking **one egress target per pod**, recomputed on every relevant
watch event:

1. pod has `yaac.session-id` and lives in an install ns → that install's
   trio.
2. pod has `managed-by=<vc>` ∧ `yaac.data-dir-hash=<h>` ∧ `role≠inner-proxy`
   and install `h` has a host-synced inner-proxy Service in the vcluster ns
   → install `h`'s **inner** trio (override).
3. other `managed-by` pod (incl. the inner proxy itself, and any pod with a
   forged/unknown hash) → the vcluster's owning install's **outer** trio
   (fallback). Forging labels stays non-escalating exactly as today.

The backstop semantics match Cilium's: the override exists while the
inner-proxy Service exists; when the Service (or install) disappears netd's
next reconcile pass reverts the pod to rule 3. Discovery reuses the logic
of `selectInnerProxies` (Service name prefix + `yaac.data-dir-hash` label),
which moves from `inner-redirect-reconcile.ts` into netd; the server-side
`inner-redirects` reconcile step and `yaac.projection` labels are deleted.
Chaining is unchanged: the inner proxy's own egress rides rule 3 to the
outer proxy; inner ∩ outer, fail-closed at both layers.

**Inner yaac transparency improves.** A top-level yaac no longer applies
any datapath object beyond plain NPs, so the nested code path stops
diverging: `ensureProxyResources` drops the CEC/CNP applies for *both*
modes, `ensureCiliumCrds` (`platform/k8s/cilium-crds.ts`) is deleted, and
the vcluster needs no policy CRD schemas — plain NetworkPolicy is a core
API every vcluster already serves. The inner install's opt-in signal is
unchanged: the presence of its host-synced proxy Service.

## What the server keeps doing

- `ensureProxyResources`: SA/Role/Deployment/Service/CA + the rewritten NP
  builders. New responsibility: apply the `yaac-netd` DaemonSet (image ref
  + env: transparent-port numbers, sentinel CIDR, POD_STREAM_PORT — the
  constants from `proxy-constants.ts`, passed as env like the proxy's).
  Skipped when nested.
- `create.ts`: unchanged — `dnsPolicy: None` → proxy ClusterIP, CA trust
  env, `GIT_SSH_COMMAND` ncat sentinel, labels. Only comments change.
- `ensureSessionVcluster` / `ensureProjectRegistry` / `ensureActivator`:
  swap their CNP applies for the NP equivalents above; keep everything
  else, including their existing plain NPs.
- `reconciler.ts`: `inner-redirects` and `tproxy-gc` steps deleted
  (`platform/k8s/cilium-tproxy.ts` + `tproxy-gc-reconcile.ts` were a
  workaround for Cilium's leaked-TPROXY-rule bug; netd owns its redirect
  rules — GC'd from its pod-delete watch plus a periodic orphan sweep —
  and Felix owns policy rules).

## Managed-cloud portability

Not in scope to build now, but this is why "Calico only, plain-NP only" is
the constraint that keeps the ports cheap. netd is identical everywhere;
what varies is who runs the policy engine:

| Platform | Policy engine | Notes |
|---|---|---|
| local kind / self-managed k3s | **our Calico** (CNI + policy) | this plan |
| GKE Standard, Dataplane V1 | **Google-managed Calico** (`--enable-network-policy`) | don't install our own; plain NP enforced natively; Calico CRDs unsupported there — hence plain-NP-only |
| EKS (AWS VPC CNI) | **our Calico, policy-only mode** (AWS-documented pattern) | do *not* use AWS's network-policy agent: it enforces via TC eBPF *before* netfilter, which would force NP world-allows on 443/80 and break the netd-late fail-closed floor; its default mode is also fail-open at pod birth |
| AKS (Azure CNI, non-Cilium) | **Microsoft-managed Calico** (`--network-policy calico`) | plain NP enforced; Microsoft is steering toward Cilium long-term — another reason to stay on the plain-NP subset |
| GKE DPv2 / Autopilot, AKS-Cilium, **DOKS** | out of scope | Cilium-mandated (DOKS's Cilium CNI is not replaceable), which defeats the veth-peer redirect itself; the in-sandbox-DNAT spike is the only candidate there |

The DOKS row corrects `stock-k8s-multi-node.md`, which listed DOKS as the
reference managed port (DigitalOcean stays reachable via self-managed
droplets + k3s).

## Cluster lifecycle

- **setup** (`features/cluster/setup.ts`): delete `installCilium`,
  `ensureCiliumCli`, `CILIUM_VERSION`, `CILIUM_CLI_VERSION` (and the brew
  formula's `cilium-cli` dependency). Add `installCalico` applying the
  vendored pinned manifests (`CALICO_VERSION`), then wait for the
  calico-node DaemonSet + a Ready node. Build/push the netd image
  (content-hashed like the proxy) and apply the DaemonSet before `check`.
- **check** (`features/cluster/check.ts`): `envoy-config` (CEC CRD probe)
  becomes two probes: calico-node Ready, and `yaac-netd` Ready with rules
  programmed on the node. `runNetworkPolicyProbe` survives nearly as-is —
  it asserts *behavior* (probe pod's direct egress blocked, transparent
  port unreachable), which is mechanism-independent; it stops pre-applying
  the CNP and instead applies the session NP set. `src_valid_mark` check:
  keep, reworded. Nested skips: unchanged in shape ("host-side datapath
  assertions").
- **delete**: unchanged (`kind delete` takes everything); the CCEC sweep in
  `test/global-setup.ts` is deleted — no cluster-scoped objects remain.

## Deletion inventory

Code: `cilium-crds.ts`, `cilium-tproxy.ts`, `tproxy-gc-reconcile.ts`,
`inner-redirect-reconcile.ts` (logic moves to netd), all CEC/CCEC/CNP
builders + `redirectListenerAndCluster`/`buildRedirectCec`/`listenerRef`
machinery in `proxy-manifests.ts` (CNP builders are *rewritten* as NP
builders, not just dropped), both priority constants and the projection
label constants in `proxy-constants.ts`, `ensureCiliumCli`/`installCilium`
in `setup.ts`, and the corresponding unit tests. The existing plain-NP
builders stay. Scripts `diagnose-egress-tproxy.sh`/`tproxy-host-test.sh`
are *kept* — they debug our TPROXY now — with headers updated.

Docs: rewrite the egress sections of `docs/nested-containers.md` (priority
model → target-selection model; `ensureCiliumCrds` section deleted),
`docs/cluster-setup.md`, `README.md`, `AGENTS.md` (gating note), the
`moving-off-kind.md` "Cilium, non-negotiable" constraint (becomes
Calico + netd), and `docs/trust-split-builds.md`/
`docs/vcluster-scale-to-zero.md` citations. Per doc conventions, no "we
used to run Cilium" narration.

## Test migration

- `test/e2e/transparent-egress.test.ts`: behavior-level, survives with the
  describe renamed; the "forgery lock" case now asserts the transparent
  ports are unreachable from a session at all. Stays the acceptance gate,
  plain + nested classes.
- `test/e2e/inner-redirect-priority.test.ts`: deleted (it guarded
  undocumented Cilium behavior). Replaced by an **override e2e** with the
  same three-act structure — synced pod egresses via outer trio; creating a
  labeled inner-proxy Service flips it to the inner trio; deleting the
  Service reverts it — asserted through real traffic. Mandatory, but no
  longer a "re-run on every upgrade" release-blocker since target
  selection is our own documented behavior.
- New e2es: fail-closed-at-birth (a session pod created while netd is
  scaled to zero has no egress at all, gains redirected egress on netd
  return), anti-spoof (forged-src frames from a `net-raw` pod never reach
  the proxy as another session), netd-restart rule reconvergence.
- Unit tests: new suites for netd's target-selection/renderer (pure
  functions: pod+Service+WorkloadEndpoint snapshot → desired TPROXY
  chains + Envoy files — same testing shape as the manifest builders) and
  for every rewritten NP builder, in the mirrored test paths per repo
  convention.
- `IS_NESTED_YAAC` gating stays for host-datapath assertions.

## Phasing

1. **Spike closure** (small, on a scratch kind cluster): kind + Calico + a
   real gVisor pod + hand-run TPROXY-to-Envoy recipe end-to-end. This must
   answer the Felix-coexistence questions (below) and the Envoy TPROXY+PP2
   bet before anything is built. Kill criteria: Envoy can't express the
   combo (→ Go forwarder fallback); Felix's INPUT-path handling of TPROXY'd
   flows can't be made to work (→ revisit mark-scoped accepts or the
   netd-owns-policy fallback design).
2. **Build the components**: `k8s/calico/` vendored manifests, `k8s/netd/`
   (netd + Envoy config templates), images in `test/global-setup.ts` with
   `contextHash()` / digest mirroring, DaemonSet manifests.
3. **Cutover branch**: Cilium deletions + NP builder rewrites + netd
   integration + check rewrite + test migration, landed as one reviewed
   branch gated on full e2e (including yaac-in-yaac and the new gates)
   against a freshly-`cluster setup` cluster.
4. **Docs + packaging sweep**, then delete this plan per convention.

## Open questions

1. **Envoy as redirector** — listener `transparent`/`original_dst` + PP2
   upstream transport are all stock Envoy features, but this exact
   combination (TPROXY intercept in the host netns, original dst preserved
   into PP2) must be proven first.
2. **Felix coexistence with the TPROXY divert** — the co-headliner.
   (a) Does Felix apply workload egress policy on the workload→host INPUT
   path that TPROXY'd flows take (`cali-wl-to-host` /
   `DefaultEndpointToHostAction`)? If yes, locally-delivered redirected
   flows need an explicit accept keyed on the TPROXY socket match/mark,
   and that accept must survive Felix's chain management
   (`ChainInsertMode` is top-or-bottom only). (b) Mark-bit budget: our
   mark must sit outside `IptablesMarkMask`. (c) Felix-managed `rp_filter`
   sysctls on `cali*` interfaces vs the TPROXY requirement.
3. **Trio port allocation** — derive deterministically from a hash of the
   install namespace (collision-checked) so netd recovers it statelessly
   after restart.
4. **conntrack on target flips** — when a pod's trio changes (inner install
   appears/disappears), established flows pin to the old target until they
   die. Cilium had the same semantics; decide whether to flush per-pod
   conntrack entries on flip or document it.
5. **Calico version/upgrade cadence** — we own the pin locally (vendored
   manifests) but should decide the upgrade policy and which datapath
   (iptables vs nftables backend) we standardize on before the cutover.

# Stock multi-node Kubernetes (self-managed pools, EKS-AL, AKS-Ubuntu)

Goal: run yaac on a multi-node, stock Kubernetes cluster — where the control
plane is remote and we do not `podman exec` the nodes.

## Locked decisions

- **Threat model: hostile multi-tenant.** Untrusted users share a cluster
  and must be isolated from each other and the host. This is what makes the
  strong-isolation runtime non-negotiable and rules out relaxing to
  plain-userns runc.
- **Nested / docker-in-docker sessions are a hard requirement.** They run
  untrusted container builds inside a session; this is where gVisor most
  earns its keep (the sentry lets the nested engine run as real root without
  the rootless-in-userns apparatus).
- **gVisor stays required, as defense-in-depth — not optional.** Its value
  over plain userns is host-kernel *attack-surface reduction*: untrusted
  syscalls hit the sentry's userspace kernel, not the host kernel, so a host
  kernel 0-day is largely unreachable. userns only remaps the UID; the code
  still calls the host kernel directly. (The two don't stack — runsc has no
  idmapped-mount support — so the sentry *replaces* userns as the wall and is
  the stronger one.)
- **Consequence, accepted:** the runsc-install node surgery (§3) is
  unavoidable, so the portability ceiling below is the price of this security
  posture. Not universally portable, by design.
- **Redirect + policy: split, and shipped (§4).** Calico is the CNI and the
  policy engine (plain `networking.k8s.io/v1` only); netd, a per-node
  DaemonSet, owns nothing but a `nat` DNAT at each session pod's **host-side
  veth peer** steering 443/80/sentinel into the yaac proxy. The redirect must
  sit at the veth *peer*, not inside the pod netns — gVisor's netstack emits
  egress as raw L2 frames via AF_PACKET, so the pod netns's own IP-layer
  netfilter never sees it. This is CNI-sensitive, not CNI-independent: it
  needs a CNI that traverses host netfilter, which rules out Cilium.

Scope reality check (the runsc install, §3, is the binding constraint): the
non-negotiable gVisor requirement means the target is **self-managed node
pools (droplets + k3s + own CNI) as the primary, fully-supported case**, with
*some* managed engines as per-provider ports (EKS-AL / AKS-Ubuntu, each
vendor-unsupported for the runtime install), a **separate adapter for GKE**
(adopt GKE Sandbox on the legacy dataplane), and Autopilot / Fargate /
Bottlerocket / **DOKS** out of scope — DOKS's CNI is a mandatory,
non-replaceable Cilium (BYO-CNI unsupported), which defeats the §4 veth-peer
redirect; DigitalOcean stays reachable via self-managed droplets + k3s.
"Runs on any stock managed cluster" is not achievable; EKS-AL is the
reference *managed* port, not a universal guarantee. The §4 datapath has
shipped on the current backend: docs/session-egress.md.

This is the third track alongside two existing plans, and it subsumes parts
of both:

- `moving-off-kind.md` — replace the node-in-a-container backend; still
  single-node, still local. Its buildkitd-in-cluster spike and
  "main registry in-cluster" section are prerequisites here.
- `multi-node-storage-plan.md` — shared project state across nodes. Its
  gVisor-enables-NFS analysis, shared-vs-node-local dir split, and NFS spike
  apply here unchanged; only the mount mechanism differs (CSI PV instead of
  node automount + hostPath).

## The one-sentence architecture change

Today yaac is **a host process that shares a filesystem with its single
node** (hostPath everywhere, `$HOME` bound into the kind node, podman on the
same machine). On stock multi-node k8s it must become **a set of in-cluster
workloads using only portable primitives**: PVCs instead of hostPath, an
image registry instead of a shared podman engine, DaemonSets instead of
`podman exec <node>`, and the API server as the only path to pods.

Moving the server itself into the cluster is the keystone. The storage
plan's invariant 1 — "the server is a host process, so no host-mountable
PVC exists" — dissolves once the server is a Deployment: server and session
pods can then mount the *same* RWX PVC, and the entire hostPath model
converts to PVC + subPath with no change to the path layout the code sees.

## Assumption-by-assumption delta

### 1. The server: host process → in-cluster Deployment

- Single-replica Deployment; pglite DB (`<dataDir>/db`), preferences, logs
  on a RWO block-storage PVC (do-block-storage). pglite is embedded
  single-writer — `Recreate` strategy, never scaled.
- Project/session state moves to the shared RWX volume (§2); `getDataDir()`
  keeps working — the pod mounts the volumes at the paths the code already
  uses.
- Ingress: LB/Ingress with real TLS in front of the existing
  `YAAC_ALLOWED_HOSTS` + `YAAC_TRUST_PROXY` + token auth (the
  remote-hosting model already assumes clients are remote; Tailscale
  becomes one option among LB+auth options).
- The auth broker (`yaac auth server`) already runs on the user's laptop
  and connects outbound — unchanged.
- `kubectl`/client-node calls are already context-agnostic; in-cluster they
  use the service account. The `ExecTunnel` and stream-relay port-forward
  paths work against any apiserver.
- Machine-scoped CLI (`yaac cluster *`, `yaac server *`) grows an
  "attach/installer" mode (§7) since there is no machine to set up.

### 2. Storage: hostPath → PVCs (RWX for shared, node-local for hot dirs)

DO block storage is RWO-only and there is no managed RWX filesystem, so we
bring the shared layer ourselves. Primary: **NFS via a CSI driver**
(csi-driver-nfs against an NFS server we run — in-cluster ganesha or a
dedicated droplet). Fallback: Rook-CephFS. The gVisor go/no-go spike chain
from `multi-node-storage-plan.md` (ownership, O_EXCL, rename, hardlinks,
coherence with external writers, perf) applies verbatim — run it against
the CSI-mounted PV. Managed nodes actually simplify this: kubelet mounts
the PV; no node automount units, no "mount before kubelet" ordering.

- `pod-spec.ts` volume rendering becomes pluggable: each `HostPathMount`
  gains a source — `hostPath` (local backends, unchanged) or
  `pvc + subPath` (stock backend). Container-side paths are identical.
- The shared/node-local split from the storage plan carries over: `claude/`,
  `claude.json`, `codex/`, `pi/`, `opencode-config/`, `repo/.git`,
  cache-volumes on the RWX volume; `worktrees/<sid>` initially shared too
  (simplest — the server pod's `addWorktree` and the session pod then see
  the same object store with zero new machinery); tmux socket and
  per-session scratch demoted to emptyDir; opencode sqlite node-local with
  resume node-affinity.
- **Unix-socket hostPath rendezvous is dead cross-node.** tmux is fine
  (every consumer already goes through exec/streamd, and the socket can be
  pod-local emptyDir once the pane log needn't outlive the pod). The
  **ssh-agent socket** shared between the proxy pod and session pods via
  `sshAgentHostDir` is the real break: agent forwarding must move onto the
  stream relay (a `tcp`/`ctrl` streamd channel carrying the agent
  protocol) or a per-session agent. This is a discrete work item.
- e2e scratch (`e2eTmpBase`) hostPath fixtures become PVC-backed on the
  stock backend.

### 3. gVisor: `podman exec` install → privileged installer DaemonSet

The containment model (sentry for sessions, no userns) is non-negotiable
and is also what makes NFS usable. No managed engine lets us install a
runtime the clean way, so the node agent (§4) does it:

- A privileged **installer DaemonSet** (the GPU-driver pattern): drops the
  pinned `runsc` + `containerd-shim-runsc-v1` onto the node, patches
  containerd config with the two handlers (`host-uds=all`, `allow-suid`,
  systrap), restarts containerd, labels the node. RuntimeClasses gain a
  `nodeSelector` on that label so pods only schedule where the shim exists.
- Node recycling (node-pool upgrades replace nodes) is handled for free —
  the DaemonSet reapplies on every new node. This replaces `--repair`.
- Prefer a dedicated **sessions node pool** for the installer's blast
  radius; infra (proxy, registries, server) runs on a stock pool on runc.
- **This is the binding portability constraint.** Mutating a managed node's
  containerd is vendor-*unsupported* but mechanically works on mutable-OS
  pools (DOKS; EKS AL2023/AL2, needs a node reboot + manual gVisor
  mount-hint config; AKS Ubuntu). It is **blocked** on immutable OS (EKS
  Bottlerocket) and on the no-node-access tiers (GKE Autopilot, EKS
  Fargate); on **GKE** you must instead adopt GKE Sandbox (managed gVisor,
  COS-only). So the reachable set is: self-managed (primary), EKS-AL,
  AKS-Ubuntu — the same envelope the §4 networking needs, since both ride
  the same privileged node install (DOKS passes this bar but fails §4's:
  its Cilium CNI is not replaceable).
- Spike: verify on a real target node — OS/containerd config include path,
  survival across a node-pool upgrade, the cluster-check sentry/dmesg probe.

### 4. Networking / egress: shipped, and multi-node-clean

**This section has shipped** on the current backend, in a different shape
than originally planned — the current-state reference is
docs/session-egress.md. Summary of what it settled, because the rest of
this plan leans on it:

- **Calico is the CNI and the policy engine**, enforcing plain
  `networking.k8s.io/v1` NetworkPolicy only. The earlier "any minimal CNI
  works, all policy in the node agent" position did not survive: kindnet's
  policy engine fails OPEN at pod birth, and writing our own policy plane
  bought nothing that Felix does not do better and audited.
- **netd** (a per-node DaemonSet) owns only the redirect: a `nat` DNAT
  appended to `nat PREROUTING`, keyed on the pod's host-side veth, aiming
  443/80/ssh-sentinel at a node-local Envoy that recovers the pre-DNAT
  destination and forwards to the yaac proxy behind a PROXY-protocol-v2
  preamble. TPROXY was tried first and retired: a TPROXY'd flow is
  delivered locally, which puts it on the workload→host INPUT path where
  Felix applies the pod's *egress* policy, and Felix re-inserts its jumps
  at the top of every base chain it manages, so no yaac rule can hold a
  position above `cali-INPUT`.
- **The attach point survived the redesign**: the host-side veth peer, not
  the pod netns. A gVisor pod's sentry drives `eth0` at L2 via AF_PACKET,
  so the pod netns's own IP-layer netfilter never sees egress. Identity is
  which veth the frame arrived on, which a sandboxed workload cannot forge.
- **Fail-closed lives in the NetworkPolicy**, not in netd: a session's only
  world-ward rule is the node on netd's listener range, so an unprogrammed
  pod's traffic keeps its real destination and is dropped. netd being down
  or late costs egress; it can never grant it.

**Multi-node status: clean.** netd is already a DaemonSet, its rules are
per-node and recomputed statelessly from cluster state, and the redirect
target is the pod's own node. Nothing in the datapath assumes one node.

**Portability envelope** (docs/session-egress.md has the full table): any
CNI that traverses host netfilter and leaves ClusterIP translation to
kube-proxy. That covers self-managed Calico, EKS's VPC CNI with Calico in
policy-only mode, GKE Standard on Dataplane V1, and AKS with the
Microsoft-managed Calico. **Cilium-mandated platforms are out** — GKE
Dataplane V2 / Autopilot, AKS-Cilium, DOKS — because eBPF host-routing
short-circuits the netfilter hook the redirect needs. The only known way
around that is docs/plans/in-sandbox-netstack-dnat.md, which is written up
and deliberately not planned.

**Remaining work here is adoption, not viability**: installing into a
cluster whose Calico we did not install (docs/plans/adopt-existing-cni.md)
— detecting the dataplane mode, the veth naming, and the real pod CIDRs
instead of assuming them.

### 5. Images: host podman + localhost registry → in-cluster builds + real registry

- **Builds**: `podman build` on the server host is replaced by
  buildkitd-in-cluster + `buildctl` (spike 2 of `moving-off-kind.md`,
  now mandatory). Trust-split untrusted layers already build in in-cluster
  runsc builder pods and only need registry reachability.
- **Main registry**: the `localhost:5001` podman container, the `kind`
  network join, and the node `hosts.toml` fixup all disappear. Two options:
  DO Container Registry (DOCR — TLS, DOKS-integrated pull secrets, zero
  node config; adds a DO dependency + egress cost) or an in-cluster
  registry Service with proper certs (what per-project registries almost
  are). Either way "the registry is the only image bus" becomes literally
  true. Content-hash tags + `IfNotPresent` survive unchanged.
- **Per-project registries** are already in-cluster and loop all nodes for
  `hosts.toml` via privileged node-write pods — that pattern still works on
  managed nodes (privileged pods are allowed), but their storage hostPath
  (`/var/lib/yaac/registry/<hash>`) becomes a PVC.
- **Image salvage / shared image store**: the node-local
  `/var/lib/yaac/imagecache` hostPath + unpinned writer pod is already a
  latent multi-node bug. Replace store-on-disk promotion with **push to the
  project registry** (salvage writer pushes; nested engines pull) — one
  distribution mechanism, no node affinity. If the per-file pull cost hurts,
  a per-node cache DaemonSet is an optimization, not a correctness need.
- **Builder pods** carry a reserved `yaac.role=builder` label, kept
  unforgeable by the stock-k8s builder-role `ValidatingAdmissionPolicy` (no
  ServiceAccount may set it; the pod must be gvisor). The node agent gives a
  builder-labeled pod the direct-egress policy its registry/package fetches
  need, in place of the session default-deny.

### 6. Scheduling, capacity, disruption

- **Honest requests + the priority split: shipped** on the current backend.
  Session pods request cpu and ephemeral-storage alongside memory (no cpu
  limit — a CFS quota throttles an interactive agent), and every yaac pod
  names a PriorityClass, infra above sessions (docs/cluster-setup.md).
  Node-pool autoscaling works out of the box now that requests are honest.
- **Node drains kill sessions**: Jobs with `restartPolicy: Never`,
  `backoffLimit: 0`, and node-local scratch do not survive a node-pool
  upgrade. v1 answer: document it, surface a "node draining" session state,
  and rely on the shared volume holding `repo/.git` + tool state so a restart
  loses only in-flight scratch. A checkpoint/migrate story is out of scope.
- vcluster sessions carry over (control plane is just pods); the nested
  data dir moves onto the shared volume mounted at the same in-pod path,
  and the synced-pod `ValidatingAdmissionPolicy` guard is stock k8s (its CEL
  literal moves from a hostPath prefix to the PVC/subPath after §2).

### 7. Cluster lifecycle: setup/check become provider-aware

- `yaac cluster setup` splits into backends: the existing local path
  (kind, later k3s per `moving-off-kind.md`) and **`yaac cluster attach`**
  for a bring-your-own cluster: **probe the §3/§4 capabilities and refuse the
  unsupported tiers** (node OS mutable enough to install runsc, privileged
  `hostNetwork`+`NET_ADMIN` DaemonSets admitted, chained-CNI writable, VAP
  API, storage classes, k8s version) — Autopilot / Fargate / Bottlerocket
  fail the probe; GKE routes to the Sandbox adapter. Then install in-cluster
  components (proxy, RuntimeClasses + the node agent, registry, priority
  classes) and record the backend in config.
- Every `podman exec <node>` fixup either dies with kind (sysfs, TasksMax,
  pids-limit — node-container artifacts) or moves into the installer
  DaemonSet if still wanted on real nodes (vm sysctls).
- `cluster check` probes are already in-cluster pods and mostly carry over;
  the hostPath-write-at-session-uid probe becomes an RWX-PV write probe;
  the "single node assumed" warning inverts into a multi-node readiness
  check (RuntimeClass node coverage, registry reachability per node,
  shared-volume visibility per node).

## What survives unchanged

The parts already built against the API server rather than the host:
stream relay (streamd, proxy relay, `ExecTunnel`), tmux status/attach via
exec, content-hash image tagging, trust-split builder pods, per-project
registry topology, the `ValidatingAdmissionPolicy` guards (builder-role and
vcluster synced-pod — stock k8s, unaffected), vcluster sessions, the remote
client/auth-broker model, and the DB layer (pglite on a private volume). The
egress plane (§4) carries over as-is: plain NetworkPolicy enforced by the
cluster's Calico, plus netd's per-node redirect, both already multi-node
shaped.

## Phasing

1. **Spikes (kill-order):**
   - ~~Node agent owns the redirect at the veth peer~~ — **done and
     shipped** (§4, docs/session-egress.md), forgery e2e included. What is
     left for this plan is adopting a Calico we did not install
     (docs/plans/adopt-existing-cni.md), which is a probe, not a spike.
   - gVisor installer DaemonSet on a target node pool; sentry probe green;
     survive a node-pool upgrade.
   - RWX (NFS-CSI) under gVisor: the storage plan's probe chain + perf
     numbers.
   - buildkitd-in-cluster + push/pull against DOCR or in-cluster registry.
2. **Host-decoupling that pays off on single-node too** (land on the
   current backend first): buildkit builds behind a builder abstraction,
   registry in-cluster, salvage-via-registry, ssh-agent over the stream
   relay, tmux socket to emptyDir, shared/node-local root split in
   `project-paths.ts`.
3. **Server-in-cluster mode:** volume-source abstraction in `pod-spec.ts`
   (hostPath | PVC), server Deployment + PVCs, `yaac cluster attach`
   installer, provider-aware check.
4. **Multi-node rehearsal, then a real managed cluster:** multi-node kind
   with per-node extraMounts (from the storage plan) to shake out scheduling
   bugs cheaply, then a real EKS-AL/self-managed cluster behind the spikes.

## Open questions

- Multi-tenancy: remote-hosting is one-developer today; a shared cluster
  invites multi-user auth/quotas — explicitly out of scope here.
- NFS server placement and SPOF story (in-cluster vs droplet; backups).
- DOCR vs self-hosted registry (cost, egress, coupling to DO).
- Build vs reuse of the istio-cni/ztunnel plumbing: crib the technique into
  the node agent, or vendor pieces and own the per-platform hardening.
- Node-drain UX for long-running sessions (surfacing, auto-restart
  semantics).

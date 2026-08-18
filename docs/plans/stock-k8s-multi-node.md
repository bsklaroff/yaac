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
shipped on the current backend: docs/worktree-egress.md.

This is the third track alongside two existing plans, and it subsumes parts
of both:

- `moving-off-kind.md` — replace the node-in-a-container backend; still
  single-node, still local. Its buildkitd-in-cluster spike is a
  prerequisite here (its main-registry-in-cluster section has shipped).
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

- ~~`pod-spec.ts` volume rendering becomes pluggable~~ — **done**. A
  session mount is `{source, mountPath, readOnly?}` where the source is
  `hostPath` (what every tier renders as on the local backend),
  `pvc + subPath` (rendered, selected by nothing yet — it waits on the
  claims and the in-cluster server below), or `emptyDir`. Container-side
  paths do not depend on the source.
- The shared/node-local split from the storage plan carries over: `claude/`,
  `claude.json`, `codex/`, `pi/`, `opencode-config/`, `repo/.git`,
  cache-volumes on the RWX volume; `worktrees/<sid>` initially shared too
  (simplest — the server pod's `addWorktree` and the session pod then see
  the same object store with zero new machinery); tmux socket and
  per-session scratch demoted to emptyDir; opencode sqlite node-local with
  resume node-affinity. **The path layer already declares this split**
  (`sharedRoot` / `nodeLocalRoot` / `serverLocalRoot` in
  packages/shared/src/paths.ts, one tier per helper in project-paths.ts,
  all three resolving to today's data dir) — see the storage plan's
  "Split shared vs node-local roots" for the per-directory verdicts. What
  is left here is pointing the roots at different volume sources.
- **Unix-socket hostPath rendezvous is dead cross-node.** tmux is **done**:
  every consumer goes through exec/streamd, nothing was ever written into
  the socket dir but the socket, so it is a pod-local emptyDir and
  `sessionTmuxDir()` is gone. The
  **ssh-agent socket** was the real break, and is **done**: the proxy
  serves the agent protocol on its own port, session pods run a local
  forwarder that re-exposes it at the unchanged `SSH_AUTH_SOCK` path, and
  the socket dir is a pod-local emptyDir (docs/worktree-egress.md, "The two
  direct pod→proxy dials").
- e2e scratch (`testTmpBase`) hostPath fixtures become PVC-backed on the
  stock backend.

### 3. gVisor: `podman exec` install → privileged installer DaemonSet

The containment model (sentry for sessions, no userns) is non-negotiable
and is also what makes NFS usable. No managed engine lets us install a
runtime the clean way, so a privileged DaemonSet does it.

**The mechanism has shipped** on the current backend — `yaac-gvisor-install`
(drivers/k8s/install/gvisor-installer.ts), the current-state reference is
docs/cluster-setup.md §4:

- The **installer DaemonSet** (the GPU-driver pattern) drops the pinned
  `runsc` + `containerd-shim-runsc-v1` onto each node it lands on, patches
  that node's containerd config with the two handlers (`host-uds=all`,
  `allow-suid`, systrap), restarts containerd through PID 1's mount
  namespace, and labels the node. The RuntimeClasses carry a
  `scheduling.nodeSelector` on that label, so pods only schedule where the
  shim exists. It is the ONE install mechanism: kind goes through it too,
  being just a mutable-OS node with the same containerd config.
- Node recycling (node-pool upgrades replace nodes) is handled for free —
  the DaemonSet reapplies on every new node. This took the runtime out of
  the install's node-fixup tail, which now owns only the
  kind-node-container state that has no node-side agent (sysctls,
  TasksMax, pids limit, registry wiring).
- The binaries are fetched **from the node**, not pushed from the server:
  the pinned release, verified against its published sha512 and cached
  node-locally. A server-side cache cannot help a node yaac has no shell on.
- The installer image is upstream digest-pinned `curlimages/curl`, not a
  yaac-built one — the install needs a shell, curl, sha512sum and nsenter,
  and must work before any yaac image or host podman exists.
- Still to do here: a dedicated **sessions node pool** for the installer's
  blast radius. Both knobs it needs are now plumbed and default to a
  no-op — `nodeSelector` on the DaemonSet builder (where the runtime gets
  installed, and where a containerd restart is spent) and `tolerations` on
  the RuntimeClasses (what lets sandboxed pods onto the tainted pool, merged
  by admission into every pod naming the class). Cluster check matches node
  taints against those same tolerations, so a tainted pool reads as usable
  rather than as zero eligible nodes. What is left is the config surface
  that sets them, plus a real pool to point them at; the RuntimeClass
  *selector* still needs no edit, because it selects on what the installer
  stamps, not on the pool.
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
- Spike (unchanged, and now a matter of pointing the shipped DaemonSet at
  one): verify on a real target node — OS/containerd config include path
  (the installer appends to `/etc/containerd/config.toml` and refuses a node
  without one, rather than writing a fresh config that would lose the
  node's defaults), whether `systemctl restart containerd` is the right
  restart there (k3s embeds containerd), survival across a node-pool
  upgrade, and the cluster-check sentry/dmesg probe.

### 4. Networking / egress: shipped, and multi-node-clean

**This section has shipped** on the current backend, in a different shape
than originally planned — the current-state reference is
docs/worktree-egress.md. Summary of what it settled, because the rest of
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

**Portability envelope** (docs/worktree-egress.md has the full table): any
CNI that traverses host netfilter and leaves ClusterIP translation to
kube-proxy. That covers self-managed Calico, EKS's VPC CNI with Calico in
policy-only mode, GKE Standard on Dataplane V1, and AKS with the
Microsoft-managed Calico. **Cilium-mandated platforms are out** — GKE
Dataplane V2 / Autopilot, AKS-Cilium, DOKS — because eBPF host-routing
short-circuits the netfilter hook the redirect needs. The only known way
around that is docs/plans/in-sandbox-netstack-dnat.md, which is written up
and deliberately not planned.

**Adoption has shipped too**: `yaac cluster install --adopt-cni` installs
into a cluster whose Calico we did not install, detecting the dataplane
mode, the veth naming and the real pod CIDRs instead of assuming them, and
refusing the configurations that would otherwise fail silently (Calico in
eBPF mode, a replaced kube-proxy, an empty pod-CIDR set, a veth prefix that
resolves nothing). Current-state reference: docs/cluster-setup.md,
"Adopting a CNI yaac did not install". So the §4 networking envelope is
reachable on a real managed cluster without further design work here.

### 5. Images: host podman + localhost registry → in-cluster builds + real registry

- **Builds**: `podman build` on the server host is replaced by
  buildkitd-in-cluster + `buildctl` (spike 2 of `moving-off-kind.md`,
  now mandatory). Trust-split untrusted layers already build in in-cluster
  runsc builder pods and only need registry reachability.
- **Main registry**: **done** — it is an in-cluster `registry:2`
  Deployment + ClusterIP Service on the per-project registries' pattern, so
  the podman container, the `kind` network join, and the `localhost:5001`
  node `hosts.toml` fixup are all gone. The server reaches it over a
  `kubectl port-forward`; content-hash tags + `IfNotPresent` are unchanged.
  What is left is TLS/auth, if the registry ever has to be addressable from
  outside the cluster (DOCR remains the alternative there — TLS,
  DOKS-integrated pull secrets, zero node config, at the cost of a DO
  dependency and egress).
- **Registry storage**: **done** — both registries store on an RWO PVC
  bound through the cluster's *default* StorageClass, so the store belongs
  to the claim rather than to whatever node the pod last landed on. That is
  what let the per-project registries' node pin go: placement is the
  scheduler's, constrained by the bound volume's own affinity, so a
  reschedule can neither strand a multi-GB store nothing reclaims nor bring
  the registry back serving a *different* store than the collect just
  pruned. RWO is enough — both are `replicas: 1` + `Recreate` — and it still
  admits the collect pod beside the serving registry on one node. Their
  `hosts.toml` loop over all nodes via privileged node-write pods still
  works on managed nodes (privileged pods are allowed). On kind the default
  class is rancher local-path, so the directory behind the claim is still
  node-local; what the PVC buys there is stickiness, not mobility. See
  docs/cluster-setup.md.
- ~~**Image salvage / shared image store**~~ — **done**. The cross-session
  image cache for nested sessions travels through the project's in-cluster
  registry: the session pushes what its in-pod engine built or pulled, a
  later session pulls it back. The registry is the only distribution
  mechanism, so a session scheduled on a different node than the one that
  built the images still gets the cache. The push runs *inside* the sandbox
  because the one hard constraint is that no layer may be extracted
  file-by-file through the gVisor gofer (~2ms/file; a 4GB salvage took 16+
  minutes) — the engine's graphroot is a sentry-internal tmpfs, so the push
  reads at native speed and streams blobs out over netstack, the same shape
  the trust-split builder pods already push with. The read side is a
  per-node read-only materialization of that registry (store-writer.ts):
  a cache, so still no node affinity — a session on a cold node runs cold
  rather than being pinned.
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

- `yaac cluster install` splits into backends: the existing local path
  (kind, later k3s per `moving-off-kind.md`) and **`yaac cluster attach`**
  for a bring-your-own cluster: **probe the §3/§4 capabilities and refuse the
  unsupported tiers** (node OS mutable enough to install runsc, privileged
  `hostNetwork`+`NET_ADMIN` DaemonSets admitted, chained-CNI writable, VAP
  API, storage classes, k8s version) — Autopilot / Fargate / Bottlerocket
  fail the probe; GKE routes to the Sandbox adapter. Then install in-cluster
  components (proxy, RuntimeClasses + the node agent, registry, priority
  classes) and record the backend in config.
  **The §4 half of that already exists** as `yaac cluster install
  --adopt-cni`: it creates no cluster, probes the CNI/kube-proxy/pod-CIDR
  capabilities and refuses what cannot work, labels the install namespace
  for the privileged Pod Security Standard, and then installs exactly that
  in-cluster component set (docs/cluster-setup.md). What `attach` adds is
  the §3 node-OS probe, the storage-class probe, and recording the backend.
- Every `podman exec <node>` fixup either dies with kind (sysfs, TasksMax,
  pids-limit — node-container artifacts) or moves into the installer
  DaemonSet if still wanted on real nodes (vm sysctls).
- `cluster check` probes are already in-cluster pods and mostly carry over;
  the hostPath-write-at-session-uid probe becomes an RWX-PV write probe;
  the "single node assumed" warning inverts into a multi-node readiness
  check (RuntimeClass node coverage, registry reachability per node,
  shared-volume visibility per node) — **that inversion has shipped** on the
  local backend (docs/cluster-setup.md, "Verifying"), and its probes are
  pod-based, so they carry over to any backend.
- **The readiness sweep's eligibility model takes tolerations** — the
  prerequisite for a dedicated sessions pool, and **shipped**
  (docs/cluster-setup.md, "Which nodes count as session-eligible"). "Can a
  session land on this node?" is answered by real per-taint matching against
  what the `gvisor` RuntimeClass declares in `scheduling.tolerations`, which
  the admission controller merges into every pod naming the class — session
  pods, builder pods, synced pods, and the sweep's own pinned probes (which
  bypass the scheduler but are still admitted by kubelet, and would be
  evicted by a `NoExecute` taint). A pool tainted the conventional way is
  therefore usable once its toleration is declared, instead of reading as
  *zero* eligible nodes with a fix suggesting the taint be removed. Both
  the inventory and the sweep now name the nodes they excluded and why, so a
  transient taint (memory/disk/pid pressure, a joining node's
  `uninitialized`) is visible rather than hidden behind "all N
  session-eligible nodes". Nothing declares a toleration on the local
  backend, where the only taint is the control plane's, so the local verdict
  is unchanged and the matching is covered by unit fixtures.

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
     shipped** (§4, docs/worktree-egress.md), forgery e2e included, and so
     is adopting a Calico we did not install (`--adopt-cni`,
     docs/cluster-setup.md). What is left is running that gate against a
     real provider-managed Calico rather than a kind cluster.
   - gVisor installer DaemonSet on a target node pool; sentry probe green;
     survive a node-pool upgrade.
   - RWX (NFS-CSI) under gVisor: the storage plan's probe chain + perf
     numbers.
   - buildkitd-in-cluster + push/pull against DOCR or in-cluster registry.
2. **Host-decoupling that pays off on single-node too** (land on the
   current backend first): buildkit builds behind a builder abstraction,
   ~~registry storage on PVCs~~ (done — §5),
   ~~registry in-cluster~~ (done — §5),
   ~~salvage-via-registry~~ (done — §5),
   ~~ssh-agent off the hostPath socket~~ (done — over the proxy's agent
   port, not the stream relay),
   ~~tmux socket to emptyDir~~ (done), ~~shared/node-local root split in
   `project-paths.ts`~~ (done — §2).
3. **Server-in-cluster mode:** ~~volume-source abstraction in `pod-spec.ts`
   (hostPath | PVC)~~ (done — §2; the `pvc` source renders but nothing
   selects it until the claims exist), server Deployment + PVCs, `yaac
   cluster attach` installer, provider-aware check.
4. **A real managed cluster:** EKS-AL / self-managed, behind the spikes.

**Final gate, re-run after every migration above lands: the e2e suite on a
multi-node cluster.** ~~Multi-node kind with per-node extraMounts (from the
storage plan)~~ — `yaac cluster install --nodes N` builds it, `cluster check`
gates per-node readiness (runsc / registry pull / shared volume), which is
§7's "single node assumed" warning inverted, and the suite has been run
against one. It is listed last rather than as a phase because each item
above changes what a second node can observe — registry storage, session
eligibility, the server's own volumes — so a green multi-node run is the
acceptance criterion for each, not a milestone reached once.

## Open questions

- Multi-tenancy: remote-hosting is one-developer today; a shared cluster
  invites multi-user auth/quotas — explicitly out of scope here.
- NFS server placement and SPOF story (in-cluster vs droplet; backups).
- DOCR vs self-hosted registry (cost, egress, coupling to DO).
- Build vs reuse of the istio-cni/ztunnel plumbing: crib the technique into
  the node agent, or vendor pieces and own the per-platform hardening.
- Node-drain UX for long-running sessions (surfacing, auto-restart
  semantics).

# Stock multi-node Kubernetes (e.g. DigitalOcean DOKS)

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
- **Redirect + policy: one mechanism everywhere — per-pod rules at the veth
  peer (Istio ambient shape).** The node agent programs default-deny, the
  ingress lock, and a transparent TPROXY to the yaac proxy in the **host-side
  veth-peer netns** of each session pod. Because the rules sit upstream of the
  CNI datapath they are CNI-independent and gVisor-safe (host-kernel netfilter,
  not the sentry) — so Cilium is dropped entirely and any minimal CNI works,
  local and managed (§4). Reuse istio-cni/ztunnel *plumbing* only — ztunnel is
  not our egress proxy. **Spike resolved (validated 2026-07-23, see
  `spikes/`):** the redirect must sit at the veth *peer*, not inside the pod
  netns — gVisor's `fdbased` netstack emits egress as raw L2 frames via
  AF_PACKET, so the pod netns's own IP-layer netfilter never sees it.

Scope reality check (the runsc install, §3, is the binding constraint): the
non-negotiable gVisor requirement means the target is **self-managed node
pools (droplets + k3s + own CNI) as the primary, fully-supported case**, with
*some* managed engines as per-provider ports (DOKS / EKS-AL / AKS-Ubuntu,
each vendor-unsupported for the runtime install), a **separate adapter for
GKE** (adopt GKE Sandbox), and Autopilot / Fargate / Bottlerocket **out of
scope**. "Runs on any stock managed cluster" is not achievable; DOKS is the
reference *managed* port, not a universal guarantee.

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
  COS-only). So the reachable set is: self-managed (primary), DOKS, EKS-AL,
  AKS-Ubuntu — the same envelope the §4 networking needs, since both ride
  the same privileged node install.
- Spike: verify on a real target node — OS/containerd config include path,
  survival across a node-pool upgrade, the cluster-check sentry/dmesg probe.

### 4. Networking / egress: default-deny + transparent proxy, in the pod netns

**No Cilium — anywhere (local or managed).** The cluster runs any *minimal*
CNI (kindnet, flannel, plain bridge); its only job is to hand out pod IPs.
All egress/ingress policy and the transparent redirect live in the **per-pod
network namespace**, programmed by the node agent (§3 — the same privileged
DaemonSet that installs runsc) through a **chained CNI plugin** that fires on
pod-add. This is the Istio *ambient* shape.

**Where the rules live (spike result).** A gVisor session pod runs runsc with
the default `--network=sandbox` netstack: the sentry pulls the pod's IP/routes
into its userspace netstack and drives `eth0` at L2 via an AF_PACKET socket
(`fdbased`). In the host kernel the pod netns `eth0` therefore has no IP and no
routes, and egress leaves as raw Ethernet frames — so **iptables/TPROXY inside
the pod netns never sees it**. The rules go one hop out, in the **host-side
veth-peer netns**, matching on the arrival interface. This is validated
end-to-end (real runsc sandbox → veth → peer-netns TPROXY → transparent
forwarder that recovers the original dst); scripts and the exact iptables
recipe are in [`spikes/`](spikes/). `net-raw` (nested pods) does not change
this — it only governs the guest's own raw sockets, not the fdbased transport.

For each session pod, the node agent enters its **veth-peer** netns and
installs:

- **Default-deny egress** — only the redirect target and the DNS stub are
  reachable; everything else is dropped (fail-closed).
- **The ingress lock** — only the yaac proxy may reach the pod (streamd on
  `:10300`); everything else dropped.
- **A TPROXY rule** steering `443` / `80` / the SSH-tunnel sentinel to a
  **per-pod forwarder socket teleported into that netns**. The forwarder
  stamps the session identity — which it knows authoritatively from *which
  netns it serves* — and forwards to the yaac proxy. The proxy is unchanged:
  TLS-MITM with its CA, SNI/Host allowlist, credential injection.

One choice — rules live in the **host-side pod netns** — buys three
properties at once:

1. **CNI-independent.** Interception is upstream of the CNI datapath, so it
   works even on eBPF CNIs (managed Cilium, GKE Dataplane V2) that bypass
   node-root netfilter.
2. **gVisor-safe.** Host-kernel netfilter, not the sentry's netstack (whose
   iptables-NAT gap sinks any in-*sandbox* redirect).
3. **Tamper-proof + spoof-proof.** In-sandbox root has no syscall path to the
   veth-peer netns; and a net-raw sandbox that forges packet source IPs still
   only reaches the forwarder for *its own* veth, so it cannot impersonate
   another session. No separate anti-spoof rule needed — identity is by which
   veth peer the frame arrives on (the forwarder recovers it from the arrival
   netns/interface, not from the packet's src IP).

**Reuse the plumbing, not the proxy.** ztunnel is an L4 mesh mTLS proxy; it
does no egress TLS-MITM, allowlisting, or credential injection, so the yaac
proxy stays ours. Crib istio-cni's netns-entry + in-pod TPROXY and ztunnel's
socket-teleport (both Apache-2.0), pointed at yaac-proxy. The node agent
grows two pieces on top of the runsc install: the chained CNI plugin and a
per-node forwarder.

The stream relay is already multi-node clean (streamd reached by pod IP;
server↔proxy via apiserver exec/port-forward) — no node locality anywhere.

**Portability = the §3 runsc-install envelope** (both need the same
privileged node install): self-managed (primary), DOKS, EKS-AL, AKS-Ubuntu;
out on GKE Dataplane V2 / Autopilot, Bottlerocket, Fargate. Istio ambient's
own tested matrix has the *same* exceptions for the *same* privilege reasons
(DPv2 forbids the istio-cni mount propagation; Autopilot forbids the
privileged install), which is corroborating.

**Spike: done (2026-07-23), see [`spikes/`](spikes/).** Confirmed the veth-peer
TPROXY composes with gVisor's `fdbased` netstack (real sentry → veth →
peer-netns TPROXY → teleported IP_TRANSPARENT socket, original dst recovered)
— Istio's cross-CNI testing does not cover the gVisor runtime, so this one was
ours. It also corrected the attach point from "pod netns" to "veth peer" (see
above). Still outstanding as implementation (not viability): a real gVisor pod
on a **minimal/no-Cilium CNI**, redirected by the node agent, and the
**forgery e2e** (a session pod reaching any un-allowlisted host, or
impersonating another session, must fail — plain *and* nested classes) as the
acceptance gate.

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

- Session pods must gain CPU (and ephemeral-storage) requests alongside the
  existing memory request — multi-node bin-packing needs them; add a
  PriorityClass split (infra > sessions).
- Node-pool autoscaling works out of the box once requests are honest.
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
vcluster synced-pod — stock k8s, not Cilium, unaffected), vcluster sessions,
the remote client/auth-broker model, and the DB layer (pglite on a private
volume). The egress **policy plane** is replaced, not preserved: **Cilium is
removed entirely (local and managed)**; all egress/ingress policy and the
transparent redirect move into the node agent's per-pod-netns rules (§4), so
the CNI only hands out pod IPs and the whole design is CNI-independent.

## Phasing

1. **Spikes (kill-order):**
   - **Node agent (§4) owns all policy + redirect at the veth peer.** Via a
     chained CNI plugin it programs default-deny egress, the ingress lock, and
     a TPROXY steering `443/80/sentinel` to a per-pod forwarder socket that
     forwards to the yaac proxy (unchanged). Key spike (**done** — the
     veth-peer TPROXY composes with gVisor's `fdbased` netstack; see
     `spikes/`). Gate: the forgery e2e (direct un-allowlisted egress +
     cross-session impersonation) passes for plain *and* nested classes.
   - gVisor installer DaemonSet on a target node pool; sentry probe green;
     survive a node-pool upgrade.
   - RWX (NFS-CSI) under gVisor: the storage plan's probe chain + perf
     numbers.
   - buildkitd-in-cluster + push/pull against DOCR or in-cluster registry.
2. **Host-decoupling that pays off on single-node too** (land on the
   current backend first): buildkit builds behind a builder abstraction,
   registry in-cluster, salvage-via-registry, ssh-agent over the stream
   relay, tmux socket to emptyDir, shared/node-local root split in
   `project-paths.ts`, honest CPU requests.
3. **Server-in-cluster mode:** volume-source abstraction in `pod-spec.ts`
   (hostPath | PVC), server Deployment + PVCs, `yaac cluster attach`
   installer, provider-aware check.
4. **Multi-node rehearsal, then a real managed cluster:** multi-node kind
   with per-node extraMounts (from the storage plan) to shake out scheduling
   bugs cheaply, then a real DOKS/self-managed cluster behind the spikes.

## Open questions

- Multi-tenancy: remote-hosting is one-developer today; a shared cluster
  invites multi-user auth/quotas — explicitly out of scope here.
- NFS server placement and SPOF story (in-cluster vs droplet; backups).
- DOCR vs self-hosted registry (cost, egress, coupling to DO).
- Build vs reuse of the istio-cni/ztunnel plumbing: crib the technique into
  the node agent, or vendor pieces and own the per-platform hardening.
- Node-drain UX for long-running sessions (surfacing, auto-restart
  semantics).

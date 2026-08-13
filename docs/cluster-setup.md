# Cluster setup

Current-state reference for `yaac cluster setup` — the runtime yaac needs,
what the command provisions, and why. Companion to `yaac cluster check`,
which verifies all of it (the command finishes by running it).

```sh
yaac cluster setup             # one node
yaac cluster setup --nodes 3   # one control-plane node + two workers
yaac cluster setup --adopt-cni # install into a cluster whose CNI is not ours
```

The command bootstraps the podman machine on macOS (see below) — or expects a
reachable rootful podman on Linux (see below) — creates a kind cluster from the
bundled `k8s/kind-config.yaml`, installs pinned Calico (the CNI and
NetworkPolicy engine) and netd (the worktree-egress redirect), applies the node
fixups to every node, and deploys the in-cluster image registry.

`--adopt-cni` is the one non-destructive mode: it creates nothing and
installs no CNI, adopting the Calico an existing cluster already runs (see
"Adopting a CNI yaac did not install").

## The split runtime

yaac splits the container runtime in two:

- **Podman** builds worktree images (`podman build` / `podman push`) and
  hosts the kind node container.
- **Kubernetes** runs the worktrees — one Job (single-pod) per worktree, plus
  a shared proxy Deployment. yaac targets a **local kind cluster** of one or
  more nodes (see "Multi-node" below). Worktree pods run under gVisor (runsc): the gofer
  performs hostPath I/O as node root while the sentry enforces file
  permissions on the ownership the backing filesystem reports, so that
  filesystem must report **real file ownership**. Any normal Linux
  filesystem does; on macOS this constrains the VM stack (see below).

## macOS: the podman machine

On macOS, podman runs inside a VM, and yaac needs two non-default machine
settings — **rootful** (kind requires it) and the **libkrun provider** with
the tap's patched **`yaac-krunkit`**. Both halves of that requirement are
about virtiofs **ownership semantics**: gVisor's gofer does hostPath I/O as
node root while the sentry enforces file permissions on the ownership
virtiofs reports, so the VM's file sharing must report real ownership.
Apple's Virtualization.framework (applehv/vz) cannot — its virtiofs reports
the accessing process as every file's owner ("dynamic ownership",
[lima#1513](https://github.com/lima-vm/lima/issues/1513)), so the root
gofer sees root-owned files and worktree uids can never write hostPath
mounts; chown is silently swallowed and idmapped mounts fail EINVAL, so
there is no remap escape hatch either. Stock krunkit (<= 1.3.x) fails the
same way for a different reason: it hardcodes libkrun's `Simplified`
virtiofs semantics, which also squash ownership to the accessor.
`yaac-krunkit` is upstream krunkit built against a patched `yaac-libkrun`
that forces `LinuxComplete` semantics, which report real host ownership
(and advertise FUSE `ALLOW_IDMAP` — the `MOUNT_ATTR_IDMAP` EINVAL that
first surfaced this, [#27](https://github.com/bsklaroff/yaac/issues/27),
dates from when worktree pods used user namespaces instead of gVisor).
`yaac cluster setup` applies both settings: it writes a `containers.conf.d`
drop-in selecting libkrun and drives `podman machine init --rootful` +
start. Use podman >= 6.0 — it passes krunkit's `--timesync` flag itself
([podman#28527](https://github.com/containers/podman/pull/28527)) and its
machine image ships the vsock guest agent
([podman-machine-os#238](https://github.com/containers/podman-machine-os/pull/238)),
so the VM clock survives Mac sleep
([podman#11541](https://github.com/containers/podman/issues/11541)) with no
manual wiring.

> **Upgrading from a pre-6.0 install:** a machine provisioned under podman
> 5.x lacks the 6.0 image's guest wiring and must be recreated
> (`podman machine rm` + re-init) — `yaac cluster setup` detects this and
> prompts.

## Linux: rootful podman

On Linux, yaac drives the **rootful** podman engine — the same choice as the
macOS machine, for the same reason. kind's node runs as a container on this
engine, and the calico-node agent needs privileges that only exist in the initial
user namespace. Under rootless podman the node lives in a user namespace,
where the kernel denies the agent's `mount-bpf-fs` init container
(`mount: /sys/fs/bpf: permission denied`), so the agent pod crash-loops in
init and never leaves phase Pending: `yaac cluster setup` hangs at
`1 pods of DaemonSet calico-node are not ready / pod is pending` and times out.
Even on kernels new enough to permit that mount in a user namespace (>= 6.9),
loading the datapath's BPF programs still needs CAP_BPF in the initial user
namespace — rootful is required either way.

yaac points both halves of the split runtime at the rootful engine by setting
`CONTAINER_HOST=unix:///run/podman/podman.sock` at startup
(`ensureRootfulPodmanHost` in `src/lib/container/runtime.ts`): kind inherits it
(so its podman provider uses rootful) and every `podman build`/`push` call
targets the same store the cluster pulls from. A `CONTAINER_HOST` you set
yourself is left untouched.

The rootful socket is root-owned and systemd-activated, so yaac (unprivileged)
can't start it — enable it once and grant your user access:

```sh
sudo apt install podman              # Debian/Ubuntu (or dnf on Fedora/RHEL)
sudo systemctl enable --now podman.socket
sudo setfacl -m u:$USER:x /run/podman
sudo setfacl -m u:$USER:rw /run/podman/podman.sock
```

For access that survives socket recreation, use a `podman.socket` systemd
drop-in (`sudo systemctl edit podman.socket`) setting `SocketMode=0660` and
`SocketGroup=` to a group you belong to. `yaac cluster setup` prints these same
steps if the rootful socket isn't reachable.

> **Nested (in-pod) worktrees are exempt:** inside a yaac worktree
> (`YAAC_NESTED=1`) the in-pod podman is rootless on its own per-uid socket, so
> the rootful default does not apply there.

## Linux: VPN and firewall interference

Two host-level blockers that both present as "container is up but its
published port doesn't answer" (kind's API server on `127.0.0.1:<port>`,
or the loopback end of a `kubectl port-forward`):

- **VPN firewalls (e.g. Mullvad)** reject traffic to the podman bridge
  subnets — including loopback-published ports, whose destination is
  DNAT-rewritten to the container IP before the VPN's filter runs. The
  signature: `curl` fails instantly ("after 0 ms") while `tcpdump -i podman0`
  captures nothing. Enable the VPN's LAN exemption (Mullvad:
  `mullvad lan set allow`). Split tunneling does not help — the blocked
  traffic is kernel-forwarded, not owned by any process.
- **ufw hosts: pin netavark's iptables firewall driver.** The nftables
  driver keeps its rules in a separate table that ufw's default-deny can
  override, and it has been seen not intercepting loopback-published ports
  at all (connections land on podman's port-reservation socket and hang):

  ```sh
  printf '[network]\nfirewall_driver = "iptables"\n' \
    | sudo tee /etc/containers/containers.conf.d/50-firewall-driver.conf
  ```

  Switch drivers only with a reboot (or a full teardown of containers and
  networks) — `podman network reload` across a driver change leaves
  half-migrated rules behind.

## Version skew: podman 6.x needs a patched kind

**Don't bump podman alone.** Podman 6.0 changed the container label format
from a map to a slice, which breaks how kind <= v0.32.0 enumerates its node
containers (`kind get clusters` fails with `exit status 125` —
[kind#4201](https://github.com/kubernetes-sigs/kind/issues/4201)). The fix
([kind#4203](https://github.com/kubernetes-sigs/kind/pull/4203)) is merged
to `main` but unreleased (latest stable is v0.32.0; even v0.33.0-alpha
predates it). The brew formula handles this by depending on `yaac-kind`, a
build pinned past the fix. Installing by hand: stay on podman 5.x, or build
kind from `main` (`go install sigs.k8s.io/kind@main` — note `@latest`
resolves to the v0.32.0 tag, which lacks the fix). `yaac cluster setup`
preflights the pair and reports the skew explicitly. yaac's own podman
calls are unaffected (they read `.ID`/`.Repository`/`.Tag`, not `.Labels`);
only kind's provider breaks.

## What it wires up

1. **The image registry**, as an in-cluster `registry:2` Deployment behind
   a ClusterIP Service — the same shape the per-project registries use.
   Pods and builder pods pull by its Service FQDN
   (`yaac-registry.yaac.svc.cluster.local:5000`); the node, which is not a
   cluster-DNS client, matches that host against a containerd `hosts.toml`
   holding the live ClusterIP, written by a one-shot pod per node. The
   server pushes and queries through a `kubectl port-forward`, so nothing in
   the image path depends on host↔cluster networking. Blobs live on an RWO
   PVC (`yaac-registry-storage-<install-hash>`, install-keyed so coexisting
   installs never share a store), which binds through the cluster's *default*
   StorageClass — a cluster with none leaves the registry pod Pending. They
   die with the cluster and cost only re-pushes.

   An install upgrading from the older node-hostPath store converts on its
   next server start and comes up on a **fresh, empty claim**: nothing
   migrates blobs, so the first worktree create afterwards pays one round of
   re-pushes and rebuilds. That is the same self-healing a cluster recreate
   has always relied on. The old hostPath data stays on the nodes under
   `/var/lib/yaac/main-registry/<install-hash>`, recoverable by hand.
2. **Home-directory extraMount** — worktree pods mount worktrees, caches, and
   credentials via `hostPath`, which resolves on the *node*. Mounting
   `$HOME` into the node at the same path makes node == host for everything
   yaac touches. Every node gets it, so the bind holds wherever a worktree
   is scheduled.
3. **Node limits** — `DefaultTasksMax=infinity` + VM memory sysctls inside
   each node and a raised pids-limit on the node container, so subagent
   fan-out and virtiofs I/O don't die with
   `fork: resource temporarily unavailable`. Also `--housekeeping-interval=60s`
   in the kubelet flags (kubeadm-flags.env): at the 10s default, cAdvisor's
   per-container process stats readlink every open fd of every process each
   tick, and gVisor worktree sandboxes concentrate ~9k fds per sentry — kubelet
   alone burned 1.5–2 cores on a busy node before this.
4. **The gVisor runtime**, via the `yaac-gvisor-install` DaemonSet — a
   privileged pod on every node that drops a pinned `runsc` +
   `containerd-shim-runsc-v1` there, registers two runsc handlers in that
   node's containerd config (`runsc` and `runsc-nested`, each with its own
   `/etc/containerd/runsc*.toml` flag file — both set `allow-suid` so the
   image's passwordless `sudo` works inside the sentry, `runsc-nested`
   additionally allows raw/packet sockets for the in-pod engine), restarts
   containerd, and labels the node `yaac.gvisor=true`. Setup waits for that
   rollout and then applies the `gvisor` and `gvisor-nested` RuntimeClasses,
   whose `scheduling.nodeSelector` is that label — so a sandboxed pod can
   only be scheduled where the shim actually exists.

   A DaemonSet rather than a loop over `podman exec <node>` for two reasons:
   it works on nodes yaac has no shell on (a managed pool, a remote control
   plane), and a node that is restarted or *replaced* installs itself with
   nothing to run — which is what makes the install survive node recycling.
   It is idempotent: the binaries are fetched only when the node-local cache
   does not already hold a copy matching the release's published sha512
   (re-verified on every hit, not just after a download), the config files
   are compared before writing, and containerd is restarted only when
   something changed. Passes take a node-local lock, so a second install
   sharing the node (an e2e run's) converges after the first rather than
   interleaving with it — they must pin the same gVisor version.
   The installer image is upstream `curlimages/curl`,
   digest-pinned and mirrored into the local registry like Envoy and
   registry:2. See `docs/plans/stock-k8s-multi-node.md` §3 for why the
   privilege is accepted and where a dedicated worktrees node pool fits.

   Every pod hosting untrusted code carries a RuntimeClass explicitly:
   plain worktrees run on `gvisor`, nested-containers worktrees run the
   rootful in-pod engine on `gvisor-nested`, and vcluster-synced tenant
   pods are stamped `gvisor` by the syncer. Trusted yaac infra (the proxy,
   registries, node-write pods, vcluster control planes) runs on runc — a
   sentry per infra pod starves the node for no containment gain.
5. **PriorityClasses** — `yaac-infra` (1000000) > `yaac-builder` (100000) >
   `yaac-worktree` (1000). The proxy and per-project registries take the
   infra tier, ephemeral image builders the builder tier, worktree pods the
   worktree tier. The split is about who dies when a node fills up — losing
   the egress proxy costs *every* worktree its DNS and its route to the
   world, while losing one worktree costs one worktree, and kubelet's
   node-pressure eviction orders by priority.

   Only infra may **preempt**; builders and worktrees set `preemptionPolicy:
   Never`. A preempted pod is deleted and a worktree Job (`backoffLimit: 0`)
   never comes back, so nothing below the infra tier is allowed to buy its
   own scheduling with a worktree's life — a build that waits costs a worktree
   create some latency instead.

   Two deliberate omissions. netd stays on `system-node-critical` — it is
   node infrastructure, like kube-proxy. Per-worktree **vcluster control
   planes** stamp nothing and so sit at 0, *below* worktrees: they are
   Deployment-managed and come back, and a worktree does not. Worktrees
   created by a *nested* yaac against their vcluster also stamp nothing —
   the syncer drops the class name host-side but copies `preemptionPolicy`,
   and the host rejects that pod outright.

   `yaac cluster check` verifies the classes, and the yaac server re-applies
   them at every start, so an existing cluster picks them up on upgrade.
6. **Calico** — upstream's classic KDD/iptables release manifest for the
   pinned version, fetched once and verified against the checksum committed
   in `k8s/calico/`, then cached at
   `$YAAC_DATA_DIR/cache/calico-<version>.yaml` so a cluster recreate does
   not refetch. A checksum mismatch fails the setup. Calico's images are
   pulled to the *host* engine and side-loaded onto the node, which keeps
   the ~235 MB one-time rather than per-recreate. `k8s/calico/README.md`
   has the repin recipe.

## Multi-node

```sh
yaac cluster setup --nodes 3
```

`--nodes N` creates one control-plane node and `N-1` workers (max 5 — every
node is a full node container on this one host, so this is a topology knob,
not a capacity one). It is create-time only: `--repair` fixes up the nodes
that exist and rejects `--nodes`.

**Worktrees land on the workers.** kind keeps the control-plane's
`node-role.kubernetes.io/control-plane:NoSchedule` taint as soon as a cluster
has workers (it only clears it on worker-less ones), and worktree pods declare
no tolerations. So `--nodes 2` leaves exactly one worktree-eligible node and
`--nodes 3` leaves two — **3 is the smallest topology that actually
exercises multi-node scheduling.** `yaac cluster check` reports both numbers
(`3 nodes, 2 able to schedule worktrees`).

The rendering is the whole mechanism. `k8s/kind-config.yaml` holds one
control-plane node entry carrying the `$HOME → $HOME` extraMount, and setup
copies that entry into `N-1` `role: worker` entries — so **every** node
binds the host's home directory at the same path. Since all kind nodes are
containers on this one host, hostPath keeps resolving to the same bytes no
matter which node a worktree lands on, and the shared-filesystem model
survives unchanged while real multi-node *scheduling* is exercised. The rest
of the config is cluster-scoped and kind applies it to every node itself:
the containerd `config_path` registry patch, the kubelet swap patch, and
`disableDefaultCNI`.

Everything else already reached every node and stays that way, by one of
two mechanisms. Host-side loops over the node list: the node fixups and the
containerd registry `hosts.toml` (both `podman exec`), and the per-project
registries' `hosts.toml` writer pods. DaemonSets, which need no list and
also cover nodes added later: the gVisor installer, Calico, and netd.

Both registries' blob stores are RWO PVCs, so the store belongs to the
claim rather than to whatever node the pod last landed on. Under kind's
default `standard` class (rancher local-path, `WaitForFirstConsumer`) the
underlying directory is still node-local — but it is now *sticky*: the
bound volume carries node affinity, the scheduler honours it, and a
reschedule therefore comes back to the same store rather than to an empty
one while stranding the store it left. On a cluster whose default class is
network-attached, the store follows the pod outright. Either way the
Deployments stay unpinned: placement is the scheduler's job, constrained by
the volume, and a `nodeSelector` would only trade a self-healing degradation
for a single point of failure.

`yaac cluster check` reports per-node readiness on a multi-node cluster
(`runsc-nodes`, `registry-nodes`, `volume-nodes` — see "Verifying").

## Adopting a CNI yaac did not install

```sh
yaac cluster setup --adopt-cni
```

Installs into the cluster the current kubeconfig points at, adopting the
**Calico it already runs** — ours, a self-managed one, or a provider-managed
one (GKE Dataplane V1, AKS `--network-policy calico`, Calico policy-only over
the AWS VPC CNI on EKS). It creates no cluster, needs no `kind`, and skips
the Calico install; everything else it applies is what the other modes apply
(PriorityClasses, registry, builder guard, gVisor runtime, netd), so it is
idempotent and re-runnable. It refuses `--nodes` (no nodes to render) and
`--repair` (that mode fixes up a cluster yaac built).

There is no datapath change here — the netd redirect (docs/worktree-egress.md)
works unmodified on any CNI whose pod egress traverses host netfilter and
that leaves ClusterIP translation to kube-proxy. What changes is that four
things the owned-cluster path guarantees by construction become things this
mode **verifies**, and every one of them fails *silently* when the
assumption is wrong. So each is a refusal, not a warning:

| Verified | Why a refusal |
|---|---|
| calico-node present and fully rolled out | policy is the enforcement plane; a node without Felix is a node with no worktree egress lockdown. Absent Calico is also how a Cilium cluster reads, and no Cilium configuration survives the veth-peer redirect |
| **not** the eBPF dataplane — `spec.bpfEnabled` on **any** FelixConfiguration, or `FELIX_BPFENABLED` on the container | eBPF host-routing short-circuits host netfilter exactly as Cilium does: the redirect chain exists, counts zero packets, and every worktree silently loses the internet |
| kube-proxy running, and not replaced (`bpfKubeProxyIptablesCleanupEnabled`) | netd's Envoy dials the yaac proxy by ClusterIP from the host netns, and appending below `KUBE-SERVICES` is what keeps ClusterIP traffic out of the redirect |
| a pod-CIDR set that is non-empty and wholly parseable | those CIDRs lead netd's chain as RETURNs; with none it would DNAT pod-to-pod 443/80 into the proxy, and a silently-dropped `YAAC_POD_CIDRS` entry narrows the set below what was configured. The per-apply path falls back to kind's default — adoption refuses instead |
| `system-node-critical` exists | netd names it, and the apiserver rejects a pod naming a missing class: the DaemonSet then creates no pod and no node has a redirect |
| workload host routes match the veth prefix, **on every node** | netd's only pod → veth source, read through each netd pod once it is up. A prefix matching nothing renders a chain with no per-pod rules — indistinguishable from a healthy netd |
| every check was actually **evaluated** | a read that failed for any reason other than genuine absence is an unknown, not a fact. Absence is meaningful here (no FelixConfiguration means Felix's iptables defaults), so an RBAC-denied or timed-out read that collapsed into "absent" would wave an eBPF cluster through |

Two things are **recorded, not enforced**. `chainInsertMode`: netd appends
its own `nat PREROUTING` jump and never competes with Felix for position, so
`Append` is safe and only warns. And per-node kube-proxy coverage: one
running kube-proxy proves the cluster has one, but a node without it loses
egress by itself while the rest work — which reads as intermittent, so the
nodes are named.

The pod → veth and kube-proxy checks are **per node**, not per cluster. On a
heterogeneous fleet — mixed node pools or AMIs, the realistic EKS shape —
one node's routing table says nothing about the others', and a node whose
veths are named differently is a node whose worktrees get no redirect.

**NetworkPolicy enforcement is probed, never inferred.** "Calico is
installed" is not evidence that plain `networking.k8s.io/v1` policy is
enforced — policy-only Calico over a foreign IPAM is a supported topology and
a misconfigured one looks identical until a worktree escapes. The `egress`
gate of the cluster check that finishes every setup is that probe (see
"Verifying"), and its failure makes the command exit non-zero.

**A failed check leaves the install in place.** Every mode installs before
it verifies, so the failure's only artifact is the non-zero exit code —
nothing uninstalls, and nothing re-checks between explicit `yaac cluster
check` runs. That matters most for the `egress` gate: a cluster that fails
it runs worktrees whose egress lockdown is *advisory*, since the policy is
applied but not enforced, and the proxy allowlist then covers only the
ports the redirect steers (443/80/the ssh sentinel). Setup says so
explicitly when that gate fails. **Do not start worktrees until a re-run
passes.**

**The veth check is re-run by every `yaac cluster check`**, not only at
adoption. It has its own gate (`veth-source`) rather than living inside
`datapath`, because `datapath` structurally cannot see it: netd's readiness
is Envoy's config ack, which goes green with zero pod → veth mappings. A
node pool added after adoption is the case that matters.

The namespaces yaac creates — the install namespace, the registry namespace,
and each per-worktree vcluster namespace — are labelled for the `privileged`
Pod Security Standard. Inert on kind, load-bearing on an adopted cluster
whose default is `baseline` or `restricted`: netd is `hostNetwork` with
`NET_ADMIN`/`NET_RAW`, the node-write pods hostPath-mount `certs.d`, and
synced tenant pods are shaped by the vcluster's own guard. PSS is
namespace-scoped, so this relaxes nothing outside them.

Three knobs exist for what a foreign cluster does not publish:

- `YAAC_CNI_VETH_PREFIX` — the interface-name prefix the CNI gives workload
  veths (default `cali`; policy-only Calico over the AWS VPC CNI gives
  `eni`). Never relaxed to "any device": that prefix is what stops a
  malformed routing table from making netd redirect something that is not a
  workload, so an empty or nonsense value falls back to `cali` rather than
  becoming a wildcard. When the configured prefix resolves nothing, the
  refusal names the prefix the node's routes actually use.
- `YAAC_POD_CIDRS` — extra pod CIDRs, comma-separated. Unioned with the
  discovered sources rather than replacing them, because too *narrow* is the
  dangerous direction: a pod IP outside the list is treated as world. An
  entry that is not a usable dotted-quad v4 CIDR is refused rather than
  dropped — a vanished typo would leave the set narrower than what was
  written, with nothing to say so.
- `YAAC_KUBE_PROXY_EXTERNAL=1` — acknowledges that kube-proxy runs where no
  pod can be found. **k3s** is the case: it runs kube-proxy in-process inside
  the kubelet, so there is no pod, DaemonSet or label to detect, and
  self-managed k3s is a primary target rather than an exotic one. Getting it
  wrong costs egress rather than opening it — netd's Envoy simply fails to
  dial the proxy's ClusterIP, and the worktree NetworkPolicy still denies
  every world-ward destination but the node's listener range. Recorded in the
  audit trail, since it is the one check an operator can wave through.

All are read at apply time, so a CIDR added to a live cluster needs a
re-run to take effect.

Calico's kube-proxy pods are found under either `k8s-app=kube-proxy`
(kubeadm, EKS, kind) or `component=kube-proxy` (GKE, AKS).

Out of scope, deliberately: Cilium in any configuration, and installing
policy for anyone else's workloads — every yaac policy selects only its own
pods and its own vcluster namespaces.

## Node fixups vanish on restart

The node limits live in node/VM state and **vanish on a node or VM restart**
(e.g. after restarting the podman machine). Re-apply them without recreating
the cluster:

```sh
yaac cluster setup --repair
```

`yaac cluster check` detects when they're missing and points here.

`--repair` owns exactly the state that has no node-side agent to re-apply
it: the sysctls, `DefaultTasksMax`, the node container's pids ceiling and
the registry wiring. The gVisor runtime is **not** in that set — its
installer DaemonSet reinstalls on any node that appears — but `--repair`
does re-apply the DaemonSet itself, which is how an existing cluster picks
up a runsc version bump on a yaac upgrade.

## What a worktree reserves

Each worktree container requests **250m cpu, 1Gi memory, 2Gi
ephemeral-storage**, and is limited to **8 cores, 8Gi memory and 16Gi
ephemeral-storage** (plus the podman graphroot's own volume cap on a
nested-containers worktree, which kubelet charges to the same limit). Requests
are the scheduler's reservation and sit well under the limits: the node is
deliberately overcommitted, the way many mostly-idle worktrees want.

Memory and disk are capped because they are not compressible: one worktree
must not be able to take the node down with it. The cpu ceiling is there for
a second reason specific to gVisor. runsc sizes the sandbox's virtual cpu
count from the container's cpu quota (`-cpu-num-from-quota`, on by default),
and the systrap platform spawns one stub process per virtual cpu — so with no
limit there is no quota, every sandbox falls back to the *host's* core count,
and one worktree running syscall-heavy work (an e2e suite: image builds,
container starts, every syscall trapping through the sentry) drives that many
stubs at once and starves the node.

The ceiling is set far above the request — 8 cores against 250m — so it
bounds that burst without becoming a CFS quota that throttles an interactive
agent on an idle node. Ordinary worktree work never approaches it.

The practical effect is a ceiling on concurrent worktrees, whichever of cpu or
memory runs out first — roughly `cores × 4` and `GB ÷ 1` respectively (each
worktree's vcluster control plane, on a `virtualCluster` project, reserves on
top of that). At 4 GB per core the two ceilings coincide; above that, cpu
binds first, and a worktree that no longer fits sits `Pending` with an
`Insufficient cpu` event rather than failing outright.

## Runtimes and uids

Worktree containment is the **gVisor sentry**: every pod running untrusted
code (worktrees, vcluster-synced tenant pods, the check's probe pods) runs
under the `gvisor` RuntimeClass, where in-container root — the image grants
passwordless sudo so agents can `apt-get install` mid-worktree — is a sandbox
fiction with no host authority, and no user namespace is used.
Nested-containers worktrees run their in-pod container engine as **real root
inside the sentry** on the `gvisor-nested` RuntimeClass (the sentry is the
containment). Trusted yaac infra (proxy, registries, node-write pods,
vcluster control planes) runs unsandboxed on runc: it only executes
yaac-shipped code, and the sentries' CPU cost is what matters at fleet
scale.

Under gVisor there is no user namespace and no idmap, so hostPath files are
presented at their real node-side uids (the gofer preserves them), and the
worktree image builds its `yaac` user with the server's uid
(`YAAC_UID` build arg, baked in automatically and folded into the image
tag). Nothing to configure — but if your uid ever changes, images rebuild
on their own, and a standalone `Dockerfile.yaac` that creates its own user
should honor `ARG YAAC_UID` the same way `dockerfiles/Dockerfile.default`
does, or its writes to `/workspace` will fail with `Permission denied`.

## Verifying

`yaac cluster check` verifies kubectl, the cluster, the registry, the
namespace, the PriorityClasses and the node fixups, asserts the
RuntimeClasses exist, that at least one node carries the `yaac.gvisor`
label they schedule on, and that a
`gvisor`-class pod really runs inside the sentry, then runs an end-to-end
probe pod — on the gvisor tier, like worktree pods — that exercises all of
the wiring above, including a hostPath **write** at the worktree uid. It
ends with a sweep warning about any untrusted pod (worktree-labeled or
vcluster-synced) running without a gvisor-tier `runtimeClassName` (pods
predating the gVisor migration). Run it whenever worktrees fail to start.

Two gates cover the redirect, and they fail differently on purpose.
`datapath` says calico-node and netd are Ready — policy is enforced and a
redirect exists. `veth-source` says the redirect can actually *key* on
anything: it execs each netd pod for its own node's routing table and
checks that workload host routes match the configured veth prefix. Ready
netd does not imply that — netd's readiness is Envoy's config ack, which
goes green with zero pod → veth mappings — so without this gate a wrong
prefix presents only as worktrees with no egress.

### Which nodes count as worktree-eligible

The node inventory line, the per-node sweep below, and `--adopt-cni`'s
per-node kube-proxy coverage all narrow to the nodes a worktree could
actually land on: Ready, uncordoned, and carrying no taint the worktree pod
fails to tolerate. That last clause is real per-taint matching, not "carries
no taint at all" — a worktree pod's tolerations are whatever the `gvisor`
RuntimeClass declares in `scheduling.tolerations`, which the RuntimeClass
admission controller merges into every pod naming the class. One definition,
shared: a second one would drift, and on a tainted pool the blanket rule
reads as *zero* eligible nodes, so a coverage check built on it would
silently verify nothing.

That is also how a **dedicated worktrees node pool** works: taint the pool so
other workloads stay off it, declare the matching toleration once on the
RuntimeClass, and worktree pods, builder pods, vcluster-synced pods and this
check's own pinned probes all inherit it — the probes included because they
bypass the scheduler but are still admitted by kubelet, and a `NoExecute`
pool taint would evict one that tolerated nothing. Scope the toleration to
the pool's own key; a bare `{operator: Exists}` tolerates every taint on
every node, which reads as a fully eligible cluster no matter what its nodes
are carrying.

Because the toleration rides the RuntimeClass rather than the workload, the
pool is really an **untrusted-sandboxed-workload** pool: builder pods name
the same class, so untrusted image builds land there too and compete with
worktrees for its capacity. Separating them would take a second RuntimeClass,
which does not exist today. Trusted infra (the proxy, the registries) names
no RuntimeClass, inherits no toleration, and so stays off the pool by
construction. The one-shot **node-write pods** are the deliberate exception:
they are pinned by `nodeName` to every node and blanket-tolerate, because a
pool node that never receives its containerd `hosts.toml` cannot pull the
images its worktrees need. Being `nodeName`-pinned, the toleration buys them
no scheduling freedom.

Nothing declares a toleration on a local cluster, where the only tainted
node is the control plane a worktree genuinely cannot use. When no node
qualifies, the check names each node and the taint that excluded it, and the
fix points at declaring the pool's toleration on the RuntimeClass — not at
removing the taint, which would dismantle the isolation the pool exists for.

Nothing persists that toleration yet, so whether it survives `yaac cluster
setup --repair` depends on how it got there — the repair re-applies the
RuntimeClasses from the builder's defaults, which carry none. A toleration
that went in through the code path is recorded in the object's
`last-applied-configuration` and is pruned by that re-apply, putting the
pool's nodes straight back to reading excluded; one added with `kubectl
edit`/`patch` survives, because client-side apply only prunes fields it
previously owned. Neither is a home for it: check after a repair until the
pool's own config knob exists.

On a cluster with more than one node it also runs a **per-node readiness
sweep** over those worktree-eligible nodes, pinning one probe pod to each and
reporting three warn-level gates —

- `runsc-nodes`: that node can host a sandboxed pod. A node the installer
  DaemonSet has not labelled yet fails here by definition — the
  RuntimeClasses schedule on that label, so nothing sandboxed can be placed
  there. Beyond that, a node whose kubelet publishes
  `status.runtimeHandlers` is judged by it, and otherwise by whether its
  probe pod ran at all (containerd refuses a pod whose handler it never
  registered). The `gvisor` gate above proves the handler is really the
  sentry and that *some* node has it; this one says how many.
- `registry-nodes`: that node's containerd can pull from the registry (the
  probe pulls `Always`, so a layer already on the node cannot mask an
  unreachable one).
- `volume-nodes`: the shared data dir is the same bytes the server sees
  from that node, and the worktree uid can write it.

They are warnings, not failures: a single-node cluster is still a legitimate
topology, and each carries the fix for its own cause — the installer
DaemonSet for runsc, `--repair` for the registry wiring, the home
extraMount for the volume. A probe pod that never ran is attributed to one
gate from the kubelet's event and left explicitly *unverified* on the
others, so no gate ever passes on a node it could not actually check.

Every gate also names what it did **not** sweep, and why (`not swept:
yaac-worker3 (untolerated taint node.kubernetes.io/disk-pressure:NoSchedule)`).
Narrowing is right; narrowing silently is not — an "all N worktree-eligible
nodes" pass otherwise reads identically whether the node that dropped out
was a control plane or a worker that just went under disk pressure.

> **Limits:** all nodes must share one filesystem — the hostPath model
> assumes node == host, which multi-node kind preserves by binding `$HOME`
> into every node container. The server's control traffic reaches the proxy
> through a loopback exec tunnel (`kubectl exec` + socat —
> runtime-agnostic, unlike `kubectl port-forward`, which cannot reach
> gVisor pods); nothing yaac deploys listens on host interfaces.

## Deleting the cluster

```sh
yaac cluster delete        # prompts first; -y / --yes skips the prompt
```

The teardown counterpart to `setup`, and one `kind delete` is the whole of
it: everything yaac deploys lives inside the cluster — Calico, netd, every
vcluster, the main and per-project registries — and so does their
node-local storage on every node, including every pushed image. Running worktree pods
stop, but nothing under the yaac data dir is touched: on-disk worktrees and
worktrees survive, and a later `yaac cluster setup` recreates the cluster and
re-pushes images on demand. It leaves the podman machine and its shared image
store alone (that's the build engine, not the cluster), and refuses to run
inside a nested yaac worktree — there the cluster belongs to the outer
install.

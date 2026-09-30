# Cluster setup

Current-state reference for `yaac cluster install` — the runtime yaac needs,
what the command provisions, and why. Companion to `yaac cluster check`,
which verifies all of it (the command finishes by running it).

```sh
yaac cluster install             # one node
yaac cluster install --nodes 3   # one control-plane node + two workers
yaac cluster install --byo --rwx-storage-class <nfs-class>  # a cluster yaac did not create
```

One idempotent verb, safe to run at any time. It bootstraps the podman
machine on macOS (see below) — or expects a reachable rootful podman on
Linux (see below) — creates a kind cluster from the bundled
`k8s/kind-config.yaml` **if there is none**, installs pinned Calico (the CNI
and NetworkPolicy engine), applies the kind node fixups to every node,
deploys the in-cluster image registry, builds and pushes every image yaac ships (see
"Images are built here, and only here"), applies the in-cluster layers —
the gVisor runtime, the PriorityClasses, netd — and finally deploys **the
yaac server itself** (docs/server-in-cluster.md), publishing it at a fixed
host loopback origin and writing the `server.json` every client on this
machine resolves through.

Under this driver the server is a workload of the cluster, not a process
beside it, so this command is also how the server is installed and upgraded:
`npm update`, then `yaac cluster install`. `yaac server start` on such an
install scales the Deployment rather than spawning anything, and refuses
outright when there is no Deployment to scale — a host process on a k8s
data dir would be a second writer of the same database, and there is no
host-process form of this driver to fall back to. `yaac server start` means
containerless; this command means k8s.

Nothing in it is destructive: a cluster that already exists is converged,
never recreated, so it is also what an upgrade runs (`npm update`, then
`yaac cluster install`). Teardown happens only through an explicit `yaac
cluster delete`, which is the one command that can lose running workspaces.
`--nodes` therefore applies only to a cluster this run creates; against an
existing one it is a no-op with a note.

`--byo` installs into a cluster yaac did not create — a cloud node pool —
with its storage provisioned from named classes and its server on the
tailnet (see "Bring your own cluster").

`--tailnet` publishes a kind install's server on the machine's Tailscale
tailnet through the Tailscale Kubernetes operator instead of at
`127.0.0.1` — the fronting a byo install always gets. The operator is a
prerequisite (`helm upgrade --install tailscale-operator …`, printed by the
refusal when it is missing), and the server then identifies every caller by
tailnet user (docs/server-in-cluster.md "Reachability",
docs/remote-hosting.md). Alongside `--byo` it is accepted and changes
nothing.

## Images are built here, and only here

Every image yaac itself ships — the base/tools/nestable workspace chain, the
egress proxy, netd, and the server — is built by `podman build` on the
machine running the yaac CLI and pushed to the in-cluster registry, together
with the mirrors of the digest-pinned upstreams it uses (registry:2, Envoy,
podman-stable, the gVisor installer's curl). Content-hash tags make an
unchanged source tree cost one registry HEAD per image, so re-running install
is cheap. The server image's content hash is taken over the BUNDLE (`dist/`),
which is what makes a rebuilt server a different image and therefore a
rollout.

The server builds none of them. It resolves each one from the registry by
content-hash tag, and a tag that is not there is an actionable error naming
this command rather than a build trigger — which is what lets the server run
with no container engine at all (docs/trust-split-builds.md). What it still
builds is what a project or a user wrote, and only inside sandboxed builder
pods.

## The split runtime

yaac splits the container runtime in two:

- **Podman** builds workspace images (`podman build` / `podman push`) and
  hosts the kind node container.
- **Kubernetes** runs the workspaces — one Job (single-pod) per workspace, plus
  a shared proxy Deployment. yaac targets a **local kind cluster** of one or
  more nodes (see "Multi-node" below). Workspace pods run under gVisor (runsc): the gofer
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
gofer sees root-owned files and workspace uids can never write hostPath
mounts; chown is silently swallowed and idmapped mounts fail EINVAL, so
there is no remap escape hatch either. Stock krunkit (<= 1.3.x) fails the
same way for a different reason: it hardcodes libkrun's `Simplified`
virtiofs semantics, which also squash ownership to the accessor.
`yaac-krunkit` is upstream krunkit built against a patched `yaac-libkrun`
that forces `LinuxComplete` semantics, which report real host ownership
(and advertise FUSE `ALLOW_IDMAP` — the `MOUNT_ATTR_IDMAP` EINVAL that
first surfaced this, [#27](https://github.com/bsklaroff/yaac/issues/27),
dates from when workspace pods used user namespaces instead of gVisor).
`yaac cluster install` applies both settings: it writes a `containers.conf.d`
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
> (`podman machine rm` + re-init) — `yaac cluster install` detects this and
> prompts.

## Linux: rootful podman

On Linux, yaac drives the **rootful** podman engine — the same choice as the
macOS machine, for the same reason. kind's node runs as a container on this
engine, and the calico-node agent needs privileges that only exist in the initial
user namespace. Under rootless podman the node lives in a user namespace,
where the kernel denies the agent's `mount-bpf-fs` init container
(`mount: /sys/fs/bpf: permission denied`), so the agent pod crash-loops in
init and never leaves phase Pending: `yaac cluster install` hangs at
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
`SocketGroup=` to a group you belong to. `yaac cluster install` prints these same
steps if the rootful socket isn't reachable.

## Linux: VPN and firewall interference

Host-level blockers that present as "the container is up but does not
answer": the first and last as a published port that does not (kind's API
server on `127.0.0.1:<port>`, or the loopback end of a `kubectl
port-forward`), the second as a pod that runs and never turns Ready:

- **VPN firewalls (e.g. Mullvad)** reject traffic to the podman bridge
  subnets — including loopback-published ports, whose destination is
  DNAT-rewritten to the container IP before the VPN's filter runs. The
  signature: `curl` fails instantly ("after 0 ms") while `tcpdump -i podman0`
  captures nothing. Enable the VPN's LAN exemption (Mullvad:
  `mullvad lan set allow`). Split tunneling does not help — the blocked
  traffic is kernel-forwarded, not owned by any process.
- **A host `arp_ignore=2` leaves pods unreachable from their node.** A new
  pod netns copies IPv4 `conf/all` from the host's root netns (the kernel
  default `net.core.devconf_inherit_init_net=0`), not from the kind node
  that creates it. Calico gives each pod a `/32`, so under `arp_ignore=2`
  the pod answers no ARP from the node: containers run and every kubelet
  probe times out. VPN clients set it (Mullvad is a suspected source).
  Install detects this when the registry stalls and says to run
  `sudo sysctl -w net.core.devconf_inherit_init_net=3` (new namespaces
  copy from their creator, the node), persist it in `/etc/sysctl.d`, and
  recreate the cluster.
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

## kind and Kubernetes versions

yaac needs kind v0.33.0 or newer, and `yaac cluster install` refuses an
older one. There are two reasons:

- **The node image is pinned.** `k8s/kind-config.yaml` pins the node image
  (Kubernetes 1.37.0) by digest, so a kind upgrade never silently moves new
  clusters to another Kubernetes minor. kind only guarantees an image works
  with the release that published it, so the pin and the kind floor move
  together. Bump both deliberately. Existing clusters keep the version they
  were created with.
- **podman 6.x breaks older kind.** Podman 6.0 changed the container label
  format from a map to a slice, which breaks how kind <= v0.32.0 enumerates
  its node containers: `kind get clusters` fails with `exit status 125`
  ([kind#4201](https://github.com/kubernetes-sigs/kind/issues/4201)).
  yaac's own podman calls are unaffected, since they read
  `.ID`/`.Repository`/`.Tag`, not `.Labels`. Only kind's provider breaks.

## What it wires up

1. **The image registry**, as an in-cluster `registry:2` Deployment behind
   a ClusterIP Service — the same shape the per-project registries use.
   Pods and builder pods pull by its Service FQDN
   (`yaac-registry.yaac.svc.cluster.local:5000`); the node, which is not a
   cluster-DNS client, matches that host against a containerd `hosts.toml`
   holding the live ClusterIP, written by a one-shot pod per node. The
   server, being a pod itself, pushes and queries through that same Service
   FQDN; the CLI, which is not, keeps a `kubectl port-forward` for the
   pushes `yaac cluster install` does — so nothing in the image path depends
   on host↔cluster networking either way. Blobs live on an RWO
   PVC (`yaac-registry-storage-<install-hash>`, install-keyed so coexisting
   installs never share a store), which binds through the cluster's *default*
   StorageClass — a cluster with none leaves the registry pod Pending. They
   die with the cluster and cost only re-pushes. Reads are anonymous; a
   write needs a grant signed by the cluster's registry key, which an Envoy
   gate in the registry's own pod checks (docs/trust-split-builds.md "The
   write gate"). Install creates the key, as the Secret
   `yaac-registry-grant-key` in its own `yaac-registry-keys` namespace, on
   its first run against a cluster.

   An install upgrading from the older node-hostPath store converts on its
   next server start and comes up on a **fresh, empty claim**: nothing
   migrates blobs, so the first workspace create afterwards pays one round of
   re-pushes and rebuilds. That is the same self-healing a cluster recreate
   has always relied on. The old hostPath data stays on the nodes under
   `/var/lib/yaac/main-registry/<install-hash>`, recoverable by hand.
2. **Two extraMounts per node.** The home directory, at the same path:
   the two storage claims (`yaac-global`, `yaac-server-local`) bind static
   hostPath volumes into the data dir's `global/` and `server-local/`
   folders, and a hostPath resolves on the *node*, so the bind is what
   makes the volume the host's bytes (docs/server-in-cluster.md "Storage
   is two claims"). And `<dataDir>/node-local` at the install's node path,
   `/var/lib/yaac/node/<hash>`: the NODE-LOCAL tier — package caches, image
   stores, opencode working copies — lives there, so on kind it is host
   disk and survives a cluster delete rather than dying with the node
   container. Both ride every node, so they hold wherever a workspace is
   scheduled. The second is per install (the hash).
3. **The kind node fixups** — the two settings a node *container* has and
   a real node does not, applied through podman: a raised pids-limit on the
   node container (podman's default 2048 is what subagent fan-out would
   otherwise hit as `fork: resource temporarily unavailable`), and
   `--housekeeping-interval=300s` in the kubelet flags (kubeadm-flags.env):
   at the 10s default, cAdvisor's per-container process stats readlink
   every open fd of every process each tick, and gVisor workspace sandboxes
   concentrate ~9k fds per sentry — kubelet alone burned 1.5–2 cores on a
   busy node before this. On a cluster yaac did not create the kubelet
   config is the pool's, so the flag is a pool setting there.
4. **The gVisor runtime and the node tuning**, via the `yaac-gvisor-install`
   DaemonSet — a privileged pod on every node that drops a pinned `runsc` +
   `containerd-shim-runsc-v1` there, registers two runsc handlers in that
   node's containerd config (`runsc` and `runsc-nested`, each with its own
   `/etc/containerd/runsc*.toml` flag file — both set `allow-suid` so the
   image's passwordless `sudo` works inside the sentry, `runsc-nested`
   additionally allows raw/packet sockets for the in-pod engine), restarts
   containerd, and labels the node `yaac.gvisor=true`. Setup waits for that
   rollout and then applies the `gvisor` and `gvisor-nested` RuntimeClasses,
   whose `scheduling.nodeSelector` is that label — so a sandboxed pod can
   only be scheduled where the shim actually exists.

   Every pass first **tunes the node**: `vm.min_free_kbytes` and the two
   `fs.inotify` ceilings (raised to yaac's floor, never lowered — an
   operator who set more keeps it), `vm.compaction_proactiveness` (a 5.9+
   knob; a sysctl the kernel does not have is logged and skipped), and a
   `DefaultTasksMax=infinity` drop-in in `/etc/systemd/system.conf.d`
   followed by a `systemctl daemon-reexec` whenever the node's systemd
   reports a live `DefaultTasksMax` other than `infinity` — the file is
   for the next boot, the live value is what this boot is judged by.
   Subagent fan-out, virtiofs allocations under memory pressure and netd's
   Envoy (which asserts on an inotify fd at startup) all die without them,
   on any node. Because the pass re-runs on every node the DaemonSet lands
   on, on every pod restart and every ten minutes, a node that restarts —
   a podman machine restart, a host reboot, a recycled cloud node — gets
   its sysctls back with no `yaac cluster install` re-run. A node the pass
   cannot tune fails the pass, and so never gets the runtime label: a node
   whose workspaces would die late is a node yaac does not schedule onto.

   A DaemonSet rather than a loop over `podman exec <node>` for two reasons:
   it works on nodes yaac has no shell on (a managed pool, a remote control
   plane), and a node that is restarted or *replaced* installs and tunes
   itself with nothing to run — which is what makes the install survive
   node recycling. It is idempotent: the binaries are fetched only when the node-local cache
   does not already hold a copy matching the release's published sha512
   (re-verified on every hit, not just after a download), the config files
   are compared before writing, and containerd is restarted only when
   something changed. Passes take a node-local lock, so a second install
   sharing the node (an e2e run's) converges after the first rather than
   interleaving with it — they must pin the same gVisor version.
   The installer image is upstream `curlimages/curl`,
   digest-pinned and mirrored into the local registry like Envoy and
   registry:2. See docs/plans/cloud-k8s.md for why the privilege is
   accepted and where a dedicated workspaces node pool fits.

   Every pod hosting untrusted code carries a RuntimeClass explicitly:
   plain workspaces run on `gvisor`, and nested-containers workspaces run the
   rootful in-pod engine on `gvisor-nested`. Trusted yaac infra (the proxy,
   registries, node-write pods) runs on runc — a sentry per infra pod
   starves the node for no containment gain.
5. **PriorityClasses** — `yaac-infra` (1000000) > `yaac-builder` (100000) >
   `yaac-workspace` (1000). The proxy and per-project registries take the
   infra tier, ephemeral image builders the builder tier, workspace pods the
   workspace tier. The split is about who dies when a node fills up — losing
   the egress proxy costs *every* workspace its DNS and its route to the
   world, while losing one workspace costs one workspace, and kubelet's
   node-pressure eviction orders by priority.

   Only infra may **preempt**; builders and workspaces set `preemptionPolicy:
   Never`. A preempted pod is deleted and a workspace Job (`backoffLimit: 0`)
   never comes back, so nothing below the infra tier is allowed to buy its
   own scheduling with a workspace's life — a build that waits costs a workspace
   create some latency instead.

   One deliberate omission: netd stays on `system-node-critical` — it is
   node infrastructure, like kube-proxy.

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
7. **The npm cache** — one Verdaccio (`yaac-npm-cache`) in the install
   namespace, which every workspace's `pnpm install` goes through
   (docs/workspace-storage.md "Package installs"). A Recreate Deployment of
   one replica over an RWO claim, like the main registry; digest-pinned and
   mirrored like Envoy. A new workspace is pointed at it only while a cache
   pod is ready, so a cluster installed before the cache existed, or one
   whose cache is down, leaves new workspaces' pnpm on npmjs. Install
   carries on without it rather than failing — installs are slower without
   it, nothing worse.

## Multi-node

```sh
yaac cluster install --nodes 3
```

`--nodes N` creates one control-plane node and `N-1` workers (max 5 — every
node is a full node container on this one host, so this is a topology knob,
not a capacity one). It is create-time only: an existing cluster's node
count is fixed and install never recreates one, so against one the flag is
a no-op with a note.

**Workspaces land on the workers.** kind keeps the control-plane's
`node-role.kubernetes.io/control-plane:NoSchedule` taint as soon as a cluster
has workers (it only clears it on worker-less ones), and workspace pods declare
no tolerations. So `--nodes 2` leaves exactly one workspace-eligible node and
`--nodes 3` leaves two — **3 is the smallest topology that actually
exercises multi-node scheduling.** `yaac cluster check` reports both numbers
(`3 nodes, 2 able to schedule workspaces`).

The rendering is the whole mechanism. `k8s/kind-config.yaml` holds one
control-plane node entry carrying the `$HOME → $HOME` extraMount, install
adds the node-local one beside it, and setup copies that entry into `N-1`
`role: worker` entries — so **every** node binds both. Since all kind nodes
are containers on this one host, the claims' volumes keep resolving to the
same bytes no matter which node a workspace lands on, and the NODE-LOCAL
tier — per node in name — is one host folder in fact; the storage model
survives unchanged while real multi-node *scheduling* is exercised. The rest
of the config is cluster-scoped and kind applies it to every node itself:
the containerd `config_path` registry patch, the kubelet swap patch, and
`disableDefaultCNI`.

Everything else already reached every node and stays that way, by one of
two mechanisms. Host-side loops over the node list: the kind node fixups
(`podman exec` and `podman update`), and both registries' `hosts.toml`
writer pods. DaemonSets, which need no list and also cover nodes added
later: the gVisor installer (the runtime and the node tuning), Calico, and
netd.

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

## Bring your own cluster

```sh
yaac cluster install --byo --rwx-storage-class <nfs-class> [--rwo-storage-class <block-class>]
```

Installs into the cluster the current kubeconfig points at — a self-managed
pool, or a managed one on a mutable node OS — using the same in-cluster
layers and the same server Deployment as a kind install. It creates no
cluster and needs no `kind`; it installs no CNI, adopting the Calico the
cluster already runs; and it is idempotent and re-runnable like every other
mode. What differs is only what install renders:

- **Storage** is provisioned from classes rather than static volumes:
  `yaac-global` from `--rwx-storage-class`, which must be NFS-family
  (csi-driver-nfs, EFS, Azure Files over NFS), and `yaac-server-local` from
  `--rwo-storage-class` or the cluster's default class. Install re-adopts a
  volume of its own that a namespace delete left `Released` — matched by
  the random install id `server.json` records, never by the data-dir path
  — claims each volume root for that id through a one-shot binder pod, and
  pins both `Retain` (docs/server-in-cluster.md "Storage is two claims").
  A class with a fixed `subDir` or base path hands every claim the same
  directory, so it can host one install: a second is refused rather than
  handed the first one's data.
- **The uid** is a fixed 1000, not this machine's (docs/server-in-cluster.md
  "The uid everything runs as").
- **The fronting** is the Tailscale operator's TLS Ingress — `--byo` implies
  `--tailnet`, since a cloud cluster has no loopback to publish at.

**The gates**, in order, before anything is applied or built — ahead of the
podman bootstrap, so a refusal leaves the cluster and this host untouched:

| Gate | Refuses |
|---|---|
| Architecture | a node pool that mixes architectures, or one that is not this machine's — install builds every image here, for this machine's architecture, with no cross-build and no emulation |
| Node OS and containerd | a runtime that is not containerd; an immutable OS (Bottlerocket, Container-Optimized OS, Talos, Flatcar); EKS Fargate and GKE Autopilot; k3s and RKE2, whose embedded containerd keeps its config in a template the gVisor installer does not write yet |
| CNI | everything in "The CNI gate" below |
| Operator | a cluster without the Tailscale operator or its `tailscale` IngressClass — with "could not ask" kept apart from absent |
| Storage | an RWX class that does not exist or is not NFS-family, an RWO class that does not exist, and a cluster with no default class (the registry and the npm cache provision through it) |
| Identity | a live `yaac-server` Deployment of another install (its `yaac.install-id` label is not this data dir's install id — installing over it would take over its storage), and a data dir recorded as the containerless driver |
| Cluster | a current context whose cluster is not the one recorded (below) |
| Environment | `YAAC_USE_TOR`, which names a listener on this machine no pod there can reach |

`cluster check` repeats the architecture and node-OS gates on every run
(`architecture`, `node-os`, fail-level on every backend), so a pool that
later gains a foreign node is reported rather than failing to pull
without explanation.

**What `--byo` never does**: exec into a node — the kind node fixups (the
pids ceiling, the kubelet housekeeping flag) are settings of a node
container, the check's `node-fixups` gate skips on a byo install, and on a
real pool the housekeeping interval is a pool setting; nor create host
directories for the tiers, whose bytes are the classes'. The node tuning
(sysctls, `DefaultTasksMax`) rides the gVisor installer DaemonSet onto
every node regardless.

**The installer is the node-OS gate's flavor table**, with one row: stock
containerd, restarted through the node's systemd, reading registry hosts
from `/etc/containerd/certs.d` — the directory both registries' hosts
writers mount. kind's config patch sets that `config_path`; a stock node
may not, so the installer ensures it on every pass: a config that already
names `certs.d` is left alone, one with no registry table gets the block
(marker-guarded, under the key its config version speaks), and one that
names another directory — or still uses the deprecated `mirrors`, which
containerd refuses beside `config_path` — fails the node's readiness with
the reason.

**The cluster is recorded.** Every cluster call uses the kubeconfig's
current context, and anyone with a cloud install very likely has other
contexts too. Install records the cluster it installed into in
`server.json` (on every backend) as the uid of its `kube-system` namespace
— a context's name is a local label that another kubeconfig can reuse for
another cluster — with the context's name kept only for the hint. Each
host-side verb that touches the cluster — `cluster install|check`,
`server start|stop|restart|logs` — refuses when the current context's
cluster is another one, or cannot be identified (reading `kube-system` is
Forbidden under the namespace-scoped RBAC a shared work cluster hands out),
before asking it anything, naming `kubectl config
use-context <recorded>` where that would help. A refusal rather than
pinning: nothing has to thread `--context` through the substrate. A kind
install is checked the other way round, since its cluster may be deleted
and re-created: the current context must be `kind-<cluster>` and point at
the apiserver kind reports for it, and install then records that cluster.

**A data dir is byo or not for its whole life.** Plain `yaac cluster
install` on a byo data dir is refused before it runs anything — the kind
path would create a kind cluster here and switch the current context to it
— and `--byo` on a kind data dir likewise.

**A dead NFS server hangs, rather than fails.** The shared claim is mounted
`hard` unless its class says `soft` (Linux's default, and yaac leaves the
choice to the class): while the server is gone, every I/O on the global
tier blocks — the server pod's, every workspace's — and so does the
kubelet's unmount, so those pods sit `Terminating` and the node usually
needs a reboot (or cordon it and replace it) once the server is back or
gone for good. `soft` turns the hang into an EIO after its retries, which
a git checkout or a half-written file then has to survive; that is the
trade the class owner makes. yaac does set `actimeo=1` on the volume,
whatever the class says: a GETATTR per file per second of use — on EFS,
billed latency — is what bounds how long a workspace can act on a file the
server has already changed.

**`yaac cluster delete` refuses on a byo install** — the cluster is not
yaac's to delete — and prints the uninstall instead: the install's
namespaces (the registry's signing key has one of its own) and the
cluster-scoped objects labelled with them; then, marked as shared by every
install on the cluster, the runtime objects and the `yaac.gvisor` node
labels. The two `Retain` volumes survive that on purpose; it says how to
remove them deliberately, selected by the install id.

### The CNI gate

The Calico a byo cluster runs may be self-managed or provider-managed (GKE
Dataplane V1, AKS `--network-policy calico`, Calico policy-only over the AWS
VPC CNI on EKS). There is no datapath change for it — the netd redirect
(docs/workspace-egress.md) works unmodified on any CNI whose pod egress
traverses host netfilter and that leaves ClusterIP translation to
kube-proxy. What changes is that what the owned-cluster path guarantees by
construction becomes something this mode **verifies**, and every one of
them fails *silently* when the assumption is wrong. So each is a refusal,
not a warning:

| Verified | Why a refusal |
|---|---|
| calico-node present and fully rolled out | policy is the enforcement plane; a node without Felix is a node with no workspace egress lockdown. Absent Calico is also how a Cilium cluster reads, and no Cilium configuration survives the veth-peer redirect |
| **not** the eBPF dataplane — `spec.bpfEnabled` on **any** FelixConfiguration, or `FELIX_BPFENABLED` on the container | eBPF host-routing short-circuits host netfilter exactly as Cilium does: the redirect chain exists, counts zero packets, and every workspace silently loses the internet |
| kube-proxy running, and not replaced (`bpfKubeProxyIptablesCleanupEnabled`) | netd's Envoy dials the yaac proxy by ClusterIP from the host netns, and appending below `KUBE-SERVICES` is what keeps ClusterIP traffic out of the redirect |
| a pod-CIDR set that is non-empty and wholly parseable | those CIDRs lead netd's chain as RETURNs; with none it would DNAT pod-to-pod 443/80 into the proxy, and a silently-dropped `YAAC_POD_CIDRS` entry narrows the set below what was configured. The per-apply path falls back to kind's default — `--byo` refuses instead |
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
veths are named differently is a node whose workspaces get no redirect.

**NetworkPolicy enforcement is probed, never inferred.** "Calico is
installed" is not evidence that plain `networking.k8s.io/v1` policy is
enforced — policy-only Calico over a foreign IPAM is a supported topology and
a misconfigured one looks identical until a workspace escapes. The `egress`
gate of the cluster check that finishes every setup is that probe (see
"Verifying"), and its failure makes the command exit non-zero.

**A failed check leaves the install in place.** Every mode installs before
it verifies, so the failure's only artifact is the non-zero exit code —
nothing uninstalls, and nothing re-checks between explicit `yaac cluster
check` runs. That matters most for the `egress` gate: a cluster that fails
it runs workspaces whose egress lockdown is *advisory*, since the policy is
applied but not enforced, and the proxy allowlist then covers only the
ports the redirect steers (443/80/the ssh sentinel). Setup says so
explicitly when that gate fails. **Do not start workspaces until a re-run
passes.**

**The veth check is re-run by every `yaac cluster check`**, not only at
install. It has its own gate (`veth-source`) rather than living inside
`datapath`, because `datapath` structurally cannot see it: netd's readiness
is Envoy's config ack, which goes green with zero pod → veth mappings. A
node pool added after install is the case that matters.

The namespaces yaac creates — the install namespace and the registry
namespace — are labelled for the `privileged` Pod Security Standard. Inert
on kind, load-bearing on a byo cluster whose default is `baseline` or
`restricted`: netd is `hostNetwork` with `NET_ADMIN`/`NET_RAW`, and the
node-write pods hostPath-mount `certs.d`. PSS is namespace-scoped, so this
relaxes nothing outside them.

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
  dial the proxy's ClusterIP, and the workspace NetworkPolicy still denies
  every world-ward destination but the node's listener range. Recorded in the
  audit trail, since it is the one check an operator can wave through.

All are read at apply time, so a CIDR added to a live cluster needs a
re-run to take effect.

Calico's kube-proxy pods are found under either `k8s-app=kube-proxy`
(kubeadm, EKS, kind) or `component=kube-proxy` (GKE, AKS).

Out of scope, deliberately: Cilium in any configuration, and installing
policy for anyone else's workloads — every yaac policy selects only its own
pods.

## Running byo locally: kind-byo

```sh
pnpm kind-byo up     # stand up the stand-in cloud, then `yaac cluster install --byo` into it
eval "$(pnpm -s kind-byo env)"   # drive it: its data dir, kubeconfig, kind cluster name, CA bundle
pnpm kind-byo down   # delete the cluster; the data dir keeps the install's bytes
```

A repo tool, not a CLI mode: a second kind cluster set up to look like a
cloud one, plus a real `yaac cluster install --byo` into it, run by the
built CLI exactly as an operator runs the published one. Nothing in the CLI
knows it exists, which is what makes it a test of the cloud path rather
than a third backend. It is how the byo install runs end to end on one
Linux machine, by hand or by the `e2e-byo` tier
(docs/server-in-cluster.md "The e2e tiers run against this").

| Piece | What | Why this one |
|---|---|---|
| Cluster | kind `yaac-byo`: a control-plane and two workers, `disableDefaultCNI`, none of yaac's kind-config patches, its own kubeconfig in the install's client-local dir | two workspace-eligible nodes, so every NFS number is cross-node; no containerd patch, so the installer's own `config_path` handling is what runs |
| Node mounts | one extraMount on every node: kind-byo's data dir, at its own path | the backing store for both classes; nothing else of the host is visible to the nodes |
| CNI | the pinned Calico manifest, applied by the script | the CNI gate's happy path, on a CNI yaac did not install |
| RWX | nfs-ganesha on the control-plane node behind csi-driver-nfs, class `kind-byo-nfs` | the self-managed target's shape: an NFS server you run, provisioned by `nfs.csi.k8s.io` |
| RWO | local-path-provisioner, `WaitForFirstConsumer`: the default class `kind-byo-local`, and `kind-byo-rwo`, which install is told to use for `yaac-server-local` | a block class like a provider's zonal disk — node-pinned, and the reason install's binder exists; named rather than defaulted, so a named class that went ignored would show |
| Fronting | the Tailscale operator, its OAuth client from `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET`, every proxy defaulting to a ProxyClass that takes certificates from Let's Encrypt **staging** | `--byo` implies the tailnet; without the client, `up` says so and the install stops at its operator gate. Staging because production issues five certificates a week per name, and every rebuild of the Ingress is a new device asking again |
| Node fixups | the script sets its node containers' pids ceiling itself | `--byo` never execs a node; the script made these containers, so their podman settings are its |

**Its volumes land in its own data dir** (`KIND_BYO_DATA_DIR`, default
`~/.yaac-byo`): ganesha exports the data dir, and every class provisions a
directory per claim under it, `volumes/<namespace>/<claim>` — the NFS
class through csi-driver-nfs's per-claim `subDir` template, the local-path
classes through their pattern. So `yaac-global` lands at
`<dataDir>/volumes/yaac/yaac-global` and `yaac-server-local` beside it,
where their bytes can be read, backed up and removed, while the data dir's
own `global/` and `server-local/` stay the installing CLI's, as a laptop's
tiers are on a real cloud install — it writes its host log there, which a
volume aliasing that folder would hand the binder as someone else's data.
The classes are written as
naively as an operator would (`reclaimPolicy: Delete`, no `actimeo`, no
`mountPermissions`), so every one of install's storage steps is
load-bearing here and `cluster check` fails if one regresses. It is a
separate install with a data dir of its own, shares no directory with any
other, and has no `node-local/` there: its node-local tier is the node
containers' own disk, so deleting the cluster costs what a drained cloud
node costs — cold caches.

**A second cluster, not a second namespace.** Its NFS mounts are `hard`, so
a wedged ganesha blocks every mount operation on its nodes, the kubelet's
teardown included — which in a shared cluster would stall the kind install
used every day. (It is also why `down` drains the workers before deleting
the cluster: a node whose last unmount outlives ganesha waits on it
forever, and its container never finishes stopping.) And the ordinary cluster carries everything a kind install
set up (the containerd patch, the node fixups, the port mapping, the home
mount), so a byo install landing there could not show it works without
them. The recorded cluster keeps the two installs' commands off each
other's.

**Why ganesha rather than kernel nfsd.** A userspace server in an ordinary
pod needs no server-side kernel module and leaves no host state behind; it
restarts like any Deployment, which is how a real NFS server's restart is
rehearsed. The NFS *client* still comes from the host kernel, loaded by the
csi node plugin's mount, as on every backend. Its export is NFSv4 only,
over the data dir, with `No_Root_Squash` (uids pass through raw, and the
binder's chown is root's), `Graceless` (a restart does not stall clients
through a grace period), a pinned `Filesystem_Id`, and the server's own
metadata caching off — the data dir is also written from the host, behind
ganesha's back, and client-side staleness is what `actimeo=1` bounds and
what this cluster measures. Only nodes may mount: the export admits the
node addresses (InternalIPs and Calico tunnel addresses), and a
NetworkPolicy admits nothing else to 2049. The image
(`yaac-kind-byo-ganesha:<contextHash>`, from `test/kind-byo/ganesha/`) is
sideloaded, because it has to serve before install creates the registry.
csi-driver-nfs, local-path-provisioner and the operator are pinned the way
Calico is: a version constant and a committed sha256 per manifest
(`test/kind-byo/pins.sha256`), cached client-local.

**Its origin's certificate is a staging one** — the one way kind-byo
differs from a cloud install. Production Let's Encrypt issues at most five
certificates a week for one name, and each `down`/`up` or namespace delete
is a new operator proxy device asking for the same name again; staging
allows 30,000. The operator is told so through `PROXY_DEFAULT_CLASS`, not
through yaac, and the clients trust Let's Encrypt's staging roots: `up`
fetches them (pinned) into a bundle in the install's client-local dir, and
`env` exports it as `NODE_EXTRA_CA_CERTS`. A browser will not trust that
origin.

**Linux only, on a real filesystem.** ganesha's VFS backend needs file
handles that outlive the kernel's inode cache — ext4, xfs and btrfs give
them; tmpfs, overlay and a macOS virtiofs share do not — so `up` refuses a
data dir on anything else. A macOS host runs the kind tiers.

**The install uid is 1000, the host's may not be.** Files under a kind-byo
data dir are owned by uid 1000, as they would be on a cloud NFS server. On a
host whose user is 1000 that is invisible; on one whose user is not, they
are readable but not writable from the host — the honest consequence of
running the cloud's uid decision locally, and why the `e2e-byo` tier
refuses such a host.

## What survives a restart, and what heals itself

The sysctls are kernel state and **vanish on a node or VM restart** (a
podman machine restart, a host reboot). Nothing needs re-running for them:
the installer DaemonSet's pod restarts with the node and its first pass
puts them back, and `yaac cluster check`'s `node-tuning` gate reads them
back through that pod (every node the DaemonSet is meant to cover is
accounted for: a pod that is not Running, an exec that fails, or a node
with no pod at all is reported unverified, never passed). A node that reads untuned right after a restart is
one whose installer pod has not passed yet; one that stays untuned is
diagnosed from the installer's log
(`kubectl -n yaac logs -l app=yaac-gvisor-install`).

The kind node fixups are podman state and kubeadm's flags file, both kept
across a node container restart and lost only with the container — a
cluster recreate. `yaac cluster install` re-applies them on every run
regardless (cheap, idempotent, and how a cluster made by an older yaac
picks them up), and `yaac cluster check`'s `node-fixups` gate detects
their absence and points here:

```sh
yaac cluster install
```

The gVisor runtime needs neither: its installer DaemonSet reinstalls on
any node that appears. The DaemonSet itself is re-applied by install too,
which is how an existing cluster picks up a runsc version bump on a yaac
upgrade.

A host reboot leaves the kind node containers themselves stopped — kind
creates them with no restart policy — which `yaac cluster check` reports
as an unreachable API server. `yaac cluster install` is the recovery: it
starts every stopped node before the fixups, waits for the API server to
answer, and then converges as usual. Until calico-node is back the pods'
recorded status is the one from before the reboot, so the registry step
waits on an actual dial rather than on its rollout reading done.

## What a workspace reserves

Each workspace container requests **250m cpu, 1Gi memory, 2Gi
ephemeral-storage**, and is limited to **8 cores, 8Gi memory and 16Gi
ephemeral-storage** (plus the podman graphroot's own volume cap on a
nested-containers workspace, which kubelet charges to the same limit). A
workspace with module dirs (the default, `node_modules`) adds 2Gi to the
ephemeral-storage request — the install it really holds — and one module
dir's 9Gi volume cap to the limit. Requests
are the scheduler's reservation and sit well under the limits: the node is
deliberately overcommitted, the way many mostly-idle workspaces want.

Memory and disk are capped because they are not compressible: one workspace
must not be able to take the node down with it. The cpu ceiling is there for
a second reason specific to gVisor. runsc sizes the sandbox's virtual cpu
count from the container's cpu quota (`-cpu-num-from-quota`, on by default),
and the systrap platform spawns one stub process per virtual cpu — so with no
limit there is no quota, every sandbox falls back to the *host's* core count,
and one workspace running syscall-heavy work (an e2e suite: image builds,
container starts, every syscall trapping through the sentry) drives that many
stubs at once and starves the node.

The ceiling is set far above the request — 8 cores against 250m — so it
bounds that burst without becoming a CFS quota that throttles an interactive
agent on an idle node. Ordinary workspace work never approaches it.

The practical effect is a ceiling on concurrent workspaces, whichever of cpu or
memory runs out first — roughly `cores × 4` and `GB ÷ 1` respectively. At
4 GB per core the two ceilings coincide; above that, cpu binds first, and a
workspace that no longer fits sits `Pending` with an `Insufficient cpu`
event rather than failing outright.

## Runtimes and uids

Workspace containment is the **gVisor sentry**: every pod running untrusted
code (workspaces, the check's probe pods) runs under the `gvisor`
RuntimeClass, where in-container root — the image grants
passwordless sudo so agents can `apt-get install` mid-workspace — is a sandbox
fiction with no host authority, and no user namespace is used.
Nested-containers workspaces run their in-pod container engine as **real root
inside the sentry** on the `gvisor-nested` RuntimeClass (the sentry is the
containment). Trusted yaac infra (proxy, registries, node-write pods) runs
unsandboxed on runc: it only executes yaac-shipped code, and the sentries'
CPU cost is what matters at fleet scale.

Under gVisor there is no user namespace and no idmap, so files on the claims
are presented at their real uids (the gofer preserves them), and every
writer of a shared path has to name the same number: **the install uid**,
which install decides and stamps on the server Deployment. On kind it is the
uid of the machine that ran the install — on macOS it cannot be anything
else, since virtiofs makes the host user's uid a ceiling. On a byo install
it is a fixed 1000: an NFS server passes uids through raw, and a constant
keeps ownership stable whichever machine re-installs. Every yaac pod — the
server, the workspaces, the proxy, the probes — runs at it
(docs/server-in-cluster.md "The uid everything runs as").

The images know nothing about that number: they bake a fixed `yaac` user
and run correctly at any uid, so one image set serves every host
(docs/arbitrary-uid-images.md). Nothing to configure — but a standalone
`Dockerfile.yaac` that creates its own user has to follow the same pattern,
or its writes will fail with `Permission denied` on any host whose uid is
not 1000. The README's "Custom images" section spells that out.

## Verifying

`yaac cluster check` verifies kubectl, the cluster, the registry, the
namespace, the two storage claims (`storage`: both Bound, both volumes
`Retain`; on kind — a static volume, the empty class — each volume the
data dir's own tier folder, on a byo install — a provisioned one, whatever
its source: local-path hands out hostPath volumes too — each volume
labelled with this install's id and the global one
NFS-family and mounted with `actimeo` at most 1 — a missing claim fails
and points at install), the PriorityClasses and the
kind node fixups, asserts the RuntimeClasses exist, that at least one node
carries the `yaac.gvisor` label they schedule on, and that a `gvisor`-class
pod really runs inside the sentry, reads the node tuning back through the
installer's pod on every node (`node-tuning`, warn-level: a node whose
installer pod is not Running is reported unverified, never passed), then
runs an end-to-end probe pod — on the gvisor tier, like workspace pods —
that mounts the `yaac-global` claim and exercises all of the wiring above,
including a **write** at the workspace uid. Its other end is a *peer* pod —
runc, at the install uid, the claim mounted whole, which is the server's
footing — that writes the nonce the probe must read, checks the probe's
write reached it, and times a second nonce round-tripped while both run.
The two prefer different nodes, so on a multi-node cluster the round trip
the pass detail reports is cross-node: the coherence number an NFS class is
judged by. Nothing in the check touches this machine's copy of the data
dir, so it runs the same against a cluster whose claims are not on this
machine at all. `storage-semantics` runs the POSIX probe in
`k8s/probes/fsprobe.py` (ownership, O_EXCL, atomic rename, hardlinks,
locks, fsync, mmap, append, xattrs) against the claim from a sandboxed pod
and fails naming any that fail — fail-level on every backend, since a
workspace runs the same code on each. `npm-cache` has a
workspace-labelled pod fetch a package through the npm cache's Service: a
warn when the install has no cache or no ready cache pod (new workspaces
then install from npmjs), a fail when a ready one does not serve, since
every new workspace installs through it. It ends with a sweep
warning about any untrusted (workspace-labeled) pod running without a
gvisor-tier `runtimeClassName`. Run it whenever workspaces fail to start.

Two gates cover the redirect, and they fail differently on purpose.
`datapath` says calico-node and netd are Ready — policy is enforced and a
redirect exists. `veth-source` says the redirect can actually *key* on
anything: it execs each netd pod for its own node's routing table and
checks that workload host routes match the configured veth prefix. Ready
netd does not imply that — netd's readiness is Envoy's config ack, which
goes green with zero pod → veth mappings — so without this gate a wrong
prefix presents only as workspaces with no egress.

### Which nodes count as workspace-eligible

The node inventory line, the per-node sweep below, and `--byo`'s
per-node kube-proxy coverage all narrow to the nodes a workspace could
actually land on: Ready, uncordoned, and carrying no taint the workspace pod
fails to tolerate. That last clause is real per-taint matching, not "carries
no taint at all" — a workspace pod's tolerations are whatever the `gvisor`
RuntimeClass declares in `scheduling.tolerations`, which the RuntimeClass
admission controller merges into every pod naming the class. One definition,
shared: a second one would drift, and on a tainted pool the blanket rule
reads as *zero* eligible nodes, so a coverage check built on it would
silently verify nothing.

That is also how a **dedicated workspaces node pool** works: taint the pool so
other workloads stay off it, declare the matching toleration once on the
RuntimeClass, and workspace pods, builder pods and this check's own pinned
probes all inherit it — the probes included because they
bypass the scheduler but are still admitted by kubelet, and a `NoExecute`
pool taint would evict one that tolerated nothing. Scope the toleration to
the pool's own key; a bare `{operator: Exists}` tolerates every taint on
every node, which reads as a fully eligible cluster no matter what its nodes
are carrying.

Because the toleration rides the RuntimeClass rather than the workload, the
pool is really an **untrusted-sandboxed-workload** pool: builder pods name
the same class, so untrusted image builds land there too and compete with
workspaces for its capacity. Separating them would take a second RuntimeClass,
which does not exist today. Trusted infra (the proxy, the registries) names
no RuntimeClass, inherits no toleration, and so stays off the pool by
construction. The one-shot **node-write pods** are the deliberate exception:
they are pinned by `nodeName` to every node and blanket-tolerate, because a
pool node that never receives its containerd `hosts.toml` cannot pull the
images its workspaces need. Being `nodeName`-pinned, the toleration buys them
no scheduling freedom.

Nothing declares a toleration on a local cluster, where the only tainted
node is the control plane a workspace genuinely cannot use. When no node
qualifies, the check names each node and the taint that excluded it, and the
fix points at declaring the pool's toleration on the RuntimeClass — not at
removing the taint, which would dismantle the isolation the pool exists for.

Nothing persists that toleration yet, so whether it survives `yaac cluster
install` depends on how it got there — install re-applies the
RuntimeClasses from the builder's defaults, which carry none. A toleration
that went in through the code path is recorded in the object's
`last-applied-configuration` and is pruned by that re-apply, putting the
pool's nodes straight back to reading excluded; one added with `kubectl
edit`/`patch` survives, because client-side apply only prunes fields it
previously owned. Neither is a home for it: check after an install until the
pool's own config knob exists.

On a cluster with more than one node it also runs a **per-node readiness
sweep** over those workspace-eligible nodes, pinning one probe pod to each and
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
- `volume-nodes`: the `yaac-global` claim is the same bytes the server
  sees from that node, and the workspace uid can write it.

They are warnings, not failures: a single-node cluster is still a legitimate
topology, and each carries the fix for its own cause — the installer
DaemonSet for runsc, `yaac cluster install` for the registry wiring, the
claim's volume (the home extraMount, on kind) for the volume. A probe pod
that never ran is attributed to one
gate from the kubelet's event and left explicitly *unverified* on the
others, so no gate ever passes on a node it could not actually check.

Every gate also names what it did **not** sweep, and why (`not swept:
yaac-worker3 (untolerated taint node.kubernetes.io/disk-pressure:NoSchedule)`).
Narrowing is right; narrowing silently is not — an "all N workspace-eligible
nodes" pass otherwise reads identically whether the node that dropped out
was a control plane or a worker that just went under disk pressure.

> **Limits:** the `yaac-global` claim has to be the same bytes on every
> node — which multi-node kind gets by binding `$HOME` into every node
> container, so the static volume resolves everywhere, and a cloud cluster
> gets from an RWX storage class. Nothing yaac deploys listens on a host
> interface: the server's control traffic reaches the proxy as an ordinary
> pod-to-pod Service dial (docs/server-in-cluster.md).

## Deleting the cluster

```sh
yaac cluster delete        # prompts first; -y / --yes skips the prompt
```

The teardown counterpart to `install`, and one `kind delete` is the whole
of it: everything yaac deploys lives inside the cluster — Calico, netd, the
main and per-project registries, the two storage claims and their
volumes — and so does the registries' storage on every node, including
every pushed image. Running workspace pods stop, but nothing under the yaac
data dir is touched: the volumes are `Retain` and their bytes are the data
dir's own folders, so on-disk workspaces, the database and the node-local
caches all survive, and a later `yaac cluster install` recreates the
cluster, re-binds the same folders and re-pushes images on demand. It
leaves the podman machine and its shared image store alone (that's the
build engine, not the cluster).

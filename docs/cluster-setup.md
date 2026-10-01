# Cluster setup

Reference for `yaac cluster install`: the runtime yaac needs under the `k8s`
driver, what the command sets up, and why. `yaac cluster check` verifies all
of it, and install ends by running the check.

```sh
yaac cluster install             # one node
yaac cluster install --nodes 3   # one control-plane node + two workers
yaac cluster install --byo --rwx-storage-class <nfs-class>  # a cluster yaac did not create
```

Install is idempotent and safe to re-run at any time. In order, it:

1. On macOS, sets up the podman machine. On Linux, it expects a reachable
   rootful podman (see below).
2. Creates a kind cluster from the bundled `k8s/kind-config.yaml` if there
   is none, installs pinned Calico (the CNI and NetworkPolicy engine), and
   applies the kind node fixups to every node. An existing cluster is
   converged instead: stopped nodes are started and the fixups re-applied.
3. Applies the PriorityClasses and the in-cluster image registry.
4. Builds and pushes every image yaac ships (see "Images are built here").
5. Applies the gVisor runtime installer, netd and the npm cache.
6. Deploys the yaac server itself (docs/server-in-cluster.md), publishes it
   at a fixed host loopback origin, and writes the `server.json` that every
   client on this machine resolves the server through.

Under `k8s` the server is a workload in the cluster, so this command is also
how the server is installed and upgraded: `npm update`, then `yaac cluster
install`. On such an install, `yaac server start` scales the server
Deployment. It refuses when there is no Deployment, because a host process
on a k8s data dir would be a second writer of the same database. Put simply,
`yaac server start` stands up a containerless server and `yaac cluster
install` stands up a k8s one.

Nothing in install is destructive. An existing cluster is converged, never
recreated. Only `yaac cluster delete` tears a cluster down, and it is the one
command that can lose running workspaces. For the same reason `--nodes` only
applies to a cluster this run creates; against an existing one it is a no-op
with a note.

Other flags:

- `--byo` installs into a cluster yaac did not create, such as a cloud node
  pool (see "Bring your own cluster").
- `--tailnet` publishes a kind install's server on the machine's Tailscale
  tailnet through the Tailscale Kubernetes operator, instead of at
  `127.0.0.1`. The operator must already be installed; install prints the
  `helm upgrade --install tailscale-operator …` command when it is missing.
  The server then identifies every caller by tailnet user
  (docs/server-in-cluster.md "Reachability", docs/remote-hosting.md).
  `--byo` implies it.

## Images are built here, and only here

Every image yaac ships is built by `podman build` on the machine running
the CLI and pushed to the in-cluster registry. That covers the
base/tools/nestable workspace chain, the egress proxy, netd and the server.
Install also mirrors the digest-pinned upstream images yaac uses
(registry:2, Envoy, podman-stable, curl for the gVisor installer, Verdaccio).
Tags carry a content hash, so an unchanged source tree costs one registry
HEAD per image and re-running install is cheap. The server image's hash is
taken over the built bundle (`dist/`), so a rebuilt server is a new image
and therefore a rollout.

The server builds none of these. It looks each one up in the registry by
tag, and a missing tag is an error that names this command, not a build
trigger. That is why the server needs no container engine
(docs/trust-split-builds.md). The only images the server builds are the
ones a project or user wrote, and only inside sandboxed builder pods.

## The runtime

- **Podman** builds images (`podman build` / `podman push`) and hosts the
  kind node containers.
- **Kubernetes** runs the workspaces: one single-pod Job per workspace, on a
  local kind cluster of one or more nodes.

Workspace pods run under gVisor (runsc). gVisor's gofer process does
hostPath I/O as node root, while the sentry (gVisor's user-space kernel)
checks file permissions against the ownership the backing filesystem
reports. So that filesystem must report real file ownership. Any normal
Linux filesystem does. On macOS this constrains the VM stack.

## macOS: the podman machine

On macOS podman runs in a VM, and yaac needs two non-default machine
settings: **rootful** (kind requires it) and the **libkrun provider** with
the patched `yaac-krunkit` from yaac's Homebrew tap.

The provider choice is about virtiofs ownership. Apple's
Virtualization.framework (applehv/vz) reports the accessing process as the
owner of every file ([lima#1513](https://github.com/lima-vm/lima/issues/1513)).
gVisor's root gofer then sees root-owned files, and workspace uids can never
write hostPath mounts. chown is silently ignored and idmapped mounts fail
with EINVAL, so there is no remapping workaround. Stock krunkit (<= 1.3.x)
fails the same way, because it hardcodes libkrun's `Simplified` virtiofs
mode, which also reports the accessor as owner. `yaac-krunkit` is upstream
krunkit built against a patched `yaac-libkrun` that forces `LinuxComplete`
mode, which reports real host ownership.

Install writes a `containers.conf.d` drop-in selecting libkrun, then runs
`podman machine init --rootful` and starts the machine. An existing machine
on another provider is removed and re-created after a confirmation prompt.

Use podman 6.0 or newer. It passes krunkit's `--timesync` flag itself
([podman#28527](https://github.com/containers/podman/pull/28527)) and its
machine image ships the vsock guest agent
([podman-machine-os#238](https://github.com/containers/podman-machine-os/pull/238)),
so the VM clock survives Mac sleep
([podman#11541](https://github.com/containers/podman/issues/11541)). A
machine created under podman 5.x lacks that guest setup and must be
re-created (`podman machine rm` and re-init). Install detects this and
prompts.

## Linux: rootful podman

On Linux yaac uses the **rootful** podman engine, for the same reason as on
macOS. kind's node runs as a container on this engine, and the calico-node
agent needs privileges that only exist in the initial user namespace. Under
rootless podman the kernel denies the agent's `mount-bpf-fs` init container
(`mount: /sys/fs/bpf: permission denied`), so the pod never leaves Pending
and install times out at `1 pods of DaemonSet calico-node are not ready`.
Kernels >= 6.9 allow that mount in a user namespace, but loading Calico's
BPF programs still needs CAP_BPF in the initial namespace, so rootful is
required either way.

`ensureRootfulPodmanHost` (`#drivers/k8s/container`, runtime.ts) sets
`CONTAINER_HOST=unix:///run/podman/podman.sock` at CLI startup. kind
inherits it, so its podman provider uses the rootful engine, and every
`podman build`/`push` targets the same store. A `CONTAINER_HOST` you set
yourself is left alone.

The rootful socket is root-owned and started by systemd, so yaac cannot
start it. Enable it once and grant your user access:

```sh
sudo apt install podman              # Debian/Ubuntu (or dnf on Fedora/RHEL)
sudo systemctl enable --now podman.socket
sudo setfacl -m u:$USER:x /run/podman
sudo setfacl -m u:$USER:rw /run/podman/podman.sock
```

For access that survives the socket being re-created, add a
`podman.socket` drop-in (`sudo systemctl edit podman.socket`) with
`SocketMode=0660` and `SocketGroup=` set to a group you are in. Install
prints these steps when the socket is unreachable.

## Linux: VPN and firewall interference

These host settings make a container look up but unresponsive:

- **VPN firewalls (e.g. Mullvad)** reject traffic to the podman bridge
  subnets. That includes loopback-published ports such as kind's API server
  on `127.0.0.1:<port>` or a `kubectl port-forward`, because their
  destination is rewritten to the container IP before the VPN's filter
  runs. Symptom: `curl` fails "after 0 ms" and `tcpdump -i podman0` sees
  nothing. Enable the VPN's LAN exemption (Mullvad: `mullvad lan set
  allow`). Split tunneling does not help, since the blocked traffic is
  forwarded by the kernel, not sent by a process.
- **Host `arp_ignore=2` makes pods unreachable from their node.** A new pod
  network namespace copies its IPv4 `conf/all` settings from the host's
  root namespace (kernel default `net.core.devconf_inherit_init_net=0`),
  not from the kind node. Calico gives each pod a `/32`, so with
  `arp_ignore=2` the pod ignores ARP from the node: containers run but every
  kubelet probe times out. VPN clients set this (Mullvad is a suspect).
  Install detects it when the registry stalls and tells you to run `sudo
  sysctl -w net.core.devconf_inherit_init_net=3` (new namespaces copy from
  their creator, the node), persist it in `/etc/sysctl.d`, and re-create the
  cluster.
- **ufw hosts: use netavark's iptables firewall driver.** The nftables
  driver keeps its rules in a separate table that ufw's default-deny can
  override, and it has been seen not handling loopback-published ports at
  all (connections hang on podman's port-reservation socket):

  ```sh
  printf '[network]\nfirewall_driver = "iptables"\n' \
    | sudo tee /etc/containers/containers.conf.d/50-firewall-driver.conf
  ```

  Switch drivers only with a reboot or a full teardown of containers and
  networks. `podman network reload` across a driver change leaves
  half-migrated rules behind.

## kind and Kubernetes versions

yaac needs kind v0.33.0 or newer, and install refuses an older one:

- **The node image is pinned.** `k8s/kind-config.yaml` pins the node image
  (Kubernetes 1.37.0) by digest, so a kind upgrade never silently moves new
  clusters to another Kubernetes minor. kind only guarantees an image works
  with the release that published it, so bump the pin and the kind minimum
  together. Existing clusters keep the version they were created with.
- **podman 6 breaks older kind.** Podman 6.0 changed the container label
  format from a map to a slice, and kind <= v0.32.0 then fails to list its
  node containers (`kind get clusters` exits 125,
  [kind#4201](https://github.com/kubernetes-sigs/kind/issues/4201)). yaac's
  own podman calls do not read labels and are unaffected.

## What it wires up

1. **The image registry**: a `registry:2` Deployment behind a ClusterIP
   Service in the `yaac` namespace, the same shape as the per-project
   registries. Pods, builder pods and the server pull and push through its
   Service name (`yaac-registry.yaac.svc.cluster.local:5000`). The node is
   not a cluster-DNS client, so a one-shot pod per node writes a containerd
   `hosts.toml` mapping that name to the live ClusterIP. The CLI is outside
   the cluster, so it pushes through a `kubectl port-forward`. Neither path
   depends on host-to-cluster networking.

   Blobs live on an RWO PVC, `yaac-registry-storage-<install-hash>`, keyed
   by install so two installs never share a store. It binds through the
   cluster's default StorageClass, so a cluster with none leaves the
   registry Pending. Losing the store costs only re-pushes. Reads are
   anonymous. A write needs a grant signed by the cluster's registry key,
   which an Envoy gate in the registry pod checks (docs/trust-split-builds.md
   "The write gate"). Install creates the key on its first run, as the
   Secret `yaac-registry-grant-key` in its own `yaac-registry-keys`
   namespace.
2. **Two extraMounts per node.** Your home directory, at the same path: the
   two storage claims (`yaac-global`, `yaac-server-local`) bind static
   hostPath volumes onto the data dir's `global/` and `server-local/`
   folders, and a hostPath resolves on the node, so this mount is what makes
   the volume the host's bytes (docs/server-in-cluster.md "Storage is two
   claims"). And `<dataDir>/node-local` at `/var/lib/yaac/node/<hash>`,
   holding the node-local tier (package caches, image stores, opencode
   working copies). On kind that tier is therefore host disk and survives a
   cluster delete. Both mounts are on every node, and the second is per
   install.
3. **The kind node fixups**: two settings that a node container needs and a
   real node does not, applied through podman.
   - A raised pids limit on the node container (32768). Podman's default of
     2048 is hit by subagent fan-out as `fork: resource temporarily
     unavailable`.
   - `--housekeeping-interval=300s` in the kubelet flags
     (`kubeadm-flags.env`). At the 10s default, cAdvisor reads every open fd
     of every process on each tick, and gVisor sandboxes hold ~9k fds each;
     kubelet alone used 1.5–2 cores on a busy node. On a cluster yaac did
     not create this is a node-pool setting.
4. **The gVisor runtime and node tuning**, via the `yaac-gvisor-install`
   DaemonSet. On every node, a privileged pod installs a pinned `runsc` and
   `containerd-shim-runsc-v1`, registers two runsc handlers in containerd
   (`runsc` and `runsc-nested`, each with its own
   `/etc/containerd/runsc*.toml`), restarts containerd, and labels the node
   `yaac.gvisor=true`. Both handlers set `allow-suid` so the image's
   passwordless `sudo` works in the sandbox; `runsc-nested` also allows raw
   and packet sockets for the in-pod container engine. Install waits for
   the rollout, then applies the `gvisor` and `gvisor-nested`
   RuntimeClasses. Their `scheduling.nodeSelector` is that label, so a
   sandboxed pod can only land where the shim exists.

   Each pass first tunes the node: `vm.min_free_kbytes` and the two
   `fs.inotify` limits (raised to yaac's minimum, never lowered),
   `vm.compaction_proactiveness` (skipped with a log line on kernels older
   than 5.9), and a `DefaultTasksMax=infinity` drop-in in
   `/etc/systemd/system.conf.d`. If the node's systemd reports a live
   `DefaultTasksMax` other than `infinity`, the pass runs `systemctl
   daemon-reexec`, since the file alone only takes effect at the next boot.
   Without these, subagent fan-out, virtiofs allocations under memory
   pressure and netd's Envoy (which needs an inotify fd at startup) all
   fail. The pass runs on every pod start and every ten minutes, so a node
   that restarts gets its settings back without re-running install. A node
   the pass cannot tune never gets the runtime label, so yaac never
   schedules workspaces onto it.

   It is a DaemonSet rather than a loop of `podman exec <node>` so it works
   on nodes yaac has no shell on, and a replaced node sets itself up. It is
   idempotent: binaries are downloaded only when the node's cached copy
   fails the release's sha512, and containerd restarts only when a config
   changed. Passes take a node-local lock, so installs sharing a node (an
   e2e run's) must pin the same gVisor version. The installer image is
   digest-pinned upstream `curlimages/curl`. docs/plans/cloud-k8s.md covers
   why the privilege is accepted.

   Every pod running untrusted code names a RuntimeClass: plain workspaces
   use `gvisor`, and nested-containers workspaces run their rootful in-pod
   engine on `gvisor-nested`. Trusted yaac infra (the proxy, registries,
   node-write pods) runs on runc, since a sandbox per infra pod costs CPU
   for no containment gain.
5. **PriorityClasses**: `yaac-infra` (1000000) > `yaac-builder` (100000) >
   `yaac-workspace` (1000). The proxy and registries use the infra tier,
   image builder pods the builder tier, and workspaces the workspace tier.
   The order decides who is evicted first when a node fills up: losing the
   egress proxy cuts off every workspace, while losing one workspace costs
   one workspace.

   Only infra pods may preempt. Builders and workspaces set
   `preemptionPolicy: Never`. A preempted workspace Job (`backoffLimit: 0`)
   never comes back, so a build waits for room rather than evicting a
   workspace. netd stays on `system-node-critical`, like kube-proxy.

   The server also re-applies the classes on every start, so an existing
   cluster picks them up on upgrade.
6. **Calico**: upstream's KDD/iptables manifest for the pinned version,
   verified against the checksum committed in `k8s/calico/` and cached at
   `<dataDir>-client/cache/calico-<version>.yaml` so a cluster re-create does
   not re-download it. A checksum mismatch fails install. Calico's images
   (~235 MB) are pulled to the host engine and side-loaded onto the nodes,
   so they download once rather than on every re-create.
   `k8s/calico/README.md` has the steps for changing the pin.
7. **The npm cache**: one Verdaccio (`yaac-npm-cache`) in the install
   namespace, which every workspace's `pnpm install` goes through
   (docs/workspace-storage.md "Package installs"). A one-replica Deployment
   over an RWO claim, like the registry. A new workspace uses it only while
   a cache pod is ready; otherwise its pnpm goes to npmjs. Install carries on
   if the cache fails, since installs are only slower without it.

## Multi-node

`--nodes N` creates one control-plane node and `N-1` workers, up to 5. Every
node is a container on this one host, so this changes topology, not
capacity. It only applies when install creates the cluster.

**Workspaces land on the workers.** Once a cluster has workers, kind keeps
the control-plane's `node-role.kubernetes.io/control-plane:NoSchedule`
taint, and workspace pods do not tolerate it. So `--nodes 2` gives one node
that can run workspaces and `--nodes 3` gives two. **3 is the smallest
topology that really exercises multi-node scheduling.** `yaac cluster
check` reports both counts.

`k8s/kind-config.yaml` holds one control-plane node entry with the `$HOME`
extraMount. Install adds the node-local mount to it and copies the entry
into `N-1` worker entries, so every node has both mounts. Because all kind
nodes share this host's filesystem, the claims' volumes resolve to the same
bytes whichever node a workspace lands on, and the "node-local" tier is one
host folder. The rest of the config (the containerd `config_path` patch,
the kubelet swap patch, `disableDefaultCNI`) is cluster-wide.

Host-side loops over the node list apply the kind node fixups and write
both registries' `hosts.toml`. DaemonSets (the gVisor installer, Calico,
netd) also cover nodes added later.

Both registries store blobs on RWO PVCs. Under kind's default `standard`
class (rancher local-path, `WaitForFirstConsumer`) the directory is on one
node, but the bound volume carries node affinity, so a rescheduled registry
pod returns to the same store. On a cluster whose default class is
network-attached, the store follows the pod. The Deployments are not pinned
to a node: a `nodeSelector` would turn a self-healing reschedule into a
single point of failure.

## Bring your own cluster

```sh
yaac cluster install --byo --rwx-storage-class <nfs-class> [--rwo-storage-class <block-class>]
```

Installs into the cluster the current kubeconfig points at: a self-managed
pool, or a managed one on a mutable node OS. It applies the same in-cluster
layers and server Deployment as a kind install. It creates no cluster,
needs no `kind`, installs no CNI (it uses the cluster's existing Calico),
and is re-runnable like every other mode. What differs:

- **Storage** comes from storage classes instead of static volumes.
  `yaac-global` uses `--rwx-storage-class`, which must be NFS-family
  (csi-driver-nfs, EFS, Azure Files over NFS). `yaac-server-local` uses
  `--rwo-storage-class` or the cluster's default class. Install re-adopts
  its own volumes that a namespace delete left `Released`, matched by the
  random install id recorded in `server.json` (never by data-dir path). It
  claims each volume root for that id through a one-shot binder pod and
  sets both volumes to `Retain` (docs/server-in-cluster.md "Storage is two
  claims"). A class with a fixed `subDir` or base path gives every claim the
  same directory, so it can host only one install; a second is refused.
- **The uid** is a fixed 1000, not this machine's
  (docs/server-in-cluster.md "The uid everything runs as").
- **The server is published** through the Tailscale operator's TLS Ingress.
  `--byo` implies `--tailnet`, since a cloud cluster has no host loopback.

**Gates.** These run in order before anything is built or applied, and
before the podman setup, so a refusal changes nothing:

| Gate | Refuses |
|---|---|
| Architecture | a node pool that mixes architectures, or whose architecture is not this machine's (install builds every image here, with no cross-build) |
| Node OS and containerd | a runtime other than containerd; an immutable OS (Bottlerocket, Container-Optimized OS, Talos, Flatcar); EKS Fargate and GKE Autopilot; k3s and RKE2, whose embedded containerd keeps its config in a template the gVisor installer does not write yet |
| CNI | everything in "The CNI gate" below |
| Operator | no Tailscale operator or no `tailscale` IngressClass (an unanswered query is reported separately from "absent") |
| Storage | an RWX class that is missing or not NFS-family, a missing RWO class, or no default class (the registry and npm cache use it) |
| Identity | a live `yaac-server` Deployment of another install (its `yaac.install-id` label differs; installing over it would take over its storage), or a data dir recorded as containerless |
| Cluster | a current context whose cluster is not the recorded one (below) |
| Environment | `YAAC_USE_TOR`, which names a listener on this machine that no pod there can reach |

`yaac cluster check` repeats the `architecture` and `node-os` gates on every
run, so a node of the wrong kind added later is reported rather than
failing to pull with no explanation.

**What `--byo` never does:** exec into a node, or create host directories
for the storage tiers. The kind node fixups are node-container settings, so
the check's `node-fixups` gate skips on byo, and on a real pool the
housekeeping interval is a pool setting. The node tuning still reaches
every node through the gVisor installer DaemonSet.

**containerd's registry config.** The installer supports stock containerd,
restarted through the node's systemd, reading registry hosts from
`/etc/containerd/certs.d`. kind's config patch sets that `config_path`; on
byo the installer adds it on every pass when the config has no registry
section. A config that names another directory, or still uses the
deprecated `mirrors` (which containerd refuses beside `config_path`), fails
that node's readiness with the reason.

**The cluster is recorded.** Every cluster call uses the kubeconfig's
current context, and a cloud user likely has several. Install records the
cluster in `server.json` as the uid of its `kube-system` namespace, since a
context name can point at a different cluster in another kubeconfig; the
context name is kept only for error hints. Every host-side command that
touches the cluster (`cluster install|check`, `server
start|stop|restart|logs`) refuses when the current context is a different
cluster, or cannot be identified (reading `kube-system` is Forbidden under
typical namespace-scoped RBAC). The refusal suggests `kubectl config
use-context <recorded>` where that helps. Refusing avoids threading
`--context` through every call. A kind install checks the other way round,
since its cluster may be deleted and re-created: the current context must be
`kind-<cluster>` and point at the API server kind reports, and install then
records that cluster.

**A data dir is byo or not for its whole life.** Plain `yaac cluster
install` on a byo data dir is refused before it does anything (it would
create a local kind cluster and switch the current context to it), and
`--byo` on a kind data dir likewise.

**A dead NFS server hangs, it does not fail.** The shared claim is mounted
`hard` unless its class says `soft` (Linux's default; yaac leaves the choice
to the class). While the server is gone, every I/O on the global tier
blocks, including the kubelet's unmount, so those pods sit `Terminating` and
the node usually needs a reboot, or to be cordoned and replaced. `soft`
turns the hang into EIO after retries, which a git checkout or half-written
file then has to survive. yaac always sets `actimeo=1` on the volume: one
attribute check per file per second (billed latency on EFS) bounds how long
a workspace can act on a file the server has already changed.

**`yaac cluster delete` refuses on a byo install**, since the cluster is not
yaac's. It prints the uninstall steps instead: the install's namespaces (the
registry signing key has its own) and the cluster-scoped objects labelled
with them, then the runtime objects and `yaac.gvisor` node labels, which
every install on the cluster shares. The two `Retain` volumes survive on
purpose; it says how to remove them by install id.

### The CNI gate

A byo cluster's Calico may be self-managed or provider-managed (GKE
Dataplane V1, AKS `--network-policy calico`, Calico policy-only over the AWS
VPC CNI on EKS). The netd redirect (docs/workspace-egress.md) works on any
CNI whose pod egress passes through host netfilter and that leaves
ClusterIP translation to kube-proxy. On a kind cluster yaac installs, those
properties hold by construction; on byo they are checked. Each check is a
refusal, not a warning, because each fails silently when wrong:

| Checked | Why it matters |
|---|---|
| calico-node present and fully rolled out | Calico enforces NetworkPolicy; a node without Felix has no egress lockdown. A Cilium cluster also shows up as "no Calico", and no Cilium setup works with the redirect |
| **not** the eBPF dataplane: `spec.bpfEnabled` on any FelixConfiguration, or `FELIX_BPFENABLED` on the container | eBPF routing bypasses host netfilter: the redirect chain exists, sees no packets, and every workspace silently loses the internet |
| kube-proxy running and not replaced (`bpfKubeProxyIptablesCleanupEnabled`) | netd's Envoy dials the yaac proxy by ClusterIP from the host network, and netd's rules sit below `KUBE-SERVICES` to keep ClusterIP traffic out of the redirect |
| a non-empty, fully parseable pod-CIDR set | netd skips pod CIDRs before redirecting. With none, it would send pod-to-pod 443/80 into the proxy. kind falls back to its default; `--byo` refuses |
| `system-node-critical` exists | netd uses it, and a pod naming a missing class is rejected, so netd would run on no node |
| workload routes match the veth prefix, **on every node** | netd finds each pod's veth from host routes, read through each netd pod once it is up. A prefix that matches nothing gives a chain with no per-pod rules, which looks like a healthy netd |
| every check actually ran | a read that failed (RBAC denied, timeout) is unknown, not "absent". Absence is meaningful here (no FelixConfiguration means iptables defaults), so a failed read must not wave an eBPF cluster through |

Two things are recorded but not enforced. `chainInsertMode`: netd appends
its own `nat PREROUTING` jump and does not compete with Felix for position,
so `Append` only warns. And per-node kube-proxy coverage: a node without
kube-proxy loses egress while the rest work, which looks intermittent, so
those nodes are named.

The veth and kube-proxy checks run **per node**. On a mixed fleet (several
node pools or AMIs, common on EKS) one node's routing table says nothing
about another's.

**NetworkPolicy enforcement is tested, not assumed.** Policy-only Calico
over a foreign IPAM is a supported setup, and a misconfigured one looks the
same until a workspace escapes. The check's `egress` gate (see "Verifying")
tests enforcement directly, and its failure makes install exit non-zero.

**A failed check leaves the install in place.** Install applies everything
before it verifies, so the only sign of failure is the exit code; nothing is
rolled back. This matters most for the `egress` gate: on a cluster that
fails it, workspace egress lockdown is advisory (policy applied but not
enforced), and the proxy allowlist covers only the ports the redirect steers
(443, 80 and the ssh port). Install says so when that gate fails. **Do not
start workspaces until a re-run passes.**

The veth check also runs on every `yaac cluster check` (the `veth-source`
gate), which catches a node pool added after install.

The install and registry namespaces are labelled for the `privileged` Pod
Security Standard. This does nothing on kind, but matters on a byo cluster
whose default is `baseline` or `restricted`: netd is `hostNetwork` with
`NET_ADMIN`/`NET_RAW`, and the node-write pods hostPath-mount `certs.d`. PSS
is per namespace, so nothing outside them is relaxed.

Three environment variables cover what a foreign cluster does not expose:

- `YAAC_CNI_VETH_PREFIX`: the name prefix of workload veths (default
  `cali`; policy-only Calico over the AWS VPC CNI uses `eni`). An empty or
  invalid value falls back to `cali` rather than matching every device,
  because the prefix is what keeps netd from redirecting non-workload
  traffic. When the prefix matches nothing, the refusal names the prefix
  the node's routes actually use.
- `YAAC_POD_CIDRS`: extra pod CIDRs, comma-separated, added to the
  discovered ones (never replacing them). Too narrow a set is the dangerous
  direction, since a pod IP outside it is treated as the internet. An entry
  that is not a valid IPv4 CIDR is refused, not dropped.
- `YAAC_KUBE_PROXY_EXTERNAL=1`: kube-proxy runs where no pod shows it.
  **k3s** runs kube-proxy inside the kubelet, so there is nothing to detect.
  Getting this wrong loses egress rather than opening it: netd's Envoy
  cannot reach the proxy, and the workspace NetworkPolicy still blocks the
  internet. It is recorded in the audit trail, as the one check an operator
  can override.

All three are read at apply time, so changing one on a live cluster needs a
re-run. kube-proxy pods are found by `k8s-app=kube-proxy` (kubeadm, EKS,
kind) or `component=kube-proxy` (GKE, AKS).

Out of scope: Cilium in any configuration, and policy for anyone else's
workloads. Every yaac policy selects only yaac's own pods.

## Running byo locally: kind-byo

```sh
pnpm kind-byo up     # create the stand-in cloud cluster, then `yaac cluster install --byo` into it
eval "$(pnpm -s kind-byo env)"   # its data dir, kubeconfig, kind cluster name and CA bundle
pnpm kind-byo down   # delete the cluster; the data dir keeps the install's files
```

A repo tool (`packages/test-utils/src/kind-byo.ts`), not a CLI mode. It
creates a second kind cluster set up to look like a cloud one, then runs a
real `yaac cluster install --byo` into it with the built CLI. The CLI does
not know about it, which makes it a real test of the byo path. It is how
byo runs end to end on one Linux machine, by hand or in the `e2e-byo` tier
(docs/server-in-cluster.md "The e2e tiers run against this").

| Piece | What | Why |
|---|---|---|
| Cluster | kind `yaac-byo`: a control-plane and two workers, `disableDefaultCNI`, none of yaac's kind-config patches, its own kubeconfig in the install's client-local dir | two nodes that can run workspaces, so NFS timings are cross-node; no containerd patch, so the installer's own `config_path` handling runs |
| Node mounts | one extraMount on every node: kind-byo's data dir, at its own path | backing store for all classes; nothing else of the host is visible |
| CNI | the pinned Calico manifest, applied by the script | the CNI gate's happy path, on a CNI yaac did not install |
| RWX | nfs-ganesha on the control-plane node behind csi-driver-nfs, class `kind-byo-nfs` | the self-managed shape: an NFS server you run, provisioned by `nfs.csi.k8s.io` |
| RWO | local-path-provisioner, `WaitForFirstConsumer`: default class `kind-byo-local`, plus `kind-byo-rwo`, which install is told to use for `yaac-server-local` | like a provider's zonal disk: node-pinned, which is why install's binder pod exists. Named rather than defaulted, so ignoring the flag would show |
| Server publishing | the Tailscale operator, with its OAuth client from `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET`, and every proxy defaulting to a ProxyClass using Let's Encrypt **staging** | `--byo` implies the tailnet; without the client, `up` says so and install stops at the operator gate |
| Node fixups | the script sets the pids limit on its node containers itself | `--byo` never touches nodes; the script made these containers |

**Its volumes land in its own data dir** (`KIND_BYO_DATA_DIR`, default
`~/.yaac-byo`), one directory per claim under `volumes/<namespace>/<claim>`,
e.g. `<dataDir>/volumes/yaac/yaac-global`. The data dir's own `global/` and
`server-local/` stay the installing CLI's, as a laptop's are on a real
cloud install. The classes are written as plainly as an operator would
(`reclaimPolicy: Delete`, no `actimeo`, no `mountPermissions`), so every
storage step install takes is exercised, and `cluster check` fails if one
regresses. The node-local tier is the node containers' own disk, so
deleting the cluster costs cold caches, like a drained cloud node.

**A second cluster, not a second namespace.** Its NFS mounts are `hard`, so
a stuck ganesha blocks every mount operation on its nodes; in a shared
cluster that would stall the everyday kind install. (It is also why `down`
drains the workers first: a node whose last unmount outlives ganesha waits
forever.) And the everyday cluster has everything a kind install set up, so
a byo install there could not show it works without it.

**ganesha rather than kernel nfsd.** A user-space server in a pod needs no
host kernel module, leaves no host state, and restarts like any Deployment,
which rehearses an NFS server restart. The export is NFSv4 only, with
`No_Root_Squash` (uids pass through as-is), `Graceless` (no grace-period
stall after a restart), a pinned `Filesystem_Id`, and ganesha's metadata
caching off, because the host also writes the data dir directly. Only node
addresses may mount, enforced by the export list and a NetworkPolicy on
port 2049. The image (from `test/kind-byo/ganesha/`) is side-loaded, since
it must serve before the registry exists. csi-driver-nfs,
local-path-provisioner and the operator are pinned like Calico, with
checksums in `test/kind-byo/pins.sha256`.

**Its certificate is a staging one**, the one way kind-byo differs from a
cloud install. Production Let's Encrypt issues at most five certificates a
week per name, and every `down`/`up` asks again; staging allows 30,000. The
operator is set up for this through `PROXY_DEFAULT_CLASS`, not through
yaac. `env` exports the pinned staging roots as `NODE_EXTRA_CA_CERTS`. A
browser will not trust that origin.

**Linux only, on a real filesystem.** ganesha's VFS backend needs file
handles that outlive the kernel's inode cache. ext4, xfs and btrfs provide
them; tmpfs, overlay and a macOS virtiofs share do not, so `up` refuses a
data dir on anything else. On macOS, run the kind tiers.

**The install uid is 1000; yours may not be.** Files under a kind-byo data
dir are owned by uid 1000, as on a cloud NFS server. If your host user is
not 1000 they are readable but not writable from the host, which is why the
`e2e-byo` tier refuses such a host.

## After a restart

**Sysctls** are lost when a node or VM restarts. The installer
DaemonSet's pod restarts with the node and its first pass puts them back.
A node that stays untuned in the `node-tuning` gate is diagnosed from the
installer's log (`kubectl -n yaac logs -l app=yaac-gvisor-install`).

**The kind node fixups** are podman state and a kubelet flags file. Both
survive a node container restart and are lost only when the container is,
on a cluster re-create. Install re-applies them on every run, and the
check's `node-fixups` gate points at `yaac cluster install` when they are
missing.

**The gVisor runtime** reinstalls itself on any new node, and install
re-applies the DaemonSet, which is how a runsc version bump reaches an
existing cluster.

**A host reboot leaves the kind node containers stopped** (kind creates
them with no restart policy), which the check reports as an unreachable API
server. Run `yaac cluster install`: it starts every stopped node, applies
the fixups, waits for the API server, and converges as usual. Until
calico-node is back, pod statuses still show their pre-reboot values, so
the registry step waits on a real connection rather than on the rollout
status.

## What a workspace reserves

Each workspace container requests **250m cpu, 1Gi memory and 2Gi
ephemeral storage**, and is limited to **8 cores, 8Gi memory and 16Gi
ephemeral storage**. A nested-containers workspace adds its podman
graphroot volume's size to the storage limit, since kubelet charges it
there. A workspace with module dirs (the default, `node_modules`) adds 2Gi
to the storage request, the install it really holds, and one module dir's
9Gi volume cap to the limit. Requests are what the scheduler reserves, and
they sit well under the limits: the node is deliberately overcommitted, to
fit many mostly-idle workspaces.

Memory and disk are capped because they cannot be throttled, and one
workspace must not take the node down. The cpu limit is for gVisor: runsc
sizes the sandbox's virtual cpu count from the cpu quota
(`-cpu-num-from-quota`), and starts one systrap stub process per virtual
cpu. With no limit, every sandbox sees all host cores, and one
syscall-heavy workspace (an e2e suite, say) starves the node. The limit is
far above the request, so it does not throttle an interactive agent.

In practice this caps concurrent workspaces at roughly `cores × 4` or `GB
of memory`, whichever is lower. A workspace that does not fit sits
`Pending` with an `Insufficient cpu` (or memory) event rather than failing.

## Runtimes and uids

Root inside a gVisor sandbox has no authority outside it, which is why the
image can grant passwordless sudo (so agents can `apt-get install`) and why
nested-containers workspaces can run their engine as root on
`gvisor-nested`. No user namespace or idmap is used, so files on the claims
show their real uids, and every writer of a shared path must use the same
one: **the install uid**. On kind it is the uid of the user who ran install
(on macOS virtiofs allows nothing else); on byo it is a fixed 1000. Every
yaac pod runs at it (docs/server-in-cluster.md "The uid everything runs
as").

The images work at any uid, so one image set serves every host
(docs/arbitrary-uid-images.md). A standalone `Dockerfile.yaac` that creates
its own user must follow the same pattern, or its writes fail with
`Permission denied` on hosts whose uid is not 1000. The README's "Custom
images" section explains how.

## Verifying

Run `yaac cluster check` whenever workspaces fail to start. Its gates, in
order:

- `kubectl`, `cluster`, `nodes` (how many nodes, how many can run
  workspaces, and whether they are Ready), then `architecture` and
  `node-os` (the byo node gates), `podman`, `registry` and `namespace`.
- `storage`: both claims are Bound and both volumes are `Retain`. On kind
  each volume is a static one pointing at the data dir's own tier folder.
  On byo each is labelled with this install's id, and the global one is
  NFS-family and mounted with `actimeo` of at most 1. A missing claim fails
  and points at install.
- `priority-classes` and `node-fixups` (kind only, warn).
- `gvisor`: the RuntimeClasses exist, at least one node has the
  `yaac.gvisor` label, and a `gvisor`-class pod really runs inside the
  sandbox.
- `node-tuning` (warn): the sysctls and `DefaultTasksMax`, read through the
  installer's pod on every node.
- `probe`: an end-to-end probe pod on the `gvisor` class that pulls from the
  registry, mounts `yaac-global`, and **writes** at the workspace uid. A
  peer pod on runc at the install uid, with the claim mounted whole (as the
  server has it), writes a nonce the probe must read, checks the probe's
  write arrived, and times a second round trip while both run. The two
  prefer different nodes, so on a multi-node cluster the reported round
  trip is cross-node: the coherence figure an NFS class is judged by. The
  check never touches this machine's copy of the data dir, so it works the
  same when the claims live elsewhere.
- `egress`: a workspace-labelled pod cannot reach the API server and cannot
  dial the proxy's transparent ports directly. This is the NetworkPolicy
  enforcement test.
- `npm-cache`: a workspace-labelled pod fetches a package through the
  cache. Warns when there is no ready cache pod; fails when a ready one
  does not serve.
- `datapath`: calico-node and netd are Ready, meaning policy is enforced
  and a redirect exists.
- `veth-source`: runs in each netd pod against that node's routing table
  and checks that workload routes match the configured veth prefix. A
  Ready netd does not imply this: netd is Ready once Envoy accepts its
  config, even with no pod-to-veth mappings.
- The per-node sweep (multi-node only, below).
- `nested-mount` (warn): a pod under the nested security context can mount
  a tmpfs, which the in-pod engine needs.
- `storage-semantics`: runs `k8s/probes/fsprobe.py` (ownership, O_EXCL,
  atomic rename, hardlinks, locks, fsync, mmap, append, xattrs) against the
  claim from a sandboxed pod. Fails on every backend, since workspaces run
  the same code on each.
- `vap`: the ValidatingAdmissionPolicy API is available. Builder pods need
  it, so without it no workspace image can be built.
- `runtime-stamp` (warn): no workspace-labelled pod runs without a gvisor
  RuntimeClass.

### Which nodes count as workspace-eligible

The node count, the per-node sweep and byo's per-node kube-proxy check all
consider only the nodes a workspace could land on: Ready, not cordoned, and
with no taint the workspace pod does not tolerate. A workspace pod's
tolerations are whatever the `gvisor` RuntimeClass declares in
`scheduling.tolerations`, which Kubernetes merges into every pod naming the
class.

This is also how a **dedicated workspace node pool** works. Taint the pool,
add the matching toleration once to the RuntimeClass, and workspace pods,
builder pods and the check's pinned probes all inherit it. Scope the
toleration to the pool's own taint key: a bare `{operator: Exists}`
tolerates every taint, so every node looks eligible whatever its state.
Builder pods share the class, so untrusted image builds compete with
workspaces for the pool. Trusted infra names no RuntimeClass and stays off
it. The one-shot node-write pods are the exception: pinned to each node by
`nodeName`, they tolerate everything, because a node without its containerd
`hosts.toml` cannot pull workspace images. When no node qualifies, the
check lists each node and the taint that excluded it, and suggests adding
the toleration to the RuntimeClass rather than removing the taint.

There is no config setting for the toleration yet. Install re-applies the
RuntimeClasses with none, which removes a toleration added through
`kubectl apply` but keeps one added with `kubectl edit`/`patch` (client-side
apply only removes fields it set). Re-check after every install.

On a multi-node cluster the check also pins one probe pod to each eligible
node and reports three warn-level gates:

- `runsc-nodes`: the node can run a sandboxed pod. A node the installer has
  not labelled yet fails by definition. Otherwise the node is judged by
  `status.runtimeHandlers` when its kubelet publishes it, or by whether its
  probe pod ran (containerd refuses a pod whose handler it lacks). The
  `gvisor` gate proves some node really runs the sandbox; this gate says
  which ones can.
- `registry-nodes`: the node's containerd can pull from the registry. The
  probe pulls with `Always`, so a cached layer cannot hide a broken route.
- `volume-nodes`: from that node, `yaac-global` has the same bytes the
  server sees, and the workspace uid can write it.

Each names its own fix. A probe pod that never ran is blamed on one gate
using the kubelet's event and reported unverified on the others, so no gate
passes on a node it could not check. Each gate also names the nodes it
skipped and why (`not swept: yaac-worker3 (untolerated taint …)`).

`yaac-global` must be the same bytes on every node. Multi-node kind gets
that by mounting `$HOME` into every node container; a cloud cluster gets it
from an RWX storage class.

## Deleting the cluster

```sh
yaac cluster delete        # prompts first; -y / --yes skips the prompt
```

This runs `kind delete`, and that is all it needs to do: everything yaac
deploys lives in the cluster, including Calico, netd, the main and
per-project registries with every pushed image, and the two storage claims
and their volumes. Running workspace pods stop, but nothing under the yaac
data dir is touched. The volumes are `Retain` and their bytes are the data
dir's own folders, so on-disk workspaces, the database and the node-local
caches all survive. A later `yaac cluster install` re-creates the cluster,
re-binds the same folders, and re-pushes images as needed. The podman
machine and its image store are left alone, since they are the build
engine, not the cluster.

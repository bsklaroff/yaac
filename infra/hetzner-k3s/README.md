# yaac on Hetzner Cloud (k3s)

OpenTofu that stands up a k3s cluster on Hetzner Cloud shaped for `yaac
cluster install --byo` (docs/cluster-setup.md "Bring your own cluster"):
one control node, any number of workers you manage here, and pools the
cluster autoscaler grows and shrinks. Once `tofu apply` finishes and the
control node has bootstrapped, one command there installs yaac:

```sh
yaac cluster install --byo --rwx-storage-class yaac-nfs
```

## What it creates

| Piece | Why yaac needs it |
|---|---|
| A private network (`10.0.0.0/16`, nodes in `10.0.1.0/24`) and a firewall that admits only ICMP and ssh from `ssh_source_cidrs` | Node and pod traffic stays on the private network. Nodes reach the internet through their own public addresses. The Kubernetes API and the yaac server are reached over the tailnet, never publicly. |
| A control node (`control_server_type`, default cx43) running the k3s server | It also runs yaac's server and infrastructure and the first few workspaces, and it is where install runs: yaac builds its images with rootful podman on the machine running install, for that machine's architecture. |
| k3s on Ubuntu, against the host's containerd from apt rather than k3s's embedded one | The gVisor installer writes `/etc/containerd/config.toml` and restarts containerd through systemd. k3s's embedded containerd regenerates its config on every start and is refused by install. |
| kubelet `--housekeeping-interval=300s`, the iptables kube-proxy | The setting a kind install applies itself, and the kube-proxy mode netd's redirect sits beside (docs/workspace-egress.md). |
| kubelet `system-reserved` on every node (`control_system_reserved`, default 1 cpu and 2Gi; `worker_system_reserved`, default 500m and 1Gi) | The k3s server or agent, containerd and, on the control node, the datastore and the NFS server are host processes, outside the reach of yaac's PriorityClasses. A workspace may use memory far past its request, so the reservation keeps workspaces out of their room and makes the kubelet evict a workspace before they run short of memory. |
| Calico from the Tigera operator: VXLAN, the iptables dataplane, MTU 1400 | yaac's egress wall is Calico NetworkPolicy plus netd's iptables redirect. Hetzner's network routes only the addresses it assigned, so pod traffic is encapsulated. |
| The Hetzner cloud controller | Sets node addresses and provider IDs (the autoscaler finds servers by them) and removes the Node of a deleted server. Its network routes are off. |
| The Hetzner volume driver; `hcloud-volumes` is the default class | `yaac-server-local`, the registries and the npm cache. |
| A volume on the control node, exported over NFSv4, and csi-driver-nfs with a `yaac-nfs` class | `yaac-global`, the RWX claim every workspace mounts. Hetzner has no managed NFS. The volume outlives the server and has deletion protection. |
| The Tailscale Kubernetes operator | The only way onto a byo server is its tailnet Ingress. |
| The cluster autoscaler with its Hetzner provider, one node group per `autoscale_pools` entry | Adds workers as workspaces stop fitting and removes those that hold no workspace (see "Autoscaling"). |
| The `yaac.workspaces=true:NoSchedule` taint on every worker | Keeps yaac's server and registries on the control node (docs/cluster-setup.md "A dedicated workspace node pool"); workspaces run on every node (see "Nodes"). |

Every in-cluster piece is a manifest k3s applies from the control node's
manifests directory (cluster.tf), so tofu never talks to the Kubernetes
API. tofu writes that directory, the k3s config and the tokens over ssh
(control.sh.tftpl), not through user data, and re-runs that step whenever
they change.

## Before you apply

On this machine you need OpenTofu 1.10 or newer, and an ssh-agent holding
the key whose public half is `ssh_public_key`: tofu configures the control
node over ssh.

In Hetzner Cloud, create a **project of its own** for the cluster and an API
token for it with read & write access. The autoscaler and the volume driver
create servers and volumes in that project, so a dedicated one keeps
teardown simple.

In the Tailscale admin console, follow the four steps in
`infra/aws-eks/README.md` "Before you apply": MagicDNS and HTTPS
certificates, the operator's tag owners, an OAuth client for the operator,
and optionally a user-owned (untagged) auth key, set as
`tailscale_auth_key`, that joins the control node to your tailnet as you.

## Remote state

tofu keeps its state in a Hetzner Object Storage bucket, so any machine can
update or destroy the cluster, not only the one that created it. Create the
bucket once, before the first `tofu init`:

1. In the Hetzner console, **Object Storage → Create Bucket**: a globally
   unique name, any location, private, **versioning off**. OpenTofu locks
   the state with conditional writes, which Hetzner refuses on a versioned
   bucket.
2. **Security → S3 credentials**: generate a key pair. Hetzner shows the
   secret once. A new key can take 15 minutes or more to reach every
   storage server; until it has, requests fail at random with 403
   `AccessDenied` and `tofu init` cannot read or lock the state, so wait
   it out rather than changing the backend configuration.
3. Copy `backend.hcl.example` to `backend.hcl` (gitignored), with the
   bucket, its location's endpoint and the key pair.

Hetzner encrypts nothing on your behalf, and the state holds the Hetzner
token and the cluster's join tokens, so OpenTofu encrypts it before upload
with `state_passphrase` (versions.tf). Lose the passphrase and the state is
unreadable.

Another machine needs three things to take over: `terraform.tfvars`,
`backend.hcl`, and the ssh key in its agent (tofu configures the control
node over ssh, from an address in `ssh_source_cidrs`). The first two hold
every secret the stack uses; keep them in a password manager, not in git.

## Bring it up

```sh
cd infra/hetzner-k3s
cp terraform.tfvars.example terraform.tfvars   # fill it in
cp backend.hcl.example backend.hcl             # see "Remote state"
tofu init -backend-config=backend.hcl
tofu apply
```

`ssh_source_cidrs` is required: the addresses allowed to reach the nodes on
port 22, which tofu needs. Give this machine's `/32`.

tofu waits for the control node's containerd, installs the k3s server, and
returns while the node goes on to build yaac from `yaac_ref` (about ten
minutes). Then:

```sh
$(tofu output -raw control_ssh)
cloud-init status --wait        # the bootstrap; its log is /var/log/yaac-node.log
tailscale up --ssh --hostname yaac-control   # only without tailscale_auth_key
sudo -iu yaac
kubectl get nodes               # the control node, Ready
kubectl -n calico-system rollout status ds/calico-node
yaac cluster install --byo --rwx-storage-class yaac-nfs
```

`~/.yaac-hetzner.env`, sourced from `.bashrc`, sets `KUBECONFIG` (k3s's
`kubectl` otherwise reads its root-only config) and
`YAAC_KUBE_PROXY_EXTERNAL=1`: k3s runs kube-proxy inside its own process,
where the CNI gate cannot see a pod for it (docs/cluster-setup.md "The CNI
gate"). Install records it on the server Deployment.

Install checks the cluster before changing anything, then builds every
image on the control node. It ends with `yaac cluster check`, and **no gate
may fail** before you create a workspace. After that, use it from
your own machine, logged in to the same tailnet:

```sh
yaac remote set https://yaac.<tailnet>.ts.net
```

For `kubectl` from your machine, copy `~yaac/.kube/config` from the
control node and point its `server` at `https://yaac-control:6443` (its
tailnet name, which the API certificate covers).

## Nodes

**Infrastructure stays on the control node.** Every worker, manual or
autoscaled, joins with the `yaac.workspaces=true:NoSchedule` taint, which
only sandboxed pods tolerate, so a rollout (an upgrade, `yaac server
restart`) cannot move yaac's server or a registry onto a worker the
autoscaler may remove. The control node carries no such mark, so it takes
workspaces beside the infrastructure, and a cluster with no workers still
runs them.

k3s applies a node's taints only when it first joins, and tofu never
re-runs a manual worker's user data, so a worker that joined before this
taint was added does not get it from an apply. Taint each one by hand:
`kubectl taint node <worker> yaac.workspaces=true:NoSchedule`. Autoscaled
workers pick it up as they are replaced.

**Manual workers** are the `manual_workers` map, name to server type. Add an
entry and apply to add a node. To remove one, `kubectl drain` it first, then
delete its entry and apply; the cloud controller removes its Node once the
server is gone. Every worker joins with the `yaac.gvisor/pending` taint,
which yaac's gVisor installer lifts once the node can run workspaces.

**Every node shares one architecture**, the control node's, because install
builds images only for the machine it runs on. Hetzner's `cax` types are
arm64 and the rest amd64; the plan refuses a mix.

Every node also sits in `location`, because a Hetzner volume attaches only to
a server in its own location.

## Autoscaling

When a workspace pod cannot fit, the autoscaler creates a server in one of
the `autoscale_pools`, named `<pool>-<random>`:

1. The server boots with the pool's user data (the same as a manual
   worker's), joins with the pending taint, and the autoscaler, which
   knows it as a startup taint, counts it as still starting rather than
   adding another.
2. The yaac server's node-sync, on its next resync (at most a minute),
   writes the node's registry `hosts.toml` and admits its address in the
   NetworkPolicies.
3. yaac's gVisor installer installs runsc, labels the node `yaac.gvisor=true`
   and lifts the taint. The workspace lands there and pulls its image.

Workspace pods are marked `safe-to-evict: false`, so a node is removed only
once it holds no running workspace. Pools scale from zero: the autoscaler
plans a new node from the labels and taints in its cluster config
(cluster.tf) and the server type's disk, not from a live node.

## The control node is not disposable

It holds the k3s datastore (`/var/lib/rancher/k3s/server/db`) and the
install's identity (`~yaac/.yaac-client/server.json`, see
`infra/aws-eks/README.md` "The host holds the install's identity"). tofu
never replaces it on its own: later user-data and image changes are
ignored. Back both up. The shared claim's bytes are on the NFS volume, which
survives the server, but rebinding retained volumes into a new cluster is
done by hand.

## Upgrading

- **yaac**: on the control node as `yaac`, `cd ~/yaac`, check out the new
  ref, `pnpm install && pnpm build && npm install -g .`, then re-run
  install.
- **k3s**: bump `k3s_version`, and `autoscaler_version` with it when the
  Kubernetes minor changes, then apply. That re-runs the k3s installer on
  the control node. New autoscaled workers join on the new version; a
  manual worker moves when you drain it and
  `tofu apply -replace='hcloud_server.worker["<name>"]'`.

## Security notes

- **User data is readable from the node's metadata service**, and a
  worker's holds the k3s agent token. Pods cannot reach it: builder and
  proxy egress exclude the metadata address. Workspaces reach the internet
  only through yaac's proxy, which dials whatever a workspace's allowlist
  admits, the metadata address included under `*`, so the proxy's egress
  NetworkPolicy is the only barrier on that path. The control node's user
  data holds no secret.
- **The NFS export trusts client-claimed uids** (`no_root_squash`) and is
  open to the node subnet. A pod on another node reaches it SNATed to that
  node's address, so the export list cannot keep pods out. NetworkPolicy
  does: workspace egress is default-deny, and builder and proxy egress
  exclude NFS on node addresses. `yaac cluster check`'s `egress` gate
  verifies the workspace half against this server.
- The Hetzner API token sits in two Secrets in `kube-system`, read by the
  cloud controller, the volume driver and the autoscaler. The yaac server
  can read them too, since its ClusterRole reads every Secret, so a
  compromised server reaches the whole Hetzner project: it can create and
  delete servers and volumes and read user data.

## What has been tried, and what has not

Verified on Hetzner: `tofu apply` with the state in Hetzner Object
Storage, the bootstrap of every in-cluster piece (the Calico operator and
the cloud controller each retry once on ordering, then settle), and
`yaac cluster install --byo` ending with every `yaac cluster check` gate
passing on a control node and a manual worker, and an autoscaled pool
scaling up from zero (a pending pod to a running one on the new node in
about three minutes) and back down once the node held nothing (about
sixteen minutes, the autoscaler's default delays). That was before
workers carried the `yaac.workspaces` taint, which has not been applied
there yet.

## Tear down

```sh
# Scale the pools to zero (autoscale_pools = []) and apply, or delete the
# servers the autoscaler made (they carry the cluster=<name> label).
tofu destroy    # stops at the NFS volume while its deletion protection is on
```

Lift the NFS volume's protection in the Hetzner console (or `hcloud volume
disable-protection <name>-nfs delete`) once you no longer need its data,
then destroy again. The volume driver's `pvc-*` volumes, which yaac pins
`Retain`, outlive the cluster; delete them from the project. Finally, remove
the tailnet devices the stack added (the operator, the `yaac` Ingress proxy
and the control node) in the Tailscale admin console, and delete the state
bucket if nothing else uses it.

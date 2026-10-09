# yaac on AWS EKS

OpenTofu that stands up an EKS cluster shaped for `yaac cluster install
--byo` (docs/cluster-setup.md "Bring your own cluster"), plus the machine to
run that install from. Once `tofu apply` finishes and the install host has
bootstrapped, one command on the host installs yaac:

```sh
yaac cluster install --byo --rwx-storage-class yaac-efs
```

## What it creates

| Piece | Why yaac needs it |
|---|---|
| A VPC over two AZs, public subnets only, no NAT gateway | Nodes and the host reach the internet through their own public addresses. Their security groups admit nothing from outside. A NAT gateway would add about $33 a month, plus a fee per GB. |
| EKS with two AL2023 node groups in one AZ: `system` (always one m7i.large) and `workspaces` (0 to `max_workspace_nodes` m7i.xlarge), with 100 GB disks, and the labels and taints that keep workspaces and yaac's infrastructure apart (see "Autoscaling") | AL2023 is a mutable containerd node, which the gVisor installer can write to. Bottlerocket, Fargate and Auto Mode are refused. One AZ, because the EBS volumes behind the server's state and the registries are zonal. |
| The Cluster Autoscaler | Adds workspace nodes as workspaces stop fitting, and removes them once they hold no workspace (see "Autoscaling"). |
| The VPC CNI with its network-policy agent **off**, and policy-only Calico from the Tigera operator | yaac's egress wall is Calico NetworkPolicy plus netd's iptables redirect (docs/workspace-egress.md). |
| VPC CNI prefix delegation, and `maxPods: 110` on every node | Without it an m7i.large takes 29 pods, fewer than the add-ons and yaac's infrastructure need on the system node. |
| The EBS CSI driver and a default `gp3` class | `yaac-server-local`, the registries and the npm cache. |
| An EFS file system, the EFS CSI driver and a `yaac-efs` class | `yaac-global`, the RWX claim every workspace mounts. A file system policy admits only the nodes' roles, over TLS with IAM, through an access point, so a pod that reaches a mount target on 2049 cannot mount the file system's root. |
| The Tailscale Kubernetes operator | The only way onto a byo server is its tailnet Ingress. |
| kubelet `--housekeeping-interval=300s` via nodeadm | The setting a kind install applies itself (docs/cluster-setup.md "What it wires up"). |
| An install host (Ubuntu 26.04, m7i.xlarge), reached through SSM, stoppable between installs | yaac builds its images here with rootful podman and pushes them into the cluster. So it runs in the cluster's VPC, on the nodes' architecture. |

Control-plane logging is off, because CloudWatch bills audit logs by the GB
and yaac talks to the API constantly.

**Idle cost**, with the host stopped and no workspace nodes: about $185 a
month in us-west-2. The control plane is $73 and the system node $74; the
rest is EBS (the node's disk, the stopped host's, and the registry and npm
cache volumes), public IPv4 and EFS storage. Each workspace node adds about
$0.21 an hour while it is up. `architecture = "arm64"` switches every
instance to Graviton, which is about 20% cheaper (about $170 idle).

## Before you apply

On this machine you need OpenTofu 1.10 or newer, the AWS CLI v2 with
credentials for the target account, and the AWS CLI's
[Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html).
tofu's helm and kubernetes providers authenticate through `aws eks
get-token`, so the CLI has to work here.

In the Tailscale admin console:

1. **DNS**: turn on MagicDNS and HTTPS certificates. The server's origin is
   `https://yaac.<tailnet>.ts.net`, with a certificate the operator gets
   for it.
2. **Access controls**: let the operator own its tags.

   ```json
   "tagOwners": {
     "tag:k8s-operator": [],
     "tag:k8s": ["tag:k8s-operator"]
   }
   ```

3. **Settings → OAuth clients**: create a client with write access to
   *Devices Core*, *Auth Keys* and *Services*, tagged `tag:k8s-operator`.
   Its ID and secret go in `terraform.tfvars`.
4. Optionally, **Settings → Keys**: generate a one-off auth key **without**
   tags, and set it as `tailscale_auth_key`. The host then joins the
   tailnet as you. It must be user-owned: the yaac server refuses requests
   from tagged devices (docs/remote-hosting.md), and install checks the
   server's origin from the host. The key is stored as an SSM
   SecureString that only the host's role can read, not in its user data.
   Without a key, you log the host in yourself (below).

## Remote state

tofu keeps its state in an S3 bucket, so any machine with credentials for
the account can update or destroy the cluster, not only the one that
created it. Create the bucket once, before the first `tofu init` (new
buckets block public access and encrypt at rest by default; versioning
keeps every earlier state):

```sh
bucket=yaac-tofu-state-$(aws sts get-caller-identity --query Account --output text)
aws s3api create-bucket --bucket "$bucket" --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2
aws s3api put-bucket-versioning --bucket "$bucket" --versioning-configuration Status=Enabled
```

Then copy `backend.hcl.example` to `backend.hcl` (gitignored) with that
bucket and region. Another machine needs `terraform.tfvars`, `backend.hcl`
and AWS credentials to take over. `terraform.tfvars` holds the Tailscale
secrets; keep it in a password manager, not in git. Your address must also
be in `api_public_access_cidrs`, since tofu's helm and kubernetes providers
call the EKS API from there.

## Bring it up

```sh
cd infra/aws-eks
cp terraform.tfvars.example terraform.tfvars   # fill in the Tailscale values
cp backend.hcl.example backend.hcl             # see "Remote state"
tofu init -backend-config=backend.hcl
tofu apply                                     # about 20 minutes
```

`api_public_access_cidrs` is required: the addresses allowed to reach the
EKS API's public endpoint, which tofu (and your own `kubectl`) use. Give
this machine's `/32`. The install host reaches the API privately.

Kubernetes access on EKS is granted per IAM principal, separately from AWS
permissions. Whoever runs tofu gets it; anyone else who should see or edit
the cluster's workloads, in `kubectl` or the EKS console (which otherwise
says "Unauthorized"), goes in `admin_principal_arns`. The account root is
`arn:aws:iam::<account>:root`.

The host bootstraps while the cluster is being created. Its bootstrap
installs podman, kubectl, the AWS CLI, Tailscale and Node, builds yaac from
`yaac_ref`, and writes a kubeconfig once the cluster exists. Then open a
shell on it:

```sh
$(tofu output -raw install_host_session)
cloud-init status --wait        # the bootstrap; its log is /var/log/yaac-install-host.log
sudo tailscale up --ssh --hostname yaac-install-host   # only without tailscale_auth_key
sudo -iu ubuntu
kubectl get nodes               # the system node, Ready
kubectl get nodes -o jsonpath='{.items[*].status.allocatable.pods}'   # 110
yaac cluster install --byo --rwx-storage-class yaac-efs
```

With no workspace node up, the check skips its gates that run a sandboxed
pod (`gvisor`, `probe`, `egress` and the rest) and says so. To have them
run, start a workspace and re-run `yaac cluster check` while its node is
up.

`~/.yaac-eks.env`, sourced from `.bashrc`, sets the two settings the CNI
gate cannot discover on EKS:

- `YAAC_CNI_VETH_PREFIX=eni`, the VPC CNI's veth names.
- `YAAC_POD_CIDRS` set to the VPC CIDR. Pods take VPC addresses, which no
  Calico IPPool or node `podCIDR` describes.

Install records both on the server Deployment.

Install checks the cluster before changing anything, then builds every
image on the host. The first run takes a while. It ends with `yaac cluster
check`, and **no gate may fail** before you create a workspace. A
failed `egress` gate means workspace egress is not locked down. After that,
use it from your own machine, logged in to the same tailnet:

```sh
yaac remote set https://yaac.<tailnet>.ts.net
```

After Tailscale SSH is on, `ssh ubuntu@yaac-install-host` reaches the
host too.

The host is needed again only to upgrade yaac (re-run install with a newer
`yaac_ref` checked out). In between, stop it: set `install_host_running =
false` and run `tofu apply`. Its disk and bootstrap are kept, so setting it
back to `true` brings the same host up again.

**The host holds the install's identity.** `~/.yaac-client/server.json`
records the random install id stamped on the server Deployment and the
retained volumes. A host without it is refused by install ("already runs
the yaac server of another install"). Tofu never replaces the host on its
own (it ignores later user-data changes), so this only matters if you
replace it yourself (`tofu apply -replace=aws_instance.host`). Copy the
file off the host first and put it back on the new one, before running
install. If it is lost, write it again from the refusal's install id:

```json
{"url": "https://yaac.<tailnet>.ts.net", "enabled": true, "saved": [], "driver": "k8s",
 "installId": "<id from the refusal>", "byo": true,
 "clusterUid": "<kubectl get ns kube-system -o jsonpath={.metadata.uid}>",
 "kubeContext": "arn:aws:eks:<region>:<account>:cluster/<name>"}
```

## Autoscaling

The system node holds the cluster add-ons and yaac's server, registries,
npm cache and proxy. Workspaces run only on `workspaces` nodes
(docs/cluster-setup.md "A dedicated workspace node pool"): the system node
is labelled `yaac.workspaces=false`, so no workspace lands there, and the
workspace nodes carry the `yaac.workspaces=true:NoSchedule` taint, which
only sandboxed pods tolerate, so no rollout can move yaac's infrastructure
onto a node the autoscaler may drain. When a
workspace pod cannot fit, the autoscaler adds a `workspaces` node. From a
pending pod to it running there takes about two and a half minutes, which
is also how long the first workspace waits when no workspace node is up:

1. The node registers with the `yaac.gvisor/pending` taint, so nothing is
   scheduled on it yet. The autoscaler knows it as a startup taint, so it
   counts the node as still starting rather than adding another.
2. The yaac server's node-sync, on its next resync (at most a minute),
   writes the node's registry `hosts.toml` and admits its address in the
   NetworkPolicies, without which the node cannot pull yaac's images.
3. yaac's gVisor installer, which tolerates every taint, installs runsc,
   labels the node `yaac.gvisor=true` and removes the pending taint
   (docs/cluster-setup.md "Bring your own cluster").
4. The workspace lands there and pulls its image from the in-cluster
   registry. The first workspace on a fresh node waits for that pull, since
   the node has no image cache.

Workspace pods are marked `safe-to-evict: false`, so a node is removed only
once it holds no running workspace. With none, it goes within about half an
hour, taking its node-local caches with it. While nodes come and go, `yaac
cluster install` may refuse with "calico-node is n/m ready"; re-run it once
the node count settles.

The workspace group scales from zero, so the autoscaler plans a new node
from tags on its Auto Scaling group rather than from a live node: the
`yaac.gvisor` label and the node's ephemeral storage (autoscaler.tf).

**The system node is small.** After kube-reserved memory it has about
6 GiB allocatable. The add-ons and yaac's infrastructure request a small
part of that, but the yaac server may grow to 6 GiB. If the system node
comes under memory pressure, set `system_instance_type` to an xlarge.

## When install refuses

Every refusal names its cause and fix. The ones most likely here:

- **calico-node is n/m ready**: the Tigera operator is still rolling Calico
  out. Wait for `kubectl -n calico-system rollout status ds/calico-node`,
  then re-run install.
- **The storage binder could not make … belong to uid 1000**: the `yaac-efs`
  class must keep `uid`/`gid` 1000 and `directoryPerms` 2775 (see
  cluster.tf).
- **A gVisor node readiness failure**: read
  `kubectl -n yaac logs ds/yaac-gvisor-install`. It rewrites containerd's
  config on AL2023 and restarts containerd.
- **The origin never answers**: check `kubectl -n tailscale logs
  deploy/operator` and `kubectl -n yaac describe ingress yaac-server`.
  HTTPS certificates must be on for the tailnet.

Install is idempotent, so re-run it after any fix.

## What has been tried, and what has not

This stack has been applied on a fresh AWS account. On it, `yaac cluster
install --byo` installed with every `cluster check` gate green, and the
autoscaler scaled the workspace group from zero to one node and back. Not
yet exercised:

- **Real workspaces.** No agent workspace has run on this cluster yet, only
  the check's probes and a test pod.
- **The workspace pool.** The `yaac.workspaces` label and taint have not
  been applied on EKS yet, so neither has a check run where only the
  workspace node takes sandboxed pods.
- **EFS under load.** `cluster check`'s POSIX-semantics and uid probes
  pass on it, but git and package-install performance over EFS is
  unmeasured. docs/nfs-checkout-performance.md has the numbers for an NFS
  server on the same host, and says which of them a real network changes.
- **Reboots.** AL2023's nodeadm rewrites `/etc/containerd/config.toml` at
  boot. The gVisor installer puts its block back when its pod restarts, and
  until then a rebooted node still carries its `yaac.gvisor` label.
- **`cluster check`'s NFS reachability probe on EFS.** The volume names a
  file system ID rather than a server, so the probe resolves the mount
  target of each zone the nodes are in from a pod in the cluster and checks
  that a workspace pod cannot dial it on 2049. It has not run here yet.
  Under the VPC CNI a pod shares its node's security group, so a pod can
  reach the mount targets: workspace pods are kept off them by
  NetworkPolicy, builder pods are not. What stops either from mounting is
  the file system policy, which refuses any client without the node role's
  IAM credentials.
- **No swap on the nodes.** Unlike the kind setup in the top-level README,
  a workspace under memory pressure is OOM-killed rather than swapped.

## Tear down

yaac pins its volumes `Retain` so that a namespace delete never takes the
data. That means they outlive the cluster, and you remove them yourself:

```sh
name=$(tofu output -raw cluster_name)
fs=$(tofu output -raw efs_file_system_id)

# The cluster's own objects go with the cluster. Dropping them from state
# means destroy never has to uninstall them from a live cluster.
tofu state rm helm_release.calico_crds helm_release.calico helm_release.tailscale_operator \
  helm_release.cluster_autoscaler \
  kubernetes_storage_class_v1.gp3 kubernetes_storage_class_v1.efs

for ap in $(aws efs describe-access-points --file-system-id "$fs" \
    --query 'AccessPoints[].AccessPointId' --output text); do
  aws efs delete-access-point --access-point-id "$ap"
done
tofu destroy

# The EBS volumes yaac retained, tagged by the gp3 class.
for v in $(aws ec2 describe-volumes --filters Name=tag:yaac-cluster,Values="$name" \
    --query 'Volumes[].VolumeId' --output text); do
  aws ec2 delete-volume --volume-id "$v"
done
```

Finally, remove the tailnet devices the stack added (the operator, the
`yaac` Ingress proxy and the install host) in the Tailscale admin console.

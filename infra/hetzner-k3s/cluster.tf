# What `yaac cluster install --byo` expects to find already in the cluster
# (docs/cluster-setup.md "Bring your own cluster"), as manifests k3s
# applies from the control node's manifests directory: Calico enforcing
# NetworkPolicy, the Hetzner cloud controller and volume driver, an
# NFS-family RWX class, the Tailscale operator and the cluster autoscaler.
# Charts are k3s HelmChart objects, so tofu needs no access to the
# Kubernetes API. `bootstrap` charts run before the node is Ready, on the
# host network.

locals {
  # k3s's default pod range, which Calico's pool reuses so the CNI gate
  # discovers one consistent set.
  pod_cidr = "10.42.0.0/16"

  charts = merge(
    {
      # Calico's version matches CALICO_VERSION, the Calico a kind install
      # applies. The crd.projectcalico.org CRD flavor is the API yaac's CNI
      # gate reads.
      calico-crds = {
        chart     = "https://github.com/projectcalico/calico/releases/download/v3.32.1/crd.projectcalico.org.v1-v3.32.1.tgz"
        namespace = "kube-system"
        bootstrap = true
        values    = {}
      }
      # VXLAN, because Hetzner's network routes only the addresses it
      # assigned; 1400 is its 1450 MTU less VXLAN's overhead. Pods leaving
      # the pool are SNATed to their node's address. The iptables dataplane
      # is the one netd's redirect works with (docs/workspace-egress.md).
      calico = {
        chart     = "https://github.com/projectcalico/calico/releases/download/v3.32.1/tigera-operator-v3.32.1.tgz"
        namespace = "tigera-operator"
        bootstrap = true
        values = {
          installation = {
            calicoNetwork = {
              bgp                        = "Disabled"
              mtu                        = 1400
              linuxDataplane             = "Iptables"
              nodeAddressAutodetectionV4 = { cidrs = [local.node_subnet] }
              ipPools = [{
                cidr          = local.pod_cidr
                encapsulation = "VXLAN"
                natOutgoing   = "Enabled"
                blockSize     = 26
              }]
            }
          }
          goldmane = { enabled = false }
          whisker  = { enabled = false }
        }
      }
      # Sets each node's addresses and provider ID (which the autoscaler
      # matches servers by), and deletes the Node of a deleted server.
      # Hetzner network routes are off: Calico's VXLAN carries pod traffic.
      # `networking` also puts it on the host network, so it can start
      # before cluster DNS.
      hcloud-ccm = {
        chart     = "https://github.com/hetznercloud/hcloud-cloud-controller-manager/releases/download/v1.37.0/hcloud-cloud-controller-manager-1.37.0.tgz"
        namespace = "kube-system"
        bootstrap = true
        values = {
          networking = { enabled = true, clusterCIDR = local.pod_cidr }
          env        = { HCLOUD_NETWORK_ROUTES_ENABLED = { value = "false" } }
        }
      }
      # The default class, hcloud-volumes: yaac-server-local, the
      # registries and the npm cache.
      hcloud-csi = {
        chart     = "https://github.com/hetznercloud/csi-driver/releases/download/v2.23.0/hcloud-csi-2.23.0.tgz"
        namespace = "kube-system"
        bootstrap = false
        values    = { controller = { hcloudVolumeDefaultLocation = var.location } }
      }
      csi-driver-nfs = {
        chart     = "https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/master/charts/v4.13.4/csi-driver-nfs-4.13.4.tgz"
        namespace = "kube-system"
        bootstrap = false
        values    = {}
      }
      tailscale-operator = {
        repo      = "https://pkgs.tailscale.com/helmcharts"
        chart     = "tailscale-operator"
        version   = "1.102.4"
        namespace = "tailscale"
        bootstrap = false
        values = {
          operatorConfig = { hostname = "${var.name}-operator" }
          oauth = {
            clientId     = var.tailscale_oauth_client_id
            clientSecret = var.tailscale_oauth_client_secret
          }
        }
      }
    },
    { for name, c in {
      cluster-autoscaler = {
        chart     = "https://github.com/kubernetes/autoscaler/releases/download/cluster-autoscaler-chart-9.59.0/cluster-autoscaler-9.59.0.tgz"
        namespace = "kube-system"
        bootstrap = false
        values = {
          cloudProvider = "hetzner"
          autoscalingGroups = [for p in var.autoscale_pools : {
            name         = p.name
            minSize      = p.min
            maxSize      = p.max
            instanceType = p.server_type
            region       = var.location
          }]
          image         = { tag = var.autoscaler_version }
          envFromSecret = "hcloud-autoscaler"
          # The Secret is read at start, so a new worker config rolls the pod.
          podAnnotations = { "yaac/cluster-config" = sha256(jsonencode(local.autoscaler_cluster_config)) }
          # On a worker it could keep that worker from scaling down.
          nodeSelector = { pool = "system" }
          extraArgs = {
            # A new node counts as still starting until the gVisor installer
            # lifts the taint, instead of as a node the pending pod cannot use.
            startup-taint = local.gvisor_pending_taint
            # Workspace pods opt out of eviction themselves, so everything
            # else may be moved off a node the autoscaler wants to remove.
            skip-nodes-with-system-pods   = false
            skip-nodes-with-local-storage = false
            expander                      = "least-waste"
          }
        }
      }
    } : name => c if length(var.autoscale_pools) > 0 },
  )

  # How the autoscaler creates a worker. Pools scale from zero, so it plans
  # a new node from these labels and taints rather than from a live one:
  # yaac.gvisor is the label the workspace RuntimeClasses select, which the
  # gVisor installer adds only after boot.
  autoscaler_cluster_config = {
    imagesForArch        = { amd64 = var.image, arm64 = var.image }
    defaultSubnetIPRange = local.node_subnet
    nodeConfigs = { for p in var.autoscale_pools : p.name => {
      cloudInit    = local.worker_user_data
      labels       = { "yaac.gvisor" = "true" }
      serverLabels = { cluster = var.name, role = "worker" }
      taints = [
        { key = "yaac.workspaces", value = "true", effect = "NoSchedule" },
        { key = local.gvisor_pending_taint, value = "true", effect = "NoSchedule" },
      ]
    } }
  }

  manifest_objects = concat(
    [
      {
        apiVersion = "v1"
        kind       = "Secret"
        metadata   = { name = "hcloud", namespace = "kube-system" }
        stringData = { token = var.hcloud_token, network = hcloud_network.main.name }
      },
      # The shared claim's class, over the control node's export
      # (node.sh.tftpl). Written as plainly as kind-byo's: install makes
      # the volumes Retain and mounts them with actimeo=1 itself.
      {
        apiVersion        = "storage.k8s.io/v1"
        kind              = "StorageClass"
        metadata          = { name = local.rwx_storage_class }
        provisioner       = "nfs.csi.k8s.io"
        parameters        = { server = local.control_ip, share = local.nfs_export, subDir = "$${pvc.metadata.namespace}/$${pvc.metadata.name}" }
        reclaimPolicy     = "Delete"
        volumeBindingMode = "Immediate"
        mountOptions      = ["nfsvers=4.2", "hard"]
      },
    ],
    [for name, c in local.charts : {
      apiVersion = "helm.cattle.io/v1"
      kind       = "HelmChart"
      metadata   = { name = name, namespace = "kube-system" }
      spec = merge(
        {
          chart           = c.chart
          targetNamespace = c.namespace
          createNamespace = true
          bootstrap       = c.bootstrap
          valuesContent   = yamlencode(c.values)
        },
        can(c.repo) ? { repo = c.repo, version = c.version } : {},
      )
    }],
    [for _ in range(length(var.autoscale_pools) > 0 ? 1 : 0) : {
      apiVersion = "v1"
      kind       = "Secret"
      metadata   = { name = "hcloud-autoscaler", namespace = "kube-system" }
      stringData = {
        HCLOUD_TOKEN          = var.hcloud_token
        HCLOUD_CLUSTER_CONFIG = base64encode(jsonencode(local.autoscaler_cluster_config))
        HCLOUD_NETWORK        = hcloud_network.main.name
        HCLOUD_FIREWALL       = hcloud_firewall.nodes.name
        HCLOUD_SSH_KEY        = hcloud_ssh_key.admin.name
      }
    }],
  )

  manifests = join("---\n", [for m in local.manifest_objects : yamlencode(m)])
}

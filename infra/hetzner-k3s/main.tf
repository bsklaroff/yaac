# The Hetzner side of a yaac `--byo` target: a private network, a firewall,
# a k3s control node that also serves the shared claim over NFS and is
# where `yaac cluster install --byo` runs, and any manually managed
# workers. The in-cluster prerequisites and the autoscaler are in
# cluster.tf; README.md says how they fit together.

provider "hcloud" {
  token = var.hcloud_token
}

locals {
  network_cidr = "10.0.0.0/16"
  node_subnet  = "10.0.1.0/24"
  # The subnet's first three octets, which node.sh.tftpl matches addresses on.
  subnet_prefix = join(".", slice(split(".", local.node_subnet), 0, 3))
  # A fixed address, which workers join and the NFS class mounts. Hetzner's
  # gateway is the network's first address (10.0.0.1), outside the subnet.
  control_ip = cidrhost(local.node_subnet, 2)

  network_zone = {
    fsn1 = "eu-central", nbg1 = "eu-central", hel1 = "eu-central",
    ash  = "us-east", hil = "us-west", sin = "ap-southeast",
  }[var.location]

  # yaac builds its images on the control node for its own architecture,
  # so every node must share it. Hetzner's cax types are Ampere (arm64).
  server_types = distinct(concat(
    [var.control_server_type], values(var.manual_workers), [for p in var.autoscale_pools : p.server_type],
  ))
  architectures = distinct([for t in local.server_types : startswith(t, "cax") ? "arm64" : "amd64"])

  nfs_export        = "/srv/yaac-nfs"
  rwx_storage_class = "yaac-nfs"

  # A new worker takes no pod until yaac's gVisor installer has put the
  # runtime on it and removed this taint (docs/cluster-setup.md "Bring your
  # own cluster"). The autoscaler treats it as a startup taint.
  gvisor_pending_taint = "yaac.gvisor/pending"

  # Every node runs k3s against the host's containerd (node.sh.tftpl), with
  # the cloud controller (cluster.tf) owning node addresses and provider
  # IDs. At the default 10s housekeeping interval, cAdvisor walks every fd
  # of every gVisor sandbox on each tick (docs/cluster-setup.md "What it
  # wires up"). netd's rules sit beside kube-proxy's iptables chains.
  k3s_node_config = {
    container-runtime-endpoint = "unix:///run/containerd/containerd.sock"
    kubelet-arg                = ["cloud-provider=external", "cgroup-driver=systemd", "housekeeping-interval=300s"]
    kube-proxy-arg             = ["proxy-mode=iptables"]
  }

  # Flannel and k3s's own policy controller are off because Calico is the
  # CNI (cluster.tf). servicelb and traefik would publish ports nothing
  # here needs, and the default class is Hetzner volumes, not local-path.
  # system-reserved holds back room for what runs on this node outside any
  # pod (the k3s server and its datastore, the NFS server, containerd), so
  # workspaces cannot schedule into it and the kubelet evicts them before
  # those processes run short of memory.
  k3s_server_config = merge(local.k3s_node_config, {
    kubelet-arg              = concat(local.k3s_node_config.kubelet-arg, ["system-reserved=${var.control_system_reserved}"])
    node-ip                  = local.control_ip
    advertise-address        = local.control_ip
    node-label               = ["pool=system"]
    tls-san                  = [local.control_ip, "${var.name}-control"]
    token                    = random_password.server_token.result
    agent-token              = random_password.agent_token.result
    flannel-backend          = "none"
    disable-network-policy   = true
    disable-cloud-controller = true
    disable                  = ["traefik", "servicelb", "local-storage"]
    write-kubeconfig-mode    = "0600"
  })

  k3s_install_url = "https://raw.githubusercontent.com/k3s-io/k3s/${urlencode(var.k3s_version)}/install.sh"

  # User data for every worker, manual or autoscaled. It carries the agent
  # token, which only lets a machine join as a worker. Pods cannot read it
  # from the metadata service: yaac's builder and proxy egress excludes its
  # address. Workspaces reach the internet only through the proxy, which
  # dials whatever their allowlist admits (`*` admits the metadata
  # address), so the proxy's egress policy is what keeps them off it.
  worker_user_data = templatefile("${path.module}/node.sh.tftpl", {
    role            = "agent"
    subnet_prefix   = local.subnet_prefix
    k3s_version     = var.k3s_version
    k3s_install_url = local.k3s_install_url
    k3s_config = yamlencode(merge(local.k3s_node_config, {
      server     = "https://${local.control_ip}:6443"
      token      = random_password.agent_token.result
      node-taint = ["${local.gvisor_pending_taint}=true:NoSchedule"]
    }))
    nfs_device = ""
    nfs_export = ""
    yaac_repo  = ""
    yaac_ref   = ""
  })
}

resource "random_password" "server_token" {
  length  = 48
  special = false
}

resource "random_password" "agent_token" {
  length  = 48
  special = false
}

# Node-to-node traffic, Calico's VXLAN included, stays on this network.
resource "hcloud_network" "main" {
  name     = var.name
  ip_range = local.network_cidr
}

resource "hcloud_network_subnet" "nodes" {
  network_id   = hcloud_network.main.id
  type         = "cloud"
  network_zone = local.network_zone
  ip_range     = local.node_subnet
}

resource "hcloud_ssh_key" "admin" {
  name       = var.name
  public_key = var.ssh_public_key
}

# Applies to public interfaces only; the private network is unfiltered.
# Nodes reach the internet through their own public addresses, and nothing
# but ssh from ssh_source_cidrs gets in. The Kubernetes API and the yaac
# server are reached over the tailnet.
resource "hcloud_firewall" "nodes" {
  name = var.name

  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_source_cidrs
  }
}

resource "hcloud_server" "control" {
  name         = "${var.name}-control"
  server_type  = var.control_server_type
  image        = var.image
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.nodes.id]
  labels       = { cluster = var.name, role = "control" }

  network {
    network_id = hcloud_network.main.id
    ip         = local.control_ip
  }

  user_data = templatefile("${path.module}/node.sh.tftpl", {
    role            = "server"
    subnet_prefix   = local.subnet_prefix
    k3s_version     = ""
    k3s_install_url = ""
    k3s_config      = ""
    nfs_device      = hcloud_volume.nfs.linux_device
    nfs_export      = local.nfs_export
    yaac_repo       = var.yaac_repo
    yaac_ref        = var.yaac_ref
  })

  # The control node holds the cluster's datastore and the install's
  # identity (~yaac/.yaac-client/server.json), so a later change to its
  # user data or image must not quietly replace it. Replace it deliberately
  # (README.md "The control node is not disposable").
  lifecycle {
    ignore_changes = [image, user_data, ssh_keys]

    precondition {
      condition     = length(local.architectures) == 1
      error_message = "Every node must share one architecture (cax* types are arm64, the rest amd64): ${join(", ", local.server_types)}."
    }
  }

  depends_on = [hcloud_network_subnet.nodes]
}

# The NFS export behind the shared claim. Deletion protection, because it
# holds every project's checkouts and the server's database; README.md
# "Tear down" says how to lift it.
resource "hcloud_volume" "nfs" {
  name              = "${var.name}-nfs"
  size              = var.nfs_volume_gb
  location          = var.location
  format            = "ext4"
  delete_protection = true
}

resource "hcloud_volume_attachment" "nfs" {
  volume_id = hcloud_volume.nfs.id
  server_id = hcloud_server.control.id
}

resource "terraform_data" "control" {
  triggers_replace = sha256(local.control_script)

  connection {
    type  = "ssh"
    host  = hcloud_server.control.ipv4_address
    user  = "root"
    agent = true
  }

  provisioner "file" {
    content     = local.control_script
    destination = "/root/yaac-control.sh"
  }

  provisioner "remote-exec" {
    inline = ["bash /root/yaac-control.sh", "rm -f /root/yaac-control.sh"]
  }

  depends_on = [hcloud_volume_attachment.nfs]
}

locals {
  control_script = templatefile("${path.module}/control.sh.tftpl", {
    k3s_version        = var.k3s_version
    k3s_install_url    = local.k3s_install_url
    k3s_config         = yamlencode(local.k3s_server_config)
    manifests          = local.manifests
    tailscale_auth_key = var.tailscale_auth_key
    host_name          = "${var.name}-control"
  })
}

resource "hcloud_server" "worker" {
  for_each = var.manual_workers

  name         = "${var.name}-${each.key}"
  server_type  = each.value
  image        = var.image
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.nodes.id]
  labels       = { cluster = var.name, role = "worker" }
  user_data    = local.worker_user_data

  network {
    network_id = hcloud_network.main.id
  }

  # A running worker keeps the k3s it joined with; replace it to move it to
  # a new k3s_version (README.md "Upgrading"). Its network is ignored too:
  # with no `ip` in the block, the provider would otherwise plan to detach
  # and reattach the private network on every apply.
  lifecycle {
    ignore_changes = [image, user_data, ssh_keys, network]
  }

  depends_on = [hcloud_network_subnet.nodes, terraform_data.control]
}

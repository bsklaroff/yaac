# The AWS side of a yaac `--byo` target: a VPC, an EKS cluster with a
# fixed system node and an autoscaled workspace node group, the EFS file
# system behind the shared claim, and the IAM the storage drivers and the
# autoscaler need. The in-cluster prerequisites are in cluster.tf and the
# install host is in install-host.tf; README.md says how they fit together.

provider "aws" {
  region = var.region
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  vpc_cidr = "10.0.0.0/16"
  azs      = slice(data.aws_availability_zones.available.names, 0, 2)
  arm      = var.architecture == "arm64"

  system_instance_type = coalesce(var.system_instance_type, local.arm ? "m7g.large" : "m7i.large")
  node_instance_type   = coalesce(var.node_instance_type, local.arm ? "m7g.xlarge" : "m7i.xlarge")
  host_instance_type   = coalesce(var.host_instance_type, local.arm ? "m7g.xlarge" : "m7i.xlarge")

  # The StorageClass `yaac cluster install --byo --rwx-storage-class` names.
  rwx_storage_class = "yaac-efs"

  # Each storage driver's controller gets its AWS permissions through EKS
  # Pod Identity, so only that controller holds them, not every node.
  csi_policies = {
    ebs = "AmazonEBSCSIDriverPolicy"
    efs = "AmazonEFSCSIDriverPolicy"
  }

  # Both node groups share their image, disk and kubelet settings. At the
  # default 10s housekeeping interval, cAdvisor walks every fd of every
  # gVisor sandbox on each tick (docs/cluster-setup.md "What it wires up").
  # maxPods is the prefix-delegation ceiling (see the vpc-cni addon), which
  # is what lets a 2-vCPU system node hold every add-on pod. The nodes sit in
  # one AZ, since the EBS volumes yaac's server and registries use are zonal.
  node_group_defaults = {
    ami_type   = local.arm ? "AL2023_ARM_64_STANDARD" : "AL2023_x86_64_STANDARD"
    subnet_ids = [module.vpc.public_subnets[0]]
    # Pods sit one hop off the node, so hop limit 1 keeps workspace and
    # builder pods from the node role's credentials over IMDS. Stated here
    # so a module default cannot relax it.
    metadata_options = {
      http_endpoint               = "enabled"
      http_tokens                 = "required"
      http_put_response_hop_limit = 1
    }
    block_device_mappings = {
      root = {
        device_name = "/dev/xvda"
        ebs = {
          volume_size           = var.node_disk_gb
          volume_type           = "gp3"
          encrypted             = true
          delete_on_termination = true
        }
      }
    }
    cloudinit_pre_nodeadm = [{
      content_type = "application/node.eks.aws"
      content      = <<-EOT
        ---
        apiVersion: node.eks.aws/v1alpha1
        kind: NodeConfig
        spec:
          kubelet:
            config:
              maxPods: 110
            flags:
              - --housekeeping-interval=300s
      EOT
    }]
  }

  # A new workspace node takes no pod until yaac's gVisor installer has put
  # the runtime on it and removed this taint (docs/cluster-setup.md
  # "Bring your own cluster"). The autoscaler treats it as a startup taint.
  gvisor_pending_taint = "yaac.gvisor/pending"
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "6.7.3"

  name = var.name
  cidr = local.vpc_cidr
  azs  = local.azs

  # Public subnets only: a NAT gateway would add about $33 a month plus a
  # per-GB fee. Nodes and the host get public addresses for outbound
  # traffic, and their security groups admit nothing from the internet. The /19s are
  # sized for the VPC CNI, which hands each pod a subnet address.
  public_subnets          = [for i, _ in local.azs : cidrsubnet(local.vpc_cidr, 3, i)]
  map_public_ip_on_launch = true
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "21.26.0"

  name               = var.name
  kubernetes_version = var.kubernetes_version
  vpc_id             = module.vpc.vpc_id
  subnet_ids         = module.vpc.public_subnets

  # Control-plane logging is off: yaac drives the API hard (exec, watches,
  # polling), and CloudWatch bills audit logs by the GB even when idle.
  enabled_log_types           = []
  create_cloudwatch_log_group = false

  endpoint_public_access       = true
  endpoint_public_access_cidrs = var.api_public_access_cidrs
  endpoint_private_access      = true

  # Every AWS-calling pod gets its role through Pod Identity, so no OIDC
  # provider for IRSA.
  enable_irsa = false

  # Cluster admins: whoever runs tofu, the install host, and the principals
  # admin_principal_arns names, so the EKS console can show and edit the
  # cluster's Kubernetes objects for them.
  enable_cluster_creator_admin_permissions = true
  access_entries = {
    for name, arn in merge(
      { install_host = aws_iam_role.host.arn },
      { for arn in var.admin_principal_arns : arn => arn },
      ) : name => {
      principal_arn = arn
      policy_associations = {
        admin = {
          policy_arn   = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
          access_scope = { type = "cluster" }
        }
      }
    }
  }

  # yaac's egress wall is Calico policy (cluster.tf), so the VPC CNI's own
  # policy agent stays off: it enforces in eBPF ahead of netfilter
  # (docs/workspace-egress.md). Prefix delegation hands each ENI slot a /28
  # rather than one address. Without it an m7i.large holds 29 pods, fewer
  # than the add-ons and yaac's infrastructure need.
  addons = {
    vpc-cni = {
      before_compute = true
      configuration_values = jsonencode({
        enableNetworkPolicy = "false"
        env = {
          ENABLE_PREFIX_DELEGATION = "true"
          WARM_PREFIX_TARGET       = "1"
        }
      })
    }
    eks-pod-identity-agent = {
      before_compute = true
    }
    kube-proxy = {}
    coredns    = {}
    aws-ebs-csi-driver = {
      pod_identity_association = [{
        role_arn        = aws_iam_role.csi["ebs"].arn
        service_account = "ebs-csi-controller-sa"
      }]
    }
    aws-efs-csi-driver = {
      pod_identity_association = [{
        role_arn        = aws_iam_role.csi["efs"].arn
        service_account = "efs-csi-controller-sa"
      }]
    }
  }

  security_group_additional_rules = {
    install_host = {
      description              = "Install host to the private API endpoint"
      from_port                = 443
      to_port                  = 443
      source_security_group_id = aws_security_group.host.id
    }
  }

  # Under the VPC CNI a pod carries its node's security group, so these
  # open pod-to-pod and control-plane-to-pod traffic on every port. What a
  # yaac pod may reach is decided by NetworkPolicy, not here.
  node_security_group_additional_rules = {
    self_all = {
      description = "Node and pod to node and pod, all ports"
      protocol    = "-1"
      from_port   = 0
      to_port     = 0
      self        = true
    }
    cluster_all = {
      description                   = "Control plane to node and pod, all ports (webhooks, the Calico API server)"
      protocol                      = "-1"
      from_port                     = 0
      to_port                       = 0
      source_cluster_security_group = true
    }
  }

  eks_managed_node_groups = {
    # Always on: the add-ons, yaac's server, registries, npm cache and proxy.
    # The yaac.workspaces=false label keeps workspaces off it
    # (docs/cluster-setup.md "A dedicated workspace node pool").
    system = merge(local.node_group_defaults, {
      instance_types = [local.system_instance_type]
      labels         = { pool = "system", "yaac.workspaces" = "false" }
      min_size       = 1
      max_size       = 1
      desired_size   = 1
    })

    # Holds every workspace. Grows as workspaces stop fitting on the nodes
    # there are, and shrinks back to zero. A node running a workspace is
    # never scaled down, since yaac marks workspace pods safe-to-evict=false.
    # Only sandboxed pods tolerate the yaac.workspaces taint, so yaac's
    # server and registries stay on the system node.
    workspaces = merge(local.node_group_defaults, {
      instance_types = [local.node_instance_type]
      min_size       = 0
      max_size       = var.max_workspace_nodes
      desired_size   = 0
      taints = {
        workspace_pool = {
          key    = "yaac.workspaces"
          value  = "true"
          effect = "NO_SCHEDULE"
        }
        gvisor_pending = {
          key    = local.gvisor_pending_taint
          value  = "true"
          effect = "NO_SCHEDULE"
        }
      }
    })
  }
}
data "aws_iam_policy_document" "pod_identity_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "csi" {
  for_each = local.csi_policies

  name               = "${var.name}-${each.key}-csi"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_trust.json
}

resource "aws_iam_role_policy_attachment" "csi" {
  for_each = local.csi_policies

  role       = aws_iam_role.csi[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/${each.value}"
}

# The file system behind `yaac-global`, the RWX claim every workspace pod
# mounts. Elastic throughput, since yaac's load is bursty git and package
# I/O rather than a steady stream.
resource "aws_efs_file_system" "global" {
  creation_token  = "${var.name}-global"
  encrypted       = true
  throughput_mode = "elastic"

  tags = {
    Name = "${var.name}-global"
  }
}

resource "aws_security_group" "efs" {
  name_prefix = "${var.name}-efs-"
  description = "NFS from the EKS nodes to the yaac EFS file system"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}

data "aws_caller_identity" "current" {}

# Only the nodes may mount, only through an access point, and only over
# TLS with IAM. With a file system policy, a client without IAM counts as
# anonymous and is refused, so a pod that reaches a mount target on 2049
# (every pod carries the node's security group) cannot mount the root and
# walk every project's tree. The CSI node plugin mounts with the node role,
# which pods cannot reach (hop limit 1 above).
resource "aws_efs_file_system_policy" "global" {
  file_system_id = aws_efs_file_system.global.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "NodesThroughAccessPoints"
      Effect    = "Allow"
      Principal = { AWS = [for g in module.eks.eks_managed_node_groups : g.iam_role_arn] }
      Action    = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      Resource  = aws_efs_file_system.global.arn
      Condition = {
        Bool = {
          "aws:SecureTransport"                      = "true"
          "elasticfilesystem:AccessedViaMountTarget" = "true"
        }
        ArnLike = {
          "elasticfilesystem:AccessPointArn" = "arn:aws:elasticfilesystem:${var.region}:${data.aws_caller_identity.current.account_id}:access-point/*"
        }
      }
    }]
  })
}

resource "aws_efs_mount_target" "global" {
  count = length(local.azs)

  file_system_id  = aws_efs_file_system.global.id
  subnet_id       = module.vpc.public_subnets[count.index]
  security_groups = [aws_security_group.efs.id]
}

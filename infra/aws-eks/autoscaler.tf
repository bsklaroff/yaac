# The Cluster Autoscaler, which grows the workspaces node group when a
# workspace pod cannot be scheduled and removes nodes that have no
# workspace left. Its image's minor version must match the cluster's
# (chart 9.59.0 ships v1.35).

# The workspace group starts at zero, so the autoscaler plans its first
# node from these tags rather than from a live node. yaac.gvisor is the
# label the workspace RuntimeClasses select, which the gVisor installer
# adds only after boot.
resource "aws_autoscaling_group_tag" "workspace_template" {
  for_each = {
    "k8s.io/cluster-autoscaler/node-template/label/yaac.gvisor"           = "true"
    "k8s.io/cluster-autoscaler/node-template/resources/ephemeral-storage" = "${var.node_disk_gb}G"
  }

  autoscaling_group_name = module.eks.eks_managed_node_groups["workspaces"].node_group_autoscaling_group_names[0]

  tag {
    key                 = each.key
    value               = each.value
    propagate_at_launch = false
  }
}

resource "aws_iam_role" "autoscaler" {
  name               = "${var.name}-cluster-autoscaler"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_trust.json
}

# Reads anywhere; scales only the groups EKS tags as this cluster's.
resource "aws_iam_role_policy" "autoscaler" {
  name = "cluster-autoscaler"
  role = aws_iam_role.autoscaler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "autoscaling:DescribeAutoScalingGroups",
          "autoscaling:DescribeAutoScalingInstances",
          "autoscaling:DescribeLaunchConfigurations",
          "autoscaling:DescribeScalingActivities",
          "autoscaling:DescribeTags",
          "ec2:DescribeImages",
          "ec2:DescribeInstanceTypes",
          "ec2:DescribeLaunchTemplateVersions",
          "ec2:GetInstanceTypesFromInstanceRequirements",
          "eks:DescribeNodegroup",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "autoscaling:SetDesiredCapacity",
          "autoscaling:TerminateInstanceInAutoScalingGroup",
        ]
        Resource = "*"
        Condition = {
          StringEquals = { "aws:ResourceTag/k8s.io/cluster-autoscaler/${var.name}" = "owned" }
        }
      },
    ]
  })
}

resource "aws_eks_pod_identity_association" "autoscaler" {
  cluster_name    = module.eks.cluster_name
  namespace       = "kube-system"
  service_account = "cluster-autoscaler"
  role_arn        = aws_iam_role.autoscaler.arn
}

resource "helm_release" "cluster_autoscaler" {
  name = "cluster-autoscaler"
  # The release asset the chart repo's index points at, fetched directly.
  chart     = "https://github.com/kubernetes/autoscaler/releases/download/cluster-autoscaler-chart-9.59.0/cluster-autoscaler-9.59.0.tgz"
  namespace = "kube-system"

  values = [yamlencode({
    autoDiscovery = { clusterName = module.eks.cluster_name }
    awsRegion     = var.region
    rbac          = { serviceAccount = { name = "cluster-autoscaler" } }
    # On a workspace node it could keep that node from scaling down.
    nodeSelector = { pool = "system" }
    extraArgs = {
      # A new node counts as still starting until the gVisor installer lifts
      # the taint, instead of as a node the pending pod cannot use.
      startup-taint = local.gvisor_pending_taint
      # Workspace pods opt out of eviction themselves, so everything else
      # (CoreDNS, the CSI controllers, yaac's infrastructure) may be moved
      # off a node the autoscaler wants to remove.
      skip-nodes-with-system-pods   = false
      skip-nodes-with-local-storage = false
      expander                      = "least-waste"
    }
  })]

  depends_on = [aws_eks_pod_identity_association.autoscaler, aws_autoscaling_group_tag.workspace_template]
}

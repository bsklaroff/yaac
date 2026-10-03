# What `yaac cluster install --byo` expects to find already in the cluster
# (docs/cluster-setup.md "Bring your own cluster"): Calico enforcing
# NetworkPolicy, the Tailscale operator, an NFS-family RWX class and a
# default block class.

locals {
  kube_exec = {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.region]
  }
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  exec {
    api_version = local.kube_exec.api_version
    command     = local.kube_exec.command
    args        = local.kube_exec.args
  }
}

provider "helm" {
  kubernetes = {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    exec                   = local.kube_exec
  }
}

# Policy-only Calico over the VPC CNI, from the Tigera operator (which runs
# calico-node in calico-system). Its version matches CALICO_VERSION, the
# Calico a kind install applies. The operator chart carries no CRDs: they
# are a chart of their own, the crd.projectcalico.org flavor here because
# that is the API yaac's CNI gate reads. Both charts come from Calico's
# GitHub release, the same files its Helm repository serves.
resource "helm_release" "calico_crds" {
  name  = "calico-crds"
  chart = "https://github.com/projectcalico/calico/releases/download/v3.32.1/crd.projectcalico.org.v1-v3.32.1.tgz"

  depends_on = [module.eks]
}

resource "helm_release" "calico" {
  name             = "calico"
  chart            = "https://github.com/projectcalico/calico/releases/download/v3.32.1/tigera-operator-v3.32.1.tgz"
  namespace        = "tigera-operator"
  create_namespace = true

  values = [yamlencode({
    installation = {
      kubernetesProvider = "EKS"
      cni                = { type = "AmazonVPC" }
    }
  })]

  depends_on = [helm_release.calico_crds]
}

resource "helm_release" "tailscale_operator" {
  name             = "tailscale-operator"
  repository       = "https://pkgs.tailscale.com/helmcharts"
  chart            = "tailscale-operator"
  version          = "1.102.4"
  namespace        = "tailscale"
  create_namespace = true

  values = [yamlencode({
    operatorConfig = { hostname = "${var.name}-operator" }
  })]
  set_sensitive = [
    { name = "oauth.clientId", value = var.tailscale_oauth_client_id },
    { name = "oauth.clientSecret", value = var.tailscale_oauth_client_secret },
  ]

  depends_on = [module.eks]
}

# The default class: yaac-server-local, the registries and the npm cache
# provision through it. The tag lets teardown find the volumes yaac pins
# `Retain`, which outlive the cluster.
resource "kubernetes_storage_class_v1" "gp3" {
  metadata {
    name        = "gp3"
    annotations = { "storageclass.kubernetes.io/is-default-class" = "true" }
  }
  storage_provisioner    = "ebs.csi.aws.com"
  volume_binding_mode    = "WaitForFirstConsumer"
  allow_volume_expansion = true
  parameters = {
    type               = "gp3"
    encrypted          = "true"
    tagSpecification_1 = "yaac-cluster=${var.name}"
  }

  depends_on = [module.eks]
}

# The RWX class for yaac-global. EFS provisions an access point per volume,
# and an access point runs every file operation as its own uid and gid. So
# both are 1000, the uid a byo install runs as, and the root is created
# with the mode install's binder pod would otherwise chmod it to: that pod
# runs as root, which the access point also maps to 1000, so it could not
# chown the root itself.
resource "kubernetes_storage_class_v1" "efs" {
  metadata {
    name = local.rwx_storage_class
  }
  storage_provisioner = "efs.csi.aws.com"
  # The file system policy (main.tf) admits only TLS mounts with IAM.
  mount_options = ["tls", "iam"]
  parameters = {
    provisioningMode = "efs-ap"
    fileSystemId     = aws_efs_file_system.global.id
    basePath         = "/yaac"
    directoryPerms   = "2775"
    uid              = "1000"
    gid              = "1000"
  }

  depends_on = [module.eks, aws_efs_mount_target.global, aws_efs_file_system_policy.global]
}

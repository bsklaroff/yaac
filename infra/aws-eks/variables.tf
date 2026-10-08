variable "region" {
  description = "AWS region for everything this stack creates."
  type        = string
  default     = "us-west-2"
}

variable "name" {
  description = "Name of the EKS cluster, and prefix of every other resource."
  type        = string
  default     = "yaac"
}

variable "kubernetes_version" {
  description = "EKS Kubernetes version. Use one `aws eks describe-cluster-versions` lists in standard support, and keep the autoscaler chart (autoscaler.tf) on the same minor."
  type        = string
  default     = "1.35"
}

variable "architecture" {
  description = "amd64 or arm64. The nodes and the install host share it, because yaac builds its images on the host for the host's own architecture."
  type        = string
  default     = "amd64"

  validation {
    condition     = contains(["amd64", "arm64"], var.architecture)
    error_message = "architecture must be amd64 or arm64."
  }
}

variable "system_instance_type" {
  description = "Instance type of the always-on system node. Defaults to m7i.large (amd64) or m7g.large (arm64): 2 vCPUs and 8 GiB, for the add-ons and yaac's infrastructure."
  type        = string
  default     = null
}

variable "node_instance_type" {
  description = "Instance type of the autoscaled workspace nodes. Defaults to m7i.xlarge (amd64) or m7g.xlarge (arm64): 4 vCPUs and 16 GiB, about a dozen workspaces by their requests."
  type        = string
  default     = null
}

variable "max_workspace_nodes" {
  description = "Most nodes the autoscaler may add beyond the always-on system node."
  type        = number
  default     = 4
}

variable "node_disk_gb" {
  description = "Root disk per node: images, workspace scratch and the node-local caches."
  type        = number
  default     = 100
}

variable "host_instance_type" {
  description = "Install host instance type. Defaults to m7i.xlarge (amd64) or m7g.xlarge (arm64)."
  type        = string
  default     = null
}

variable "install_host_running" {
  description = "Whether the install host runs. It is only needed to install or upgrade yaac, so set this false in between; its disk is kept."
  type        = bool
  default     = true
}

variable "admin_principal_arns" {
  description = "IAM users or roles (or arn:aws:iam::<account>:root) given cluster-admin Kubernetes access, for example so the EKS console can show the cluster's workloads. Whoever runs tofu is an admin already."
  type        = list(string)
  default     = []
}

variable "api_public_access_cidrs" {
  description = "CIDRs allowed to reach the EKS API's public endpoint, which tofu's helm and kubernetes providers use from the machine running tofu (its own /32, e.g. from `curl https://checkip.amazonaws.com`). The install host uses the private endpoint. There is no default, so the API is never open to the internet by accident."
  type        = list(string)
}

variable "tailscale_oauth_client_id" {
  description = "OAuth client ID for the Tailscale Kubernetes operator (see README)."
  type        = string
  sensitive   = true
}

variable "tailscale_oauth_client_secret" {
  description = "OAuth client secret for the Tailscale Kubernetes operator."
  type        = string
  sensitive   = true
}

variable "tailscale_auth_key" {
  description = "Optional auth key that joins the install host to the tailnet, stored as an SSM SecureString only the host can read. It must be a user-owned key, not a tagged one: the yaac server refuses tagged devices. Empty means you run `sudo tailscale up` on the host yourself."
  type        = string
  default     = ""
  sensitive   = true
}

variable "yaac_repo" {
  description = "Git URL the install host clones yaac from."
  type        = string
  default     = "https://github.com/bsklaroff/yaac.git"
}

variable "yaac_ref" {
  description = "Branch, tag or commit of yaac the install host builds."
  type        = string
  default     = "main"
}

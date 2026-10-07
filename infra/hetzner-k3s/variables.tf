variable "hcloud_token" {
  description = "Hetzner Cloud API token (read & write) for the project the cluster lives in. The cloud controller, the volume driver and the autoscaler use it from inside the cluster too."
  type        = string
  sensitive   = true
}

variable "state_passphrase" {
  description = "Passphrase the state is encrypted with before it is stored in the bucket (at least 16 characters). Lose it and the state cannot be read."
  type        = string
  sensitive   = true
}

variable "name" {
  description = "Prefix of every server, network and firewall this stack creates."
  type        = string
  default     = "yaac"
}

variable "location" {
  description = "Hetzner location for every node (fsn1, nbg1, hel1, ash, hil, sin). One location, because the volumes behind the server's state and the registries can only attach to a server in their own location."
  type        = string
  default     = "fsn1"
}

variable "image" {
  description = "OS image of every node. The bootstrap expects Ubuntu: it installs containerd, podman and the NFS server from apt."
  type        = string
  default     = "ubuntu-26.04"
}

variable "control_server_type" {
  description = "Server type of the control node: the k3s server, the NFS server behind the shared claim, yaac's server and infrastructure, the place images are built, and the first few workspaces. cax* types are arm64; every node must share the control node's architecture."
  type        = string
  default     = "cx43"
}

variable "control_system_reserved" {
  description = "kubelet system-reserved on the control node: the cpu and memory no pod may be scheduled into, kept for the k3s server, the NFS server and containerd. Raise it with the control node's size."
  type        = string
  default     = "cpu=1,memory=2Gi"
}

variable "worker_system_reserved" {
  description = "kubelet system-reserved on every worker, manual or autoscaled: the cpu and memory kept for the k3s agent and containerd, so workspaces using memory past their requests are evicted before those run short. The autoscaler plans a new node from its full size, so it may count one workspace more than fits."
  type        = string
  default     = "cpu=500m,memory=1Gi"
}

variable "manual_workers" {
  description = "Always-on workers you manage through this file, by name, with their server type. Add an entry to add a node; drain a node (kubectl drain) before removing its entry."
  type        = map(string)
  default     = {}
}

variable "autoscale_pools" {
  description = "Worker pools the cluster autoscaler grows when workspaces stop fitting and shrinks once their nodes hold no workspace. Empty means no autoscaler."
  type = list(object({
    name        = string
    server_type = string
    min         = optional(number, 0)
    max         = number
  }))
  default = [{ name = "workspaces", server_type = "cx43", max = 3 }]
}

variable "nfs_volume_gb" {
  description = "Size of the volume the control node exports over NFS: the shared claim every workspace mounts (checkouts, the database, agent state)."
  type        = number
  default     = 100
}

variable "ssh_public_key" {
  description = "Public key installed for root on every node. tofu also uses it (through your ssh-agent) to configure the control node."
  type        = string
}

variable "ssh_source_cidrs" {
  description = "CIDRs allowed to reach the nodes on port 22, which tofu needs to configure the control node: this machine's address as a /32. There is no default, so ssh is never open to the internet by accident."
  type        = list(string)
}

variable "k3s_version" {
  description = "k3s release every node installs. Keep its Kubernetes minor equal to the autoscaler's (autoscaler_version)."
  type        = string
  default     = "v1.36.4+k3s1"
}

variable "autoscaler_version" {
  description = "Cluster autoscaler image tag. Its minor version must match the cluster's."
  type        = string
  default     = "v1.36.1"
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
  description = "Optional auth key that joins the control node to the tailnet. It must be a user-owned key, not a tagged one: the yaac server refuses tagged devices. Empty means you run `tailscale up` on the node yourself."
  type        = string
  default     = ""
  sensitive   = true
}

variable "yaac_repo" {
  description = "Git URL the control node clones yaac from."
  type        = string
  default     = "https://github.com/bsklaroff/yaac.git"
}

variable "yaac_ref" {
  description = "Branch, tag or commit of yaac the control node builds."
  type        = string
  default     = "main"
}

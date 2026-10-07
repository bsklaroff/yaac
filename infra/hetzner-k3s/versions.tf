terraform {
  required_version = ">= 1.10"

  # State lives in a Hetzner Object Storage bucket, so any machine holding
  # terraform.tfvars and backend.hcl can update or destroy the cluster
  # (README.md "Remote state"). The bucket, endpoint and keys come from
  # backend.hcl. Hetzner implements S3 but not AWS's account and region
  # APIs, nor its newer checksum headers, hence the skips. Its lockfile
  # locking needs conditional writes, which Hetzner refuses on a versioned
  # bucket, so the bucket is unversioned.
  backend "s3" {
    key                         = "hetzner-k3s/terraform.tfstate"
    region                      = "us-east-1"
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }

  # The state holds the Hetzner token and the cluster's join tokens, and
  # Hetzner offers no server-side encryption of its own, so OpenTofu
  # encrypts the state before it leaves this machine.
  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "1.69.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
  }
}

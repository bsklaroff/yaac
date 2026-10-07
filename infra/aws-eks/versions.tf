terraform {
  required_version = ">= 1.10"

  # State lives in an S3 bucket, so any machine with AWS credentials and
  # terraform.tfvars can update or destroy the cluster (README.md "Remote
  # state"). The bucket and its region come from backend.hcl.
  backend "s3" {
    key          = "aws-eks/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "3.3.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "3.2.1"
    }
  }
}

# The machine `yaac cluster install --byo` runs on. yaac builds its images
# here with rootful podman, for this machine's architecture, and pushes
# them into the cluster through a kubectl port-forward. So the host sits
# in the cluster's VPC and matches the nodes' architecture. Its security
# group admits nothing: reach it with SSM Session Manager, or Tailscale SSH
# once it is on the tailnet. It is needed only to install or upgrade, so
# `install_host_running = false` stops it in between.

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/26.04/stable/current/${var.architecture}/hvm/ebs-gp3/ami-id"
}

data "aws_iam_policy_document" "ec2_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "host" {
  name               = "${var.name}-install-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
}

resource "aws_iam_role_policy_attachment" "host_ssm" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# `aws eks update-kubeconfig` reads the cluster; the cluster admin access
# itself is the access entry in main.tf.
resource "aws_iam_role_policy" "host_eks" {
  name = "describe-cluster"
  role = aws_iam_role.host.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "eks:DescribeCluster"
      Resource = module.eks.cluster_arn
    }]
  })
}

# The Tailscale auth key, kept out of the user data (which the EC2 API and
# console serve to anyone with DescribeInstanceAttribute). Only the host's
# role may read it.
resource "aws_ssm_parameter" "tailscale_auth_key" {
  count = var.tailscale_auth_key == "" ? 0 : 1

  name  = "/${var.name}/install-host/tailscale-auth-key"
  type  = "SecureString"
  value = var.tailscale_auth_key
}

resource "aws_iam_role_policy" "host_tailscale_key" {
  count = var.tailscale_auth_key == "" ? 0 : 1

  name = "read-tailscale-auth-key"
  role = aws_iam_role.host.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "ssm:GetParameter"
      Resource = aws_ssm_parameter.tailscale_auth_key[0].arn
    }]
  })
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.name}-install-host"
  role = aws_iam_role.host.name
}

resource "aws_security_group" "host" {
  name_prefix = "${var.name}-install-host-"
  description = "yaac install host: outbound only"
  vpc_id      = module.vpc.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "host" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = local.host_instance_type
  subnet_id              = module.vpc.public_subnets[0]
  vpc_security_group_ids = [aws_security_group.host.id]
  iam_instance_profile   = aws_iam_instance_profile.host.name

  root_block_device {
    volume_size = 100
    volume_type = "gp3"
    encrypted   = true
  }

  # Hop limit 1 keeps a build container on this host (one hop off it) from
  # IMDS, and so from this role, which is EKS cluster-admin. Set here rather
  # than left to the AMI, whose default may be 2.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  user_data = templatefile("${path.module}/install-host.sh.tftpl", {
    region                  = var.region
    cluster_name            = var.name
    kubernetes_version      = var.kubernetes_version
    host_name               = "${var.name}-install-host"
    tailscale_key_parameter = var.tailscale_auth_key == "" ? "" : "/${var.name}/install-host/tailscale-auth-key"
    yaac_repo               = var.yaac_repo
    yaac_ref                = var.yaac_ref
    pod_cidrs               = local.vpc_cidr
  })

  # The bootstrap reads the auth key at first boot.
  depends_on = [aws_ssm_parameter.tailscale_auth_key, aws_iam_role_policy.host_tailscale_key]

  tags = {
    Name = "${var.name}-install-host"
  }

  # The user data only runs at first boot, and the host holds the install's
  # identity (~/.yaac-client/server.json), so a later change to either must
  # not quietly replace the host. Replace it deliberately with `tofu apply
  # -replace=aws_instance.host`, after saving that file (README.md).
  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

resource "aws_ec2_instance_state" "host" {
  instance_id = aws_instance.host.id
  state       = var.install_host_running ? "running" : "stopped"
}

output "cluster_name" {
  value = module.eks.cluster_name
}

output "efs_file_system_id" {
  value = aws_efs_file_system.global.id
}

output "install_host_session" {
  description = "Opens a shell on the install host (needs the Session Manager plugin for the AWS CLI)."
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.host.id}"
}

output "install_command" {
  description = "Run on the install host as ubuntu (`sudo -iu ubuntu`) once its bootstrap is done."
  value       = "yaac cluster install --byo --rwx-storage-class ${local.rwx_storage_class}"
}

output "local_kubeconfig" {
  description = "Points this machine's kubectl at the cluster."
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}

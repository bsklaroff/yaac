output "control_ipv4" {
  value = hcloud_server.control.ipv4_address
}

output "control_ssh" {
  description = "Opens a root shell on the control node. `sudo -iu yaac` there is the user install runs as."
  value       = "ssh root@${hcloud_server.control.ipv4_address}"
}

output "install_command" {
  description = "Run on the control node as yaac (`sudo -iu yaac`) once /var/lib/yaac/yaac.ready exists."
  value       = "yaac cluster install --byo --rwx-storage-class ${local.rwx_storage_class}"
}

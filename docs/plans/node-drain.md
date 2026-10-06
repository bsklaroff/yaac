# Surviving a node drain

On a byo cluster nodes come and go: a node-pool upgrade, a reboot, or the
cluster autoscaler. Workspace pods carry `safe-to-evict: "false"`, so
scale-down never picks a node running one, but an upgrade or a manual
`kubectl drain` still evicts the pod and its Job fails. Today that reads as
an ordinary death with no explanation.

## Proposal

- Recognize the eviction (the pod's `DisruptionTarget` condition or an
  `Evicted` reason) and record a "node drained" death cause, so the
  workspace shows why it stopped and offers a restart.
- Document what survives: the checkout, transcripts and opencode's last
  checkpoint are on the shared tier; in-flight scratch on the node is lost.
- Run a full workspace life for every tool on `infra/aws-eks` (create,
  nested containers, prewarm claim, drain the node, resume on another) and
  confirm the gVisor installer survives a node-pool upgrade.
- A drain that moves the npm cache or a registry makes installs and pulls
  fail until its claim reattaches. Decide whether that needs more than the
  existing retries.

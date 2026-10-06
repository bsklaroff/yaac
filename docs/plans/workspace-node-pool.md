# A dedicated workspace node pool

A byo cluster can keep workspaces on their own node pool today only by hand:
taint the pool and add the matching toleration to the `gvisor` RuntimeClass
(docs/cluster-setup.md "Which nodes count as workspace-eligible"). Nothing
records that toleration, and yaac's own infrastructure is not kept off the
pool. Install schedules the server and registries when only the system node
exists, but a later rollout (an upgrade, `yaac server restart`) can put them
on a workspace node, where the cluster autoscaler may evict them to drain it
and briefly take the server down (infra/aws-eks/README.md "Known gap").

## Proposal

Add `--workspace-pool-taint <key>[=<value>]:<effect>` to `yaac cluster
install --byo`, recorded in `server.json` so a re-install keeps it:

- The `gvisor` and `gvisor-nested` RuntimeClasses get a `scheduling.tolerations`
  entry scoped to that key. Workspace, builder and check-probe pods inherit it.
- The gVisor installer DaemonSet gets the toleration plus a `nodeSelector` (or
  required node affinity) for the pool, so only pool nodes get the runtime.
- Trusted infra (server, registries, proxy, npm cache) gets an anti-affinity
  away from the pool, or a `nodeSelector` for the system pool, so a rollout
  cannot land it on a node the autoscaler drains.
- `cluster check` reports which nodes the taint selects and refuses a pool
  with no Ready node.

`infra/aws-eks` then passes its pool's taint and drops the known gap.

# Legacy-compat shims in the tree

This lists the shims, backfills, compatibility windows and legacy prose that
exist only because an older install may still be out there. Each gets an
entry when it is added, so a cleanup pass starts from this list instead of a
grep, and shims with an ordering constraint are removed in the right order.

There is no version-floor scheme, and none is wanted: nothing records which
version last wrote a data dir or set up a cluster. Shims are deleted as they
come up. An install that skips many releases may lose data or need a manual
step. That cost is accepted, and the entries say which shims carry it.

Each entry says what the shim reads, what breaks silently if it is deleted
too early, and how to tell it is safe to remove, plus any required order.

No test can catch a shim going stale. The suite runs on a database and disk it
just created, where every shim is already a no-op, so a green run says nothing
about them. That is why this is a list and not a check.

## netd's cluster-wide RBAC sweep

netd watches pods only in its install namespace, through a namespaced Role.
Older installs granted it a ClusterRole and ClusterRoleBinding named
`yaac-netd-<namespace>` for a pod watch across every namespace. `kubectl
apply` never prunes, so on an upgraded install that grant would outlive the
code that needed it.

- **What it reads.** `deleteLegacyNetdClusterRbac` in
  `packages/server/src/drivers/k8s/cluster/netd.ts` deletes the ClusterRole
  and ClusterRoleBinding labelled `app=yaac-netd` and
  `yaac.install-namespace=<namespace>`, after every netd rollout.
  `test/global-setup.ts` keeps `yaac-netd` in its leaked-RBAC selector to
  sweep the same objects left by earlier test runs.
- **What breaks silently if it goes too early.** Nothing visibly: the netd
  ServiceAccount keeps cluster-wide read on every pod (specs, env, labels) on
  installs that predate the change, so a compromised netd sees more than it
  should.
- **When it is safe to remove.** Once no install set up before the change
  remains: `kubectl get clusterrole -l app=yaac-netd` is empty on every
  cluster yaac manages.
- **Order.** Delete this sweep before dropping `clusterroles` and
  `clusterrolebindings` from the server's ClusterRole
  (`buildServerClusterRoleManifest`). Nothing else the server runs needs
  them, but while the sweep exists, removing them makes it fail as
  Forbidden, and `ensureNetd` with it.

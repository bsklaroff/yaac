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
`yaac-netd-<namespace>` for a pod watch across every namespace. Applying
manifests never deletes an object yaac stops sending, so on an upgraded
install that grant would outlive the code that needed it.

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

## Adopting fields owned by client-side `kubectl apply`

Installs set up before the k8s driver used server-side apply wrote every
object with client-side `kubectl apply`, so each field is owned by the
`kubectl-client-side-apply` manager and the object carries a
`kubectl.kubernetes.io/last-applied-configuration` annotation. yaac's apply
co-owns a field whose value it sends unchanged, so later omitting that field
would never remove it.

- **What it reads.** `adoptClientSideFields` in
  `packages/server/src/drivers/k8s/substrate/api.ts`, run on every
  `applyObject` response. When the response lists a
  `kubectl-client-side-apply` entry in `managedFields`, it merges that
  entry's fields into yaac's Apply entry, removes the last-applied
  annotation, and applies again so omitted fields are pruned at once. An
  object already adopted costs nothing extra. `test/apiserver` covers it
  against a real API server.
- **What breaks silently if it goes too early.** A key yaac stops sending
  stays on an upgraded install. Examples are a signed-out credential in
  `yaac-proxy-credentials` or a project secret, which the proxy keeps
  injecting, or an install env var such as `YAAC_USE_TOR` that is unset on
  re-install. The last-applied annotation also keeps a frozen copy of old
  Secret data.
- **When it is safe to remove.** Once every object yaac still re-applies
  has been adopted. An object is adopted the first time yaac applies it
  after the upgrade, so one `yaac cluster install` plus a workspace create
  covers the install-time and proxy objects. Objects yaac writes once or
  only when absent never get adopted, and don't need to be, because the
  shim only matters to a later apply. These are the PVs and PVCs, the
  proxy auth Secret and CA, the proxy's own output objects, and the
  `yaac-registry-keys` Namespace. Leave Calico's and kind's objects out of
  the check: `installCalico` applies the upstream manifest with
  client-side `kubectl apply`, so they always carry the old manager. This
  lists the yaac objects still carrying it:
  `kubectl get "$(kubectl api-resources --verbs=list -o name | paste -sd,)"
  -A --show-managed-fields -o json | jq -r '.items[] | select(.metadata.name
  | startswith("yaac")) | select(any(.metadata.managedFields[]?;
  .manager == "kubectl-client-side-apply")) | "\(.kind)/\(.metadata.name)"'`.
  It is safe once that list holds only objects yaac never re-applies. A
  project's secrets Secret is re-applied on that project's next sync, so it
  stays on the list, and the shim stays needed, until every project has
  synced since the upgrade.

## The proxy relays yaac-mama's old `/cmd` path

`relayMamaRequest` in `k8s/proxy/main.ts` (`LEGACY_MAMA_PATH`) relays a POST
to `http://yaac.internal/cmd` like one to `/api/workspace/mama`. That is
where a workspace's `yaac-mama` script POSTed before the proxy relayed calls
to the server (the body is the same envelope), and a workspace keeps the
script it launched with until it is recreated.

- **Reads:** the request path, nothing stored.
- **Breaks silently if deleted too early:** every `yaac-mama` call in a
  workspace launched before the relay gets a 404 naming the new path, until
  the workspace is recreated.
- **Safe to remove when:** no workspace launched before the relay can still
  be running, i.e. once every install has been upgraded past it and its
  older workspaces stopped.

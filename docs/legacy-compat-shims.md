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
  `yaac-proxy-credentials`, which the proxy keeps injecting, or an install
  env var such as `YAAC_USE_TOR` that is unset on
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
  It is safe once that list holds only objects yaac never re-applies.

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

## The shared api-key placeholder for opencode and pi

opencode and pi each have their own api-key placeholder
(`yaac-ph-opencode-api-key`, `yaac-ph-pi-api-key`), so the proxy can tell from
the request whose key to swap in. Workspaces launched before that carry the
shared `yaac-ph-api-key` in the provider's own variable (`OPENROUTER_API_KEY`
and the like), and `yaac auth fake` used to store it as the fake opencode and
pi key.

- **What it reads.** `buildDynamicRules` in `k8s/proxy/injection.ts` still
  swaps `PLACEHOLDER_API_KEY` for the opencode and pi keys on their provider
  hosts. claude and codex send that same placeholder from every workspace,
  so where opencode's or pi's provider host is `api.anthropic.com` or
  `api.openai.com` the request is ambiguous; the claude and codex swaps run
  after it and win. An old opencode or pi workspace on those hosts therefore
  gets claude's or codex's key while either is signed in by api key.
  `holdsRealCredential` in
  `packages/server/src/domain/projects/fake-auth.ts` counts a stored
  `yaac-ph-api-key` as a fake, so `yaac auth fake` re-seeds over it.
- **What breaks silently if it goes too early.** opencode and pi in a k8s
  workspace started before the change send a placeholder nothing swaps, and
  every request gets a 401 until the workspace restarts. In yaac-in-yaac, an
  inner install whose fakes predate the change gets the same 401 from the
  outer proxy, and `yaac auth fake` refuses to re-seed, calling the old
  fake a real credential.
- **When it is safe to remove.** Once no workspace pod is older than the
  change (`kubectl get pods -n yaac` ages, or every workspace restarted), and
  every inner install has re-run `yaac auth fake` for opencode and pi.

## Inferred run starts and held messages for an older pi-acp

pi-acp as yaac patches it (`dockerfiles/agent-patches/pi-acp.js`, revision 3
on) adopts a run an extension starts: it reports the run's start and queues
prompts behind it. An older install reports only the run's end and fails a
`session/prompt` sent during the run, so yaac compensates for it.

- **What it reads.** pi's `infersRunStart` and `refusesPromptMidRun` in
  `packages/server/src/runtime/agents/acp-adapters.ts`: `AcpClient` treats
  a work update while idle as a run's start and holds messages while such a
  run goes on. Both are harmless against the patched adapter.
- **What breaks silently if it goes too early.** In a pi acp workspace still
  on an older pi-acp (a k8s workspace on an older image, a containerless one
  started before the upgrade), an extension-started run shows as idle until
  it ends, and a message sent during it fails with stop reason `error`
  instead of waiting.
- **When it is safe to remove.** Once every running pi acp workspace was
  started on patch revision 3 or later: restart any older one. Then delete
  both flags, the code reading them, and their tests.

## Backfilling project ids into the slug-keyed rows

Projects were keyed by a slug derived from the repo name, and every table
naming a project had a `project_slug` column. The `key_projects_by_id`
migration (`packages/server/drizzle/*_key_projects_by_id/migration.sql`)
re-keys them by `projects.id`.

- **What it reads.** Each `project_slug`, joined to `projects.slug` to fill
  `project_id`; `projects.slug` itself is copied into the new `name`
  column. Rows whose slug names no project are deleted, since nothing can
  reach them.
- **What breaks silently if it goes too early.** It is a migration, so it
  can only go with a squash of the migration history. A squash that drops
  its backfill turns an older install's workspaces, conversations, groups,
  queued and draft workspaces, env vars and create defaults into rows that
  name no project, or fails the migration outright.
- **When it is safe to remove.** When the migrations are squashed and no
  install still has a `project_slug` column (`\d projects` shows no
  `slug`). Nothing else depends on it, except that the project dir move
  below reads the `name` it wrote.

## Backfilling owners and the access mode

Projects, preferences, shortcut overrides and git credentials had no owner,
and an install had no access mode. The `add_users_and_owners` migration
(`packages/server/drizzle/*_add_users_and_owners/migration.sql`) inserts the
built-in user, owns every existing row by it, and records `local` for an
install holding any of those rows (docs/remote-hosting.md "Access modes").

- **What it reads.** Whether `projects`, `git_credentials`, `preferences` or
  `shortcut_overrides` has any row, to decide whether to record `local`; the
  `owner` columns are filled from a default that is dropped again.
- **What breaks silently if it goes too early.** It is a migration, so it
  can only go with a squash of the migration history. A squash that drops
  the `local` record lets an upgraded install start as `--tailnet` without
  `--owner`, leaving its data with a built-in user no tailnet login can
  reach; one that drops the owner backfill fails the migration outright.
  The test cannot see tool sign-ins, which live in `.credentials/<tool>.json`
  outside the DB: an install holding only those counts as fresh, may go
  `tailnet` without `--owner`, and keeps a login-less built-in user, so an
  importer of those bundles must not assume that user has a login.
- **When it is safe to remove.** When the migrations are squashed and every
  install has started once since this release, so has an `access_modes`
  row. The built-in user insert must stay in any squash: a fresh database
  needs it.

## Moving slug-named project dirs to their ids

Each project's data dir was `projects/<slug>/`; it is `projects/<id>/`.
`moveProjectDirsToIds` in
`packages/server/src/domain/workspaces/project-dir-migration.ts` runs on
every server start, from the driver's `recover` hook (before any watch or
reconcile pass), and merges each dir still named after a project's `name`
into `projects/<id>/`, which a request may already have created; of a file
both hold, the newer copy wins. When the old dir holds the main clone, the
project's running workspaces mount and hold paths inside it, so they are
stopped first, recorded as stopped, and resume their conversations on
restart. A project whose workspaces cannot be confirmed stopped keeps its
old dir until the next start. Before moving, it harvests a refreshed token
from the old tool homes, drops the macOS Keychain item claude keyed on the
old path, repoints each checkout's `alternates` at where the main clone is
going (so a stopped workspace's diff still reads), and drops claude's
history links named after the old checkout paths. A dir named after a name
several projects share goes to the oldest of them.

- **What it reads.** `projects.name`, `projects.id` and `addedAt`, and
  whether `projects/<name>/` and its `repo/` exist. Containerless
  workspaces in an old dir report the dir's name as their project, which it
  maps back to the id.
- **What breaks silently if it goes too early.** An older install's
  projects keep their files under `projects/<slug>/`, where nothing looks:
  workspaces fail to create or restart, config, history and tool logins
  appear lost, and the old tree is never cleaned up.
- **When it is safe to remove.** Once every install has started a server
  with this change: no `projects/` entry in any data dir's global tier is
  anything but a uuid (`ls ~/.yaac/global/projects`, or the global claim
  under the in-cluster server).
- **Order.** It reads `name` as the old dir name, so it must go before
  project names become editable, and before the planned per-owner dir move
  (docs/plans/multi-user-deployment.md), which must start from id-named
  dirs.

## Deleting slug-named proxy secrets Secrets

The proxy's per-project secret values Secret was named after a hash of the
project slug and labelled `yaac.project=<slug>`. It is
`yaac-proxy-secrets-<id>` with `yaac.project-id`, written at every server
start. `deleteSlugNamedProjectSecrets` in
`packages/server/src/drivers/k8s/cluster/proxy-apply.ts` deletes the old
ones on every k8s driver start.

- **What it reads.** Secrets in the install namespace labelled
  `app=yaac-proxy,yaac.proxy-input=secrets` that still carry the
  `yaac.project` label, which only the old ones have. The old Secrets
  carried no install label, so the sweep is namespace-wide: an older install
  sharing the namespace (whose names hashed its data dir to keep them apart)
  loses its secret values until its server re-syncs them.
- **What breaks silently if it goes too early.** Nothing visible: the
  proxy only resolves `<id>/<NAME>` refs, so an old Secret is never used,
  but it keeps a decrypted copy of the project's secret values in the
  cluster, and a removed secret survives there.
- **When it is safe to remove.** Once
  `kubectl get secret -n <namespace> -l yaac.proxy-input=secrets,yaac.project`
  is empty on every cluster yaac manages.

## The proxy drops slug-keyed git auth failures

The proxy records git credentials an upstream rejected per project, in the
`yaac-proxy-state` ConfigMap it seeds from at boot. Those entries were keyed
by slug, and a slug-keyed entry never clears, since no request carries that
key any more.

- **What it reads.** `ObservedState.seed` in `k8s/proxy/observed-state.ts`
  skips `gitAuthFailures` keys that are not uuids.
- **What breaks silently if it goes too early.** A failure recorded before
  the change is reported forever under a key that names no project: the
  CLI's `workspace list` prints it as an unknown project.
- **When it is safe to remove.** Once every install's proxy has booted
  with the change and written its state since: the `gitAuthFailures` keys
  in `kubectl get configmap yaac-proxy-state -n <namespace> -o json` are
  all uuids.

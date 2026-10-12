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
  The test cannot see tool sign-ins, which lived in `.credentials/<tool>.json`
  outside the DB: an install holding only those counts as fresh, may go
  `tailnet` without `--owner`, and keeps a login-less built-in user, which
  the importer below hands them to all the same.
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
going (so a stopped workspace's diff still reads), drops claude's
history links named after the old checkout paths, and repoints the paths
pi, opencode and codex recorded (`rewriteToolRecordPaths`, described under
the host install below). A dir named after a name
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
  anything but a uuid (`ls ~/.yaac-server/global/projects`, or the global claim
  under the in-cluster server).
- **Order.** It reads `name` as the old dir name, so it must go before
  project names become editable.

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

## The proxy serves an owner-less registration from the only owner

A workspace's egress registration names the owner whose credentials it
spends. A workspace launched before owner keys keeps a registration
without one until it is recreated, since a registration is rewritten only
on create, claim and allow-host.

- **What it reads.** `ProxyObjects.ownerOf` in `k8s/proxy/object-watch.ts`:
  a registration with no `owner` resolves to the one owner the credentials
  Secret names, and to none when it names several.
- **What breaks silently if it goes too early.** Every workspace launched
  before the change loses its tool and git credentials at the proxy: its
  placeholders travel unswapped and get 401s, and its ssh-agent lists no
  keys, until the workspace is recreated.
- **When it is safe to remove.** Once no workspace pod is older than the
  change: every `yaac-proxy-reg-*` ConfigMap's `registration.json` carries
  an `owner`.
- **Order.** None. Once the credentials Secret holds more than one owner
  the shim stops matching on its own, which is the safe direction.

## Adopting refreshed bundles a pre-owner proxy wrote

The proxy writes OAuth rotations it captures to `yaac-proxy-refreshed`
under `<owner>.claude.json` and `<owner>.codex.json`. A proxy from before
owner keys wrote bare `claude.json` and `codex.json`, and a rotation it
captured while the server was down for the upgrade is in nothing else; a
codex refresh token is single-use, so losing it signs codex out.

- **What it reads.** `mapProxyRefreshedObject` in
  `packages/server/src/drivers/k8s/substrate/proxy-objects.ts` reports the
  bare keys under the owner `''`, and `adoptRefreshedToolCredentials` in
  `packages/server/src/domain/auth/runtime-push.ts` adopts them into the
  built-in user's store (`ownerOfCredentialKey` in
  `packages/server/src/domain/auth/store.ts`), which owned everything
  before credentials were per user, under the same newest-wins rule as any
  owner's captures. The
  proxy never deletes the bare keys, so later passes compare against the
  same stale bundle and adopt nothing.
- **What breaks silently if it goes too early.** A rotation captured by the
  old proxy during the upgrade is never adopted: the built-in user's store
  keeps the spent refresh token, and the next refresh signs that tool out.
- **When it is safe to remove.** Once every install has started a server
  with the change at least once (its first adoption pass takes whatever the
  bare keys hold).
- **Order.** None.

## Importing tool sign-ins from `.credentials/`

Tool sign-ins were one install-wide set of files,
`server-local/.credentials/<tool>.json`; they are rows of `tool_credentials`,
per user. `importToolCredentialFiles` in
`packages/server/src/domain/auth/import-files.ts` runs on every server start,
after the access mode settles and before anything reads the store. It hands
each readable file to the built-in user (who owned everything then, whether
or not it has since been given a login), unless that user already has a row
for the tool, and deletes the file once its row reads back. A file that
fails its schema is moved to `server-local/.credentials-unreadable/` for a
hand repair. The directory is removed once empty.

- **What it reads.** The four `<tool>.json` files under `credentialsDir()`
  (`packages/shared/src/project-paths.ts`), each against its tool's schema.
- **What breaks silently if it goes too early.** An install upgraded past
  its removal loses its tool sign-ins: every agent's sentinel goes unswapped
  (k8s) or its project home is no longer refreshed (containerless), plan
  usage disappears, and `yaac-mama create` refuses every tool, until the
  user signs in again. The files stay on disk, unread.
- **When it is safe to remove.** Once every install has started a server
  with the change: no data dir has a `<tool>.json` left in
  `server-local/.credentials/`. Remove `credentialsDir()` with it.
  `.credentials-unreadable/` is the user's to delete; nothing reads it.
- **Order.** None.

## Moving the egress allowlist out of yaac-config.json

A project's allowlist was two `yaac-config.json` keys, `addAllowedUrls` and
`setAllowedUrls`; it is the `projects.egress_allowlist` column.
`importConfigAllowlists` in `packages/server/src/domain/projects/allowlist.ts`
runs on every server start, from the driver's `recover` hook right after the
project dir move below. For each project whose config file holds either key it
merges the hosts into the column (`setAllowedUrls` turns the defaults off),
then rewrites the file without the two keys. It keeps only entries whose effect
does not change: one the proxy could never match (uppercase, a scheme, path or
port) is dropped, and so is a `*` that was not the whole of `setAllowedUrls`,
since there it matched only single-label names and the column treats `*` as
allow-all. Each drop is logged by name. A file holding both keys, or a list
that is not a string array, is left alone and logged; a file that is not JSON
is skipped silently, since parsing it already fails loudly. `parseProjectConfig`
also refuses either key with a pointer to the settings page, so a pasted old
config, and one the import left alone, fails loudly instead of being ignored.

- **What it reads.** `global/projects/<id>/config/yaac-config.json` for every
  project row.
- **What breaks silently if it goes too early.** An upgraded install's extra
  hosts stop being allowed (its workspaces get proxy 403s from hosts they used
  to reach), and a project that had replaced the defaults gets them back,
  widening its egress. With the refusal still in place the leftover keys make
  every create and the config editor fail instead, which is loud; deleting
  both at once makes the loss silent.
- **When it is safe to remove.** Once every install has started a server with
  the change: no project's `yaac-config.json` contains `AllowedUrls`. Remove the
  refusal in `parseProjectConfig` with it.
- **Order.** It reads project dirs by id, so it runs after
  `moveProjectDirsToIds`, and must be removed no later than that move is.

## The built-in user's credentials keep the `install` key

Before credentials were per user, the server pushed its one set to the
egress proxy under the owner key `install`, and every workspace's
registration named it. A registration is rewritten only on create, claim
and allow-host, so a workspace running across the upgrade still names
`install`. `credentialOwnerKey` in
`packages/server/src/domain/auth/store.ts` therefore files the built-in
user's credentials under `install` rather than its user id, and
`ownerOfCredentialKey` maps the key back for adopting refresh captures.

- **What it reads.** Nothing; it is the key the server writes for the
  built-in user, and the key `yaac-proxy-reg-*` registrations of workspaces
  launched before the change name.
- **What breaks silently if it goes too early.** Keying the built-in user by
  its id strands every such workspace: its registration names a key the
  credentials Secret lacks, so the proxy swaps nothing and its tool and git
  requests get 401s until it is recreated.
- **When it is safe to remove.** Never on its own: every built-in-user
  workspace launched since also names `install`. Switching the key to the
  user id needs the same release to re-register each running workspace
  under it.
- **Order.** None.

## Moving the user build dir to the built-in user

`Dockerfile.user` and its build files lived in one install-wide dir,
`server-local/build/`; each user now has `server-local/users/<user id>/build/`.
`moveLegacyUserBuildDir` in `packages/server/src/domain/projects/dockerfile.ts`
runs on every server start, before the access mode is settled (the server
admits no request until then), and renames the old dir to the built-in
user's, since that user owned every project the old file built for. When
the built-in user already has a dir, which only a downgrade and re-upgrade
produces, the old dir is stale: it is left in place, logged on each start,
and must be deleted by hand.

- **What it reads.** Whether `server-local/build/` and the built-in user's
  `server-local/users/00000000-0000-0000-0000-000000000000/build/` exist.
- **What breaks silently if it goes too early.** An older install's
  `Dockerfile.user` and its support files stop applying: the next image
  build drops the user layer without an error, and the settings page shows
  an empty `Dockerfile.user` while the old file sits where nothing reads it.
- **When it is safe to remove.** Once every install has started a server
  with this change: no data dir's server-local tier has a `build/` entry
  (`ls ~/.yaac-server/server-local`, or the server-local claim under the
  in-cluster server), other than a stale one beside the built-in user's
  dir, which the start log names and which can be deleted.

## Stopping the auth daemon an older CLI left running

Older CLIs ran the auth daemon as a detached process (`yaac auth server
run`, started by `yaac auth update`, `yaac auth server start` or an older
desktop app) and recorded it in `~/.yaac-client/.auth-daemon.lock`. It
survives an upgrade, and nothing in the current tree starts or stops one.

- **What it reads.** `stopLegacyAuthDaemon` in
  `packages/desktop/src/server-process.ts`, run once at app start before
  the app's own daemon is forked. It reads the lock, removes it, and sends
  SIGTERM to its pid if `ps` still shows that pid running `auth server run`.
- **What breaks silently if it goes too early.** The server keeps the newest
  auth socket for each user, and both daemons reconnect within a second of
  losing theirs. So the old daemon and the app's take the socket from each
  other in a loop, and every handover cancels the sign-ins in flight on the
  losing side. Web sign-ins fail intermittently until the machine reboots.
- **When it is safe to remove.** Once no supported upgrade starts from a
  release that had `yaac auth server`, so no machine can still hold a
  `.auth-daemon.lock`.

## The `yaac` Homebrew formula renamed to `yaac-cluster`

The tap's single `yaac` formula became `yaac-server` (the CLI and the
containerless host tools) and `yaac-cluster` (the local cluster's tools on
top of it). `homebrew/formula_renames.json` maps `yaac` to `yaac-cluster`, the
one that keeps every dependency `yaac` had. `yaac-cluster.rb`'s caveat tells a
containerless-only user how to drop the cluster tools afterwards.

- **What it reads.** An installed `yaac` keg, which `brew upgrade` migrates
  to `yaac-cluster`.
- **What breaks silently if it goes too early.** Without the rename, an
  installed `yaac` never upgrades again. Pointing it at `yaac-server` instead
  orphans podman, kind, kubectl and the tap's krunkit, and brew's default
  cleanup (after `brew upgrade`, `brew uninstall` or `brew cleanup`) removes
  them. The cluster keeps running until its podman machine next restarts, then
  fails far from the cause.
- **When it is safe to remove.** The caveat paragraph, once no release before
  the split is still in use. `formula_renames.json` can stay indefinitely: it
  costs nothing, and lets an install that skipped many releases migrate.

## Retiring the install record from `server.json`

A data dir's install record lives in `<dataDir>/install.json`. Older
installs kept it in the client tier's `server.json`, beside the selection,
and later ones still copied it there for an older `yaac`. That copy is no
longer written, and `retireServerJsonRecord` in
`packages/shared/src/install-record.ts` moves an existing one out.

- **What it reads.** Install keys (`driver`, `installId`, `clusterUid`,
  `kubeContext`, `byo`, `origin`) in `<clientDataDir>-client/server.json`,
  on every `readServerConfig` and every `readInstallRecord` of the client
  data dir. It writes them to that data dir's `install.json` when that is
  missing (exclusively, so another process's record wins) or torn; an
  existing readable one is left alone, since the copy came from it. Then
  it rewrites `server.json` without them, or deletes it when only an empty
  selection is left. That rewrite can race a concurrent selection change
  and lose it, once per machine.
- **What breaks silently if it goes too early.** An install from before
  `install.json` loses its record, so a host `yaac server start` is
  allowed on its data dir, and `yaac cluster install` mints a new install
  id and refuses its own byo Deployment as another install's. A cluster
  install whose data dir was moved gets the stale copy lifted back into
  `~/.yaac`, and `clusterDataDir` points there.
- **When it is safe to remove.** Once no `server.json` on any machine
  carries an install key, that is, every machine has run one upgraded
  `yaac` command.
- **Order.** Independent of the install-id entries below. The `~/.yaac`
  cluster rule finds a legacy record through it, so it goes with or after
  that rule.

## A cluster install that already lives in `~/.yaac`

With no `YAAC_DATA_DIR`, `yaac cluster …` uses `~/.yaac-cluster`, beside the
host server's `~/.yaac-server`. Older cluster installs live in `~/.yaac` itself.
A live kind cluster's install cannot move: its static volumes are hostPaths
into `~/.yaac`, the kind node's `node-local` mount is fixed when the cluster
is created, and a bound claim's volume is immutable.

- **What it reads.**
  - *The rule.* `clusterDataDir` in `packages/shared/src/install-record.ts`
    keeps `~/.yaac` when its record says `driver: k8s`. It reads that record
    through `readInstallRecord`, so it sees one still only in `server.json`
    (the retirement above). The desktop tray hides the host server's lines when
    `yaac server status --json` reports `driver: k8s` (`hostStatus` in
    `packages/desktop/src/server-control.ts`), since that data dir is the
    cluster's.
  - *The move.* Once the install's kind cluster is gone (`yaac cluster
    delete`, or a podman reset), nothing mounts the old path, so `yaac
    cluster install` renames `~/.yaac` to `~/.yaac-cluster` before it creates
    the new cluster (`moveLegacyClusterDataDir` in
    `packages/shared/src/legacy-data-dir.ts`, asking `kindClusterExists`). The
    fresh cluster mounts the new path and binds fresh volumes to the same
    data. A byo install, and a `--byo` run, never move.
- **What breaks silently if it goes too early.** `yaac cluster install`
  starts a fresh install in `~/.yaac-cluster` against the existing kind
  cluster. A byo install is refused, because its Deployment carries the old
  install id. A kind install gets further and fails in `ensureStaticClaims`
  ("the yaac-global claim is bound to <old volume>, not to <new volume>"),
  whose advice is to delete the claim and re-run. Doing that binds the
  server to fresh volumes under `~/.yaac-cluster`, and the install comes up
  **empty**: every project is still in `~/.yaac`, unreachable.
- **When it is safe to remove.** Once no machine has a cluster install in
  `~/.yaac`: neither `~/.yaac/install.json` nor `~/.yaac-client/server.json`
  records `driver: k8s`.
- **Moving one by hand.** As for any install (docs/cluster-setup.md
  "Moving an install"): a byo install is `mv` and a re-install; a kind
  install is `yaac cluster delete` (running workspaces are lost) and `yaac
  cluster install`, which moves the data dir itself and keeps its
  projects.

## A host install that still lives in `~/.yaac`

With no `YAAC_DATA_DIR`, the host server keeps its data in `~/.yaac-server`.
Older host installs live in `~/.yaac`, and are moved once nothing runs from
them: a containerless workspace holds absolute paths into its data dir and
a socket in a tmp dir keyed by that path, so the dir cannot move under it.
A stopped workspace rebuilds most of what names the path at its next launch
(its HOME links, sockets, alternates and claude's history links). What the
agent tools record about their conversations is not rebuilt, so the move
repoints it.

- **What it reads.**
  - *The fallback.* `defaultHostDataDir` in `packages/shared/src/paths.ts`
    resolves to `~/.yaac` while `~/.yaac-server` does not exist,
    `~/.yaac/server-local` does, and `~/.yaac/install.json` does not record
    `driver: k8s`.
  - *The move.* `moveLegacyHostDataDir` in
    `packages/shared/src/legacy-data-dir.ts`, run by `yaac server
    start|restart` and `yaac cluster install`, renames `~/.yaac` to
    `~/.yaac-server` unless `~/.yaac`'s record says `k8s`, its server lock is
    live, or a socket in its tmp dir answers. First it removes claude's
    history links named after the old checkout paths and repoints each
    project's tool records (`rewriteToolRecordPaths` in
    `packages/shared/src/tool-records.ts`): pi's session headers and
    pi-acp's session map, opencode's database, and codex's rollouts and
    state database record the checkout as an absolute path, and refuse to
    resume a conversation from another one. Every `~/.yaac/` prefix in the
    JSON, JSONL and SQLite files of the project's `history/`, `pi/`,
    `codex/` and `opencode-data/` becomes `~/.yaac-server/`, without
    reading any tool's format. opencode's snapshot repos (its undo and
    revert history) get their `core.worktree` and `alternates` repointed,
    and are renamed after the sha1 of the new checkout path. A failed rename points them back and leaves
    `~/.yaac` in use. Every outcome re-resolves the host data dir, so a
    start that lost a race to move it follows the one that won.
  - *The Keychain.* On macOS, claude names its Keychain item after a hash
    of its config dir, which the move changes. Before the rename, each
    project's item under the old name is written to claude's own
    `.credentials.json`, which claude falls back to and the server
    harvests from, and then deleted. Without this, a token claude refreshed
    but yaac never harvested (a workspace that died without a yaac stop)
    would be stranded under the old name, and the item would leak.
- **What breaks silently if it goes too early.** Without the fallback, an
  unmoved install looks empty: `yaac server status` reports "not running"
  while the old server serves, and a second, empty server starts beside it.
  Without the move, the fallback holds forever. Without the repoint, pi, opencode and codex conversations from
  before the move stop resuming and drop out of the transcript view, and
  pi-acp writes into a recreated `~/.yaac`. While the move is deferred, or
  when `~/.yaac` sits unserved beside `~/.yaac-server`, `yaac server
  status` says so (`legacyHostDataDirHint`).
- **When it is safe to remove.** Once no machine has a `~/.yaac/server-local`
  that is not a cluster install. `rewriteToolRecordPaths` goes with the
  later of this and the slug-named project dir move above.
- **Order.** Remove it before, or together with, the `server.json`
  retirement above. The move finds a cluster install in `~/.yaac` whose
  record is still only in `server.json` through the retirement. Without it
  it would take
  that install for a containerless one, and since a pod-hosted server's lock
  names no host pid, it would judge the live cluster idle and rename `~/.yaac`
  out from under its hostPath volumes.

## Cluster objects keyed by a data-dir hash

An install from before install ids named and labelled its cluster objects
after the first 16 hex characters of a sha256 of its data dir's path, under
the labels `yaac.data-dir-hash`, `yaac.registry-data-dir-hash`,
`yaac.sweep-data-dir-hash` and `yaac.store-data-dir-hash`. Everything is now
keyed by the install id (docs/server-in-cluster.md "Storage claims"). Three
shims move an older install over; remove them in this order.

`yaac cluster install` reads the hash back from the cluster, never from a
path, and records it as `install.json`'s `legacyDataDirHash`
(`readLegacyDataDirHash` in `packages/server/src/drivers/k8s/install/install.ts`):
from the server Deployment's pod template, or on kind with the namespace
gone, from its `yaac-global` volume. Only the hash's shape is accepted, since
it ends up in a node-tree path. `legacyNames` beside it says the install's
names still carry the hash. The CLI binds both next to the install id, and
the server pod gets them as `YAAC_LEGACY_DATA_DIR_HASH` and
`YAAC_LEGACY_NAMES`. Every shim below is a no-op without a hash, which
covers every install created since.

### 1. The startup relabel

- **What it reads.** `relabelLegacyObjects` in
  `packages/server/src/drivers/k8s/substrate/legacy-labels.ts`, run by the
  server at k8s driver start (`startK8sDriver`) before anything selects on
  the install id, adds `yaac.install-id` to each Job, Pod, Deployment,
  Service, claim and NetworkPolicy in the install's namespace whose legacy
  label equals the hash. Objects a later apply re-sends pick the new label
  up anyway; this covers the ones nothing re-applies (workspace Jobs and
  pods, prewarmed spares, builder, store-writer and sweep pods). It runs on
  every start while the hash is recorded, since a Deployment that is not
  re-applied (a project registry, the proxy) recreates its pods from a
  template that carries only the old label. A failure fails the server's
  start: watching with a live workspace unlabelled would read it as gone,
  and the sweeps would delete its data. Volumes, which the server may not
  write, are relabelled by `yaac cluster install` as it ensures them. Old
  labels are never stripped.
- **What breaks silently if it goes too early.** Workspaces from before the
  upgrade are invisible: their pods run on and their Jobs leak, the sweeps
  remove their session dirs and node-local working copies, and `yaac
  cluster check` fails a kind install's storage gate.
- **When it is safe to remove.** Once every legacy install has started an
  upgraded server, so every object that predates the upgrade carries the
  install id or is gone.

### 2. Legacy names and node path

- **What it reads.** `installNameKey` in
  `packages/server/src/drivers/k8s/substrate/install-id.ts` answers the hash
  instead of the install id while `legacyNames` is set, so the node path
  (`/var/lib/yaac/node/<hash>`), kind's static volumes (`<claim>-<hash>`) and
  the main registry and npm cache claims keep their names: kind's extraMount
  and a bound claim's volume cannot change. A kind install drops them when
  `yaac cluster install` creates a new cluster.
  - *byo.* `byoLegacyKeys` switches the names to the install id at the first
    run that finds no pod, in any namespace, mounting the old tree (another
    install from the same data-dir path shares it); this install's own
    server pod is left out, since the rollout replaces it. The switch drops
    `legacyNames` at once, so no later run goes back to the hash's names.
    The new server is still handed the hash, for its startup relabel. Once
    it is up, `retireLegacyNames` deletes the old cache claims (the registry
    and npm cache start empty; install re-pushes the built-in images and
    project images rebuild on use), checks the tree again, since the old
    server could launch a workspace on it until it rolled, and removes it on
    every node only if nothing mounts it. Only then is the hash cleared; a
    kept or failed removal is retried by the next run.
- **What breaks silently if it goes too early.** On kind, the server mounts
  a node path the extraMount does not back, so node-local data lands on the
  node container's own filesystem and is lost with it, and claims bound to
  legacy volume names make install throw. On byo, running workspaces lose
  their image stores and pnpm stores mid-run.
- **When it is safe to remove.** Once no install records
  `legacyDataDirHash`. For kind that means each legacy cluster has been
  recreated, and nothing forces that.

### 3. The backfill and the record fields

- **What it reads.** `readLegacyDataDirHash` and `legacyHashOf`, the
  `legacyDataDirHash` and `legacyNames` fields of `InstallRecord`, and the
  `YAAC_LEGACY_DATA_DIR_HASH` and `YAAC_LEGACY_NAMES` variables.
- **What breaks silently if it goes too early.** The two shims above never
  see a hash, with the consequences they list.
- **When it is safe to remove.** Together with 2.

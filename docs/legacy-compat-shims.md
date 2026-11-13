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

## `server.json`'s `enabled: false`

`server.json` marks nothing selected with an empty `url`. Clients before
0.1.0 kept `url` and set `enabled: false` instead (`yaac remote off`, and the
desktop's switch-back and remove). `readServerConfig` in
`packages/shared/src/server-config.ts` reads that as an empty `url`, keeping
the old one in `saved`. Nothing writes `enabled` any more, so the next write
of the file by any client clears it, but a read alone does not.

- **What it reads.** The `enabled` key of `~/.yaac-client/server.json`.
- **What breaks silently if it goes too early.** A server a pre-0.1.0 client
  deselected is selected again, and commands reach a server the user turned
  off.
- **When it is safe to remove.** Once no `server.json` holds `enabled: false`
  beside a non-empty `url`.

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
  that is not a cluster install. `rewriteToolRecordPaths` goes with it.
- **Order.** Remove it before, or together with, the `server.json`
  retirement above. The move finds a cluster install in `~/.yaac` whose
  record is still only in `server.json` through the retirement. Without it
  it would take that install for a containerless one, and since a
  pod-hosted server's lock names no host pid, it would judge the live
  cluster idle and rename `~/.yaac` out from under its hostPath volumes.

## The server lock's `host` field

A server in the cluster names its pod in its lock's `pod` field, and a host
server's lock names none (docs/server-in-cluster.md "The lock is a lease").
Older yaac had no `pod`. It compared the lock's `host` with its own
`os.hostname()` to decide whether to check the pid or the lease, and it
reads a lock without `host` as unparseable.

- **What it reads.** Nothing reads `host`. `newLeaseFields` in
  `packages/shared/src/lock.ts` still writes it, only for older readers.
- **What breaks silently if it is deleted too early.** An older yaac on the
  same data dir sees no lock. Its `yaac server start` then spawns an older
  server, whose `acquireLock` deletes the lock it cannot parse and opens the
  database beside the running server, so two servers write one PGlite
  database. Its `status` and `stop` report nothing running.
- **When it is safe to remove.** Once no yaac from before `pod` is run
  against a data dir a newer server uses. Nothing records that, so judge it
  by how long `pod` has shipped.
- **The window it leaves.** A lock an older pod wrote has no `pod`, so until
  `yaac cluster install` replaces that pod, a newer host CLI judges it by
  its pid and its `127.0.0.1:<port>`, which belong to the pod. `yaac cluster
  status` can then call the pod not running, or ask whatever host server
  listens on the pod's port 8787. A pod still reads a lock without `pod` by
  its lease, so the database's single-writer guard is unaffected.

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

## Spare labels on claimed workspaces' Jobs

A workspace Job and its pod carry one label set, so a prewarmed spare's Job
has always had `yaac.prewarmed=true`. A claim now removes it from both, but a
server from before that removed it from the pod only, so every workspace it
claimed still has a labelled Job.

- **What it reads.** `unmarkClaimedJobs` in
  `packages/server/src/drivers/k8s/workspaces/claim.ts`, the k8s
  `unmark-claimed-jobs` maintenance step, removes the label from every Job
  whose pod is listed without it. A Job whose pod is already gone cannot be
  told from a dead spare's and keeps the label.
- **What breaks silently if it is deleted too early.** Once such a
  workspace's pod goes (evicted, or deleted out of band), its Job is a stray
  labelled as a spare, and the stale reaper hands it to `reapSpare`. Only the
  row then keeps its checkout, so a database restored from before the row
  existed (docs/workspace-storage.md) deletes the user's files.
- **When it is safe to remove.** When no Job created by an older server can
  remain: every workspace running at the upgrade has since been stopped or
  restarted, since both replace the Job.

## A compaction recorded as a `Compact conversation` tool call

yaac declares `session.compaction`, so an adapter reports a compaction as
`compaction_update`s. Records from before that, and the live conversations
whose handshake ran before it, hold claude's and codex's fallback instead: a
think call titled `Compact conversation` (claude's `_meta.claudeCode.toolName`
is `compact`, and its `rawOutput` carries the trigger and token counts).
`AcpProjection.applyCompaction` in
`packages/server/src/runtime/agents/acp-protocol.ts` reads that call as a
compaction.

- **What it reads.** `tool_call` and `tool_call_update` lines of an ACP
  record matching that call, and later updates to a call it took as one.
- **What breaks silently if it goes too early.** Those compactions show as
  generic thinking rows and start no page, so an older conversation shows
  its pre-compaction history and the rest as one page.
- **When it is safe to remove.** Once every workspace whose `acp`
  conversation ran before the change, stopped ones included, has restarted
  or been deleted since. A stopped workspace's view reads its last life's
  record directly, and it may never be restarted. A restart replaces the
  record, and the lives before it are read from the tool's own history,
  whose translators report compactions as `compaction_update`s.

## A `/compact` opencode answered without reporting a compaction

The pinned opencode reports a compaction as `compaction_update`s. An older
one (2.0.21 and before) reported none, so `RecordProjection` in
`packages/server/src/runtime/agents/acp-log.ts` shows a completed manual
compaction where a user's `/compact` was answered with none reported
(`AcpProjection.unreportedCompaction` in `acp-protocol.ts`). A workspace
started under an older yaac keeps running that opencode until it restarts.

- **What it reads.** A `session/prompt` line of an ACP record whose text
  starts with `/compact`, and the reply to it.
- **What breaks silently if it goes too early.** Those compactions show
  nothing and start no page, so an older conversation shows its
  pre-compaction history and the rest as one page.
- **When it is safe to remove.** Once every workspace whose `acp` opencode
  conversation ran on 2.0.21 or earlier, stopped ones included, has
  restarted or been deleted since. A stopped workspace's view reads its last
  life's record directly, and it may never be restarted.

## A `yaac-mama send` script or opening message that arrives empty

A `yaac-mama send` to a `tui` agent runs a delivery script the server writes
to the exec's stdin (`buildMessageCmd` in
`packages/server/src/runtime/agents/agent-command.ts`), and a `tui`
session's opening message is written to a file the same way before its
agent is launched with it (`buildOpeningWrite`). Under k8s, a pod's streamd
only passes stdin on since exec learned its `stdin` byte count
(docs/stream-relay.md). An older streamd, baked into the base image of a pod
started before then, ignores the count and runs the command with an empty
stdin, so each command checks that something arrived and exits 2 if not.

Only `send` and a session opened with a message in a running workspace
need it. A create's opening message never reaches an older pod: it gets a
fresh pod, or a spare, and a spare warmed before the server restarted is
stale and never claimed.

- **What it reads.** The script, or the message, the command read from
  stdin.
- **What breaks silently if it goes too early.** A `send` to a workspace
  still running a pod started before the upgrade runs an empty script and
  exits 0, so the sender is told "Sent to …" and the agent gets nothing; a
  session opened there launches its agent without its message.
- **When it is safe to remove.** Once no running workspace pod predates the
  streamd that reads exec stdin. A restart moves a workspace onto the
  current base image, so it suffices that every workspace running at the
  upgrade has stopped or restarted since. Containerless workspaces never
  needed it.

## A project's yaac-config.json

Every setting a project's `global/projects/<id>/config/yaac-config.json`
held is a column of its row now (docs/project-config.md), and nothing reads
the file. At start, before any create, the server runs
`importProjectConfigFiles` (`#domain/projects`, `config-import.ts`): for
each project that still has the file, it stores each key on the row. The
keys are `portForward`, `cacheVolumes`, `nestedContainers` and `npmCache`,
plus three that older files carry: `ephemeralModulesPaths` (the scratch
dirs, each with no cap of its own, also filling the project's running
workspace rows, see the next entry), and `initCommands` and `hideInitPane`
(converted to the steps they ran as and written as an init workflow, unless
the project has init workflows already; it is named `init`, else
`init-steps` where the project has an `init`, as the migration names one). The
converted steps run in the workspace's `$SHELL` when it is
a POSIX-family one, as `initCommands` did, so a fish user's now run in bash.
Under containerless the three pod settings are dropped, as they never
applied there and the routes refuse them.

A file that wholly imports is deleted. One with a value that does not
validate or an unknown key, or that is not a JSON object, is renamed
`yaac-config.json.unimported` beside it, for the user to recover from; the
log names only the keys and why, since a value can hold a secret (an
`initCommands` line exporting a token). A failed write leaves the file in
place, and the next start imports it again, which is safe since each write
sets the same values.

- **What it reads.** Every project's `yaac-config.json` under its config dir.
- **What breaks silently if it goes too early.** An install upgraded past
  the import without running it loses its forwarded ports, cache volumes,
  nested containers and npm-cache choice, and, for an older file, its
  scratch dirs and init steps: workspaces then start on the defaults with
  no error anywhere.
- **When it is safe to remove.** Once every install has started a server
  with the import at least once, and no start has failed to write it since.
  No project config dir then has a `yaac-config.json`, which
  `ls ~/.yaac*/global/projects/*/config/yaac-config.json` confirms for a
  given data dir. A `yaac-config.json.unimported` left beside it is the
  user's to read and delete; nothing reads it, so it does not hold the shim
  back.

## A workspace life with no `scratchDirs`

A stop removes the scratch dirs a workspace was started with, recorded on its
life (`workspace_lives.scratchDirs`) by the create, restart or spare claim.
A workspace whose runtime started before that was recorded has it null on
its current life. Two pieces cover it, and both go together:

- `importProjectConfigFiles` (see the entry above), when it moves a
  project's `ephemeralModulesPaths`, also fills that project's null current
  lives with the moved list (`backfillWorkspaceScratchDirs` in `#db`), since
  every null one then is a workspace started with it.
- `checkoutScratchDirs` (`#domain/workspaces` cleanup) treats a life still
  null as started with the old default, `node_modules` alone. It never reads
  the project's current list, which the migration set to `node_modules` and
  `target` and which says nothing about what an older runtime mounted.

- **What it reads.** Each project's config file at start; at stop, the
  workspace's current life's null `scratchDirs`.
- **What breaks silently if it goes too early.** A workspace running at the
  upgrade is stopped without its scratch dirs being removed: under k8s that
  leaves empty mount points, under containerless a full copy of every
  dependency in its checkout. Reading the project's list instead would be
  worse, since it deletes a `target/` the workspace keeps in its checkout.
- **When it is safe to remove.** Once no running workspace has a null
  `scratchDirs`, that is once every workspace running at the upgrade has
  stopped:
  `SELECT count(*) FROM workspace_lives l WHERE scratch_dirs IS NULL AND stopped_at IS NULL
  AND started_at = (SELECT max(started_at) FROM workspace_lives WHERE workspace_id = l.workspace_id)`
  is zero. A stopped one restarted later without the fallback only keeps its
  old `node_modules` contents, which its init steps install over.

## A dead containerless workspace's private HOME

A containerless workspace once ran with a private `$HOME` under its state
dir, `<state dir>/containerless/home`, which held its git credential store
(`.git-credentials`) and gh's login. Workspaces now keep both directly in
`<state dir>/containerless`. `sweepDeadWorkspaceSecrets` in
`packages/server/src/drivers/containerless/lifecycle.ts` deletes `home` along
with the current paths for any workspace recovery finds dead, and
`launchWorkspace` deletes it when a restart relaunches one.

- **What it reads.** `<state dir>/containerless/home` of each dead workspace
  whose marker survives (its host rebooted, or tmux died while the server
  was down), and of each workspace a launch starts.
- **What breaks silently if it goes too early.** A project's HTTPS token,
  and any `gh auth login` a pane made, stay on disk for a workspace that will
  never run again, until someone deletes or restarts it.
- **When it is safe to remove.** Once no state dir on any host has a
  `containerless/home`: every workspace launched before the change has been
  stopped, restarted or deleted. A workspace still running from before keeps
  its private HOME in its tmux server until it stops or restarts.

## claude's session hook naming `$HOME/.claude`

yaac's claude `SessionStart` and `SessionEnd` hooks, merged into each
project's shared claude `settings.json`, once passed the home as
`"$HOME/.claude"`. A containerless workspace now runs on the user's own
`$HOME`, so the hooks name `"$CLAUDE_CONFIG_DIR"`, and `mergeHooks` in
`packages/server/src/runtime/agents/agent-reporters.ts` drops the old
command (`RETIRED_HOOKS`) whenever a create merges the file.

- **What it reads.** The `hooks` of `<project>/claude/settings.json`.
- **What breaks silently if it goes too early.** Both hooks fire on every
  session change. Under containerless the old one names the user's own
  `~/.claude`, so it reports the conversation with no transcript path, and
  the two race to set the pane's conversation, so a row can lose its
  transcript path.
- **When it is safe to remove.** Once every project's claude settings have
  been merged by a create since the change, that is, every project has
  started a workspace since.

## Session windows the `add_sessions` migration named

A session's window is `<tool>-<8 hex>` (`sessionWindowName`). The
`add_sessions` migration gave each session it made the window its agent
already ran in: `<tool>` for a workspace's first agent, `<tool>-<n>` for
the rest, or an acp handle of either form, with `-<8 hex>` appended where
two of a workspace's sessions collided. Those names stay with the session
for as long as it is open, across restarts. `SESSION_WINDOW` in
`packages/server/src/runtime/terminals/pty-bridge.ts` accepts them.

- **What it reads.** The `session:<window>` and `native:<window>` targets
  a client sends to the terminal socket.
- **What breaks silently if it goes too early.** A migrated session's pane
  stops attaching to its window and falls back to the native attach, which
  shows whichever window is current.
- **When it is safe to remove.** Once no open session has a migrated name:
  `SELECT count(*) FROM sessions WHERE closed_at IS NULL AND "window" !~ '^[a-z]+-[0-9a-f]{8}$'`
  is zero.

## A workspace runtime started before sessions

A runtime started before sessions has no keeper window (`_yaac`), and its
agent windows lack `remain-on-exit`, so an agent that quits takes its window
with it. `reconcileWorkspaceSessions` in
`packages/server/src/domain/workspaces/sessions.ts` skips a workspace with
no keeper, so such a vanished window is not read as the user killing the
session, and the session comes back on the next restart.

- **What it reads.** The window listing of each running workspace.
- **What breaks silently if it goes too early.** An agent that quits in a
  workspace running across the upgrade, while another window keeps tmux
  alive, closes its session, and the workspace's next restart comes back
  with no agent.
- **When it is safe to remove.** Once every workspace running at the upgrade
  has stopped or restarted, which a restart does: no running workspace's
  `life_started_at` is older than the upgrade.

## A `tailnet` install from before roles, with no admin

The `add_user_roles` migration makes the built-in user an admin unless the
install is `tailnet` and the built-in user has no login, which is how a
fresh `tailnet` install from before roles was left: nobody can sign in as
it, so such an install comes out of the migration with no admin.
`settleAccessMode` in `packages/server/src/main/access-mode.ts` therefore
treats a recorded `tailnet` mode with no admin like a fresh `tailnet`
install: it takes admins from `--admin` or refuses, naming the flag. Since
roles, nothing else leaves a `tailnet` install with no admin: a fresh start
needs `--admin`, the admin socket refuses an empty list and the last admin
cannot be demoted.

- **What it reads.** The recorded access mode and whether any `users` row
  has `role = 'admin'` (`listAdmins`), on every start.
- **What breaks silently if it goes too early.** An upgraded install starts
  without complaint with nobody able to publish sites or set roles, and
  nothing points at `--admin`.
- **When it is safe to remove.** Once every `tailnet` install has started on
  a build with roles and been given admins. Only the
  `listAdmins().length === 0` half of that condition goes; the
  `recorded === undefined` half is the fresh install's. The migration's
  promotion `UPDATE` stays, as migrations do.

## An install tmp dir left open to other users

The install tmp dir (`installTmpDir`) holds the server's sockets and must be
0700. Older servers created it with `mkdir({ recursive: true })`, which never
tightens an existing dir, and a containerless launch could create it at the
umask default first. So a host whose temp dir has not been cleared since
then can still hold one at 0755 (or 0775 under umask 002), with live
workspaces' tmux sockets in it. `ensureInstallTmpDir` in
`packages/shared/src/paths.ts` chmods such a dir to 0700 when this user owns
it, and if it was writable by others, removes the entries they own.

- **What it reads.** The mode of the install tmp dir, and the owner of each
  entry in it.
- **What breaks if it goes too early.** A server started against such a dir
  refuses to start, and the obvious way out, removing the dir, orphans
  every running containerless workspace, whose tmux socket goes with it.
- **When it is safe to remove.** Once no host can still hold a tmp dir an
  older server created, which is after every one has rebooted (or had its
  temp dir cleared) since running a yaac with this function. The refusals
  of a symlink and a foreign owner stay.

## A custom sign-in that carries its own endpoint

An opencode, pi or omp sign-in with the `custom` provider names one of its
user's custom endpoints by id (`endpointId`, docs/custom-endpoints.md). One
written before endpoints were their own rows carries the endpoint inline
instead: `endpoint: { baseUrl, models }`, with the key on the sign-in. Two
pieces cover it, and they go together:

- `importEmbeddedEndpoints` (`#domain/auth`), run at server start before
  anything reads a sign-in, moves each such sign-in onto an endpoint row of
  its owner's (sign-ins sharing a URL and key share one) and rewrites it to
  name that row.
- The credential file schemas (`apiKeyToolCredentialsFileSchema` in
  `@yaac/shared/types`) still accept the inline `endpoint` with model ids,
  so the importer can read the old sign-ins at all. The same field also
  carries the URL to the runtime, which stays.

- **What it reads.** Every user's stored opencode, pi and omp sign-ins, at
  each server start.
- **What breaks silently if it goes too early.** A tool signed in to a
  custom endpoint reads as signed out (its sign-in names no endpoint), so its
  workspaces stop being creatable, and the URL, key and model list the user
  entered are gone from the settings page.
- **When it is safe to remove.** Once every install has started a server
  that carries the importer at least once: from then on no stored sign-in
  has an inline `endpoint` without an `endpointId`. Remove the importer
  first or together with narrowing the schema's `models` field, never the
  schema first, since the importer cannot read what the schema refuses.

## An opening message stored over the 130 KB prompt cap

A `tui` agent takes its opening message as one command-line argument, so
prompts are capped at what one holds (`MAX_PROMPT_BYTES`, 130,000 UTF-8
bytes). Every write checks that, but an older install capped prompts at
200,000 characters, and what it stored can still be launched: a queued
entry, a routine, or a session a restart launches for the first time.
`sessionLaunches` in `packages/server/src/domain/workspaces/session-launch.ts`
refuses a `tui` opening message over the cap with a message saying to
shorten it, so the create or queued run fails visibly. An `acp` one goes
over the protocol whole, so it needs no check.

- **What it reads.** A session's stored opening message as it launches,
  which comes from a `sessions`, `queued_workspaces`, `routines` or
  `draft_workspaces` row's `prompt`.
- **What breaks silently if it goes too early.** The agent's launch fails
  on a too-long argument (`E2BIG`): its pane dies at once, the session
  lists as exited, and the message is gone, since the launch has already
  deleted the file it was read from.
- **When it is safe to remove.** Once no stored prompt is over the cap:
  `octet_length` of `sessions.first_prompt` (for sessions not yet
  launched), `queued_workspaces.prompt`, `routines.prompt` and
  `draft_workspaces.prompt` is at most 130000 in every install's database.

## Claude memory under `-repo`

A project keeps one claude auto-memory per repo, in
`claude/projects/-repo-<repo id>/memory` (docs/workspace-storage.md "Agent
history"). While a project had exactly one repo its memory was
`claude/projects/-repo/memory`. `moveLegacyMainClones`
(`packages/server/src/domain/repos/legacy-main-clones.ts`) runs at every
server start and renames that folder to the one named for the repo the
project had then: the one carrying the project's id, or for a project that
was a share the repo it links. It leaves a relative symlink at `-repo`,
because a containerless workspace started before the upgrade links its
memory through that name until it restarts (a pod keeps its mount of the
renamed folder).

- **What it reads.** A real `claude/projects/-repo` directory under each
  project dir, and the symlink it leaves there.
- **What breaks silently if it goes too early.** claude in every workspace
  of a project never started since the upgrade begins with an empty memory,
  and the old one sits unread on disk. With the symlinks gone, a
  containerless workspace not restarted since the upgrade writes memory
  nothing else reads.
- **When it is safe to remove.** The rename: once no project dir holds a
  real `claude/projects/-repo`. The symlinks: once every containerless
  workspace created before the upgrade has been restarted or deleted.

## Main clones under the project dir

Each repo's main clone is `global/repos/<repo id>`. An install from before
repos were rows of their own kept one per project, at
`global/projects/<project id>/repo`. `moveLegacyMainClones`
(`packages/server/src/domain/repos/legacy-main-clones.ts`) runs at every
server start and moves what it finds there:

- A project whose repo carries its id (the `add_repos` migration gave every
  project such a repo, except a share) has its clone renamed into place.
- A project that was a share links the repo it was shared from, so its own
  clone is no longer used. Every object it holds, reachable or not, is
  copied into the clone it now uses (`absorbClone`), and it is removed once
  none of the project's workspaces runs, since a pod started before the
  upgrade still mounts it.

Either way a relative symlink is left at the old path, because the
alternates file of a checkout made before the upgrade names it until its
workspace restarts (a restart rewrites it, `buildCloneLinkExec`). A start
that finds the clone moved and no link there (the server died in between)
makes the link.

- **What it reads.** A real `repo` directory under each
  `global/projects/<id>/`, and the symlinks it leaves there.
- **What breaks silently if it goes too early.** A project never started
  since the upgrade has no main clone where the server looks, so its
  creates fail to fetch. With the symlinks gone, a workspace not restarted
  since the upgrade loses the objects its checkout borrows: git there
  reports missing objects, in a pod or a stopped workspace's file reads.
- **When it is safe to remove.** The mover: once no `global/projects/<id>/`
  holds a real `repo` directory. The symlinks: once every workspace created
  before the upgrade has been restarted or deleted, which no row records; a
  checkout whose `.git/objects/info/alternates` names `projects/<id>/repo`
  is one that has not.

## Hosted URLs naming a project

A user's own git reaches a hosted repo at `<origin>/api/repo/<repo id>/git`.
While a project had exactly one repo that was
`<origin>/api/project/<project id>/git`, which is what every clone made
with `yaac project clone` then carries as its `origin`. The three
`/:projectId/git/…` routes in `packages/server/src/api/routes/projects.ts`
still answer it: the id is a repo's too (every repo from then carries its
project's id), or a former share's project (the next entry).

- **What it reads.** The id in `/api/project/<id>/git/…`, as a repo id.
- **What breaks silently if it goes too early.** Nothing silently: a clone
  made before the upgrade gets "repository not found" on its next fetch or
  push, until its owner runs `git remote set-url origin
  <origin>/api/repo/<id>/git`.
- **When it is safe to remove.** Once no user's clone still names
  `/api/project/<id>/git`, which the server cannot see; the access log
  showing no request to those routes for a release is the evidence.

## Pods whose ssh trusts the git host

No code: a note for an upgrade. The proxy ends a workspace's ssh sessions
to git hosts itself (docs/workspace-egress.md "Git over SSH"), so a pod's
`GIT_SSH_COMMAND` trusts the proxy's host key. A pod launched while the
proxy only tunnelled ssh trusts the git host's own key and holds an agent
socket the proxy no longer serves, and both are fixed at launch.

- **What it reads.** Nothing; no shim covers it.
- **What breaks.** In a k8s workspace with an ssh remote that has run since
  before the upgrade, the next `git fetch` or `push` fails with OpenSSH's
  "REMOTE HOST IDENTIFICATION HAS CHANGED". Restarting the workspace fixes
  it.
- **When this note can go.** Once no such pod is running.

## Hosted URLs naming a share

A hosted repo's remote is `http://yaac.internal/api/workspace/git/<repo
id>.git`. Before repos were shared, a share was a project of its own whose
checkouts' `origin` named the share project's id there. That project now
links the repo it was shared from, so `hostedRepo` in
`packages/server/src/domain/repos/hosted.ts` answers an id that is a
project's rather than a repo's with that project's one hosted repo. A
restart points such a checkout's `origin` at the repo's own URL
(`buildCloneLinkExec`).

- **What it reads.** The id in a hosted git URL, against `projects.id`.
- **What breaks silently if it goes too early.** A workspace of a former
  share that has not restarted since the upgrade cannot fetch or push:
  its git answers "repo not found" for a remote that exists.
- **When it is safe to remove.** Once every workspace of a project that was
  a share before the upgrade has been restarted or deleted. No row records
  which projects those were; a checkout whose `remote.origin.url` names an
  id that is no repo's is one that has not.

## Step rows with an empty workflow name

Every step belongs to a workflow and is known as `<workflow>.<step>`
(docs/workspace-steps.md "Workflow names"). The `key_steps_by_workflow`
migration gave each step row of a life already running an empty workflow
name, since its window and log files run under its bare name, and a site's
release runs for months. An empty name reads as "known by the bare name":
`stepFullName` (`@yaac/shared/steps`) answers the bare name for it, a need
in a graph beside it falls back to a bare step of that name (`needsOf` in
`#domain/workspaces` `steps.ts`), and `addSteps` lets a step added to such a
life need one by its bare name. Every life started since names its
workflows. The rows of a life from before the upgrade keep the empty name
for as long as their workspace exists, as its history, and so does that
life's workflow row. Those are what the shim keeps readable afterwards: the
webapp's step list and `yaac workspace logs` / `yaac-mama logs` of those
lives, whose log files carry bare names.

- **What it reads.** `workspace_steps.workflow_name = ''`, and the
  `workspace_life_workflows` row named `''` those steps belong to.
- **What breaks silently if it goes too early.** A workspace or release
  running since before the upgrade loses track of its steps: their windows
  are looked for under `<workflow>.<step>`, found nowhere, and its running
  steps are marked cancelled after the launch grace, a release's deploy
  failing or its service never restarting. On a stopped workspace, the
  steps of its old lives no longer line up with their bare-named logs.
- **When it is safe to remove.** Once no workspace that still exists, and
  whose old logs still matter, has a step row with an empty workflow name
  (`SELECT DISTINCT workspace_id FROM workspace_steps WHERE workflow_name =
  ''` lists them). The count does not reach 0 by itself: every life keeps
  its rows, so deleting the workspaces it lists (or accepting their old
  lives' steps read oddly) is what clears it.

## A site's repo with no branch

Sites name their repos, each at a branch or a commit
(docs/public-sites.md "Sites and releases"). The `add_site_repos` migration
moved each site's one repo into `sites.repos` at the branch it followed; a
site that followed nothing deployed its repo's default branch, which only
the main clone knows, so the migration left that repo with neither branch
nor commit. At start, after the main clones are where they belong,
`backfillSiteBranches` (`#domain/sites`, `deploys.ts`) writes each such
repo's main clone default branch into it. Until it has, a deploy reads the
default branch itself (`settingOf`). No new site can name a repo without a
branch or commit.

- **What it reads.** `sites.repos` entries with neither `branch` nor
  `commit`.
- **What breaks silently if it goes too early.** Removing the backfill and
  `settingOf`'s fallback together leaves such a site with a repo naming
  nothing, so its next deploy, replacement or follow pass fails to resolve a
  commit and the site stops deploying. Removing only the backfill leaves it
  deploying the remote's current default branch, so a default branch
  renamed on the remote changes what the site serves without a word.
- **When it is safe to remove.** Once every install has started a server
  with the backfill since the migration, and its log shows no "naming its
  repo's default branch failed": then no site row has a repo with neither
  (`SELECT name FROM sites, jsonb_array_elements(repos) r WHERE NOT (r ? 'branch' OR r ? 'commit')`
  answers nothing). Remove the backfill and `settingOf`'s fallback to
  `getDefaultBranch` together.

## The unsuffixed Cloudflare tunnel

The Cloudflare tunnel's Deployment, Secret, two NetworkPolicies and `app`
label are `yaac-site-tunnel-cloudflare`. Older installs named them
`yaac-site-tunnel`. Two pieces of `cluster/site-edge.ts` carry an install
across, and go together:

- `ensureSiteEdge` copies the token from the Secret `yaac-site-tunnel` to
  the new Secret when only the old one exists, rolls out the new
  Deployment, and then deletes the four old objects (on every run, so the
  old policies an install without a tunnel kept also go).
- The router's ingress policy admits pods labelled `app: yaac-site-tunnel`
  as well as the new label, so the old cloudflared replicas keep reaching
  the router while the new ones roll out.

- **What it reads.** The Secret `yaac-site-tunnel` in the install's
  namespace, and the `app: yaac-site-tunnel` pod label.
- **What breaks silently if it goes too early.** An install that has not
  run `yaac cluster install` since the rename keeps its token only under
  the old name, so the next install without `CF_TUNNEL_TOKEN` finds no
  Secret and removes the tunnel: every public site goes down until someone
  supplies the token again. Without the second label, the old replicas are
  cut off from the router the moment install re-applies its policy, before
  the new ones are ready.
- **When it is safe to remove.** Once no supported upgrade starts from a
  version that applied `yaac-site-tunnel`; on a given cluster, once
  `kubectl get secret,deploy,networkpolicy -l app=yaac-site-tunnel` finds
  nothing.

## A route table without the tailnet file

The site router's bootstrap names three route files in the ConfigMap
`yaac-site-routes`: `rds.json`, `rds-tailnet.json` and `cds.json`. A server
from before tailnet sites wrote only the first and last. Install creates the
table empty only when absent, since the server owns it, and the new server
rewrites it only once it is deployed, after the site edge. So
`ensureRouteFiles` in `cluster/site-edge.ts` adds any file the table lacks,
empty, and keeps the files the server wrote.

- **What it reads.** The keys of the `yaac-site-routes` ConfigMap.
- **What breaks silently if it goes too early.** The first `yaac cluster
  install` over an older install leaves the new router crash-looping
  (Envoy will not start while a file it names is missing), logs only a
  note, and skips both site tunnels for that run, so a `--site-domain` with
  `TS_SITE_AUTHKEY` deploys no tailnet tunnel until install runs again.
  The old router keeps serving meanwhile.
- **When it is safe to remove.** Once every install's server has run a
  version with tailnet sites, which rewrites the table with all three files;
  on a given cluster, once `kubectl get configmap yaac-site-routes -o
  jsonpath='{.data}'` names `rds-tailnet.json`.

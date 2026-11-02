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

## A `yaac-mama send` script that arrives empty

A `yaac-mama send` to a `tui` agent runs a delivery script the server writes
to the exec's stdin (`buildMessageCmd` in
`packages/server/src/runtime/agents/agent-command.ts`). Under k8s, a pod's
streamd only passes stdin on since exec learned its `stdin` byte count
(docs/stream-relay.md). An older streamd, baked into the base image of a pod
started before then, ignores the count and runs the command with an empty
stdin, so the command checks that a script arrived and exits 2 if none did.

Only `send` needs it. A create's initial prompt never reaches an older pod:
it gets a fresh pod, or a spare, and a spare warmed before the server
restarted is stale and never claimed.

- **What it reads.** The script the command read from stdin.
- **What breaks silently if it goes too early.** A `send` to a workspace
  still running a pod started before the upgrade runs an empty script and
  exits 0, so the sender is told "Sent to …" and the agent gets nothing.
- **When it is safe to remove.** Once no running workspace pod predates the
  streamd that reads exec stdin. A restart moves a workspace onto the
  current base image, so it suffices that every workspace running at the
  upgrade has stopped or restarted since. Containerless workspaces never
  needed it.

## `ephemeralModulesPaths` in a project's yaac-config.json

A project's scratch dirs are a column on its row
(`projects.scratchDirs`, docs/project-config.md). They used to be a
`yaac-config.json` key, which the config parser now refuses as unknown. At
start, before anything reads the config, the server runs
`importScratchDirsFromConfig` (`#domain/projects`): for each project
whose config file still has the key, it copies the value onto the row, each
dir with no cap of its own, and rewrites the file without it. A file that is not JSON, or a value that does
not validate, is logged and left for the user to fix, and until then the
parser's error for the key (`RETIRED_FIELDS` in `domain/projects/config.ts`)
says where the setting went. Delete that hint along with the import.

- **What it reads.** Every project's `yaac-config.json` under its config dir.
- **What breaks if it goes too early.** Not silent: every create in a
  project whose file still has the key fails with `unknown field
  "ephemeralModulesPaths"` until someone edits it out, and the list they had
  set, `[]` or extra nested `node_modules`, is lost unless they re-enter it
  as the project setting.
- **When it is safe to remove.** Once every install has started a server
  with the import at least once. No config file then has the key, which
  `grep -l ephemeralModulesPaths ~/.yaac*/global/projects/*/config/yaac-config.json`
  confirms for a given data dir.

## A workspace row with no `scratchDirs`

A stop removes the scratch dirs a workspace was started with, recorded on its
row (`workspaces.scratchDirs`) by the create, restart or spare claim. A
workspace whose runtime started before that column existed has it null. Two
pieces cover it, and both go together:

- `importScratchDirsFromConfig` (see the entry above), when it moves a
  project's `ephemeralModulesPaths`, also fills that project's null rows with
  the moved list (`backfillWorkspaceScratchDirs` in `#db`), since every null
  row then is a workspace started with it.
- `checkoutScratchDirs` (`#domain/workspaces` cleanup) treats a row still
  null as started with the old default, `node_modules` alone. It never reads
  the project's current list, which the migration set to `node_modules` and
  `target` and which says nothing about what an older runtime mounted.

- **What it reads.** Each project's config file at start; at stop, the
  workspace row's null `scratchDirs`.
- **What breaks silently if it goes too early.** A workspace running at the
  upgrade is stopped without its scratch dirs being removed: under k8s that
  leaves empty mount points, under containerless a full copy of every
  dependency in its checkout. Reading the project's list instead would be
  worse, since it deletes a `target/` the workspace keeps in its checkout.
- **When it is safe to remove.** Once no running workspace has a null
  `scratchDirs`, that is once every workspace running at the upgrade has
  stopped:
  `SELECT count(*) FROM workspaces WHERE scratch_dirs IS NULL AND stopped_at IS NULL`
  is zero. A stopped one restarted later without the fallback only keeps its
  old `node_modules` contents, which its init commands install over.

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

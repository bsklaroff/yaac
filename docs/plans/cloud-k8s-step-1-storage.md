# Cloud k8s, step 1: storage — claims on kind, data dir untouched

Implementation plan for step 1 of docs/plans/cloud-k8s.md. Read that
document's "Where things stand", "Decisions" and "Invariants to keep"
first; this one restates none of them and plans nothing past step 1.

One naming decision here supersedes the parent plan's wording: the three
tiers are three explicit subfolders of the data dir, `global/`,
`server-local/` and `node-local/`, and the tier the parent calls SHARED is
called GLOBAL everywhere — folder, helper, claim, env var and pod path —
so that one word names one thing. The parent's "`yaac-shared` binds
`<dataDir>` itself" becomes "`yaac-global` binds `<dataDir>/global`"; the
parent doc is updated in the commit that lands the layout (see "Docs").

Steps 2, 4 and 5 of the parent have shipped since this plan was first
written, and it is written against that tree: the proxy mounts nothing from
the host and `.credentials/` is already SERVER-LOCAL; the server's fronting
is a `ServerFronting` handed to `deployServerWorkload`, and the token mint
already reads the pod's lock through `YAAC_SERVER_LOCAL_ROOT`; the images
bake no uid and every yaac pod runs as `hostUidSecurityContext()`.

## Outcome

When this lands, on kind:

- The server pod mounts two PersistentVolumeClaims, `yaac-global` (RWX)
  and `yaac-server-local` (RWO), plus a node hostPath for the NODE-LOCAL
  tier, at three fixed pod paths. Every worktree pod mounts subPaths of
  `yaac-global`; nothing under the data dir is mounted by hostPath any
  more. Each claim is bound to a static hostPath PersistentVolume that
  install renders into the host's data dir, so the bytes stay on the host
  disk under `~/.yaac`, and `yaac cluster delete` keeps touching none of
  them.
- The data dir has three subfolders, one per tier, on every substrate:
  `<dataDir>/global`, `<dataDir>/server-local` and `<dataDir>/node-local`
  on a host; three mount points inside the pod. An existing data dir is
  moved into that shape once, by a one-shot rename that runs on the host,
  all-or-nothing, before anything else reads the data dir (see "The
  migration, and its order against every other shim"). `getDataDir()` is
  unchanged, so `dataDirHash()`, every label, every claim name and every
  row carry over.
- The k8s driver resolves a mount's source from the tier root its path
  lives under. Domain code goes on declaring `hostPath` sources against the
  tier helpers exactly as today; the containerless driver goes on
  symlinking them.
- NODE-LOCAL directories are created by an init container on the
  worktree's node, and swept by per-node one-shot pods, so nothing about a
  node's disk is read or written from the server's own filesystem.
- opencode's history lives in the global tier and nowhere else durably.
  A k8s pod works on a node-local copy of it, checkpoints on a timer,
  and on stop checkpoints once more and deletes the copy; every start
  restores from the global store. Containerless uses the global store
  directly.
- `yaac cluster check` proves the claim, not the extraMount: the nonce
  probe and the per-node `volume-nodes` sweep write through `yaac-global`,
  and a `storage` gate reports the claims' binding and the POSIX semantics
  of what backs them.
- The e2e harness renders a claim pair per test namespace with static PVs
  into the file's own data dir, the way it already renders per-namespace
  RBAC.

Gate: the e2e suite green on kind, one node and three, plus the
verification procedure at the end of this document.

## The layout

One set of names for every backend, chosen here and used everywhere below.

| Tier | Host folder (containerless, and kind's PV path) | Pod mount point | Env var the Deployment sets | Backing on kind |
|---|---|---|---|---|
| GLOBAL | `<dataDir>/global` | `/yaac/global` | `YAAC_GLOBAL_ROOT` | PVC `yaac-global` → PV `yaac-global-<dataDirHash>` → hostPath `<dataDir>/global` |
| SERVER-LOCAL | `<dataDir>/server-local` | `/yaac/server-local` | `YAAC_SERVER_LOCAL_ROOT` | PVC `yaac-server-local` → PV `yaac-server-local-<dataDirHash>` → hostPath `<dataDir>/server-local` |
| NODE-LOCAL | `<dataDir>/node-local` | `/yaac/node-local` | `YAAC_NODE_LOCAL_ROOT` | hostPath `/var/lib/yaac/node/<dataDirHash>` on the node, which a kind extraMount binds to `<dataDir>/node-local` |
| CLIENT-LOCAL | `<dataDir>-client` | never mounted | — | — |

`YAAC_DATA_DIR` keeps naming the host's data dir inside the pod. It is an
identity string there and a directory only on the host. The data dir root
itself holds nothing but the three tier folders — plus, on a test rig, the
harness's `e2e-tmp/`, and on an install that predates the client-local
tier, the `remote.json` / `.auth-daemon.lock` / `driver` files their
fallback readers still look for at the root (docs/legacy-compat-shims.md).
Neither is a tier path and neither sits inside any claim.

What moves on the host, once, for an existing data dir, in this order:

| # | From | To | Tier |
|---|---|---|---|
| 1 | `secret.key` | `server-local/secret.key` | SERVER-LOCAL — first, so no state can exist in which a database has moved without its key |
| 2 | `.credentials/` | `server-local/.credentials/` | SERVER-LOCAL |
| 3 | `db/` | `server-local/db/` | SERVER-LOCAL |
| 4 | `server.log` | `server-local/server.log` | SERVER-LOCAL |
| 5 | `build/` (Dockerfile.user and its context) | `server-local/build/` | SERVER-LOCAL |
| 6 | `models/` | `server-local/models/` | SERVER-LOCAL |
| 7 | `projects/` | `global/projects/` | GLOBAL |
| 8 | `run/proxy-data/` | `global/run/proxy-data/` | GLOBAL — read by `seedProxyObjects` through `sharedPath`, so it moves with that helper |
| 9 | `global/projects/<slug>/.cached-packages/` | `node-local/projects/<slug>/.cached-packages/` | NODE-LOCAL, per slug, after row 7 |
| — | `.server.lock` | never moved | see "The migration" — a live one refuses the run, a stale one is unlinked |
| — | `shared-images/` | not moved; deleted by hand | its generations are root-owned, and `rename(2)` of a directory into a new parent needs write permission on the directory itself; it is a re-derivable cache and the install log prints the `rm -rf` |
| — | `run/ssh-pub/` | not moved | content-keyed public key files, regenerated on demand by `contentKeyedFile` |

Each moved row is one `rename(2)` on the same filesystem, so the whole move
is metadata and takes no time proportional to the data. `run/` is removed
once row 8 empties it. `global/projects/<slug>/opencode-data/<id>` is NOT
moved out of the projects tree: it becomes the GLOBAL checkpoint directory
(see "opencode"), so a pre-existing opencode database is a checkpoint
already, carried into place by row 7 and never converted.

The node path carries `dataDirHash()` so two installs on one cluster (the
real one and every e2e namespace) never share a node directory. The pod
paths carry no hash: a pod belongs to one install.

## Decisions this step makes

- **GLOBAL is the word, and it names a folder.** The parent plan's SHARED
  tier had no folder of its own because it was the data dir root; giving
  it one means the root holds exactly the three tiers and nothing else,
  and it means the root can never again be mounted anywhere by accident.
  The rename is mechanical and lands in the first commit: `sharedRoot` →
  `globalRoot`, `sharedPath` → `globalPath`, `sharedProjectPath` →
  `globalProjectPath`, the tier legend's SHARED → GLOBAL, and the mount
  list's comments. The cost is that `projects/` moves once, which is one
  rename.
- **One layout for both drivers.** The three roots default to the three
  folders whether or not the env vars are set. The host CLI must read what
  the pod writes into SERVER-LOCAL (`yaac server logs` reads the log,
  `deployServerWorkload` refuses on a live host lock), so the host's answer
  for SERVER-LOCAL has to be the PV's path, and a driver-conditional
  default would put a `server.json` read in every path helper. What "the
  split is inert under containerless" means is that the roots are three
  subdirectories of one directory there and no volume machinery applies —
  not that the layout differs. The one-shot rename therefore runs on both
  substrates: at install time for k8s, at server start for containerless.
- **The migration is the first thing a host process does with the data
  dir, and it is all-or-nothing.** Its rules are their own section below,
  because every other legacy-compat shim reads a path the migration moves,
  and the order between them is where data would be lost.
- **Prefix mapping in the k8s driver, nothing new on the contract.** The
  contract's `MountSource` already has the `pvc` arm; the driver rewrites
  a `hostPath` source by which tier root its path is under. The three
  roots are siblings on the host and inside the pod, so the mapping is a
  plain prefix test with no ordering concern. A path under SERVER-LOCAL,
  or under no root at all, is a thrown error: a pod may not mount the
  server's claim, and every product path is tiered.
- **A `File` mount becomes a subPath to a file.** kubelet bind-mounts an
  existing file at a subPath; a subPath that does not exist is created as
  a root-owned directory. The `type: File` guard that used to fail such a
  mount loudly is therefore replaced by the ordering the create already
  has: `ensureSessionStartsLog` and `stageWorktreeBin` run before the Job
  is applied. That ordering gets a unit test.
- **The node-local init container is the pod's own image as root.** It runs
  under the pod's RuntimeClass like every other container of the pod, so
  no extra image and no extra pull. It `mkdir -p`s and chowns to the pod's
  `runAsUser:runAsGroup` (the host identity `hostUidSecurityContext()`
  stamps on every worktree pod) each node-local directory the mount list
  names, because hostPath ignores `fsGroup` and `DirectoryOrCreate` makes
  root-owned directories. On kind the node path is host disk (through the
  extraMount) and on macOS a chown through virtiofs is cosmetic, which is
  fine: the host uid owns everything on that side anyway
  (docs/server-in-cluster.md, "The uid everything runs as").
- **Node-local sweeps are a driver verb.** The domain keeps the global half
  of the orphan GC (spare state, session-starts logs, global
  `sessions/<id>`) and hands the node-local half to a new contract verb,
  `reapNodeLocal`. k8s answers with one root pod per node running an
  `rm -rf` script over a keep-list; containerless answers with the
  `fs.rm` loop the domain runs today, moved into its driver. Project
  removal takes the same route: `removeNodeImageStore` generalizes to
  `removeNodeLocalProject`, one pod per node removing the project's node
  tree and its image store together.
- **The global opencode store is the only source of truth; node-local is
  a working copy that exists only while the pod runs.** A checkpoint is
  the node-local opencode data directory copied file-for-file, except the
  SQLite file, which is produced by the backup API and renamed into place.
  Every start restores from the global store unconditionally — the
  node-local directory is emptied first, so a stale copy left by a
  failed stop can never outrank the checkpoint. The pod checkpoints on a
  timer while running, and in `preStop` it checkpoints one last time and,
  on success, deletes the node-local copy. So after a clean stop the node
  holds nothing for that worktree; after an unclean one it holds a copy
  the next start overwrites and the sweep collects. Choosing the plain
  copy as the format is what makes today's `opencode-data/<id>` directory
  a valid checkpoint with nothing to convert.
- **`nodeLocalWorktreeStateDir` is deleted, not re-rooted.** Nothing has
  written under `projects/<slug>/sessions/<id>` on the node-local side
  since the tmux socket became an emptyDir, and with the roots now
  different an empty declared slot is a directory the sweep walks for
  nothing. It goes, along with `worktreeStateRoots` and
  `projectWorktreeStateRoots`; their callers use `worktreeStateDir` and
  its parent directly. The node-local tier then holds exactly four things
  (the pnpm store, the ephemeral module dirs under it, the opencode
  working copy, the image store) and `projectsRoots()` stays only because
  the orphan sweep still has to see a project whose global half is gone.
- **No new CLI flags.** `--nodes` renders the second extraMount onto every
  node; `--adopt-cni` gets the claims too (it needs a StorageClass-free
  static PV pair like kind's, which is wrong for a real cloud cluster and
  right for the adopted-kind rehearsal — `--byo` in step 6 replaces it).
  `--tailnet` is orthogonal: it changes the fronting, not the storage.
- **The server's ClusterRole is unchanged.** Install applies the PVs and
  PVCs from the CLI's kubeconfig; the server only references the claim
  names. The e2e harness applies its own from the developer's kubeconfig.

## The migration, and its order against every other shim

`migrateDataDirLayout` (`shared/data-dir-layout.ts`) is the one place the
data dir is rearranged, and these are its rules. They exist because the
tree already carries ten legacy-compat shims that read paths this
migration moves, and each of them is a way to lose data if it runs first.

**When it runs.** Three call sites, all on a host, none in a pod:

- `runServer` (`main/server-run.ts`), when `!env.inCluster`: before
  `ensureDataDir()`, before the lock is read, before the DB is opened.
  Nothing on the data dir precedes it.
- `startServer` (`main/lifecycle.ts`): same position, so the "already
  running" decision reads the migrated lock.
- `deployServerWorkload` (`install/server-deploy.ts`): after
  `refuseIfHostServerRunning`, and after the server Deployment — if one
  exists — has been scaled to zero and its pod is gone (`stopClusterServer`,
  which already waits on the pod's deletion). Only then is the data dir
  quiescent: the old pod holds PGlite open by path and heartbeats its lock
  by path, and renaming `db/` under a running server is a corrupt or
  stranded database. Install already rolls the server; stopping it first
  costs the operator nothing they were not already paying.

**Why before `ensureDataDir`.** `ensureDataDir` creates `global/projects`;
run first, it would leave an empty destination for row 7. The migration
therefore treats an EMPTY existing destination directory as absent (rmdir,
then rename) as well, so the order is enforced by code rather than only by
call placement. A NON-empty destination beside a still-present source is a
mixed layout the migration cannot resolve on its own, and it refuses to
start the server (see below) rather than guess which half is current.

**All or nothing.** The rows are attempted in the table's order; each is
one `rename(2)`. A row that fails for any reason other than "source
absent" (EACCES, EXDEV, ENOTEMPTY on a non-empty destination) aborts with
the row named and the server does not start — `runServer` exits nonzero,
`startServer` prints the error, install stops before deploying. A
partially completed run is not a corrupt state: every completed row is
atomic and the next run resumes at the first row whose source still
exists. What the abort prevents is a server running on a half-moved tree,
which is the only way the shims below can do harm.

**The order of the rows is load-bearing.** `secret.key` moves before
`db/`: a server that found a database without its key would generate a
fresh key at the new path and seal every new row with it, after which the
old rows are unrecoverable by anything but a hand-copied file. With the
key first, an interrupted run leaves a key with no database beside it,
which the next run completes. `.credentials/` moves before `projects/`
for the importer described next.

**The lock.** A live lock at the old root path means a pre-split server
holds this data dir; the migration throws, naming `yaac server restart`
(containerless) or `yaac cluster install` (k8s, where install's own
stop-first sequencing means this cannot happen). A stale lock at the old
path is unlinked. The lock is never moved: the new server writes its own
at the new path. `readLock`/`removeLock` fall back to the old path when
the new one has no lock, which is what lets `yaac server start|stop|
restart` see and stop a pre-split server that is still running.

**Root-level files the migration must not touch.** `remote.json`,
`.auth-daemon.lock` and `driver` at the data dir root belong to the
pre-client-local fallback readers, which spell the root explicitly after
this step (today they go through `serverLocalPath`, which would send them
to `server-local/`). The migration's table is a whitelist; those three
files are not on it and stay where their readers look.

**Every other shim, and where it stands relative to the move.** All read
through the tier helpers, so once the migration has run they find the
moved location; none of them may run before it, and the call placement
above guarantees they do not.

| Shim (docs/legacy-compat-shims.md) | What it reads, after this step | When it runs | Relation to the migration |
|---|---|---|---|
| `adoptProjectDirs` | `global/projects/*/project.json` | every `listProjectRows`, after the DB is open | After. Its only failure mode here is an empty `global/projects` shadowing a full `projects/`, which the empty-destination rule prevents. |
| `importLegacyProjectConfig` | `global/projects/<slug>/config/yaac-config.json`, and `server-local/.credentials/proxy-secrets.json` as the value source | `importLegacyState`, after the DB is open | After, and it is the reason the migration is all-or-nothing: run on a tree where `projects/` had moved but `.credentials/` had not, it finds the overlays, finds no values, imports valueless rows and STRIPS the keys from the overlays — after which the values still sitting in the un-moved file are orphaned for good. |
| `sweepLegacyProxySecretsFile` / `legacySecretImportPending` | the same secrets file | after a completed proxy rollout | After. Deletes at the new path only; an interrupted migration leaves nothing there to delete. |
| `seedProxyObjects` | `global/run/proxy-data/` (`sharedPath`, renamed `globalPath`), from the server pod's own mount | inside `ensureProxyResources`, first proxy roll after an upgrade | After. Row 8 is what puts the old proxy's CA where the seed looks inside the pod (`/yaac/global/run/proxy-data`); without it an install jumping from pre-step-5 to post-step-1 would mint a new CA and every running agent's TLS trust would break. The directory is never deleted. |
| The `/etc/yaac/agent-links.sh` strip | `global/projects/<slug>/claude/settings.json` | per create | After. |
| `adoptLegacyClaudeJson` | `global/projects/<slug>/claude.json` | per create | After. |
| The spent-mountpoint reclaim | the tool homes' `skills/` dirs under `global/projects/<slug>/` | per create | After. Its root-owned mountpoints move with `projects/` (only the renamed directory's own permission matters, and `projects/` is the user's). |
| `sweepLegacyVclusterState` | `vcluster/`, `nested-yaac/` under `global/projects/<slug>/sessions/<id>/` | k8s driver attach | After. Root-owned residue moves the same way. |
| The optional lease fields | the lock, wherever it is read | every lock read | Independent, but the fallback read above is what lets a pre-lease AND pre-split lock at the root still be parsed. |
| The pre-client-local read fallbacks | `<dataDir>/remote.json`, `.auth-daemon.lock`, `driver` at the ROOT | every client read | Untouched by design, with their spelling corrected to the root. |
| `seedLegacyGitIdentity`, the `virtualCluster` key, the spawn channel, `remote.json` → `server.json`, the `driver` record, the token name | environment, config keys, client-local files, the API | — | Read nothing the migration moves. |

**What the pre-upgrade k8s pods hold.** A worktree pod created before this
step bind-mounts `projects/<slug>/…` by its old hostPath, and the old proxy
(if the install skipped step 5) bind-mounts `.credentials/` and
`run/proxy-data/`. A bind mount holds its dentry, so renaming an ancestor
underneath it leaves the running pod's view intact; those pods keep working
until they stop, and the new server addresses the same bytes under the new
names. Verified on the rig with a running worktree in step 3 of the
procedure.

**What the e2e suite cannot prove.** Every tier starts from a fresh data
dir, where this is a no-op. The one executable check is the
e2e-containerless case that rebuilds the OLD layout by hand and starts a
server on it (see "Tests"); the k8s upgrade path is step 3 of the
procedure, run against the rig's real pre-step-1 data dir.

## Changes by module

### `packages/shared`

**`src/env.ts`** — three accessors: `globalRootOverride`,
`serverLocalRootOverride`, `nodeLocalRootOverride`, reading
`YAAC_GLOBAL_ROOT`, `YAAC_SERVER_LOCAL_ROOT`, `YAAC_NODE_LOCAL_ROOT`.
Unset → `undefined`. The tier-legend comment there names the Deployment as
their only setter.

**`src/paths.ts`**

- `sharedRoot()` becomes `globalRoot()` → override ?? `path.join(getDataDir(),
  'global')`; `sharedPath` → `globalPath`, `sharedProjectPath` →
  `globalProjectPath`.
- `serverLocalRoot()` → override ?? `path.join(getDataDir(), 'server-local')`.
- `nodeLocalRoot()` → override ?? `path.join(getDataDir(), 'node-local')`.
- `installTmpDir()` hashes `getDataDir()` instead of `serverLocalRoot()`.
  Same value as today (the two are equal), and it is the install identity
  that is meant; left alone, every running containerless worktree's tmux
  socket directory would change name on upgrade and the recovery scan
  would read them all as dead.
- The tier legend is rewritten in the present tense: the three roots ARE
  three folders of the data dir; the pod's are mount points named by the
  Deployment; the data dir root holds nothing else of yaac's.
- `ensureDataDir()` creates `<global>/projects` and `serverLocalRoot()`.
  Not `nodeLocalRoot()`: on k8s that is the node's, created by the init
  container; on containerless it is created lazily by the driver
  (below).
- New constants beside `CONTAINER_SESSION_STARTS_LOG`:
  `CONTAINER_OPENCODE_DATA = '/home/yaac/.local/share/opencode'` (today an
  inline string in create.ts) and
  `CONTAINER_OPENCODE_CHECKPOINT = '/home/yaac/.yaac/opencode-checkpoint'`.

**`src/project-paths.ts`**

- Every `SHARED` tag and `sharedProjectPath` call becomes GLOBAL /
  `globalProjectPath`. `credentialsDir()` is already `serverLocalPath('.credentials')`
  and stays.
- New `opencodeCheckpointDir(slug, worktreeId)`, GLOBAL:
  `globalProjectPath(slug, 'opencode-data', worktreeId)`. Its doc says
  why the path is the pre-split node-local location inside the projects
  tree.
- `opencodeDataDir` re-documented as the node-local WORKING COPY of that
  checkpoint, present only while the pod runs; path unchanged
  (`nodeLocalProjectPath(slug, 'opencode-data', id)`), which now resolves
  under `<nodeLocal>`.
- `cachedPackagesDir`, `imageStoreDir`: no code change; their doc comments
  drop the "same directory today" wording.
- `nodeLocalWorktreeStateDir`, `worktreeStateRoots`,
  `projectWorktreeStateRoots` and `projectRoots` are deleted (see
  "Decisions"). `projectsRoots()` stays and now genuinely returns two
  entries; its one caller, the orphan sweep, already iterates.

**`src/lock.ts`** — `readLock()` and `removeLock()` fall back to
`path.join(getDataDir(), SERVER_LOCK_FILENAME)` when the server-local path
has no lock (legacy shim above).

**`src/server-config.ts`**, **`src/auth-daemon.ts`** — the legacy paths
`legacyConfigPaths()` and `legacyAuthDaemonLockPath()` spell
`path.join(getDataDir(), …)` instead of `serverLocalPath(…)`. They meant
the data dir root when the tiers coincided; `serverLocalPath` now names a
directory those files were never in. `readLegacyDriverRecord` likewise.

**New `src/data-dir-layout.ts`** — `migrateDataDirLayout(log)`, exactly
the rules in the section above: the table's rows in order, `fs.rename`
when the source exists and the destination is absent or an empty
directory, throw on any other failure with the row named, the lock's
live/stale handling, the log line for the root-owned `shared-images/`
that is skipped. Idempotent, and a no-op on a fresh data dir. Runs on a
host only — never inside the pod, where the roots are mounts and a rename
across claims is a copy. Unit-tested in
`packages/shared/test/data-dir-layout.test.ts`.

### `packages/server` — db, lib, main

- `db/client.ts`, `lib/build-dirs.ts`, `domain/titles/llama-cpp.ts`,
  `domain/git/transport.ts`, `db/secret-key.ts`,
  `domain/projects/legacy-config-import.ts`,
  `drivers/k8s/cluster/legacy-proxy-seed.ts`: no change beyond the
  `shared*` → `global*` rename — every one already goes through a tier
  helper.
- `main/server-run.ts` `runServer`: `if (!env.inCluster) await
  migrateDataDirLayout(serverLog)` BEFORE `ensureDataDir()`. The pod skips
  it; a host process migrates its own data dir before it creates or reads
  anything. `importLegacyState()` keeps its place after `openDb()`, which
  is now guaranteed to be after the migration.
- `main/lifecycle.ts` `startServer`: the same call in the same place.
- `drivers/containerless/paths.ts`: no change (it reads `installTmpDir()`).

### `drivers/k8s/substrate`

**New `storage-constants.ts`** (zero-import vocabulary, like
`proxy-constants.ts`), exported through the barrel:

- `GLOBAL_CLAIM_NAME = 'yaac-global'`, `SERVER_LOCAL_CLAIM_NAME =
  'yaac-server-local'`.
- `POD_GLOBAL_ROOT = '/yaac/global'`, `POD_SERVER_LOCAL_ROOT =
  '/yaac/server-local'`, `POD_NODE_LOCAL_ROOT = '/yaac/node-local'`.
- `nodeLocalNodePath()` = `/var/lib/yaac/node/${dataDirHash()}` (in
  `kubectl.ts` beside `dataDirHash`, since it needs it).
- `LABEL_INSTALL_NAMESPACE = 'yaac.install-namespace'` — already spelled
  inline by the server RBAC and netd; lift it here.

**New `mount-sources.ts`**, exported through the barrel:

- `resolveMountSource(m: PodMount): PodMount` — `emptyDir` and `pvc` pass
  through; `hostPath` under `nodeLocalRoot()` → `{ kind: 'hostPath', path:
  nodeLocalNodePath() + rel, type: source.type ?? 'DirectoryOrCreate' }`;
  under `globalRoot()` → `{ kind: 'pvc', claimName: GLOBAL_CLAIM_NAME,
  subPath: rel }` (a `File` type simply becomes a subPath to that file);
  under `serverLocalRoot()` or under nothing → throw with the path named.
- `nodeLocalHostPath(serverPath)` — the node path for a NODE-LOCAL
  server-side path; what the store writer and the sweep pods mount.
- `nodeLocalDirsOf(mounts)` — the node paths of every NODE-LOCAL
  directory mount, for the init container. File mounts are excluded
  (none are node-local today).

**`pod-spec.ts`** — `PodJobParams` gains `nodeLocalDirs?: string[]`
(rendered as an init container `node-dirs`: the pod's image,
`securityContext: { runAsUser: 0 }`, `sh -c 'mkdir -p … && chown
<runAsUser>:<runAsGroup> …'` with the numbers from
`hostUidSecurityContext()`, mounting the node root at `/node`) and
`preStopExec?: string[]` (rendered as `lifecycle.preStop.exec`). The
comment on the `pvc` arm of `MountSource` stops saying nothing selects it.
Volume naming (`hp-`/`pv-`/`ed-` + index) is unchanged, so every existing
manifest assertion that does not name a data-dir path survives.

**`kubectl.ts`** — `nodeLocalNodePath()` as above.

### `drivers/k8s/worktrees/launch.ts`

`launchWorkspace` maps `[...spec.mounts, ...substrate.storeMounts,
...ssh.mounts]` through `resolveMountSource`, passes
`nodeLocalDirsOf(mounts)` and `spec.preStopExec` to `buildPodJobManifest`.
Nothing else changes: labels, env, the registration ConfigMap and the
receipt are as today.

### `drivers/k8s/install`

**New `storage.ts`**

- `buildGlobalPvManifest({ hostPath })`, `buildServerLocalPvManifest({
  hostPath })`: `PersistentVolume` named `<claim>-<dataDirHash()>`,
  `spec.hostPath: { path, type: 'Directory' }` (never `DirectoryOrCreate`:
  a root-owned `server-local/` is a database PGlite cannot open — install
  pre-creates both as the user), `capacity.storage` nominal,
  `accessModes` `['ReadWriteMany']` / `['ReadWriteOnce']`,
  `persistentVolumeReclaimPolicy: 'Retain'`, `storageClassName: ''`,
  `claimRef: { namespace: k8sNamespace(), name }`, labels
  `{ app: SERVER_APP_NAME, [LABEL_INSTALL_NAMESPACE]: k8sNamespace(),
  [LABEL_DATA_DIR_HASH]: dataDirHash() }`.
- `buildGlobalPvcManifest()`, `buildServerLocalPvcManifest()`:
  `PersistentVolumeClaim` in `k8sNamespace()`, `storageClassName: ''`,
  `volumeName` = the PV's name, matching access mode, the same nominal
  request. Same labels.
- `ensureStorageClaims({ globalHostPath, serverLocalHostPath, log })`:
  `mkdir -p` both host dirs (and `<dataDir>/node-local`) as the user, then
  apply PV, PV, PVC, PVC and wait for both claims to read `Bound`. A claim
  that is already bound to the expected `volumeName` is skipped rather
  than re-applied (the spec is immutable after binding; a re-apply of an
  identical manifest is a no-op but a differing one is an error that
  should name the claim). Exported through the install barrel so the e2e
  harness can call the builders with a test file's paths.

**`server-deploy.ts`**

- `buildServerEnv`: adds `YAAC_GLOBAL_ROOT`, `YAAC_SERVER_LOCAL_ROOT`,
  `YAAC_NODE_LOCAL_ROOT` with the three pod paths. `YAAC_DATA_DIR`
  unchanged. `readPodLock` already reads
  `${YAAC_SERVER_LOCAL_ROOT:-$YAAC_DATA_DIR}/.server.lock` inside the pod,
  so the mint follows the variable with no change.
- `buildServerDeploymentManifest`: volumes `global` (PVC `yaac-global`),
  `server-local` (PVC `yaac-server-local`), `node-local` (hostPath
  `nodeLocalNodePath()`, `DirectoryOrCreate`), mounted at the three pod
  roots. The module and function doc comments about "storage is
  deliberately unchanged here" and "the data dir is this pod's only
  volume" go.
- `ensureServerDeployment(imageRef, fronting, envOpts)` is unchanged in
  order. `deployServerWorkload` becomes: `refuseIfHostServerRunning` →
  `stopClusterServer` when `serverDeploymentExists()` → `migrateDataDirLayout`
  → `ensureStorageClaims` → the image → `ensureServerDeployment` → the
  rest as today. The stop is what makes the migration safe (see "The
  migration").
- The RWO note on the Deployment ("there is no attach exclusivity to fall
  back on") stays true on kind and is left.

**`install.ts`**

- `renderKindConfig` gains `{ dataDir, dataDirHash }` and renders a second
  `extraMounts` entry on the node template, `hostPath: <dataDir>/node-local`,
  `containerPath: /var/lib/yaac/node/<hash>`, so the worker copies carry
  it beside the `$HOME` one. `k8s/kind-config.yaml`'s header describes both
  mounts and why the second one is per-install. `createKindCluster` creates
  `<dataDir>/node-local` before `kind create` (podman refuses a bind of a
  missing source, or creates it as root).
- `runClusterInstall` is unchanged in sequence: the migration and the
  claims are steps of `deployServerWorkload`, because the harness reuses
  its pieces. The `--adopt-cni` note gains a line saying the claims were
  applied (server or no server — see "Decisions").
- A cluster that predates the extraMount cannot be converged (kind writes
  mounts at create time). Install says so once, beside
  `applyKindNodeFixups`, when the node's `/var/lib/yaac/node/<hash>` is not
  a mount of the host dir: caches live on node disk until `yaac cluster
  delete` + install. That probe (`podman exec <node> findmnt <path>`)
  self-skips on a non-podman node like the fixups do.

**`check.ts`**

- `runEndToEndProbe`: the probe pod mounts `{ persistentVolumeClaim:
  { claimName: GLOBAL_CLAIM_NAME } }` at `/probe`; the nonce and the
  write-back file are written and read on the host at `globalRoot()` as
  today (on kind the PV's hostPath IS that folder, which is what the
  probe proves). The pod's identity stays `hostUidSecurityContext()`. Fix
  strings name the claim and its PV instead of "the extraMounts entry".
  The pod additionally waits for a second nonce the check writes once the
  pod is Running and reports the latency in the pass detail (`global
  claim: read, write at uid N, cross-visibility 12ms`) — the coherence
  number step 6 will judge a byo class by.
- `probeNode` / `runMultiNodeReadiness`: the per-node pod mounts the
  claim; `VOLUME_NODES_FIX` names the PV; `blameProbeFailure` also matches
  `FailedAttachVolume|PersistentVolumeClaim|not bound`.
- New `storage` gate (after `namespace`, before `probe`): both claims
  exist, are `Bound`, their PVs carry `Retain` and, on kind, a `hostPath`
  under the data dir. A missing or Pending claim fails with "run `yaac
  cluster install`".
- New `storage-semantics` gate, warn-level: one pod on the gvisor class
  mounting `yaac-global`, running the spike's `fsprobe.py` (landed at
  `k8s/probes/fsprobe.py`, delivered to the pod by a ConfigMap the check
  applies and deletes, run by the pinned `quay.io/podman/stable` mirror
  because it ships python3 and is already in the registry). Every check
  must pass; the detail lists failures by name. Warn rather than fail on
  kind so a virtiofs quirk on macOS surfaces without blocking; step 6
  promotes it for byo.
- New `node-local-mount` advisory (kind only, warn): the tripwire from
  install above, beside `node-fixups`, so a `cluster check` after a
  podman-machine restart says it too.
- `PROBE_GATES` ordering updated; `formatCheckResult` unchanged.

**`delete.ts`** — unchanged. `kind delete` takes the PVs with the cluster;
`Retain` is what keeps a claim or namespace delete from touching the
hostPath, and nothing deletes host bytes on either path. The confirmation
text stays true as written.

### `drivers/k8s/cluster`

The proxy is already stateless and mounts nothing from the host, so
`proxy-manifests.ts` and `proxy-apply.ts` need no storage change. The only
edit in this folder is `legacy-proxy-seed.ts` following the `sharedPath` →
`globalPath` rename; its read of `global/run/proxy-data` is what row 8 of
the migration serves.

### `drivers/k8s/images/store-writer.ts`

- `buildStoreWriterPodManifest` and `buildStoreCleanupPodManifest` mount
  `nodeLocalHostPath(imageStoreDir(slug))` (and its parent) — node paths,
  where before the server-side path doubled as the node path.
- `nodeImageStoreMount` is unchanged (a server-side `hostPath` source that
  `launchWorkspace` resolves).
- `generationsInUse` compares live pods' `spec.volumes[].hostPath.path`
  by the trailing `shared-images/<slug>/<gen>` rather than by equality,
  so a nested worktree started before this upgrade (mounting the old
  spelling) still pins its generation through the window.
- `listStoreGenerations` keeps reading the server's own `/yaac/node-local`
  mount: the server's node's generations, which is the "one node today"
  the module already documents. Nothing here changes that.
- `removeNodeImageStore(slug)` becomes `removeNodeLocalProject(slug)`:
  the cleanup pod removes `<nodeRoot>/projects/<slug>` and
  `<nodeRoot>/shared-images/<slug>` in one pass. Callers:
  `worktrees/teardown.ts` (project removal) and the sweep below.

### `drivers/k8s/images` — new `node-local-sweep.ts`

`buildNodeLocalSweepPodManifest({ nodeName, imageRef, running, cutoffEpoch,
runId, nodeIndex })` on the store-writer shape (root, runc, `nodeName`,
`tolerations: Exists`, infra priority, `hostNetwork` unnecessary here),
mounting `nodeLocalNodePath()` at `/node`. Its script walks
`/node/projects/*/{.cached-packages/modules,opencode-data}/*` and `rm -rf`s
each entry whose basename is not in `running` for that slug and whose
mtime is older than `cutoffEpoch` (`find -newermt` is the in-pod form of
`inUseBySweep`'s slack). `running` is the set of worktree ids with a live
pod, per slug, and it is the only keep-list: a stopped worktree's
ephemeral modules are per life, and its opencode working copy is either
already deleted by its own `preStop` or a stale copy the global store
outranks (see "Decisions"). Everything else on the node is an orphan.

`reapNodeLocal(running)` runs one pod per node through `runPodToCompletion`
with the builder image mirror (busybox lacks `find -newermt`), throttled
to once per `NODE_LOCAL_SWEEP_INTERVAL_MS` (an hour) per server life, on
the same keyed-mutex shape as the store ensure. Exported through the
images barrel and wired in `drivers/k8s/index.ts` and `steps.ts` as a
`maintenance` step (`node-local-gc`, no triggers).

### `drivers/contract.ts` and `drivers/containerless`

- `WorkspaceSpec` gains `preStopExec?: string[]` beside `postStartExec`.
  The containerless driver never receives one (the domain sets it only
  under k8s) and ignores it if it did, documented on the field beside
  `postStartExec`, which has the same property.
- `WorktreeDriver` gains `reapNodeLocal(running: Map<string, Set<string>>):
  Promise<void>` (live worktree ids per slug) and
  `removeNodeLocalProject(projectSlug): Promise<void>`. Containerless
  answers the first with the loop `gcOrphanEphemeralModuleDirs` runs today
  over `nodeLocalRoot()` (moved, not rewritten; on that substrate the
  node-local tier holds only the pnpm store and its module dirs, since
  opencode has no working copy there — see `create.ts` below) and the
  second with `fs.rm` of `nodeLocalProjectPath(slug)` and
  `imageStoreDir(slug)`. The fake driver in test-utils answers both as
  resolved no-ops.
- `drivers/containerless/launch.ts` `realizeMount`: a `hostPath` source
  directory under `nodeLocalRoot()` that does not exist is `mkdir -p`ed
  before the symlink. This is where the server-side `fs.mkdir`s of
  `opencodeDataDir`, `cachedPackagesDir` and the ephemeral backing dirs
  go for this substrate; the pod driver's equivalent is the init
  container.

### `domain/worktrees`

- **`create.ts`**: drops the `fs.mkdir` of `opencodeData` and
  `cachedPackages`; keeps every global `mkdir`. `prepareEphemeralMounts`
  (`seed.ts`) keeps creating the in-worktree mountpoint targets (global,
  and the checkout must find them) and stops creating the node-local
  backing dirs. The opencode mounts branch on `runtime.kind`, which is the
  one kind of branch the layering allows above the seam — WHETHER the
  working-copy feature applies. Under `k8s` the list carries the
  node-local working copy at `CONTAINER_OPENCODE_DATA` (as today), a new
  `{ source: { kind: 'hostPath', path: opencodeCheckpointDir(projectSlug,
  worktreeId) }, mountPath: CONTAINER_OPENCODE_CHECKPOINT }` (GLOBAL) with
  an `fs.mkdir` for it, and `preStopExec:
  ['/usr/local/bin/yaac-opencode-checkpoint', 'stop']` on the spec. Under
  `containerless` the global store IS the data dir: `CONTAINER_OPENCODE_DATA`
  is realized (symlinked) straight to `opencodeCheckpointDir`, there is no
  checkpoint mount and no `preStop`, and `opencodeDataDir` is never used —
  a host process's disk is local, so a copy would be a copy of itself.
  The mount-list comment's legend is reworded around GLOBAL / NODE-LOCAL /
  emptyDir: the driver now realizes each tier differently, and the list
  is the declaration.
- **`cleanup.ts`**: `deleteWorktreeState` removes
  `opencodeCheckpointDir` (global) instead of `opencodeDataDir`;
  `gcOrphanEphemeralModuleDirs` keeps `gcOrphanSpares` and the global
  `sessions/<id>` sweep (over `worktreeStateDir`'s parent, no longer a
  roots pair), and ends by calling `worktreeDriver().reapNodeLocal(running)`
  with the live set it already computed. Its once-per-life flag goes: the
  k8s verb throttles itself and the containerless loop is cheap.
  `cleanupWorktreeDetached`'s detached script `rm -rf`s `worktreeStateDir`,
  the modules dir and the checkout's ephemeral paths as today, minus the
  node-local twin that no longer exists.
- **`project-purge.ts`**: after the global `rm -rf` of `projectDir`, calls
  `worktreeDriver().removeNodeLocalProject(slug)` instead of iterating
  `projectRoots()`; `projectRoots()` loses its one caller and goes.
- The reconcile step `orphan-modules-gc` in `domain/reconcile.ts` is
  unchanged in name and trigger.

### Worktree-side: `worktree-bin/` and the images

- **New `worktree-bin/yaac-opencode-checkpoint [stop]`** (POSIX sh, staged
  and File-mounted like the others): no-op unless
  `$HOME/.local/share/opencode` holds a SQLite file. Otherwise: `python3
  -c` using the stdlib `sqlite3` backup API into
  `<checkpoint>/.tmp-<pid>.db`, `mv` it over the database's name, then
  `cp -a` every non-database entry of the data dir into the checkpoint
  dir. With `stop`, and only when every step above succeeded, it then
  empties the data dir (`rm -rf <data>/.[!.]* <data>/*`), so a cleanly
  stopped worktree leaves nothing on its node. A failure leaves the copy in
  place and exits nonzero, which the kubelet logs and nothing else acts
  on: the next start overwrites it from the global store and the sweep
  collects it. python3 is in `Dockerfile.default` already, so no image
  changes and no content hash moves.
- **`worktree-bin/yaac-worktree-init`**: after the `/etc/passwd` rewrite
  and before `tmux new-session`, the restore, unconditional: empty the
  data dir, then if the checkpoint dir holds a SQLite file `cp -a
  <checkpoint>/. <data>/` (excluding stale `-wal`/`-shm` sidecars). The
  global store is the only source of truth, so whatever the node held is
  discarded, not merged. After streamd, a timer: `setsid sh -c 'while
  sleep 300; do yaac-opencode-checkpoint; done' &` with the same
  redirections the engine start uses. The interval is a constant at the
  top of the script, named in the plan doc's gate (five minutes is the
  "at most one checkpoint interval" the decision accepts).
- The SQLite file's name at the pinned `@opencode/cli` 2.x release is read
  off a running pod before the script is written (see "Open questions");
  the script matches `*.db` rather than hard-coding it.

### CLI (`packages/cli`)

- `yaac server logs` description: the log is
  `~/.yaac/server-local/server.log`. The command already reads
  `serverLogPath()`.
- No new flags. `rejectClusterArgs` and the e2e-cli option tests are
  untouched.

### `packages/test-utils` (the e2e harness)

- **`cli.ts`** `createYaacTestEnv` and **`setup.ts`** `createTempDataDir`:
  create `<dataDir>/global/projects` and `<dataDir>/server-local` through
  the path helpers rather than spelling `projects` by hand.
- **`deployed-server.ts`** `deployTestServer`: after `ensureNamespace()`,
  applies `buildGlobalPvManifest({ hostPath: <dataDir>/global })`,
  `buildServerLocalPvManifest({ hostPath: <dataDir>/server-local })` and
  both PVCs, and waits for `Bound`. `testServerDeploymentManifest` keeps
  the production builder's three tier mounts and env, and ADDS a fourth
  hostPath of `testTmpBase()` at its own absolute path: the pod still
  needs the file's scratch tree for `GIT_CONFIG_GLOBAL` and the local
  source repos tests `project add`. The doc comment says which of the
  four is test-only.
- **`setup.ts`** `createTempDataDir` (the api-k8s tier's in-process
  server, which creates real pods from the host): applies the same claim
  pair for `TEST_NAMESPACE` into its data dir — the namespace now exists
  from `cluster-setup.ts`'s `beforeAll` — so the resolver's `yaac-global`
  subPaths bind. A new `ensureTestStorageClaims(dataDir)` in test-utils
  serves both callers.
- **`cluster-setup.ts`** `afterAll`: before the namespace delete, delete
  PVs by `LABEL_INSTALL_NAMESPACE=<TEST_NAMESPACE>` (cluster-scoped, they
  do not cascade) and run one node-local cleanup pod per node for the
  file's `dataDirHash()` (the test hash has no extraMount, so its node
  tree is node disk that nothing else reclaims).
- **`test/global-setup.ts`** `cleanupLeakedTestNamespaces`: also sweeps
  PVs labelled `yaac.install-namespace=yaac-test-*`, and node-local trees
  of leaked test hashes with one pod per node (`/var/lib/yaac/node/*`
  minus the real install's hash — read off the real data dir's
  `dataDirHash()` when `ambientDataDir()` resolves one).

## Manifests, env vars and flags involved

| Kind | Name | Where rendered |
|---|---|---|
| PersistentVolume | `yaac-global-<hash>`, `yaac-server-local-<hash>` | `install/storage.ts` |
| PersistentVolumeClaim | `yaac-global`, `yaac-server-local` (install namespace; one pair per e2e namespace) | `install/storage.ts`, applied by `deployServerWorkload` and `deployTestServer` |
| Deployment `yaac-server` | three volumes at `/yaac/{global,server-local,node-local}`; three env vars | `install/server-deploy.ts` |
| Job (worktree) | `pv-N` subPath mounts, `hp-N` node-path mounts, init container `node-dirs`, `preStop` | `substrate/pod-spec.ts` via `worktrees/launch.ts` |
| Pod (one-shot) | store writer/cleanup, node-local sweep, check probes | `images/store-writer.ts`, `images/node-local-sweep.ts`, `install/check.ts` |
| ConfigMap | `yaac-cluster-check-fsprobe` (transient) | `install/check.ts` |
| kind config | second `extraMounts` entry per node | `install/install.ts` `renderKindConfig` |

Env vars: `YAAC_GLOBAL_ROOT`, `YAAC_SERVER_LOCAL_ROOT`,
`YAAC_NODE_LOCAL_ROOT` (Deployment only). CLI flags: none added or
changed. The proxy Deployment and the server fronting manifests are
untouched.

## Legacy compat (entries for docs/legacy-compat-shims.md)

Each gets its own section there, in the same change that adds the code.

**`migrateDataDirLayout`** (`shared/data-dir-layout.ts`). What it reads:
the nine moved rows of the layout table, on a host, at containerless
server start and at `yaac cluster install` — after the server pod has been
stopped there. Its rules, and its order against every other shim, are the
section above, and the entry carries that table verbatim so the next
cleanup pass sees the dependencies without re-deriving them. What breaks
silently if it is deleted too early: an install that upgrades without it
comes up with no projects (`global/projects` is empty), an empty
`server-local/db`, no credentials and a fresh `server-local/secret.key` —
every project and worktree row is gone from every listing while the
checkouts sit one directory over, every credential is missing, and every
sealed row that still exists is unreadable, with no error anywhere because
that is exactly what a fresh install looks like. Its node-local row is
cheaper to lose (a cold pnpm store), but it is the same function. How to
tell it is safe to remove: no data dir in use has `projects/` or `db/` at
its root — directly checkable with `ls "${YAAC_DATA_DIR:-$HOME/.yaac}"`
showing only the three tier folders (and the pre-client-local files, which
have their own entry) on every install that matters. The checkpoint
placement is recorded here too: the GLOBAL `opencodeCheckpointDir` is
deliberately the pre-split node-local location inside the projects tree,
so row 7 is also what carries every stopped opencode worktree's history
into place; renaming the checkpoint dir later is a migration of that
history. Order: this entry outlives `importLegacyProjectConfig`,
`seedProxyObjects` and `adoptLegacyClaudeJson`, each of which reads a path
only this migration puts where they look.

**The old-path lock fallback in `readLock`/`removeLock`** (`shared/lock.ts`).
What it reads: `<dataDir>/.server.lock` when
`<dataDir>/server-local/.server.lock` is absent. Exists for one window: a
containerless server that predates the split is still running when the CLI
upgrades, and `yaac server start` must see it (it would otherwise spawn a
second writer on the same, now-migrated, database) and `yaac server stop`
must be able to stop it. What breaks silently: that second server. Order:
keep it as long as `migrateDataDirLayout`'s lock handling, and remove the
two together. Safe once no pre-split server can still be running — a
release boundary, since nothing records a server's build.

**The `node-local-mount` advisory** (`install/install.ts`, `install/check.ts`).
A tripwire about state, not a shim in the data path: a kind cluster created
before the second extraMount existed holds node-local caches on node disk.
Nothing breaks if it goes; a user with an old cluster simply stops being
told why their pnpm store is cold after every podman-machine restart. Safe
to remove when no kind cluster in use predates it, which `kubectl get nodes
-o yaml` cannot say; a season after release.

**The root-owned `shared-images/` skip** (a log line in
`migrateDataDirLayout`). The old node-local image store is not moved
because its generations are root-owned; the migration prints the
`rm -rf` for the operator. Nothing reads the old directory afterwards, so
it is a message, not a code path, and it goes with the migration.

**The pre-client-local read fallbacks** (existing entry): its three readers
now spell the data-dir root explicitly (`path.join(getDataDir(), …)`)
because `serverLocalPath` no longer names it. The entry's "what it reads"
line is corrected; nothing else about it changes.

**`seedProxyObjects`** (existing entry): its "what it reads" line becomes
`<dataDir>/global/run/proxy-data`, with a sentence saying row 8 of the
layout migration is what puts it there and that the two entries go
together or not at all.

**Existing entries' check commands**: the `/etc/yaac/agent-links.sh` strip
and the spent-mountpoint reclaim both print a `grep`/`find` over
`<dataDir>/projects/…`; those become `<dataDir>/global/projects/…`.

## Tests

### Unit (`unit:shared`)

- `paths.test.ts` `storage tiers`: the three roots resolve to
  `<dataDir>/global`, `<dataDir>/server-local`, `<dataDir>/node-local`;
  each override env var re-roots exactly one tier; `projectsRoots()`
  returns two entries; `opencodeDataDir` is under the node-local root and
  `opencodeCheckpointDir` under the global one, with a comment naming the
  legacy-compat entry as the reason the checkpoint's spelling is frozen;
  `installTmpDir()` is stable across the roots. The "keeps node-local
  session paths where the single-node backend puts them" case is
  rewritten to freeze the new spellings and loses its
  `nodeLocalWorktreeStateDir` line; the "pairs both roots" case shrinks to
  `projectsRoots()`; the `getProjectsDir` and credentials cases move under
  `global/` and `server-local/`.
- `env.test.ts`: the three accessors.
- `lock.test.ts`: `readLock` falls back to the old path only when the new
  one has no lock; `removeLock` unlinks whichever it found.
- `server-config.test.ts`, `auth-daemon.test.ts`: the legacy files are
  found at the data dir root, not under `server-local/`.
- New `data-dir-layout.test.ts`: one `describe('migrateDataDirLayout')`:
  moves every row in order; is idempotent; treats an empty destination as
  absent and refuses (throws, naming the row) on a non-empty one; throws
  on a live old lock and unlinks a stale one; ignores `remote.json`,
  `.auth-daemon.lock`, `driver`, `e2e-tmp` and `shared-images` at the
  root; logs the `shared-images` command; no-ops on a fresh dir; leaves
  `opencode-data/<id>` inside `global/projects`; and — the ordering case —
  a run interrupted after row 3 (simulated by a failing rename injected at
  row 4) leaves the key beside the database and completes on the next
  call.

### Unit (`unit:server`)

- `substrate/mount-sources.test.ts` (new; one describe per barrel
  function): `resolveMountSource` maps a global dir, a global file
  (`type: 'File'` → subPath to the file, `readOnly` kept), a node-local
  dir (node path, `DirectoryOrCreate`), passes `emptyDir`/`pvc` through,
  throws on a server-local path and on an untiered path (the data dir
  root itself included); `nodeLocalHostPath`; `nodeLocalDirsOf` lists
  dirs only.
- `substrate/pod-spec.test.ts`: the init container (image, root,
  `mkdir`+`chown` to the pod's `runAsUser:runAsGroup`, node root
  mounted), `preStop`, and a `pvc` source with a file subPath render as
  expected; existing cases keep passing unchanged since the source kinds
  and volume names are as before.
- `worktrees/launch.test.ts`: `launchWorkspace` — the applied manifest
  carries `pv-*` subPath mounts for every global mount, node-path `hp-*`
  mounts for the node-local ones, the init container naming exactly those
  node dirs, the `preStop` hook, and no `hostPath` under the data dir; a
  spec naming a server-local path rejects before `kubectlApply`.
- `install/storage.test.ts` (new): the four manifests (names, `Retain`,
  `claimRef`, `storageClassName: ''`, `volumeName`, access modes, labels,
  `type: 'Directory'`); `ensureStorageClaims` creates the host dirs, applies
  in PV→PVC order, waits on `Bound`, skips a claim already bound to the
  right volume and errors on one bound elsewhere.
- `install/server-deploy.test.ts` "hands the pod what it can no longer
  read off a host": three mounts, three root env vars, `YAAC_DATA_DIR`
  still the host path; `deployServerWorkload` orders refusal → stop of an
  existing Deployment → migration → claims → image → Deployment, and
  skips the stop when no Deployment exists.
- `install/install.test.ts`: `renderKindConfig` puts both extraMounts on
  every node entry and the port mapping on the control plane only;
  install creates `<dataDir>/node-local` before `kind create`; the
  `node-local-mount` note fires on a node whose path is not a mount.
- `install/check.test.ts`: the probe and per-node pods mount the claim;
  the second-nonce latency lands in the pass detail; `storage` passes on
  Bound+Retain and fails on Pending/absent; `storage-semantics` warns
  with the failing probe names; `blameProbeFailure` attributes a
  `FailedAttachVolume` event to `volume`; the multi-node case at
  `probes every session-eligible node…` asserts the claim mount.
- `images/store-writer.test.ts`: writer and cleanup pods mount node paths;
  `generationsInUse` matches by suffix; `removeNodeLocalProject` removes
  both trees.
- `images/node-local-sweep.test.ts` (new): the pod script spares
  `running` ids and nothing else, removes a stopped worktree's leftover
  `opencode-data` copy, honours the cutoff, runs once per node, throttles.
- `domain/worktrees/cleanup.test.ts`: `gcOrphanEphemeralModuleDirs` keeps
  its global cases and asserts `reapNodeLocal` is called with the live set
  (fake driver); the once-per-life case and the "also removes orphan
  per-session tmux dirs" case go; `deleteWorktreeState` removes the
  checkpoint dir.
- `domain/worktrees/create.test.ts` (or `worktree-create` in the CLI
  package, whichever pins the mount list today): under k8s the working
  copy, the checkpoint mount and `preStopExec` are on the spec; under
  containerless `CONTAINER_OPENCODE_DATA` points at the checkpoint dir and
  neither of the other two is present; `ensureSessionStartsLog` and
  `stageWorktreeBin` complete before `launchWorkspace` is called.
- `drivers/containerless/launch.test.ts`: a missing node-local source dir
  is created before linking; `reapNodeLocal` removes exactly what the
  domain loop removed before.
- `main/server-run.test.ts`, `main/lifecycle.test.ts`: the migration runs
  before `ensureDataDir` and the lock read on a host, not in-cluster, and
  a migration error stops the start before the lock is taken.
- `cluster/legacy-proxy-seed.test.ts`: the seed reads
  `global/run/proxy-data` (the helper rename).
- **Every test that spells `<dataDir>/projects` by hand goes through
  `projectDir()` / `getProjectsDir()`** — 84 sites across 27 files today
  (`grep -rn "dataDir, 'projects'" test packages/*/test`), the largest
  mechanical edit in this step. Same for the handful that spell
  `<dataDir>/db`, `.server.lock`, `server.log` or `.credentials`
  (`db/client.test.ts`, `main/log.test.ts`, `test/api/token-auth-flow.test.ts`,
  `test/e2e-containerless/server-lifecycle.test.ts`, the credentials
  fixtures in `worktree-create-suite` and `auth-cli`).

### API matrix

No route is added or changed; `route-matrix.ts` needs no row. Both matrix
projects must stay green — the k8s one now depends on
`ensureTestStorageClaims` in `createTempDataDir`.

### e2e-containerless

- `server-lifecycle.test.ts`: the lock-path assertion becomes
  `<dataDir>/server-local/.server.lock`. New case, the only executable
  proof the migration has: start a server, add a project, store a
  credential, stop it, rebuild the OLD layout by hand (`global/projects` →
  `projects`, `server-local/db` → `db`, `server-local/secret.key` and
  `server-local/.credentials` to the root), `yaac server start` again —
  the project still lists, the credential still reads, the log names
  every move in order, and the root holds only the three tier folders. A
  second case leaves a live old-path lock in place and asserts `yaac
  server start` reports the running server rather than migrating under
  it.
- `worktree-suite.test.ts`: the discovery-hook case is unchanged; add an
  assertion that a worktree's `.cached-packages` realizes under
  `<dataDir>/node-local/projects/<slug>` while its checkout and its
  opencode data are under `<dataDir>/global/projects/<slug>`, and that
  `node-local/projects/<slug>` holds nothing else.

### k8s e2e (`test/e2e`, `test/e2e-cli`)

- `worktree-create-suite.test.ts`
  - `provisions pod, worktree, mounts, git, and tmux`: unchanged in
    substance — the container-side paths are identical — plus a read of
    the Job manifest asserting every volume is a `yaac-global` subPath, an
    `emptyDir`, the ConfigMap, or a `hostPath` under
    `/var/lib/yaac/node/`; none under the data dir.
  - `redirects /workspace/node_modules through .cached-packages…` and the
    `provisioning hand-off` cases read `<projectPath>/.cached-packages` on
    the host today; the backing dirs are now node disk (the test hash has
    no extraMount). They assert through the pod (`ls
    /home/yaac/.cached-packages/modules/<id>`) and, for the after-delete
    half, through a node pod or `podman exec <node> ls
    /var/lib/yaac/node/<hash>/…`.
  - `opencode session` gains the gate case: create, drive one turn
    through the in-pod HTTP API against the mock LLM, `worktree stop`,
    then assert two things on disk — the checkpoint
    (`<projectPath>/opencode-data/<id>` on the host) holds the database,
    and `/var/lib/yaac/node/<hash>/projects/oc-demo/opencode-data/<id>` on
    the node is gone (the `preStop` deleted it) — then `worktree restart`
    and assert the conversation is listed with its message by the in-pod
    session API in the new pod. A second variant plants a junk file in
    the node-local dir before the restart and asserts it is not there
    after, which is the "global outranks whatever the node held" rule.
- `nested-containers.test.ts`: the store assertions that read
  `<dataDir>/shared-images` on the host switch to a `podman exec <node>`
  read of `/var/lib/yaac/node/<hash>/shared-images/<slug>`.
- `server.test.ts` (`yaac server lifecycle against the in-cluster
  Deployment`): the `server logs` cases read
  `<dataDir>/server-local/server.log`; add `the server pod mounts the two
  claims and nothing under the data dir by hostPath` reading the
  Deployment.
- `cluster-cli.test.ts`: unchanged (it covers refusals; the happy path is
  the verification procedure). Add one refusal: `yaac cluster check`
  against a cluster whose `yaac-global` claim is absent reports `storage`
  as failed naming install — this needs a cluster, so it lives in
  `test/e2e` with the other cluster-bound files rather than here.
- `test/e2e/*`: `proxy-credentials-suite`, `arbitrary-uid`, the egress and
  ssh-agent files need no edit. Run them.

## Docs to update (same change as the code they describe)

- `docs/plans/cloud-k8s.md`: the "Storage is two named claims" decision
  names `yaac-global` / `yaac-server-local`, says the RWX PV binds
  `<dataDir>/global`, and drops "nothing under the data dir is ever
  moved" for "moved once, by a rename, into three tier folders"; the
  tier-roots decision names `globalRoot()` and `YAAC_GLOBAL_ROOT`; "Where
  things stand" gains the storage bullets, drops "Nothing selects `pvc`
  yet" and "the tiers are still one directory", and (a pre-existing
  staleness) "the built-in images bake the CLI machine's uid"; step 1 is
  deleted from "The work, in order"; this document is deleted when the
  step ships.
- `docs/server-in-cluster.md`: "Storage is still hostPath" becomes
  "Storage is two claims" (the table above, the PV/PVC shape, why the
  claims are named and the PVs hashed, why `YAAC_DATA_DIR` stays a host
  path, the stop-before-migrate order on install); "Client state lives
  beside the data dir" gains the sentence that the data dir root holds
  only the three tier folders; "The e2e tiers run against this" gains the
  per-namespace claim pair and the scratch hostPath that remains
  test-only; the "What is deployed" list gains the claims.
- `docs/cluster-setup.md`: "What it wires up" item 2 describes two
  extraMounts and the node path; "Multi-node" says the node-local
  extraMount rides the worker copies and that node-local is per node in
  name and shared on kind in fact; "Verifying" describes `storage`,
  `storage-semantics`, the claim-based `probe`/`volume-nodes`, and
  `node-local-mount`; "Deleting the cluster" says the PVs go with the
  cluster and the bytes do not; the closing "Limits" note about one
  filesystem is rewritten around the claim.
- `docs/worktree-storage.md`: the `File` hostPath sentences become
  subPath-to-file, keeping the append-only reasoning; its one
  `projects/<slug>/meta/…` path gains the `global/` prefix.
- `docs/containerless-driver.md`: the paths table (`~/.yaac/global/projects/…`),
  the layout, the start-time migration, `reapNodeLocal`, and that opencode
  data is the global store directly with no working copy.
- `docs/nested-containers.md`, `docs/trust-split-builds.md`: the store's
  location is the node path; the writer/cleanup pod wording.
- `docs/worktree-egress.md`: the sentence on where `seedProxyObjects` reads
  from.
- `README.md`: the paths table (`~/.yaac/global/projects/…` throughout,
  opencode data as node-local working copy with its checkpoint,
  `.cached-packages` under `node-local/`, `server.log` and
  `Dockerfile.user` under `server-local/`), the credentials paragraph
  (`~/.yaac/server-local/.credentials/`), and the sentence that says the
  home directory must be extraMounted. Twenty-four such path mentions
  across README, the containerless doc and the shims doc today.
- `docs/legacy-compat-shims.md`: the entries above.

## Gate: verification procedure

Run on the cloud-k8s test rig (`/home/ben/yaac-test-s4`, its own cluster,
data dir and kubeconfig — see the project's memory note), in this order.
Every step must be green before the next.

1. In the worktree: `pnpm lint`; `pnpm test:unit`; `pnpm vitest run
   --project api-containerless --project e2e-containerless`.
2. Grep gates: `grep -rn hostPath packages/server/src/drivers/k8s
   --include='*.ts'` names only node paths (`gvisor.ts` installer mounts,
   the `certs.d` writers, `nodeLocalNodePath` users, `check.ts`'s node
   probe of the node path) — nothing under the data dir, nothing in
   `server-deploy.ts`. And `grep -rn "sharedRoot\|sharedPath\|SHARED"
   packages/*/src` finds nothing: the tier is GLOBAL everywhere.
3. Upgrade path, single node, EXISTING cluster and data dir: on the rig
   with a project, a stored credential, a RUNNING claude worktree and a
   stopped opencode worktree that has a conversation, `yaac cluster
   install` (no delete). Assert: the install log shows the server pod
   stopped, then each rename in table order, then the claims bound; the
   running worktree is still listed and its agent still answers (its bind
   mounts survived the rename); `ls <dataDir>` shows exactly `global`,
   `server-local`, `node-local` (plus `e2e-tmp` and any pre-client-local
   files); `ls <dataDir>/server-local` shows `db`, `.credentials`,
   `server.log`, `secret.key`; `kubectl get pv,pvc -n yaac` shows both
   pairs `Bound` with `Retain`; `yaac cluster check` is green except the
   `node-local-mount` advisory; `yaac worktree restart` of the opencode
   worktree resumes its conversation (the moved directory served as the
   checkpoint); `yaac project list` and every stopped worktree are
   unchanged; `yaac auth` reads the moved credentials; the server log
   shows `importLegacyProjectConfig` and `seedProxyObjects` finding
   nothing to do (or, on a rig that skipped step 5, the seed carrying the
   old CA).
4. Fresh cluster, single node: `yaac cluster delete -y && yaac cluster
   install`. `yaac cluster check` fully green (advisory gone; `findmnt` on
   the node shows `/var/lib/yaac/node/<hash>` bound to
   `<dataDir>/node-local`). Then `pnpm test:api-k8s` and `pnpm test:e2e`
   from the rig.
5. Three nodes: `yaac cluster delete -y && yaac cluster install --nodes
   3`. `yaac cluster check` green with `volume-nodes` reporting both
   workers writing through the claim; a nested worktree and an opencode
   worktree created, stopped and restarted; then `pnpm test:e2e` again.
6. macOS smoke if a Mac is available: steps 3–4 on the podman machine, in
   particular the `storage-semantics` result over virtiofs (expected to
   warn on at least one lock or ownership check; the warning must name
   it and nothing must fail).
7. By hand, once, documented in the commit that lands the checkpoint
   script: the spike's `append-race.sh` from `origin/nfs-gvisor-storage-spike`
   against a `yaac-global` subPath on kind, to record that the
   session-starts log's one-writer contract is what keeps it clean (the
   spike found two-sandbox O_APPEND loss on a gofer-backed ext4 hostPath,
   and that finding is unchanged by this step).

## Suggested commit order

Each commit lands green on `pnpm lint`, `pnpm test:unit` and the
containerless tiers; the k8s tiers are run at the commits marked.

1. **Tier folders, the GLOBAL rename and the host layout.** The
   `shared*` → `global*` rename across `packages/shared` and every caller
   (including `legacy-proxy-seed.ts`), `env.ts` accessors, `paths.ts`
   roots, `installTmpDir` and `ensureDataDir`, `data-dir-layout.ts` and
   its test, the lock fallback, the legacy-path spellings in
   `server-config.ts`/`auth-daemon.ts`, the migration calls in
   `server-run.ts`, `lifecycle.ts` and `deployServerWorkload` (with the
   stop-first sequencing), `paths.test.ts` rewritten, the 84 hand-spelt
   `projects` paths in tests, the harness's data-dir creation through the
   helpers, the e2e-containerless lifecycle cases, the legacy-compat
   entries, the containerless doc, README paths, `cloud-k8s.md`'s naming.
   The k8s pod at this commit still hostPath-mounts the data dir, so its
   three folders are subdirectories of that mount and everything works.
   Run the k8s e2e here, and step 3 of the procedure: it proves the
   migration runs after the old pod is gone and before the new one, that
   the new pod finds the moved projects, DB and credentials, and that
   running worktree pods survive the `projects/` rename underneath their
   bind mounts.
2. **Claims, PVs and the storage vocabulary.** `storage-constants.ts`,
   `install/storage.ts` with tests, `ensureStorageClaims` called from
   `deployServerWorkload` and `deployTestServer`, the harness's
   `ensureTestStorageClaims`, the PV sweeps in `cluster-setup.ts` and
   `global-setup.ts`. Nothing mounts the claims yet: they bind and sit.
   Green on k8s e2e with no behavior change.
3. **The pod side: three roots, the resolver, the init container.**
   `mount-sources.ts`, `pod-spec.ts` (init container, `preStop`
   plumbing), `launch.ts`, the server Deployment's mounts and env, the
   store writer's node paths and suffix match, `removeNodeLocalProject`,
   the kind extraMount and host-dir creation, `create.ts` dropping the
   node-local `mkdir`s and the containerless `realizeMount` creating them,
   the `node-local-mount` advisory, the mount-list tests, the k8s e2e
   manifest assertions and the node-path rewrites of the
   `.cached-packages`/`shared-images` host reads. This is the commit the
   whole gate is about: run steps 3–5 of the procedure on it.
4. **Sweeps as node pods.** The two contract verbs, `node-local-sweep.ts`,
   the containerless implementations, the domain delegation in
   `cleanup.ts` and `project-purge.ts`, `projectRoots()` deleted, the fake
   driver, tests.
5. **opencode checkpoint and restore.** `opencodeCheckpointDir`, the two
   container-path constants, the mount and `preStopExec` in `create.ts`,
   `yaac-opencode-checkpoint`, the init script's restore and timer, the
   opencode e2e case, README and worktree-storage doc updates.
6. **Cluster check.** `storage`, `storage-semantics` (with
   `k8s/probes/fsprobe.py` landed from the spike branch and the
   `build:assets` copy), the claim-based `probe`/`volume-nodes`, the
   latency detail, `blameProbeFailure`; `cluster-setup.md` "Verifying";
   `server-in-cluster.md` storage section; `cloud-k8s.md` updated and
   this plan deleted.

## Open questions and risks

- **Running worktree pods under the `projects/` rename.** At commit 1 the
  k8s upgrade renames `projects/` while pre-upgrade worktree pods still
  bind-mount subdirectories of it by the old hostPath. A bind mount holds
  its dentry and the gofer holds open fds, so the running pod keeps its
  view; the server, after its roll, addresses the same bytes under
  `global/`. Step 3 of the procedure verifies it with a running worktree;
  if a running pod does break, the fallback is that install refuses to
  migrate while worktree pods are running and says to stop them, which is
  a bounded cost since an install is an upgrade the user chose to run.
- **Stopping the server pod before migrating lengthens install's
  outage.** Today's `Recreate` roll already stops the old pod before the
  new one starts; the change is that the stop moves earlier, ahead of the
  image build. On an install that has to build a new server image that
  can be minutes rather than seconds. If that matters, build the image
  before the stop (it needs no data dir) and keep stop → migrate →
  claims → deploy contiguous; the plan's order is the simpler one to
  state and the one to start with.
- **subPath to a file on a hostPath PV under gVisor.** kubelet realizes a
  file subPath as a bind mount, which is what a `type: File` hostPath was;
  runsc sees a bind either way. Verify with a scratch pod before commit 3,
  including `readOnly: true` on a file subPath (the worktree-bin scripts)
  and an append from inside the sandbox (session-starts). If a file
  subPath misbehaves, the fallback is a subPath to the `meta/` directory
  with the hook writing `<id>.session-starts.jsonl` inside it — a
  one-line change in the hook and the mount, no format change.
- **A subPath that is missing at pod create becomes a root-owned
  directory.** Every global file or dir a pod mounts must exist before the
  Job is applied. The create already orders it so; the unit test in
  commit 3 pins it. The same applies to `cacheVolumes` dirs.
- **The migration's empty-destination rule.** Treating an empty
  destination as absent is what makes ordering mistakes harmless, but it
  must never apply to a non-empty one: a data dir that was half-migrated
  by hand refuses to start with both halves named, rather than one half
  silently shadowing the other.
- **The `shared-images/` skip on Linux.** Confirm on the rig that
  `rename(2)` of the root-owned store directory really fails for the user
  (it should: moving a directory to a new parent needs write permission on
  it), and that leaving it costs nothing but disk. If it turns out to be
  renameable — a store whose top level the server created — moving it is
  strictly better and the row comes back.
- **opencode 2.x's SQLite filename and mode.** Read the data dir of a
  running pod at the pinned release to confirm the file name and whether
  WAL sidecars exist; the backup API copes with WAL, and the script globs
  `*.db`, but the restore must not copy stale `-wal`/`-shm` files beside a
  freshly restored database — exclude them.
- **`preStop` against a 5s grace.** A backup of a few-MB database is
  well under a second; the hook is bounded by `terminationGracePeriodSeconds`
  and a slow one is killed, not waited on. A killed hook loses at most
  one timer interval of conversation (the last timer checkpoint is the
  restore point) and leaves a copy the next start discards, so the
  failure is bounded and quiet, never a corrupt or merged database. If
  the e2e stop case shows the checkpoint stale, raise the grace on
  worktree pods to 10s rather than shortening the hook.
- **The unconditional restore discards node-side edits.** That is the
  point of a single source of truth, but it means an opencode worktree
  that was killed rather than stopped (a node lost, an OOM) resumes from
  its last timer checkpoint even when a newer copy still sits on the
  node. The interval is the knob; five minutes is the plan's stated
  acceptance and it is a one-line constant.
- **Node-local disk growth on a long-lived dev cluster.** Every e2e file
  leaves `/var/lib/yaac/node/<testHash>` on the node until the per-file
  cleanup pod runs; an interrupted run leaks it to the global sweep. Both
  are in the plan; check `du -sh /var/lib/yaac/node` on the rig after the
  first full run.
- **Pre-upgrade worktrees after commit 3.** A worktree Job created before
  it mounts hostPaths under the data dir; on kind those still resolve
  through the `$HOME` extraMount, so it keeps running, is listed (labels
  unchanged), and stops normally. Its opencode data is under the old
  path, which is the checkpoint path — a restart resumes it. Its nested
  image-store generation is protected by the suffix match. Nothing else
  reaches into a running pod's mounts.
- **An existing kind cluster has no node-local extraMount.** Caches land
  on node disk until the cluster is recreated; correctness is unaffected,
  and the advisory says so. The rig itself is such a cluster: step 3 of
  the procedure deliberately runs against it before step 4 recreates it.
- **`storage-semantics` on macOS.** `fsprobe.py` may report lock or
  ownership differences over virtiofs. It is warn-level for exactly that
  reason; the question is whether any of its findings names something a
  worktree relies on today — the answer feeds the byo promotion in step 6.
- **The api-k8s tier's in-process server** creates pods from the host with
  host-shaped roots. The three folders are siblings there as in the pod,
  so the resolver behaves identically; the store writer's
  `listStoreGenerations` reads `<dataDir>/node-local/shared-images` on the
  host, which no node writes to, so that tier always mounts no store.
  That is what it does today for a different reason and no api test
  asserts a store mount.
- **`--adopt-cni` and the claims.** Static hostPath PVs into the data dir
  are wrong on any cluster that is not this host's kind, and adoption
  targets exactly one such cluster today (a hand-made kind). Step 6
  renames it `--byo` and replaces the PV pair with StorageClass claims;
  until then adoption applies kind's pair and the note it prints says so.

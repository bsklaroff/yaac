# Cloud k8s, step 1: storage — claims on kind, data dir untouched

Implementation plan for step 1 of docs/plans/cloud-k8s.md. Read that
document's "Where things stand", "Decisions" and "Invariants to keep"
first; this one restates none of them and plans nothing past step 1.

## Outcome

When this lands, on kind:

- The server pod mounts two PersistentVolumeClaims, `yaac-shared` (RWX)
  and `yaac-server-state` (RWO), plus a node hostPath for the NODE-LOCAL
  tier, at three fixed pod paths. Every worktree pod and the proxy mount
  subPaths of `yaac-shared`; nothing under the data dir is mounted by
  hostPath any more. Each claim is bound to a static hostPath
  PersistentVolume that install renders into the host's data dir, so the
  bytes stay on the host disk at the paths they occupy today, and `yaac
  cluster delete` keeps touching none of them.
- The three tier roots are three different directories on every substrate:
  `<dataDir>` (SHARED), `<dataDir>/server` (SERVER-LOCAL) and
  `<dataDir>/node-local` (NODE-LOCAL) on a host; three mount points inside
  the pod. `getDataDir()` is unchanged, so `dataDirHash()`, every label,
  every claim name and every row carry over.
- The k8s driver resolves a mount's source from the tier root its path
  lives under. Domain code goes on declaring `hostPath` sources against the
  tier helpers exactly as today; the containerless driver goes on
  symlinking them.
- NODE-LOCAL directories are created by an init container on the
  worktree's node, and swept by per-node one-shot pods, so nothing about a
  node's disk is read or written from the server's own filesystem.
- opencode's SQLite works on a node-local copy and is checkpointed to the
  shared tier by the pod itself: on a timer, and in the pod's `preStop`
  hook. A restart whose node-local copy is gone restores from the
  checkpoint.
- `yaac cluster check` proves the claim, not the extraMount: the nonce
  probe and the per-node `volume-nodes` sweep write through `yaac-shared`,
  and a `storage` gate reports the claims' binding and the POSIX semantics
  of what backs them.
- The e2e harness renders a claim pair per test namespace with static PVs
  into the file's own data dir, the way it already renders per-namespace
  RBAC.

Gate: the e2e suite green on kind, one node and three, plus the
verification procedure at the end of this document.

## The layout

One set of names for every backend, chosen here and used everywhere below.

| Tier | Host (containerless, and kind's PV path) | Pod mount point | Env var the Deployment sets | Backing on kind |
|---|---|---|---|---|
| SHARED | `<dataDir>` | `/yaac/shared` | `YAAC_SHARED_ROOT` | PVC `yaac-shared` → PV `yaac-shared-<dataDirHash>` → hostPath `<dataDir>` |
| SERVER-LOCAL | `<dataDir>/server` | `/yaac/server` | `YAAC_SERVER_LOCAL_ROOT` | PVC `yaac-server-state` → PV `yaac-server-state-<dataDirHash>` → hostPath `<dataDir>/server` |
| NODE-LOCAL | `<dataDir>/node-local` | `/yaac/node` | `YAAC_NODE_LOCAL_ROOT` | hostPath `/var/lib/yaac/node/<dataDirHash>` on the node, which a kind extraMount binds to `<dataDir>/node-local` |
| CLIENT-LOCAL | `<dataDir>-client` | never mounted | — | — |

`YAAC_DATA_DIR` keeps naming the host's data dir inside the pod. It is an
identity string there and a directory only on the host.

What moves on the host, once, for an existing data dir:

| From | To | Tier |
|---|---|---|
| `db/` | `server/db/` | SERVER-LOCAL |
| `server.log` | `server/server.log` | SERVER-LOCAL |
| `secret.key` | `server/secret.key` | SERVER-LOCAL |
| `build/` (Dockerfile.user and its context) | `server/build/` | SERVER-LOCAL |
| `models/` | `server/models/` | SERVER-LOCAL |
| `run/ssh-keys/` | `server/run/ssh-keys/` | SERVER-LOCAL |
| `.server.lock` | `server/.server.lock` | SERVER-LOCAL — never moved live; see "Legacy compat" |
| `projects/<slug>/.cached-packages/` | `node-local/projects/<slug>/.cached-packages/` | NODE-LOCAL |
| `shared-images/` | `node-local/shared-images/` | NODE-LOCAL |

What does not move: `projects/` (minus the entry above), `.credentials/`,
`run/proxy-data/`, `e2e-tmp/`, and `projects/<slug>/opencode-data/<id>` —
which becomes the SHARED checkpoint directory at exactly its current path,
so a pre-existing opencode database is a checkpoint already and restores
with no migration (see "opencode").

The node path carries `dataDirHash()` so two installs on one cluster (the
real one and every e2e namespace) never share a node directory. The pod
paths carry no hash: a pod belongs to one install.

## Decisions this step makes

- **One layout for both drivers.** `serverLocalRoot()` defaults to
  `<dataDir>/server` and `nodeLocalRoot()` to `<dataDir>/node-local`
  whether or not the env vars are set. The host CLI must read the lock the
  pod writes (`mintLocalClientToken` reads its secret, `yaac server logs`
  reads the log, `deployServerWorkload` refuses on a live host lock), so
  the host's answer for SERVER-LOCAL has to be the PV's path, and a
  driver-conditional default would put a `server.json` read in every path
  helper. What "the split is inert under containerless" means is that the
  roots are three subdirectories of one directory there and no volume
  machinery applies — not that the layout differs. The one-shot rename
  therefore runs on both substrates: at install time for k8s, at server
  start for containerless.
- **Prefix mapping in the k8s driver, nothing new on the contract.** The
  contract's `MountSource` already has the `pvc` arm; the driver rewrites
  a `hostPath` source by which tier root its path is under. The roots are
  disjoint inside the pod (`/yaac/shared`, `/yaac/node`), which is what
  makes the mapping sound; on a host they nest (`<dataDir>/node-local` is
  under `<dataDir>`), so the resolver tests NODE-LOCAL before SHARED and
  a host-process caller (the api-k8s tier's in-process server) still maps
  correctly. A path under SERVER-LOCAL, or under no root at all, is a
  thrown error: a pod may not mount the server's claim, and every product
  path is tiered.
- **A `File` mount becomes a subPath to a file.** kubelet bind-mounts an
  existing file at a subPath; a subPath that does not exist is created as
  a root-owned directory. The `type: File` guard that used to fail such a
  mount loudly is therefore replaced by the ordering the create already
  has: `ensureSessionStartsLog` and `stageWorktreeBin` run before the Job
  is applied. That ordering gets a unit test.
- **The node-local init container is the pod's own image as root.** It runs
  under the pod's RuntimeClass like every other container of the pod, so
  no extra image and no extra pull. It `mkdir -p`s and chowns to `podUid()`
  each node-local directory the mount list names, because hostPath
  ignores `fsGroup` and `DirectoryOrCreate` makes root-owned directories.
  On kind the node path is host disk (through the extraMount) and on macOS
  a chown through virtiofs is cosmetic, which is fine: the host uid owns
  everything on that side anyway (docs/server-in-cluster.md, "The uid
  everything runs as").
- **Node-local sweeps are a driver verb.** The domain keeps the shared half
  of the orphan GC (spare state, session-starts logs, shared
  `sessions/<id>`) and hands the node-local half to a new contract verb,
  `reapNodeLocal`. k8s answers with one root pod per node running an
  `rm -rf` script over a keep-list; containerless answers with the
  `fs.rm` loop the domain runs today, moved into its driver. Project
  removal takes the same route: `removeNodeImageStore` generalizes to
  `removeNodeLocalProject`, one pod per node removing the project's node
  tree and its image store together.
- **The opencode checkpoint is the plain data dir, copied.** A checkpoint is
  the node-local opencode data directory copied file-for-file, except the
  SQLite file, which is produced by the backup API and renamed into place.
  The restore is the reverse copy when the node-local directory has no
  database. Choosing the copy as the format is what makes today's
  `opencode-data/<id>` directory a valid checkpoint with nothing to
  convert.
- **No new CLI flags.** `--nodes` renders the second extraMount onto every
  node; `--adopt-cni` gets the claims too (it needs a StorageClass-free
  static PV pair like kind's, which is wrong for a real cloud cluster and
  right for the adopted-kind rehearsal — `--byo` in step 6 replaces it).
- **The server's ClusterRole is unchanged.** Install applies the PVs and
  PVCs from the CLI's kubeconfig; the server only references the claim
  names. The e2e harness applies its own from the developer's kubeconfig.

## Changes by module

### `packages/shared`

**`src/env.ts`** — three accessors: `sharedRootOverride`,
`serverLocalRootOverride`, `nodeLocalRootOverride`, reading
`YAAC_SHARED_ROOT`, `YAAC_SERVER_LOCAL_ROOT`, `YAAC_NODE_LOCAL_ROOT`.
Unset → `undefined`. The tier-legend comment there names the Deployment as
their only setter.

**`src/paths.ts`**

- `sharedRoot()` → override ?? `getDataDir()`.
- `serverLocalRoot()` → override ?? `path.join(getDataDir(), 'server')`.
- `nodeLocalRoot()` → override ?? `path.join(getDataDir(), 'node-local')`.
- The tier legend is rewritten in the present tense: the three roots ARE
  different directories; the pod's are mount points named by the
  Deployment.
- `ensureDataDir()` creates `<shared>/projects` and `serverLocalRoot()`.
  Not `nodeLocalRoot()`: on k8s that is the node's, created by the init
  container; on containerless it is created lazily by the driver
  (below).
- New constants beside `CONTAINER_SESSION_STARTS_LOG`:
  `CONTAINER_OPENCODE_DATA = '/home/yaac/.local/share/opencode'` (today an
  inline string in create.ts) and
  `CONTAINER_OPENCODE_CHECKPOINT = '/home/yaac/.yaac/opencode-checkpoint'`.

**`src/project-paths.ts`**

- New `opencodeCheckpointDir(slug, worktreeId)`, SHARED:
  `sharedProjectPath(slug, 'opencode-data', worktreeId)`. Its doc says
  why the path equals the pre-split node-local one.
- `opencodeDataDir` re-documented as the node-local WORKING COPY of that
  checkpoint; path unchanged (`nodeLocalProjectPath(slug, 'opencode-data',
  id)`), which now resolves under `<nodeLocal>`.
- `cachedPackagesDir`, `imageStoreDir`, `nodeLocalWorktreeStateDir`: no
  code change; their doc comments drop the "same directory today" wording.
- `projectsRoots()`, `projectRoots()`, `worktreeStateRoots()`,
  `projectWorktreeStateRoots()` now genuinely return two entries; their
  callers already iterate.

**`src/lock.ts`** — `readLock()` and `removeLock()` fall back to
`path.join(getDataDir(), SERVER_LOCK_FILENAME)` when the server-local path
has no lock. This is the window in which a pre-split containerless server
is still running after an upgrade (legacy shim below).

**`src/server-config.ts`**, **`src/auth-daemon.ts`** — the legacy paths
`legacyConfigPaths()` and `legacyAuthDaemonLockPath()` spell
`path.join(getDataDir(), …)` instead of `serverLocalPath(…)`. They meant
the data dir root when the tiers coincided; `serverLocalPath` now names a
directory those files were never in. `readLegacyDriverRecord` likewise.

**New `src/data-dir-layout.ts`** — `migrateDataDirLayout(log)`: the
one-shot rename in the layout table above, entry by entry, `fs.rename`
when the source exists and the destination does not, logging each move;
a destination that already exists leaves the source alone and logs it
(never merges, never deletes). The lock entry is special: a live lock at
the old path is left in place (the running server owns it and will unlink
it); a stale one is unlinked. Idempotent, and a no-op on a fresh data dir.
Runs on a host only — never inside the pod, where the roots are mounts and
the old files, if any, sit on `yaac-shared` at `/yaac/shared/db` where a
rename across claims is a copy. Unit-tested in
`packages/shared/test/data-dir-layout.test.ts`.

### `packages/server` — db, lib, main

- `db/client.ts`, `lib/build-dirs.ts`, `domain/titles/llama-cpp.ts`,
  `domain/git/transport.ts`, `db/secret-key.ts`: no change — every one
  already goes through `serverLocalPath`.
- `main/server-run.ts` `runServer`: after `ensureDataDir()` and before
  `assertHostServerAllowed()`, `if (!env.inCluster) await
  migrateDataDirLayout(serverLog)`. The pod skips it; a host process
  migrates its own data dir before it reads the lock.
- `main/lifecycle.ts` `startServer`: the same call in the same place, so
  the "already running" decision reads the migrated lock. The
  `readLock()` fallback covers the one order this cannot control (a
  pre-split server still running).
- `drivers/containerless/paths.ts` `tmuxSockDir`: hash `getDataDir()`
  instead of `serverLocalPath()`. Same value as today (the two were
  equal), and it is the install identity that is meant; without this a
  running containerless install would lose its socket directory on
  upgrade and every live worktree would read as dead.

### `drivers/k8s/substrate`

**New `storage-constants.ts`** (zero-import vocabulary, like
`proxy-constants.ts`), exported through the barrel:

- `SHARED_CLAIM_NAME = 'yaac-shared'`, `SERVER_STATE_CLAIM_NAME =
  'yaac-server-state'`.
- `POD_SHARED_ROOT = '/yaac/shared'`, `POD_SERVER_LOCAL_ROOT =
  '/yaac/server'`, `POD_NODE_LOCAL_ROOT = '/yaac/node'`.
- `nodeLocalNodePath()` = `/var/lib/yaac/node/${dataDirHash()}` (in
  `kubectl.ts` beside `dataDirHash`, since it needs it).
- `LABEL_INSTALL_NAMESPACE = 'yaac.install-namespace'` — already spelled
  inline by the server RBAC and netd; lift it here.

**New `mount-sources.ts`**, exported through the barrel:

- `resolveMountSource(m: PodMount): PodMount` — `emptyDir` and `pvc` pass
  through; `hostPath` under `nodeLocalRoot()` → `{ kind: 'hostPath', path:
  nodeLocalNodePath() + rel, type: source.type ?? 'DirectoryOrCreate' }`;
  under `sharedRoot()` → `{ kind: 'pvc', claimName: SHARED_CLAIM_NAME,
  subPath: rel }` (a `File` type simply becomes a subPath to that file);
  under `serverLocalRoot()` or under nothing → throw with the path named.
  NODE-LOCAL is tested first (the roots nest on a host).
- `nodeLocalHostPath(serverPath)` — the node path for a NODE-LOCAL
  server-side path; what the store writer and the sweep pods mount.
- `nodeLocalDirsOf(mounts)` — the node paths of every NODE-LOCAL
  directory mount, for the init container. File mounts are excluded
  (none are node-local today).

**`pod-spec.ts`** — `PodJobParams` gains `nodeLocalDirs?: string[]`
(rendered as an init container `node-dirs`: the pod's image,
`securityContext: { runAsUser: 0 }`, `sh -c 'mkdir -p … && chown
<podUid()>:<gid> …'`, mounting the node root at `/node`) and
`preStopExec?: string[]` (rendered as `lifecycle.preStop.exec`). The
comment on the `pvc` arm of `MountSource` stops saying nothing selects it.
Volume naming (`hp-`/`pv-`/`ed-` + index) is unchanged, so every existing
manifest assertion that does not name a data-dir path survives.

**`kubectl.ts`** — `nodeLocalNodePath()` as above.

### `drivers/k8s/worktrees/launch.ts`

`launchWorkspace` maps `[...spec.mounts, ...substrate.storeMounts,
...ssh.mounts]` through `resolveMountSource`, passes
`nodeLocalDirsOf(mounts)` and `spec.preStopExec` to `buildPodJobManifest`.
Nothing else changes: labels, env and the receipt are as today.

### `drivers/k8s/install`

**New `storage.ts`**

- `buildSharedPvManifest({ hostPath })`, `buildServerStatePvManifest({
  hostPath })`: `PersistentVolume` named `<claim>-<dataDirHash()>`,
  `spec.hostPath: { path, type: 'Directory' }` (never `DirectoryOrCreate`:
  a root-owned `server/` is a database PGlite cannot open — install
  pre-creates both as the user), `capacity.storage` nominal,
  `accessModes` `['ReadWriteMany']` / `['ReadWriteOnce']`,
  `persistentVolumeReclaimPolicy: 'Retain'`, `storageClassName: ''`,
  `claimRef: { namespace: k8sNamespace(), name }`, labels
  `{ app: SERVER_APP_NAME, [LABEL_INSTALL_NAMESPACE]: k8sNamespace(),
  [LABEL_DATA_DIR_HASH]: dataDirHash() }`.
- `buildSharedPvcManifest()`, `buildServerStatePvcManifest()`:
  `PersistentVolumeClaim` in `k8sNamespace()`, `storageClassName: ''`,
  `volumeName` = the PV's name, matching access mode, the same nominal
  request. Same labels.
- `ensureStorageClaims({ sharedHostPath, serverStateHostPath, log })`:
  `mkdir -p` both host dirs (and `<dataDir>/node-local`) as the user, then
  apply PV, PV, PVC, PVC and wait for both claims to read `Bound`. A claim
  that is already bound to the expected `volumeName` is skipped rather
  than re-applied (the spec is immutable after binding; a re-apply of an
  identical manifest is a no-op but a differing one is an error that
  should name the claim). Exported through the install barrel so the e2e
  harness can call the builders with a test file's paths.

**`server-deploy.ts`**

- `buildServerEnv`: adds `YAAC_SHARED_ROOT`, `YAAC_SERVER_LOCAL_ROOT`,
  `YAAC_NODE_LOCAL_ROOT` with the three pod paths. `YAAC_DATA_DIR`
  unchanged.
- `buildServerDeploymentManifest`: volumes `shared` (PVC
  `yaac-shared`), `server-state` (PVC `yaac-server-state`), `node-local`
  (hostPath `nodeLocalNodePath()`, `DirectoryOrCreate`), mounted at the
  three pod roots. The module and function doc comments about "storage is
  deliberately unchanged here" go.
- `ensureServerDeployment` is unchanged in order; `deployServerWorkload`
  calls `migrateDataDirLayout` right after `refuseIfHostServerRunning`
  (the one moment install knows no host server holds the data dir and no
  pod is running yet — `Recreate` plus the rollout that follows), then
  `ensureStorageClaims`, then the image and the Deployment.
- The RWO note on the Deployment ("there is no attach exclusivity to fall
  back on") stays true on kind and is left.

**`install.ts`**

- `renderKindConfig` gains `{ dataDir, dataDirHash }` and renders a second
  `extraMounts` entry on the node template, `hostPath: <dataDir>/node-local`,
  `containerPath: /var/lib/yaac/node/<hash>`, so the worker copies carry
  it. `k8s/kind-config.yaml`'s header describes both mounts and why the
  second one is per-install. `createKindCluster` creates
  `<dataDir>/node-local` before `kind create` (podman refuses a bind of a
  missing source, or creates it as root).
- `runClusterInstall`: `ensureStorageClaims` is a step of
  `deployServerWorkload` rather than of install, because the harness
  reuses `deployServerWorkload`'s pieces; install itself gains nothing but
  the `--adopt-cni` note update (claims are applied there too, server or
  no server — see "Decisions").
- A cluster that predates the extraMount cannot be converged (kind writes
  mounts at create time). Install says so once, after `kindNodes`, when
  the node's `/var/lib/yaac/node/<hash>` is not a mount of the host dir:
  caches live on node disk until `yaac cluster delete` + install. That
  probe (`podman exec <node> findmnt <path>`) lives beside the fixups and
  self-skips on a non-podman node.

**`check.ts`**

- `runEndToEndProbe`: the probe pod mounts `{ persistentVolumeClaim:
  { claimName: SHARED_CLAIM_NAME } }` at `/probe`; the nonce and the
  write-back file are written and read on the host at `sharedRoot()` as
  today (on kind the PV's hostPath IS the data dir, which is what the
  probe proves). Fix strings name the claim and its PV instead of "the
  extraMounts entry". The pod additionally waits for a second nonce the
  check writes once the pod is Running and reports the latency in the
  pass detail (`shared claim: read, write at uid N, cross-visibility
  12ms`) — the coherence number step 6 will judge a byo class by.
- `probeNode` / `runMultiNodeReadiness`: the per-node pod mounts the
  claim; `VOLUME_NODES_FIX` names the PV; `blameProbeFailure` also matches
  `FailedAttachVolume|PersistentVolumeClaim|not bound`.
- New `storage` gate (after `namespace`, before `probe`): both claims
  exist, are `Bound`, their PVs carry `Retain` and, on kind, a `hostPath`
  under the data dir. A missing or Pending claim fails with "run `yaac
  cluster install`".
- New `storage-semantics` gate, warn-level: one pod on the gvisor class
  mounting `yaac-shared`, running the spike's `fsprobe.py` (landed at
  `k8s/probes/fsprobe.py`, delivered to the pod by a ConfigMap the check
  applies and deletes, run by the pinned `quay.io/podman/stable` mirror
  because it ships python3 and is already in the registry). Every check
  must pass; the detail lists failures by name. Warn rather than fail on
  kind so a virtiofs quirk on macOS surfaces without blocking; step 6
  promotes it for byo.
- New `node-local-mount` advisory (kind only, warn): the tripwire from
  install above, so a `cluster check` after a podman-machine restart says
  it too.
- `PROBE_GATES` ordering updated; `formatCheckResult` unchanged.

**`delete.ts`** — unchanged. `kind delete` takes the PVs with the cluster;
`Retain` is what keeps a claim or namespace delete from touching the
hostPath, and nothing deletes host bytes on either path. The confirmation
text stays true as written.

### `drivers/k8s/cluster`

**`proxy-manifests.ts`** — `credentials` and `proxy-data` become
`persistentVolumeClaim: { claimName: SHARED_CLAIM_NAME }` volumes mounted
with `subPath: '.credentials'` and `subPath: 'run/proxy-data'`. The doc on
`proxyRunAsSecurityContext` stops saying hostPath. **`proxy-apply.ts`**
keeps its two `fs.mkdir`s: they run in the server, whose shared root is
the same claim, and they are what keeps kubelet from creating the subPath
root-owned.

The `hostPath` grep gate for `proxy-manifests.ts` that step 5 states is
met here already; step 5 changes what the proxy is handed, not how.

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
- `listStoreGenerations` keeps reading the server's own `/yaac/node`
  mount: the server's node's generations, which is the "one node today"
  the module already documents. Nothing here changes that.
- `removeNodeImageStore(slug)` becomes `removeNodeLocalProject(slug)`:
  the cleanup pod removes `<nodeRoot>/projects/<slug>` and
  `<nodeRoot>/shared-images/<slug>` in one pass. Callers:
  `worktrees/teardown.ts` (project removal) and the sweep below.

### `drivers/k8s/images` — new `node-local-sweep.ts`

`buildNodeLocalSweepPodManifest({ nodeName, imageRef, keep, cutoffEpoch,
runId, nodeIndex })` on the store-writer shape (root, runc, `nodeName`,
`tolerations: Exists`, infra priority, `hostNetwork` unnecessary here),
mounting `nodeLocalNodePath()` at `/node`. Its script walks
`/node/projects/*/{.cached-packages/modules,sessions,opencode-data}/*` and
`rm -rf`s each entry whose basename is not in the keep-list for that
directory kind and whose mtime is older than `cutoffEpoch` (`find
-newermt` is the in-pod form of `inUseBySweep`'s slack). `keep` is per
slug: `running` (ids with a live pod — keeps all three kinds) and
`stopped` (ids with a row, stopped less than 24h ago — keeps
`opencode-data` only, so a checkpoint that a failed `preStop` never wrote
is not lost to a sweep an hour later). Everything else on the node is an
orphan.

`reapNodeLocal(keep)` runs one pod per node through `runPodToCompletion`
with the builder image mirror (busybox lacks `find -newermt`), throttled
to once per `NODE_LOCAL_SWEEP_INTERVAL_MS` (an hour) per server life, on
the same keyed-mutex shape as the store ensure. Exported through the
images barrel and wired in `drivers/k8s/index.ts` and `steps.ts` as a
`maintenance` step (`node-local-gc`, no triggers).

### `drivers/contract.ts` and `drivers/containerless`

- `WorkspaceSpec` gains `preStopExec?: string[]` beside `postStartExec`.
  The containerless driver ignores it, documented on the field: a stop
  there is a tmux kill and the opencode data is host disk.
- `WorktreeDriver` gains `reapNodeLocal(keep: NodeLocalKeep): Promise<void>`
  and `removeNodeLocalProject(projectSlug): Promise<void>`. Containerless
  answers the first with the loop `gcOrphanEphemeralModuleDirs` runs today
  over `nodeLocalRoot()` (moved, not rewritten) and the second with
  `fs.rm` of `nodeLocalProjectPath(slug)` and `imageStoreDir(slug)`. The
  fake driver in test-utils answers both as resolved no-ops.
- `drivers/containerless/launch.ts` `realizeMount`: a `hostPath` source
  directory under `nodeLocalRoot()` that does not exist is `mkdir -p`ed
  before the symlink. This is where the server-side `fs.mkdir`s of
  `opencodeDataDir`, `cachedPackagesDir` and the ephemeral backing dirs
  go for this substrate; the pod driver's equivalent is the init
  container.

### `domain/worktrees`

- **`create.ts`**: drops the `fs.mkdir` of `opencodeData` and
  `cachedPackages`; keeps every shared `mkdir`. `prepareEphemeralMounts`
  (`seed.ts`) keeps creating the in-worktree mountpoint targets (shared,
  and the checkout must find them) and stops creating the node-local
  backing dirs. The mount list gains `{ source: { kind: 'hostPath', path:
  opencodeCheckpointDir(projectSlug, worktreeId) }, mountPath:
  CONTAINER_OPENCODE_CHECKPOINT }` (SHARED) with an `fs.mkdir` for it, and
  `preStopExec: ['/usr/local/bin/yaac-opencode-checkpoint']` on the spec.
  The mount-list comment's SHARED/NODE-LOCAL legend is reworded: the
  driver now realizes each tier differently, and the list is the
  declaration.
- **`cleanup.ts`**: `deleteWorktreeState` removes
  `opencodeCheckpointDir` (shared) instead of `opencodeDataDir`;
  `gcOrphanEphemeralModuleDirs` keeps `gcOrphanSpares` and the shared
  `sessions/<id>` sweep, and ends by calling
  `worktreeDriver().reapNodeLocal(keep)` with the live set it already
  computed plus the recently-stopped ids from `getProjectWorktreeRows`.
  Its once-per-life flag goes: the k8s verb throttles itself and the
  containerless loop is cheap. `cleanupWorktreeDetached`'s detached script
  keeps `rm -rf` of `worktreeStateRoots` — on k8s the node-local half of
  that pair is a path on the server's own node mount and the rm is a
  harmless no-op there; the sweep is what actually collects it.
- **`project-purge.ts`**: after the shared `rm -rf` of `projectDir`, calls
  `worktreeDriver().removeNodeLocalProject(slug)` instead of iterating
  `projectRoots()`; `projectRoots()` loses its one caller and goes.
- The reconcile step `orphan-modules-gc` in `domain/reconcile.ts` is
  unchanged in name and trigger.

### Worktree-side: `worktree-bin/` and the images

- **New `worktree-bin/yaac-opencode-checkpoint`** (POSIX sh, staged and
  File-mounted like the others): no-op unless
  `$HOME/.local/share/opencode` holds a SQLite file. Otherwise: `python3
  -c` using the stdlib `sqlite3` backup API into
  `<checkpoint>/.tmp-<pid>.db`, `mv` it over the database's name, then
  `cp -a` every non-database entry of the data dir into the checkpoint
  dir. python3 is in `Dockerfile.default` already, so no image changes
  and no content hash moves.
- **`worktree-bin/yaac-worktree-init`**: before `tmux new-session`, the
  restore: if the data dir has no SQLite file and the checkpoint dir has
  one, `cp -a <checkpoint>/. <data>/`. After streamd, a timer: `setsid sh
  -c 'while sleep 300; do yaac-opencode-checkpoint; done' &` with the same
  redirections the engine start uses. The interval is a constant at the
  top of the script, named in the plan doc's gate (five minutes is the
  "at most one checkpoint interval" the decision accepts).
- The SQLite file's name at the pinned opencode release is read off a
  running pod before the script is written (see "Open questions"); the
  script matches `*.db` rather than hard-coding it.

### CLI (`packages/cli`)

- `yaac server logs` description: the log is `~/.yaac/server/server.log`.
  The command already reads `serverLogPath()`.
- No new flags. `rejectClusterArgs` and the e2e-cli option tests are
  untouched.

### `packages/test-utils` (the e2e harness)

- **`deployed-server.ts`** `deployTestServer`: after `ensureNamespace()`,
  applies `buildSharedPvManifest({ hostPath: dataDir })`,
  `buildServerStatePvManifest({ hostPath: <dataDir>/server })` and both
  PVCs, and waits for `Bound` — the two host dirs having been created by
  `createYaacTestEnv`. `testServerDeploymentManifest` keeps the production
  builder's three tier mounts and env, and ADDS a fourth hostPath of
  `testTmpBase()` at its own absolute path: the pod still needs the file's
  scratch tree for `GIT_CONFIG_GLOBAL` and the local source repos tests
  `project add`. The doc comment says which of the four is test-only.
- **`setup.ts`** `createTempDataDir` (the api-k8s tier's in-process
  server, which creates real pods from the host): applies the same claim
  pair for `TEST_NAMESPACE` into its data dir, so the resolver's
  `yaac-shared` subPaths bind. A new `ensureTestStorageClaims(dataDir)`
  in test-utils serves both callers.
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
| PersistentVolume | `yaac-shared-<hash>`, `yaac-server-state-<hash>` | `install/storage.ts` |
| PersistentVolumeClaim | `yaac-shared`, `yaac-server-state` (install namespace; one pair per e2e namespace) | `install/storage.ts`, applied by `deployServerWorkload` and `deployTestServer` |
| Deployment `yaac-server` | three volumes at `/yaac/{shared,server,node}`; three env vars | `install/server-deploy.ts` |
| Deployment `yaac-proxy` | two subPath mounts of `yaac-shared` | `cluster/proxy-manifests.ts` |
| Job (worktree) | `pv-N` subPath mounts, `hp-N` node-path mounts, init container `node-dirs`, `preStop` | `substrate/pod-spec.ts` via `worktrees/launch.ts` |
| Pod (one-shot) | store writer/cleanup, node-local sweep, check probes | `images/store-writer.ts`, `images/node-local-sweep.ts`, `install/check.ts` |
| ConfigMap | `yaac-cluster-check-fsprobe` (transient) | `install/check.ts` |
| kind config | second `extraMounts` entry per node | `install/install.ts` `renderKindConfig` |

Env vars: `YAAC_SHARED_ROOT`, `YAAC_SERVER_LOCAL_ROOT`,
`YAAC_NODE_LOCAL_ROOT` (Deployment only). CLI flags: none added or
changed.

## Legacy compat (entries for docs/legacy-compat-shims.md)

Each gets its own section there, in the same change that adds the code.

**`migrateDataDirLayout`** (`shared/data-dir-layout.ts`). What it reads:
the nine root-level entries in the layout table, on a host, at containerless
server start and at `yaac cluster install`. What breaks silently if it is
deleted too early: an install that upgrades without it comes up on an
empty `server/db` with a fresh `server/secret.key` — every project and
worktree row is gone from every listing while the checkouts sit on disk,
and every sealed row that still exists is unreadable, with no error
anywhere because that is exactly what a fresh install looks like. Its
node-local half is cheaper to lose (a cold pnpm store and image store), but
it is the same function. How to tell it is safe to remove: no data dir in
use has `db/` at its root — directly checkable with `ls
"${YAAC_DATA_DIR:-$HOME/.yaac}/db"` on every install that matters. The
checkpoint-path coincidence is recorded in this entry too: the SHARED
`opencodeCheckpointDir` is deliberately the pre-split node-local path, and
renaming it later is a migration of every stopped opencode worktree's
history.

**The old-path lock fallback in `readLock`/`removeLock`** (`shared/lock.ts`).
What it reads: `<dataDir>/.server.lock` when `<dataDir>/server/.server.lock`
is absent. Exists for one window: a containerless server that predates the
split is still running when the CLI upgrades, and `yaac server start` must
see it (it would otherwise spawn a second writer on the same, now-migrated,
database) and `yaac server stop` must be able to stop it. What breaks
silently: that second server. Order: keep it as long as
`migrateDataDirLayout`'s lock handling, and remove the two together. Safe
once no pre-split server can still be running — a release boundary, since
nothing records a server's build.

**The `node-local-mount` advisory** (`install/install.ts`, `install/check.ts`).
A tripwire about state, not a shim in the data path: a kind cluster created
before the second extraMount existed holds node-local caches on node disk.
Nothing breaks if it goes; a user with an old cluster simply stops being
told why their pnpm store is cold after every podman-machine restart. Safe
to remove when no kind cluster in use predates it, which `kubectl get nodes
-o yaml` cannot say; a season after release.

**The pre-client-local read fallbacks** (existing entry): its three readers
now spell the data-dir root explicitly (`path.join(getDataDir(), …)`)
because `serverLocalPath` no longer names it. The entry's "what it reads"
line is corrected; nothing else about it changes.

## Tests

### Unit (`unit:shared`)

- `paths.test.ts` `storage tiers`: the three roots resolve to
  `<dataDir>`, `<dataDir>/server`, `<dataDir>/node-local`; each override
  env var re-roots exactly one tier; `projectsRoots()` and
  `worktreeStateRoots()` return two entries; `opencodeDataDir` is under
  the node-local root and `opencodeCheckpointDir` under the shared one,
  with the checkpoint asserted equal to the pre-split spelling and a
  comment naming the legacy-compat entry as the reason the assertion is
  frozen. The "keeps node-local session paths where the single-node
  backend puts them" case is rewritten to freeze the new spellings.
- `env.test.ts`: the three accessors.
- `lock.test.ts`: `readLock` falls back to the old path only when the new
  one has no lock; `removeLock` unlinks whichever it found.
- `server-config.test.ts`, `auth-daemon.test.ts`: the legacy files are
  found at the data dir root, not under `server/`.
- New `data-dir-layout.test.ts`: one `describe('migrateDataDirLayout')`:
  moves every entry, is idempotent, leaves a destination that already
  exists (and says so), leaves a live old lock and unlinks a stale one,
  ignores unknown entries, no-ops on a fresh dir.

### Unit (`unit:server`)

- `substrate/mount-sources.test.ts` (new; one describe per barrel
  function): `resolveMountSource` maps a shared dir, a shared file
  (`type: 'File'` → subPath to the file, `readOnly` kept), a node-local
  dir (node path, `DirectoryOrCreate`), passes `emptyDir`/`pvc` through,
  throws on a server-local path and on an untiered path, and prefers
  node-local when the roots nest (host-shaped roots); `nodeLocalHostPath`;
  `nodeLocalDirsOf` lists dirs only.
- `substrate/pod-spec.test.ts`: the init container (image, root,
  `mkdir`+`chown` to `podUid()`, node root mounted), `preStop`, and a
  `pvc` source with a file subPath render as expected; existing cases
  keep passing unchanged since the source kinds and volume names are as
  before.
- `worktrees/launch.test.ts`: `launchWorkspace` with the roots set to
  disjoint dirs — the applied manifest carries `pv-*` subPath mounts for
  every shared mount, node-path `hp-*` mounts for the node-local ones, the
  init container naming exactly those node dirs, the `preStop` hook, and
  no `hostPath` under the data dir; a spec naming a server-local path
  rejects before `kubectlApply`.
- `install/storage.test.ts` (new): the four manifests (names, `Retain`,
  `claimRef`, `storageClassName: ''`, `volumeName`, access modes, labels,
  `type: 'Directory'`); `ensureStorageClaims` creates the host dirs, applies
  in PV→PVC order, waits on `Bound`, skips a claim already bound to the
  right volume and errors on one bound elsewhere.
- `install/server-deploy.test.ts` "hands the pod what it can no longer
  read off a host": three mounts, three root env vars, `YAAC_DATA_DIR`
  still the host path; `deployServerWorkload` orders refusal → migration
  → claims → image → Deployment.
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
- `cluster/proxy-manifests.test.ts`: a `describe('buildProxyDeploymentManifest')`
  is added (it is a barrel function with no test today): both subPath
  mounts, and no `hostPath` anywhere in the manifest.
- `images/store-writer.test.ts`: writer and cleanup pods mount node paths;
  `generationsInUse` matches by suffix; `removeNodeLocalProject` removes
  both trees.
- `images/node-local-sweep.test.ts` (new): the pod script spares
  `running` ids everywhere and `stopped` ids under `opencode-data` only,
  honours the cutoff, runs once per node, throttles.
- `domain/worktrees/cleanup.test.ts`: `gcOrphanEphemeralModuleDirs` keeps
  its shared cases and asserts `reapNodeLocal` is called with the live and
  recently-stopped sets (fake driver); the once-per-life case goes;
  `deleteWorktreeState` removes the checkpoint dir.
- `domain/worktrees/create.test.ts` (or `worktree-create` in the CLI
  package, whichever pins the mount list today): the checkpoint mount and
  `preStopExec` are on the spec; `ensureSessionStartsLog` and
  `stageWorktreeBin` complete before `launchWorkspace` is called.
- `drivers/containerless/launch.test.ts`: a missing node-local source dir
  is created before linking; `preStopExec` is ignored; `reapNodeLocal`
  removes exactly what the domain loop removed before.
- `main/server-run.test.ts`, `main/lifecycle.test.ts`: the migration runs
  before the lock read on a host and not in-cluster.
- `db/client.test.ts`, `main/log.test.ts`, `test/api/token-auth-flow.test.ts`
  and any other test that spells `<dataDir>/db` or `.server.lock` by hand
  switch to the path helpers.

### API matrix

No route is added or changed; `route-matrix.ts` needs no row. Both matrix
projects must stay green — the k8s one now depends on
`ensureTestStorageClaims` in `createTempDataDir`.

### e2e-containerless

- `server-lifecycle.test.ts`: the lock-path assertion becomes
  `<dataDir>/server/.server.lock`. New case: start a server, add a project,
  stop it, move `server/db` back to `db` (and `server/secret.key` to the
  root), `yaac server start` again — the project still lists, the log
  names the moves, and `db/` is gone from the root.
- `worktree-suite.test.ts`: the discovery-hook case is unchanged; add an
  assertion that a worktree's `.cached-packages` and `opencode-data`
  realize under `<dataDir>/node-local/projects/<slug>`.

### k8s e2e (`test/e2e`, `test/e2e-cli`)

- `worktree-create-suite.test.ts`
  - `provisions pod, worktree, mounts, git, and tmux`: unchanged in
    substance — the container-side paths are identical — plus a read of
    the Job manifest asserting every volume is a `yaac-shared` subPath, an
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
    delete `/var/lib/yaac/node/<hash>/projects/oc-demo/opencode-data/<id>`
    on the node, `worktree restart`, and assert the conversation is listed
    with its message by `GET /session` in the new pod — the checkpoint
    (`<projectPath>/opencode-data/<id>` on the host) is asserted to exist
    right after the stop, which is the `preStop` half.
- `nested-containers.test.ts`: the store assertions that read
  `<dataDir>/shared-images` on the host switch to the node path (through
  the deployed server's own node mount is not visible from the host
  either), i.e. a `podman exec <node>` read of
  `/var/lib/yaac/node/<hash>/shared-images/<slug>`.
- `server.test.ts` (`yaac server lifecycle against the in-cluster
  Deployment`): the `server logs` cases read `<dataDir>/server/server.log`;
  add `the server pod mounts the two claims and nothing under the data
  dir by hostPath` reading the Deployment.
- `cluster-cli.test.ts`: unchanged (it covers refusals; the happy path is
  the verification procedure). Add one refusal: `yaac cluster check`
  against a cluster whose `yaac-shared` claim is absent reports `storage`
  as failed naming install — this needs a cluster, so it lives in
  `test/e2e` with the other cluster-bound files rather than here.
- `test/e2e/*`: the proxy's mounts change shape but not content; the
  egress and ssh-agent files need no edit. Run them.

## Docs to update (same change as the code they describe)

- `docs/server-in-cluster.md`: "Storage is still hostPath" becomes
  "Storage is two claims" (the table above, the PV/PVC shape, why the
  claims are named and the PVs hashed, why `YAAC_DATA_DIR` stays a host
  path); "The e2e tiers run against this" gains the per-namespace claim
  pair and the scratch hostPath that remains test-only; the lease
  paragraph loses nothing.
- `docs/cluster-setup.md`: "What it wires up" item 2 describes two
  extraMounts and the node path; "Multi-node" says the node-local
  extraMount rides the worker copies and that node-local is per node in
  name and shared on kind in fact; "Verifying" describes `storage`,
  `storage-semantics`, the claim-based `probe`/`volume-nodes`, and
  `node-local-mount`; "Deleting the cluster" says the PVs go with the
  cluster and the bytes do not; the closing "Limits" note about one
  filesystem is rewritten around the claim.
- `docs/worktree-storage.md`: the `File` hostPath sentences become
  subPath-to-file, keeping the append-only reasoning.
- `docs/containerless-driver.md`: the layout (`<dataDir>/server`,
  `<dataDir>/node-local`), the start-time migration, `reapNodeLocal`.
- `docs/nested-containers.md`, `docs/trust-split-builds.md`: the store's
  location is the node path; the writer/cleanup pod wording.
- `README.md`: the paths table (opencode data as node-local working copy
  with its checkpoint, `.cached-packages` under `node-local/`,
  `server.log` and `Dockerfile.user` under `server/`), and the sentence
  that says the home directory must be extraMounted.
- `docs/legacy-compat-shims.md`: the entries above.
- `docs/plans/cloud-k8s.md`: "Where things stand" gains the storage
  bullets and drops "Nothing selects `pvc` yet"; step 1 is deleted from
  "The work, in order"; this document is deleted when the step ships.

## Gate: verification procedure

Run on the test rig (its own cluster, data dir and kubeconfig — see the
project's memory note), in this order. Every step must be green before
the next.

1. In the worktree: `pnpm lint`; `pnpm test:unit`; `pnpm vitest run
   --project api-containerless --project e2e-containerless`.
2. Grep gate: `grep -rn hostPath packages/server/src/drivers/k8s
   --include='*.ts'` names only node paths (`gvisor.ts` installer mounts,
   the `certs.d` writers, `nodeLocalNodePath` users, `check.ts`'s node
   probe of the node path) — nothing under the data dir, nothing in
   `proxy-manifests.ts` or `server-deploy.ts`.
3. Upgrade path, single node, EXISTING cluster and data dir: on the rig
   with a project and a stopped opencode worktree that has a conversation,
   `yaac cluster install` (no delete). Assert: the install log lists each
   rename; `ls <dataDir>/server` shows `db`, `server.log`, `secret.key`;
   `kubectl get pv,pvc -n yaac` shows both pairs `Bound` with `Retain`;
   `yaac cluster check` is green except the `node-local-mount` advisory;
   `yaac worktree restart` of the opencode worktree resumes its
   conversation (the pre-existing directory served as the checkpoint);
   `yaac project list` and every stopped worktree are unchanged.
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
   against a `yaac-shared` subPath on kind, to record that the
   session-starts log's one-writer contract is what keeps it clean (the
   spike found two-sandbox O_APPEND loss on a gofer-backed ext4 hostPath,
   and that finding is unchanged by this step).

## Suggested commit order

Each commit lands green on `pnpm lint`, `pnpm test:unit` and the
containerless tiers; the k8s tiers are run at the commits marked.

1. **Tier roots and the host layout.** `env.ts` accessors,
   `paths.ts` roots and `ensureDataDir`, `data-dir-layout.ts` and its
   test, the lock fallback, the legacy-path spellings in
   `server-config.ts`/`auth-daemon.ts`, `tmuxSockDir` hashing
   `getDataDir()`, the migration calls in `server-run.ts`, `lifecycle.ts`
   and `deployServerWorkload`, `paths.test.ts` rewritten, the
   e2e-containerless lifecycle case, the two legacy-compat entries, the
   containerless doc. The k8s pod at this commit still hostPath-mounts the
   data dir, so its `<dataDir>/server` is a subdirectory of that mount and
   everything works. Run the k8s e2e here: it proves the migration runs
   before the pod and the pod finds the moved DB.
2. **Claims, PVs and the storage vocabulary.** `storage-constants.ts`,
   `install/storage.ts` with tests, `ensureStorageClaims` called from
   `deployServerWorkload` and `deployTestServer`, the harness's
   `ensureTestStorageClaims`, the PV sweeps in `cluster-setup.ts` and
   `global-setup.ts`. Nothing mounts the claims yet: they bind and sit.
   Green on k8s e2e with no behavior change.
3. **The pod side: three roots, the resolver, the init container.**
   `mount-sources.ts`, `pod-spec.ts` (init container, `preStop`
   plumbing), `launch.ts`, the server Deployment's mounts and env, the
   proxy subPaths, the store writer's node paths and suffix match,
   `removeNodeLocalProject`, the kind extraMount and host-dir creation,
   the node-local half of `migrateDataDirLayout`, `create.ts` dropping the
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

- **subPath to a file on a hostPath PV under gVisor.** kubelet realizes a
  file subPath as a bind mount, which is what a `type: File` hostPath was;
  runsc sees a bind either way. Verify with a scratch pod before commit 3,
  including `readOnly: true` on a file subPath (the worktree-bin scripts)
  and an append from inside the sandbox (session-starts). If a file
  subPath misbehaves, the fallback is a subPath to the `meta/` directory
  with the hook writing `<id>.session-starts.jsonl` inside it — a
  one-line change in the hook and the mount, no format change.
- **A subPath that is missing at pod create becomes a root-owned
  directory.** Every shared file or dir a pod mounts must exist before the
  Job is applied. The create already orders it so; the unit test in
  commit 3 pins it. The same applies to the proxy's `.credentials` and
  `run/proxy-data` (`ensureProxyResources` creates them first) and to
  `cacheVolumes` dirs.
- **opencode's SQLite filename and mode.** Read the data dir of a running
  pod at the pinned release to confirm the file name and whether WAL
  sidecars exist; the backup API copes with WAL, and the script globs
  `*.db`, but the restore must not copy stale `-wal`/`-shm` files beside a
  freshly restored database — exclude them.
- **`preStop` against a 5s grace.** A backup of a few-MB database is
  well under a second; the hook is bounded by `terminationGracePeriodSeconds`
  and a slow one is killed, not waited on. If the e2e stop case shows
  the checkpoint missing, raise the grace on worktree pods to 10s rather
  than shortening the hook.
- **Node-local disk growth on a long-lived dev cluster.** Every e2e file
  leaves `/var/lib/yaac/node/<testHash>` on the node until the per-file
  cleanup pod runs; an interrupted run leaks it to the global sweep. Both
  are in the plan; check `du -sh /var/lib/yaac/node` on the rig after the
  first full run.
- **Pre-upgrade worktrees.** A worktree Job created before commit 3 mounts
  hostPaths under the data dir; on kind those still resolve through the
  `$HOME` extraMount, so it keeps running, is listed (labels unchanged),
  and stops normally. Its opencode data is under the old path, which is
  the checkpoint path — a restart resumes it. Its nested image-store
  generation is protected by the suffix match. Nothing else reaches into
  a running pod's mounts.
- **An existing kind cluster has no node-local extraMount.** Caches land
  on node disk until the cluster is recreated; correctness is unaffected,
  and the advisory says so. The rig itself is such a cluster: step 3 of
  the procedure deliberately runs against it before step 4 recreates it.
- **`storage-semantics` on macOS.** `fsprobe.py` may report lock or
  ownership differences over virtiofs. It is warn-level for exactly that
  reason; the question is whether any of its findings names something a
  worktree relies on today — the answer feeds the byo promotion in step 6.
- **The api-k8s tier's in-process server** creates pods from the host with
  host-shaped roots (`<dataDir>/node-local` nested under `<dataDir>`). The
  resolver's node-local-first order handles it; the store writer's
  `listStoreGenerations` reads `<dataDir>/node-local/shared-images` on the
  host, which no node writes to, so that tier always mounts no store.
  That is what it does today for a different reason and no api test
  asserts a store mount.
- **The layout migration and a data dir shared by two installs.** Two
  yaac servers on one data dir is already unsupported (the lock forbids
  it); the migration adds nothing new, but a containerless server started
  while an old-binary server holds the old-path lock is refused by the
  lock fallback rather than by a check of its own. That refusal message
  should name the upgrade (`yaac server restart`).
- **`--adopt-cni` and the claims.** Static hostPath PVs into the data dir
  are wrong on any cluster that is not this host's kind, and adoption
  targets exactly one such cluster today (a hand-made kind). Step 6
  renames it `--byo` and replaces the PV pair with StorageClass claims;
  until then adoption applies kind's pair and the note it prints says so.

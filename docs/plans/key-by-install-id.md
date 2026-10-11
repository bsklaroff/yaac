# Keying cluster objects by install id, not by data-dir path

A k8s install names and labels its cluster objects with `dataDirHash()`, the
first 16 hex characters of a sha256 of the data dir's path. So the install's
identity in the cluster is its path on the host, and moving the data dir
(for example, Hetzner's `~/.yaac` to the new default `~/.yaac-cluster`)
re-keys the install. Running workspaces become invisible to the new server,
and the cache claims and node-local trees start over under new names.

`installId`, the UUID minted by the first `yaac cluster install` and kept in
`install.json`, is already the install's identity for the byo Deployment
refusal, class-volume re-adoption, the binder's `.yaac-install` marker and
the byo uninstall hint. This plan makes it the only identity. `dataDirHash()`
and the four `*-data-dir-hash` label keys are removed. Every object carries
`yaac.install-id=<installId>`, and names and node paths use the id. Existing
installs keep their old labels as a legacy-compat shim while they move over.

The path still says where a kind install's bytes live. It no longer says
what the install is called.

The same change takes the install record out of
`~/.yaac-client/server.json` (see "The install record leaves
`server.json`"). Today that file keeps a copy of the record, which ties the
client config to the install's data dir and turns a moved data dir back
into a cluster install at its old path.

## What the hash does today

**Labels.** Four keys share the value:

| Key | Carried by | Selected by |
|---|---|---|
| `yaac.data-dir-hash` | workspace Jobs and pods (`launch.ts`), builder pods, proxies (`proxy-manifests.ts`), the server and server-front pods, storage PVs and PVCs (`storage.ts`) | `workspacePodSelector` and `workspaceJobSelector` (plus `yaac.workspace-id`), the leaked-builder sweep (plus `yaac.role=builder`), `runStorageCheck`, `readoptVolume`, the e2e `cleanupWorkspaceJobs` |
| `yaac.registry-data-dir-hash` | the main registry and project registry objects | `installRegistrySelector` (plus `app`) |
| `yaac.sweep-data-dir-hash` | node-local sweep and node image GC pods | their own cleanup (plus `app`) |
| `yaac.store-data-dir-hash` | store-writer pods | their own cleanup (plus `app`) |

The three extra keys exist so that a bare `yaac.data-dir-hash` selector
never picks up registries or sweep pods. Every selector already pairs the
install label with a discriminator (`yaac.workspace-id`, `yaac.role`, `app`,
`yaac.claim`), so one key is enough, provided that stays true. A unit test
on the selector builders guards it (see Tests).

**No selector depends on it.** Every Deployment selector is `{app}` or
`{app, project-id}`. Changing the label is an ordinary pod-template change
(a rollout), and no object has to be recreated.

**Names:**
- `yaac-registry-storage-<hash>` (`mainRegistryPvcName`) and
  `yaac-npm-cache-storage-<hash>` (`npmCachePvcName`): cache claims, in the
  default class on byo and local-path on kind.
- kind's static PVs `<claim>-<hash>` (`staticVolumeName`). A bound claim's
  `volumeName` can't change. Byo's `yaac-checkouts` PV is named after the
  global volume, so byo has no hashed PV names.

**A node path:** `NODE_LOCAL_NODE_ROOT/<hash>` (`nodeLocalNodePath`), used
by workspace, server, store-writer and sweep hostPath mounts, by
`nodeLocalDirsOf`, and by kind's extraMount. On kind it is the mount point
of `<dataDir>/node-local` inside every node container, fixed when the
cluster is created. On byo it is a `DirectoryOrCreate` hostPath on each
node.

**Out of scope:** `installTmpDir()` in `paths.ts` hashes the path to keep
host socket dirs apart. It names nothing in the cluster and is correctly
per-path. The storage locations `globalRoot()`, `serverLocalRoot()` and
`nodeLocalRoot()` stay path-based by design.

## Design

### One identity: `installId()`

- `dataDirHash()` in `substrate/api.ts` is deleted, and
  `installId()` replaces it. It is synchronous, like every call site. It
  returns `YAAC_INSTALL_ID` (read in `env.ts`) when that is set, otherwise
  the value bound for this process by `bindInstallId(id)`. With neither, it
  throws: a k8s code path without an id is a bug, and the containerless
  driver never calls it.
- `LABEL_DATA_DIR_HASH` and its three siblings are deleted. Every writer
  sets `LABEL_INSTALL_ID` (`yaac.install-id`, already in
  `storage-constants.ts`) to `installId()`, and every selector uses
  `yaac.install-id=<id>` with its existing discriminator. New objects carry
  no old label, even on an install being moved over.
- Names become `yaac-registry-storage-<id>`, `yaac-npm-cache-storage-<id>`
  and `<claim>-<id>`. The node path becomes `NODE_LOCAL_NODE_ROOT/<id>`. A
  UUID is valid in a label value, an object name and a path.
- **Who binds it.** On the host, `yaac cluster install` mints or reads the id
  (as it does today) and binds it before `createKindCluster`, because
  `renderKindConfig` bakes `nodeLocalNodePath()` into the node mounts. The
  `cluster` command's `preAction` hook in `packages/cli/src/cli.ts` binds the
  recorded id for every other subcommand. In the pod, `buildServerEnv` passes
  `YAAC_INSTALL_ID`. In the test rigs, `packages/test-utils` mints a
  `test-<random>` id per file, sets it beside `YAAC_DATA_DIR` (`cli.ts`,
  `kind-byo.ts`), and passes it to the server it deploys. Today's
  `test-${dataDirHash()}` in `storage-claims.ts` goes away.
- **`YAAC_DATA_DIR` in the server pod.** `buildServerEnv` passes the host's
  path only so the hash matches. Every tier is overridden by
  `YAAC_GLOBAL_ROOT` and the other root variables. Once the id comes from
  `YAAC_INSTALL_ID`, audit what the pod still reads through `getDataDir()`
  (`installTmpDir()`, error text in `driver-choice.ts`, anything reached
  from `lifecycle.ts`). If nothing depends on the value, drop the variable
  and its comment.

### The two checks that read the hash

- **`readoptVolume` (`storage.ts`).** Today it refuses to provision an empty
  volume over a Released one left by "an install from this same path, but
  not by this one" (a lost `install.json` after the namespace was deleted).
  It becomes path-free. The server Deployment's name is fixed, so a
  namespace holds one install, and any loose volume in this namespace for
  this claim with another `yaac.install-id` is an earlier install's
  leftover. The adopt hint (`kubectl label pv … yaac.install-id=<id>
  --overwrite`) stays. The "provision fresh" hint becomes removing
  `yaac.claim`.
- **`runStorageCheck` (`check.ts`).** It matches volumes by `installId` when
  there is a record and by the hash otherwise, because an e2e file's server
  has no record. Every process now has an id, so it matches on
  `yaac.install-id` alone and the branch goes.

## The install record leaves `server.json`

Today `server.json` carries a copy of the client data dir's install record
(`driver`, `installId`, `clusterUid`, `kubeContext`, `byo`, `origin`),
written by two shims in `packages/shared`:

- **The mirror.** `recordInstall` (`mirrorIntoServerJson`) and
  `writeServerConfig` write the record beside the selection, and
  `clearServerConfig` keeps the file while it has one. It exists so that an
  older `yaac` that reads only `server.json` still sees the driver.
  Compatibility with an older `yaac` is not kept, so the mirror is deleted:
  `mirrorIntoServerJson`, the record spread in `writeServerConfig`, and
  `clearServerConfig`'s record branch, which leaves it a plain `fs.rm`.
  `server.json` then holds only `url`, `enabled` and `saved`, which is
  already all `readServerConfig` returns.
- **The lift.** `liftLegacyRecord` copies a record from `server.json` into
  a missing or torn `install.json`. It becomes a move that also cleans up
  files where `install.json` already exists, which is every machine running
  current `main`, since the mirror rewrote them. In `install-record.ts`,
  `retireServerJsonRecord()`:
  1. reads `server.json`, and returns at once if it carries none of the
     install keys (the normal case after the first run);
  2. if `<clientDataDir>/install.json` is missing or torn, writes the
     record there (exclusive when missing, as the lift does today). An
     existing, readable `install.json` wins and is left alone, because the
     mirror only ever copied it;
  3. rewrites `server.json` without the install keys, through the same
     atomic `writeJsonFile` that `writeServerConfig` uses. If what's left is
     the empty selection the mirror wrote for a machine with no server
     selected (`url: ''`, `saved: []`), it deletes the file instead.

  It runs from `readServerConfig` and from `readInstallRecord` for the
  client data dir, so the first upgraded command of any kind, whether
  client, `server` or `cluster`, cleans the file. `clusterDataDir()` reads
  through `readInstallRecord`, so the `~/.yaac` cluster rule still sees a
  record that only `server.json` held.

Step 3 can race a concurrent `writeServerConfig` and lose a selection
change made in the same instant. It only happens once per machine, so
`writeServerConfig` re-reading and retrying isn't worth it. The selection
is easy to redo.

Once `server.json` is clean, a moved data dir no longer gets its old record
lifted back into `~/.yaac`, so neither move procedure below edits
`server.json`.

## Moving existing installs over

An install created before this change has objects labelled only with the
old keys, two kinds of objects named with its hash, and possibly a node
mount point named with its hash. It moves in three parts. Each part is a
legacy-compat shim with its own section in `docs/legacy-compat-shims.md`.

### 1. The legacy hash, read from the cluster

`install.json` gains `legacyDataDirHash`. `yaac cluster install` fills it
when the record has no such field and the install's objects carry an old
label. It reads the value from the cluster, not from the path: the server
Deployment's pod template label `yaac.data-dir-hash`, or failing that (the
namespace was deleted) a `yaac-global` PV labelled with this
`yaac.install-namespace`. Reading it from the cluster means the code never
hashes a path again. It also means the backfill is right even for a data
dir that was moved before upgrading. `buildServerEnv` passes it to the pod
as `YAAC_LEGACY_DATA_DIR_HASH`, and a host CLI command binds it next to the
id.

`install.json` drops the field once the install has nothing left named
after the hash (part 3). Every shim below is a no-op for an install without
it, which includes every install created after this change.

### 2. Labels: relabel what predates the upgrade

Rolling back to an older `yaac` is not supported, so new objects are never
stamped with an old label. The old labels stay on the objects that already
have them, and the relabel is what reads them.

- **Relabel.** Objects created before the upgrade carry only the old key.
  SSA-applied objects (Deployments, Services, PVCs, policies) pick up the
  new label the next time they are applied. That covers the server and
  server-front, the main registry, the npm cache, proxies and project
  registries when they converge. Objects nothing re-applies need a one-shot
  label patch: workspace Jobs and pods (including prewarmed spares),
  builder, store-writer and sweep pods, storage PVs and PVCs, and any
  project registry that doesn't converge before its first listing.
  - **Where it runs.** In the server at startup, as a reconcile step,
    before the first workspace listing.
  - **Why the server and not install.** The old server keeps running during
    `cluster install` and can create objects after the CLI has relabelled.
    The new server is the only writer once it starts, because the Deployment
    uses `Recreate`.
  - **What it does.** For each kind in that list, it adds
    `yaac.install-id=<id>` to every object in the install's namespaces
    (`k8sNamespace()` and the project registry namespaces) whose old key
    equals `YAAC_LEGACY_DATA_DIR_HASH`.
  - **Repeating it.** It runs on every start while the field is set, so it
    is repeatable and finds nothing to do after the first run.

  Old labels are never stripped. Once the relabel has run, nothing reads
  them.

### 3. Names that can't change in place

| Object | kind | byo |
|---|---|---|
| Static PVs `<claim>-<hash>` | Kept. A bound claim's volume can't change, so `ensureStaticClaims` accepts a claim bound to `<claim>-<legacy>`. Goes when the cluster is recreated. | None (class volumes, and `yaac-checkouts` is named after the global volume). |
| Node-local mount point `/var/lib/yaac/node/<hash>` | Kept. `nodeLocalNodePath()` returns the legacy path, because kind's extraMount can't change. Goes when the cluster is recreated. | Switched at the first `cluster install` that finds **no workspace pods**. Running pods hold mounts and image stores under the old path. Until then the install logs that the switch is deferred and keeps the legacy path. After the switch, a node sweep pod deletes the old tree on every node. |
| Cache claims `yaac-registry-storage-<hash>`, `yaac-npm-cache-storage-<hash>` | Kept until the cluster is recreated (they're local-path volumes on the node). | Switched to `-<id>`, and the old claims deleted once the new Deployment rolls. The registry and npm cache start empty: install re-pushes built-in images, and project images rebuild on demand (see open questions). |

When an install has nothing left under its hash, install removes
`legacyDataDirHash` from `install.json`, and the server stops relabelling:

- **kind:** `runClusterInstall` creates a new kind cluster (after `yaac
  cluster delete`). The old static PVs, cache claims and node mounts went
  with the old cluster.
- **byo:** the node path and cache claims have switched.

## Tests

- **Unit (`unit:server`).** Every `dataDirHash` mock (`'ddh16'` in
  `check.test.ts`, `install.test.ts`, `server-deploy.test.ts`,
  `storage.test.ts`, `mount-sources.test.ts`) and every expected label or
  name built from it (about 15 files under `test/drivers/k8s/`) moves to
  `installId()` and `yaac.install-id`. `unit-setup.ts` sets
  `YAAC_INSTALL_ID`. `api.test.ts`'s `describe('dataDirHash')` becomes
  `installId`: env first, then the bound value, otherwise it throws.
- **New behaviour, through the barrel functions that own it:**
  - `runClusterInstall` on a fresh data dir renders the kind mount at
    `NODE_LOCAL_NODE_ROOT/<installId>` and applies only `yaac.install-id`
    labels;
  - on a cluster whose server Deployment carries `yaac.data-dir-hash`, it
    records `legacyDataDirHash` from that label, stamps only
    `yaac.install-id` on what it applies, keeps the
    legacy static PV names and node path on kind, and on byo switches the
    node path and cache claims only when no workspace pods exist;
  - the server's startup relabel adds `yaac.install-id` to a pre-existing
    workspace Job and pod and to a leaked builder pod, and the workspace
    listing then sees them;
  - a data dir moved to another path applies the same labels and names.
    This is the property the change exists for;
  - `readoptVolume`'s path-free refusal and its two hints;
  - one test over the selector builders asserting that each pairs
    `yaac.install-id` with a discriminator. Folding four keys into one only
    stays safe while that holds.
- **Shared (`unit:shared`).**
  - `legacyDataDirHash` round-trips through `install.json`.
  - `server.json` is never written with an install key by `recordInstall`,
    `writeServerConfig` or `clearServerConfig`.
  - `retireServerJsonRecord`, driven through `readServerConfig` and
    `readInstallRecord`, behaves as follows:
    - a `server.json` holding a record and no `install.json` ends with the
      record in `install.json` and `server.json` holding only the selection;
    - with an `install.json` already present, the file is left alone and
      `server.json` is stripped;
    - a mirrored empty selection is deleted;
    - a torn `install.json` is re-lifted;
    - a moved data dir is not recreated in `~/.yaac`, so `clusterDataDir()`
      returns `~/.yaac-cluster`.
  - The existing tests that assert the mirror are deleted.
- **E2e.** No CLI argument or option changes, so `test/e2e-cli` needs no
  new case. Run `test:api-k8s` and `e2e` on a host, since every label in
  them now comes through `installId()`. An upgrade from a hash-labelled
  install is best verified by hand on Hetzner (below). An e2e for it would
  need a fixture deployed by the previous release.

## Legacy compat entries

One section each in `docs/legacy-compat-shims.md`.

**`server.json` record retirement.** This replaces the current entry "The
install record in `server.json`: the lift and the mirror". The mirror half
is deleted outright rather than kept as a shim.
- *What it reads:* install keys in `<clientDataDir>-client/server.json`.
- *What breaks silently if it goes too early:* an install from before
  `install.json` loses its record, so a host `yaac server start` is
  allowed on its data dir, and `yaac cluster install` mints a new id and
  refuses its own byo Deployment as another install's. A cluster install
  whose data dir was moved gets the stale record lifted back into
  `~/.yaac`, and `clusterDataDir()` points there.
- *When it is safe to remove:* once no `server.json` on any machine
  carries an install key, that is, every machine has run one upgraded
  `yaac` command.
- *Order:* independent of the entries below. The `~/.yaac` cluster rule
  finds a legacy record through it, so it goes with or after that rule.

The install-id shims, removed in this order:

1. **The startup relabel.** Safe to remove once every legacy install has
   started an upgraded server, so every object that predates it has the new
   label or is gone. If removed too early, pre-upgrade workspaces stay
   invisible: their pods run on and their Jobs leak.
2. **Legacy names and node path** (`ensureStaticClaims`'s acceptance,
   `nodeLocalNodePath()`'s legacy branch, the byo switch and old-tree
   sweep). Safe to remove once no install records `legacyDataDirHash`. For
   kind that means each legacy cluster has been recreated, and nothing
   forces that. If removed too early on kind, the server mounts a node path
   that the extraMount doesn't back, so node-local data lands on the node
   container's own filesystem and is lost with it. Claims bound to legacy
   PV names make install throw.
3. **The `legacyDataDirHash` backfill and field.** Remove together with
   2.

## Moving an install, once this ships

Document this in `docs/cluster-setup.md`, and replace "Moving one by hand"
in the `~/.yaac` cluster-rule shim entry:

- **byo.** Make sure an upgraded `yaac cluster install` has run, which also
  cleans `server.json`. Then `mv` the data dir and re-run `yaac cluster
  install` with the same flags. Nothing in the cluster is named after the
  path, so nothing changes there.
- **kind.** Storage is tied to the path, so the move rebuilds the cluster
  without losing data: `yaac cluster delete` (running workspaces are lost),
  `mv`, `yaac cluster install`. The new
  cluster's PVs and extraMount point at the new path, under the same id.
  The `$HOME → $HOME` mount means a destination outside `$HOME` won't
  resolve on the node.

## Rollout on Hetzner (byo)

1. Stop every workspace, so the node path and cache claims switch on the
   first run instead of being deferred. Deploy as usual (pull, build,
   `npm install -g .`), then run `yaac cluster install --byo
   --rwx-storage-class yaac-nfs`. It moves the record from `server.json`
   into `~/.yaac/install.json` (afterwards `server.json` holds only `url`,
   `enabled` and `saved`), records `legacyDataDirHash` from the server
   Deployment, switches the node path and cache claims, and clears the
   field. `kubectl -n yaac get pods --show-labels` shows `yaac.install-id`
   on the server pod, and `cluster check` passes.
2. Create a workspace, then move the data dir with the byo steps above.
   `cluster check` passes, and that workspace is still listed and
   reachable.

## Docs to update in the same change

- `docs/server-in-cluster.md`: storage claims, the server's environment,
  install identity.
- `docs/cluster-setup.md`: moving an install.
- `docs/legacy-compat-shims.md`: the entries above, which replace "The
  install record in `server.json`: the lift and the mirror", and the rewritten "Moving one by hand".
- `docs/server-selection.md`: `server.json` holds only the selection.
- The module comments in `server-config.ts` and `install-record.ts`.
- `AGENTS.md`, if it mentions the hash.
- The comments in `k8s/kind-config.yaml` and
  `substrate/storage-constants.ts` describing `/var/lib/yaac/node/<hash>`.
- Check `docs/nested-containers.md`, `docs/containerless-driver.md`,
  `docs/plans/session-operator.md` and `docs/plans/storage-gc-gaps.md`.
- `grep -rn 'data-dir-hash\|dataDirHash'` must come back empty outside the
  shim code and `docs/legacy-compat-shims.md`.

## Open questions

- **The byo cache claims.** Switching empties the main registry, so every
  project image rebuilds on its next use. The alternative is keeping the
  legacy names for byo installs too. That costs nothing at upgrade, but it
  leaves a hash-named object on byo installs permanently, because nothing
  else ever recreates them. The plan assumes switching.
- **Where `bindInstallId` lives.** In `substrate/api.ts` beside
  `installId()`, or in `env.ts` as a settable override? Putting it in the
  substrate keeps `env.ts` read-only.

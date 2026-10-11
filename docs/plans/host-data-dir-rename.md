# Move the host server's data dir to `~/.yaac-server`

With no `YAAC_DATA_DIR`, the host (containerless) server keeps its data in
`~/.yaac`, while a cluster install uses `~/.yaac-cluster` and clients use
`~/.yaac-client`. This plan renames the host server's default to
`~/.yaac-server`, so the three defaults share one shape (`~/.yaac-<role>`).
Existing `~/.yaac` host installs are moved by the next `yaac server
start|restart` or `yaac cluster install`, provided nothing is running from
them and `~/.yaac-server` is free.

A data dir named by `YAAC_DATA_DIR` (including one set to `~/.yaac`) is
never moved or redirected. That dir is the install by definition.

## Target layout (no override)

| Role | Default | With `YAAC_DATA_DIR=X` |
|---|---|---|
| host server | `~/.yaac-server` | `X` |
| cluster | `~/.yaac-cluster` | `X` |
| client tier | `~/.yaac-client` | `X-client` |

The client tier stays where it is. `server.json` is not moved and the
registered origin does not change, so the CLI, the desktop app and the
auth daemon need no migration of their own.

## Why a plain `mv` is not enough

Three things tie a host install to its path. Each one constrains when the
move can run.

- **Running workspaces.** A containerless workspace is a tmux server that
  outlives `yaac server restart` (docs/containerless-driver.md). Its
  agents hold absolute paths under the data dir: the env vars for tool
  homes, the symlinks in their private `$HOME`, and the checkout as their
  cwd. Its socket lives in `installTmpDir()`, which is keyed by a hash of
  the data dir's path. After a move, the server would not find these
  sockets, and the agents' paths would point nowhere. So the move runs
  only when no workspace is up. A stopped workspace is safe, because every
  launch rewrites its path-dependent state, including the alternates line
  (`buildCloneLinkExec`) and the HOME links.
- **The running server.** It holds the DB open and its lock under
  `server-local/`. The move runs only when the lock is not live.
- **The mirrored install record.** `~/.yaac-client/server.json` carries a
  copy of `~/.yaac`'s `install.json` for older CLIs (the "lift" and
  "mirror" shims in docs/legacy-compat-shims.md). If the move left that
  copy behind, the next `readInstallRecord(~/.yaac)` would lift it and
  recreate `~/.yaac`. The move therefore strips those fields from
  `server.json`.

A **cluster** install in `~/.yaac` is not moved (see "Out of scope").

## Read-time fallback

Until the move happens, everything must keep resolving the host install to
`~/.yaac`. Otherwise an upgraded CLI would see `~/.yaac-server` as empty:
`yaac server status` would report "not running" while the old server
serves, and the desktop app would offer to start a second, empty server.

Change the default branch of the host data dir in
`packages/shared/src/paths.ts`, resolved once per process and cached:

- Use `~/.yaac` when all of these hold:
  - `~/.yaac-server` does not exist;
  - `~/.yaac/server-local` exists (some server has run there);
  - `~/.yaac/install.json` does not record `driver: k8s`. This is a sync
    read, because `paths.ts` cannot import `#install-record` without a
    cycle.
- Otherwise use `~/.yaac-server`.

The move clears the cache (an exported reset next to `setDataDir`), so a
`restart` that stops on `~/.yaac` starts on `~/.yaac-server`. The detached
`yaac server run` child resolves the path itself, after the move, and gets
the same answer.

A pre-`install.json` cluster install whose record exists only in
`server.json` passes the sync check and resolves to `~/.yaac`. That is
still safe, because every command that acts on the install reads the
record through `readInstallRecord`, whose lift sees `k8s`:
`refuseHostVerbOnCluster` refuses, the move skips, and `clusterDataDir`
keeps `~/.yaac`.

## The move

The new module `packages/shared/src/host-data-dir.ts` exports
`moveLegacyHostDataDir(): Promise<void>`. It works on explicit paths, never
on `getDataDir()`, because `cluster install` has already pointed this
process at the cluster's data dir. It does nothing when:

1. `YAAC_DATA_DIR` (or the `setDataDir` hook) names a dir;
2. `~/.yaac` does not exist;
3. `readInstallRecord(~/.yaac)` says `k8s`, so the existing cluster rule
   applies;
4. `~/.yaac-server` already exists. In this case it warns once that both
   exist, that `~/.yaac-server` is in use, and that `~/.yaac` is left
   alone.

Otherwise it checks that nothing is running, then moves the dir:

- **Server.** It reads `~/.yaac/server-local/<lock>`. If `isLockLive` says
  the lock is live, it skips. `startServer` then reports the server as
  already running, which is correct, since the fallback still points there.
- **Workspaces.** It tries `net.connect` on each `*.sock` in
  `installTmpDir(~/.yaac)`. That function gets an optional `dataDir`
  parameter. If any socket answers, it skips with a warning, for example:
  "`~/.yaac` stays in use while workspaces run from it; it moves to
  `~/.yaac-server` on the first `yaac server restart` after they stop."
  The server's own `git-agent.sock` is in the same dir, so this check also
  covers a server whose lock is torn.
- **Move.** It runs `fs.rename(~/.yaac, ~/.yaac-server)`. Both paths are
  under `$HOME`, so they are on one filesystem.
- It then rewrites `server.json` with only `url`, `enabled` and `saved`,
  using `writeJsonFile` directly rather than `writeServerConfig`, which
  would read, and so lift, the old record first.
- It clears the cached host data dir and logs `[yaac] moved ~/.yaac to
  ~/.yaac-server`.

The move is not repeated on every command. Read-only commands rely on the
fallback; only the commands that set up a server move the dir.

### Call sites

- `startServer` in `packages/server/src/main/lifecycle.ts`: first line,
  before `ensureDataDir`. This covers `yaac server start` and also
  `restart`, which calls `stopServer` (still on `~/.yaac`) and then
  `startServer`. It also covers the desktop app's setup button, which runs
  `yaac server start`.
- The `cluster install` action in `packages/cli/src/cli.ts`: before
  `runClusterInstall`. A containerless `~/.yaac` is no obstacle to a
  cluster install, but this command is the other "set this machine up"
  entry point, including the desktop app's.

## Out of scope: a cluster install in `~/.yaac`

A cluster install in `~/.yaac` stays put (the existing `clusterDataDir`
rule). It cannot be moved in place:

- its static PVs are hostPath volumes into `~/.yaac/global` and
  `server-local`, and their names include `dataDirHash()`;
- the kind node's `<dataDir>/node-local` extraMount is fixed when the
  cluster is created;
- a bound claim's volume is immutable.

A moved dir comes up as the empty install described in
docs/legacy-compat-shims.md.

One possible extension, not planned: `yaac cluster install` could move a
kind-backed `~/.yaac` to `~/.yaac-cluster` when that install's kind
cluster no longer exists, because the fresh cluster would mount the new
path and bind fresh PVs to the same data. A byo install would never move.

## Code changes

- `packages/shared/src/paths.ts`: add `hostDataDir()`, with
  `named ?? defaultHostDataDir()` (the fallback above). Leave
  `ambientDataDir` unchanged. `clientDataDir()` stays `named ?? ~/.yaac`. That is still the
  dir whose `-client` sibling is the client tier and whose record
  `server.json` mirrors, so the lift, the mirror, `clusterDataDir` and
  `cli.ts`'s `refuseClusterOnContainerless` keep their behavior. Rewrite
  its doc comment to say it names the client tier and the mirrored record,
  not an install. `getDataDir()` uses `installDataDir || hostDataDir()`.
  `installTmpDir(dataDir = getDataDir())`.
- `packages/test-utils/src/tmp.ts`: keep reading the env-only dir. Tests
  always set `YAAC_DATA_DIR`, so `e2e-tmp` does not move.
- `packages/shared/src/env.ts`: update the `dataDirOverride` comment.
- `packages/cli/src/cli.ts`: change the `server logs` description to
  `~/.yaac-server/server-local/server.log`, and add the `cluster install`
  call site.
- `packages/desktop/src/server-control.ts`: `hostStatus`'s `k8s` guard can
  now be hit only with `YAAC_DATA_DIR` naming a cluster install, or with
  the pre-`install.json` record above. Keep the guard and update its
  comment.
- `packages/server/src/domain/auth/credential-sync.ts`: fix its stale
  `~/.yaac/projects` comment while touching paths.

## Docs

- Replace the host's `~/.yaac` with `~/.yaac-server` in:
  - README.md;
  - docs/containerless-driver.md (prose and the paths table);
  - docs/server-selection.md (table row and prose);
  - docs/server-in-cluster.md (lines 63 and 595: the client-tier example
    becomes "`~/.yaac-client` by default, `X-client` for `YAAC_DATA_DIR=X`");
  - docs/environment-variables.md (default column and the `secret.key`
    paths);
  - docs/cluster-setup.md;
  - docs/workspace-storage.md, where needed.
- docs/legacy-compat-shims.md: add a section, "A host install that still
  lives in `~/.yaac`", covering the fallback and the move:
  - **Reads:** `~/.yaac/server-local`, `~/.yaac/install.json`, the old
    install's tmp sockets, and `server.json`'s mirrored fields.
  - **Breaks silently if deleted early:** an unmoved install looks empty
    and a second server starts beside the old one; or a lifted record
    recreates `~/.yaac`.
  - **Safe to remove when:** no machine has `~/.yaac/server-local` that is
    not a cluster install.
  - **Order:** remove it before or with the lift/mirror pair. The move's
    `server.json` strip exists only because of the mirror, and the
    fallback's k8s check leans on the `~/.yaac` cluster rule.
- docs/legacy-compat-shims.md, `~/.yaac` cluster entry: change "beside the
  host server's `~/.yaac`" to `~/.yaac-server`. The manual-move recipe
  stays valid.

## Tests

The e2e and CLI tiers always set `YAAC_DATA_DIR`, where the fallback and
the move are no-ops by design, so this is unit-only. Say so in the PR.

`packages/shared/test/`:

- `paths.test.ts`: with `os.homedir` pointed at a temp dir, check each
  case of the default resolution:
  - nothing exists, giving `~/.yaac-server`;
  - an unmoved host `~/.yaac`, giving `~/.yaac`;
  - a cluster `~/.yaac`, giving `~/.yaac-server`;
  - both dirs exist, giving `~/.yaac-server`;
  - a named dir always wins.

  Also check that the client tier stays at `~/.yaac-client`.
- `host-data-dir.test.ts`, one `describe` for `moveLegacyHostDataDir`:
  - a movable host `~/.yaac` moves, `server.json` loses its install fields
    but keeps the selection, and a later `readInstallRecord(~/.yaac)` does
    not recreate the dir;
  - a live lock blocks the move (a lock carrying this process's pid);
  - a listening socket in the old tmp dir blocks it (a `net.Server` there);
  - a cluster `~/.yaac` and a named data dir are left alone.
- `install-record.test.ts`: the existing `clusterDataDir` cases should
  pass unchanged. Run them to confirm the client-dir semantics did not
  shift.

## Open questions

- Should a blocked move also be offered by `yaac server status` (as a hint
  line), so the user learns why `~/.yaac` is still in use without running
  a restart?
- Should a cluster install in `~/.yaac` be moved when its kind cluster is
  gone (the extension above)?

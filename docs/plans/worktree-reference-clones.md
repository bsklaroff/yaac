# Worktrees as reference clones

## Problem

A yaac worktree is a `git worktree add` linked checkout of the project's
clone at `global/projects/<slug>/repo`. Its git state is split across two
places, and one of them is shared:

- `worktrees/<id>/.git`: a file, `gitdir: <admin dir>`
- `repo/.git/worktrees/<id>/`: the admin dir (HEAD, index, reflog,
  in-progress merge/rebase state)
- **everything else is shared across worktrees**: objects, every ref
  (`refs/heads/*`, `refs/tags/*`, `refs/stash`, `refs/remotes/origin/*`),
  `config`, `hooks/`, `info/`, `modules/`

Under k8s every worktree pod mounts the whole `repo/.git` read-write at
`/repo/.git`. That has three costs.

**Worktrees interfere with each other.** One agent can plant a hook, a filter
driver, an fsmonitor, `url.*.insteadOf` or a credential helper in the shared
config, and another agent's git runs it inside its own pod. Branches, tags
and the stash are one namespace per project. An agent's `git gc --prune=now`,
`git worktree prune` or `git branch -D` reaches every sibling.

**The server's own git works around a repository it can't trust.**
docs/server-git.md builds a throwaway git dir for every call so git never
reads the pod-writable config, and it still lists holes it can't close: a pod
can plant symlinks, `objects/info/alternates` or a linked `packed-refs` that
the server's git follows into other projects and other server files.

**The layout generates machinery of its own:**

- `buildWorktreeLinkExec` rewrites both pointers into the pod's view on every
  k8s launch and writes a `locked` file so a prune can't reap every
  session's admin dir.
- `buildUpstreamExec` and `withUpstreamConfigLock` exist because a
  host-side write to the shared config goes stale under the virtiofs cache
  every pod reads through, and because concurrent in-pod writes race
  `config.lock`.
- `addWorktree` passes `--no-track` for the same reason.
- `worktreeUpstreamBranch` reads pod-written config back through a one-read
  copy.
- `buildWorktreeLinkExec` also has to run on every launch on both drivers,
  because both pointers are absolute paths written in the view of whichever
  substrate last launched the checkout, and a driver switch strands them.

## Goal

Each worktree gets its own complete `.git` directory. It borrows the main
clone's objects through `objects/info/alternates`, which is what
`git clone --reference` produces, and shares nothing writable with the main
clone or with any sibling. After that:

- **The main clone belongs to the server.** No workspace can write it. Pods
  mount its `.git` read-only, which lets them borrow its objects and pull
  its fresh `origin/*` refs. Every server git call that needs only origin
  refs and objects runs against it with no hardening beyond defense in
  depth.
- **A worktree's own git dir is its workspace's business.** A server call
  that needs worktree-specific state (HEAD, index, working tree, the
  branch's upstream) runs inside the workspace, and so only while it is
  running. The server never runs git against a worktree's git dir after
  creating it.
- **The main clone never deletes an object**, because clones borrow objects
  from it without the main clone being able to see which ones.
- **Every running clone's `origin/*` tracks the main clone's**, a few
  minutes behind origin at most, without a network fetch per worktree.

## Target layout

| Path (server view) | What it is | Who writes it | Mounted into a k8s pod |
|---|---|---|---|
| `repo/.git` | The main clone. It holds origin's refs as `refs/remotes/origin/*`, origin's objects, a sanitized config and no `worktrees/`. | the server only | the whole `.git`, **read-only**, at the same absolute path the server uses |
| `repo/` working tree | Unchanged. Skills discovery reads it as a fallback when a repo has no ref to read. | the server | no |
| `worktrees/<id>/` | The checkout. | workspace | `/workspace`, read-write |
| `worktrees/<id>/.git/` | A full git dir. `objects/info/alternates` names the main clone's `objects`. | workspace (created by the server) | inside `/workspace` |

Under containerless nothing is mounted. The workspace sees the same host
paths the server does.

### What a worktree's git dir holds when it is created

- **`objects/`**: empty. `objects/info/alternates` is one line, the main
  clone's objects dir. Commits the agent makes land here and never in the
  main clone.
- **Refs**:
  - A snapshot of the main clone's `refs/remotes/origin/*` at create
    time, including `origin/HEAD`, packed with `pack-refs --all`, so a repo
    with thousands of branches doesn't cost thousands of files per worktree
    on the network filesystem.
  - `refs/heads/agent/<id>` at the start commit.
  - `HEAD` pointing at that branch.
  - Tags come along only if the main clone has them. The main clone's
    fetch refspec stays as it is.
- **`config`**, written by the server:
  - `core.repositoryformatversion`, the object format and
    `core.logallrefupdates`
  - `remote.origin.url` (the project row's URL, tokenless) and
    `remote.origin.fetch` (`+refs/heads/*:refs/remotes/origin/*`)
  - `branch.agent/<id>.remote = origin` and `.merge = refs/heads/<base>`.
    This is the upstream, written before any workspace can see the file.

### Why not literally `git clone --reference`

The on-disk result is the same: alternates, no copied objects. The clone is
built from plumbing instead, because each of these rules out the porcelain:

1. `git clone` refuses a non-empty destination, and the destination already
   holds the ephemeral module dirs (`prepareModuleDirs`) that the pod binds
   before the checkout runs. This is the same reason `addWorktree` stages
   today.
2. `clone --reference <main> <origin-url>` goes to the network with a
   credential. The main clone has just been fetched, so everything needed is
   already on disk.
3. `clone --shared <main>` maps the main clone's *local* branches to the new
   `origin/*`. The refs that should be copied are the main clone's
   remote-tracking ones.
4. The alternates path has to be the view-agnostic one described below, not
   whatever path `clone` resolved.

Checked against git 2.43: `init`, then writing alternates, then
`for-each-ref refs/remotes/origin` in main piped into `update-ref --stdin` in
the clone, then `checkout --force` produces a working clone with
`count-objects` at 0 loose and 0 packed. A later network `git fetch` in that
clone works normally, with no error output from the objects-only alternate.

### One alternates string for the server and the workspace

The alternates line is an absolute path. It has to resolve for the server's
`checkout` in `createCheckout` and for the workspace's git from then on. A
relative path can't do both: `worktrees/<id>/.git/objects` and
`/workspace/.git/objects` sit at different depths, and git refuses a relative
alternate that climbs above `/`.

So the line is always **the main objects dir as the server sees it**,
`<repoDir(slug)>/.git/objects`. The k8s pod mounts the main clone's `.git`
read-only **at that same path**. The in-cluster server sees the global PVC at
`/yaac/global/...`, so the pod gets a mount at
`/yaac/global/projects/<slug>/repo/.git`. Under containerless the server's
path is already the workspace's path. One string is true in every view,
including during the pod's boot, before any launch step has run. The same
path is also what the origin refresh fetches from (see "Keeping `origin/*`
fresh").

The launch step writes that line **on every create and restart, on both
drivers**. It replaces `buildWorktreeLinkExec`:

```sh
printf '%s\n' '<repoDir>/.git/objects' > <workspaceDir>/.git/objects/info/alternates
```

This line is now the only path-shaped git state a checkout carries. It
keeps the rule the link step follows today, "written on every launch, on
both drivers, in the launching substrate's view", so a driver switch or a
moved data dir still heals on restart. What changes is that there is one
value in place of two pointers, and one view in place of two. Unlike
today's pointers, the line doesn't break a workspace still running on the
outgoing substrate when the other one restarts the worktree: that workspace
reads the main clone at its own path, which the switch did not remove. The
two-agents-in-one-checkout precondition in docs/containerless-driver.md
still stands, though. `WorkspacePaths.repoGitDir` goes too: nothing needs a
separate workspace view of the main clone any more, because the workspace's
view equals the server's.

The mount costs one thing: `/yaac/...` must not collide with a path the
project's image uses. Validate that at create time the way the other fixed
mount paths are validated. It is not expected to happen.

## Object lifetime: the main clone never deletes an object

A clone that borrows objects breaks when the main clone deletes one of them,
and the main clone can't tell which objects its clones use. It sees none of
their refs, indexes or reflogs. Today that visibility is exactly what keeps
gc safe: a linked checkout's HEAD and index sit in `repo/.git/worktrees/`,
where gc finds them.

An object in the main clone becomes unreachable in two ways:

- An upstream force-push or branch deletion, followed by a server fetch.
  The fetch uses a `+` refspec and no `--prune`.
- The migration below dropping a legacy `refs/heads/agent/<id>`.

Measured against git 2.43, with a clone built from `origin/feat`, then
`feat` force-pushed upstream, then refetched into main, with main's reflogs
expired:

| Operation on the main clone | Clone after it |
|---|---|
| `gc` with default settings, immediately | intact, but only until the 2-week prune expiry |
| `gc --prune=now` | **broken** |
| `repack -a -d` | **broken** |
| `repack -A -d` followed by `prune` | **broken** |
| `-c gc.pruneExpire=never gc`, with or without `gc.cruftPacks`, run three times | intact |
| `-c gc.pruneExpire=never gc --prune=now` | **broken**: the flag wins over the config |

Rules:

1. **Only the server runs git on the main clone**, and the RO mount enforces
   that under k8s.
2. **The server's maintenance of the main clone is one call**, `maintainRepo`
   in `#domain/git`:
   ```
   git -c gc.pruneExpire=never -c gc.reflogExpire=never \
       -c gc.reflogExpireUnreachable=never -c gc.worktreePruneExpire=never \
       -c gc.autoDetach=false gc --auto
   ```
   It runs after `fetchOrigin`, under the same per-repo mutex, and nobody
   waits for it. The mutex is what keeps it from racing a fetch. Today the
   pods auto-gc the shared repo; after the RO mount they can't, so without
   this call the main clone accumulates loose objects and small packs that
   slow every clone's object lookups.
3. **Nothing else prunes or repacks the main clone.** The runner keeps
   pinning `gc.auto=0` and `maintenance.auto=false` on every other call.
   `maintainRepo` is the one call that overrides them, and it hardcodes the
   never-prune pins on the command line rather than trusting the main
   clone's config.
4. **Worktree clones gc freely.** `gc` in a clone passes `-l` to repack,
   so it touches only local objects. An agent running `repack -a` in its own
   clone copies borrowed objects locally, which wastes disk and harms no one.

What this costs is disk: unreachable objects are kept forever, in a cruft
pack. On an ordinary project they come only from upstream force-pushes and
are small. If some project needs reclaiming, the fix is a pin set instead of
never-prune: `refs/yaac/pins/<id>` in main naming each live clone's borrowed
tips, dropped when the clone is deleted, so ordinary gc becomes safe again.
That is not built now, because it is more machinery than the disk it saves.

## Creating a checkout (replaces `addWorktree`)

`createCheckout(repoPath, worktreePath, branchName, startSha, baseBranch)`
in `#domain/git`:

1. **Stage the git dir where no pod can see it**:
   `worktrees/.staging-<id>/.git`. The sibling-staging pattern already
   exists, and no pod mounts the staging dir. There: `git init`, write the
   config above and the alternates line, copy the origin refs out of main
   (`for-each-ref` in main piped into `update-ref --stdin`), `pack-refs
   --all`, create `refs/heads/<branchName>` at `startSha`, and
   `symbolic-ref HEAD`.
2. **Populate the tree from the private git dir**: `checkout --force` with
   `GIT_DIR=<staging>/.git` and `GIT_WORK_TREE=<worktreePath>`. The git dir
   is still one the server just wrote, so a plain runner call is safe. The
   destination is pod-visible, but under k8s this is the same exposure
   `addWorktree`'s checkout already has.
3. **Move it in**: `rename(<staging>/.git, <worktreePath>/.git)`. That adds
   one directory entry and never replaces the destination's inode, which
   keeps the pod-bind-before-checkout overlap.
4. Emit `base-branch-resolved`, as today.

Rollback shrinks to removing the staging dir, plus the `.git` if step 3 ran.
There is no branch in main to delete, no admin dir, no `update-ref -d`, and
no concurrent-add hazard that forbids `worktree prune`. The branch name
`agent/<id>` stays, because it is also the name agents push to origin.

A restart keeps reusing a checkout whose `.git` exists (the `fs.access`
probe is unchanged). A `.git` that is a *file* is a legacy linked checkout,
converted first (see Migration).

This is also a step toward node-local worktrees (`worktreeDir`'s doc comment
says the checkout is GLOBAL only because its `.git` points into the shared
clone). A clone needs only a read-only mount of the main clone to exist, so an init
container on the worktree's node could build it. That is out of scope here.

## Every server-side git call, decided

**Against the main clone.** Trusted, because only the server writes it.

| Call | Consumer | Needs |
|---|---|---|
| `cloneRepo` | `project add` | nothing; it creates the main clone |
| `fetchOrigin` (+ `maintainRepo`) | create, claim, branch picker `?refresh=1` | origin refs |
| `getDefaultBranch`, `listRemoteBranches` | branch picker, create, skills | `refs/remotes/origin/*` |
| `remoteBranchExists`, `resolveRemoteRef` | create, claim, reference-branch route, skills | `refs/remotes/origin/<b>` |
| `listTreeSubdirs`, `readBlobAt` | skills discovery | trees and blobs at `origin/<b>` |
| the `for-each-ref` inside `createCheckout` | create | origin refs |

None of these ever needed a worktree. With the main clone trusted, the
throwaway git dir that `runGit` builds for a `repo` target has nothing left
to defend against, so it is deleted in phase 3 (below). The command-line pins
stay (`hooksPath=/dev/null`, `fsmonitor=false`, the submodule pins,
`protocol.allow`, `gc.auto=0`): they cost nothing and still hold if the
data dir is ever touched by hand.

**Against a worktree's own state.**

| Call | Today | After |
|---|---|---|
| `worktreeUpstreamBranch` at claim (`tryClaimPrewarmed`: which branch was this spare warmed from?) | reads `branch.agent/<id>.merge` from the shared config | **deleted**. Spares get `baseBranch` on their row when they are warmed (emit `base-branch-resolved` for spares too), and the claim reads the row. A spare row without one is a legacy spare and gets reaped (Migration). |
| `worktreeUpstreamBranch` in `fork-branch.ts:forkFallback` (Changes pane base, only when the row has none) | same config read | **deleted**. The row stays the authority. With no row value it returns null, and the pod script already falls back to `@{upstream}` inside the workspace, where the question belongs. `readRepoConfig` goes with it once the conversion shim no longer needs it. |
| `listCheckoutFiles` for a **running** worktree (explorer, every 5s while visible) | server-side, against the admin dir through the throwaway common dir | **inside the workspace**. A new driver verb runs a shared script beside `drivers/shared/worktree-changes.ts`, the same shape the Changes pane already uses on both drivers: the four `ls-files` calls plus `status --porcelain=v1 -z --no-optional-locks`, each section NUL-framed, parsed server-side by the existing `parsePorcelainStatus`. The workspace's own git reads its own config. Whatever it runs, it runs in the pod's sandbox as the pod. |
| `listCheckoutFiles` for a **stopped** worktree | same | **dropped.** The listing route resolves with `requireRunning` (the Changes pane's rule) and a stopped worktree's explorer shows "start the worktree to browse its files". The file read and write routes are plain `fs` with no git, and they stay as they are. |
| `createCheckout` | `addWorktree` against the shared clone | server-written staging git dir, as described above |

**Inside the workspace.** These already run there and stay there, minus the
config lock.

- The alternates line (replaces `buildWorktreeLinkExec`).
- Re-branch prep at claim (`buildRebranchPrep`):
  ```
  git update-ref refs/remotes/origin/<b> <sha>
  git reset --hard <sha>
  git clean -fd -e <mounts>
  git branch --set-upstream-to origin/<b>
  ```
  The SHA comes from the server's fetch into main. Its objects reach the
  clone through alternates, so the SHA-not-ref reasoning in `spare-pool.ts`
  still holds. The `update-ref` is new: the clone's origin refs are a
  snapshot, and `--set-upstream-to` needs the ref to exist.
  `withUpstreamConfigLock` is deleted, because each clone has its own
  config.
- `buildUpstreamExec` is **deleted**. `createCheckout` writes the upstream
  before any pod can see the config, so it has no virtiofs staleness and no
  lock.
- The Changes pane script: unchanged.

With the stopped listing gone, **the server never runs git against a
worktree's git dir after `createCheckout`**, so `runGit` has no worktree
target at all. That is what lets phase 3 delete the throwaway git dir
outright rather than keep it for one caller.

## Keeping `origin/*` fresh

Today a server fetch moves every pod's `origin/*` at once, because the refs
are shared. A clone's refs are its own, so without help they would move only
when the agent itself runs `git fetch`. Two pieces restore the old behavior
and improve on it.

**1. The server fetches on a timer, not only on demand.** A new reconcile
step, `origin-refresh`, sits in `#domain/reconcile.ts` beside
`credential-sync`, and like it is throttled. For each project with at least
one running worktree whose last `fetchOrigin` is older than
`ORIGIN_REFRESH_MS` (5 minutes), it runs `fetchOrigin` (same mutex, same
project-row URL and credential), then `maintainRepo`. A fetch that a create,
a claim or the branch picker just made counts, so a busy project doesn't
fetch twice. A project with no running worktree is never fetched in the
background. A failed fetch (auth, network) is logged and retried on the next
tick. It never surfaces as a worktree error: a stale `origin/*` is exactly
today's behavior when nobody creates anything.

**2. Every server fetch is fanned out to every running clone.** Any
successful `fetchOrigin` schedules `propagateOrigin(slug)`. That covers the
timed step, every create and restart, a claim's re-branch and the branch
picker's refresh, so a create's fetch reaches the whole project, as the
shared refs do today. `propagateOrigin` runs one command in each of the
project's running workspaces, with bounded concurrency:

- **The fetch's caller never waits for it.** A create does not block on its
  siblings' execs.
- **Calls are coalesced per project.** A fan-out requested while one is in
  flight marks the project dirty, and the in-flight fan-out runs exactly
  once more when it finishes. A burst of creates therefore costs at most two
  rounds of execs, not one round per create. The keyed mutex in
  `#lib/keyed-mutex` plus a dirty flag is enough; nothing new is needed.

The same command runs once more in the launch step, right after the
alternates line. That makes the worktree being created or restarted current
before its agent starts, whatever the fan-out's timing:

```sh
git -C <workspaceDir> fetch --quiet --no-tags --no-write-fetch-head \
    <repoDir>/.git 'refs/remotes/origin/*:refs/remotes/origin/*'
```

- **It is local.** It reads the RO mount, and every object is already
  reachable through alternates, so no pack is sent and no credential is
  used. It costs one exec per running worktree per server fetch: every 5
  minutes, plus one after each create, claim or picker refresh (coalesced).
  Checked on git 2.43:
  the clone's `count-objects` stays at 0 after the refresh.
- **The refspec has no `+`, so updates are fast-forward only.** That is
  deliberate. An agent's own `git fetch origin` can leave a ref *ahead* of
  the main clone's, and a forced refresh would move it backwards. Git treats
  a backwards move as a non-fast-forward and rejects that one ref while
  updating the rest. Checked on git 2.43:
  - `main` fast-forwarded and a new branch appeared.
  - A force-pushed branch was reported `! [rejected]`, and the fetch exited
    1.

  So a branch force-pushed upstream stays stale in a clone until the agent
  fetches it. That is an accepted cost. The alternative is to force a ref
  only when the clone still holds the value the server last wrote, which
  means tracking that value per clone, and that is not worth the code. The
  script ignores the exit status, and the server treats any failure as "try
  on the next fetch".
- **`--no-write-fetch-head` is required.** Without it every refresh
  overwrites the clone's `FETCH_HEAD`, and an agent between its own
  `git fetch origin foo` and `git merge FETCH_HEAD` would merge the wrong
  thing.
- **There is no `--prune`.** Pruning against the main clone would delete any
  `origin/*` ref the agent fetched itself that main hasn't seen yet. Branches
  deleted upstream therefore linger in clones, as they already linger in
  main, whose fetch doesn't prune either.
- **Ref lock contention with the agent's own git** (`origin/x.lock`) fails
  fails that one ref this time, and the next fan-out retries.
- **It stays out of the Changes pane's way.** The pane diffs against
  `merge-base(HEAD, origin/<base>)`. Fast-forwarding `origin/<base>` leaves
  that fork point where it is, unless the agent has merged the newer base.
  That is the one case where the fork point should move.

**A bonus for the agent's own network fetches.** Because the pod now mounts
the main clone's refs as well as its objects, git's alternate-refs
negotiation can advertise main's `origin/*` tips as "haves". An agent's
`git fetch origin` then downloads only what main doesn't already hold,
instead of re-downloading objects that are already on disk behind the
alternate. Main is owned by the same uid as every worktree pod
(`hostUidSecurityContext()`, docs/file-editor.md), so git's ownership check
does not refuse it. Verify both points against the pinned base image's git
(see Risks).

A per-worktree network fetch on a timer inside each pod would also keep refs
fresh. It was rejected because it multiplies network traffic and credential
use by the number of worktrees, and because each clone would store its own
copy of every new object.

## Behavior changes agents and users will see

- **`origin/*` is refreshed, not shared.**
  - A clone's `origin/*` trails origin by at most the 5-minute interval,
    even in a project where nobody creates anything, which today can stay
    stale indefinitely.
  - A create's fetch reaches every running worktree within one fan-out, as
    it does today.
  - Updates fast-forward only, and the refresh never moves back a ref the
    agent fetched itself.
  - Two things differ from today. A force-pushed upstream branch updates in
    a clone only when that agent fetches. An agent's own `git fetch origin`
    no longer reaches its siblings immediately, only at the server's next
    fetch.
- **The explorer is running-only.** A stopped worktree's explorer shows a
  "start the worktree" state instead of a listing. Update docs/file-editor.md,
  which currently says a stopped worktree browses like a running one, and
  the frontend's explorer pane.
- **No cross-worktree git state.** Unpushed branches, tags, the stash and
  local config are per worktree. Nothing in yaac relies on seeing a
  sibling's branch: every create starts from `origin/<ref>`, and
  `yaac-mama` spawns do the same. An agent that expected to `git checkout`
  another worktree's unpushed branch now has to push it first. That is the
  isolation this plan is for.
- **Repo-local config is per clone.** `git lfs install --local` and similar
  settings apply only to the clone they were run in.
- **Claude's trusted roots drop `/repo`** (and the containerless repo root):
  claude no longer sees a main worktree behind `/workspace`. Update
  `seed.ts` and the e2e assertions on the `/repo` trust key.
- **`safe.directory /repo`** leaves `yaac-worktree-init`, and
  `safe.directory = <repoGitDir>` leaves the containerless `.gitconfig`.
  Ownership checks apply to the repo dir, not to its alternates.

## Migration

Existing installs hold linked checkouts, some of them in running pods with
`/repo/.git` mounted read-write. Those pods can't be changed (a Job's pod
spec is immutable), and they keep running across a server upgrade.

### Phase 1: ship clones, convert on the way in

Everything above, plus the shims below. New and converted worktrees are
clones. Legacy pods keep running untouched. Every server path already
handles them: the running-listing verb works in a linked checkout too
(`git -C /workspace` does not care), and the Changes pane is unchanged.

**The ordering hazard.** While any legacy pod runs, it can gc the main
clone, and its auto-gc sees neither the new clones' refs nor the converted
ones'. Its default 2-week prune expiry would eventually delete objects they
borrow. So the **first thing** phase 1 does, per project, before it creates
or converts any clone there, is write the never-prune keys into the main
clone's *real* config (`gc.pruneExpire`, `gc.reflogExpire`,
`gc.reflogExpireUnreachable` = `never`), which legacy pods' git does read.
Writing the config from the host replaces its inode under the virtiofs
cache, so legacy pods on that project may see a few seconds of "unknown
error occurred while reading the configuration files" once. That is
accepted as a one-time cost. An agent in a legacy pod running
`gc --prune=now` by hand could still break clones. That is already true of
every sibling today, and it ends with the last legacy pod.

**Until a project is sanitized, its new clones are only as isolated as
today.** Their pods mount main read-only, but legacy pods can still write
main's refs and config, and a clone's refresh fetch and alternate-ref
negotiation read both. That is the same exposure every sibling has today, and
it ends when the project's last linked checkout is converted.

**`adoptLinkedCheckout(slug, id)`** converts one stopped linked checkout. It
runs from the launch path (where `fs.access(.git)` finds a file). A startup
sweep also runs it over every stopped row, because main is sanitized only
once no linked checkout is left, and a stopped worktree nobody restarts
would otherwise hold that up forever. The sweep is row-driven, as every
sweep is, so pre-row strays stay untouched. The conversion is idempotent at
every step:

0. Find the admin dir by worktree id, as `repo/.git/worktrees/<id>` in the
   server's view. Never follow the `.git` file's content. Since the link
   step runs on every launch on both drivers, that file names whichever view
   last launched the checkout. For anything last run under k8s it is the
   pod's `/repo/.git/worktrees/<id>`, which resolves nowhere on the server.
1. Stage a new git dir exactly as `createCheckout` does, but seed it from
   the legacy state:
   - **Refs**:
     - main's `refs/remotes/origin/*` and `refs/tags/*`
     - `refs/heads/agent/<id>`
     - every other `refs/heads/*` **except other worktrees' `agent/*`**.
       Local branches were one shared namespace and can't be attributed,
       so each converted clone gets them all. That loses nothing.
     - `refs/stash` with its reflog, for the same reason: the stash was one
       stack, and each clone gets a copy.

     All refs are read through today's hardened runner, since main is still
     untrusted at this point.
   - **Admin dir files**: every *regular* file under
     `repo/.git/worktrees/<id>/` except `gitdir`, `commondir` and `locked`,
     including `index`, `logs/HEAD`, `ORIG_HEAD` and in-progress
     `MERGE_HEAD`/`rebase-merge/`/`sequencer/` state. Copied with `lstat`
     checks, never following a link, because the admin dir was
     pod-writable.
   - **Config**: `branch.agent/<id>.merge` from main (via `readRepoConfig`,
     validated as today) becomes the clone's upstream. Other repo-local
     config is dropped, deliberately.

   The agent's commits stay where they are, in main's objects, and the
   clone borrows them. That is safe because of the never-prune config
   written above.
2. Swap: rename the `.git` file to `.git.linked`, rename the staged dir to
   `.git`, then delete `.git.linked`. On a crash, a later pass finding
   `.git.linked` with no `.git` resumes from step 2.
3. Delete `repo/.git/worktrees/<id>` and `refs/heads/agent/<id>` from main.
4. If no admin dir owned by a row is left in `repo/.git/worktrees/`, the
   project has no legacy pod, because a legacy pod exists only for a row
   whose admin dir exists. **Sanitize the main clone once**:
   - fail loudly on any symlink under `.git`
   - rewrite `config` from the allowlist plus `remote.origin.url` from the
     row and the never-prune keys
   - delete `hooks/`, `info/attributes`, `objects/info/alternates` and
     `worktrees/`
   - drop any leftover `refs/heads/agent/*`

   From here on, every pod in the project mounts main read-only.

**Legacy spares are reaped, not converted.** A spare row without
`baseBranch` is legacy. It is disposable, and the prewarm reconcile re-warms
it as a clone. Reaping them also retires most legacy pods quickly.
`deleteWorktreeState` keeps removing the admin dir for those reaps.

### Phase 2: wait

Legacy pods retire as users stop or restart worktrees. Nothing has to force
them.

### Phase 3: delete the shims and the main-clone hardening together

This phase deletes:

- `adoptLinkedCheckout`, its startup sweep and `.git.linked` handling
- `deleteWorktreeState`'s admin-dir removal
- `readRepoConfig`
- the legacy-spare reap rule
- **the throwaway git dir, entirely.** Main is the only repository the
  server still runs git against, and it is trusted, so `runGit` becomes a
  plain `GIT_DIR` call with the pins. Going with it:
  - `buildGitDir`, `readOnce`, `configEntries`, `KEPT_KEYS`, `LINKED` and the
    `worktree` target
  - `clearGitScratch`, its startup call and its barrel export
  - the scratch dir under `run/git-shadow`

The runner simplification has to go in the same change as the conversion
shim, not before it. An install that carries a linked checkout past this
point would run unhardened server git against a config its pods can still
write. Per docs/legacy-compat-shims.md that is an accepted cost for an
install that skips the window, and it is why these share one entry.

### Entries for docs/legacy-compat-shims.md (added in phase 1)

- **The never-prune keys in the main clone's real config.**
  - *Reads*: nothing. It is a write that legacy pods' git reads.
  - *Breaks silently if removed early*: a legacy pod's auto-gc prunes
    objects a clone borrows, and that clone fails weeks later with
    missing-object errors.
  - *Safe to remove when*: no project has a row-owned admin dir.
  - *Ordering*: the keys must be written before the first clone in the
    project. Once a project is sanitized they stay as belt and braces;
    `maintainRepo`'s command-line pins are what the server relies on.
- **`adoptLinkedCheckout` and the main-clone hardening in `runGit`.** One
  entry, for the reason given in phase 3.
  - *Reads*: `worktrees/<id>/.git` files, `repo/.git/worktrees/<id>/`, main's
    refs and `branch.*.merge`.
  - *Breaks if removed early*: loudly for the worktree (its restart can't
    write alternates into a `.git` file) but silently for the server, which
    would trust a config legacy pods can write.
  - *Safe to remove when*: no row's checkout has a `.git` file and no
    `repo/.git/worktrees/` exists.
- **The legacy-spare reap.**
  - *Reads*: the spare row's `baseBranch`.
  - *Breaks if removed early*: a legacy spare is claimed with no base
    branch, and the re-branch decision falls back to the default branch.
  - *Safe to remove when*: no spare row lacks `baseBranch`.

## Implementation order

Each step is one reviewable change, and each keeps the tree green.

1. **`maintainRepo` + never-prune.** Add the verb and call it after
   `fetchOrigin`. Add the gc-safety unit test below. This is harmless
   today.
2. **`baseBranch` on spare rows.** Spares emit `base-branch-resolved`, the
   claim reads the row, and `forkFallback` is deleted. Both
   `worktreeUpstreamBranch` callers are gone after this.
3. **Explorer listing in the workspace, running-only.** Add the shared
   script and driver verb, resolve the listing route with `requireRunning`,
   and give the frontend explorer its stopped state. This works for linked
   checkouts too, so it lands before the layout change, and it removes the
   server's last git call against a worktree.
4. **The layout change.**
   - `createCheckout` replaces `addWorktree`.
   - The alternates launch step replaces `buildWorktreeLinkExec` at the same
     call site in `launchWithSetup`, which already runs on every launch on
     both drivers.
   - The pod spec drops the RW `/repo/.git` mount for the RO mount of main's
     `.git` at the server's path, with a mount-collision check.
   - Deleted: `WorkspacePaths.repoGitDir`, `buildUpstreamExec` and
     `withUpstreamConfigLock`.
   - The re-branch prep gets its `update-ref`.
   - The `/repo` trust roots and `safe.directory` entries go.
   - `adoptLinkedCheckout` and the never-prune config write, with its
     startup sweep, and the legacy-spare reap.
   - The shim entries.
5. **`origin-refresh`.** Add the throttled reconcile step,
   `propagateOrigin` (coalesced per project and scheduled after every
   successful `fetchOrigin`), and the refresh in the launch step. It skips projects
   that still hold a linked checkout, where the old shared refs already do
   the job.
6. **Docs**, in the same changes as steps 3 to 5 (see below).
7. **Phase 3**, later: delete the shims and the throwaway git dir.

## Tests

- **Unit, `#domain/git`**, one `describe` per barrel function in its
  defining module, per CLAUDE.md:
  - `createCheckout`: the clone has zero local objects, `origin/*` matches
    main, HEAD is `agent/<id>`, the upstream is set, a pre-populated module
    dir survives, the destination inode is unchanged, and a failure at each
    step leaves no `.git` and no staging dir.
  - `maintainRepo`: the scenario from the table above, with
    `transfer.unpackLimit=1` so the objects are packed. Build a clone,
    force-push upstream, fetch into main, expire main's reflogs, run
    `maintainRepo` three times, then `git fsck --connectivity-only` in the
    clone passes. This is the test that stops anyone "fixing" gc later.
  - `adoptLinkedCheckout`: a linked checkout with a dirty index, a commit
    only on `agent/<id>`, a sibling's `agent/<other>`, a user branch and a
    stash converts to a clone with an identical `git status`, the same
    `HEAD` commit, the user branch and the stash, and no `agent/<other>`. The
    admin dir and main's `agent/<id>` are gone. A crash between the renames
    (planted `.git.linked`) resumes. Converting the last checkout sanitizes
    main.
- **test/e2e-containerless** (runnable in a dev worktree): extend
  `worktree-suite`:
  - A created worktree's `.git` is a directory with the canonical alternates
    line.
  - An agent-side `git config core.hooksPath` or a new branch in one
    worktree is invisible in a sibling.
  - The driver-switch restart test (`restarts the stopped worktree back onto
    a live tmux server`) now plants pod-shaped pointers in the linked
    layout. It becomes a clone test: plant the other substrate's alternates
    line, restart, then assert the canonical line and that host
    `git status` works.
  - The origin refresh, run with a short interval against the mock remote:
    - A commit pushed to `main` appears as the clone's `origin/main`.
    - A new branch appears.
    - A ref the clone fetched ahead of main is *not* moved back.
    - A force-pushed branch is left alone.
    - `FETCH_HEAD` is untouched.
  - The explorer listing works on a running worktree, and on a stopped one
    it answers the not-running error.
  - The existing test that plants a filter and hooks in `repo/.git` and
    asserts create doesn't run them stays as it is. Add the clone-side twin:
    a filter planted in one clone's config never runs in a sibling or in a
    later create.
  - A planted legacy linked checkout (made with plain `git worktree add`)
    converts on restart, including one whose `.git` names the pod's
    `/repo/.git/worktrees/<id>`. That is the shape the current restart test
    plants, so its setup moves here.
- **k8s tiers (host-only)**:
  - `worktree-create-suite`'s restart case now plants host-shaped linked
    pointers and asserts they are rewritten to pod paths. It becomes the
    mirror of the containerless one: a host-view alternates line comes back
    as the canonical one, and `git status` works in the pod.
  - `worktree-create-suite`: `/yaac/.../repo/.git` is mounted RO (a write
    fails), and `/repo` is gone.
  - `git status`, `git fetch` and the origin refresh work in the pod.
  - The explorer listing matches `ls-files` in the pod.
  - `worktree-prewarm`: the `@{u}` assertion stays, and the shared-config
    assertion becomes a row assertion.
- **Manual, once, on a host with a cluster**: start a worktree on the old
  build and leave it running, upgrade, and create a new one in the same
  project. Confirm the old pod keeps working and the new one is a clone.
  Stop the old one and restart it, and confirm it converts with its
  uncommitted changes intact and the main clone is sanitized. Then do a
  driver switch both ways and run `git status` in the restarted workspace.

## Docs to update in the same change

- `docs/server-git.md`: rewrite around "main is the server's, a worktree's
  git dir is its workspace's". The server runs git only against main, so
  the throwaway-dir sections go in phase 3. The "What this does not cover"
  section goes now, because pods no longer write anything the server's git
  reads.
- `docs/file-editor.md`: the explorer listing is running-only and runs in
  the workspace. File reads and writes still work on a stopped worktree.
- `docs/worktree-storage.md`: "a row is 1-1 with a git worktree" becomes
  "with a checkout". The stray description stays, because pre-row strays
  still have admin dirs.
- `docs/containerless-driver.md`: the path table, and the gitdir-rewrite
  paragraph, which becomes the alternates line. It keeps the rule that the
  outgoing substrate's workspaces come down first.
- `docs/plans/multi-user-deployment.md`: its "mount `/repo/.git` read-only
  with only per-worktree writable" item points here.
- Source comments that cite the linked layout:
  - `repo.ts`
  - `setup-commands.ts`
  - `create.ts`, around the upstream lock and the link exec
  - `spare-pool.ts`
  - `cleanup.ts`
  - `project-paths.ts`, in `repoDir` and `worktreeDir`
  - `containerless/git-auth.ts`, whose "worktrees share the repository's
    config" rationale for the credential store no longer applies. The store
    still works, so leave it.

## Risks and open questions

- **Stale pack listings under virtiofs.** When `maintainRepo` or a fetch
  replaces packs, a pod may briefly miss a new pack or look for a deleted
  one. Git re-scans the pack dir on a missing object, and pods already read
  host-fetched objects through this same mount today, so nothing new is
  expected. The re-branch prep has no retry today. If claims start failing
  right after a gc, give its `reset --hard <sha>` one, or skip `maintainRepo`
  on the fetch a claim makes.
- **The pod image's git version.** The refresh needs `--no-write-fetch-head`
  (git 2.29+). Also confirm against the pinned base image's git that
  alternate-ref negotiation reads the RO main and prints nothing on an
  ordinary `git fetch`. If it is noisy or refused, set
  `core.alternateRefsCommand = true` in the clone's config, which gives up
  only the download saving.
- **The refresh fan-out** is one exec per running worktree per server fetch,
  and it runs even for worktrees nobody is looking at. Coalescing caps a
  burst of creates at two rounds. If it shows up in profiles, lengthen the
  timed interval first. Create-triggered fan-outs are the ones users notice
  when they are missing.
- **A shallow main clone** would need `shallow` copied into every clone.
  `cloneRepo` never makes one, so `createCheckout` refuses a shallow main
  rather than handling it.
- **Submodules** initialized in a clone now live in the clone's own
  `.git/modules`, with paths relative to the clone. That is an improvement
  on today, where they sat in the shared repo.
- **Disk**: one index plus packed refs per worktree, which is negligible.
  Converted clones keep borrowing their pre-conversion commits from main
  forever, which is the never-prune cost again.

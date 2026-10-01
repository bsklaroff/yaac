# Server-side git

A project has one **main clone**, at `global/projects/<slug>/repo`. Each
workspace's checkout is a separate clone that borrows the main clone's
objects. The server owns the main clone; each workspace owns its checkout.

## The layout

| Path (server view) | What it is | Who writes it | In a k8s pod |
|---|---|---|---|
| `repo/.git` | The main clone: origin's refs as `refs/remotes/origin/*`, and origin's objects | the server only | read-only, at the path the server sees |
| `workspaces/<id>/` | The checkout | the workspace | `/workspace` |
| `workspaces/<id>/.git/` | A git dir whose `objects/info/alternates` points at the main clone's objects | the workspace (created by the server) | inside `/workspace` |

A containerless workspace sees the server's paths unchanged.

**The checkout's git dir** (`createCheckout` in `#domain/git`) holds no
objects. It starts with the main clone's `origin/*` refs and tags written as
`packed-refs` (so thousands of branches do not become thousands of files),
`agent/<id>` checked out at `origin/<base>`, and a server-written config: the
object format, `remote.origin` (the project row's URL, without a token), and
`agent/<id>`'s upstream. It is built in a staging dir and renamed in as
`.git`, so the checkout directory itself is never replaced; a pod may already
have it bound as `/workspace`. Plain `git clone` can't do this: it refuses a
non-empty destination, copies local branches rather than remote-tracking
ones, and writes its own alternates path.

**The alternates line** is the only path stored in a checkout's git state. It
always holds the main clone's objects dir as the server sees it, and a pod
mounts the main clone at that same path
(`/yaac/global/projects/<slug>/repo/.git` under the in-cluster server), so the
line is valid everywhere. Every create and restart rewrites it
(`buildCloneLinkExec`), which repairs a checkout last launched by a server
that saw the data dir at another path.

Workspaces share no git state: branches, tags, stash, hooks and config are
per checkout, so one agent's `git config`, `gc --prune=now` or `branch -D`
cannot affect another. To use another workspace's unpushed branch, that
workspace must push it. Under k8s this is enforced, since a pod sees only its
checkout and a read-only main clone. Under containerless it is not: every
workspace runs as the server's user, so an agent can write the main clone and
other checkouts directly (docs/containerless-driver.md).

## The main clone never deletes an object

A checkout breaks if an object it borrows is deleted, and the main clone
cannot see which objects checkouts use (their refs, indexes and reflogs are
in their own git dirs). Objects become unreachable when a fetch follows an
upstream force-push or branch deletion, and default gc prunes them two weeks
later. So nothing prunes the main clone:

- The runner sets `gc.auto=0` and `maintenance.auto=false` on every call.
- The one gc the server runs, `maintainRepo`, is `gc --auto` in the
  foreground with `gc.pruneExpire`, `gc.reflogExpire`,
  `gc.reflogExpireUnreachable` and `gc.worktreePruneExpire` set to `never` on
  the command line, under the fetch's per-repo mutex. Unreachable objects go
  to a cruft pack and stay. Nothing passes `--prune`, which would override
  those settings.
- `cloneRepo` also writes the prune and reflog keys into the main clone's
  config, for git run there without the server's settings (a user, or a
  containerless agent).

A checkout can gc freely; its repack is `-l` (local objects only).

The cost is disk, and on a normal project only upstream force-pushes create
unreachable objects. If space is ever needed back, the fix is a pin ref per
live checkout in the main clone (`refs/yaac/pins/<id>`), which makes ordinary
gc safe again.

## Keeping `origin/*` fresh

A checkout's `origin/*` refs are its own, so they change only when something
copies them over (`origin.ts` in `#domain/projects`):

- **Every server fetch fans out.** `fetchProjectOrigin` (create, spare
  claims, the branch picker's refresh, the timer below) schedules
  `maintainRepo` and refreshes every running workspace of the project, a few
  at a time, without making the caller wait. Fan-outs are coalesced per
  project, so a burst of creates costs at most two rounds.
- **A timer fetches.** The `origin-refresh` reconcile step fetches every
  project that has a running workspace and was not fetched in the last five
  minutes. A failure is logged and retried next interval.
- **Every launch refreshes**, right after rewriting the alternates line.

The refresh (`buildOriginRefreshExec`) is a local fetch from the main clone,
run inside the workspace:

```sh
git -C <workspace> fetch --quiet --no-tags --no-write-fetch-head \
    <main clone>/.git 'refs/remotes/origin/*:refs/remotes/origin/*'
```

Every object is already reachable through the alternate, so nothing crosses
the network and no credential is used. The refspec has no `+`, so a ref the
agent fetched ahead of the main clone is never moved back (the cost: a
force-pushed branch stays stale until the agent fetches it). There is no
`--prune`, so refs the agent fetched are kept. `FETCH_HEAD` is not written,
since the agent may be between its own `fetch` and `merge FETCH_HEAD`.

An agent's own `git fetch origin` goes to the network, but because the pod
also mounts the main clone's refs, git offers their tips as haves and
downloads only what the main clone lacks.

## Where the server runs git

- **Against the main clone**, trusted because only the server writes it:
  `cloneRepo`, `fetchOrigin`, `maintainRepo`, `getDefaultBranch`,
  `listRemoteBranches`, `remoteBranchExists`, `resolveRemoteRef`, the skills
  reads (`listTreeSubdirs`, `readBlobAt`), and `createCheckout`'s ref
  snapshot.
- **Against a checkout's staged git dir**, only while `createCheckout` builds
  it and no workspace can see it (the runner's `private` target).
- **Never against a checkout's git dir after that.** Anything that needs a
  checkout's state runs inside the workspace, so only while it runs: the
  Changes pane's diff, the file explorer, the git status bar's ahead/behind
  count (docs/file-editor.md), a spare's HEAD and re-branch at claim, and the
  refresh above. A workspace's base branch comes from its row, never from the
  checkout's config, which the agent can rewrite.

## The runner

Every git process the server starts goes through `runGit` (`run.ts` in
`#domain/git`), called only by the `#domain/git` barrel's functions. Each call
sets these on the command line, where they override any config:

- `core.hooksPath=/dev/null` and `core.fsmonitor=false`
- submodule recursion off
- `gc.auto=0` and `maintenance.auto=false`
- `protocol.allow=never`, plus an allow for the transport of the remote the
  call talks to

The server user's global and system config are still read, and so is the
main clone's own config. No pod can write it; a containerless agent can, but
it already runs as the server's user. A call with no
repository runs in an empty server-private dir under a ceiling, so git never
discovers one from its cwd.

## Remote URLs come from the project row

The URL a fetch goes to, the credential matched to it, and the `repoUrl` the
k8s proxy uses to limit the project's https credential to one host and to
gate the ssh agent all come from `projectRemoteUrl(slug)` in
`#domain/projects`, which reads the project row. `fetchOrigin` fetches by
explicit URL and refspec, never by the remote name `origin`, so a
repository's `remote.origin.*` cannot change where a fetch goes or which
token it sends. Each clone's `remote.origin.url` is written from the row,
without a token, for the workspace's own git.

## Consequences

- Filters configured inside a repository (e.g. `git lfs install --local`)
  apply only in that checkout, never to the server's git. LFS in the server
  user's global config still applies, and pods fetch LFS content themselves.
- A shallow main clone is refused, since every checkout would need its
  `shallow` file. `cloneRepo` never makes one.
- Submodules initialized in a checkout live in its own `.git/modules`.

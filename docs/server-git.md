# Server-side git

A project has one **main clone**, at `global/projects/<slug>/repo`, and every
worktree's checkout is a **clone of its own** that borrows the main clone's
objects. The main clone is the server's; a checkout's git dir is its
workspace's.

## The layout

| Path (server view) | What it is | Who writes it | In a k8s pod |
|---|---|---|---|
| `repo/.git` | The main clone: origin's refs as `refs/remotes/origin/*`, origin's objects, and no `worktrees/` | the server only | the whole `.git`, **read-only**, at the path the server sees it at |
| `worktrees/<id>/` | The checkout | the workspace | `/workspace` |
| `worktrees/<id>/.git/` | A full git dir whose `objects/info/alternates` names the main clone's objects | the workspace (created by the server) | inside `/workspace` |

A containerless workspace sees the server's paths as they are.

**A checkout's git dir** (`createCheckout` in `#domain/git`) holds no object of
its own. It starts with a snapshot of the main clone's `origin/*` and tags,
written as `packed-refs`, so a repository with thousands of branches does not
cost thousands of files per worktree; `agent/<id>` at `origin/<base>`, checked
out; and a config the server writes: the object format, `remote.origin` (the
project row's URL, tokenless), and `agent/<id>`'s upstream. It is assembled in
a staging dir beside the checkout, where no pod looks, populated from there,
and renamed in as `.git` — one new directory entry, so the checkout's inode,
which a pod may already have bound as `/workspace`, is never replaced. The
porcelain `git clone` is no use for it: it refuses a non-empty destination
(the pod's module mount points are already there), it would map the main
clone's local branches rather than its remote-tracking ones, and it would
write whatever alternates path it resolved.

**The alternates line** is the only path-shaped git state a checkout carries,
and it is always the main clone's objects dir as the SERVER sees it. A pod
mounts the main clone at that same path (under the in-cluster server,
`/yaac/global/projects/<slug>/repo/.git`), so the line holds in every view,
including a pod's boot before any launch step has run. The launch rewrites it
on every create and restart, on both drivers (`buildCloneLinkExec`), which
heals a checkout last launched by a server that saw the data dir elsewhere.

Worktrees share no git state: branches, tags, the stash, hooks and config
are per checkout, so one agent's `git config`, `gc --prune=now` or
`branch -D` reaches no sibling. An agent that wants another worktree's
unpushed branch has to push it first. Under k8s that is enforced: a pod sees
only its own checkout and the main clone, read-only. Under containerless it is
not — every workspace runs as the server's user with no mount namespace, so an
agent can still write the main clone and its siblings' clones directly
(docs/containerless-driver.md).

## Object lifetime: the main clone never deletes an object

A clone breaks when an object it borrows is deleted, and the main clone
cannot see which ones its clones use: their refs, indexes and reflogs are in
their own git dirs. An object in the main clone becomes unreachable when a
fetch follows an upstream force-push or branch deletion, and default gc would
prune it two weeks later.

So nothing prunes the main clone. The runner pins `gc.auto=0` and
`maintenance.auto=false` on every call, and the one gc the server runs,
`maintainRepo`, is `gc --auto` with `gc.pruneExpire`, `gc.reflogExpire`,
`gc.reflogExpireUnreachable` and `gc.worktreePruneExpire` pinned to `never` on
the command line, in the foreground, under the fetch's per-repo mutex so it
never repacks under a fetch. Unreachable objects go to a cruft pack and stay.
A `--prune` flag would beat those pins, which is why nothing passes one.
`cloneRepo` also writes the prune and reflog keys into the main clone's own
config, for git that runs there without the server's pins — a user, or a
containerless agent. A clone gcs freely: its repack is `-l`, local objects
only.

The cost is disk, and on an ordinary project unreachable objects come only
from upstream force-pushes. If a project ever needs reclaiming, the fix is a
pin per live clone in the main clone (`refs/yaac/pins/<id>` naming each
clone's borrowed tips), which makes ordinary gc safe again.

## Keeping `origin/*` fresh

A checkout's `origin/*` is its own, so a server fetch reaches it only when
something copies the refs over (`#domain/projects`, `origin.ts`):

- **Every server fetch fans out.** `fetchProjectOrigin` — which the create, a
  spare's claim, the branch picker's refresh and the timer below all go
  through — schedules `maintainRepo` and then refreshes every running
  workspace of the project, a few at a time, without the caller waiting on
  either. Fan-outs are coalesced per project: one asked for while another
  runs marks the project, and the running one goes round once more, so a
  burst of creates costs at most two rounds of execs.
- **The server fetches on a timer.** The `origin-refresh` reconcile step
  fetches every project that has a running worktree and has not been fetched
  for five minutes, so a project nobody creates in still trails origin by
  minutes. A failure is logged and tried an interval later; a stale
  `origin/*` is all it costs.
- **Every launch refreshes too**, right after the alternates line, so an agent
  starts current whatever the fan-out's timing.

The refresh (`buildOriginRefreshExec`) is a local fetch from the main clone,
run in the workspace:

```sh
git -C <workspace> fetch --quiet --no-tags --no-write-fetch-head \
    <main clone>/.git 'refs/remotes/origin/*:refs/remotes/origin/*'
```

Every object is already reachable through the alternate, so nothing crosses
the network and no credential is used. The refspec has no `+`: a ref the
agent fetched ahead of the main clone is never moved back (git rejects that
one ref and moves the rest), at the price of a force-pushed branch staying
stale in a checkout until its agent fetches it. There is no `--prune`, so a
ref the agent fetched that the main clone has not seen stays. And it never
writes `FETCH_HEAD`, which the agent's own `fetch` + `merge FETCH_HEAD` may be
between.

An agent's own `git fetch origin` goes to the network as it always did. Since
the pod mounts the main clone's refs as well as its objects, git can offer
their tips as haves, so it downloads only what the main clone lacks.

## Every server git call

**Against the main clone**, which is trusted because only the server writes
it: `cloneRepo`, `fetchOrigin` and `maintainRepo`, `getDefaultBranch`,
`listRemoteBranches`, `remoteBranchExists`, `resolveRemoteRef`, the skills
reads (`listTreeSubdirs`, `readBlobAt`), and the ref snapshot `createCheckout`
takes.

**Against a checkout's staged git dir**, only while `createCheckout` is
building it and no workspace can see it (the runner's `private` target).

**Never against a checkout's git dir after that.** What needs a checkout's own
state runs inside its workspace, and so only while it runs: the Changes pane's
diff, the file explorer's listing and the git status bar's ahead/behind count
(docs/file-editor.md), a spare's HEAD and re-branch at claim time, and the
refresh above. The worktree's base branch is its row's, never read back out
of the checkout's config, which the agent can rewrite.

## The runner

Every git process the server starts goes through `runGit`
(`#domain/git`, `run.ts`), and the `#domain/git` barrel's verbs are its only
callers. Each call pins, on the command line where they beat any config:

- `core.hooksPath=/dev/null` and `core.fsmonitor=false`
- submodule recursion off
- `gc.auto=0` and `maintenance.auto=false` (see above)
- `protocol.allow=never`, plus the one transport of the remote the call talks
  to

The server's own global and system config are still read. They belong to the
server's user, not to a pod.

### The throwaway git dir

While a project still holds a checkout an older install made — a `git
worktree add` linked checkout, whose pod mounts the main clone read-write
(docs/legacy-compat-shims.md) — git must not read the main clone's config,
which that pod can write and which can name commands for git to run under
names only its writer knows (filter drivers, the fsmonitor, credential
helpers, `url.*.insteadOf`). So every call against a main clone builds a git
dir in server-private scratch (`<server-local>/run/git-shadow/g-*`, cleared at
startup): a `config` built from an allowlist (`core.repositoryformatversion`,
`extensions.objectformat`) after one no-follow read of the real one, a
validated copy of `HEAD`, and links to the real `objects`, `refs`,
`packed-refs`, `logs`, `info` and `shallow`. A repository using a ref storage
other than `files` is refused.

Converting a project's last linked checkout sanitizes its main clone
(`sanitizeMainClone`): a `.git` holding any symlink is refused, the config is
rewritten from the allowlist plus the row's `remote.origin.url` and the
never-prune keys, and `hooks/`, `info/attributes`, `objects/info/alternates`
and `worktrees/` go. Branches stay: an `agent/*` no clone received (a deleted
worktree's, an agent's side branch, a checkout whose `.git` vanished) is the
only name its commits have. From then on no pod can write it, and the
throwaway dir guards nothing; it goes once no install can still have a linked
checkout.

## Remote URLs come from the project row

The URL a fetch goes to, the credential it is matched with, and the `repoUrl`
the k8s proxy uses to bound its project's https credential to one host and to
gate the ssh agent all come from `projectRemoteUrl(slug)` in
`#domain/projects`, which reads the project row. `fetchOrigin` takes that URL
as an argument and fetches by explicit URL and refspec. It never uses the name
`origin`, so no repository's `remote.origin.*` affects where a fetch goes or
which token it carries. Both the main clone's `remote.origin.url` and each
checkout's are written tokenless from the row, for the workspaces' own git.

## Consequences

- Filters configured in a repository, such as LFS set up with
  `git lfs install --local`, apply only to the checkout they were set up in,
  and never to the server's checkout. LFS configured in the server user's
  global config still does, and pods fetch LFS content themselves.
- A shallow main clone is refused rather than shared: every clone would need
  its `shallow` file. `cloneRepo` never makes one.
- Submodules initialized in a checkout live in that checkout's own
  `.git/modules`.

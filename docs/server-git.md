# Server-side git

A repo (docs/project-repos.md) has one **main clone**, at
`global/repos/<repo id>`, shared by every project that links the repo. Each
checkout of it in a workspace is a separate clone that borrows the main
clone's objects. The server owns the main clone; each workspace owns its
checkouts: none, one at its root, or one per repo in a folder each.

## The layout

| Path (server view) | What it is | Who writes it | In a k8s pod |
|---|---|---|---|
| `repos/<repo id>/.git` | The main clone: origin's refs as `refs/remotes/origin/*`, and origin's objects | the server only | read-only, at the path the server sees |
| `workspaces/<id>/` | The workspace dir | the workspace | `/workspace` |
| `workspaces/<id>/[<folder>/]` | A checkout: the workspace dir itself, or a folder of it | the workspace | `/workspace[/<folder>]` |
| `workspaces/<id>/[<folder>/].git/` | A git dir whose `objects/info/alternates` points at its main clone's objects | the workspace (created by the server) | inside the checkout |

A containerless workspace sees the server's paths unchanged.

**The checkout's git dir** (`createCheckout` in `#domain/git`) holds no
objects. It starts with the main clone's `origin/*` refs and tags written as
`packed-refs` (so thousands of branches do not become thousands of files),
`agent/<id>` checked out at the commit the start picked (below), and a
server-written config: the object format, `remote.origin` (the repo row's
URL, without a token), and `agent/<id>`'s upstream. It is built in a staging dir beside the workspace
dir, where no workspace mounts it, and renamed in as `.git`, so the checkout
directory itself is never replaced; a pod may already have the workspace
dir bound as `/workspace`. Plain `git clone` can't do this: it refuses a
non-empty destination, copies local branches rather than remote-tracking
ones, and writes its own alternates path. The tree is written by eight
processes at once (`checkout.workers`, which a workspace's own git also
gets). Under k8s the server builds only the `.git`, in place, and the
workspace's tree container checks the tree out on its node
(docs/node-local-workspaces.md).

The git dir comes from one `git init`, kept because it probes the filesystem
for settings such as macOS's `core.ignorecase`, with the files ref format
pinned over the user's default: a reftable repo would ignore the refs written
beside it. Its `origin/*` refs, tags, `HEAD` and remaining config are then
written as files, and a `checkout -B` sets `agent/<id>` with its reflog and
writes the tree. So a checkout costs three git processes: the `init`, the
`for-each-ref` that reads the main clone's refs, and the `checkout`.

**An empty origin gets its default branch from the server.** A just-created
remote has no branches, and a host such as GitHub makes the first branch
pushed to it the default, whatever its name. Left alone, that would be an
agent's `agent/<id>` or a PR branch. So once a create's fetch finds origin
with no branches, the server pushes an empty root commit, authored as the
project's owner, to the branch the main clone's `HEAD` names
(`seedEmptyOrigin`). A clone of an empty remote takes that from the
remote's advertised default where the host advertises one (GitHub does),
else from this server's `init.defaultBranch`. The checkout then starts on
it like any other base. The seed starts only once the create's own checks
(credential, egress allowlist, tool, the workspace row) have passed, so a
create refused by one leaves the remote alone. Nothing is forced, and the
push holds the fetch lock, so of two creates racing on one repo only the
first pushes. The local refs are only current if a fetch just ran, so the
remote itself is asked (`ls-remote`) to confirm it is empty before the
push. A credential that cannot push fails the create, naming the remedy.

**The alternates line** is the only path stored in a checkout's git state. It
always holds the main clone's objects dir as the server sees it, and a pod
mounts the main clone at that same path
(`/yaac/global/repos/<repo id>/.git` under the in-cluster server), so the
line is valid everywhere. A launch that reuses a checkout rewrites it
(`buildCloneLinkExec`), which repairs a checkout last launched by a server
that saw the data dir at another path. The same command sets an `origin`
that still names yaac's hosted remote to the repo row's URL, so a
checkout of a repo that moved to another git host
(docs/hosted-projects.md) pushes there once restarted. An `origin` the
user pointed elsewhere is left alone. A checkout the launch made has both
already.

Workspaces share no git state: branches, tags, stash, hooks and config are
per checkout, so one agent's `git config`, `gc --prune=now` or `branch -D`
cannot affect another. To use another workspace's unpushed branch, that
workspace must push it. Under k8s this is enforced, since a pod sees only its
checkout and a read-only main clone. Under containerless it is not: every
workspace runs as the server's user, so an agent can write the main clone and
other checkouts directly (docs/containerless-driver.md).

## Starting a workspace

A start fetches origin, but nothing on its way to the agent's window waits
for that fetch, whether it claims a prewarmed spare or provisions cold. Both
follow one sequence (`pickStart` in `checkouts.ts` and `origin-catch-up.ts`,
in `#domain/workspaces`):

1. **Pick the start commit** from the main clone: the tip it has for the
   base branch, or for the branch the create names. Only a branch the clone
   lacks (one never fetched, or an empty origin's) waits for the fetch, and
   the start is refused if the branch is still missing then. So a branch
   that does not exist is refused before anything launches.
2. **Get a workspace at that commit.** A cold create writes the checkout's
   `.git` there and, under k8s, the tree container's start instruction at
   once. A claim takes a spare, moving it first if it stands on another
   commit or branch.
3. **Launch the agent.**
4. **Catch up** once the workspace is up and the fetch has landed, whichever
   comes later. A fetch that has landed by the time the agent's window is
   about to open is caught up with in the command that opens it, ahead of
   the window, so the agent never sees the older tree. That is the usual
   case for a cold create, whose pod takes longer to boot than a fetch. A
   fetch that lands within five seconds after the launch is caught up with
   then. A later one leaves the workspace behind origin, like any workspace
   whose base moved after it started, and the server logs it.

   One launch opens its windows before that command: a containerless
   workspace's chat agents start while the checkout is still being
   written, their conversations held until it lands. Their catch-up counts
   as after the launch.

Catching up is one command, run inside the workspace as the agent's own
user. The server resolves the target commit from the main clone, and the
command moves the checkout to it only where that is safe:

- It fast-forwards (`git merge --ff-only`). Git refuses when the checkout
  has commits of its own, or a change the incoming commits would overwrite.
- Where a fast-forward is impossible (origin's branch was force-pushed),
  the checkout is reset to the target only ahead of the launch, while
  nothing runs in the workspace, and only if it is untouched: still on the
  commit it started at, with nothing modified or untracked
  (`git status --porcelain --untracked-files=all --ignore-submodules=none`,
  which no git config can narrow). The test and the reset are separate
  processes, so after the launch a file written between them would be
  lost; there the checkout is left behind origin instead.
- Any other checkout is left as it is, and the server logs it.

Either way the checkout's `origin/<branch>` is set to the target, so its
ahead and behind counts are right, and a checkout that moved has its
recorded start commit moved with it. The command runs with the repo's hooks
off, so a `post-merge` hook (a package install, say) does not fire because
the server moved the checkout. Each checkout of a workspace with several
repos catches up on its own repo's fetch.

The same command moves a spare: to a new tip in the background, so a claim
finds it current (`refreshSpares`), and to the commit or branch a claim
starts at. Nothing has touched a spare, so it is reset wherever a
fast-forward is refused, its untracked files removed but for the mount
points (scratch dirs and cache volumes), and a spare that still does not
reach its target is reaped.

What this costs:

- An agent launched before the catch-up read its instructions
  (`CLAUDE.md`) and took its git snapshot at the older commit, and an init
  step already running saw the older tree.
- A fast-forward after the launch moves the tree under a running agent.
  Git checks the working tree first and then rewrites files, so a change
  made in between to a file the incoming commits also change is
  overwritten. What the agent changes elsewhere stays.
- The untouched test trusts `git status`, which does not report a change
  to an entry marked `assume-unchanged` or `skip-worktree`, and a reset
  overwrites an ignored file at a path the target starts tracking.
- A fetch that fails does not fail a start whose branch the main clone
  has: the workspace starts from the last commit fetched, and the server
  logs why. A create that needs the fetch (a branch the clone lacks, a
  commit, an empty origin) still fails with it.
- A named branch origin has deleted, which the main clone still has until
  the fetch prunes it, starts and is logged.

Some starts wait for the fetch instead and are never moved afterwards: a
create at a commit, which has no branch to follow; a restart, which reuses
its checkout; and a non-interactive run or a site's release, which nothing
may change once it runs, so it starts at origin's tip.

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
copies them over (`origin.ts` in `#domain/repos` fetches,
`origin-fanout.ts` in `#domain/workspaces` copies):

- **Every server fetch fans out.** `fetchRepoOrigin` (create, spare
  claims, the branch picker's refresh, a base branch change, the timer
  below) schedules
  `maintainRepo` and refreshes the checkout of the repo in every running
  workspace that has one, in any project, a few at a time, without making
  the caller wait. Fan-outs are coalesced per repo, so a burst of creates
  costs at most two rounds. A spare that a create is claiming is refreshed
  only once the claim is over, so the command that opens its session never
  queues behind the refresh in the pod.
- **A timer fetches.** The `origin-refresh` reconcile step fetches every
  repo that a running workspace has a checkout of and that was not fetched
  in the last five minutes. A failure is logged and retried next interval.
- **A launch that reuses a checkout refreshes**, right after rewriting the
  alternates line, in the same exec that starts the agents. A checkout the
  launch made holds the refs the main clone had then, and catches up with
  the create's fetch ("Starting a workspace"). In a pod that exec also
  starts a detached
  `git --no-optional-locks status` (`buildStatusWarmupExec`), which fills
  the sandbox's file cache before anything else asks
  (docs/nfs-checkout-performance.md).

The refresh (`buildOriginRefreshExec`) is a local fetch from the main clone,
run inside the workspace:

```sh
git -C <checkout> fetch --quiet --no-tags --no-write-fetch-head \
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

A start's catch-up ("Starting a workspace") is the one place a checkout's
`origin/<branch>` is set outright rather than fast-forwarded, which is how
it follows a force-push.

## Where the server runs git

- **Against the main clone**, trusted because only the server writes it:
  `cloneRepo`, `fetchOrigin`, `maintainRepo`, `getDefaultBranch`,
  `listRemoteBranches`, `remoteBranchExists`, `resolveRemoteRef`, the skills
  reads (`listTreeSubdirs`, `readBlobAt`), and `createCheckout`'s ref
  snapshot.
- **Against a checkout's staged git dir**, only while `createCheckout` builds
  it and no workspace can see it (the runner's `private` target).
- **Never against a checkout's git dir after that.** Anything that needs a
  checkout's state runs inside the workspace, in that checkout's directory,
  so only while it runs: the changes diff, the file explorer, the git status
  bar's ahead/behind count (docs/file-editor.md), a spare's HEAD, the move
  of a spare or a starting workspace to its branch's tip, a stop's removal
  of ignored files, and the refresh above. The one
  exception is that removal's fallback for a stopped workspace, which runs
  git on the checkout as root in a one-shot gVisor pod that mounts nothing
  else, or as the server's user under containerless, with the
  repository's config kept from running anything (docs/workspace-storage.md
  "Ignored files at stop"). A workspace's base branch comes from its row,
  never from the checkout's config, which the agent can rewrite. The one read
  that works on a stopped workspace parses its git dir without running git
  (below).

## Reading another workspace's git

`yaac-mama fetch <workspace>` gives one workspace another's committed work,
running or stopped, in the same project. It acts on one repo: the checkout
the caller runs it in (the script sends that checkout's path; a workspace
with one checkout needs none), and the target's checkout of the same repo.
The server reads the target's git dir and answers with a git bundle of its
branches and HEAD; the caller's own
git fetches that into `refs/yaac/peers/<id8>/*` with
`transfer.fsckObjects`, so every object is checked in the caller's sandbox.
That namespace is outside `refs/remotes`, so no remote's fetch or prune can
write or delete there, and git still resolves the short name
`yaac/peers/<id8>/HEAD`.

The target's git dir is agent-written, so the server treats it as data
(`bundleCheckout` in `#domain/git`):

- **A link-free snapshot.** The server copies `HEAD`, `packed-refs`,
  `refs/heads/**` and `objects/**` (never `objects/info`, so no alternate)
  into a private temp dir through a confined root (`#lib/confined-fs`) with
  the `no-links` policy: a symlink anywhere under `.git`, or a `.git` that is
  itself a link, is skipped, and a FIFO never blocks. The copy stops at
  256 MiB. Config, hooks and the index are never copied, so nothing in them
  can be acted on.
- **No git runs on it.** isomorphic-git does the reading. It starts no
  process, so no hook, `core.fsmonitor`, filter or transport could fire even
  if one were there, and it does not read alternates.
- **A sandboxed child process** (`peer-reader`, built to the self-contained
  `dist/git-peer-reader.mjs`). Node's permission model lets it read the
  snapshot and its own file and nothing else, and denies child processes,
  workers, addons, WASI, the inspector and every write. The read limit is a
  real boundary only because the snapshot holds no link: Node checks a path
  as written, so a link inside an allowed tree would lead out of it, and the
  reader cannot make one since it cannot write. The reader refuses to start
  unless every limit this Node can enforce is in force. Node 24 has no
  network permission, so there the reader could open a connection, but it
  can read nothing beyond the snapshot, which is the data the caller is
  given anyway. Workers stay denied because a worker given its own
  `execArgv` leaves the permission model, which is also why the reader
  cannot run as source under tsx, whose loader needs one; tests build it
  first.
- **Memory, time and load.** An object's declared size can lie about what
  it inflates to, so the bound is the OS: the reader runs under
  `ulimit -v` (2.5 GiB of address space, of which Node itself maps about
  1.2 GiB), which stops a decompression bomb at about 1.2 GiB resident. The
  reader streams the pack one object at a time, so an answer at its 128 MiB
  cap peaks about 600 MiB above Node's own mapping, inside the limit. It
  loads each of the snapshot's packs once and keeps it, which the snapshot
  cap bounds, and sends at most 50,000 objects, which keeps a read of a
  packed workspace well inside its deadline. macOS
  does not enforce that limit, so there only the snapshot and pack caps
  apply. The child also gets no environment, a 256 MiB heap and a two-minute
  deadline, the pack it returns is capped at 256 MiB, and at most two
  readers run at once across the server; another fetch is refused with
  "try again".
- **Refs are checked by the server**, and only `refs/heads/*` and HEAD are
  taken, with names restricted to plain characters (and not
  `refs/heads/HEAD`), so a ref name cannot inject a line into the bundle
  header or collide in the caller's refs. A ref whose tip is in neither the
  target nor the main clone (`rev-list --ignore-missing` against the trusted
  main clone) is dropped, so one dangling branch cannot fail the whole fetch.

`peer-bundle.test.ts` holds these lines against dependency upgrades. It
plants every hook, every config key whose value git runs (fsmonitor,
filters, helpers, editors, `ext::` transports, includes) and an alternate
to another repository, then checks that nothing fired and no foreign object
was sent. It feeds the reader a 1.9 GiB decompression bomb, and checks that
the reader refuses to run without its sandbox or with any of it widened.

The walk stops at the first object the target does not hold itself, since
that one is borrowed from the main clone. The bundle therefore carries only
the target's own objects, and the caller resolves the rest through the same
main clone. Only SHA-1 repositories can be read. What the bundle says is
what the target's agent wrote, so it is a claim about that workspace, not
proof: use it to read work, never to grant anything.

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

## Remote URLs come from the repo's row

The URL a fetch goes to and the credential matched to it come from the
repo's row (`origin.ts` in `#domain/repos`), as do the grants that tell the
egress path which repo each credential may reach (docs/git-credentials.md).
For a repo the server hosts, the server's own fetch reads the bare
repository from disk instead (docs/hosted-projects.md). `fetchOrigin` fetches by
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

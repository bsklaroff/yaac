# Server-side git

A project has one **main clone**, at `global/projects/<project id>/repo`. Each
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
(`/yaac/global/projects/<project id>/repo/.git` under the in-cluster server), so the
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
  changes diff, the file explorer, the git status bar's ahead/behind
  count (docs/file-editor.md), a spare's HEAD and its move to a new base
  tip, and the refresh above. A workspace's base branch comes from its row,
  never from the checkout's config, which the agent can rewrite. The one read
  that works on a stopped workspace parses its git dir without running git
  (below).

## Reading another workspace's git

`yaac-mama fetch <workspace>` gives one workspace another's committed work,
running or stopped, in the same project. The server reads the target's git
dir and answers with a git bundle of its branches and HEAD; the caller's own
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

## Remote URLs come from the project row

The URL a fetch goes to, the credential matched to it, and the `repoUrl` the
k8s proxy uses to limit the project's https credential to one host and to
gate the ssh agent all come from `projectRemoteUrl(projectId)` in
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

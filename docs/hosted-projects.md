# Repos hosted by yaac

A repo can be created inside yaac with no remote of its own. `yaac project
create <name>`, or "New project" in the webapp's Add project dialog, makes
a project with one such repo, and Project settings adds one to an existing
project ("New hosted repo"). The server then hosts the repo's git remote
itself. Everything below the remote, including the main clone, checkouts,
`origin/*` refresh, the branch picker, `yaac-mama` and image builds, works
exactly as for a repo cloned from GitHub, because the main clone treats the
hosted remote as just another remote. Hosted is a property of the repo
(`repos.hosted`), so one project can link hosted and external repos side by
side (docs/project-repos.md).

## The bare repository

A hosted repo's remote is a bare repository at
`server-local/hosted-repos/<repo id>.git` (`hostedRepoDir`). It sits in
the SERVER-LOCAL tier, not beside the main clone in GLOBAL, for three
reasons:

- **No workspace pod can mount it.** The k8s driver refuses a SERVER-LOCAL
  mount, so a pod can change the repository only through the git route
  below, where the server checks who is asking.
- **It is block storage.** On a byo cluster SERVER-LOCAL is the RWO claim,
  which suits git's small writes better than the NFS-backed GLOBAL claim.
- **It is already backed up.** That claim also holds the database, so an
  operator already treats it as precious (docs/cluster-setup.md).

The cost is that every object is stored twice: once in the bare repository
and once in the main clone. The main clone cannot borrow the bare
repository's objects through an alternate, because pods would then have to
see SERVER-LOCAL.

`createHostedRepo` creates the repository empty, on `main`
(`initHostedRepo`), then clones it as the main clone over the `file`
transport, the same `cloneRepo` that adding a repo by URL runs. The
first workspace create gives it `main`, as an empty commit, as it does any
empty remote (docs/server-git.md).

Nothing is ever lost from the repository:

- `core.logAllRefUpdates=always` puts every ref update in a reflog;
- the main clone's never-prune settings apply here too, and the gc after a
  push never prunes.

So a forced push or a deleted branch can always be recovered by hand
(`git reflog show <branch>` in the bare repository).

## Serving it

The server speaks git's smart HTTP protocol by running `git http-backend`
as a CGI (`serveGitHttp` in `#domain/git`). It goes through the runner's
pins like every other git process (docs/server-git.md "The runner"). It
serves only the three smart endpoints (`info/refs`, `git-upload-pack`,
`git-receive-pack`), never the dumb protocol's file reads. Two more
settings apply to every push:

- `receive.fsckObjects` checks every pushed object;
- `receive.maxInputSize` caps a push at 2 GiB.

The same handler answers two routes, which differ only in who is asking:

| Route | Who | May read | May push |
|---|---|---|---|
| `/api/workspace/git/<repo id>.git/…` | a workspace | the repos its project links | the same, unless the link is read-only |
| `/api/repo/<repo id>/git/…` | the user's own git, on the API origin | any user (docs/multi-user.md) | the owner, and users it is shared with |

A workspace's project must link the repo, and the project's owner must
still be allowed to use it (`canUseRepo`: its owner, or a user it is shared
with), so a workspace of a user whose share ended reaches nothing.

These are boundaries under k8s only. A containerless workspace runs as the
server's user, so it can reach the user route on loopback as the owner, and
can write `server-local/` (the hooks and every bare repository) directly.
That is the containerless model (docs/multi-user.md), not something the
routes can change.

Neither listener caps a request's total time (`requestTimeout: 0`, and the
same on the egress proxy's HTTP listener), since a large push can upload
for longer than Node's five-minute default.

**A workspace's identity is its credential.** A hosted repo has no git
credential, and `resolveRepoCredential` answers `{ kind: 'hosted' }` for it,
so workspace create never asks for one. The egress allowlist is not
consulted either. Every checkout's `origin` is
`http://yaac.internal/api/workspace/git/<repo id>.git` on both drivers,
which is the repo row's `remoteUrl`:

- **Under k8s** the pod's request reaches the egress proxy like any plain
  HTTP egress. The proxy relays `yaac.internal` to the server's yaac-mama
  listener before it reads the allowlist (`k8s/proxy/yaac-relay.ts`),
  naming the pod's workspace and authenticating as the proxy, exactly as it
  does for `yaac-mama` (docs/workspace-egress.md "yaac-mama"). The pod holds
  no secret.
- **Under containerless** the workspace's private gitconfig rewrites that
  prefix to the server's loopback origin (`url.<origin>.insteadOf`). It
  sends the workspace's yaac-mama token as a bearer header to that origin
  only (`http.<origin>.extraHeader`). Like `YAAC_MAMA_URL`, the port is
  fixed at launch, so a workspace started before the server moved to
  another port reaches its remote again once it restarts.

The user's clone URL is `<server origin>/api/repo/<repo id>/git`.
`yaac project clone <project> [dir]` runs `git clone` against it, and
Project settings shows it. A browser cannot forge a push there: a
receive-pack request has a non-simple content type, which forces a CORS
preflight the server never approves.

**A push reaches every workspace at once.** When a push succeeds, the
server fetches the bare repository into the main clone (`fetchRepoOrigin`).
That fetch's fan-out refreshes `origin/*` in every running workspace that
has a checkout of the repo, in any project of any user, so a sibling sees a
pushed branch within seconds rather than at the next five-minute refresh.

## The hooks

The bare repository runs two hooks that yaac ships. The server writes them
to `server-local/run/hosted-git-hooks` and points `core.hooksPath` there on
the command line when it serves the repository. This is the one place the
server lets git run a hook. That is safe because the hooks are yaac's own
scripts, and under k8s the repository is one only the server writes.

**The default branch** is whatever the repository's `HEAD` names. A new
repository's `HEAD` is an unborn `main`. While `HEAD` names a branch that
does not exist, the `post-receive` hook points it at one that does:
`main`, else `master`, else the first by name. So a repo first filled
by pushing `master` defaults to `master`. git waits for the hook before the
push completes, so a clone right after the push sees it. The server then
copies it into the main clone's `origin/HEAD` (`setOriginHead`), which a
clone of an empty remote could not learn, so creates fork from it.

The owner can point `HEAD` at any existing branch in Project settings or
with `yaac config default-branch <project> <branch>`
(`PUT /api/repo/<id>/default-branch`, `setDefaultBranch`). The main clone
takes it as `origin/HEAD` before the request answers, so the next create,
in any project that links the repo, forks from it, and the guard below
moves to it. A main clone that cannot take it (a stale lock file, say) is
logged rather than failing the change, and follows at the next push or
change of default; setting the same branch again is that retry. The clone
reads the default from the repository after its fetch, so a push landing
during a change cannot put the old default back. Only the repo's owner
changes it, whoever it is shared with.

What has already chosen a branch keeps it: a running or stopped workspace's
checkout stays on the base branch it was created on. What resolves the default
only when it launches takes the new one: a queued workspace or routine
that names no branch, and a prewarmed spare, which is rebranched to the
current default when claimed.

**The `pre-receive` hook** refuses a branch named `HEAD`, which every clone
would find ambiguous. While a repo's default-branch guard is on
(`repos.guardDefaultBranch`, on by default), it also refuses a push
that deletes the default branch, or moves it to a commit that does not
contain its old tip. Agents can still rewrite every other branch. The owner
turns the guard off and on in Project settings or with `yaac config
default-branch-guard <project> on|off`
(`PUT /api/repo/<id>/default-branch-guard`). The hook runs after the
pack is received, so it can check ancestry against the pushed commits. A
pre-check in the handler could only see ref names.

## No pull requests

A hosted remote is plain git: it has no pull requests, reviews or web UI.
Agents land work by pushing to the default branch (with the guard on, a
fast-forward), and the user reviews it in the webapp's changes view or a
local clone. The built-in skills that drive `gh` (`push-pr`, `review-pr`,
`spawn-pr-reviewers`, `yaac-watch-prs`) check the `origin` URL first and say
they do not apply.

## Sharing

The owner of a hosted repo can share it with another user of the install
(`POST /api/repo/<id>/share`, `shareRepo`; Settings → Repos, or `yaac repo
share`). A share is a row (`repo_shares`) and nothing else: it lets that
user link the repo into any project of theirs, beside their own repos
(docs/project-repos.md). Their projects then use the owner's repo row and
main clone, the one place a main clone serves two users, which is allowed
because the owner granted it. `canUseRepo` (its owner, or a user it is
shared with) is checked when a repo is linked, for each repo a create or
restart starts with, and on every push.

Everything above applies to a sharer unchanged: their workspaces read and
push the repository through the workspace route, they push through the user
route, and a push lands in the one main clone and reaches every running
checkout. The default branch and its guard stay the owner's to set.

Only a repo the server hosts can be shared. One hosted elsewhere already
has a remote each user can add under their own credential, which is what a
shared repo becomes when it moves to another git host (see "Moving to a git
host").

**Ending a share** (`POST /api/repo/<id>/unshare`, `unshareRepo`) deletes
the row and stops that user's running workspaces that hold a checkout of
the repo, adopting any token their agents refreshed, as a stop does.
Nothing else of theirs changes: their projects, links, workspaces and
checkouts stay, and work again if the repo is shared again. Until then a
create or restart with the repo is refused, and both git routes refuse
them. A workspace that cannot be stopped then, or a create or restart that
had passed its check first, is stopped by the `revoked-shares` reconcile
step (`reconcileRevokedShares`), which on every pass tears down any running
workspace holding a checkout of a repo its project's owner may not use.

## Moving to a git host

The owner can move a hosted repo to an empty repository elsewhere, such as
a new one on GitHub, with one of their git credentials (`yaac project move
<project> <remote-url> <credential>`, `POST /api/repo/<id>/move`, or "Move
to a git host" in Project settings). Afterwards it is an ordinary repo of
that remote. yaac keeps its repository, read-only, until the owner removes
it (see below).

The move stops other users' workspaces, so clients warn first.
`GET /api/repo/<id>/move-preview` (`previewRepoMove`) says how many
workspaces would stop and whom the repo is shared with. The webapp shows
that above the form, and the CLI asks to continue, on a terminal only.

Behind an egress proxy, the remote's host must already be in the egress
allowlist of each of the owner's projects that link the repo, or the move
is refused before anything else happens: every workspace restarted after it
would be refused, as a create is. Another user's project keeps its own
allowlist, which their next create checks.

`moveRepoToRemote` holds the repo (`withRepoHeld`) and every project that
links it (`withProjectsHeld` in `#domain/access`) for the whole move. A
held repo refuses every push, and `authorizeProject` refuses every write to
a held project as CONFLICT, the server's own included, so nothing starts in
it (creates, restarts, "Run now", routines). Queued workspaces that become
ready meanwhile, such as those released by the stops below, wait rather
than fail, and start once the hold lifts, on the new remote. Then:

1. **Check the remote** (`checkMoveTarget`). The credential must be able
   to push there. Reading the remote cannot show that, and a public one
   may not ask for the credential at all, so a dry-run push asks the
   remote's push endpoint and sends nothing. It dry-runs deleting a branch
   that does not exist, which needs no commits, so an empty repo is
   checked the same way. The remote must also be empty, or hold only what
   a push from here left there: each branch contained in the repo's branch
   of that name, each tag the same. That is what a push that failed partway
   leaves, even if the repo's branches moved on before the retry, so a
   retry finishes the move, and the push only ever fast-forwards. A host's
   starter commit, such as a README, is refused. The move's git calls give
   up on a remote that stops answering, so a stalled remote cannot hold the
   repo for long.
2. **Stop every workspace** holding a checkout of the repo, whoever owns
   it, keeping its checkout, and reap the spares warmed with it. A create
   or restart already past its last checkpoint is waited for, then stopped
   with the rest. They were launched to push to yaac, and a k8s workspace's
   egress registration is fixed at launch. A workspace of a linking project
   that holds no checkout of the repo runs on.
3. **Push** every branch and tag (`pushHostedRepo`), nothing forced. The
   default branch goes first, because a host that takes its default branch
   from the first push (GitHub does) then agrees with the main clone's
   `origin/HEAD`. Nothing else moves: other refs (such as `refs/notes/*`)
   and the reflog, which can recover a forced push or a deleted branch,
   stay only in yaac's copy.
4. **Switch.** The repo takes the remote, the credential and its host key,
   and its shares end.
5. **Hand each other user their own repo.** A main clone holds what its
   owner's credential fetched, so users no longer share one. Each other
   user whose projects or workspaces name the repo gets a repo row of
   their own for the same remote, with a copy of the main clone and no
   credential, and everything of theirs that named the repo names it
   instead (`repointProjectRepos`): links, checkouts, queued entries,
   routines, drafts and sites. They assign a credential before their next
   create (docs/git-credentials.md).
6. **Fetch and hand over the credential.** The main clone fetches from
   the new remote, and the runtime is handed the credential set again
   (`pushCredentialsToRuntime`), since an egress proxy injects only what it
   was last handed. If that fails, the move reports it: the repo has moved,
   but its workspaces cannot push until the next credential change or
   server restart.

A failure before step 4 leaves everything on yaac. The workspaces stopped
by then stay stopped. A stopped workspace's checkout still names yaac as
`origin`, and restarting it points `origin` at the repo's remote
(docs/server-git.md), so its unpushed commits go there on its next push.

**yaac's old repository.** The bare repository stays where it was after
the move, and the row's `keepsHostedRepo` says so. The user route keeps
serving it for clones and fetches, so the owner can compare it with the
new remote (Project settings shows `git ls-remote` for both, which also
lists the refs a move does not push). Every push is refused. Once the owner
has checked the remote has everything, they remove it from Project
settings (`DELETE /api/repo/<id>/kept-hosted-repo`,
`removeKeptHostedRepo`). Deleting the repo removes it too.

## Deleting a repo

Nothing deletes a repo but its owner (`yaac repo delete`, `DELETE
/api/repo/<id>`, `deleteRepo`; Settings → Repos), hosted or not. Removing a
project, or unlinking a repo from one, leaves the repo, its credential and
its main clone among its owner's repos, ready to link again; a project made
by `yaac project create` leaves its hosted repo behind, unlinked, when it
is removed. Settings → Repos lists the repos no project links first, since
nothing else in the webapp shows them.

A delete unlinks the repo from every project, other users' included, ends
its shares, and for a hosted repo deletes the bare repository, the only
authoritative copy of its code. So clients confirm first:
`GET /api/repo/<id>/delete-preview` (`previewRepoDelete`) answers whether
yaac holds that only copy, the projects it would be unlinked from and the
workspaces holding a checkout of it, and the webapp points at `yaac project
clone`.

It deletes and stops no workspace. One holding a checkout keeps its files
and its commits, with no remote to fetch from or push to. Those checkouts
borrow their objects from the main clone, so while any workspace holds one
the main clone and the repo's row (marked `deletedAt`, usable by no one)
stay. The delete answers those workspaces, with their projects and owners,
and Settings shows the repo with what still holds it. Once the last of them
is deleted, the `deleted-repos` reconcile step (`collectDeletedRepos`)
removes the main clone and the row. With no such workspace, everything goes
at once.

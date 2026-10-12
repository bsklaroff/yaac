# Projects hosted by yaac

A project can be created inside yaac with no remote of its own: `yaac
project create <name>`, or "New project" in the webapp's Add project dialog.
The server then hosts the project's git remote itself. Everything below the
remote, including the main clone, checkouts, `origin/*` refresh, the branch
picker, `yaac-mama` and image builds, works exactly as for a project cloned
from GitHub, because the main clone treats the hosted remote as just another
remote.

## The bare repository

A hosted project's remote is a bare repository at
`server-local/hosted-repos/<project id>.git` (`hostedRepoDir`). It sits in
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

`createHostedProject` creates the repository empty, on `main`
(`initHostedRepo`). A project's name must be unused, since it is a hosted
project's only handle (`yaac project clone`, the remove confirmation). It then clones it as the main clone over the `file`
transport, the same `cloneRepo` that `project add` runs against a URL. An
empty remote needs no special case anywhere: workspace create already
handles a repository with no branches (docs/server-git.md).

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
| `/api/workspace/git/<project id>.git/…` | a workspace | its own project only | its own project only |
| `/api/project/<project id>/git/…` | the user's own git, on the API origin | any user (docs/multi-user.md) | the owner |

These are boundaries under k8s only. A containerless workspace runs as the
server's user, so it can reach the user route on loopback as the owner, and
can write `server-local/` (the hooks and every bare repository) directly.
That is the containerless model (docs/multi-user.md), not something the
routes can change.

Neither listener caps a request's total time (`requestTimeout: 0`, and the
same on the egress proxy's HTTP listener), since a large push can upload
for longer than Node's five-minute default.

**A workspace's identity is its credential.** A hosted project has no git
credential row, and `resolveProjectCredential` answers `{ kind: 'hosted' }`
for it, so workspace create never asks for one. The egress allowlist is not
consulted either. Every checkout's `origin` is
`http://yaac.internal/api/workspace/git/<project id>.git` on both drivers,
which is the project row's `remoteUrl`:

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

The user's clone URL is `<server origin>/api/project/<project id>/git`.
`yaac project clone <project> [dir]` runs `git clone` against it, and
Project settings shows it. A browser cannot forge a push there: a
receive-pack request has a non-simple content type, which forces a CORS
preflight the server never approves.

**A push reaches every workspace at once.** When a push succeeds, the
server fetches the bare repository into the main clone
(`fetchProjectOrigin`). That fetch's fan-out refreshes `origin/*` in every
running workspace of the project, so a sibling sees a pushed branch within
seconds rather than at the next five-minute refresh.

## The hooks

The bare repository runs two hooks that yaac ships. The server writes them
to `server-local/run/hosted-git-hooks` and points `core.hooksPath` there on
the command line when it serves the repository. This is the one place the
server lets git run a hook. That is safe because the hooks are yaac's own
scripts, and under k8s the repository is one only the server writes.

**The default branch** is whatever the repository's `HEAD` names. A new
repository's `HEAD` is an unborn `main`. While `HEAD` names a branch that
does not exist, the `post-receive` hook points it at one that does:
`main`, else `master`, else the first by name. So a project first filled
by pushing `master` defaults to `master`. git waits for the hook before the
push completes, so a clone right after the push sees it. The server then
copies it into the main clone's `origin/HEAD` (`setOriginHead`), which a
clone of an empty remote could not learn, so creates fork from it.

**The `pre-receive` hook** refuses a branch named `HEAD`, which every clone
would find ambiguous. While a project's default-branch guard is on
(`projects.guardDefaultBranch`, on by default), it also refuses a push
that deletes the default branch, or moves it to a commit that does not
contain its old tip. Agents can still rewrite every other branch. The owner
turns the guard off and on in Project settings
(`PUT /api/project/<id>/default-branch-guard`). The hook runs after the
pack is received, so it can check ancestry against the pushed commits. A
pre-check in the handler could only see ref names.

## No pull requests

A hosted remote is plain git: it has no pull requests, reviews or web UI.
Agents land work by pushing to the default branch (with the guard on, a
fast-forward), and the user reviews it in the webapp's changes view or a
local clone. The built-in skills that drive `gh` (`push-pr`, `review-pr`,
`spawn-pr-reviewers`, `yaac-watch-prs`) check the `origin` URL first and say
they do not apply.

## Removing a hosted project

`project remove` deletes the bare repository with the rest of the project
(`purgeProjectBytes`). That is the only authoritative copy of the code, so
the webapp's confirmation says so, asks for the project's name rather than
its remote, and points at `yaac project clone`.

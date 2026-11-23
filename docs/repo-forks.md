# Forks and read-only repos

A repo whose credential can read it but not push to it, such as most
open-source repos, is one of two things to its user, and yaac makes each a
stated choice:

- **Something to read.** The repo is **read-only**: workspaces fetch it and
  never push.
- **Something to build on.** The repo is a **fork** with an **upstream**:
  workspaces push to `origin`, which the user controls, and the remote they
  cannot push to is where its history comes from.

A fork's `origin` is either hosted by yaac (a **local fork**) or a fork on
a git host, such as a GitHub fork (a **remote fork**). Both work the same
way. This builds on docs/project-repos.md and docs/hosted-projects.md.

## The model

**An upstream is a repo.** A repo may name another of its owner's repos as
its upstream (`repos.upstreamRepoId`). The upstream is an ordinary row: its
own remote, credential and host key, listed in Settings → Repos, linkable
into a project like any other. Nothing about a repo says "I am an
upstream"; another repo points at it. So:

- its credential is assigned, replaced and checked by the code that does so
  for any repo;
- several forks can name one upstream, and a fork can have a fork (a
  checkout wires in only its repo's direct upstream); a cycle is refused;
- an upstream need not be read-only, but through a fork it is only read;
- it must be its owner's (`canUseRepo`). A hosted fork shared with another
  user gives them the fork, not the upstream: their checkouts have no
  `upstream` remote.

**A repo is cloned when a project links it, not before.** A repo that is
only an upstream has no main clone: its history is fetched into its fork's
main clone as `upstream/*`. Linking one clones it first
(`ensureMainClone`), and Settings → Repos lists it under its fork rather
than among the repos nothing uses.

| Shape | `origin` | Upstream | How it comes about |
|---|---|---|---|
| plain | a git host | none | `yaac project add`, with push access |
| read-only | a git host | none | `--read-only`, or `yaac repo read-only` |
| hosted | yaac | none | `yaac project create` |
| local fork | yaac | a repo on a git host | `--fork`, or `yaac project move --hosted` |
| remote fork | a git host | a repo on a git host | `yaac repo upstream`, or `--upstream` at add |

The moves between shapes: read-only is a setting; **Move to yaac**
(`moveRepoToYaac`) turns a repo on a git host into a local fork; **Move to
a git host** (docs/hosted-projects.md) turns a local fork into a remote
one, keeping its upstream; **Move to upstream** (`moveRepoToUpstream`)
turns a fork into a plain repo on its upstream's remote; setting or
removing an upstream adds or drops one. A local fork with its upstream
removed is a hosted repo.

A repo another names as its upstream cannot be deleted until those forks
remove it or are deleted.

## Read-only repos

`repos.readOnly` says no workspace pushes to the repo, in any project.
`project_repos.readOnly` (k8s only) still marks one link read-only, which
is how one project reads a repo another writes; a link is read-only when
either says so.

- **Every checkout's `origin` gets a push URL that is not a repository**
  (`NO_PUSH_URL`, a path under `/dev/null`), so a push fails at once,
  naming it, on both drivers.
- **Under k8s the grant is read-only**, so the proxy refuses pushes, and
  the repo's token is never `GH_TOKEN`. A token belongs to a credential,
  though: where a read-only repo or an upstream shares its credential with
  a writable repo, that repo's `GH_TOKEN` can write it through the host's
  API. Under containerless nothing more is
  promised: the workspace holds the credential and can reset the push URL.
- **A public https remote needs no credential.** A read-only https repo
  without one is fetched anonymously by the server and by workspaces
  (`needsGitCredential`). It has no grant, since a grant belongs to a
  credential.
- **The server never pushes to it**: an empty read-only origin is not
  seeded with a first commit.
- **Push access is not probed.**

## Push access

`probePushAccess` is a dry-run push that deletes a branch that does not
exist: it asks the remote's push endpoint, which checks the credential, and
sends nothing. It answers `yes`, `no` (`isGitAuthError`) or unknown (any
other failure, such as the network, or a remote silent for 15 seconds),
which leaves `repos.pushAccess` as it was. A read-only refusal over ssh (a GitHub deploy key without write
access, GitLab's "not allowed to push") counts as `no`. It runs in an empty repository of the server's own, so it needs no
clone. `checkMoveTarget` ends with the same push.

**At add**, a new remote is probed before the clone. One the credential
cannot push to is refused with `PUSH_REFUSED`, naming `--fork` and
`--read-only`; the webapp offers the same two as buttons, which resubmit
the add. An unknown answer does not refuse. An add with no credential must
be `--fork` or `--read-only`, and reads the remote anonymously. Adding a
URL whose repo is only an upstream is refused, naming its fork, since the
fork already holds that history; `--fork` makes another fork instead.

**Afterwards** a plain repo is probed again when its credential is assigned
or replaced, once a day while a workspace has a checkout of it (the
`origin-refresh` step), and on demand (`POST /api/repo/<id>/push-access`,
at most once per repo every 10 seconds; callers share a probe under way).
`pushAccess: 'no'` on a repo that is not read-only is `pushRefused`, a
warning in Settings → Repos, Project settings and the create form, offering
Move to yaac, Make read-only, Assign another credential and Check again.
Nothing converts a repo on its own: a lost push right is as often an
expired token as a changed permission.

## Upstreams in server git

**A fork's main clone holds both remotes.** After each fetch of a fork's
origin lands, the server fetches its upstream with the upstream's
credential as `+refs/heads/*:refs/remotes/upstream/*`, pruned, with no
tags, under the same per-repo lock (`fetchRepoUpstream`), then runs the
fetch listeners again so the fan-out copies it. Nothing that waits for
origin waits for the upstream. A failed upstream fetch fails nothing: its
error is kept per upstream and shown on its row. Removing an upstream
deletes `upstream/*` from the main clone.

**Checkouts see it.** `createCheckout` writes a second remote, `upstream`,
whose push URL is `NO_PUSH_URL`, and copies `upstream/*` into
`packed-refs` beside `origin/*`. The origin fan-out copies
`refs/remotes/upstream/*` into checkouts that have that remote. A launch
that reuses a checkout sets `origin`'s URL to the row's, always, sets or
removes `origin`'s push URL and the `upstream` remote to match the rows
(`buildCloneLinkExec`), so a checkout follows its repo through every move.
`origin` is yaac's remote in a checkout; a user who wants another remote
adds one under another name.

**Bases stay on origin.** Workspaces are cut from `origin/<branch>` and
diffed against it.

## Catching up with the upstream

A fork never catches up on its own: its `main` carries its owner's
commits, so taking the upstream's means replaying them, which takes
judgment and can conflict. That is done in a workspace, and the built-in
`sync-upstream` skill carries the steps: rebase onto `upstream/main`,
resolve, push to `origin` with `--force-with-lease`. So
`upstream/main..main` is always exactly what the fork adds. The server has
no sync action that writes to `origin`.

**The push rewrites the default branch**, which the hosted guard refuses.
A hosted fork has a second setting under the guard, `guardAllowsCatchUp`
(on by default; "Allow rebasing onto the upstream", `yaac config
upstream-rebase`, `PUT /api/repo/<id>/upstream-rebase`). With it on, a
rewrite passes when its new tip contains the upstream's branch of the same
name as the server last fetched it, the old tip did not, and every commit
the old tip added since it forked from the upstream is still there with the
same patch (`git cherry` against the new tip): the shape of a catch-up and
of nothing else. The server hands the `pre-receive` hook that commit
(`YAAC_CATCH_UP_COMMIT`). A rebase whose conflict resolutions changed one
of the fork's commits is refused too, and so is every rewrite with the
setting off, naming it; `sync-upstream` then falls back to a merge. A remote
fork's host applies its own branch protection.

**Running workspaces see the rewritten branch.** The fan-out
fast-forwards a checkout's refs, and sets a ref outright where neither tip
contains the other: the branch was rewritten, not fetched ahead
(docs/server-git.md). This applies to every repo's force-pushes.

**Workspaces cut from the old `main` stay on the old commits**, which
their Changes pane counts as their own until they rebase onto the new
base; git drops the duplicates. The status bar says the base was rewritten
(`comparison.rewritten`, from `baseRewritten`: the base no longer contains
the workspace's start commit, and its merge base is older than the start),
and what to run.

## Seeing the difference

A workspace already compares any two refs (docs/file-editor.md "Ranges").
The compare picker lists the upstream's branches after origin's
(`getRepoBranches` answers `upstreamBranches`), each passed as its full ref
(`refs/remotes/upstream/<branch>`) so an origin branch named `upstream/x`
is not taken for it. A fork's Changes strip has "Compare with upstream",
which opens `refs/remotes/upstream/main...main`. A base on the upstream
reads its `fetchedAt` from the upstream branch's reflog.

## Moving a repo to yaac

`moveRepoToYaac` (`POST /api/repo/<id>/host`, `yaac project move <project>
--hosted`) moves a repo on a git host onto yaac, and the remote it leaves
stays as its upstream. The row keeps its id and its main clone, so nothing
that names the repo changes (links, checkouts, queued entries, routines,
drafts, sites) and a stopped k8s workspace's checkpoint chain stays valid
(docs/node-local-workspaces.md). A repo that still keeps the repository it
had before a move off yaac is refused until that copy is removed, since
the new one takes its place on disk.

It holds the repo and its projects (`withRepoHeld`, `withProjectsHeld`),
stops every workspace holding a checkout and reaps the spares warmed with
it (`GET /api/repo/<id>/host-preview` names them first), fetches origin
(a failed fetch refuses the move, so the hosted repository misses nothing),
fills the bare repository at `hostedRepoDir(id)` with every `origin/*`
branch and tag (`fillHostedRepo`), copies `origin/*` to `upstream/*`, and
switches the rows in one transaction (`hostRepoWithUpstream`): a new row
takes the old remote, credential, host key and push access, read-only
if the probe it runs first found its credential cannot push, and the moved
repo becomes hosted with it as its upstream. Then the runtime is handed the credentials again. A repo that
already had an upstream leaves a chain.

An add with `--fork` clones the remote, then does the same with no
workspaces to stop. Once made, a fork is a hosted repo and
docs/hosted-projects.md applies, sharing included; its history contains
the upstream's, which the share dialog says.

## Moving back to the upstream

`moveRepoToUpstream` (`POST /api/repo/<id>/move-upstream`, `yaac project
move <project> --upstream`) makes a fork's upstream its `origin` once the
upstream's credential can push there (probed first). It is refused while a
project links the upstream itself, since the two would be one remote under
two rows. The repo keeps its id and main clone and takes the upstream's
remote, credential and own upstream; every other fork of the upstream
names it instead, and the upstream's row goes (`adoptUpstreamRemote`),
with any main clone it had from an earlier link.

**Every branch is accounted for.** The preview (`GET
/api/repo/<id>/move-preview?target=upstream`) fetches both remotes and
compares them by name (`compareRemoteBranches`), with what depends on each
of the fork's branches:

| The fork's branch | Choice |
|---|---|
| the same as the upstream's, or behind it | none |
| only the upstream has it | none |
| only the fork has it, or ahead | push it (optionally as another name), or leave it behind |
| diverged | leave it behind, or catch up in a workspace first |

The move refuses until each branch that needs one has a choice; the CLI
takes `--push <branch>[=<name>]`, `--push-all` and `--leave-rest`. It then
stops every workspace holding a checkout, whoever owns it, fetches and
compares again, pushes the picked branches atomically and unforced
(`pushMainBranches`), switches the rows, ends a hosted fork's shares and
hands each other user a repo of their own, and drops `upstream/*`. What is
left behind stays where the fork was: yaac's kept repository for a local
fork (`keepsHostedRepo`), or the fork on its git host, whose URL the move
answers.

## Remote forks

A repo gets its upstream with `yaac repo upstream <repo> <upstream>
[credential]` (`--none` removes it), `--upstream` at add, or the picker in
Settings → Repos (`PUT`/`DELETE /api/repo/<id>/upstream`). `<upstream>` is
one of the owner's repos, or a URL, which finds their repo for it or
records one without a clone (`recordRemoteRepo`), read-only when it has no
credential or its credential cannot push. Setting one adds its host to the allowlist of the
owner's projects that link the fork.

For a `github.com` remote read with an https token, an add asks GitHub
whether it is a fork (`suggestUpstream`, the repo's `parent`) and answers
the parent's clone URL as `suggestedUpstream`, which clients offer for the
user to accept. With Tor on it does not ask, since the lookup would not go
through Tor as git does.

Pull requests stay in the fork: `gh` would act on a remote named
`upstream`, so the PR skills and `yaac-watch-prs` set `GH_REPO` to
`origin`'s repo.

## What a workspace can reach

The server does the fetching, so a workspace needs nothing new to see
`upstream/*`. For an agent's own `git fetch upstream`, a project gets a
read-only grant for the upstream of each repo it links, never offering a
`GH_TOKEN`, when the project's owner owns the upstream; under containerless
the upstream's credential joins the ones a launch writes, so there the
upstream is read-only only by convention: a workspace holds that credential
and can push to the upstream by its URL if the credential can
(docs/containerless-driver.md). An upstream with no credential is public
and needs no grant. Under k8s, a project that links the upstream itself has
that link's grant instead of the read-only one. A hosted upstream is readable
through the workspace git route by a project linking its fork.

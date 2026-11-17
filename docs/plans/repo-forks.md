# Forks and read-only repos

A plan, not shipped. It builds on docs/project-repos.md,
docs/hosted-projects.md, docs/server-git.md, docs/git-credentials.md and
docs/file-editor.md.

## What it is for

A repo added today has one remote, `origin`, and every workspace pushes to
it. A repo the credential can read but not push to (most open-source
repos) is added without complaint, and then every push from every
workspace fails. Nothing in yaac says why, and there is nowhere else for
the work to go: a k8s workspace gets a token only for the repos its
project links, so it cannot push to a fork on its own either.

Such a repo is one of two things to its user, and this plan makes each a
stated choice:

- **Something to read.** The repo is marked **read-only**: workspaces
  fetch it and never push.
- **Something to build on.** The repo becomes a **fork** with an
  **upstream**: workspaces push to `origin`, which the user controls, and
  the remote they cannot push to is where its history comes from.

A fork's `origin` is either hosted by yaac (a **local fork**) or a fork
on a git host, such as a GitHub fork (a **remote fork**). Both work the
same way.

## The model

**An upstream is a repo.** A repo may name another of its owner's repos as
its upstream (`repos.upstreamRepoId`). The upstream is an ordinary repo
row: its own remote, credential and host key, listed in Settings → Repos,
linkable into a project like any other. Nothing about a repo says "I am
an upstream"; another repo points at it.

**A repo is cloned when a project links it, not before.** A repo that is
only an upstream is a remote and nothing on disk: its history is fetched
into its fork's main clone, as `upstream/*`. So a fork costs what a
hosted repo costs today and a read-only repo what a plain one does.
Linking a repo that has no main clone yet clones it first, as an add
does.

So a fork is two repos. Adding an open-source project with `--fork` makes
the project's repo on its git host, read-only, and a second repo that
yaac hosts and that names the first as its upstream. Workspaces get
checkouts of the second.

| Shape | The repo's `origin` | Its upstream repo | How it comes about |
|---|---|---|---|
| plain | a git host | none | `yaac project add`, with push access (today) |
| read-only | a git host | none | `--read-only`, or marked later |
| hosted | yaac | none | `yaac project create` (today) |
| local fork | yaac | a repo on a git host | `--fork`, or moved to yaac later |
| remote fork | a git host | a repo on a git host | a fork's URL added, and its upstream named |

For the fork, `origin` stays what it is everywhere: the remote of its
row, its main clone's `origin/*`, the base of every workspace, the target
of every push. The upstream reaches a workspace as a second remote,
`upstream`, that can only be fetched.

What follows from an upstream being a repo:

- **Nothing about a remote is recorded twice.** Its credential is
  assigned, replaced and checked for usability by the code that does so
  for any repo.
- **Several forks can name one upstream.** Each fetches it into its own
  clone.
- **A fork can have a fork.** A team's fork on GitHub can be the upstream
  of a local fork, and have the open-source project as its own upstream.
  A checkout wires in only its repo's direct upstream. A cycle is refused.
- **An upstream need not be read-only.** Someone who can push to a repo
  can still fork it to keep agents off it. Through a fork it is only ever
  read, whatever its own setting.
- **It must be its owner's.** A repo names only an upstream its owner may
  use (`canUseRepo`). A hosted fork shared with another user gives that
  user the fork, not the upstream: their checkouts of it have no
  `upstream` remote.

The moves between shapes:

- plain → read-only and back: a setting.
- a repo on a git host → local fork: **Move to yaac** ("Moving a repo to
  yaac"): the repo moves, and the remote it leaves becomes its upstream.
- local fork → remote fork: **Move to a git host**, as it exists, to the
  user's own fork on the host. The upstream stays.
- a fork, local or remote → plain, on its upstream's remote: **Move to
  upstream** ("Moving back to the upstream"), once its owner can push
  there.
- any → with an upstream: **set upstream**; any → without: **remove
  upstream**. A local fork with its upstream removed is a hosted repo.

**A fork never catches up on its own.** Its `main` carries its owner's
commits, so taking upstream's means replaying them on top of it, which
takes judgment and can conflict. That is done in a workspace, like any
other change ("Catching up with the upstream"). The server has no sync
action, no button and no timer that writes to `origin`.

## Rows

`repos` gains:

```
readOnly            workspaces never push to it
upstreamRepoId      the repo it is a fork of; null for none
pushAccess          'yes' | 'no' | null (not yet known): whether its
                    credential can push
guardAllowsCatchUp  for a hosted repo with an upstream: the default
                    branch guard lets a rebase onto the upstream
                    through (default true)
```

One migration, no backfill: the defaults are today's behavior, and a null
`pushAccess` is filled by the first probe.

A repo that another names as its upstream cannot be deleted; the refusal
names the forks, and removing their upstream or deleting them comes
first. `RepoSummary` carries a repo's upstream and its forks, and
Settings → Repos shows an upstream that no project links under its fork
rather than among the repos nothing uses.

## Read-only repos

`repos.readOnly` says no workspace pushes to the repo, in any project. It
is set at add (`--read-only`), in Settings → Repos, or with `yaac repo
read-only <repo> on|off`. A project can still mark one link read-only
(`project_repos.readOnly`), which is how one project reads a repo another
writes; a link is read-only when either says so.

What it changes:

- **Every checkout's `origin` gets a push URL that is not a repository**
  (`remote.origin.pushurl`), so a push fails at once, naming it, on both
  drivers.
- **Under k8s the grant is `readOnly`**, so the proxy refuses pushes as it
  does for a read-only link, and the repo's token is never the
  `GH_TOKEN`.
- **Under containerless nothing more is promised.** A workspace there
  holds the credential and can set the push URL back. For the case this
  exists for, a credential that cannot push, the host refuses anyway.
- **It needs no credential on a public remote.** A read-only `https` repo
  with no credential is fetched anonymously, by the server and by
  workspaces, and counts as usable for a create. Under k8s it has no
  grant, since a grant belongs to a credential; the host refuses a push
  from nobody.
- **The server never pushes to it**: an empty read-only origin is not
  seeded with a first commit.
- **Push access is not probed, and no warning is shown.**

## Push access

**The probe.** `checkMoveTarget` already ends with the right test: a
dry-run push that deletes a branch that does not exist. It asks the
remote's push endpoint, which checks the credential, and sends nothing.
It moves out as `probePushAccess`, answering `yes`, `no` (the remote
refused the credential: `isGitAuthError`) or unknown (anything else, such
as the network), which leaves the stored answer as it was. It needs no
clone, only any repository to run in.

**At add.** The probe runs before the clone, so a refusal costs seconds.
An add of a remote the credential cannot push to is refused, and the
refusal names the two ways forward:

```
You can't push to github.com/acme/tool with "my-token".
  --fork       yaac hosts a fork of it that workspaces push to
  --read-only  workspaces only read it
```

The Add Project form shows the same refusal with the two choices as
buttons, which resubmit the add. An unknown answer does not refuse.

`yaac project add <url> [credential]`: the credential becomes optional. An
add with none must pass `--fork` or `--read-only`, since nobody can push
anonymously, and reads the remote anonymously. `--fork` and `--read-only`
are also accepted with push access, by someone who wants agents kept off
the real remote. `yaac project repo add` takes the same flags.

`--fork` makes a local fork of the remote and links it ("Moving a repo to
yaac"). Adding a URL its owner already has finds that repo, as today;
when it is the upstream of a fork, the add says so and offers to link the
fork instead, since linking the upstream itself clones it a second time.

**Afterwards.** A plain repo is probed again when its credential is
assigned or replaced, once a day while a workspace with a checkout of it
runs (in the `origin-refresh` step), and on demand. `pushAccess: 'no'` on
a repo that is not read-only is a warning on `RepoSummary`, shown where
the repo is: its row in Settings → Repos, Project settings, and the create
form of a project that links it. It reads "Pushes to acme/tool are
refused" and offers:

- **Move to yaac**
- **Make read-only**
- **Assign another credential**
- **Check again**

Nothing converts a repo on its own. A lost push right is as often an
expired token as a changed permission, and only its owner knows which.

## Upstreams in server git

**A fork's main clone holds both remotes.** After each fetch of a fork's
origin lands, the server fetches its upstream's URL, with the upstream's
credential, as `+refs/heads/*:refs/remotes/upstream/*` (pruned), under
the same per-repo fetch lock. That follows the 5-minute `origin-refresh`
step, the branch picker's refresh and a start's fetch. It is not part of
the promise `fetchRepoOrigin` answers, so nothing that waits for origin
waits for the upstream too: neither a start's catch-up nor the starts
that still wait for their fetch (a restart, a non-interactive run, a
site's release, a create at a commit; docs/server-git.md "Starting a
workspace"). One clone, so objects the two remotes share are stored
once, and a checkout's one alternates line and a pod's one mount cover
both. An upstream that fails to fetch does not fail anything; the error
is kept per repo and shown on its row in Settings → Repos.

**Checkouts see it.** `createCheckout` writes a second remote, whose push
URL is not a repository, and copies `upstream/*` into `packed-refs`
beside `origin/*`:

```
[remote "upstream"]
    url = <the upstream repo's remoteUrl>
    fetch = +refs/heads/*:refs/remotes/upstream/*
    pushurl = <not a repository>
```

The origin fan-out (`buildOriginRefreshExec`) copies
`refs/remotes/upstream/*` too, after the upstream's fetch, so every
running workspace's `upstream/*` is within minutes of the upstream with
no network use of its own. A
launch that reuses a checkout sets or removes the remote, and `origin`'s
push URL, to match the rows (`buildCloneLinkExec`).

**A checkout follows its repo.** Each move below changes a repo's remote
while its workspaces are stopped, and their checkouts still name the old
one, possibly from several moves ago. A launch that reuses a checkout
sets its `origin` URL to the repo's, always, as `createCheckout` does.
`origin` is yaac's remote in a checkout: the fan-out writes the main
clone's refs into `refs/remotes/origin/*` whatever URL it names, so an
`origin` pointed elsewhere is already a mix of two remotes. A user who
wants another remote adds one under another name, which nothing touches.
This replaces the rule in `buildCloneLinkExec` that rewrites only an
`origin` naming yaac's hosted prefix, so no move needs to record
anything, and that rule's special case goes.

Removing a fork's upstream deletes `upstream/*` from its main clone. The
objects stay, as everything a main clone ever held does.

**Bases stay on origin.** Workspaces are cut from `origin/<branch>` and
diffed against it, so creates, spares, the base-branch code and
`yaac-mama set-base` are unchanged.

## Catching up with the upstream

Everything here happens in a workspace, with the refs above already in
place. A fork's `main` is the upstream's history with the owner's commits
on top, and catching up keeps it that way by **rebasing**: the owner's
commits are replayed onto the upstream's new tip. So `upstream/main..main`
is always exactly what the fork adds, as a straight list of commits with
no merges among them.

- **Bringing the fork up to date** is a workspace on `main` whose agent
  rebases onto `upstream/main`, resolves what conflicts, and pushes to
  `origin`'s `main` with `--force-with-lease`.
- **A feature branch** rebases onto `upstream/main` or `origin/main`
  whenever the work calls for it.
- **A branch only the upstream has** is brought into the fork by pushing
  it: `git push origin upstream/release-2:refs/heads/release-2`.

A built-in skill, `sync-upstream`, carries these steps, so "sync with
upstream" is a prompt anyone can give. It stops and says so where the
repo has no upstream.

A rebase gives every one of the fork's commits a new id, which has two
consequences.

**The push is a rewrite of the default branch**, which the hosted guard
refuses. A repo with an upstream has a second setting beside the guard,
`guardAllowsCatchUp`, on by default: "Allow rebasing onto the upstream"
under the guard in Project settings, `yaac config upstream-rebase
<project> on|off`, `PUT /api/repo/<id>/upstream-rebase`. It means nothing
on a repo without an upstream or with the guard off.

With it on, a push that rewrites the default branch passes when its new
tip contains the upstream's branch of the same name as the server last
fetched it and the old tip did not. That is the shape of a catch-up and
of nothing else: a rewrite of a fork that is already current is still
refused, and so is one that does not land on the upstream. The server
hands the hook that commit as it hands it the guard setting. The guard
cannot tell whether every one of the owner's commits survived the
rebase; the bare repository's reflog keeps the old tip, as it does for
any push.

With it off, the guard refuses every rewrite as it does today, and the
refusal names the setting. Catching up is then a merge, whose push is a
fast-forward, and `sync-upstream` falls back to one when its forced push
is refused. A remote fork's own host applies whatever branch protection
its owner set there.

**Running workspaces must see the rewritten `main`.** The origin fan-out
only fast-forwards a checkout's `origin/*`, so that a ref an agent's own
fetch moved ahead of the main clone is kept. A rewritten branch is no
fast-forward, so today a running workspace's `origin/main` would stay on
the old tip until its agent fetched. The fan-out therefore sets a branch
outright, as a start's catch-up already does (docs/server-git.md
"Starting a workspace"), where the checkout's copy is not an ancestor of
the main clone's and the main clone's is not an ancestor of the
checkout's: the branch was rewritten, not fetched ahead. This applies to
every repo's force-pushes, not only forks', and to `upstream/*` as well
as `origin/*`.

A workspace started after the catch-up needs nothing: its start's
catch-up moves an untouched checkout to the new tip, and a touched one
is left like any other running workspace.

**Workspaces cut from the old `main` are left on the old commits.** Until
such a workspace rebases onto the new `origin/main`, its Changes pane
counts the fork's old commits as its own, because they are no longer on
its base. git drops them during that rebase, since the same patches are
already on the new base, so it is one command with rarely a conflict. The
skill ends by naming the running workspaces of the repo, and the status
bar of a workspace in this state says its base was rewritten and what to
run.

## Seeing the difference

There is no fork view. A workspace already compares any two refs
(docs/file-editor.md "Ranges", "Commits", "Git status bar"), and a ref
that is not a branch on origin resolves as itself, so with `upstream/*`
in the checkout these work with no change to the reads:

| To see | Open |
|---|---|
| what the fork adds to the upstream, as a diff | Changes, `upstream/main...main` |
| what the upstream has that the fork lacks | Changes, `main...upstream/main` |
| the two histories side by side, and how far apart | Commits and the status bar, compared against `upstream/main` |
| this workspace's work against the upstream | Changes, base `upstream/main` |

What is added is the way in:

- **The compare picker lists the upstream's branches** under their own
  heading, after origin's (`getRepoBranches` answers them). It passes
  each as its full ref, so an origin branch that happens to be named
  `upstream/main` cannot be mistaken for it.
- **A fork's workspace has "Compare with upstream"** in the Changes
  strip, which opens the first row of the table for the default branch.

The status bar's `behind` against an upstream branch is as fresh as the
server's last fetch, like `origin/*`. Its `fetchedAt` reads the upstream
branch's reflog and the same server record.

## Moving a repo to yaac

The counterpart of "Move to a git host" (docs/hosted-projects.md), and
named for what happens to the repo: it moves onto yaac, and the remote it
leaves stays behind as its upstream. `moveRepoToYaac`
(`POST /api/repo/<id>/host`, `yaac project move <project> --hosted`,
"Move to yaac" beside "Move to a git host" in Project settings, in
Settings → Repos and on the warning). The row keeps its id and its main
clone and becomes the hosted repo, and a new row takes over its remote as
the upstream. So nothing that names the repo has to change: project
links, checkouts, queued entries, routines, drafts and sites all follow
it, and every checkout's alternates line stays valid. Keeping the main
clone also keeps a stopped k8s workspace restorable: its checkpoint
chain leans on the main clone's objects (docs/node-local-workspaces.md),
so a move that gave the repo a new clone would have to carry them over. It reuses the
move's holds and stops (`withRepoHeld`, `withProjectsHeld`).

**Which repos can move.** One on a git host, by its owner: plain or
read-only, with or without an upstream. A repo yaac already hosts has
nowhere to move; it gets an upstream by having one set. One that still
keeps the repository it had on yaac before a move to a git host
(`keepsHostedRepo`) is refused until that copy is removed, since the new
bare repository takes its place on disk. A repo that already had an
upstream leaves a chain: the new row keeps that upstream, so the hosted
repo's upstream is the fork on the git host, whose upstream is the
original. `yaac repo upstream` shortens it for someone who would rather
follow the original directly.

**It stops workspaces, and says so first.** Every workspace holding a
checkout of the repo stops, since its remote and credentials change, and
a containerless workspace only learns how to reach a hosted remote at
launch. A repo on a git host is private to its owner and cannot be
shared, so these are all the owner's own, though they may be in several
of their projects. `GET /api/repo/<id>/host-preview` answers the
workspaces that would stop, by project. The webapp lists them above the
confirm button, and the CLI lists them and asks to continue, on a
terminal only (`--yes` skips it).

Then:

1. **Stop** those workspaces, keeping their checkouts, and reap the
   spares warmed with the repo.
2. **Create the bare repository** at `hostedRepoDir(id)` and push every
   `origin/*` branch and every tag into it from the main clone, default
   branch first. This is local, so it takes seconds.
3. **Copy the refs**: `origin/*` becomes `upstream/*` in the main clone
   as well.
4. **Switch the rows**, in one transaction. A new repo takes the old
   `remoteUrl`, credential, host key and `pushAccess`, read-only when it
   cannot be pushed to. The moved repo takes the hosted URL, `hosted`
   true, no credential, `readOnly` false, and the new repo as its
   upstream.
5. **Hand the credential set to the runtime again**, since the grants
   changed.

A restarted workspace's launch points `origin` at the hosted remote and
adds `upstream`, so commits an agent could never push go to the fork on
its next push. The fork's default-branch guard is on, as for any hosted
repo, and so is `guardAllowsCatchUp` ("Catching up with the upstream").

An add with `--fork` clones the remote as any add does, then runs steps 2
to 4: there are no workspaces to stop.

Once made, the fork is a hosted repo and everything in
docs/hosted-projects.md applies, sharing included. Its history contains
the upstream's, so sharing a fork of a private upstream shows the other
user that code, which the share dialog says.

## Moving back to the upstream

A fork's owner who gains push access to the upstream can make the
upstream `origin`: `yaac project move <project> --upstream`, "Move
to upstream" beside the other two moves. The repo keeps its id and its
main clone (and so every checkpoint chain that leans on it) and takes
the upstream's remote, and the upstream's row goes away. It is the existing move (`moveRepoToRemote`) with a different rule
for what is pushed: that move wants an empty target and pushes
everything, while this one has a target with a history of its own and
pushes what the owner picks.

**Which repos.** Any repo with an upstream, wherever its `origin` is,
whose upstream's credential can push (probed first; a refusal says to
assign one that can). It is refused while a project links the upstream
directly, since the two would then be one remote under two rows;
unlinking it comes first.

**Every branch is accounted for.** The server fetches both remotes, so
the main clone's `origin/*` and `upstream/*` are current, and compares
them by name:

| The fork's branch, against the upstream's | What the owner chooses |
|---|---|
| the same commit, or behind it | nothing: it becomes the upstream's |
| only the upstream has it | nothing |
| only the fork has it | push it, or leave it behind |
| ahead (the upstream's, with commits on top) | push it, or leave it behind |
| diverged | leave it behind, or catch up in a workspace first, which makes it ahead |

A branch that is pushed can be pushed under another name, for a `main`
whose commits belong on a branch of the upstream rather than on its
`main`. Nothing is forced, so a push can only add a branch or
fast-forward one. The move does not start until every branch in the last
three rows has a choice.

**Leaving a branch behind deletes nothing.** It stays where the fork
was. For a local fork that is the hosted repository, kept read-only
until its owner removes it (`keepsHostedRepo`), as after any move off
yaac. For a remote fork it is the fork on its git host, which the move
does not touch; the move's answer names its URL, since no row does
afterwards. Tags are not pushed; they stay there too.

**The preview** (`GET /api/repo/<id>/move-preview`, with the upstream as
its target) answers that table, and for each branch that needs a choice
what depends on it: running and stopped workspaces based on it, queued
entries and routines that name it. It also answers what the existing
preview does: the workspaces that would stop, and whom the repo is
shared with. The webapp shows the table with a choice per row and "push
all" and "leave all" above it. The CLI takes `--push <branch>[=<name>]`
(repeatable), `--push-all` and `--leave-rest`, and refuses, printing the
table, while a branch has no choice.

Then, holding the repo and its projects as the existing move does:

1. **Stop every workspace** holding a checkout of the repo, whoever owns
   it, and reap its spares.
2. **Fetch and compare again.** If a picked push is no longer possible
   because the upstream moved, the move fails here with everything still
   on yaac.
3. **Push** the picked branches from the main clone to the upstream, with
   the upstream's credential.
4. **Switch the rows**, in one transaction. The repo takes the
   upstream's remote, credential and host key, is not hosted, and takes
   the upstream's own upstream, if it had one. Every other repo
   that named the upstream names this repo instead, since it is that
   remote now. The upstream's row is deleted, and a hosted repo's shares
   end.
5. **Hand each other user of a hosted repo their own**, fetch from the
   new origin, drop `upstream/*`, and hand the runtime the credential
   set, as the existing move's last steps do.

A restarted workspace's launch points `origin` at the upstream's remote
and removes the `upstream` remote, so its own unpushed commits go there
on its next push. A workspace based on a branch that was left behind
keeps the copy of it in its checkout, and is given another base with
`yaac-mama set-base`.

## Remote forks

A repo whose `origin` is a fork on a git host gets its upstream by being
told: `yaac repo upstream <repo> <upstream>` (and `--none`), `--upstream`
on `yaac project add`, and a picker in Settings → Repos. `<upstream>` is
one of the owner's repos, or a URL with an optional credential, which
finds the owner's repo for that URL or records it, read-only unless it
can be pushed to, without cloning it. The upstream can be on any host.

For a `github.com` origin with an https token, the add also asks the API
whether the repo is a fork (`GET /repos/<owner>/<repo>`, its `parent`),
and offers the answer as the upstream. It is a suggestion the user
accepts, not something the server applies.

Everything else is shared with local forks: the upstream's fetch,
`upstream/*` in checkouts, the compare picker, the skill.

**Pull requests stay in the fork.** Workspaces are cut from the fork's
branches, which carry its owner's commits, so a pull request is opened
against the fork (`origin`), as today. Sending work back to the upstream
is outside this plan. One thing changes: `gh` picks a remote named
`upstream` over `origin` as the repo to act on, so `push-pr`, `review-pr`,
`yaac-watch-prs` and `spawn-pr-reviewers` name `origin`'s repo explicitly
(`--repo`). With a hosted origin they keep saying they do not apply.

## What a workspace can reach

The server does the fetching, so a workspace needs nothing new to see
`upstream/*`. An agent will still type `git fetch upstream`, and it works
because the upstream is a repo with a credential of its own: a project
gets a grant for the upstream of each repo it links, always `readOnly`
and never offering a `GH_TOKEN`, beside the grants for the repos
themselves. The proxy needs no change, since a read-only grant is what it
already enforces. Under containerless the upstream's credential joins the
others the launch writes. An upstream with no credential is public and
needs no grant. Setting an upstream adds its host to the allowlist of the
projects that link the fork, as linking a repo does.

## Phases

1. **Read-only repos and the probe.** `repos.readOnly`, `pushAccess`,
   `probePushAccess`, the refusal at add, `--read-only`, the add with no
   credential, the warning. This alone ends the silent failure.
2. **Upstreams.** `upstreamRepoId`, cloning at link, the upstream fetch
   into the fork's clone, the remote and refs in checkouts and the
   fan-out (which sets a rewritten branch outright), the read-only grant, `yaac repo upstream`, upstream branches
   in the compare picker, `sync-upstream`, the PR skills naming `origin`.
   Useful alone for remote forks.
3. **Local forks.** `moveRepoToYaac` and its preview, `--fork`, "Move to
   yaac" on the warning, `guardAllowsCatchUp`.
4. **Moving back to the upstream.**
5. **GitHub's parent as a suggestion** for a remote fork's upstream.

Each phase updates the reference docs it changes (project-repos,
hosted-projects, server-git, git-credentials, workspace-egress,
file-editor, node-local-workspaces, cli), adds rows to `test/api/route-matrix.ts` for its
routes, and an e2e case per new CLI argument. The mock remote in the e2e
tiers needs a mode that serves reads and refuses pushes, for the probe.

## Decided against

- **Merging the upstream into a fork's `main`.** A merge needs neither
  the guard's extra case nor a rebase in the workspaces in flight, but
  the fork's commits end up interleaved with merge commits. Rebase is the
  rule, and it lives in the `sync-upstream` skill: the server never
  rebases anything.
- **The upstream's token as a local fork's `GH_TOKEN`.** A token reaches
  whatever it can at the host, and the fork's workspaces are meant only
  to read the upstream.
- **Pull requests to the upstream**, and workspaces cut from its
  branches.

# Sites and workflows in workspaces of several repos

## Context

A project links zero or more repos and a workspace starts with any number
of them (docs/project-repos.md). Four things have not caught up:

- A workspace's **steps** are one flat set keyed by name, whichever graph
  they came from. Two graphs cannot run side by side if both have a step
  called `install`, which is what one init graph per repo would do.
- A **workflow** says nothing of the repo its steps are written for. They
  start in the workspace's cwd, so the same graph works or fails by the
  layout and cwd each launch happens to pick. A project's init steps are
  the common case: written for one repo's root, and run in every
  workspace whichever repos it starts with. A project also has only one
  set of them, where a project of several repos wants one per repo.
- A **workflow with run secrets** is approved per commit or per branch of
  one repo, and `workflowLaunch` refuses a launch with no repo or several
  (`RUN_SECRETS_NEED_ONE_REPO`).
- A **public site** records the repo it is built from (`sites.repoId`), the
  branch it follows, and one commit each for the live release, the deploy
  in progress, the last deploy and the last failed one.

This plan lets a workflow name the repos it runs in, and lets run secrets
and sites work in a workspace of any number of repos by naming one commit
per repo. It changes no rule about who may publish a site or who may name
secrets.

## The design in one paragraph

Every step belongs to a workflow that has a name in its workspace, and
is known as `<workflow>.<step>`. A workflow names the repos its steps
need. Its steps start in that repo's
root when it names one and in the workspace root when it names several,
and it does not run in a workspace that lacks one. A project marks any
number of its named workflows as init workflows, and a workspace starts
those whose repos it has. Wherever one commit is
named today, a map of repo id to full commit is named instead
(`RepoCommits`). A workflow's approvals stay per repo and are checked per
repo: a launch gets the secrets when every repo it starts with passes on
its own. A site names its repos, each at a branch or a commit, plus one
`follow` flag, and its four commit columns become four `RepoCommits`
columns.

## Data model

```ts
/** Full commit by repo id: what a release or a secret-bearing run is at. */
type RepoCommits = Record<string, string>
```

**`workspace_steps`** keeps its `workflowId` and `workflowName` columns,
which become always set, and is keyed by workspace, `workflowName` and
name (see "Steps belong to a workflow"):

- `workflowName`: the name the workflow has in this workspace.
- `workflowId`: the stored workflow the step came from, which says where
  it starts through that workflow's repos.

Today both are set only on a step added from a named workflow.
`workspaces.workflowName` is always set for a workspace that brought its
own graph.

**`workflows`** gains `repos uuid[]`, the repos its steps need, empty by
default (see "Workflows name their repos").

**`named_workflows`** gains `init boolean`, and **`projects`** drops
`initWorkflowId` and `initNamedWorkflowId` (see "Init workflows").

**Approvals do not change.** `workflow_approvals.ref` is already a bare
commit or `<repo id>:refs/heads/<branch>`. A commit id names its content
whichever repo holds it, so a bare commit needs no repo beside it.

**`workflow_runs` is dropped.** It repeats what workspaces already
record, and the launch check reads them instead (see "Workflows with run
secrets").

**`sites`** drops `repoId`, `followBranch`, `releaseCommit`,
`deployCommit`, `lastDeployCommit` and `failedCommit`, and gains:

| Column | Holds |
|---|---|
| `repos` jsonb `RepoStart[]` | the repos its releases start with, by id, each at a branch or at a full commit |
| `follow` boolean | deploy whenever a branch in `repos` moves |
| `releaseCommits`, `deployCommits`, `lastDeployCommits`, `failedCommits` jsonb `RepoCommits` | what the single-commit columns hold today, per repo; null as today |

Why jsonb on the row rather than child tables:

- A deploy is a state on the site's row, started by one compare-and-set
  (`beginSiteDeploy`) and advanced by single-row patches. Per-repo child
  rows would turn each of those into a transaction.
- The four maps are records of what a release ran. They must survive an
  edit that takes a repo off the site, which rows keyed by the site's
  current repos would not.
- `repos` is stored as `routines` and `queued_workspaces` store theirs,
  so `repointProjectRepos`, which rewrites repo ids in stored JSON by
  text, covers a site the same way.

A hash that names a whole set of commits was considered, to keep single
text columns. It needs a lookup table to show anything, and reads as
nothing in the CLI, so the maps are stored as they are.

### Migration

One Drizzle migration, data moved in its SQL, so a deploy in progress
across the upgrade resumes:

- `repos = [{ repo: repoId, branch: followBranch }]` and
  `follow = followBranch is not null`.
- Each commit column becomes `{ [repoId]: commit }`, or null.

A site that follows nothing deploys its repo's default branch today, and
names no branch for SQL to copy: the default is known only to the main
clone. The migration leaves such a repo with no branch, and a one-shot
backfill at server start writes the main clone's default branch into it.
After that the site deploys the same branch it did before, by name. No
new site can name a repo without a branch or commit, so the backfill is
legacy compat and gets an entry in docs/legacy-compat-shims.md.

## Steps belong to a workflow

Today a step is known by its bare name: the row's key, the tmux window,
the log file, the webapp's pane, and what `needs`, `step rerun` and
`yaac-mama logs` take. A workspace's steps from every source share that
one set of names.

**Every step belongs to a workflow, and every workflow in a workspace
has a name there.**

- A named workflow goes by its name.
- An anonymous one (a create's `--steps`, a `step add --run` or
  `--steps`) is stored as a workflow like any other and given a short
  random name when it is given, such as `k3f9`, unique among the
  workspace's workflows and the project's workflow names. A create's is
  kept for every life of the workspace and copied by a rerun, so logs
  line up.
- The name belongs to the step rows, not to the stored workflow, which
  is one row per content: running `pnpm test` ten times is one workflow
  and ten names. A step added with `--run` and no `--name` is called
  `run`, so those ten share their content; today each gets a random step
  name instead.
- A step's full name is `<workflow>.<step>`: `web-init.install`. That is
  its window's name, its pane in the webapp, what every command takes,
  and what its log and events files are named by
  (`web-init.install.log`). One spelling is used everywhere.

So two workflows of one life may both have an `install`, and the
workspace bar groups steps under their workflow.

**`needs`.**

- A bare name is a step of the same workflow, checked when the graph is
  parsed, as today.
- `<workflow>.<step>` is a step of another workflow of the same life. It
  is checked when its step is placed in a life, since a stored workflow
  cannot know what will run beside it. A launch or `step add` that names
  the workflow is refused if the need names nothing there. An init
  workflow's step is `skipped` instead, as a step whose need was skipped
  is today: which init workflows start depends on the workspace's repos
  (see "Init workflows").
- A cycle through several workflows is found when they are placed
  together, and treated the same way.
- `volume` stays the one need that names no step (a site's release).

**Commands that address a step of a running workspace** (`step rerun`,
`step cancel`, `logs`, `yaac-mama logs`, and `--needs` on `step add
--run`) take the full name, and accept a bare name while only one
workflow of the life has that step. So `yaac-mama create --workspace …
--run 'pnpm test' --needs build` keeps working in a workspace with one
`build`, and the need is stored in full. Graphs get no such lookup, so a
typo in a stored `needs` is still caught when the graph is saved.

**Across workspaces.** A third segment, `<workspace>.<workflow>.<step>`,
fits the syntax, and is left out:

- A stored workflow cannot name a workspace, whose id is minted at each
  create, so only a step added by hand could use it.
- Workspaces are sealed from each other, so a service being ready in one
  gives a step in another nothing to connect to.
- A need would have to say what it means once the other workspace
  restarts, which starts its steps afresh, or is deleted.
- Ordering whole workspaces is what the queue does, and an agent that
  wants to act on a sibling's step can already read its state and log
  through `yaac-mama`.

**Upgrade.** A workspace running across the upgrade has windows and log
files under bare names, and a site's release runs for months. Its rows
keep an empty workflow name, which means "known by the bare name", and
whatever workflow id they had, and
every life started afterwards names its workflows. That reading of an
empty name is legacy compat and gets an entry in
docs/legacy-compat-shims.md: it can go once no step row has one.

**Names.** A workflow's name and a step's name follow one rule, the one
steps have today: letters, digits, `-` and `_`, starting with a letter or
digit, at most 48 long. So neither can hold the `.` that joins them, and
a full name splits one way. The migration rewrites `.` to `-` in existing
workflow names, which may hold one today, on the named workflow and where
a workspace recorded it, cuts one over 48, and adds a number where that
makes two of a project's names the same.

**tmux addresses a step's window by id, never by name.** tmux reads `.`
in a target as the pane separator: on tmux 3.6, `-t =yaac:=web-init.install`
resolves to a window named `web-init` if there is one, with no error, and
fails otherwise. So nothing may build a target from a step's name:

- A step's script sets `remain-on-exit` on its own pane (`$TMUX_PANE`) as
  its first act, in place of the server setting it by name after opening
  the window.
- Killing a step's window (a cancel, a rerun's dead window) finds its id
  by name in the window listing first.
- `windowTarget` refuses a name that holds a `.`, so a later caller
  cannot reintroduce the mistake quietly.

Reading goes the other way and is unaffected: the watcher's listing
carries each window's name and id, and the webapp attaches by id.

A step's window always holds a `.`, which no session's, shell's or
keeper's does. So the names a step may not take today (an agent tool's,
`yaac`, `shell`) are allowed again, and the log hook and `isAgentWindow`
tell a step's window by the `.` before they look for a tool's name, so a
workflow called `claude-review` is still logged.

## Workflows name their repos

A workflow's content is its steps, its secrets and now its **repos**: the
repos of the project its steps are written for, by id. None is the
default and means what a workflow means today.

**Where its steps start.**

| The workflow names | Its steps start in |
|---|---|
| one repo | that repo's checkout, at the workspace root or in its folder |
| several | the workspace root, which holds each in its folder |
| none | the workspace's cwd, as today |

So a graph written for one repo's root runs there whether the workspace
holds that repo alone at its root, alone in a folder, or beside others,
and whatever cwd its agent was given. A step's directory is read off
its row's workflow and the workspace's checkouts when its window opens.
Neither changes while the workspace lives, so a step rerun starts where
the step did, and the row needs no directory of its own.

**Where it does not run.** A workflow runs only in a workspace that has
a checkout of every repo it names.

- A launch that names the workflow is refused, with the repo it lacks: a
  create's or queued entry's `--workflow`, a routine, a site, a rerun, and
  `step add --workflow` on a running workspace. A routine, a site and a
  queued entry are refused when they are saved too, since what they start
  with is known then.
- A project's **init workflows** are not named by the create, so one
  whose repo the workspace lacks is skipped, and the create says so (see
  "Init workflows").

**Part of the content.** `repos` enters `workflowHash`, only when there
are any, so every stored hash stays valid and the migration only adds the
column. Being content, it is covered by the rules on steps: an edit makes
a new workflow, and an agent may not edit a named workflow that names
secrets, so it cannot move a secret-bearing graph into another repo's
root. `repointProjectRepos` rewrites the ids and the hash with them.

**Where it is set.** `yaac workflow create|edit --repo <dir>`,
repeatable, and a repos field on each workflow in the webapp.

Steps added to a running workspace take it too, since they are stored as
a workflow: `yaac workspace step add … --run 'pnpm test' --repo web`, and
`yaac-mama create --workspace … --run … --repo web`, run in `web`'s
checkout and are refused if the workspace has none. A graph a create
gives inline (`--steps`) names none: `--repo` there already says which
repos the workspace starts with, and that create picks its own cwd.

**Unlinking.** Unlinking a repo that a named workflow names is refused,
as it is for a site's repo, since every later launch would be refused or,
for an init workflow, silently skipped.

## Init workflows

A project's init steps are today one graph, or one named workflow it
follows. They become a property of named workflows: **a named workflow
marked `init` is started by every workspace that brings no graph of its
own and has the workflow's repos**, at each of its lives. A project may
mark any number.

- A project of `web` and `api` marks `web-init` (repos: web) and
  `api-init` (repos: api). A workspace of both runs both, each in its own
  repo's root. A workspace of `api` alone runs only `api-init`, and its
  create's progress says `web-init` was skipped for lack of `web`.
- An init workflow that names no repo runs in every workspace, as init
  steps do today.
- The workflows of one life are independent graphs started together, so
  no order is kept between them. Each step row records the workflow it
  came from, as a step added from a named workflow does.

Why a flag on the named workflow and not a list on the project: it needs
no positions and no way to address an unnamed entry, the repos field and
the graph editor are the workflow's own, and "which workflows start with
a workspace" reads off one column. There is no unnamed init graph any
more (`initWorkflowId`): init steps are always a named workflow, made and
edited like any other.

Two init workflows may use the same step names, since each step is known
by its workflow (see "Steps belong to a workflow"), and one may need a
step of another: `api-init`'s `migrate` needing `db-init.postgres` is
skipped in a workspace where `db-init` did not start.

**Setting them.** Init steps are no longer a setting with its own graph,
so `yaac config init-steps` and `PUT /project/:id/init-steps` go, with
their `--file`, `--workflow` and `--none`. In their place:

- `yaac workflow create <project> <name> --file <f> [--repo <dir>]…
  --init` makes an init workflow in one step, and `workflow edit --init`
  / `--no-init` marks or unmarks one.
- `yaac config init-workflows <project>` prints the project's init
  workflows, each with its repos and steps. Given names
  (`init-workflows <project> web-init api-init`) it makes exactly those
  the project's init workflows, and `--none` unmarks them all, as
  `config scratch-dirs` and its neighbours take a whole list. It is one
  request (`PUT /project/:id/init-workflows`).

What applies init steps from a file changes with it: this repo's
`.yaac/init-steps.json` is applied with `yaac workflow create … --file
.yaac/init-steps.json --init` (CLAUDE.md and the run-yaac skill say how),
and the yaac-autoconfig skill prints that command. The legacy
`yaac-config.json` import, which stores a project's old init commands,
writes them as a marked workflow named `init`, and its entry in
docs/legacy-compat-shims.md is updated.

**Migration**, in SQL: a project's `initNamedWorkflowId` marks that named
workflow; an `initWorkflowId` becomes a named workflow `init` pointing at
it (`init-steps` where the project already has an `init`), marked. Both
columns are dropped, and no code reads the old shape afterwards.

**Deleting** an init workflow is allowed, where today a workflow the
project's init steps follow cannot be deleted: nothing points at it any
more, and deleting it is how its steps stop running.

**Spares** are warmed with the init workflows that apply to the
remembered selection, which is the set a claiming create would run, since
a claim needs the same selection.

## Workflows with run secrets

### What is approved

An approval stays what it is: one commit, or one branch of one repo, for
a named workflow. **A launch gets the secrets when every repo it starts
with is at a commit that passes**, where a commit passes if

1. it is approved for a named workflow that points at the workflow now, or
2. a workspace that ran the workflow with its secrets started that repo
   there, or
3. it is now the tip of a branch of its repo approved for such a named
   workflow.

Why per repo and not per combination of commits:

- An approval says "this code may see these secrets". In a passing launch
  every checkout holds code a person approved for this workflow. An agent
  choosing which approved commits sit together is the same kind of choice
  it already has in rerunning any older approved commit.
- A branch is approved per repo by nature, since each tip moves on its
  own. A combination rule would need approvals that mix branches and
  commits across repos, and a matcher for them.
- `workflow show` lists what it lists today.

What it gives up: two commits that no person ran together can run with
the secrets, such as a newer deploy script beside an older app.

Every repo of the workspace is checked, not only those the workflow
names, since a step can reach any checkout beside its own.

**Rule 2 is read from workspaces.** A workspace that ran a workflow with
its secrets is a non-interactive one or a site's release whose
`workflowId` is that workflow, and each of its checkouts records the
commit it started at (`workspace_repos.startCommit`). Such a workspace
exists only because its launch passed this check, so it is the record,
and the separate `(workflow, commit)` table, with the write that fills
it, goes.

- What a rerun, a replacement and `site start` need is always there: each
  starts from the workspace it repeats.
- A record now lasts as long as its workspace. Deleting the workspaces
  that ran a workflow takes rule 2 back for it, where today nothing
  does. A workflow whose named workflow still points at it keeps passing
  on its approvals.
- A workspace holds the whole set of commits a run started with, so the
  stricter rule, "these commits ran together", could be read from the
  same rows later without a new table.

A workspace with **no repos** passes, since it has no commit to check and
runs only the steps a person wrote. That lets a project with no repos use
run secrets (a routine that calls an API with a token).

### Shared and read-only repos

- **A hosted repo shared with another user** takes branch approvals like
  any other repo. The refusal there today (`remoteShared`,
  `sharedBranchRefusal`) is deleted, so a site may follow, and a
  routine start at, a branch of a shared repo with a workflow that names
  secrets.
  docs/workflows.md keeps the warning in place of the rule: whoever the
  repo is shared with can push the branch, so approving it gives them the
  secrets.
- **A read-only link** (`project_repos.readOnly`) changes nothing. It
  stops this project's agents pushing the repo over git, but other
  projects of the owner may link it writable and the flag does not stop
  a write through the host's API (docs/project-repos.md "Read-only
  repos"), so who can push a branch is still the remote's to bound.

### Code changes (`#domain/projects`, `workflows.ts`)

- `workflowLaunch` takes the start's repos (`{ repoId, branch?, commit? }`
  each) in place of `repoId`, `commit` and `branch`. It resolves each
  branch to its tip after a fetch, lets a person's launch approve each
  commit, checks every repo, and answers the commits it resolved. Rule 2
  is one query over workspaces and their checkouts, and
  `recordWorkflowRun` and `workflowRan` go with their table.
  `prepareStart` pins every repo to them, as it pins the lone repo today,
  so each checkout of a secret-bearing run is created at a commit and has
  no base branch.
- Rule 3 is read from the main clone: the approved branches of the repo
  whose tip is the commit. That deletes `fromBranch` from
  `StartWorkspaceRequest` and from the deploy path. A launch at a commit
  that happens to be an approved branch's tip now passes without naming
  the branch, which the same launch naming the branch already did.
- `checkWorkflowRef` and `approveWorkflowRef` become `checkWorkflowStart`
  and `approveWorkflowStart(actor, namedWorkflowId, repos: RepoStart[])`:
  each repo at a commit is that commit, each at a branch is that branch
  of that repo. Routines and sites pass the selection they are about to
  store, which deletes the lone-repo mapping in `resolveRoutine` and the
  branch-only calls in `sites.ts`.
- `RUN_SECRETS_NEED_ONE_REPO` and both checks that throw it go.
- A refusal names the repo: "no person has run it on `web@1a2b3c4`".

### Reruns

`prepareRerun` already starts each repo at its checkout's start commit
(`startOf(row, 'commit')`). Each passes by rule 2, so a rerun needs no
change beyond a test with two repos.

## Sites

### Repos and layout

A site names at least one repo, each at a branch or at a full commit,
given when the repo is added. Nothing falls back to a default branch:
which branch of a repo is published is a choice the site's owner makes,
and a default branch renamed on the remote would otherwise change what a
site serves.

The layout follows from the count, as for any workspace: one repo sits at
the root, several sit in their folders. A site has no `nested` or `cwd`
of its own. A release runs no agent, so its cwd would matter
only to its steps, and the workflow now says where those start. A site
whose workflow names its one repo can add a second repo and keep its
workflow. The site's repos must include every repo its workflow names.

The repos are editable and apply from the next deploy, like the port.

### Following

`follow` is one flag on the site. A site with it off deploys only when
asked. With it on, while the site serves, the `sites` step computes the
site's **target**, which is each repo's branch tip in its main clone or
the commit it names, and deploys it when it differs from `releaseCommits`
and from `failedCommits`.

A repo at a commit never moves, so following some repos and not others
is naming a commit for the others. The flag is on the site rather than
on each repo so that what a site serves can be read off its settings: a
repo at a branch that did not trigger deploys would be served at whatever
its tip was when another repo last moved.

**What triggers a deploy.** Nothing new: every fetch of any repo already
wakes the `sites` step (`onOriginFetched`), and the origin refresh
already fetches every repo a live release has a checkout of. One detail
is added. Before a follow deploy starts, the site's other repos at a
branch are brought up to date if their last fetch is older than a few
seconds. The fetches are detached and each wakes the step again, so the
pass never waits on the network. Without this the refresh, whose fetches
finish at different times, would deploy once per repo that moved, and a
site with a volume goes down for each deploy's handoff.

Pushes to two repos seconds apart can still deploy the first without the
second, then both. A change that spans repos must work in that order, or
the site is taken off `follow` while it lands. There is no settle delay.

The branch checks of today (`checkBranch`: on origin now, not
`origin/…`, `refs/…` or `agent/…`) apply to every branch a site's
settings name. A person setting `follow`, or changing the repos or
workflow of a following site, approves each branch and each commit it
names for the workflow (`approveWorkflowStart`), refused before anything
is written. A follow deploy runs as the server and approves nothing, so
it passes on those.

`--no-follow` publishes nothing, so it is taken mid-deploy and from
anyone who may stop the site, as today. A stopped site follows nothing
until it is started.

### Deploys

- `deploySite` takes a ref per repo, for that deploy only. Each repo not
  named takes its setting: its branch's tip or its commit.
- A following site deploys only its target, so naming any other ref is
  a `CONFLICT`, as today. To roll back, stop following, then deploy the
  commits.
- **"The same commit"** becomes "the same commits": equal maps over the
  same repos. A second deploy of the commits already deploying is that
  deploy; any other is a `CONFLICT`.
- A **replacement** and **`site start`** start what the last release
  started with: `startOf(release, 'commit')`, which answers its repos at
  their start commits and in its layout, beside the workflow, volume
  and image `lastReleaseConfig` reads today. Where that release's row is
  gone, the site's settings at `releaseCommits`.
- A release's title lists its commits: `shop @ 1a2b3c4d` for one repo at
  the root, `shop @ web@1a2b3c4d api@5e6f7a8b` otherwise.

### Unlinking, deleting, renaming

"Built from the repo" means named in the site's `repos` or in
`releaseCommits`. Unlinking or deleting such a repo is refused as today.
Renaming the folder (`dir`) of a repo a site nests is refused too: a
replacement is a fresh checkout under the folder's current name, and the
steps name folders.

## Create paths

| Path | Change |
|---|---|
| `prepareStart` | refuses a named workflow whose repos the start lacks; passes every repo to `workflowLaunch` and pins each; the lone-repo branch goes |
| A workspace's life | `startStepsOf` answers the steps of the workspace's own workflow, else of every init workflow whose repos it has, each with its workflow |
| `step add` | `--workflow` is refused when the workspace lacks a repo the workflow names, or already runs that workflow in this life; `--run` and `--steps` store an anonymous workflow, with `--repo` its repos, and give it a name of its own |
| Queued entries | checked against their workflow's repos when saved; otherwise none: an entry stores a branch or commit per repo, and its launch resolves and checks each |
| Routines | `resolveRoutine` checks its workflow's repos and calls `approveWorkflowStart` on the stored repos; the one-repo refusal goes |
| `yaac-mama create --non-interactive --workflow` | none in code: `--repo <dir>@<commit>` per repo already reaches `prepareStart`. An agent approves nothing, so each repo must already pass |
| Reruns | none |
| Site releases | `startDeploy` passes the site's repos at the deploy's commits |

## Clients

**Wire types.** `SiteEntry.live`, `.deploy` and `.lastDeploy` carry
`commits: Array<{ dir: string; commit: string }>` in place of `commit`,
as do `SiteDetail.releases` and the answers of `/site/deploy` and
`/site/start`. `SiteEntry` gains `repos` and `follow`; `followBranch`
goes, and `followSkipped` becomes the commits not retried. `WorkflowEntry`
gains `repos`, by folder, and `init`. `ProjectSummary.initSteps` and
`initWorkflow` go: a client reads the init workflows from the workflow
list.
One formatter in `@yaac/shared` prints commits as `yaac-mama list`
already does (`<dir>@<short>` joined by spaces, bare for a lone repo),
used by the CLI, the webapp, the release title and `mama.ts`'s
`placements`, which drops its own copy.

**API.** `/workflow/create` and `/workflow/edit` take `repos` (folders or
ids) and `init`. `PUT /project/:id/init-workflows` takes the names that
are to be the project's init workflows, and replaces
`PUT /project/:id/init-steps`. `/site/create` and
`/site/edit` take `repos` and `follow: boolean` in place of `repo` and
`followBranch`. `repos` is required on create, and every entry names a
branch or a commit. On edit, `repos` is the site's whole list, as a
routine's is. `/site/deploy` takes `refs` (repo folder or id to branch or
full commit) beside `ref`, which stays as the form for a site of one
repo.

**CLI.**

- `site create|edit --repo <dir>@<branch or commit>`, repeatable, and
  required on create. A `--repo` with no branch or commit is refused, as
  is `--no-repos`.
- `--follow` / `--no-follow` as a flag. `--follow <branch>` goes: it is
  spelled `--repo <dir>@<branch> --follow`.
- `site deploy --ref [<dir>@]<ref>`, repeatable.
- `workspace step add|rerun|cancel` and `workspace logs` take and print
  full step names, as `yaac-mama logs` and `create --workspace --run` do.
  `step add --repo <dir>`, repeatable, says where added steps run.
- `site list|show` print commits per repo, and `show` each repo's branch
  or commit.
- `workflow create|edit --repo <dir>`, repeatable, and `--no-repos` on
  edit, as `--no-secrets` is; `--init` on both and `--no-init` on edit.
  `workflow list|show` print a workflow's repos and whether it is an
  init workflow.
- `config init-workflows <project> [workflows...] [--none]` replaces
  `config init-steps`, and `config show` lists the init workflows.
- `workflow show` prints an approved branch as `<dir>@<branch>` in place
  of `<dir>:<branch>`, to match `--repo`.

**Webapp.** The workspace bar and the logs view group steps by workflow,
and a step's pane is `step:<workflow>.<step>`. The workflow form
(`Workflows.tsx`) gets a repos field and a
"Run at workspace start" switch, and each workflow's row shows both. The
Init steps section of project settings becomes that list filtered to the
init workflows, each with its repos field and graph editor, and a button
that adds one. The
site form (`Sites.tsx`) gets the repo rows of the new-workspace pane
(`useStartSelection`: include, branch or commit per repo) and a Follow
switch in place of the branch field. A repo's branch field starts empty
there, not at origin's default. The deploy dialog shows one ref field per
repo when the site does not follow. Live, deploying and last-deploy lines
and the release list show commits per repo.

**yaac-mama.** No new verb. `create --workspace … --run` takes `--repo`
for where the step runs. `workflow list|show` print a
workflow's repos and whether it is an init workflow, and `list` shows a
release's commits through the shared formatter.

## Tests

Under this repo's rules (CLAUDE.md): one `describe` per barrel function,
internals covered by the arguments chosen, mocks only at the process
boundary.

- `packages/shared/test/` for `parseStepGraph`: a need on another
  workflow's step parses, a bare need on no step of the graph is refused,
  a name with `.` is refused and `shell` is allowed. The workflow
  migration against names with a `.`, over 48, and two that become the
  same.
- `test/domain/workspaces/` through `addSteps`, `rerunStep`, `cancelStep`
  and `reconcileSteps`: two workflows with the same step name run side by
  side under their own windows and logs; a need across them holds one
  back and skips it when the other fails; a bare name addresses a step
  while it is unambiguous and is refused once it is not; an anonymous
  add gets a name, and adding a named workflow twice is refused; a
  restart keeps the start workflow's name; rows with an empty workflow
  name are still found under their bare windows; and the commands a
  step is opened and killed with build no target from its name.
- `test/db/step-store.test.ts`: the new key.
- `test/domain/projects/workflows.test.ts`, `config-import.test.ts` and
  `repos.test.ts`: a workflow created and edited with repos (same graph,
  other repos, is another workflow; an agent's edit of a secret-bearing
  one refused), marking and unmarking init, setting the whole list of
  init workflows, the legacy config
  import writing a marked `init`, and unlinking a repo a workflow names
  refused. `init-steps.test.ts` goes with its module.
- `test/domain/workspaces/`: through `prepareStart`, `addSteps` and a
  restart, a step starts in each of the three places; a step added with
  `--repo` runs in that checkout and is refused without it; a start
  that lacks the workflow's repo is refused. A project with two init
  workflows: a workspace of both repos starts both graphs, each in its
  repo, both with a step of the same name; a workspace of one starts
  only its own, says the other was skipped, and skips a step that needs
  one of the other's. A routine and a queued entry are refused at save.
- `test/domain/projects/workflows.test.ts` again: `checkWorkflowStart` and
  `approveWorkflowStart` replace the two `…Ref` describes;
  `workflowLaunch` gains cases with two repos (one at an approved commit
  and one at an approved branch's tip; one repo unapproved, refused with
  nothing approved; a branch of a shared repo, which passes; no repos;
  a commit that passes only because an earlier non-interactive workspace
  of the workflow started there, and stops passing once that workspace
  is deleted, while an interactive workspace of the same workflow never
  counts).
- `test/domain/workspaces/`: `prepareStart` pins every repo of a
  secret-bearing start; `prepareRerun` of a two-repo run; a routine
  saved with two repos approves both starts.
- `test/domain/sites/`: within the existing describes, a following site
  of two repos, one at a branch and one at a commit. `createSite` and
  `editSite` (approvals of both, `--no-follow` mid-deploy), `deploySite`
  (a ref per repo, any other ref refused while following, the same
  commits being the same deploy), `reconcileSites` (a move of the branch
  deploys once, a failed target is not retried, a replacement starts the
  dead release's commits), `startSite`, `showSite`, and a site whose
  repos lack its workflow's refused. The
  shared-remote describe in `sites.test.ts` is deleted with the rule, and
  "editSite on a workflow" folds into `editSite`.
- `test/db/`: `site-store` (releases with several checkouts),
  `repo-store` (`repointProjectRepos` rewrites a site's `repos` and
  commit maps, and a workflow's `repos` and hash), `workflow-store`
  (repos in the hash, an empty list hashing as before, the init flag),
  the init migration against a project of each shape, and the site
  migration against a site that follows a branch
  and one that follows none, each mid-deploy. The backfill is tested
  where it lives, giving the second site its default branch.
- `test/api/route-matrix.ts`: the `PUT /project/:id/init-steps` row
  becomes `PUT /project/:id/init-workflows`, answering the same under
  both drivers. No other route is added; the `/site/create` row's body
  gains `repos`, which the route requires.
  Request-shape behavior goes in `write-routes.test.ts`.
- `test/e2e-cli/site-suite.test.ts` (k8s, host-only): one more repo in
  the file's existing fixture, and cases for `site create --repo`,
  `--follow`/`--no-follow`, the
  refusals of `--no-repos` and of a `--repo` with no branch or commit,
  `site deploy --ref <dir>@<ref>`, and `site show` of a two-repo
  release. They reuse the file's server and run before its teardown
  cases.
- `test/e2e-containerless/steps-suite.test.ts`, which already carries
  the step, workflow and run-secret cases and runs in a dev workspace:
  its existing cases move to full step names, with one for a bare name
  and one for `--needs <workflow>.<step>`. Then
  `workflow create --repo --init`, `workflow edit --repo`, `--no-repos`,
  `--init` and `--no-init`, and `config init-workflows` printing,
  setting a list and `--none`, in place of the `config init-steps`
  cases, with steps that print their directory in a workspace of two
  repos and two init workflows, the skip in a workspace of one, and the
  refusal of a named launch without the repo. Then the run-secret case with
  two repos, through `yaac workspace create --non-interactive --workflow
  … --repo a@<commit> --repo b@<commit>` and `yaac-mama create`, refused
  until a person ran both commits.
- Frontend unit tests for the workflow form's repos and init switch, the
  init steps section, the site form's request and the commit labels.

## Phasing

Each phase is one PR.

1. **Steps belong to a workflow.** The key, the names, `needs` across
   workflows, the commands that address a step, the webapp's grouping and
   the upgrade shim. No new feature: one workflow per workspace still, so
   it is the refactor alone, and every later phase builds on it. Updates
   docs/workspace-steps.md and docs/workflows.md.
2. **Workflows name their repos.** The column, the hash, where a step starts,
   the refusals, the skip for the project's one set of init steps, and
   every client's field. It fixes init steps written for one repo.
   Updates the same two docs.
3. **Init workflows.** The flag, the migration off the two project
   columns, `startStepsOf` over several workflows,
   `config init-workflows` in place of `config init-steps`, the webapp
   section, and the places that apply init steps from a file (CLAUDE.md,
   the run-yaac and yaac-autoconfig skills, the legacy config import).
   Updates the same two docs, docs/project-config.md and docs/cli.md.
4. **Run secrets per repo.** The per-repo launch check,
   `…WorkflowStart`, deriving rule 3, dropping `fromBranch`, the one-repo
   refusals and the shared-repo refusal. Its one schema change drops
   `workflow_runs`. Multi-repo
   routines and non-interactive creates get run secrets here. Updates
   docs/workflows.md, docs/routines.md and what docs/public-sites.md says
   of shared repos.
5. **Sites store repos and commit maps**, still refused for more than one
   repo. The migration, the default-branch backfill and its shim entry,
   the wire types, the shared formatter and every client's display. This
   is the PR that carries the risk for existing sites, so it changes no
   behavior.
6. **Sites of several repos.** Create, edit and deploy take the new
   fields; following across repos; the unlink, delete and rename
   refusals; the webapp form and the CLI options. Updates
   docs/public-sites.md, docs/cli.md, deletes "Limits" from
   docs/project-repos.md, and deletes this plan.

Cleanups that come first because they make the rest smaller, all inside
phase 4 or 5:

- Deriving rule 3 from the main clone, which removes `fromBranch`
  everywhere before sites would have needed one per repo.
- One helper that maps a stored selection to approvals, in place of the
  copies in `routines.ts` and `sites.ts`.
- The shared commit formatter, replacing `short()` in the CLI and webapp
  and the inline one in `placements`.
- `listSiteReleases` reading checkouts with `listWorkspaceReposFor`
  rather than a join that assumes one checkout per release.

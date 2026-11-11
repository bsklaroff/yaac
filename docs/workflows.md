# Workflows

A **workflow** is a step graph (docs/workspace-steps.md), the run secrets
(docs/project-config.md "Run secrets") it names and the repos its steps are
written for, stored once per content and never changed. Every graph a
workspace starts is one: a create's or a queued entry's `--steps`, a step
added to a running workspace, and what a named workflow points at. A
**named workflow** is a project's name for a workflow, which an edit points
at another; any number of them are the project's **init workflows**.
Routines and sites run named workflows only, and run secrets reach a
workspace only through one.

Workflows are kept by yaac, not versioned with the code. Keeping the graph
in the repository, as GitHub Actions does, would let one commit name both,
but it would also let any branch rewrite a graph that gets secrets.

## Storage

| Table | What it holds |
|---|---|
| `workflows` | a graph, the secrets and the repos it names, unique by project and a hash of all three (`workflowHash`; the repos enter it only when there are any), so a graph given twice is one row |
| `named_workflows` | a project's name pointing at one workflow, and whether it is an init workflow |
| `workflow_approvals` | the commits, and branches of a repo, a named workflow was approved to run on |

A graph given by itself (`--steps`) names no secrets, so it never lands on a
row that does. Nothing keeps a named workflow's earlier workflows as
history; the retention sweep deletes a workflow once nothing names it and it
is an hour old.

A workflow's name follows a step's rule (letters, digits, `-` and `_`, at
most 48 long), so it holds no `.`: a step is known as `<workflow>.<step>`
(docs/workspace-steps.md "Workflow names").

## Repos

A workflow names the repos of its project its steps are written for, by id;
none is the default.

| The workflow names | Its steps start in |
|---|---|
| one repo | that repo's checkout, at the workspace root or in its folder |
| several | the workspace root, which holds each in its folder |
| none | the workspace's cwd |

So a graph written for one repo's root runs there whether the workspace
holds that repo alone at its root, alone in a folder, or beside others, and
whatever cwd its agent was given.

A workflow runs only in a workspace with a checkout of every repo it names.
A launch that names it is refused, naming the repo it lacks: a create's or
queued entry's `--workflow`, a routine, a site, a rerun, and `step add
--workflow`. A routine, a site and a queued entry are refused when saved
too, since what they start with is known then. An init workflow is not
named by the create, so one whose repo the workspace lacks is skipped
instead, and the create says so.

Repos are content: an edit makes a new workflow, and an agent may not edit
a named workflow that names secrets, so it cannot move a secret-bearing
graph into another repo's root. Unlinking or deleting a repo that a named
workflow names is refused, since every later launch would be refused or,
for an init workflow, silently skipped. Steps added to a running workspace take
repos too (`yaac workspace step add --run … --repo web`, `yaac-mama create
--workspace … --run … --repo web`); a create's inline `--steps` names none,
since that create's `--repo` already says which repos it starts with.

## Init workflows

A named workflow marked `init` is started by every workspace that brings no
graph of its own and has the workflow's repos, at each of its lives, under
its name. A project may mark any number: one of `web` and `api` marks
`web-init` (repos: web) and `api-init` (repos: api), and a workspace of both
runs both, each in its own repo's root, while a workspace of `api` alone
runs only `api-init` and its create's progress says `web-init` was skipped.
An init workflow that names no repo runs in every workspace. The workflows
of one life are independent graphs started together, so no order is kept
between them; two may use the same step names, and one may need a step of
another (`db-init.postgres`), which is skipped where that one did not start.

A flag on the named workflow, rather than a list on the project, needs no
positions or way to address an unnamed entry; the repos field and graph
editor are the workflow's own; and which workflows start with a workspace
reads off one column. Deleting an init workflow is how its steps stop
running.

## What each holder names

| Holder | Column | When the graph is read |
|---|---|---|
| A project's init workflows | `named_workflows.init` | at each life of a workspace that brought no graph |
| Routine | `namedWorkflowId`, or none for the init workflows | each run takes its named workflow at launch |
| Site | `namedWorkflowId` | each deploy takes its named workflow when it starts |
| Queued entry | `workflowId` (its `--steps`) or `namedWorkflowId` (`--workflow`) | a named one at launch; its own steps are fixed |
| Workspace | `workflowId`, and `workflowName`, the name it has there | fixed for every life; none starts the project's init workflows |
| Rerun, a site's replacement, `site start` | the original's `workflowId` and `workflowName` | fixed |
| A step added to a running workspace | its own spec, its row's `workflowId` and `workflowName` | once, in that life |

So an edit never changes what is running, or a rerun or replacement of it,
only what the next launch takes up. A routine's run copies its routine's
named workflow at its tick and follows it until it launches. It cannot be
edited; editing the routine is how the next run changes.

## Run secrets

Every guarantee in this section rests on agents reaching the server only
through `yaac-mama`, which is true under k8s only. Under containerless an
agent's shell reaches the API over loopback as the user, so it can set,
name and approve run secrets; there they only keep values out of
interactive workspaces' environments (docs/project-config.md "Run
secrets").

**Only a person names them.** A workspace's agent may not name secrets, nor
edit a named workflow whose workflow names any. An edit that names secrets
carries its whole graph, so a person never gives secrets to steps they did
not see; a person changing only its repos need not, since its steps stay
the ones they saw. Anything may launch a named workflow that names them (a routine, a
site, a create through the webapp, the CLI, the API or `yaac-mama`), since
launching what a person made changes when it runs, not what.

**Approvals.** A workflow runs whatever the repositories hold at their
commits, so the commits are checked too. An approval is one commit, or one
branch of one repo, for a named workflow (`workflow_approvals.ref`: a bare
commit, which names its content whichever repo holds it, or
`<repo id>:refs/heads/<branch>`). Only running something approves it, and
only a person's action:

- A person saving a routine approves the commit or branch each repo it
  starts with is at (the repo's default branch when it names none). Every
  agent of the project can push to a branch with the project's git
  credential, so approving one approves whatever is pushed there.
- A person deploying a site, or launching a named workflow
  non-interactively by hand (webapp, CLI, API), approves each commit it
  runs.
- A person setting a site to follow (docs/public-sites.md "Following"),
  changing the repos or workflow of a following site, or deploying one,
  approves each branch and commit the site names, so each follow deploy
  passes.

A branch is approved for its repo, so in a project with several repos the
same branch name in another repo is not approved by it.

Nothing an agent does approves anything, and no verb approves on its own.
An approval reaches only the workflow its named workflow points at now, but
every launch of it: not only the routine or site whose setup made it.

**A branch approval gives the secrets to whoever can push the branch.**
Code pushed there runs with the real values at the next follow deploy,
routine run, or any launch of the workflow on that branch, `yaac-mama
create --workflow` included, and can print them into its step logs, which
the project's agents read. That includes the project's agents themselves,
which push with its git credential, so approve a branch only where an agent
reading the secret is acceptable, or protect the branch on the remote. A
hosted repo its owner shared with another user (docs/hosted-projects.md
"Sharing") takes branch approvals like any other, so there approving a
branch gives the secrets to whoever it is shared with. A read-only link
(docs/project-repos.md "Read-only repos") changes nothing: other projects
may link the repo writable, so who can push a branch is still the remote's
to bound.

**The launch check** (`workflowLaunch` in `#domain/projects`). A
non-interactive launch, or a site's release, of workflow W gets the secrets
W names when every repo it starts with is at a commit that passes on its
own, where a commit passes if

1. it is approved for a named workflow that points at W now, or
2. a workspace that ran W with its secrets started that repo there, or
3. it is now the tip of a branch of its repo approved for such a named
   workflow.

A repo at a branch runs at its tip, resolved after a fetch before anything
is provisioned, and every checkout of the launch is created at its commit.
A launch with no repos passes, since it runs only steps a person wrote.
Every repo of the workspace is checked, not only those the workflow names,
since a step can reach any checkout beside its own. Nothing else is
checked: not who started it, nor through which path. A refusal names the
repo: "no person has run it on `web@1a2b3c4`".

Per repo rather than per combination: in a passing launch every checkout
holds code a person approved for this workflow, and a branch is approved
per repo by nature. What it gives up is that two commits no person ran
together can run with the secrets, such as a newer deploy script beside an
older app.

Rule 2 is read from workspaces: one that ran W with its secrets is a
non-interactive workspace or a site's release whose `workflowId` is W, and
each of its checkouts records the commit it started at
(`workspace_repos.startCommit`). Such a workspace exists only because its
launch passed this check, so it is the record. What a rerun, a replacement
and `site start` need is always there, since each starts from the
workspace it repeats; deleting the workspaces that ran a workflow takes
rule 2 back for it.

- A launch that fails the check is refused rather than run without the
  secrets, which would only fail later and less clearly. A routine's run
  fails with a launch error, as any broken routine does.
- An interactive launch never gets secrets and is not refused: `rerun
  --interactive`, to debug a failed run, opens without them.
- Values are read at each launch, as GitHub Actions reads a secret when each
  job starts, so a rotated value reaches every later launch, an earlier
  workflow's rerun or replacement included. A workflow naming a secret that
  was deleted, or no longer opens, fails to launch.

**Revoking.** Approvals are never taken back, and workflows never change,
so a secret taken off a named workflow still reaches reruns of the
workspaces that ran the workflows it pointed at before. Delete the
secret, which fails every launch that names it, or rotate it, which leaves
a value that leaked before the rotation worth nothing. Either reaches only
later launches: a running workspace, a live site release above all, keeps
the value it started with, so stop the releases and runs that have it.

## Lifecycle

- A named workflow that a routine, site or queued entry follows cannot be
  deleted; an init workflow can, which is how its steps stop running.
  Deleting one drops its approvals; its workflows stay while anything names
  them.
- A site edit is refused while a deploy runs, and a deploy fixes its
  workflow when it starts.

## Surfaces

- **API**: `GET /api/workflow/list`, `/show` (readers); `POST
  /api/workflow/create`, `/edit` (both take `repos`, by folder or id, and
  `init`), `/delete` (the project's owner); `PUT
  /project/:id/init-workflows` takes the names that are to be the project's
  init workflows. `workflow` on `/workspace/create`, the queue routes,
  `/routine/create` and `/update`, `/site/create` and `/edit`, and `POST
  /workspace/:id/steps`.
- **CLI**: `yaac workflow create|edit|list|show|delete <project> <name>`,
  `--file`, `--secret` and `--repo` (`--no-secrets` and `--no-repos` on
  edit), `--init` (`--no-init` on edit); `yaac config init-workflows
  <project> [workflows...] [--none]`; `--workflow <name>` on `workspace
  create`, `workspace step add`, `routine create|edit` and `site
  create|edit` (docs/cli.md).
- **yaac-mama**: `workflow list|show` (with each one's repos and whether it
  is an init workflow), and `--workflow` on `create`, `create --workspace`
  (adds its steps), `queue`, `edit-queued` and `routine create|edit`.
- **Webapp**: Settings → Project Config → Run secrets, Workflows (each with
  its repos and a "Run at workspace start" switch) and Init workflows (that
  list filtered); a site's form picks its workflow.

| Concern | Path |
|---|---|
| Rows | `packages/server/src/db/workflow-store.ts` |
| Edits, approvals, the launch check | `packages/server/src/domain/projects/workflows.ts` |
| Launches | `prepareStart` in `packages/server/src/domain/workspaces/start.ts` |

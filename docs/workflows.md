# Workflows

A **workflow** is a step graph (docs/workspace-steps.md) and the run secrets
(docs/project-config.md "Run secrets") it names, stored once per content
and never changed. Every graph a workspace starts is one: the project's
init steps, a create's or a queued entry's `--steps`, and what a named
workflow points at. A **named workflow** is a project's name for a
workflow, which an edit points at another. Routines and sites run named
workflows only, and run secrets reach a workspace only through one.

Workflows are kept by yaac, not versioned with the code. Keeping the graph
in the repository, as GitHub Actions does, would let one commit name both,
but it would also let any branch rewrite a graph that gets secrets.

## Storage

| Table | What it holds |
|---|---|
| `workflows` | a graph and the secrets it names, unique by project and a hash of both (`workflowHash`), so a graph given twice is one row |
| `named_workflows` | a project's name pointing at one workflow |
| `workflow_approvals` | the commits and branches a named workflow was approved to run on |
| `workflow_runs` | each (workflow, commit) that ran with its secrets |

A graph given by itself (`--steps`) names no secrets, so it never lands on a
row that does. Nothing keeps a named workflow's earlier workflows as
history; the retention sweep deletes a workflow once nothing names it and it
is an hour old, with its recorded runs.

## What each holder names

| Holder | Column | When the graph is read |
|---|---|---|
| A project's init steps | `initWorkflowId` (`config init-steps --file`) or `initNamedWorkflowId` (`--workflow`) | at each life of a workspace that brought no graph |
| Routine | `namedWorkflowId`, or none for the init steps | each run takes its named workflow at launch |
| Site | `namedWorkflowId` | each deploy takes its named workflow when it starts |
| Queued entry | `workflowId` (its `--steps`) or `namedWorkflowId` (`--workflow`) | a named one at launch; its own steps are fixed |
| Workspace | `workflowId`, and `workflowName` as a record | fixed for every life; none follows the project's init steps |
| Rerun, a site's replacement, `site start` | the original's `workflowId` and `workflowName` | fixed |
| A step added to a running workspace | its own spec, and `workflowId` and `workflowName` as a record when added from a named one | once, in that life |

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
not see. Anything may launch a named workflow that names them (a routine, a
site, a create through the webapp, the CLI, the API or `yaac-mama`), since
launching what a person made changes when it runs, not what.

**Approvals.** A workflow runs whatever the repository holds at a commit,
so the commit is checked too. Only running something approves it, and only
a person's action:

- A person saving a routine approves the commit it starts at, or its branch
  (the repo's default when it names none). Every agent of the project
  can push to a branch with the project's git credential, so approving one
  approves whatever is pushed there.
- A person deploying a site, or launching a named workflow
  non-interactively by hand (webapp, CLI, API), approves the commit it runs.
- A person setting a site to follow a branch (docs/public-sites.md
  "Following a branch"), or deploying a site that follows one, approves the
  branch, so each follow deploy passes as its tip.

The commit is one repo's, so run secrets reach only a workspace that starts
with exactly one repo (docs/project-repos.md): a launch with none or several
that would get them is refused. A branch is approved for that repo, so in a
project with several repos the same branch name in another repo is not
approved by it.

Nothing an agent does approves anything, and no verb approves on its own.
An approval reaches only the workflow its named workflow points at now, but
every launch of it: not only the routine or site whose setup made it.

**A branch approval gives the secrets to whoever can push the branch.**
Code pushed there runs with the real values at the next follow deploy,
routine run, or any launch of the workflow on that branch, `yaac-mama
create --workflow` included, and can print them into its step logs, which
the project's agents read. That includes the project's agents themselves,
which push with its git credential, so approve a branch only where an agent
reading the secret is acceptable, or protect the branch on the remote. On a
hosted repo its owner shared with another user (docs/hosted-projects.md
"Sharing"), that would be another person, so there no branch is approved
for a workflow that names secrets, and a launch that would rely on one is
refused; such a workflow runs at commits.

**The launch check** (`workflowLaunch` in `#domain/projects`). A
non-interactive launch, or a site's release, of workflow W at commit C gets
the secrets W names if a named workflow pointing at W now is approved for C
or for the branch C is the tip of, or (W, C) ran with them before. A launch
that names no commit runs at its branch's tip (else the default branch's),
resolved before anything is provisioned. Nothing else is checked: not who
started it, nor through which path.

- A launch that fails the check is refused rather than run without the
  secrets, which would only fail later and less clearly. A routine's run
  fails with a launch error, as any broken routine does.
- An interactive launch never gets secrets and is not refused: `rerun
  --interactive`, to debug a failed run, opens without them.
- Values are read at each launch, as GitHub Actions reads a secret when each
  job starts, so a rotated value reaches every later launch, an earlier
  workflow's rerun or replacement included. A workflow naming a secret that
  was deleted, or no longer opens, fails to launch.

**Revoking.** Approvals and recorded runs are never taken back, and
workflows never change, so a secret taken off a named workflow still
reaches the recorded runs of the workflows it pointed at before. Delete the
secret, which fails every launch that names it, or rotate it, which leaves
a value that leaked before the rotation worth nothing. Either reaches only
later launches: a running workspace, a live site release above all, keeps
the value it started with, so stop the releases and runs that have it.

## Lifecycle

- A named workflow that a routine, site, queued entry or the project's init
  steps follow cannot be deleted. Deleting one drops its approvals; its
  workflows stay while anything names them.
- A site edit is refused while a deploy runs, and a deploy fixes its
  workflow when it starts.

## Surfaces

- **API**: `GET /api/workflow/list`, `/show` (readers); `POST
  /api/workflow/create`, `/edit`, `/delete` (the project's owner).
  `workflow` on `/workspace/create`, the queue routes, `/routine/create`
  and `/update`, `/site/create` and `/edit`, `PUT
  /project/:id/init-steps` and `POST /workspace/:id/steps`.
- **CLI**: `yaac workflow create|edit|list|show|delete <project> <name>`,
  `--file` and `--secret` (`--no-secrets` on edit); `--workflow <name>` on
  `workspace create`, `workspace step add`, `routine create|edit`, `site
  create|edit` and `config init-steps` (docs/cli.md).
- **yaac-mama**: `workflow list|show`, and `--workflow` on `create`,
  `create --workspace` (adds its steps), `queue`, `edit-queued` and
  `routine create|edit`.
- **Webapp**: Settings → Project Config → Run secrets and Workflows; a
  site's form picks its workflow.

| Concern | Path |
|---|---|
| Rows | `packages/server/src/db/workflow-store.ts` |
| Edits, approvals, the launch check | `packages/server/src/domain/projects/workflows.ts` |
| Launches | `prepareStart` in `packages/server/src/domain/workspaces/start.ts` |

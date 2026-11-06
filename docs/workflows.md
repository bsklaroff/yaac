# Workflows

A **workflow** is a project's named step graph (docs/workspace-steps.md),
kept by yaac rather than in the repository. Routines, sites and creates run
one by name, and its revisions name the run secrets (docs/project-config.md
"Run secrets") they are given. A workflow is the one thing a run secret is
given to, so one check at launch decides whether a workspace gets one,
whatever path started it.

Workflows are not versioned with the code. Keeping the graph in the
repository, as GitHub Actions does, would let one commit name both, but it
would also let any branch rewrite a graph that gets secrets.

## Revisions

A workflow (`workflows`, unique by project and name) holds its content in
immutable revisions (`workflow_revisions`), numbered from 1; the highest is
current. An edit adds one. Each holds a graph and the run secrets it names.

A graph may also come from elsewhere, and none of these is a workflow: a
project's init steps, a create's or a routine's `--steps`, a site's own
steps. They never get run secrets.

## What follows an edit

| Reference | Follows the workflow, or pins a revision |
|---|---|
| Routine → workflow (`routines.workflowId`) | Follows: each run starts with the current revision |
| Site → workflow (`sites.workflowId`) | Follows: each deploy runs the current revision |
| A routine's run that has not launched | Follows its routine, read at launch |
| Workspace (`workspaces.revisionId`, with its graph copied to `startSteps`) | Pins: every life runs the same graph |
| Rerun | Pins the original's revision |
| A site's replacement and `site start` | Pin the revision of the release they replace |

An edit so never changes what is running, or a rerun or replacement of it.

**A routine's run is a record of its routine.** It launches with its
routine's settings as they are then: workflow, steps, commit or branch,
tool, prompt. It keeps only what is its own: its tick, its title, its
timeout window, and its group, whose line it waits in. It cannot be edited,
by a person or an agent; editing the routine is how a run changes.
Discarding it and running it now still work.

## Run secrets

**Only a person names them.** A workspace's agent may not create or edit a
revision that names secrets, nor edit a workflow whose current revision
does (its edit would replace a working revision with one that gets none).
An edit that names secrets carries its whole graph, so a person never gives
secrets to steps they did not see, such as an agent's edit made since they
last looked.

**Anything may launch a workflow that names them**: a routine, a site, a
create through the webapp, the CLI, the API or `yaac-mama`. Launching what
a person made changes when it runs, not what.

**Approvals.** A revision runs whatever the repository holds at a commit,
so the commit is checked too. A workflow keeps its approvals
(`workflow_approvals`): commits, and branches whose tip it may run on. Only
running something approves it, and only a person's action:

- A person saving a routine approves the commit it starts at, or its branch
  (the project's default when it names none). Every agent of the project can
  push to a branch with the project's git credential, so approving one
  approves whatever is pushed there.
- A person deploying a site, or launching a workflow non-interactively by
  hand (webapp, CLI, API), approves the commit it runs.
- A person setting a site to follow a branch (docs/public-sites.md
  "Following a branch"), or deploying a site that follows one, approves the
  branch, so each follow deploy passes as its tip.

Nothing an agent does approves anything, and no verb approves on its own.
Approvals reach only the current revision.

**Runs that happened.** Every (revision, commit) that was handed its secrets
is recorded (`workflow_runs`) and may run with them again. So after an edit,
a rerun or a site's replacement of an earlier revision keeps its secrets on
the commit it ran on, and nothing reaches an earlier revision on a new
commit.

**The launch check** (`workflowLaunch` in `#domain/projects`). A
non-interactive launch, or a site's release, of revision R at commit C gets
the secrets R names if R is current and C is approved or the tip of an
approved branch, or (R, C) is recorded. A launch that names no commit runs
at its branch's tip (else the default branch's), resolved before anything
is provisioned. Nothing else is checked: not who started it, nor through
which path.

- A launch that fails the check is refused rather than run without the
  secrets, which would only fail later and less clearly, or run an app
  without its key. A graph meant to run without them belongs in a workflow
  that names none. A routine's run fails with a launch error, as any
  broken routine does: an agent's routine on a workflow a person later gave
  secrets, at a commit no person approved, say.
- An interactive launch never gets secrets and is not refused: `rerun
  --interactive`, to debug a failed run, opens without them.
- Values are read at each launch, as GitHub Actions reads a secret when each
  job starts, so a rotated value reaches every later launch, an earlier
  revision's rerun or replacement included. A revision naming a secret that
  was deleted, or no longer opens, fails to launch.

**Revoking.** Approvals and recorded runs are never taken back, and
revisions never change, so a secret taken out of the current revision still
reaches the recorded runs of earlier ones. Delete the secret, which fails
every launch that names it, or rotate it, which leaves a value that leaked
before the rotation worth nothing.

## Lifecycle

- A workflow a routine or site runs cannot be deleted. Deleting one takes
  its revisions, approvals and recorded runs; a rerun of one of its runs
  is then refused.
- A site edit is refused while a deploy runs, and a deploy pins its
  revision when it starts.

## Surfaces

- **API**: `GET /api/workflow/list`, `/show` (readers); `POST
  /api/workflow/create`, `/edit`, `/delete` (the project's owner).
  `workflow` on `/workspace/create`, `/routine/create|edit` and
  `/site/create|edit`, in place of `steps`.
- **CLI**: `yaac workflow create|edit|list|show|delete <project> <name>`,
  `--file` and `--secret` (`--no-secrets` on edit); `--workflow <name>` on
  `workspace create`, `routine create|edit` and `site create|edit`
  (docs/cli.md).
- **yaac-mama**: `workflow list|show`, and `--workflow` on `create` and
  `routine create|edit`. A queued entry takes none.
- **Webapp**: Settings → Project Config → Run secrets and Workflows, the
  latter listing each workflow's approvals; a site's form picks its own
  steps or a workflow.

| Concern | Path |
|---|---|
| Rows | `packages/server/src/db/workflow-store.ts` |
| Edits, approvals, the launch check | `packages/server/src/domain/projects/workflows.ts` |
| Launches | `prepareStart` in `packages/server/src/domain/workspaces/start.ts` |

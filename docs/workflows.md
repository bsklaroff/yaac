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
| `launch_approvals` | the commits, and branches of a repo, a person approved each privileged launch's spec to run on (see "Approvals") |

A graph given by itself (`--steps`) names no secrets, so it never lands on a
row that does. Nothing keeps a named workflow's earlier workflows as
history; the retention sweep deletes a workflow once nothing names it and it
is an hour old, and its approvals with it.

A named workflow's name follows a step's rule (letters, digits, `-` and
`_`, starting with a letter or digit, at most 48 long), so it holds no `.`:
a step is known as `<workflow>.<step>`. A workflow with no name of its own
gets one the server mints in each workspace, `_steps` or `_added-N`, whose
leading `_` no chosen name has (docs/workspace-steps.md "Workflow names").

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

Repos are content: an edit makes a new workflow, which nothing approved, so
moving a secret-bearing graph into another repo's root needs a person's
approval before it runs with the secrets. Unlinking or deleting a repo that a named
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
| A step added to a running workspace | its own spec, and its life's workflow row (`workspace_life_workflows`: the name and `workflowId`) | once, in that life |

So an edit never changes what is running, or a rerun or replacement of it,
only what the next launch takes up. A routine's run copies its routine's
named workflow at its tick and follows it until it launches. It cannot be
edited; editing the routine is how the next run changes.

## Run secrets

Every guarantee in this section rests on agents reaching the server only
through `yaac-mama`, which is true under k8s only. Under containerless an
agent's shell reaches the API over loopback as the user, so it can set and
approve run secrets; there they only keep values out of interactive
workspaces' environments (docs/project-config.md "Run secrets").

**Names are free; launches are gated.** Anyone who may write the project,
its agents included, may write a workflow and name run secrets in it, as
anyone may write a GitHub Actions job that names an environment's secrets.
Naming a secret approves nothing. What gets one is a **privileged launch**:
a non-interactive launch, or a site's release, of a workflow that names
any. It runs only on commits a person approved for its **spec**, the exact
content it runs. Only a person sets a secret's value
(docs/project-config.md "Run secrets"), and nothing an agent does approves
anything.

### Approvals

A launch's spec is what it runs apart from its commits:

- for a workflow launched outside a site (a create, a queued entry, a
  routine's run, `step add --workflow`), its workflow's id, which covers the
  graph, the secret names and the repos, since a workflow is stored once
  per content;
- for a site's deploy, its site, workflow, port and volume
  (docs/public-sites.md "Publishing"), so approving one site approves no
  other, and an approved deploy cannot be pointed at another volume.

An approval (`launch_approvals`) is a spec and a ref: a bare commit, which
names its content whichever repo holds it, `<repo id>:refs/heads/<branch>`,
or `-` for a launch with no repos, which approves the spec alone. Approvals
key on content, never on a name: an edit to a named workflow is a new spec
with none, so its secret-bearing runs wait for a person, and pointing the
name back at the old graph is the old spec again.

**Who saw the content.** Each workflow row records whether a person wrote
that content or was shown it and approved it (`personWritten`). A person
saving a workflow's steps (the webapp's form, `yaac workflow create`, or
`edit --file`) writes it; an agent's `yaac-mama workflow create|edit` does
not, and nor does a person's edit that gives an agent's steps secrets or
repos without sending the steps, since the person was not shown them.
Content an agent wrote stays the agent's until a person writes the same
steps or approves it in a review. A person's own action approves runs only of
content a person saw, never of what an agent put behind a name meanwhile:

- A person saving an unattended routine approves the commit or branch each
  repo it starts with is at (the repo's default branch when it names none),
  for its named workflow's current workflow, when the save sets or changes
  its workflow or start; an edit of anything else approves nothing.
- A person queuing a named workflow to run unattended later (a scheduled
  or queued create) marks the entry (`queued_workspaces.personSaved`), and
  its launch approves each commit it runs, as their own launch would. It
  approves no branch: a one-off run is not a standing setup. An agent's
  queue, or an agent's edit of the entry's workflow or start, clears the
  mark, and its launch waits for a review where it needs one.
- A person launching a workflow non-interactively by hand (webapp, CLI,
  API) approves each commit it runs.
- A person deploying a site, publishing one, or setting a site to follow
  approves its commits or branches for the site's spec
  (docs/public-sites.md "Following").

For content an agent wrote, none of these approve anything, and the launch
waits for a **review**: a person is shown what it would run (the
workflow's graph, the run secrets it names and each repo's commit) and
approves it by sending back that workflow's id and those commits. The
server refuses a review where either is no longer what would run, so an
edit or a newer request made meanwhile cannot ride on it, and runs exactly
the commits shown, never a branch's newer tip. A review marks the content
as seen, so the person's later actions approve runs of it as above. Every
agent of the project can push to a branch with the project's git
credential, so approving a branch approves whatever is pushed there.

A branch is approved for its repo, so in a project with several repos the
same branch name in another repo is not approved by it.

**A branch approval gives the secrets to whoever can push the branch.**
Code pushed there runs with the real values at the next follow deploy,
routine run, or any launch of the spec on that branch, `yaac-mama
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

**The launch check** (`admitLaunch` in `#domain/projects`). A privileged
launch of spec S passes when every repo it starts with is at a commit that
passes on its own: one approved for S, or the tip of a branch of its repo
approved for S. A repo at a branch runs at its tip, resolved after a fetch
before anything is provisioned, and every checkout of the launch is created
at its commit. A launch with no repos passes once its spec is approved
(`-`). Every repo of the workspace is checked, not only those the
workflow names, since a step can reach any checkout beside its own. Nothing
else is checked: not who started it, nor through which path. A launch that
passes records its commits as approved for S, so a rerun, a replacement and
`site start` repeat it after the branch has moved on. Approvals are never
taken back, so an agent may launch S again at any commit it was ever
approved on, a site's rollback to an earlier approved release included.

Per repo rather than per combination: in a passing launch every checkout
holds code a person approved for this spec, and a branch is approved per
repo by nature. What it gives up is that two commits no person ran
together can run with the secrets, such as a newer deploy script beside an
older app.

What a launch that fails the check does depends on who launched it:

- A queued entry, a routine's run included, waits: its launch error says
  no person approved it, and it keeps what it would have run
  (`approvalRequest`: the workflow and each repo's commit). Its review (the
  sidebar's Review and approve, or `yaac workspace run-queued`, which prints
  it and asks) approves exactly that and launches it pinned there, as that
  person. Any edit of the entry drops the request, and a review is refused
  unless the request covers each of the entry's repos. Any other run of an
  entry, a person's Run now included, launches as the server and approves
  nothing.
- A site's deploy that needs approval becomes its requested deploy, which
  a person reviews the same way (docs/public-sites.md "Publishing").
- Any other launch is refused with `APPROVAL_REQUIRED`, rather than run
  without the secrets, which would only fail later and less clearly. An
  agent that needs one queues it for the user, and a person whose launch
  is refused for content an agent wrote saves or reviews it first.
- An interactive launch never gets secrets and is not refused: `rerun
  --interactive`, to debug a failed run, opens without them.
- Values are read at each launch, as GitHub Actions reads a secret when each
  job starts, so a rotated value reaches every later launch, an earlier
  workflow's rerun or replacement included. A workflow naming a secret that
  was deleted, or no longer opens, fails to launch.

**Logs.** A workspace given run secrets names them in `YAAC_MASK_NAMES`,
and each window's log is written through `workspace-bin/yaac-log-mask`,
which blanks every value as it is written (docs/workspace-steps.md
"Logs"), as CI runners do. It misses an encoded or changed value and one
under 8 characters, so approval is the control and masking only catches
accidents: a step must not print a secret.

**Revoking.** Approvals are never taken back, and workflows never change,
so a secret taken off a named workflow still reaches reruns of the
workspaces that ran the workflows it pointed at before. Delete the
secret, which fails every launch that names it, or rotate it, which leaves
a value that leaked before the rotation worth nothing. Either reaches only
later launches: a running workspace, a live site release above all, keeps
the value it started with, so stop the releases and runs that have it.

## Lifecycle

- A named workflow that a routine, site or queued entry follows cannot be
  deleted; an init workflow can, which is how its steps stop running. Its
  workflows, and their approvals, stay while anything names them.
- A site edit is refused while a deploy runs, and a deploy fixes its
  workflow when it starts.

## Surfaces

- **API**: `GET /api/workflow/list`, `/show` (readers); `POST
  /api/workflow/create`, `/edit` (both take `repos`, by folder or id, and
  `init`), `/delete` (the project's owner); `PUT
  /project/:id/init-workflows` takes the names that are to be the project's
  init workflows. `workflow` on `/workspace/create`, the queue routes,
  `/routine/create` and `/update`, `/site/create` and `/edit`, and `POST
  /workspace/:id/steps`. A launch no person approved answers
  `APPROVAL_REQUIRED` (403).
- **CLI**: `yaac workflow create|edit|list|show|delete <project> <name>`,
  `--file`, `--secret` and `--repo` (`--no-secrets` and `--no-repos` on
  edit), `--init` (`--no-init` on edit); `yaac config init-workflows
  <project> [workflows...] [--none]`; `--workflow <name>` on `workspace
  create`, `workspace step add`, `routine create|edit` and `site
  create|edit`; `yaac workspace run-queued <id>` approves and runs a queued
  entry awaiting approval (docs/cli.md).
- **yaac-mama**: `workflow list|show|create|edit|delete` (each with its
  repos and whether it is an init workflow), and `--workflow` on `create`,
  `create --workspace` (adds its steps), `queue`, `edit-queued` and
  `routine create|edit`.
- **Webapp**: the sidebar's Workflow tab lists each named workflow, with
  Run now on its row and its unattended runs under it (they go in a group
  the workflow owns, docs/workspace-groups.md "Owned groups"); a live run
  shows on the Workspace tab too, as a plain row. Its
  pane shows its steps, repos, run secrets, approvals, whether an agent
  wrote it, a "Run at workspace start" switch and the routines and sites
  that run it, and edits it. The new-workspace pane's Workflow tab runs one
  unattended now, later or on a schedule, and its Agent tab's Steps row
  starts an agent workspace with one in place of the init workflows. Run
  secrets are set under Settings → Project › Environment; a site's form
  picks its workflow. A queued entry awaiting approval says so in the
  sidebar, where its review approves it.

| Concern | Path |
|---|---|
| Rows | `packages/server/src/db/workflow-store.ts` |
| Edits, approvals, the launch check | `packages/server/src/domain/projects/workflows.ts` |
| Launches | `prepareStart` in `packages/server/src/domain/workspaces/start.ts` |

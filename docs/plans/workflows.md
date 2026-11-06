# Workflows

A **workflow** is a project's named step graph (docs/workspace-steps.md),
stored by yaac rather than in the repository. Routines, sites, queued
entries and workspaces name a workflow instead of each holding a copy of a
graph, and a workflow's revision names the run secrets
(docs/project-config.md "Run secrets") it gets, rather than each secret
naming the sites and routines that launch it.

Today a graph is copied inline into five columns: `projects.initSteps`,
`routines.steps`, `sites.steps`, `queued_workspaces.steps` and
`workspaces.startSteps`. With no identity, a run secret can only be
given to whatever holds a copy, and every path that copies one needs a
rule of its own: a queued run of a routine gets its secrets only while it
still matches the routine, an agent may not edit a routine that has them, and
a rerun gets none. Workflows replace those rules with one check at launch.

Workflows are not versioned with the code. Keeping the graph in the
repository, as GitHub Actions does, would make one commit identify both,
but it would also make every branch able to rewrite a graph that gets
secrets.

## Workflows and revisions

A workflow is a row (project, name) whose content lives in immutable
**revisions**. An edit adds a revision and moves the workflow's `current`
pointer to it; a revision is never changed and never shared between
workflows. Reverting is an edit, which makes a new revision with the old
content.

A create that brings its own graph (`--steps ci.json`) makes a revision
that belongs to no workflow. It runs as today, and names no secrets.

## What follows an edit

Each reference to a graph either follows the workflow or pins a revision:

| Reference | Kind | Why |
|---|---|---|
| A project's init steps | Follows its `init` workflow | Every workspace starts the project's current setup |
| Routine → workflow | Follows | What its next run runs |
| Site → workflow | Follows | What its next deploy runs |
| A routine's run that has not launched | Follows its routine, pins at launch | A run is a record of its routine, not a request of its own |
| Workspace (every life, every restart) | Pins | "This graph passed on this commit" stays true |
| Rerun | Pins the original's revision | It reproduces the original |
| Release, replacement, `site start` | Pins the revision of the release it replaces or restarts | A replacement runs what that release ran |

So an edit never changes what is running, or a rerun or replacement of
it, only what the next launch takes up.

**A routine's run is not editable.** Every setting of a waiting or
failed run is its routine's, read at launch: workflow, commit, tool,
timeout length, group. The run keeps only what is its own: its tick, its
title, the window its timeout counts from that tick, and its place in its
group's line. Discard and run now remain, since they change whether and
when it runs, not what. Today a run is an ordinary queued entry that
anyone, an agent included, may edit; that ends. A waiting run also stops
keeping the settings it was queued with and takes up its routine's edits,
which is the visible change.

## Secrets

A revision names the run secrets it gets, beside its graph, as a GitHub
Actions workflow names `${{ secrets.X }}`. There is no separate grant:
naming a secret is an edit, so adding one makes a new revision, and an
earlier revision keeps the names it had. Anything may launch a workflow
whose revision names secrets (a routine, a site, `yaac workspace create
--workflow`, `yaac-mama`), since launching what a person made changes only
when it runs, not what.

**Only a person's revision gets its secrets.** A revision records whether a
person or an agent made it, and an agent's gets none of the secrets it
names. An agent may not edit a workflow whose current revision names
secrets, since its revision would replace a working one with an inert one.
An edit that names secrets is compare-and-set on the revision the person
was shown, because the rest of the graph is copied from it: without the
check, an agent's edit in between would be vouched for unseen.

**Commits.** A revision runs what the repository holds at a commit, so the
commit is checked too. The workflow keeps its **approvals**: commits, and
branches whose tip it may run on. A person's action approves the commit or
branch it names, and an agent's never does:

- A person setting up or editing a routine approves its commit, or its
  branch. Every agent of the project can push to a branch with the
  project's git credential, so the webapp and CLI say so as they save one.
- A person launching it by hand, in the webapp or with the CLI, or
  deploying a site, approves its commit.

There is no verb that approves on its own, so nothing is approved without
being run. An agent's routine or launch of a workflow that names secrets, at a commit
or branch not approved, is refused at once. Nothing ever waits for an
approval. Approvals reach only the current revision, and every (revision,
commit) pair that ran with its secrets is recorded (`workflow_runs`) and
allowed from then on. So after an edit, reruns and replacements of what ran
keep their secrets, while a commit or branch approved later reaches only
the current revision.

The launch check: a non-interactive launch (or a site's release) of
revision R at commit C gets the secrets R names if a person made R, and
either R is current and C is approved or the tip of an approved branch, or
(R, C) is recorded. A routine's run makes this check at each tick, so an
agent's routine on a workflow a person later gave secrets, at a commit no
person approved, fails with a launch error, as any broken routine does. Nothing else is checked: not who started it, nor through which
path. A launch that fails the check is refused rather than run without the
secrets, which would only fail later and less clearly, or run an app
without its key; a graph meant to run without them belongs in a workflow
that names none. An interactive launch, such as `rerun --interactive` to
debug a failed run, never gets secrets and is not refused: it opens
without them.

**Values are read at launch**, as GitHub Actions reads a secret when each
job starts, re-runs included. A rotated value reaches every launch that
names it, an earlier revision's rerun or replacement included, so a new key
reaches production without a deploy. A deleted secret fails the launch of a
revision that names it, rather than running it without.

**Revoking.** Approvals and recorded pairs are never taken back, and
revisions are immutable, so a secret taken out of the current revision
still reaches the recorded pairs of earlier ones that name it. To cut
those off, delete the secret, which fails every launch that names it, or
rotate it, which leaves them running with a value worth nothing to a leak
before the rotation.

## Lifecycle

- A workflow named by a routine or site cannot be deleted, like a volume a
  site names. A project's `init` workflow cannot be deleted.
- A revision is kept while a workspace, a routine run's record, a release
  or a recorded pair names it, or it is current; then it is collected.
- A site edit stays refused while a deploy runs, and a deploy pins its
  revision when it starts.

## Schema

- `workflows` (id, project, name, current revision), unique (project, name).
- `workflow_revisions` (id, workflow or null, graph, secret names, created
  at, made by a person or an agent).
- `workflow_approvals` (workflow, a commit or a branch).
- `workflow_runs` (revision, commit): the pairs that ran with their secrets.
- `routines.workflowId`, `sites.workflowId`, `projects.initWorkflowId`;
  `workspaces.revisionId` and `queued_workspaces.revisionId` for what a
  workspace or an entry not from a routine runs.

The five inline columns go. A drizzle migration turns each graph into a
revision, gives each routine and site a workflow named after it (suffixed
where names clash), and each project an `init` workflow. Done in SQL in
the migration, it leaves no code for older installs, so no entry in
docs/legacy-compat-shims.md.

## Run secrets

The run-secret store stays (`project_run_secrets`, its value surfaces in
`yaac config env` and Project Config). Its `siteIds` and `routineIds` give
way to the names on revisions, and the rules the launch check replaces go: the routine
match in `routineRunSecrets`, the refusal of agent edits to a routine
with run secrets, the pinned-commit requirement on routines, and reruns
getting none.

## Surfaces

- **CLI**: `yaac workflow create|edit|list|show|delete <project> <name>
  [--file <path>] [--secret NAME...]`; `--workflow <name>` on
  `workspace create`, `routine create|edit` and `site create|edit`, beside
  `--steps`.
- **yaac-mama**: `--workflow` where it takes `--steps`, and `workflow
  list|show`. Its edits are held to the `--steps` ceiling, refused on a
  workflow whose current revision names secrets, and name none themselves.
  Nothing it does approves.
- **Webapp**: a Workflows section in Project Config with each workflow's
  revisions, the secrets each names and its approvals, and a workflow
  picker in the routine, site and create forms, which warns as it saves a
  routine on a branch.
- **API**: routes for the above, each with a row in `test/api/route-matrix.ts`.

# Workflows

A **workflow** is a project's named step graph (docs/workspace-steps.md),
stored by yaac rather than in the repository. Routines, sites, queued
entries and workspaces name a workflow instead of each holding a copy of a
graph, and run secrets (docs/project-config.md "Run secrets") are granted
to a workflow rather than to the sites and routines that launch it.

Today a graph is copied inline into five columns: `projects.initSteps`,
`routines.steps`, `sites.steps`, `queued_workspaces.steps` and
`workspaces.startSteps`. With no identity, a run secret can only be
granted to whatever holds a copy, and every path that copies one needs a
rule of its own: a queued run of a routine gets its secrets only while it
still matches the routine, an agent may not edit a routine that has them, and
a rerun gets none. Workflows replace those rules with one check at launch.

Workflows are not versioned with the code. Keeping the graph in the
repository, as GitHub Actions does, would make one commit identify both,
but it would also make every branch able to rewrite the graph a grant
covers.

## Workflows and revisions

A workflow is a row (project, name) whose content lives in immutable
**revisions**. An edit adds a revision and moves the workflow's `current`
pointer to it; a revision is never changed and never shared between
workflows. Reverting is an edit, which makes a new revision with the old
content.

A create that brings its own graph (`--steps ci.json`) makes a revision
that belongs to no workflow. It runs as today, and is never granted.

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

## Grants

A **grant** gives a set of run secrets to one workflow, with a **commit
rule**: the commits it may run on. Anything may launch a granted workflow
(a routine, a site, `yaac workspace create --workflow`, `yaac-mama`), since
launching what a person approved changes only when it runs, not what.

A grant covers (revision, commit) pairs:

- **The current revision** gets it on any commit the commit rule allows.
- **An earlier revision** gets it only on the exact commits it already
  launched on with the grant. A commit approved later, a newly pinned one,
  or a branch's new tip never reaches an earlier revision.

Each launch that is handed the secrets records its pair and the secret
names it got (`workflow_grant_runs`), which is how an earlier revision's
commits are known. So after an edit, reruns and replacements of what ran
keep their secrets, and no earlier revision runs on new code with them.

**Values are read at launch, names are bounded by the pair.** As GitHub
Actions reads a secret by name when each job starts, re-runs included:

- A secret's new value reaches every launch that gets the secret, an
  earlier revision's rerun or replacement included, so a rotated key
  reaches production without a deploy.
- A secret taken off the grant, or deleted, reaches no launch.
- A secret added to the grant reaches only the current revision. An
  earlier revision gets at most the names its recorded pair got.

A launch gets a grant's secrets when it is non-interactive (or a site's
release), its pinned revision is the workflow's current one and its commit
satisfies the rule, or its (revision, commit) pair is recorded. Nothing
else is checked: not who started it, nor through which path.

**Edits under a grant.**

- A person's edit of a granted workflow makes a current revision the grant
  covers, since they vouch for it.
- An agent may not edit a granted workflow. It may edit an ungranted one;
  a person who grants it later grants what it then holds.
- Granting is compare-and-set on the revision the person was shown, so an
  agent's edit between the person reading the workflow and granting it is
  refused rather than granted unseen.
- Revoking drops the grant and its recorded pairs. A grant made again
  covers only the then-current revision.

**Commit rules.**

- **Approved commits**: pinned ahead, or approved one at a time. A
  routine's run of the current revision whose commit is not approved waits
  for a person to approve the commit it resolved to (the webapp shows it,
  as GitHub's required reviewers do), which adds that commit to the
  grant's approved commits. This is how a routine on a branch gets
  secrets. Any other launch at a commit not approved runs without the
  secrets and asks no one, so an agent cannot raise approval prompts.
- **A branch's tip**, opt-in, for a branch the user trusts (one the
  project's git credential cannot push to). Every agent of the project can
  push with that credential, so this is the user's risk to take.
- A site's deploy approves the commit it deploys, since only the site's
  owner, while an admin, deploys.

## Lifecycle

- A workflow named by a routine or site cannot be deleted, like a volume a
  site names. A project's `init` workflow cannot be deleted.
- A revision is kept while a workspace, a routine run's record, a release
  or a recorded grant pair names it, or it is current; then it is
  collected.
- A site edit stays refused while a deploy runs, and a deploy pins its
  revision when it starts.

## Schema

- `workflows` (id, project, name, current revision), unique (project, name).
- `workflow_revisions` (id, workflow or null, graph, created at, created by
  a person or an agent).
- `workflow_grants` (workflow, run secret names, commit rule, the revision
  it was granted at).
- `workflow_grant_runs` (grant, revision, commit).
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
way to grants, and the rules the grant check replaces go: the routine
match in `routineRunSecrets`, the refusal of agent edits to a routine
with run secrets, the pinned-commit requirement on routines, and reruns
getting none.

## Surfaces

- **CLI**: `yaac workflow create|edit|list|show|delete <project> <name>
  [--file <path>]`, `yaac workflow grant <project> <name> --secret NAME...
  [--commit <sha>...] [--branch <name>]`, `revoke`, `approve <run>`;
  `--workflow <name>` on `workspace create`, `routine create|edit` and
  `site create|edit`, beside `--steps`.
- **yaac-mama**: `--workflow` where it takes `--steps`, and `workflow
  list|show`. Its edits are held to the `--steps` ceiling and refused on a
  granted workflow; it has no grant, revoke or approve.
- **Webapp**: a Workflows section in Project Config with each workflow's
  revisions and grant, an approval prompt for a waiting run, and a workflow
  picker in the routine, site and create forms.
- **API**: routes for the above, each with a row in `test/api/route-matrix.ts`.

## Open questions

- Whether a grant names its secrets, or a secret names its workflows.
  Named on the grant, one approval covers one workflow's whole set.

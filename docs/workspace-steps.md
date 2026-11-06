# Workspace steps, logs and non-interactive workspaces

A **step** is a named list of shell commands that a workspace runs in a tmux
window of its own, like one job of a GitHub Actions workflow. Steps form a
graph through `needs`. A workspace gets its steps from one of three places:

| Source | Example |
|---|---|
| The project's init steps | every workspace installs, builds and starts its dev server |
| A create that brings its own graph instead | `yaac workspace create --steps ci.json --non-interactive --wait` |
| A step added to a running workspace | `yaac-mama create --workspace "$YAAC_WORKSPACE_ID" --run 'pnpm test' --needs build --wait` |

A create runs the project's init steps, or brings its own graph, which
replaces them entirely (`--no-steps` for none). There are no named graphs to
pick from: a reusable CI graph lives in a file in the repository, versioned
with the code, and a routine stores the graph it was given until
`routine edit --steps` changes it. Steps run commands only; an agent is a
session, which opens beside the steps.

A workspace is **interactive**, running until someone or its timeout stops
it, or **non-interactive**: it runs one graph on one commit, untouched,
records an outcome and stops (see below).

## The step shape

```jsonc
{
  "install": { "run": "pnpm install" },
  "db":      { "run": "postgres -D .pg", "service": true, "ready": "pg_isready" },
  "build":   { "run": ["pnpm build", "pnpm build:docs"], "needs": ["install"] },
  "server":  { "run": "pnpm start --port $YAAC_PORT_3000", "service": true,
               "needs": ["build", "db"], "ready": "curl -sf localhost:$YAAC_PORT_3000/health" }
}
```

- **`run`**: a command or a list of them. A list runs in order in **one
  shell**, stopping at the first failure, which fails the step. The shell is
  the workspace's `$SHELL` when it is a POSIX-family one (bash, zsh, sh,
  dash, ksh), as init commands always ran, so zsh still reads `~/.zshenv`;
  otherwise (fish, say) bash, else sh. One shell, not one per command as GitHub does, so a
  `cd` or `export` carries to the commands after it. Steps never share a
  shell, so a step that needs another's exports repeats them.
- **`needs`**: steps that must succeed first, or, for a service, be ready. A
  step whose need fails, is cancelled or is skipped is itself `skipped`;
  branches of the graph that do not depend on it carry on.
- **`service`**: the step is long-running. Its last command is the process
  and the commands before it its setup. It never succeeds: it is `ready` once
  its `ready` check passes (at once with none) and `failed` if it exits.
- **`ready`**: a service's check, run every two seconds until it exits 0.

A name is letters, digits, `-` and `_`. It may not be an agent tool's name or
start with one and a `-` (a session's window looks like that, and the log
hook leaves it unlogged), `yaac`, or a scratch shell's (`shell`, `shell-2`),
whose window a step's launch would kill. `parseStepGraph` in
`@yaac/shared/steps` is the one parser for every source; it also refuses a
`needs` naming no step, and a cycle.

## Init steps

A project's init steps are a column of its row (`projects.initSteps`), like
its scratch dirs. Set them with
`PUT /project/:projectId/init-steps`, `yaac config init-steps <project>
[--file <path> | --none]`, or Settings → Project Config → Init steps.

## Running a step

`reconcileSteps` (`#domain/workspaces`) runs in the reconcile loop, triggered
by the workspace set changing and by any workspace's window listing changing
(the `windows` trigger). For each running workspace whose setup is done (its
keeper renamed), it records how each running step stands, skips the steps a
failure blocks, and opens a window for each pending step whose needs are
met. A step added, rerun or cancelled through the API runs a pass at once.

To open one, the server writes the step's script into the life's log dir,
where the workspace sees it at `WorkspacePaths.terminalLogDir`, and opens the
window running it, `remain-on-exit` so the dead pane keeps its exit status.
The script (`stepScript` in `#runtime/terminals`) appends
`start <i> <time>` and `end <i> <status> <time>` to `<step>.events` around
each command, which the webapp may show as progress. A service's script
starts its ready check in the background before its last command; when it
passes, the check sets the window option `@yaac-step-ready`. An EXIT trap
writes the `end` of a command that exits the script itself; a command that
`exec`s another process writes none, since the script is gone.

The log dir is writable by the workspace (under k8s, by any of its pods), so
the server only touches it as a confined root (`openTerminalLogs`, the same
`no-links` policy as `acp/`, docs/workspace-storage.md "Sandbox-writable
dirs"): a link or FIFO planted there is neither served nor written through.

The server learns how a step stands from the status watcher's window
listing, which carries each window's exit status (`#{pane_dead_status}`) and
`@yaac-step-ready`. No tmux notification reports a pane dying or an option
changing, so each is turned into a rename of the window to its own name,
which control mode reports as `%window-renamed` and the watcher re-lists on:
the ready check renames its window, and a `pane-died` hook renames any
window whose pane died. A step's window that vanishes for a minute after it
opened was killed by hand, and the step is `cancelled`.

Rows are `workspace_steps`, keyed by workspace and name. Observed changes
arrive as `step-changed` events, applied only to the life they were seen in,
and never to a settled step.

## Lives

A workspace's **life** is one run of it, from a start or restart to its stop
(`workspaces.lifeStartedAt`). Each life starts its graph afresh, steps that
succeeded before included: a stop empties the scratch dirs and the
checkout's ignored files, so what `install` or `build` made is gone. The
graph is the one its create brought (`workspaces.startSteps`), else its
project's current init steps. A step added to a running workspace runs once:
one not settled at a stop becomes `interrupted`. A step whose output survives
a stop checks for it itself (`test -f model.bin || ./download`).

A prewarmed spare runs no steps; a claim starts the life with the project's
init steps. A create that brings its own graph, or starts at a commit, never
claims one.

## Start point and base branch

Every workspace records the commit its checkout was created at
(`workspaces.startCommit`). A create names at most one of a branch and a full
commit id (40 hex digits, or 64 in a SHA-256 repository). One at a branch
starts at its tip, and the branch is its **base branch**: what the changes
view diffs against, what `yaac-mama set-base` moves, and what a queued child
forks from. One at a commit has no base branch until `yaac-mama set-base`
gives it one; meanwhile its changes are diffed against its start commit, a
restart whose checkout is gone recreates it there, and a queued child starts
there too. A commit the main clone lacks is fetched by id
(`fetchCommit` in `#domain/git`), which GitHub serves for any commit
reachable from one of its refs; one origin cannot serve refuses the create.
Queued entries and routines take a commit the same way.

## Non-interactive workspaces

`--non-interactive` (`nonInteractive: true`) makes a CI run. It brings its
own graph, with a step that is not a service, and opens no session.

- **Nobody touches it while it runs, only stops it**, so its outcome means
  "this graph passed on this commit". `assertInteractive` refuses, with
  `CONFLICT`, every surface that could change it, for people and agents
  alike: added steps, step rerun and cancel, sessions, terminals, pty and
  port-forward attaches, workspace hostnames, egress allow-host, file
  writes and pasted images.
  Reads stay open. This binds yaac's surfaces, not the machine: the host user
  under containerless, or a cluster admin with `kubectl exec`, can still
  reach its tmux. Its steps are followed through their logs.
- **It stops when done.** Once every step that is not a service has settled,
  `stepsOutcome` records `succeeded` if every step succeeded and `failed`
  otherwise, and the workspace stops; its services stop with it. A hung step
  runs until the workspace's timeout, so a routine that starts these should
  set one.
- **It is rerun, never restarted**, since a restart would reuse a checkout
  the run may have changed. A rerun (`POST /workspace/rerun`,
  `yaac workspace rerun`, `yaac-mama rerun`) is a new non-interactive
  workspace with the same graph at its start commit, linked by `rerunOf`;
  with `--interactive`, an interactive workspace there with the graph as its
  start steps, to reproduce a failure in.

`--wait` on a create or rerun blocks until the outcome and exits non-zero
unless it succeeded. `yaac-mama create --workspace … --run … --wait` waits
on the step it adds instead, until it settles (a service until ready),
exiting with its code; `yaac workspace step add` has no `--wait`.

## Site releases

A public site's release (docs/public-sites.md) runs its site's graph and is
locked by `assertInteractive` the same way, but serves until its site stops
it. Two things differ in its steps:

- **`volume` in `needs`** names no step: it counts as succeeded once the
  release holds its volume's lease, which a deploy hands it after the old
  release is gone. Only the steps that wait on it, directly or through
  another step, get `YAAC_VOLUME_DIR`.
- **A service of the release serving its site that exits opens again**,
  after a backoff from 1 s to 5 min that resets once it ran 10 minutes, its
  dependents left running and its log appended to. Any other release's
  service that exits fails, which fails its deploy.

## Permissions

A command a caller hands a workspace runs as whatever the workspace runs as,
so through `yaac-mama` a create, queue or routine with `--steps`, and `--run`
on any workspace, the caller's own included, are refused unless the caller's
ceiling is `bypass` (docs/permission-modes.md). `--no-steps` is always
allowed, and the project's own init steps run in every create, being the
user's setting. The webapp and CLI are the user's and have no ceiling.

## Logs

Every window that is not a session's is logged: steps, the webapp's
terminals, and windows opened by hand inside tmux. A session's is not: a
TUI's output is full-screen redraws, and its conversation is already
recorded.

Each life sources a tmux config the server writes into its log dir
(`lifeHooksConfig`), which names the dir in the global option
`@yaac-log-dir` and sets an `after-new-window` hook piping every new window
whose name is not a session's into `workspace-bin/yaac-log-writer`. The
writer appends to `<window>.log` and at 64 MiB moves it to `<window>.log.1`,
replacing the one before, so a window that runs for days holds at most twice
that.

The dir is `terminalLogDir` (`global/projects/<project>/logs/<workspace>`),
one subdir per life named after its start time, mounted in a pod at
`/home/yaac/.yaac-logs` and used where it is under containerless. The server
reads it from the host, so a stopped workspace's logs read the same
(`GET /workspace/:id/logs`, then `GET /workspace/:id/logs/:life/:file` from a
byte offset, which a client following a running log asks again from;
`yaac workspace logs`). Its project's agents read the end of a step's log
through `yaac-mama logs`, at most 4 MiB of it, and only once the step has
started: the log file is named after the window, and the server clears
and recreates a step's file as it starts the step, so before then a window
opened by hand under the step's name would be writing it. A window opened
by hand under the name of a step that has already run appends to that
step's log. Every life's logs are kept until the workspace is
deleted, and nothing else bounds the total: rotation caps each window of
each life, not how many there are, so deleting the workspace, or the
project's stopped-workspace retention, is the only cleanup. A shell's log
holds whatever it printed, which under containerless can be the user's real
credentials; the logs routes are the owner's alone (docs/multi-user.md), and
the webapp's New shell says the shell is logged.

## The webapp

Step windows are not terminal tabs, and no step pane opens by itself. The
workspace bar lists running, pending, failed and cancelled steps one by one,
a failed one with its exit code; steps that succeeded or were skipped fold
into one "N done" entry. A step pane (`step:<name>`) shows the live window
while its step runs in an interactive workspace, and its log otherwise,
followed while it can still grow; one opened by hand stays open when its
step finishes. A stopped non-interactive workspace shows its outcome on its
row, its last run's logs, and Rerun.

## Where things live

| Concern | Path |
|---|---|
| Step shape and parser | `packages/shared/src/steps.ts` |
| Step rows | `packages/server/src/db/step-store.ts` |
| Reconcile, add, rerun, cancel, the non-interactive lock | `packages/server/src/domain/workspaces/steps.ts` |
| Logs | `packages/server/src/domain/workspaces/logs.ts`, `workspace-bin/yaac-log-writer` |
| Scripts and hooks | `packages/server/src/runtime/terminals/steps.ts` |
| Init steps | `packages/server/src/domain/projects/init-steps.ts` |
| Rerun | `prepareRerun` in `packages/server/src/domain/workspaces/restart.ts` |
| Webapp | `packages/frontend/src/components/StepsBar.tsx`, `StepPane.tsx`, `StepLog.tsx`, `WorkspaceLogs.tsx` |

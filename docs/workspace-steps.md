# Workspace steps, logs and non-interactive workspaces

A **step** is a named list of shell commands that a workspace runs in a tmux
window of its own, like one job of a GitHub Actions workflow. Steps form a
graph through `needs`. A workspace gets its steps from one of these:

| Source | Example |
|---|---|
| The project's init workflows | every workspace installs, builds and starts its dev server |
| A create that brings its own graph instead | `yaac workspace create --steps ci.json --non-interactive --wait` |
| A step added to a running workspace | `yaac-mama create --workspace "$YAAC_WORKSPACE_ID" --run 'pnpm test' --needs build --wait` |
| A named workflow (docs/workflows.md) | `yaac workspace create --workflow ci --non-interactive --wait` |

A create runs the project's init workflows, or brings its own graph, which
replaces them entirely (`--no-steps` for none): a file (`--steps`), or a
named workflow (`--workflow`). Every graph is stored as a workflow, once per
content, and only a named workflow may be given run secrets; routines and
sites run named workflows only (docs/workflows.md). Steps run commands only;
an agent is a session, which opens beside the steps.

## Workflow names

Every step belongs to a workflow, and every workflow in a workspace has a
name there: a named workflow its own, and an anonymous one (a create's
`--steps`, a `step add --run` or `--steps`) a short random one such as
`k3f9`, unique among the workspace's workflows and the project's workflow
names. A create's is kept for every life of the workspace and copied by a
rerun, so logs line up. The name belongs to the step rows, not to the
stored workflow, which is one row per content: running `pnpm test` ten
times is one workflow under ten names. A step added with `--run` and no
`--name` is called `run`.

A step's **full name** is `<workflow>.<step>`, such as `web-init.install`.
It names the step's window, its pane in the webapp (`step:<full name>`), its
log and events files (`web-init.install.log`), and is what every command
takes. So two workflows of one life may both have an `install`. Commands
that address a step of a running workspace (`step rerun`, `step cancel`,
`workspace logs`, `yaac-mama logs` and `status`, and `--needs` on `step add
--run`) also take a bare name while only one workflow of the life has that
step; graphs get no such lookup, so a typo in a stored graph is caught when
it is saved.

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
  branches of the graph that do not depend on it carry on. A bare name is a
  step of the same workflow, checked when the graph is parsed;
  `<workflow>.<step>` is a step of another workflow of the same life,
  checked when the step is placed in a life, since a stored workflow cannot
  know what runs beside it. A launch or `step add` is refused when such a
  need names nothing there, or closes a cycle through several workflows;
  an init workflow's step is `skipped` instead, since which init workflows
  start depends on the workspace's repos.
- **`service`**: the step is long-running. Its last command is the process
  and the commands before it its setup. It never succeeds: it is `ready` once
  its `ready` check passes (at once with none) and `failed` if it exits.
- **`ready`**: a service's check, run every two seconds until it exits 0.

A step's name and a workflow's follow one rule: letters, digits, `-` and
`_`, starting with a letter or digit, at most 48 long. Neither can hold the
`.` that joins them, so a full name splits one way, and a step's window
always holds a `.`, which no session's, shell's or keeper's does: a step may
take any name, an agent tool's or `shell` included. `parseStepGraph` in
`@yaac/shared/steps` is the one parser for every source; it also refuses a
bare `needs` naming no step of the graph, and a cycle within it.

## Where a step starts

A step starts in the checkout of the one repo its workflow names, at the
workspace root or in its folder; in the workspace root when it names
several; and in the workspace's cwd when it names none (docs/workflows.md
"Repos"). The directory is read off the step row's workflow and the
workspace's checkouts when its window opens. Neither changes while the
workspace lives, so a rerun starts where the step did.

## Init workflows

A project's init steps are its init workflows: named workflows marked
`init` (docs/workflows.md "Init workflows"). A workspace that brings no
graph of its own starts, at each life, every init workflow whose repos it
has, each under its name, and its create's progress says which it skipped
for lack of a repo. Mark them with `yaac workflow create|edit --init`, set
the whole list with `yaac config init-workflows <project> [workflows...]
[--none]` (`PUT /project/:projectId/init-workflows`), or in Settings →
Project Config → Init workflows.

## Running a step

`reconcileSteps` (`#domain/workspaces`) runs in the reconcile loop, triggered
by the workspace set changing and by any workspace's window listing changing
(the `windows` trigger). For each running workspace whose setup is done (its
keeper renamed), it records how each running step stands, skips the steps a
failure blocks, and opens a window for each pending step whose needs are
met. A step added, rerun or cancelled through the API runs a pass at once.

To open one, the server writes the step's script into the life's log dir,
where the workspace sees it at `WorkspacePaths.terminalLogDir`, and opens the
window running it. The script (`stepScript` in `#runtime/terminals`) first
sets `remain-on-exit` on its own pane (`$TMUX_PANE`), so the dead pane keeps
its exit status, then appends `start <i> <time>` and
`end <i> <status> <time>` to `<full name>.events` around
each command, which the webapp may show as progress. A service's script
starts its ready check in the background before its last command; when it
passes, the check sets the window option `@yaac-step-ready`. An EXIT trap
writes the `end` of a command that exits the script itself; a command that
`exec`s another process writes none, since the script is gone.

**tmux addresses a step's window by id, never by name.** tmux reads a `.`
in a target as the pane separator: `-t =yaac:=web-init.install` resolves to
a window named `web-init` if there is one, with no error. So killing a
step's window (a cancel, a rerun's dead window) finds its id by name in the
window listing first, and `windowTarget` refuses a name holding a `.`.
Reading goes the other way and is unaffected: the watcher's listing carries
each window's name and id, and the webapp attaches by id.

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

Rows are `workspace_steps`, keyed by workspace, workflow name and step name,
each with the stored workflow it came from. Observed changes arrive as
`step-changed` events, applied only to the life they were seen in, and never
to a settled step. A row of a life started before steps had workflows has an
empty workflow name and is known by its bare name, under which its window
and logs run (docs/legacy-compat-shims.md).

## Lives

A workspace's **life** is one run of it, from a start or restart to its stop
(`workspaces.lifeStartedAt`). Each life starts its graph afresh, steps that
succeeded before included: a stop empties the scratch dirs and the
checkout's ignored files, so what `install` or `build` made is gone. The
graph is the workflow its create brought (`workspaces.workflowId`, under
`workflowName`), else its project's current init workflows that apply to its
repos. The workflows of one life are independent graphs started together.
A step added to a running workspace runs once:
one not settled at a stop becomes `interrupted`. A step whose output survives
a stop checks for it itself (`test -f model.bin || ./download`).

A prewarmed spare runs no steps; a claim starts the life with the project's
init workflows that apply to the claim's selection, which is the one the
spare was warmed with. A create that brings its own graph, or starts at a
commit, never claims one.

## Start point and base branch

Every workspace records the commit its checkout was created at
(`workspaces.startCommit`). A create names at most one of a branch and a full
commit id (40 hex digits, or 64 in a SHA-256 repository). One at a branch
starts at its tip, and the branch is its **base branch**: what the changes
view diffs against, what the Commits pane's picker and `yaac-mama set-base`
move, and what a queued child forks from. One at a commit has no base branch
until one of those gives it one; meanwhile its changes are diffed against its start commit, a
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

A non-interactive workspace, or a site's release, gets the run secrets its
workflow names (docs/workflows.md) when every repo it starts with is at a
commit that passes, and is refused otherwise. A rerun runs the same workflow
under the same name, so it gets them again at the commits it reruns.

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
so through `yaac-mama` a create or queue with `--steps`, and `--run` on any
workspace, the caller's own included, are refused unless the caller's
ceiling is `bypass` (docs/permission-modes.md). `--no-steps` is always
allowed, and so is `--workflow`, a named workflow being written through the
user's surfaces; the project's own init workflows run in every create, being
the user's setting. The webapp and CLI are the user's and have no ceiling.

## Logs

Every window that is not a `tui` session's is logged: steps (under their full
names), the webapp's
terminals, windows opened by hand inside tmux, and `acp` sessions' windows,
which hold acpd's own lines (the agent's exits and restarts) and the
adapter's whole stderr. The chat pane offers that log once its agent exits,
and the listing below leaves it out (`isAgentWindow`), since it only
explains an exit; it is still read by name, as `yaac workspace logs <id>
<window>` does. A `tui` session's is not logged: its output is
full-screen redraws, and its conversation is already recorded.

Each life sources a tmux config the server writes into its log dir
(`lifeHooksConfig`), which names the dir in the global option
`@yaac-log-dir` and sets an `after-new-window` hook piping every new window
whose name is not a session's (a step's holds a `.`, so a workflow named
after a tool is still logged) into `workspace-bin/yaac-log-writer`; an
`acp` session's window is piped the same way by the command that opens it
(`buildWindowsExec`), and the pipe outlives a resume's respawn. The
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
credentials, and an `acp` session's the adapter's routine log lines and,
on its error paths, raw protocol messages that can carry prompt text or
tool payloads; the logs routes are the owner's alone (docs/multi-user.md), and
the webapp's New shell says the shell is logged.

## The webapp

Step windows are not terminal tabs, and no step pane opens by itself. The
workspace bar groups steps under their workflow, and lists running, pending,
failed and cancelled steps one by one, a failed one with its exit code;
steps of a workflow that succeeded or were skipped fold into one "N done"
entry. The logs view groups its tabs the same way. A step pane
(`step:<workflow>.<step>`) shows the live window
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
| A life's start workflows | `startStepsOf` in `packages/server/src/domain/workspaces/life.ts` |
| Rerun | `prepareRerun` in `packages/server/src/domain/workspaces/restart.ts` |
| Webapp | `packages/frontend/src/components/StepsBar.tsx`, `StepPane.tsx`, `StepLog.tsx`, `WorkspaceLogs.tsx` |

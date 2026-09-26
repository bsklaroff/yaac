# Pane-reported sessions

## Problem

Under `tui`, working out which conversation runs where takes four steps. A
`SessionStart` hook appends a line to a per-worktree log. The registry folds
that log into rows. It then joins the rows' pane ids against the live pane set.
Then it works out which conversation a pane's pushed model belongs to. Under
`acp` the same answer is one field: the live agent set already carries each
conversation's id (`LiveAgent.agentSessionId`). So the registry has two
branches that look nothing alike, and the `tui` one is most of its code and
most of its comments.

Most of that code exists to keep the log honest across pod lives, not to find
conversations:
- **`lifeLogBytes`.** A column, an event field (`WorktreeLifeStarted.logBytes`)
  and a byte boundary. Together they tell this life's lines from a previous
  pod's, because tmux pane ids restart at `%0` and an old line would otherwise
  name a live pane.
- **The shrunk-log tripwire.** It covers a log shorter than its recorded
  boundary.
- **The stale-handle windows** described in `reconcileWorktreeAgentSessions`:
  the race between reading the offset and applying the fold, and the extra
  window it can freeze.
- **`paneModels`.** It rebuilds "which conversation owns this pane now" from
  sightings, rows and a single-link fallback, only to attribute a model the
  pane already pushed.
- **The pinned-session branch.** It records `--session-id <worktree id>` when
  no hook has spoken, exempts opencode, and carries a comment warning that it
  deactivates every other session if a second one ever appears.
- **Teardown timing.** A conversation begun within a resync of a stop can miss
  the freeze, because nothing pushes a log append; a fold runs only on a
  live-set change or the resync.

Model and permission mode already travel the simpler way. The reporter sets a
pane option (`@yaac-model`, `@yaac-permission-mode`), tmux pushes it over the
control-mode subscription the status watcher already holds, and it arrives
on `LiveAgent`.

## Design

**Put the conversation on the pane too.** `yaac-agent-links` stops appending to
a log. It sets `@yaac-session` on `$TMUX_PANE` instead, to `<id>|<project-relative
transcript>`, using the same `tmux set-option -p` call `yaac-agent-report`
makes. The tui driver subscribes to it beside the model and mode, filtered
inside the format the same way. It then publishes `agentSessionId` and
`transcriptPath` on `LiveAgent`, exactly as the acp driver does.

The session option is subscribed on **every** pane of the worktree's tmux
server, not only on the agent windows the status watcher follows today
(`syncPanes`). Otherwise a conversation started by hand in a scratch shell
would never be seen. Today's log does record one of those (inactive, since its
pane is not an agent window), and this keeps that.

The registry then has one path for both modes:

1. For each live agent with an id, report it (`sessions-discovered`, with its
   pane, transcript and model).
2. Report the live set as the active set (`sessions-active`).
3. Follow reported modes (`followReportedModes`).

The rest follows from that:
- **A pane option dies with its pane**, and a new pod's tmux starts with none.
  So a stale handle cannot exist, and the life boundary, the tripwire and the
  per-line fold go.
- **The model needs no attribution.** The pane that pushed it names its own
  conversation in the same live agent.
- **A new conversation is a live-set change**, which already triggers a
  reconcile. So `reconcileBeforeTeardown`, the sweep stop and restart run
  before freezing the active set, goes too.
- **codex's resume record** (the launch running `yaac-agent-links … <id>`)
  becomes the launch setting the option itself.

**codex's posture moves into the driver.** codex's title cannot carry its
permission mode (neither the `permissions` nor the `approval-mode` item
renders there in 0.156.1), so the rollout stays the source. But the tui driver,
not the registry, reads it. For each codex pane whose `@yaac-session` names a
rollout, it reads `getCodexPermissionMode` on its status tick and publishes
the result as `reportedMode`, counting only entries written after the pane
started. That makes codex's first report behave like everyone else's. It
deletes `followRolloutModes`, its `transcriptModes` cache and the special case
for the first reading in a new life.

**Every tool reports.** opencode's plugin (`OPENCODE_REPORT_PLUGIN`) already
reports model and agent. It sets `@yaac-session` from `session.created` or
`session.updated` too. pi's extension does the same from its session events.
Then no tool depends on the `--session-id` pin, and the pinned branch
(`links.length === 0`) and opencode's exemption go. **To verify against the
pinned opencode and pi**, which drop unknown events silently.

## What goes

- `domain/worktrees/session-starts.ts`, and its tests.
- `foldSightings`, `paneModels` and the pinned-session branch in the registry.
  The `tui` branch becomes the `acp` one.
- The `lifeLogBytes` column (a migration), `WorktreeLifeStarted.logBytes`, and
  the boundary handling in `recordWorktreeLife`.
- The session-starts log's File mount (k8s), its symlink (containerless), its
  pre-creation, its delete, and `worktreeSessionStartsPath`.
- `followRolloutModes` and `transcriptModes`.
- Most of `docs/worktree-storage.md`'s section on the log. What remains is one
  paragraph on the pane option.

## Trade-offs

- **History while no server watches.** While the server is up, every change
  to a pane's option is pushed, and discovery only ever adds rows. So a
  `/clear` leaves both conversations recorded: the old one inactive, the new
  one active on the pane. So does a conversation started in another window.
  What a pane option cannot give is history the server was not there for: it
  holds only the pane's current conversation. A conversation that starts and
  is replaced entirely while no server runs never becomes a row. A restart
  still resumes the right one, because that is the one on the pane. The log
  keeps every conversation ever started, so this is a real loss for a history
  view.
- **Coalescing.** tmux pushes subscription changes at most once a second, so
  two `/clear`s inside a second report only the second. Same consequence as
  above.
- **Forgery** is unchanged. Anything in the workspace could already append to
  the log, and it can set the option instead. The format filter bounds what it
  can say, as it does for the model.

## Transition

The scripts are staged per worktree, so a worktree running when the server
upgrades keeps appending to a log the new server no longer reads, until it
restarts. For that window its conversations are invisible, and a stop freezes
an empty active set. Two options:
- **(a)** Keep reading the log, for panes that have no `@yaac-session`, until
  every worktree has restarted once. That is a dual-read shim and needs an
  entry in `docs/legacy-compat-shims.md`.
- **(b)** Accept it, and say so in the release notes.

(a) is safer, because a lost active set means a restart starts agents anew.

## Verification

- **Unit:** the tui driver publishes `agentSessionId`/`transcriptPath` from the
  option. codex's `reportedMode` comes from its rollout, counting only entries
  written after the pane started. The registry's single path covers both
  modes.
- **e2e-containerless:** the codex restart case this PR adds, unchanged. The
  stand-ins set the option through the real script. A `/clear` stand-in moves a
  pane to a new conversation, and both are rows, the old one inactive. A
  conversation started in a scratch shell window is recorded too.
- **k8s tiers** on a host with a cluster. The file mount and its removal are
  k8s-only.

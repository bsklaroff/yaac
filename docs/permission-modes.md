# Permission modes

How much a worktree's agent may do before it stops to ask. One enum,
`PermissionMode` in `@yaac/shared`, spelled per tool at launch:

| Mode | claude | codex | opencode | pi |
|---|---|---|---|---|
| `bypass` | `--permission-mode bypassPermissions` | `--yolo` | `OPENCODE_PERMISSION` all-allow | — |
| `auto` | `--permission-mode auto` | `--approve-for-me` | — | — |
| `accept-edits` | `--permission-mode acceptEdits` | *(its default preset)* | `OPENCODE_PERMISSION` edit=allow, bash=ask | — |
| `plan` | `--permission-mode plan` | `--sandbox read-only` | `--agent plan` | — |
| `manual` | `--permission-mode manual` | `--ask-for-approval untrusted` | `OPENCODE_PERMISSION` all-ask | — |

`buildAgentCmd` owns that table. Three things about it are worth knowing.

**codex splits the posture across two axes** — an approval policy and a
sandbox — so each mode picks the pair that adds up to it. `accept-edits`
carries no flag because it *is* codex's own default preset
(`workspace-write` + `on-request`), whose sandbox has network off; that is
what makes codex ask to escalate for anything reaching the network, rather
than yaac having to arrange it.

**opencode's posture is config, not flags** — it has no posture flag at all,
and its parser drops unknown flags silently, so inventing one would leave the
posture at whatever the defaults say. `OPENCODE_PERMISSION` takes the same
JSON as the config file's `permission` block and is read per process, which
is what makes it per-worktree — the `opencode.json` session create writes is
shared by every worktree in the project.

Two things about that JSON are load-bearing, because **getting either wrong
fails open rather than loudly**. Its schema is a plain zod object over
exactly `edit`, `bash`, `webfetch`, `doom_loop` and `external_directory` —
there is no top-level wildcard — and a plain zod object *strips* unknown
keys, so a posture spelled in any other key arrives as an empty one, which
opencode then fills with `edit: allow`, `webfetch: allow`,
`bash: {"*": "allow"}`. And the value has to survive the trip: the command is
embedded in `respawn-window '<cmd>'`, so it is double-quoted with escaped
inner quotes (a single quote would end the wrapper early, and bare `{...}`
would hit zsh brace expansion). Both are asserted in
`agent-command.test.ts`, the second by running the escaped string through a
real shell — string equality alone would happily lock in a value opencode
cannot read.

`bypass` states allow-everything rather than sending nothing, for the same
reason: `doom_loop` and `external_directory` already default to `ask`, so an
unstated bypass is not one, and a future default that tightens would quietly
stop meaning bypass.

**pi has no permission system at all**, by design — its tools execute
immediately and nothing prompts. It is therefore `bypass`-only, and create
refuses anything else rather than launch flags that do nothing. Closing that
gap means shipping a pi extension that denies or prompts on its blocking
`tool_call` event, not a change to the table above.

`SUPPORTED_PERMISSION_MODES` is the machine-readable version, and both the
refusal and the webapp's disabled tool rows read from it.

## Under `acp`, the answer is the adapter's

A posture is a launch flag for a TUI and an advertised session mode for an
adapter, and the adapters offer fewer — so the table above is the `tui` column
and `ACP_SUPPORTED_PERMISSION_MODES` is the other one:

| Mode | claude | codex | opencode | pi |
|---|---|---|---|---|
| `bypass` | `bypassPermissions` | `agent-full-access` | `OPENCODE_PERMISSION` all-allow | — |
| `auto` | `auto` | `agent` | — | — |
| `accept-edits` | `acceptEdits` | `read-only` | `OPENCODE_PERMISSION` edit=allow, bash=ask | — |
| `plan` | `plan` | — | the `plan` agent, over `session/set_mode` | — |
| `manual` | `default` | — | `OPENCODE_PERMISSION` all-ask | — |

Three things follow from it.

**codex loses two postures over ACP.** codex-acp collapses codex's approval ×
sandbox grid into three modes, and neither `plan` nor `manual` is among them.
A create asking for one is refused rather than nudged to a neighbour — the same
rule the TUI column follows, and the reason the refusal says "under acp": codex
plainly has plan mode, its adapter does not.

**opencode's postures do not travel as modes at all.** Its ACP "modes" are its
own agents (`build`, `plan`), so only `plan` is one; the rest ride
`OPENCODE_PERMISSION`, read from the environment by the same code the TUI uses.
`plan` deliberately carries no rules alongside it: opencode merges the
environment's permission config *over* the agent's own, so stating an all-ask
block there would turn plan's `edit: deny` into `edit: ask` — a weaker plan
mode, arrived at by trying to harden it.

**pi's asks are not permissions.** It has no permission system in either mode,
so no posture maps to a mode and none is sent (its `availableModes` are
thinking levels, and `session/set_mode` rejects anything else). What does arrive
on `session/request_permission` are its extensions' own questions — a choice a
person is being asked to make — so those are forwarded to the pane even under
`bypass`, where every other adapter's asks are answered for them. `bypass`
waives permission prompts; it does not answer questions.

A mode id a profile names but the adapter did not advertise is reported in the
pane as well as the log, and the conversation continues in whatever mode the
adapter is holding. Not fatal, because every launch-time floor is at least as
strict as what was asked (an adapter's own default asks about everything, and
codex's is `read-only`), but not silent either: the conversation is running
under a posture nobody chose, and the pane is the one place that is visible to
whoever chose.

## Resolution

`resolvePermissionMode` decides, in three rungs, most specific first:

1. what the request named (`--permission-mode`, the popover's dropdown),
2. what this project last had chosen (`projects.lastPermissionMode`),
3. `defaultPermissionMode` for this driver and tool — `bypass` where the
   worktree is sandboxed, `accept-edits` where it is not, and `bypass` for
   pi either way.

The middle rung is why the choice is persisted at all: a user who picks
`plan` once keeps getting it from the CLI, the webapp and the keyboard
shortcut alike, because all three land here. It lives on the project row
rather than in the browser so those three agree, and only an *explicit*
choice writes it — a defaulted create must not overwrite what a human
picked. The route is what records it, since only there is the choice known
to be a person's rather than a restart's or the spawn policy's.

A request naming a posture its tool lacks is refused rather than nudged to a
neighbour: the caller asked for a restraint, and quietly launching with a
weaker one is the failure mode worth being loud about. The remembered value
gets the opposite treatment — it was chosen for some other tool, so a tool
that lacks it falls through to its default.

The resolved answer is recorded on `worktrees.permissionMode`, because a
worktree outlives the request that made it: a restart must relaunch its
agents the way the user asked, not the way today's default would. A restart
therefore re-states the row's posture, which is neither remembered (it is
not a person choosing) nor refused when unsupported (a row written by a
different build would otherwise strand a checkout).

## How a conversation honors one

A `tui` agent gets its posture as a launch flag, and its own UI does the
asking. An `acp` conversation has no UI of its own, so yaac supplies both
halves — and the split is worth stating, because each half alone would be a
posture in name only:

- **The adapter is told**, over `session/set_mode`, once the handshake has a
  session to set it on. That is what decides which questions get asked at
  all — without it `accept-edits` would prompt for every edit, since the
  adapter's own default is to ask about everything.
- **The asks it still makes are forwarded** to the chat pane, where the user
  answers them. The served JSON-RPC request is held open, with no timeout: the
  agent is blocked until a person decides, and answering *for* them after some
  interval is exactly the auto-approval the posture exists to refuse.

`bypass` is the one posture yaac still answers itself, and it stays that way
even with the mode set: an adapter honors a `permissions.ask` rule the user
configured even with permissions skipped, and an adapter running as root
outside a sandbox does not offer `bypassPermissions` at all. Auto-granting
those is what makes bypass mean bypass wherever it runs.

Both directions of the ask are in acpd's record, so a pane attaching mid-ask
is shown the question and a `bypass` transcript reads back as the decisions
that were made. That is also what survives a dropped relay: nothing replays a
request, but the record names it, and the id it must be answered under is the
agent's own — so the connection that takes over can settle an ask it never
received. See docs/agent-modes.md.

One posture is *not* re-asserted: a reattach leaves a live adapter's mode
alone. Leaving plan mode is itself a permission ask whose options are mode
ids, so a user who accepted "yes, and auto-accept edits" moved the session to
`acceptEdits`; re-stating the row on the next relay hiccup would drag them
back. The row wins again at the next restart, which is where it is the durable
answer.

## One place a posture is not honored

**A prewarmed spare is only claimable for a create resolving to `bypass`.**
The spare's agent is already running, in that posture — claiming one for a
`plan` create would hand back an unrestrained worktree, and silently, since
the claim never rewrites the row. Cold-creating is the honest answer; it
costs the claim's saving, which is the price of the posture actually being
the one that was asked for.

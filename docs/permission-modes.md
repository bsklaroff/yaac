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

## Two places a posture is not honored

**ACP conversations are `bypass`-only.** The adapter asks over
`session/request_permission`, and this build has no chat-pane UI to put that
question in front of the user, so the client answers every request itself.
Any other posture would claim a restraint that isn't there, so create
refuses it. Honoring them is a matter of forwarding those requests to the
pane (see docs/agent-modes.md), not of changing the launch command.

**A prewarmed spare is only claimable for a create resolving to `bypass`.**
The spare's agent is already running, in that posture — claiming one for a
`plan` create would hand back an unrestrained worktree, and silently, since
the claim never rewrites the row. Cold-creating is the honest answer; it
costs the claim's saving, which is the price of the posture actually being
the one that was asked for.

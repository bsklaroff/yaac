# Permission modes

How much a worktree's agent may do before it stops to ask. One enum,
`PermissionMode` in `@yaac/shared`, spelled per tool at launch:

| Mode | claude | codex | opencode | pi |
|---|---|---|---|---|
| `bypass` | `--permission-mode bypassPermissions` | `--yolo` | `permissions`: `*` allow | — |
| `auto` | `--permission-mode auto` | `--approve-for-me` | — | — |
| `accept-edits` | `--permission-mode acceptEdits` | *(its default preset)* | `permissions`: `shell` ask | — |
| `plan` | `--permission-mode plan` | `--sandbox read-only` | `default_agent: plan` + the `manual` rules | — |
| `manual` | `--permission-mode manual` | `--ask-for-approval untrusted` | `permissions`: `*` ask, reads allow | — |

`buildAgentCmd` owns that table. Three things about it are worth knowing.

**codex splits the posture across two axes** — an approval policy and a
sandbox — so each mode picks the pair that adds up to it. `accept-edits`
carries no flag because it *is* codex's own default preset
(`workspace-write` + `on-request`), whose sandbox has network off; that is
what makes codex ask to escalate for anything reaching the network, rather
than yaac having to arrange it.

**opencode's posture is config, not flags** — its TUI has no posture, model
or agent flag at all, and refuses an unknown one outright (usage, exit), so
inventing one would leave a dead window rather than a posture. The
launch carries a config document in `OPENCODE_CONFIG_CONTENT`, read per
process and merged over the shared `opencode.json` (its own keys win), which
is what makes it per-worktree — the file is shared by every worktree in the
project. The TUI runs `--standalone`, over a private server that is its own
child: the server is what reads the config, so a child inheriting the
process env is what makes the posture stick, where opencode's background
service would keep running — and keep the first launch's config — across
restarts.

Rules go in opencode's ordered `permissions` array, over a base policy every
agent starts from (`*` allow, then ask for `external_directory` and `.env`
reads) that global rules append to and a built-in agent's own rules append
after; last match wins. `manual` is therefore wildcard-first — `*` ask, then
reads back to allow, then the base policy's `.env` asks restated behind that
wildcard — so what the base policy allows without yaac naming it (websearch,
subagents, skills, Code Mode, every MCP tool a project's own config adds) is
covered. `plan` selects opencode's own plan agent by `default_agent` for its
`edit: deny`, and carries the same rules, because that is *all* the agent's
rules say: nothing about `shell`, so on its own it runs commands unprompted.

Two things about that document are load-bearing, because **getting either
wrong fails open rather than loudly**. An action opencode does not know
matches nothing, so a rule spelled in the wrong action is not a partial
posture but no posture — the base policy's `*` allow stays in force. And the
value has to survive the trip: the command is embedded in
`respawn-window '<cmd>'`, so it is double-quoted with escaped inner quotes (a
single quote would end the wrapper early, and bare `{...}` would hit zsh
brace expansion). Both are asserted in `agent-command.test.ts`, the second by
running the escaped string through a real shell — string equality alone
would happily lock in a value opencode cannot read.

`bypass` states `*` allow rather than sending nothing, for the same reason:
the base policy already asks for out-of-tree access and `.env` reads, so an
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

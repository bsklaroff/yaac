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

## Under `acp`, the answer is the adapter's

A posture is a launch flag for a TUI and an advertised session mode for an
adapter, and the adapters offer fewer — so the table above is the `tui` column
and `ACP_SUPPORTED_PERMISSION_MODES` is the other one:

| Mode | claude | codex | opencode | pi |
|---|---|---|---|---|
| `bypass` | `bypassPermissions` | `agent-full-access` | the TUI's own config | — |
| `auto` | `auto` | `agent` | — | — |
| `accept-edits` | `acceptEdits` | `read-only` | the TUI's own config | — |
| `plan` | `plan` | — | its config, **plus** the `plan` agent over `session/set_mode` | — |
| `manual` | `default` | — | the TUI's own config | — |

Three things follow from it.

**codex loses two postures over ACP.** codex-acp collapses codex's approval ×
sandbox grid into three modes, and neither `plan` nor `manual` is among them.
A create asking for one is refused rather than nudged to a neighbour — the same
rule the TUI column follows, and the reason the refusal says "under acp": codex
plainly has plan mode, its adapter does not.

**opencode's postures do not travel as modes at all.** Every posture is the
same `OPENCODE_CONFIG_CONTENT` document the TUI is launched with, built by the
same function — opencode reads it per process whichever front end is running.
Its ACP "modes" are its own agents (`build`, `plan`), and `plan` is the one
posture that needs both halves: the config's ask-to-act rules, plus the agent
itself over `session/set_mode`, because the config's `default_agent` is ignored
on the ACP path. Without the agent, plan would keep the rules but lose its
`edit deny`.

**pi's asks are not permissions.** It has no permission system in either mode,
so no posture maps to a mode and none is sent (its `availableModes` are
thinking levels, and `session/set_mode` rejects anything else). What does arrive
on `session/request_permission` are its extensions' own questions — a choice a
person is being asked to make — so those are forwarded to the pane even under
`bypass`, where every other adapter's asks are answered for them. `bypass`
waives permission prompts; it does not answer questions.

A mode a conversation could not be put in — one the adapter never advertised,
or one it refused — is reported **in the pane** as well as the log, naming the
mode the session is actually in. It has to stand rather than be announced once:
the report is made during the handshake, and the id a pane attaches by is
minted by that same handshake, so at the moment it is made there is nobody to
hear it. The conversation holds it until a later `session/set_mode` succeeds,
and every pane is given it after its greeting. It is not fatal: losing a worktree over a
posture would be worse than running in the adapter's default, and the pane says
which that is.

Reporting it is not a nicety, because an adapter's default is not always at
least as strict as what was asked. codex-acp's is `agent` — a reviewer model
approving most actions — not the codex CLI's `read-only` preset, so an
`accept-edits` codex conversation that lands there is running *looser* than the
create asked for. That is the one cell where it matters: under `bypass` yaac
answers the asks itself, and `auto` is the fallback.

The message says only which mode the session is in, and deliberately promises
nothing about what happens to the asks from there — `bypass` answers them here,
and codex's `agent` fallback has a reviewer answering most of them, so
"forwarded to the pane" would be wrong in both.

## Resolution

`resolveCreate` (`#domain/worktrees`) decides a person's create field by field,
most specific first:

1. what the request named (`--permission-mode`, the create form's dropdown),
2. what this project last chose *for this agent* (`project_tool_defaults`),
3. `defaultPermissionMode` for this driver and tool — `bypass` where the
   worktree is sandboxed, `accept-edits` where it is not, and `bypass` for
   pi either way.

The middle rung is why the choice is persisted at all: a user who picks
`plan` once keeps getting it from the CLI, the webapp and the keyboard
shortcut alike, because all three land here. It lives server-side so those
three agree, keyed by project because posture tracks what the code is (a
scratch repo vs one that deploys), and by agent because one agent's postures
are not another's — pi can only run in `bypass`, and that says nothing about
how a claude worktree in the same project should run. The route records what
the request named, since only there is the choice known to be a person's
rather than a restart's or the spawn policy's; a field the request left out
is left as it was.

A request naming a posture its tool lacks is refused rather than nudged to a
neighbour: the caller asked for a restraint, and quietly launching with a
weaker one is the failure mode worth being loud about. The remembered value
gets the opposite treatment — it may have been recorded under the other agent
mode, or before a tool update dropped it — so a posture the agent no longer
offers falls through to its default.

### The rest of the create form's memory

The same row remembers the agent's model and agent mode, and the project row
remembers which agent was last created with (`projects.lastTool`). A create
naming no tool runs that agent; one naming no model runs the remembered one,
else a fallback (`defaultModelFor`: a pinned id for claude and codex, pi's own
per-provider default, and for opencode pi's default for the same provider
where opencode lists it, else the provider's newest). A remembered
`provider/model` id for a provider the stored credential no longer names is
dropped rather than launched.

The agent mode has no server-side rung: an omitted mode is `tui`, because the
CLI can only present a terminal and would otherwise print "open it in the
web app" instead of attaching. The webapp, which can present both, sends the
remembered mode itself — from the create form and from Alt+N alike, which
both submit exactly what the form shows untouched. `resolveToolCreateDefaults`
in `@yaac/shared/types` is the one function both ends answer "what would an
untouched create run" with, so the form never shows one thing and launches
another.

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

## Prewarmed spares

A spare is warmed as its project's untouched create — the last agent, with
its remembered model, posture and agent mode — so the usual claim hands its
running agent over as booted. What each spare was launched with is on its
worktree row (`permissionMode`, `model`, `mode`), and a claim picks one whose
launch matches the request first. A spare in the same mode but warmed with a
different agent, model or posture is still claimed, and its agent is
respawned into what was asked for — a posture is never quietly weaker than
the request. A spare in the other mode is passed over: an `acp` pod carries a
mount for acpd's records that a `tui` one lacks, and the pod spec is fixed at
warm time. The pool replaces a spare whose mode no longer matches its
project's, since no claim from the webapp could take it.

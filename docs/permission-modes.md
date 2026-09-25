# Permission modes

How much a worktree's agent may do before it stops to ask. One enum,
`PermissionMode` in `@yaac/shared`, spelled per tool at launch:

| Mode | claude | codex | opencode | pi |
|---|---|---|---|---|
| `bypass` | `--permission-mode bypassPermissions` | `--yolo` | `permissions`: `*` allow | — |
| `auto` | `--permission-mode auto` | `--approve-for-me` | — | — |
| `accept-edits` | `--permission-mode acceptEdits` | *(its default preset)* | the `manual` rules + `edit` allow | — |
| `manual` | `--permission-mode manual` | — | `permissions`: `*` ask, reads allow | — |
| `plan` | `--permission-mode plan` | — | `default_agent: plan` + the `manual` rules | — |
| `read-only` | — | `--sandbox read-only` | — | — |

Rows run most permissive first, which is the order the create form's
dropdown and the CLI's choices list them in (`PERMISSION_MODES`). `plan` and
`read-only` share the strictest place: each is its tools' strictest posture,
so either may be granted under the other (see "A spawned worktree's
posture").

`buildAgentCmd` owns that table, written against the pinned CLIs
(`AGENT_CLIS` in `@yaac/shared/types`, which the image and a host install
both use). Three things about it are worth knowing.

**codex splits the posture across two axes** — an approval policy and a
sandbox — so each mode picks the pair that adds up to it. `accept-edits`
carries no flag because it *is* codex's own default preset
(`workspace-write` + `on-request`), whose sandbox has network off; that is
what makes codex ask to escalate for anything reaching the network, rather
than yaac having to arrange it. Its strictest posture is `read-only`, its
"Read Only" preset: reads and sandboxed commands run unasked, and every edit
or network reach asks. (Both depend on a sandbox that does not start in a k8s
pod; see below.) It has no `manual` — its approval policy is only
`on-request` or `never`, so nothing asks before every action — and no `plan`:
codex's plan mode is a collaboration mode that instructs the model not to
mutate anything, over whatever sandbox is in force, and no flag launches into
it. A posture the sandbox enforces is the one worth naming.

**Under k8s, codex's sandboxed postures cannot run commands.** Everything
but `bypass` puts codex's shell behind its Linux sandbox (bubblewrap) with
network off, and worktree pods run under gVisor, where bubblewrap cannot
configure the new network namespace (`bwrap: loopback: Failed
RTM_NEWADDR`). So every shell command fails to start — a read such as `ls`
included — and codex does not ask to run it outside the sandbox; it reports
the failure and carries on without it. Checked in a yaac k8s worktree pod
(codex 0.156.1) for `read-only` and `accept-edits`; `auto` shares that
sandbox. The restraint fails *closed*: nothing escapes the sandbox, and with
network allowed bubblewrap starts and confines writes to the writable roots.
But a codex worktree on k8s that is to run commands needs `bypass`, where the
pod and its egress proxy are the containment. Under containerless the sandbox runs on the host kernel, and the
postures mean what the table says.

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
covered. `accept-edits` is those rules with `edit` let back through — the
action opencode's edit, write and patch tools all assert — which is what
claude's `acceptEdits` does: edits in the tree land
unasked, while commands, fetches, subagents, Code Mode and MCP tools still ask,
and an edit outside the tree asks as `external_directory`. (claude also lets
through a few filesystem commands, `mkdir` or `mv`; opencode is not given a
`shell` rule for them, because how it matches a chained command against one is
unverified and a match on `rm x; curl …` would fail open.) `plan` selects
opencode's own plan agent by `default_agent` for its `edit: deny`, and carries
the `manual` rules, because that is *all* the agent's rules say: nothing about
`shell`, so on its own it runs commands unprompted.

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
refusal and the webapp's disabled tool rows read from it. A row holding a
posture its tool lacks (written by another build) launches — on a restart
as much as a create — in the most permissive one the tool has that is no
looser, else its strictest (`launchablePermissionMode`): codex `plan` or
`manual` as `read-only`, claude's and opencode's `read-only` as `plan`,
opencode `auto` as `accept-edits`, and pi, which has nothing but `bypass`, as
that. Never the driver default, which in a container is `bypass`. A
remembered choice the tool no longer offers (see "Resolution") lands the same
way.

## Under `acp`, the answer is the adapter's

A posture is a launch flag for a TUI and an advertised session mode for an
adapter, and the adapters offer fewer — so the table above is the `tui` column
and `ACP_SUPPORTED_PERMISSION_MODES` is the other one:

| Mode | claude | codex | opencode | pi |
|---|---|---|---|---|
| `bypass` | `bypassPermissions` | `agent-full-access` | the TUI's own config | — |
| `auto` | `auto` | `agent` | — | — |
| `accept-edits` | `acceptEdits` | `read-only` | the TUI's own config | — |
| `manual` | `default` | — | the TUI's own config | — |
| `plan` | `plan` | — | its config, **plus** the `plan` agent over `session/set_mode` | — |
| `read-only` | — | — | — | — |

Three things follow from it.

**codex loses `read-only` over ACP.** codex-acp collapses codex's approval ×
sandbox grid into three modes, and none is a read-only sandbox — the one it
calls `read-only` is codex's default preset, which is `accept-edits`. A create
asking for `read-only` under acp is refused rather than nudged to a neighbour —
the same rule the TUI column follows, and the reason the refusal says "under
acp": codex plainly has the sandbox, its adapter does not offer it.

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
and every pane is given it after its greeting. It is not fatal: losing a
worktree over a posture would be worse than running in the adapter's default,
and the pane says which that is. That mode is the conversation's posture from
then on, and is reported to the worktree's row like any move (see "Following
the agent"), so a restart asks for it again rather than for the one refused.

Reporting it is not a nicety, because an adapter's default is not always at
least as strict as what was asked. codex-acp's is `agent` — a reviewer model
approving most actions — not the codex CLI's `read-only` preset, so an
`accept-edits` codex conversation that lands there is running *looser* than the
create asked for, and recorded as `auto`.

The message says only which mode the session is in, and deliberately promises
nothing about what happens to the asks from there — codex's `agent` fallback
has a reviewer answering most of them, so "forwarded to the pane" would be
wrong.

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
offers becomes the nearest one it does that is no looser, and when there is
none, its strictest (`launchablePermissionMode`) — never the default, which
in a container is `bypass`. A remembered codex `read-only` under acp, whose
adapter has nothing that strict, runs `accept-edits`: the most restraint the
tool can give. A restart's posture lands the same way.

### A spawned worktree's posture

`yaac-mama create` (the spawn policy) does not go through that chain. It
starts from the **caller's** posture, which is read from the caller's row
and never taken from the request, and it treats that posture as a ceiling. A
sibling may run at most as permissively as its parent, in the order `bypass >
auto > accept-edits > manual > plan = read-only`. Otherwise an agent that the user left in
`plan` could get its work done unrestrained by asking a sibling to do it.
The project's remembered posture is skipped here too: a spawned sibling runs
with nobody attached, so a `plan` inherited from someone's last webapp create
would leave it waiting for an answer that never comes. The same is true, and
intended, of a `bypass` sibling whose agent enters plan mode on its own: its
plan-exit ask is a question for a person, so it is held for one rather than
approved (see "Following the agent"), and the sibling shows as waiting.

A named `--permission-mode` above the ceiling, or one the tool lacks, is
refused. This is the last point where a refusal can reach the caller,
because the create itself runs detached. An unnamed posture that the tool lacks
steps down to the most permissive posture the tool has below the ceiling. If
there is none, for example pi under a caller that is not in `bypass`, it is
refused.

The ceiling is the caller's posture as its row holds it, which follows the
running agent either way (see "Following the agent"): a caller that moved
into plan mode caps its siblings at `plan`, and one a person moved up to
`bypass` may spawn `bypass` siblings. The ceiling binds the `yaac-mama`
channel, not every way to create a worktree. Under k8s that
channel is the only one a pod has, because the proxy attributes the caller by
source IP and the ingress policy keeps pods off the server's API. Under
containerless there is no such boundary (docs/containerless-driver.md): a
loopback-only server accepts an uncredentialed `/worktree/create` from the
agent, and every worktree runs as the same user. So there, the ceiling holds
only as far as the agent's own tool restrains the commands it runs, the same
as everything else on that driver.

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
agents in the posture they were in, not the way today's default would. The
column follows the agent while it runs (see "Following the agent"), and a
restart relaunches in what it holds. It re-states it rather than choosing
again, so it is neither remembered (it is not a person choosing) nor refused
when unsupported (a row written by a different build would otherwise strand a
checkout).

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
configured even with permissions skipped, and auto-granting those is what
makes bypass mean bypass. An adapter that would not enter its bypass mode at
all (claude's, running as root outside a sandbox) is running in another mode,
and the conversation answers by that one.

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
back. The row has followed them there instead, so the next restart brings the
conversation back in the mode it was left in.

## Following the agent

A posture is chosen at launch, but the agent can leave it: a user presses
Shift+Tab in claude's TUI or picks `/permissions` in codex's, answers a
plan-exit ask with "yes, and auto-accept edits", or the agent enters plan
mode on its own. `worktrees.permissionMode` follows, up or down, because both
of its readers mean the posture the agent is in *now* — a restart relaunches
in it, and `yaac-mama create` caps a sibling at it. A create or a claim sets
it; every move the agent reports overwrites it.

Every report comes from inside the workspace — a pane option, a codex
rollout, acpd's socket and record — so anything running there could forge
one. A forged `bypass` raises the worktree's spawn ceiling and the posture a
restart relaunches in, and under `acp` a forged mode update on the socket
makes yaac auto-answer that conversation's asks while its real adapter is
still asking. That is accepted: it takes a process already running in the
workspace under the agent's own approval posture. Under k8s the sandbox, not
the row, is what holds such a process in; under containerless there is no
sandbox, and such a process already runs as the user with nothing between
it and the host, so a forged posture gives it nothing it lacked.

Only a *change* in what an agent reports is recorded, not a difference from
the row: the row follows every agent in the worktree, and a report that has
not moved is not news about any of them. A first report is a change, which is
also what carries a move made while no server was watching onto the row once
one is — tmux keeps the pane option, acpd's record keeps the mode, and a
codex rollout keeps its settings. Every source reports per pane or per
conversation, and the registry's reconcile pass writes the result through the
event door (`permission-mode-changed`). A mode no posture stands for — pi's
thinking levels, an agent of a project's own — is left unrecorded rather than
rounded to a neighbour; claude's `dontAsk`, which denies whatever is not
pre-approved, reads as `manual`.

**Under `acp` the adapter says so.** Claude's adapter announces a move it made
itself (EnterPlanMode, a plan-exit answer) as a `current_mode_update`;
codex-acp reports every change as a `config_option_update` naming its `mode`
option. The conversation reads both off its socket, and the mode id rides the
live agent set to the registry (`LiveAgent.reportedMode`), read back through
the adapter profile (`modeIds`, then `readsAs`). opencode's adapter never
reports a mode (its one mode, `plan`, is set by yaac), and pi's are thinking
levels.

A conversation answers its own asks by the posture its adapter's current
mode stands for, whichever way it last moved. Each adapter holds its own
mode, so one conversation entering plan mode leaves another still in
`bypassPermissions` answering as before, and a person answering "yes, and
bypass permissions" in one pane does not start auto-approving another's asks.
The worktree's row stands in only where the adapter's mode names no posture
(opencode's agents), and only for the connection that launched the
conversation, as the posture it launched in. A reattach runs no handshake, so
it reads the mode its session is in back from its own acpd record and reports
it; an ask that arrives while it reads waits for the answer. When the record
names no posture it answers by nothing — the row may hold another
conversation's raise — and forwards every ask. A `bypass` conversation that
enters plan mode shows its plan-exit ask in the pane, as the TUI would,
instead of approving it.

**Under `tui` each tool is read where it writes its posture down.** None of
them announces a change to anything outside the process as it happens:

- **claude** — its hooks carry the mode it is in as `permission_mode`
  (`manual` arrives as `default`), but no hook fires on the change itself,
  and its statusLine input does not carry the mode (both checked against
  2.1.282). So the reporter (`worktree-bin/yaac-agent-report`, the same
  script that reports the model) runs on the two hooks that fire once a
  change takes hold: `UserPromptSubmit`, since a mode picked between turns is
  in force by the next prompt, and `Stop`, for one the agent moved to
  mid-turn. It sets the pane option `@yaac-permission-mode`. A Shift+Tab is
  therefore seen at the next prompt or the end of the turn, not as it is
  pressed — a mode changed and never prompted in has not done anything yet.
- **opencode** — its Tab switches between its `build` and `plan` agents, and
  changes only the TUI's draft until a prompt is sent, when its server emits
  `session.agent.selected`. The same plugin that reports the model reports
  the agent. An agent is only half a posture — the rules ride the launch
  config — so it is read against the posture the worktree runs under: `plan`
  and `manual` share their rules, so a switch moves between those two, and
  `build` under any other posture is that posture. The plan agent over
  `bypass`'s or `accept-edits`' rules is no posture yaac has, and is left
  unrecorded; so is the TUI's auto-accept toggle, which writes a file every
  worktree of the project shares, so it says nothing about one worktree.
- **codex** — its hooks carry `permission_mode` only as `bypassPermissions` or
  `default`, two answers for four postures. Its rollout says more, and at
  once: a `thread_settings_applied` event is written the moment `/permissions`
  or Shift+Tab changes anything, and a `turn_context` at every turn, both
  naming the approval policy, its reviewer and the permission profile. The
  registry reads the newest from each rollout and maps it back through the
  launch table; a combination the table never launches reads as the nearest
  posture no looser. The collaboration mode those entries also name is not
  read — codex's plan mode restrains the model by instruction only, over
  whatever sandbox is in force, so it is left unrecorded. It is read on the
  reconcile pass rather than pushed. A reading is news when it changed since
  the last, or — on the first — when its entry was written during the current
  pod life: a restart resumes a rollout whose newest entry is the old
  process's until codex writes its first turn, and that is where the worktree
  stands, not a move. The rollouts read are the ones codex's hook recorded,
  or under containerless, where no hook runs, the ones found by the checkout
  they name (docs/containerless-driver.md).
- **pi** has no permission system to move.

claude and opencode reach the server by push: the reporter's option rides the
same per-pane subscription as the model, filtered inside the format so a value
anything in the workspace sets cannot forge control-mode lines.

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

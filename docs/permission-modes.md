# Permission modes

A permission mode (or *posture*) sets how much a workspace's agent may do
before it stops to ask. It is one enum, `PermissionMode` in `@yaac/shared`,
translated per tool at launch by `buildAgentCmd`:

| Mode | claude | codex | opencode | pi |
|---|---|---|---|---|
| `bypass` | `--permission-mode bypassPermissions` | `--yolo` | `permissions`: `*` allow | — |
| `auto` | `--permission-mode auto` | `--approve-for-me` | — | — |
| `accept-edits` | `--permission-mode acceptEdits` | *(its default preset)* | the `manual` rules + `edit` allow | — |
| `manual` | `--permission-mode manual` | — | `permissions`: `*` ask, reads allow | — |
| `plan` | `--permission-mode plan` | — | `default_agent: plan` + the `manual` rules | — |
| `read-only` | — | `--sandbox read-only` | — | — |

Rows run most permissive first, the order the create form and CLI list them
in (`PERMISSION_MODES`). `plan` and `read-only` rank equal: each is the
strictest posture its tools have. `SUPPORTED_PERMISSION_MODES` lists which
postures each tool has; the create refusal and the webapp's dropdown
read it. The flags are written against the pinned CLIs (`AGENT_CLIS` in
`@yaac/shared/types`).

## Per-tool notes

### codex

codex sets a posture with two settings, an approval policy and a sandbox.
`accept-edits` needs no flag because it is codex's default preset
(`workspace-write` + `on-request`); that sandbox has no network, so codex
asks before anything that reaches the network. `read-only` is codex's "Read
Only" preset: reads and sandboxed commands run unasked, edits and network
access ask. codex has no `manual` (its approval policy is only `on-request`
or `never`) and no `plan` (its plan mode only instructs the model, and no
flag launches into it).

**Under k8s, codex's sandbox uses a patched bubblewrap.** Every codex
posture except `bypass` relies on codex's Linux sandbox, which is bubblewrap
with the network unshared. gVisor creates a new network namespace with `lo`
already holding 127.0.0.1, so stock bubblewrap fails to add it (`EEXIST`)
and aborts with `bwrap: loopback: Failed RTM_NEWADDR`. The failure is quiet:
every shell command fails to start, and codex carries on without asking to
run outside the sandbox. So `dockerfiles/Dockerfile.tools` builds a
bubblewrap that treats that `EEXIST` as success, installed as
`/usr/bin/bwrap`, which codex prefers over its bundled copy.

The sandbox's helper must also survive. Each codex process runs sandboxed
commands through a `codex-linux-sandbox` alias under `$CODEX_HOME/tmp/arg0`,
locked while it runs, and every codex start deletes the ones it can lock.
gVisor keeps file locks per sandbox, so a codex starting in another pod over
the project's shared codex home would delete a running agent's helper. So in
a pod that `tmp` is a pod-local emptyDir (`codexHomeMounts`).

`test/e2e/codex-sandbox.test.ts` checks both, and fails once the bundled
bubblewrap works, which is when the patched build can go. That happens when
gVisor creates `lo` empty
([google/gvisor#13438](https://github.com/google/gvisor/issues/13438), fixed
by [#13532](https://github.com/google/gvisor/pull/13532), once
`GVISOR_VERSION` includes it), or bubblewrap tolerates the address
([containers/bubblewrap#745](https://github.com/containers/bubblewrap/issues/745))
and codex bundles that release. Under containerless, codex's bundled
bubblewrap works as shipped.

### opencode

opencode's posture is config, not flags: its TUI has no posture, model or
agent flag, and exits on an unknown one. The launch passes a config document
in `OPENCODE_CONFIG_CONTENT`, which is read per process and merged over the
project's shared `opencode.json` (its own keys win), making the posture
per-workspace. The TUI runs `--standalone`, over a private server that is its
own child and so inherits the env. opencode's background service would keep
the first launch's config across restarts instead.

Rules go in opencode's ordered `permissions` array, after a base policy every
agent starts from (`*` allow, then ask for `external_directory` and `.env`
reads). A built-in agent's own rules come after; the last match wins.

- `manual`: `*` ask, then reads allowed, then the base policy's `.env` asks
  restated. Starting with the wildcard covers everything the base policy
  would otherwise allow (websearch, subagents, skills, Code Mode, MCP tools).
- `accept-edits`: the `manual` rules plus `edit` allowed (the action behind
  opencode's edit, write and patch tools). As with claude's `acceptEdits`,
  edits in the tree land unasked; commands, fetches, subagents and MCP tools
  still ask; an out-of-tree edit asks as `external_directory`. There is no
  `shell` rule for `mkdir`/`mv` (which claude allows), because how opencode
  matches a chained command is unverified and a rule matching
  `rm x; curl …` would also allow the `curl`.
- `plan`: opencode's plan agent (`default_agent`) for its `edit: deny`, plus
  the `manual` rules, because the plan agent says nothing about `shell` and
  would otherwise run commands unasked.
- `bypass`: an explicit `*` allow, since the base policy asks for
  out-of-tree access and `.env` reads.

Two mistakes would silently loosen the posture instead of failing. An action
name opencode doesn't know matches nothing, leaving the base `*` allow in
force. And the value must survive shell quoting inside
`respawn-window '<cmd>'`, so it is double-quoted with escaped inner quotes (a
single quote would end the wrapper; bare `{...}` would hit zsh brace
expansion). `agent-command.test.ts` checks both, the second through a real
shell.

### pi

pi has no permission system, by design: its tools run immediately. It is
`bypass`-only, and create refuses anything else. Adding postures would need a
pi extension that denies or prompts on its blocking `tool_call` event.

### A posture the tool lacks

A row can hold a posture its tool lacks (written by another build). On
create or restart it launches in the most permissive posture the tool has
that is no looser, else the tool's strictest (`launchablePermissionMode`):
codex `plan`/`manual` as `read-only`, claude's and opencode's `read-only` as
`plan`, opencode `auto` as `accept-edits`, pi as `bypass`. It never falls
back to the driver default, which in a container is `bypass`.

## Under `acp`, the adapter's session modes

For an ACP adapter a posture is a session mode the adapter advertises. Each
adapter covers the same postures as its TUI (`SUPPORTED_PERMISSION_MODES`):

| Mode | claude | codex | opencode | pi |
|---|---|---|---|---|
| `bypass` | `bypassPermissions` | `agent-full-access` | the TUI's config | — |
| `auto` | `auto` | `agent` | — | — |
| `accept-edits` | `acceptEdits` | `workspace-write` | the TUI's config | — |
| `manual` | `default` | — | the TUI's config | — |
| `plan` | `plan` | — | its config, plus the `plan` agent over `session/set_mode` | — |
| `read-only` | — | `read-only` | — | — |

- **opencode's postures are config, not ACP modes.** It gets the same
  `OPENCODE_CONFIG_CONTENT` as the TUI. Its ACP modes are its agents
  (`build`, `plan`), and `plan` also sets the `plan` agent over
  `session/set_mode`, because a new ACP session applies `default_agent` only
  at its first prompt.
- **pi's asks are questions, not permission prompts.** No mode is sent (its
  `availableModes` are thinking levels). What arrives on
  `session/request_permission` are its extensions' questions for the user,
  so they are forwarded to the pane even under `bypass`. `bypass` skips
  permission prompts; it does not answer questions.

If a conversation can't be put in the requested mode (not advertised, or
refused), the pane and the log say which mode the session is actually in.
The handshake happens before any pane attaches, so the conversation keeps the
message and shows it to every pane until a later `session/set_mode`
succeeds. It is not fatal. The actual mode is recorded on the workspace row
like any other move (see "Following the agent"), so a restart asks for it.
This matters because an adapter's default can be looser than what was asked:
codex-acp's default is `agent` (a reviewer model approves most actions), so
an `accept-edits` codex conversation that falls back to it is recorded as
`auto`.

## Resolution

`resolveCreate` (`#domain/workspaces`) decides each field of a user's create,
most specific first:

1. what the request named (`--permission-mode`, the create form's dropdown);
2. what this project last chose for this agent (`project_tool_defaults`);
3. `defaultPermissionMode`: `bypass` where the workspace is sandboxed (k8s),
   `accept-edits` where it is not (containerless), `bypass` for pi.

Step 2 means a user who picks `plan` once keeps getting it from the CLI, the
webapp and the keyboard shortcut. It is stored server-side so those agree,
per project because posture depends on the code, and per agent because
postures differ by agent. The route records only what the request named,
since only there is it a person's choice.

A request naming a posture its tool lacks is refused: silently launching
with less restraint than asked is the failure worth being loud about. A
remembered value is instead lowered like a row's (`launchablePermissionMode`),
since it may have been recorded before a tool update.

### A spawned workspace's posture

`yaac-mama create`, `yaac-mama queue` and `yaac-mama edit-queued`
(docs/queued-workspaces.md) resolve the posture with `agentPermissionMode` in
the spawn policy instead. It treats the **caller's** posture (read from the
caller's row, never from the request) as a ceiling: a sibling may run at
most as permissively as its parent, in the order `bypass > auto >
accept-edits > manual > plan = read-only`. Otherwise an agent left in `plan`
could get its work done unrestricted by asking a sibling.

The project's remembered posture is skipped, since a spawned sibling runs
unwatched and a remembered `plan` would leave it waiting forever. Likewise a
`bypass` sibling whose agent enters plan mode holds its plan-exit ask for a
person (see "Following the agent") and shows as waiting.

- A named `--permission-mode` above the ceiling, or one the tool lacks, is
  refused. This is the last point a refusal can reach the caller, since the
  create itself runs detached.
- An unnamed posture is inherited (the caller's for `create`; for `queue`,
  the parent workspace's or the stored posture of the entry it chains after)
  and lowered to the most permissive the tool has at or below both it and the
  ceiling. If there is none (pi under a non-`bypass` caller), it is refused.
- `edit-queued` treats the stored posture as named, so an entry above the
  ceiling is refused, unless the edit changes the tool, which re-resolves it
  as unnamed.

The ceiling applies only to agents; the webapp and `/workspace/queue/*`
routes are the user's. It is the caller's current row value, which follows
the running agent: a caller that moved into plan mode caps siblings at
`plan`, and one a person moved to `bypass` may spawn `bypass` siblings.

The ceiling binds only the `yaac-mama` channel. Under k8s that is the only
channel a pod has: the proxy identifies the caller by source IP, and the
ingress policy keeps pods off the server's API. Under containerless there is
no such boundary (docs/containerless-driver.md): the loopback server accepts
an uncredentialed `/workspace/create` from the agent, so the ceiling holds
only as far as the agent's own tool restrains it.

### The rest of the create form's memory

`project_tool_defaults` also remembers the agent's model and agent mode, and
`projects.lastTool` the agent last used. A create naming no tool runs that
agent; one naming no model runs the remembered model, else `defaultModelFor`
(a pinned id for claude and codex; pi's per-provider default; for opencode,
pi's default for the same provider if opencode lists it, else the provider's
newest). A remembered `provider/model` whose provider the stored credential
no longer names is dropped.

An omitted agent mode is the remembered one, else `acp` (`DEFAULT_AGENT_MODE`),
for the CLI as for the webapp. A `yaac-mama create` naming none takes its
caller's mode, as a queued entry takes its parent's. `resolveToolCreateDefaults` in
`@yaac/shared/types` is the one function the form and server both use for
"what would an untouched create run", so the form always shows what will
launch.

The branch is remembered only for the dialog: `projects.lastBranch` (recorded
when a create names one) is what the dialog opens on while origin still has
it, else the remote's default. A create naming no branch uses the remote's
default, so the CLI and spare pool never depend on the webapp's last pick.

The resolved posture is stored in `workspaces.permissionMode`, so a restart
relaunches in the posture the agents were in. A restart re-uses it without
choosing again: it is neither remembered nor refused if unsupported.

## How a conversation applies a posture

A `tui` agent gets its posture as a launch flag, and its own UI does the
asking.

codex launches in the workspace (`-C`) with the repository root trusted,
hook trust bypassed (`--dangerously-bypass-hook-trust`), and its update check
off (`codexLaunchConfig`), so no startup screen swallows a pasted
`--prompt`. Trusting the folder has a known, accepted cost: codex loads the
repository's `.codex/` — its `config.toml` (whose `sandbox_mode` and
`approval_policy` override a posture that sets no flag), its exec-policy
rules (an `allow` rule runs a command outside the sandbox), and its MCP
servers and hooks, which run at launch. So a repository can loosen codex's
posture and run code at startup.

An `acp` conversation has no UI of its own, so yaac does two things:

- **It tells the adapter** the posture over `session/set_mode` once the
  handshake has a session. This decides which questions are asked at all;
  without it the adapter asks about everything.
- **It forwards the remaining asks** to the chat pane. The JSON-RPC request
  is held open with no timeout, because answering for the user after a delay
  would be the auto-approval the posture exists to prevent.

Under `bypass` yaac answers asks itself, because an adapter still honors a
user-configured `permissions.ask` rule in bypass mode. An adapter that won't
enter its bypass mode (claude's, running as root outside a sandbox) is in
some other mode, and the conversation answers according to that mode.

acpd's record holds both directions of each ask, so a pane attaching mid-ask
sees the question and a reconnecting connection can answer an ask it never
received (docs/agent-modes.md).

A reattach does not re-send the posture to a live adapter. Leaving plan mode
is itself an ask whose options are mode ids, so a user who chose "yes, and
auto-accept edits" moved the session to `acceptEdits`; re-sending the row's
mode would undo that. The row follows the move instead.

## Following the agent

The agent can leave its launch posture: Shift+Tab in claude's TUI,
`/permissions` in codex's, a plan-exit answer like "yes, and auto-accept
edits", or the agent entering plan mode on its own.
`workspaces.permissionMode` follows, up or down, because both its readers
want the current posture: a restart relaunches in it, and `yaac-mama create`
caps siblings at it.

Every report comes from inside the workspace (a pane option, a codex rollout,
acpd's socket and record), so anything running there could forge one, e.g.
a forged `bypass` to raise the spawn ceiling. This is accepted: it needs a
process already running in the workspace. Under k8s the sandbox contains such
a process; under containerless it already runs as the user.

Only a *change* in what an agent reports is recorded, since the row is shared
by every agent in the workspace. A first report counts as a change, which is
how a move made while no server was watching reaches the row later (tmux
keeps the pane option, acpd's record keeps the mode, a rollout keeps its
settings). The registry's reconcile pass writes it as a
`permission-mode-changed` workspace event. A mode that matches no posture
(pi's thinking levels, a project's own opencode agent) is not recorded.
claude's `dontAsk` reads as `manual`.

### Under `acp`

claude's adapter announces a move it made itself (EnterPlanMode, a plan-exit
answer) as `current_mode_update`; codex-acp reports every change as a
`config_option_update` for its `mode` option. The conversation publishes the
mode id on the live agent set (`LiveAgent.reportedMode`), and the registry
maps it to a posture through the adapter profile (`modeIds`, then
`readsAs`). opencode's adapter never reports a mode, and pi's are thinking
levels.

Each conversation answers its own asks according to its adapter's current
mode, so one conversation entering plan mode, or a user choosing "yes, and
bypass permissions" in one pane, does not change how another answers. The
workspace row is used only when the adapter's mode names no posture
(opencode's agents), and only by the connection that launched the
conversation. A connection reads the row once when it connects, then follows
each recorded `permission-mode-changed` (`setAcpPermissionMode`). A reattach reads its session's mode back from the acpd record;
an ask arriving meanwhile waits. If the record names no posture, every ask is
forwarded. A `bypass` conversation that enters plan mode shows its plan-exit
ask in the pane, as the TUI would.

### Under `tui`

No tool announces a posture change outside its process, so each is read where
it writes it down:

- **claude.** Its hooks carry the mode as `permission_mode` (`manual` arrives
  as `default`), but no hook fires on the change itself, and its statusLine
  input lacks the mode (checked against the pinned 2.1.286). So the reporter
  (`workspace-bin/yaac-agent-report`, which also reports the model) runs on
  `UserPromptSubmit` and `Stop` and sets the pane option
  `@yaac-permission-mode`. A Shift+Tab is seen at the next prompt or turn
  end, not when pressed.
- **opencode.** Tab switches between its `build` and `plan` agents; the
  server emits `session.agent.selected` when a prompt is sent, and the plugin
  that reports the model reports it. The agent is read against the
  workspace's posture, since the rules come from the launch config: `plan`
  and `manual` share rules, so a switch moves between those two, and `build`
  under any other posture is that posture. The plan agent over `bypass` or
  `accept-edits` rules matches no posture and is not recorded; nor is the
  TUI's auto-accept toggle, which writes a file every workspace of the
  project shares.
- **codex.** Its hooks only distinguish `bypassPermissions` from `default`.
  Its rollout says more: a `thread_settings_applied` entry is written as soon
  as `/permissions` or Shift+Tab changes anything, and a `turn_context` at
  every turn, both naming the approval policy, reviewer and permission
  profile. The reconcile pass reads the newest entry from the rollout each
  codex pane names (docs/workspace-storage.md) and maps it back through the
  launch table; an unlaunched combination reads as the nearest posture no
  looser. The collaboration (plan) mode is ignored, since it only instructs
  the model. Only entries from the current pod's life count, since a resumed
  rollout's newest entry is the old process's until codex writes a turn.
- **pi** has no permission system to change.

claude's and opencode's pane option rides the same per-pane tmux subscription
as the model, filtered inside the format string so a value set by anything
in the workspace cannot forge control-mode lines.

## Prewarmed spares

A spare is warmed as its project's untouched create: the last agent, with its
remembered model, posture and agent mode, recorded on the spare's row
(`permissionMode`, `model`, `mode`). A claim prefers a spare whose launch
matches. A spare in the same agent mode but with a different agent, model or
posture can still be claimed; its agent is respawned with what was asked, so
the posture is never weaker than requested. A spare in the other agent mode
is skipped, because an `acp` pod has a mount for acpd's records that a `tui`
pod lacks, fixed at warm time. The pool replaces spares whose mode no longer
matches their project's.

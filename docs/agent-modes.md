# Agent modes: `tui` and `acp`

A workspace runs a coding agent. How the server talks to it is its **mode**:

| | `tui` | `acp` |
|---|---|---|
| What runs | the tool's own terminal UI | the tool's ACP (Agent Client Protocol) adapter, JSON-RPC over stdio |
| Server sees | tmux control-mode notifications | `session/update` notifications |
| Browser sees | PTY bytes in xterm.js | structured messages in a chat pane |
| Status from | pane titles / rendered content | prompt-turn boundaries |
| Conversation ids from | a pane option the tool's reporter sets | `session/new`'s reply |

Mode is independent of the tool: it picks the protocol, not the agent. Every
tool has an adapter, listed in `ACP_ADAPTERS` in `@yaac/shared/types`. The
image install, the host preflight, the launch command and the create form's
Terminal / Chat dropdown (remembered per agent, see
docs/permission-modes.md) all read that one table:

| tool | adapter | notes |
|---|---|---|
| claude | `claude-agent-acp` | bundles its own SDK |
| codex | `codex-acp` | drives `codex app-server` (the CLI on PATH, via `CODEX_PATH`), so the CLI must be installed too |
| opencode | `opencode acp` | a subcommand of the CLI |
| pi | `pi-acp` | drives `pi --mode rpc`, so the CLI must be installed too |

How the adapters differ is described by per-tool profiles in
`#runtime/agents/acp-adapters.ts`: the argv, the environment that carries a
posture or model, the session mode ids for yaac's postures, whether the
adapter's asks are permission prompts, and whether a message can join a
running turn. These facts depend on each other (a
tool that can't take a model at launch must be sent one over the protocol),
so they live in one table.

`acp` is the better mode on a phone. A chat pane needs only a message list
and a composer, while a TUI needs Esc, Tab, Ctrl and arrow keys, which is why
the mobile layout gives terminal panes an extra key bar
(docs/mobile-layout.md).

## tmux supervises both

tmux is the process supervisor that outlives the viewer. A closed tab, a
dropped connection or a server restart must not kill a turn in progress.

An ACP agent can't run under tmux directly: a PTY would corrupt the protocol,
and a streamd `ctrl` stream kills its child when the socket closes. **acpd**
(`dockerfiles/acpd/`) fills that gap. It runs inside the tmux window, owns the
agent's stdio, and republishes it on a UNIX socket that clients can attach to
and detach from freely.

```
tmux window                                   server
┌─────────────────────────────┐               ┌──────────────────┐
│ acpd ── stdio ── ACP agent  │               │ AcpConversation  │
│   └── /tmp/yaac-acp/<w>.sock│◄──ctrl+socat──┤ (JSON-RPC peer)  │
└─────────────────────────────┘               └──────────────────┘
```

So acpd is to JSON-RPC what tmux is to a PTY. Everything built on "a
conversation is a tmux window" works unchanged for both modes: launch,
restart, window-close teardown, and workspace GC.

acpd works the same under both drivers. The launch command passes everything
that differs: the socket path, the record path, and `--cwd`, the checkout to
run the agent in (`/workspace` in a pod, a path under the data dir on a
host). A missing cwd fails the spawn with `ENOENT`, the same error as a
missing binary, so the path must be right.

## The driver interface

`agentDriver(mode)` in `#runtime/agents` returns an `AgentDriver` with
`launchCmd(spec)` and `connect(workspace, sink, deps)`. `connect` produces a
stream of `AgentObservation`s (`up`, `down`, `live-agents`, `status`,
`command-channel`, `windows-changed`). `WorkspaceStatusWatcher` consumes it
and owns what both modes need: respawn, backoff, the streamd self-heal, and
the workspace's terminal listing, which it re-reads over the command channel
whenever tmux adds, closes or renames a window, so the snapshot carries it.
There is one retry loop for both.

Content is not part of the interface. PTY bytes and ACP events have nothing
in common, and the webapp already picks a renderer from a pane's target
string.

ACP's message shapes live only in `acp-protocol.ts`, which turns every
`session/update` into the closed `AcpEvent` union. A protocol change is made
there and nowhere else.

## Handles

The status store keys a conversation's busy/idle state by its **handle**, the
driver's address for it: a tmux pane id (`%3`) under `tui`, the acpd window
name (`claude-2`) under `acp`. The store never knows which protocol produced a
status. `workspace_agent_sessions.paneId` holds the same handle, which is how
a live status joins back to its conversation.

## Where history lives

Not in the server. acpd appends every line it relays, in both directions, to
a **record** file on a host-mounted path (`acpLogDir()` in
`@yaac/shared/project-paths`). That file is the conversation's history:

- It is written whether or not anyone is attached, so an unwatched turn is
  still recorded.
- It is in ACP's own format, so replaying it uses the same projection as the
  live path.
- It is on the host, so the server can read it without the pod, including
  after the pod is gone. That is what makes a stopped workspace's
  conversation readable.

Both directions are needed because the agent echoes user messages only when
replaying under `session/load`; without the client's `session/prompt` lines
the record would show no live user turns. Nothing is buffered for an absent
client, and the server keeps no copy.

### Reading a stopped conversation

`GET /workspace/:id/agent-sessions/:sessionId/transcript` returns the same
`AcpEvent[]` a pane renders, read from files rather than from a running
workspace, so the stopped-workspaces view can show the whole conversation.

- An `acp` conversation is a replay of its acpd record.
- A `tui` claude conversation has no record, so claude's own session
  transcript is translated on demand. The server calls `claude-agent-acp`'s
  `toAcpNotifications` (the function its `session/load` uses) as a library,
  then feeds the result through the same replay as an acpd record. No adapter
  process, pod or credential is involved, and a stopped conversation renders
  the same way it looked live. The package the server imports must match the
  version `dockerfiles/Dockerfile.tools` installs; a unit test fails if they
  drift.
- A `tui` conversation of any other tool returns `NOT_SUPPORTED`, because only
  claude's adapter exposes its translation as a library.

### How content reaches a pane

**Pane content comes only from the record.** The socket carries requests,
replies and the agent's own questions, but no rendered messages. Record and
socket carry the same `session/update` notifications, which have no `id`, so
two copies can't be merged without duplicating or dropping the overlap.

A pane's content is a tail of the record: the first pass delivers everything
and the pane replaces what it held; later passes deliver only new lines
(`seq` is scoped to one attach). The cost is polling latency; replies arrive
in bursts.

Two events come over the socket because the record can't carry them: turn end
and error, built from a `session/prompt` reply that acpd never sees or from
the adapter's own state report (below). No event comes from both sources, so
nothing is duplicated. The tail is flushed
before either is forwarded, so a turn never appears to end before its last
words.

Those turn events (`turn-start`, `turn-end`, `error`) and the busy flag in the
attach greeting are the only things that move a pane's working indicator.
Messages can't be used for this: `session/load` replays the whole
conversation as live `user` messages, and the record has no boundary to close
them. A pane inferring from content would come back from a restart stuck at
"working…".

acpd truncates the record when it starts. A tail that sees the file shrink
resets its position and projection, and the pane replaces its content. A
restart's `session/load` replays the whole conversation, so the new file ends
up complete. This depends on every adapter replaying on load, which is
adapter behavior, not a protocol guarantee. An adapter that didn't would come
back blank, and the fix would be to keep the record instead of truncating it.

The record is named for the conversation, not the window. Window names are
slots, and a restart that drops an earlier conversation shifts later ones
down, which would overwrite one conversation's history with another's. On a
resume the id is known at launch; on a fresh create the file starts under the
workspace id and is renamed once `session/new` answers.

### What the pane keeps

A pane holds none of the conversation, only the unsent draft, which lives in
the webapp's persisted ui store (keyed per conversation) so it survives a
stop, a closed tab or a reload. A sent message stays in the composer until
the server echoes it. If the pane is torn down in between, the store also
keeps the exact text sent: the composer is cleared only if it still holds
that text and the replayed history shows it arrived, or the server holds it
queued. (Matching on history alone would clear a fresh "ok" because of an
earlier one.)

An off-screen pane stays mounted and keeps its socket, like a terminal, so
switching tabs or workspaces costs no network. Attaching is the slow part (a
handshake, then the whole conversation in one `hello` frame): that is the
"Connecting to the agent…" wait. The warm-up that pre-attaches terminals
after a page load covers chat panes too.

## Sending mid-turn

The composer stays open while the agent works, as a TUI's prompt does: Enter
sends, and Stop sits beside Send. What happens to the message is the adapter
profile's `steers` fact, matching what each tool's TUI does with a message
typed mid-turn where its adapter allows:

- **claude, codex and pi steer.** Their adapters implement the
  `_session/steering` extension, which adds the message to the running turn.
  When it lands differs per adapter:
  - codex delivers it at the turn's next model call, as its TUI does.
  - pi delivers it once the current tool calls finish, before the next model
    call, as Enter does in its TUI. pi-acp steers only as yaac patches it at
    install, in the image and in a host install alike
    (`dockerfiles/agent-patches/pi-acp.js`, which says when it can go).
  - claude's adapter interrupts: the generation in progress is cut off where
    it stands and the message runs as a second cycle of the same turn. While
    a permission ask is open it waits for the answer instead. claude's TUI
    holds a typed message for the next tool boundary, and the pinned adapter
    offers no way to ask for that. Stop after a steer does not stop the
    turn: the adapter interrupts the cycle the steer pre-empted, the SDK
    keeps the steered message queued across the interrupt, and the turn runs
    on until that message is answered before it reports `cancelled`. yaac
    sends `session/cancel` at once; the hold-up is the adapter's.

  The request asks for `idleBehavior: promptRequired`, so a steer that
  arrives just after the turn ended is handed back. Any steer the agent does
  not take (handed back, refused, or an adapter without the method, such as
  an unpatched pi-acp in a workspace older than the patch) is queued rather
  than lost. Messages are routed one at a time, so one sent while an earlier
  steer awaits its answer cannot overtake it.

  A steered message has no turn of its own, so it moves no status. In the
  record it is a request whose reply says whether the agent took it, so the
  projection shows it as a `user` event only once that reply arrives (marked
  `steered` when it joined the turn, so the pane does not read it as ending
  the calls before it); one that was not taken shows once, as the prompt
  that followed.

  codex's adapter ignores `promptRequired`: a steer that lands as its turn
  ends makes it start a turn of its own (`startedNewTurn`), which answers no
  `session/prompt` of yaac's. Like any turn an agent starts itself, it
  counts as running until codex reports its thread idle, both live and when
  a reattach reads the record (see "The agent can start turns itself").
- **opencode queues.** Its TUI steers by default, but its acp refuses a
  second `session/prompt` while one runs and has no steering method, and the
  adapter is compiled into opencode's binary rather than shipped as a
  script yaac could patch.

**The queue.** A message that is not steered waits in `AcpConversation`'s
queue and runs as the next turn. The queue is server state, not history, so
it reaches panes beside the record: in `hello` and as `queue` frames. Every
pane shows it, the composer clears as soon as its message appears there, and
a queued message can be removed (`unqueue`) until it is sent.

The queue is in the server's memory. It survives a dropped connection,
whether one conversation's relay or the whole workspace's: acpd keeps the
agent, and the conversation that replaces the dropped one takes the queue
over (keyed by session id, since a restart can move window names) and sends
it once it knows no turn is running. The status watcher stopping is what
discards it. It does not survive a workspace stop, a server
restart or the agent's window closing; those messages are dropped with only
a log line, so a resumed conversation never acts on stale instructions.

**Stop cancels the running turn, not the queue.** A queued prompt is
something the user asked for, so it runs once the turn ends; removing it is a
separate click. A turn recovered after a reattach is treated the same way.

## Reconnect

acpd keeps the agent alive across detaches, so a reconnect may land mid-turn.

**The handshake runs once per agent process, not per connection.** acpd's
first line on every attach is `_acpd/hello {firstAttach}`. When it is false,
the client skips `initialize` and `session/new` and keeps the session id it
already holds. `firstAttach` tracks whether a client ever *sent* anything, not
whether one connected: a client that died during an adapter's cold start ran
no handshake, and its successor must run one.

**The agent can start turns itself.** In ACP v1 a turn is running only while
*your* `session/prompt` is unanswered, but agents also work unprompted: a
claude background task finishing or scheduled wakeup, a codex goal
continuing, a pi extension triggering a run. v1 has no standard report for
this (v2's `state_update` is still a draft), so each adapter's own is read
(`agentRunningReport`):

- claude's adapter forwards the Agent SDK's `session_state_changed` as a
  `_claude/sdkMessage` notification, which the handshake asks for in `_meta`.
- codex-acp sends `session_info_update` carrying `_meta.codex.threadStatus`
  (`active`/`idle`) for every turn.
- pi-acp sends `session_info_update` carrying `_meta.piAcp.running`. As yaac
  patches it, that covers a run pi-acp did not start too: pi-acp adopts the
  run at pi's `agent_start` as a turn with no `session/prompt` to answer,
  and queues prompts behind it. An older install reports only the closing
  `false` for such a run, so the first thought, tool call or plan update
  while idle stands in for the start (docs/legacy-compat-shims.md). Plain
  text does not, since pi-acp also sends text outside any run (an
  extension's `notify`, its startup prelude) that no `false` would follow.
- opencode's ACP server forwards nothing from a turn it did not start, not
  even its content, so such a turn never reaches the record or the pane
  (bsklaroff/yaac#288 tracks the upstream fix).

A conversation is working while either signal says so. The pane's busy
indicator, Stop and steering follow the combination: a message sent during a
turn the agent started itself steers into it like any other. pi-acp is the
exception: its steering patch reaches only turns pi-acp started, so under
pi such a message queues until pi reports the run settled.

A report the adapter never follows up would pin the conversation running:
claude's adapter sends no idle once the CLI under it exits, and a start
inferred for pi has no end report of its own. So the report is dropped when
Stop is pressed with no prompt of ours running, and when the adapter refuses
a prompt; a run that goes on reports again. Recovery reads the record the
same way.

The record projection turns each reported run start into an `agent-turn`
event. It moves no status; the transcript uses it to keep a self-started
reply from running on from the reply before, which has no user message
between them.

For claude, a `woken` event names what started such a run, and the pane
captions the run's first row with it, in the condensed view too. A claude
run ends at its result, the `usage_update` whose `_meta["_claude/origin"]`
says what started it. Causes are credited there, and only when that origin
is `task-notification`, so a run the user started is never captioned. They
are taken when the run began:

- A finished background task or background subagent sends its
  `task_notification` between runs, just before the run it starts. The
  notifications seen since the last run ended are the cause. A task that a
  subagent started (`owned_by_subagent`) notifies that subagent, and an
  ambient watch is not the agent's, so both are skipped. A prompt or a new
  agent life drops notifications no run has claimed.
- A monitor's event wakes the agent with nothing before the run. A run with
  no notification at all before it, skipped ones included, is credited to
  the one monitor running when it began, or "a monitor" when several were.

The adapter does not always report idle between runs. While a background
subagent works it stays `running` and holds our prompt open, so a run that
a notification starts then is found by its first output after a result.
Without a notification waiting, output after a result continues the run:
a steer aborts the cycle it interrupts, which sends a result of its own. A
monitor event during such a hold therefore joins the run before it. A
notification that arrives mid-run joins that run and wakes nothing. The
notification text the agent itself received is not available: the CLI
replays it only when it joins a running turn.

**Background work is its own status.** Between turns, a claude conversation
whose background shells, monitors or background subagents are still live
reports `background` rather than `waiting`: that work will usually wake the
agent, so nothing needs a person yet, and the sidebar shows a slow-breathing
marker instead of the unread dot (the chime and tray badge stay quiet too).
The source is claude's `background_tasks_changed`, which lists every live
background task; ambient tasks are not counted, as the SDK asks of activity
indicators. claude reports a finished task gone just before its
notification wakes the agent, so the drop back to `waiting` waits a few
seconds, and an agent waking in that time skips the waiting spell (and its
chime) entirely. While the adapter holds a turn open for a background
subagent, the conversation stays `running`. Other adapters, and `tui`
conversations, report no background work, so they never show this status.
The workspace's status is its most pressing conversation's: `asking`, then
`waiting`, then `running`, then `background`. A client that predates
`background` reads it as quiet, like `running`.

`background` has no time limit: it lasts as long as claude lists the work.
A task that never ends by itself (a dev server or `pnpm watch` run in the
background, a `tail -f` monitor, or the persistent `yaac-watch-prs` monitor
that the `push-pr` and `review-pr` skills arm) therefore keeps its workspace
in `background` for the task's whole life. That holds even when the agent
ends a turn with a question, so such a workspace never shows the unread dot
or chimes. The sidebar's marker still shows that its turn is over.

**Busy state is recovered from the record.** The protocol has no status
query. A connection taking over a live agent reads the record, which shows
whether the last prompt was answered and what state the adapter last
reported. Until then the conversation is
*unclassified* rather than idle, and no status is published, since guessing
`waiting` would show a working agent as idle. A recovered turn is sent to
panes as `turn-start`, so a pane can show a turn it didn't start.

**A pane is closed with its conversation.** Tearing down a conversation
closes its panes' sockets. A pane holds the conversation object it attached
to, so it would never see a replacement registered under the same `acp:<id>`
(as a workspace restart creates); a Stop sent down the old socket would reach
a closed peer. Closing forces the pane to re-attach, which binds it to the new
conversation.

**An in-flight `session/prompt` reply arrives as an orphan** and is read as
"that turn ended". Request ids carry a per-connection prefix, so a duplicate
of this connection's own reply is dropped instead of ending a live turn. A
reply produced while nobody was attached is never delivered, so only the
record has it; a reply arriving after the reattach may beat the record scan,
and the first classification wins.

## State

The conversation's row records its mode (`agent_sessions.mode`), because a
restart must bring it back the same way and nothing else on disk says which.

Recording is the same for both modes: the live agent set names each running
conversation, and the registry records exactly those as active
(docs/workspace-storage.md). Only the id's source differs: a `tui` tool names
it on its pane through a hook or plugin, while `session/new` gives an `acp`
one to the server.

An ACP row records no transcript path. Under ACP, three of the four tools
leave nothing the server can find outside the pod (codex's rollouts are named
by a thread id yaac never sees, opencode's history is a database in the
container, pi's log is named by an id its adapter made up), so the row's
opening message and last-active time are read from the record instead.

The model comes from the adapter: the handshake reply names it (as a
`models` block, a `configOptions` entry with `id: model`, or both), and later
changes arrive as `config_option_update`. It is published on the live agent
set and stored as the catalog's id, matched by display name when the adapter
uses its own id (claude's adapter may answer with a picker alias such as
`opus`), so the sidebar label matches the create form. Mode changes
travel the same way and become the workspace's posture
(docs/permission-modes.md, "Following the agent").

The row is written by the reconciler's conversation sweep, so the id
appearing in the live agent set is itself a reconcile trigger (`live-agents`,
docs/event-driven-reconcile.md). Until the row exists an ACP workspace has no
chat pane, only the raw agent window (acpd's log). So a fresh ACP create waits
for the handshake to name the conversation (`whenAcpConversation`, resolved
when the connection registers the id) and runs that workspace's sweep itself,
and the webapp swaps its provisioning placeholder straight for the chat pane.
A claimed spare waits the same way, and the placeholder hides the spare so it
is never listed twice.

The connection finds conversations through a tmux control-mode client of its
own, as the `tui` driver does: tmux pushes a window add or close, and a
subscription on an agent window still running create's placeholder fires
when acpd replaces it. Listing windows over that stream is the heartbeat.
acpd binds its socket a moment after it starts, so a dial that finds nothing
is retried every second, a bounded number of times, before it waits for the
heartbeat.

Under k8s an `acp` pod carries the label `yaac.mode=acp`, so the status
watcher can pick a driver from an informer event without a database read. A
pod without it is `tui`.

## Where status can mislead

Status is exact at turn boundaries, with three exceptions. A turn opencode
starts on its own is not seen at all (see "The agent can start turns
itself").

A **hung adapter** (process alive, prompt never answered) stays `running`
forever: nothing times out a `session/prompt`, and `session/cancel` is a
notification a wedged agent ignores. Use the pane's Stop button, then restart
the workspace.

A **torn record** can leave a reattached conversation `running`. Recovery
reads "last prompt unanswered" as a turn in flight, so if the reply's bytes
never reached the record nothing clears it (an agent exit is recorded and
clears it; a lost write is not). It shows as working with nothing streaming.
The pane can't release it: new messages queue behind the phantom turn (a
steering adapter hands them back, having no turn to add them to), and
Stop's `session/cancel` names a turn the adapter doesn't have, so nothing
ends it. Restart the workspace; a fresh acpd
starts idle.

## Commands, skills and models

A chat pane's composer completes what a TUI's prompt would. Typing `/` lists
the slash commands the session advertises (`available_commands_update`, a
`commands` event), and `/model ` lists the models it can switch to. Both lists
are projected from the record, like the rest of the conversation, so a pane
that attaches late or after a server restart has them too.

Skills arrive as commands, spelled as each tool's TUI spells them: claude's as
plain `/name`, pi's as `/skill:name`, and codex's as `$name`, a mention codex
resolves inside the message. So the composer also opens on `$` and inserts a
`$` entry without a slash. opencode's adapter lists no skills.

Enter runs a command that takes no argument (it is sent as the message text,
which is how ACP invokes one) and completes one that does; Tab completes.
pi runs an extension's command without starting a run of the agent, and
pi-acp ends that prompt's turn only as yaac patches it
(`dockerfiles/agent-patches/pi-acp.js`).

The model list is the session's `model` config option, read from the
`session/new` or `session/load` reply, from any `session/set_config_option`
reply, and from `config_option_update` (each a `models` event). Every adapter
yaac runs advertises that option and accepts `session/set_config_option` for
it, so `/model` sends that rather than a prompt. claude's own `/model` command
is replaced by the picker. A `models` block is read only when there is no
config option: codex sends both, and its block's ids carry a reasoning effort
(`gpt-6-astra[low]`) that the option's values do not. The new model reaches
the row through the same `onModel` path as a model the adapter reports itself
(see "State").

## Context usage

Beside Send, the composer shows how full the context window is, as a ring
and a percentage. It turns amber at 75% and red at 90%. Every adapter yaac
runs sends ACP's `usage_update` (`used` and `size` in tokens), which becomes
a `usage` event; the pane shows the latest one from the main conversation.
A subagent's report carries its `thread` and is not shown.

## Subagents and background tasks

A TUI lists the subagents and background shells its agent started, and lets
you open one to read it. A chat pane does the same: a strip over the
composer lists what is still running, grouped by category under a label
and count (Agents, Shells, Monitors, Workflows, each with its own icon and
tint, as claude's TUI footer counts "2 shells, 1 monitor"), the transcript
holds a card where each one started, and opening either switches the pane to that subagent's own
transcript or to the task's output. Esc or Back returns. Those views have no
composer, since an agent takes messages only on its main thread.

No protocol standard covers this yet, so each adapter is asked in its own
way, and the projection turns every answer into the same `subagent` and
`task` events:

| tool | subagents | background tasks | Stop |
|---|---|---|---|
| claude | from the Agent SDK's task messages | the same, output in a file | no |
| codex | AIR | AIR, output streamed onto the call | yes |
| opencode | its own child-session notifications | not reported (#297) | no |
| pi | none (pi has no subagents) | none (pi has no background shells) | no |

- **AIR is a client identity, not a feature switch.** claude's and codex's
  adapters report subagents and background tasks only to JetBrains' AIR
  client, and declaring `_meta.jetbrains.air` makes an adapter treat yaac as
  that client in everything it sends. claude then drops a read's text and
  changes how it renders most tool calls, so claude is never told this.
  codex is (`CODEX_CAPABILITIES_META`), and so sends plain ACP's fields and
  a command's output differently. Each adapter's opt-ins live in its profile
  (`capabilitiesMeta`).
- **claude** forwards the Agent SDK's own `task_started`, `task_updated`,
  `task_progress`, `task_notification` and `background_tasks_changed`
  messages once asked in the session's `_meta` (the same channel as its
  running/idle report). A subagent is keyed by the Agent call that spawned
  it, which is what its own updates name (`_meta.claudeCode.parentToolUseId`),
  so its card stands in for that call; its final report arrives in its
  `task_notification` and ends its view. That notification can be skipped,
  so a terminal `task_updated` ends a subagent too, and
  `background_tasks_changed`, which lists every live background task, ends
  a background task or subagent it no longer lists as stopped (cancelled,
  for a subagent) until a later report says how it ended. A foreground
  subagent is never in that list, so only one started or moved to the
  background is ended this way.
  A background command names its output file in its call's result. A
  Monitor tool watch reports itself as a backgrounded shell (`local_bash`),
  so it is named a monitor by the Monitor call that started it, which always
  arrives first. That call is shown as a shell call titled by the command
  it watches, since the adapter titles it just "Monitor", and a task's view
  opens its starting call so the command is in view. A Monitor of a
  WebSocket has no command, so its call keeps the "Monitor" title. A
  plugin's monitor has no such call and still shows as a shell. A monitor
  gets a card and a strip chip like any other task: it is
  work the agent chose to start, and a persistent one runs for the whole
  session. A task claude flags `ambient` (an artifact's live-update watch,
  whether or not the agent was asked for it, which the wire does not say)
  gets a card but no chip, as the SDK asks of activity indicators. claude
  stops a task only for an AIR client, so there is no Stop.
- **codex (AIR)** announces a subagent with `subagent_spawned`, sends its
  updates under the subagent's own session id, and ends it with
  `subagent_state_update`. A background shell arrives as `async_task_spawned`
  and `_state_update`, and `_session/async_task/stop` stops it. Its output is
  streamed onto the call that started it (`terminal_output_delta`, which
  yaac asks for; an AIR client that does not gets a command's output only
  once it ends).
- **opencode** sends `opencode/session/child_update` notifications: `status`
  ones move a subagent through its life, and `update` ones carry one of its
  own `session/update`s, projected as if sent under its id. It reports a
  background shell only as a finished call whose metadata says it is still
  running, with no end and no stop, so yaac shows it as an ordinary call.

The projection tags a subagent's events with a `thread`, and a pane shows
one thread at a time. A subagent's permission asks also show in the main
thread, since an unanswered one blocks the whole turn.

Streamed terminal output is projected as `tool-output` deltas, apart from the
call: it is raw text, shown verbatim rather than as Markdown, and resending
the merged call for every chunk would make a replay grow with the square of
the output. A pane keeps the last 64 KB of a call's output.

A task's output is read one of two ways. With an output file (claude), the
pane asks for its end every two seconds while the task is open and running
(`task-output`), and the server runs `tail` in the workspace, only on a path
the record gave for that task that ends in `/tasks/<id>.output`. Without one
(codex), the pane shows what the starting call streamed.

Both are projected from the record like everything else, so a pane that
attaches late, and a stopped workspace's transcript, show them too. A
stopped transcript can open a subagent but not a task.

## Capabilities yaac declines

In an editor the agent is remote from the files, so the client serves `fs/*`
and `terminal/*` for it. In yaac the agent runs inside the workspace, on the
real checkout, with its own tools, so yaac declines those capabilities. Under
k8s the container boundary (gVisor, the egress proxy, the NetworkPolicy) is
what constrains the agent; under containerless there is no such boundary
(docs/containerless-driver.md).

`session/request_permission` is the one request yaac serves, and its answer
depends on the workspace's posture (docs/permission-modes.md). Under `bypass`
it is granted immediately. Under every other posture it is held open and
forwarded to the chat pane for the user to answer. The adapter is also told
the posture over `session/set_mode`, so it only asks about what that mode
leaves open.

While a request is held, the conversation reports `asking`, which outranks
every other status in the workspace's aggregate; otherwise a blocked agent
would look busiest exactly when it is stuck. Listings send it as `waiting`
with an `asking` flag (`ListedAgentStatus`), so every client alerts on it as
on any wait, a desktop app built before the flag existed included, and an
ask shares the workspace's waiting spell rather than starting its own: an
ask arriving while a sibling already waits does not alert again, and
answering it does not bring back a spell the user already saw. The sidebar
shows its own marker for the flag, read or not, until the ask is answered. A `tui` agent's dialogs cannot be told apart from
its idle prompt (claude's title shows the same glyph for both), so `tui`
conversations never report `asking`.

An ask survives the connection dropping. In the record an unanswered ask is a
request with no reply after it, which is how a reattaching connection and a
pane attaching mid-ask learn of it. Its id is the agent's own (no
per-connection prefix), so the new connection can answer an ask it never
received, and the agent resumes without a restart.

## Images

Users give an agent an image by pasting or dropping it, or by picking it in a
chat pane. Each mode delivers it in the form its agents accept.

**`tui`: a file path.** A terminal carries no images, and an agent's own
paste-image key reads the clipboard of the machine it runs on, which has no
display. Every TUI yaac runs accepts a pasted path to an image file (what a
terminal sends when a file is dropped on it). claude, codex and opencode
attach it immediately; pi keeps the path as text and reads the file during
the turn. So the terminal pane intercepts an image paste or drop, uploads it
(`POST /workspace/:id/attachments`), and pastes the path the server returns.

The server stores the file under the workspace's state dir
(`workspaceAttachmentsDir`), so it lasts for the workspace's current run and
is removed when it stops. The pasted path is the one the workspace sees
(`WorkspacePaths.attachmentsDir`): a read-only mount at
`/home/yaac/.yaac-attachments` in a pod, the host directory under
containerless. Files are named by content hash, so the same image pasted
twice is stored once and names never need quoting.

Off macOS, Ctrl+Shift+V is paste-as-plain-text in browsers, and its paste
event carries no image. For that chord the pane reads the clipboard itself
(`navigator.clipboard.read`, which asks permission the first time) and
attaches an image it finds, unless the clipboard also holds text.

**`acp`: an image block.** ACP carries images in `session/prompt`, and every
adapter yaac runs advertises `promptCapabilities.image`, so a chat message's
images go inline after its text. The server checks each image's magic bytes,
as the upload route does, and caps all of a message's images together at
5 MB (`MAX_ATTACHMENT_BYTES`). A message over the cap is refused whole, and
the composer warns before sending. Because acpd records the prompt, images
are part of the history and show on replay and in a stopped workspace's
transcript. That is why the browser shrinks them first: the long edge to
1568 px (the most a model reads), and a PNG still over 1 MB re-encoded as
WebP or JPEG when smaller.

For large prompts, acpd writes whole lines only, so a multi-megabyte prompt
arriving in chunks is never split by agent output; a client that disconnects
mid-line gets its line ended with a newline, so the agent discards the
fragment. The opening-message scan reads only the record's first 64 KB, but
still finds the text because it is written before the images.

In either pane, a paste that also carries plain text is treated as text,
since office apps put a picture of the copied selection beside the text. A
URL alone doesn't count as text, since Firefox's Copy Image puts one beside
the image.

## Where things live

| Concern | Path |
|---|---|
| Driver interface + factory | `packages/server/src/runtime/agents/drivers.ts` |
| Per-tool adapter profiles | `packages/server/src/runtime/agents/acp-adapters.ts` |
| tmux driver | `packages/server/src/runtime/agents/tui-driver.ts` |
| ACP driver | `packages/server/src/runtime/agents/acp-driver.ts` |
| ACP protocol → `AcpEvent` | `packages/server/src/runtime/agents/acp-protocol.ts` |
| Record reader + tail | `packages/server/src/runtime/agents/acp-log.ts` |
| JSON-RPC peer | `packages/server/src/runtime/agents/acp-jsonrpc.ts` |
| Conversation state | `packages/server/src/runtime/agents/acp-client.ts` |
| Pane bridge (`/acp/attach`) | `packages/server/src/runtime/agents/acp-bridge.ts` |
| Claude TUI transcript replay | `packages/server/src/runtime/agents/claude-acp-replay.ts` |
| Agent supervisor | `dockerfiles/acpd/` (baked into the base image; run from the install under containerless) |
| Record location | `acpLogDir()` in `packages/shared/src/project-paths.ts` |
| Wire types | `packages/shared/src/acp.ts` |
| Chat pane | `packages/frontend/src/components/WorkspaceChat.tsx`, `src/lib/acp.ts` |
| Composer `/` and `$` completion | `packages/frontend/src/components/ComposerMenu.tsx` |
| Subagent and task views | `packages/frontend/src/components/AcpActivity.tsx` |
| Pasted images | `packages/frontend/src/lib/attachments.ts`, `packages/server/src/domain/workspaces/attachments.ts`, `packages/shared/src/attachments.ts` |

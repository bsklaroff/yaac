# Multi-session workspaces

A workspace should be able to run any number of agent sessions: none, one,
or several. Sessions can be `acp` chat panes or `tui` terminals, can mix
tools and modes, and each starts and closes on its own without the
workspace stopping. The workspace keeps what is genuinely shared: the
checkout and branch, the runtime (pod or tmux server), the ports, the
group, the timeout and the title. Everything about a running agent moves
onto the session.

This plan says what that means for the data model, the runtime, the API,
the sidebar, the create screen and the pane system. It also uses the
change to delete a layer of special cases that exist today only because
"the workspace's agent" is singular.

## Where things stand

Storage is already many-to-many. Most of the code above it assumes one
agent.

**Already plural:**

- `agent_sessions` holds one row per conversation, keyed by the tool's
  own id. `workspace_agent_sessions` links a conversation to a workspace
  with `active`, `ordinal` and `paneId`.
- `AgentSessionEntry` on the wire carries each conversation's status,
  mode and model, and the snapshot lists them all.
- The chat pane is addressed per conversation (`acp:<conversationId>`),
  and its model, posture and effort controls act on that conversation's
  socket.
- A restart already brings back every active conversation, each in its
  own window (`agentWindowName`: `claude`, `claude-2`, …).

**Still singular:**

- **Launch settings sit on the workspace row.** `workspaces.mode`,
  `model`, `permissionMode`, `effort` and `pendingPrompt` describe "its
  first agent". `followReportedModes` and `followReportedEfforts` write
  *any* conversation's reported change onto that one shared row, so with
  two agents the last one to report wins. The restart then relaunches
  every agent in that posture.
- **Window 0 is "the agent".** `yaac-workspace-init` opens the tmux
  session with a window named `$YAAC_TOOL` running `sleep infinity`, and
  create then `respawn-window`s the agent into it.
  - `listTerminals` and `killWindowTerminal` treat the lowest-index window
    as the agent and refuse to kill it.
  - The pty `agent` target is `yaac:^`.
  - The stale reaper's `probeAgentPaneState` reaps a workspace whose
    window 0 is still running `sleep`.
- **The mode is per workspace.** k8s stamps `yaac.mode` and `yaac.tool`
  on the pod, and containerless writes `tool`/`mode` into its
  `WorkspaceMarker`. `RuntimeHandle.mode` picks one `agentDriver(mode)`
  for the whole workspace's `WorkspaceStatusWatcher`. A workspace
  therefore cannot hold a `tui` and an `acp` agent side by side. The acp
  driver also only attaches to windows whose name parses as
  `agentWindowName`.
- **Handles are slots, not identities.** A conversation's handle is a tmux
  pane id (`tui`) or an acpd window name (`acp`). These restart from
  scratch with each life, so `recordWorkspaceLife` clears every `paneId`.
  Window names shift when a restart drops an earlier conversation.
- **Several workarounds exist only because the agent's id is not known
  at launch:**
  - The pin: create records a placeholder conversation under the
    workspace id, which the first real one takes over (`SELF_NAMING_TOOLS`).
  - `pendingPrompt` on the workspace row, aimed at "the first agent
    window".
  - An acp record that is written under the workspace id and renamed
    later.
- **Nothing starts or closes a single agent.** No route, CLI command or
  `yaac-mama` command starts an agent in a running workspace. Extra
  agents appear only from a restart or from someone typing `claude` in a
  shell.
- **An agent exiting is not handled.**
  - Agent windows have no `remain-on-exit`, so the window disappears.
  - If it was the last window, tmux exits and the reaper records
    `agent-exited`. Otherwise the workspace runs on with no agent.
  - Neither driver publishes an empty live set, so the exited agent's
    status and `active` flag stay stuck.
- **The frontend assumes one agent:**
  - Agent panes (`'agent'`, `acp:*`) have no close button, because
    `syncPaneLayout` would reopen any live conversation's pane straight
    away.
  - `'agent'` is renamed to the first `acp:` target once that
    conversation exists.
  - `launches` (the create prompt shown until it is echoed) is keyed per
    workspace, so every chat pane in a workspace would show it.
  - The sidebar row shows one tool and model label and an "N agents"
    count.
  - The create screen can only make a new workspace.

## The model

Three nouns, each with one job:

| | Owns | Lifetime |
|---|---|---|
| **Workspace** | checkout, branch, runtime, ports, group, timeout, title, egress | create → stop → restart → delete |
| **Session** (new) | one agent process in one tmux window: tool, mode, model, posture, effort, the prompt it was opened with | open → close; survives workspace stop/restart while open |
| **Conversation** (today's `agent_sessions`) | the tool's own history, keyed by the tool's id | forever, project-scoped |

A session is yaac's object, with a yaac id (a uuid) that is known before
anything launches. A session holds one current conversation and builds up
earlier ones (after `/clear`, `/resume` or `/compact`). "Session" is what
the user sees: one sidebar child row, one pane, one line under its
workspace in `yaac workspace list`.

**The rename.** Today's "agent session" (the tool's conversation) is
renamed **conversation** throughout: `agent_sessions` → `conversations`,
`agentSessionId` → `conversationId`, and `AgentSessionEntry` →
`ConversationEntry`. That frees the word "session" for the new object.
Without the rename, "session" would mean two different things in the
same file. The rename is mechanical and can land as its own commit
before anything else.

### Schema

```ts
/** One agent running (or meant to run) in a workspace. */
sessions = table('sessions', {
  id: uuid().primaryKey().defaultRandom(),
  projectId, workspaceId,          // workspaceId → workspaces, cascade
  tool, mode, model, permissionMode, effort,
  ordinal: integer(),              // display + restore order
  openedAt, closedAt,              // closedAt set = closed for good
  endReason: text().$type<'closed' | 'exited' | 'failed'>(),
  endDetail: text(),
  /** The prompt to send once the conversation is up (acp) or the agent
   *  has drawn (tui); taken by compare-and-set, as today. */
  pendingPrompt: text(),
  /** The conversation it is on now; null until the agent names one. */
  conversationId: text(),
  /** The user's name for this session, if they renamed it. */
  title: text(),
  waitingSeenBy: uuid().array(),
})

/** Every conversation a session has held, replacing
 *  workspace_agent_sessions. */
session_conversations = table(..., { sessionId, projectId, tool,
  conversationId, firstSeenAt, lastSeenAt })
```

**Columns leaving `workspaces`:** `mode`, `model`, `permissionMode`,
`effort`, `pendingPrompt`, `waitingSeenBy`.

**Columns staying on `workspaces`:** `timeZone`, `mamaTokenHash`,
`lifeStartedAt`, and the deadline and title fields.

**`workspace_agent_sessions` is dropped.** A workspace's history is the
union of its sessions' conversations.

**Session states:**

| State | Rule |
|---|---|
| open | `closedAt` is null. A running workspace has a window for every open session, and a restart brings back exactly its open sessions. |
| closed by the user | The window is killed, `closedAt` is set and `endReason` is `closed`. Its conversations stay in history and can be resumed into a new session. |
| exited on its own | The agent quits, crashes, or fails its handshake. The window stays (`remain-on-exit on`), and the session reports `exited` with the exit status. Its pane then shows *Agent exited — Resume / Close*. A restart resumes it like any other open session. |

**The migration.** For each `workspace_agent_sessions` link:

- **Active links** become an open session. It copies the row's posture
  and effort, takes `mode`/`model` from the conversation (else the row),
  takes `conversationId` from the link, and records `legacyHandle =
  paneId`.
- **Inactive links** become closed sessions, so history keeps its
  grouping.
- **Rows with no links** (no agent ever reported) become one open session
  built from the row's settings and `pendingPrompt`.

## Runtime

### Window 0 is a keeper, never an agent

`yaac-workspace-init` opens the tmux session with a hidden window `_yaac`
running `sleep infinity`, and no agent is respawned into it. A workspace
with no sessions then keeps a live tmux server, so "0 sessions" is an
ordinary running state. This lets us delete:

- `YAAC_TOOL` from the init env.
- The `respawn-window -k -t yaac:<tool>` path in `buildWindowsExec` and
  `retoolSpare`.
- `probeAgentPaneState` and `agentStartedCache`, together with the
  reaper's `never-started` placeholder branch. A create cut off before
  its agent launches now leaves a workspace with an open session that has
  no window yet. The reconcile loop launches that session (below), so
  nothing is left stuck.
- The `yaac:^` meaning of "the agent". Anyone attaching via `yaac
  workspace attach` lands on the first session's window, or a shell if
  there are no sessions.

### A session is a window, and its id is its handle

Each session runs in its own window. The window is named for display
(`claude·a1b2`) and tagged with tmux window options
`@yaac-session=<id>` and `@yaac-session-mode=<tui|acp>`.

- The watcher identifies windows by the option, never by the name, so a
  user renaming a window in tmux breaks nothing.
- acpd's socket is `/tmp/yaac-acp/<sessionId>.sock`, and a fresh record
  starts under the session id. It is still renamed to the conversation
  once known, because history is per conversation.
- The status store, `paneId`, the acp registry key and the pty target all
  use the session id. A session id is stable across lives, so
  `recordWorkspaceLife` no longer clears handles, and restart order no
  longer shifts names.

**`agentWindowName` and `agentWindowTool` go.** Terminal listing becomes
"windows with no `@yaac-session` that aren't the keeper", so
`listTerminals` no longer treats the lowest index specially.
`killWindowTerminal` refuses only the keeper; session windows are closed
through the session route.

### One watcher, both modes

`WorkspaceStatusWatcher` stops taking a mode. It keeps the single
control-mode client it already has and lists windows with their
`@yaac-session*` options:

- For each `tui` session window it subscribes the pane options it
  subscribes today (`@yaac-session`, `@yaac-model`,
  `@yaac-permission-mode`, `@yaac-effort`) and classifies status from
  the pane.
- For each `acp` session window it holds an `AcpConversation`, as
  `acp-driver.ts` does today.

`agentDriver(mode)` survives only as the per-session launch and
observe strategy: `launchCmd(spec)`, `observe(sessionWindow, sink)` and
`deliverPrompt`. It no longer chooses how a whole workspace is watched.
That means we can remove:

- the k8s `yaac.mode` / `yaac.tool` pod labels and the label patch in
  `claim.ts`;
- the containerless marker's `tool` and `mode`;
- `RuntimeHandle.mode` and `.tool`;
- the "(prewarmed && mode !== 'acp')" skip in the watcher manager.

The observation becomes **`live-sessions`**: session id →
`{conversationId?, model?, posture?, effort?, status, exited?}`. It is
always published, *including when empty*, which fixes the stuck status
after the last agent exits. The registry turns it into
`session-observed` events, and `applyWorkspaceEvent` writes those to the
**session** row:

- A reported model, posture or effort moves that session alone.
  `followReportedModes`'s "only a change is recorded, since the row is
  shared" caveat goes away.
- A new `conversationId` appends a `session_conversations` row. This is
  how `/clear` is recorded.

**Conversations started by hand in a shell window** (`claude` typed in a
terminal) are still discovered from the pane option and recorded in
history against the workspace, as now. They are not sessions while they
run: no status and no sidebar row. A restart turns each one still live
at stop into a `tui` session, which is what today's restart already
does in effect. Adopting them live would make closing such a "session"
kill the user's shell, which is the wrong ownership.

### Declarative launch

Sessions become desired state that the reconcile loop drives, which is
the same pattern `docs/event-driven-reconcile.md` already uses for
workspaces. The rule: **every open session of a running workspace has a
window; a missing one is launched.** This one rule covers four cases
that each have their own code today:

- **create:** insert the workspace row plus an open session, then
  provision. The session's window is launched like any other.
- **restart:** clear `exited`, then provision. Every open session is
  launched with resume of its `conversationId`. The per-conversation
  "history is missing, so fail" check from `resumePlan` stays, but per
  session.
- **new session in a running workspace:** insert the row. The pass
  launches it.
- **interrupted create or server crash mid-launch:** the next pass
  finds the open session with no window and launches it.

**Guarding against double launches.** A session is launched at most once
per life, guarded by a `launchedLife` column compared against
`lifeStartedAt`. An exited window still exists, so the rule never
relaunches an agent the user quit; only Resume (or a restart) does.

**Prompt delivery:**

- `pendingPrompt` moves to the session. Under `acp` it is delivered to
  *that session's* conversation once its handshake completes. Under `tui`
  it is pasted into *that session's* window.
- The "first agent window" special case in
  `reconcileWorkspaceAgentSessions` and `handOverAgent` goes.
- **The pin goes.** The session row records the tool, launch model and
  prompt from the start, so nothing needs to stand in for a conversation
  before the agent names one. With it go the takeover logic in
  `recordAgentSessions` and the `SELF_NAMING_TOOLS` special case.

### Liveness, death and the reaper

A workspace is alive while its runtime and tmux server are. Sessions
coming and going never change that.

- `agent-exited` stops being a workspace death reason. An agent exit is
  a session's `endReason: 'exited'`.
- A tmux server dying under a running pod is recorded as `crashed`. Old
  rows keep their `agent-exited` label at read time
  (docs/legacy-compat-shims.md).
- A workspace with no open sessions is **not** auto-stopped. It still
  holds a checkout, ports and maybe a dev server, which is often the
  point. The existing timeout covers idle cost.

### Posture ceiling for `yaac-mama`

The ceiling stays **the calling agent's own posture**.

- **How the caller is identified.** Every session launch sets
  `YAAC_SESSION_ID` in the agent's environment. The agent's tool calls
  inherit it: a `tui` agent's shell commands and an `acp` adapter's
  commands under acpd both see it. `yaac-mama` sends it with each request.
- **How the server checks it.** The server identifies the workspace as
  it does today: the bearer token under containerless, the pod's source
  IP under k8s. It accepts the session id only if it names an **open
  session of that workspace**, and refuses anything else. The ceiling is
  that session row's posture, which follows the agent's reported mode.
  This works across restarts because the session id is stable.
- **Calls with no session id.** These come from a user's shell, or from
  an agent started by hand in one. They get the **strictest posture among
  the workspace's open sessions**. With no open session, they get the
  posture a create would resolve for the project. The fallback is meant
  to be conservative rather than to guess which agent is calling.

This is not a security boundary. Any process in the workspace can set
the variable, or type into another session's window. What it gives is
the same guardrail as today: an agent in `plan` cannot spawn a `bypass`
sibling just by asking.

### Prewarmed spares become sessionless workspaces

Today a spare is warmed for one `{mode, model, posture, effort}` and is
retooled on claim (`retoolSpare` renames and respawns window 0). Under
the new model:

- A spare is a running workspace with no sessions.
- `spareSettings` keeps only zone, image, base branch and scratch dirs.
- A claim inserts the row and the requested session. The normal launch
  rule then starts it.

We can delete `retoolSpare`, the agent respawn in `rebranchSpare`, the
mode filter in `tryClaimPrewarmed`, the preference for "spares whose
tool/model already match", and the warm-time acp handshake path
(`whenAcpConversation`'s pane-pid dance on claim).

**The cost:** a claimed `acp` session waits for its adapter to start
(about 2 s for claude) instead of finding a warm handshake. Measure it
first. If it matters, a spare can carry a "warm session" for the
project's default settings, which a claim keeps if it matches and closes
otherwise. That is still a close plus a launch, never a retool.

## API, CLI, `yaac-mama`

**Routes** (each one gets a `test/api/route-matrix.ts` row for both
drivers, and none differs by driver):

| Route | Purpose |
|---|---|
| `POST /workspace/create` | Workspace fields, plus an optional `session: {prompt?, tool?, model?, mode?, permissionMode?, effort?}`. With no `session`, the workspace has no agent. The flat agent fields move under `session`. |
| `GET /workspace/:id/sessions` | `SessionEntry[]` (open first, then closed), each with its conversations. Replaces `/agent-sessions`. |
| `POST /workspace/:id/sessions` | Open a session: the same shape as create's `session`, plus `resume?: conversationId`. Resolved through `resolveCreate`, which records project defaults as a create does. Answers with the entry immediately, without waiting for the launch. |
| `POST /workspace/:id/sessions/:sid/close` | Kill the window and set `closedAt`. |
| `POST /workspace/:id/sessions/:sid/resume` | Relaunch an `exited` session on its conversation. |
| `POST /workspace/:id/sessions/:sid/title` | Rename a session. |
| `GET /workspace/:id/conversations/:cid/transcript` | Unchanged apart from the rename. History stays per conversation. |
| WS `/api/acp/attach?id=&session=<sessionId>` | Attach by session. The bridge resolves the session's current conversation, so a `/clear` in an acp pane keeps the same socket target. |
| WS `/api/pty/attach?target=session:<id>` | Resolved to the window through the watcher's listing. |

**Snapshot.** `WorkspaceListEntry` drops `tool`, `mode`, `permissionMode`
and `effort`, and replaces `agentSessions` with
`sessions: SessionEntry[]` (open ones only) plus `history` on the detail
route. `SessionEntry` carries `{id, tool, mode, model, modelName,
permissionMode, effort, title?, prompt?, status?, asking?, waitingSinceMs?,
waitingSeenBy, exited?, ordinal, conversationId?}`. Workspace `status`,
`asking` and `waitingSinceMs` stay as the roll-up over sessions, with the
same precedence as today. A workspace with no sessions reports
`status: 'idle'`, a new value that sorts below `background`. Before
shipping it, check how an older desktop app reads a status it does not
know; it must not read it as waiting.

**Commands.** The `yaac` CLI and `yaac-mama` have the same shape. There
is no separate `session` command group. Whether work gets a new workspace
or a session beside an existing one is an option on the commands that
exist today.

- **`create`** (`yaac workspace create [<project>]`,
  `yaac-mama create`).
  - **No `--workspace`:** it does what it does today. It makes a new
    workspace whose first session runs the prompt, and the agent flags
    describe that session.
  - **`--workspace <w>`:** it opens a session in that running workspace.
    For `yaac-mama` that can be the caller's own workspace, giving another
    agent on the same checkout. The CLI's `<project>` is then omitted,
    since the workspace implies it.
    - Only the session options are accepted: `--tool`, `--model`,
      `--effort`, `--permission-mode`, `--mode` (`--ui-mode` in
      `yaac-mama`), the prompt, and `--title` for the session's title.
    - The workspace options are refused, as any option a command doesn't
      take is today: `--branch`, `--group`, `--timeout`, `--start-at` and
      `--start-in`.
  - **`--no-session`:** it makes a workspace with no session. It is
    refused together with `--workspace`, a prompt, any session option, or
    a later start (`--start-at`/`--start-in`).
  - **`--resume <conversation>`:** opens the session on an earlier
    conversation of the project, in a new workspace or an existing one.
    A prompt given with it is sent after the resume.
  - **Posture ceiling:** it applies to every `yaac-mama create` that
    opens a session. A workspace made with `--no-session` runs no agent
    to cap. Opening a session in it later is capped like any other.
- **`stop [--session] <target>`** (`yaac workspace stop`, `yaac-mama
  stop`).
  - **Without `--session`:** it stops the whole workspace, as today.
  - **With `--session`:** `<target>` names a session rather than a
    workspace, and only that session closes. The workspace keeps running,
    with no agent if that was its last session; the reply says so and
    says how to stop it.
  - **`yaac-mama` only:** `<target>` may be omitted, and then means the
    caller's own workspace (no `--session`) or its own session (with
    `--session`, from `YAAC_SESSION_ID`; refused when that is unset).
- **`yaac-mama send [--session <s>] <workspace> "<message>"`.**
  - It targets the named session, else the workspace's first open
    session. `--conversation` stays and resolves to the session holding
    that conversation.
  - Today `send` refuses the caller's own workspace. It now accepts it
    when the target is a *different* session, and refuses only the
    caller's own session.
- **`list`** (`yaac workspace list`, `yaac-mama list`) shows each
  running workspace's open sessions under it (id, tool · model, status,
  title), so they can be addressed.
- **`yaac workspace attach <workspace> [--session <s>]`** selects that
  session's window. Without `--session` it selects the first session's
  window, or a shell when there is none.
- **`yaac workspace agents`** is renamed `yaac workspace conversations`.
  It lists the history that `--resume` takes ids from.
- **`queue`, `edit-queued` and the routine commands** always make new
  workspaces with a session, so they take neither `--workspace` nor
  `--no-session`. A queued, scheduled or draft entry therefore always
  carries a session spec.

Every new argument and option needs an e2e test. The CLI's tests go in
`test/e2e-cli/` and `yaac-mama`'s beside its existing ones. Fold them into
one `session-suite` per tier.

The `yaac-mama` skill (`builtin-skills/yaac-mama/SKILL.md`) and the
`workspace-bin/yaac-mama` usage text change with these. That includes the
skill's description, so that "start another agent on this checkout"
triggers it.

**Queued entries, routines and drafts** keep their one agent spec, which
becomes "the first session's spec" and is always present. A workspace
with no session is only ever created immediately. A queued child inherits from its parent's first open session,
else from the project's defaults (today it uses `firstAgentSession`,
else the row). Queuing a session *into* a running workspace is not part
of this plan.

## Frontend

### Panes

**One target per session: `session:<id>`.** It replaces both `'agent'`
and `acp:<conversationId>`. `WorkspaceView` picks the renderer from the
session's mode:

- `WorkspaceChat` for `acp`. It absorbs `AcpStartingPane`'s "Starting
  claude…" state, since the target no longer changes when the
  conversation appears.
- `WorkspaceTerminal` for `tui`.

**`syncPaneLayout` gets simpler:**

- Add a pane for each open session not yet in the layout, as a tab in
  the focused column rather than a new column once there are three or
  more.
- Remove the pane of a closed session.
- Keep the shell-window handling as it is.
- The `'agent'` → `acp:` rename and the "keep `agent` only while no
  conversation exists" rule both go.

`isAgentPane` goes, and every pane gets an ×.

**Closing a session pane:**

- If the session is running or asking, × asks *"Close Claude · Opus 5.5?
  The agent stops; its conversation stays in this workspace's history"*.
  If it is waiting, it closes at once.
- It calls `/sessions/:sid/close` and removes the pane optimistically,
  as `killPane` does for terminals.

**An exited session's pane** shows the exit status and the tail of the
pane (tui) or acpd's log (acp), with **Resume** and **Close** buttons.
Today the pane vanishes without explanation.

**Starting a session from inside a workspace.** `PaneBar`'s new-pane menu
gets **New session** above New shell, with a `new-session` shortcut. It
opens a **composer pane** (`compose:<draftKey>`, a special pane) holding
the agent half of the create form: prompt, tool, model, UI mode, posture
and effort. Send posts `/sessions`, and the composer pane is renamed in
place to the new session's target, so the layout does not jump.

**Other pane changes:**

- `launches` (the prompt shown until it is echoed) is keyed by session
  id.
- Chat drafts stay per conversation. A brand-new session's draft is keyed
  by session id until it has a conversation.

**Empty state.** A workspace with no session panes and no other panes
shows a centered "No sessions running" panel with:

- **New session** and **New shell** buttons.
- The workspace's past conversations, each with **Resume** (which opens
  a session with `resume`) and **Read** (which opens the read-only
  transcript as a pane).

Running workspaces have no way to browse history today. This panel
provides one.

### Sidebar

A workspace row stays the unit of navigation. Sessions show as children
only when there is something to choose between.

| Sessions | Rendering |
|---|---|
| 0 | One row. The status mark is a hollow ring for `idle`. The meta line reads "No agent", with an inline **+** that opens a composer pane. |
| 1 | One row, as today. The session's status, unread dot and tool · model label are the row's. |
| 2+ | The workspace row shows the roll-up status and "3 sessions", with a disclosure chevron. Its children are indented rows, one per open session, each with its own `StatusMark`, its title (session title, else the conversation's agent title, else the prompt's first line, else "Claude 2") and its tool · model. |

**How the rows behave:**

- Clicking a child selects the workspace and focuses that session's pane
  (`focusTerminal` with `session:<id>`).
- Children are expanded by default while any of them is waiting or
  asking, and otherwise remember the user's toggle. The toggle is stored
  per workspace in the persisted ui store.
- Alt+J/K (`sidebarRowIds`) walks visible child rows, so jumping to "the
  next thing waiting for me" lands on the session.
- The row menu gains **New session** and keeps Stop. A child's menu has
  Rename, Close and Move to new workspace (out of scope; listed only to
  reserve the slot).

**Unread state moves to sessions.** `waitingSeenBy` becomes per session,
so a session waiting in a background tab keeps its dot after you have
looked at a sibling.

- A session is marked seen when its pane is visible and focused, using
  the same rule App.tsx applies to the workspace today, at session
  granularity.
- The workspace dot is "any session unread".
- The desktop app's waiting notifications and dock badge count sessions.
- `/events` names the session, so a notification click can focus it.

**Stopped rows** show "N sessions" in place of one tool label when they
had more than one.

### Create screen

`NewWorkspacePane` gains a **Where** field at the top: **New workspace**
(the default) or one of the running workspaces, chosen from a typeahead
over `snapshot.workspaces`. It is preselected when opened from a
workspace's **New session**.

**Choosing a running workspace hides the workspace-only fields:** Base
branch, Group, Start (after / at / schedule / when room), Timeout and
Title. Prompt, Agent, Model, UI, posture and effort stay, and Submit
posts `/sessions`. Drafts are not offered for this target in v1, since
a draft is a create request. The composer pane above is this same form
in its existing-workspace shape, so the form's agent half is extracted
once (`SessionFields`) and used in both places.

**An Agent option `None`** creates a workspace with no session. Choosing
it disables the prompt and the agent fields, and limits Start to Now,
matching `--no-session`. "Start without a prompt" still starts an agent
with no prompt, as it does today.

### Read-only and mobile

- `ReadOnlyTranscript` groups tabs by session, then by conversation
  within a session (most have one). A stopped workspace's view lists
  closed sessions after the ones that were open at stop.
- Mobile keeps one pane on screen. The tab strip lists sessions first,
  and `PaneOverflowMenu` gains New session. The sidebar's child rows
  (shared with `WorkspacesScreen`) are how a phone user jumps straight
  to a session.

## Things that read "the workspace's agent" and their new answer

| Reader | Today | New |
|---|---|---|
| Workspace title (docs/workspace-titles.md) | user → opening conversation's agent title → generated | user → agent title of the first session's opening conversation → generated → branch name for a workspace that never had a session |
| `WorkspaceListEntry.prompt` | `openingPrompt(links) ?? row.pendingPrompt` | same over the first session's conversations, then its `pendingPrompt` |
| Queued child defaults | `firstAgentSession`, else row | first open session, else project defaults |
| `yaac-mama` posture ceiling | caller row | the calling session (`YAAC_SESSION_ID`), else the strictest open session |
| `yaac-mama send` default | first live conversation | the workspace's first open session; `--session` picks another, and only the caller's own session is refused |
| Restart mode / posture | `active[0].mode`, row posture | each session's own |
| `projects.lastTool`, `project_tool_defaults` | written by create | written by every session open that names settings |
| Generated title for pi | opening conversation's tool | first session's tool |
| Group `workspaceLimit` | counts workspaces | unchanged |

## What gets deleted

This is the payoff of doing the refactor rather than layering
multi-session on top:

- The pin and its takeover (`recordAgentSessions` pin branch,
  `SELF_NAMING_TOOLS` in the stores and restart).
- `agentWindowName`/`agentWindowTool`, slot-shifting window names, and
  the `paneId` reset in `recordWorkspaceLife`.
- Window 0 as the agent: the init placeholder respawn,
  `probeAgentPaneState`, `agentStartedCache`, the reaper's placeholder
  branch, and `killWindowTerminal`'s lowest-index refusal.
- Per-workspace mode: the `yaac.mode`/`yaac.tool` labels, the marker
  fields, `RuntimeHandle.mode`/`.tool`, and the watcher's mode selection.
- `retoolSpare`, the spare settings match, and the warm acp handshake
  hand-over.
- The "first agent window" prompt routing in `handOverAgent` and
  `reconcileWorkspaceAgentSessions`.
- `followReportedModes`'s shared-row reasoning, and the
  `workspaces.mode`/`model`/`permissionMode`/`effort`/`pendingPrompt`
  columns.
- Frontend: `'agent'` target handling, `isAgentPane`, the
  `syncPaneLayout` rename, the `'agent'` wrapper in `AcpStartingPane`, and
  `defaultPaneTarget`'s fallback.

## Legacy compatibility

Each item gets its own entry in docs/legacy-compat-shims.md in the change
that adds it:

- **Running workspaces at upgrade.** Their windows carry no
  `@yaac-session` option. On its first listing, the watcher matches each
  unnamed agent window to a migrated session by `legacyHandle` (the old
  `paneId`: a pane id or an acpd window name) and stamps the options. A
  legacy acp session keeps addressing its old socket path, read from
  `legacyHandle`, until the workspace restarts. The shim is safe to
  delete once no running workspace's `lifeStartedAt` predates the
  release. If it is deleted too early, those workspaces' agents silently
  go unwatched (no status, no pane).
- **`agent-exited` on stopped rows.** This is display only. It can go
  when retention has aged those rows out or the label is folded into
  `crashed`.

Running a pre-upgrade window 0 that holds an agent is fine: it is matched
like any other window. That workspace simply has no keeper until it
restarts, so closing its last session there ends tmux and the workspace.
The shim entry has to say this.

## Phases

Each phase lands green on its own.

1. **Rename.** `agent_sessions` → `conversations` and the
   `agentSessionId` family, server, wire and frontend. Mechanical only;
   behavior unchanged.
2. **Sessions table.** Add the `sessions` and `session_conversations`
   tables with the migration, and move the per-agent columns off
   `workspaces`. Point every reader in the table above at sessions.
   Window naming and handles stay as they are, carried in
   `legacyHandle`. Behavior is unchanged except that posture, model and
   effort follow each agent separately (a fix).
3. **Runtime.** This phase covers:
   - the keeper window, session-tagged windows and session-id handles;
   - the mode-agnostic watcher and the `live-sessions` observation;
   - declarative launch and per-session prompt delivery;
   - `remain-on-exit` with exited state;
   - reaper and death-reason changes;
   - sessionless spares;
   - the upgrade shim.

   After this phase, mixed-mode workspaces work server-side.
4. **API, CLI and `yaac-mama`.** Session routes, `create` with an
   optional session, and route-matrix rows. The shared command shape
   (`create --workspace|--no-session|--resume`, `stop --session`,
   `send --session`, sessions in `list`) in both the CLI and `yaac-mama`,
   with the skill text and the `session-suite` e2e tests.
5. **Frontend.** Session pane targets, closable panes and the exited
   state, the composer pane and empty state, sidebar children and
   per-session unread, and the create screen's Where field and Agent:
   None.
6. **Docs.**
   - Fold this plan into a `docs/sessions.md` reference.
   - Update agent-modes, workspace-storage ("Agent workspaces"),
     permission-modes ("Following the agent", the ceiling),
     effort-levels, terminal-mirror (`yaac:^`), workspace-titles,
     queued-workspaces, multi-user, mobile-layout and
     event-driven-reconcile.
   - Grep for citations of anything renamed.
   - Delete this plan.

## Tests

- **Unit (`packages/server/test/`).**
  - The registry and `applyWorkspaceEvent` tests move to session rows.
  - `fakeCluster`-backed tests drop the pod mode label.
  - The watcher test drives a workspace with one `tui` and one `acp`
    window through a single control-mode stream, which is the case that
    cannot exist today.
  - Declarative launch is covered through the reconcile pass with an open
    session and no window, and again after a simulated server restart.
  - Per-session posture following: two sessions reporting different
    modes leave two different rows.
- **API.** Rows for the new routes in both columns. Behavior goes in
  `write-routes.test.ts`: open, close, resume and title, plus create with
  and without `session`.
- **e2e (containerless runnable in-workspace; k8s host-only).** One
  `session-suite` per tier sharing a single workspace:
  - open an `acp` and a `tui` session beside the create's;
  - send to each;
  - close one, and check the window is gone and the workspace is still
    running;
  - let one exit, then Resume it;
  - stop and restart, checking that exactly the open sessions return on
    their conversations;
  - create `--no-session`, then open a session in it with
    `create --workspace`;
  - `stop --session` on the last session, checking that the workspace
    keeps running.

  The destructive cases run last, per the e2e rules.
- **Playwright script** in `test-playwright-scripts/` covering the
  sidebar disclosure, closing a session pane, the composer pane's
  rename-in-place, and the empty state.

## Open questions

1. **Auto-stop sessionless workspaces?** The plan says no. A
   project-level "stop N minutes after the last session closes" setting
   could come later, if idle workspaces turn out to pile up.
2. **Should shells be sessions too** (persisted, restored on restart)?
   The plan says no: shells stay tmux-only and are not restored.
   Restoring them is a separate feature, and the `session` kind could
   absorb it later with `mode: 'shell'`.
3. **Warm session on spares.** Measure the claim latency first (see
   "Prewarmed spares").
4. **Move a session to another workspace** (a conversation can already be
   resumed across workspaces). Leave out of v1; Resume into a new session
   covers most of it.
5. **The herdr plan** (docs/plans/herdr-integration.md) maps each herdr
   terminal to a yaac window. Session-tagged windows with stable ids make
   that mapping direct, so that plan should be revised on top of this
   one rather than beside it.

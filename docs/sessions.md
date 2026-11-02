# Sessions

A workspace runs any number of agent **sessions**: none, one, or several,
in either mode (`tui` or `acp`, docs/agent-modes.md) and with any tool. Each
session is one agent process in a tmux window of its own. It starts and
closes on its own, and the workspace keeps running whatever its sessions
do. What a workspace owns is shared by its sessions: the checkout and
branch, the runtime (pod or tmux server), the ports, the group, the timeout
and the title.

Three nouns, each with one job:

| | Owns | Lifetime |
|---|---|---|
| **Workspace** | checkout, branch, runtime, ports, group, timeout, title, egress | create → stop → restart → delete |
| **Session** (`sessions`) | one agent in one window: tool, mode, model, posture, effort, the message it was opened with | open → close; survives a workspace stop and restart while open |
| **Conversation** (`conversations`) | the tool's own history, keyed by the tool's id | forever, project-scoped |

yaac mints a session's id before anything launches. The id names the
session's window (`<tool>-<first 8 of the id>`), and that window name is
its **handle**: the status store's key, the acpd socket's name under `acp`
and the pane target the webapp opens (`session:<id>`). None of these
change across restarts or a `/clear`. The conversation an agent holds is
reported by the agent and can change under the session; a session keeps a
link to each one it held (`workspace_conversations.sessionId`). An agent
started by hand in a terminal is not a session: its conversation is linked
to the workspace alone.

## A session's row

`sessions` holds what the agent runs with, and each field follows what the
agent reports (`followSessionReports` in `#domain/workspaces`, recorded as
a `session-reported` event): its conversation, its model, its permission
mode and its effort. Each row follows only its own agent, so a restart
relaunches each one as it was, and an agent's Shift+Tab never moves its
siblings.

- **Open** is a row without `closedAt`. A running workspace has a window for
  each open session, and a restart brings back exactly the open ones.
- **Closed** (the user's close, `yaac workspace stop --session`, `yaac-mama
  stop --session`, or its window killed from inside tmux): the window is
  killed and the row keeps `closedAt`. Its conversations stay in the
  workspace's history and can be resumed into a new session.
- **Exited**: the agent quit or crashed. Session windows are set
  `remain-on-exit`, so the window stays with a dead pane, and the listing
  marks the session `exited`. Its pane offers Resume (a fresh window on its
  conversation) and Close. A restart resumes it like any open session.

An `acp` session's opening message waits on its row (`pendingPrompt`) until
its conversation has finished its handshake, and is taken by
compare-and-set before it is sent, as docs/agent-modes.md "State"
describes. A `tui` session's is typed into its window once, on its first
launch, never on a resume.

## Launching

`launchSessions` (and `createWorkspace`, for a create or a restart) builds
each open session's command with its own mode's driver, on its own model,
posture and effort, with `YAAC_SESSION_ID` exported for the agent's
commands. A session whose agent has named a conversation resumes it if its
history is where its tool keeps it; one the rows say wrote history that is
gone refuses the launch rather than start the work over
(`planSessionResumes`). A fresh `tui` claude or pi session is launched with
its session id as the conversation id.

Launching is also a reconcile step (`reconcileSessions`): every open
session of a running workspace whose setup is done has a window, so one
opened while the workspace was stopped, or one a server restart cut off
mid-launch, is launched there. A window that was seen in this life and then
vanished was killed from inside tmux, which closes its session.

## The workspace without an agent

Window 0 of every workspace is the **keeper** (`KEEPER_WINDOW`): a
keepalive that holds the tmux server open whatever its sessions do, so a
workspace with no sessions is an ordinary running state, and no session
exiting ever ends the workspace. Each driver opens it as
`KEEPER_STARTING`, and the create renames it once its setup has finished,
which is how the stale reaper tells a create that died partway through
(`probeSetupState`, death reason `never-started`) from a workspace that
simply runs no agent. A workspace with no running session lists as `idle`.
It is not stopped for that; its timeout covers what it costs.

## Watching

A workspace's status watcher holds one connection per mode, each watching
only that mode's sessions (the drivers read the open sessions on every
window listing). The `tui` connection subscribes the first pane of each
`tui` session's window; the `acp` one dials each `acp` session's acpd
socket. Both subscribe to each session pane's death, so an exit, and a
resume that brings the pane back, is seen at once, and both publish their
live agents after every listing, empty included, so a session whose agent
exited loses its agent's status. The watcher also lists the workspace's
windows; the listing decides which windows are terminals (all but the
keeper and the sessions') and which sessions have exited, by each window's
first pane, where its agent runs.

An exited session waits on the user to resume or close it, so it lists as
`waiting` (with `exited`), in a spell that began when its pane was first
listed dead. The workspace's status is its most pressing session's. Unread
state is per session (`sessions.waitingSeenBy`): the webapp marks a session
seen when its pane is on screen, a resume ends an exited session's spell,
and a workspace shows the unread dot while any of its sessions is unread.
The chime and the desktop app's notifications key each session's spell
(`packages/shared/src/waiting.ts`), so a session that starts waiting alerts
even while a sibling already waits.

## Opening, closing and resuming

| | API | CLI | `yaac-mama` |
|---|---|---|---|
| New workspace with a session | `POST /workspace/create` | `yaac workspace create <project>` | `yaac-mama create "<prompt>"` |
| New workspace, no session | `… { noSession: true }` | `--no-session` | `--no-session` |
| Session in a running workspace | `POST /workspace/:id/sessions` | `yaac workspace create --workspace <id>` | `yaac-mama create --workspace <id>` |
| Resume one of its conversations | `… { resume }` | `… --resume <conversation>` | `… --resume <conversation>` |
| Close a session | `POST /workspace/:id/sessions/:sid/close` | `yaac workspace stop --session <sid>` | `yaac-mama stop --session [<sid>]` |
| Resume an exited session | `POST /workspace/:id/sessions/:sid/resume` | | |
| Rename a session | `POST /workspace/:id/sessions/:sid/title` | | |

With `--workspace`, only a session's settings are taken (tool, model,
effort, posture, UI mode, its title); a workspace's (branch, group,
timeout, a later start) are refused. A conversation resumes only in the
workspace that holds it. Queued entries, routines and drafts always start a
new workspace with a session. `yaac workspace list` and `yaac-mama list`
show each running workspace's open sessions under it.

## `yaac-mama` and the calling session

Every session's launch exports `YAAC_SESSION_ID`, and `yaac-mama` sends it
with each request. The server takes it only as one of the calling
workspace's open sessions (`mamaCaller`). The caller's ceiling (what it may
start or message, docs/permission-modes.md) is then that session's
posture. A call from outside any session, such as a user's shell, gets the
strictest posture among the workspace's open sessions; with none open,
among those closed during its current life, since an agent's detached
child can outlive its session; and with neither, what a create would
resolve. A posture this build does not rank counts as the strictest. Anything in the workspace can set the variable or
type into another session's window, so this is a guardrail, not a
boundary. `send` reaches any session but the caller's own, in another
workspace or beside it in its own.

## The webapp

- **Panes.** Each open session is a pane, `session:<id>`, rendered by its
  mode (`SessionPane`): a chat for `acp`, the agent's terminal for `tui`.
  An `acp` session whose agent has not named a conversation shows its
  opening message and a spinner, with acpd's log a click away. Every pane
  has a ×; closing a session asks first only while its agent is mid-turn.
  A workspace with no pane open shows what it can start and the
  conversations it held, each resumable (`EmptyWorkspace`).
- **Sidebar.** A workspace with no session reads "No agent" with a hollow
  ring; with one, its agent; with several, "N sessions" and a row per
  session under it, each with its own status and unread dot, which opens
  the workspace on that session's pane.
- **Starting one.** The new-workspace pane's Where field aims it at a
  running workspace, which hides the workspace-only fields and opens a
  session there; New session in a workspace's bar or row menu opens it
  aimed. Its Agent field's None creates a workspace with no session.

## Where things live

| Concern | Path |
|---|---|
| Session rows | `packages/server/src/db/session-store.ts` |
| Open, close, resume, reconcile | `packages/server/src/domain/workspaces/sessions.ts` |
| Launch commands and resume planning | `packages/server/src/domain/workspaces/session-launch.ts` |
| What agents report, onto their sessions | `packages/server/src/domain/workspaces/conversation-registry.ts` |
| Window specs and the keeper | `packages/server/src/runtime/agents/setup-commands.ts`, `KEEPER_WINDOW` in `drivers/contract.ts` |
| Per-mode watcher lanes | `packages/server/src/runtime/status/status-watcher.ts` |
| Session panes | `packages/frontend/src/components/SessionPane.tsx`, `src/lib/panes.ts` |

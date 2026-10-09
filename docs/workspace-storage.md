# Workspace storage

A yaac workspace is a row in the `workspaces` table of the server's PGlite DB
(`packages/server/src/db/schema.ts`), keyed by workspace id. The substrate
decides whether a workspace is *running*. The row holds everything else: which
workspaces have ever existed, their title, base branch, sidebar group, and when
and why they stopped.

The row does not store the tool or the founding message. Both are read off the
workspace's **first agent session**. A workspace can hold conversations with any
mix of tools, so "the workspace's tool" is not a property of the workspace.
Reading the founding ask the same way means it survives a `/clear`: the new
conversation is a second row, and the first one's opening message stays the
label.

A row corresponds to exactly one checkout: a clone that borrows the main
clone's objects (docs/server-git.md). Teardown never removes the checkout, so a
stopped row is a checkout still on disk, with its git state and diff, ready to
restart.

Every sweep is driven by rows, so a checkout without a row is never collected
automatically. Guessing "garbage" from disk alone is how a sweep deletes the
only copy of someone's work. The code paths that delete a row therefore delete
its files too.

Agents inside a workspace are separate rows. `agent_sessions` has one row per
tool-native conversation (a claude, codex, pi or opencode session, keyed by the
id the tool chose). `workspace_agent_sessions` links the two, so a workspace
can accumulate conversations and one conversation can be resumed into a second
workspace. See "Agent workspaces" below.

`db/workspace-store.ts` owns the `workspaces` table and
`db/agent-session-store.ts` the other two. They are the only writers.

## Write discipline

- **A workspace id is unique across all projects.** It is the `workspaces`
  primary key, and a fresh create's INSERT refuses a taken id (`CONFLICT`)
  before touching disk or the substrate, so it can neither overwrite a live
  workspace nor tear it down on failure. The provisioning and runtime
  registries, proxy registration and relay identity are keyed on the id alone,
  which is why it is global.
- **`recordWorkspaceCreated` is the only INSERT, and it runs first**, together
  with the first agent session (the conversation create is about to launch;
  without it the workspace has no tool or label). It runs before the Job in
  `createWorkspace`, so no pod exists without a row. A create that fails
  afterwards deletes its row; a failed restart marks the row stopped instead,
  keeping the workspace's history.
- **Everything else is an UPDATE**, which does nothing when the row does not
  exist. That keeps workspaces from another data dir invisible without any
  existence check.
- **A warming spare has a row flagged `spare`.** Listings and the reaper's
  desired set ignore it. The flag exists because once a spare's pod is gone, a
  reaped spare and a stopped workspace look the same on disk, and deleting the
  wrong one loses uncommitted work.

  `claimSpareWorkspace` clears the flag, and throws when no unclaimed spare
  matched: the startup sweep deletes checkouts based on the flag, so a lost
  clear would make the user's new workspace look reapable. The claim clears the
  flag first. If it then fails before changing the spare, it sets the flag back
  and the pod returns to the pool. If it fails after changing the spare, it
  removes it in the reap's order (pod, then checkout, then row), each step only
  if the previous one succeeded. The row is the last reference to the checkout
  at that point, so it is deleted only once the files are really gone; whatever
  survives shows up as an ordinary stopped workspace.
- **No stop deletes a row.** A row with `stoppedAt` set is a stopped
  workspace. A restart reuses the id and, once the new runtime is up, clears
  `stoppedAt` and any death cause, but keeps the title and sidebar group. Only
  two paths delete rows:
  - `project remove`, which also removes the checkouts and transcripts (a
    leftover row would list a workspace whose checkout no longer exists).
  - A fresh create rolling back its own insert, which also removes its staged
    checkout. A failed restart leaves the row stopped as it found it, since
    its checkout is the work the user came back for.
- Reads and writes propagate errors. A teardown logs a failed stop write and
  carries on, since a lost stop stamp degrades a listing while a skipped
  teardown leaks a runtime.

`stoppedAt` and the death columns are separate on purpose. Every stop sets
`stoppedAt`. Only a stop performed by the reaper sets `deathReason` /
`deathDetail`. That is how the UI tells "you stopped it" from "it ran out of
memory".

## Reads

The base branch is written separately, once the checkout resolves it. The
checkout runs concurrently with the pod boot, and making the row wait would
serialize them.

`listActiveWorkspaces` joins live pods to one `getProjectWorkspaceRows` and one
`getProjectAgentSessions` query per project. `listStoppedWorkspaces` takes the
recorded rows minus live pod ids, sorts by `stoppedAt` (else `createdAt`),
caps the list, and only then touches the filesystem: one `stat` per linked
conversation for last activity, newest wins. So a workspace the user
`/clear`ed an hour ago reads as an hour old, not as old as its first question.
Restart reads a stopped workspace's project and tool from the rows, so a tool
that leaves no host transcript restarts like any other.

The stale reaper handles a workspace recorded as live whose pod never appeared
(a create killed between the row write and the Job). Once it is older than any
normal cold create, it is recorded as a `never-started` death, which also makes
it restartable. Creates still in flight in this process are exempt via the
provisioning registry.

## Agent workspaces

Agent sessions are reported by the agents, not written by create. Every running
agent names the conversation it holds. The status watcher carries that in its
live agent set, and the registry turns the set into `sessions-discovered` /
`sessions-active` events, which `applyWorkspaceEvent` writes
(docs/layered-server.md). Both agent modes use this path; they differ only in
where the conversation id comes from.

Under `acp` the server is the ACP client, so `session/new` returns the id.
Under `tui` the tool's reporter sets the tmux pane option `@yaac-session`
(`<tool>|<id>|<project-relative transcript>`) through
`workspace-bin/yaac-agent-links`, which is staged onto the workspace's PATH.
The status watcher subscribes to that option over tmux control mode on every
pane of the workspace, agent windows and user shells alike. tmux pushes each
change as it happens, so a conversation started by hand in a new terminal is
recorded too. Anything in the workspace can set the option, and a restart puts
the id into a launch command, so the value is validated (the subscription
format strips unprintable characters and bounds the length; see "Transcript
paths" for `parsePaneSession`).

Every tool reports from its project-shared home (`ensureAgentReporters`), so a
hand-started one reports as well:

- **claude**: its `SessionStart` hook (settings.json), which fires on
  `startup`, `resume`, `clear` and `compact`, the events that change a pane's
  conversation.
- **codex**: the same hook, in `hooks.json` in its home. yaac launches codex
  with `--dangerously-bypass-hook-trust`; a hand-started codex asks once
  whether to trust the hooks and saves the answer in the project's
  `config.toml`. codex fires `SessionStart` at a conversation's first turn, not
  at startup. It also fires it for a throwaway titling session that has no
  rollout and an id `codex resume` rejects, so a report without a rollout is
  dropped. A resumed conversation fires nothing until its next turn, so a
  resume launch sets the option itself in the same tmux command. codex runs
  embedded in its pane only with its shared background server off
  (`features.daemon_auto_start=false`, which yaac passes and the image's
  `requirements.toml` enforces). That server keeps the env of the first pane
  that started it, as opencode's does, so on containerless a codex started
  by hand needs `-c features.daemon_auto_start=false` to be recorded.
- **pi**: an extension, on `session_start` (startup, resume, `/new`).
- **opencode**: a plugin, on a top-level `session.created`. opencode creates a
  session at its first prompt, and a subagent's session has a `parentID`. A
  `/new` does not announce the end of the session it replaces, so the plugin
  ends that one itself. A resumed session announces nothing, so a resume launch
  sets the option and resumes by id (`--session`). The plugin runs in the
  server behind the TUI, which belongs to the pane only with `--standalone` (as
  yaac launches it). A plain `opencode` joins a background service shared by
  all such TUIs, which keeps the env of whichever pane started it, so the
  plugin reports nothing there. Start opencode by hand with
  `opencode --standalone` to have it recorded.

Each tool also ends its conversation (claude's and codex's `SessionEnd`, pi's
`session_shutdown`, the plugin's dispose), which clears the option when the
agent quits. That matters in a shell pane that outlives the agent. (Verified
against claude 2.1.286, codex-cli 0.159.3, pi 0.99.2 and @opencode/cli 2.0.21.)

A conversation is **active** exactly when a live agent names it. A pane option
dies with its pane, and a new pod's tmux starts with none, so a previous pod's
conversation can never look live. A new conversation changes the live set,
which dirties the reconcile tick. Two cases leave the active set untouched:

- The watcher has not enumerated panes yet, so a stream gap never reads as
  "every agent exited".
- The `sleep infinity` keepalive a session starts with, in the window its agent
  is respawned into, is not an agent pane, so a restart does not mark its
  conversations inactive before its agents are running.

Discovery only adds rows: a `/clear` leaves the old conversation recorded,
inactive, beside the new one.

The one row discovery replaces is the **pin**: the conversation a `tui` create
records under the workspace id, so the workspace has a tool and a founding ask
before any agent speaks. claude and pi are launched with that id, so the pin is
their real conversation. codex and opencode choose their own ids
(`SELF_NAMING_TOOLS`), so for them the pin is a placeholder. The first
conversation of that tool a pane names takes it over (`recordAgentSessions`):
the link keeps ordinal 0, and the conversation inherits what create recorded on
the pin (the `--prompt` ask, the launch model, the birth time). Everything that
reads "the first conversation" (prompt, title, restart) then finds the one the
agent is running. A workspace stopped before any pane named one still holds the
pin, and its restart starts the tool fresh instead of resuming an id the tool
never knew.

Limits of pane options:

- They hold only the pane's current conversation. A conversation that starts
  and is replaced while no server runs never becomes a row (restart still
  resumes the right one, the one on the pane).
- tmux pushes a subscription change at most once a second. Two `/clear`s
  within a second record only the second, and a conversation started or
  `/clear`ed within about a second of a stop is not the one a restart resumes,
  because the stop marks the workspace terminating at once and no later pass
  visits it.

An agent can run another agent inside its own pane (a `claude -p` from its Bash
tool), which reports on the same pane. So reports nest: a start saves the
conversation it displaces, and an end (honored only for the conversation the
pane names) restores it. Nesting is one level deep. A nested agent that dies
without ending leaves the pane on its conversation until the parent's next
start (a `/clear` or resume).

Handles are scoped to a **life**: one pod, stamped on the workspace row at each
create. `recordWorkspaceLife` sets `lifeStartedAt` and clears every recorded
`paneId` in one transaction, because handles restart with the pod (tmux pane
ids from `%0`, acpd sockets at the tool's name) and the ACP driver addresses a
conversation by its recorded handle. The life also separates a permission mode
reported by this pod from one a previous pod left.

`active` is frozen at teardown and not recomputed while a workspace is stopped.
A restart brings back exactly the conversations that were live at stop, each in
its own tmux window, in the order they were first recorded (`agentWindowName`;
the first keeps the bare tool name so `yaac:<tool>` targets still resolve). A
conversation started in a shell comes back in an agent window.

### Opening message and model

A conversation's row also stores two display facts, so no display path has to
parse a transcript: its opening message and its **model**.

- The opening message never changes. It is read from the transcript once and
  kept, because after compaction the head of the transcript is something else.
- The model can change (`/model`), so the column is overwritten whenever the
  agent reports a different one.

A missing report leaves the stored value alone on both. The model is null only
for a conversation launched without one that has never reported.

The model is pushed by the agent, so a switch shows up immediately. Under `acp`
the adapter reports it (docs/agent-modes.md). Under `tui` each agent pane sets
a second pane option, `@yaac-model`, through `workspace-bin/yaac-agent-report`,
and the watcher subscribes to it on agent windows:

- **claude**: its `PostModelSwitch` hook, and its `SessionStart` hook on an
  interactive startup. `SessionStart` does not name the model on the CLI
  `--resume` a restart uses, so a restarted claude pane reports nothing until
  its first `/model`.
- **pi**: its extension, on every switch and session start.
- **opencode**: its plugin. The TUI holds a `/models` pick until the next
  prompt is submitted, so that is when the switch is reported. The plugin also
  reports the model of each step, which covers a resumed session at its first
  turn.
- **codex**: runs nothing on a switch, but yaac launches it with the model in
  its pane title. The subscription cuts the model out of the title and maps
  codex's display name back to the slug, using the catalog codex caches in its
  home or else the catalogs' spelling rule.

A third pane option, `@yaac-permission-mode`, carries the agent's permission
mode through the same script, subscription and plugin (docs/permission-modes.md,
"Following the agent"), and a fourth, `@yaac-effort`, its effort level
(docs/effort-levels.md). A pushed model belongs to the pane, and so to whatever
conversation the pane names, which is why a `/clear` hands the new conversation
its predecessor's model.

opencode leaves no host transcript. It keeps history in a per-workspace SQLite
DB (`opencode-data/`), and its first message comes from an `opencode api` probe
while the workspace runs. A data dir from opencode 1.x holds history as JSON
under `storage/`, which opencode 2 cannot import: such a workspace resumes into
a fresh session and the JSON stays on disk.

### opencode

SQLite does not work on a network filesystem, so a k8s pod runs opencode
against a **node-local working copy**
(`node-local/projects/<project id>/opencode-data/<id>`, mounted at
`~/.local/share/opencode`). The durable copy is the **checkpoint** on the
global tier, `global/projects/<project id>/opencode-data/<id>`
(`opencodeCheckpointDir`, mounted at `~/.yaac/opencode-checkpoint`).

- `workspace-bin/yaac-opencode-checkpoint` copies the working copy into the
  checkpoint: the database through SQLite's backup API (consistent under a live
  writer), other files one by one. It then exports every conversation from
  that copy as `yaac-transcripts/<session id>.jsonl`: a line per session (the
  conversation's and its subagents', with parent and title), then each
  session's `session_message` rows. This export is how the server shows a
  sandboxed workspace's conversation, since it never opens a database the
  workspace wrote; a checkpoint with no export shows an empty transcript.
- `yaac-workspace-init` runs it every five minutes. The pod's preStop hook runs
  it once more with `stop`, which also empties the working copy, so a cleanly
  stopped workspace leaves nothing on its node. A crashed one leaves a copy for
  the node-local sweep.
- A start restores from the checkpoint and discards whatever the node held,
  with one exception: if a surviving working copy's database or WAL is newer
  than the checkpoint, it is checkpointed first, so an unclean stop on a node
  that came back loses nothing. If the node did not come back, at most five
  minutes of conversation are lost.

Two things make the preStop hook actually run. The teardown's
`kubectl delete job` is a waited foreground cascade, because the next step
removes the session dir that backs the pod's file mounts, including the hook's
own script. And a pod with a preStop hook gets a grace period sized for a
backup plus a copy (`PRE_STOP_GRACE_SECONDS`), not the few seconds a bare
SIGTERM needs. Under `containerless` the checkpoint directory is the working
copy, and none of this runs.

## Transcript paths

Every transcript path is stored **relative to the project directory**: in the
pane option, in the event, and in `agent_sessions.transcriptPath`.

An absolute path would include the data dir, so moving the data dir (a restored
backup, a changed `YAAC_DATA_DIR`) would silently break every row. Relative to
the project rather than a tool home, the column can be read without knowing the
tool. The reporter is passed its home and that home's name
(`yaac-agent-links "$HOME/.claude" claude`) and computes the relative form with
shell parameter expansion. It also tries the home's physical path, since a tool
reached through a link may report the link target.

The reporter names the path the tool sees (`claude/projects/…`,
`codex/sessions/…`), which in a pod is the workspace's history mounted there
(see "Agent history"). Discovery therefore resolves it with
`locateTranscript`: first in `history/<workspaceId>/<tool>/`, then in the
shared home, following links so a host workspace's row names the real file. A
path that resolves outside the project, into a sibling's history, or to nothing
yet is skipped (the next tick retries). pi writes only to the history, and
its reporter names no path, so pi conversations are found there by the id in
the log's filename.

`toProjectRelative` / `resolveProjectPath` in `runtime/agents/transcripts.ts`
convert between the two forms. Disk code works with `SandboxFile`s (a dir plus
a path under it); events carry project-relative paths; server-side reads decode
through `toLinkRow`.

`@yaac-session` is the one input yaac does not write, so it is validated.
`parsePaneSession` holds the id to `agentSessionIdSchema` (a shell-safe
charset) and drops absolute or escaping paths. `resolveProjectPath` resolves a
path only under the recording tool's shared home or that tool's part of the
reading workspace's own history, so a pane naming `known_hosts`,
`repo/.git/config` or a sibling's history resolves to no transcript.

Readers without a recorded path (`sessionTranscriptPath`) search the same
places in the same order. codex is why the path is recorded at all: claude's
transcript is named by conversation id and pi's contains the id in its
filename, but codex names rollouts by timestamp plus thread id, so a conversation
id alone is not enough to find one.

## Agent history

Each workspace's conversation state lives in `history/<workspaceId>/`, not in
the project's shared tool homes, so under k8s a pod can reach only its own
conversations. Agent *config* (settings, `.claude.json`, credentials, skills,
plugins, `config.toml`) stays shared on purpose.

| `history/<id>/…` | Holds | k8s | containerless |
|---|---|---|---|
| `claude/` | claude's `projects/` (transcripts, subagent logs, tool results) | mounted at `~/.claude/projects` | the folder claude files this checkout under, linked to `claude/-workspace` |
| `claude-file-history/` | claude's `file-history/<sid>/` (what `/rewind` restores) | mounted at `~/.claude/file-history` | one link per conversation in the shared `file-history/` |
| `codex/` | codex's `sessions/` rollouts | mounted at `~/.codex/sessions` | one link per rollout in the shared `sessions/` |
| `codex-sqlite/` | codex's SQLite state | mounted at `~/.codex-sqlite`, named by `CODEX_SQLITE_HOME` | the same variable, pointing at a link in the private HOME |
| `pi/` | pi's session logs | mounted at `~/.yaac-pi-sessions`, named by `PI_CODING_AGENT_SESSION_DIR` | likewise |

Where a tool has an env override, the directory sits outside every tool home
and both drivers use it directly. The other three are nested inside a shared
home. A pod mounts them over it, but a host has no mount namespace, and a link
written inside a home that is itself a link lands in the shared dir. So a host
create plants links in the shared homes instead. On both drivers every
conversation is filed under `-workspace` (a pod's cwd), which is why one
folder link is enough on a host.

Auto-memory stays shared. claude keys it on the checkout's git root, which is
the checkout itself (`/workspace` in a pod). So the project's
`claude/projects/-repo/memory` is mounted over the `projects/` overlay as
`-workspace/memory`. On a host, create links the history's `-workspace/memory`
to it instead. The folder-name munging is claude's own rule
(`claudeProjectDirName`, pinned against the binary by a test).

Isolation is per workspace, not per conversation. Conversations in one
workspace run in one pod as one uid, so one can delete another's transcript, as
it can delete the checkout. Under containerless there is no isolation at all.

### Reading another workspace's history

`yaac-mama history` (`#domain/workspaces`, `history-export.ts`) hands a
workspace's conversations to another workspace of the same project, running or
stopped: a listing, one conversation's JSONL transcripts concatenated, or its
files one at a time (a standalone project image may carry a GNU tar, which
cannot unpack an archive under gVisor: it extracts with `openat2`, which
gVisor lacks). So the isolation above keeps a workspace's files out of its
siblings' pods, but not private within the project: any workspace can ask
the server for any other's conversations, as `yaac-mama fetch` hands out its
branches.

Which files belong to a conversation is decided by `conversationFiles` in
`#runtime/agents`, from the same places and rules the readers above use:
claude's transcript and its companion `<id>/` dir (subagents, saved tool
results), a codex rollout and every rollout descended from it (the lineage
converge follows), pi's logs, opencode's database, and for an `acp`
conversation acpd's record. On both drivers a file is listed and read only
when no link lies on its path below its directory: yaac links nothing inside
a workspace's history, so a link there was planted, and under containerless
following one could hand out a sibling's checkout. Files are streamed one at
a time, each cut at the length it had when opened, so a running agent's last
line can be partial. A file over 256 MB is never sent, since a workspace can
make one as large as it likes (a sparse file costs it nothing) and the caller
would write every byte; `-o` skips it and says so.

opencode's database is handed out as a consistent copy
(`openConversationFile`). A sandboxed workspace wrote it, so it is never
opened with SQLite there: its checkpoint is already a backup-API copy with no
sidecars, at most five minutes behind while the pod runs. A host workspace's
is the live working copy, so when a `-wal` beside it says a writer may be
active, the server backs it up through a read-only connection (`node:sqlite`),
once it has checked that the database is where it was listed and neither
sidecar is a link; without one, the file is the whole database. SQLite opens
by path, so a link swapped in after that check is followed, which is accepted
because a host workspace has no sandbox: it could read what the link names
itself. The caller's `yaac-mama` turns the copy into JSONL, its session and
its subagents' sessions, with `python3` in its own sandbox.

A `tui` opencode conversation's transcript view (`opencodeTranscriptAsAcp`)
follows the same split. A sandboxed workspace's is read from the checkpoint's
JSONL export, with the size cap and link refusal of any agent-written file.
Only a host workspace's database is queried, read-only and in place: through
its `-wal` when one says opencode may be writing, and otherwise opened
immutable, so no lock file or sidecar appears beside it.

### Converging at create

Every create and restart runs `convergeAgentHistory` (`#domain/agent-history`)
before launch. Under k8s it only creates every mount source and nested
mountpoint, so the kubelet never creates one owned by root: a pod writes its
history through those mounts and never into the shared homes. Under
containerless, where a host run writes into the shared homes, it moves every
conversation the workspace has held out of them into its history. That set
is every id its rows name (active or not), every ACP record in `acp/<id>/` (an
ACP conversation fires no hook, but claude still writes a transcript), and the
workspace id itself (used by the pin before any row names it).

A conversation that a sibling workspace's rows also name is excluded. It has no
single owner, and moving it would orphan it in the other workspace. It stays in
the shared home, readable by both through the fallback, but a pod of either
can no longer resume it.

Subagents move with their parent. claude files them inside the conversation's
`<sid>/` dir. A codex `spawn_agent` child or fork is its own thread and may fire
no hook, so the set also includes rollouts whose first line (`session_meta`)
names a thread already in the set, unless a sibling's rows name that thread
(a host codex can fork any thread linked into the shared home).

Moves are `rename`s under the project dir through a `no-links` root. They never
overwrite and leave links alone. A row whose file is gone from the shared home
and present in the history is repointed with a `sessions-discovered` event.
This is decided from the disk, not from the moves just made, so a converge
interrupted between a rename and the row write is repaired by the next one.
Create then plants the links above, first emptying a real
folder where the checkout's link belongs (a folder still holding a shared
conversation stays as it is).

This step is permanent, not a one-off migration: a host run can always leave
new files in the shared homes, and the next create moves them. Readers search
the history and then the shared homes, so a file is readable wherever it is;
only resuming needs the move.

A stop keeps the history. `deleteWorkspaceState` removes it along with every
link in the shared homes that points into it; `project remove` takes it with the
project dir. Because claude's history is deleted with its workspace, `seed.ts`
raises claude's `cleanupPeriodDays` so claude never prunes it.

## Sandbox-writable dirs

Under k8s every pod of a project mounts read-write its tool homes (`claude/`,
`codex/`, `pi/`, `opencode-config/`), its conversation records
(`acp/<workspaceId>/`), its history (`history/<workspaceId>/…`) and the
checkout. Anything below a mount root may be a link or a FIFO the pod planted.
The server never touches these trees with plain path I/O. It opens them as a
confined root (`#lib/confined-fs`), which checks each path step on an open
descriptor, opens leaves non-blocking, caps reads, writes through a random temp
file plus rename, and deletes by walking descriptors.

- **Tool homes and records** are opened with `openSandboxDir`
  (`#runtime/agents`). Under a sandboxing runtime this is `no-links`, rooted at
  the dir itself (a mount root the pod cannot replace): a link or FIFO in place
  of a file reads as missing, and a write replaces it instead of following it.
  Under containerless there is no boundary to defend and the links are yaac's
  own, so it is `inside`, rooted at the project dir: links are followed while
  they stay in the project. As a result, a personal skill linked in from
  outside the project dir is not listed by skills discovery, though the agent
  still loads it.
- **The checkout** is opened `inside` on both substrates (the file editor
  excludes its `.git`).
- **Whole-tree deletes** of a workspace or project run only once no pod can
  write under them, so Node's recursive `rm` (which follows no link) cannot be
  redirected mid-walk.

An ACP agent's `sessionId` is checked against `agentSessionIdSchema` too before
it is recorded or used in a path.

## First messages

Each conversation gets its own opening message, read from the transcript its
row names. The workspace's founding ask is simply the first conversation's
opening message.

The discovery sweep reads it once per conversation per server run and writes it
to the row, so a settled workspace costs one file read per tick. For a workspace
that died before capture, the stopped listing parses the first transcript on
demand and saves the result.

## The node-local tree

The node-local tier (`node-local/projects/<project id>/…` and
`node-local/shared-images/<project id>/…`) is keyed, like the global tree, by
the project's immutable id (`projects.id`, never reused). A node's copy cannot
be removed reliably, since the node may be gone when the project is removed;
because ids are never reused, a project added again starts empty rather than
mounting the old one's caches and image store.

The node-local sweep (`reapNodeLocal`) collects by the same key. It is given the
live project ids and workspace ids, and removes any project tree no live id
holds (unless a live pod still mounts it) and any opencode working copy whose
workspace is gone. If the project list cannot be read, the sweep does nothing
rather than treating the list as empty.

## The shared tier on a network filesystem

On a byo install `global/` is an NFS mount shared by every node
(docs/server-in-cluster.md "Claims on byo"), and gVisor's file locks never
reach the NFS server. So anything on the shared tier follows these rules,
on every backend:

- **One writer per file.** A file may have many readers and one appending
  writer. Cross-workspace aggregation goes through per-workspace files the
  server merges; nothing relies on a cross-pod lock.
- **No filesystem watchers.** Freshness comes from reading on reconcile,
  which works the same over NFS.
- **A writer that another node reads closes soon after each write a reader
  waits on.** NFS promises only close-to-open consistency: bytes written
  through a held-open file reach the server when it is closed or synced, or
  when the kernel writes them back, up to 30 s later. acpd closes and reopens
  its record at once for a line someone is waiting on, and within 200 ms for
  streamed output. It reopens the descriptor (`/dev/fd/<fd>`), not the path,
  since paths on the shared tier can be renamed under a writer. Files a
  workspace's own processes hold open (a build log, say) follow no such rule,
  so a reader on another node, such as the server's file editor, can see them
  up to 30 s behind.
- **Every path stored in a row is relative** to the data dir or a directory
  under it (see "Transcript paths"), so the data dir can move.
- **The node-local tier is disposable.** It holds re-derivable caches and
  working copies of a shared checkpoint, as opencode's database is. Checkouts
  stay on the shared tier (docs/plans/node-local-checkouts.md).

## Package installs

A workspace's installed packages (its `ephemeralModulesPaths`, `node_modules`
by default) live and die with its runtime, not in the shared checkout.
`prepareModuleDirs` creates each one in the checkout and passes them to the
driver as the spec's `moduleDirs`. A stop removes them from the checkout, and a
restart's init commands reinstall.

### Under k8s

Each module dir is its own pod-local emptyDir volume, which the gVisor mount
hints (`sentryTmpfsAnnotations`) turn into a tmpfs inside the gVisor sentry,
backed by a file in the emptyDir: node disk rather than pinned memory, and file
metadata traffic that never crosses the gofer. The hint applies per volume, so
each dir gets its own volume rather than a subPath. The volume goes with the pod
(a workspace Job never restarts in place). Each dir is capped at 8 GiB, and the
pod's ephemeral-storage limit covers one dir's cap.

pnpm's store is also per pod, set in both `pnpm_config_store_dir` and
`npm_config_store_dir` (pnpm 11+ reads only the first, a corepack-pinned pnpm 10
only the second). It sits inside the root module dir,
`/workspace/node_modules/.pnpm-store`, on the same mount as
`node_modules/.pnpm`, so pnpm can hardlink instead of copy. If the project's
module dirs leave out the root one, the store goes on the pod's own disk, never
in the checkout. In a pnpm workspace the nested module dirs only hold symlinks
into the root one. Module dirs that are independent installs (with their own
lockfiles) each hold a full copy, so several of them count against the one-dir
limit.

A store shared between pods is not possible. pnpm indexes the store in one
SQLite database in WAL mode, which needs every writer on one kernel, and each
pod is its own sandbox, so concurrent installs would corrupt it. A pod mounts
no project-wide package tree at all, since one that every pod could write would
be a channel between workspaces.

So every install is a full fetch, which goes to the install's **npm cache**,
one Verdaccio
(`drivers/k8s/cluster/npm-cache.ts`). A package is downloaded from npmjs once
per cluster, and installs keep working while npmjs is slow or down. The cache is
read-only to workspaces, and pnpm checks every tarball against the lockfile's
integrity hash regardless of source.

Verdaccio sits behind an nginx sidecar that owns the cache port. Verdaccio is a
single Node process that reads and parses a package's whole metadata document
on every request, and some of those documents are tens of MB. When many
workspaces install at once, that starves the event loop until requests and the
readiness probe time out. nginx caches Verdaccio's metadata responses on
pod-local disk, keyed by URL and `Accept`, because the abbreviated and full
documents share a URL. Identical concurrent requests wait on one upstream
fetch, so N workspaces cost one parse. nginx keeps metadata for five minutes,
as npmjs's CDN does, and serves a stale copy while it refreshes. Tarballs pass
straight through: Verdaccio streams them from its claim without parsing, so a
second copy would cost node disk for little CPU. nginx evicts
least-recently-used entries past 1 GB, or when the node's disk has under 2 GB
free, because a cache write that hits a full disk sends the client a truncated
body. Its cache is lost when the pod restarts.

nginx also answers the two npm endpoints Verdaccio lacks, npm's signing keys
(`/-/npm/v1/keys`) and per-version attestations (`/-/npm/v1/attestations/`),
by fetching them from npmjs over a certificate-checked connection. It sends
only GET and HEAD there, and drops a client's `Authorization` and `Cookie`
headers. Without the
keys, `pnpm audit signatures` finds none for the cache, checks no package, and
still reports success. Installs need neither endpoint: pnpm reads attestations
only for a publish time, and falls back to the metadata's `time` field.

The cache is only ever the **default** registry. The init script writes it to
the workspace's user-level `~/.npmrc` (from `YAAC_NPM_REGISTRY`). pnpm 10, 11
and npm all read that below a project's own `.npmrc`, so a project that names a
registry there, globally or per scope, keeps it. That is also the opt-out:
`registry=https://registry.npmjs.org/` in the project `.npmrc`. A project that
authenticates to npmjs with a token in that file needs it, because the cache
fetches anonymously and never serves private packages.

A workspace cannot use the cache at all (it is neither pointed at it nor
allowed by NetworkPolicy) when any of these hold:

- its project sets `npmCache: false`;
- its allowlist leaves out `registry.npmjs.org` (the cache fetches outside the
  proxy, see docs/workspace-egress.md);
- its project authenticates to npmjs through a proxied secret.

Whether a new workspace is pointed at the cache is decided at each create, by
whether a cache pod is ready. A cache that is down or rolling leaves new
workspaces on npmjs, which is only slower. A prewarmed spare is decided at
warm-up and again at claim, which rewrites the cache line in its `~/.npmrc`.
A workspace already pointed at the cache fails its installs while the cache is
down. It is a single replica, so a rollout or a node drain is such a window;
the main registry has the same exposure for image pulls. Nothing prunes the
cache, and any workspace can grow it by fetching public packages. On kind its
volume claim is node disk with no quota.

### Under containerless

The module dirs stay in the checkout on the host's disk, and all workspaces of
a project share one pnpm store under `.cached-packages`. That is safe because
they are all processes on one kernel (docs/containerless-driver.md).

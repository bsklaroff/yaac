# Workspace storage

A yaac workspace is recorded in the `workspaces` table of the server's PGlite
DB (`packages/server/src/db/schema.ts`), one row per
`(projectSlug, workspaceId)`. The cluster stays authoritative for whether a
workspace is *running*; the row is authoritative for everything else — which
workspaces have ever existed, their title, base branch, sidebar group, and
when (and why) they stopped.

Neither the tool nor the founding message is on that row. Both are read off
the workspace's **first agent session**, which is the thing that actually has
them: a workspace is tool-agnostic — it holds whatever conversations the user
opens in it, in any mix — so "the workspace's tool" is not a property it owns.
Deriving the founding ask the same way is what makes it survive a `/clear`
for free: the new conversation is a second row, so the first one's opening
message stays the label, with no write-once rule to enforce.

A row is 1-1 with a checkout — a clone of its own that borrows the main
clone's objects (docs/server-git.md) — and that is why stopping keeps it:
teardown never removes `workspaceDir`, so a stopped row is a checkout still on
disk, git state, diff and all, waiting to be restarted.

That correspondence is also the limit of what can be collected. A checkout
whose row is gone answers to nothing — every sweep is row-driven — so the
paths that erase a row are the ones that must take its bytes with them, and
they do. Nothing hunts for rowless checkouts: inferring "garbage" from disk
alone is how a sweep deletes the one copy of somebody's work. An install that
predates this is the one place strays can exist, under
`projects/<slug>/workspaces/<id>` with a matching `repo/.git/worktrees/<id>`;
they are inert (ids are fresh UUIDs, so nothing collides with them) and are
removed by hand or not at all.

The agents *inside* a workspace are separate rows. `agent_sessions` holds one
row per tool-native conversation — a claude/codex/pi/opencode session, keyed by
the id the tool chose — and `workspace_agent_sessions` links the two, so a
workspace can accumulate conversations over its life and one conversation can be
resumed into a second workspace. See "Agent workspaces" below.

`db/workspace-store.ts` owns the `workspaces` table and
`db/agent-session-store.ts` the other two: every read and write
goes through them, and they are the only writers.

## Write discipline

- **A workspace id is claimed once, across every project.** It is the
  `workspaces` primary key, and a fresh create's row is a plain INSERT that
  refuses a taken id (`CONFLICT`) before the create has touched a disk or a
  substrate — so a create posting a live workspace's id can neither re-stamp
  that workspace nor, failing, tear it down as its own. A restart is an
  UPDATE of the row it must already have. The provisioning registry, the
  runtime registries, the proxy registration and the relay identity are all
  keyed on the id alone, which is why it is unique globally rather than per
  project.
- **`recordWorkspaceCreated` is the only INSERT, and it runs first**, together
  with the first agent session — a workspace with no conversation could name
  neither its tool nor its label, so create records the one it is about to
  launch rather than waiting for discovery to notice it. (Discovery only ever
  adds to that — save that for codex and opencode, which mint their own ids,
  the one create recorded is a stand-in that the agent's first named
  conversation replaces; see "Agent workspaces".) Before
  the Job in `createWorkspace`, so no pod can exist without a
  row — which matters because a rowless pod is invisible to every path that
  reads recorded state. A create that fails afterwards rolls its row back; a
  *restart* that fails re-marks the row stopped instead, since that row
  already carried the workspace's history.
- **Everything else is an UPDATE**, which silently no-ops for a row that
  doesn't exist. That is what keeps workspaces belonging to another data dir
  invisible without a single existence check.
- **A warming spare gets a row too, flagged `spare`.** It is a checkout, a
  branch and a pod from the moment it is warmed, but not a workspace: every
  listing filters the flag out, and the reaper's desired set excludes it, so
  it is as invisible as it would be with no row at all. What the flag buys is
  the one question an absent row could not answer — once a spare's pod is
  gone, a reaped spare and a stopped workspace look identical on disk, and
  deleting the wrong one takes uncommitted work with it.

  `claimSpareWorkspace` clears the flag, and it is the one spare write that
  throws rather than shrugging: the startup sweep deletes a checkout on the
  strength of the flag, so a silently-lost flip would mark a workspace the
  user is about to be handed as reapable. The claim runs it before touching
  the spare, so a failure costs nothing but a cold create — and a claim that
  fails before any mutation puts the flag *back*, returning the pod to the
  pool rather than stranding it.

  A claim that fails *after* mutating the spare cannot do that — the spare is
  tainted — so it takes the whole thing down instead, in the same order the
  ordinary reap uses: pod, then checkout, then row. The
  order is the point, and each step gates the next on having actually
  happened. The flag is already off by then, so the startup sweep can no
  longer see this checkout, and the row is the last name anything has for it:
  erase that over a pod still terminating or an rm that failed, and the bytes
  left behind are ones nothing can ever reach again. Whatever survives keeps
  its row and reaches the user as an ordinary stopped workspace instead.
- **No stop deletes a row.** A row with `stoppedAt` set *is* the stopped
  listing. A restart reuses the id and clears the column, along with any death
  cause from the previous life; the title and the sidebar group survive,
  because they belong to the workspace rather than to one of its lives — which
  is what puts a restarted workspace back in the group its ghost row was
  sitting in. The two
  deletes are scoped to something other than a running workspace going away:
  `project remove`, which takes the checkouts and transcripts with it (rows
  left behind would list workspaces whose restart resolves into a directory that
  no longer exists), and a create rolling back its own insert — which takes
  its staged checkout with it for the same reason the claim above does, and
  only for a *fresh* create: a failed resume is put back as stopped, and its
  checkout is the work the user came back for.
- Writes are best-effort (a failed write degrades a listing, never blocks a
  create or a teardown); reads propagate their errors.

`stoppedAt` and the death columns are deliberately separate vocabularies:
every stop stamps the former, and only a stop the *reaper* performed stamps
`deathReason` / `deathDetail`. That is what makes "stopped because you stopped
it" legible next to "stopped because it OOMed".

## Reads

The base branch is stamped separately, once the workspace checkout resolves
it — the checkout runs concurrently with the pod boot, and making the row
wait for it would undo that overlap.

`listActiveWorkspaces` joins live pods to one `getProjectWorkspaceRows` and one
`getProjectAgentSessions` query per project. `listStoppedWorkspaces` is recorded
rows minus live pod ids, sorted by `stoppedAt` (falling back to `createdAt`),
capped, and only then touching the filesystem — one `stat` per linked
conversation for last-activity, of which the newest wins, so a workspace the
user `/clear`ed an hour ago reads as an hour old rather than as old as its
opening question. Restart resolves a stopped workspace's project and tool from
the row, so a tool that leaves no host transcript restarts like any other.

The stale reaper closes the last gap: a workspace recorded as live whose pod
never appeared (a create killed between the row write and the Job) is
recorded as a `never-started` death once it is older than any legitimate
cold create, which also makes it restartable. Creates still in flight in
the current process are exempt via the provisioning registry.

## Agent workspaces

A workspace's agent sessions are *reported*, not authored: every running agent
names the conversation it holds, the status watcher carries that on its live
agent set, and the registry turns the set into rows by reporting
`sessions-discovered` / `sessions-active` events, which `applyWorkspaceEvent`
lands (docs/layered-server.md). One path serves both modes — the modes differ
only in where an agent's conversation id comes from.

Under `acp` the server is the ACP client, so `session/new` hands it the id.
Under `tui` the tool's own reporter puts it on its tmux pane, as the pane option
`@yaac-session` (`<tool>|<id>|<project-relative transcript>`), through
`workspace-bin/yaac-agent-links`, staged per workspace onto the workspace's PATH
like the other workspace-bin scripts. The status watcher subscribes to that
option over control mode on **every** pane of the workspace's tmux server — an
agent window or a shell the user opened — so tmux pushes each change the
moment it is set, and a conversation started by hand in a new terminal is
recorded like any other. The subscription format strips anything unprintable
and bounds the length, and the driver drops an id outside a shell-safe charset
and a path that is absolute or climbs out of the project (`parsePaneSession`):
anything in the workspace can set the option, and a restart interpolates the
id into a launch command.

Every tool reports, from its project-shared home (`ensureAgentReporters`), so a
hand-run one does too:
- claude from its `SessionStart` hook (settings.json), which fires on
  `startup`, `resume`, `clear` and `compact` — exactly the events that change
  which conversation a pane is in.
- codex from the same hook in `hooks.json` in its home. yaac's launch passes
  `--dangerously-bypass-hook-trust`; a codex started by hand asks once whether
  to trust the hooks and remembers the answer in the project's `config.toml`.
  codex fires `SessionStart` at a conversation's first turn rather than at
  startup, and again, on the same pane, for the throwaway session it titles a
  conversation in — which has no rollout and an id `codex resume` refuses, so
  a codex report without a rollout is dropped. A resumed conversation fires
  nothing until its next turn, so a resume launch names it on the pane, in
  the same tmux command that starts it.
- pi from an extension, on `session_start` (startup, resume, `/new`), with its
  log.
- opencode from a plugin, on a top-level `session.created` — opencode creates a
  session lazily at its first prompt, and a subagent's carries a `parentID`.
  A `/new` announces no end for the session it replaces, so the plugin ends
  that one itself. A resumed session announces nothing, so a resume launch
  names it too, and resumes by id (`--session`). The plugin runs in the
  server behind a TUI, which is the pane's own only under `--standalone`
  (as yaac launches it): a plain `opencode` joins a background service
  shared by every such TUI, which keeps the env of whichever pane started it
  and outlives each one. The plugin reports nothing there, so a conversation
  started by hand is recorded from `opencode --standalone`, not a plain
  `opencode`.

Each ends its conversation too (claude's and codex's `SessionEnd`, pi's
`session_shutdown`, the plugin's dispose), which clears the option once the
agent quits — what matters in a shell the pane outlives. (Verified against claude 2.1.282, codex-cli 0.156.1,
pi 0.84.4 and @opencode/cli 2.0.12.)

A conversation is **active** exactly when a live agent names it. A pane option
dies with its pane and a new pod's tmux starts with none, so nothing can
mistake a previous pod's conversation for a live one; a new conversation is a
change to the live set, which dirties the reconcile tick. When the watcher has
not enumerated panes yet the active set is left untouched, so a stream gap
never reads as "every agent exited" — and the `sleep infinity` keepalive a
session opens on, in the window its agent is respawned into, is not an agent
pane, so a restart's conversations are not marked inactive before its agents
are even running. And discovery only ever adds rows: a
`/clear` leaves the old conversation recorded, inactive, beside the new one.

The one row discovery replaces is the **pin**: the conversation a `tui` create
records under the workspace id, so the workspace has a tool and a founding ask
before any agent has spoken. claude and pi are launched under that id, so the
pin is their real conversation. codex and opencode take no id and mint their
own (`SELF_NAMING_TOOLS`), so for them the pin is a stand-in, and the first
conversation of its tool a pane names takes it over (`recordAgentSessions`):
the link keeps ordinal 0, and the conversation keeps what the create recorded
on the pin — the `--prompt` ask, the launch's model, the birth time — so every
reader of "the first conversation" (the workspace's prompt, its title, restart)
finds the one the agent actually runs. A workspace stopped before its pane named
one still holds the pin, and its restart starts that tool fresh rather than
resuming an id the tool never knew.

What a pane option cannot give is history no server was there for: it holds
only the pane's current conversation, so one that starts and is replaced
entirely while no server runs never becomes a row (a restart still resumes the
right one — the one on the pane). tmux also pushes a subscription change at
most once a second, so two `/clear`s inside a second record only the second,
and a conversation begun or `/clear`ed within about a second of a stop is not
the one a restart resumes: the stop marks the workspace terminating at once,
and no pass visits it after that.

An agent can run another inside its own pane (a `claude -p` from its Bash
tool), which inherits the pane and reports on it. So reports nest: a start
saves the conversation it displaces, and an end — honored only for the
conversation the pane names — hands the pane back. One level deep; and a
nested agent that dies without ending leaves the pane on its conversation
until the parent's next start (a `/clear`, a resume).

Handles are scoped to a **life** — one pod, stamped on the workspace row at each
create. `recordWorkspaceLife` sets `lifeStartedAt` and NULLs every recorded
`paneId` in one transaction, because handles restart with the pod (tmux pane
ids at `%0`, acpd sockets at the tool's name) and the ACP driver re-addresses a
conversation by its recorded handle. The life is also what separates a
reported permission mode this pod made from one a previous pod left behind.

`active` is frozen at teardown and never recomputed while a workspace is stopped.
That freeze is the whole contract: a restart brings back exactly the
conversations that were live when the workspace stopped, each in its own tmux
window, in the order they were first recorded (`agentWindowName` — the first
keeps the bare tool name so every existing `yaac:<tool>` target still
resolves). A conversation started in a shell comes back in an agent window.

A conversation's row also carries two display facts, so no display path has
to parse a transcript: its opening message and the **model** it is running.
They are not the same kind of fact, and they arrive differently. An opening
message is true forever: it is read out of the transcript once and coalesced —
re-reading a transcript that has since been compacted would otherwise replace
it with whatever now sits at the head. A model is true *now*: `/model`
mid-conversation changes it, so the column is overwritten whenever the agent
reports a different one. Absent still means "not reported" on both, and leaves
the stored value alone.

The model is pushed by the agent rather than read, so a switch lands the moment
it happens instead of on the next reply. Under `acp` the adapter reports it (see
docs/agent-modes.md). Under `tui` each agent pane carries it as a second pane
option, `@yaac-model`, which the status watcher subscribes to on agent windows
the same way. The tools set it through `workspace-bin/yaac-agent-report`:

- claude from its `PostModelSwitch` hook, on any switch, and its `SessionStart`
  hook, which names the model on an interactive startup — but not on the CLI
  `--resume` a restart relaunches with, so a restarted claude pane reports
  nothing until its first `/model`.
- pi from its extension, on every switch and every session start.
- opencode from its plugin. Its TUI keeps a `/models` pick to itself until the
  next prompt is submitted, so that is when a switch is reported; the plugin
  also reports the model each step runs on, which is what covers a resumed
  session (reported at its first turn).
- codex runs nothing on a switch but retitles its pane (yaac launches it with
  the model among its title items), so its subscription cuts the model out of
  the title and maps codex's display name back to the slug — through the
  catalog codex caches in its home, else by the catalogs' spelling rule.

The same script, subscription and plugin carry the permission mode the agent
is in, as a third pane option (`@yaac-permission-mode`) — what that means for
the workspace's row is docs/permission-modes.md's "Following the agent".
A pushed model belongs to the pane, and so to the conversation the pane names
in the same live agent — which is what makes a `/clear` hand the new
conversation its predecessor's model.

Whenever no push arrives, the row keeps its last stored value — the launch seed
or the last report. It is null only for a conversation launched without a model
that has never reported.

opencode is the exception throughout: it keeps history in a per-workspace sqlite
DB (`opencode-data/`) and leaves no host transcript, so its first message comes
from an `opencode api` probe while the workspace runs. A data dir written by the
1.x line holds its history as JSON under `storage/` instead, which opencode 2
has no importer for: such a workspace resumes into a fresh, empty session, and
the JSON stays on disk untouched.

### opencode

SQLite is unusable on a network filesystem, so under `k8s` a pod runs opencode
against a NODE-LOCAL working copy of its data dir
(`node-local/projects/<project id>/opencode-data/<id>`, mounted at
`~/.local/share/opencode`) and the GLOBAL tier holds the one durable copy: the
checkpoint at `global/projects/<slug>/opencode-data/<id>`
(`opencodeCheckpointDir`, mounted at `~/.yaac/opencode-checkpoint`).
`yaac-opencode-checkpoint` (workspace-bin) copies the working copy into the
checkpoint — the database through sqlite's backup API, which is consistent
under a live writer, everything else file for file. `yaac-workspace-init` runs
it every five minutes, and the pod runs it once more as its preStop hook with
`stop`, which also empties the working copy, so a cleanly stopped workspace
leaves nothing on its node; a crashed one leaves a copy the node-local sweep
collects. A start restores from the checkpoint — it is the only source of
truth, and whatever the node still held is discarded, never merged — with
one exception: a surviving working copy whose database or WAL is newer than
the checkpoint's is checkpointed first, so an unclean stop on a node that
came back costs nothing. Where the node did not come back, the loss is
bounded by the timer: at most five minutes of conversation.

Two things make the hook run at all. The detached teardown's
`kubectl delete job` is a waited foreground cascade, because the session dir
it removes next is the source of the pod's File mounts — the hook's own
script among them; and a pod with a preStop hook gets a grace period sized
for a backup plus a copy (`PRE_STOP_GRACE_SECONDS`) rather than the few
seconds a bare SIGTERM needs. Under `containerless` the checkpoint directory
is the working copy itself, and none of this runs.

## Transcript paths

Every transcript path is stored **relative to the project directory** — in the
pane option that names it, in the event that reports it, and in
`agent_sessions.transcriptPath`. Absolute appears nowhere.

One form rather than three. An absolute path carries the data dir, so it pins a
row to the directory that wrote it: move the data dir (a restored backup, a
changed `YAAC_DATA_DIR`) and every row points somewhere that no longer exists,
silently, since the readers only ever stat these paths. An absolute path in a
event is worse still — it names a machine-absolute place, which the
server can neither resolve nor meaningfully store once the two are separate
processes.

Project-relative rather than tool-home-relative so the column needs no tool to
be read. The reporter is handed its home and that home's name
(`yaac-agent-links "$HOME/.claude" claude`), so producing the form stays
parameter expansion with no interpreter. It tries the home's physical path as
well, since a workspace may reach its tool home through a link and a tool that
resolves its own paths then reports the transcript under the target.

What the reporter names is the path the tool sees — `claude/projects/…`,
`codex/sessions/…` — which in a pod is the workspace's history mounted there
(see "Agent history"). So discovery does not record it verbatim:
`locateTranscript` looks for it in `history/<workspaceId>/<tool>/` first and the
shared home second, then resolves links, so a host workspace's row names the
file its folder link leads to. A path that resolves outside the project, into a
sibling's history, or nowhere yet is left out (the next tick fills it). pi's
logs sit outside the home its reporter names, so a pi conversation is found by
the id in its log's filename instead.

`toProjectRelative` / `resolveProjectPath` in `runtime/agents/transcripts.ts`
are the only place the two forms meet. Disk code works in `SandboxFile`s — a
dir and a path under it (see "Sandbox-writable dirs") — while a path reaches an
event already project-relative. Decoding funnels through `toLinkRow`, the
single projection every server-side reader comes through.

A pane's `@yaac-session` is the one input yaac does not write, so it is
*validated* rather than converted: anything in the workspace can set it.
`parsePaneSession` holds the id to `agentSessionIdSchema` and drops a path that
is absolute or climbs out of the project, and decoding (`resolveProjectPath`)
resolves a path only under the recording tool's shared home or its part of the
reading workspace's own history — a pane naming `known_hosts`,
`repo/.git/config` or a sibling's history names no transcript.

Readers without a recorded path (`sessionTranscriptPath`) search the same two
places in the same order: the workspace's history, then the shared home. codex is
why the path is recorded at all: claude's transcript is named for its
conversation and pi's is found by matching the id in its filename, but codex
names its rollout files by a timestamp as well as a thread id, so a reader holding
only a conversation id does not look for one.

## Agent history

Each workspace's conversation state lives in `history/<workspaceId>/`, not in the
project's shared tool homes, so under k8s a pod can reach only its own
workspace's conversations. It still reads and writes the shared agent *config*
(settings, `.claude.json`, credentials, skills, plugins, `config.toml`) — that
is shared on purpose.

| `history/<wt>/…` | Holds | k8s | containerless |
|---|---|---|---|
| `claude/` | claude's `projects/` (transcripts, subagent logs, tool results) | mounted at `~/.claude/projects` | the folder claude files this checkout under, linked to `claude/-workspace` |
| `claude-file-history/` | claude's `file-history/<sid>/` (what `/rewind` restores) | mounted at `~/.claude/file-history` | one link per conversation in the shared `file-history/` |
| `codex/` | codex's `sessions/` rollouts | mounted at `~/.codex/sessions` | one link per rollout in the shared `sessions/` |
| `codex-sqlite/` | codex's sqlite state | mounted at `~/.codex-sqlite`, named by `CODEX_SQLITE_HOME` | the same declaration, as a link in the private HOME |
| `pi/` | pi's session logs | mounted at `~/.yaac-pi-sessions`, named by `PI_CODING_AGENT_SESSION_DIR` | likewise |

Where a tool has an env override the directory sits outside every tool home, so
both drivers realize the mount as they are. The other three are nested inside
a shared home: a pod layers them over it (as it does builtin skills), but a
host has no mount namespace and a link written inside a home that is itself a
link lands in the shared dir. So a host create plants links *in the shared
homes* instead. Every conversation is filed under `-workspace` in the history
on both drivers — a pod's cwd — which is what makes one folder link enough on a
host.

Auto-memory stays shared: claude keys it on the checkout's git root — the
checkout itself, `/workspace` in a pod — so the project's
`claude/projects/-repo/memory` is mounted back on top of the `projects/`
overlay as `-workspace/memory`. On a host a create links the history's
`-workspace/memory` to it instead, and folds in the folder the host repo path
names, where memory lived while checkouts were linked worktrees of the repo
(two real folders are left alone; memory is never merged). So memory is one
thing across a project's workspaces and on both drivers. The munging is claude's own
rule (`claudeProjectDirName`, pinned against the binary by a test).

The boundary is the workspace, not the conversation. Several conversations in
one workspace run in one pod as one uid, so one can delete another's
transcript, just as it can delete the checkout. Under containerless there is no
isolation at all — an agent can delete anything the server's user can; what it
gets is the shared layout, which is what lets an install switch drivers.

**Converging at create.** A stretch on either driver can leave files where the
other one needs them, so every create and restart runs `convergeAgentHistory`
(`#domain/agent-history`) in its prep, before the workspace launches. It first
makes every mount source and nested mountpoint (so the kubelet never creates
one root-owned), then moves every conversation the workspace ever held out of
the shared homes into its history. That set is every id its rows name (not
only the active ones), every ACP record in `acp/<wt>/` (an ACP conversation
fires no hook, yet the SDK's claude still writes a transcript), and the
workspace id itself, which the pinned first conversation uses before any row
names it — less any conversation a sibling's rows also name. Such a
conversation was resumed from one workspace in another back when the folder was
shared, so it has no single owner: moving it would hand it to whichever
workspace converged first and orphan it in the other. It stays in the shared
home, readable by both through the fallback, and a pod of either can no longer
resume it. Subagents ride with their parent: claude files them inside the
conversation's `<sid>/` dir, which moves with it; a codex `spawn_agent` child or
fork is a thread of its own that may fire no hook, so the set closes over
rollouts whose first line (`session_meta`) names a thread already in it —
except a thread a sibling's rows name, since a host codex can fork any thread
linked into the shared home and that fork is the sibling's. Moves are `rename`s
under the project dir, done through a `no-links` root, never overwrite, and
leave links alone. A row whose file is gone from the shared home (judged
`no-links`, as a pod would see it) and present at its history destination is
repointed through a `sessions-discovered` event. That is read off the disk, not
off the moves just made, so a converge interrupted between a rename and the row
write is repaired by the next one. Under containerless the create then plants the
links above, first emptying a real folder where the checkout's link belongs
(one still holding a shared conversation stays real and unlinked).
The step is permanent, not a migration: a host run can always leave new files
in the shared homes (a new rollout, a new file-history dir), and the next create
moves them in. Readers search the history and then the shared homes, so a
file is readable wherever it currently is; only a *resume* needs the move.

A stop keeps the history. `deleteWorkspaceState` removes it, with every link in
the shared homes that still leads into it; `project remove` takes it with the project dir.
Because claude's history now goes with its workspace, `seed.ts` raises claude's
`cleanupPeriodDays` so claude never prunes it itself.

## Sandbox-writable dirs

Under k8s every pod of a project mounts its tool homes (`claude/`, `codex/`,
`pi/`, `opencode-config/`), its conversation records (`acp/<workspaceId>/`), its
history (`history/<workspaceId>/…`) and the checkout read-write, so anything below a mount root may be a link or a FIFO
the pod planted. The server never touches those trees with plain path I/O: it
opens them as a confined root (`#lib/confined-fs`), which checks every step on
the descriptor it opened, opens leaves non-blocking, caps what it reads, writes
through a random temp file and a rename, and deletes by walking descriptors.

- **Tool homes and records** are opened with `openSandboxDir`
  (`#runtime/agents`). Under a sandboxing runtime that is `no-links`, rooted at
  the dir itself — a mount root the pod cannot replace: a link or FIFO in place
  of a file reads as missing, and a write replaces it rather than following
  it. Under containerless there is no boundary to defend and the links there
  are yaac's own, so it is `inside`, rooted at the project dir: links are
  followed while they stay in the project. One consequence: a personal skill
  linked in from outside the project dir is not listed by skills discovery,
  though the agent itself still loads it.
- **The checkout** is opened `inside` on both substrates (the file editor
  excludes its `.git`).
- **Whole-tree deletes** of a workspace or project run only once no pod is left
  to write under them, so Node's recursive `rm` — which follows no link it
  meets — cannot be steered mid-walk.

Ids that come from a workspace (a pane's conversation id, an ACP agent's
minted `sessionId`) are held to `agentSessionIdSchema` before they are recorded
or joined into a path.

## First messages

Capture is per conversation: each gets its own opening message, read from the
transcript its row names. There is no separate workspace-level capture — the
founding ask *is* the first conversation's opening message.

The discovery sweep does this once per conversation per server life and writes
the result to the row, so a settled workspace costs one file read a tick. Where
the transcripts live per tool is `runtime/agents/transcripts.ts`. A workspace
that died before capture parses its first conversation's transcript on demand
from the stopped listing, and the result is persisted.

## The node-local tree

The NODE-LOCAL tier (`node-local/projects/<project id>/…` and
`node-local/shared-images/<project id>/…`) is keyed by the project's
immutable id — the `projects.id` column, minted at insert and never reused —
not by its slug as the global tree is. A node's copy cannot be removed
reliably: the node may be gone or unreachable when the project is removed.
Keyed by slug, a project re-added under the same name would mount the old
one's caches and image store. Keyed by id, it starts from nothing, and the
node-local sweep (`reapNodeLocal`) collects by the same key: the caller
hands it the live project ids and live workspace ids, and it removes any
project tree no live id holds — except one a live pod still mounts — and any
opencode working copy whose workspace is gone. A project list that cannot be
read stands the sweep down rather than reading as empty.

## Package installs

A workspace's installed packages — its `ephemeralModulesPaths`, `node_modules`
by default — live and die with its runtime rather than in the shared checkout.
`prepareModuleDirs` creates each one in the checkout and hands them to the
driver as the spec's `moduleDirs`; the stop removes them from the checkout, and
a restart's init commands reinstall.

**Under k8s each module dir is its own pod-local volume**, an emptyDir the
gVisor mount hints (`sentryTmpfsAnnotations`) turn into a sentry-internal
tmpfs paged against a file in the emptyDir: node disk, not pinned memory, and
link/stat traffic that never crosses the gofer. One volume per dir, never
subPaths of one, because the hint keys on a whole volume's kubelet path. The
volume goes with the pod — a workspace Job never restarts in place — and kubelet
reclaims it as soon as the pod finishes. Each dir is capped at 8 GiB, and the
pod's ephemeral-storage limit clears one dir's cap.

pnpm's store is per pod too, set under both `pnpm_config_store_dir` and
`npm_config_store_dir` (pnpm 11 reads only the first, a corepack-pinned pnpm
10 only the second). It goes inside the root module dir,
`/workspace/node_modules/.pnpm-store`, which puts it on the same mount as
`node_modules/.pnpm`, so pnpm hardlinks rather than copies. A project whose
module dirs leave out the root one gets a store on the pod's own disk instead,
never in the checkout. In a pnpm workspace the nested module dirs hold only
symlinks into the root one; module dirs that are independent installs (their
own lockfiles) each hold a full copy — the store is on another mount — so a
repo with several of them spends a copy per dir against the one-dir limit.

A store shared between pods is not an option: pnpm 11 indexes the store in one
SQLite database in WAL mode, which needs every writer on one kernel, and every
pod is its own sandbox — workspaces installing at once corrupt it. So a pod
mounts no project-wide package tree at all: one every pod of a project could
write would be a channel between them with nothing left to carry.

A cold store per workspace makes every install a full fetch, so fetches go to
the install's **npm cache** instead of the internet: one Verdaccio
(`drivers/k8s/cluster/npm-cache.ts`). A package comes from npmjs once per
cluster, and installs keep working while npmjs is slow or down. The cache is
read-only to workspaces, and pnpm checks every tarball against the lockfile's
integrity hash whoever served it.

It is only ever the **default** registry. The init script writes it to the
workspace's user-level `~/.npmrc` (from `YAAC_NPM_REGISTRY`), which pnpm 10, 11
and npm all read below a project's own `.npmrc` — so a project that names a
registry there, for everything or for a scope, keeps it. That is also the
opt-out: `registry=https://registry.npmjs.org/` in the project `.npmrc`, which a
project authenticating to npmjs with a token in that file needs, since the
cache fetches anonymously and so never serves private packages. A workspace
cannot use the cache at all — it is neither pointed at it nor admitted by its
NetworkPolicies — when its project sets `npmCache: false`, when its allowlist
leaves `registry.npmjs.org` out (the cache fetches outside the proxy —
docs/workspace-egress.md), or when its project authenticates to npmjs through
a proxied secret.

Whether a new workspace is pointed at the cache is read at each create, from
whether a cache pod is ready: a cache that is down or rolling leaves new
workspaces on npmjs, slower and nothing worse. A prewarmed spare is decided
twice — at warm-up, and again when it is claimed, which rewrites the cache's
line in its `~/.npmrc` to match the cache as it is then. A workspace already pointed at it
fails its installs while it is down — it is one replica, so a rollout or a node
drain waiting on its claim is such a window; the main registry has the same
exposure for image pulls. Nothing prunes the cache, and any workspace can grow
it by fetching public packages; on kind its claim is node disk with no quota.

**Under containerless** the module dirs stay in the checkout, on the host's own
disk, and every workspace of a project shares one pnpm store under
`.cached-packages` — safe there because they are all processes on one kernel
(docs/containerless-driver.md).

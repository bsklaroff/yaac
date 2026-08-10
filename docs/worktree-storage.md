# Worktree storage

A yaac worktree is recorded in the `worktrees` table of the server's PGlite
DB (`packages/server/src/records/schema.ts`), one row per
`(projectSlug, worktreeId)`. The cluster stays authoritative for whether a
worktree is *running*; the row is authoritative for everything else — which
worktrees have ever existed, their title, base branch, background pin, and
when (and why) they stopped.

Neither the tool nor the founding message is on that row. Both are read off
the worktree's **first agent session**, which is the thing that actually has
them: a worktree is tool-agnostic — it holds whatever conversations the user
opens in it, in any mix — so "the worktree's tool" is not a property it owns.
Deriving the founding ask the same way is what makes it survive a `/clear`
for free: the new conversation is a second row, so the first one's opening
message stays the label, with no write-once rule to enforce.

A row is 1-1 with a git worktree, and that is why stopping keeps it: teardown
prunes the worktree dir but never `worktreeDir`, so a stopped row is a checkout
still on disk, diff and all, waiting to be restarted.

The agents *inside* a worktree are separate rows. `agent_sessions` holds one
row per tool-native conversation — a claude/codex/pi/opencode session, keyed by
the id the tool chose — and `worktree_agent_sessions` links the two, so a
worktree can accumulate conversations over its life and one conversation can be
resumed into a second worktree. See "Agent worktrees" below.

`records/worktree-store.ts` owns the `worktrees` table and
`records/agent-session-store.ts` the other two: every read and write
goes through them, and they are the only writers.

## Write discipline

- **`recordWorktreeCreated` is the only INSERT, and it runs first**, together
  with the first agent session — a worktree with no conversation could name
  neither its tool nor its label, so create records the one it is about to
  launch rather than waiting for discovery to notice it. (Discovery only ever
  adds to that; for opencode, which no hook ever fires for, it never fires at
  all.) Before the Job in `createWorktree`, so no pod can exist without a
  row — which matters because a rowless pod is invisible to every path that
  reads recorded state. A create that fails afterwards rolls its row back; a
  *restart* that fails re-marks the row stopped instead, since that row
  already carried the worktree's history.
- **Everything else is an UPDATE**, which silently no-ops for a row that
  doesn't exist. That is what keeps worktrees belonging to another data dir
  invisible without a single existence check.
- **A warming spare gets a row too, flagged `spare`.** It is a checkout, a
  branch and a pod from the moment it is warmed, but not a worktree: every
  listing filters the flag out, and the reaper's desired set excludes it, so
  it is as invisible as it would be with no row at all. What the flag buys is
  the one question an absent row could not answer — once a spare's pod is
  gone, a reaped spare and a stopped worktree look identical on disk, and
  deleting the wrong one takes uncommitted work with it.

  `claimSpareWorktree` clears the flag, and it is the one spare write that
  throws rather than shrugging: the startup sweep deletes a checkout on the
  strength of the flag, so a silently-lost flip would mark a worktree the
  user is about to be handed as reapable. The claim runs it before touching
  the spare, so a failure costs nothing but a cold create — and a claim that
  fails before any mutation puts the flag *back*, returning the pod to the
  pool rather than stranding it.
- **No stop deletes a row.** A row with `stoppedAt` set *is* the stopped
  listing. A restart reuses the id and clears the column, along with any death
  cause from the previous life; the title and the background pin survive,
  because they belong to the worktree rather than to one of its lives. The two
  deletes are scoped to something other than a running worktree going away:
  `project remove`, which takes the checkouts and transcripts with it (rows
  left behind would list worktrees whose restart resolves into a directory that
  no longer exists), and a create rolling back its own insert.
- Writes are best-effort (a failed write degrades a listing, never blocks a
  create or a teardown); reads propagate their errors.

`stoppedAt` and the death columns are deliberately separate vocabularies:
every stop stamps the former, and only a stop the *reaper* performed stamps
`deathReason` / `deathDetail`. That is what makes "stopped because you stopped
it" legible next to "stopped because it OOMed".

## Reads

The base branch is stamped separately, once the worktree checkout resolves
it — the checkout runs concurrently with the pod boot, and making the row
wait for it would undo that overlap.

`listActiveWorktrees` joins live pods to one `getProjectWorktreeRows` and one
`getProjectAgentSessions` query per project. `listStoppedWorktrees` is recorded
rows minus live pod ids, sorted by `stoppedAt` (falling back to `createdAt`),
capped, and only then touching the filesystem — one `stat` per linked
conversation for last-activity, of which the newest wins, so a worktree the
user `/clear`ed an hour ago reads as an hour old rather than as old as its
opening question. Restart resolves a stopped worktree's project and tool from
the row, so a tool that leaves no host transcript restarts like any other.

The stale reaper closes the last gap: a worktree recorded as live whose pod
never appeared (a create killed between the row write and the Job) is
recorded as a `never-started` death once it is older than any legitimate
cold create, which also makes it restartable. Creates still in flight in
the current process are exempt via the provisioning registry.

## Agent worktrees

A worktree's agent sessions are *discovered*, not authored, and what discovery
finds goes straight into rows: the sweep reports a `sessions-discovered` /
`sessions-active` event and `applyWorktreeEvent` decides which rows it lands in
(docs/layered-server.md).

Discovery has one input the host cannot see for itself, and it is the only file
in this story. Every tool with a host-mounted home runs a `SessionStart` hook
(`/etc/yaac/agent-links.sh`, baked into the tools image) which appends **one
JSON line per firing** to
`projects/<slug>/meta/<worktreeId>.session-starts.jsonl`, mounted into the pod
at `/home/yaac/.yaac/session-starts.jsonl`:

```jsonc
{"id":"<agentSessionId>","tool":"claude","pane":"3","path":"claude/projects/-workspace/….jsonl"}
```

The hook fires on `startup`, `resume`, `clear` and `compact` — exactly the
events that change which conversation a pane is in — and it is the only witness
of a user-started one, because it alone sees `TMUX_PANE` beside the tool's
session id. `/clear` and a hand-typed `claude --resume` are invisible from
outside the pod.

**The pod appends and the server folds**, and that asymmetry is the whole
design. The log is append-only and never renamed, which is what makes mounting
it as a `File` hostPath safe — a rename would replace the inode the mount pins,
and the pod would go on writing to a file nobody reads. Two writers doing two
read-modify-writes would lose one side's write, and coordinating them would mean
a lock held across a hostPath mount from inside a gVisor sandbox. So nothing
crosses the boundary but appended lines; the database is server-local and
single-writer (PGlite), which the pod could not reach even if it wanted to.

Nothing truncates the log. Sightings are idempotent — a conversation id maps to
one handle — so re-folding the whole file every tick is correct, and it avoids
the drain/append race a truncation would introduce.

A conversation is **active** in a worktree when its link row names a pane *and*
the status watcher can currently see that pane. Neither source answers alone: a
recorded handle outlives the pane that wrote it, and the watcher knows nothing
about which conversation is loaded. When the watcher has not enumerated handles
yet the active set is left untouched, so a stream gap never reads as "every
agent exited".

Handles are scoped to a **life** — one pod, stamped on the worktree row at each
create. `recordWorktreeLife` sets `lifeStartedAt` and NULLs every recorded
`paneId` in one transaction, because those are the same fact: tmux pane ids
restart at `%0`, so a handle the previous life recorded would name a pane *this*
life owns. Doing it atomically is what stops a crash between the two halves from
leaving a dead pod's handles against a fresh life.

The log needs the same boundary, since it is never truncated and its lines carry
no life marker. `lifeLogBytes` records how long it was when the life began: a
line below that offset still proves its conversation exists and still names its
transcript, but its pane belongs to a pod that is gone — so the fold keeps the
conversation and drops the handle.

`active` is frozen at teardown and never recomputed while a worktree is stopped.
That freeze is the whole contract: a restart brings back exactly the worktrees
that were live when the worktree stopped, each in its own tmux window, in the
order they were first opened (`agentWindowName` — the first keeps the bare tool
name so every existing `yaac:<tool>` target still resolves).

opencode is the exception throughout: it keeps history in a per-worktree sqlite
DB inside the container and leaves no host transcript, so no hook fires for it
and its first message comes from an HTTP probe while the pod runs.

`acp` needs none of this. The server *is* the ACP client, so `session/new` hands
it the id directly and the live set carries it — the mode replaces a whole
discovery mechanism with a return value.

## Transcript paths

Every transcript path is stored **relative to the project directory** — in the
session-starts log, in the event that reports it, and in
`agent_sessions.transcriptPath`. Absolute appears nowhere.

One form rather than three. An absolute path carries the data dir, so it pins a
row to the directory that wrote it: move the data dir (a restored backup, a
changed `YAAC_DATA_DIR`) and every row points somewhere that no longer exists,
silently, since the readers only ever stat these paths. An absolute path in a
event is worse still — it names a machine-absolute place, which the
server can neither resolve nor meaningfully store once the two are separate
processes.

Project-relative rather than tool-home-relative because it needs no tool: every
tool home is `<projectDir>/<tool>`, so the tool segment is simply the first
component, and nothing has to know which home a path came out of. The in-pod
hook is handed its home and that home's name (`agent-links.sh
/home/yaac/.claude claude`), so producing the form stays parameter expansion
with no interpreter.

`toProjectRelative` / `resolveProjectPath` in `store/transcripts/transcripts.ts`
are the only place the two forms meet. Disk code works in absolute paths
internally — it stats transcripts and hands them to parsers — and converts at
the last moment before an event, in `toReported`. The conversion is also
applied at the *last write* before the column, because the on-demand
founding-ask capture is fed by a reader that has already resolved a path.

Decoding funnels through `toLinkRow`, the single projection every server-side
reader comes through. That is where the shared-filesystem assumption between
the halves still lives: the stopped listing stats a transcript for
last-activity and the detail route parses one for a founding ask, both against
files on disk.

The worktree-starts log is the one input yaac does not write, so it is the one
place a path is *validated* rather than converted: it is an RW mount in a
sandboxed pod, and absolute paths are refused there — everything downstream
takes the value at face value and would happily stat and parse whatever it
named.

The transcripts themselves are deliberately left where each tool writes them,
in the project-shared tool home. Recording the path is what makes them findable,
and it costs less than relocating them would: no mount moves, a worktree started
before any of this still resolves, and cross-worktree `--resume` keeps working.
The price is that the shared homes stay shared — `file-history/<worktreeId>/` and
`worktree-env/<worktreeId>/` outlive the worktree that made them, `history.jsonl`
is pooled across a project, and every worktree of a project is a concurrent
writer into one transcript directory, which is why `seed.ts` raises claude's
`cleanupPeriodDays` so it cannot prune another worktree's history on startup.

codex is why the path is recorded at all: claude's transcript is at a
conventional location and pi's is found by matching the id in its filename, but
codex names its rollout files unpredictably, so nothing derives one from a
worktree id.

## First messages

Capture is per conversation: each gets its own opening message, read from the
transcript its row names. There is no separate worktree-level capture — the
founding ask *is* the first conversation's opening message.

The discovery sweep does this once per conversation per server life and writes
the result to the row, so a settled worktree costs one file read a tick. Where
the transcripts live per tool is `store/transcripts/transcripts.ts`. A worktree
that died before capture parses its first conversation's transcript on demand
from the stopped listing, and the result is persisted.

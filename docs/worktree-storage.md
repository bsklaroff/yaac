# Worktree storage

A yaac worktree is recorded in the `worktrees` table of the server's PGlite
DB (`packages/server/src/platform/db/schema.ts`), one row per
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

`features/worktrees/worktree-store.ts` owns the `worktrees` table and
`features/worktrees/agent-session-store.ts` the other two: every read and write
goes through them, and they are the only writers.

## Write discipline

- **`recordWorktreeCreated` is the only INSERT, and it runs first**, together
  with the first agent session — a worktree with no conversation could name
  neither its tool nor its label, so create records the one it is about to
  launch rather than waiting for discovery to notice it. (Discovery only ever
  adds to that; for opencode, which no hook ever fires for, it never fires at
  all.) Before the Job in `createWorktree`, and before a claim touches a
  prewarmed spare
  — the two paths that produce a user worktree. No pod can therefore exist
  without a row, which matters because a rowless pod is invisible to every
  path that reads recorded state and there is no way to tell one from an
  unclaimed spare after the fact. A create that fails afterwards rolls its
  row back; a *restart* that fails re-marks the row stopped instead, since
  that row already carried the worktree's history. A spare gets no row while
  it is warm, because it is not a worktree until claimed.
- **Everything else is an UPDATE**, which silently no-ops for a row that
  doesn't exist. That is what keeps spares — and worktrees belonging to
  another data dir — invisible without a single existence check.
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

A worktree's agent sessions are *discovered*, not authored. The server keeps a
own record of what it found, because after the database split
(docs/plans/layered-server.md) it may not read a row: one **metadata document** per
worktree, `projects/<slug>/meta/<worktreeId>.json`, owned and rewritten whole by
the server process and validated by a zod schema
(`features/worktrees/worktree-meta.ts`).

It holds only what discovery needs to work without the database — which worktrees
a worktree has, where their transcripts are, their opening messages, and which
handle each is on right now. Titles, background pins, `stoppedAt` and death
causes are the server's; mirroring one here would make two sources of truth that
drift. What the sweep finds it reports as a `worktrees-discovered` /
`worktrees-active` event, and the server writes the row.

Discovery has one input the host cannot see for itself. Every tool with a
host-mounted home runs a `SessionStart` hook (`/etc/yaac/agent-links.sh`, baked
into the tools image) which appends **one JSON line per firing** to
`projects/<slug>/meta/<worktreeId>.worktree-starts.jsonl`, mounted into the pod at
`/home/yaac/.yaac/worktree-starts.jsonl`:

```jsonc
{"id":"<agentSessionId>","tool":"claude","pane":"3","path":"claude/projects/-workspace/….jsonl"}
```

The hook fires on `startup`, `resume`, `clear` and `compact` — exactly the
events that change which worktree a pane is in — and it is the only witness of a
user-started one, because it alone sees `TMUX_PANE` beside the tool's worktree
id. `/clear` and a hand-typed `claude --resume` are invisible from outside the
pod.

**Two files rather than one, and the split is the design.** The document is
rewritten whole (tmp + `rename`), which makes a torn read impossible and is why
it is never mounted into a pod: a rename replaces the inode a `File` hostPath
mount pins, and the pod would read a stale copy forever. The log is append-only
and never renamed, which is exactly what makes mounting it safe. Two
read-modify-writes would lose one side's write, and coordinating them would mean
a lock held across a hostPath mount from inside a gVisor sandbox — so the pod
appends and the server folds, and no lock crosses the boundary. Within the
server process, `updateWorktreeMeta` serializes per worktree on a keyed mutex.

Nothing truncates the log. Sightings are idempotent — a worktree id maps to one
handle — so re-folding it every tick is correct, and it avoids the drain/append
race a truncation would introduce.

A worktree is **active** in a worktree when the document names a handle for it
*and* the status watcher can currently see that handle. Neither source answers
alone: a handle outlives the pane that wrote it, and the watcher knows nothing
about which worktree is loaded. When the watcher has not enumerated handles yet
the active set is left untouched, so a stream gap never reads as "every agent
exited".

Handles are scoped to a **life** — one pod, recorded as `life` on the document
with a fresh id at each create. A handle counts only while its `handleLifeId` is
the current life, because tmux pane ids restart at `%0` and the previous life's
handle would otherwise name this life's pane. Nothing has to be deleted before a
pod starts.

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
metadata document, in the event that reports it, and in
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

`toProjectRelative` / `resolveProjectPath` in `runtime/agents/transcripts.ts`
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

Capture is per worktree: each gets its own opening message, read from the
transcript the metadata document names. There is no separate worktree-level capture — the
founding ask *is* the first worktree's opening message.

The discovery sweep does this once per worktree per server life and folds the
result back into the document, so a settled worktree costs one file read a tick. Where the transcripts live per tool
is `runtime/agents/transcripts.ts`. A worktree that died before capture
parses its first conversation's transcript on demand from the stopped listing,
and the result is persisted.

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
prunes the session dir but never `worktreeDir`, so a stopped row is a checkout
still on disk, diff and all, waiting to be restarted.

The agents *inside* a worktree are separate rows. `agent_sessions` holds one
row per tool-native conversation — a claude/codex/pi/opencode session, keyed by
the id the tool chose — and `worktree_agent_sessions` links the two, so a
worktree can accumulate conversations over its life and one conversation can be
resumed into a second worktree. See "Agent sessions" below.

`features/sessions/worktree-store.ts` owns the `worktrees` table and
`features/sessions/agent-session-store.ts` the other two: every runtime read and
write goes through them. The one other writer is the startup sweep in
`platform/db/legacy-import.ts`, which adopts worktrees that predate the tables —
it inserts directly, but applies the stores' invariants (normalized titles,
capped prompts) so an imported row is indistinguishable from a recorded one.

## Write discipline

- **`recordWorktreeCreated` is the only INSERT, and it runs first**, together
  with the first agent session — a worktree with no conversation could name
  neither its tool nor its label, so create records the one it is about to
  launch rather than waiting for discovery to notice it. (Discovery only ever
  adds to that; for opencode, which has no host link tree, it never fires at
  all.) Before the Job in `createSession`, and before a claim touches a
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

`listActiveSessions` joins live pods to one `getProjectWorktreeRows` and one
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

## Agent sessions

A worktree's conversations are *discovered*, not authored. Every tool with a
host-mounted home runs a `SessionStart` hook (`/etc/yaac/agent-links.sh`, baked
into the tools image) that maintains a record tree under that home:

```
.yaac-links/<worktreeId>/sessions/<agentSessionId>  the transcript's path,
                                                   relative to this home
.yaac-links/<worktreeId>/panes/<paneId>            the id on that pane
```

Both are plain files. The transcript path is
stored *relative to the tool home* because the hook only ever sees the in-pod
path (`/home/yaac/.claude/…`) while the server reads the same tree through the
host mount, where that prefix does not exist; joining the host-side home back
on is the whole translation, and it needs no interpreter in the hook. A
conversation whose transcript is outside the home, or not yet written, is
recorded with an empty body: the conversation is still real, only its path is
unknown.

`features/agents/agent-links.ts` also reads the tree an older hook wrote,
where a `sessions/` entry was a symlink named `<agentSessionId>.jsonl` pointing
at the transcript. Those trees are on disk for every worktree that ran before
the record format, and a pod launched from an older image keeps writing them
until it restarts — which is why the reader branches on the entry being a
symlink rather than a startup pass rewriting the trees once. Read as a record,
a symlink would name a phantom `<id>.jsonl` conversation, hide the real one its
pane pointer names, and load a whole transcript into memory as if it were a
path. A conversation named in both formats collapses to one, keeping the older
sighting.

The hook fires on `startup`, `resume`, `clear` and `compact` — exactly the
events that change which conversation a pane is in. `sessions/` outlives the
pod, so a stopped worktree can still list everything it hosted; `panes/` is
per-life state, wiped by session create before the pod starts, because tmux
pane ids restart from `%0` and a stale pointer would attribute this life's pane
to the last life's conversation.

`features/sessions/agent-session-registry.ts` joins that tree to the status
watcher's live pane set and writes the result. A conversation is **active** in a
worktree when a pane pointer names it *and* that pane is currently alive —
neither source can answer alone, since the pointers outlive the pane that wrote
them and the pane list knows nothing about which conversation is loaded. When
the watcher has not enumerated panes yet the active set is left untouched, so a
stream gap never reads as "every agent exited".

`active` is frozen at teardown and never recomputed while a worktree is
stopped. That freeze is the whole contract: a restart brings back exactly the
conversations that were live when the worktree stopped, each in its own tmux
window, in the order they were first opened (`agentWindowName` — the first
keeps the bare tool name so every existing `yaac:<tool>` target still resolves).

opencode is the exception throughout: it keeps history in a per-session sqlite
DB inside the container and leaves no host transcript, so it has no record tree
and its first message comes from an HTTP probe while the pod runs.

codex is the reason the *path* has to be recorded at all: claude's transcript
is at a conventional location and pi's is found by matching the id in its
filename, but codex names its rollout files unpredictably, so nothing derives
one from a session id. yaac used to index them with a symlink per session; the
recorded path replaces that, and a one-shot startup pass
(`resolveSymlinkedTranscripts`) rewrites any row still pointing at one of the
old symlinks to the file behind it. It runs while those symlinks still exist —
which is why it lives in the startup sweep and not in a migration, since SQL
cannot follow a symlink. One that no longer resolves, whether it dangles or is
gone outright, is cleared: a path that resolves nowhere is worse than no path,
since every reader would keep stat-ing it forever.

`agent_sessions.transcriptPath` stores that path the same way the record tree
does — **relative to the tool home**, never absolute. The home carries the data
dir, so an absolute path would pin every row to the directory that wrote it,
and moving a data dir (a restored backup, a changed `YAAC_DATA_DIR`) would
strand all of them silently, since the readers only ever stat these paths.
`toStoredTranscriptPath` / `fromStoredTranscriptPath` in
`features/agents/transcripts.ts` are the only place the two forms meet: the
store encodes on write and decodes in the single projection every reader comes
through, so nothing else sees anything but an absolute path. Encoding can fail
where decoding cannot — a transcript outside the home has no relative form, and
records as null, the same verdict the hook reaches. A second startup pass
(`relativizeTranscriptPaths`, after the symlink resolve) re-homes rows written
before the column held this form; one whose absolute path is not inside the
home is cleared, which is the moved-data-dir case, and the record tree puts the
right path back on the next reconcile tick. Neither pass can be a
`migration.sql`: the relative form depends on the data dir and the row's
per-project tool home, and SQL can see neither.

## First messages

Capture is per conversation: each agent session gets its own opening message,
read from the transcript its link resolved. There is no separate worktree-level
capture — the founding ask *is* the first conversation's opening message, read
through that link.

The `session-prompts` reconcile step does this once per conversation, so a
settled worktree costs one indexed read and no I/O. Where the transcripts live per tool
is `features/agents/transcripts.ts`. A worktree that died before capture
parses its first conversation's transcript on demand from the stopped listing,
and the result is persisted.

## Worktrees that predate the tables

The startup sweep (`platform/db/legacy-import.ts`) adopts them once: every
worktree a project's transcripts prove existed becomes a row, and rows the SQL
data migration had to guess at (it can only see the folded side tables) get
their `tool`, `createdAt` and base branch corrected from disk. Each also gets
its single agent session recorded and linked active — before the split, yaac
pinned the agent's conversation id to the worktree id (`claude --session-id
<worktreeId>`), so that conversation's id is known rather than guessed.

It is gated on a durable flag in `preferences`, not on the tables being empty —
the data migration runs first and seeds rows, so an emptiness check would skip
adoption on precisely the installs that need it. Running once is the point:
after that, an unrecognized transcript belongs to a conversation the hook will
link on its own, not to a worktree, and adopting those would list phantom
worktrees that no checkout, pod, or restart can back.

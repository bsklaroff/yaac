# Session storage

A yaac session is recorded in one place: the `agent_sessions` table in the
server's PGlite DB (`packages/server/src/platform/db/schema.ts`), one row
per `(projectSlug, sessionId)`. The cluster stays authoritative for whether
a session is *running*; the row is authoritative for everything else —
which sessions have ever existed, what tool each ran, its first message,
title, base branch, background pin, and when (and why) it went away.

`packages/server/src/features/sessions/store.ts` owns the table: every
runtime read and write goes through it. The one other writer is the startup
sweep in `platform/db/legacy-import.ts`, which adopts sessions that predate
the table — it inserts directly, but applies the store's invariants
(normalized titles, capped prompts) so an imported row is indistinguishable
from a recorded one.

## Write discipline

- **`recordSessionCreated` is the only INSERT, and it runs first.** Before
  the Job in `createSession`, and before a claim touches a prewarmed spare
  — the two paths that produce a user session. No pod can therefore exist
  without a row, which matters because a rowless pod is invisible to every
  path that reads recorded state and there is no way to tell one from an
  unclaimed spare after the fact. A create that fails afterwards rolls its
  row back; a *restart* that fails re-marks the row deleted instead, since
  that row already carried the session's history. A spare gets no row while
  it is warm, because it is not a session until claimed.
- **Everything else is an UPDATE**, which silently no-ops for a row that
  doesn't exist. That is what keeps spares — and sessions belonging to
  another data dir — invisible without a single existence check.
- **No session write deletes a row.** A row with `deletedAt` set *is* the
  deleted-session listing. A restart reuses the id and clears the column,
  along with any death cause from the previous life; the title and the
  background pin survive, because they belong to the session rather than to
  one of its lives. The two deletes are scoped to something other than a
  live session going away: `project remove`, which takes the worktrees and
  transcripts with it (rows left behind would list sessions whose restart
  resolves into a directory that no longer exists), and a create rolling
  back its own insert.
- Writes are best-effort (a failed write degrades a listing, never blocks a
  create or a teardown); reads propagate their errors.

## Reads

The base branch is stamped separately, once the worktree checkout resolves
it — the checkout runs concurrently with the pod boot, and making the row
wait for it would undo that overlap.

`listActiveSessions` joins live pods to one `getProjectSessionRows` query
per project. `listDeletedSessions` is recorded rows minus live pod ids,
sorted by `deletedAt` (falling back to `createdAt`), capped, and only then
touching the filesystem — one `stat` of `transcriptPath` for last-activity.
Restart resolves a deleted session's project and tool from the row, so a
tool that leaves no host transcript restarts like any other.

The stale reaper closes the last gap: a session recorded as live whose pod
never appeared (a create killed between the row write and the Job) is
recorded as a `never-started` death once it is older than any legitimate
cold create, which also makes it restartable. Creates still in flight in
the current process are exempt via the provisioning registry.

## First messages and transcripts

The `session-prompts` reconcile step captures each session's first user
message exactly once, onto its row, and stamps the transcript path in the
same write. Its work list is "live sessions with no prompt yet", so a
settled session costs one indexed read and no I/O. Where the transcripts
live per tool is `features/sessions/transcripts.ts`; opencode has none (its
history is a per-session sqlite DB inside the container), so its first
message comes from an HTTP probe while the session runs, and a session that
died before capture parses its transcript on demand from the deleted
listing.

## Sessions that predate the table

The startup sweep (`platform/db/legacy-import.ts`) adopts them once: every
session a project's transcripts prove existed becomes a row, and rows the
SQL data migration had to guess at (it can only see the folded side tables)
get their `tool`, `createdAt` and base branch corrected from disk.

It is gated on a durable flag in `preferences`, not on the table being
empty — the data migration runs first and seeds rows, so an
emptiness check would skip adoption on precisely the installs that need it.
Running once is the point: after that, an unrecognized transcript is a
conversation the agent started for itself — claude's `/clear` mints a fresh
session id and a fresh file — not a yaac session, and adopting those would
list phantom sessions that no worktree, pod, or restart can back.

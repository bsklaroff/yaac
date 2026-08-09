# One meaning for "session"

**A session is a conversation with an agent.** Nothing else.

The word currently carries four meanings in this repo, and the most common one
is the wrong one: in `create.ts`, `sessionId` *is* the worktree id, and
`sessionDir`, `sessionJobName`, `sessionRoots` and `LABEL_SESSION_ID` all key on
it. The other three are the agent's conversation (`agentSessionId`), the web
auth cookie, and tmux's own.

## The good news: the surface is already clean

This is an internal rename, not a compatibility event. The user-facing layers
have already moved:

- **CLI** — every command is `worktree-*` (`worktree-create`, `worktree-attach`,
  `worktree-stop`, …). No `yaac session` command exists.
- **HTTP** — the routes live in `routes/worktrees.ts`. The one session-named
  route is `GET /:id/agent-sessions`, which means agent conversations and is
  therefore *already correct* under this convention.
- **Database** — the spine table is `worktrees`. `agent_sessions` and
  `worktree_agent_sessions` mean conversations, so they are correct too; the
  `agent_` prefix becomes redundant rather than wrong, and dropping it is
  optional cleanup, not part of this.

So what is left is server-internal identifiers plus two names that cross into
the cluster or an image — and only one of those is hard. Nothing a user types or
a client calls has to change.

## The vocabulary

The worktree-meaning `session` does not collapse into one replacement, because
three distinct things are hiding under it. Getting this wrong is how a rename
turns into a second rename:

| word | means | where it is the right word |
|---|---|---|
| **session** | one conversation with an agent | the tool's own id, transcripts, first prompts, `mode` |
| **worktree** | the durable thing: a checkout, its history, its record | storage, the CLI, the database, anything a user names |
| **workspace** | the same thing seen by a herd, substrate-neutrally | the herd contract only — deliberately free of git and Kubernetes nouns (docs/plans/herd-split.md) |
| **pod** | the Kubernetes object a worktree currently runs in | `#platform/k8s` and nothing above it |

`SessionMount`, `SessionPod`, `sessionExec` and `sessionUid` are the ones this
table reclassifies: they are pod-level, not worktree-level, and renaming them to
`Worktree*` would be a second mistake on top of the first.

## The one hard edge

Everything else is `sed` with a code review. This one is protocol:

**`LABEL_SESSION_ID` (`yaac.session-id`)** is a label on live pods, and the pod
selectors read it. Changing it strands every running worktree: the new selector
matches nothing, and the pods carrying the old label go invisible to listing,
status and the reaper at once. Readers accept both for one release, writers
switch after. A relabel pass over live pods is the alternative; the dual-read is
cheaper and needs no cluster write.

It fails **silently** if done wrong — a stale selector finds no pods, it does not
error — so it wants a test that asserts the OLD label still resolves, not just
the new one. Land it alone, so a mistake is attributable.

**`YAAC_SESSION_ID`** used to belong here and no longer does. It was read by the
`SessionStart` hook baked into the tools image, which meant server and hook only
agreed after a rebuild and a pod from an older image kept reading the old name.
The hook now writes to a fixed in-pod path and does not need the worktree id at
all, so the only thing left reading the variable inside an image is the shell
prompt in `Dockerfile.default`. Injecting both names for one release keeps that
prompt from regressing on pods built before the rename; nothing else notices.

## The herd contract — landed

`7df3493` introduced `conversations-launched` / `-discovered` / `-active`,
`DiscoveredConversation`, `LaunchedConversation` and `ActiveConversation`. It
freed `session` on the *other* axis — naming the worktree `workspaceId` — and
then used `conversation` for what this convention calls a session.

Under this convention those are now `sessions-*` and `DiscoveredSession`. Doing
it first was the point: they were days old, in-process, carried no persisted
form, and had exactly one producer and one consumer. The moment the herd is a
separate process with a versioned protocol (herd-split steps 12–16), the same
rename would have needed a compatibility window it did not need then.

`workspaceId` stays. It is not the worktree-meaning `session` under another
name — it is deliberately substrate-neutral, and the herd report is the one
place that matters.

## Order

1. **The herd contract** — `conversations-*` → `sessions-*`. **Landed**, with
   the worktree metadata work, since it touched the same contract.
2. **`LABEL_SESSION_ID`**, with its dual-read release, landed alone.
   `YAAC_SESSION_ID` can ride along or go later — see above, it is no longer a
   hard edge.
3. **`#platform/k8s`** — the pod-level names (`SessionPod`, `SessionMount`,
   `sessionExec`, `sessionUid`, `sessionPodSelector`) become pod-level words.
   Self-contained, and it shrinks the count enough to make the rest legible.
4. **`#features/sessions` and its callers** — the bulk. Worth doing
   feature-by-feature rather than repo-wide: the folder is already split down
   the middle by `HERD_SRC`, and a per-module rename keeps each diff reviewable
   against the herd boundary it sits on.
5. **`@yaac/shared/types` and the frontend** — `SessionDeathCause`,
   `StaleSessionInfo`, `SessionView` and friends. Last because every other layer
   feeds them, and mechanical once the rest has settled.

The folder `#features/sessions` itself is misnamed under the convention — it is
the worktree feature. Renaming it touches the `imports` map, `HERD_SRC`, the
sealed-folder eslint rule and every importer at once, so it belongs at the end
of step 4 as its own commit, not spread through it.

## Risks worth naming

- **A rename that is 95% done is worse than one not started**, because a reader
  can no longer tell which meaning a given `sessionId` carries. Each step above
  should leave the repo in a state where the answer is "this module is done" or
  "this module is untouched", never "it depends on the line".
- **`grep` cannot do this.** `session` appears ~1900 times bare, and the
  worktree meaning and the conversation meaning are both spelled `sessionId`.
  The type checker catches renames within a package; it does not catch a
  *correct-looking* rename that changed the meaning. Reviewing by module, with
  the table above in hand, is what makes that tractable.
- **Tests encode the old names in strings**, not just identifiers — pod labels,
  env var names, fixture paths. A green run after renaming only the identifiers
  proves less than it looks.

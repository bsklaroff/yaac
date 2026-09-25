# Per-worktree agent history

## Problem

Under `k8s`, every worktree pod of a project mounts that project's tool homes
read-write: `claude/` at `/home/yaac/.claude`, `codex/` at `/home/yaac/.codex`,
`pi/` at `/home/yaac/.pi`. Every conversation's transcript lives inside them,
so any session can delete any sibling's history, and yaac has no second copy —
`agent_sessions` stores only a transcript's path, opening message and model.
The same goes for claude's `file-history/` (what `/rewind` restores from) and
codex's sqlite databases.

ACP records (`acp/<worktreeId>`), opencode data (`opencode-data/<worktreeId>`)
and the session-starts log are already per worktree and are not touched here.

## Goal and boundary

- **Under k8s, a pod can reach only its own conversations' history.** It can
  still read and write the project's shared agent *config*, which is shared
  on purpose.
- **Switching drivers keeps working.** An install may move a data dir between
  k8s and containerless in either direction, and a worktree's conversations
  have to resume on whichever driver restarts it. So the durable layout is the
  same on both: a worktree's history lives in
  `global/projects/<slug>/history/<worktreeId>/`, and each driver makes that
  directory reachable in its own way.
- **containerless gains no isolation.** It has no sandbox, so an agent there
  can delete anything the server's user can. What it gets from this plan is
  the shared layout, not protection.
- **Pods started before the upgrade keep the old layout** until they restart.
  `history/` sits outside every old mount, so nothing such a pod does can
  reach history that has already been moved.
- **Cross-worktree resume goes away** (agreed): `claude --resume`'s picker
  lists only this worktree's conversations. Nothing in yaac relies on it.
- **The boundary is the worktree, not the conversation.** A worktree can hold
  several conversations at once: extra windows, a `/clear`, and a different
  tool per window. They all run in one pod, as one uid, over one filesystem,
  so one of them can delete another's transcript, just as it can delete the
  checkout or kill the other agent. No mount layout separates processes that
  share a sandbox. Protecting conversations from each other within a
  worktree needs a copy the sandbox can't reach; see Follow-ups.

## Layout: one per-worktree tree, reached per driver

Each tool home stays one per-project directory holding the shared config
(settings, `.claude.json`, credentials, skills, agents, plugins, `config.toml`,
auth). What moves into `history/<wt>/` is per-conversation state:

| `history/<wt>/…` | What it holds | k8s reaches it by | containerless reaches it by |
|---|---|---|---|
| `claude/` | claude's `projects/` (transcripts, subagent logs, tool results) | mount at `/home/yaac/.claude/projects` | a folder symlink in the shared `claude/projects/` (below) |
| `claude-file-history/` | claude's `file-history/<sid>/` | mount at `/home/yaac/.claude/file-history` | per-conversation symlinks (below) |
| `codex/` | codex's `sessions/` rollouts | mount at `/home/yaac/.codex/sessions` | per-rollout symlinks (below) |
| `codex-sqlite/` | `state_5`, `thread_history_1`, `logs_2`, … | mount at `/home/yaac/.codex-sqlite` + `CODEX_SQLITE_HOME` | the same declaration: a symlink in the private HOME, with the env var remapped to the source |
| `pi/` | pi's session logs | mount at `/home/yaac/.yaac-pi-sessions` + `PI_CODING_AGENT_SESSION_DIR` | the same, like `codex-sqlite/` |

Where a tool has an env override (codex's sqlite home, pi's session dir), both
drivers use it and the layout matches with no extra machinery. The mount is
not nested, so the containerless driver realizes it as an ordinary link. The
other three have no override. Under k8s they are nested mounts, layered over
the shared home the way builtin skills already are. Under containerless a
nested mount can't be realized (a link written inside the shared home would be
shared), so the containerless create plants links in the shared homes instead.

**Auto-memory stays shared.** In a pod, claude keys it on the canonical git
root, `/repo`, so it lives at `projects/-repo/memory/`. The host's
`claude/projects/-repo/memory` is mounted back at that path, on top of the
`projects/` overlay. On a host the key is the munged host repo path, which
means memory already splits across a driver switch today. The containerless
create fixes that with the same link mechanism: `claude/projects/<munged
host repo>` → `claude/projects/-repo`.

### Why not a per-worktree `CLAUDE_CONFIG_DIR`, with config linked back in

- On macOS, claude names its Keychain item after a hash of the config dir
  (`CLAUDE_SECURESTORAGE_CONFIG_DIR` can decouple that), and credential-sync
  reads per-project homes.
- Every config entry claude creates *after* the per-worktree dir is built
  lands in the per-worktree dir. codex's `auth.json` refresh may also replace
  a link rather than write through it, and under containerless (real
  credentials) that spends the project's refresh token.
- `CLAUDE_CODE_PROJECT_DIR_NAME` (claude 2.1.280) would file transcripts
  under a fixed folder name on both drivers, but it is undocumented and the
  ACP adapter's bundled claude (2.1.220) doesn't know it.

## Converging at create, both directions

A switch can leave history where the other driver put it. Every create and
restart (in the create prep, before the workspace launches) therefore
converges this worktree's history into the current driver's shape. This is
the pattern `reconcileSharedSkillRoots` already uses. The step is permanent,
not a shim: a stretch under containerless can always leave new files in the
shared homes.

**Which conversations are this worktree's.** Every step below iterates the
same set, and it has to cover every conversation the worktree ever held, not
only the one a restart brings back. Under k8s the shared `-workspace` dir holds
every worktree's files together, so a conversation left out stays in the
shared home, where siblings can reach it and resume can't. The set is the
union of:

- the link rows (`listWorktreeAgentSessions`, the whole history rather than
  only `active`)
- every id in the worktree's session-starts log, including lines from earlier
  lives. The log is never truncated, so it names each `/clear` and each extra
  window even when the pod died before the sweep turned a sighting into a row.
- the ACP record names in `acp/<wt>/`. ACP conversations get no hook line, and
  the SDK's claude still writes a transcript under `projects/`.
- the worktree id itself, which the pinned first conversation uses and which
  may have no row yet

Each id is looked up in every tool's layout, since the log's `tool` field is
the only per-id hint and ACP ids carry none.

**Subagents ride with their parent, but not in the same way for each tool:**

- **claude** files a conversation's subagents *inside* it:
  `projects/<dir>/<sid>/subagents/agent-<id>.jsonl` (plus `.meta.json` and
  forked-skill markers), next to `<sid>/tool-results/`. Moving or linking
  `<sid>.jsonl` together with its `<sid>/` sibling covers them, as does the
  containerless folder link and the k8s overlay. They need no ids of their
  own.
- **codex** subagents are threads of their own. A `spawn_agent` child, like a
  `/fork`, gets its own rollout, named for its own thread id and filed by
  date like any other. Its tie to the parent is `thread_spawn_edges` in the
  sqlite state and the parent id (`parent_thread_id` / `forked_from_id`) in
  the child's `session_meta`, the rollout's first line. A child may fire no
  hook, so it may never appear in the log or a row. The set therefore closes
  over codex children: scan `codex/sessions/` for rollouts whose
  `session_meta` names a thread already in the set, and repeat until nothing
  new turns up. Rollout files, not the sqlite, because the sqlite may be the
  shared pre-upgrade one, or absent.
- **pi** has no subagents of its own. An extension that starts child pi
  sessions writes them to the same session dir, which is per worktree on both
  drivers after this change. Only pre-upgrade children, matched by id alone,
  stay behind in the shared home.
- **opencode** keeps subagents in its per-worktree database, so nothing
  changes.

New subagents under k8s land in the overlay, so the closure only matters for
files written before the upgrade or during a containerless stretch.

**Under k8s: move in.** For each id in that set:

- claude: `claude/projects/*/<sid>.jsonl` and its `<sid>/` sibling →
  `history/<wt>/claude/-workspace/`; `claude/file-history/<sid>` →
  `history/<wt>/claude-file-history/<sid>`
- codex: the row's `codex/sessions/<rest>`, or failing that the rollout found
  by id (codex names each file `rollout-<timestamp>-<thread id>.jsonl`, and
  containerless codex conversations have no hook, so no recorded path) →
  `history/<wt>/codex/<rest>`
- pi: `pi/agent/sessions/**/<ts>_<sid>.jsonl` → `history/<wt>/pi/` (only
  pre-upgrade installs have these; after the change both drivers write pi
  there)

A real file is moved with `fs.rename` (both ends are under the project dir). A
symlink into this worktree's history is left alone: containerless planted it,
the data is already in place, and the pod can't see it under the overlay. This
also covers every pre-upgrade k8s worktree, so it needs no separate legacy
path. New paths reach the rows through a `sessions-discovered` event, the one
door for observed facts.

**Under containerless: link out.**

- `claude/projects/<munged checkout path>` → `history/<wt>/claude/-workspace`.
  claude files a host worktree's transcripts under its checkout path, which
  is per worktree, so one folder link means **new** containerless transcripts
  are written straight into `history/`. If a real dir is already there
  (written before this change), move its contents in first, then link.
- For each id in the same set that has files in `history/`:
  `claude/file-history/<sid>` → its history dir, and each codex rollout
  linked at its own relative path under `codex/sessions/`. New
  file-history and new rollouts written under containerless are real files in
  the shared homes, and the next k8s create moves them in.
- `claude/projects/<munged host repo>` → `claude/projects/-repo`, for memory.
  If both are real dirs, leave both and log; never merge.

The munged names follow claude's rule (every non-alphanumeric character
becomes `-`; past 200 characters it truncates and appends a hash). If a path
is too long, or its logical and physical forms differ (macOS `/var` vs
`/private/var`), link every form claude might use, or skip and log. Skipping
degrades to what happens today: files land in a real dir, and the next k8s
create moves them in. `transcripts.ts` currently avoids deriving this name on
purpose, so it gets a test pinned to claude's behavior.

## Other changes

### Create (`#domain/worktrees` create.ts)

- `mkdir -p` the five `history/<id>/…` subdirs (and
  `claude/projects/-repo/memory`) before the Job, so the kubelet never
  creates a subPath root-owned.
- Both drivers: the `codex-sqlite` and `pi` mounts and their env vars.
- k8s only (the `hostSkills` fact generalized to "can layer mounts over tool
  homes"): the three nested mounts and the memory mount.
- The converge step above, in whichever direction the runtime needs.

### Discovery: record where the file really is

The hook stays as it is and keeps reporting container-layout paths
(`claude/projects/<dir>/<sid>.jsonl`, `codex/sessions/…`). The fold maps them
into the worktree's own tree, then realpaths:

- `claude/projects/<rest>` → first that exists of
  `history/<wt>/claude/<rest>` and `claude/projects/<rest>`, then realpath.
  A containerless link resolves into `history/`, so the row names the real
  file.
- `codex/sessions/<rest>` works the same way.
- If nothing exists yet (claude writes on its first turn), omit the path; the
  next tick's re-fold fills it.
- Any other prefix drops the path. The hook never emits one, and this is
  tighter than today's check, which accepts any project-relative path.
- A realpath outside the project dir, or inside a *sibling's* `history/`,
  drops the path. On a host a link could otherwise point anywhere.

### Readers (`runtime/agents/transcripts.ts`)

`sessionTranscriptPath` / `findClaudeTranscript` / `piSessionLogs` take the
worktree id and search `history/<wt>/…` first, then the shared homes (files a
containerless stretch left behind, and not-yet-restarted pre-upgrade
worktrees). That also fixes `transcript.ts`, which passes a conversation id
where a worktree id belongs. Readers therefore work on either driver whoever
wrote the file. Only a *resume* needs the converge step.

### Lifecycle

- `deleteWorktreeState` also removes `history/<wt>` and the containerless
  folder link. Its "transcripts are deliberately left" note goes away, since
  that existed only to protect cross-worktree resume. (It doesn't remove
  `acp/<wt>` today either; add it while there.)
- Stop keeps everything. `project remove` takes `history/` with the project
  dir.

## Verify against the pinned binaries before building

claude and codex are unpinned in the image (`Dockerfile.tools`), so each point
below also needs a test that fails if a new release changes it:

1. claude (TUI 2.1.280 and the ACP SDK's 2.1.220), k8s: a new conversation
   writes into the overlay, `--resume <sid>` finds a moved transcript, and
   memory reads and writes `projects/-repo/memory` through the inner mount.
2. claude, containerless: it writes into and resumes from a `projects/`
   folder that is a symlink; the munged-name rule matches for real checkout
   paths (and macOS's physical path); memory works through the repo link.
3. codex: `resume <id>` works with a rollout reached through a file symlink
   under `sessions/` (and appends through it), and with a per-worktree
   `CODEX_SQLITE_HOME` that starts empty (TUI and codex-acp). Check that a
   resumed parent still finds its `spawn_agent` children once they're moved
   or linked (and that the backfill rebuilds `thread_spawn_edges`); pin the
   `session_meta` field that names a child's parent; and check whether a
   child thread fires the SessionStart hook. Also check
   whether any version writes `.jsonl.zst` rollouts (seen in 0.156.1's
   strings), since yaac reads plain `.jsonl`.
4. pi: resumes by `--session-id` from the new session dir on both drivers.

## Tests

- **unit:server:** the fold's mapping and realpath rules (own history first,
  shared fallback, a sibling's history refused, omit when missing); both
  converge directions (move in, link out, idempotent re-runs, a real dir
  sitting where a link belongs, a conversation linked twice); reader search
  order; `deleteWorktreeState` removing `history/<wt>`.
- **test/e2e (k8s, one file, shared fixture):** two worktrees of one project.
  From A, `rm -rf ~/.claude/projects/* ~/.codex/sessions/*` leaves B's rows
  readable through `GET …/transcript`. A memory file written in A is visible
  in B. A holds several conversations: two claude windows, a `/clear`, and a
  codex window. A claude conversation has run a subagent, and the codex one has
  spawned a child. After a restart every active one resumes, and every inactive
  one has been moved into A's history. That includes the claude subagent's
  `<sid>/subagents/` files, a codex child rollout planted with only a
  `session_meta` parent link, and a conversation planted only as a
  session-starts line with no row. A pre-upgrade layout, planted before
  restart, is moved in.
- **test/e2e-containerless:** the existing cases, plus a worktree whose
  history was planted in the k8s shape resumes (the k8s→containerless half of
  a switch). The reverse half is covered by the k8s tier's planted-layout
  case.

## Docs on ship

- `docs/worktree-storage.md`: the `history/` tier, both drivers' way of
  reaching it, and the converge step. Also rewrite the end of "Transcript
  paths" (shared homes, cross-worktree `--resume`, `cleanupPeriodDays` as
  cross-worktree protection).
- `docs/containerless-driver.md`, "Mounts become symlinks": which history
  mounts it realizes and which it replaces with links in the shared homes.
- `project-paths.ts` doc comments on `claudeDir` / `codexDir` / `piDir` /
  `piSessionsDir`, which currently promise every worktree's logs are shared.

## Decided

- Codex's sqlite home is per worktree (codex memories become per worktree).
- `file-history/` is per worktree.
- Switching drivers stays supported.

## Follow-ups, not in this change

- `worktree_agent_sessions` stays many-to-many even though a conversation now
  belongs to one worktree.
- `acp/<wt>` could move under `history/<wt>/acp`, at the cost of migrating
  ACP records.
- **A server-side copy, for conversations sharing a worktree.** The server
  could copy each transcript into server-local storage, which no worktree
  mounts, as the discovery sweep sees it grow (an mtime-and-size stamp
  answers "has this changed?"). Readers would fall back to the copy when the
  original is gone. That is the only thing that protects one conversation
  from another in the same worktree, and it would also make "yaac can recover
  it" literally true under k8s. It costs duplicated storage and a copier that
  must never read a file a pod swapped for a symlink. It is also meaningless
  under containerless, where the agent can reach server-local too.

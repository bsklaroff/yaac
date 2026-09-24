# Queued worktrees

## What this adds

A **queued worktree** is a worktree create request saved for later: a
prompt plus the full create settings (agent, model, permissions, UI mode,
branch), attached to a **parent** worktree. The queued request runs
automatically when the parent stops *naturally*. A natural stop is a user
stop from the webapp, `yaac worktree stop`, or `yaac-mama stop`. It does not
run when the parent dies (OOM, crash, eviction, the agent's tmux going away,
and so on). In that case the request waits, still under the parent, until
the user runs it or discards it.

The same change also reworks the create flow around it:

- The create popover becomes one **create dialog**: a centered modal built
  like Settings, with an optional prompt and a **Start** dropdown (`Now` /
  `After <worktree> stops`). The dialog is used for creating, queueing and
  editing a queued request.
- **Alt+N** opens that dialog with the prompt focused, instead of creating a
  worktree straight away. Alt+N then Enter still gives the old one-keystroke
  create.
- A sidebar worktree row's hover icons collapse into one **`…` menu**, which
  gains **Queue worktree after this…**.
- Queued requests show in the sidebar **nested under their parent**, with
  **Run now / Edit / Discard**.
- The **stop dialog** lists the worktree's queued children, so the user can
  edit or discard them before they start.
- **`yaac-mama queue`** lets an agent queue a follow-up under itself, or
  under another worktree named with `--session`.
- **Permission ceiling for agents.** Permission modes get a strict ordering.
  Anything an agent creates through `yaac-mama create` or `yaac-mama queue`
  runs at or below the creating worktree's own permission mode. Both commands
  take `--permission-mode`, and a request that can't meet the ceiling fails
  with an error rather than being quietly downgraded.

There is no parent/child or deferred-create concept in the codebase today.
The only relative is `callerWorkspaceId` in `spawn-policy.ts`, and that is
an in-memory concurrency cap that is never persisted.

## Terms

| Term | Meaning |
|---|---|
| **queued worktree** / **entry** | A `queued_worktrees` row: a saved create request. It is not a worktree yet. It has no `worktrees` row, no checkout and no runtime. |
| **parent** | The worktree an entry waits on (`parentWorktreeId`). |
| **release** | Marking an entry to launch now. A natural parent stop releases every child. **Run now** releases one. |
| **launch** | Turning a released entry into a real worktree through the normal create path. The entry is deleted when the create succeeds. |
| **held parent** | A *stopped* worktree that still has entries. It stays in the sidebar until it has none. |

The UI calls entries "queued worktrees" and never "queued sessions"
(docs/naming.md). In code, "queue" already names the egress proxy's
`yaac-mama` request queue (`mama-queue.ts`). So this feature's modules and
table are called `queued-worktree*` / `queued_worktrees`, never `queue`.

## Behavior

### When an entry runs

The release happens in `stopWorktree` (`domain/worktrees/stop.ts`) and
nowhere else. That function is exactly the set of natural stops. Every
user-requested stop reaches it, and none of the other paths that record a
stop do:

| Stop path | Reaches `stopWorktree`? | Children |
|---|---|---|
| Webapp stop (row menu, Alt+D) → `POST /worktree/stop` | yes | released |
| `yaac worktree stop` → `POST /worktree/stop` | yes | released |
| `yaac-mama stop [--session X]` → `runMamaCommand` → `runStop` | yes | released |
| Stale reaper: `oom`, `evicted`, `crashed`, `pod-stopped`, `agent-exited`, `never-started`, `orphaned` | no (`cleanupWorktreeDetached` with a `cause`) | stay queued; parent is held |
| Restart of a running worktree (`teardownForRestart`) | no | stay queued; the parent comes back |
| Failed resume (`applyCreateFailed`) | no | stay queued; parent is held |
| Project removal | no | deleted with the project's rows |
| Prewarm spare reap | no | spares have no children |

Stop *records* cannot be used for this. The `worktree-stopped` event with no
`cause` also covers restart teardown, failed resumes and project purges. And
`applyWorktreeEvent` is a row-writing door with no intent attached. So
"`deathReason IS NULL`" is not a safe trigger, while the call site is.

`stopWorktree` releases **after** `cleanupWorktreeDetached` returns, which
is once the `worktree-stopped` row is written. Launching children does not
wait for the detached runtime teardown, because a child has its own checkout
and runtime and does not depend on the parent's being gone. A user who stops
a worktree that has already died, before the reaper has noticed, gets a
natural stop. They chose to stop it, and the stop dialog showed them what
would start.

Exiting the agent (`/exit`, which takes the tmux server down with it) is a
death. The reaper records it as `agent-exited`, which it cannot tell apart
from a crash, so the children stay queued. An agent that is done calls
`yaac-mama stop`.

All of a parent's children release together and launch concurrently, as
siblings. There is no limit on how many entries one parent can hold.

### Default settings come from the parent

When the dialog's Start is set to a parent, or when `yaac-mama queue` runs,
an entry's settings default to the parent's **first agent session** (the
same session that supplies the worktree's tool and label):

- **tool** and **mode**: from that session.
- **model**: that session's *current* model (`AgentSessionEntry.model`
  follows a `/model` switch), which is what "the parent's settings" means to
  a user.
- **permissionMode**: from the parent's `worktrees` row. For an entry made
  by `yaac-mama queue`, this default is also checked against the calling
  worktree's ceiling (see "Permission ceiling" below).
- **branch**: the parent's **reference branch** (`worktrees.baseBranch`, the
  branch the parent forked from), and **not** the parent's own `agent/<id>`
  branch. The child forks from the *latest* origin tip of that branch at
  launch time, not from the commit the parent started from.

If the user picks a different tool, the tool-dependent fields fall back to
the normal `resolveCreate` answers for that tool (remembered per-project
defaults, then the tool default), exactly as the popover does today.

Every setting is **resolved to a concrete value and stored when the entry is
queued**. This includes `branch` and `model`: an entry never holds a null
that is filled in later. What the sidebar and the edit dialog show is
exactly what will run, and an edit can change a value but never clear it.

- **`model`** = the explicit choice, else the parent's current model when
  the tool matches the parent's, else `resolveToolCreateDefaults`' answer
  (the remembered default, then `defaultModelFor`). `defaultModelFor` returns
  `''` for a provider the catalog lists no models for. In that case the queue
  is refused (`VALIDATION`: no model is known for that tool; pick one) rather
  than stored empty.
- **`branch`** = the explicit choice, else the parent's `baseBranch`. The
  parent row's `baseBranch` has to be there to read, and today it may not be
  (next paragraph).

**Record `baseBranch` when the worktree row is created.** Today
`baseBranch` is written by a `base-branch-resolved` event that lands after
the launch has finished, and only on a best-effort basis. So a parent that
is still starting has none. That is exactly the parent of
`id=$(yaac-mama create …); yaac-mama queue --session "$id" …`.

The branch doesn't need to wait for the launch: `createWorktree` computes
it as `options.branch ?? config.referenceBranch ?? getDefaultBranch(repo)`,
and all three are local reads. `getDefaultBranch` reads `origin/HEAD` from
the local clone, and `fetchOrigin` does not move that ref.

So step 3 of the order of work resolves the branch **before** the row is
written and carries it on `worktree-created`:

- The checkout uses that same resolved value.
- The cold-create emit of `base-branch-resolved` is deleted.
- The event survives only for the spare claim, whose re-branch really does
  change the branch after the row exists.
- A spare's row gets its warmed branch at creation.

After this, every row a current server writes has `baseBranch` from birth,
including a parent that is still provisioning.

**Old rows.** Rows written before this change may still have no
`baseBranch`. For those, `queueWorktree` falls back to the project's
reference branch as a create would resolve it (`config.referenceBranch ??
getDefaultBranch`), and stores that value concretely. The fallback's only
reason to exist is rows from older installs, so it gets a section in
`docs/legacy-compat-shims.md`:

- **What it reads:** `worktrees.baseBranch IS NULL`.
- **What breaks silently if it is removed too early:** queueing under such a
  parent fails.
- **When it is safe to remove:** once no row with a null `baseBranch` can
  still be live or restartable.

**Latest from origin.** A cold create already runs `fetchOrigin` before
`addWorktree(…, 'origin/<branch>')`, so it always forks from the current
remote tip. A prewarmed spare does not: when the spare's warmed branch
matches the request, the claim skips the fetch, and the spare keeps the tip
from when it was warmed. So queued launches **skip the spare claim** and
always create cold (`claimSpare: false`). Nobody is watching a background
child start, so the spare's speed is not worth a stale base.

Queueing does **not** call `recordProjectCreate`. Settings inherited from a
parent are not a choice the user made for the project, and they should not
overwrite the create defaults the create form remembers.

### Groups

A child is filed into its **parent's group at launch time**, meaning the
parent's `worktrees.groupId` as it is when the entry starts. If the user
moves the parent between queueing and stopping, the child follows the
parent. The entry has no group column, and the dialog has no group field
(today's create has none either).

### Held parents stay in the sidebar

A stopped worktree with at least one entry is **held**. It renders in its
normal place (the default list or its group section) as a stopped row: the
ghost-row styling, plus its death reason when it died ("died — OOM"). Its
entries render beneath it. It drops out once its last entry has launched or
been discarded. A group whose only occupant is a held parent is shown, as if
it had a live member.

This covers both ways a parent can end up held:

- **It died.** Its children never ran. The row keeps them visible until the
  user runs or discards each one. Restarting the parent brings it back to
  life with its children still queued for its *next* natural stop.
- **It stopped naturally, but a child's launch failed.** The child is back in
  the queue with `launchError` set (see below), and the user can fix it and
  Run now.

### Editing, discarding, running now

- **Edit** changes any stored field, including the parent: the dialog's
  Start dropdown can re-parent an entry. Choosing `Now` in edit mode saves
  the entry and runs it.
- **Discard** deletes the entry. From the sidebar it asks for confirmation
  (the entry is a prompt someone wrote). In the stop dialog it happens
  immediately, because that dialog is already a confirmation. Discarding in
  the stop dialog and then cancelling the stop does not bring the entry
  back.
- **Run now** releases one entry, whatever the parent's state. The parent
  keeps running if it is running.

An entry whose launch is in flight cannot be edited or discarded
(`CONFLICT`). It is also absent from the snapshot while in flight, and its
provisioning row stands in for it (see below).

### Launch, failure, and a server restart mid-launch

A launch goes through the same create path as the route (see
`startWorktree` below), with the spare claim turned off. It shows a normal
provisioning row with progress and delivers the prompt the same way
(`agentDriver(mode).deliverPrompt`).

- **Claim.** The launcher first sets `launchWorktreeId` with a
  compare-and-set (`WHERE launch_worktree_id IS NULL`), before it provisions
  anything under that id. A Run-now double-click, or the stop hook racing
  the reconcile step, loses the CAS and does nothing.
- **Success.** The entry row is deleted.
- **Failure.** `launchWorktreeId` and `releasedAt` are cleared and
  `launchError` is set. The provisioning entry is *removed*, not *failed*, so
  the error shows once, on the queued row, rather than also as a failed
  provisioning row with a dismiss ×. The prompt is never lost: a failed fresh
  create deletes its `worktrees` row, but the entry is still there.
- **Server restart mid-launch.** The entry still has `launchWorktreeId`, and
  the new process's provisioning registry does not know it. The reconcile
  step (below) handles this. If the runtime snapshot has a live workspace
  under that id, the launch finished and only the cleanup was lost, so the
  step deletes the entry. Otherwise it clears `launchWorktreeId` and launches
  again under a fresh id. The half-made worktree from the dead attempt is the
  stale reaper's (`never-started`), as it would be for any interrupted
  create.

## Data model

A new table in `packages/server/src/db/schema.ts`. It gets a uuid surrogate
key, and, like every other table there, has no foreign keys.

```ts
/**
 * A worktree create request saved to run when `parentWorktreeId` stops
 * naturally (docs/queued-worktrees.md). Not a worktree: no `worktrees` row,
 * checkout or runtime exists until it launches, and the launch deletes it.
 */
export const queuedWorktrees = snakeCase.table('queued_worktrees', {
  id: uuid().primaryKey().defaultRandom(),
  projectSlug: text().notNull(),
  parentWorktreeId: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  prompt: text().notNull(),
  tool: text().notNull(),
  model: text().notNull(),
  mode: text().notNull(),
  permissionMode: text().notNull(),
  /** The reference branch to fork from (no `origin/` prefix); fetched fresh
   *  from origin at launch, so the child starts from its latest tip. */
  branch: text().notNull(),
  /** Set by a natural parent stop or Run now; the launcher's work list. */
  releasedAt: timestamp({ withTimezone: true }),
  /** The worktree id this entry's in-flight launch is creating. Set by a
   *  compare-and-set before anything is provisioned; it is the claim. */
  launchWorktreeId: text(),
  /** Why the last launch failed; cleared by the next release. */
  launchError: text(),
}, (t) => [index().on(t.projectSlug, t.parentWorktreeId)])
```

Generate the migration with
`pnpm --filter @yaac/server exec drizzle-kit generate --name add_queued_worktrees`.

No legacy-compat shim is needed. The table starts empty, and nothing older
reads or writes it.

**Store** (`db/queued-worktree-store.ts`, exported from the `#db` barrel).
Every write ends with `notifyWorktreeListChanged()`, like `group-store.ts`:

| Function | Does |
|---|---|
| `insertQueuedWorktree` | adds an entry |
| `updateQueuedWorktree` | edits an entry; guarded by `launchWorktreeId IS NULL`; returns whether it matched |
| `deleteQueuedWorktree` | deletes an entry, with the same guard |
| `listQueuedWorktreeRows(projectSlug?)` | reads entries |
| `releaseQueuedChildren(slug, parentId)` | sets `releasedAt`, clears `launchError`; returns the released rows |
| `releaseQueuedWorktree(id)` | same, for one entry |
| `claimQueuedLaunch(id, worktreeId)` | the CAS |
| `finishQueuedLaunch(id)` | deletes the entry after a successful launch |
| `failQueuedLaunch(id, error)` | records a failed launch |
| `deleteProjectQueuedWorktrees(slug)` | removes a project's entries; called from `removeProject` beside `deleteProjectWorktrees` |

## Server

### Refactor first: one `startWorktree`

Today the create logic is split across three callers:

- The `POST /worktree/create` handler (`api/routes/worktrees.ts`) owns
  resolve group → `resolveCreate` → remember defaults → try a spare
  (delivering the prompt itself) → `registerProvisioning` → `createWorktree`.
- `decideSpawn` (`spawn-policy.ts`) repeats a smaller version with no spare
  claim.
- The queue launcher would be a third copy.

Resolving, deciding and then acting is domain work (CLAUDE.md: "anything
that resolves, decides and then acts belongs in `#domain`"). So step one
moves the route body into `startWorktree(request, onProgress)` in
`domain/worktrees/`:

- The route becomes a thin `streamProvisioned` wrapper around it.
- `decideSpawn` keeps only its policy (the per-caller cap and tool
  precedence) and calls it, which also gives `yaac-mama create` the spare
  fast path.
- The queue launcher calls it too.

`startWorktree` takes two flags:

- `rememberDefaults`: the route passes `true`, while `yaac-mama` and queued
  launches pass `false`. For the route and `yaac-mama create` that is the
  same behavior as today.
- `claimSpare`: queued launches pass `false`, for the reason given under
  "Latest from origin".

This is also where "the id the launch ends up with" becomes one answer: a
claimed spare's id or the minted one. The launcher needs that id for its
claim.

### Domain module

The domain module is `domain/worktrees/queued-worktrees.ts`. It is exported
through the `#domain/worktrees` barrel:

| Function | Does |
|---|---|
| `queueWorktree(project, request, source)` | Resolves the parent with `resolveSessionInProject` (the same id-or-prefix lookup `yaac-mama` uses). Rejects spares and unknown ids (`NOT_FOUND`). Fills defaults from the parent (above) and checks `launchPermissionMode` for the tool/mode pair. When `source` is `mama`, it also applies the permission ceiling. Inserts the entry. There is no cap on entries per parent. |
| `updateQueuedWorktree(id, patch)` | Validates like `queueWorktree`; `CONFLICT` while launching. |
| `discardQueuedWorktree(id)` | `CONFLICT` while launching. |
| `runQueuedWorktree(id)` | `releaseQueuedWorktree`, then launches detached. Returns once the launch is claimed. |
| `releaseQueuedChildren(slug, parentId)` | Called by `stopWorktree`. Releases the children and launches each one detached. |
| `listQueuedWorktrees()`, `listHeldWorktrees()` | Snapshot projections. |
| `reconcileQueuedWorktrees(ctx)` | The reconcile step. |

The launcher is internal: claim → read the parent's current `groupId` →
`startWorktree({ …entry, groupId, rememberDefaults: false,
claimSpare: false })` → on
success `finishQueuedLaunch`, on failure `failQueuedLaunch` and
`removeProvisioning`. Its `registerProvisioning` carries the `groupId`, so
the provisioning row appears in the right section.

**Reconcile step** `queued-worktrees`, added to `defaultReconcileSteps()`
after `stale-worktrees`. It has no triggers of its own, so it runs on resync,
and the first pass after server start is a resync. It is the crash
backstop, not the main path, because `stopWorktree` launches directly. It
handles two cases:

1. **An interrupted launch.** The entry has `launchWorktreeId` set, and the
   provisioning registry doesn't know that id. If `ctx.snapshot()` has a live
   workspace under the id, the step calls `finishQueuedLaunch`. Otherwise it
   clears the claim and launches again.
2. **A missed release.** The entry has `releasedAt` set and
   `launchWorktreeId` null, which means the server died between the release
   and the launch. The step launches it.

No new `ReconcileTrigger` is needed. A domain action has no way to raise one
today, and the direct launch makes one unnecessary.

**Snapshot** (`api/events.ts` `buildSnapshot`). Two new feeds, both built
from rows only:

- `queuedWorktrees: QueuedWorktreeEntry[]`. Every entry *not* currently
  launching, oldest first within a parent. This mirrors how
  `buildSnapshot` already hides worktrees that are provisioning.
- `heldWorktrees: HeldWorktreeEntry[]`. Stopped, non-spare `worktrees` rows
  that have at least one entry. This is deliberately a slimmer type than
  `StoppedWorktreeEntry`. `listStoppedWorktrees` stats transcripts to compute
  `lastActiveAt`, which is too slow for a snapshot that rebuilds on every
  change. The sidebar only needs `worktreeId, projectSlug, tool, title,
  prompt, groupId, stoppedAt, deathReason, deathDetail`.

`WorktreeListEntry` gains `permissionMode` (already on the row) so the
dialog can seed a child's defaults from a live parent without another
request. `tool`, `mode` and `model` already reach the client through
`agentSessions`.

### Routes

The routes live beside the group routes in `api/routes/worktrees.ts`. They
take and return JSON, not an NDJSON stream: nothing about queueing is slow,
and a Run now's progress shows up as a provisioning row in the snapshot.

| Route | Body | Answers |
|---|---|---|
| `POST /worktree/queue/create` | `{ project, parent, prompt, tool?, model?, mode?, permissionMode?, branch? }` | the `QueuedWorktreeEntry` |
| `POST /worktree/queue/update` | `{ id, parent?, prompt?, tool?, model?, mode?, permissionMode?, branch? }`; a field that is present replaces the stored value, and none can be null. A new `tool` sent without `model` or `permissionMode` re-resolves those for that tool, as queueing does. | the entry; 409 while launching |
| `POST /worktree/queue/discard` | `{ id }` | 204; 404 if gone, 409 while launching |
| `POST /worktree/queue/run` | `{ id }` | `{ worktreeId }` once claimed; 404 / 409 |

A queued entry needs a prompt (`min(1).max(MAX_PROMPT_LENGTH)`). An entry
with no prompt would launch an idle agent nobody is watching.

**Route matrix.** Each route gets a row in `test/api/route-matrix.ts` with
**the same answer under both drivers**: queueing is substrate-neutral, so no
`why` is needed. Against the empty matrix server:

- `create` with an unknown parent → `404`
- `update` / `discard` / `run` with an unknown id → `404`

Behavior belongs in `write-routes.test.ts`: create → update → run →
the entry is gone, and a CAS loser gets `409`.

### Permission ceiling for `yaac-mama`

An agent must not be able to hand work to something that has more
permission than it has itself. So permission modes get an order, from most
to least permissive:

```
bypass > auto > accept-edits > manual > plan
```

- **Where the order lives.** `PERMISSION_MODES` in `@yaac/shared/types` is
  reordered to this order, and the array order *is* the ranking. A new
  helper, `permissionModeWithin(mode, ceiling)`, compares indexes. The
  per-tool lists (`SUPPORTED_PERMISSION_MODES`,
  `ACP_SUPPORTED_PERMISSION_MODES`) are reordered to match; only
  opencode's list changes (`manual` moves ahead of `plan`).
- **Effects of the reorder.** Every permission dropdown and CLI help string
  now lists modes in order of permissiveness. Check each caller of the array
  for code that relied on the old order.
- **The ceiling** is the calling worktree's `worktrees.permissionMode`: the
  mode yaac launched it with, looked up from `MamaCaller.workspaceId`. A mode
  change made inside the tool afterwards, such as claude's Shift+Tab cycle,
  is not recorded and does not raise the ceiling.

The ceiling applies to `yaac-mama create` and `yaac-mama queue`. Both take
`--permission-mode <mode>`. A shared helper in `spawn-policy.ts` works out
the mode for both:

| Command | Mode when `--permission-mode` is not given |
|---|---|
| `create` | the caller's own mode. This replaces today's driver default, which could be *above* the caller's, e.g. `bypass` on k8s for a `plan`-mode caller. |
| `queue` | the **parent's** mode (the caller's own when the parent is the caller) |

Whether the mode comes from the flag or from the default, the command fails
with an error, and nothing is created or queued, when:

1. the mode is above the caller's ceiling, e.g. queueing under a `bypass`
   sibling from an `accept-edits` caller without passing a lower
   `--permission-mode`; or
2. the target tool (in its `tui`/`acp` mode) does not support the mode, e.g.
   creating a `pi` worktree (which is `bypass` only) from a claude caller
   below `bypass`, or asking opencode for `auto`.

The mode is never quietly lowered to the nearest mode the tool supports.
The error says what was asked for, what the ceiling is, and which modes the
tool offers at or below it, or that it offers none. For example:

```
pi only runs in bypass, which is above this worktree's accept-edits
```

```
opencode has no auto; pass --permission-mode accept-edits, manual or plan
```

The ceiling limits **agents only**. The webapp, the `/worktree/queue/*`
routes and `yaac worktree create` belong to the user and are unconstrained,
including when the user edits an entry an agent queued.

### `yaac-mama queue`

```
yaac-mama queue [--session <parent>] [--tool T] [--model M]
                [--permission-mode P] "<prompt>"
```

- It prints the entry id and nothing else, like `create` prints the new
  worktree id.
- The parent defaults to the caller. `--session` names another worktree in
  the caller's project, resolved the same way `rename` and `stop` resolve
  it.
- The other settings default from the parent, as described above, and the
  permission mode follows the ceiling rules above.
- `yaac-mama list` shows each entry indented under its parent, with status
  `queued` (or `failed: <launchError>`), so an agent can see what it has
  queued.

Changes needed:

- `MAMA_COMMANDS` gains `'queue'`.
- `COMMAND_ARGS` gains `queue: ['session', 'tool', 'model',
  'permission-mode']`, and `create` gains `'permission-mode'`.
- `runQueue` in `mama.ts` calls `queueWorktree(..., 'mama')`.
- `decideSpawn` passes the resolved mode through instead of leaving the
  posture to the driver default.
- The script (`worktree-bin/yaac-mama`) gains a `queue)` branch modeled on
  `create)`, and both branches gain `--permission-mode`.
- `builtin-skills/yaac-mama/SKILL.md` gains a section. The main use is "when
  you finish, a follow-up should pick up from here", paired with
  `yaac-mama stop` as the agent's last act. The skill also documents
  `--permission-mode` and the ceiling on both commands, so an agent knows to
  pass a lower mode rather than retrying the same request.

The egress proxy passes commands through without its own allowlist, so the
k8s transport needs no change. A worktree whose staged script predates the
change won't have the subcommand until it restarts, and it fails with the
script's usage error. That is acceptable, and no shim is needed.

## Frontend

### The worktree row's `…` menu

`WorktreeRow` (`WorktreeList.tsx`) has **three** hover icons today, not
four: rename (`right-14`), add to group (`right-8`), stop (`right-2`). The
blocked-hosts badge sits separately at the bottom right and stays there.

This change replaces the three icons with one `MoreIcon` trigger at
`right-2`, opening a Base UI `Menu`. The per-row pattern to copy is the
controlled menu in `WorktreeFiles.tsx`. Its items:

1. **Rename** → `startRename`
2. **Move to group…** → `GroupDialog`
3. **Queue worktree after this…** → the create dialog, with Start set to
   this worktree and the prompt focused
4. separator
5. **Stop…** → `StopWorktreeDialog`

The title's hover padding shrinks (`group-hover:pr-20` → `pr-8`) because
three icons became one. Mobile, where the actions are always visible, gains
the most room. Alt+D and the other shortcuts are unchanged. The group-header
and ghost-row icon strips are out of scope.

### One create dialog

`NewWorktreeButton`'s popover becomes a **centered modal** built like
Settings (`SettingsButton.tsx`):

- a Base UI `Dialog` with a dimmed backdrop, centered with a fixed width and
  `rounded-xl`, scaling in and out;
- full-screen below the `md` breakpoint, like Settings.

Two dialogs will share that frame, so it moves into a `components/ui/Modal`
primitive (backdrop + centered popup + the mobile full-screen rule), and
Settings is rewritten on top of it in the same change. The create dialog is
shorter than Settings' fixed 480px: it takes its content's height, up to
`calc(100vh - 4rem)`, and scrolls inside.

The dialog is mounted **once**, in `App.tsx`, and opened through the UI
store (`openCreateWorktree(opts)` / `closeCreateWorktree()`), as Settings is
opened through `openSettings()`. `NewWorktreeButton` shrinks to a trigger
that keeps its `icon` / `cta` variants and its three mount sites. The popover
is deleted rather than kept beside the dialog.

Fields, top to bottom:

| Field | Notes |
|---|---|
| **Prompt** | An autosizing textarea. Optional for `Now`, required for a queued entry. Enter submits and Shift+Enter inserts a newline, matching the chat composer (`WorktreeChat.tsx`). |
| **Start** | `Now` (the default), then `After "<title>" stops` for each of the project's live worktrees, newest first. In edit mode it also lists the entry's current parent, even when that parent is a held (stopped) worktree. |
| **Branch, Agent, Model, Permissions, UI** | Today's controls, unchanged, including the branch pin and the "tool has no credential" handling. |

**Seeding.** `Now` seeds from `useCreateDefaults`, as today. A parent seeds
from that parent's settings (above), with Branch showing the parent's
`baseBranch`, marked "latest from origin". The dialog always sends a concrete
branch and model. Changing Start re-seeds only the fields
the user hasn't touched. Changing Agent re-resolves Model and Permissions as
the popover does today.

**Submit** is labelled **Create**, **Queue** or **Save** depending on mode:

- *Create* calls `useCreateWorktree` as today, plus the prompt.
  `CreateWorktreeOptions` gains `prompt`. The server route already accepts
  it; only the webapp never sent it.
- *Queue* calls `/worktree/queue/create`.
- *Save* calls `/worktree/queue/update`. In edit mode with Start = `Now`, it
  updates and then runs.

Keeping the dialog's open state (and its mode, target and focus field) in
`useUiStore` means any of these can open it without prop threading: Alt+N,
the row menu, the queued row, and the stop dialog.

### Alt+N

`ctx.newWorktree()` in `App.tsx` changes from "create now with the last
tool's defaults" to `openCreateDialog({ focus: 'prompt' })`. The immediate
create code and its guard that the tool is configured are deleted; the
dialog already handles both. The shortcut id and label (`new-worktree`,
"New worktree") are unchanged, so rebinds persist. Alt+N then Enter behaves
like today's instant create, with one extra keystroke.

### Queued rows and held parents

`sidebarLayout` gains two inputs, `queued` and `held`, from the snapshot
(filtered to the active project like `worktreeGroups`):

- **`QueuedWorktreeRow`** renders beneath its parent's row, indented, with a
  clock glyph. It shows the prompt's first line as the title and
  `tool · model · queued` as meta, or the `launchError` in the error color.
  Clicking it opens the edit dialog. Its `…` menu has **Run now**,
  **Edit…** and **Discard…** (`ConfirmDialog`).
- **Held parents** render in their normal slot as stopped rows, reusing
  `DeletedWorktreeRow`: dimmed, with the restart action, click opens the
  stopped overlay. When the parent died, the row adds the death reason
  (`describeWorktreeDeathReason`). Its queued rows sit beneath it. The row is
  deduplicated by id against the ghost rows the stopped-list query already
  produces.
- The group-shown rule becomes `pinned || members || provisioning || held`.
- Queued rows are **not** in `sidebarRowIds`. There is nothing to show in
  the main pane for them, so Alt+J/K skips them.

`mobile/WorktreesScreen.tsx` renders the same rows and opens the same
dialogs. At phone width the create dialog is full-screen, through the shared
`Modal`'s mobile rule.

### Stop dialog

`StopWorktreeDialog` replaces both stop confirmations: the row's
`ConfirmDialog` in `WorktreeRow`, and the Alt+D one in `App.tsx`. With no
children it looks and behaves exactly as today. With children it lists them
(prompt excerpt, `tool · model`), each with:

- **Edit**, which opens the create dialog in edit mode, stacked over the
  stop dialog.
- **Discard**, which is immediate.

The confirm button reads **Stop** or **Stop and start N queued**, and keeps
initial focus so Alt+D then Enter still works.

## Wire types (`packages/shared/src/types.ts`)

```ts
export interface QueuedWorktreeEntry {
  id: string
  projectSlug: string
  parentWorktreeId: string
  prompt: string
  tool: AgentTool
  model: string
  modelName?: string
  mode: AgentMode
  permissionMode: PermissionMode
  branch: string
  createdAt: string            // 'YYYY-MM-DD HH:MM:SS' UTC, like its peers
  launchError?: string
}

export interface HeldWorktreeEntry {
  worktreeId: string
  projectSlug: string
  tool: AgentTool
  title?: string
  prompt?: string
  groupId?: string
  stoppedAt: string
  deathReason?: WorktreeDeathReason
  deathDetail?: string
}
```

- `ServerSnapshot` gains `queuedWorktrees` and `heldWorktrees`.
- `WorktreeListEntry` gains `permissionMode`.
- `MAMA_COMMANDS` gains `'queue'`.

## Tests

**`unit:server`**
- `test/db/queued-worktree-store.test.ts`: the CAS, and the guarded update
  and delete.
- `test/domain/worktrees/queued-worktrees.test.ts`: one `describe` per barrel
  function defined in the module, mocking at the process boundary. These
  cover:
  - default inheritance, including the tool-switch fallback;
  - the interrupted-launch and missed-release cases of the reconcile step;
  - a failed launch keeping the prompt;
  - `branch` and `model` always being stored concretely, including under a
    parent that is still provisioning, and under an old parent row with no
    `baseBranch`;
  - refusal when no model can be resolved;
  - children following the parent's group at launch and forking from the
    stored branch.
- `create.ts`'s tests: the row carries `baseBranch` from `worktree-created`
  onward.
- `stopWorktree`'s existing test gains the release. The reaper's test
  asserts that a death does **not** release.
- `mama.test.ts` gains `queue` and `--permission-mode`, covering the ceiling
  rules on both commands:
  - the default is the caller's mode (`create`) or the parent's (`queue`);
  - an explicit mode above the ceiling is refused;
  - a `--session` parent above the ceiling is refused;
  - a tool that lacks the mode (pi from a non-bypass caller, opencode
    `auto`) is refused;
  - nothing is created or queued on any refusal.
- A small test for `permissionModeWithin` in `packages/shared`'s tests.
- Measure coverage on the `startWorktree` refactor before deleting any route
  or `decideSpawn` test it made redundant (CLAUDE.md).

**`test/api`**
- Four matrix rows, identical in both columns.
- The `write-routes.test.ts` behavior described above.

**`test/e2e-containerless/worktree-suite.test.ts`**
- Queue a child under the suite's shared worktree, stop the parent, and see
  the child running with its prompt delivered.
- A second parent killed out-of-band (kill its tmux server, so the reaper
  records `agent-exited`) keeps its child queued and is listed as held.
  Discard that child, and the parent drops out.
- Both parents are destroyed, so these cases run last in the file.

**`test/e2e-cli/worktree-mama-suite.test.ts`** (k8s, host-only)
- `yaac-mama queue` from inside a pod, then `yaac-mama stop`, and the child
  launches. This exercises the proxy transport end to end.

**`test-playwright-scripts/`**
- A script that drives Alt+N → type → Enter.
- The row `…` → Queue flow.
- Queued-row edit and discard.
- The stop dialog with children.

No new CLI option is added (see follow-ups), so there is no new
`e2e-cli` requirement.

## Order of work

1. **Permission ceiling.** The `PERMISSION_MODES` reorder,
   `permissionModeWithin`, and `--permission-mode` plus the ceiling on
   `yaac-mama create`. This ships on its own and closes a gap that exists
   today: `yaac-mama create` uses the driver default, which can be above the
   caller's own mode.
2. **Create dialog + prompt + Alt+N.** The shared `Modal`, the create dialog
   and the new Alt+N behavior. This ships on its own: the route already
   accepts `prompt`. Start shows only `Now` until step 4 lands.
3. **Server core.** Recording `baseBranch` at row creation, the
   `startWorktree` refactor, the table and migration,
   the store, the domain module, the release in `stopWorktree`, the
   reconcile step, the snapshot feeds and the routes, plus unit and api
   tests.
4. **Frontend queueing.** The row `…` menu, Start's parent options, queued
   rows, held parents, and `StopWorktreeDialog`.
5. **`yaac-mama queue`.** Script, handler, SKILL.md, and the e2e cases.
6. **Docs.** Fold this plan into a `docs/queued-worktrees.md` reference and
   delete the plan. Update docs/layered-server.md's list of reconcile steps.
   Record the permission order and the ceiling in docs/permission-modes.md.

## Out of scope / follow-ups

- **Forking from the parent's own `agent/<id>` branch**, for "continue this
  exact work" chains. It needs the parent's commits to be reachable from the
  project clone whether or not they were pushed.

- **Chains** (queue under a queued entry). They need an entry to point at a
  parent that is itself still an entry, rewritten to the real worktree id
  when that entry launches. Today a follow-up can be queued once the middle
  link is running.
- **CLI management.** `yaac worktree create --after <worktree>` and a
  `yaac worktree queue list|run|discard` family would each need e2e
  coverage. They are left out until someone asks.
- **`yaac-mama` edit/discard** of an agent's own entries.
- The group-header and ghost-row icon strips could move to `…` menus for
  consistency.

# Isolation groundwork

## Why this plan exists

yaac's sandbox (gVisor plus egress mediation) keeps a worktree's code off the
host and off the network. It does much less to keep one worktree's code
off *another worktree's* state, or another project's, or the install's. Many
of those gaps are live bugs on a single-user install today. Under
docs/plans/multi-user-deployment.md they turn into cross-user channels, and
ownership checks enforced over them would mean nothing.

This plan fixes the gaps that need no notion of a user. It adds no
`Principal`, no owner column, and no policy. It:

- takes over the "precondition hardening" list (phase 0) of
  docs/plans/multi-user-deployment.md,
- adds four problems that plan's audit missed (workstreams 2–4 and the
  credential harvest in 3.1),
- closes [#117](https://github.com/bsklaroff/yaac/issues/117): builder pods
  can write any `repo:tag` in the shared registry (workstream 5).

Each numbered step in "Implementation order" is one change that keeps the
tree green. The workstreams are mostly independent; "Dependencies" lists
where they are not.

## Threat model

The adversary is **code running inside a sandbox**. That means an agent
under prompt injection, a malicious dependency's install script, or an
agent-authored `RUN` step in a builder pod. It holds:

- everything its mounts let it write,
- whatever its NetworkPolicies let it reach,
- whatever the server later does with bytes it wrote.

The API is out of its reach under k8s: the server's ingress policy excludes
worktree pods, and `yaac-mama` is the one sanctioned channel. The target
property:

> Nothing a sandbox does changes what a *different* worktree, a *different*
> project, or the install itself later sees, except through a channel this
> plan names as shared by design.

Two items (1.3 and 1.4) are client-side, not sandbox-side. They are here
because multi-user phase 0 listed them and they are cheap.

**Shared by design, and not changed here.** The per-user versions of these
are multi-user phase 3 work:

- the project's clone objects;
- the project's tool-home *configuration* (settings, skills, plugins). Its
  transcripts become per-worktree in docs/plans/per-worktree-agent-history.md;
- `cacheVolumes`, a per-project cache on purpose;
- the nested-container image cache inside one project (see 5.6);
- the pnpm store under `containerless`;
- the proxy's fate-sharing (CA, DNS stub, queues).

`containerless` gets correctness fixes from this plan but no isolation. Its
workspace can already write the server's files directly
(docs/containerless-driver.md).

## Relation to other plans

- **docs/plans/multi-user-deployment.md.** Its phase 0 moves here, item by
  item, in workstream 1. Two items change shape along the way:
  - forwarded ports split sensitive from infra ports (1.3);
  - `/auth/fake` refuses to overwrite a real credential instead of being
    gated on `testEnv`, because this repo's own `yaac-config.json` init
    commands depend on it (1.4).

  That plan's open question "Registry containment mechanism" is answered in
  workstream 5. The answer is write grants, not digest pinning; see 5.7 for
  why. Its phase 3 builds on the project id (workstream 4), the grant
  scopes (workstream 5), and the confined-fs helper (workstream 3).
- **docs/plans/worktree-reference-clones.md.** That plan delivers the
  read-only `/repo/.git` item from phase 0, and this plan does not repeat
  it (1.6). The two are independent in order. The explorer listing it
  moves into the workspace no longer touches the checkout from the server,
  so that call site drops out of the 3.3 table when it lands.
- **docs/plans/per-worktree-agent-history.md.** Its `history/<wt>/`
  converge step, and the server-side transcript copier in its follow-ups,
  read and write sandbox-writable trees. They must go through the 3.2
  helper, so workstream 3 lands first.

---

## Workstream 1: the phase-0 fixes

### 1.1 Resolve worktree ids exactly, in one place

**Today.** Id resolution is spread out, and most of it is fuzzy.

- **k8s `findWorktreePod`** (`drivers/k8s/substrate/pods.ts`) is
  first-match:
  `jobName === x || podName === x || worktreeId.startsWith(x)`. It has no
  empty guard and no ambiguity check, and its pod list includes prewarmed
  spares. `findWorkspaceForTeardown` (`drivers/k8s/worktrees/locate.ts`)
  repeats the pattern over Jobs.
- **containerless `findWorkspace`** (`drivers/containerless/registry.ts`)
  does refuse an ambiguous prefix. It still has no empty guard, so `''`
  resolves to the only workspace when exactly one exists.
- **`findWorktreeRow`** (`db/worktree-store.ts`) rejects `''` but is
  first-match across *all* projects.
- **`resolveSessionInProject`** (`domain/worktrees/resolve.ts`) is the one
  correct resolver. It trims, rejects empty, prefers an exact match,
  reports `ambiguous`, and excludes spares. Only `group move` and `mama`
  use it.
- **The WebSocket upgrades** in `main/server-run.ts` (`/pty/attach`,
  `/forward/attach`, `/acp/attach`) use `c.req.query('id') ?? ''`. So
  `/pty/attach?id=&target=shell` resolves to the first running pod in the
  namespace.
- **`/worktree/restart`** registers provisioning under the *raw* input,
  which may be a prefix, before it resolves the real id.
- **The create-failure teardown** (`create.ts`) looks the unit up with
  `findForTeardown(worktreeId)`, scoped to no project.

**Who sends what.**

- The SPA and the desktop forwarder always send full ids from the
  snapshot.
- The CLI sends raw user input for `attach`, `shell`, `stop`, `restart`,
  `rename` and `agents`. `forward` already pre-resolves through
  `GET /worktree/:id` and then tunnels with the full id.
- No e2e test passes a job name or container name. Short prefixes appear
  only for `mama` and `group move`.

**Design.** Prefix expansion happens once, in domain, over rows. Everything
below domain is exact.

- **Driver contract.** `find` and `findForTeardown` take an **exact
  worktree id**. Update the contract doc comments in `drivers/contract.ts`,
  which say "id, id prefix, or runtime name". The unit-name match goes too:
  names are an implementation detail, and no client sends one.
  - k8s: `findWorktreePod` becomes `pods.find(p => p.worktreeId === id)`,
    skipping spares unless the caller asks for them. The Job fallback in
    `findWorkspaceForTeardown` matches exactly as well.
  - containerless: `findWorkspace` keeps its exact `handleFor` path and
    drops the prefix branch.
- **One domain resolver.** `resolveWorktree(input, { projectSlug? })`
  lives in `domain/worktrees/resolve.ts`.
  - It generalizes `resolveSessionInProject`: trim, reject empty, exact id
    first, then a *unique* prefix over non-spare rows, and otherwise
    `not-found` or `ambiguous`.
  - With `projectSlug` it is the existing project-scoped resolver, which
    becomes a call to it.
  - `resolveWorktreeContainer`, `resolveWorktreeRecord`, `findWorktree`
    (`detail.ts`), `resolveRestartTarget` and `stopWorktree` all resolve
    through it, then hand the exact id to the driver.
  - The prefix walk in `findWorktreeRow` is deleted. Only the exact lookup
    stays.
- **The WS upgrades are exact-only.** A missing or empty `id` is a 400
  before any lookup. The `session` query of `/acp/attach` must match the
  agent-session-id charset from 3.4 before it reaches `path.join`.
  - `/pty/attach` can be exact-only once `yaac worktree attach` and
    `yaac worktree shell` pre-resolve through `GET /worktree/:id`, as
    `forward` does. That is a CLI change of a few lines.
- **`/restart`** resolves first and registers provisioning under the
  resolved id.
- **The create-failure teardown** looks up the exact id and checks that the
  unit's project matches before it destroys anything. Workstream 2 removes
  the case where it could find someone else's unit, and this check is the
  belt to that brace.
- **CLI help** for those commands changes from "Worktree ID, container
  name, or container ID" to "Worktree ID or unique prefix".

**Tests.**

- **Unit, `domain/worktrees`:** resolver cases for empty, exact-beats-prefix,
  unique prefix, ambiguous prefix, a spare's exact id (`not-found`), and
  cross-project ambiguity.
- **api:** `/pty/attach` and `/forward/attach` without an id answer 400,
  next to the existing upgrade cases in `websocket-compression.test.ts`. The
  WS upgrades live in `main/server-run.ts`, not in the Hono route table, so
  they have no route-matrix row.
- **e2e-cli:** `worktree attach <prefix>` still works, and an ambiguous
  prefix fails with the ambiguity message. Per CLAUDE.md, every CLI
  argument needs an e2e.

### 1.2 Validate `cacheVolumes` keys

**Today.** `parseProjectConfig` (`domain/projects/config.ts`) checks only
that each *value* is an absolute path. The key flows into
`cacheVolumeDir(slug, key)`, which is a `path.join`. Create then does
`mkdir -p` on the result and mounts it read-write. That allows two things:

- a key of `../../../.credentials` mounts the host credential store into
  the pod;
- a key of `a/b` puts a mount *inside* the mounted `a`, which the pod can
  replace with a link, so the next create's `mkdir -p` follows it.

**Design.**

- Keys must match `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$`. That forbids `/`,
  a leading `.`, and so also `.` and `..`.
- Values must be absolute and normalized: `path.posix.normalize(v) === v`,
  and not `/`.
- The config write routes run `parseProjectConfig`, so a bad key is refused
  when it is written.
- An overlay already holding a bad key fails the next create with the same
  message. That is acceptable: such a key is either an attack or a nested
  layout that never worked safely.

With `/` gone, `cache-volumes/` itself is never mounted, so the server's
`mkdir` there cannot be redirected. 3.3 needs nothing more for it.

**Tests.** Unit tests for `parseProjectConfig`, in its existing test file.

### 1.3 Forward-port policy covers declarations and dials

**Today.**

- `isForwardablePort` (`drivers/shared/port-policy.ts`) is applied only by
  the two port *detectors*.
- Config `portForward` is checked only for the 1–65535 range. k8s
  `declareWorktreeForwards` allocates without the policy, and containerless
  `declareForwards` is an identity map.
- The k8s `/forward/attach` dial (`dialWorkspacePort`) relays to **any**
  container port the client names, declared or not. That includes yaac's
  own in-pod infra range, 10250–10350: the stream daemon and the relay.
- The containerless dial already refuses a port that is not a detected,
  policy-filtered listener.

**Design.** The policy has two tiers, and the difference is intent.

- **Infra ports (10250–10350)** are never declarable, detectable or
  dialable. They are yaac's own control surface.
- **Sensitive ports** (22, 5432, 6379, 9229, …) stay excluded from
  *one-click detection*, their original purpose. A config `portForward` of
  5432 remains legal: forwarding a dev database is an explicit, ordinary
  thing to write in a config. Under tenancy the tunnel is gated to the
  owner (multi-user plan), and that is the right place to limit who can
  reach it.

Changes:

1. Move `port-policy.ts` from `drivers/shared` to `src/lib`. Config
   validation is in domain, which may not import `#drivers/shared`, and the
   file has no imports. Both drivers import it from `#lib`, and the
   `drivers/shared` barrel drops the re-export.
2. Add `isInfraPort`. `parseProjectConfig` refuses an infra port in
   `portForward`.
3. k8s `dialWorkspacePort` checks the port is one the worktree declared, or
   one its detector surfaced (`isForwardablePort`), before relaying. The
   declarations are already held per worktree in `forwarders`. This matches
   containerless, which already dials only detected listeners.

**Tests.**

- Unit: config refusal.
- e2e: `/forward/attach` to an undeclared, undetected port is refused. Add
  this to the forward cases in `e2e-containerless/worktree-suite`, where
  it already holds, and to the k8s forward e2e, where it is new.

### 1.4 `POST /auth/fake` never overwrites a real credential

**Today.** `POST /auth/fake` overwrites the real Claude bundle, fans
placeholders out to every project, and adds a `github.com/*` credential,
with no gate. Gating it on `testEnv` is not an option:

- `yaac auth fake` is a real CLI feature for yaac-in-yaac;
- this repo's own `yaac-config.json` init commands run it against the dev
  worktree's inner server;
- `testEnv` is a naming convention, not a gate.

**Design.** Keep the route, but make it refuse (`CONFLICT`) to write a kind
whose store already holds a **real** credential. Its only legitimate uses
start from an empty store (a fresh inner data dir, an e2e server), where it
behaves exactly as today. A real credential is recognized by the same
predicates credential-sync already uses (`isPlaceholderClaudeBundle`, and
so on); for GitHub, an entry for the same pattern whose token is not the
fake one.

- There is no `--force`. Clearing a real credential first is what
  `yaac auth clear` is for.
- `route-matrix.ts` is unchanged, since 409 is in the 4xx class and the
  matrix checks classes.

**Tests.**

- e2e-cli `auth-cli`: `auth fake` over a real `auth` entry fails, and
  succeeds after `resetCreds`.
- The existing `auth fake` cases already reset or merge. Check their order
  against the new refusal.

### 1.5 Drop the k8s `.cached-packages` mount

**Today.** Under k8s, every worktree pod still mounts the whole node-local
`projects/<slug>/.cached-packages` read-write at `/home/yaac/.cached-packages`,
but nothing current writes there:

- module dirs are per-pod `emptyDir` volumes;
- the pnpm store is pod-local (`drivers/k8s/worktrees/launch.ts`);
- what remains is the retired shared store and `modules/<id>` dirs, which
  the node-local sweep reaps (docs/legacy-compat-shims.md, "The retired pnpm
  store and module dirs").

The mount is a shared-writable channel with no remaining user. Under
containerless the directory *is* the live project pnpm store, which is
shared by design and a correctness concern only.

**Design.**

- The mount list in `createWorktree` includes `.cached-packages` only when
  `runtime.kind === 'containerless'`. That is a "whether the feature
  applies" branch, which the layering allows.
- The sweep's arms keep running for residue. Their shim entry gains one
  line: new pods no longer mount the dir, so once the removal criteria
  hold, the whole `.cached-packages` under k8s can go.
- `containerless/teardown.ts`'s `reapNodeLocal` sweep of
  `.cached-packages/modules/*` has no current writer either. Either delete
  it, or record it in the same shim entry, which today does not mention it.

**Tests.** The unit test for the pod-spec mount list (`test/domain/worktrees`)
asserts that there is no `.cached-packages` mount under k8s.

### 1.6 `/repo/.git` read-only: delivered by worktree-reference-clones

That plan makes the main clone server-owned and mounts it read-only,
closing both the pod-plants-hooks and the server-follows-links halves. Two
things from this plan interact with it:

- the checkout's `.git` stays excluded from the confined-fs `inside` root
  (3.2), as `files.ts` does today;
- once it lands, the throwaway git dir's link-following caveats in
  docs/server-git.md "What this does not cover" go away.

---

## Workstream 2: a worktree id is claimed once

**Today.**

- `POST /worktree/create` accepts a client `worktreeId` (any UUID). The SPA
  sends one for optimistic UI and re-sends the *same* id on retry after a
  failure.
- Nothing checks the id is unused. `recordWorktreeCreated`
  (`db/worktree-store.ts`) is an upsert on `(projectSlug, worktreeId)`, and
  the table's primary key is that pair, so an id is not even unique across
  projects.
- Most runtime state assumes it is unique:
  - the provisioning registry, terminating marks and `detachedTeardowns`;
  - the containerless registry and the k8s forwarders;
  - the proxy registration ConfigMap (`yaac-proxy-reg-<worktreeId>`);
  - the proxy's pod index.

Posting an existing worktree's id therefore does one of two things:

- **Same project:**
  1. the row is re-stamped;
  2. `addWorktree` fails on the existing branch;
  3. the failure path tears down the *existing* pod, deletes its checkout
     and state, and deletes its row.

  The existing worktree's uncommitted work is lost.
- **Different project:** the create succeeds. Two pods then share one
  proxy registration and one relay identity, so one runs under the other
  project's egress rules and PTY traffic can reach the wrong pod.

**Design.**

1. **The worktree id is the primary key.** In `db/schema.ts`, the
   `worktrees` key changes from `primaryKey({ columns: [projectSlug,
   worktreeId] })` to `worktreeId: text().primaryKey()`, in migration
   `worktree_id_primary_key`. The column stays `text`: every writer already
   passes a UUID, and changing the type is a separate cast for no gain.
   The constraint is named `worktrees_pkey` (renamed in
   `rename_agent_sessions_to_worktrees`), so the SQL is a
   `DROP CONSTRAINT "worktrees_pkey"` followed by `ADD PRIMARY KEY
   ("worktree_id")`. Check what drizzle-kit emits against that.
   - `projectSlug` stays a not-null column and gains its own index,
     `index().on(t.projectSlug)`, in the same migration. It replaces the
     leading-column index the composite key gave the per-project listings
     (`getProjectWorktreeRows`, the project purge's delete). Every query
     keyed on `(projectSlug, worktreeId)` keeps working unchanged, since the
     pair is still unique.
   - Nothing else names the composite key. The one reference is the upsert's
     conflict target in `recordWorktreeCreated`, which step 2 deletes.
   - The other tables that carry `(projectSlug, worktreeId)` in their keys
     (`worktree_agent_sessions`) declare no foreign key, and are left alone.
   - No existing install can hold a duplicate id without having been
     attacked this way. If one does, the migration fails loudly on start,
     which is the right outcome.
2. **Nothing upserts.** `recordWorktreeCreated` splits on the event's
   `resume` flag, which `applyCreated` already has.
   - A fresh create, prewarm or spawn does a plain `INSERT`. A unique
     violation becomes `ServerError('CONFLICT', …)`.
   - A resume does an `UPDATE` of the live fields, keyed on
     `(projectSlug, worktreeId)`, and must match exactly one row, or it
     throws `NOT_FOUND`.
   - A claim is untouched: `claimSpareWorktree` is already an `UPDATE` of
     the spare's own row.

   Why a resume never needs to insert: a non-spare row is deleted in only
   two places, a failed *fresh* create (`applyCreateFailed`) and project
   removal, and a stopped worktree keeps its row. So a restartable worktree
   always has a row, with one exception. `resolveRestartTarget` can find a
   live pod whose row is missing, which happens only when the database lost
   rows the substrate still holds (a reset or restored DB). Today's upsert
   quietly mints a new row for such a pod, with the wrong `createdAt`. After
   this change that restart fails with `NOT_FOUND`, which is the right
   answer for a pod yaac has no record of. The failure path already
   restores a failed resume's previous stop (`priorStops`), so nothing else
   needs changing.
3. **The create owns only what it inserted.** The `worktree-created` event
   is applied before any disk or substrate action (create.ts, ahead of the
   checkout `mkdir`). An `owned` flag is set only after the insert
   succeeds. The failure path's rollback runs only when `owned` is true,
   which covers teardown, `deleteWorktreeState` and `applyCreateFailed`.
   A conflict unwinds nothing, because nothing was done.
4. **The provisioning registry refuses a live duplicate.**
   `registerProvisioning` keeps "a re-register on one id is the retry", but
   only when the existing entry is in a *failed* state. A running entry
   with the same id is `CONFLICT`. This preserves the SPA's retry, whose
   failed create has already deleted its row via `applyCreateFailed`.
5. **Restart resolves exactly.** It finds its row through the exact
   resolver (1.1), so no fuzzy input reaches `resume`.

**Tests.**

- **Unit `test/db`**, through `applyWorktreeEvent`:
  - a fresh create on an existing id, in the same project or another,
    throws the conflict and leaves the existing row as it was;
  - a resume re-stamps the live fields and keeps `createdAt`, title and
    group;
  - a resume with no row throws.
- **api `write-routes.test.ts`:** a create reusing a live worktree's id
  answers 409. The live worktree's row, checkout and pod are untouched;
  under the containerless column, its tmux handle is still up.
- **e2e `worktree-create-suite`:** the SPA-style retry (same id after a
  forced failure) still succeeds.

---

## Workstream 3: server I/O on sandbox-writable paths

Under k8s these roots are mounted read-write into every worktree pod of a
project:

- the checkout,
- the tool homes `claude/`, `codex/`, `pi/` and `opencode-config/`,
- `acp/<worktreeId>/`,
- the opencode dirs,
- cache volumes.

A pod can replace any leaf, or any directory *below* a mount root, with a
symlink or a FIFO. It cannot replace the mount root itself. About 40 server
calls read, write, list or delete under those roots, and about 20 follow
links. The worst is not a link at all.

### 3.1 Never adopt a credential from a mediated sandbox (fix first)

**Today.** `harvestClaude` and `harvestCodex` (`domain/auth/credential-sync.ts`):

1. read each project's `claude/.credentials.json` and `codex/auth.json`;
2. skip placeholders;
3. adopt any bundle that looks newer into the **host credential store**,
   from which the proxy injects for every worktree of every project.

They run from `stopWorktree` on every stop, and from `syncToolCredentials`
on the standing reconcile sweep, on both drivers. The module's comment
assumes that "under a mediated runtime … the harvest half finds nothing".

That holds only while pods behave. A pod that writes a non-placeholder
bundle with a later `expiresAt` into its tool home gets it adopted
install-wide:

- the install's Claude or Codex account is replaced by one the attacker
  chose;
- or it is replaced by garbage, which is a denial of service for every
  worktree.

**Design.** Under a mediated runtime the proxy is the only refresh writer
(docs/worktree-egress.md), so there is nothing legitimate to harvest.

- `harvestToolCredentials`, and the two harvest calls inside
  `syncToolCredentials`, return immediately when `runtimeMediatesEgress()`.
- `syncToolCredentials` then does nothing at all under k8s, which its
  comment already says is the effect.
- `stopWorktree` keeps its call, since containerless needs it.
- `seedProjectToolHome` already writes placeholders without reading under
  mediated egress.

**Tests.** Unit tests in `test/domain/auth/credential-sync.test.ts`, through
`harvestToolCredentials`:

- a mediated driver plus a newer real-looking bundle in a project home
  leaves the host store unchanged;
- a containerless driver still adopts.

### 3.2 One confined-fs helper

`domain/worktrees/files.ts` already implements the right discipline for the
checkout. It:

- pins the root by realpath;
- walks segment by segment through `/proc/self/fd/<fd>/<name>` as an
  `openat` stand-in;
- opens each directory with `O_DIRECTORY` and checks where the descriptor
  landed, because gVisor follows a link despite `O_NOFOLLOW` when
  `O_DIRECTORY` is set;
- opens leaves with `O_NONBLOCK|O_NOCTTY`, so a FIFO cannot hang it;
- creates with `O_CREAT|O_EXCL|O_NOFOLLOW`;
- deletes by fd-walk;
- falls back to realpath checks where `/proc/self/fd` does not exist
  (macOS containerless).

`domain/git/run.ts`'s `readOnce` is the leaf-only version, for
`.git/config`: `O_NOFOLLOW`, `fstat` is-a-file, and a size cap.

**Design.** Lift that into `src/lib/confined-fs.ts`. It must live in `#lib`
because `runtime/agents` needs it and cannot import domain. It exposes one
type:

```ts
type LinkPolicy =
  | 'inside'    // links allowed if they land inside the root (the checkout)
  | 'no-links'  // no link anywhere below the root (tool homes, acp logs)

interface ConfinedRoot {
  open(rel: string, flags: number): Promise<FileHandle> // + O_NONBLOCK|O_NOCTTY, regular-file check
  readFile(rel: string, opts: { maxBytes: number }): Promise<Buffer | null>
  readdir(rel: string): Promise<Dirent[]>
  stat(rel: string): Promise<Stats | null>
  writeAtomic(rel: string, data: string | Buffer): Promise<void> // O_EXCL|O_NOFOLLOW tmp in pinned parent, rename
  mkdirp(rel: string): Promise<void>
  removeTree(rel: string): Promise<void>
}
function openRoot(root: string, policy: LinkPolicy, opts?: { exclude?: string[] }): Promise<ConfinedRoot>
```

- **`files.ts` becomes a client**, with `openRoot(checkout, 'inside',
  { exclude: ['.git'] })`. Its routes, error mapping and version hashing
  stay where they are.
- **Relative names are checked lexically first:** no NUL, not absolute, no
  `..`. The existing `checkPath` moves into the helper.
- **The policy is applied, not guessed.** Under containerless there is no
  sandbox boundary, and yaac itself plants links in the tool homes: the
  per-worktree history links, and builtin skills linked into the install.
  So the tool-home callers pick `no-links` under a mediated runtime and
  `inside` rooted at the project dir otherwise. That choice is one exported
  function, `sandboxLinkPolicy()`, next to the other tool-home locators in
  `runtime/agents`, and every call site in 3.3 uses it. It is the only
  driver-kind branch this workstream adds, and it decides only *whether*
  confinement applies.

**Tests.** None directly, because it is an internal module of `#lib`.
Coverage comes through `files.ts`, whose test suite already covers
link-out cases for the checkout (add a FIFO case there), and through the
3.3 call sites' own tests. Add the `no-links` cases to the transcript and
seed tests below.

### 3.3 Call sites

Grouped by what goes wrong today. "Follows" means plain path I/O.

| Group | Calls | Today | Change |
|---|---|---|---|
| **Seeding writes into `claude/`** | `seedClaudeSettings`, `seedClaudeJson`, `adoptLegacyClaudeJson` (`domain/worktrees/seed.ts`); `ensureClaudeHooks` (`runtime/agents/claude.ts`) | `readFile` then a plain `writeFile` follow links. A planted `settings.json` link makes every create rewrite the target; a target that is not JSON is replaced by a small object, so the database file or another project's config can be clobbered. `ensureClaudeHooks` reads through the link and renames its output over it, copying the target's content into the pod's view. | `openRoot(claudeDir, sandboxLinkPolicy())`, `readFile` with a 1 MiB cap, `writeAtomic`. A link or FIFO in place of the file reads as missing, and the write replaces the link, never its target. |
| **Transcript and log readers** | `findClaudeTranscript`, `listPiJsonlFiles`, `transcriptStamp`, `transcriptLastActiveMs` (`runtime/agents/transcripts.ts`); `scanJsonlForward` / `scanJsonlBackward` (`jsonl.ts`); `readAcpLog*`, `tailAcpLog`, `readAcpFirstPrompt` (`acp-log.ts`); `readClaudeTranscriptAsAcp`; `getAgentSessionTranscript` (`domain/worktrees/transcript.ts`); the discovery sweep, `model-capture`, `stopped-list` and `detail` readers | Follow links, so a conversation view can render another project's transcript. Plain `open(… 'r')` blocks on a FIFO: a few planted FIFOs exhaust libuv's four-thread pool and stall every fs call in the server. The forward scan is unbounded. | Readers take a `FileHandle` from the tool's own root (`claude/`, `codex/`, `pi/`, `acp/<wt>/`), never `projectDir`. `transcript.ts`'s 64 MiB cap moves into the `open` / `readFile` call, where the stat-then-read race cannot bypass it. |
| **Recorded transcript paths** | `resolveProjectPath` / `toProjectRelative` (`runtime/agents/transcripts.ts`) | Confined only to `projectDir`, by text. A hook line can name `known_hosts`, `repo/.git/config` or another worktree's files. | Resolve against the recording tool's own root, and refuse otherwise. Stored `agent_sessions.transcriptPath` values are project-relative and already live under a tool home, so existing rows stay valid. |
| **Skills discovery** | `subdirs`, `fsReader`, the plugin readers (`domain/skills/discover.ts`); `reconcileSharedSkillRoots` (`domain/skills/builtin.ts`) | `SKILL.md` is read through links (a link named `SKILL.md` exposes any server file through the skills API). Linked subdirs are accepted on purpose. The root `mkdir` / `rm` follows links. | Under a mediated runtime, `no-links` roots per tool skills dir and plugin dir, and `SKILL.md` capped at 256 KiB. Under containerless, `inside` rooted at the project dir: its skill links point into the install and the history dirs, and it has no boundary to defend. `reconcileSharedSkillRoots`'s per-entry `lstat` / `rm` / `symlink` run through the pinned root. |
| **Checkout housekeeping** | `mkdirMountTarget` (`seed.ts`); `checkoutEphemeralPaths` (`domain/worktrees/cleanup.ts`) | Bespoke realpath-after-mkdir; a check-then-use race. | `openRoot(checkout, 'inside').mkdirp` / `.removeTree`. `mkdirMountTarget` is deleted. |
| **Whole-tree deletes** | `deleteWorktreeState`, `project-purge.ts` | Node's `rm -rf` does not follow links. Both run with no live pod (`podGone` gate; project purge follows teardown). | No change. Add an assertion comment naming the `podGone` precondition. |
| **Credential bundles in tool homes** | `readProjectClaudeBundle` / `readProjectCodexBundle`, `writeProject*` (`shared/tool-auth.ts`) | Writes use a random tmp name and rename, so they are safe. Reads follow links but, after 3.1, never run under a mediated runtime. | None. |

Not in scope, because the sandbox cannot write it:

- `worktreeStateDir` staging (builtin skills and the worktree bin) is
  server-written and mounted read-only.
- The session-starts log is a `File` mount inside a server-only `meta/`,
  so the pod cannot swap the inode. Its *contents* are covered by 3.4.
- `drivers/k8s/worktrees/changes.ts` runs git inside the pod.

### 3.4 Ids that come from the sandbox

- **Session-starts `id`** is `z.string().min(1)` and is later joined into
  `acp/<wt>/${id}.jsonl` and `claude/projects/*/${id}.jsonl`.
- **`adoptLog`** (`runtime/agents/acp-driver.ts`) renames to the ACP
  agent's reply `sessionId`, unchecked.
- **`/acp/attach`'s `session` query** is covered in 1.1.

All three are checked against one exported schema, `agentSessionIdSchema =
/^[A-Za-z0-9_-]{1,128}$/`, before any path is built. The pinned tools'
formats have to be checked before this lands (see Verification). A line
that fails the check is dropped, not recorded.

**Tests for 3.3 and 3.4.** Unit tests, placed per the sealed-folder rule in
the file of the barrel function each path runs through:

- `seedProjectToolHome` / create seeding, with `settings.json` as a link
  out of the root (the target is untouched and the link is replaced);
- `getAgentSessionTranscript` with a linked transcript (not found) and a
  FIFO (not found, returns promptly);
- skills listing with a linked `SKILL.md`;
- session-starts ingestion with an id containing `../`.

---

## Workstream 4: projects get an immutable id

**Today.** A project's only identity is its slug: the remote's last path
segment, lowercased (`domain/projects/add.ts`). Two remotes named `app` get
the same slug, and removing one frees the slug for the other. Removal
clears every DB table, but the state *outside* the DB is named by slug and
cleaned up best-effort:

- **Registry build cache.** `yaac-buildcache-<slug>` in the main registry
  is never removed, only aged out after 168h. A same-slug project's builds
  `--cache-from` it.
- **Per-project registry.** It is named
  `yaac-reg-<slug≤21>-<hash(dataDir/slug)>`, which is deterministic from
  the slug, and its PVC is named after it. If removal fails,
  `gcOrphanProjectRegistries` sweeps it only when `projectDir(slug)` does
  not exist. A re-add before that sweep inherits the old registry, its
  data, and a policy admitting the new project's pods.
- **Node-local stores.** `removeNodeLocalProject` runs one pod per node,
  swallows failures, and returns silently if the builder image is missing.
  The node-local sweep never removes a whole `projects/<slug>` or
  `shared-images/<slug>`. A node that missed the cleanup keeps the old
  image-store generations, and the new project's first generation there is
  seeded from them with `cp -al`.
- **Minor residue:**
  - in-memory throttle maps keyed by slug (`lastRefreshMs`,
    `lastRegistryGcMs`, prewarm);
  - the macOS Keychain item for `claudeDir(slug)` (containerless);
  - the proxy's `git-auth-failures` record.
- **Labels.** The raw slug goes into the `yaac.project` label with no
  charset or length check, so a slug over 63 characters, or containing `+`
  or `%`, breaks label writes today.

**Design.** Each project row gets a UUID that never changes and is never
reused. Every per-project object *outside the data dir* is named by it, so
a new project cannot inherit an old one's objects by construction, whether
or not cleanup succeeded. The data dir (`projects/<slug>/`) keeps the slug:
it is removed synchronously and reliably, it is user-visible, and renaming
it is a migration with no payoff.

1. **Schema.** `projects.id uuid not null unique default
   gen_random_uuid()`, in migration `add_project_id`. The backfill is the
   column default. `slug` stays the primary key and every
   `projectSlug`-keyed table is unchanged, since rows were never the leak.
   `recordProject` returns the id.
2. **`project.json` carries the id.** `adoptProjectDirs` adopts it when
   present and otherwise mints one and writes it back, so a restored or
   copied project dir keeps its identity. That shim entry (it is
   deliberately not one-shot) gains a sentence.
3. **The id reaches the substrate as data.** Drivers never look it up. The
   launch intent, `ensureProjectRegistry`, `destroyProjectSubstrate`, the
   store writer, the builder pod and the image-tag builders take a
   `ProjectRef { slug, id }` where they take a slug today. The slug stays
   for display, labels and log lines.
4. **Names built from the id.**

   | Object | Today | After |
   |---|---|---|
   | Per-project registry (Service, Deployment, PVC, NetworkPolicies, pods) | `yaac-reg-<slug≤21>-<hash8>` | `yaac-reg-<id>`. At 45 characters it fits every derived name within 63; the `-hosts-` / `-cleanup-` / `-gc-` pods are subdomain names, limited to 253. The install hash goes: a UUID cannot collide across installs sharing a cluster. |
   | Registry repos | `yaac-user-<slug>`, `yaac-buildcache-<slug>`, project layer in `yaac-base` | `yaac-user-<id>`, `yaac-buildcache-<id>`, `yaac-proj-<id>` (workstream 5 needs these per-project names) |
   | Node-local project tree | `node-local/projects/<slug>/`, `shared-images/<slug>/` | `node-local/projects/<id>/`, `shared-images/<id>/`. The global `projects/<slug>/` is unchanged. |
   | In-memory per-project maps | slug | id |
   | Labels | `yaac.project=<raw slug>` | unchanged key and value, plus `yaac.project-id=<id>` on registry-owned objects so the GCs select by id |

5. **Slug hygiene.** `addProject` sanitizes the derived slug to a valid
   label value: `[a-z0-9._-]`, alphanumeric at both ends, at most 63
   characters. It does not refuse. This changes the slug only for names
   that break label writes today.
6. **Garbage collection keys on ids, not directories.** Each of these is
   permanent (it also covers every failed removal), not a shim:
   - `gcOrphanProjectRegistries` removes registry objects whose
     `yaac.project-id` is not a live project id, and objects with no id
     label at all.
   - The node-local sweep (`buildNodeLocalSweepScript`) is handed the live
     project-id set, as it is already handed the live worktree set. It
     removes any `projects/<x>` or `shared-images/<x>` whose `x` is not in
     it, except a path any live pod mounts. That set is already read from
     pod specs.
   - The main-registry build-cache GC (`images/build-cache-gc.ts`), which
     already works on the registry's storage from a pod, also deletes
     `yaac-{user,proj,buildcache}-<x>` repo dirs whose `x` is not a live
     id, before its `garbage-collect`.
   - `removeProject` drops the Keychain item. The `git-auth-failures`
     record is re-keyed per (project, owner) in multi-user phase 3 and is
     left alone here: it is a badge, not a capability.

**Upgrade cost, stated plainly.** Existing projects get a fresh id on
migration, so their id-named objects start empty:

- one cold nested-image cache per nested project;
- one image rebuild per project with a custom layer, because the repo names
  change;
- one cold pnpm store per project under containerless.

The old slug-named objects carry no id label, or sit in no live id's path,
so the permanent GCs above reap them. The running pods that still mount an
old node-local path are protected by the live-mount check. No shim entry
is needed.

**Tests.**

- **Unit `test/db`:** project id minted and stable across
  `adoptProjectDirs`.
- **Unit `test/drivers/k8s/cluster`:** registry names built from the id,
  with every derived name at most 63 characters.
- **Unit `node-local-sweep`:** the script keeps live ids and live-mounted
  paths and removes the rest.
- **e2e (k8s):** remove a nested project, re-add the same URL, and assert
  that the new registry's catalog is empty and a different registry
  Service backs it.

---

## Workstream 5: registry write grants (closes #117)

### 5.1 Problem

The main registry (`yaac-registry`, in the default namespace, shared by
every install and e2e run on the cluster) is plain `registry:2`: no auth,
mutable tags, no path ACLs. Builder pods must reach it, and they run
agent-authored `RUN` steps as root in a chroot, so **any build can write
any `repo:tag`** (docs/trust-split-builds.md, "Open risk"). The reachable
blast radius:

- **The trusted chain.** `yaac-base` / `yaac-tools` / `yaac-nestable`
  content-hash tags, which every worktree boots.
- **Every pinned upstream reached through a mirror tag.** `podman-stable`
  runs the root, hostNetwork store-writer pods. `curlimages/curl` runs the
  **privileged, hostPID** gVisor installer. Also affected: `envoy` (netd
  and server fronting), `verdaccio`, `yaac-registry2` for the per-project
  registries, the proxy, netd, and `yaac-server`, the server Deployment
  itself. The digest in a mirror tag's *name* is a label that nothing
  checks. So a `RUN` step can plant an image that a privileged node pod
  later boots.
- **Other projects' final images and build caches.** `--cache-from
  yaac-buildcache-<slug>` has, in builder-pod.ts's own words, "no
  provenance check".

Pods consume bare tags with `IfNotPresent`. A warm node is shielded until
kubelet image GC evicts the tag; builders pull parents fresh on every
build. Since #116, "no yaac code path publishes new bytes under an existing
tag" is the only integrity guarantee, and builder writes are the path
around it.

### 5.2 Design: writes need a grant; reads stay anonymous

Put a **write gate** in front of the main registry, inside its own pod.
`GET` and `HEAD` pass through untouched. Every write (`POST`, `PUT`,
`PATCH`, `DELETE`) must carry a **grant**: a statement signed by the
install's grant key, naming the repositories it may write and an expiry.

- A builder is handed a grant for **its own project's repositories only**.
- The trusted writers (the host installer, the server's host pushes, the
  e2e global setup) hold a grant for everything.

Reads stay anonymous, so node containerd, kubelet, the store writer and
builder parent pulls need no credentials and no change. That is also what
keeps the bootstrap simple (5.5).

This is the fix the issue and the trust-split doc name: "a push-side proxy
that mints per-build, repo-scoped credentials". 5.7 covers why it is
preferred to the alternatives.

**The repository layout makes the scopes expressible.** Today the
*untrusted* project layer is tagged `yaac-base:<projectHash>`, in the same
repo as the trusted base (`image-builder.ts`). No repo-scoped grant can
separate the two. Workstream 4 moves it to `yaac-proj-<id>`, so:

| Repo | Written by | Grant |
|---|---|---|
| `yaac-base`, `yaac-tools`, `yaac-nestable`, every mirror, `yaac-netd`, the proxy, `yaac-server`, `yaac-cluster-probe` | host installer, server host pushes, e2e setup | `admin` (`*`) |
| `yaac-proj-<id>`, `yaac-user-<id>`, `yaac-buildcache-<id>` | that project's builder pods | `project:<id>` |

Project layers whose contexts happen to be identical no longer share one
tag across projects. That cost is small and wanted: a shared tag across
projects was a cross-project write channel.

### 5.3 The gate

- **Topology.** The registry Deployment gains an Envoy container on `:5000`,
  so the Service, the `hosts.toml` entries and every client address stay
  as they are. `registry:2` moves to `127.0.0.1:5001`
  (`REGISTRY_HTTP_ADDR`), reachable only from inside the pod. Envoy is
  already a pinned yaac dependency (netd's redirect sidecar, the server
  fronting). The registry-GC pods work on the PVC directly and are
  unaffected.
- **Logic.** An Envoy Lua filter, about 60 lines, in a ConfigMap:
  1. If the method is `GET` or `HEAD` and the path is not exactly `/v2/`,
     pass.
  2. If the path is `/v2/` and there is no `Authorization` header, answer
     `401` with `WWW-Authenticate: Basic realm="yaac-registry"`, so that
     podman offers `--creds` / authfile credentials. For the effect on
     anonymous clients, see Verification.
  3. For a write, decode `Authorization: Basic`. The password is
     `base64url(payload).base64url(signature)`, with payload
     `v1|<expiry unix s>|<scope>`, where scope is `*` or `project:<id>`.
  4. Verify the signature with `verifySignature` against the grant public
     key (inline in the ConfigMap), and check the expiry.
  5. Take the repository from the path (`/v2/<repo>/blobs/…` or
     `/v2/<repo>/manifests/…`) and require it to be in scope. `project:<id>`
     covers exactly the three repos in 5.2.
  6. Answer `401` (bad or missing grant) or `403` (out of scope).
  7. `DELETE` is refused for every grant. The main registry has deletes
     disabled anyway, and GC works on storage.

  A cross-repo blob mount (`POST /v2/<dst>/blobs/uploads/?mount=…&from=<src>`)
  is checked against `<dst>` only. The source is readable anonymously
  already.
- **The gate holds only the public key.** Compromising the registry pod
  mints nothing, and the pod was already all of the registry.

### 5.4 Grants

- **Key.** An ECDSA P-256 keypair (or RSA-2048, whichever `verifySignature`
  accepts; see Verification). `yaac cluster install` generates it once per
  cluster, if absent, as Secret `yaac-registry-grant-key` in the
  registry's namespace, next to the registry it guards. Every install on
  the cluster shares it, as they share the registry. Install copies the
  private key into its own namespace's Secret for the server Deployment to
  mount, and renders the public key into the gate's ConfigMap.
- **Minting.** `mintRegistryGrant(scope, ttl)` lives in `#drivers/k8s/image-engine`,
  the host half, so install can mint without a cluster import cycle.
  - **Admin grants** are minted per push session with a 1-hour expiry by
    whoever holds the key: the server for `pushImageToRegistry`, install
    for the builtin images, and `test/global-setup.ts`, which reads the
    Secret through the kubeconfig it already uses.
  - **Builder grants** are minted by the server per build, scoped
    `project:<id>`, and expire when the build's own deadline passes, plus
    a minute. The builder pod receives the grant as an authfile in a
    per-build Secret volume, deleted with the pod. The build's `RUN`
    steps may be able to read it (a root chroot is not a boundary), and
    that is acceptable: the grant writes only the project's own repos,
    which that project's Dockerfile already controls.
- **Clients.**
  - `builderBuildArgs` / `builderPushScript` (`images/builder-pod.ts`)
    pass `--authfile` to `podman build`, for `--cache-to`, and to
    `podman push`.
  - `pushImageToRegistry` (host podman) passes `--creds`.
  - `registryHasTag` is a `HEAD` and needs nothing.
  - Nothing that pulls changes.

### 5.5 Bootstrap and rollout

- **The gate's image is the upstream digest ref**
  (`envoyproxy/envoy@<ENVOY_PIN>`), not the mirror tag, for the same
  reason the registry's own image already is (`main-registry.ts`): the
  registry cannot serve the images it needs to start. Nodes already fetch
  the registry image from upstream once at install. This adds one more
  (~50 MB) fetch, which `IfNotPresent` then keeps offline.
- **Install order.** Generate the key, apply the gate ConfigMap and the
  Deployment, then push the builtin images with an admin grant.
- **Rollout on an existing cluster.** Re-running `yaac cluster install`
  rolls the registry Deployment. It is `Recreate`, so pulls fail for the
  few seconds that takes, as on any registry rollout today. A build in
  flight during the roll fails its push, and it is retried as any failed
  build is. Builders started by an older server push without a grant and
  are refused, which is the point. No compatibility window is needed:
  every writer is either upgraded in the same install or refused.

### 5.6 The nested image cache: what this plan does and does not do

The per-project registries carry the nested-container image cache. They
are **written from inside worktree sandboxes** (salvage runs in-pod) and
read by every nested worktree of the project, through the node image
store. That is a project-shared namespace by design: any worktree of a
project can name an image, including an upstream name like
`docker.io/library/postgres:16` or a short name, that every later nested
worktree of the project resolves locally.

There is no trusted production point to pin a digest to, and no grant to
scope, because the writer *is* the sandbox.

- **Across projects** it is already closed: the NetworkPolicies are keyed
  per project, and the node store is per project.
- **Workstream 4** closes inheritance across a removal: registry and store
  are named by id.
- **Across users within one project** it is multi-user phase 3 work. The
  registry's name and the store's path are then derived from (project id,
  owner) rather than the project id: a one-line change to the key once
  workstream 4 has put a key there. That plan's audit should list this
  surface next to the tool homes, and its "different feature" dismissal of
  the per-project registries is corrected there in the same change as this
  plan.

### 5.7 Alternatives considered

- **Digest pinning alone** (the multi-user plan's lean, and #113's
  unlanded `registryDigestRef`).
  - Pinning consumption to a digest makes a substituted tag unrunnable,
    but only if the digest was recorded at a trusted point. #113 resolved
    it at launch by `HEAD`ing the mutable tag: a time-of-check/time-of-use
    gap that pins whatever the tag holds at that moment.
  - It never covers the build cache. A poisoned `--cache-from` entry
    becomes a cache hit for a `RUN` step at *build* time, and the digest
    then recorded is the poisoned image's.
  - So it does not close #117, and with grants in place it adds little. It
    remains the right fix if yaac ever re-pushes a tag deliberately (#108's
    staleness class). That is not in scope here.
- **Registry-native token auth (`auth: token`).** It needs a realm service
  that answers anonymous requests too, since containerd pulls
  anonymously. That service must mint a token per requested repo, because
  distribution's access claims name repos exactly, with no wildcards, so
  the realm must hold the private key. It must also be reachable from the
  node's network namespace by IP, and be up before the registry can serve
  its own image. That is more moving parts than a write-only gate, for the
  same scopes.
- **One registry per trust level** (builders write only their project's
  registry and read the trusted chain from a read-only replica). It fits
  the per-project-registry pattern, but costs:
  - a registry and PVC for every project with a custom layer;
  - a second `registry:2` in read-only mode on a shared RWO PVC, which
    ties it to one node;
  - moving every consumer's image host.
  All for the same outcome.

### 5.8 Tests

- **Unit `test/drivers/k8s/image-engine`:** `mintRegistryGrant` round-trips
  with a verifier written to the same wire format. The Lua itself is
  exercised only in e2e.
- **e2e (k8s, host-only), in the registry-touching suite's `beforeAll`
  fixture:**
  - An anonymous `GET /v2/_catalog` and a manifest `HEAD` succeed.
  - A push with a `project:<a>` grant to `yaac-user-<a>` succeeds.
  - The same grant is refused (403) for `yaac-user-<b>`, `yaac-base` and a
    mirror repo.
  - An expired grant and a missing grant are refused (401).
  - A real nested-project create still builds and boots, which covers the
    builder authfile path end to end.
- **`cluster check`** gains a probe: an anonymous push to a scratch repo is
  refused. Without it, a registry rolled by an older install silently
  reverts to an open one.
- **Docs.** docs/trust-split-builds.md: the "Open risk" section is replaced
  by the gate's description, and its stale text about the registry's
  port-forward is corrected while it is being edited.

---

## Implementation order

Each numbered step is one reviewable change.

1. **3.1 harvest gate.** A few lines, and the most severe finding.
2. **Workstream 2.** Unique index, insert-only create, owned rollback,
   provisioning conflict.
3. **1.1 exact resolution**, including the CLI pre-resolve for
   `attach` / `shell`.
4. **1.2–1.5.** Four independent small changes, in any order.
5. **3.2 helper, then 3.3 / 3.4 call sites**, one group per change,
   starting with the seeding writes.
6. **Workstream 4.** Schema and `project.json`, then the `ProjectRef`
   plumbing and names, then the id-keyed GCs.
7. **Workstream 5.** Repo layout (`yaac-proj-<id>`), then key and minting,
   then the gate and client authfiles in one change, since a gate without
   clients breaks every build.

worktree-reference-clones proceeds independently. per-worktree-agent-history
starts after step 5.

## Dependencies

- **5 needs 4.** Grant scopes (`project:<id>`) and the per-project repo
  names come from the project id. Scoping by slug would close the
  cross-project writes, but a re-added slug would then inherit the old
  project's repos and write rights, and moving off slugs later means a
  second rename and rebuild.
- **1.1 and 3.4** share `agentSessionIdSchema`, for the `/acp/attach`
  `session` query. Whichever lands first defines it.
- **3.3 relies on 1.2** to leave `cache-volumes/` out of the call-site
  table: a key without `/` means no mount sits under a server `mkdir`.
  Until 1.2 lands, that mkdir is exposed.
- **1.1 and 2 back each other up.** Neither needs the other to be correct.
  2's owned rollback makes 1.1's project check in the create-failure
  teardown redundant, and 1.1's exact resolver keeps fuzzy input away from
  2's resume `UPDATE`.
- **1.5 before 4** saves re-keying a mount that is about to go. After 4,
  its id-keyed node-local sweep also removes the retired `.cached-packages`
  store and module dirs, so the two legacy arms for them can be deleted
  (see below).
- **2 and 4** each add a migration and both edit `create.ts`. That is a
  merge-order concern only.
- **3.1** stands alone.

## Legacy-compat entries (docs/legacy-compat-shims.md)

- **"The retired pnpm store and module dirs"** gains: new k8s pods no
  longer mount `.cached-packages` (1.5). The containerless
  `reapNodeLocal` `.cached-packages/modules/*` arm is added to the entry,
  or deleted with 1.5. When workstream 4 ships, the entry's two sweep arms
  are deleted. The id-keyed node-local sweep removes whole slug-named
  project dirs that no live pod mounts. It must spare those a live pod
  still mounts, and that is the older-server case the pnpm-store arm's
  idle wait exists for.
- **"`adoptProjectDirs`"** gains: it adopts or mints the project id from
  `project.json`.
- Nothing else. The id-keyed GCs in workstream 4 are permanent, because
  they sweep failed removals as well as pre-upgrade names. The registry
  gate has no compatibility window (5.5).

## Docs to update on ship

- **docs/trust-split-builds.md:** the gate and grants (workstream 5).
- **docs/nested-containers.md:** registry names and node-store paths by
  project id; the project-shared-namespace statement from 5.6.
- **docs/worktree-storage.md:** the node-local tree keyed by project id;
  no `.cached-packages` mount under k8s.
- **docs/server-git.md:** once worktree-reference-clones lands, not
  before.
- **docs/plans/multi-user-deployment.md:**
  - phase 0 becomes a pointer to this plan;
  - its registry-containment open question is answered;
  - its per-project-registry dismissal is corrected (5.6);
  - its phase 3 names the (project, owner) keys that workstreams 4 and 5
    leave room for.

  Do this in the first change of this plan, so the two plans never
  disagree.
- **This plan is deleted when its last workstream ships.** Anything still
  worth keeping moves into the docs above.

## Verification before building

Check each of these against the pinned binaries, not web docs, before the
change that depends on it:

- **Envoy Lua (pinned `ENVOY_PIN`):** `verifySignature` accepts the chosen
  key type, and base64 decoding of the `Basic` header is available or
  small enough to inline.
- **podman / buildah (pinned `podman-stable:v5.5` and the host's):**
  - with `/v2/` answering a `Basic` challenge, `--creds` / `--authfile`
    credentials are sent on writes;
  - `--cache-to` honors `--authfile`;
  - an anonymous `podman pull` still succeeds.
- **containerd (kind's):** a pull resolves manifests and blobs without ever
  requesting `/v2/`, so the anonymous challenge there never fails a node
  pull. If it does request it, the gate answers 200 to anonymous `/v2/`,
  and podman is given credentials preemptively through its authfile
  (verify it sends them unprompted).
- **Agent session id formats** for claude, codex, pi and opencode's ACP
  ids, against `^[A-Za-z0-9_-]{1,128}$` (3.4).
- **`gen_random_uuid()`** under the pinned PGlite, for the `add_project_id`
  default (4).

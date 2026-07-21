# Server package refactor — Pass 2: split giants, merge tiny, cut redirection

## Context

Pass 1 (done, merged) moved `packages/server` into feature verticals with pure
`git mv` — no file's internals changed. That left three things Pass 1
deliberately deferred, which this pass addresses:

1. **A few monster files** are now sitting in otherwise-tidy folders:
   `features/sessions/create.ts` (1737), `features/cluster/bootstrap.ts`
   (1294), `main/cli.ts` (774), `features/sessions/list.ts` (715). They mix
   several concerns and are hard to navigate.
2. **Over-split tiny files** add file-count and import hops with no benefit:
   five ~40-line session-state helpers, two-file-per-agent adapters, and a
   thin image-build-retry glue file.
3. **Redirection cruft**: six pure pass-through re-export barrels, and a
   provisioning sort that flakes under parallel load.

Goals, in priority order: **reduce redirection** (fewer hops for a given
task), **cut lines** (fewer files/barrels/glue), and **finish the modularity**
(break the giants along real seams). Honest expectation: the big LOC cut isn't
here — there's no large duplication to delete; this pass trims barrels + glue +
file boilerplate and, above all, flattens call-indirection. A deeper
simplification sweep (Part E) is optional follow-up.

## The one principle that shapes every split: NO re-export barrels

When a file splits, the tempting move is to leave the old file re-exporting the
new sub-modules so callers don't change. **Don't** — that re-adds exactly the
indirection this pass removes. Instead, when a symbol moves, update every
import site to point at its new home directly: internal `#…` specifiers,
cross-package `@yaac/server/…`, and `vi.mock('…')` strings. This is the same
discipline as Pass 1 (`#*` specifiers are absolute-from-`src/`, so moving a file
never changes its *own* imports — only references to it), with the same guard:
after each change, grep the repo (strings included) for the old specifier and
require zero hits. Keep the "public" entry filenames stable where cheap (see
create.ts / list.ts below) precisely to avoid churning the cross-package
surface for no reason.

## Part A — Split the four giants (along verified seams)

Extract **leaf sub-modules first** (the shared helpers everything else needs),
then the consumers. Line spans below are from the current files.

### A1. `features/sessions/create.ts` (1737) → keep `create.ts` + 3 siblings
Keep `createSession` (+ `startJobWithSetup`, `waitForPodReady`, `emit`,
`withUpstreamConfigLock`) **in `create.ts`** so the public
`#features/sessions/create` / `@yaac/server/features/sessions/create` path is
unchanged (its only external consumer is `test/api/write-routes.test.ts`, one
import + one `vi.mock`). Extract as siblings under `features/sessions/`:
- **`agent-command.ts`** (leaf both others need): `shellEscape`, `TMUX`,
  `InitWindow`, `resolveInitWindows`, `initWindowCommand`, `MODEL_RE`,
  `buildAgentCmd`, `buildPromptPasteCmd`, `typeInitialPrompt`,
  `buildAgentWindowCheck`, `verifyAgentWindowAlive`.
- **`spare-pool.ts`**: `retoolSpare`, `RebranchPrepCommands`,
  `buildRebranchPrep`, `rebranchSpare`, `workspaceMountPaths`.
- **`seed.ts`**: `seedClaudeJson`, `seedClaudeSettings`, `ClaudeJsonState`,
  `CLAUDE_ONBOARDING_VERSION`, `EphemeralMount`, `prepareEphemeralMounts`.

`create.ts` and `spare-pool.ts` both import the shared helpers from
`agent-command.ts` (`shellEscape`, `resolveInitWindows`, `buildAgentCmd`,
`verifyAgentWindowAlive`, `TMUX`).

### A2. `features/cluster/bootstrap.ts` (1294) → 3 files, delete `bootstrap.ts`
- **`proxy-constants.ts`** (leaf): all exported port/name/priority/label consts
  (`PROXY_APP_NAME`, `PROXY_PORT`, `SESSION_REDIRECT_PRIORITY`,
  `BUILDER_ROLE_GUARD_NAME`, …). External e2e tests import several of these.
- **`proxy-manifests.ts`**: every pure `build*Manifest`, the name derivers
  (`innerRedirectObjectName`, `vclusterFallbackCcecName`),
  `proxyRunAsSecurityContext`, and the **shared redirect-cec leaf**
  (`buildRedirectCec`, `listenerRef`, `edsClusterName`,
  `redirectListenerAndCluster`, `cecListenerRef`, `innerProjectionLabels`) that
  the outer/inner/vcluster manifest families all depend on.
- **`proxy-apply.ts`** (side-effects): `ensureNamespace`,
  `ensureProxyAuthSecret`, `ensureProxyResources`, `ensureCaConfigMap`,
  `proxyServiceClusterIp`, `sshAgentHostDir`, `proxyDataHostDir`.

External surface straddles the seams, so update those sites (no barrel):
`test-utils/mock-remotes.ts` (`ensureNamespace` → proxy-apply); e2e tests for
consts → proxy-constants and `proxyServiceClusterIp` → proxy-apply; and
`builder-pod.ts`'s `ROLE_BUILDER` re-export (Part D) now points at
proxy-constants.

### A3. `features/sessions/list.ts` (715) → keep `list.ts` + extract 3
Keep `listActiveSessions` (+ impl, inflight dedupe, upstream-branch cache,
`ensureProjectExists`) in `list.ts` (public path stable; one external consumer
`test/e2e-cli/session-prewarm.test.ts`). Extract:
- **`classify.ts`** (leaf all three consumers need): `classifySessionPods`,
  `watcherDisplayLiveness`.
- **`reconcile/stale-sessions.ts`**: `reconcileStaleSessions`.
- **`deleted-list.ts`**: `listDeletedSessions`, `CollectedDeleted` (imports
  `ensureProjectExists` from `list.ts` — one-way).
- Move `captureOpencodeFirstMessages` into `agents/opencode.ts` (Part B3), and
  delete the `export type { … }` barrel at `list.ts:32` (Part D).

### A4. `main/cli.ts` (774) → 3 files, delete `cli.ts` (splits cleanly)
No private helper is shared across the three groups, so this splits with zero
internal constraint. Update the one external consumer `packages/cli/src/cli.ts`
(imports all six functions from `@yaac/server/main/cli`) to the three new paths:
- **`main/server-run.ts`**: `runServer` (+ `bindServer`, `preflightHostTor`,
  `ServerRunOptions`) — the in-process daemon bootstrap + WS wiring. Also
  absorb `restore-forwarders.ts` here (Part C).
- **`main/lifecycle.ts`**: `startServer`, `stopServer`, `restartServer`,
  `serverLogs` (+ the detached-spawn helpers).
- **`main/webapp.ts`**: `openWebapp`, `buildWebappUrl` (+ `openBrowser`).

## Part B — Merge over-split files (cut files + hops)

### B1. Session state → `features/sessions/state.ts`
Merge `status.ts` (40) + `waiting.ts` (84) + `terminating.ts` (60) +
`background.ts` (39) + `death-reason.ts` (31) → one `state.ts` (~250 cohesive
lines; `waiting`→`status`+`death-reason` become intra-file). No cross-package
consumers. Repoint ~9 internal prod importers (`detail`, `list`, `restart`,
`stream-picker`, `cleanup`, `reconcile/salvage-reconcile`, `routes/sessions`)
and the internal `vi.mock('#features/sessions/status'|'waiting')` sites; keep
test-only resets (`_clearTerminatingForTests`, …). Merge the 5 test files →
`state.test.ts`.

### B2. Codex adapter → `features/sessions/agents/codex.ts`
Merge `codex-status.ts` (61) + `codex-hooks.ts` (88). Update prod importers
(`state.ts` ex-`status`, `status-watcher`, `create.ts`) and the **cross-package
`vi.mock`** at `packages/cli/test/session-create.test.ts:172` (codex-hooks →
codex). Merge tests.

### B3. Opencode adapter → `features/sessions/agents/opencode.ts`
Merge `opencode-status.ts` (289) + `opencode-config.ts` (41) + the
`captureOpencodeFirstMessages` moved out of `list.ts`. Update prod importers
(`list`, `cleanup`, `status-watcher`, `restart`, `state`, `create`) and **two**
cross-package sites: real import `packages/cli/test/session-restart.test.ts:9`
(`saveOpencodeMeta`) and `vi.mock` `session-create.test.ts:177`
(opencode-config). Merge tests.

### B4. Image retry → fold into `features/images/image-prewarm.ts`
`image-retry.ts` (41, single caller `routes/images.ts`) is glue over
`image-builds` + `image-prewarm`; fold it into `image-prewarm.ts` (same
image-build-prewarm concern) and update `routes/images.ts`. **Do not** touch
`prewarm.ts` — despite the name it's the prewarmed *session pool*, a different
concern that doesn't import image-prewarm.

## Part C — Inline (only the one that survived verification)

Fold `forwarders/restore-forwarders.ts` (49, single caller `runServer`) into
`main/server-run.ts`. Its test repoints to server-run. **Rejected after
verification** (leave as-is): `resolve.ts` has *two* prod callers (cli +
routes/sessions), and `stream-picker.ts` is 134 lines — neither is a thin
single-caller wrapper.

## Part D — Hygiene

### D1. Delete the six pass-through re-export barrels
Repoint consumers to the defining module; delete the re-export line:
- Four re-export straight from `@yaac/shared/types` — consumers import from
  there directly: `list.ts:32` (4 types), `stream-picker.ts:16` (3),
  `platform/container/port.ts:7` (`PortMapping`), `features/auth/list.ts:10`
  (3).
- Two re-export internal symbols — consumers import from the source:
  `build-coordinator.ts:39` (`ImageBuildReason` ← `image-builds`),
  `builder-pod.ts:70` (`ROLE_BUILDER` ← cluster proxy-constants).

### D2. Fix the provisioning flake (logic change — allowed in Pass 2)
`provisioning.ts:52` stamps `startedAt: Date.now()` (ms) and `:115` sorts
`startedAt − startedAt || sessionId.localeCompare`. Two back-to-back registers
tie on the ms clock in isolation but straddle a ms under load, flipping order.
Replace the `sessionId` tiebreak with a **monotonic insertion counter** so
order is deterministic regardless of the clock; update
`test/features/sessions/provisioning.test.ts` to assert insertion order.

### D3. Typed `vi.mock` factories (durability)
Upgrade the 25 cross-package `vi.mock('@yaac/server/…')` sites (6 files;
15 in `cli/test/session-create.test.ts`) to
`() => ({ … } satisfies Partial<typeof import('@yaac/server/…')>)`, so a future
stale path is a `tsc` error, not a silent no-op. Do this as you touch each
mocked module's path in Parts A–B (codex-hooks→codex, opencode-config→opencode,
etc.), then sweep the rest.

## Part E — Optional: simplification sweep (only if deeper LOC cuts wanted)
After the structure settles, run `/simplify` (or a `/code-review` pass) per
feature folder to surface dead code, dup, and altitude fixes. Not required for
the goals above; call out separately so it isn't conflated with the mechanical
work.

## Sequencing (one logical change per commit, green between each)

`pnpm lint` + `pnpm vitest run --project unit:server` (+ `unit:cli`/
`unit:test-utils` when a commit touches the cross-package surface) + the grep
guard, green before the next step. `pnpm build` once at the end.

1. **D1 barrels** — independent, lowest risk, immediate hop reduction.
2. **B1 state.ts**, then **B2 codex**, **B3 opencode** (B3 needs opencode to
   exist before A3 moves `captureOpencodeFirstMessages` into it), **B4 image**.
3. **A1 create**, **A3 list** (leaves `agent-command`/`classify` first), **A2
   bootstrap** (constants→manifests→apply), **A4 cli** (+ C restore-forwarders).
4. **D2 flake fix**, then **D3 typed-mock sweep** for any sites not already
   converted.

Do B before A so the merges shrink the surface the splits then reorganize; do
each giant as its own commit (or two) since they carry the cross-package churn.

## Risks & constraints
- **No barrels** is the whole game — a grep for `export {`/`export type {`
  re-export lines in `packages/server/src` should end at ~zero, and no split
  may leave the old filename re-exporting its pieces.
- **Cross-package lockstep** (update in the same commit): `packages/cli/src/cli.ts`
  (A4), `cli/test/session-create.test.ts` (B2/B3 mock paths),
  `cli/test/session-restart.test.ts` (B3 real import), `test-utils/mock-remotes.ts`
  and the e2e specs (A2), `test/api/write-routes.test.ts` (A1 if create's path
  ever moves — it shouldn't).
- **Tests mirror src** (Pass 1 rule, now in AGENTS.md): merged modules get a
  merged test file under the same subfolder; split modules get a test per new
  file.
- **`vi.mock` hoisting**: the typed-factory upgrade keeps the literal
  `vi.mock('…')` call — do NOT wrap it in a helper (breaks Vitest's static
  hoist), per the standing convention.
- Watch for **import cycles** the merges could close (e.g. `state.ts` pulling
  `agents/*` which pull back); run a cycle check (`madge`/`dpdm`) after Part B.

## Verification
- **Per commit**: `pnpm lint`; `unit:server` (+ cross-pkg projects when
  touched); grep guard returns zero stale specifiers and zero new re-export
  barrels.
- **Flake fix**: run `provisioning.test.ts` in the full parallel suite several
  times — it must pass deterministically (the whole point).
- **End state**: full `pnpm test:unit` green (expect the same ~1931 server
  tests, minus the files collapsed by merges), `pnpm build` +
  `check-cli-externals` green, and a real boot smoke via the `run-yaac` skill
  (start the server, create a session, confirm it streams) since Part A/B touch
  the create + daemon-bootstrap paths.

# PGlite on-disk DB with drizzle-managed schema, contained in @yaac/server

## Context

The server persists state as ad-hoc JSON files under the data dir, each with its own
tolerant-parse/whole-file-rewrite helpers. This adds an on-disk database — PGlite (embedded
Postgres) with a drizzle-orm v1.0.0-rc.4 managed schema — as the home for non-mounted server/UX
state. Constraints: the DB is opened **only by the server process**, and all DB code lives in
**packages/server**. PGlite is single-process, which forces that anyway: the proxy pod,
auth-daemon, and CLI are separate processes and must never touch it. `@yaac/server` is already
un-importable from auth-daemon/frontend (eslint zones + pnpm strict node_modules), so containment
is enforced, not just conventional.

Scope — four server-only stores move to the DB with **import-then-delete** legacy
migration: `.preferences.json`, per-project `session-titles.json`, per-project
`opencode-meta/<sessionId>.json`, and `tokens.json`. (Originally five: upstream d0dbadb
"Replace bootstrap codes with token-store exchange tokens" deleted `WebAuthStore` and
`.web-sessions.json` — web sessions are now token-store entries with `kind: 'web'`, so they ride
along in the tokens table. Stale `.web-sessions.json` files are already ignored upstream; the
legacy import ignores them too — no table, no import.)
Stay flat (cross-process or user-editable): `yaac-config.json`, `Dockerfile.yaac`/`Dockerfile.user`,
`.credentials/*`, `.server.lock`, `.auth-daemon.lock`, `remote.json`, `server.log`, and the
proxy-written `run/proxy-data/*.json`.

Notes: all four stores are already server-only (the old CLI-side `getDefaultTool()`
reads are gone — `routes/session.ts` resolves the default tool server-side), so **no apps/cli
changes**. Auto-generated titles share the same store with "only write when absent" logic in
`packages/server/src/title-generation.ts` — unaffected by the port.

## Dependencies

- `pnpm-workspace.yaml` `catalog:`: add `"@electric-sql/pglite": 0.5.4` and
  `drizzle-orm: 1.0.0-rc.4` (both >7 days old, clears `minimumReleaseAge: 10080`).
- Reference `"catalog:"` in **both** `packages/server/package.json` `dependencies` and root
  `package.json` `dependencies` — tsup leaves npm deps external and
  `scripts/check-cli-externals.ts` fails the build if a bundle external is missing from the root
  manifest (same pattern as `@lydell/node-pty`).
- `drizzle-kit@1.0.0-rc.4` inline-pinned in `packages/server` `devDependencies`
  (`pnpm --filter @yaac/server add -DE drizzle-kit@1.0.0-rc.4`). Pure-JS/prebuilt-wasm deps — no
  `allowBuilds` entries expected.
- Verified: drizzle-orm rc.4 exports `./pglite` (`drizzle({connection:{dataDir}})`) and
  `./pglite/migrator` (`migrate(db, {migrationsFolder})`); peers `@electric-sql/pglite >=0.2.0`.
- Publishing is unaffected: `pnpm publish` rewrites the root manifest's `catalog:` pins to
  concrete versions, so npm installs of the tarball (including the homebrew formula's
  `npm install`) resolve pglite/drizzle-orm normally.

## Migrations folder & drizzle-kit (contained in the server package)

- `packages/server/drizzle.config.ts`: `defineConfig({ dialect: 'postgresql',
  schema: './src/lib/db/schema.ts', out: './drizzle' })` (`driver: 'pglite'` only needed for
  db-connected commands, not `generate`). Keep `schema.ts` and the config free of `#`-subpath
  and `@yaac/*` imports (drizzle-orm/pg-core + relative paths only): drizzle-kit loads them via
  jiti with plain-Node semantics, which cannot substitute `.ts` sources for the workspace's
  output-form `./src/*.js` map targets (same reason vitest `setupFiles` are explicit file paths).
- `"db:generate": "drizzle-kit generate"` script in `packages/server/package.json`; run as
  `pnpm --filter @yaac/server db:generate`. Check in the generated
  `packages/server/drizzle/` (`0000_*.sql` + `meta/`).
- Root `build` script: copy step becomes `cp -r dockerfiles k8s dist/ && cp -r
  packages/server/drizzle dist/drizzle` (before `write-build-id.ts`).
- Runtime resolution in the DB client: `env.bundled ? path.join(PACKAGE_ROOT, 'drizzle')
  : path.join(PACKAGE_ROOT, 'packages/server/drizzle')` — the one place the second-level
  conditional is needed, commented as such.
- Do **not** add `drizzle` to `RUNTIME_DATA_DIRS` (`packages/shared/src/build-id.ts`) — a
  migration change must change the buildId so dev-watch bounces the server. Add
  `--include 'packages/server/drizzle/**'` to the root `watch` script so migration edits
  retrigger builds.

## New modules — all under `packages/server/src/lib/db/`

- `schema.ts` — drizzle pg-core tables:
  - `preferences` — `key text PK, value text NOT NULL` (only key today: `default_tool`)
  - `shortcut_overrides` — `command_id text PK, code text, alt/ctrl/meta/shift boolean NOT NULL`
    (rows, not jsonb: fixed chord shape, per-command upsert, reset = DELETE)
  - `session_titles` — `project_slug text, session_id text, title text NOT NULL,
    PK(project_slug, session_id)`
  - `opencode_session_meta` — `project_slug text, session_id text, first_message text,
    captured_at text, created_at timestamptz NOT NULL DEFAULT now(),
    PK(project_slug, session_id)` — `created_at` replaces the file birthtime that deleted-session
    listing reads (`lib/session/list.ts:427` via `collectDeleted`)
  - `tokens` — `name text PK, token text NOT NULL, kind text NOT NULL, created_at text NOT NULL,
    expires_at text` (faithful to `TokenEntry`; name-uniqueness via PK matches `create()`'s
    CONFLICT check; `expires_at` set only on `one-time` entries). **No seq column**: the only
    order consumer is the per-kind FIFO trim (`MAX_WEB_SESSIONS`/`MAX_EXCHANGE_TOKENS`, oldest
    first), which only fires past 64 auto-minted entries — `loadTokens()` orders by
    `(created_at, name)`, deterministic and chronologically correct except same-millisecond
    ties, where either eviction choice is harmless. The in-memory `entries` array stays the
    live store of record, exactly as today.
- `client.ts` — lazy singleton `getDb()` / `closeDb()`; private `dbDir()` =
  `path.join(getDataDir(), 'db')` (stays in server — not shared/paths.ts — per containment):
  - `mkdir(dbDir(), {recursive: true, mode: 0o700})` (web session ids + tokens are
    bearer-equivalent), `drizzle({ connection: { dataDir: dbDir() } })`, then
    `await migrate(db, { migrationsFolder: MIGRATIONS_DIR })`. Single-flighted; cache keyed by
    `dbDir()` — when `setDataDir()` changed it (unit tests), close the old client and reopen.
    Docstring states the server-only invariant; `.server.lock` is the single-writer guard.
- `legacy-import.ts` — `importLegacyJsonStores()` (below); the legacy path builders
  (`preferencesPath`, `sessionTitlesPath`, `opencodeMetaDir/File`, `tokensPath`) move here as
  private helpers and are deleted from `packages/shared/src/paths.ts` / `project-paths.ts` /
  the store modules (all consumers are in-server; verified).

## Server lifecycle wiring (`packages/server/src/cli.ts`, `runServer`)

1. Build the token store empty at line ~142: drop `initialTokens: await loadTokens()`; keep the
   `onChanged` persist callback, now writing through the DB-backed `saveTokens` (keep the
   log-on-failure wrapper). (The web-auth store no longer exists — web sessions are token
   entries.)
2. After `acquireLock` succeeds (line ~264): `await getDb()` → `await importLegacyJsonStores()`
   → `tokens.restoreTokens(await loadTokens())`. On failure: log, close server,
   `removeLock(process.pid)`, `exit(1)` (so `yaac server start` reports failure, not half-alive).
3. `shutdown(signal)` closure: after the bounded `server.close()`, before
   `removeLock(process.pid)`, bounded `Promise.race([closeDb(), 3s])` so PGlite checkpoints
   cleanly across dev-watch restarts.
4. `token-store.ts`: add `restoreTokens(entries)` — merge by name, in-memory entry wins (an
   exchange or `create` can race in before restore); `loadTokens`/`saveTokens` reimplemented on
   the DB, same module path and signatures (`loadTokens` orders by `(created_at, name)`;
   `saveTokens` = transaction DELETE-all + INSERT — faithful port of the whole-file rewrite).
   The old-file `kind`-defaulting guard moves into the legacy import (DB rows always carry
   `kind`).

## Legacy import (`importLegacyJsonStores()`)

Runs every startup; steady-state cost ~4 stats + one readdir per project. Per store: parse
tolerantly (reuse existing guards, e.g. `isSerializedChord`), insert in a transaction with
`onConflictDoNothing` (DB rows win over a stale re-appearing file), unlink only after commit.
Malformed file: log via server log, skip, leave in place. Stores:
1. `<dataDir>/.preferences.json` → `preferences` + `shortcut_overrides`.
2. Per project dir (`readdir(getProjectsDir())`): `session-titles.json` → `session_titles`.
3. Per project dir: `opencode-meta/<id>.json` → `opencode_session_meta`, `lstat().birthtime` →
   `created_at`; best-effort rmdir after.
4. `<dataDir>/tokens.json` (`TokenEntry[]`) → `tokens` rows, reusing upstream's shape guard
   from `loadTokens` including its `kind`-defaulting (pre-kinds entries → `durable`).
   `.web-sessions.json` is NOT imported (upstream already ignores stale ones) and is left
   untouched.

## Store rewrites (same module paths, same public signatures)

- `packages/server/src/lib/project/preferences.ts`: reimplement `getDefaultTool`/`setDefaultTool`/
  `getShortcutOverrides`/`setShortcutOverride`/`clearShortcutOverrides` on the DB; keep
  `SerializedChord`, `isValidTool`, `setDefaultToolChecked` (ServerError). Delete
  `loadPreferences`/`savePreferences`/`preferencesPath` (+ the prompt helpers if still present —
  zero callers). Consumers (`routes/tool.ts`, `routes/shortcuts.ts`, `routes/session.ts`,
  `stream-picker.ts`, `prewarm-reconcile.ts`) compile unchanged.
- `packages/server/src/lib/session/titles.ts`: `getSessionTitles(slug)` → SELECT by slug;
  `setSessionTitle` → blank ⇒ DELETE, else upsert. Keep `MAX_TITLE_LENGTH`/`normalizeTitle`.
  Title auto-generation (`title-generation.ts`) needs no change.
- `packages/server/src/lib/session/opencode-status.ts`: private `loadOpencodeMeta`/
  `saveOpencodeMeta` → DB queries (save keeps swallow-errors semantics). Add
  `hasOpencodeMeta(slug, sessionId)` and `listOpencodeMetaEntries(slug):
  Promise<Array<{sessionId, createdAt: Date}>>`:
  - `lib/session/restart.ts:45` (tool inference by file existence) → `hasOpencodeMeta`.
  - `lib/session/list.ts:427`: the opencode arm of `collectDeleted` → `listOpencodeMetaEntries`,
    mapped to the same collected-entry shape (claude/codex arms keep reading transcript dirs).
  - `session-create.ts:1043`: delete the `mkdir(opencodeMetaDir(...))`.

## Tests (co-located, `packages/server/test/`, flat naming; import stores via `#lib/...`,
helpers via `@yaac/test-utils/setup`)

- New `db-client.test.ts`: creates `<dataDir>/db` (0700), answers queries, caches the instance,
  reopens on `setDataDir` change, `closeDb` idempotent, re-migrate no-op.
- New `db-legacy-import.test.ts`: per store — rows imported + file deleted; second run no-ops;
  existing DB row survives a conflicting file; multi-project sweep; birthtime → `created_at`;
  malformed file skipped and left; missing files → clean no-op.
- New `db-tokens.test.ts` (or fold into the token-store suite): DB `loadTokens`/`saveTokens`
  round-trip incl. `kind`/`expires_at`, `(created_at, name)` load order, `restoreTokens` merge
  (in-memory wins on name collision).
- Rework: `preferences.test.ts`, `session-titles.test.ts`, opencode-status/list/restart suites
  (seed via the DB-backed helpers instead of writing JSON files), token-store tests (swap file
  fixtures for DB). `test/api/web-session-flow.test.ts` builds its own store in-process —
  untouched unless it calls `loadTokens`/`saveTokens`.
- DB-heavy files: `await closeDb()` in `afterEach` before `cleanupTempDir`; prefer one
  `createTempDataDir()` per file + table wipes per test where PGlite cold-init (~0.5-1s) hurts.
- `test/api` suites boot `buildApp` in-process — they hit the same lazy `getDb()`; no changes
  beyond any that seed the four stores.
- E2e: no CLI surface changes → none mandated. Cheap addition to `test/e2e-cli/tool.test.ts`:
  `tool set → yaac server restart → tool get` proving on-disk persistence across restarts.

## Verification

1. `pnpm --filter @yaac/server db:generate` produces `packages/server/drizzle/0000_*.sql`; commit.
2. `pnpm lint`, `pnpm test:unit` (no cluster needed).
3. `pnpm test:api`; then `pnpm test:e2e-cli` (needs `yaac cluster check` green).
4. Manual: data dir with legacy JSON files → `yaac server start` → files imported and removed;
   `yaac tool get` returns the previously-set tool; server restart → still set; webapp session
   survives restart (web-kind token persists); `yaac auth token` list survives restart; set a
   session title in the webapp → survives restart; `yaac session list -d` still shows deleted
   opencode sessions with dates.

## Risks / notes

- Double-open: DB opens strictly post-`acquireLock`; residual risk only via `stopServer`'s
  force-remove of a wedged old server (same window the JSON files had; PGlite WAL bounds damage).
- auth-daemon shares the data dir but can never import `@yaac/server` (eslint + strict
  node_modules) — the DB handle and `dbDir()` stay private to the server package.
- Tokens (incl. web-session cookies) are plaintext in the DB — same posture as the current 0600
  file; DB dir is 0700.
- Nested yaac: inner server's data dir is virtiofs-mounted — PGlite works, slower; inner
  `.server.lock` keeps single-writer.
- PGlite adds ~50-100MB RSS to the server; drizzle `latest` dist-tag is still 0.45.x — everything
  pinned exact via catalog so nothing floats.

## As-built deviations (2026-07-13)

- **Casing is declared in the schema, not the driver/kit config.** drizzle v1 replaced the
  old `casing: 'snake_case'` driver/kit option with a schema-level API: tables are defined
  via `snakeCase.table(...)` (`drizzle-orm/pg-core`), so column identifiers derive from the
  camelCase TS keys (`createdAt` → `created_at`) with no explicit name args, consistently
  across drizzle-kit generate and runtime queries. (The old config key is silently ignored
  by kit v1's `generate` — verified empirically before switching to the new API.)
- **drizzle-kit v1 migration layout**: one datestamped dir per migration
  (`drizzle/<ts>_init/{migration.sql,snapshot.json}`), no `meta/_journal.json`. The
  `drizzle-orm/pglite` migrator consumes it directly.
- The post-lock DB init (`getDb` → `importLegacyJsonStores` → `restoreTokens(loadTokens())`)
  runs *before* the start-banner `mintExchangeToken()` — that mint's `onChanged` persist
  rewrites the whole tokens table from the in-memory set, so restore must happen first.
- The build script's copy step is `rm -rf dist/drizzle && cp -r …` — tsup's `clean` only
  removes its own outputs (same reason the frontend copy is preceded by `rm -rf`).

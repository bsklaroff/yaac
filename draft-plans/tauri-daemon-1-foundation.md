# yaac daemon — phase 1: foundation

Stand up the daemon process, the CLI→daemon client, and a single
route+command pair end-to-end. Prove the pattern. Everything else in
the CLI keeps running in-process on top of `src/lib/**` exactly as it
does today.

This phase is the contract for phases 2–4: after it lands, adding a
new route is a mechanical exercise (write handler, write CLI shim,
write tests) and the plumbing below it doesn't change.

## In scope

- `yaac daemon` subcommand + server lifecycle
- `~/.yaac/.daemon.lock` read/write/liveness
- Bearer auth, browser-CORS deny, request logger
- Uniform error taxonomy + `{error:{code,message}}` response shape
- `GET /health`
- `GET /project/list` (the one demo route)
- Shared CLI client `src/lib/daemon-client.ts` with auto-spawn
- `yaac project list` ported to the daemon client
- Unit tests for every helper
- E2E `test/e2e/daemon.test.ts` covering daemon lifecycle + the
  ported command

## Out of scope (later phases)

- Every other CLI command — still runs in-process against
  `src/lib/**` unchanged.
- Daemon background loop (prewarm / reconciliation) — phase 4.
- `preAction` credential hook in `src/index.ts` — stays as-is.
- Interactive commands, auth-update flow, write routes — phases 2–4.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ yaac daemon (Node, one process)                         │
│                                                         │
│   hono app + @hono/node-server                         │
│     ├── request logger                                  │
│     ├── CORS deny                                        │
│     ├── bearer auth (skips /health)                     │
│     │                                                    │
│     ├── GET /health     → {ok, version}                │
│     └── GET /project/list → wraps projectList() data   │
│                                                         │
│   lock file at ~/.yaac/.daemon.lock (pid/port/secret)   │
└─────────────────────────────────────────────────────────┘
        ▲
        │ HTTP (127.0.0.1)
        │
┌───────┴──────────────────────────────────────────────────┐
│ yaac CLI                                                 │
│                                                          │
│   src/lib/daemon-client.ts                               │
│     - read lock, check liveness                          │
│     - auto-spawn `yaac daemon` detached if no live lock  │
│     - fetch with bearer header                           │
│     - map {error:{code,message}} → exit code             │
│                                                          │
│   src/commands/project-list.ts                           │
│     - calls client.get('/project/list')                  │
│     - renders the table locally                          │
│                                                          │
│   every OTHER command: unchanged, in-process today       │
└──────────────────────────────────────────────────────────┘
```

## Entry point and lifecycle

```
yaac daemon [--port <n>]
```

- Default: bind `127.0.0.1:<ephemeral>`, write handshake to
  `~/.yaac/.daemon.lock`, log to stderr.
- Binds TCP only; 127.0.0.1 only. No unix socket, no remote.
- SIGTERM / SIGINT: refuse new requests, finish in-flight handlers,
  unlink the lock, exit 0.
- Does not auto-exit when idle; outlives the CLI invocation that
  started it.
- Crash recovery: no in-memory state, so restart just rebinds and
  reads from Podman labels / disk on demand.
- `yaac daemon` is the *only* subcommand that does not consult
  `daemon-client.ts`. Registration in `src/index.ts` skips the
  existing `preAction` hook path when the invoked command is
  `daemon`.

### Idempotent start

Before binding, `yaac daemon`:

1. Reads `~/.yaac/.daemon.lock`.
2. If the lock is "live" (pid exists + `/health` responds within
   500ms), prints the existing handshake to stderr and exits 0.
3. Otherwise binds, writes a fresh lock (chmod 600), starts serving.

"Live" is the same predicate the CLI uses to decide whether to
auto-spawn. Shared helper in `src/lib/daemon/lock.ts`.

## Lock file

Path: `~/.yaac/.daemon.lock` (relative to `getDataDir()`).

Shape:

```json
{ "pid": 1234, "port": 51734, "secret": "<64 hex chars>", "startedAt": 1712345678901 }
```

- Written atomically (`.tmp` + rename) with `mode: 0o600`.
- `secret` is `crypto.randomBytes(32).toString('hex')`, regenerated
  on every successful bind. Never logged.
- Removed on graceful shutdown. A stale lock is fine — liveness is
  checked on every read.

## Auth

- Every route requires `Authorization: Bearer <secret>`.
- `/health` is exempt so the CLI can distinguish "daemon alive but
  my cached secret is stale" (re-read the lock and retry) from
  "daemon down" (spawn one).
- Preflight (`OPTIONS`) returns 405 — browser origins cannot talk to
  the daemon.
- Bearer compared in constant time.
- Bodies are never logged. The logger prints method + path + status
  + duration only.

## Error taxonomy

Uniform JSON shape for every non-2xx response:

```json
{ "error": { "code": "NOT_FOUND", "message": "project foo not found" } }
```

Codes (complete list — future phases MUST NOT introduce new codes
without updating this doc):

| Code | HTTP | CLI exit |
|---|---|---|
| `NOT_FOUND` | 404 | 1 |
| `VALIDATION` | 400 | 2 |
| `CONFLICT` | 409 | 1 |
| `PODMAN_UNAVAILABLE` | 503 | 1 |
| `AUTH_REQUIRED` | 401 | (phase 3 triggers `auth update` retry) |
| `INTERNAL` | 500 | 1 |

Phase 1 only needs `INTERNAL`, `AUTH_REQUIRED` (for bad bearer), and
`PODMAN_UNAVAILABLE` (for the `project list` demo route when Podman
is down). The taxonomy is defined up front so later phases don't
reinvent it.

## Routes in phase 1

### `GET /health`

Response 200:
```json
{ "ok": true, "version": "0.0.1" }
```

No auth. No body reads. The simplest possible endpoint.

### `GET /project/list`

Response 200:
```json
[
  { "slug": "foo", "remoteUrl": "https://github.com/o/r", "addedAt": "…", "sessionCount": 2 }
]
```

- Wraps the data half of today's `projectList()` — reads
  `~/.yaac/projects/*/project.json` and calls
  `podman.listContainers()` to count sessions (same as
  `src/commands/project-list.ts`).
- If Podman is unavailable, returns `sessionCount: 0` rather than
  failing — same behavior as today.
- The daemon returns raw data. Table rendering stays in the CLI.

To make this clean, extract a pure data function:

- `src/lib/project/index.ts` (new or extended) exports
  `listProjects(): Promise<ProjectListEntry[]>`.
- `src/commands/project-list.ts` becomes: call daemon client, render
  the table.
- The daemon route is a two-line handler that calls
  `listProjects()` and returns JSON.

## CLI daemon client (`src/lib/daemon-client.ts`)

Responsibilities:

1. **Discover.** `readLock()` → if no live lock, spawn
   `yaac daemon` detached, wait for the lock to appear (with a
   timeout budget), verify `/health`.
2. **Fetch.** Wrap `globalThis.fetch` with:
   - `http://127.0.0.1:<port>` prefix from the lock.
   - `Authorization: Bearer <secret>` from the lock.
   - JSON encoding for request bodies; JSON parsing for responses.
3. **Error mapping.** On non-2xx, parse `{error:{code,message}}`.
   Throw a typed `DaemonClientError(code, message)`.
4. **Exit mapping.** Helper `exitOnClientError(err)` prints the
   message to stderr and calls `process.exit(exitCodeForError(code))`.

Auto-spawn details:

- Detect "own binary" via `process.execPath` + the running script.
  In dev (`tsx`) this is `tsx` + `src/index.ts daemon`. In the
  packaged bundle it's `node dist/index.js daemon`.
- Use `child_process.spawn` with `detached: true`, `stdio: 'ignore'`
  (or a small stderr log file under `~/.yaac/`), then `unref()`.
- Wait loop: poll the lock file up to 5s (100ms cadence). If still
  absent, fail with `INTERNAL: daemon did not start`.
- After spawn + lock appears, do one `GET /health` round-trip before
  returning the client.

Secret-refresh loop (handles "daemon restarted between my lock read
and my request"): on 401, re-read the lock once and retry. If still
401, fail hard.

### Client API (phase 1)

```ts
export interface DaemonClient {
  get<T>(path: string): Promise<T>
  // post/put/delete added in later phases
}

export async function getClient(): Promise<DaemonClient>
export function exitOnClientError(err: unknown): never
export class DaemonClientError extends Error {
  readonly code: ErrorCode
}
```

## Tests

### Unit tests (all under `test/unit/daemon/`)

- `errors.test.ts` — `toErrorBody` classification (including the
  podman-unavailable pattern match), `exitCodeForError` mapping.
- `lock.test.ts` — `readLock` tolerates missing/malformed files;
  `writeLock` writes 0600 atomically; `isLockLive` false for dead
  pid, false for alive pid but no server, true for alive server
  (use a short-lived http listener fixture).
- `auth.test.ts` — `bearerAuth` 401s without a header, 401s on
  mismatch, passes with correct bearer, exempts `/health`;
  `denyBrowserCors` 405s preflight; `requestLogger` never logs
  bodies.
- `server.test.ts` — builds an app with the middleware stack; a
  malformed handler throws → `toErrorBody` → uniform JSON response.
- `daemon-client.test.ts` — `getClient` reads the lock and fetches
  with the right host+bearer (fake fetch); on 401 re-reads the
  lock; `exitOnClientError` calls `process.exit` with the mapped
  code.

Per CLAUDE.md every exported function needs a unit test — the above
covers that for phase 1.

### E2E test (`test/e2e/daemon.test.ts`)

- `yaac daemon` binds, writes lock at `~/.yaac/.daemon.lock`, `/health`
  returns 200.
- Second `yaac daemon` invocation exits 0 without rebinding.
- Killing the daemon (SIGTERM) removes the lock.
- With no lock present, running `yaac project list` transparently
  spawns a daemon and returns the expected table.
- `GET /project/list` without bearer returns 401.
- `GET /project/list` with bearer returns the same data the old
  in-process command produced (wrap the existing
  `test/e2e/project-list.test.ts` assertions).

Existing e2e suites that touch `project list` must keep passing.

## Delivery

Single PR. All of the above lands together. After merge:

- `yaac daemon` works.
- `yaac project list` goes through the daemon (auto-spawning one if
  needed).
- Every other CLI command is byte-for-byte unchanged.

This is a safe intermediate state because only one CLI command
crosses the HTTP boundary; the rest of the CLI is untouched by the
daemon's existence.

## Follow-ups

- Phase 2 (reads) adds GET routes for every other read command and
  ports the corresponding CLI commands.
- Phase 3 (writes) adds POST/PUT/DELETE and the `AUTH_REQUIRED`
  retry loop.
- Phase 4 (interactive + background loop) adds attach-info routes,
  moves `ensurePrewarmSessions` into the daemon, and drops
  `preAction`.

# yaac daemon — phase 2: read routes

Port every side-effect-free CLI command to the daemon. After this
lands, anything the user can do *without changing disk/Podman state*
goes through the HTTP client.

Depends on phase 1 (foundation) being merged.

## In scope

### Routes

All GETs:

| CLI | Method + path | Response | Wraps |
|---|---|---|---|
| `session list` | `GET /session/list?project=&deleted=` | `SessionListEntry[]` | data half of `sessionList` |
| `tool get` | `GET /tool/get` | `{tool:AgentTool?}` | `getDefaultTool` |
| `auth list` | `GET /auth/list` | `AuthListEntry[]` (masked) | `listTokens` + `loadToolAuthEntry` |
| — | `GET /project/:slug` | project detail | `projectList` subset + resolved config |
| — | `GET /project/:slug/config` | `{config, source:'repo'\|'override'}` | `resolveProjectConfig` + source detection |
| — | `GET /session/:id` | session detail incl. labels, blocked-hosts count | `resolveContainerAnyState` + meta |
| — | `GET /session/:id/blocked-hosts` | `string[]` | `readBlockedHosts` |
| — | `GET /session/:id/prompt` | `{prompt:string}` | `getSessionFirstMessage` |
| — | `GET /prewarm` | `{[slug]:PrewarmEntry}` | `readPrewarmSessions` |

### CLI commands ported

- `yaac project list` — already ported in phase 1; no change.
- `yaac session list [project] [--deleted]`
- `yaac tool get`
- `yaac auth list`

Each command becomes: call client, render the table. The rendering
code that exists today stays where it is — only the data-fetching
part moves to `src/lib/**` data fns and the daemon route.

### Required refactors

To keep the daemon returning raw data, extract pure data functions
from commands that currently mix data + rendering:

- `src/lib/session/index.ts` (new or extended):
  `listActiveSessions(filter?): Promise<SessionListEntry[]>`,
  `listDeletedSessions(filter?): Promise<DeletedSessionEntry[]>`.
  Includes the stale-cleanup side effect → move that into the
  daemon background loop stub (non-op in phase 2; wire it up in
  phase 4). For phase 2 it's fine to leave the cleanup in the CLI
  post-render step since it runs detached and doesn't block the
  response.
- `src/lib/project/index.ts`: `getProjectDetail(slug)`.
- `src/lib/session/index.ts`: `getSessionDetail(id)`,
  `getSessionBlockedHosts(id)`, `getSessionPrompt(id)`.

## Out of scope

- Write routes and any CLI command that mutates state.
- Interactive commands (`session attach|shell|stream`).
- Background loop — still in the CLI (`session monitor` keeps
  running `ensurePrewarmSessions` in-process for now).
- `preAction` hook — unchanged.

## Error handling

Phase 2 starts exercising `NOT_FOUND` (unknown slug / session id),
`VALIDATION` (bad query string), and `PODMAN_UNAVAILABLE`. All are
already defined in phase 1's taxonomy.

## Tests

- Unit tests for each new data fn and each new route handler under
  `test/unit/daemon/`.
- E2E: the existing `test/e2e/session-list.test.ts`,
  `test/e2e/project-list.test.ts`, `test/e2e/auth.test.ts` must keep
  passing — they now implicitly exercise the daemon end-to-end.
- New E2E coverage in `test/e2e/daemon.test.ts`:
  - `GET /session/list?project=missing` → 404 `NOT_FOUND`.
  - `GET /session/:id/blocked-hosts` for a fresh session returns
    `[]`.
  - `GET /prewarm` returns `{}` on a clean system.

## Delivery

Single PR. All read commands flip to the daemon at once — mixed
state is minimized.

## Follow-ups

- Phase 3: write routes + porting mutating commands.
- Phase 4: interactive commands + daemon background loop.

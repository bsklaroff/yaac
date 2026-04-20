# yaac daemon — phase 3: write routes

Move every mutating CLI command through the daemon. After this lands
the daemon is the only process that writes to `~/.yaac/` or issues
Podman writes on behalf of the user.

Depends on phases 1 (foundation) and 2 (reads).

## In scope

### Routes

| CLI | Method + path | Body | Wraps |
|---|---|---|---|
| `project add <url>` | `POST /project/add` | `{remoteUrl}` | `projectAdd` |
| `session create <project>` | `POST /session/create` | `{project, tool?, addDir?[], addDirRw?[]}` | `sessionCreate` |
| `session delete <id>` | `POST /session/delete` | `{sessionId}` | `sessionDelete` |
| `tool set <tool>` | `POST /tool/set` | `{tool}` | `setDefaultTool` |
| `auth clear` | `POST /auth/clear` | `{service}` | `authClear` |
| — | `PUT /project/:slug/config` | `{config}` | writes `config-override/yaac-config.json` |
| — | `DELETE /project/:slug/config-override` | — | removes override |
| — | `DELETE /project/:slug` | — | tears down live sessions, then `fs.rm(-rf)` of `projectDir(slug)` |
| — | `POST /auth/github/tokens` | `{pattern, token}` | `addToken` |
| — | `DELETE /auth/github/tokens/:pattern` | — | `removeToken` |
| — | `PUT /auth/github/tokens` | `{tokens: GithubTokenEntry[]}` | `saveCredentials` |
| — | `PUT /auth/:tool` | `{kind:'api-key', apiKey} \| {kind:'oauth', bundle}` | `persistToolLogin` |

### CLI commands ported

- `yaac project add <url>`
- `yaac session create <project> [--tool …] [--add-dir …] [--add-dir-rw …]`
- `yaac session delete <id>`
- `yaac tool set <tool>`
- `yaac auth clear`
- `yaac auth update` — interactive. Local prompts + local tool-login
  shell-outs (`claude login`, `codex login`) stay in the CLI process.
  The CLI reads the resulting bundle and `PUT`s it to `/auth/:tool`.
  GitHub token entry is pure prompt → `POST /auth/github/tokens`.

### Client additions

Extend `src/lib/daemon-client.ts`:

- `post<T>(path, body)`, `put<T>(path, body)`, `delete<T>(path)`
- `AUTH_REQUIRED` retry loop: if the daemon replies 401 with code
  `AUTH_REQUIRED` (distinct from "bad bearer" — that's a stale
  secret), the CLI runs `auth update` inline and retries the
  original request once. Second `AUTH_REQUIRED` → exit with the
  message.

  This is the mechanism that replaces the `preAction` hook in
  phase 4: commands that need credentials no longer fail up-front,
  they fail inside the daemon with a code the client knows how to
  handle.

## Out of scope

- Interactive `session attach|shell|stream` commands and their
  routes — phase 4.
- Background loop — phase 4.
- `preAction` hook — still runs in phase 3 as a belt-and-suspenders
  precondition. Drop in phase 4 once every command path can surface
  `AUTH_REQUIRED`.

## Error handling

Exercises `CONFLICT` (duplicate `project add`), `VALIDATION`
(unknown tool, malformed URL), and `AUTH_REQUIRED` (missing GitHub
token for a private repo).

## Tests

- Unit tests for every new handler and the new client methods.
- Unit test for the `AUTH_REQUIRED` retry loop (inject a fake
  client that returns 401 once then 200).
- E2E additions:
  - `project add` of a duplicate URL → `CONFLICT` → CLI exits 1
    with the expected message.
  - `auth update` e2e happy path (mock the OAuth shell-out).
  - `session create` with an unknown tool → `VALIDATION` → exit 2.
- All existing mutating-command e2e suites must keep passing.

## Delivery

Single PR.

## Follow-ups

- Phase 4: interactive commands, daemon background loop,
  decommission `preAction`.

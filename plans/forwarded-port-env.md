# Expose forwarded host port to in-container dev servers

## Context

When yaac forwards a localhost service out of a container (via the `nc`-based
relay in `src/lib/container/port.ts`), the host-side port may differ from the
configured `containerPort` because `reserveAvailablePort` scans forward when
`hostPortStart` is occupied. A dev server inside the container has no way to
know what external port it was assigned, so OAuth callback URLs (and similar
features that hardcode "current port") point to the original `containerPort` —
which doesn't exist on the host — and the flow breaks.

Fix: let users name an env var per `portForward` entry, and inject that env var
into the container with the actual host port value. Dev server code can then
construct correct callback URLs (e.g.
`http://localhost:${process.env.PUBLIC_PORT}/oauth/callback`).

Decision (confirmed with user):
- Naming: user-named per port via a new optional `envVar` field on
  `PortForwardConfig`. No `YAAC_*` convention layer — keeps the surface tight.
- No URL helper var. Port number only; callers compose URLs themselves.

## Approach

Carry an optional `envVar` through the existing `PortForwardConfig` →
`ReservedPort` chain, then inject it in both session-startup paths:

1. **Fresh-create path** (`src/daemon/session-create.ts`): push `envVar=hostPort`
   into the container `env` array between port reservation (line 650) and
   container creation (line 729). The agent's tmux pane and any later panes
   inherit it through the container env.
2. **Prewarm-claim and daemon-restart paths**
   (`src/lib/session/port-forwarders.ts::provisionSessionForwarders`): the
   container's baked-in env is fixed, so use `tmux set-environment -t yaac` to
   layer the var onto the tmux session environment. New panes opened by the
   user (where the dev server runs) inherit it. The agent pane keeps its
   stale env but doesn't need the var.

Both paths use the same `envVar=hostPort` mapping, so dev-server code reads the
same var regardless of how the session started.

## Files to modify

### 1. `src/shared/types.ts` (lines 109-112)

Add the optional field:
```ts
export interface PortForwardConfig {
  containerPort: number
  hostPortStart: number
  envVar?: string  // env var to set inside the container to the resolved host port
}
```

### 2. `src/lib/project/config.ts` (around line 155-173)

In the `portForward` validation block, after the `hostPortStart` check, accept
and validate `envVar`:
- Must be `string` if present.
- Must match `/^[A-Za-z_][A-Za-z0-9_]*$/` (valid POSIX env var name) — rejects
  values that would break shell quoting and prevents injection into the
  `tmux set-environment` command line.
- Push `envVar` into the stored entry alongside `containerPort`/`hostPortStart`.

### 3. `src/lib/container/port.ts`

Extend `ReservedPort` to carry the envVar through:
```ts
export interface ReservedPort extends PortMapping {
  server: net.Server
  envVar?: string
}
```
Update `reserveAvailablePort` to accept an optional `envVar` parameter and
include it in the returned object. `startPortForwarders` ignores it (already
destructures only `containerPort` and `server`).

### 4. `src/daemon/session-create.ts`

- Line 644-647: pass `envVar` through to `reserveAvailablePort` so it lands on
  the `ReservedPort`.
- After line 650 (port-reservation loop done, before `setupParams` is built at
  line 729), append env entries:
  ```ts
  for (const { envVar, hostPort } of forwardedPorts) {
    if (envVar) env.push(`${envVar}=${hostPort}`)
  }
  ```
  Placement matters: must be after reservation (need `hostPort`) and before the
  `env` array is captured into `setupParams` for container creation.

### 5. `src/lib/session/port-forwarders.ts`

- In `provisionSessionForwarders` (line 104-129): pass `envVar` through to
  `reserveAvailablePort` in the loop at line 112-115, and add a new
  `setSessionTmuxEnv(containerName, reserved)` call after `setSessionStatusRight`
  (line 121). The new helper:
  ```ts
  export async function setSessionTmuxEnv(
    containerName: string,
    ports: ReadonlyArray<ReservedPort>,
  ): Promise<void> {
    for (const { envVar, hostPort } of ports) {
      if (!envVar) continue
      await shellPodmanWithRetry(
        `podman exec ${containerName} tmux set-environment -t yaac ${envVar} ${hostPort}`,
      )
    }
  }
  ```
  No shell-escape on `envVar` because validation in step 2 already restricts it
  to safe characters; `hostPort` is a number. Call it from
  `provisionSessionForwarders` so both prewarm-claim and daemon-restart paths
  pick it up — same single source.

### Existing functions reused (no changes needed)

- `reserveAvailablePort` (`src/lib/container/port.ts:54`) — gains a new optional
  param but signature is otherwise unchanged.
- `shellPodmanWithRetry` (`src/lib/container/runtime.ts`) — used by the new
  `setSessionTmuxEnv`, same pattern as `setSessionStatusRight`.
- `startPortForwarders` — unchanged; ignores the new field.
- The env-array push pattern at `session-create.ts:548-627` — the new push
  follows the same idiom as the recently added `config.env` block.

## Tests

Per `CLAUDE.md`: every exported function gets a unit test in `test/unit/`;
every CLI argument/option gets an e2e test in `test/e2e/`. No new CLI options
here (only a new config field), so the CLI-arg e2e rule doesn't apply, but the
e2e suite should still cover the config field end-to-end.

### Unit tests

- `test/unit/config.test.ts`: extend the `portForward` cases to cover
  `envVar` accepted (string), rejected (non-string), rejected (invalid
  identifier like `"FOO BAR"` or `"1FOO"`), and absent (still valid).
- `test/unit/port.test.ts`: assert `reserveAvailablePort(cp, sp, "PUBLIC_PORT")`
  returns a `ReservedPort` whose `envVar === "PUBLIC_PORT"`, and that omitting
  it leaves `envVar` undefined.
- `test/unit/port-forwarders.test.ts`: test the new exported `setSessionTmuxEnv`
  with a mocked `shellPodmanWithRetry` — verify it issues one
  `tmux set-environment` per entry that has `envVar`, and skips entries
  without one.
- `test/unit/restore-forwarders.test.ts`: if it asserts the call shape, update
  to include the new tmux-env step (or relax the assertion).

### E2e test

Extend `test/e2e-cli/port-forward.test.ts` with a case that:
1. Creates a session with config:
   ```json
   { "portForward": [{ "containerPort": 3000, "hostPortStart": 3000, "envVar": "PUBLIC_PORT" }] }
   ```
2. Reads back the assigned host port from the create-session output.
3. Runs `podman exec <container> printenv PUBLIC_PORT` and asserts it equals
   the host port.

If feasible, repeat against a prewarmed session to cover the
`tmux set-environment` path (open a fresh tmux pane via
`podman exec <c> tmux new-window -t yaac -P -F '#{pane_id}'` and read
`PUBLIC_PORT` there). If the prewarm path is too tedious to drive in e2e,
cover it with a unit test on `provisionSessionForwarders` instead.

Use `requirePrebuilt: true` in any new image-using tests (per CLAUDE.md).

## Verification

1. `pnpm lint` — type-check and ESLint pass.
2. `pnpm test -- port` — runs both unit and e2e port tests.
3. Manual smoke: create a session with `envVar: "PUBLIC_PORT"` and a
   `hostPortStart` that's already taken on the host. Confirm the resulting
   container has `PUBLIC_PORT` set to the actual (scanned-forward) host port
   via `yaac shell <session>` then `printenv PUBLIC_PORT`.
4. Manual smoke (prewarm path): with a prewarmed session available, claim it
   with the same config, open a fresh tmux pane inside, and confirm
   `printenv PUBLIC_PORT` is set.

## Non-goals (YAGNI)

- No `YAAC_HOST_PORT_<n>` convention layer — users name the var explicitly.
- No URL helper (`YAAC_HOST_URL_<n>`) — protocol/host assumptions don't hold
  for tunneled/remote setups.
- No retroactive env injection into the already-running agent process in the
  prewarm path — the user's dev server is the consumer, not the agent.

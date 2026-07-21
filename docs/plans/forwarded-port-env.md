# Expose forwarded host port to in-container dev servers

## Context

When yaac forwards a localhost service out of a session pod (via the `nc`-based
relay in `src/lib/container/port.ts` — now driven by `kubectl exec -i nc`, see
`kubectlRelay` at `src/lib/container/port.ts:77-82`), the host-side port may
differ from the configured `containerPort` because `reserveAvailablePort` scans
forward when `hostPortStart` is occupied. A dev server inside the container has
no way to know what external port it was assigned, so OAuth callback URLs (and
similar features that hardcode "current port") point to the original
`containerPort` — which doesn't exist on the host — and the flow breaks.

Fix: let users name an env var per `portForward` entry, and inject that env var
into the container with the actual host port value. Dev server code can then
construct correct callback URLs (e.g.
`http://localhost:${process.env.PUBLIC_PORT}/oauth/callback`).

Decision (confirmed with user):
- Naming: user-named per port via a new optional `envVar` field on
  `PortForwardConfig`. No `YAAC_*` convention layer — keeps the surface tight.
- No URL helper var. Port number only; callers compose URLs themselves.

> Backend note: the container backend is now Kubernetes (one single-pod Job per
> session), not podman. The session env is baked into the pod spec at Job
> creation, and out-of-band container commands run via `containerExec` /
> `kubectl exec` (`src/lib/k8s/exec.ts`), not `podman exec`. The approach below
> targets that backend.

## Approach

Carry an optional `envVar` through the existing `PortForwardConfig` →
`ReservedPort` chain, then inject it in both session-startup paths:

1. **Fresh-create path** (`src/server/session-create.ts`): push `envVar=hostPort`
   into the pod-spec `env` array (the same array built by the `env.push(...)`
   calls around lines 743-936) after port reservation (the loop at lines
   944-950) and before that `env` array is captured into `setupParams` for Job
   creation (around line 1124). The agent's tmux pane and any later panes
   inherit it through the pod env.
2. **Server-restart path** (and any future prewarm-claim path that reuses an
   already-running pod)
   (`src/lib/session/port-forwarders.ts::provisionSessionForwarders`): the pod's
   baked-in env is fixed once the Job exists, so use
   `tmux set-environment -t yaac` (over `containerExec` / `kubectl exec`) to
   layer the var onto the tmux session environment. New panes opened by the
   user (where the dev server runs) inherit it. The agent pane keeps its stale
   env but doesn't need the var.

Both paths use the same `envVar=hostPort` mapping, so dev-server code reads the
same var regardless of how the session started.

> Forwarder-acquisition gap: today `provisionSessionForwarders` is wired only to
> the server-restart path (`src/lib/session/restore-forwarders.ts:41`). The
> fresh-create path sets up forwarders inline in `session-create.ts`
> (`startPortForwarders(kubectlRelay(jobName), forwardedPorts)` at lines
> 1163-1166) and bakes env into the pod spec, so it does **not** need the
> tmux-env step. Before claiming "one single source for both the restart and
> prewarm-claim paths", confirm how a claimed prewarmed pod acquires its
> forwarders under the current k8s flow: if a prewarm claim reuses the inline
> create path, it gets the baked pod env and needs no tmux step; if it instead
> reuses an already-running pod, it must go through `provisionSessionForwarders`
> (and thus the tmux step). Wire whichever path actually claims prewarmed pods.

## Files to modify

### 1. `src/shared/types.ts` (lines 130-133)

Add the optional field:
```ts
export interface PortForwardConfig {
  containerPort: number
  hostPortStart: number
  envVar?: string  // env var to set inside the container to the resolved host port
}
```

### 2. `src/lib/project/config.ts` (lines 226-244)

In the `portForward` validation loop, after the `hostPortStart` check (lines
239-241) and before the entry is pushed (line 242), accept and validate
`envVar`:
- Must be `string` if present.
- Must match `/^[A-Za-z_][A-Za-z0-9_]*$/` (valid POSIX env var name) — rejects
  values that would break shell quoting and prevents injection into the
  `tmux set-environment` command line.
- Include `envVar` in the pushed entry alongside
  `containerPort`/`hostPortStart` (line 242).

### 3. `src/lib/container/port.ts` (lines 8-11, 55-69)

Extend `ReservedPort` (lines 8-11) to carry the envVar through:
```ts
export interface ReservedPort extends PortMapping {
  /** Pre-bound server holding the port so no other process can claim it. */
  server: net.Server
  envVar?: string
}
```
Update `reserveAvailablePort` (lines 55-69) to accept an optional `envVar`
parameter and include it in the returned object (line 65). `startPortForwarders`
(lines 93-135) ignores it — it already destructures only `containerPort` and
`server` (line 100).

### 4. `src/server/session-create.ts`

- Line 948: pass `envVar` through to `reserveAvailablePort` so it lands on the
  `ReservedPort` (the loop at line 946 already destructures `config.portForward`
  — also pull `envVar` there).
- After the reservation loop (lines 944-950) and before `setupParams` is built
  (around line 1124), append env entries to the pod-spec `env` array:
  ```ts
  for (const { envVar, hostPort } of forwardedPorts) {
    if (envVar) env.push(`${envVar}=${hostPort}`)
  }
  ```
  Placement matters: must be after reservation (need `hostPort`) and before the
  `env` array is captured into `setupParams` for Job creation. This follows the
  same idiom as the existing `env.push(...)` calls (lines 743-936).

### 5. `src/lib/session/port-forwarders.ts` (lines 105-130)

- In `provisionSessionForwarders` (lines 105-130): pull `envVar` from the
  `portForward` entries and pass it through to `reserveAvailablePort` in the
  loop at lines 112-117, and add a new `setSessionTmuxEnv(jobName, reserved)`
  call after `setSessionStatusRight` (line 122). The new helper mirrors
  `setSessionStatusRight` (lines 85-96), using `containerExec` and the in-pod
  tmux socket:
  ```ts
  export async function setSessionTmuxEnv(
    jobName: string,
    ports: ReadonlyArray<ReservedPort>,
  ): Promise<void> {
    for (const { envVar, hostPort } of ports) {
      if (!envVar) continue
      await containerExec(
        jobName,
        `tmux -S ${CONTAINER_TMUX_SOCK} set-environment -t yaac ${envVar} ${hostPort}`,
      )
    }
  }
  ```
  No shell-escape on `envVar` because validation in step 2 already restricts it
  to safe characters; `hostPort` is a number. `containerExec` and
  `CONTAINER_TMUX_SOCK` are already imported in this module (lines 13, 16).

### Existing functions reused (no changes needed)

- `reserveAvailablePort` (`src/lib/container/port.ts:55`) — gains a new optional
  param but signature is otherwise unchanged.
- `containerExec` (`src/lib/k8s/exec.ts:18`) — used by the new
  `setSessionTmuxEnv`, same pattern as `setSessionStatusRight`
  (`port-forwarders.ts:85-96`).
- `kubectlRelay` / `startPortForwarders` (`src/lib/container/port.ts:77`, `:93`)
  — unchanged; the relay ignores the new field.
- The pod-spec env-array push pattern at `session-create.ts:743-936` — the new
  push follows the same idiom as the existing env blocks.

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
  with a mocked `containerExec` — verify it issues one `tmux set-environment`
  per entry that has `envVar`, and skips entries without one.
- `test/unit/restore-forwarders.test.ts`: if it asserts the call shape of
  `provisionSessionForwarders`, update it to include the new tmux-env step (or
  relax the assertion).

### E2e test

Extend `test/e2e-cli/port-forward.test.ts` with a case that:
1. Creates a session with config:
   ```json
   { "portForward": [{ "containerPort": 3000, "hostPortStart": 3000, "envVar": "PUBLIC_PORT" }] }
   ```
2. Reads back the assigned host port from the create-session output.
3. Runs `kubectl exec <job> -- printenv PUBLIC_PORT` (via the test's
   `containerExec` helper) and asserts it equals the host port.

If feasible, repeat against a session whose forwarders were (re)provisioned via
`provisionSessionForwarders` to cover the `tmux set-environment` path (open a
fresh tmux pane via
`containerExec(job, "tmux -S <sock> new-window -t yaac -P -F '#{pane_id}'")`
and read `PUBLIC_PORT` there). If that path is too tedious to drive in e2e,
cover it with a unit test on `provisionSessionForwarders` instead.

Use `requirePrebuilt: true` in any new image-using tests (per CLAUDE.md), and
let the e2e worker's per-run namespace (`YAAC_K8S_NAMESPACE`) isolate the
created Job as usual.

## Verification

1. `pnpm lint` — type-check and ESLint pass.
2. `pnpm test -- port` — runs both unit and e2e port tests.
3. Manual smoke: create a session with `envVar: "PUBLIC_PORT"` and a
   `hostPortStart` that's already taken on the host. Confirm the resulting
   pod has `PUBLIC_PORT` set to the actual (scanned-forward) host port via
   `yaac shell <session>` then `printenv PUBLIC_PORT`.
4. Manual smoke (restart/prewarm path): with a session whose forwarders are
   reprovisioned through `provisionSessionForwarders` (e.g. after a server
   restart), open a fresh tmux pane inside and confirm `printenv PUBLIC_PORT`
   is set.

## Non-goals (YAGNI)

- No `YAAC_HOST_PORT_<n>` convention layer — users name the var explicitly.
- No URL helper (`YAAC_HOST_URL_<n>`) — protocol/host assumptions don't hold
  for tunneled/remote setups.
- No retroactive env injection into the already-running agent process in the
  restart/prewarm path — the user's dev server is the consumer, not the agent.

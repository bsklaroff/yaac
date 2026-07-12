/**
 * Launcher orchestration: resolve which server this launch should land on,
 * bring the local one up if needed, mint a one-time exchange token with the
 * bearer credential (POST /tokens — the same endpoint `yaac open` uses),
 * and top-level-navigate the webview to `<origin>/?token=…`; the SPA trades
 * the token for its session cookie at POST /auth/web-session. From that
 * point the webview is just a browser on the server's SPA — cookie auth,
 * fetches, and WebSockets all behave exactly like the webapp
 * (`plans/remote-server-hosting.md`: the origin IS the context).
 *
 * Target precedence mirrors `resolveServerTarget` in
 * @yaac/shared/server-client (enabled remote.json, else the local lock),
 * minus its test-env hatch, which is meaningless in a GUI app. Liveness is
 * an HTTP /health probe — never `isLockLive`, whose pid check needs
 * `process.kill`.
 */
import { SERVER_LOCK_FILENAME, parseServerLock } from '@yaac/shared/server-lock-file'
import { REMOTE_CONFIG_FILENAME, parseRemoteConfig } from '@yaac/shared/remote-config-file'
import type { ServerTarget } from '@yaac/shared/server-client'
import { makeServerClient, type ServerClient } from '#client'
import type { LauncherDeps } from '#deps'
import type { LauncherErrorKind } from '#status'

const HEALTH_TIMEOUT_MS = 1500
const START_POLL_MS = 500
const START_POLL_ATTEMPTS = 40 // × START_POLL_MS = 20s of post-spawn headroom

/**
 * Read remote.json / .server.lock and pick the target. Null means "no
 * enabled remote and no lock" — locally recoverable by starting the server.
 */
export async function resolveTarget(deps: LauncherDeps): Promise<ServerTarget | null> {
  const remoteRaw = await deps.readYaacFile(REMOTE_CONFIG_FILENAME)
  const remote = remoteRaw === null ? null : parseRemoteConfig(remoteRaw)
  if (remote?.enabled) {
    return { baseUrl: remote.url, secret: remote.token, remote: true }
  }
  const lockRaw = await deps.readYaacFile(SERVER_LOCK_FILENAME)
  const lock = lockRaw === null ? null : parseServerLock(lockRaw)
  if (lock) {
    return { baseUrl: `http://127.0.0.1:${lock.port}`, secret: lock.secret, remote: false }
  }
  return null
}

/** HTTP liveness probe — the webview-side replacement for isLockLive. */
export async function checkHealth(client: ServerClient): Promise<boolean> {
  try {
    const res = await client.health.$get(undefined, {
      init: { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) },
    })
    return res.ok
  } catch {
    return false
  }
}

export type EnsureResult =
  | { ok: true, target: ServerTarget }
  | { ok: false, kind: Extract<LauncherErrorKind, 'no-cli' | 'server-start-failed' | 'no-server'>, detail?: string }

/**
 * Make sure a local server is up, spawning `yaac server start` when the
 * lock is missing or dead. Callers must never pass a remote target — a
 * configured remote never triggers a local spawn (same rule as
 * `openWebapp` in packages/server/src/cli.ts).
 */
export async function ensureLocalServer(
  deps: LauncherDeps,
  existing: ServerTarget | null,
): Promise<EnsureResult> {
  if (existing && await checkHealth(makeServerClient(deps.fetch, existing))) {
    return { ok: true, target: existing }
  }
  deps.onStatus({ phase: 'starting-server' })
  let started: { code: number | null, stderr: string }
  try {
    started = await deps.startLocalServer()
  } catch (err) {
    return { ok: false, kind: 'no-cli', detail: err instanceof Error ? err.message : String(err) }
  }
  if (started.code !== 0) {
    // Surface the CLI's own message verbatim — it already explains build
    // mismatches ("Restart it with: yaac server restart") and the like.
    return { ok: false, kind: 'server-start-failed', detail: started.stderr }
  }
  // `yaac server start` waits for the lock itself; poll with headroom for
  // slow cold starts.
  for (let attempt = 0; attempt < START_POLL_ATTEMPTS; attempt++) {
    const target = await resolveTarget(deps)
    if (target && !target.remote && await checkHealth(makeServerClient(deps.fetch, target))) {
      return { ok: true, target }
    }
    await deps.sleep(START_POLL_MS)
  }
  return { ok: false, kind: 'no-server' }
}

export type MintTokenResult =
  | { ok: true, token: string }
  | { ok: false, status: number, detail: string }

/**
 * Mint a one-time exchange token (POST /tokens) with the target's bearer —
 * the same call `openWebapp` makes. Network errors → status 0.
 */
export async function mintWebToken(client: ServerClient): Promise<MintTokenResult> {
  try {
    const res = await client.tokens.$post({ json: { kind: 'one-time' } })
    if (!res.ok) {
      return { ok: false, status: res.status, detail: `failed to mint a one-time token (HTTP ${res.status})` }
    }
    const { token } = await res.json()
    return { ok: true, token }
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) }
  }
}

/** Twin of `buildWebappUrl` (packages/server/src/cli.ts); the token is hex, so encoding is defensive only. */
export function buildWebappUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/?token=${encodeURIComponent(token)}`
}

export async function runLauncher(deps: LauncherDeps): Promise<void> {
  deps.onStatus({ phase: 'resolving' })
  const resolved = await resolveTarget(deps)

  if (resolved?.remote) {
    deps.onStatus({ phase: 'connecting', baseUrl: resolved.baseUrl })
    const client = makeServerClient(deps.fetch, resolved)
    if (!(await checkHealth(client))) {
      deps.onStatus({ phase: 'error', kind: 'unreachable-remote', detail: resolved.baseUrl })
      return
    }
    const result = await mintWebToken(client)
    if (!result.ok) {
      deps.onStatus({
        phase: 'error',
        kind: result.status === 401 ? 'bad-token' : 'unreachable-remote',
        detail: result.status === 401 ? resolved.baseUrl : result.detail,
      })
      return
    }
    navigate(deps, resolved.baseUrl, result.token)
    return
  }

  const ensured = await ensureLocalServer(deps, resolved)
  if (!ensured.ok) {
    deps.onStatus({ phase: 'error', kind: ensured.kind, detail: ensured.detail })
    return
  }
  let target = ensured.target
  deps.onStatus({ phase: 'connecting', baseUrl: target.baseUrl })
  let result = await mintWebToken(makeServerClient(deps.fetch, target))
  if (!result.ok && result.status === 401) {
    // Stale lock: the server restarted (new secret) between our read and
    // the request. Re-resolve once and retry.
    const refreshed = await resolveTarget(deps)
    if (refreshed && !refreshed.remote) {
      target = refreshed
      result = await mintWebToken(makeServerClient(deps.fetch, target))
    }
  }
  if (!result.ok) {
    deps.onStatus({ phase: 'error', kind: 'no-server', detail: result.detail })
    return
  }
  navigate(deps, target.baseUrl, result.token)
}

function navigate(deps: LauncherDeps, baseUrl: string, token: string): void {
  deps.onStatus({ phase: 'navigating', baseUrl })
  deps.navigate(buildWebappUrl(baseUrl, token))
}

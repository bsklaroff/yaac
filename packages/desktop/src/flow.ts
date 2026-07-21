/**
 * Boot orchestration: resolve which server this launch should land on,
 * bring the local one up if needed, mint a one-time exchange token, and
 * hand back the authed URL to load — `<origin>/?token=…`, the same URL
 * `yaac open` builds. The SPA trades the token for its session cookie at
 * POST /auth/web-session; from then on the window is a plain browser on
 * the server origin, exactly like the webapp (the origin IS the context).
 *
 * Target resolution and the typed client come verbatim from
 * @yaac/shared/server-api — the desktop main is a Node process, so it
 * reuses the CLI's own machinery (enabled remote.json, else the local
 * lock; prescriptive errors; BAD_BEARER re-resolve). Deps are injected so
 * every branch unit-tests without Electron, processes, or a server.
 */
import type { ServerTarget } from '@yaac/shared/server-api'
import type { RunResult } from '#server-process'
import type { LaunchError } from '#messages'

export interface FlowDeps {
  /** @yaac/shared resolveServerTarget (requireBuildMatch: false): throws (local path only) when the server is down. */
  resolveTarget(): Promise<ServerTarget>
  /** Run `yaac server start` to completion; rejects only when yaac can't be spawned. */
  startLocalServer(): Promise<RunResult>
  /**
   * Best-effort: ensure the machine-local login broker runs against `target`
   * (the same call `yaac open` makes). Fired, never awaited or propagated —
   * the packaged path resolves the login-shell PATH (up to 5s) and must not
   * delay landing the window.
   */
  ensureAuthDaemon(target: ServerTarget): Promise<void>
  /** Mint the one-time exchange token (see #mint); throws with a descriptive message. */
  mintToken(): Promise<string>
  onStatus(text: string): void
  /**
   * Base URL to load in the window instead of the server origin — the
   * `desktop:hot` dev flow points it at Vite (:1420), which proxies /auth (and
   * the rest of the API) back to the server so the token exchange stays
   * same-origin. The server target itself still resolves normally (mint talks
   * to the real server).
   */
  rendererBaseUrl?: string
}

export type FlowResult =
  | { ok: true, url: string }
  | { ok: false, error: LaunchError }

export async function runFlow(deps: FlowDeps): Promise<FlowResult> {
  deps.onStatus('Locating yaac server…')
  let target: ServerTarget
  try {
    target = await deps.resolveTarget()
  } catch {
    // Only the local-lock path throws — an enabled remote always resolves,
    // so a configured remote never triggers a local spawn (same rule as
    // `openWebapp` in packages/server/src/cli.ts).
    deps.onStatus('Starting the local yaac server…')
    let started: RunResult
    try {
      started = await deps.startLocalServer()
    } catch (err) {
      return failure({
        title: 'yaac CLI not found',
        detail: message(err),
        hint: 'Install yaac and make sure it is on PATH, then relaunch the app.',
      })
    }
    if (started.code !== 0) {
      // Verbatim stderr: `yaac server start` already prints the recovery
      // command (e.g. "Restart it with: yaac server restart").
      return failure({
        title: 'yaac server failed to start',
        detail: started.stderr,
        hint: 'Fix the reported problem (or run `yaac server start` in a terminal), then relaunch the app.',
      })
    }
    try {
      target = await deps.resolveTarget()
    } catch (err) {
      return failure({
        title: 'yaac server did not become reachable',
        detail: message(err),
        hint: 'Start it with `yaac server start`, then relaunch the app.',
      })
    }
  }

  // Best-effort, fire-and-forget: the SPA's sign-in cards need the login
  // broker on this machine. Never block or fail the window on it — a failed
  // spawn just leaves the cards saying what to run.
  void deps.ensureAuthDaemon(target).catch(() => { /* best-effort */ })

  deps.onStatus(`Connecting to ${target.baseUrl}…`)
  let token: string
  try {
    token = await deps.mintToken()
  } catch (err) {
    return failure(target.remote
      ? {
          title: 'Could not connect to the remote server',
          detail: message(err),
          hint: 'Check it with `yaac remote status`, or switch back to the local server with `yaac remote off`, then relaunch the app.',
        }
      : {
          title: 'Could not connect to the yaac server',
          detail: message(err),
          hint: 'Try `yaac server restart`, then relaunch the app.',
        })
  }

  // Trailing slashes stripped so both origin shapes compose with the /?token=
  // suffix (target.baseUrl is already bare).
  const base = deps.rendererBaseUrl?.replace(/\/+$/, '') ?? target.baseUrl
  deps.onStatus(`Opening ${base}…`)
  return { ok: true, url: buildWebappUrl(base, token) }
}

/** Twin of `buildWebappUrl` (packages/server/src/cli.ts); the token is hex, so encoding is defensive only. */
export function buildWebappUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/?token=${encodeURIComponent(token)}`
}

function failure(error: LaunchError): FlowResult {
  return { ok: false, error }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

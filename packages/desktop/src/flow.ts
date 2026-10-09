/**
 * Boot flow: resolve the server registered in `server.json`, check that it
 * answers `GET /whoami` for this device, and return its origin for the
 * window to load. After that the window is a plain browser on that origin.
 *
 * An unreachable server becomes a failure the window renders as a server
 * picker (connect-page.ts), which can start this machine's server.
 */
import {
  getApiClient, isLoopbackOrigin, type ApiClientOptions, type ServerTarget,
} from '@yaac/shared/server-api'
import type { Principal } from '@yaac/shared/types'
import type { LaunchError } from '#messages'

/**
 * Ask the selected server who this device is. Rejects with the server's
 * message when it is unreachable or won't identify this device. The
 * build-skew warning is off because the shell has no build id to compare.
 */
export async function probeIdentity(opts: ApiClientOptions = {}): Promise<Principal> {
  return getApiClient({ ...opts, warnOnBuildSkew: false }).whoami.$get()
}

export interface FlowDeps {
  /** @yaac/shared resolveServerTarget: throws when no server is selected. */
  resolveTarget(): Promise<ServerTarget>
  /**
   * Ensure the machine-local login broker runs against `target`. Not
   * awaited: resolving the login-shell PATH can take up to 5s.
   */
  ensureAuthDaemon(target: ServerTarget): Promise<void>
  /** `probeIdentity`; throws with a descriptive message. */
  probeIdentity(): Promise<unknown>
  onStatus(text: string): void
  /**
   * URL to load instead of the server origin. `desktop:hot` sets it to Vite
   * (:1420), which proxies the API to the server. The identity probe still
   * talks to the real server.
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
  } catch (err) {
    // The resolver's message starts with the same sentence as the title,
    // so the detail drops it.
    const title = 'No yaac server selected'
    return failure({
      title,
      detail: withoutHeading(message(err), title),
      hint: 'Pick a server below, or add one.',
    })
  }

  // The SPA's sign-in cards need the login broker. A failed spawn leaves the
  // cards saying what to run, so it never blocks the window.
  void deps.ensureAuthDaemon(target).catch(() => { /* best-effort */ })

  deps.onStatus(`Connecting to ${target.baseUrl}…`)
  try {
    await deps.probeIdentity()
  } catch (err) {
    // Only a server on this machine gets a command in the hint.
    return failure({
      title: `Could not connect to ${target.baseUrl}`,
      detail: message(err),
      hint: isLoopbackOrigin(target.baseUrl)
        ? 'Start it below or from the yaac menu-bar icon — or pick a '
          + 'different server below.'
        : 'Check that the server is running, then connect again — or pick a '
          + 'different server below.',
    })
  }

  // target.baseUrl has no trailing slash; strip any from the override too.
  const base = deps.rendererBaseUrl?.replace(/\/+$/, '') ?? target.baseUrl
  deps.onStatus(`Opening ${base}…`)
  return { ok: true, url: `${base}/` }
}

function failure(error: LaunchError): FlowResult {
  return { ok: false, error }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `text` minus a first line that just restates `heading`. */
function withoutHeading(text: string, heading: string): string {
  const [first, ...rest] = text.split('\n')
  if (rest.length === 0 || first.replace(/[.\s]+$/, '') !== heading) return text
  // Un-indent the resolver's continuation lines.
  return rest.map((line) => line.replace(/^ {4}/, '')).join('\n').trim()
}

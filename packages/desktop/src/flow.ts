/**
 * Boot orchestration: resolve which server this launch should land on,
 * check that it answers and will say who this device is (`GET /whoami`),
 * and hand back its origin to load. From then on the window is a plain
 * browser on the server origin, exactly like the webapp (the origin IS the
 * context), identified by the server from each request as any browser is.
 *
 * The shell never starts a server. Every server is reached the same way —
 * the origin this machine has registered in `server.json` — so there is no
 * local case to spawn into, and an unreachable one is a failure the window
 * renders as a picker rather than a spawn (see `#connect-page`). Target
 * resolution and the typed client come verbatim from
 * @yaac/shared/server-api. Deps are injected so every branch unit-tests
 * without Electron or a server.
 */
import {
  getApiClient, isLoopbackOrigin, type ApiClientOptions, type ServerTarget,
} from '@yaac/shared/server-api'
import type { Principal } from '@yaac/shared/types'
import type { LaunchError } from '#messages'

/**
 * Ask the selected server who this device is, on the shared typed client —
 * minus the build-skew warning (`warnOnBuildSkew: false`): the shell is a
 * pure client with no build identity of its own. Rejects when the server
 * is unreachable or refuses to identify this device, with the server's
 * own message.
 */
export async function probeIdentity(opts: ApiClientOptions = {}): Promise<Principal> {
  // Forced off, not defaulted: the shell ships no server code, so no
  // caller of this package ever has a build id to compare.
  return getApiClient({ ...opts, warnOnBuildSkew: false }).whoami.$get()
}

export interface FlowDeps {
  /** @yaac/shared resolveServerTarget: throws when no server is selected. */
  resolveTarget(): Promise<ServerTarget>
  /**
   * Best-effort: ensure the machine-local login broker runs against
   * `target`. Fired, never awaited or propagated — the packaged path
   * resolves the login-shell PATH (up to 5s) and must not delay landing
   * the window.
   */
  ensureAuthDaemon(target: ServerTarget): Promise<void>
  /** `probeIdentity`; throws with a descriptive message. */
  probeIdentity(): Promise<unknown>
  onStatus(text: string): void
  /**
   * Base URL to load in the window instead of the server origin — the
   * `desktop:hot` dev flow points it at Vite (:1420), which proxies the API
   * back to the server. The server target itself still resolves normally
   * (the identity probe talks to the real server).
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
    // Nothing selected. The resolver's message opens with this same
    // sentence and then lists the commands, so the heading takes the
    // sentence and the detail keeps the rest — printing both whole reads
    // as a stutter. The picker this lands on is itself the fix, so the
    // hint points at it rather than at a terminal.
    const title = 'No yaac server selected'
    return failure({
      title,
      detail: withoutHeading(message(err), title),
      hint: 'Pick a server below, or add one.',
    })
  }

  // Best-effort, fire-and-forget: the SPA's sign-in cards need the login
  // broker on this machine. Never block or fail the window on it — a failed
  // spawn just leaves the cards saying what to run.
  void deps.ensureAuthDaemon(target).catch(() => { /* best-effort */ })

  deps.onStatus(`Connecting to ${target.baseUrl}…`)
  try {
    await deps.probeIdentity()
  } catch (err) {
    // Unreachable, or this device was not identified — the client's own
    // message says which, verbatim. The hint names a command only for a server on
    // THIS machine, where there is one to name: this page is now the whole
    // window for a desktop-only user, so it is where they learn how to
    // bring their own server back.
    return failure({
      title: `Could not connect to ${target.baseUrl}`,
      detail: message(err),
      hint: isLoopbackOrigin(target.baseUrl)
        ? 'Start it with `yaac server start` (or `yaac cluster install`), then '
          + 'Try again — or pick a different server below.'
        : 'Check that the server is running, then connect again — or pick a '
          + 'different server below.',
    })
  }

  // Trailing slashes stripped so both origin shapes load as `<origin>/`
  // (target.baseUrl is already bare).
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
  // The resolver indents its continuation lines under the heading; without
  // it they are the whole body, so give them back the left margin.
  return rest.map((line) => line.replace(/^ {4}/, '')).join('\n').trim()
}

import { readBuildId } from '@/lib/build-id'
import { isLockLive, readLock, type DaemonLock } from '@/lib/daemon/lock'
import type { DaemonErrorBody } from '@/lib/daemon/errors'
import { authUpdate } from '@/commands/auth-update'

export interface GetClientOptions {
  /**
   * Injected for tests. Resolves to a live lock and returns the
   * bearer/port to use for requests.
   */
  resolveLock?: () => Promise<DaemonLock>
  fetchImpl?: typeof fetch
  /**
   * Interactive "please re-authenticate" handler. Invoked once when the
   * daemon replies with `AUTH_REQUIRED`; after it resolves the request
   * is retried once. The CLI wires this to `authUpdate`; tests inject
   * their own.
   */
  onAuthRequired?: () => Promise<void>
}

/**
 * Returns a fetch-shaped function that targets the local daemon:
 * resolves (and caches) the lock, injects the bearer header, and
 * handles BAD_BEARER / AUTH_REQUIRED retry. Input paths may be a
 * bare pathname or a full URL — only the path+search are used; the
 * host is always the current live daemon. Consumed by the typed
 * Hono RPC client in `daemon-rpc-client.ts`.
 */
export async function createDaemonFetch(
  opts: GetClientOptions = {},
): Promise<(input: string, init?: RequestInit) => Promise<Response>> {
  const resolveLock = opts.resolveLock ?? defaultResolveLock
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const onAuthRequired = opts.onAuthRequired ?? defaultAuthUpdate

  let lock = await resolveLock()

  return async (input, init = {}) => {
    const pathAndSearch = extractPathAndSearch(input)
    const send = (): Promise<Response> => fetchImpl(
      `http://127.0.0.1:${lock.port}${pathAndSearch}`,
      withAuth(init, lock.secret),
    )

    let res = await send()
    if (res.status !== 401) return res

    const body = await peekErrorBody(res)
    if (body?.error.code === 'BAD_BEARER') {
      const refreshed = await resolveLock()
      if (refreshed.secret !== lock.secret || refreshed.port !== lock.port) {
        lock = refreshed
        res = await send()
      }
    } else if (body?.error.code === 'AUTH_REQUIRED') {
      await onAuthRequired()
      res = await send()
      // A second AUTH_REQUIRED is fatal — let the caller surface it.
    }
    return res
  }
}

function extractPathAndSearch(input: string): string {
  if (input.startsWith('/')) return input
  const url = new URL(input)
  return `${url.pathname}${url.search}`
}

function withAuth(init: RequestInit, secret: string): RequestInit {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', `Bearer ${secret}`)
  headers.set('accept', 'application/json')
  return { ...init, headers }
}

async function peekErrorBody(res: Response): Promise<DaemonErrorBody | null> {
  try {
    // `Response.json()` consumes the body — clone so the fall-through
    // error path can still read it.
    return await res.clone().json() as DaemonErrorBody
  } catch {
    return null
  }
}

export async function toClientError(
  res: { status: number; json(): Promise<unknown> },
): Promise<Error> {
  try {
    const body = await res.json() as DaemonErrorBody
    return new Error(body.error.message)
  } catch {
    return new Error(`daemon returned ${res.status}`)
  }
}

/**
 * Default `AUTH_REQUIRED` recovery: run the interactive `auth update`
 * flow.
 */
async function defaultAuthUpdate(): Promise<void> {
  await authUpdate()
}

/**
 * Pure decision: is this lock usable, and if not, why? Callers surface
 * the message to the user with instructions on how to recover. Kept
 * pure so unit tests can exercise every branch without I/O.
 */
export function describeLockMismatch(
  lock: DaemonLock | null,
  isLive: boolean,
  cliBuildId: string,
): string | null {
  if (!lock || !isLive) {
    return 'yaac daemon is not running. Start it with: yaac daemon start'
  }
  if (lock.buildId !== cliBuildId) {
    return (
      'yaac daemon is running an outdated version '
      + `(daemon buildId ${lock.buildId}, CLI buildId ${cliBuildId}). `
      + 'Restart it with: yaac daemon restart'
    )
  }
  return null
}

/**
 * Look up the live daemon for this CLI invocation. Commands call this
 * before every daemon request. If the daemon isn't running or is the
 * wrong version, throw with a message telling the user exactly which
 * command to run.
 *
 * - If `YAAC_DAEMON_URL` + `YAAC_DAEMON_SECRET` are set, use them
 *   directly. This is the test injection hook: tests boot an
 *   in-process daemon and point the CLI at it without writing the
 *   shared `~/.yaac/.daemon.lock`. Production never sets these.
 */
async function defaultResolveLock(): Promise<DaemonLock> {
  const envUrl = process.env.YAAC_DAEMON_URL
  const envSecret = process.env.YAAC_DAEMON_SECRET
  if (envUrl && envSecret) {
    const url = new URL(envUrl)
    return {
      pid: -1,
      port: Number(url.port),
      secret: envSecret,
      startedAt: 0,
      buildId: process.env.YAAC_DAEMON_BUILD_ID ?? '',
    }
  }

  const cliBuildId = await readBuildId()
  const existing = await readLock()
  const live = existing ? await isLockLive(existing) : false
  const mismatch = describeLockMismatch(existing, live, cliBuildId)
  if (mismatch) throw new Error(mismatch)
  return existing as DaemonLock
}

/**
 * Print the error's message and exit 1. Calls `process.exit` —
 * never returns.
 */
export function exitOnClientError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  console.error(message)
  process.exit(1)
}

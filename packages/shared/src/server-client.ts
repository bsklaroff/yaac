import { hc } from 'hono/client'
import { readBuildId } from '#build-id'
import { testEnv } from '#env'
import { isLockLive, readLock, type ServerLock } from '#lock'
import { readRemote } from '#remote'
import type { ServerErrorBody } from '#errors'
import type { AppType } from '@yaac/server/server'

/**
 * Where a CLI invocation sends its requests. Local lock, configured
 * remote, and the test env hatch all resolve to this one shape.
 */
export interface ServerTarget {
  /** Origin (no trailing slash), e.g. http://127.0.0.1:8787. */
  baseUrl: string
  /** Bearer: the lock secret locally, a durable token remotely. */
  secret: string
  /** True when resolved from remote.json — drives error wording and the build-skew warning. */
  remote: boolean
}

export interface GetClientOptions {
  /**
   * Injected for tests. Resolves the server target (base URL + bearer)
   * to use for requests.
   */
  resolveTarget?: () => Promise<ServerTarget>
  fetchImpl?: typeof fetch
  /**
   * Interactive "please re-authenticate" handler. Invoked once when the
   * server replies with `AUTH_REQUIRED`; after it resolves the request
   * is retried once. Provided by the caller so this shared module has
   * no value-level dependency on the interactive `authUpdate` command
   * (which would create a `shared → @/commands` edge). The CLI wires
   * this to `authUpdate` once in `src/cli.ts`; tests inject their own.
   */
  onAuthRequired?: () => Promise<void>
}

/**
 * Returns a fetch-shaped function that targets the resolved server:
 * caches the target, injects the bearer header, and handles
 * BAD_BEARER / AUTH_REQUIRED retry. Input paths may be a bare pathname
 * or a full URL — only the path+search are used; the host is always
 * the resolved target. Consumed by `getRpcClient`.
 */
export async function createServerFetch(
  opts: GetClientOptions = {},
): Promise<(input: string, init?: RequestInit) => Promise<Response>> {
  const resolveTarget = opts.resolveTarget ?? resolveServerTarget
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const onAuthRequired = opts.onAuthRequired ?? (async () => { /* no-op */ })

  let target = await resolveTarget()
  // Once per client: a remote server and this CLI upgrade independently,
  // so surface (but don't fail on) a build mismatch. Local targets never
  // get here skewed — the lock resolution hard-fails first. Checked
  // lazily so purely-local use never touches the build-id file.
  let buildSkewChecked = false

  return async (input, init = {}) => {
    const pathAndSearch = extractPathAndSearch(input)
    const send = (): Promise<Response> => fetchImpl(
      `${target.baseUrl}${pathAndSearch}`,
      withAuth(init, target.secret),
    )

    let res = await send()
    if (target.remote && !buildSkewChecked && res.headers.get('x-yaac-build-id')) {
      buildSkewChecked = true
      const cliBuildId = await readBuildId().catch(() => null)
      const skew = cliBuildId
        ? describeBuildSkew(res.headers.get('x-yaac-build-id'), cliBuildId)
        : null
      if (skew) console.error(skew)
    }
    if (res.status !== 401) return res

    const body = await peekErrorBody(res)
    if (body?.error.code === 'BAD_BEARER') {
      const refreshed = await resolveTarget()
      if (refreshed.secret !== target.secret || refreshed.baseUrl !== target.baseUrl) {
        target = refreshed
        res = await send()
      } else if (target.remote) {
        // Re-resolving can't help a remote target (there is no lock to
        // re-read); tell the user how to fix the token instead.
        throw new Error(
          `remote server at ${target.baseUrl} rejected the token. `
          + 'Mint a new one on the server (yaac auth token create <name>) and run: '
          + `yaac remote set ${target.baseUrl} --token <token>`,
        )
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

async function peekErrorBody(res: Response): Promise<ServerErrorBody | null> {
  try {
    // `Response.json()` consumes the body — clone so the fall-through
    // error path can still read it.
    return await res.clone().json() as ServerErrorBody
  } catch {
    return null
  }
}

export async function toClientError(
  res: { status: number; json(): Promise<unknown> },
): Promise<Error> {
  try {
    const body = await res.json() as ServerErrorBody
    return new Error(body.error.message)
  } catch {
    return new Error(`server returned ${res.status}`)
  }
}

/**
 * Pure decision: is this lock usable, and if not, why? Callers surface
 * the message to the user with instructions on how to recover. Kept
 * pure so unit tests can exercise every branch without I/O.
 */
export function describeLockMismatch(
  lock: ServerLock | null,
  isLive: boolean,
  cliBuildId: string,
): string | null {
  if (!lock || !isLive) {
    return 'yaac server is not running. Start it with: yaac server start'
  }
  if (lock.buildId !== cliBuildId) {
    return (
      'yaac server is running an outdated version '
      + `(server buildId ${lock.buildId}, CLI buildId ${cliBuildId}). `
      + 'Restart it with: yaac server restart'
    )
  }
  return null
}

/**
 * Pure sibling of `describeLockMismatch` for remote targets, where a
 * version difference is expected life (client and server upgrade
 * independently) and only worth a warning. Null when the server didn't
 * report a build id or the ids match.
 */
export function describeBuildSkew(
  serverBuildId: string | null,
  cliBuildId: string,
): string | null {
  if (!serverBuildId || serverBuildId === cliBuildId) return null
  return (
    `warning: remote server build (${serverBuildId}) differs from this CLI `
    + `(${cliBuildId}) — upgrade one of them if commands misbehave`
  )
}

/**
 * Resolve the server target for this CLI invocation. Commands call this
 * before every server request. Precedence:
 *
 * 1. `YAAC_SERVER_URL` + `YAAC_SERVER_SECRET` — the test injection hook:
 *    tests boot an in-process server and point the CLI at it without
 *    writing the shared `~/.yaac/.server.lock`. Production never sets
 *    these. Above remote.json so a test data dir carrying a remote file
 *    can't hijack a hermetic run.
 * 2. An **enabled** `~/.yaac/remote.json` — the configured remote
 *    server, authenticated by its durable token.
 * 3. The local lock (today's behavior): must be live and build-matched,
 *    else throw with the exact recovery command.
 */
export async function resolveServerTarget(): Promise<ServerTarget> {
  const envUrl = testEnv.serverUrlOverride
  const envSecret = testEnv.serverSecretOverride
  if (envUrl && envSecret) {
    return { baseUrl: envUrl.replace(/\/+$/, ''), secret: envSecret, remote: false }
  }

  const remote = await readRemote()
  if (remote?.enabled) {
    return { baseUrl: remote.url, secret: remote.token, remote: true }
  }

  const cliBuildId = await readBuildId()
  const existing = await readLock()
  const live = existing ? await isLockLive(existing) : false
  const mismatch = describeLockMismatch(existing, live, cliBuildId)
  if (mismatch) throw new Error(mismatch)
  const lock = existing as ServerLock
  return { baseUrl: `http://127.0.0.1:${lock.port}`, secret: lock.secret, remote: false }
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

/**
 * Typed Hono RPC client for the server. Returns an `hc<AppType>(...)`
 * proxy whose route methods infer request bodies, params, and
 * response shapes directly from the server's route handlers.
 *
 * The underlying fetch is produced by `createServerFetch`, so lock
 * resolution and AUTH_REQUIRED / BAD_BEARER retry logic are shared.
 *
 * Usage:
 *   const client = await getRpcClient()
 *   const res = await client.project.list.$get()
 */
export async function getRpcClient(opts: GetClientOptions = {}) {
  const serverFetch = await createServerFetch(opts)

  // `hc` bakes the base URL into every request. We discard it via
  // `extractPathAndSearch` and route to the live server's port, so
  // this host is just a placeholder.
  return hc<AppType>('http://server.local/', {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      return serverFetch(url, init)
    },
  })
}

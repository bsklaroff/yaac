import { readBuildId } from '#build-id'
import { testEnv } from '#env'
import { readLock } from '#lock'
import { isLockLive, isSameHostLock, type ServerLock } from '#server-lock-file'
import { readRemote } from '#remote'
import { recordedDriver } from '#install-driver'
import { createApiClient, type FetchLike } from '#api-core'
import type { ServerErrorBody } from '#errors'

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

export interface ApiClientOptions {
  /**
   * Injected for tests. Resolves the server target (base URL + bearer)
   * to use for requests.
   */
  resolveTarget?: () => Promise<ServerTarget>
  fetchImpl?: typeof fetch
  /**
   * False for pure clients that ship no server code (the desktop
   * shell): default target resolution skips the build-id match (see
   * `resolveServerTarget`) and the remote build-skew warning is
   * suppressed — such clients have no build identity to compare.
   * Defaults to true.
   */
  requireBuildMatch?: boolean
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
 * lazily resolves + caches the target, injects the bearer header, and
 * handles BAD_BEARER / AUTH_REQUIRED retry. Input paths may be a bare
 * pathname or a full URL — only the path+search are used; the host is
 * always the resolved target. Consumed by `getApiClient`.
 */
export function createServerFetch(
  opts: ApiClientOptions = {},
): (input: string, init?: RequestInit) => Promise<Response> {
  const requireBuildMatch = opts.requireBuildMatch !== false
  const resolveTarget = opts.resolveTarget ?? (() => resolveServerTarget({ requireBuildMatch }))
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const onAuthRequired = opts.onAuthRequired ?? (async () => { /* no-op */ })

  // Resolved on the first request, not at construction, so a module can hold
  // the client as a singleton: the lock/remote target (and any test env
  // override) is read when the first call goes out, not at import.
  let target: ServerTarget | undefined
  // Once per client: a remote server and this CLI upgrade independently,
  // so surface (but don't fail on) a build mismatch. Local targets never
  // get here skewed — the lock resolution hard-fails first.
  let buildSkewChecked = false

  return async (input, init = {}) => {
    let active = target ?? (target = await resolveTarget())
    const pathAndSearch = extractPathAndSearch(input)
    const send = async (): Promise<Response> => {
      try {
        return await fetchImpl(`${active.baseUrl}${pathAndSearch}`, withAuth(init, active.secret))
      } catch (err) {
        // A transport failure against a configured target is the ordinary
        // "the server is not up" case once the server is a Deployment
        // (docs/server-in-cluster.md): the origin is fixed and always
        // resolvable, so nothing upstream can turn it into the lock
        // resolution's "not running" message. Undici's bare `fetch failed`
        // is what that would otherwise surface as.
        throw new Error(unreachableServerMessage(active.baseUrl, err))
      }
    }

    let res = await send()
    if (requireBuildMatch && active.remote && !buildSkewChecked && res.headers.get('x-yaac-build-id')) {
      buildSkewChecked = true
      const cliBuildId = await readBuildId().catch(() => null)
      const skew = cliBuildId
        ? describeBuildSkew(res.headers.get('x-yaac-build-id'), cliBuildId, active.baseUrl)
        : null
      if (skew) console.error(skew)
    }
    if (res.status !== 401) return res

    const body = await peekErrorBody(res)
    if (body?.error.code === 'BAD_BEARER') {
      const refreshed = await resolveTarget()
      if (refreshed.secret !== active.secret || refreshed.baseUrl !== active.baseUrl) {
        target = refreshed
        active = refreshed
        res = await send()
      } else if (active.remote) {
        // Re-resolving can't help a remote target (there is no lock to
        // re-read); tell the user how to fix the token instead.
        throw new Error(
          `remote server at ${active.baseUrl} rejected the token. `
          + 'Mint a new one on the server (yaac auth token create <name>) and run: '
          + `yaac remote set ${active.baseUrl} --token <token>`,
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

/**
 * Why a request to `origin` did not go out, and what to do about it.
 * Loopback gets the local recovery (start it); anything else is a remote
 * whose reachability is the user's network, not a command of ours.
 */
export function unreachableServerMessage(origin: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  const fix = isLoopbackOrigin(origin)
    ? '\n    Start it with `yaac server start`, or converge the install with '
      + '`yaac cluster install`.'
    : ''
  return `cannot reach the yaac server at ${origin} (${detail})${fix}`
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

/**
 * Pure decision: is this lock usable, and if not, why? Callers surface
 * the message to the user with instructions on how to recover. Kept
 * pure so unit tests can exercise every branch without I/O. A null
 * `cliBuildId` skips the version comparison — client-only callers
 * (`requireBuildMatch: false`) have no build identity to compare.
 */
export function describeLockMismatch(
  lock: ServerLock | null,
  isLive: boolean,
  cliBuildId: string | null,
): string | null {
  if (!lock || !isLive) {
    return 'yaac server is not running. Start it with: yaac server start'
  }
  if (cliBuildId !== null && lock.buildId !== cliBuildId) {
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
  origin?: string,
): string | null {
  if (!serverBuildId || serverBuildId === cliBuildId) return null
  // A loopback "remote" is this machine's own in-cluster server
  // (docs/server-in-cluster.md), where the skew has one cause — the bundle
  // moved and the Deployment has not been rolled onto it — and one fix.
  // Naming it matters because the local LOCK path treats a skew as a hard
  // error with a command attached, and this is what replaced it there.
  const fix = origin !== undefined && isLoopbackOrigin(origin)
    ? ' — roll the server onto this build with `yaac cluster install`'
    : ' — upgrade one of them if commands misbehave'
  return `warning: remote server build (${serverBuildId}) differs from this CLI `
    + `(${cliBuildId})${fix}`
}

/**
 * Whether an origin names a listener on THIS machine.
 *
 * Not the same question as `ServerTarget.remote`, which says only that the
 * target came from `remote.json`. A local k8s install resolves through that
 * file too — `yaac cluster install` writes it, pointing at the published
 * loopback origin (docs/server-in-cluster.md) — so "resolved from
 * remote.json" stopped meaning "on another machine" the moment the server
 * became a pod. Callers that want the second question ask this one.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    // `URL.hostname` keeps the brackets on an IPv6 literal, so `[::1]` never
    // equals `::1` — strip them before comparing.
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, '')
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return false
  }
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
 * 2. An **enabled** `~/.yaac-client/remote.json` — the configured remote
 *    server, authenticated by its durable token.
 * 3. The local lock (today's behavior): must be live and build-matched,
 *    else throw with the exact recovery command.
 *
 * `requireBuildMatch: false` drops the build-match half of step 3: pure
 * clients that ship no server code (the desktop shell) have no build id
 * to read, and any server they can reach serves them the matching SPA —
 * they only need the lock to be live.
 */
export async function resolveServerTarget(
  opts: { requireBuildMatch?: boolean } = {},
): Promise<ServerTarget> {
  const envUrl = testEnv.serverUrlOverride
  const envSecret = testEnv.serverSecretOverride
  if (envUrl && envSecret) {
    return { baseUrl: envUrl.replace(/\/+$/, ''), secret: envSecret, remote: false }
  }

  const remote = await readRemote()
  if (remote?.enabled) {
    return { baseUrl: remote.url, secret: remote.token, remote: true }
  }

  const cliBuildId = opts.requireBuildMatch === false ? null : await readBuildId()
  const existing = await readLock()
  // An in-cluster server is not a target this process can dial: the port
  // in its lock is the one it binds INSIDE its pod, and `127.0.0.1:<that>`
  // here is some unrelated listener — quite possibly another yaac, which
  // would answer and be believed. It is reached through `remote.json`
  // (step 2), which `yaac cluster install` writes; if we are here, that
  // file is missing or disabled, so say which command restores it.
  //
  // Asked of the CLIENT-LOCAL driver record rather than of the lock,
  // because the lock is the server's own file and this process may not be
  // able to read it at all — under k8s it belongs to the pod's uid, and an
  // unreadable lock is indistinguishable from an absent one (`readLock`
  // returns null for both). Keyed off the lock as well for an install that
  // predates the record: a cross-host lock says the same thing.
  const inCluster = await recordedDriver() === 'k8s'
  if (inCluster || (existing && !isSameHostLock(existing))) {
    const held = existing && !isSameHostLock(existing)
      ? ` (lock held by ${existing.host ?? 'another host'})`
      : ''
    throw new Error(
      `This install's server runs in the cluster${held}, `
      + 'but there is no enabled remote.json pointing at it.\n'
      + '    Run `yaac cluster install` to converge the cluster and republish the origin.',
    )
  }
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
export function exitOnApiError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  console.error(message)
  process.exit(1)
}

/**
 * Typed Hono API client for the server. Built by the shared `createApiClient`
 * (so a non-2xx rejects with a `ServerError` and a success resolves to its
 * unwrapped body — callers never check `res.ok` or call `res.json()`), over a
 * fetch from `createServerFetch` (so lock resolution and AUTH_REQUIRED /
 * BAD_BEARER retry logic are shared). Synchronous — the target resolves
 * lazily on the first request — so callers can hold the result as a singleton.
 *
 * Usage:
 *   const projects = await api.project.list.$get()
 */
export function getApiClient(opts: ApiClientOptions = {}) {
  const serverFetch = createServerFetch(opts)

  // `hc` bakes the base URL into every request. `createServerFetch`
  // discards it via `extractPathAndSearch` and routes to the live
  // server's port, so this host is just a placeholder.
  const fetchLike: FetchLike = (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
    return serverFetch(url, init)
  }
  return createApiClient('http://server.local/', fetchLike)
}

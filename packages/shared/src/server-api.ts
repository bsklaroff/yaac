import { readBuildId } from '#build-id'
import { testEnv } from '#env'
import { readServerConfig } from '#server-config'
import { createApiClient, type FetchLike } from '#api-core'

/**
 * Where requests go: an origin, whether the server is on this machine, in
 * its cluster, or remote. No credential is needed; the server identifies
 * the caller from the request.
 */
export interface ServerTarget {
  /** Origin (no trailing slash), e.g. http://127.0.0.1:8787. */
  baseUrl: string
}

export interface ApiClientOptions {
  /** Test hook overriding {@link resolveServerTarget}. */
  resolveTarget?: () => Promise<ServerTarget>
  fetchImpl?: typeof fetch
  /**
   * False for clients with no build id of their own to compare (the
   * desktop shell, the auth daemon). Defaults to true.
   */
  warnOnBuildSkew?: boolean
}

/**
 * A fetch function aimed at the resolved server. The target is resolved on
 * the first request (so the client can be a module singleton) and cached;
 * a build-id mismatch is warned about once. Only the input's path and
 * query are used.
 */
export function createServerFetch(
  opts: ApiClientOptions = {},
): (input: string, init?: RequestInit) => Promise<Response> {
  const warnOnBuildSkew = opts.warnOnBuildSkew !== false
  const resolveTarget = opts.resolveTarget ?? resolveServerTarget
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch

  let target: ServerTarget | undefined
  let buildSkewChecked = false

  return async (input, init = {}) => {
    const active = target ?? (target = await resolveTarget())
    const headers = new Headers(init.headers ?? {})
    headers.set('accept', 'application/json')
    let res: Response
    try {
      res = await fetchImpl(`${active.baseUrl}${extractPathAndSearch(input)}`, { ...init, headers })
    } catch (err) {
      // Usually means the server is not running; replace undici's bare
      // "fetch failed" with a message saying how to start it.
      throw new Error(unreachableServerMessage(active.baseUrl, err))
    }
    if (warnOnBuildSkew && !buildSkewChecked && res.headers.get('x-yaac-build-id')) {
      buildSkewChecked = true
      const cliBuildId = await readBuildId().catch(() => null)
      const skew = cliBuildId
        ? describeBuildSkew(res.headers.get('x-yaac-build-id'), cliBuildId, active.baseUrl)
        : null
      if (skew) console.error(skew)
    }
    return res
  }
}

/**
 * Error text for an unreachable server. A loopback origin also gets the
 * commands that start it.
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

/**
 * A warning when the server's build id differs from this client's; null
 * when they match or the server reported none. Only a warning, since the
 * two upgrade independently.
 */
export function describeBuildSkew(
  serverBuildId: string | null,
  cliBuildId: string,
  origin?: string,
): string | null {
  if (!serverBuildId || serverBuildId === cliBuildId) return null
  // On this machine, skew means the running server predates the install.
  const fix = origin !== undefined && isLoopbackOrigin(origin)
    ? ' — roll the server onto this build with `yaac server restart` '
      + '(or `yaac cluster install`)'
    : ' — upgrade one of them if commands misbehave'
  return `warning: server build (${serverBuildId}) differs from this CLI `
    + `(${cliBuildId})${fix}`
}

/**
 * Whether an origin is on this machine. Host and in-cluster servers are
 * both registered at loopback origins, so this is the only way to tell a
 * local server.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    // `URL.hostname` keeps an IPv6 literal's brackets.
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, '')
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * Resolve the server requests go to: `YAAC_SERVER_URL` (a test hook,
 * checked first so a stray `server.json` in a test data dir cannot win),
 * else the selected entry of `~/.yaac-client/server.json`. Clients never
 * read the server lock file.
 */
export async function resolveServerTarget(): Promise<ServerTarget> {
  const envUrl = testEnv.serverUrlOverride
  if (envUrl) return { baseUrl: envUrl.replace(/\/+$/, '') }

  const cfg = await readServerConfig()
  if (cfg?.enabled && cfg.url !== '') return { baseUrl: cfg.url }
  throw new Error(NO_SERVER_SELECTED)
}

/**
 * Printed when `server.json` selects no server. Lists every command since
 * nothing on disk says which kind of install this is.
 */
export const NO_SERVER_SELECTED =
  'No yaac server selected.\n'
  + '    Start one on this machine with `yaac server start` (or, for a cluster, '
  + '`yaac cluster install` once and then `yaac cluster start`),\n'
  + '    or point at one with `yaac remote set <url>`.'

/** Print the error's message and exit 1. */
export function exitOnApiError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  console.error(message)
  process.exit(1)
}

/**
 * Typed Hono API client for the server (see `createApiClient`), over
 * {@link createServerFetch}. Safe to hold as a singleton.
 *
 * Usage:
 *   const projects = await api.project.list.$get()
 */
export function getApiClient(opts: ApiClientOptions = {}) {
  const serverFetch = createServerFetch(opts)

  // The base URL below is a placeholder; createServerFetch replaces the host.
  const fetchLike: FetchLike = (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
    return serverFetch(url, init)
  }
  return createApiClient('http://server.local', fetchLike)
}

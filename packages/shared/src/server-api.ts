import { readBuildId } from '#build-id'
import { testEnv } from '#env'
import { readServerConfig } from '#server-config'
import { createApiClient, type FetchLike } from '#api-core'
import type { ServerErrorBody } from '#errors'

/**
 * Where a request goes. Every client resolves the same two things — an
 * origin and a bearer — whether the server is a host process on this
 * machine, a pod of this machine's cluster, or a server across the
 * network. There is no local case (see `resolveServerTarget`).
 */
export interface ServerTarget {
  /** Origin (no trailing slash), e.g. http://127.0.0.1:8787. */
  baseUrl: string
  /** Bearer: the durable token this machine holds for the server. */
  secret: string
}

export interface ApiClientOptions {
  /**
   * Injected for tests. Resolves the server target (base URL + bearer)
   * to use for requests.
   */
  resolveTarget?: () => Promise<ServerTarget>
  fetchImpl?: typeof fetch
  /**
   * False for pure clients that ship no server code (the desktop shell,
   * the auth daemon): they have no build identity to compare, and any
   * server they can reach serves them its own matching SPA. Defaults to
   * true.
   */
  warnOnBuildSkew?: boolean
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
  const warnOnBuildSkew = opts.warnOnBuildSkew !== false
  const resolveTarget = opts.resolveTarget ?? resolveServerTarget
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const onAuthRequired = opts.onAuthRequired ?? (async () => { /* no-op */ })

  // Resolved on the first request, not at construction, so a module can hold
  // the client as a singleton: `server.json` (and any test env override) is
  // read when the first call goes out, not at import.
  let target: ServerTarget | undefined
  // Once per client: server and CLI upgrade independently — even on this
  // machine, where the server may be a Deployment carrying an older bundle
  // — so surface a mismatch without failing on it.
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
    if (warnOnBuildSkew && !buildSkewChecked && res.headers.get('x-yaac-build-id')) {
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
        // A `yaac server start` or `yaac cluster install` may have
        // re-registered this machine since the client cached its target.
        target = refreshed
        active = refreshed
        res = await send()
      } else {
        // Nothing changed on disk, so the configured token is genuinely
        // the wrong one. Say how to replace it for either kind of server.
        throw new Error(
          `the yaac server at ${active.baseUrl} rejected the token.\n`
          + '    For a server on this machine, re-register it: `yaac server start` '
          + '(or `yaac cluster install`).\n'
          + '    For one elsewhere, mint a token there (`yaac auth token create '
          + `<name>\`) and run: yaac remote set ${active.baseUrl} --token <token>`,
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
 * A build-id difference between the server and this client, as a warning.
 * Never an error on the request path: they upgrade independently, and even
 * a server on this machine may be a Deployment carrying an older bundle.
 * Null when the server didn't report a build id or the ids match.
 */
export function describeBuildSkew(
  serverBuildId: string | null,
  cliBuildId: string,
  origin?: string,
): string | null {
  if (!serverBuildId || serverBuildId === cliBuildId) return null
  // A loopback origin is a server on this machine (docs/server-in-cluster.md),
  // where the skew has one cause — the bundle moved and the running server
  // has not been rolled onto it — and one pair of fixes.
  const fix = origin !== undefined && isLoopbackOrigin(origin)
    ? ' — roll the server onto this build with `yaac server restart` '
      + '(or `yaac cluster install`)'
    : ' — upgrade one of them if commands misbehave'
  return `warning: server build (${serverBuildId}) differs from this CLI `
    + `(${cliBuildId})${fix}`
}

/**
 * Whether an origin names a listener on THIS machine.
 *
 * The only "is the server local?" question there is. Every target comes
 * from the same place (`server.json`), so nothing about where a target was
 * resolved from says which machine it is on — a host server and an
 * in-cluster one are both registered there, both at a loopback origin.
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
 * Resolve the server every request goes to. Two steps, no local case:
 *
 * 1. `YAAC_SERVER_URL` + `YAAC_SERVER_SECRET` — the test injection hook:
 *    tests boot an in-process server and point the CLI at it without
 *    writing any config. Production never sets these. Above `server.json`
 *    so a test data dir carrying one can't hijack a hermetic run.
 * 2. The **selected** entry of `~/.yaac-client/server.json`, authenticated
 *    by its durable token.
 *
 * A server on this machine is in that file like any other: `yaac server
 * start` registers the host server it spawns, `yaac cluster install` the
 * Deployment it applies (`registerServer` in `#server-config`). So no
 * client reads the lock — which is the server's own file, belongs to the
 * pod's uid under k8s, and carries a port that means nothing off the pod.
 */
export async function resolveServerTarget(): Promise<ServerTarget> {
  const envUrl = testEnv.serverUrlOverride
  const envSecret = testEnv.serverSecretOverride
  if (envUrl && envSecret) {
    return { baseUrl: envUrl.replace(/\/+$/, ''), secret: envSecret }
  }

  const cfg = await readServerConfig()
  if (cfg?.enabled && cfg.url !== '') {
    return { baseUrl: cfg.url, secret: cfg.token }
  }
  throw new Error(NO_SERVER_SELECTED)
}

/**
 * What every client says when `server.json` names no server. All three
 * commands are listed because which one applies is a property of the
 * install, and this message is precisely what is printed when nothing on
 * disk says which kind of install it is.
 */
export const NO_SERVER_SELECTED =
  'No yaac server selected.\n'
  + '    Start one on this machine with `yaac server start` (or `yaac cluster '
  + 'install` on a k8s install),\n'
  + '    or point at one with `yaac remote set <url> --token <token>`.'

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

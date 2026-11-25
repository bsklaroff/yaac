/**
 * The token listener (docs/remote-hosting.md "Token access"): a third
 * listener that admits a caller by bearer token alone, so a program on a
 * machine off the tailnet can use the API as a delegate of the user a
 * token binding names. It serves `delegateApp` and nothing else: no
 * WebSocket route, no SPA, and none of the main listener's header-based
 * identity, so no request here can be `local`.
 *
 * It faces a network, so unlike the main listener it ends TLS itself, keeps
 * Node's request timeouts, caps open connections and answers 429 to a
 * source that keeps failing to authenticate, never to a valid token. A refusal is logged with its
 * source address and reason alone.
 */
import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import { serve, type ServerType } from '@hono/node-server'
import { delegateApp, type ServerAppDeps } from '#main/server'
import { resolveBearer } from '#domain/access'
import { env } from '@yaac/shared/env'

import { tokenTlsDir } from '@yaac/shared/paths'
import { formatTokenListen, parseTokenListen, readTokenTlsDir, tokenPairProblem, type TokenTlsPair } from '@yaac/shared/token-tls'
import { errorText, serverLog } from '#lib/log'

/** How often the certificate directory is re-read. */
const RELOAD_MS = 30_000
/** Failed authentications a source may make in a window before its further
 *  failures are answered 429 until the window ends, and how many sources
 *  are tracked. */
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 60_000
const MAX_TRACKED_SOURCES = 10_000
const MAX_CONNECTIONS = 256

/** Failed authentications per source address in the current window. */
const failures = new Map<string, { count: number; since: number }>()

/** Forget every source's failures (tests). */
export function resetTokenFailures(): void {
  failures.clear()
}

type NodeEnv = { incoming?: Pick<IncomingMessage, 'socket'> } | undefined

/**
 * The listener's fetch: `delegateApp` with the bearer resolver, behind the
 * failure limit. `env` is node-server's, whose socket gives the source
 * address. Every request is resolved, and only one that fails to
 * authenticate counts against its source: past the limit its refusal is a
 * 429 rather than a 401, while a request carrying a valid token is always
 * served. On a cluster every caller can share one source (the forwarder's
 * or a node's address), so refusing those would let anyone lock everyone
 * out; what the limit bounds is the cost of failures, since a token cannot
 * be guessed either way.
 */
export function tokenListenerApp(deps: ServerAppDeps): { fetch: (request: Request, env?: NodeEnv) => Promise<Response> } {
  const app = delegateApp(async (request) => {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')
    return match === null ? undefined : await resolveBearer(match[1])
  }, deps)
  return {
    fetch: async (request, nodeEnv) => {
      const res = await app.fetch(request, nodeEnv)
      if (res.status !== 401) return res
      const source = nodeEnv?.incoming?.socket.remoteAddress ?? 'unknown'
      const now = Date.now()
      const seen = failures.get(source)
      const entry = seen !== undefined && now - seen.since < FAILURE_WINDOW_MS ? seen : { count: 0, since: now }
      entry.count += 1
      failures.delete(source)
      failures.set(source, entry)
      if (failures.size > MAX_TRACKED_SOURCES) failures.delete(failures.keys().next().value as string)
      if (entry.count > MAX_FAILURES) {
        if (entry.count === MAX_FAILURES + 1) {
          serverLog(`[token] answering ${source} 429 for the rest of the minute: too many failed authentications`)
        }
        return Response.json(
          { error: { code: 'TOO_MANY_REQUESTS', message: 'too many failed authentications from this address; try again later' } },
          { status: 429, headers: { 'Retry-After': String(Math.ceil((entry.since + FAILURE_WINDOW_MS - now) / 1000)) } },
        )
      }
      const body = await res.clone().json().catch(() => undefined) as { error?: { message?: string } } | undefined
      serverLog(`[token] refused ${source}: ${body?.error?.message ?? 'unauthenticated'}`)
      return res
    },
  }
}

/**
 * Start the token listener when `YAAC_TOKEN_LISTEN` names one; undefined
 * when it does not. With a certificate pair already in place it binds
 * before returning, so an address that cannot be bound fails the start;
 * without one it binds once a pair appears. A server nested in a workspace
 * refuses it.
 */
export async function startTokenListener(deps: ServerAppDeps): Promise<{ close: () => Promise<void> } | undefined> {
  const raw = env.tokenListen
  if (raw === undefined) return undefined
  if (env.workspaceId !== undefined) {
    throw new Error('a server inside a workspace takes no token listener (YAAC_TOKEN_LISTEN)')
  }
  const listen = parseTokenListen(raw, { wildcard: env.inCluster })
  const dir = tokenTlsDir()
  const app = tokenListenerApp(deps)
  let server: ServerType | undefined
  let loaded: TokenTlsPair | undefined
  let reported: string | undefined

  /** The pair in the directory when it is whole, matches and is current;
   *  otherwise undefined, with why logged once. */
  const readPair = async (): Promise<TokenTlsPair | undefined> => {
    const pair = await readTokenTlsDir(dir).catch((err: unknown) => {
      reportOnce(`cannot read ${dir}: ${errorText(err)}`)
      return undefined
    })
    if (pair === undefined) {
      reportOnce(`waiting for tls.crt and tls.key in ${dir} before listening on ${formatTokenListen(listen)}`)
      return undefined
    }
    const problem = tokenPairProblem(pair)
    if (problem !== null) {
      reportOnce(`the pair in ${dir} is not served: ${problem}`)
      return undefined
    }
    return pair
  }
  const reportOnce = (line: string): void => {
    if (reported === line) return
    reported = line
    serverLog(`[token] ${line}`)
  }

  const bind = (pair: TokenTlsPair): Promise<void> => new Promise((resolve, reject) => {
    const s = serve({
      fetch: app.fetch,
      port: listen.port,
      hostname: listen.address,
      createServer: https.createServer,
      serverOptions: { cert: pair.cert, key: pair.key, requestTimeout: 60_000, headersTimeout: 15_000 },
    }, () => {
      server = s
      loaded = pair
      reported = undefined
      serverLog(`[token] listening on https://${formatTokenListen(listen)}`)
      resolve()
    })
    s.maxConnections = MAX_CONNECTIONS
    s.once('error', reject)
  })

  const first = await readPair()
  if (first !== undefined) await bind(first)
  const timer = setInterval(() => {
    void readPair().then(async (pair) => {
      if (pair === undefined) return
      if (server === undefined) {
        await bind(pair).catch((err: unknown) => reportOnce(`cannot listen on ${formatTokenListen(listen)}: ${errorText(err)}`))
      } else if (pair.cert !== loaded?.cert || pair.key !== loaded.key) {
        (server as https.Server).setSecureContext({ cert: pair.cert, key: pair.key })
        loaded = pair
        serverLog(`[token] loaded a new certificate from ${dir}`)
      }
    })
  }, RELOAD_MS)
  timer.unref()
  return {
    close: () => new Promise<void>((resolve) => {
      clearInterval(timer)
      if (server === undefined) resolve()
      else server.close(() => resolve())
    }),
  }
}

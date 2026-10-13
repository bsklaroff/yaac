/**
 * A stand-in yaac server on a loopback port, so CLI command tests fake the
 * HTTP and WebSocket boundary rather than the CLI's own modules. The CLI's
 * API client resolves its target once per process, so a test file starts
 * one with `startFakeApi` and points `YAAC_SERVER_URL` at it before its
 * first command.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'

/** What a route answers: a JSON body, or NDJSON events as a stream. */
export type FakeReply = { status?: number; json?: unknown } | { ndjson: object[] }

export interface FakeRequest {
  /** `METHOD /path`, query string dropped. */
  route: string
  query: URLSearchParams
  body: unknown
}

export interface FakeApi {
  url: string
  /** Every request seen, terminal attaches (`GET /api/pty/attach`) included. */
  requests: FakeRequest[]
  /** Answer `route` (`METHOD /path`) with `reply`, until replaced. */
  on(route: string, reply: FakeReply | ((req: FakeRequest) => FakeReply)): void
  /** Forget every route and request. */
  reset(): void
  close(): Promise<void>
}

/**
 * Start the fake. An unknown route answers 404 NOT_FOUND, as the server
 * does; a terminal attach opens and is closed at once, as a tmux detach
 * would end it.
 */
export async function startFakeApi(): Promise<FakeApi> {
  const routes = new Map<string, FakeReply | ((req: FakeRequest) => FakeReply)>()
  const requests: FakeRequest[] = []

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      const text = Buffer.concat(chunks).toString('utf8')
      const seen: FakeRequest = {
        route: `${req.method ?? 'GET'} ${url.pathname}`,
        query: url.searchParams,
        body: text === '' ? undefined : JSON.parse(text) as unknown,
      }
      requests.push(seen)
      const handler = routes.get(seen.route)
      const reply = typeof handler === 'function' ? handler(seen) : handler
      if (reply === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `no route ${seen.route}` } }))
      } else if ('ndjson' in reply) {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.end(reply.ndjson.map((e) => `${JSON.stringify(e)}\n`).join(''))
      } else if (reply.json === undefined) {
        res.writeHead(reply.status ?? 204)
        res.end()
      } else {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply.json))
      }
    })
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    requests.push({ route: `GET ${url.pathname}`, query: url.searchParams, body: undefined })
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(1000))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    on: (route, reply) => { routes.set(route, reply) },
    reset: () => {
      routes.clear()
      requests.length = 0
    },
    close: () => new Promise<void>((resolve) => {
      wss.close()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

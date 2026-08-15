import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import crypto from 'node:crypto'
import {
  createYaacTestEnv,
  spawnYaacServer,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'

/**
 * Every WebSocket the webapp holds open must negotiate permessage-deflate.
 *
 * This is a tripwire, not a feature test. The server cannot ask
 * @hono/node-ws for compression — it builds its WebSocketServer itself with
 * no options pass-through — so server-run sets it on the returned `wss`
 * afterwards, which works only because `ws` reads that option once per
 * upgrade rather than in its constructor. Nothing about that arrangement is
 * load-bearing to `ws`'s API contract, so a version bump could move the read
 * into the constructor and silently drop compression from the whole app: the
 * sockets would keep working, and only a slow link would ever notice. Hence
 * an assertion on the negotiated extension itself.
 *
 * The handshake is done by hand rather than with a WebSocket client because
 * the answer lives in the upgrade response headers, which is exactly where a
 * client would hide it.
 */

/** Complete a WebSocket upgrade and resolve the server's response headers.
 *  Rejects if the server answers with a plain HTTP response instead. */
function upgrade(
  port: number,
  path: string,
  secret: string,
): Promise<http.IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        authorization: `Bearer ${secret}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
        // What a browser offers. The server may only answer with an
        // extension the client put on the table, so the offer is part of
        // what's being asserted.
        'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits',
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.headers)
    })
    req.on('response', (res) => {
      res.resume()
      reject(new Error(`no upgrade: HTTP ${res.statusCode ?? 0}`))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('WebSocket compression', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer

  // One server for the file: both cases are a single upgrade against an
  // otherwise untouched server, and neither mutates any state.
  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
    server = await spawnYaacServer(testEnv.env)
  })

  afterAll(async () => {
    await server.stop()
    await testEnv.cleanup()
  })

  it('negotiates permessage-deflate on the snapshot and terminal sockets', async () => {
    // /events carries the whole server snapshot on every state change and is
    // the most compressible payload in the app; /pty/attach carries the
    // ANSI-heavy terminal repaints. The PTY route closes the socket right
    // after the upgrade here (no such worktree), which is fine — the
    // handshake, and so the negotiation, has already happened by then.
    for (const path of ['/events', '/pty/attach?id=nonexistent']) {
      const headers = await upgrade(server.lock.port, path, server.lock.secret)
      expect(headers['sec-websocket-extensions'], path).toMatch(/permessage-deflate/)
    }
  })

  it('still refuses an unauthenticated upgrade', async () => {
    // Compression is negotiated by the same `ws` server for every route, so
    // it must not have become a way to reach one without a credential: the
    // auth middleware runs on the upgrade request like any other.
    await expect(upgrade(server.lock.port, '/events', 'not-the-secret'))
      .rejects.toThrow(/no upgrade: HTTP 401/)
  })
})

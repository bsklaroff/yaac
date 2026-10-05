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
 * Nothing visible breaks if a dependency bump stops the server's
 * compression setting from reaching `ws`, so this test catches that.
 *
 * The handshake is done by hand because a WebSocket client hides the
 * upgrade response headers.
 */

/** Complete a WebSocket upgrade and resolve the server's response headers.
 *  Rejects if the server answers with a plain HTTP response instead. */
function upgrade(
  port: number,
  path: string,
  host = `127.0.0.1:${String(port)}`,
): Promise<http.IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
        // What a browser offers; the server can only accept an offered
        // extension.
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

const TAILNET_HOST = 'srv.tailnet.ts.net'

describe('WebSocket compression', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer

  // One server for the file; no case mutates state. It admits a tailnet
  // name, so the refusal below comes from the identity gate, not the Host
  // guard.
  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
    server = await spawnYaacServer({ ...testEnv.env, YAAC_ALLOWED_HOSTS: TAILNET_HOST })
  })

  afterAll(async () => {
    await server.stop()
    await testEnv.cleanup()
  })

  it('negotiates permessage-deflate on the snapshot and terminal sockets', async () => {
    // The PTY route closes the socket right after the upgrade (no such
    // workspace), but negotiation has already happened by then.
    for (const path of ['/api/events', '/api/pty/attach?id=nonexistent']) {
      const headers = await upgrade(server.lock.port, path)
      expect(headers['sec-websocket-extensions'], path).toMatch(/permessage-deflate/)
    }
  })

  // An empty id must never match whichever workspace the runtime lists
  // first, so it is refused before any lookup.
  it('refuses an attach with no workspace id, before upgrading', async () => {
    for (const path of ['/api/pty/attach', '/api/pty/attach?id=', '/api/forward/attach?port=80', '/api/acp/attach?session=s1']) {
      await expect(upgrade(server.lock.port, path), path)
        .rejects.toThrow(/no upgrade: HTTP 400/)
    }
    // The session id is later joined into a path, so its charset is
    // checked first.
    await expect(upgrade(server.lock.port, '/api/acp/attach?id=x&session=..%2F..%2Fetc'))
      .rejects.toThrow(/no upgrade: HTTP 400/)
  })

  it('still refuses an unidentified upgrade', async () => {
    // The identity gate still runs on the upgrade request (here a tailnet
    // name reached without tailscale serve).
    await expect(upgrade(server.lock.port, '/api/events', TAILNET_HOST))
      .rejects.toThrow(/no upgrade: HTTP 401/)
  })
})

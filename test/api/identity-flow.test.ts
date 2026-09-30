import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import WebSocket from 'ws'
import {
  createYaacTestEnv,
  spawnYaacServer,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { asTailnet } from '@yaac/test-utils/api'

/**
 * How the server identifies a caller, over real sockets
 * (docs/remote-hosting.md). Loopback is local; a request `tailscale serve`
 * stamped with a user is that tailnet user; a request through serve with no
 * user, or at a tailnet name without serve, is refused with a message
 * saying which. The same four cases are checked on a WebSocket upgrade.
 *
 * One server serves the file. It admits a tailnet name, so requests reach
 * the identity gate instead of stopping at the Host guard.
 */
const TAILNET_HOST = 'srv.tailnet.ts.net'

describe('identity flow (real server)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer

  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
    server = await spawnYaacServer({ ...testEnv.env, YAAC_ALLOWED_HOSTS: TAILNET_HOST })
  })

  afterAll(async () => {
    await server.stop()
    await testEnv.cleanup()
  })

  /** A raw request, because fetch() silently drops a Host override. */
  function whoami(headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: server.lock.port, path: '/api/whoami', headers },
        (res) => {
          let raw = ''
          res.on('data', (c: Buffer) => { raw += c.toString() })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as unknown }))
        },
      )
      req.on('error', reject)
      req.end()
    })
  }

  /** The status a WebSocket upgrade to /events is answered with: 101, or the refusal. */
  function upgradeStatus(headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(server.lock.port)}/api/events`, { headers })
      ws.once('upgrade', () => { ws.terminate(); resolve(101) })
      ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode ?? 0) })
      ws.once('error', reject)
    })
  }

  const local = { host: '127.0.0.1' }
  const cases: Array<[string, () => Record<string, string>, number]> = [
    ['a loopback request', () => local, 200],
    ['a tailnet user through serve', () => asTailnet('alice@example.com', TAILNET_HOST), 200],
    ['serve with no user (tagged device, Funnel)', () => asTailnet(null, TAILNET_HOST), 401],
    ['the tailnet name without serve', () => ({ host: TAILNET_HOST }), 401],
  ]

  it('identifies each kind of caller, or says why it cannot', async () => {
    expect(await whoami(local)).toEqual({ status: 200, body: { kind: 'local' } })
    expect(await whoami(asTailnet('alice@example.com', TAILNET_HOST))).toEqual({
      status: 200, body: { kind: 'tailnet', login: 'alice@example.com', name: 'alice' },
    })
    expect(await whoami(asTailnet(null, TAILNET_HOST))).toMatchObject({
      status: 401, body: { error: { code: 'UNAUTHENTICATED', message: expect.stringMatching(/tagged device.*Funnel/s) as unknown } },
    })
    expect(await whoami({ host: TAILNET_HOST })).toMatchObject({
      status: 401, body: { error: { message: expect.stringMatching(/without tailscale serve/) as unknown } },
    })
  })

  it('applies the same rule to a WebSocket upgrade', async () => {
    for (const [what, headers, status] of cases) {
      expect(await upgradeStatus(headers()), what).toBe(status === 200 ? 101 : status)
    }
  })

  it('admits an extra Host only via YAAC_ALLOWED_HOSTS', async () => {
    // The Host guard runs before the identity check.
    expect((await whoami(asTailnet('alice@example.com', 'other.ts.net'))).status).toBe(403)
  })

  it('keeps the database directory at 0700', async () => {
    // The sealed secrets inside are only as private as the directory.
    const stat = await fs.stat(path.join(testEnv.dataDir, 'server-local', 'db'))
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
  })
})

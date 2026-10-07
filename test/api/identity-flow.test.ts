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
 * (docs/remote-hosting.md). In tailnet mode a request `tailscale serve`
 * stamped with a user is that tailnet user; serve with no user, the tailnet
 * name without serve, and plain loopback are refused with a message saying
 * which. The same cases are checked on a WebSocket upgrade. In local mode
 * only loopback is admitted, and switching a local install to tailnet hands
 * its built-in user to the `--owner` login.
 */
const TAILNET_HOST = 'srv.tailnet.ts.net'
const BUILT_IN_USER_ID = '00000000-0000-0000-0000-000000000000'

/** A raw request, because fetch() silently drops a Host override. */
function request(
  port: number,
  headers: Record<string, string>,
  opts: { path?: string; method?: string; body?: string } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: opts.path ?? '/api/whoami', method: opts.method ?? 'GET', headers },
      (res) => {
        let raw = ''
        res.on('data', (c: Buffer) => { raw += c.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as unknown }))
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

const local = { host: '127.0.0.1' }

describe('identity flow in tailnet mode (real server)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer

  // One server for the file's reads. It admits the tailnet name, so
  // requests reach the identity gate instead of stopping at the Host guard.
  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
    server = await spawnYaacServer({ ...testEnv.env, YAAC_ACCESS_MODE: 'tailnet', YAAC_ALLOWED_HOSTS: TAILNET_HOST })
  })

  afterAll(async () => {
    await server.stop()
    await testEnv.cleanup()
  })

  const whoami = (headers: Record<string, string>): Promise<{ status: number; body: unknown }> =>
    request(server.lock.port, headers)

  /** The status a WebSocket upgrade to /events is answered with: 101, or the refusal. */
  function upgradeStatus(headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(server.lock.port)}/api/events`, { headers })
      ws.once('upgrade', () => { ws.terminate(); resolve(101) })
      ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode ?? 0) })
      ws.once('error', reject)
    })
  }

  const cases: Array<[string, () => Record<string, string>, number]> = [
    ['a tailnet user through serve', () => asTailnet('alice@example.com', TAILNET_HOST), 200],
    ['plain loopback', () => local, 401],
    ['serve with no user (tagged device, Funnel)', () => asTailnet(null, TAILNET_HOST), 401],
    ['the tailnet name without serve', () => ({ host: TAILNET_HOST }), 401],
  ]

  it('identifies each kind of caller as a user, or says why it cannot', async () => {
    const alice = await whoami(asTailnet('alice@example.com', TAILNET_HOST))
    expect(alice).toMatchObject({
      status: 200, body: { kind: 'tailnet', login: 'alice@example.com', name: 'alice' },
    })
    const { userId } = alice.body as { userId: string }
    // A fresh tailnet install's built-in user has no login and is not listed.
    expect((alice.body as { users: unknown[] }).users).toContainEqual({ id: userId, login: 'alice@example.com', name: 'alice' })
    expect((alice.body as { users: Array<{ id: string }> }).users.map((u) => u.id)).not.toContain(BUILT_IN_USER_ID)
    expect(await whoami(local)).toMatchObject({
      status: 401, body: { error: { code: 'UNAUTHENTICATED', message: expect.stringMatching(/runs in tailnet mode/) as unknown } },
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

  it('lets a containerless yaac-mama call over loopback reach its route, which checks the bearer', async () => {
    const res = await request(server.lock.port, { ...local, 'content-type': 'application/json', authorization: 'Bearer nope' }, {
      path: '/api/workspace/mama', method: 'POST', body: JSON.stringify({ command: 'list' }),
    })
    expect(res).toMatchObject({ status: 401, body: { error: { message: expect.stringMatching(/yaac-mama credential/) as unknown } } })
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

describe('local mode, and switching it to tailnet (real server)', () => {
  let testEnv: YaacTestEnv

  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterAll(async () => {
    await testEnv.cleanup()
  })

  it('admits only loopback until --owner switches it, which gives the owner its data', async () => {
    const localServer = await spawnYaacServer({ ...testEnv.env, YAAC_ALLOWED_HOSTS: TAILNET_HOST })
    try {
      expect(await request(localServer.lock.port, local)).toMatchObject({
        status: 200, body: { kind: 'local', userId: BUILT_IN_USER_ID, users: [{ id: BUILT_IN_USER_ID, login: null }] },
      })
      expect(await request(localServer.lock.port, asTailnet('alice@example.com', TAILNET_HOST))).toMatchObject({
        status: 401, body: { error: { message: expect.stringMatching(/runs in local mode.*--tailnet/s) as unknown } },
      })
    } finally {
      await localServer.stop()
    }

    const switched = await spawnYaacServer({
      ...testEnv.env,
      YAAC_ACCESS_MODE: 'tailnet',
      YAAC_ACCESS_OWNER: 'alice@example.com',
      YAAC_ALLOWED_HOSTS: TAILNET_HOST,
    })
    try {
      // Everything the built-in user owned is now alice's, since she is it.
      expect(await request(switched.lock.port, asTailnet('alice@example.com', TAILNET_HOST))).toMatchObject({
        status: 200,
        body: { kind: 'tailnet', userId: BUILT_IN_USER_ID, users: [{ id: BUILT_IN_USER_ID, login: 'alice@example.com', name: 'alice' }] },
      })
      const bob = await request(switched.lock.port, asTailnet('bob@example.com', TAILNET_HOST))
      expect((bob.body as { userId: string }).userId).not.toBe(BUILT_IN_USER_ID)
    } finally {
      await switched.stop()
    }
  })
})

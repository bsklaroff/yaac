import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { CLAUDE_STUB } from '@yaac/test-utils/fixtures'

/**
 * The auth-daemon relay end to end with real processes: a spawned main
 * server, `yaac auth update` auto-starting a real auth server on this
 * machine, the stubbed vendor CLI completing a "browser" login, and the
 * captured bundle landing back on the main server over RPC. Plus the
 * `yaac auth server` lifecycle commands and the raw /agent/auth wire.
 *
 * One main server serves the whole file. Each test needs only the auth
 * server isolated, and the afterEach stops it, so every case starts with
 * no agent connected.
 */
describe('yaac auth server (real CLI + real servers)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer

  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
    server = await spawnYaacServer(testEnv.env)
  })

  afterEach(async () => {
    await runYaac(testEnv.env, 'auth', 'server', 'stop')
  })

  afterAll(async () => {
    await server.stop()
    // Reaps any auth-server straggler by pid.
    await testEnv.cleanup()
  })

  it('auth update runs the relayed login and the bundle lands on the main server', async () => {
    const env = {
      ...testEnv.env,
      YAAC_E2E_CLAUDE_LOGIN_CLI: JSON.stringify([process.execPath, CLAUDE_STUB]),
    }

    const res = await runYaac(env, 'auth', 'update', { stdin: '2\n' })
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/Claude Code credentials saved/)
    // The relayed output surfaced the vendor CLI's sign-in URL.
    expect(res.stdout).toMatch(/claude\.com\/cai\/oauth/)

    const creds = JSON.parse(await fs.readFile(
      path.join(testEnv.dataDir, 'server-local', '.credentials', 'claude.json'), 'utf8',
    )) as { kind: string; claudeAiOauth: { accessToken: string } }
    expect(creds.kind).toBe('oauth')
    expect(creds.claudeAiOauth.accessToken).toBe('sk-ant-oat01-fake-web-login')
  })

  it('start / status / stop drive the broker lifecycle', async () => {
    const start = await runYaac(testEnv.env, 'auth', 'server', 'start')
    expect(start.exitCode, start.stderr).toBe(0)
    expect(start.stderr).toMatch(/auth server started/)

    // status reports running and (once the socket lands) connected.
    let connected = false
    for (let i = 0; i < 20 && !connected; i++) {
      const status = await runYaac(testEnv.env, 'auth', 'server', 'status')
      expect(status.exitCode).toBe(0)
      expect(status.stdout).toMatch(/running \(pid \d+\)/)
      connected = /connected:\s+yes/.test(status.stdout)
      if (!connected) await new Promise((r) => setTimeout(r, 250))
    }
    expect(connected).toBe(true)

    const again = await runYaac(testEnv.env, 'auth', 'server', 'start')
    expect(again.exitCode).toBe(0)
    expect(again.stderr).toMatch(/already running/)

    const stop = await runYaac(testEnv.env, 'auth', 'server', 'stop')
    expect(stop.exitCode).toBe(0)
    expect(stop.stderr).toMatch(/stopped/)

    const status = await runYaac(testEnv.env, 'auth', 'server', 'status')
    expect(status.stdout).toMatch(/not running/)
  })

  it('seeds the server git identity from this machine, and never overwrites one', async () => {
    // The seed runs before the auth server writes its lock, and `start`
    // returns once the lock exists, so each check follows a finished seed.
    const base = `http://127.0.0.1:${server.lock.port}`
    const identity = async (): Promise<unknown> =>
      ((await (await fetch(`${base}/api/config/git-identity`)).json()) as { identity: unknown }).identity
    const gitConfig = testEnv.env.GIT_CONFIG_GLOBAL!
    await fs.writeFile(gitConfig, '[user]\n\tname = Seeded User\n\temail = seeded@example.com\n')
    try {
      expect(await identity()).toBeNull()
      expect((await runYaac(testEnv.env, 'auth', 'server', 'start')).exitCode).toBe(0)
      expect(await identity()).toEqual({ name: 'Seeded User', email: 'seeded@example.com' })
      await runYaac(testEnv.env, 'auth', 'server', 'stop')

      // An identity the user set survives a restart with a different git
      // config.
      const set = await runYaac(
        testEnv.env, 'config', 'git-identity', '--name', 'Chosen User', '--email', 'chosen@example.com',
      )
      expect(set.exitCode, set.stderr).toBe(0)
      expect((await runYaac(testEnv.env, 'auth', 'server', 'start')).exitCode).toBe(0)
      expect(await identity()).toEqual({ name: 'Chosen User', email: 'chosen@example.com' })
    } finally {
      await fs.writeFile(gitConfig, '')
    }
  })

  it('without an agent, webapp-shaped login starts get actionable 503 guidance', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.lock.port}/api/auth/claude/login/start`,
      { method: 'POST' },
    )
    expect(res.status).toBe(503)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('AUTH_AGENT_DISCONNECTED')
    expect(body.error.message).toMatch(/yaac auth (update|server start)/)
  })

  it('a raw agent socket flips /auth/agent and dropping it fails running flows', async () => {
    const base = `http://127.0.0.1:${server.lock.port}`

    const ws = new WebSocket(`ws://127.0.0.1:${server.lock.port}/api/agent/auth`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    const connected = await (await fetch(`${base}/api/auth/agent`)).json() as { connected: boolean }
    expect(connected.connected).toBe(true)

    // Start a login; the fake agent receives the op with the flow id.
    const opReceived = new Promise<{ op: string; id: string; tool: string }>((resolve) => {
      ws.once('message', (data: Buffer) => resolve(JSON.parse(data.toString('utf8')) as { op: string; id: string; tool: string }))
    })
    const start = await fetch(`${base}/api/auth/claude/login/start`, { method: 'POST' })
    expect(start.status).toBe(200)
    const view = await start.json() as { id: string; status: string }
    expect(view.status).toBe('running')
    const op = await opReceived
    expect(op).toMatchObject({ op: 'start', id: view.id, tool: 'claude' })

    // Agent pushes a view; the poll route serves it.
    ws.send(JSON.stringify({
      op: 'view', kind: 'login',
      view: { id: view.id, tool: 'claude', status: 'running', output: 'visit https://sign.in' },
    }))
    await new Promise((r) => setTimeout(r, 200))
    const polled = await (await fetch(`${base}/api/auth/login/${view.id}`)).json() as { output?: string }
    expect(polled.output).toBe('visit https://sign.in')

    // Dropping the socket fails the running flow and flips connectivity.
    ws.close()
    await new Promise((r) => setTimeout(r, 300))
    const after = await (await fetch(`${base}/api/auth/login/${view.id}`)).json() as { status: string; error?: string }
    expect(after.status).toBe('error')
    expect(after.error).toMatch(/disconnected/)
    const disconnected = await (await fetch(`${base}/api/auth/agent`)).json() as { connected: boolean }
    expect(disconnected.connected).toBe(false)
  })
})

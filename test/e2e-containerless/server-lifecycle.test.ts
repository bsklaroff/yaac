import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createYaacTestEnv, spawnYaacServer, runYaac, TEST_CLI_ENTRY, type YaacTestEnv } from '#support/cli'
import { asTailnet } from '@yaac/test-utils/api'
import { readLock, serverLockPath } from '@yaac/shared/lock'
import type { ServerLock } from '@yaac/shared/server-lock-file'
import { MAX_PORT_PROBES } from '@yaac/shared/server-port'
import { serverLogPath } from '@yaac/shared/paths'
import { readServerConfig } from '@yaac/shared/server-config'
import { readInstallRecord } from '@yaac/shared/install-record'
import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * The server as a host process: binding, the lock file, `start`/`stop`/
 * `restart`, and `logs`. Only the containerless server is a host process;
 * under k8s it is a Deployment (docs/server-in-cluster.md) driven by
 * `yaac cluster start|stop|restart|logs|status`, covered by
 * test/e2e-cli/server.test.ts.
 */

/**
 * One host install, walked through by every case below: they share its data
 * dir, and a case that needs the server running starts it if the one before
 * left it stopped, so only the first start pays for a new database.
 */
describe('yaac server on one host install (real CLI + real server)', () => {
  let testEnv: YaacTestEnv

  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterAll(async () => {
    await killServerByLock()
    await testEnv.cleanup()
  })

  /** The lock of the running server, started first unless one already runs. */
  async function running(): Promise<ServerLock> {
    const { exitCode, stderr } = await runYaac(testEnv.env, 'server', 'start')
    expect(exitCode, stderr).toBe(0)
    return (await readLock())!
  }

  async function status(env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> {
    const r = await runYaac(env, 'server', 'status', ...args)
    expect(r.exitCode).toBe(0)
    return r.stdout.trim()
  }

  it('`server logs`, `status` and `stop` say so when nothing has run', async () => {
    const logs = await runYaac(testEnv.env, 'server', 'logs')
    expect(logs.exitCode).toBe(0)
    expect(logs.stderr).toMatch(/no server log at/)
    expect(logs.stdout).toBe('')

    expect(await status(testEnv.env)).toBe('not running')
    expect(JSON.parse(await status(testEnv.env, '--json'))).toMatchObject({ running: false, driver: null, serverBuildId: null, origin: null })

    const stop = await runYaac(testEnv.env, 'server', 'stop')
    expect(stop.exitCode).toBe(0)
    expect(stop.stderr).toMatch(/not running/)
  })

  it('`server run` refuses a bind beyond loopback, where anyone could claim to be this machine', async () => {
    // Loopback callers are treated as the owner (docs/remote-hosting.md),
    // so a wider bind would grant that to anyone who sends a loopback Host.
    // Only the in-cluster pod binds wide, behind its ingress policy.
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, YAAC_BIND_ADDR: '0.0.0.0' }, 'server', 'run',
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/YAAC_BIND_ADDR=0\.0\.0\.0 would expose the server.*tailscale serve/s)
    expect(await readLock()).toBeNull()
  })

  it('`server run` binds, writes the lock at serverLockPath(), serves /health and the CLI, and clears the lock on stop', async () => {
    const server = await spawnYaacServer(testEnv.env)
    try {
      expect(server.lock.port).toBeGreaterThan(0)

      const res = await fetch(`http://127.0.0.1:${server.lock.port}/api/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true })

      expect(serverLockPath()).toBe(path.join(testEnv.dataDir, 'server-local', '.server.lock'))
      // `heartbeatAt` is renewed every few seconds.
      const raw = await fs.readFile(serverLockPath(), 'utf8')
      expect({ ...JSON.parse(raw) as object, heartbeatAt: server.lock.heartbeatAt }).toEqual(server.lock)

      const { stdout, exitCode } = await runYaac(testEnv.env, 'project', 'list')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No projects found')
    } finally {
      await server.stop()
    }
    expect(await readLock()).toBeNull()
  })

  it('`server run --port <N>` prefers the requested port over the env default', async () => {
    // A port above the env default (YAAC_SERVER_PORT): if --port were
    // ignored the server would bind the lower one. Auto-increment only moves
    // it up, so it lands in [wanted, wanted + probes).
    const wanted = testEnv.serverPort + 1
    const child = spawn(process.execPath, [
      TEST_CLI_ENTRY, 'server', 'run', '--port', String(wanted),
    ], { env: testEnv.env, stdio: ['ignore', 'ignore', 'pipe'] })
    try {
      // Generous budget for a cold start on a loaded host. Ready, not just
      // bound: the lock is written before the database opens, and the cases
      // after this one reopen what a kill would interrupt.
      const lock = await vi.waitFor(async () => {
        const l = await readLock()
        if (!l) throw new Error('server never wrote its lock')
        const health = await (await fetch(`http://127.0.0.1:${l.port}/api/health`)).json() as { ready?: boolean }
        expect(health.ready).toBe(true)
        return l
      }, { timeout: 60_000, interval: 100 })
      expect(lock.port).toBeGreaterThanOrEqual(wanted)
      expect(lock.port).toBeLessThan(wanted + MAX_PORT_PROBES)
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  })

  it('`server start` spawns a background server that writes the lock, and is idempotent while its version matches', async () => {
    expect(await readLock()).toBeNull()
    const lock = await running()
    // Without --port it starts from YAAC_SERVER_PORT and increments if
    // busy, never picking an OS-assigned ephemeral port.
    expect(lock.port).toBeGreaterThanOrEqual(testEnv.serverPort)
    expect(lock.port).toBeLessThan(testEnv.serverPort + MAX_PORT_PROBES)
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/health`)
    expect(res.status).toBe(200)
    // `server start` waits for readiness (DB init), so the next init
    // command does not race the boot.
    expect(await res.json()).toMatchObject({ ok: true, ready: true })

    const second = await runYaac(testEnv.env, 'server', 'start')
    expect(second.exitCode).toBe(0)
    expect(second.stderr).toMatch(/already running/)
    expect((await readLock())?.pid).toBe(lock.pid)
    expect(await status(testEnv.env)).toBe('running')
  })

  it('`server logs` prints the log the running server wrote', async () => {
    // Guarantees a request-log line besides the startup line.
    await fetch(`http://127.0.0.1:${(await running()).port}/api/health`)

    const { exitCode, stdout } = await runYaac(testEnv.env, 'server', 'logs')
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/\[server\] listening on 127\.0\.0\.1:/)
    expect(stdout).toMatch(/GET \/api\/health 200/)
  })

  it('`server restart` replaces the running server with a fresh one', async () => {
    const before = await running()

    const { exitCode } = await runYaac(testEnv.env, 'server', 'restart')
    expect(exitCode).toBe(0)

    const after = await readLock()
    expect(after).not.toBeNull()
    expect(after!.pid).not.toBe(before.pid)
    const res = await fetch(`http://127.0.0.1:${after!.port}/api/health`)
    expect(res.status).toBe(200)
  })

  it('`server stop` SIGTERMs the server and clears the lock', async () => {
    await running()
    const { exitCode, stderr } = await runYaac(testEnv.env, 'server', 'stop')
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/server stopped/)
    expect(await readLock()).toBeNull()
  })

  it('refuses to `start` beside a server on another build, which `status [--json]` reports and `restart` replaces', async () => {
    await killServerByLock()
    // A server on another build than the CLI is what the desktop tray
    // offers to restart.
    expect((await runYaac({ ...testEnv.env, YAAC_BUILD_ID: 'old-build' }, 'server', 'start')).exitCode).toBe(0)

    const second = await runYaac(testEnv.env, 'server', 'start')
    expect(second.exitCode).toBe(1)
    expect(second.stderr).toMatch(/outdated version/)
    expect(second.stderr).toMatch(/yaac server restart/)

    const json = JSON.parse(await status(testEnv.env, '--json')) as Record<string, unknown>
    expect(json).toMatchObject({ running: true, driver: 'containerless', serverBuildId: 'old-build', refused: null, reachable: true })
    // The origin the desktop app trusts this install's pages from.
    expect(json.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(json.cliBuildId).not.toBe('old-build')
    expect(await status(testEnv.env)).toMatch(/different build than this CLI; update it with: yaac server restart/)

    expect((await runYaac(testEnv.env, 'server', 'restart')).exitCode).toBe(0)
    expect(await status(testEnv.env)).toBe('running')

    // A hung server still runs: its pid lives though its port is silent.
    const { pid } = (await readLock())!
    process.kill(pid, 'SIGSTOP')
    try {
      expect(await status(testEnv.env)).toBe('running, but its /api/health does not answer; see `yaac server logs`')
      expect(JSON.parse(await status(testEnv.env, '--json'))).toMatchObject({ running: true, refused: null, reachable: false })
    } finally {
      process.kill(pid, 'SIGCONT')
    }
  })

  // These write the log themselves, so they need no server.
  it('`server logs -n <N>` and `--lines <N>` print only the last lines', async () => {
    await killServerByLock()
    await fs.writeFile(serverLogPath(), 'a\nb\nc\nd\n')
    const one = await runYaac(testEnv.env, 'server', 'logs', '-n', '1')
    expect(one.exitCode).toBe(0)
    expect(one.stdout).toBe('d\n')
    const two = await runYaac(testEnv.env, 'server', 'logs', '--lines', '2')
    expect(two.exitCode).toBe(0)
    expect(two.stdout).toBe('c\nd\n')
  })

  it('`server logs -f` keeps printing new lines until interrupted', async () => {
    await fs.writeFile(serverLogPath(), 'initial\n')

    const child = spawn(process.execPath, [
      TEST_CLI_ENTRY, 'server', 'logs', '-f',
    ], { env: testEnv.env, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })

      // The first wait absorbs the CLI's cold start.
      await vi.waitFor(() => expect(stdout).toContain('initial\n'), { timeout: 15_000, interval: 50 })
      await fs.appendFile(serverLogPath(), 'appended\n')
      await vi.waitFor(() => expect(stdout).toContain('appended\n'), { timeout: 5_000, interval: 50 })
    } finally {
      child.kill('SIGINT')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  })
})

/**
 * A signal after the lock is taken but before the server is ready. Its own
 * data dir, since a kill mid-start can leave a half-made database behind.
 */
describe('yaac server run stopped while it starts (real CLI)', () => {
  let testEnv: YaacTestEnv

  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterAll(async () => {
    await killServerByLock()
    await testEnv.cleanup()
  })

  it('removes its lock on SIGTERM, so the next start does not wait it out', async () => {
    const child = spawn(process.execPath, [TEST_CLI_ENTRY, 'server', 'run'], { env: testEnv.env, stdio: 'ignore' })
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
    // The lock is written at bind time, before the database opens.
    await vi.waitFor(async () => { expect(await readLock()).not.toBeNull() }, { timeout: 60_000, interval: 20 })
    child.kill('SIGTERM')
    // 1 is the startup exit; a server already ready would exit 0.
    expect(await exited).toBe(1)
    expect(await readLock()).toBeNull()
  })
})

describe('yaac server start|restart --tailnet/--admin/--yes, and yaac user (access modes and roles)', () => {
  // One data dir walked through the whole one-way sequence: fresh tailnet
  // needs an --admin, a mode the running server is not in is refused, and
  // tailnet never goes back to local. Others cover replacing the admins and
  // the switch from local, which takes exactly one --admin.
  const HOST = 'srv.tailnet.ts.net'
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await killServerByLock()
    await testEnv.cleanup()
  })

  /** GET /whoami at the running server, as `headers` says the caller is. */
  async function whoami(headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const lock = await readLock()
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: lock!.port, path: '/api/whoami', headers }, (res) => {
        let raw = ''
        res.on('data', (c: Buffer) => { raw += c.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Record<string, unknown> }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  /** The roles /whoami lists, by login. */
  async function roles(): Promise<Record<string, string>> {
    const { users } = (await whoami(asTailnet('alice@example.com', HOST))).body as { users: Array<{ login: string; role: string }> }
    return Object.fromEntries(users.map((u) => [u.login, u.role]))
  }

  it('records a fresh install\'s mode and admins, registers its tailnet origin, and never switches back', async () => {
    const adminless = await runYaac(testEnv.env, 'server', 'start', '--tailnet', HOST)
    expect(adminless.exitCode).toBe(1)
    expect(adminless.stderr).toMatch(/has no admin/)
    expect(adminless.stderr).toContain(`\`yaac server start --tailnet ${HOST} --admin <login>\``)
    expect(await readLock()).toBeNull()

    const started = await runYaac(testEnv.env, 'server', 'start', '--tailnet', HOST.toUpperCase(), '--admin', 'alice@example.com')
    expect(started.exitCode).toBe(0)
    expect(started.stderr).toContain('admin: alice@example.com (has not signed in yet)')
    expect(await readServerConfig()).toMatchObject({ url: `https://${HOST}` })
    expect(await readInstallRecord()).toEqual({ driver: 'containerless', origin: `https://${HOST}` })
    expect((await whoami(asTailnet('alice@example.com', HOST))).body).toMatchObject({ kind: 'tailnet', login: 'alice@example.com' })
    expect((await whoami({ host: '127.0.0.1' })).status).toBe(401)

    // The running server is in another mode than asked for.
    const mismatch = await runYaac(testEnv.env, 'server', 'start')
    expect(mismatch.exitCode).toBe(1)
    expect(mismatch.stderr).toMatch(/running in tailnet mode, which cannot switch back to local[\s\S]*yaac server start --tailnet srv\.tailnet\.ts\.net/)

    // Back to local is refused, and the refusing server is not left running.
    const back = await runYaac(testEnv.env, 'server', 'restart')
    expect(back.exitCode).toBe(1)
    expect(back.stderr).toMatch(/refused to start: this install runs in tailnet mode/)
    expect(back.stderr).toContain(`Start it with \`yaac server start --tailnet ${HOST}\`.`)
    expect(await readLock()).toBeNull()

    // A foreground `server run` is not stopped on refusal: it stays up
    // answering `/health` with the reason, as the in-cluster server does,
    // and status reports that rather than `running`.
    const refusing = spawn(process.execPath, [TEST_CLI_ENTRY, 'server', 'run'], { env: testEnv.env, stdio: 'ignore' })
    try {
      const status = await vi.waitFor(async () => {
        const json = JSON.parse((await runYaac(testEnv.env, 'server', 'status', '--json')).stdout) as Record<string, unknown>
        if (json.refused === null) throw new Error('the server has not refused yet')
        return json
      }, { timeout: 60_000, interval: 200 })
      expect(status).toMatchObject({ running: true, reachable: true })
      expect(status.refused).toMatch(/runs in tailnet mode/)
      expect((await runYaac(testEnv.env, 'server', 'status')).stdout).toMatch(/^up, but refused to start: this install runs in tailnet mode/)
    } finally {
      refusing.kill('SIGTERM')
      await new Promise<void>((resolve) => refusing.once('exit', () => resolve()))
    }

    const again = await runYaac(testEnv.env, 'server', 'restart', '--tailnet', HOST)
    expect(again.exitCode).toBe(0)
    expect((await whoami(asTailnet('alice@example.com', HOST))).status).toBe(200)
  })

  it('replaces the admins of a running server, revoking anyone only once accepted', async () => {
    const started = await runYaac(testEnv.env, 'server', 'start', '--tailnet', HOST, '--admin', 'alice@example.com', '--admin', 'bob@example.com')
    expect(started.exitCode).toBe(0)
    expect(await roles()).toMatchObject({ 'alice@example.com': 'admin', 'bob@example.com': 'admin' })
    // Bob signs in, so revoking him keeps him as a member.
    await whoami(asTailnet('bob@example.com', HOST))

    // No terminal to ask on, so revoking bob needs --yes.
    const asked = await runYaac(testEnv.env, 'server', 'start', '--tailnet', HOST, '--admin', 'alice@example.com')
    expect(asked.exitCode).toBe(1)
    expect(asked.stderr).toMatch(/would revoke admin from bob@example\.com; re-run with --yes/)
    expect(await roles()).toMatchObject({ 'bob@example.com': 'admin' })

    const accepted = await runYaac(testEnv.env, 'server', 'restart', '--tailnet', HOST, '--admin', 'alice@example.com', '--yes')
    expect(accepted.exitCode).toBe(0)
    expect(await roles()).toMatchObject({ 'alice@example.com': 'admin', 'bob@example.com': 'member' })
  })

  it('lists users and sets roles with `yaac user`, then switches local to tailnet with exactly one --admin, who owns its data', async () => {
    expect((await runYaac(testEnv.env, 'server', 'start')).exitCode).toBe(0)
    expect(await whoami({ host: '127.0.0.1' })).toMatchObject({ status: 200, body: { kind: 'local' } })
    const builtIn = (await whoami({ host: '127.0.0.1' })).body.userId

    // A local install's one user is its admin, and its last.
    expect((await runYaac(testEnv.env, 'user', 'list')).stdout).toMatch(/local\s+admin\s+local \(you\)/)
    expect((await runYaac(testEnv.env, 'user', 'role', 'local', 'admin')).stdout).toContain('local is now an admin.')
    const demoted = await runYaac(testEnv.env, 'user', 'role', 'local', 'member')
    expect(demoted.exitCode).toBe(1)
    expect(demoted.stderr).toMatch(/last admin/)
    expect((await runYaac(testEnv.env, 'user', 'role', 'nobody', 'admin')).stderr).toMatch(/No user "nobody"/)
    expect((await runYaac(testEnv.env, 'user', 'role', 'local', 'owner')).stderr).toMatch(/Allowed choices are admin, member/)

    const unowned = await runYaac(testEnv.env, 'server', 'restart', '--tailnet', HOST)
    expect(unowned.exitCode).toBe(1)
    expect(unowned.stderr).toMatch(/runs in local mode[\s\S]*exactly one admin/)
    expect(unowned.stderr).toContain(`\`yaac server start --tailnet ${HOST} --admin <login>\``)
    expect(await readLock()).toBeNull()
    const two = await runYaac(testEnv.env, 'server', 'start', '--tailnet', HOST, '--admin', 'alice@example.com', '--admin', 'bob@example.com')
    expect(two.stderr).toMatch(/exactly one admin/)

    const owned = await runYaac(testEnv.env, 'server', 'start', '--tailnet', HOST, '--admin', 'alice@example.com')
    expect(owned.exitCode).toBe(0)
    expect((await whoami(asTailnet('alice@example.com', HOST))).body).toMatchObject({ userId: builtIn })
    expect(await roles()).toEqual({ 'alice@example.com': 'admin' })
  })

  it('refuses bad flags before starting anything, and --tailnet inside a workspace', async () => {
    for (const [args, message] of [
      [['--admin', 'alice@example.com'], /--admin .* needs --tailnet <host>/],
      [['--tailnet', 'https://srv.tailnet.ts.net'], /--tailnet takes the bare MagicDNS name/],
    ] as const) {
      const { exitCode, stderr } = await runYaac(testEnv.env, 'server', 'start', ...args)
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(message)
      expect(await readLock()).toBeNull()
    }
    const nested = await runYaac({ ...testEnv.env, YAAC_WORKSPACE_ID: 'abcd1234' }, 'server', 'start', '--tailnet', HOST)
    expect(nested.exitCode).toBe(1)
    expect(nested.stderr).toMatch(/inside a workspace is always local/)
    expect(await readLock()).toBeNull()
  })
})

describe('yaac server and yaac cluster: two installs, two data dirs', () => {
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await killServerByLock()
    await testEnv.cleanup()
  })

  async function json(env: NodeJS.ProcessEnv, ...args: string[]): Promise<unknown> {
    const res = await runYaac(env, ...args, '--json')
    expect(res.exitCode, res.stderr).toBe(0)
    return JSON.parse(res.stdout)
  }

  it('refuses every host verb on a cluster install\'s data dir, naming the cluster verb, and spawns nothing', async () => {
    // A host server here would be a second writer of the same database and
    // would reap every workspace as podless (docs/server-in-cluster.md).
    await fs.writeFile(path.join(testEnv.dataDir, 'install.json'), JSON.stringify({ driver: 'k8s' }), { mode: 0o600 })
    for (const verb of ['start', 'stop', 'restart', 'logs']) {
      const { exitCode, stderr } = await runYaac(testEnv.env, 'server', verb)
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(new RegExp(`is a cluster install[\\s\\S]*yaac cluster ${verb}`))
    }
    expect(await readLock()).toBeNull()
    // Status still answers, so the desktop app can tell whose data dir it is.
    expect((await runYaac(testEnv.env, 'server', 'status')).stdout).toMatch(/cluster install; see `yaac cluster status`/)
    expect(await json(testEnv.env, 'server', 'status')).toMatchObject({ driver: 'k8s', running: false })
    expect(await json(testEnv.env, 'cluster', 'status')).toMatchObject({ driver: 'k8s', running: false })
    // A record `yaac cluster install` never stamped names no cluster to act on.
    const start = await runYaac(testEnv.env, 'cluster', 'start')
    expect(start.exitCode).toBe(1)
    expect(start.stderr).toMatch(/records no cluster[\s\S]*yaac cluster install/)
  })

  it('`yaac cluster start|stop|restart|logs|status` say there is no cluster install, whatever the host server is doing', async () => {
    await fs.writeFile(path.join(testEnv.dataDir, 'install.json'), JSON.stringify({ driver: 'containerless' }), { mode: 0o600 })
    for (const verb of ['start', 'stop', 'restart', 'logs']) {
      const { exitCode, stderr } = await runYaac(testEnv.env, 'cluster', verb)
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/There is no cluster install at .*yaac cluster install/)
    }
    for (const args of [['-n', '1'], ['-f']]) {
      expect((await runYaac(testEnv.env, 'cluster', 'logs', ...args)).stderr).toMatch(/no cluster install/)
    }
    expect((await runYaac(testEnv.env, 'cluster', 'status')).stdout).toMatch(/no cluster install; create one with `yaac cluster install`/)
    expect(await json(testEnv.env, 'cluster', 'status')).toEqual({
      driver: null, running: false, serverBuildId: null, cliBuildId: 'test-build-id', origin: null, refused: null, reachable: null,
    })
  })

  it('keeps a cluster install in ~/.yaac-cluster beside the host server\'s ~/.yaac', async () => {
    // With no YAAC_DATA_DIR each install gets its own data dir, so the
    // host server and a cluster's can run side by side.
    const home = path.join(testEnv.scratchDir, 'home')
    await fs.mkdir(path.join(home, '.yaac-cluster'), { recursive: true })
    await fs.writeFile(path.join(home, '.yaac-cluster', 'install.json'), JSON.stringify({ driver: 'k8s' }))
    const env: NodeJS.ProcessEnv = { ...testEnv.env, HOME: home }
    delete env.YAAC_DATA_DIR
    expect(await json(env, 'cluster', 'status')).toMatchObject({ driver: 'k8s', running: false })
    expect(await json(env, 'server', 'status')).toMatchObject({ driver: null, running: false })
    // The cluster verbs act on that data dir, not on ~/.yaac.
    expect((await runYaac(env, 'cluster', 'stop')).stderr).toMatch(/records no cluster/)
  })

  it('has no --driver flag to choose a substrate with', async () => {
    // `yaac server start` means containerless and `yaac cluster install`
    // means k8s, so there is nothing to select.
    const { exitCode, stderr } = await runYaac(
      testEnv.env, 'server', 'start', '--driver', 'containerless',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/unknown option/i)
  })
})

async function killServerByLock(): Promise<void> {
  const lock = await readLock()
  if (!lock) return
  try {
    process.kill(lock.pid, 'SIGTERM')
  } catch {
    // already gone
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const cur = await readLock()
    if (!cur || cur.pid !== lock.pid) return
    await new Promise((r) => setTimeout(r, 50))
  }
}

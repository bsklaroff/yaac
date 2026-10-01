import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  acquireServerMutex,
  TEST_CLI_ENTRY,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { readLock, serverLockPath } from '@yaac/shared/lock'
import { MAX_PORT_PROBES } from '@yaac/shared/server-port'
import { serverLogPath } from '@yaac/shared/paths'
import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * The server as a host process: binding, the lock file, `start`/`stop`/
 * `restart`, and `logs`. Only the containerless server is a host process;
 * under k8s it is a Deployment (docs/server-in-cluster.md), covered by
 * test/e2e-cli/server.test.ts.
 */

// These tests spawn detached servers through the CLI rather than
// spawnYaacServer, so the cross-worker server mutex is held for the whole
// file.
let releaseServerMutex: (() => Promise<void>) | null = null
beforeAll(async () => {
  releaseServerMutex = await acquireServerMutex()
})
afterAll(async () => {
  await releaseServerMutex?.()
  releaseServerMutex = null
})

describe('yaac server lifecycle (real CLI + real server)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    if (server) await server.stop()
    server = null
    await killServerByLock()
    await testEnv.cleanup()
  })

  it('binds, writes the lock at serverLockPath(), serves /health and the CLI, and clears the lock on stop', async () => {
    // A second `server run` hits the same lock check as the `server start`
    // idempotency test below.
    server = await spawnYaacServer(testEnv.env)
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

    await server.stop()
    server = null
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
      // Generous budget for a cold start on a loaded host. The lock is
      // written at bind time, before DB init, so readiness is not awaited.
      const deadline = Date.now() + 60_000
      let lock = await readLock()
      while (!lock && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        lock = await readLock()
      }
      expect(lock, 'server never wrote its lock').not.toBeNull()
      expect(lock?.port).toBeGreaterThanOrEqual(wanted)
      expect(lock!.port).toBeLessThan(wanted + MAX_PORT_PROBES)
      const res = await fetch(`http://127.0.0.1:${lock!.port}/api/health`)
      expect(res.status).toBe(200)
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  })

})

describe('yaac server start / stop / restart (real CLI)', () => {
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await killServerByLock()
    await testEnv.cleanup()
  })

  it('`server start` spawns a background server that writes the lock', async () => {
    expect(await readLock()).toBeNull()
    const { exitCode } = await runYaac(testEnv.env, 'server', 'start')
    expect(exitCode).toBe(0)
    const lock = await readLock()
    expect(lock).not.toBeNull()
    // Without --port it starts from YAAC_SERVER_PORT and increments if
    // busy, never picking an OS-assigned ephemeral port.
    expect(lock!.port).toBeGreaterThanOrEqual(testEnv.serverPort)
    expect(lock!.port).toBeLessThan(testEnv.serverPort + MAX_PORT_PROBES)
    const res = await fetch(`http://127.0.0.1:${lock!.port}/api/health`)
    expect(res.status).toBe(200)
    // `server start` waits for readiness (DB init), so the next init
    // command does not race the boot.
    expect(await res.json()).toMatchObject({ ok: true, ready: true })
  })

  it('`server start` is idempotent when the running version matches', async () => {
    const first = await runYaac(testEnv.env, 'server', 'start')
    expect(first.exitCode).toBe(0)
    const firstLock = await readLock()
    const second = await runYaac(testEnv.env, 'server', 'start')
    expect(second.exitCode).toBe(0)
    expect(second.stderr).toMatch(/already running/)
    const secondLock = await readLock()
    expect(secondLock?.pid).toBe(firstLock?.pid)
  })

  it('`server start` errors when a running server has a mismatched buildId', async () => {
    const startEnv = { ...testEnv.env, YAAC_BUILD_ID: 'old-build' }
    const first = await runYaac(startEnv, 'server', 'start')
    expect(first.exitCode).toBe(0)

    const second = await runYaac(testEnv.env, 'server', 'start')
    expect(second.exitCode).toBe(1)
    expect(second.stderr).toMatch(/outdated version/)
    expect(second.stderr).toMatch(/yaac server restart/)
  })

  it('`server stop` SIGTERMs the server and clears the lock', async () => {
    await runYaac(testEnv.env, 'server', 'start')
    expect(await readLock()).not.toBeNull()
    const { exitCode, stderr } = await runYaac(testEnv.env, 'server', 'stop')
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/server stopped/)
    expect(await readLock()).toBeNull()
  })

  it('`server stop` is a no-op when no server is running', async () => {
    const { exitCode, stderr } = await runYaac(testEnv.env, 'server', 'stop')
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/not running/)
  })

  it('`server restart` replaces the running server with a fresh one', async () => {
    await runYaac(testEnv.env, 'server', 'start')
    const before = await readLock()
    expect(before).not.toBeNull()

    const { exitCode } = await runYaac(testEnv.env, 'server', 'restart')
    expect(exitCode).toBe(0)

    const after = await readLock()
    expect(after).not.toBeNull()
    expect(after!.pid).not.toBe(before!.pid)
    const res = await fetch(`http://127.0.0.1:${after!.port}/api/health`)
    expect(res.status).toBe(200)
  })

})

describe('yaac server start on a k8s install', () => {
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await killServerByLock()
    await testEnv.cleanup()
  })

  it('refuses, and never spawns a second writer of that data dir', async () => {
    // The recorded driver marks this data dir as a k8s install
    // (docs/server-in-cluster.md). A host server here would be a second
    // writer of the same database and would reap every workspace as podless.
    const clientRoot = `${testEnv.dataDir}-client`
    await fs.mkdir(clientRoot, { recursive: true })
    await fs.writeFile(path.join(clientRoot, 'server.json'), JSON.stringify({
      url: '', enabled: false, saved: [], driver: 'k8s',
    }), { mode: 0o600 })

    const { exitCode, stderr } = await runYaac(testEnv.env, 'server', 'start')
    expect(exitCode).toBe(1)
    // The record names no cluster, so the CLI refuses before asking one.
    expect(stderr).toMatch(/records no cluster[\s\S]*yaac cluster install/)
    // Nothing was spawned.
    expect(await readLock()).toBeNull()
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

describe('yaac server run refuses what the identity rule cannot defend', () => {
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await killServerByLock()
    await testEnv.cleanup()
  })

  it('a bind beyond loopback, where anyone could claim to be this machine', async () => {
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
})

describe('yaac server logs (real CLI)', () => {
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await killServerByLock()
    await testEnv.cleanup()
  })

  it('tells the user when no log file exists yet', async () => {
    const { exitCode, stderr, stdout } = await runYaac(testEnv.env, 'server', 'logs')
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/no server log at/)
    expect(stdout).toBe('')
  })

  it('prints the server log after `server start` has written to it', async () => {
    const started = await runYaac(testEnv.env, 'server', 'start')
    expect(started.exitCode).toBe(0)

    // Guarantees a request-log line besides the startup line.
    const lock = await readLock()
    await fetch(`http://127.0.0.1:${lock!.port}/api/health`)

    const { exitCode, stdout } = await runYaac(testEnv.env, 'server', 'logs')
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/\[server\] listening on 127\.0\.0\.1:/)
    expect(stdout).toMatch(/GET \/api\/health 200/)
  })

  it('`-n 1` prints only the last line', async () => {
    await fs.writeFile(serverLogPath(), 'first\nsecond\nthird\n')
    const { exitCode, stdout } = await runYaac(testEnv.env, 'server', 'logs', '-n', '1')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('third\n')
  })

  it('`--lines 2` prints only the last 2 lines', async () => {
    await fs.writeFile(serverLogPath(), 'a\nb\nc\nd\n')
    const { exitCode, stdout } = await runYaac(testEnv.env, 'server', 'logs', '--lines', '2')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('c\nd\n')
  })

  it('`-f` keeps printing new lines until interrupted', async () => {
    await fs.writeFile(serverLogPath(), 'initial\n')

    const child = spawn(process.execPath, [
      TEST_CLI_ENTRY, 'server', 'logs', '-f',
    ], { env: testEnv.env, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })

      // The first wait absorbs the CLI's cold start.
      await waitFor(() => stdout.includes('initial\n'), 15000)
      await fs.appendFile(serverLogPath(), 'appended\n')
      await waitFor(() => stdout.includes('appended\n'), 5000)

      expect(stdout).toContain('initial\n')
      expect(stdout).toContain('appended\n')
    } finally {
      child.kill('SIGINT')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
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

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('waitFor timed out')
}

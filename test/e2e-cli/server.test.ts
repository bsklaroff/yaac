import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  acquireServerMutex,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { readLock, serverLockPath } from '@yaac/shared/lock'
import { MAX_PORT_PROBES } from '@yaac/shared/server-port'
import { serverLogPath } from '@yaac/shared/paths'
import { spawn } from 'node:child_process'
import path from 'node:path'

// Hold the cross-worker server mutex for the whole file: these tests
// exercise `yaac server start`/`stop`/`restart` which spawn detached
// servers via the CLI (not spawnYaacServer), so there's no per-test
// hook to wrap. Acquiring at the file level serializes this suite
// with every other server-using test.
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
    // One spawned server walks the whole run-lifecycle: these were four
    // separate tests, but each claim needs nothing beyond "a live server",
    // so they share one spawn. (`server run` second-invocation idempotency
    // is covered by the `server start` idempotency test below — both hit
    // the same server-side lock check.)
    server = await spawnYaacServer(testEnv.env)
    expect(server.lock.port).toBeGreaterThan(0)

    const res = await fetch(`http://127.0.0.1:${server.lock.port}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })

    expect(serverLockPath()).toBe(path.join(testEnv.dataDir, '.server.lock'))
    const raw = await fs.readFile(serverLockPath(), 'utf8')
    expect(JSON.parse(raw)).toEqual(server.lock)

    const { stdout, exitCode } = await runYaac(testEnv.env, 'project', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No projects found')

    await server.stop()
    server = null
    expect(await readLock()).toBeNull()
  })

  it('`server run --port <N>` prefers the requested port over the env default', async () => {
    // A port above the env default (YAAC_SERVER_PORT) proves --port wins: were
    // it ignored, the server would land on the lower env port. Auto-increment
    // only nudges it higher, so the bound port stays in [wanted, wanted+probes).
    const wanted = testEnv.serverPort + 1
    const child = spawn(process.execPath, [
      path.resolve('node_modules/tsx/dist/cli.mjs'),
      path.resolve('apps/cli/src/cli.ts'),
      'server', 'run', '--port', String(wanted),
    ], { env: testEnv.env, stdio: ['ignore', 'ignore', 'pipe'] })
    try {
      const deadline = Date.now() + 5000
      let lock = await readLock()
      while (!lock && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        lock = await readLock()
      }
      expect(lock?.port).toBeGreaterThanOrEqual(wanted)
      expect(lock!.port).toBeLessThan(wanted + MAX_PORT_PROBES)
      const res = await fetch(`http://127.0.0.1:${lock!.port}/health`)
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
    // No --port was given, so the server prefers the fixed default (here the
    // test env's YAAC_SERVER_PORT), auto-incrementing only if it's busy —
    // never an OS-assigned ephemeral port well outside that range.
    expect(lock!.port).toBeGreaterThanOrEqual(testEnv.serverPort)
    expect(lock!.port).toBeLessThan(testEnv.serverPort + MAX_PORT_PROBES)
    const res = await fetch(`http://127.0.0.1:${lock!.port}/health`)
    expect(res.status).toBe(200)
    // `server start` returns only once the server is ready (DB init done),
    // not merely bound — so /health reports ready: true by the time the
    // command's exit is observed. This is what lets the next init command
    // (e.g. `yaac auth ...`) reach the server instead of racing its boot.
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
    const res = await fetch(`http://127.0.0.1:${after!.port}/health`)
    expect(res.status).toBe(200)
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

    // Hit /health to guarantee the request logger has flushed at least
    // one line, plus the initial "listening on …" line from startup.
    const lock = await readLock()
    await fetch(`http://127.0.0.1:${lock!.port}/health`)

    const { exitCode, stdout } = await runYaac(testEnv.env, 'server', 'logs')
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/\[server\] listening on 127\.0\.0\.1:/)
    expect(stdout).toMatch(/GET \/health 200/)
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
      path.resolve('node_modules/tsx/dist/cli.mjs'),
      path.resolve('apps/cli/src/cli.ts'),
      'server', 'logs', '-f',
    ], { env: testEnv.env, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })

      // Generous budgets: the first wait absorbs the CLI's tsx cold start,
      // which can exceed 3s on a loaded or virtualized host.
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

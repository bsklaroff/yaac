import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  acquireDaemonMutex,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { readLock, daemonLockPath } from '@/shared/lock'
import { daemonLogPath } from '@/shared/paths'
import { spawn } from 'node:child_process'
import path from 'node:path'

// Hold the cross-worker daemon mutex for the whole file: these tests
// exercise `yaac daemon start`/`stop`/`restart` which spawn detached
// daemons via the CLI (not spawnYaacDaemon), so there's no per-test
// hook to wrap. Acquiring at the file level serializes this suite
// with every other daemon-using test.
let releaseDaemonMutex: (() => Promise<void>) | null = null
beforeAll(async () => {
  releaseDaemonMutex = await acquireDaemonMutex()
})
afterAll(async () => {
  await releaseDaemonMutex?.()
  releaseDaemonMutex = null
})

describe('yaac daemon lifecycle (real CLI + real daemon)', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    if (daemon) await daemon.stop()
    daemon = null
    await killDaemonByLock()
    await testEnv.cleanup()
  })

  it('the daemon binds and /health responds with ok', async () => {
    daemon = await spawnYaacDaemon(testEnv.env)
    expect(daemon.lock.port).toBeGreaterThan(0)

    const res = await fetch(`http://127.0.0.1:${daemon.lock.port}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('stopping the daemon removes the lock', async () => {
    daemon = await spawnYaacDaemon(testEnv.env)
    expect(await readLock()).not.toBeNull()
    await daemon.stop()
    daemon = null
    expect(await readLock()).toBeNull()
  })

  it('runYaac can issue a command against the spawned daemon', async () => {
    daemon = await spawnYaacDaemon(testEnv.env)
    const { stdout, exitCode } = await runYaac(testEnv.env, 'project', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No projects found')
  })

  it('a second `yaac daemon run` invocation is idempotent', async () => {
    daemon = await spawnYaacDaemon(testEnv.env)
    const firstPort = daemon.lock.port

    const second = spawn(process.execPath, [
      path.resolve('node_modules/tsx/dist/cli.mjs'),
      path.resolve('src/cli.ts'),
      'daemon', 'run', '--port', '0',
    ], { env: testEnv.env, stdio: ['ignore', 'ignore', 'pipe'] })
    const exitCode = await new Promise<number | null>((resolve) => {
      second.once('exit', (code) => resolve(code))
    })
    expect(exitCode).toBe(0)

    const lockNow = await readLock()
    expect(lockNow?.port).toBe(firstPort)
  })

  it('writes the lock at the resolved daemonLockPath()', async () => {
    daemon = await spawnYaacDaemon(testEnv.env)
    expect(daemonLockPath()).toBe(path.join(testEnv.dataDir, '.daemon.lock'))
    const raw = await fs.readFile(daemonLockPath(), 'utf8')
    expect(JSON.parse(raw)).toEqual(daemon.lock)
  })
})

describe('yaac daemon start / stop / restart (real CLI)', () => {
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await killDaemonByLock()
    await testEnv.cleanup()
  })

  it('`daemon start` spawns a background daemon that writes the lock', async () => {
    expect(await readLock()).toBeNull()
    const { exitCode } = await runYaac(testEnv.env, 'daemon', 'start')
    expect(exitCode).toBe(0)
    const lock = await readLock()
    expect(lock).not.toBeNull()
    const res = await fetch(`http://127.0.0.1:${lock!.port}/health`)
    expect(res.status).toBe(200)
  })

  it('`daemon start` is idempotent when the running version matches', async () => {
    const first = await runYaac(testEnv.env, 'daemon', 'start')
    expect(first.exitCode).toBe(0)
    const firstLock = await readLock()
    const second = await runYaac(testEnv.env, 'daemon', 'start')
    expect(second.exitCode).toBe(0)
    expect(second.stderr).toMatch(/already running/)
    const secondLock = await readLock()
    expect(secondLock?.pid).toBe(firstLock?.pid)
  })

  it('`daemon start` errors when a running daemon has a mismatched buildId', async () => {
    const startEnv = { ...testEnv.env, YAAC_BUILD_ID: 'old-build' }
    const first = await runYaac(startEnv, 'daemon', 'start')
    expect(first.exitCode).toBe(0)

    const second = await runYaac(testEnv.env, 'daemon', 'start')
    expect(second.exitCode).toBe(1)
    expect(second.stderr).toMatch(/outdated version/)
    expect(second.stderr).toMatch(/yaac daemon restart/)
  })

  it('`daemon stop` SIGTERMs the daemon and clears the lock', async () => {
    await runYaac(testEnv.env, 'daemon', 'start')
    expect(await readLock()).not.toBeNull()
    const { exitCode, stderr } = await runYaac(testEnv.env, 'daemon', 'stop')
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/daemon stopped/)
    expect(await readLock()).toBeNull()
  })

  it('`daemon stop` is a no-op when no daemon is running', async () => {
    const { exitCode, stderr } = await runYaac(testEnv.env, 'daemon', 'stop')
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/not running/)
  })

  it('`daemon restart` replaces the running daemon with a fresh one', async () => {
    await runYaac(testEnv.env, 'daemon', 'start')
    const before = await readLock()
    expect(before).not.toBeNull()

    const { exitCode } = await runYaac(testEnv.env, 'daemon', 'restart')
    expect(exitCode).toBe(0)

    const after = await readLock()
    expect(after).not.toBeNull()
    expect(after!.pid).not.toBe(before!.pid)
    const res = await fetch(`http://127.0.0.1:${after!.port}/health`)
    expect(res.status).toBe(200)
  })

  it('`daemon restart` starts a daemon even when none was running', async () => {
    expect(await readLock()).toBeNull()
    const { exitCode } = await runYaac(testEnv.env, 'daemon', 'restart')
    expect(exitCode).toBe(0)
    expect(await readLock()).not.toBeNull()
  })
})

describe('yaac daemon logs (real CLI)', () => {
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await killDaemonByLock()
    await testEnv.cleanup()
  })

  it('tells the user when no log file exists yet', async () => {
    const { exitCode, stderr, stdout } = await runYaac(testEnv.env, 'daemon', 'logs')
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/no daemon log at/)
    expect(stdout).toBe('')
  })

  it('prints the daemon log after `daemon start` has written to it', async () => {
    const started = await runYaac(testEnv.env, 'daemon', 'start')
    expect(started.exitCode).toBe(0)

    // Hit /health to guarantee the request logger has flushed at least
    // one line, plus the initial "listening on …" line from startup.
    const lock = await readLock()
    await fetch(`http://127.0.0.1:${lock!.port}/health`)

    const { exitCode, stdout } = await runYaac(testEnv.env, 'daemon', 'logs')
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/\[daemon\] listening on 127\.0\.0\.1:/)
    expect(stdout).toMatch(/GET \/health 200/)
  })

  it('`-n 1` prints only the last line', async () => {
    await fs.writeFile(daemonLogPath(), 'first\nsecond\nthird\n')
    const { exitCode, stdout } = await runYaac(testEnv.env, 'daemon', 'logs', '-n', '1')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('third\n')
  })

  it('`--lines 2` prints only the last 2 lines', async () => {
    await fs.writeFile(daemonLogPath(), 'a\nb\nc\nd\n')
    const { exitCode, stdout } = await runYaac(testEnv.env, 'daemon', 'logs', '--lines', '2')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('c\nd\n')
  })

  it('`-f` keeps printing new lines until interrupted', async () => {
    await fs.writeFile(daemonLogPath(), 'initial\n')

    const child = spawn(process.execPath, [
      path.resolve('node_modules/tsx/dist/cli.mjs'),
      path.resolve('src/cli.ts'),
      'daemon', 'logs', '-f',
    ], { env: testEnv.env, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })

      await waitFor(() => stdout.includes('initial\n'), 3000)
      await fs.appendFile(daemonLogPath(), 'appended\n')
      await waitFor(() => stdout.includes('appended\n'), 3000)

      expect(stdout).toContain('initial\n')
      expect(stdout).toContain('appended\n')
    } finally {
      child.kill('SIGINT')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  })
})

async function killDaemonByLock(): Promise<void> {
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

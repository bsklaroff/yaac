import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@/lib/project/paths'
import { daemonLockPath, readLock, type DaemonLock } from '@/shared/lock'
import { daemonLogPath } from '@/shared/paths'

const TSX_CLI = path.resolve(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const ENTRY = path.resolve(__dirname, '..', '..', 'src', 'cli.ts')

interface SpawnedDaemon {
  child: ChildProcess
  lock: DaemonLock
  stop: () => Promise<void>
}

async function startDaemon(env: NodeJS.ProcessEnv): Promise<SpawnedDaemon> {
  const child = spawn(process.execPath, [TSX_CLI, ENTRY, 'daemon', 'run', '--port', '0'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const lock = await waitForLock(5000)

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  return { child, lock, stop }
}

async function waitForLock(timeoutMs: number): Promise<DaemonLock> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = await readLock()
    if (lock) return lock
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('daemon did not write the lock within timeout')
}

describe('yaac daemon run (subprocess)', () => {
  let homeDir: string
  let dataDir: string
  let daemon: SpawnedDaemon | null = null
  let env: NodeJS.ProcessEnv

  beforeEach(async () => {
    // The daemon subprocess resolves the lock via os.homedir()/.yaac
    // since setDataDir() is only an in-process override. Point HOME at
    // a temp dir, then setDataDir() to the matching path in the test
    // process so both agree on where the lock lives.
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-daemon-test-'))
    dataDir = path.join(homeDir, '.yaac')
    await fs.mkdir(path.join(dataDir, 'projects'), { recursive: true })
    setDataDir(dataDir)
    env = { ...process.env, HOME: homeDir, YAAC_BUILD_ID: 'test-build-id' }
  })

  afterEach(async () => {
    if (daemon) await daemon.stop()
    daemon = null
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('binds, writes the lock, and /health responds', async () => {
    daemon = await startDaemon(env)
    expect(daemon.lock.port).toBeGreaterThan(0)
    expect(daemon.lock.secret).toMatch(/^[0-9a-f]{64}$/)

    const res = await fetch(`http://127.0.0.1:${daemon.lock.port}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('a second `yaac daemon run` invocation is idempotent', async () => {
    daemon = await startDaemon(env)
    const firstPort = daemon.lock.port

    const second = spawn(process.execPath, [TSX_CLI, ENTRY, 'daemon', 'run', '--port', '0'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const exitCode = await new Promise<number | null>((resolve) => {
      second.once('exit', (code) => resolve(code))
    })
    expect(exitCode).toBe(0)

    // The lock should still belong to the first daemon.
    const lockNow = await readLock()
    expect(lockNow?.port).toBe(firstPort)
  })

  it('removes the lock on SIGTERM', async () => {
    daemon = await startDaemon(env)
    expect(await readLock()).not.toBeNull()
    await daemon.stop()
    daemon = null
    expect(await readLock()).toBeNull()
  })

  it('rejects /project/list without a bearer token', async () => {
    daemon = await startDaemon(env)
    const res = await fetch(`http://127.0.0.1:${daemon.lock.port}/project/list`)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_BEARER')
  })

  it('returns the empty project list with the correct bearer', async () => {
    daemon = await startDaemon(env)
    const res = await fetch(`http://127.0.0.1:${daemon.lock.port}/project/list`, {
      headers: { authorization: `Bearer ${daemon.lock.secret}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('writes the lock at the resolved daemonLockPath()', async () => {
    daemon = await startDaemon(env)
    expect(daemonLockPath()).toBe(path.join(dataDir, '.daemon.lock'))
    const raw = await fs.readFile(daemonLockPath(), 'utf8')
    expect(JSON.parse(raw)).toEqual(daemon.lock)
  })

  async function authedFetch(url: string): Promise<Response> {
    if (!daemon) throw new Error('daemon not started')
    return fetch(url, { headers: { authorization: `Bearer ${daemon.lock.secret}` } })
  }

  it('GET /session/list?project=missing returns 404 NOT_FOUND', async () => {
    daemon = await startDaemon(env)
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/session/list?project=missing`)
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('GET /session/:id/blocked-hosts returns 404 for an unknown session', async () => {
    daemon = await startDaemon(env)
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/session/deadbeef/blocked-hosts`)
    expect(res.status).toBe(404)
  })

  it('GET /prewarm returns {} on a clean data dir', async () => {
    daemon = await startDaemon(env)
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/prewarm`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('GET /tool/get returns {tool:null} when no default is configured', async () => {
    daemon = await startDaemon(env)
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/tool/get`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tool: null })
  })

  it('GET /auth/list returns empty arrays when nothing is configured', async () => {
    daemon = await startDaemon(env)
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/auth/list`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ githubTokens: [], toolAuth: [] })
  })

  it('GET /project/:slug 404s for an unknown project', async () => {
    daemon = await startDaemon(env)
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/project/nope`)
    expect(res.status).toBe(404)
  })
})

async function runCli(env: NodeJS.ProcessEnv, ...args: string[]): Promise<{
  exitCode: number | null
  stderr: string
  stdout: string
}> {
  const child = spawn(process.execPath, [TSX_CLI, ENTRY, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  let stdout = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
  })
  return { exitCode, stderr, stdout }
}

async function killDaemonByLock(): Promise<void> {
  const lock = await readLock()
  if (!lock) return
  try {
    process.kill(lock.pid, 'SIGTERM')
  } catch {
    // already gone
  }
  // Wait for the lock to be unlinked by the daemon's shutdown handler.
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const cur = await readLock()
    if (!cur || cur.pid !== lock.pid) return
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('yaac daemon start / stop / restart (subprocess)', () => {
  let homeDir: string
  let dataDir: string
  let env: NodeJS.ProcessEnv

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-daemon-lifecycle-'))
    dataDir = path.join(homeDir, '.yaac')
    await fs.mkdir(path.join(dataDir, 'projects'), { recursive: true })
    setDataDir(dataDir)
    env = { ...process.env, HOME: homeDir, YAAC_BUILD_ID: 'test-build-id' }
  })

  afterEach(async () => {
    await killDaemonByLock()
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('`daemon start` spawns a background daemon that writes the lock', async () => {
    expect(await readLock()).toBeNull()
    const { exitCode } = await runCli(env, 'daemon', 'start')
    expect(exitCode).toBe(0)
    const lock = await readLock()
    expect(lock).not.toBeNull()
    const res = await fetch(`http://127.0.0.1:${lock!.port}/health`)
    expect(res.status).toBe(200)
  })

  it('`daemon start` is idempotent when the running version matches', async () => {
    const first = await runCli(env, 'daemon', 'start')
    expect(first.exitCode).toBe(0)
    const firstLock = await readLock()
    const second = await runCli(env, 'daemon', 'start')
    expect(second.exitCode).toBe(0)
    expect(second.stderr).toMatch(/already running/)
    const secondLock = await readLock()
    expect(secondLock?.pid).toBe(firstLock?.pid)
  })

  it('`daemon start` errors when a running daemon has a mismatched buildId', async () => {
    const startEnv = { ...env, YAAC_BUILD_ID: 'old-build' }
    const first = await runCli(startEnv, 'daemon', 'start')
    expect(first.exitCode).toBe(0)

    const second = await runCli(env, 'daemon', 'start')
    expect(second.exitCode).toBe(1)
    expect(second.stderr).toMatch(/outdated version/)
    expect(second.stderr).toMatch(/yaac daemon restart/)
  })

  it('`daemon stop` SIGTERMs the daemon and clears the lock', async () => {
    await runCli(env, 'daemon', 'start')
    expect(await readLock()).not.toBeNull()
    const { exitCode, stderr } = await runCli(env, 'daemon', 'stop')
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/daemon stopped/)
    expect(await readLock()).toBeNull()
  })

  it('`daemon stop` is a no-op when no daemon is running', async () => {
    const { exitCode, stderr } = await runCli(env, 'daemon', 'stop')
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/not running/)
  })

  it('`daemon restart` replaces the running daemon with a fresh one', async () => {
    await runCli(env, 'daemon', 'start')
    const before = await readLock()
    expect(before).not.toBeNull()

    const { exitCode } = await runCli(env, 'daemon', 'restart')
    expect(exitCode).toBe(0)

    const after = await readLock()
    expect(after).not.toBeNull()
    expect(after!.pid).not.toBe(before!.pid)
    const res = await fetch(`http://127.0.0.1:${after!.port}/health`)
    expect(res.status).toBe(200)
  })

  it('`daemon restart` starts a daemon even when none was running', async () => {
    expect(await readLock()).toBeNull()
    const { exitCode } = await runCli(env, 'daemon', 'restart')
    expect(exitCode).toBe(0)
    expect(await readLock()).not.toBeNull()
  })
})

describe('yaac daemon logs (subprocess)', () => {
  let homeDir: string
  let dataDir: string
  let env: NodeJS.ProcessEnv

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-daemon-logs-'))
    dataDir = path.join(homeDir, '.yaac')
    await fs.mkdir(path.join(dataDir, 'projects'), { recursive: true })
    setDataDir(dataDir)
    env = { ...process.env, HOME: homeDir, YAAC_BUILD_ID: 'test-build-id' }
  })

  afterEach(async () => {
    await killDaemonByLock()
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('tells the user when no log file exists yet', async () => {
    const { exitCode, stderr, stdout } = await runCli(env, 'daemon', 'logs')
    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/no daemon log at/)
    expect(stdout).toBe('')
  })

  it('prints the daemon log after `daemon start` has written to it', async () => {
    const started = await runCli(env, 'daemon', 'start')
    expect(started.exitCode).toBe(0)

    // Hit /health to guarantee the request logger has flushed at least
    // one line, plus the initial "listening on …" line from startup.
    const lock = await readLock()
    await fetch(`http://127.0.0.1:${lock!.port}/health`)

    const { exitCode, stdout } = await runCli(env, 'daemon', 'logs')
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/\[daemon\] listening on 127\.0\.0\.1:/)
    expect(stdout).toMatch(/GET \/health 200/)
  })

  it('`-n 1` prints only the last line', async () => {
    // Seed the log file directly so the assertion is deterministic
    // regardless of how many lines the daemon itself wrote.
    await fs.writeFile(daemonLogPath(), 'first\nsecond\nthird\n')
    const { exitCode, stdout } = await runCli(env, 'daemon', 'logs', '-n', '1')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('third\n')
  })

  it('`--lines 2` prints only the last 2 lines', async () => {
    await fs.writeFile(daemonLogPath(), 'a\nb\nc\nd\n')
    const { exitCode, stdout } = await runCli(env, 'daemon', 'logs', '--lines', '2')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('c\nd\n')
  })

  it('`-f` keeps printing new lines until interrupted', async () => {
    await fs.writeFile(daemonLogPath(), 'initial\n')

    const child = spawn(process.execPath, [TSX_CLI, ENTRY, 'daemon', 'logs', '-f'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })

      // Wait for the initial content to be flushed.
      await waitFor(() => stdout.includes('initial\n'), 3000)

      // Append more — the follow loop polls at 200ms, so 500ms is plenty.
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

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('waitFor timed out')
}

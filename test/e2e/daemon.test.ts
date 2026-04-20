import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@/lib/project/paths'
import { daemonLockPath, readLock, type DaemonLock } from '@/lib/daemon/lock'

const TSX_CLI = path.resolve(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const ENTRY = path.resolve(__dirname, '..', '..', 'src', 'index.ts')

interface SpawnedDaemon {
  child: ChildProcess
  lock: DaemonLock
  stop: () => Promise<void>
}

async function startDaemon(env: NodeJS.ProcessEnv): Promise<SpawnedDaemon> {
  const child = spawn(process.execPath, [TSX_CLI, ENTRY, 'daemon', '--port', '0'], {
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

describe('yaac daemon (subprocess)', () => {
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
    await fs.rm(homeDir, { recursive: true, force: true })
  })

  it('binds, writes the lock, and /health responds', async () => {
    daemon = await startDaemon(env)
    expect(daemon.lock.port).toBeGreaterThan(0)
    expect(daemon.lock.secret).toMatch(/^[0-9a-f]{64}$/)

    const res = await fetch(`http://127.0.0.1:${daemon.lock.port}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('a second `yaac daemon` invocation is idempotent', async () => {
    daemon = await startDaemon(env)
    const firstPort = daemon.lock.port

    const second = spawn(process.execPath, [TSX_CLI, ENTRY, 'daemon', '--port', '0'], {
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
    expect(body.error.code).toBe('AUTH_REQUIRED')
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@/lib/project/paths'
import { readLock, type DaemonLock } from '@/shared/lock'

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

/**
 * HTTP-surface smoke tests for the spawned daemon. CLI lifecycle and
 * logs tests live in `test/e2e-cli/daemon.test.ts`; these verify that
 * a real daemon subprocess answers its bearer-guarded endpoints with
 * the shapes the CLI client relies on.
 */
describe('yaac daemon HTTP surface (subprocess)', () => {
  let homeDir: string
  let dataDir: string
  let daemon: SpawnedDaemon | null = null
  let env: NodeJS.ProcessEnv

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-daemon-test-'))
    dataDir = path.join(homeDir, '.yaac')
    await fs.mkdir(path.join(dataDir, 'projects'), { recursive: true })
    setDataDir(dataDir)
    env = { ...process.env, YAAC_DATA_DIR: dataDir, YAAC_BUILD_ID: 'test-build-id' }
  })

  afterEach(async () => {
    if (daemon) await daemon.stop()
    daemon = null
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import type { ServerTarget } from '#server-client'
import {
  ensureAuthDaemonSpawned,
  readAuthDaemonLock,
  spawnAuthDaemonDetached,
  writeAuthDaemonLock,
} from '#auth-daemon'
import { setDataDir } from '#paths'

const TARGET: ServerTarget = { baseUrl: 'http://127.0.0.1:8787', secret: 's3cret', remote: false }
const INVOCATION = { bin: '/App/Resources/node/node', args: ['/App/Resources/server/dist/cli.js', 'auth', 'server', 'run'] }

interface SpawnCall {
  bin: string
  args: string[]
  opts: { detached?: boolean, stdio?: string, env?: NodeJS.ProcessEnv }
}

/** A spawn fake: records its args, optionally emits a spawn error. */
function fakeSpawn(outcome: { error?: Error } = {}) {
  const calls: SpawnCall[] = []
  const unref = vi.fn()
  const impl = ((bin: string, args: string[], opts: SpawnCall['opts']) => {
    calls.push({ bin, args, opts })
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = unref
    if (outcome.error) queueMicrotask(() => child.emit('error', outcome.error))
    return child
  }) as unknown as typeof spawn
  return { impl, calls, unref }
}

describe('spawnAuthDaemonDetached', () => {
  it('spawns the provided invocation detached with the given env', async () => {
    const { impl, calls, unref } = fakeSpawn()
    await spawnAuthDaemonDetached({ invocation: INVOCATION, env: { PATH: '/opt/x' }, spawnImpl: impl })
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe(INVOCATION.bin)
    expect(calls[0].args).toEqual(INVOCATION.args)
    expect(calls[0].opts).toMatchObject({ detached: true, stdio: 'ignore', env: { PATH: '/opt/x' } })
    expect(unref).toHaveBeenCalledTimes(1)
  })
  it('defaults to relaunching this process as `yaac auth server run` with the full env', async () => {
    const { impl, calls } = fakeSpawn()
    await spawnAuthDaemonDetached({ spawnImpl: impl })
    expect(calls[0].args.slice(-3)).toEqual(['auth', 'server', 'run'])
    expect(calls[0].opts.env).toBe(process.env)
  })
  it('rejects when the child fails to spawn', async () => {
    const { impl } = fakeSpawn({ error: new Error('spawn yaac ENOENT') })
    await expect(spawnAuthDaemonDetached({ invocation: INVOCATION, spawnImpl: impl }))
      .rejects.toThrow('ENOENT')
  })
})

describe('ensureAuthDaemonSpawned', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-authd-ensure-'))
    setDataDir(dir)
  })

  afterEach(async () => {
    setDataDir('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('no lock → spawns and returns the target', async () => {
    const { impl, calls } = fakeSpawn()
    const killImpl = vi.fn()
    const result = await ensureAuthDaemonSpawned({
      target: TARGET, invocation: INVOCATION, spawnImpl: impl, killImpl,
    })
    expect(result).toEqual({ baseUrl: TARGET.baseUrl, secret: TARGET.secret })
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe(INVOCATION.bin)
    expect(killImpl).not.toHaveBeenCalled()
  })
  it('live daemon at the same baseUrl → no spawn, no kill', async () => {
    await writeAuthDaemonLock({ pid: process.pid, baseUrl: TARGET.baseUrl, startedAt: 1 })
    const { impl, calls } = fakeSpawn()
    const killImpl = vi.fn()
    await ensureAuthDaemonSpawned({ target: TARGET, invocation: INVOCATION, spawnImpl: impl, killImpl })
    expect(calls).toHaveLength(0)
    expect(killImpl).not.toHaveBeenCalled()
  })
  it('dead-pid lock → spawns without killing', async () => {
    // PID guaranteed unused: beyond typical pid_max on test hosts.
    await writeAuthDaemonLock({ pid: 2 ** 30, baseUrl: TARGET.baseUrl, startedAt: 1 })
    const { impl, calls } = fakeSpawn()
    const killImpl = vi.fn()
    await ensureAuthDaemonSpawned({ target: TARGET, invocation: INVOCATION, spawnImpl: impl, killImpl })
    expect(calls).toHaveLength(1)
    expect(killImpl).not.toHaveBeenCalled()
  })
  it('live daemon at a different baseUrl → SIGTERM, lock removed, respawn', async () => {
    await writeAuthDaemonLock({ pid: process.pid, baseUrl: 'http://other:1', startedAt: 1 })
    const { impl, calls } = fakeSpawn()
    const killImpl = vi.fn()
    await ensureAuthDaemonSpawned({ target: TARGET, invocation: INVOCATION, spawnImpl: impl, killImpl })
    expect(killImpl).toHaveBeenCalledWith(process.pid, 'SIGTERM')
    expect(await readAuthDaemonLock()).toBeNull()
    expect(calls).toHaveLength(1)
  })
  it('without a pre-resolved target the default resolution throws off-CLI', async () => {
    // Documents the desktop trap: no remote.json, no live server lock, and
    // (in this process) no .build-id — the default resolveServerTarget()
    // path cannot succeed, so non-CLI callers must pass `target`.
    const { impl, calls } = fakeSpawn()
    await expect(ensureAuthDaemonSpawned({ invocation: INVOCATION, spawnImpl: impl }))
      .rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

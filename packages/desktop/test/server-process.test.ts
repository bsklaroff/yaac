import { EventEmitter } from 'node:events'
import type { execFile } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { ensureAuthDaemonSpawned } from '@yaac/shared/auth-daemon'
import type { ServerTarget } from '@yaac/shared/server-api'
import type { SpawnImpl } from '#server-process'
import {
  ensureAuthDaemonRunning, loginShellPath, resolveYaacCommand, runYaacServerStart,
} from '#server-process'

interface FakeOutcome {
  error?: NodeJS.ErrnoException
  code?: number
  stderr?: string
}

/** A spawn fake: each call consumes the next outcome; records its args. */
function fakeSpawn(outcomes: FakeOutcome[]) {
  const calls: { cmd: string, args: string[], path: string | undefined }[] = []
  const impl = ((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    const outcome = outcomes.shift() ?? { code: 0 }
    calls.push({ cmd, args, path: opts.env?.PATH })
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      if (outcome.error) {
        child.emit('error', outcome.error)
        return
      }
      if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr))
      child.emit('close', outcome.code ?? 0)
    })
    return child
  }) as unknown as SpawnImpl
  return { impl, calls }
}

function enoent(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('spawn yaac ENOENT')
  err.code = 'ENOENT'
  return err
}

describe('resolveYaacCommand', () => {
  it('spawns yaac from PATH in dev (no resources dir)', () => {
    expect(resolveYaacCommand(null, ['server', 'start'])).toEqual({ bin: 'yaac', args: ['server', 'start'] })
    expect(resolveYaacCommand(null, ['auth', 'server', 'run'])).toEqual({ bin: 'yaac', args: ['auth', 'server', 'run'] })
  })
  it('runs the bundled node + staged cli.js when packaged', () => {
    expect(resolveYaacCommand('/Applications/yaac.app/Contents/Resources', ['auth', 'server', 'run'])).toEqual({
      bin: '/Applications/yaac.app/Contents/Resources/node/node',
      args: ['/Applications/yaac.app/Contents/Resources/server/dist/cli.js', 'auth', 'server', 'run'],
    })
  })
})

describe('runYaacServerStart', () => {
  it('resolves with the exit code and trimmed stderr', async () => {
    const { impl, calls } = fakeSpawn([{ code: 1, stderr: 'boom\n' }])
    expect(await runYaacServerStart(resolveYaacCommand(null, ['server', 'start']), {
      spawnImpl: impl, resolvePath: () => Promise.resolve(null),
    })).toEqual({ code: 1, stderr: 'boom' })
    expect(calls).toEqual([{ cmd: 'yaac', args: ['server', 'start'], path: undefined }])
  })
  it('on ENOENT retries once with the login-shell PATH', async () => {
    const { impl, calls } = fakeSpawn([{ error: enoent() }, { code: 0 }])
    const resolvePath = vi.fn(() => Promise.resolve('/opt/homebrew/bin:/usr/bin'))
    expect(await runYaacServerStart(resolveYaacCommand(null, ['server', 'start']), {
      spawnImpl: impl, resolvePath,
    })).toEqual({ code: 0, stderr: '' })
    expect(calls[1].path).toBe('/opt/homebrew/bin:/usr/bin')
  })
  it('rethrows ENOENT when no login-shell PATH resolves', async () => {
    const { impl } = fakeSpawn([{ error: enoent() }])
    await expect(runYaacServerStart(resolveYaacCommand(null, ['server', 'start']), {
      spawnImpl: impl, resolvePath: () => Promise.resolve(null),
    })).rejects.toThrow('ENOENT')
  })
  it('rethrows non-ENOENT spawn errors without retrying', async () => {
    const err: NodeJS.ErrnoException = new Error('EACCES')
    err.code = 'EACCES'
    const { impl, calls } = fakeSpawn([{ error: err }, { code: 0 }])
    await expect(runYaacServerStart(resolveYaacCommand(null, ['server', 'start']), {
      spawnImpl: impl, resolvePath: () => Promise.resolve('/bin'),
    })).rejects.toThrow('EACCES')
    expect(calls).toHaveLength(1)
  })

  it('hydratePath resolves the login-shell PATH up front (packaged)', async () => {
    const { impl, calls } = fakeSpawn([{ code: 0 }])
    const cmd = resolveYaacCommand('/App/Resources', ['server', 'start'])
    const resolvePath = vi.fn(() => Promise.resolve('/opt/homebrew/bin:/usr/bin'))
    await runYaacServerStart(cmd, { spawnImpl: impl, resolvePath, hydratePath: true })
    expect(resolvePath).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([{
      cmd: '/App/Resources/node/node',
      args: ['/App/Resources/server/dist/cli.js', 'server', 'start'],
      path: '/opt/homebrew/bin:/usr/bin',
    }])
  })
  it('hydratePath keeps the inherited env when no PATH resolves', async () => {
    const { impl, calls } = fakeSpawn([{ code: 0 }])
    await runYaacServerStart(resolveYaacCommand('/App/Resources', ['server', 'start']), {
      spawnImpl: impl, resolvePath: () => Promise.resolve(null), hydratePath: true,
    })
    expect(calls[0].path).toBeUndefined()
  })
})

describe('ensureAuthDaemonRunning', () => {
  const TARGET: ServerTarget = { baseUrl: 'http://127.0.0.1:8787', secret: 's', remote: false }
  const CMD = resolveYaacCommand('/App/Resources', ['auth', 'server', 'run'])
  const fakeEnsure = () => vi.fn(
    (() => Promise.resolve({ baseUrl: TARGET.baseUrl, secret: TARGET.secret })) as typeof ensureAuthDaemonSpawned,
  )

  it('forwards the target and invocation with the inherited env (dev)', async () => {
    const ensureImpl = fakeEnsure()
    await ensureAuthDaemonRunning({ target: TARGET, command: CMD, ensureImpl })
    expect(ensureImpl).toHaveBeenCalledTimes(1)
    expect(ensureImpl).toHaveBeenCalledWith({ target: TARGET, invocation: CMD, env: undefined })
  })
  it('hydratePath hands the daemon the login-shell PATH over the inherited env', async () => {
    const ensureImpl = fakeEnsure()
    const resolvePath = vi.fn(() => Promise.resolve('/opt/homebrew/bin:/usr/bin'))
    await ensureAuthDaemonRunning({
      target: TARGET, command: CMD, hydratePath: true, resolvePath, ensureImpl,
    })
    expect(resolvePath).toHaveBeenCalledTimes(1)
    expect(ensureImpl).toHaveBeenCalledWith({
      target: TARGET,
      invocation: CMD,
      env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin' },
    })
  })
  it('hydratePath keeps the inherited env when no PATH resolves', async () => {
    const ensureImpl = fakeEnsure()
    await ensureAuthDaemonRunning({
      target: TARGET, command: CMD, hydratePath: true, resolvePath: () => Promise.resolve(null), ensureImpl,
    })
    expect(ensureImpl).toHaveBeenCalledWith({ target: TARGET, invocation: CMD, env: undefined })
  })
  it('propagates ensure failures (the swallow lives in the flow)', async () => {
    const ensureImpl = vi.fn(
      (() => Promise.reject(new Error('spawn yaac ENOENT'))) as typeof ensureAuthDaemonSpawned,
    )
    await expect(ensureAuthDaemonRunning({ target: TARGET, command: CMD, ensureImpl }))
      .rejects.toThrow('ENOENT')
  })
})

describe('loginShellPath', () => {
  const exec = (stdout: string | Error) => ((
    _cmd: string,
    _args: readonly string[],
    _opts: object,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (stdout instanceof Error) cb(stdout, '', '')
    else cb(null, stdout, '')
  }) as unknown as typeof execFile

  it('returns the printed PATH', async () => {
    expect(await loginShellPath(exec('/opt/homebrew/bin:/usr/bin'))).toBe('/opt/homebrew/bin:/usr/bin')
  })
  it('returns null on shell failure or empty output', async () => {
    expect(await loginShellPath(exec(new Error('no such shell')))).toBeNull()
    expect(await loginShellPath(exec('  '))).toBeNull()
  })
})

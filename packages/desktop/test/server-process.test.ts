import type { execFile } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { ensureAuthDaemonSpawned } from '@yaac/shared/auth-daemon'
import type { ServerTarget } from '@yaac/shared/server-api'
import {
  ensureAuthDaemonRunning, loginShellPath, resolveYaacCommand,
} from '#server-process'

describe('resolveYaacCommand', () => {
  it('runs yaac from PATH in dev (no resources dir)', () => {
    expect(resolveYaacCommand(null, ['auth', 'server', 'run'])).toEqual({ bin: 'yaac', args: ['auth', 'server', 'run'] })
  })
  it('runs the bundled node + staged cli.js when packaged', () => {
    expect(resolveYaacCommand('/Applications/yaac.app/Contents/Resources', ['auth', 'server', 'run'])).toEqual({
      bin: '/Applications/yaac.app/Contents/Resources/node/node',
      args: ['/Applications/yaac.app/Contents/Resources/server/dist/cli.js', 'auth', 'server', 'run'],
    })
  })
})

describe('ensureAuthDaemonRunning', () => {
  const TARGET: ServerTarget = { baseUrl: 'http://127.0.0.1:8787', secret: 's' }
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

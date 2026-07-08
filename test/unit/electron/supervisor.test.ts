import { describe, it, expect, vi } from 'vitest'
import {
  decideDaemonAction,
  resolveDaemonStartCommand,
  ensureDaemonRunning,
  type DaemonStartContext,
  type EnsureDaemonDeps,
} from '@/electron/supervisor'
import type { DaemonLock } from '@/shared/lock'

const lock = (over: Partial<DaemonLock> = {}): DaemonLock => ({
  pid: 123, port: 8787, secret: 's', startedAt: 0, buildId: 'bid', ...over,
})

describe('decideDaemonAction', () => {
  it('starts when there is no lock', () => {
    expect(decideDaemonAction(null, false, 'bid')).toBe('start')
  })
  it('starts when the lock is present but not live', () => {
    expect(decideDaemonAction(lock(), false, 'bid')).toBe('start')
  })
  it('restarts a live daemon on a buildId mismatch', () => {
    expect(decideDaemonAction(lock({ buildId: 'old' }), true, 'bid')).toBe('restart')
  })
  it('reuses a live daemon whose buildId matches', () => {
    expect(decideDaemonAction(lock({ buildId: 'bid' }), true, 'bid')).toBe('reuse')
  })
})

const baseCtx = (over: Partial<DaemonStartContext> = {}): DaemonStartContext => ({
  override: undefined,
  bundled: false,
  execPath: '/path/to/electron',
  bundledCliEntry: '/app/dist/cli.js',
  tsxCli: '/repo/node_modules/tsx/dist/cli.mjs',
  devCliEntry: '/repo/src/cli.ts',
  nodeBin: 'node',
  ...over,
})

describe('resolveDaemonStartCommand', () => {
  it('runs the source CLI via tsx in dev', () => {
    const cmd = resolveDaemonStartCommand('start', baseCtx())
    expect(cmd.bin).toBe('node')
    expect(cmd.args).toEqual([
      '/repo/node_modules/tsx/dist/cli.mjs', '/repo/src/cli.ts', 'daemon', 'start',
    ])
    expect(cmd.extraEnv).toEqual({})
  })
  it('appends the restart subcommand for a restart', () => {
    const cmd = resolveDaemonStartCommand('restart', baseCtx())
    expect(cmd.args.slice(-2)).toEqual(['daemon', 'restart'])
  })
  it('runs the bundled CLI via Electron-as-Node when packaged', () => {
    const cmd = resolveDaemonStartCommand('start', baseCtx({ bundled: true }))
    expect(cmd.bin).toBe('/path/to/electron')
    expect(cmd.args).toEqual(['/app/dist/cli.js', 'daemon', 'start'])
    expect(cmd.extraEnv).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })
  it('honors a JSON argv override, appending the subcommand', () => {
    const cmd = resolveDaemonStartCommand('start', baseCtx({
      override: '["/usr/bin/node","/x/cli.js"]',
    }))
    expect(cmd.bin).toBe('/usr/bin/node')
    expect(cmd.args).toEqual(['/x/cli.js', 'daemon', 'start'])
  })
  it('ignores a malformed override and falls back to the dev resolution', () => {
    const cmd = resolveDaemonStartCommand('start', baseCtx({ override: 'not json' }))
    expect(cmd.bin).toBe('node')
  })
  it('throws in dev when tsx cannot be found', () => {
    expect(() => resolveDaemonStartCommand('start', baseCtx({ tsxCli: null })))
      .toThrow(/tsx/)
  })
})

describe('ensureDaemonRunning', () => {
  const deps = (over: Partial<EnsureDaemonDeps>): EnsureDaemonDeps => ({
    readBuildId: () => Promise.resolve('bid'),
    readLock: () => Promise.resolve(lock()),
    isLockLive: () => Promise.resolve(true),
    runDaemonStart: () => Promise.resolve(),
    waitForLiveLock: () => Promise.resolve(lock()),
    ...over,
  })

  it('reuses a live matching daemon without starting anything', async () => {
    const runDaemonStart = vi.fn(() => Promise.resolve())
    const result = await ensureDaemonRunning(deps({ runDaemonStart }))
    expect(runDaemonStart).not.toHaveBeenCalled()
    expect(result.port).toBe(8787)
  })

  it('starts a daemon when none is running, then waits for the fresh lock', async () => {
    const runDaemonStart = vi.fn(() => Promise.resolve())
    const fresh = lock({ pid: 999, port: 9000 })
    const result = await ensureDaemonRunning(deps({
      readLock: () => Promise.resolve(null),
      isLockLive: () => Promise.resolve(false),
      runDaemonStart,
      waitForLiveLock: () => Promise.resolve(fresh),
    }))
    expect(runDaemonStart).toHaveBeenCalledWith('start')
    expect(result.port).toBe(9000)
  })

  it('restarts an outdated daemon', async () => {
    const runDaemonStart = vi.fn(() => Promise.resolve())
    await ensureDaemonRunning(deps({
      readLock: () => Promise.resolve(lock({ buildId: 'old' })),
      isLockLive: () => Promise.resolve(true),
      runDaemonStart,
    }))
    expect(runDaemonStart).toHaveBeenCalledWith('restart')
  })

  it('reuses a live matching daemon in attach mode', async () => {
    const runDaemonStart = vi.fn(() => Promise.resolve())
    const result = await ensureDaemonRunning(deps({ allowStart: false, runDaemonStart }))
    expect(runDaemonStart).not.toHaveBeenCalled()
    expect(result.port).toBe(8787)
  })

  it('throws in attach mode when a start would be needed', async () => {
    const runDaemonStart = vi.fn(() => Promise.resolve())
    await expect(ensureDaemonRunning(deps({
      readLock: () => Promise.resolve(null),
      isLockLive: () => Promise.resolve(false),
      allowStart: false,
      runDaemonStart,
    }))).rejects.toThrow(/attach mode/)
    expect(runDaemonStart).not.toHaveBeenCalled()
  })
})

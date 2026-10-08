import { EventEmitter } from 'node:events'
import type { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adoptLoginShellPath, createAuthDaemonRunner, stopLegacyAuthDaemon } from '#server-process'

describe('adoptLoginShellPath', () => {
  const inherited = process.env.PATH
  afterEach(() => { process.env.PATH = inherited })

  it('takes the PATH the login shell prints, ignoring what its rc files print', async () => {
    // A real shell whose "rc" prints around the PATH line.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-shell-'))
    const shell = path.join(dir, 'sh')
    await fs.writeFile(shell, '#!/bin/sh\necho "welcome back"\nPATH=/opt/homebrew/bin:/usr/bin\nshift\neval "$1"\necho bye\n', { mode: 0o755 })
    const savedShell = process.env.SHELL
    process.env.SHELL = shell
    try {
      await adoptLoginShellPath()
      expect(process.env.PATH).toBe('/opt/homebrew/bin:/usr/bin')
    } finally {
      process.env.SHELL = savedShell
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
  it('keeps the inherited PATH on shell failure or no PATH printed', async () => {
    const exec = (stdout: string | Error) => ((
      _cmd: string, _args: readonly string[], _opts: object,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (stdout instanceof Error) cb(stdout, '', '')
      else cb(null, stdout, '')
    }) as unknown as typeof execFile
    await adoptLoginShellPath(exec(new Error('no such shell')))
    await adoptLoginShellPath(exec('welcome back\n'))
    expect(process.env.PATH).toBe(inherited)
  })
})

describe('stopLegacyAuthDaemon', () => {
  let dir: string
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  /** A live process whose command line reads as `extra`. */
  async function child(...extra: string[]) {
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...extra], { stdio: 'ignore' })
    await new Promise((r) => proc.once('spawn', r))
    const exited = new Promise((r) => proc.once('exit', (_code, signal) => r(signal)))
    return { proc, exited }
  }

  it('signals the daemon an older yaac left and removes its lock', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-legacy-'))
    const lock = path.join(dir, '.auth-daemon.lock')
    const daemon = await child('auth', 'server', 'run')
    await fs.writeFile(lock, JSON.stringify({ pid: daemon.proc.pid, baseUrl: 'http://x', startedAt: 1 }))
    await stopLegacyAuthDaemon(lock)
    expect(await daemon.exited).toBe('SIGTERM')
    await expect(fs.access(lock)).rejects.toThrow()
  })
  it('leaves a process that reused the pid alone, and is a no-op without a lock', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-legacy-'))
    const lock = path.join(dir, '.auth-daemon.lock')
    const other = await child('something', 'else')
    try {
      await fs.writeFile(lock, JSON.stringify({ pid: other.proc.pid }))
      await stopLegacyAuthDaemon(lock)
      await expect(fs.access(lock)).rejects.toThrow()
      expect(other.proc.exitCode).toBeNull()
      expect(other.proc.signalCode).toBeNull()
      await stopLegacyAuthDaemon(lock)
    } finally {
      other.proc.kill()
    }
  })
})

describe('createAuthDaemonRunner', () => {
  afterEach(() => { vi.useRealTimers() })

  /** A fork fake whose children record kills and can exit on demand. */
  function fakeFork() {
    const children: (EventEmitter & { baseUrl: string, kill: ReturnType<typeof vi.fn> })[] = []
    const fork = vi.fn((baseUrl: string) => {
      const child = Object.assign(new EventEmitter(), { baseUrl, kill: vi.fn(() => true) })
      children.push(child)
      return child
    })
    return { fork, children }
  }
  const A = { baseUrl: 'http://127.0.0.1:8787' }
  const B = { baseUrl: 'https://srv.tailnet.ts.net' }

  it('runs one daemon per server, handed its origin, and replaces it on a switch', () => {
    const { fork, children } = fakeFork()
    const runner = createAuthDaemonRunner(fork)

    runner.ensure(A)
    runner.ensure(A)
    expect(fork).toHaveBeenCalledTimes(1)
    expect(children[0].baseUrl).toBe(A.baseUrl)

    runner.ensure(B)
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    expect(children[1].baseUrl).toBe(B.baseUrl)

    // The replaced child's exit restarts nothing.
    children[0].emit('exit')
    runner.stop()
    expect(children[1].kill).toHaveBeenCalledTimes(1)
    children[1].emit('exit')
    expect(fork).toHaveBeenCalledTimes(2)
  })

  it('restarts a daemon that exits on its own, backing off while it keeps crashing', () => {
    vi.useFakeTimers()
    const { fork, children } = fakeFork()
    const runner = createAuthDaemonRunner(fork, { minDelayMs: 100, maxDelayMs: 1000 })
    runner.ensure(A)

    children[0].emit('exit')
    vi.advanceTimersByTime(99)
    expect(fork).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(children[1].baseUrl).toBe(A.baseUrl)

    children[1].emit('exit')
    vi.advanceTimersByTime(199)
    expect(fork).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    expect(fork).toHaveBeenCalledTimes(3)

    // One that stayed up a while restarts after the shortest delay again.
    vi.advanceTimersByTime(1000)
    children[2].emit('exit')
    vi.advanceTimersByTime(100)
    expect(fork).toHaveBeenCalledTimes(4)

    // Stopping cancels a pending restart.
    children[3].emit('exit')
    runner.stop()
    vi.advanceTimersByTime(10_000)
    expect(fork).toHaveBeenCalledTimes(4)
  })
})

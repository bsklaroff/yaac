import { EventEmitter } from 'node:events'
import type { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adoptLoginShellPath, createAuthDaemonRunner } from '#server-process'

describe('adoptLoginShellPath', () => {
  const inherited = process.env.PATH
  afterEach(() => { process.env.PATH = inherited })

  it('takes the PATH the login shell prints, ignoring what its rc files print, plus Homebrew\'s', async () => {
    // A real shell whose "rc" prints around the PATH line.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-shell-'))
    const shell = path.join(dir, 'sh')
    await fs.writeFile(shell, '#!/bin/sh\necho "welcome back"\nPATH=/opt/homebrew/bin:/usr/bin\nshift\neval "$1"\necho bye\n', { mode: 0o755 })
    const savedShell = process.env.SHELL
    process.env.SHELL = shell
    try {
      await adoptLoginShellPath()
      expect(process.env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/usr/local/bin')
    } finally {
      process.env.SHELL = savedShell
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
  it('keeps the inherited PATH, plus Homebrew\'s, on shell failure or no PATH printed', async () => {
    const exec = (stdout: string | Error) => ((
      _cmd: string, _args: readonly string[], _opts: object,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (stdout instanceof Error) cb(stdout, '', '')
      else cb(null, stdout, '')
    }) as unknown as typeof execFile
    process.env.PATH = '/usr/bin:/bin'
    await adoptLoginShellPath(exec(new Error('no such shell')))
    expect(process.env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin')
    process.env.PATH = '/usr/bin:/bin'
    await adoptLoginShellPath(exec('welcome back\n'))
    expect(process.env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin')
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

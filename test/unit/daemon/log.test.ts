import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, daemonLogPath } from '@/shared/paths'
import { daemonLog } from '@/daemon/log'
import { daemonLogs } from '@/daemon/cli'

describe('daemonLog', () => {
  let dataDir: string
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-log-test-'))
    setDataDir(dataDir)
    consoleErrorSpy.mockClear()
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('writes the message to stderr via console.error', () => {
    daemonLog('[daemon] hello')
    expect(consoleErrorSpy).toHaveBeenCalledWith('[daemon] hello')
  })

  it('appends a timestamped line to the log file', async () => {
    daemonLog('[daemon] line-one')
    daemonLog('[daemon] line-two')
    const contents = await fs.readFile(daemonLogPath(), 'utf8')
    const lines = contents.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[daemon\] line-one$/)
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[daemon\] line-two$/)
  })

  it('creates the data dir on demand', async () => {
    // Fresh subdir that doesn't exist yet.
    const nested = path.join(dataDir, 'nested', 'deeper')
    setDataDir(nested)
    daemonLog('[daemon] create me')
    const contents = await fs.readFile(path.join(nested, 'daemon.log'), 'utf8')
    expect(contents).toContain('[daemon] create me')
  })
})

describe('daemonLogs', () => {
  let dataDir: string
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-logs-test-'))
    setDataDir(dataDir)
    consoleErrorSpy.mockClear()
    stdoutWriteSpy.mockClear()
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  function stdoutContent(): string {
    return stdoutWriteSpy.mock.calls
      .map((args) => {
        const chunk = args[0]
        if (typeof chunk === 'string') return chunk
        if (Buffer.isBuffer(chunk)) return chunk.toString('utf8')
        return ''
      })
      .join('')
  }

  it('prints a notice to stderr when the log file is missing', async () => {
    await daemonLogs()
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('no daemon log at'),
    )
    expect(stdoutContent()).toBe('')
  })

  it('prints the whole log file when no options are given', async () => {
    await fs.writeFile(daemonLogPath(), 'alpha\nbeta\ngamma\n')
    await daemonLogs()
    expect(stdoutContent()).toBe('alpha\nbeta\ngamma\n')
  })

  it('prints only the last N lines when --lines is set', async () => {
    await fs.writeFile(daemonLogPath(), 'one\ntwo\nthree\nfour\nfive\n')
    await daemonLogs({ lines: 2 })
    expect(stdoutContent()).toBe('four\nfive\n')
  })

  it('lines=0 prints nothing but does not error', async () => {
    await fs.writeFile(daemonLogPath(), 'a\nb\n')
    await daemonLogs({ lines: 0 })
    expect(stdoutContent()).toBe('')
  })

  it('lines larger than file prints the whole file', async () => {
    await fs.writeFile(daemonLogPath(), 'a\nb\n')
    await daemonLogs({ lines: 100 })
    expect(stdoutContent()).toBe('a\nb\n')
  })

  it('handles a final line without a trailing newline', async () => {
    await fs.writeFile(daemonLogPath(), 'a\nb\nc')
    await daemonLogs({ lines: 2 })
    expect(stdoutContent()).toBe('b\nc')
  })
})

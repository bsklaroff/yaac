import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { setDataDir, serverLogPath } from '@yaac/shared/paths'
import { serverLog, pipeToServerLog } from '#log'
import { serverLogs } from '#cli'

describe('serverLog', () => {
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
    serverLog('[server] hello')
    expect(consoleErrorSpy).toHaveBeenCalledWith('[server] hello')
  })

  it('appends a timestamped line to the log file', async () => {
    serverLog('[server] line-one')
    serverLog('[server] line-two')
    const contents = await fs.readFile(serverLogPath(), 'utf8')
    const lines = contents.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[server\] line-one$/)
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[server\] line-two$/)
  })

  it('creates the data dir on demand', async () => {
    // Fresh subdir that doesn't exist yet.
    const nested = path.join(dataDir, 'nested', 'deeper')
    setDataDir(nested)
    serverLog('[server] create me')
    const contents = await fs.readFile(path.join(nested, 'server.log'), 'utf8')
    expect(contents).toContain('[server] create me')
  })
})

describe('serverLogs', () => {
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
    await serverLogs()
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('no server log at'),
    )
    expect(stdoutContent()).toBe('')
  })

  it('prints the whole log file when no options are given', async () => {
    await fs.writeFile(serverLogPath(), 'alpha\nbeta\ngamma\n')
    await serverLogs()
    expect(stdoutContent()).toBe('alpha\nbeta\ngamma\n')
  })

  it('prints only the last N lines when --lines is set', async () => {
    await fs.writeFile(serverLogPath(), 'one\ntwo\nthree\nfour\nfive\n')
    await serverLogs({ lines: 2 })
    expect(stdoutContent()).toBe('four\nfive\n')
  })

  it('lines=0 prints nothing but does not error', async () => {
    await fs.writeFile(serverLogPath(), 'a\nb\n')
    await serverLogs({ lines: 0 })
    expect(stdoutContent()).toBe('')
  })

  it('lines larger than file prints the whole file', async () => {
    await fs.writeFile(serverLogPath(), 'a\nb\n')
    await serverLogs({ lines: 100 })
    expect(stdoutContent()).toBe('a\nb\n')
  })

  it('handles a final line without a trailing newline', async () => {
    await fs.writeFile(serverLogPath(), 'a\nb\nc')
    await serverLogs({ lines: 2 })
    expect(stdoutContent()).toBe('b\nc')
  })
})

describe('pipeToServerLog', () => {
  let dataDir: string
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-pipe-log-test-'))
    setDataDir(dataDir)
    consoleErrorSpy.mockClear()
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  async function readLogMessages(): Promise<string[]> {
    const contents = await fs.readFile(serverLogPath(), 'utf8')
    // Strip the leading "<ISO timestamp> " from each line.
    return contents
      .trimEnd()
      .split('\n')
      .map((l) => l.replace(/^\S+ /, ''))
  }

  it('logs one server-log entry per newline-terminated chunk', async () => {
    const s = new PassThrough()
    pipeToServerLog(s, '[build foo] ')
    s.write('alpha\nbeta\n')
    s.end()
    await new Promise((r) => s.on('end', r))
    expect(await readLogMessages()).toEqual(['[build foo] alpha', '[build foo] beta'])
  })

  it('buffers across chunk boundaries until a newline arrives', async () => {
    const s = new PassThrough()
    pipeToServerLog(s, 'p ')
    s.write('hel')
    s.write('lo\nwor')
    s.write('ld\n')
    s.end()
    await new Promise((r) => s.on('end', r))
    expect(await readLogMessages()).toEqual(['p hello', 'p world'])
  })

  it('flushes a trailing partial line on stream end', async () => {
    const s = new PassThrough()
    pipeToServerLog(s, 'p ')
    s.write('no-newline-here')
    s.end()
    await new Promise((r) => s.on('end', r))
    expect(await readLogMessages()).toEqual(['p no-newline-here'])
  })

  it('skips empty lines between consecutive newlines', async () => {
    const s = new PassThrough()
    pipeToServerLog(s, 'p ')
    s.write('a\n\nb\n')
    s.end()
    await new Promise((r) => s.on('end', r))
    expect(await readLogMessages()).toEqual(['p a', 'p b'])
  })

  it('is a no-op when the stream is null', () => {
    expect(() => pipeToServerLog(null, 'p ')).not.toThrow()
  })
})

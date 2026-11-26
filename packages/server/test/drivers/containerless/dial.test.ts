import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { setDataDir } from '@yaac/shared/paths'
import { workspaceDir } from '@yaac/shared/project-paths'
import net from 'node:net'
import { dialCtrlStream, dialSocketStream } from '#drivers/containerless/dial'
import { containerlessJobName } from '#drivers/containerless/paths'

const UUID = '7d3c1f0a-5b2e-4c8d-9a6f-1e2b3c4d5e6f'
const JOB = containerlessJobName('demo', UUID)
let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-dial-'))
  setDataDir(dataDir)
  fs.mkdirSync(workspaceDir('demo', UUID), { recursive: true })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('dialCtrlStream', () => {
  it('survives a write to a child that stopped reading, reporting the end as exit', async () => {
    // The child closes its stdin but lives on, which is the window between
    // a tmux client dying and its exit being handled. A write there raises
    // EPIPE on stdin; unhandled, vitest fails the run as it would crash the
    // server.
    const child = dialCtrlStream(JOB, ['sh', '-c', 'exec 0<&-; sleep 0.3'])
    const exited = new Promise<unknown>((resolve) => child.on('exit', resolve))
    await new Promise((r) => setTimeout(r, 100))
    child.stdin?.write('list-windows\n')
    expect(await exited).toBe(0)
  })
})

describe('dialSocketStream', () => {
  // A new acp window's socket is dialed before acpd binds it; the dial
  // waits for it, and holds what was written meanwhile.
  it('connects once the socket is bound, and reports its end as exit', async () => {
    const sock = path.join(dataDir, 'a.sock')
    let peer: net.Socket | undefined
    const server = net.createServer((c) => {
      peer = c
      c.pipe(c)
    })
    try {
      const child = dialSocketStream(JOB, sock)
      let got = ''
      child.stdout?.on('data', (c) => { got += c.toString() })
      const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
      child.stdin?.write('early ')
      await new Promise<void>((resolve) => server.listen(sock, resolve))
      await vi.waitFor(() => { expect(got).toBe('early ') })
      child.stdin?.write('late')
      await vi.waitFor(() => { expect(got).toBe('early late') })
      peer?.destroy()
      await exited
    } finally {
      server.close()
    }
  })
})

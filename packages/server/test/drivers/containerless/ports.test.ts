import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { setDataDir } from '@yaac/shared/paths'

import type * as childProcess from 'node:child_process'
import type * as hostModule from '#drivers/containerless/host'

const mockDescendants = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  descendantPids: mockDescendants,
}))
// The sweep's process boundary is the lsof it spawns; the fake below is
// what answers it.
const mockSpawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: mockSpawn,
}))
import {
  _resetPortsForTests,
  dialWorkspacePort,
  sweepPorts,
  workspacePorts,
} from '#drivers/containerless/ports'
import {
  _resetRegistryForTests,
  observeLiveness,
  rememberWorkspace,
} from '#drivers/containerless/registry'

const UUID = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
let dataDir: string

/** What lsof prints for `-Ftn`: one field per line, the family before the
 *  name, exactly as the real binary emits it for these listeners. */
function lsofOutput(...listeners: Array<[family: 'IPv4' | 'IPv6', name: string]>): string {
  return ['p4242', ...listeners.flatMap(([t, n]) => [`t${t}`, `n${n}`])].join('\n') + '\n'
}

/** A spawned child that prints `stdout` and exits `code`. */
function fakeChild(stdout: string, code: number): EventEmitter {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  })
  child.stdout.end(stdout)
  setImmediate(() => child.emit('close', code))
  return child
}

/** lsof answering with these listeners — or, with none, exiting 1 the way
 *  it does when nothing matches. */
function listening(...listeners: Array<[family: 'IPv4' | 'IPv6', name: string]>): void {
  mockSpawn.mockImplementation(() => listeners.length === 0
    ? fakeChild('', 1)
    : fakeChild(lsofOutput(...listeners), 0))
}

/** The argv of the one command the sweep spawned. */
function spawnedArgv(): string[] {
  const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]]
  return [cmd, ...args]
}

function running(): void {
  rememberWorkspace({
    projectSlug: 'demo', worktreeId: UUID, tool: 'claude', mode: 'tui',
    prewarm: false, createdAtMs: 1_000, tmuxPid: 4242,
  })
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-ports-'))
  setDataDir(dataDir)
  _resetRegistryForTests()
  _resetPortsForTests()
  mockDescendants.mockReset()
  mockSpawn.mockReset()
  mockDescendants.mockResolvedValue([4242, 5150])
  listening()
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('sweepPorts', () => {
  it('scans only the worktree\'s own process tree, not the host\'s', async () => {
    running()
    await sweepPorts()
    // A worktree's ports are its own tree's: every other listener on the
    // machine belongs to someone else and must never surface as this
    // worktree's.
    expect(mockDescendants).toHaveBeenCalledWith([4242])
    const argv = spawnedArgv()
    expect(argv[0]).toBe('lsof')
    expect(argv).toContain('-a')
    expect(argv[argv.indexOf('-p') + 1]).toBe('4242,5150')
  })

  it('asks lsof for listeners without stat-ing any path', async () => {
    running()
    await sweepPorts()
    // `-b`: without it lsof stats every mount on the host first, and one
    // hung network mount hangs the sweep past its timeout — a host with a
    // live dev server then reports no ports at all. The hang itself cannot
    // be reproduced in a test; this is what guards the flag.
    const argv = spawnedArgv()
    expect(argv.slice(1, 3)).toEqual(['-b', '-w'])
    expect(argv).toContain('-Ftn')
  })

  it('surfaces a detected listener as an identity mapping', async () => {
    running()
    listening(['IPv4', '127.0.0.1:3000'])
    await sweepPorts()
    // The workspace bound the host port itself, so there is nothing to
    // relay — the "mapping" is the port reaching itself, which is what
    // makes the webapp's link work with no forwarder behind it.
    expect(workspacePorts(UUID)).toEqual([{ containerPort: 3000, hostPort: 3000 }])
  })

  it('reports one port for a dev server on both loopbacks, sorted', async () => {
    running()
    listening(['IPv6', '[::1]:5173'], ['IPv4', '127.0.0.1:5173'], ['IPv6', '*:3000'])
    await sweepPorts()
    expect(workspacePorts(UUID)).toEqual([
      { containerPort: 3000, hostPort: 3000 },
      { containerPort: 5173, hostPort: 5173 },
    ])
  })

  it('withholds ports that are a step toward RCE or data exposure', async () => {
    running()
    listening(['IPv4', '*:22'], ['IPv4', '127.0.0.1:5432'], ['IPv4', '127.0.0.1:9229'], ['IPv4', '*:3000'])
    await sweepPorts()
    expect(workspacePorts(UUID)).toEqual([{ containerPort: 3000, hostPort: 3000 }])
  })

  it('reports a change only when the set really moved', async () => {
    running()
    listening(['IPv4', '127.0.0.1:3000'])
    expect(await sweepPorts()).toBe(true)
    // An unchanged sweep must push no snapshot, or an idle host would
    // broadcast one every few seconds forever.
    expect(await sweepPorts()).toBe(false)
    listening(['IPv4', '127.0.0.1:3000'], ['IPv4', '127.0.0.1:5173'])
    expect(await sweepPorts()).toBe(true)
  })

  it('drops a dead workspace\'s ports', async () => {
    running()
    listening(['IPv4', '127.0.0.1:3000'])
    await sweepPorts()
    observeLiveness(UUID, false, { reason: 'agent-exited' })
    expect(await sweepPorts()).toBe(true)
    expect(workspacePorts(UUID)).toEqual([])
  })

  it('reports nothing for a workspace whose tmux pid was never recorded', async () => {
    // Without a tree root there is nothing to walk; the worktree still runs
    // fine, its ports just go unreported.
    rememberWorkspace({
      projectSlug: 'demo', worktreeId: UUID, tool: 'claude', mode: 'tui',
      prewarm: false, createdAtMs: 1_000,
    })
    await sweepPorts()
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(workspacePorts(UUID)).toEqual([])
  })
})

/** A real listener on `host`, echoing a greeting the moment a client
 *  connects and every byte it is sent — the process boundary this dial
 *  crosses. Resolves null when the host cannot be bound here. */
async function listener(host: string): Promise<{ port: number; close: () => void } | null> {
  const server = net.createServer((sock) => {
    sock.write('hello')
    sock.on('data', (chunk: Buffer) => sock.write(chunk))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, host, () => resolve())
    })
  } catch {
    return null
  }
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => server.close(),
  }
}

/** Sweep an lsof answer naming `port` bound at `name`, so it is one this
 *  worktree is offering. */
async function offered(port: number, name = `127.0.0.1:${String(port)}`): Promise<void> {
  running()
  listening([name.startsWith('[') ? 'IPv6' : 'IPv4', name])
  await sweepPorts()
}

function read(stream: NodeJS.ReadableStream, n: number): Promise<string> {
  return new Promise((resolve) => {
    let got = ''
    stream.on('data', (chunk: Buffer) => {
      got += chunk.toString('utf8')
      if (got.length >= n) resolve(got)
    })
  })
}

describe('dialWorkspacePort', () => {
  it('refuses a port the sweep has not surfaced for this worktree', async () => {
    // The tunnel is authenticated but this host is the user's machine: an
    // unoffered port is every other loopback service on it, and the dial
    // must not become a door onto those.
    const srv = await listener('127.0.0.1')
    try {
      await offered(3000)
      await expect(dialWorkspacePort(UUID, srv!.port)).rejects.toThrow(/not one this worktree/)
    } finally {
      srv!.close()
    }
  })

  it('connects to an offered port on loopback, paused so the first bytes survive', async () => {
    const srv = await listener('127.0.0.1')
    try {
      await offered(srv!.port)
      const stream = await dialWorkspacePort(UUID, srv!.port)
      // The greeting was written on connect, before any reader existed: a
      // stream handed over flowing would have dropped it on the floor.
      const got = read(stream, 'hello'.length + 'ping'.length)
      stream.write('ping')
      stream.resume()
      expect(await got).toBe('helloping')
      stream.destroy()
    } finally {
      srv!.close()
    }
  })

  it('dials the listener the worktree holds, not a stranger on the other loopback', async () => {
    // A dev server bound to `localhost` lands on `::1` alone on plenty of
    // hosts, and any local process can take `127.0.0.1` on the same
    // number. The sweep recorded WHICH address the worktree bound, and the
    // dial goes exactly there — a guessed loopback would hand the tunnel
    // to the stranger.
    const mine = await listener('::1')
    if (!mine) return // no IPv6 loopback on this host
    const stranger = net.createServer((sock) => sock.end('stranger'))
    try {
      await new Promise<void>((resolve) => stranger.listen(mine.port, '127.0.0.1', () => resolve()))
      await offered(mine.port, `[::1]:${String(mine.port)}`)
      const stream = await dialWorkspacePort(UUID, mine.port)
      const got = read(stream, 'hello'.length)
      stream.resume()
      expect(await got).toBe('hello')
      stream.destroy()
    } finally {
      mine.close()
      stranger.close()
    }
  })

  it('dials a wildcard listener on the loopback of its own family', async () => {
    const srv = await listener('::')
    if (!srv) return // no IPv6 on this host
    try {
      await offered(srv.port, `*:${String(srv.port)}`)
      const stream = await dialWorkspacePort(UUID, srv.port)
      const got = read(stream, 'hello'.length)
      stream.resume()
      expect(await got).toBe('hello')
      stream.destroy()
    } finally {
      srv.close()
    }
  })

  it('rejects when nothing answers on an offered port any more', async () => {
    const srv = await listener('127.0.0.1')
    const { port } = srv!
    srv!.close()
    await offered(port)
    await expect(dialWorkspacePort(UUID, port)).rejects.toThrow()
  })
})

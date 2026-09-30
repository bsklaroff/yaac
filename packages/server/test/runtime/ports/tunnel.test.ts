/**
 * `attachPortTunnel`, the server half of the port-forward tunnel. The
 * driver's dial is mocked with real streams, so the bytes flow for real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Duplex, PassThrough } from 'node:stream'

vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  TUNNEL_DIAL_FAILED,
  attachPortTunnel,
  type TunnelSocketLike,
} from '#runtime/ports/tunnel'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import type { WorkspaceDriver } from '#drivers/contract'

const dialPort = vi.fn<WorkspaceDriver['dialPort']>()

/** A fake client socket that records what it was sent and accepts frames. */
function fakeSocket(): TunnelSocketLike & {
  sent: Buffer[]
  closed: { code?: number; reason?: string } | null
  push: (data: Buffer, isBinary?: boolean) => void
  hangUp: () => void
} {
  const messageCbs: Array<(d: string | Buffer | ArrayBuffer, b: boolean) => void> = []
  const closeCbs: Array<() => void> = []
  const sock = {
    sent: [] as Buffer[],
    closed: null as { code?: number; reason?: string } | null,
    send: (data: Uint8Array) => { sock.sent.push(Buffer.from(data)) },
    close: (code?: number, reason?: string) => { sock.closed ??= { code, reason } },
    onMessage: (cb: (d: string | Buffer | ArrayBuffer, b: boolean) => void) => { messageCbs.push(cb) },
    onClose: (cb: () => void) => { closeCbs.push(cb) },
    push: (data: Buffer, isBinary = true) => { for (const cb of messageCbs) cb(data, isBinary) },
    hangUp: () => { for (const cb of closeCbs) cb() },
  }
  return sock
}

/**
 * A workspace-side connection: writes land in `written`, and `reply` sends
 * data back. Returned paused, as `dialPort` promises, so the bridge must
 * resume it.
 */
function fakeConnection(): { stream: Duplex; written: () => string; reply: (s: string) => void } {
  const inbound = new PassThrough()
  const outbound = new PassThrough()
  const chunks: Buffer[] = []
  inbound.on('data', (c: Buffer) => chunks.push(c))
  const stream = Duplex.from({ writable: inbound, readable: outbound } as never)
  stream.pause()
  return {
    stream,
    written: () => Buffer.concat(chunks).toString('utf8'),
    reply: (s: string) => outbound.write(Buffer.from(s, 'utf8')),
  }
}

/** Let the dial promise and the stream's own events settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

beforeEach(() => {
  vi.clearAllMocks()
  installFakeWorkspaceDriver({ dialPort })
})

describe('attachPortTunnel', () => {
  it('splices the socket to a connection into the workspace, both ways', async () => {
    const conn = fakeConnection()
    dialPort.mockResolvedValue(conn.stream)
    const sock = fakeSocket()

    attachPortTunnel('sess-1', 5173, sock)
    await settle()

    expect(dialPort).toHaveBeenCalledWith('sess-1', 5173)
    sock.push(Buffer.from('GET / HTTP/1.1\r\n\r\n'))
    await settle()
    expect(conn.written()).toBe('GET / HTTP/1.1\r\n\r\n')

    conn.reply('HTTP/1.1 200 OK\r\n\r\n')
    await settle()
    expect(Buffer.concat(sock.sent).toString('utf8')).toBe('HTTP/1.1 200 OK\r\n\r\n')
  })

  it('reads what the workspace sent before the bridge was wired up', async () => {
    // Protocols where the server speaks first (SMTP, databases) depend on it.
    const conn = fakeConnection()
    conn.reply('220 ready\r\n')
    dialPort.mockResolvedValue(conn.stream)
    const sock = fakeSocket()

    attachPortTunnel('sess-1', 25, sock)
    await settle()

    expect(Buffer.concat(sock.sent).toString('utf8')).toBe('220 ready\r\n')
  })

  it('holds bytes written before the dial lands rather than dropping them', async () => {
    // HTTP clients send the whole request at once; losing it looks like a hang.
    const conn = fakeConnection()
    let land = (): void => { /* replaced */ }
    dialPort.mockReturnValue(new Promise((resolve) => {
      land = () => resolve(conn.stream)
    }))
    const sock = fakeSocket()

    attachPortTunnel('sess-1', 5173, sock)
    sock.push(Buffer.from('early '))
    sock.push(Buffer.from('bytes'))
    await settle()
    expect(conn.written()).toBe('')

    land()
    await settle()
    expect(conn.written()).toBe('early bytes')
  })

  it('closes with a distinguishable code when the dial fails', async () => {
    // The client must be able to tell this from the dev server hanging up.
    dialPort.mockRejectedValue(new Error('nothing listening on 5173'))
    const sock = fakeSocket()

    attachPortTunnel('sess-1', 5173, sock)
    await settle()

    expect(sock.closed?.code).toBe(TUNNEL_DIAL_FAILED)
  })

  it('ends the socket when the workspace side closes', async () => {
    const conn = fakeConnection()
    dialPort.mockResolvedValue(conn.stream)
    const sock = fakeSocket()

    attachPortTunnel('sess-1', 5173, sock)
    await settle()
    conn.stream.destroy()
    await settle()

    expect(sock.closed).not.toBeNull()
    // A normal close, not the dial-failed code.
    expect(sock.closed?.code).toBeUndefined()
  })

  it('destroys the workspace connection when the client hangs up', async () => {
    // Otherwise closed tabs would leak streams in the pod.
    const conn = fakeConnection()
    dialPort.mockResolvedValue(conn.stream)
    const sock = fakeSocket()

    attachPortTunnel('sess-1', 5173, sock)
    await settle()
    sock.hangUp()
    await settle()

    expect(conn.stream.destroyed).toBe(true)
  })

  it('destroys a connection that lands after the client already left', async () => {
    const conn = fakeConnection()
    let land = (): void => { /* replaced */ }
    dialPort.mockReturnValue(new Promise((resolve) => { land = () => resolve(conn.stream) }))
    const sock = fakeSocket()

    attachPortTunnel('sess-1', 5173, sock)
    sock.hangUp()
    land()
    await settle()

    expect(conn.stream.destroyed).toBe(true)
  })

  it('ignores text frames — this protocol carries bytes and nothing else', async () => {
    const conn = fakeConnection()
    dialPort.mockResolvedValue(conn.stream)
    const sock = fakeSocket()

    attachPortTunnel('sess-1', 5173, sock)
    await settle()
    sock.push(Buffer.from('{"type":"ping"}'), false)
    await settle()

    expect(conn.written()).toBe('')
  })
})

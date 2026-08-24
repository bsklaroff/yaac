/**
 * The server half of the port-forward tunnel — `attachPortTunnel`.
 *
 * Mocked at the contract boundary only: the driver answers the dial with a
 * real `PassThrough` pair, so the splice runs for real and the assertions
 * are about bytes arriving where they should.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Duplex, PassThrough } from 'node:stream'

vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  TUNNEL_DIAL_FAILED,
  attachPortTunnel,
  type TunnelSocketLike,
} from '#runtime/ports/tunnel'
import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import type { WorktreeDriver } from '#drivers/contract'

const dialPort = vi.fn<WorktreeDriver['dialPort']>()

/** A fake client socket that records what the bridge sent it, and lets a
 *  test push frames in as the client would. */
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
 * A workspace-side connection: what the bridge writes lands in `written`,
 * and `reply` is what the workspace sends back.
 *
 * Handed over PAUSED, exactly as `dialPort` promises — the real k8s dial
 * pauses its socket after the relay handshake, and a bridge that never
 * resumes carries nothing in either direction with no error anywhere.
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
  installFakeWorktreeDriver({ dialPort })
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
    // The stream arrives paused precisely so this cannot be lost: a
    // protocol whose server greets first (SMTP, a database handshake) puts
    // its whole greeting on the wire before anything here is listening.
    const conn = fakeConnection()
    conn.reply('220 ready\r\n')
    dialPort.mockResolvedValue(conn.stream)
    const sock = fakeSocket()

    attachPortTunnel('sess-1', 25, sock)
    await settle()

    expect(Buffer.concat(sock.sent).toString('utf8')).toBe('220 ready\r\n')
  })

  it('holds bytes written before the dial lands rather than dropping them', async () => {
    // Every HTTP client writes its whole request immediately. Losing that
    // to a race with the pod's stream setup would look like a hang, not an
    // error — the request simply never arrives.
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
    // A client cannot see inside the cluster, so the close code is the
    // whole diagnosis it gets — and it has to be tellable from a dev
    // server that simply hung up.
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
    // A normal end, not the dial-failed code: the tunnel worked and the
    // far end hung up.
    expect(sock.closed?.code).toBeUndefined()
  })

  it('destroys the workspace connection when the client hangs up', async () => {
    // Otherwise a closed browser tab leaves a stream open in the pod for
    // every connection it ever made.
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

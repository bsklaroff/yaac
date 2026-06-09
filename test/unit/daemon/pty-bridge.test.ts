import { describe, it, expect, vi } from 'vitest'
import * as pty from '@lydell/node-pty'
import { attachArgs, parseControl, parsePtySize, bridge, spawnAttachPty } from '@/daemon/pty-bridge'
import type { PtyLike, SocketLike } from '@/daemon/pty-bridge'

// Avoid loading/spawning the real node-pty native module in unit tests.
vi.mock('@lydell/node-pty', () => ({ spawn: vi.fn(() => ({})) }))

describe('attachArgs', () => {
  it('builds the podman exec tmux attach argv', () => {
    expect(attachArgs('yaac-demo-abc')).toEqual([
      'exec', '-it', 'yaac-demo-abc',
      'tmux', '-S', '/tmp/yaac-tmux/server', 'attach-session', '-t', 'yaac',
    ])
  })
})

describe('spawnAttachPty', () => {
  it('spawns `podman` under a PTY with the attach argv and given size', () => {
    spawnAttachPty('yaac-demo', { cols: 100, rows: 40 })
    expect(pty.spawn).toHaveBeenCalledWith(
      'podman',
      attachArgs('yaac-demo'),
      expect.objectContaining({ name: 'xterm-color', cols: 100, rows: 40 }),
    )
  })
})

describe('parsePtySize', () => {
  it('coerces valid numeric strings to a size', () => {
    expect(parsePtySize('150', '40')).toEqual({ cols: 150, rows: 40 })
  })

  it('accepts numbers and truncates fractions', () => {
    expect(parsePtySize(150.9, 40.2)).toEqual({ cols: 150, rows: 40 })
  })

  it('drops missing, non-numeric, non-positive, or oversized values', () => {
    expect(parsePtySize(undefined, undefined)).toEqual({ cols: undefined, rows: undefined })
    expect(parsePtySize('abc', '40')).toEqual({ cols: undefined, rows: 40 })
    expect(parsePtySize('0', '-5')).toEqual({ cols: undefined, rows: undefined })
    expect(parsePtySize('5000', '40')).toEqual({ cols: undefined, rows: 40 })
  })
})

describe('parseControl', () => {
  it('parses resize / signal / ping', () => {
    expect(parseControl('{"type":"resize","cols":120,"rows":40}')).toEqual({
      type: 'resize', cols: 120, rows: 40,
    })
    expect(parseControl('{"type":"signal","name":"SIGINT"}')).toEqual({ type: 'signal', name: 'SIGINT' })
    expect(parseControl('{"type":"ping"}')).toEqual({ type: 'ping' })
  })

  it('returns null for invalid JSON, non-objects, and unknown types', () => {
    expect(parseControl('not json')).toBeNull()
    expect(parseControl('42')).toBeNull()
    expect(parseControl('null')).toBeNull()
    expect(parseControl('{"type":"nope"}')).toBeNull()
  })
})

class FakePty implements PtyLike {
  written: string[] = []
  resized: Array<[number, number]> = []
  killed: Array<string | undefined> = []
  private dataCb?: (d: string) => void
  private exitCb?: (e: { exitCode: number }) => void
  onData(cb: (d: string) => void): void { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exitCb = cb }
  write(d: string): void { this.written.push(d) }
  resize(c: number, r: number): void { this.resized.push([c, r]) }
  kill(s?: string): void { this.killed.push(s) }
  emitData(d: string): void { this.dataCb?.(d) }
  emitExit(code: number): void { this.exitCb?.({ exitCode: code }) }
}

class FakeSock implements SocketLike {
  sent: Array<string | Uint8Array> = []
  closed: Array<[number | undefined, string | undefined]> = []
  private msgCb?: (data: string | Buffer | ArrayBuffer, isBinary: boolean) => void
  private closeCb?: () => void
  send(d: string | Uint8Array): void { this.sent.push(d) }
  close(code?: number, reason?: string): void { this.closed.push([code, reason]) }
  onMessage(cb: (data: string | Buffer | ArrayBuffer, isBinary: boolean) => void): void { this.msgCb = cb }
  onClose(cb: () => void): void { this.closeCb = cb }
  emitMessage(data: string | Buffer, isBinary: boolean): void { this.msgCb?.(data, isBinary) }
  emitClose(): void { this.closeCb?.() }
}

describe('bridge', () => {
  it('streams PTY output to the socket as bytes', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    pty.emitData('hello')
    expect(sock.sent).toHaveLength(1)
    expect(Buffer.from(sock.sent[0] as Uint8Array).toString('utf8')).toBe('hello')
  })

  it('writes binary input frames to the PTY', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    sock.emitMessage(Buffer.from('ls\r', 'utf8'), true)
    expect(pty.written).toEqual(['ls\r'])
  })

  it('applies resize control frames', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    sock.emitMessage('{"type":"resize","cols":100,"rows":30}', false)
    expect(pty.resized).toEqual([[100, 30]])
  })

  it('replies to ping with pong', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    sock.emitMessage('{"type":"ping"}', false)
    expect(sock.sent).toContain('{"type":"pong"}')
  })

  it('forwards signal control frames to the PTY', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    sock.emitMessage('{"type":"signal","name":"SIGINT"}', false)
    expect(pty.killed).toEqual(['SIGINT'])
  })

  it('kills the PTY when the socket closes (detach)', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    sock.emitClose()
    expect(pty.killed).toEqual([undefined])
  })

  it('closes the socket when the PTY exits', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    pty.emitExit(0)
    expect(sock.closed).toHaveLength(1)
    expect(sock.closed[0][0]).toBe(1000)
  })
})

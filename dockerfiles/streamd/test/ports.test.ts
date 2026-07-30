// Tests for the `ports` stream kind: the /proc/net/tcp{,6} LISTEN parser
// (loopback/wildcard reachability filter, IPv6, torn/hostile input) and
// the push behavior over a live streamd — initial set, change push,
// keepalive re-send, and the daemon's own-port exclusion.
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
// Untyped plain-JS modules (they run under bare node in the pod).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { parseProcTcpPorts, isLoopbackOrWildcardHex, readListeningPorts } from '../ports.js'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { createStreamd } from '../streamd.js'

const TOKEN = 'test-token-0123456789abcdef'

const PROC_HEADER
  = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'

/** One /proc/net/tcp-shaped row for a local address in the given state. */
function procRow(localHex: string, portHex: string, state: string): string {
  return `   0: ${localHex}:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0`
}

function procFile(rows: string[]): string {
  return [PROC_HEADER, ...rows].join('\n') + '\n'
}

describe('isLoopbackOrWildcardHex', () => {
  it('accepts IPv4 loopback and wildcard, rejects other addresses', () => {
    expect(isLoopbackOrWildcardHex('0100007F')).toBe(true) // 127.0.0.1
    expect(isLoopbackOrWildcardHex('0A00007F')).toBe(true) // 127.0.0.10
    expect(isLoopbackOrWildcardHex('00000000')).toBe(true) // 0.0.0.0
    expect(isLoopbackOrWildcardHex('0101A8C0')).toBe(false) // 192.168.1.1
    expect(isLoopbackOrWildcardHex('0F02000A')).toBe(false) // 10.0.2.15
  })

  it('accepts IPv6 loopback, wildcard, and v4-mapped loopback', () => {
    expect(isLoopbackOrWildcardHex('00000000000000000000000001000000')).toBe(true) // ::1
    expect(isLoopbackOrWildcardHex('00000000000000000000000000000000')).toBe(true) // ::
    expect(isLoopbackOrWildcardHex('0000000000000000FFFF00000100007F')).toBe(true) // ::ffff:127.0.0.1
    expect(isLoopbackOrWildcardHex('0000000000000000FFFF00000101A8C0')).toBe(false) // ::ffff:192.168.1.1
    expect(isLoopbackOrWildcardHex('FE80000000000000021CB3FFFE1D2E3F')).toBe(false) // link-local
  })

  it('rejects malformed input', () => {
    expect(isLoopbackOrWildcardHex('')).toBe(false)
    expect(isLoopbackOrWildcardHex('zznotahexstring')).toBe(false)
    expect(isLoopbackOrWildcardHex('0100007F00')).toBe(false) // wrong length
  })
})

describe('parseProcTcpPorts', () => {
  it('keeps LISTEN rows on loopback/wildcard binds only', () => {
    const text = procFile([
      procRow('0100007F', '1F90', '0A'), // 127.0.0.1:8080 LISTEN
      procRow('00000000', '1F91', '0A'), // 0.0.0.0:8081 LISTEN
      procRow('0101A8C0', '1F92', '0A'), // 192.168.1.1:8082 LISTEN (unreachable)
      procRow('0100007F', '1F93', '01'), // 127.0.0.1:8083 ESTABLISHED
    ])
    expect(parseProcTcpPorts(text)).toEqual([8080, 8081])
  })

  it('parses tcp6 rows', () => {
    const text = procFile([
      procRow('00000000000000000000000001000000', '1F90', '0A'), // [::1]:8080
      procRow('00000000000000000000000000000000', '1F91', '0A'), // [::]:8081
      procRow('FE80000000000000021CB3FFFE1D2E3F', '1F92', '0A'), // link-local
    ])
    expect(parseProcTcpPorts(text)).toEqual([8080, 8081])
  })

  it('skips torn and malformed rows without throwing', () => {
    const text = procFile([
      'garbage line',
      '   0: brokenrow',
      procRow('0100007F', 'ZZZZ', '0A'), // non-hex port
      procRow('0100007F', '0000', '0A'), // port 0
      procRow('0100007F', '1F90', '0A'),
    ]).slice(0, -20) // tear the tail
    expect(parseProcTcpPorts(text)).toEqual([8080])
  })

  it('bounds hostile input by row count', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) =>
      procRow('0100007F', (1024 + (i % 60_000)).toString(16).toUpperCase().padStart(4, '0'), '0A'))
    const ports = parseProcTcpPorts(procFile(rows)) as number[]
    expect(ports.length).toBeLessThanOrEqual(8192)
  })
})

describe('readListeningPorts', () => {
  it('merges tcp and tcp6, deduped and sorted; missing files contribute nothing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamd-proc-'))
    try {
      await fs.writeFile(path.join(dir, 'tcp'), procFile([
        procRow('0100007F', '1F92', '0A'), // 8082
        procRow('00000000', '1F90', '0A'), // 8080
      ]))
      await fs.writeFile(path.join(dir, 'tcp6'), procFile([
        procRow('00000000000000000000000000000000', '1F90', '0A'), // 8080 again
        procRow('00000000000000000000000001000000', '1F91', '0A'), // 8081
      ]))
      expect(readListeningPorts(dir)).toEqual([8080, 8081, 8082])
      expect(readListeningPorts(path.join(dir, 'missing'))).toEqual([])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('ports stream kind', () => {
  interface Daemon { listen(): Promise<number>; close(): Promise<void> }
  const daemons: Daemon[] = []
  const sockets: net.Socket[] = []
  const dirs: string[] = []

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy()
    for (const d of daemons.splice(0)) await d.close()
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
  })

  async function startDaemon(): Promise<{ port: number; procDir: string }> {
    const procDir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamd-proc-'))
    dirs.push(procDir)
    await fs.writeFile(path.join(procDir, 'tcp'), procFile([]))
    const d = createStreamd({
      token: TOKEN,
      port: 0,
      host: '127.0.0.1',
      procNetDir: procDir,
      portsPollMs: 50,
      portsKeepaliveMs: 400,
    }) as Daemon
    daemons.push(d)
    return { port: await d.listen(), procDir }
  }

  /** Dial, handshake as a ports stream, and hand back a line reader. */
  function openPortsStream(port: number): Promise<{ next: (timeoutMs?: number) => Promise<string> }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1')
      sockets.push(socket)
      let buf = ''
      const lines: string[] = []
      const waiters: Array<(line: string) => void> = []
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          const w = waiters.shift()
          if (w) w(line)
          else lines.push(line)
          nl = buf.indexOf('\n')
        }
      })
      socket.on('error', reject)
      socket.on('connect', () => {
        socket.write(JSON.stringify({ token: TOKEN, kind: 'ports' }) + '\n')
      })
      const next = (timeoutMs = 3000): Promise<string> => new Promise((res, rej) => {
        const queued = lines.shift()
        if (queued !== undefined) {
          res(queued)
          return
        }
        const timer = setTimeout(() => rej(new Error('no line within deadline')), timeoutMs)
        waiters.push((line) => {
          clearTimeout(timer)
          res(line)
        })
      })
      void next().then((replyLine) => {
        const reply = JSON.parse(replyLine) as { ok: boolean; error?: string }
        if (!reply.ok) reject(new Error(`refused: ${reply.error}`))
        else resolve({ next })
      }, reject)
    })
  }

  it('pushes the initial set, then a change, then keepalives; excludes its own port', async () => {
    const { port, procDir } = await startDaemon()
    // Include the daemon's own listen port — it must be filtered out.
    await fs.writeFile(path.join(procDir, 'tcp'), procFile([
      procRow('0100007F', '1F90', '0A'), // 8080
      procRow('0100007F', port.toString(16).toUpperCase().padStart(4, '0'), '0A'),
    ]))
    const stream = await openPortsStream(port)

    // Initial push (the very first may race the file write and see the
    // empty pre-write set; the next poll then pushes the real one).
    let ports = (JSON.parse(await stream.next()) as { ports: number[] }).ports
    if (ports.length === 0) ports = (JSON.parse(await stream.next()) as { ports: number[] }).ports
    expect(ports).toEqual([8080])

    // A new listener appears → a change push within a poll tick or two.
    await fs.writeFile(path.join(procDir, 'tcp'), procFile([
      procRow('0100007F', '1F90', '0A'),
      procRow('00000000', '1F95', '0A'), // 8085
    ]))
    const changed = JSON.parse(await stream.next()) as { ports: number[] }
    expect(changed.ports).toEqual([8080, 8085])

    // No further change → the unchanged set re-arrives as a keepalive.
    const keepalive = JSON.parse(await stream.next(2000)) as { ports: number[] }
    expect(keepalive.ports).toEqual([8080, 8085])
  })
})

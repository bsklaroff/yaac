/**
 * The PROXY protocol v1 header tailscaled's serve sends before each
 * forwarded connection's bytes: one text line naming the caller's tailnet
 * address (`PROXY TCP4 <src> <dst> <sport> <dport>\r\n`).
 */
import { Duplex } from 'node:stream'
import type net from 'node:net'

/** A v1 header is at most 107 bytes, its CRLF included. */
const MAX_HEADER = 107

export interface ProxyHeader {
  address: string
  port: number
}

export function parseProxyV1(line: string): ProxyHeader | null {
  const m = /^PROXY TCP[46] (\S+) \S+ (\d+) \d+$/.exec(line)
  return m ? { address: m[1], port: Number(m[2]) } : null
}

/**
 * Read the header off `socket`, and return the caller with a stream of the
 * connection's bytes after it. The bytes that arrived with the header are
 * put back in front through a stream of its own: a TLS socket wrapping a
 * `net.Socket` reads its handle directly and would never see them.
 */
export function readProxyHeader(socket: net.Socket): Promise<{ caller: ProxyHeader; stream: Duplex }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const fail = (err: Error): void => {
      socket.off('data', onData)
      socket.destroy()
      reject(err)
    }
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n')
      if (end === -1) {
        if (buf.length > MAX_HEADER) fail(new Error('no PROXY header'))
        return
      }
      socket.off('data', onData)
      socket.pause()
      const caller = parseProxyV1(buf.subarray(0, end).toString('latin1'))
      if (!caller) {
        fail(new Error('malformed PROXY header'))
        return
      }
      resolve({ caller, stream: prefixed(socket, buf.subarray(end + 2)) })
    }
    socket.on('data', onData)
    socket.once('error', fail)
  })
}

function prefixed(socket: net.Socket, prefix: Buffer): Duplex {
  const stream = new Duplex({
    read() { socket.resume() },
    write(chunk: Buffer, _enc, cb) { socket.write(chunk, cb) },
    final(cb) { socket.end(cb) },
    destroy(err, cb) {
      socket.destroy()
      cb(err)
    },
  })
  if (prefix.length > 0) stream.push(prefix)
  socket.on('data', (chunk: Buffer) => { if (!stream.push(chunk)) socket.pause() })
  socket.on('end', () => stream.push(null))
  socket.on('error', (err) => stream.destroy(err))
  socket.on('close', () => stream.destroy())
  return stream
}

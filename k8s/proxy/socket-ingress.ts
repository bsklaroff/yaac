/**
 * The proxy's one listener for sandbox egress (docs/workspace-egress.md).
 * netd's relay carries every connection a workspace or builder sandbox
 * makes to this port, behind a PROXY protocol v2 header naming the address
 * the sandbox dialed, the sandbox's id and the proxy auth secret. Which
 * sandbox a connection belongs to is decided by the relay (the socket
 * directory it arrived in), so the header's id is trusted once its secret
 * matches; a sandbox cannot write this header, since netshim's own header
 * reaches only the relay, which drops its TLVs.
 *
 * The destination picks the handler: port 443 is TLS routed by SNI, the SSH
 * sentinel's address and port is git's `CONNECT`, and anything else is plain
 * HTTP routed by its Host header. Every failure before the hand-off
 * destroys the socket.
 */

import type net from 'node:net'
import { parsePp2Header } from './pp2'
import { timingSafeStrEqual } from './secure-compare'

/** PROXY protocol v2 TLV types the relay writes (proxy-constants.ts). */
export const PP2_TLV_ID = 0xe0
export const PP2_TLV_SECRET = 0xe1

/** The SSH tunnel's sentinel address and port (proxy-constants.ts). */
export const SSH_TUNNEL_SENTINEL = '198.18.0.2'
export const TUNNEL_INGRESS_PORT = 10259

/** Size cap and deadline for the relay's header. */
const HEADER_MAX_BYTES = 4 * 1024
const HEADER_TIMEOUT_MS = 10_000

export type IngressKind = 'tls' | 'tunnel' | 'http'

/** Which handler a connection to `dstIp:dstPort` goes to. */
export function ingressKind(dstIp: string | null, dstPort: number | null): IngressKind {
  if (dstPort === 443) return 'tls'
  if (dstIp === SSH_TUNNEL_SENTINEL && dstPort === TUNNEL_INGRESS_PORT) return 'tunnel'
  return 'http'
}

/**
 * A handler takes the socket, the sandbox's id and the bytes read past the
 * header, which it must replay itself: each unshifts once, and a second
 * unshift does not reliably reach a new 'data' listener.
 */
export type IngressHandler = (socket: net.Socket, id: string, leftover: Buffer) => void

export interface SocketIngressOptions {
  secret: string
  /** Whether `id` has a registration, fetching one the watch has not
   *  delivered yet. A connection from an unregistered id is refused, which
   *  is also what keeps a spare offline until its claim. */
  registered: (id: string) => Promise<boolean>
  handlers: Record<IngressKind, IngressHandler>
}

/** Read the relay's header on `socket` and hand it to its handler. */
export function handleSocketIngress(socket: net.Socket, opts: SocketIngressOptions): void {
  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'ECONNRESET') console.error('[proxy] socket ingress error:', err.message)
  })
  let buf = Buffer.alloc(0)
  const timer = setTimeout(() => {
    console.log(`[proxy] socket ingress: no PROXY header within ${HEADER_TIMEOUT_MS}ms`)
    socket.destroy()
  }, HEADER_TIMEOUT_MS)

  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk])
    const res = parsePp2Header(buf)
    if (res.kind === 'need-more') {
      if (buf.length > HEADER_MAX_BYTES) { clearTimeout(timer); socket.destroy() }
      return
    }
    clearTimeout(timer)
    socket.removeListener('data', onData)
    const secret = res.kind === 'ok' ? res.tlvs.get(PP2_TLV_SECRET)?.toString('utf8') : undefined
    const id = res.kind === 'ok' ? res.tlvs.get(PP2_TLV_ID)?.toString('utf8') : undefined
    if (res.kind !== 'ok' || secret === undefined || !timingSafeStrEqual(secret, opts.secret)
      || !id || res.dstPort === null) {
      console.log('[proxy] BLOCKED socket ingress: no valid relay header')
      socket.destroy()
      return
    }
    const kind = ingressKind(res.dstIp, res.dstPort)
    // Keep bytes that arrive during the registration lookup.
    let leftover = buf.subarray(res.bytesConsumed)
    const buffer = (more: Buffer): void => { leftover = Buffer.concat([leftover, more]) }
    socket.on('data', buffer)
    void opts.registered(id).then((known) => {
      socket.removeListener('data', buffer)
      if (!known) {
        console.log(`[proxy] BLOCKED socket ingress: ${id.slice(0, 8)}... has no registration`)
        socket.destroy()
        return
      }
      opts.handlers[kind](socket, id, leftover)
    })
  }
  socket.on('data', onData)
}

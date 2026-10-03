/**
 * The terminal WebSocket as both terminal paths see it: binary frames carry
 * terminal bytes, text frames carry JSON control messages. The client sends
 * `resize`, `signal` and `ping`; the server answers `pong`, and the pane
 * mirror also sends `size`.
 */

/** The socket surface (in production, the `ws` WebSocket via WSContext.raw). */
export interface SocketLike {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: string | Buffer | ArrayBuffer, isBinary: boolean) => void): void
  onClose(cb: () => void): void
  /** Bytes queued for the client but not yet written to the network. */
  bufferedAmount(): number
}

export interface ControlMessage {
  type: 'resize' | 'signal' | 'ping'
  cols?: number
  rows?: number
  name?: string
  /** Ping only: an opaque client stamp echoed in the pong so the client can
   *  time the round trip. */
  t?: number
}

/** Parse a text control frame. Returns null for anything unrecognized. */
export function parseControl(text: string): ControlMessage | null {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const t = (obj as { type?: unknown }).type
  if (t !== 'resize' && t !== 'signal' && t !== 'ping') return null
  return obj as ControlMessage
}

/**
 * The pong for a ping. Echoing the client's stamp lets it time the round
 * trip (the frontend's link-quality store); a bare ping (the CLI's
 * keepalive) gets a bare pong.
 */
export function pongFor(ping: ControlMessage): string {
  return typeof ping.t === 'number' && Number.isFinite(ping.t)
    ? JSON.stringify({ type: 'pong', t: ping.t })
    : '{"type":"pong"}'
}

export function toBytes(data: string | Buffer | ArrayBuffer): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  return Buffer.isBuffer(data) ? data : Buffer.from(data)
}

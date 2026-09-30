import { workspaceDriver } from '#drivers/driver'
import { serverLog } from '#log'
import type { Duplex } from 'node:stream'

/**
 * The socket surface this bridge needs (same shape as the PTY bridge's); the
 * real one is the `ws` WebSocket, whose types are not importable here.
 */
export interface TunnelSocketLike {
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: string | Buffer | ArrayBuffer, isBinary: boolean) => void): void
  onClose(cb: () => void): void
}

/** WS close code for "the tunnel could not be opened", so a client can tell
 *  a refused dial from a server that hung up. */
export const TUNNEL_DIAL_FAILED = 4001

/**
 * Bridge one WebSocket to one TCP connection inside a workspace
 * (docs/port-forward-tunnel.md). The client holds the listener and opens one
 * WebSocket per accepted connection, so every binary frame is just bytes in
 * order and either side's close ends the pair.
 *
 * Frames arriving before the dial completes are buffered, since clients
 * usually write immediately (every HTTP request does).
 */
export function attachPortTunnel(
  workspaceId: string,
  containerPort: number,
  sock: TunnelSocketLike,
): void {
  let stream: Duplex | null = null
  let closed = false
  const pending: Buffer[] = []

  const shutdown = (code?: number, reason?: string): void => {
    if (closed) return
    closed = true
    pending.length = 0
    stream?.destroy()
    try {
      sock.close(code, reason)
    } catch { /* socket already gone */ }
  }

  sock.onClose(() => {
    closed = true
    stream?.destroy()
  })
  sock.onMessage((data, isBinary) => {
    // No control messages exist; ignore text frames so a client keepalive
    // is harmless.
    if (!isBinary) return
    const chunk = typeof data === 'string'
      ? Buffer.from(data, 'utf8')
      : Buffer.from(data as ArrayBuffer)
    if (stream) stream.write(chunk)
    else pending.push(chunk)
  })

  workspaceDriver().dialPort(workspaceId, containerPort).then(
    (dialed) => {
      if (closed) {
        // Attach a listener first: an unhandled 'error' on a destroyed stream
        // would be an uncaught exception.
        dialed.on('error', () => { /* nothing is reading it */ })
        dialed.destroy()
        return
      }
      stream = dialed
      dialed.on('data', (chunk: Buffer) => {
        if (closed) return
        try {
          sock.send(chunk)
        } catch {
          shutdown()
        }
      })
      // No half-close over a WebSocket: either side ending closes both.
      dialed.on('error', () => { /* 'close' follows */ })
      dialed.on('close', () => shutdown())
      for (const chunk of pending) dialed.write(chunk)
      pending.length = 0
      // The stream arrives paused (see `dialPort`) so no bytes are lost
      // before the handler exists. Without this resume the tunnel carries
      // nothing, silently.
      dialed.resume()
    },
    (err: unknown) => {
      serverLog(
        `[server] forward tunnel to ${workspaceId.slice(0, 8)}:${containerPort} failed: `
        + (err instanceof Error ? err.message : String(err)),
      )
      shutdown(TUNNEL_DIAL_FAILED, 'dial failed')
    },
  )
}

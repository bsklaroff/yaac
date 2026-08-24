import { worktreeDriver } from '#drivers/driver'
import { serverLog } from '#log'
import type { Duplex } from 'node:stream'

/**
 * Minimal socket surface this bridge needs — the same shape the PTY bridge
 * takes, and for the same reason: the real implementation is the `ws`
 * WebSocket behind Hono's WSContext, whose types are not in our resolvable
 * set.
 */
export interface TunnelSocketLike {
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: string | Buffer | ArrayBuffer, isBinary: boolean) => void): void
  onClose(cb: () => void): void
}

/** WS close code for "the tunnel could not be opened". Distinct from a
 *  normal close so a client can tell a refused dial from a dev server that
 *  hung up, and retry (or not) accordingly. */
export const TUNNEL_DIAL_FAILED = 4001

/**
 * Bridge one WebSocket to one TCP connection inside a workspace.
 *
 * The far end of a forward whose LISTENER is on the client: the client
 * accepted a connection on the user's machine and opened this socket for
 * it, so the whole job here is to splice it to a stream into the workspace
 * and let either side's close end the pair. One WS per TCP connection —
 * the kubectl shape — which is what makes that splice the entire protocol:
 * every binary frame is bytes, in order, and there is nothing to
 * demultiplex.
 *
 * Frames that arrive before the dial lands are buffered rather than
 * dropped: a client that writes immediately (every HTTP request does)
 * would otherwise lose its first bytes to a race with the pod's stream
 * setup, and lose them silently.
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
    // Text frames are not part of this protocol — there are no control
    // messages to send, since the connection's whole state is "open" until
    // one end closes it. Ignoring rather than erroring keeps a client's
    // keepalive ping harmless.
    if (!isBinary) return
    const chunk = typeof data === 'string'
      ? Buffer.from(data, 'utf8')
      : Buffer.from(data as ArrayBuffer)
    if (stream) stream.write(chunk)
    else pending.push(chunk)
  })

  worktreeDriver().dialPort(workspaceId, containerPort).then(
    (dialed) => {
      if (closed) {
        // Listener first: an unhandled 'error' on a destroyed stream is an
        // uncaught exception, and this branch has attached none yet.
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
      // Either direction ending ends the connection: a forwarded TCP
      // connection has no half-close worth modelling over a WebSocket, and
      // pretending otherwise would leave a client waiting on a socket
      // nothing will ever write to again.
      dialed.on('error', () => { /* 'close' follows */ })
      dialed.on('close', () => shutdown())
      for (const chunk of pending) dialed.write(chunk)
      pending.length = 0
      // The stream arrives PAUSED (see `dialPort`) so its first bytes
      // cannot land before the handler above exists. Resuming is the last
      // thing, and forgetting it is a tunnel that opens and then carries
      // nothing in either direction, with no error anywhere.
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

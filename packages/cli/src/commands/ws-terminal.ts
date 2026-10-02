import WebSocket from 'ws'
import { resolveServerTarget } from '@yaac/shared/server-api'
import { wsUrl } from '@yaac/shared/api-core'

/**
 * Attach the user's terminal to a workspace over the server's /pty/attach
 * WebSocket, the same path the web app uses, so it works the same against a
 * local or remote server.
 *
 * Protocol (packages/server/src/runtime/terminals/pty-bridge.ts): binary
 * frames are PTY bytes both ways; text frames are JSON control messages
 * (resize / ping / error).
 */

/** App-level keepalive so idle terminals survive proxy idle timeouts. */
const PING_INTERVAL_MS = 30_000

/**
 * Attach the current terminal to a workspace PTY until the server closes
 * the stream (tmux detach, shell exit, or the workspace dies). A
 * server-reported error (e.g. workspace not running) is printed and sets
 * exitCode 1 instead of throwing.
 */
export async function attachWorkspacePty(
  workspaceId: string,
  /** 'native' (full tmux) | 'shell' (raw zsh) | 'window:@N' | 'agent'. */
  target: string,
): Promise<void> {
  const server = await resolveServerTarget()
  // No size without a TTY; the server picks one.
  const ws = new WebSocket(wsUrl(server.baseUrl, '/api/pty/attach', {
    id: workspaceId,
    target,
    cols: process.stdout.columns,
    rows: process.stdout.rows,
  }))

  await new Promise<void>((resolve, reject) => {
    const stdin = process.stdin
    const wasRaw = stdin.isTTY ? stdin.isRaw : false
    let pingTimer: NodeJS.Timeout | null = null

    const onStdin = (chunk: Buffer): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk)
    }
    const onResize = (): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'resize',
          cols: process.stdout.columns,
          rows: process.stdout.rows,
        }))
      }
    }

    const cleanup = (): void => {
      if (pingTimer) clearInterval(pingTimer)
      stdin.off('data', onStdin)
      process.stdout.off('resize', onResize)
      if (stdin.isTTY) stdin.setRawMode(wasRaw)
      stdin.pause()
    }

    ws.on('open', () => {
      if (stdin.isTTY) stdin.setRawMode(true)
      stdin.resume()
      stdin.on('data', onStdin)
      process.stdout.on('resize', onResize)
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}')
      }, PING_INTERVAL_MS)
    })

    ws.on('message', (data: Buffer | Buffer[], isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : data
      if (isBinary) {
        process.stdout.write(buf)
        return
      }
      let msg: { type?: string; message?: string }
      try {
        msg = JSON.parse(buf.toString('utf8')) as { type?: string; message?: string }
      } catch {
        return
      }
      if (msg.type === 'error') {
        console.error(msg.message ?? 'terminal error')
        process.exitCode = 1
      }
    })

    ws.on('close', () => {
      cleanup()
      resolve()
    })

    ws.on('error', (err: Error) => {
      cleanup()
      reject(new Error(`terminal connection failed: ${err.message}`))
    })
  })
}

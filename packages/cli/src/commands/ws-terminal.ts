import WebSocket from 'ws'
import { resolveServerTarget } from '@yaac/shared/server-api'

/**
 * CLI-side terminal transport: attach the user's terminal to a worktree
 * over the server's /pty/attach WebSocket — the same path the webapp
 * uses — instead of a client-side `kubectl exec`. This is what makes
 * attach/shell/stream work identically against a local and a remote
 * server: the kubectl invocation happens server-side, next to the
 * cluster.
 *
 * Wire protocol (see src/server/pty-bridge.ts): binary frames are PTY
 * bytes both ways; text frames are JSON control messages (resize /
 * ping / error).
 */

/** http(s) origin → ws(s) origin. */
export function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/, 'ws')
}

export function buildPtyAttachUrl(
  baseUrl: string,
  params: { worktreeId: string; target: string; cols?: number; rows?: number },
): string {
  const url = new URL(`${toWsUrl(baseUrl)}/pty/attach`)
  url.searchParams.set('id', params.worktreeId)
  url.searchParams.set('target', params.target)
  if (params.cols) url.searchParams.set('cols', String(params.cols))
  if (params.rows) url.searchParams.set('rows', String(params.rows))
  return url.toString()
}

/** App-level keepalive so idle terminals survive proxy idle timeouts. */
const PING_INTERVAL_MS = 30_000

/**
 * Attach the current terminal to a worktree PTY until the server closes
 * the stream (tmux detach, shell exit, or worktree death). Resolves on
 * a clean close; a server-reported error (e.g. worktree not running) is
 * printed and sets exitCode 1 rather than throwing, matching how the
 * old kubectl path surfaced mid-attach failures.
 */
export async function attachWorktreePty(
  worktreeId: string,
  /** 'native' (full tmux) | 'shell' (raw zsh) | 'window:@N' | 'agent'. */
  target: string,
): Promise<void> {
  const server = await resolveServerTarget()
  const url = buildPtyAttachUrl(server.baseUrl, {
    worktreeId,
    target,
    cols: process.stdout.columns,
    rows: process.stdout.rows,
  })
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${server.secret}` },
  })

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
      // 'pong' and anything else: ignore.
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

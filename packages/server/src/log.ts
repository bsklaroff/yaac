import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { serverLogPath } from '@yaac/shared/paths'

/**
 * Log a message from the server. Writes to stderr (visible when running
 * in the foreground via `yaac server run`) and appends a timestamped line
 * to `~/.yaac/server.log` (durable across detached runs, readable with
 * `yaac server logs`).
 *
 * Synchronous append keeps lines from interleaving between concurrent
 * callers without needing a write queue. A failure to open/append never
 * propagates — losing a log line is preferable to crashing the server.
 */
export function serverLog(message: string): void {
  console.error(message)
  try {
    const p = serverLogPath()
    mkdirSync(path.dirname(p), { recursive: true })
    appendFileSync(p, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // swallow — stderr already got the message
  }
}

/**
 * Forward a child process's stdout/stderr stream to `serverLog`, one
 * line at a time with `prefix` prepended. Used so noisy subprocess
 * output (e.g. `podman build`) lands in `~/.yaac/server.log` instead of
 * being dropped when the server runs detached with `stdio: 'ignore'`.
 *
 * Pass `onLine` to also fan each line out to a caller — used where the
 * output has a live audience as well as the log (the image-build registry
 * the webapp tails, a command's captured stderr).
 */
export function pipeToServerLog(
  stream: NodeJS.ReadableStream | null,
  prefix: string,
  onLine?: (line: string) => void,
): void {
  if (!stream) return
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buf += chunk
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.length > 0) {
        serverLog(`${prefix}${line}`)
        onLine?.(line)
      }
    }
  })
  stream.on('end', () => {
    if (buf.length > 0) {
      serverLog(`${prefix}${buf}`)
      onLine?.(buf)
    }
  })
}

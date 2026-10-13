import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { serverLogPath } from '@yaac/shared/paths'

/**
 * Log a server message to stderr (seen with `yaac server run`) and append
 * a timestamped line to `serverLogPath()` (read with `yaac server logs`).
 * The append is synchronous so concurrent lines never interleave. Failures
 * are swallowed; losing a log line beats crashing the server.
 */
export function serverLog(message: string): void {
  console.error(message)
  try {
    const p = serverLogPath()
    mkdirSync(path.dirname(p), { recursive: true })
    appendFileSync(p, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // stderr already has the message.
  }
}

/**
 * `String(err)` followed by each error in its `cause` chain. A wrapping
 * error names only what was attempted: drizzle's `DrizzleQueryError` says
 * which query failed and keeps the database's reason in `cause`.
 */
export function errorText(err: unknown): string {
  let text = String(err)
  // Bounded, since a cause chain can loop.
  for (let e = err, depth = 0; e instanceof Error && e.cause instanceof Error && depth < 5; e = e.cause, depth++) {
    text += `\n  caused by: ${String(e.cause)}`
  }
  return text
}

/**
 * Forward a child process's output stream to `serverLog` line by line, with
 * `prefix`, so subprocess output (e.g. `podman build`) is kept when the
 * server runs detached. `onLine` also receives each line, for callers with
 * a live audience (the image-build registry the webapp tails, captured
 * stderr).
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

import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { daemonLogPath } from '@/shared/paths'

/**
 * Log a message from the daemon. Writes to stderr (visible when running
 * in the foreground via `yaac daemon run`) and appends a timestamped line
 * to `~/.yaac/daemon.log` (durable across detached runs, readable with
 * `yaac daemon logs`).
 *
 * Synchronous append keeps lines from interleaving between concurrent
 * callers without needing a write queue. A failure to open/append never
 * propagates — losing a log line is preferable to crashing the daemon.
 */
export function daemonLog(message: string): void {
  console.error(message)
  try {
    const p = daemonLogPath()
    mkdirSync(path.dirname(p), { recursive: true })
    appendFileSync(p, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // swallow — stderr already got the message
  }
}

/**
 * Forward a child process's stdout/stderr stream to `daemonLog`, one
 * line at a time with `prefix` prepended. Used so noisy subprocess
 * output (e.g. `podman build`) lands in `~/.yaac/daemon.log` instead of
 * being dropped when the daemon runs detached with `stdio: 'ignore'`.
 */
export function pipeToDaemonLog(
  stream: NodeJS.ReadableStream | null,
  prefix: string,
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
      if (line.length > 0) daemonLog(`${prefix}${line}`)
    }
  })
  stream.on('end', () => {
    if (buf.length > 0) daemonLog(`${prefix}${buf}`)
  })
}

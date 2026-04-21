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

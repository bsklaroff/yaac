import { env } from '@/shared/env'

/**
 * Port the daemon binds on 127.0.0.1 when `yaac daemon run` is invoked
 * without `--port`. A fixed default — rather than an OS-assigned ephemeral
 * port — keeps the browser-app URL (http://127.0.0.1:<port>/) stable across
 * daemon restarts so it can be bookmarked, and lets the Vite dev server fall
 * back to the right target when no daemon lock exists yet (see
 * vite.config.ts). Override per-run with `yaac daemon run --port <N>`.
 */
export const DEFAULT_DAEMON_PORT = 8787

/**
 * Resolve the port the daemon should bind, honoring (highest precedence
 * first):
 *   1. an explicit `--port` flag (`optPort`),
 *   2. the `YAAC_DAEMON_PORT` environment variable,
 *   3. DEFAULT_DAEMON_PORT.
 *
 * `0` is a valid value at every level — it asks the OS for an ephemeral port
 * (used by the test harness). An explicitly-provided value (flag or env) that
 * isn't a valid TCP port throws, so a typo fails loudly instead of silently
 * falling through to the default.
 */
export function resolveDaemonPort(optPort?: number): number {
  if (optPort !== undefined) return assertValidPort(optPort, '--port')
  return env.daemonPort ?? DEFAULT_DAEMON_PORT
}

function assertValidPort(port: number, source: string): number {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `${source} must be an integer between 0 and 65535, got ${String(port)}`,
    )
  }
  return port
}

/**
 * True when `err` is a Node `EADDRINUSE` error — the address/port is already
 * bound by another listener. Used to drive the auto-increment search below:
 * an in-use port is skipped, any other bind error is fatal.
 */
export function isAddrInUseError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE'
}

/** How many consecutive ports to probe before giving up (8787 → 8850). */
export const MAX_PORT_PROBES = 64

/**
 * Bind starting at `startPort`, incrementing past any in-use port until one
 * binds — so the daemon prefers its configured port but never fails just
 * because it's taken. `bind(port)` must resolve on a successful bind and
 * reject with an `EADDRINUSE` error when the port is busy; its resolved value
 * (e.g. the listening server) is returned for the first port that binds.
 *
 * `startPort` 0 is the OS-ephemeral request — bound once, never incremented.
 * Stops at port 65535, and after MAX_PORT_PROBES attempts. Throws when every
 * probed port is busy, or immediately on any non-`EADDRINUSE` error.
 */
export async function bindWithAutoIncrement<T>(
  startPort: number,
  bind: (port: number) => Promise<T>,
): Promise<T> {
  if (startPort === 0) return bind(0)
  let lastErr: unknown
  for (let i = 0; i < MAX_PORT_PROBES; i++) {
    const port = startPort + i
    if (port > 65535) break
    try {
      return await bind(port)
    } catch (err) {
      if (!isAddrInUseError(err)) throw err
      lastErr = err
    }
  }
  const end = Math.min(startPort + MAX_PORT_PROBES, 65536)
  throw new Error(
    `no free port found in [${startPort}, ${end}); last error: ${String(lastErr)}`,
  )
}

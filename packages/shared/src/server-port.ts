import { env } from '#env'

/**
 * The server's default port. Fixed rather than ephemeral so the web app's
 * URL stays the same across restarts.
 */
export const DEFAULT_SERVER_PORT = 8787

/**
 * The port to bind: `--port` (`optPort`), else `YAAC_SERVER_PORT`, else
 * DEFAULT_SERVER_PORT. `0` asks the OS for an ephemeral port. An invalid
 * explicit value throws.
 */
export function resolveServerPort(optPort?: number): number {
  if (optPort !== undefined) return assertValidPort(optPort, '--port')
  return env.serverPort ?? DEFAULT_SERVER_PORT
}

function assertValidPort(port: number, source: string): number {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `${source} must be an integer between 0 and 65535, got ${String(port)}`,
    )
  }
  return port
}

/** True when `err` is a Node `EADDRINUSE` error. */
export function isAddrInUseError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE'
}

/** How many consecutive ports to probe before giving up (8787 → 8850). */
export const MAX_PORT_PROBES = 64

/**
 * Try `bind` on `startPort`, then each next port while it rejects with
 * `EADDRINUSE`, and return the first success. Port 0 is tried once. Gives
 * up after MAX_PORT_PROBES ports or at 65535, and throws at once on any
 * other error.
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

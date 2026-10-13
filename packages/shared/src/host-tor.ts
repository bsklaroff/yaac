/**
 * The host Tor checks both `yaac server start` and the server it spawns
 * run when `YAAC_USE_TOR` is set.
 */
import net from 'node:net'
import { env } from '#env'
import type { DriverKind } from '#types'

// With YAAC_USE_TOR, the server's own git goes through a host Tor SOCKS
// endpoint (default 127.0.0.1:9050). Fail at startup if it is unreachable
// rather than on the first git operation.
export async function preflightHostTor(): Promise<void> {
  if (!env.useTor) return
  const url = new URL(env.torSocksUrl)
  const host = url.hostname
  const port = parseInt(url.port || '9050', 10)
  await new Promise<void>((resolve, reject) => {
    const sock = net.connect({ host, port })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error(`timeout connecting to ${host}:${port}`))
    }, 2000)
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve() })
    sock.once('error', (err) => { clearTimeout(timer); reject(err) })
  }).catch((err: Error) => {
    throw new Error(
      `YAAC_USE_TOR is set but host Tor at ${url.href} is not reachable `
      + `(${err.message}). Start Tor ('sudo systemctl start tor' on Linux, `
      + `'brew services start tor' on macOS) or unset YAAC_USE_TOR.`,
    )
  })
}

/**
 * What `YAAC_USE_TOR` does not cover under the given driver, or undefined
 * when it covers everything.
 *
 * The server's own git is routed through Tor under either driver. Under
 * `k8s`, all workspace traffic is redirected into the egress proxy, which
 * dials through Tor. Containerless workspaces are plain host processes with
 * no proxy, and advisory env (`ALL_PROXY`, ssh ProxyCommand) fails open
 * (undici ignores it, raw sockets and DNS bypass it), so we warn instead.
 */
export function torCoverageWarning(driver: DriverKind): string | undefined {
  if (!env.useTor || driver !== 'containerless') return undefined
  return 'YAAC_USE_TOR is set, but the containerless driver runs workspaces '
    + 'directly on the host with no egress proxy, so agent traffic and '
    + 'anything a workspace does itself will NOT go through Tor. Only the '
    + "server's own git operations are routed through it. A cluster install "
    + '(`yaac cluster install`) is what gives Tor-covered workspaces.'
}

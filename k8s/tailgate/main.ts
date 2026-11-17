/**
 * tailgate's entry point: its configuration comes from the environment the
 * tailnet tunnel's Deployment sets (`cluster/site-edge.ts`).
 */
import { startTailgate } from './tailgate'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** Checked here, since `socket.setTimeout` would throw on the first
 *  connection rather than at start, and 0 would turn the timeout off. */
const idleSeconds = Number(required('TAILGATE_IDLE_SECONDS'))
if (!Number.isFinite(idleSeconds) || idleSeconds <= 0) {
  throw new Error('TAILGATE_IDLE_SECONDS must be a positive number')
}

/** A `host:port` address. */
function address(raw: string): { host: string; port: number } {
  const colon = raw.lastIndexOf(':')
  return { host: raw.slice(0, colon), port: Number(raw.slice(colon + 1)) }
}

/** The server upstream exists only while the install names a server name. */
const serverName = process.env.TAILGATE_SERVER_NAME?.toLowerCase()
await startTailgate({
  siteDomain: required('TAILGATE_SITE_DOMAIN').toLowerCase(),
  tailscaleSocket: required('TAILGATE_TAILSCALE_SOCKET'),
  router: address(required('TAILGATE_ROUTER')),
  server: serverName ? { name: serverName, ...address(required('TAILGATE_SERVER')) } : undefined,
  tlsDir: required('TAILGATE_TLS_DIR'),
  serveHost: required('TAILGATE_SERVE_HOST'),
  dnsHost: '127.0.0.1',
  httpsPort: Number(required('TAILGATE_HTTPS_PORT')),
  httpPort: Number(required('TAILGATE_HTTP_PORT')),
  dnsPort: 53,
  healthPort: Number(required('TAILGATE_HEALTH_PORT')),
  idleMs: idleSeconds * 1000,
  pollMs: 10_000,
})
console.log('[tailgate] serving')

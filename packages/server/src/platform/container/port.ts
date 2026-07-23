import net from 'node:net'
import { env } from '@yaac/shared/env'
import type { PortMapping } from '@yaac/shared/types'

export interface ReservedPort extends PortMapping {
  /** Pre-bound server holding the port so no other process can claim it. */
  server: net.Server
}

/**
 * The per-connection relay a forwarder spawns: a child-process-shaped
 * object bridging stdin/stdout to a TCP endpoint. Real implementations are
 * the stream-relay's `relayTcpFactory` (session port forwards — a `tcp`
 * stream into the pod's streamd) and ExecTunnel's kubectl+socat child (the
 * proxy control API), which both satisfy this shape.
 */
export interface RelayProcess {
  stdin: NodeJS.WritableStream | null
  stdout: NodeJS.ReadableStream | null
  kill(): void
  on(event: 'close' | 'error', cb: (...args: unknown[]) => void): void
}

/** A function that spawns a relay process bridging stdin/stdout to a TCP port. */
export type RelayFactory = (containerPort: number) => RelayProcess

/**
 * Try to listen on a port.  Returns the bound server on success, null on
 * failure.  Binds `YAAC_FORWARD_BIND` (default loopback) — a remote-
 * hosting server sets its tailnet IP here so forwarded dev servers are
 * reachable from other tailnet devices.
 */
function tryListen(port: number): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(null))
    server.once('listening', () => resolve(server))
    server.listen(port, env.forwardBind)
  })
}

/**
 * Find an available TCP port and **keep it bound** so no other process can
 * claim it between discovery and actual use.  The returned `server` should be
 * passed to {@link startPortForwarders} which will take ownership of it.
 */
export async function reserveAvailablePort(
  containerPort: number,
  startPort: number,
): Promise<ReservedPort> {
  const maxAttempts = 100
  for (let offset = 0; offset < maxAttempts; offset++) {
    const port = startPort + offset
    if (port > 65535) break
    const server = await tryListen(port)
    if (server) {
      return { containerPort, hostPort: port, server }
    }
  }
  throw new Error(`No available port found starting from ${startPort} (tried ${maxAttempts} ports)`)
}

/**
 * Start TCP servers on the host that forward connections into a container
 * by spawning a relay per connection.
 *
 * Accepts only {@link ReservedPort} entries whose `server` is already bound,
 * guaranteeing that the port cannot be stolen between discovery and use.
 *
 * Returns a cleanup function that closes all listeners.
 */
export function startPortForwarders(
  spawnRelay: RelayFactory,
  ports: ReservedPort[],
): () => void {
  const servers: net.Server[] = []
  const activeRelays = new Set<RelayProcess>()

  for (const { containerPort, server } of ports) {
    server.on('connection', (client: net.Socket) => {
      const child = spawnRelay(containerPort)

      if (!child.stdin || !child.stdout) {
        client.destroy()
        child.kill()
        return
      }

      activeRelays.add(child)
      child.on('close', () => activeRelays.delete(child))

      child.stdout.pipe(client)
      client.pipe(child.stdin)

      child.stdin.on('error', () => client.destroy())
      child.on('error', () => client.destroy())
      child.on('close', () => client.destroy())
      client.on('error', () => { child.stdin?.end(); child.kill() })
      client.on('close', () => { child.stdin?.end(); child.kill() })
    })

    servers.push(server)
  }

  return () => {
    for (const server of servers) {
      server.close()
    }
    for (const child of activeRelays) {
      child.kill()
    }
    activeRelays.clear()
  }
}

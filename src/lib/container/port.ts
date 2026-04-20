import net from 'node:net'
import { type ChildProcess, spawn } from 'node:child_process'

export interface PortMapping {
  containerPort: number
  hostPort: number
}

export interface ReservedPort extends PortMapping {
  /** Pre-bound server holding the port so no other process can claim it. */
  server: net.Server
}

/** A function that spawns a relay process bridging stdin/stdout to a TCP port. */
export type RelayFactory = (containerPort: number) => ChildProcess

/**
 * Try to listen on a port.  Returns the bound server on success, null on failure.
 */
function tryListen(port: number): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(null))
    server.once('listening', () => resolve(server))
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Scan for an available TCP port on the host, starting from `startPort`.
 * Tries up to 100 consecutive ports before throwing.
 *
 * NOTE: This releases the port immediately after finding it, so there is a
 * small TOCTOU window.  Prefer {@link reserveAvailablePort} when the caller
 * needs to guarantee the port stays available until it is handed off.
 */
export async function findAvailablePort(startPort: number): Promise<number> {
  const maxAttempts = 100
  for (let offset = 0; offset < maxAttempts; offset++) {
    const port = startPort + offset
    if (port > 65535) break
    const server = await tryListen(port)
    if (server) {
      server.close()
      return port
    }
  }
  throw new Error(`No available port found starting from ${startPort} (tried ${maxAttempts} ports)`)
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
 * Create a RelayFactory that uses `podman exec` + `nc` to connect to
 * localhost inside the given container.  Using `localhost` instead of a
 * literal IP lets nc reach services bound to either IPv4 (127.0.0.1) or
 * IPv6 (::1) loopback.
 */
export function podmanRelay(containerName: string): RelayFactory {
  return (containerPort) =>
    spawn('podman', [
      'exec', '-i', containerName,
      'nc', 'localhost', String(containerPort),
    ], { stdio: ['pipe', 'pipe', 'ignore'] })
}

/**
 * Start TCP servers on the host that forward connections into a container
 * by spawning a relay process (typically `podman exec nc`) per connection.
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
  const activeRelays = new Set<ChildProcess>()

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
      client.on('error', () => { child.stdin?.destroy(); child.kill() })
      client.on('close', () => { child.stdin?.destroy(); child.kill() })
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

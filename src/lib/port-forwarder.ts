import net from 'node:net'
import { type ChildProcess, spawn } from 'node:child_process'

interface ForwardedPort {
  containerPort: number
  hostPort: number
}

/** A function that spawns a relay process bridging stdin/stdout to a TCP port. */
export type RelayFactory = (containerPort: number) => ChildProcess

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
 * Returns a cleanup function that closes all listeners.
 */
export function startPortForwarders(
  spawnRelay: RelayFactory,
  ports: ForwardedPort[],
): () => void {
  const servers: net.Server[] = []
  const activeRelays = new Set<ChildProcess>()

  for (const { containerPort, hostPort } of ports) {
    const server = net.createServer((client) => {
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

    server.listen(hostPort, '127.0.0.1')
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

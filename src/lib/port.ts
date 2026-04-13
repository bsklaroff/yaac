import net from 'node:net'

/**
 * Check if a TCP port is available on the host by attempting to listen on it.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Scan for an available TCP port on the host, starting from `startPort`.
 * Tries up to 100 consecutive ports before throwing.
 */
export async function findAvailablePort(startPort: number): Promise<number> {
  const maxAttempts = 100
  for (let offset = 0; offset < maxAttempts; offset++) {
    const port = startPort + offset
    if (port > 65535) break
    if (await isPortAvailable(port)) {
      return port
    }
  }
  throw new Error(`No available port found starting from ${startPort} (tried ${maxAttempts} ports)`)
}

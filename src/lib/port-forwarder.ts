import net from 'node:net'

interface ForwardedPort {
  containerPort: number
  hostPort: number
}

/**
 * Establish a TCP connection through an HTTP CONNECT proxy.
 * Returns the connected socket after the CONNECT handshake completes.
 */
function connectViaProxy(
  proxyHost: string,
  proxyPort: number,
  targetHost: string,
  targetPort: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, proxyHost)

    socket.once('error', reject)

    let buffer = Buffer.alloc(0)

    function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk])
      const idx = buffer.indexOf('\r\n\r\n')
      if (idx === -1) return

      socket.removeListener('data', onData)
      socket.removeListener('error', reject)

      const statusLine = buffer.subarray(0, idx).toString().split('\r\n')[0]
      if (!statusLine.startsWith('HTTP/1.1 200')) {
        socket.destroy()
        reject(new Error(`CONNECT failed: ${statusLine}`))
        return
      }

      const remaining = buffer.subarray(idx + 4)
      if (remaining.length > 0) {
        socket.unshift(remaining)
      }

      resolve(socket)
    }

    socket.on('data', onData)

    socket.once('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n\r\n`,
      )
    })
  })
}

/**
 * Start TCP servers on the host that forward connections through the proxy
 * sidecar's CONNECT handler to a container on the internal network.
 *
 * Returns a cleanup function that closes all listeners.
 */
export function startPortForwarders(
  proxyHost: string,
  proxyPort: number,
  targetIp: string,
  ports: ForwardedPort[],
): () => void {
  const servers: net.Server[] = []

  for (const { containerPort, hostPort } of ports) {
    const server = net.createServer((client) => {
      connectViaProxy(proxyHost, proxyPort, targetIp, containerPort)
        .then((tunnel) => {
          tunnel.pipe(client)
          client.pipe(tunnel)
          tunnel.on('error', () => client.destroy())
          client.on('error', () => tunnel.destroy())
          client.on('close', () => tunnel.destroy())
          tunnel.on('close', () => client.destroy())
        })
        .catch(() => {
          client.destroy()
        })
    })

    server.listen(hostPort, '127.0.0.1')
    servers.push(server)
  }

  return () => {
    for (const server of servers) {
      server.close()
    }
  }
}

import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { startPortForwarders } from '@/lib/port-forwarder'

describe('startPortForwarders', () => {
  const cleanups: Array<() => void> = []
  const servers: net.Server[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
    for (const s of servers) s.close()
    servers.length = 0
  })

  /** Minimal HTTP CONNECT proxy that tunnels to a target server. */
  function startFakeProxy(): Promise<net.Server> {
    return new Promise((resolve) => {
      const proxy = net.createServer((clientSocket) => {
        let buf = Buffer.alloc(0)

        clientSocket.on('data', function onData(chunk: Buffer) {
          buf = Buffer.concat([buf, chunk])
          const idx = buf.indexOf('\r\n\r\n')
          if (idx === -1) return

          clientSocket.removeListener('data', onData)

          const line = buf.subarray(0, idx).toString().split('\r\n')[0]
          const match = line.match(/^CONNECT\s+([^:]+):(\d+)/)
          if (!match) {
            clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
            return
          }

          const [, host, targetPort] = match
          const upstream = net.connect(parseInt(targetPort, 10), host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            const remaining = buf.subarray(idx + 4)
            if (remaining.length > 0) upstream.write(remaining)
            clientSocket.pipe(upstream)
            upstream.pipe(clientSocket)
          })

          upstream.on('error', () => clientSocket.destroy())
          clientSocket.on('error', () => upstream.destroy())
        })
      })

      proxy.listen(0, '127.0.0.1', () => {
        servers.push(proxy)
        resolve(proxy)
      })
    })
  }

  /** Start a TCP echo server on a random port. */
  function startEchoServer(): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        socket.pipe(socket)
      })
      server.listen(0, '127.0.0.1', () => {
        servers.push(server)
        const addr = server.address() as net.AddressInfo
        resolve({ server, port: addr.port })
      })
    })
  }

  function connectAndSend(port: number, data: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(data)
      })
      let received = ''
      client.on('data', (chunk) => {
        received += chunk.toString()
        if (received.length >= data.length) {
          client.destroy()
          resolve(received)
        }
      })
      client.on('error', reject)
      client.setTimeout(5000, () => {
        client.destroy()
        reject(new Error('timeout'))
      })
    })
  }

  it('forwards TCP through proxy CONNECT to target', async () => {
    const proxy = await startFakeProxy()
    const proxyPort = (proxy.address() as net.AddressInfo).port

    const echo = await startEchoServer()

    const stop = startPortForwarders(
      '127.0.0.1', proxyPort,
      '127.0.0.1', [{ containerPort: echo.port, hostPort: 0 }],
    )
    cleanups.push(stop)

    // startPortForwarders uses port 0 for hostPort, but we specified actual
    // ports. Let's use a known port instead.
    stop()
    cleanups.pop()

    // Use a specific host port
    const hostPort = 19300
    const stop2 = startPortForwarders(
      '127.0.0.1', proxyPort,
      '127.0.0.1', [{ containerPort: echo.port, hostPort }],
    )
    cleanups.push(stop2)

    const result = await connectAndSend(hostPort, 'hello')
    expect(result).toBe('hello')
  })

  it('forwards multiple ports', async () => {
    const proxy = await startFakeProxy()
    const proxyPort = (proxy.address() as net.AddressInfo).port

    const echo1 = await startEchoServer()
    const echo2 = await startEchoServer()

    const stop = startPortForwarders(
      '127.0.0.1', proxyPort,
      '127.0.0.1', [
        { containerPort: echo1.port, hostPort: 19310 },
        { containerPort: echo2.port, hostPort: 19311 },
      ],
    )
    cleanups.push(stop)

    const [r1, r2] = await Promise.all([
      connectAndSend(19310, 'port1'),
      connectAndSend(19311, 'port2'),
    ])
    expect(r1).toBe('port1')
    expect(r2).toBe('port2')
  })

  it('destroys client when CONNECT fails', async () => {
    // Proxy that always rejects CONNECT
    const rejectProxy = net.createServer((socket) => {
      let buf = Buffer.alloc(0)
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk])
        if (buf.indexOf('\r\n\r\n') !== -1) {
          socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        }
      })
    })
    await new Promise<void>((resolve) => {
      rejectProxy.listen(0, '127.0.0.1', () => {
        servers.push(rejectProxy)
        resolve()
      })
    })
    const proxyPort = (rejectProxy.address() as net.AddressInfo).port

    const stop = startPortForwarders(
      '127.0.0.1', proxyPort,
      '127.0.0.1', [{ containerPort: 9999, hostPort: 19320 }],
    )
    cleanups.push(stop)

    // Connection should be destroyed — client sees a close/reset
    const result = await new Promise<string>((resolve, reject) => {
      const client = net.connect(19320, '127.0.0.1')
      client.on('close', () => resolve('closed'))
      client.on('error', () => resolve('error'))
      client.setTimeout(3000, () => {
        client.destroy()
        reject(new Error('timeout'))
      })
    })
    expect(['closed', 'error']).toContain(result)
  })

  it('cleanup function closes all listeners', async () => {
    const proxy = await startFakeProxy()
    const proxyPort = (proxy.address() as net.AddressInfo).port

    const stop = startPortForwarders(
      '127.0.0.1', proxyPort,
      '127.0.0.1', [{ containerPort: 8080, hostPort: 19330 }],
    )

    stop()

    // Port should be free now — connecting should fail
    await expect(connectAndSend(19330, 'test')).rejects.toThrow()
  })
})

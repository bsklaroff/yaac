import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { startPortForwarders, type RelayFactory } from '@/lib/port-forwarder'

describe('startPortForwarders', () => {
  const cleanups: Array<() => void> = []
  const servers: net.Server[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
    for (const s of servers) s.close()
    servers.length = 0
  })

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

  /** RelayFactory that spawns a local `node` process to relay stdin/stdout to a TCP port. */
  function localRelay(): RelayFactory {
    return (port: number): ChildProcess => {
      const script = `
        const net = require('net');
        const s = net.connect(${port}, '127.0.0.1', () => {
          process.stdin.pipe(s);
          s.pipe(process.stdout);
        });
        s.on('error', () => process.exit(1));
        s.on('close', () => process.exit(0));
      `
      return spawn(process.execPath, ['-e', script], {
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    }
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

  it('forwards TCP through relay to target', async () => {
    const echo = await startEchoServer()

    const hostPort = 19300
    const stop = startPortForwarders(
      localRelay(),
      [{ containerPort: echo.port, hostPort }],
    )
    cleanups.push(stop)

    const result = await connectAndSend(hostPort, 'hello')
    expect(result).toBe('hello')
  })

  it('forwards multiple ports', async () => {
    const echo1 = await startEchoServer()
    const echo2 = await startEchoServer()

    const stop = startPortForwarders(
      localRelay(),
      [
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

  it('destroys client when relay fails', async () => {
    // Relay that immediately exits with error (target port not listening)
    const failRelay: RelayFactory = (port) => {
      return spawn(process.execPath, [
        '-e', `const s=require('net').connect(${port},'127.0.0.1');s.on('error',()=>process.exit(1))`,
      ], { stdio: ['pipe', 'pipe', 'ignore'] })
    }

    const stop = startPortForwarders(
      failRelay,
      [{ containerPort: 59999, hostPort: 19320 }],
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
    const echo = await startEchoServer()

    const stop = startPortForwarders(
      localRelay(),
      [{ containerPort: echo.port, hostPort: 19330 }],
    )

    stop()

    // Port should be free now — connecting should fail
    await expect(connectAndSend(19330, 'test')).rejects.toThrow()
  })
})

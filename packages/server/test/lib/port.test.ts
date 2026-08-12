import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { reserveAvailablePort, startPortForwarders, type RelayFactory } from '#lib/port'

describe('reserveAvailablePort', () => {
  const servers: net.Server[] = []

  afterEach(() => {
    for (const server of servers) {
      server.close()
    }
    servers.length = 0
  })

  function occupyPort(port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        servers.push(server)
        resolve(server)
      })
    })
  }

  it('returns the start port when it is available', async () => {
    const reserved = await reserveAvailablePort(3000, 19500)
    servers.push(reserved.server)
    expect(reserved.hostPort).toBe(19500)
    expect(reserved.containerPort).toBe(3000)
    // Default posture: bound to loopback (YAAC_FORWARD_BIND unset).
    expect((reserved.server.address() as net.AddressInfo).address).toBe('127.0.0.1')
  })

  it('binds the YAAC_FORWARD_BIND address when configured', async () => {
    vi.stubEnv('YAAC_FORWARD_BIND', '0.0.0.0')
    try {
      const reserved = await reserveAvailablePort(3000, 19550)
      servers.push(reserved.server)
      expect((reserved.server.address() as net.AddressInfo).address).toBe('0.0.0.0')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('skips occupied ports', async () => {
    await occupyPort(19600)
    const reserved = await reserveAvailablePort(3000, 19600)
    servers.push(reserved.server)
    expect(reserved.hostPort).toBe(19601)
  })

  it('holds the port so concurrent callers cannot claim it', async () => {
    // Simulate two sessions both trying to reserve the same port range.
    const first = await reserveAvailablePort(3000, 19700)
    servers.push(first.server)

    // Second reservation with the same start port must get a different port
    // because the first is still held.
    const second = await reserveAvailablePort(3001, 19700)
    servers.push(second.server)

    expect(first.hostPort).toBe(19700)
    expect(second.hostPort).toBe(19701)
  })

  it('throws when no ports are available within range', async () => {
    await expect(reserveAvailablePort(3000, 65536)).rejects.toThrow('No available port found')
  })
})

describe('startPortForwarders', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  /** Start a TCP echo server on a random port. */
  function startEchoServer(): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        socket.pipe(socket)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo
        resolve({ server, port: addr.port })
      })
    })
  }

  /**
   * A real relay: a `node` child bridging its stdin/stdout to a TCP port,
   * which is the shape both production factories have (a streamd `tcp`
   * stream and ExecTunnel's kubectl+socat child). Spawning it for real keeps
   * the boundary where the feature has one — the child process.
   */
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
    cleanups.push(() => echo.server.close())

    const reserved = await reserveAvailablePort(echo.port, 19300)
    const stop = startPortForwarders(
      localRelay(),
      [reserved],
    )
    cleanups.push(stop)

    const result = await connectAndSend(reserved.hostPort, 'hello')
    expect(result).toBe('hello')
  })

  it('forwards multiple ports', async () => {
    const echo1 = await startEchoServer()
    const echo2 = await startEchoServer()
    cleanups.push(() => echo1.server.close())
    cleanups.push(() => echo2.server.close())

    const r1 = await reserveAvailablePort(echo1.port, 19310)
    const r2 = await reserveAvailablePort(echo2.port, 19311)

    const stop = startPortForwarders(
      localRelay(),
      [r1, r2],
    )
    cleanups.push(stop)

    const [res1, res2] = await Promise.all([
      connectAndSend(r1.hostPort, 'port1'),
      connectAndSend(r2.hostPort, 'port2'),
    ])
    expect(res1).toBe('port1')
    expect(res2).toBe('port2')
  })

  it('destroys client when relay fails', async () => {
    // Relay that immediately exits with error (target port not listening)
    const failRelay: RelayFactory = (port) => {
      return spawn(process.execPath, [
        '-e', `const s=require('net').connect(${port},'127.0.0.1');s.on('error',()=>process.exit(1))`,
      ], { stdio: ['pipe', 'pipe', 'ignore'] })
    }

    const reserved = await reserveAvailablePort(59999, 19320)
    const stop = startPortForwarders(
      failRelay,
      [reserved],
    )
    cleanups.push(stop)

    // Connection should be destroyed — client sees a close/reset
    const result = await new Promise<string>((resolve, reject) => {
      const client = net.connect(reserved.hostPort, '127.0.0.1')
      client.on('close', () => resolve('closed'))
      client.on('error', () => resolve('error'))
      client.setTimeout(3000, () => {
        client.destroy()
        reject(new Error('timeout'))
      })
    })
    expect(['closed', 'error']).toContain(result)
  })

  it('destroys the client when the relay command cannot be spawned', async () => {
    // A relay whose command is missing (no kubectl on PATH, say) hands back a
    // child with pipes that emits 'error' instead of ever connecting.
    const missingRelay: RelayFactory = () =>
      spawn('/nonexistent/yaac-relay', [], { stdio: ['pipe', 'pipe', 'ignore'] })

    const reserved = await reserveAvailablePort(59997, 19350)
    const stop = startPortForwarders(missingRelay, [reserved])
    cleanups.push(stop)

    const result = await new Promise<string>((resolve, reject) => {
      const client = net.connect(reserved.hostPort, '127.0.0.1')
      client.on('close', () => resolve('closed'))
      client.on('error', () => resolve('error'))
      client.setTimeout(3000, () => {
        client.destroy()
        reject(new Error('timeout'))
      })
    })
    expect(['closed', 'error']).toContain(result)
  })

  it('destroys the client when the relay has no pipes to bridge', async () => {
    // A relay whose stdio the caller forgot to pipe has nothing to bridge:
    // the connection must be dropped rather than hang, and the useless child
    // killed rather than leaked.
    const killed: ChildProcess[] = []
    const pipelessRelay: RelayFactory = (port) => {
      const child = spawn(process.execPath, [
        '-e', `setTimeout(() => {}, 30000); void ${port}`,
      ], { stdio: 'ignore' })
      killed.push(child)
      return child
    }

    const reserved = await reserveAvailablePort(59998, 19340)
    const stop = startPortForwarders(pipelessRelay, [reserved])
    cleanups.push(stop)

    const result = await new Promise<string>((resolve, reject) => {
      const client = net.connect(reserved.hostPort, '127.0.0.1')
      client.on('close', () => resolve('closed'))
      client.on('error', () => resolve('error'))
      client.setTimeout(3000, () => {
        client.destroy()
        reject(new Error('timeout'))
      })
    })

    expect(['closed', 'error']).toContain(result)
    expect(killed).toHaveLength(1)
    await vi.waitFor(() => expect(killed[0]?.killed).toBe(true))
  })

  it('cleanup function closes all listeners and kills live relays', async () => {
    const echo = await startEchoServer()
    cleanups.push(() => echo.server.close())

    const reserved = await reserveAvailablePort(echo.port, 19330)
    const stop = startPortForwarders(
      localRelay(),
      [reserved],
    )

    // Hold a connection open so the stop below has a live relay to kill.
    const client = net.connect(reserved.hostPort, '127.0.0.1')
    await new Promise<void>((resolve) => client.once('connect', () => resolve()))

    stop()
    client.destroy()

    // Port should be free now — connecting should fail
    await expect(connectAndSend(reserved.hostPort, 'test')).rejects.toThrow()
  })
})

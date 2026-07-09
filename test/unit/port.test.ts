import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { reserveAvailablePort } from '@/lib/container/port'

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

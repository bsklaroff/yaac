import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { findAvailablePort } from '@/lib/container/port'

describe('findAvailablePort', () => {
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
    const port = await findAvailablePort(19100)
    expect(port).toBe(19100)
  })

  it('skips occupied ports and returns the next available one', async () => {
    await occupyPort(19200)
    await occupyPort(19201)
    const port = await findAvailablePort(19200)
    expect(port).toBe(19202)
  })

  it('throws when no ports are available within range', async () => {
    await expect(findAvailablePort(65536)).rejects.toThrow('No available port found')
  })
})

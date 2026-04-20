import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import crypto from 'node:crypto'
import http from 'node:http'
import { requirePodman, TEST_RUN_ID, podmanRetry, removeContainer } from '@test/helpers/setup'
import { ProxyClient } from '@/lib/container/proxy-client'
import { startPortForwarders, podmanRelay, reserveAvailablePort } from '@/lib/container/port'
import { podman } from '@/lib/container/runtime'

/** Make a simple HTTP GET request and return the response body. */
function httpGet(url: string, timeoutMs = 5000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timed out'))
    })
  })
}

describe('port forwarding via podman exec relay', () => {
  let client: ProxyClient
  const containerPort = 8080

  const containers: string[] = []

  beforeAll(async () => {
    await requirePodman()

    client = new ProxyClient({
      image: 'yaac-test-proxy',
      network: `yaac-test-portfwd-${TEST_RUN_ID}`,
      requirePrebuilt: true,
    })

    await client.ensureRunning()
  }, 30_000)

  afterAll(async () => {
    try { await client?.stop() } catch { /* ok */ }
  })

  afterEach(async () => {
    for (const name of containers) {
      await removeContainer(name)
    }
    containers.length = 0
  })

  /**
   * Start a container with an HTTP server listening on the given bind address.
   * Defaults to 127.0.0.1 (IPv4 loopback), which is the common case for dev
   * servers and the scenario the old CONNECT-based forwarder could not handle.
   */
  async function startHttpContainer(
    bindAddress: '127.0.0.1' | '::1' = '127.0.0.1',
  ): Promise<{ name: string }> {
    const name = `yaac-portfwd-test-${crypto.randomBytes(4).toString('hex')}`
    containers.push(name)

    const echoScript = `
      const http = require('http');
      http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello from container');
      }).listen(${containerPort}, '${bindAddress}', () => console.log('ready'));
    `

    // Use the base image — it has both node and nc (netcat-openbsd)
    const { stdout: images } = await podmanRetry([
      'images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=yaac-test-base',
    ])
    const baseImage = images.trim().split('\n')[0]

    const container = await podman.createContainer({
      Image: baseImage,
      name,
      Entrypoint: ['node', '-e', echoScript],
      Labels: { 'yaac.test': 'true' },
      HostConfig: {
        NetworkMode: client.network,
      },
    })
    await container.start()

    // Wait for the HTTP server to be ready inside the container
    const curlHost = bindAddress === '::1' ? '[::1]' : bindAddress
    for (let i = 0; i < 30; i++) {
      try {
        const { stdout } = await podmanRetry([
          'exec', name, 'sh', '-c',
          `curl -sf http://${curlHost}:${containerPort}/`,
        ], { timeout: 3000 })
        if (stdout) break
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }

    return { name }
  }

  it('forwards HTTP request from host to container via podman exec relay', async () => {
    const { name } = await startHttpContainer()

    const reserved = await reserveAvailablePort(containerPort, 19400)
    const stop = startPortForwarders(
      podmanRelay(name),
      [reserved],
    )

    try {
      const result = await httpGet(`http://127.0.0.1:${reserved.hostPort}/`)
      expect(result.status).toBe(200)
      expect(result.body).toBe('hello from container')
    } finally {
      stop()
    }
  }, 30_000)

  it('forwards HTTP request from host to IPv6-only container server', async () => {
    const { name } = await startHttpContainer('::1')

    const reserved = await reserveAvailablePort(containerPort, 19400)
    const stop = startPortForwarders(
      podmanRelay(name),
      [reserved],
    )

    try {
      const result = await httpGet(`http://127.0.0.1:${reserved.hostPort}/`)
      expect(result.status).toBe(200)
      expect(result.body).toBe('hello from container')
    } finally {
      stop()
    }
  }, 30_000)

  it('forwards multiple ports to the same container', async () => {
    // Start a container running two HTTP servers on different ports
    const secondPort = 8081
    const name = `yaac-portfwd-test-${crypto.randomBytes(4).toString('hex')}`
    containers.push(name)

    const dualScript = `
      const http = require('http');
      http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello from container');
      }).listen(${containerPort}, '127.0.0.1');
      http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('second server');
      }).listen(${secondPort}, '127.0.0.1');
    `

    const { stdout: images } = await podmanRetry([
      'images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=yaac-test-base',
    ])
    const baseImage = images.trim().split('\n')[0]

    const container = await podman.createContainer({
      Image: baseImage,
      name,
      Entrypoint: ['node', '-e', dualScript],
      Labels: { 'yaac.test': 'true' },
      HostConfig: { NetworkMode: client.network },
    })
    await container.start()

    // Wait for both servers
    for (const port of [containerPort, secondPort]) {
      for (let i = 0; i < 30; i++) {
        try {
          await podmanRetry([
            'exec', name, 'sh', '-c', `curl -sf http://127.0.0.1:${port}/`,
          ], { timeout: 3000 })
          break
        } catch {
          await new Promise((r) => setTimeout(r, 250))
        }
      }
    }

    const reserved1 = await reserveAvailablePort(containerPort, 19410)
    const reserved2 = await reserveAvailablePort(secondPort, reserved1.hostPort + 1)

    const stop = startPortForwarders(
      podmanRelay(name),
      [reserved1, reserved2],
    )

    try {
      const [r1, r2] = await Promise.all([
        httpGet(`http://127.0.0.1:${reserved1.hostPort}/`),
        httpGet(`http://127.0.0.1:${reserved2.hostPort}/`),
      ])

      expect(r1.status).toBe(200)
      expect(r1.body).toBe('hello from container')
      expect(r2.status).toBe(200)
      expect(r2.body).toBe('second server')
    } finally {
      stop()
    }
  }, 30_000)

  it('relay works while event loop processes other tasks', async () => {
    // Regression test: startPortForwarders relies on the Node.js event loop
    // to accept TCP connections. If the event loop is blocked (e.g. by
    // execSync), no connections can be accepted.
    const { name } = await startHttpContainer()

    const reserved = await reserveAvailablePort(containerPort, 19420)
    const stop = startPortForwarders(
      podmanRelay(name),
      [reserved],
    )

    try {
      // Make multiple sequential requests to confirm stability
      for (let i = 0; i < 3; i++) {
        const result = await httpGet(`http://127.0.0.1:${reserved.hostPort}/`)
        expect(result.status).toBe(200)
        expect(result.body).toBe('hello from container')
      }
    } finally {
      stop()
    }
  }, 30_000)
})

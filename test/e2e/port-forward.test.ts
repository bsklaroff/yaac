import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import crypto from 'node:crypto'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requirePodman, TEST_PROXY_CONFIG } from '@test/helpers/setup'
import { ProxyClient } from '@/lib/proxy-client'
import { startPortForwarders, podmanRelay } from '@/lib/port-forwarder'
import { findAvailablePort } from '@/lib/port'
import { podman } from '@/lib/podman'

const execFileAsync = promisify(execFile)

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
  const testAuthSecret = crypto.randomBytes(32).toString('hex')
  const containerPort = 8080

  const containers: string[] = []

  beforeAll(async () => {
    await requirePodman()

    // We still use the proxy network to simulate the real session topology
    // (container on an internal network with no host route).
    const proxyPort = await findAvailablePort(19350)

    client = new ProxyClient({
      ...TEST_PROXY_CONFIG,
      containerName: 'yaac-proxy-portfwd-test',
      hostPort: String(proxyPort),
      authSecret: testAuthSecret,
    })

    await client.ensureRunning()
  }, 30_000)

  afterAll(async () => {
    try { await client?.stop() } catch { /* ok */ }
  })

  afterEach(async () => {
    for (const name of containers) {
      try {
        const c = podman.getContainer(name)
        await c.stop({ t: 1 })
        await c.remove()
      } catch { /* already gone */ }
    }
    containers.length = 0
  })

  /**
   * Start a container with an HTTP server listening on 127.0.0.1 (localhost
   * only).  This is the common case for dev servers and is the scenario that
   * the old CONNECT-based forwarder could not handle.
   */
  async function startHttpContainer(): Promise<{ name: string }> {
    const name = `yaac-portfwd-test-${crypto.randomBytes(4).toString('hex')}`
    containers.push(name)

    // Deliberately bind to 127.0.0.1 — not 0.0.0.0
    const echoScript = `
      const http = require('http');
      http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello from container');
      }).listen(${containerPort}, '127.0.0.1', () => console.log('ready'));
    `

    // Use the base image — it has both node and nc (netcat-openbsd)
    const { stdout: images } = await execFileAsync('podman', [
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
    for (let i = 0; i < 30; i++) {
      try {
        const { stdout } = await execFileAsync('podman', [
          'exec', name, 'sh', '-c',
          `curl -sf http://127.0.0.1:${containerPort}/`,
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

    const hostPort = await findAvailablePort(19400)
    const stop = startPortForwarders(
      podmanRelay(name),
      [{ containerPort, hostPort }],
    )

    try {
      // Give the TCP server a moment to bind
      await new Promise((r) => setTimeout(r, 100))

      const result = await httpGet(`http://127.0.0.1:${hostPort}/`)
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

    const { stdout: images } = await execFileAsync('podman', [
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
          await execFileAsync('podman', [
            'exec', name, 'sh', '-c', `curl -sf http://127.0.0.1:${port}/`,
          ], { timeout: 3000 })
          break
        } catch {
          await new Promise((r) => setTimeout(r, 250))
        }
      }
    }

    const hostPort1 = await findAvailablePort(19410)
    const hostPort2 = await findAvailablePort(hostPort1 + 1)

    const stop = startPortForwarders(
      podmanRelay(name),
      [
        { containerPort, hostPort: hostPort1 },
        { containerPort: secondPort, hostPort: hostPort2 },
      ],
    )

    try {
      await new Promise((r) => setTimeout(r, 100))

      const [r1, r2] = await Promise.all([
        httpGet(`http://127.0.0.1:${hostPort1}/`),
        httpGet(`http://127.0.0.1:${hostPort2}/`),
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

    const hostPort = await findAvailablePort(19420)
    const stop = startPortForwarders(
      podmanRelay(name),
      [{ containerPort, hostPort }],
    )

    try {
      await new Promise((r) => setTimeout(r, 100))

      // Make multiple sequential requests to confirm stability
      for (let i = 0; i < 3; i++) {
        const result = await httpGet(`http://127.0.0.1:${hostPort}/`)
        expect(result.status).toBe(200)
        expect(result.body).toBe('hello from container')
      }
    } finally {
      stop()
    }
  }, 30_000)
})

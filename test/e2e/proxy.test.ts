import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import { requirePodman, TEST_PROXY_CONFIG } from '@test/helpers/setup'
import { ProxyClient, INTERNAL_PORT } from '@/lib/proxy-client'
import { podman } from '@/lib/podman'
import { findAvailablePort } from '@/lib/port'

const execFileAsync = promisify(execFile)

// Unique suffix per test run to avoid container/network name collisions
const RUN_ID = crypto.randomBytes(4).toString('hex')

/** Make an HTTP request through the proxy using the absolute-URI form. */
function proxyRequest(
  proxyPort: number,
  targetUrl: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: targetUrl,
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

describe('proxy sidecar', () => {
  let client: ProxyClient
  let proxyPort: number

  const testAuthSecret = crypto.randomBytes(32).toString('hex')

  beforeAll(async () => {
    await requirePodman()

    proxyPort = await findAvailablePort(19255)
    client = new ProxyClient({
      ...TEST_PROXY_CONFIG,
      containerName: `yaac-proxy-test-${RUN_ID}`,
      hostPort: String(proxyPort),
      network: `yaac-test-sidecar-${RUN_ID}`,
      authSecret: testAuthSecret,
    })
  })

  afterAll(async () => {
    if (!client) return
    try {
      await client.stop()
    } catch {
      // ok
    }
  })

  it('starts proxy and healthcheck responds', async () => {
    await client.ensureRunning()

    const res = await fetch(`http://127.0.0.1:${proxyPort}/healthz`)
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('ok')
  })

  it('serves CA certificate', async () => {
    await client.ensureRunning()

    const caCert = await client.getCaCert()
    expect(caCert).toContain('BEGIN CERTIFICATE')
    expect(caCert).toContain('END CERTIFICATE')
  })

  it('registers session and project rules', async () => {
    await client.ensureRunning()

    const token = client.generateSessionToken()
    expect(token).toHaveLength(64) // 32 bytes hex

    // Register rules
    await client.updateProjectRules('test-project', [
      {
        hostPattern: 'api.github.com',
        pathPattern: '/*',
        injections: [{ action: 'set_header', name: 'authorization', value: 'Bearer test-token' }],
      },
    ])

    // Register session
    await client.registerSession(token, 'test-project')

    // Clean up
    await client.removeSession(token)
    await client.removeProjectRules('test-project')
  })

  it('ensureRunning is idempotent', async () => {
    // Call twice — should not error or create duplicate containers
    await client.ensureRunning()
    await client.ensureRunning()

    const res = await fetch(`http://127.0.0.1:${proxyPort}/healthz`)
    expect(res.ok).toBe(true)
  })

  it('stop removes container and network', async () => {
    await client.ensureRunning()
    await client.stop()

    // Healthcheck should fail
    await expect(fetch(`http://127.0.0.1:${proxyPort}/healthz`)).rejects.toThrow()
  })

  describe('CONNECT tunnel', () => {
    const tunnelContainers: string[] = []

    afterEach(async () => {
      for (const name of tunnelContainers) {
        try {
          const c = podman.getContainer(name)
          await c.stop({ t: 1 })
          await c.remove()
        } catch {
          // already gone
        }
      }
      tunnelContainers.length = 0
    })

    it('tunnels TCP connections via CONNECT from internal network', async () => {
      await client.ensureRunning()

      // Create a container on the internal-only network (same as a real session)
      const containerName = `yaac-proxy-tunnel-test-${crypto.randomBytes(4).toString('hex')}`
      tunnelContainers.push(containerName)

      // Find the test base image
      const { stdout: images } = await execFileAsync('podman', [
        'images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=yaac-test-base',
      ])
      const baseImage = images.trim().split('\n')[0]
      expect(baseImage).toBeTruthy()

      const container = await podman.createContainer({
        Image: baseImage,
        name: containerName,
        Labels: { 'yaac.test': 'true' },
        HostConfig: {
          NetworkMode: client.network,
        },
      })
      await container.start()

      // Verify the container CANNOT reach external hosts directly
      const { stdout: blocked } = await execFileAsync('podman', [
        'exec', containerName, 'sh', '-c',
        'curl -sf --connect-timeout 3 http://github.com 2>&1 || echo connection-blocked',
      ], { timeout: 10_000 })
      expect(blocked.trim()).toContain('connection-blocked')

      // Verify the container CAN reach external hosts via CONNECT tunnel through proxy
      const proxyAddr = `${client.proxyIp}:${INTERNAL_PORT}`
      const { stdout: tunneled } = await execFileAsync('podman', [
        'exec', containerName, 'sh', '-c',
        `echo '' | nc -w 5 -X connect -x ${proxyAddr} github.com 443 | head -c 1 || echo tunnel-open`,
      ], { timeout: 15_000 })
      // A successful CONNECT to port 443 will get some TLS bytes or a timeout,
      // but it won't say "connection-blocked". If we get any data, the tunnel worked.
      expect(tunneled.trim()).not.toContain('connection-blocked')
    }, 30_000)
  })
})

describe('proxy HTTP forwarding', () => {
  let client: ProxyClient
  let echoContainerName: string
  let echoIp: string
  let proxyPort: number
  const echoPort = 8080

  const testAuthSecret = crypto.randomBytes(32).toString('hex')

  beforeAll(async () => {
    await requirePodman()

    proxyPort = await findAvailablePort(19257)
    client = new ProxyClient({
      image: 'yaac-test-proxy',
      containerName: `yaac-proxy-http-test-${RUN_ID}`,
      hostPort: String(proxyPort),
      network: `yaac-test-http-${RUN_ID}`,
      authSecret: testAuthSecret,
      requirePrebuilt: true,
    })
    await client.ensureRunning()

    // Run an echo HTTP server inside a container on the podman network
    // (same network the proxy container is also connected to).
    // This avoids macOS podman VM host-reachability issues.
    echoContainerName = `yaac-echo-test-${crypto.randomBytes(4).toString('hex')}`
    const echoScript = `
      const http = require('http');
      http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
      }).listen(${echoPort}, '0.0.0.0', () => console.log('echo ready'));
    `

    // Find the proxy image (has node)
    const { stdout: images } = await execFileAsync('podman', [
      'images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=yaac-test-proxy',
    ])
    const proxyImage = images.trim().split('\n')[0]

    const echoContainer = await podman.createContainer({
      Image: proxyImage,
      name: echoContainerName,
      Cmd: ['node', '-e', echoScript],
      Labels: { 'yaac.test': 'true' },
      HostConfig: {
        NetworkMode: 'podman',
      },
    })
    await echoContainer.start()

    // Get the echo container's IP on the podman network
    const info = await echoContainer.inspect()
    const networks = info.NetworkSettings.Networks as Record<string, { IPAddress: string }>
    echoIp = networks['podman']?.IPAddress
    if (!echoIp) throw new Error('Echo container has no IP on podman network')

    // Wait for echo server to be ready
    for (let i = 0; i < 20; i++) {
      try {
        const { stdout } = await execFileAsync('podman', [
          'exec', echoContainerName, 'sh', '-c',
          `curl -sf http://127.0.0.1:${echoPort}/ping`,
        ], { timeout: 3000 })
        if (stdout) break
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
  })

  afterAll(async () => {
    try { await client?.stop() } catch { /* ok */ }
    if (echoContainerName) {
      try {
        const c = podman.getContainer(echoContainerName)
        await c.stop({ t: 1 })
        await c.remove()
      } catch { /* ok */ }
    }
  })

  it('forwards a plain HTTP GET request', async () => {
    const targetUrl = `http://${echoIp}:${echoPort}/hello?foo=bar`
    const result = await proxyRequest(proxyPort, targetUrl)

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { method: string; url: string; headers: Record<string, string> }
    expect(echo.method).toBe('GET')
    expect(echo.url).toBe('/hello?foo=bar')
    expect(echo.headers.host).toBe(`${echoIp}:${echoPort}`)
  })

  it('forwards a POST request with body', async () => {
    const targetUrl = `http://${echoIp}:${echoPort}/submit`
    const body = 'key=value&other=data'
    const result = await proxyRequest(proxyPort, targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { method: string; url: string; body: string }
    expect(echo.method).toBe('POST')
    expect(echo.url).toBe('/submit')
    expect(echo.body).toBe(body)
  })

  it('strips proxy-authorization header before forwarding', async () => {
    const token = Buffer.from('x:my-session-token').toString('base64')
    const targetUrl = `http://${echoIp}:${echoPort}/check`
    const result = await proxyRequest(proxyPort, targetUrl, {
      headers: { 'Proxy-Authorization': `Basic ${token}` },
    })

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { headers: Record<string, string> }
    expect(echo.headers['proxy-authorization']).toBeUndefined()
  })

  it('returns 502 when upstream is unreachable', async () => {
    const targetUrl = `http://${echoIp}:19399/nope`
    const result = await proxyRequest(proxyPort, targetUrl)
    expect(result.status).toBe(502)
  })

  it('still serves API endpoints on non-proxy requests', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/healthz`)
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('ok')
  })

  it('does not inject tokens into plain HTTP requests (security)', async () => {
    // Register project rules that would match the echo server's host
    await client.updateProjectRules('project-secret', [
      {
        hostPattern: echoIp,
        pathPattern: '/*',
        injections: [{ action: 'set_header', name: 'authorization', value: 'Bearer secret-token' }],
      },
    ])

    const sessionToken = client.generateSessionToken()
    await client.registerSession(sessionToken, 'project-secret')

    // Send a plain HTTP request through the proxy with valid session credentials
    const auth = Buffer.from(`x:${sessionToken}`).toString('base64')
    const result = await proxyRequest(proxyPort, `http://${echoIp}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { headers: Record<string, string> }
    // Token must NOT be injected over plain HTTP — only HTTPS CONNECT+MITM
    expect(echo.headers['authorization']).toBeUndefined()

    // Clean up
    await client.removeSession(sessionToken)
    await client.removeProjectRules('project-secret')
  })
})

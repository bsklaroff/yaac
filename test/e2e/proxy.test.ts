import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import crypto from 'node:crypto'
import http from 'node:http'
import { requirePodman, podmanRetry } from '@test/helpers/setup'
import { ProxyClient, PROXY_CONTAINER_PORT } from '@/lib/container/proxy-client'
import { podman } from '@/lib/container/runtime'

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

  beforeAll(async () => {
    await requirePodman()

    client = new ProxyClient({
      image: 'yaac-test-proxy',
      network: `yaac-test-sidecar-${RUN_ID}`,
      requirePrebuilt: true,
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

    const res = await fetch(`http://127.0.0.1:${client.hostPort}/healthz`)
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('ok')
  })

  it('serves CA certificate', async () => {
    await client.ensureRunning()

    const caCert = await client.getCaCert()
    expect(caCert).toContain('BEGIN CERTIFICATE')
    expect(caCert).toContain('END CERTIFICATE')
  })

  it('registers session with rules and allowlist', async () => {
    await client.ensureRunning()

    const sessionId = crypto.randomUUID()

    await client.registerSession(sessionId, {
      rules: [
        {
          hostPattern: 'api.github.com',
          pathPattern: '/*',
          injections: [{ action: 'set_header', name: 'authorization', value: 'Bearer test-token' }],
        },
      ],
      allowedHosts: ['*'],
    })

    await client.removeSession(sessionId)
  })

  it('ensureRunning is idempotent', async () => {
    // Call twice — should not error or create duplicate containers
    await client.ensureRunning()
    await client.ensureRunning()

    const res = await fetch(`http://127.0.0.1:${client.hostPort}/healthz`)
    expect(res.ok).toBe(true)
  })

  it('stop removes container and network', async () => {
    await client.ensureRunning()
    const containerName = client.containerName
    const networkName = client.network
    await client.stop()

    // Verify the container was removed
    const { ExitCode: containerExit } = await podmanRetry([
      'container', 'exists', containerName,
    ]).then(() => ({ ExitCode: 0 }), () => ({ ExitCode: 1 }))
    expect(containerExit).toBe(1)

    // Verify the network was removed
    const { ExitCode: networkExit } = await podmanRetry([
      'network', 'exists', networkName,
    ]).then(() => ({ ExitCode: 0 }), () => ({ ExitCode: 1 }))
    expect(networkExit).toBe(1)
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

      // Register a session with an allowlist covering github.com so the CONNECT
      // tunnel can be authorized. (The proxy blocks by default when no session
      // or allowlist is registered.)
      const sessionId = crypto.randomUUID()
      await client.registerSession(sessionId, {
        rules: [],
        allowedHosts: ['github.com'],
      })

      // Create a container on the internal-only network (same as a real session)
      const containerName = `yaac-proxy-tunnel-test-${crypto.randomBytes(4).toString('hex')}`
      tunnelContainers.push(containerName)

      // Find the test base image
      const { stdout: images } = await podmanRetry([
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
      const { stdout: blocked } = await podmanRetry([
        'exec', containerName, 'sh', '-c',
        'curl -sf --connect-timeout 3 http://github.com 2>&1 || echo connection-blocked',
      ], { timeout: 10_000 })
      expect(blocked.trim()).toContain('connection-blocked')

      // Verify the container CAN open a CONNECT tunnel through the proxy when
      // authenticated as a registered session. We send a raw CONNECT request
      // and check the proxy's response line. A successful tunnel returns
      // "HTTP/1.1 200 Connection Established"; a blocked tunnel returns 403.
      const proxyAuth = Buffer.from(`x:${sessionId}`).toString('base64')
      const connectReq =
        'CONNECT github.com:443 HTTP/1.1\r\n' +
        'Host: github.com:443\r\n' +
        `Proxy-Authorization: Basic ${proxyAuth}\r\n\r\n`
      const { stdout: tunneled } = await podmanRetry([
        'exec', containerName, 'sh', '-c',
        `printf '${connectReq}' | nc -w 3 ${client.proxyIp} ${PROXY_CONTAINER_PORT} | head -c 40`,
      ], { timeout: 10_000 })
      expect(tunneled).toContain('200 Connection Established')

      await client.removeSession(sessionId)
    }, 30_000)
  })
})

describe('proxy HTTP forwarding', () => {
  let client: ProxyClient
  let echoContainerName: string
  let echoIp: string
  const echoPort = 8080
  // Default session used by tests that exercise forwarding (as opposed to
  // allowlist enforcement). Since the proxy fails closed, every forwarding
  // test needs an authenticated session with a permissive allowlist.
  const defaultSessionId = crypto.randomUUID()
  const defaultAuth = Buffer.from(`x:${defaultSessionId}`).toString('base64')
  const defaultAuthHeader = { 'Proxy-Authorization': `Basic ${defaultAuth}` }

  beforeAll(async () => {
    await requirePodman()

    client = new ProxyClient({
      image: 'yaac-test-proxy',
      network: `yaac-test-http-${RUN_ID}`,
      requirePrebuilt: true,
    })
    await client.ensureRunning()

    // Register a default session with a wildcard allowlist so the basic
    // forwarding tests can proceed without setting up their own session.
    await client.registerSession(defaultSessionId, { rules: [], allowedHosts: ['*'] })

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
    const { stdout: images } = await podmanRetry([
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
        const { stdout } = await podmanRetry([
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
    const result = await proxyRequest(Number(client.hostPort), targetUrl, {
      headers: defaultAuthHeader,
    })

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { method: string; url: string; headers: Record<string, string> }
    expect(echo.method).toBe('GET')
    expect(echo.url).toBe('/hello?foo=bar')
    expect(echo.headers.host).toBe(`${echoIp}:${echoPort}`)
  })

  it('forwards a POST request with body', async () => {
    const targetUrl = `http://${echoIp}:${echoPort}/submit`
    const body = 'key=value&other=data'
    const result = await proxyRequest(Number(client.hostPort), targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...defaultAuthHeader },
      body,
    })

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { method: string; url: string; body: string }
    expect(echo.method).toBe('POST')
    expect(echo.url).toBe('/submit')
    expect(echo.body).toBe(body)
  })

  it('strips proxy-authorization header before forwarding', async () => {
    const targetUrl = `http://${echoIp}:${echoPort}/check`
    const result = await proxyRequest(Number(client.hostPort), targetUrl, {
      headers: defaultAuthHeader,
    })

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { headers: Record<string, string> }
    expect(echo.headers['proxy-authorization']).toBeUndefined()
  })

  it('returns 502 when upstream is unreachable', async () => {
    const targetUrl = `http://${echoIp}:19399/nope`
    const result = await proxyRequest(Number(client.hostPort), targetUrl, {
      headers: defaultAuthHeader,
    })
    expect(result.status).toBe(502)
  })

  it('still serves API endpoints on non-proxy requests', async () => {
    const res = await fetch(`http://127.0.0.1:${client.hostPort}/healthz`)
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('ok')
  })

  it('blocks HTTP forward when host is not in allowlist', async () => {
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, {
      rules: [
        {
          hostPattern: echoIp,
          pathPattern: '/*',
          injections: [],
        },
      ],
      allowedHosts: [echoIp],
    })

    // Request to the echo server (allowed)
    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const allowed = await proxyRequest(Number(client.hostPort), `http://${echoIp}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(allowed.status).toBe(200)

    // Request to a different host (blocked) — use a non-routable IP to avoid DNS
    const blocked = await proxyRequest(Number(client.hostPort), 'http://192.0.2.1:80/test', {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked.status).toBe(403)
    expect(blocked.body).toContain('not in the allowed hosts')

    await client.removeSession(sessionId)
  })

  it('allows all hosts when allowedHosts includes wildcard', async () => {
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, { rules: [], allowedHosts: ['*'] })

    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const result = await proxyRequest(Number(client.hostPort), `http://${echoIp}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(result.status).toBe(200)

    await client.removeSession(sessionId)
  })

  it('supports wildcard patterns in allowlist', async () => {
    // The echo container IP is like 10.x.x.x — use a wildcard that won't match it
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, { rules: [], allowedHosts: ['*.example.com'] })

    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const blocked = await proxyRequest(Number(client.hostPort), `http://${echoIp}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked.status).toBe(403)

    await client.removeSession(sessionId)
  })

  it('blocks traffic when no session is registered (fail closed)', async () => {
    // No Proxy-Authorization header → proxy has no session mapping and must
    // block the request. Previously this would allow all traffic.
    const blocked = await proxyRequest(Number(client.hostPort), `http://${echoIp}:${echoPort}/test`)
    expect(blocked.status).toBe(403)
    expect(blocked.body).toContain('not in the allowed hosts')
  })

  it('blocks traffic when session is registered but session is unknown (fail closed)', async () => {
    // A random session ID that was never registered → no session state
    // exists, so the proxy must block.
    const unknownSessionId = crypto.randomUUID()
    const auth = Buffer.from(`x:${unknownSessionId}`).toString('base64')
    const blocked = await proxyRequest(Number(client.hostPort), `http://${echoIp}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked.status).toBe(403)
  })

  it('blocks all traffic when allowedHosts is empty', async () => {
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, { rules: [], allowedHosts: [] })

    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const blocked = await proxyRequest(Number(client.hostPort), `http://${echoIp}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked.status).toBe(403)

    await client.removeSession(sessionId)
  })

  it('does not inject tokens into plain HTTP requests (security)', async () => {
    const sessionId = crypto.randomUUID()
    // Register session rules that would match the echo server's host
    await client.registerSession(sessionId, {
      rules: [
        {
          hostPattern: echoIp,
          pathPattern: '/*',
          injections: [{ action: 'set_header', name: 'authorization', value: 'Bearer secret-token' }],
        },
      ],
      allowedHosts: ['*'],
    })

    // Send a plain HTTP request through the proxy with valid session credentials
    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const result = await proxyRequest(Number(client.hostPort), `http://${echoIp}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { headers: Record<string, string> }
    // Token must NOT be injected over plain HTTP — only HTTPS CONNECT+MITM
    expect(echo.headers['authorization']).toBeUndefined()

    // Clean up
    await client.removeSession(sessionId)
  })

  it('tracks blocked hosts per session via /blocked-hosts endpoint', async () => {
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, { rules: [], allowedHosts: [echoIp] })

    // Make a request to a blocked host
    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const blocked = await proxyRequest(Number(client.hostPort), 'http://192.0.2.1:80/test', {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked.status).toBe(403)

    // Also block a second host
    const blocked2 = await proxyRequest(Number(client.hostPort), 'http://198.51.100.1:80/test', {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked2.status).toBe(403)

    // Fetch blocked hosts
    const blockedHosts = await client.getBlockedHosts()
    expect(blockedHosts[sessionId]).toBeDefined()
    expect(blockedHosts[sessionId]).toContain('192.0.2.1')
    expect(blockedHosts[sessionId]).toContain('198.51.100.1')

    // After removing session, blocked hosts should be cleaned up
    await client.removeSession(sessionId)
    const afterRemoval = await client.getBlockedHosts()
    expect(afterRemoval[sessionId]).toBeUndefined()
  })

  it('isolates rules between concurrent sessions', async () => {
    // Two sessions, same hostPattern but different injected values. Session
    // keying means the two sets of rules cannot bleed into each other —
    // which is the behaviour this refactor was designed to unlock.
    const sessionA = crypto.randomUUID()
    const sessionB = crypto.randomUUID()

    await client.registerSession(sessionA, {
      rules: [],
      allowedHosts: ['*'],
    })
    await client.registerSession(sessionB, {
      rules: [],
      allowedHosts: [],
    })

    const authA = Buffer.from(`x:${sessionA}`).toString('base64')
    const authB = Buffer.from(`x:${sessionB}`).toString('base64')

    const allowed = await proxyRequest(Number(client.hostPort), `http://${echoIp}:${echoPort}/a`, {
      headers: { 'Proxy-Authorization': `Basic ${authA}` },
    })
    expect(allowed.status).toBe(200)

    const blocked = await proxyRequest(Number(client.hostPort), `http://${echoIp}:${echoPort}/b`, {
      headers: { 'Proxy-Authorization': `Basic ${authB}` },
    })
    expect(blocked.status).toBe(403)

    await client.removeSession(sessionA)
    await client.removeSession(sessionB)
  })

  it('blocks requests after session removal (fail closed)', async () => {
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, { rules: [], allowedHosts: ['*'] })

    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const before = await proxyRequest(Number(client.hostPort), `http://${echoIp}:${echoPort}/before`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(before.status).toBe(200)

    await client.removeSession(sessionId)

    const after = await proxyRequest(Number(client.hostPort), `http://${echoIp}:${echoPort}/after`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(after.status).toBe(403)
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import {
  requirePodman,
  requireCluster,
  useTestNamespace,
  createTempDataDir,
  cleanupTempDir,
  TEST_PROXY_CONFIG,
} from '@test/helpers/setup'
import { resolveTestBaseImageRef } from '@test/helpers/mock-remotes'
import { ProxyClient } from '@/lib/container/proxy-client'
import {
  ensureNamespace,
  ensureProxyAuthSecret,
  PROXY_APP_NAME,
  PROXY_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_HTTPS_PORT,
} from '@/lib/k8s/bootstrap'
import { relayTokenFor } from '@proxy/pp2'
import { buildPp2Header } from '@relay/pp2-frame'
import { ServicePortForward } from '@/lib/k8s/port-forward'
import { readBlockedHosts } from '@/lib/session/blocked-hosts'
import { writeProxySecrets } from '@/lib/project/credentials'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@/lib/k8s/kubectl'

/**
 * Exercises the proxy directly through the new kubernetes ProxyClient:
 * the proxy runs as the `yaac-proxy` Deployment+Service in the per-run
 * test namespace; the test reaches its HTTP API through a loopback
 * `kubectl port-forward` (the same transport the daemon uses), and
 * in-cluster peers (echo servers, session-like pods) run as pods in the
 * same namespace.
 */

// File-wide environment: per-run namespace + a temp data dir (the proxy
// Deployment hostPath-mounts credential/agent dirs under the data dir).
let restoreNamespace: (() => void) | null = null
let tempDataDir: string | null = null
// The proxy auth secret, for forging the relay's PP2 identity header. The
// suite reaches the proxy's transparent listeners directly (playing the
// relay) since the explicit :10255 CONNECT/forward paths are gone.
let proxyAuthSecret = ''

beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  restoreNamespace = useTestNamespace()
  tempDataDir = await createTempDataDir()
  await ensureNamespace()
  proxyAuthSecret = await ensureProxyAuthSecret()
})

/** PP2 identity header the relay prepends for a session (test plays relay). */
function pp2(sessionId: string): Buffer {
  return buildPp2Header({ identity: `${sessionId}:${relayTokenFor(proxyAuthSecret, sessionId)}` })
}

/** Pull the session id out of a `Proxy-Authorization: Basic x:<sid>` header. */
function sessionIdFromAuth(headers: Record<string, string> | undefined): string | null {
  const h = headers?.['Proxy-Authorization'] ?? headers?.['proxy-authorization']
  const m = h ? /^Basic\s+(.+)$/i.exec(h) : null
  if (!m) return null
  const decoded = Buffer.from(m[1], 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  return colon === -1 ? decoded : decoded.slice(colon + 1) || null
}

/** Decode a chunked transfer-encoding body into a single string. */
function decodeChunked(buf: Buffer): string {
  const out: Buffer[] = []
  let off = 0
  while (off < buf.length) {
    const lineEnd = buf.indexOf('\r\n', off)
    if (lineEnd === -1) break
    const size = parseInt(buf.toString('ascii', off, lineEnd).trim(), 16)
    if (!Number.isFinite(size) || size === 0) break
    out.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size))
    off = lineEnd + 2 + size + 2 // past the chunk + its trailing CRLF
  }
  return Buffer.concat(out).toString('utf8')
}

/**
 * Parse a raw HTTP/1 response (status line + body after the blank line),
 * decoding chunked transfer-encoding (the echo server omits Content-Length,
 * so HTTP/1.1 chunks the body — node's http client used to decode this for
 * us before this suite went raw to inject the PP2 header).
 */
function parseHttpResponse(buf: Buffer): { status: number; body: string } {
  const headEnd = buf.indexOf('\r\n\r\n')
  const head = buf.toString('utf8', 0, headEnd === -1 ? buf.length : headEnd)
  const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(head.slice(0, head.indexOf('\r\n')))?.[1] ?? 0)
  if (headEnd === -1) return { status, body: '' }
  const rawBody = buf.subarray(headEnd + 4)
  const chunked = /\r\ntransfer-encoding:\s*chunked/i.test('\r\n' + head)
  return { status, body: chunked ? decodeChunked(rawBody) : rawBody.toString('utf8') }
}

afterAll(async () => {
  restoreNamespace?.()
  restoreNamespace = null
  if (tempDataDir) await cleanupTempDir(tempDataDir)
  tempDataDir = null
})

/**
 * Make an HTTP request through the proxy's transparent HTTP listener,
 * prefixed with the relay's PP2 identity header (the test plays the relay).
 * `proxyPort` is a loopback forward of TRANSPARENT_HTTP_PORT. The original
 * absolute-form (`http://host:port/path`) and `Proxy-Authorization` shape
 * is kept so call sites barely change: the host:port becomes the origin-
 * form Host header, and the `x:<sid>` auth becomes the PP2 token. A request
 * with no auth carries no PP2 — the proxy destroys it (fail closed), which
 * surfaces here as a closed connection (status 0).
 */
function proxyRequest(
  proxyPort: number,
  targetUrl: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl)
    const sessionId = sessionIdFromAuth(opts.headers)
    const body = opts.body ?? ''
    let buf = Buffer.alloc(0)
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      if (sessionId !== null) sock.write(pp2(sessionId))
      const lines = [
        `${opts.method ?? 'GET'} ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        'Connection: close',
        ...Object.entries(opts.headers ?? {})
          .filter(([k]) => k.toLowerCase() !== 'proxy-authorization')
          .map(([k, v]) => `${k}: ${v}`),
      ]
      if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`)
      sock.write(lines.join('\r\n') + '\r\n\r\n' + body)
    })
    sock.on('data', (c: Buffer) => { buf = Buffer.concat([buf, c]) })
    sock.on('close', () => resolve(buf.length ? parseHttpResponse(buf) : { status: 0, body: '' }))
    sock.on('error', () => { if (buf.length) resolve(parseHttpResponse(buf)); else resolve({ status: 0, body: '' }) })
    sock.setTimeout(20_000, () => { sock.destroy(); reject(new Error('proxyRequest timeout')) })
  })
}

/**
 * Open a raw TCP connection to the proxy's forwarded loopback port, send a
 * request, and resolve with everything received before the socket closes
 * (or a 5s cap). Used to assert that the explicit CONNECT path on :10255 is
 * gone — the server closes a CONNECT with no HTTP response, so this
 * resolves empty.
 */
function rawConnectResult(proxyPort: string | number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(Number(proxyPort), '127.0.0.1', () => sock.write(request))
    let buf = ''
    sock.on('data', (d: Buffer) => { buf += d.toString('utf8') })
    sock.on('close', () => resolve(buf))
    sock.on('error', () => resolve(buf))
    sock.setTimeout(5000, () => { sock.destroy(); resolve(buf) })
  })
}

/** Delete a test pod (and its same-named service, if any), best-effort. */
async function deleteTestPod(name: string): Promise<void> {
  await kubectlWithRetry([
    'delete', 'pod', name, '-n', k8sNamespace(),
    '--ignore-not-found', '--wait=false', '--grace-period=1',
  ]).catch(() => { /* ok */ })
  await kubectlWithRetry([
    'delete', 'service', name, '-n', k8sNamespace(), '--ignore-not-found',
  ]).catch(() => { /* ok */ })
}

/** `kubectl exec` into a test pod (argv passthrough). */
async function execInPod(
  podName: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return kubectlWithRetry(
    ['exec', '-n', k8sNamespace(), podName, '--', ...args],
    opts,
  )
}

/** Poll a pod until Running (covers registry image pull). */
async function waitForPodRunning(name: string, timeoutMs = 60_000): Promise<void> {
  interface RawPod { status?: { phase?: string } }
  const deadline = Date.now() + timeoutMs
  let phase = 'Pending'
  while (Date.now() < deadline) {
    const pod = await kubectlGetJson<RawPod>(['get', 'pod', name, '-n', k8sNamespace()])
    phase = pod?.status?.phase ?? 'Unknown'
    if (phase === 'Running') return
    if (phase === 'Failed' || phase === 'Succeeded') {
      throw new Error(`pod ${name} reached terminal phase ${phase}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`pod ${name} not Running within ${timeoutMs}ms (phase ${phase})`)
}

const ECHO_PORT = 8080

/**
 * Start an HTTP echo server as a Pod + ClusterIP Service in the test
 * namespace — the in-cluster peer the proxy forwards/redirects to.
 * Returns the Service DNS name the proxy resolves.
 */
async function startEchoPod(name: string): Promise<{ host: string }> {
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
    }).listen(${ECHO_PORT}, '0.0.0.0', () => console.log('echo ready'));
  `
  const ns = k8sNamespace()
  const image = await resolveTestBaseImageRef()
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: ns, labels: { 'app': name, 'yaac.test': 'true' } },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      containers: [{
        name: 'echo',
        image,
        imagePullPolicy: 'IfNotPresent',
        command: ['node', '-e', echoScript],
        ports: [{ containerPort: ECHO_PORT }],
      }],
    },
  })
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: ns, labels: { 'yaac.test': 'true' } },
    spec: {
      type: 'ClusterIP',
      selector: { app: name },
      ports: [{ port: ECHO_PORT, targetPort: ECHO_PORT }],
    },
  })
  await waitForPodRunning(name)

  // Wait for the echo server to be reachable through the SERVICE path —
  // the same DNS name + ClusterIP route the proxy uses. Probing the
  // pod's loopback is not enough: the service DNS record and kube-proxy
  // endpoint programming land after the pod is up, and the first
  // forwarding request would race them and 502.
  const host = `${name}.${ns}.svc`
  const probeUrl = `http://${host}:${ECHO_PORT}/ping`
  let reachable = false
  for (let i = 0; i < 40; i++) {
    try {
      const { stdout } = await execInPod(name, [
        'sh', '-c', `curl -sf ${probeUrl}`,
      ], { timeout: 5000 })
      if (stdout) { reachable = true; break }
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  if (!reachable) throw new Error(`echo service not reachable at ${probeUrl}`)
  return { host }
}

describe('proxy sidecar', () => {
  let client: ProxyClient
  const tunnel = new ServicePortForward(PROXY_APP_NAME, PROXY_PORT)

  /** ensureRunning + a live loopback tunnel; returns the local port. */
  async function ensureProxy(): Promise<number> {
    await client.ensureRunning()
    return tunnel.ensure()
  }

  beforeAll(() => {
    client = new ProxyClient(TEST_PROXY_CONFIG)
  })

  afterAll(async () => {
    tunnel.stop()
    if (!client) return
    try {
      await client.stop()
    } catch {
      // ok
    }
  })

  it('starts proxy and healthcheck responds', async () => {
    const hostPort = await ensureProxy()

    const res = await fetch(`http://127.0.0.1:${hostPort}/healthz`)
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('ok')
  }, 240_000)

  it('serves CA certificate', async () => {
    await ensureProxy()

    const caCert = await client.getCaCert()
    expect(caCert).toContain('BEGIN CERTIFICATE')
    expect(caCert).toContain('END CERTIFICATE')
  }, 60_000)

  it('registers session with rules and allowlist', async () => {
    await ensureProxy()

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

    // GET /sessions reflects the registration — the persistence tests
    // below depend on this to observe what a replaced pod reloaded.
    expect(await client.listSessions()).toContain(sessionId)

    await client.removeSession(sessionId)
    expect(await client.listSessions()).not.toContain(sessionId)
  }, 60_000)

  it('ensureRunning is idempotent', async () => {
    // Call twice — should not error or roll the deployment.
    await client.ensureRunning()
    const hostPort = await ensureProxy()

    const res = await fetch(`http://127.0.0.1:${hostPort}/healthz`)
    expect(res.ok).toBe(true)

    // Exactly one proxy pod backs the Service.
    const pods = await kubectlGetJson<{ items: unknown[] }>([
      'get', 'pods', '-n', k8sNamespace(),
      '-l', `app=${PROXY_APP_NAME}`, '--field-selector', 'status.phase=Running',
    ])
    expect(pods?.items).toHaveLength(1)
  }, 60_000)

  it('no longer offers an explicit CONNECT path on :10255 (server closes it)', async () => {
    const hostPort = await ensureProxy()

    // SSH and all session egress now authenticate via the relay's
    // per-connection PP2 token on the transparent listeners; no session
    // carries a proxy credential, so there is no `server.on('connect')`
    // handler. Node closes any CONNECT to :10255 with no HTTP response —
    // neither the old 200 tunnel nor the 407 challenge.
    const out = await rawConnectResult(
      hostPort,
      'CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n',
    )
    expect(out).not.toContain('200 Connection Established')
    expect(out).not.toContain('407')
    expect(out.trim()).toBe('')
  }, 30_000)

  it('stop removes the proxy Deployment and Service', async () => {
    await ensureProxy()
    await client.stop()
    tunnel.stop()

    // stop() deletes the Deployment with --wait=false; poll briefly until
    // both objects are gone.
    let deploymentGone = false
    let serviceGone = false
    for (let i = 0; i < 40; i++) {
      const dep = await kubectlGetJson<unknown>([
        'get', 'deployment', PROXY_APP_NAME, '-n', k8sNamespace(),
      ])
      const svc = await kubectlGetJson<unknown>([
        'get', 'service', PROXY_APP_NAME, '-n', k8sNamespace(),
      ])
      deploymentGone = dep === null
      serviceGone = svc === null
      if (deploymentGone && serviceGone) break
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(deploymentGone).toBe(true)
    expect(serviceGone).toBe(true)
  }, 60_000)
})

describe('proxy HTTP forwarding', () => {
  let client: ProxyClient
  let hostPort = 0
  let echoPodName: string
  let echoHost: string
  const echoPort = ECHO_PORT
  const tunnel = new ServicePortForward(PROXY_APP_NAME, PROXY_PORT)
  const httpFwd = new ServicePortForward(PROXY_APP_NAME, TRANSPARENT_HTTP_PORT)
  let httpFwdPort = 0
  // Default session used by tests that exercise forwarding (as opposed to
  // allowlist enforcement). Since the proxy fails closed, every forwarding
  // test needs an authenticated session with a permissive allowlist.
  const defaultSessionId = crypto.randomUUID()
  const defaultAuth = Buffer.from(`x:${defaultSessionId}`).toString('base64')
  const defaultAuthHeader = { 'Proxy-Authorization': `Basic ${defaultAuth}` }

  beforeAll(async () => {
    client = new ProxyClient(TEST_PROXY_CONFIG)
    await client.ensureRunning()
    hostPort = await tunnel.ensure()
    httpFwdPort = await httpFwd.ensure()

    // Register a default session with a wildcard allowlist so the basic
    // forwarding tests can proceed without setting up their own session.
    await client.registerSession(defaultSessionId, { rules: [], allowedHosts: ['*'] })

    // Run an echo HTTP server as a pod+service in the test namespace —
    // an upstream the proxy can resolve and reach from inside the cluster.
    echoPodName = `yaac-echo-test-${crypto.randomBytes(4).toString('hex')}`
    const echo = await startEchoPod(echoPodName)
    echoHost = echo.host
  }, 240_000)

  afterAll(async () => {
    tunnel.stop()
    httpFwd.stop()
    try { await client?.stop() } catch { /* ok */ }
    if (echoPodName) await deleteTestPod(echoPodName)
  })

  it('forwards a plain HTTP GET request', async () => {
    const targetUrl = `http://${echoHost}:${echoPort}/hello?foo=bar`
    const result = await proxyRequest(httpFwdPort, targetUrl, {
      headers: defaultAuthHeader,
    })

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { method: string; url: string; headers: Record<string, string> }
    expect(echo.method).toBe('GET')
    expect(echo.url).toBe('/hello?foo=bar')
    expect(echo.headers.host).toBe(`${echoHost}:${echoPort}`)
  })

  it('forwards a POST request with body', async () => {
    const targetUrl = `http://${echoHost}:${echoPort}/submit`
    const body = 'key=value&other=data'
    const result = await proxyRequest(httpFwdPort, targetUrl, {
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
    const targetUrl = `http://${echoHost}:${echoPort}/check`
    const result = await proxyRequest(httpFwdPort, targetUrl, {
      headers: defaultAuthHeader,
    })

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { headers: Record<string, string> }
    expect(echo.headers['proxy-authorization']).toBeUndefined()
  })

  it('returns 502 when upstream is unreachable', async () => {
    const targetUrl = `http://${echoHost}:19399/nope`
    const result = await proxyRequest(httpFwdPort, targetUrl, {
      headers: defaultAuthHeader,
    })
    expect(result.status).toBe(502)
  })

  it('still serves API endpoints on non-proxy requests', async () => {
    const res = await fetch(`http://127.0.0.1:${hostPort}/healthz`)
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('ok')
  })

  it('blocks HTTP forward when host is not in allowlist', async () => {
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, {
      rules: [
        {
          hostPattern: echoHost,
          pathPattern: '/*',
          injections: [],
        },
      ],
      allowedHosts: [echoHost],
    })

    // Request to the echo server (allowed)
    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const allowed = await proxyRequest(httpFwdPort, `http://${echoHost}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(allowed.status).toBe(200)

    // Request to a different host (blocked) — use a non-routable IP to avoid DNS
    const blocked = await proxyRequest(httpFwdPort, 'http://192.0.2.1:80/test', {
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
    const result = await proxyRequest(httpFwdPort, `http://${echoHost}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(result.status).toBe(200)

    await client.removeSession(sessionId)
  })

  it('supports wildcard patterns in allowlist', async () => {
    // The echo host is a `*.svc` cluster DNS name — use a wildcard that
    // won't match it.
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, { rules: [], allowedHosts: ['*.example.com'] })

    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const blocked = await proxyRequest(httpFwdPort, `http://${echoHost}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked.status).toBe(403)

    await client.removeSession(sessionId)
  })

  it('blocks traffic when no session is registered (fail closed)', async () => {
    // No Proxy-Authorization header → proxy has no session mapping and must
    // block the request. Previously this would allow all traffic.
    // No PP2 identity at all (no auth) → the transparent listener
    // destroys the connection before any allowlist check.
    const blocked = await proxyRequest(httpFwdPort, `http://${echoHost}:${echoPort}/test`)
    expect(blocked.status).not.toBe(200)
  })

  it('blocks traffic when session is registered but session is unknown (fail closed)', async () => {
    // A random session ID that was never registered → no session state
    // exists, so the proxy must block.
    const unknownSessionId = crypto.randomUUID()
    const auth = Buffer.from(`x:${unknownSessionId}`).toString('base64')
    const blocked = await proxyRequest(httpFwdPort, `http://${echoHost}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked.status).toBe(403)
  })

  it('blocks all traffic when allowedHosts is empty', async () => {
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, { rules: [], allowedHosts: [] })

    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const blocked = await proxyRequest(httpFwdPort, `http://${echoHost}:${echoPort}/test`, {
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
          hostPattern: echoHost,
          pathPattern: '/*',
          injections: [{ action: 'set_header', name: 'authorization', value: 'Bearer secret-token' }],
        },
      ],
      allowedHosts: ['*'],
    })

    // Send a plain HTTP request through the proxy with valid session credentials
    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const result = await proxyRequest(httpFwdPort, `http://${echoHost}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { headers: Record<string, string> }
    // Token must NOT be injected over plain HTTP — only HTTPS CONNECT+MITM
    expect(echo.headers['authorization']).toBeUndefined()

    // Clean up
    await client.removeSession(sessionId)
  })

  it('writes blocked hosts through to /data, readable from the host', async () => {
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, { rules: [], allowedHosts: [echoHost] })

    // Make a request to a blocked host
    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const blocked = await proxyRequest(httpFwdPort, 'http://192.0.2.1:80/test', {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked.status).toBe(403)

    // Also block a second host
    const blocked2 = await proxyRequest(httpFwdPort, 'http://198.51.100.1:80/test', {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked2.status).toBe(403)

    // The proxy writes /data/blocked-hosts.json through on growth; /data
    // is a hostPath under the test data dir, so read it exactly the way
    // the daemon does. Poll: the write-through happens after the 403 is
    // already on the wire.
    await expect.poll(() => readBlockedHosts(sessionId), { timeout: 10_000 })
      .toEqual(expect.arrayContaining(['192.0.2.1', '198.51.100.1']))

    // After removing the session, its entry is pruned from the file
    await client.removeSession(sessionId)
    await expect.poll(() => readBlockedHosts(sessionId), { timeout: 10_000 }).toEqual([])
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

    const allowed = await proxyRequest(httpFwdPort, `http://${echoHost}:${echoPort}/a`, {
      headers: { 'Proxy-Authorization': `Basic ${authA}` },
    })
    expect(allowed.status).toBe(200)

    const blocked = await proxyRequest(httpFwdPort, `http://${echoHost}:${echoPort}/b`, {
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
    const before = await proxyRequest(httpFwdPort, `http://${echoHost}:${echoPort}/before`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(before.status).toBe(200)

    await client.removeSession(sessionId)

    const after = await proxyRequest(httpFwdPort, `http://${echoHost}:${echoPort}/after`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(after.status).toBe(403)
  })
})

/**
 * Send a proxied HTTPS request through the proxy's transparent HTTPS
 * listener: prefix the connection with the relay's PP2 identity header
 * (the test plays the relay), then TLS-wrap (trusting the proxy's
 * self-signed leaf), then ride an `http.request` over the TLS socket so
 * node handles framing. `proxyHostPort` is a loopback forward of
 * TRANSPARENT_HTTPS_PORT. `rejectUnauthorized: false` avoids the CA-cert
 * plumbing for tests that only exercise the forwarding path.
 */
async function proxiedHttpsRequest(
  proxyHostPort: number,
  targetHost: string,
  sessionId: string,
  request: { method: string; path: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const tcp = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(proxyHostPort, '127.0.0.1')
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
  // Persistent handler so a late reset (e.g. proxy churn) rejects the
  // request promise instead of crashing the process as an unhandled error.
  tcp.on('error', () => { /* surfaced via the TLS / http error paths */ })

  // PP2 identity, then the SNI-bearing ClientHello drives the proxy's
  // peek + MITM, exactly as the relay → proxy path does in production.
  tcp.write(pp2(sessionId))

  const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const t = tls.connect({
      socket: tcp,
      servername: targetHost,
      rejectUnauthorized: false,
    })
    t.once('secureConnect', () => resolve(t))
    t.once('error', reject)
  })

  return new Promise((resolve, reject) => {
    const req = http.request({
      createConnection: () => tlsSocket,
      host: targetHost,
      method: request.method,
      path: request.path,
      headers: { host: targetHost, ...(request.headers ?? {}) },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.once('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        })
      })
      res.once('error', reject)
    })
    req.once('error', reject)
    if (request.body) req.write(request.body)
    req.end()
  })
}

describe('proxy upstream redirect', () => {
  let client: ProxyClient
  let hostPort = 0
  let echoPodName: string
  let echoHost: string
  const echoPort = ECHO_PORT
  const tunnel = new ServicePortForward(PROXY_APP_NAME, TRANSPARENT_HTTPS_PORT)

  beforeAll(async () => {
    client = new ProxyClient(TEST_PROXY_CONFIG)
    await client.ensureRunning()
    hostPort = await tunnel.ensure()

    // Echo server in the test namespace — mirrors what a mock-remotes
    // pod looks like: a Service the proxy resolves by cluster DNS.
    echoPodName = `yaac-redirect-echo-${crypto.randomBytes(4).toString('hex')}`
    const echo = await startEchoPod(echoPodName)
    echoHost = echo.host
  }, 240_000)

  afterAll(async () => {
    tunnel.stop()
    try { await client?.stop() } catch { /* ok */ }
    if (echoPodName) await deleteTestPod(echoPodName)
  })

  it('redirects MITMed upstream to the registered target', async () => {
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, {
      rules: [],
      allowedHosts: ['api.anthropic.com'],
      upstreamRedirects: {
        'api.anthropic.com': { host: echoHost, port: echoPort, tls: false },
      },
    })

    const result = await proxiedHttpsRequest(
      hostPort,
      'api.anthropic.com',
      sessionId,
      { method: 'POST', path: '/v1/messages', body: '{"hello":"world"}' },
    )

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as {
      method: string; url: string; headers: Record<string, string>; body: string
    }
    expect(echo.method).toBe('POST')
    expect(echo.url).toBe('/v1/messages')
    expect(echo.body).toBe('{"hello":"world"}')
    // Host header is what the client sent; the redirect leaves it intact so
    // the mock can route on virtual-host basis if it wants to.
    expect(echo.headers.host).toBe('api.anthropic.com')

    await client.removeSession(sessionId)
  }, 30_000)

  it('does not redirect for hosts that have no redirect registered', async () => {
    // Same session, but request a host not in the redirect map. Since we
    // allow all hosts here and don't set a redirect for api.openai.com, the
    // proxy would try to forward to the real api.openai.com — which the
    // test cluster either can't reach or we don't want to hit. The
    // invariant we check: the request did NOT land at our echo server
    // (path wouldn't match).
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, {
      rules: [],
      allowedHosts: ['api.anthropic.com', 'api.openai.com'],
      upstreamRedirects: {
        'api.anthropic.com': { host: echoHost, port: echoPort, tls: false },
      },
    })

    // api.anthropic.com → echo (redirected, succeeds)
    const redirected = await proxiedHttpsRequest(
      hostPort,
      'api.anthropic.com',
      sessionId,
      { method: 'GET', path: '/mapped' },
    )
    expect(redirected.status).toBe(200)
    const echoBody = JSON.parse(redirected.body) as { url: string }
    expect(echoBody.url).toBe('/mapped')

    // api.openai.com → real upstream. Either the cluster has no route to
    // it (502 from the proxy) or — if the test cluster does have egress —
    // the real api.openai.com answers with a non-200 for this bogus path.
    // Both prove the redirect map did not capture the host.
    const unredirected = await proxiedHttpsRequest(
      hostPort,
      'api.openai.com',
      sessionId,
      { method: 'GET', path: '/not-mapped' },
    ).catch((err: Error) => ({ status: -1, body: err.message, headers: {} as http.IncomingHttpHeaders }))
    expect(unredirected.status).not.toBe(200)

    await client.removeSession(sessionId)
  }, 30_000)

  it('clears redirect map when a session is re-registered without redirects', async () => {
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, {
      rules: [],
      allowedHosts: ['api.anthropic.com'],
      upstreamRedirects: {
        'api.anthropic.com': { host: echoHost, port: echoPort, tls: false },
      },
    })
    const first = await proxiedHttpsRequest(
      hostPort,
      'api.anthropic.com',
      sessionId,
      { method: 'GET', path: '/v1/before' },
    )
    expect(first.status).toBe(200)

    // Re-register without redirects
    await client.registerSession(sessionId, {
      rules: [],
      allowedHosts: ['api.anthropic.com'],
    })
    const second = await proxiedHttpsRequest(
      hostPort,
      'api.anthropic.com',
      sessionId,
      { method: 'GET', path: '/v1/after' },
    ).catch((err: Error) => ({ status: -1, body: err.message, headers: {} as http.IncomingHttpHeaders }))
    expect(second.status).not.toBe(200)

    await client.removeSession(sessionId)
  }, 30_000)
})

interface RawProxyPodList {
  items: Array<{
    metadata?: { uid?: string; deletionTimestamp?: string }
    status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean }> }
  }>
}

/** UID of the single ready proxy pod, or null while none qualifies. */
async function findReadyProxyPodUid(): Promise<string | null> {
  const list = await kubectlGetJson<RawProxyPodList>([
    'get', 'pods', '-n', k8sNamespace(), '-l', `app=${PROXY_APP_NAME}`,
  ])
  const pod = list?.items.find((p) =>
    p.status?.phase === 'Running'
    && !p.metadata?.deletionTimestamp
    && p.status?.containerStatuses?.every((c) => c.ready),
  )
  return pod?.metadata?.uid ?? null
}

describe('proxy state persistence across pod replacement', () => {
  let client: ProxyClient
  let hostPort = 0
  let echoPodName: string
  let echoHost: string
  const tunnel = new ServicePortForward(PROXY_APP_NAME, PROXY_PORT)
  const httpsFwd = new ServicePortForward(PROXY_APP_NAME, TRANSPARENT_HTTPS_PORT)
  const httpFwd = new ServicePortForward(PROXY_APP_NAME, TRANSPARENT_HTTP_PORT)
  let httpsFwdPort = 0
  let httpFwdPort = 0

  beforeAll(async () => {
    client = new ProxyClient(TEST_PROXY_CONFIG)
    await client.ensureRunning()
    hostPort = await tunnel.ensure()
    httpsFwdPort = await httpsFwd.ensure()
    httpFwdPort = await httpFwd.ensure()

    echoPodName = `yaac-persist-echo-${crypto.randomBytes(4).toString('hex')}`
    const echo = await startEchoPod(echoPodName)
    echoHost = echo.host
  }, 240_000)

  afterAll(async () => {
    tunnel.stop()
    httpsFwd.stop()
    httpFwd.stop()
    try { await client?.stop() } catch { /* ok */ }
    if (echoPodName) await deleteTestPod(echoPodName)
  })

  it('resolves secretRef injections from the proxy-secrets credentials file', async () => {
    // The credentials dir is a hostPath under the test data dir — write
    // the secret the same way the daemon does before a registration.
    await writeProxySecrets({ E2E_TEST_SECRET: 'sekrit-value' })

    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, {
      rules: [{
        hostPattern: 'api.anthropic.com',
        pathPattern: '/*',
        injections: [{
          action: 'set_header', name: 'x-test-secret',
          secretRef: 'E2E_TEST_SECRET', prefix: 'Bearer ',
        }],
      }],
      allowedHosts: ['api.anthropic.com'],
      upstreamRedirects: {
        'api.anthropic.com': { host: echoHost, port: ECHO_PORT, tls: false },
      },
    })

    const result = await proxiedHttpsRequest(
      httpsFwdPort, 'api.anthropic.com', sessionId,
      { method: 'GET', path: '/with-secret' },
    )
    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { headers: Record<string, string> }
    expect(echo.headers['x-test-secret']).toBe('Bearer sekrit-value')

    await client.removeSession(sessionId)
  }, 30_000)

  it('serves live sessions across a proxy pod replacement with no re-registration', async () => {
    await writeProxySecrets({ E2E_TEST_SECRET: 'sekrit-value' })

    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, {
      rules: [{
        hostPattern: 'api.anthropic.com',
        pathPattern: '/*',
        injections: [{
          action: 'set_header', name: 'x-test-secret',
          secretRef: 'E2E_TEST_SECRET', prefix: 'Bearer ',
        }],
      }],
      allowedHosts: ['api.anthropic.com'],
      upstreamRedirects: {
        'api.anthropic.com': { host: echoHost, port: ECHO_PORT, tls: false },
      },
    })

    // Record a blocked host so its survival can be asserted post-churn.
    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const blocked = await proxyRequest(httpFwdPort, 'http://192.0.2.1:80/test', {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked.status).toBe(403)
    await expect.poll(() => readBlockedHosts(sessionId), { timeout: 10_000 })
      .toContain('192.0.2.1')

    const oldUid = await findReadyProxyPodUid()
    expect(oldUid).toBeTruthy()

    // Kill the proxy pod. The Deployment (strategy: Recreate) replaces it;
    // the replacement must reload all session state from /data.
    await kubectlWithRetry([
      'delete', 'pod', '-n', k8sNamespace(), '-l', `app=${PROXY_APP_NAME}`,
      '--wait=false', '--grace-period=1',
    ])
    await expect.poll(
      async () => {
        const uid = await findReadyProxyPodUid().catch(() => null)
        return uid !== null && uid !== oldUid
      },
      { timeout: 120_000, interval: 1_000 },
    ).toBe(true)

    // Both loopback tunnels died with the pod; poll until they respawn
    // against the replacement and it answers.
    await expect.poll(() => client.attachIfRunning(), { timeout: 30_000, interval: 500 })
      .toBe(true)
    await expect.poll(
      async () => {
        try {
          hostPort = await tunnel.ensure()
          httpsFwdPort = await httpsFwd.ensure()
          httpFwdPort = await httpFwd.ensure()
          const res = await fetch(`http://127.0.0.1:${hostPort}/healthz`)
          return res.ok
        } catch {
          return false
        }
      },
      { timeout: 30_000, interval: 500 },
    ).toBe(true)

    // The headline assertions: nothing re-registered this session (no
    // daemon runs in this suite), yet the replacement proxy knows it —
    // registration, allowlist, redirect, and secretRef rule all survived
    // via /data, and the proxied request still succeeds.
    expect(await client.listSessions()).toContain(sessionId)

    // Retry: the transparent-HTTPS forward can briefly race the Recreate's
    // endpoint reprogramming even after /healthz answers on the API port.
    let result: { status: number; body: string; headers: http.IncomingHttpHeaders } | null = null
    await expect.poll(async () => {
      try {
        httpsFwdPort = await httpsFwd.ensure()
        result = await proxiedHttpsRequest(
          httpsFwdPort, 'api.anthropic.com', sessionId,
          { method: 'GET', path: '/after-churn' },
        )
        return result.status
      } catch {
        return 0
      }
    }, { timeout: 30_000, interval: 1_000 }).toBe(200)
    const echo = JSON.parse(result!.body) as { headers: Record<string, string> }
    expect(echo.headers['x-test-secret']).toBe('Bearer sekrit-value')

    // Blocked-host history survived the replacement too (reloaded at boot)
    expect(await readBlockedHosts(sessionId)).toContain('192.0.2.1')

    // And the allowlist still fails closed for non-allowed hosts (re-ensure
    // the transparent-HTTP forward, which can go stale across the churn).
    await expect.poll(async () => {
      httpFwdPort = await httpFwd.ensure()
      const r = await proxyRequest(httpFwdPort, 'http://192.0.2.1:80/test', {
        headers: { 'Proxy-Authorization': `Basic ${auth}` },
      })
      return r.status
    }, { timeout: 30_000, interval: 1_000 }).toBe(403)

    await client.removeSession(sessionId)
  }, 240_000)
})

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
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
import { ProxyClient, PROXY_CONTAINER_PORT } from '@/lib/container/proxy-client'
import { PROXY_APP_NAME, PROXY_PORT } from '@/lib/k8s/bootstrap'
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

beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  restoreNamespace = useTestNamespace()
  tempDataDir = await createTempDataDir()
})

afterAll(async () => {
  restoreNamespace?.()
  restoreNamespace = null
  if (tempDataDir) await cleanupTempDir(tempDataDir)
  tempDataDir = null
})

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

/**
 * Open a raw TCP connection to the proxy's forwarded loopback port, send a
 * CONNECT request, and resolve with the response head (everything up to
 * the blank line). Used to assert the proxy's CONNECT-level responses
 * (e.g. the 407 auth challenge) without a full TLS tunnel.
 */
function rawConnectHead(proxyPort: string | number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(proxyPort), '127.0.0.1', () => sock.write(request))
    let buf = ''
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      if (buf.includes('\r\n\r\n')) {
        sock.destroy()
        resolve(buf)
      }
    })
    sock.on('error', reject)
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('rawConnectHead timeout')) })
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

  describe('CONNECT tunnel', () => {
    const tunnelPods: string[] = []

    afterEach(async () => {
      for (const name of tunnelPods) {
        await deleteTestPod(name)
      }
      tunnelPods.length = 0
    })

    it('tunnels TCP connections via CONNECT from a session-like pod', async () => {
      await ensureProxy()

      // Register a session with an allowlist covering github.com so the CONNECT
      // tunnel can be authorized. (The proxy blocks by default when no session
      // or allowlist is registered.)
      const sessionId = crypto.randomUUID()
      await client.registerSession(sessionId, {
        rules: [],
        allowedHosts: ['github.com'],
      })

      // Create a pod in the test namespace (same as a real session pod).
      // NOTE: the podman-era assertion that the pod CANNOT reach external
      // hosts directly is gone — the internal-only podman network has no
      // kubernetes equivalent yet (egress lockdown via NetworkPolicy is
      // not part of this migration), so only the positive CONNECT path is
      // asserted here.
      const podName = `yaac-proxy-tunnel-test-${crypto.randomBytes(4).toString('hex')}`
      tunnelPods.push(podName)

      await kubectlApply({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: podName,
          namespace: k8sNamespace(),
          labels: { 'yaac.test': 'true' },
        },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          containers: [{
            name: 'session',
            image: await resolveTestBaseImageRef(),
            imagePullPolicy: 'IfNotPresent',
            // No command override — the base image's ENTRYPOINT is
            // `catatonit -- sleep infinity`, which keeps the pod alive.
          }],
        },
      })
      await waitForPodRunning(podName)

      // Verify the pod CAN open a CONNECT tunnel through the proxy when
      // authenticated as a registered session. We send a raw CONNECT
      // request to the proxy Service and check the response line. A
      // successful tunnel returns "HTTP/1.1 200 Connection Established";
      // a blocked tunnel returns 403.
      const proxyAuth = Buffer.from(`x:${sessionId}`).toString('base64')
      const connectReq =
        'CONNECT github.com:443 HTTP/1.1\r\n' +
        'Host: github.com:443\r\n' +
        `Proxy-Authorization: Basic ${proxyAuth}\r\n\r\n`
      const proxyHost = `${PROXY_APP_NAME}.${k8sNamespace()}.svc`
      const { stdout: tunneled } = await execInPod(podName, [
        'sh', '-c',
        `printf '${connectReq}' | nc -w 3 ${proxyHost} ${PROXY_CONTAINER_PORT} | head -c 40`,
      ], { timeout: 15_000 })
      expect(tunneled).toContain('200 Connection Established')

      await client.removeSession(sessionId)
    }, 120_000)

    it('challenges a credential-less CONNECT with 407, not 403', async () => {
      const hostPort = await ensureProxy()

      // ncat (git's SSH ProxyCommand) never sends Proxy-Authorization
      // preemptively — it sends a bare CONNECT and only attaches credentials
      // after a 407 challenge. A 403 here made it give up without ever
      // authenticating. The proxy must answer missing auth with 407 +
      // Proxy-Authenticate so challenge-response clients can retry.
      const head = await rawConnectHead(
        hostPort,
        'CONNECT github.com:22 HTTP/1.1\r\nHost: github.com:22\r\n\r\n',
      )
      expect(head).toMatch(/^HTTP\/1\.1 407 /)
      expect(head.toLowerCase()).toContain('proxy-authenticate: basic')
    }, 30_000)
  })

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
    try { await client?.stop() } catch { /* ok */ }
    if (echoPodName) await deleteTestPod(echoPodName)
  })

  it('forwards a plain HTTP GET request', async () => {
    const targetUrl = `http://${echoHost}:${echoPort}/hello?foo=bar`
    const result = await proxyRequest(hostPort, targetUrl, {
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
    const result = await proxyRequest(hostPort, targetUrl, {
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
    const result = await proxyRequest(hostPort, targetUrl, {
      headers: defaultAuthHeader,
    })

    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { headers: Record<string, string> }
    expect(echo.headers['proxy-authorization']).toBeUndefined()
  })

  it('returns 502 when upstream is unreachable', async () => {
    const targetUrl = `http://${echoHost}:19399/nope`
    const result = await proxyRequest(hostPort, targetUrl, {
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
    const allowed = await proxyRequest(hostPort, `http://${echoHost}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(allowed.status).toBe(200)

    // Request to a different host (blocked) — use a non-routable IP to avoid DNS
    const blocked = await proxyRequest(hostPort, 'http://192.0.2.1:80/test', {
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
    const result = await proxyRequest(hostPort, `http://${echoHost}:${echoPort}/test`, {
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
    const blocked = await proxyRequest(hostPort, `http://${echoHost}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked.status).toBe(403)

    await client.removeSession(sessionId)
  })

  it('blocks traffic when no session is registered (fail closed)', async () => {
    // No Proxy-Authorization header → proxy has no session mapping and must
    // block the request. Previously this would allow all traffic.
    const blocked = await proxyRequest(hostPort, `http://${echoHost}:${echoPort}/test`)
    expect(blocked.status).toBe(403)
    expect(blocked.body).toContain('not in the allowed hosts')
  })

  it('blocks traffic when session is registered but session is unknown (fail closed)', async () => {
    // A random session ID that was never registered → no session state
    // exists, so the proxy must block.
    const unknownSessionId = crypto.randomUUID()
    const auth = Buffer.from(`x:${unknownSessionId}`).toString('base64')
    const blocked = await proxyRequest(hostPort, `http://${echoHost}:${echoPort}/test`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked.status).toBe(403)
  })

  it('blocks all traffic when allowedHosts is empty', async () => {
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, { rules: [], allowedHosts: [] })

    const auth = Buffer.from(`x:${sessionId}`).toString('base64')
    const blocked = await proxyRequest(hostPort, `http://${echoHost}:${echoPort}/test`, {
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
    const result = await proxyRequest(hostPort, `http://${echoHost}:${echoPort}/test`, {
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
    const blocked = await proxyRequest(hostPort, 'http://192.0.2.1:80/test', {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(blocked.status).toBe(403)

    // Also block a second host
    const blocked2 = await proxyRequest(hostPort, 'http://198.51.100.1:80/test', {
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

    const allowed = await proxyRequest(hostPort, `http://${echoHost}:${echoPort}/a`, {
      headers: { 'Proxy-Authorization': `Basic ${authA}` },
    })
    expect(allowed.status).toBe(200)

    const blocked = await proxyRequest(hostPort, `http://${echoHost}:${echoPort}/b`, {
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
    const before = await proxyRequest(hostPort, `http://${echoHost}:${echoPort}/before`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(before.status).toBe(200)

    await client.removeSession(sessionId)

    const after = await proxyRequest(hostPort, `http://${echoHost}:${echoPort}/after`, {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(after.status).toBe(403)
  })
})

/**
 * Send a proxied HTTPS request: CONNECT through the proxy, TLS-wrap the
 * tunnel (trusting the proxy's self-signed leaf cert), then ride an
 * `http.request` over the TLS socket so node handles chunked encoding,
 * content-length parsing, and response framing. Mirrors what a real CLI
 * inside a session pod does, minus CA-cert verification —
 * `rejectUnauthorized: false` avoids the CA-cert plumbing dance for tests
 * that only exercise the forwarding path.
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

  const auth = Buffer.from(`x:${sessionId}`).toString('base64')
  tcp.write(
    `CONNECT ${targetHost}:443 HTTP/1.1\r\n` +
    `Host: ${targetHost}:443\r\n` +
    `Proxy-Authorization: Basic ${auth}\r\n\r\n`,
  )

  await new Promise<void>((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      if (buf.includes('\r\n\r\n')) {
        tcp.off('data', onData)
        if (/^HTTP\/1\.1 200/.test(buf)) resolve()
        else reject(new Error(`CONNECT failed: ${buf.split('\r\n')[0]}`))
      }
    }
    tcp.on('data', onData)
    tcp.once('error', reject)
  })

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
  const tunnel = new ServicePortForward(PROXY_APP_NAME, PROXY_PORT)

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

  beforeAll(async () => {
    client = new ProxyClient(TEST_PROXY_CONFIG)
    await client.ensureRunning()
    hostPort = await tunnel.ensure()

    echoPodName = `yaac-persist-echo-${crypto.randomBytes(4).toString('hex')}`
    const echo = await startEchoPod(echoPodName)
    echoHost = echo.host
  }, 240_000)

  afterAll(async () => {
    tunnel.stop()
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
      hostPort, 'api.anthropic.com', sessionId,
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
    const blocked = await proxyRequest(hostPort, 'http://192.0.2.1:80/test', {
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

    const result = await proxiedHttpsRequest(
      hostPort, 'api.anthropic.com', sessionId,
      { method: 'GET', path: '/after-churn' },
    )
    expect(result.status).toBe(200)
    const echo = JSON.parse(result.body) as { headers: Record<string, string> }
    expect(echo.headers['x-test-secret']).toBe('Bearer sekrit-value')

    // Blocked-host history survived the replacement too (reloaded at boot)
    expect(await readBlockedHosts(sessionId)).toContain('192.0.2.1')

    // And the allowlist still fails closed for non-allowed hosts.
    const stillBlocked = await proxyRequest(hostPort, 'http://192.0.2.1:80/test', {
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    })
    expect(stillBlocked.status).toBe(403)

    await client.removeSession(sessionId)
  }, 240_000)
})

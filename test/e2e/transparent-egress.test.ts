import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  requirePodman,
  requireCluster,
  useTestNamespace,
  createTempDataDir,
  cleanupTempDir,
  TEST_PROXY_CONFIG,
  IS_NESTED_YAAC,
} from '@test/helpers/setup'
import { resolveTestBaseImageRef } from '@test/helpers/mock-remotes'
import { ProxyClient } from '@/lib/container/proxy-client'
import {
  proxyServiceClusterIp,
  SSH_TUNNEL_SENTINEL,
  TRANSPARENT_HTTPS_PORT,
  TUNNEL_INGRESS_PORT,
} from '@/lib/k8s/bootstrap'
import { CA_CONFIGMAP_NAME } from '@/lib/k8s/pod-spec'
import { LABEL_SESSION_ID } from '@/lib/k8s/pods'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@/lib/k8s/kubectl'

const execFileAsync = promisify(execFile)

/**
 * End-to-end coverage of the Cilium-level egress redirect. Session pods are
 * BARE — no sidecars — carrying only the `yaac.session-id` label and a
 * `dnsConfig` pointed at the proxy. Their outbound 443/80 is redirected to
 * the proxy by the cluster-level CiliumEnvoyConfig + CiliumNetworkPolicy
 * (applied by ensureRunning); the proxy identifies each connection by the
 * Cilium-stamped source pod IP it watches, then routes by TLS SNI / Host.
 * Every target IP is TEST-NET (192.0.2.0/24) via `curl --resolve`, so
 * reaching anything at all proves the redirect.
 */

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

const ECHO_PORT = 8080
const TLS_ECHO_PORT = 8443

/** Never-routable TEST-NET-1 addresses the redirect must intercept. */
const FAKE_IP_A = '192.0.2.10'
const FAKE_IP_B = '192.0.2.11'

const MITM_HOST = 'api.anthropic.com' // always dynamically MITM'd by the proxy
const BLOCKED_HOST = 'blocked.example.com'
const CA_PATH = '/etc/yaac/certs/proxy-ca.pem'

async function deleteTestPod(name: string): Promise<void> {
  await kubectlWithRetry([
    'delete', 'pod', name, '-n', k8sNamespace(),
    '--ignore-not-found', '--wait=false', '--grace-period=1',
  ]).catch(() => { /* ok */ })
  await kubectlWithRetry([
    'delete', 'service', name, '-n', k8sNamespace(), '--ignore-not-found',
  ]).catch(() => { /* ok */ })
}

async function execInPod(
  podName: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return kubectlWithRetry(['exec', '-n', k8sNamespace(), podName, '--', ...args], opts)
}

async function waitForPodRunning(name: string, timeoutMs = 120_000): Promise<void> {
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

/** HTTP echo (request mirror as JSON) — Pod + Service, ports 8080 and 80. */
async function startEchoPod(name: string): Promise<{ host: string }> {
  const echoScript = `
    const http = require('http');
    http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method, url: req.url, headers: req.headers,
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
        name: 'echo', image, imagePullPolicy: 'IfNotPresent',
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
      ports: [
        { name: 'echo', port: ECHO_PORT, targetPort: ECHO_PORT },
        { name: 'http', port: 80, targetPort: ECHO_PORT },
      ],
    },
  })
  await waitForPodRunning(name)
  // No self-reachability probe: a pod reaching its own Service is hairpin
  // NAT, which this kind+podman setup doesn't do. The actual tests reach the
  // echo pod-to-pod (session pod → proxy → echo) and retry via
  // curlUntilSuccess to absorb endpoint-programming races.
  return { host: `${name}.${ns}.svc` }
}

/** TLS echo with its own self-signed (NOT proxy-CA) cert — tunnel peer. */
async function startTlsEchoPod(name: string): Promise<{ host: string }> {
  const ns = k8sNamespace()
  const host = `${name}.${ns}.svc`
  const certDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tls-echo-'))
  const keyPath = path.join(certDir, 'key.pem')
  const certPath = path.join(certDir, 'cert.pem')
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
    '-days', '2', '-nodes', '-subj', `/CN=${host}`,
  ])
  const [key, cert] = await Promise.all([
    fs.readFile(keyPath, 'utf8'), fs.readFile(certPath, 'utf8'),
  ])
  await fs.rm(certDir, { recursive: true, force: true })

  const body = 'TUNNEL_OK'
  const tlsScript = `
    const tls = require('tls');
    tls.createServer({ key: process.env.TLS_KEY, cert: process.env.TLS_CERT }, (sock) => {
      sock.on('error', () => {});
      sock.end('HTTP/1.1 200 OK\\r\\nContent-Length: ${body.length}\\r\\nConnection: close\\r\\n\\r\\n${body}');
    }).listen(${TLS_ECHO_PORT}, '0.0.0.0', () => console.log('tls echo ready'));
  `
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: ns, labels: { 'app': name, 'yaac.test': 'true' } },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      containers: [{
        name: 'tls-echo', image: await resolveTestBaseImageRef(), imagePullPolicy: 'IfNotPresent',
        command: ['node', '-e', tlsScript],
        env: [{ name: 'TLS_KEY', value: key }, { name: 'TLS_CERT', value: cert }],
        ports: [{ containerPort: TLS_ECHO_PORT }],
      }],
    },
  })
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: ns, labels: { 'yaac.test': 'true' } },
    spec: { type: 'ClusterIP', selector: { app: name }, ports: [{ port: 443, targetPort: TLS_ECHO_PORT }] },
  })
  await waitForPodRunning(name)
  return { host }
}

/**
 * A bare session pod: the `yaac.session-id` label (so the proxy's pod-watch
 * resolves its source IP to a session and the redirect CNP selects it), the
 * proxy-CA mount for `curl --cacert`, and `dnsConfig` pointed at the proxy
 * VIP DNS stub. No sidecars, no proxy env vars — egress is redirected at the
 * cluster level.
 */
async function startSessionPod(name: string, sessionId: string, proxyHost: string): Promise<void> {
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: { [LABEL_SESSION_ID]: sessionId, 'yaac.test': 'true' },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      dnsPolicy: 'None',
      dnsConfig: { nameservers: [proxyHost] },
      containers: [{
        name: 'session',
        image: await resolveTestBaseImageRef(),
        imagePullPolicy: 'IfNotPresent',
        // Base image ENTRYPOINT keeps the pod alive (catatonit + sleep).
        volumeMounts: [{ name: 'proxy-ca', mountPath: '/etc/yaac/certs', readOnly: true }],
      }],
      volumes: [{ name: 'proxy-ca', configMap: { name: CA_CONFIGMAP_NAME } }],
    },
  })
}

/** Run curl in a pod, never failing the exec: emits `EXIT:<code>` last. */
async function curlInPod(pod: string, curlArgs: string): Promise<{ exit: number; out: string }> {
  const { stdout } = await execInPod(pod, [
    'sh', '-c', `curl -sS --max-time 20 ${curlArgs} 2>&1; printf '\nEXIT:%s\n' "$?"`,
  ], { timeout: 40_000 })
  const m = /EXIT:(\d+)\s*$/.exec(stdout)
  return { exit: m ? Number(m[1]) : -1, out: stdout }
}

/** Retry a curl until it succeeds (first requests race endpoint programming). */
async function curlUntilSuccess(
  pod: string, curlArgs: string, timeoutMs = 60_000,
): Promise<{ exit: number; out: string }> {
  const deadline = Date.now() + timeoutMs
  let last: { exit: number; out: string } = { exit: -1, out: '(never ran)' }
  for (;;) {
    last = await curlInPod(pod, curlArgs)
    if (last.exit === 0 || Date.now() >= deadline) return last
    await new Promise((r) => setTimeout(r, 2000))
  }
}

describe('cilium-level transparent egress (source-IP identity)', () => {
  const client = new ProxyClient(TEST_PROXY_CONFIG)
  const suffix = crypto.randomBytes(4).toString('hex')

  const echoName = `yaac-tegress-echo-${suffix}`
  const tlsEchoName = `yaac-tegress-tls-${suffix}`
  const podA = `yaac-tegress-a-${suffix}`
  const podB = `yaac-tegress-b-${suffix}`

  const sessionA = crypto.randomUUID()
  const sessionB = crypto.randomUUID()

  let echoHost = ''
  let tlsHost = ''
  let proxyHost = ''

  beforeAll(async () => {
    await client.ensureRunning()
    proxyHost = await proxyServiceClusterIp()

    const [echo, tlsEcho] = await Promise.all([
      startEchoPod(echoName),
      startTlsEchoPod(tlsEchoName),
    ])
    echoHost = echo.host
    tlsHost = tlsEcho.host

    // Session A: MITM api.anthropic.com → the HTTP echo, plus plain HTTP to
    // the echo host. Session B: only the TLS echo (for the tunnel test).
    await client.registerSession(sessionA, {
      rules: [],
      allowedHosts: [MITM_HOST, echoHost],
      upstreamRedirects: { [MITM_HOST]: { host: echoHost, port: ECHO_PORT, tls: false } },
    })
    await client.registerSession(sessionB, { rules: [], allowedHosts: [tlsHost] })

    await Promise.all([
      startSessionPod(podA, sessionA, proxyHost),
      startSessionPod(podB, sessionB, proxyHost),
    ])
    await Promise.all([waitForPodRunning(podA), waitForPodRunning(podB)])
  }, 300_000)

  afterAll(async () => {
    await Promise.all(
      [echoName, tlsEchoName, podA, podB].map((n) => deleteTestPod(n)),
    )
    try { await client.removeSession(sessionA) } catch { /* ok */ }
    try { await client.removeSession(sessionB) } catch { /* ok */ }
    try { await client.stop() } catch { /* ok */ }
  })

  // The positive-egress legs (reach/HTTP/CONNECT/DNS-stub) require the
  // inner Cilium redirect, which is enforced host-side in a nested session;
  // the fail-closed / source-IP / forgery-lock legs still hold and run.
  it.skipIf(IS_NESTED_YAAC)('reaches an allowed host through SNI MITM with the mounted CA', async () => {
    // --resolve pins the never-routable IP: only the Cilium redirect can
    // deliver it. --cacert proves the proxy MITM'd with a leaf the mounted
    // yaac CA signs for api.anthropic.com. Identity is podA's source IP.
    const result = await curlUntilSuccess(
      podA,
      `--cacert ${CA_PATH} --resolve ${MITM_HOST}:443:${FAKE_IP_A} https://${MITM_HOST}/v1/test`,
    )
    expect(result.exit, result.out).toBe(0)
    const echoed = JSON.parse(result.out.slice(0, result.out.lastIndexOf('EXIT:'))) as {
      method: string; url: string; headers: Record<string, string>
    }
    expect(echoed.method).toBe('GET')
    expect(echoed.url).toBe('/v1/test')
    expect(echoed.headers.host).toBe(MITM_HOST)
  }, 120_000)

  it('fails closed for a host outside the session allowlist', async () => {
    const r = await curlInPod(
      podA, `-k --resolve ${BLOCKED_HOST}:443:${FAKE_IP_B} https://${BLOCKED_HOST}/`,
    )
    expect(r.exit).not.toBe(0)
  }, 60_000)

  it('judges concurrent sessions by their own source IP', async () => {
    // podB's source IP maps to session B, whose allowlist has no MITM_HOST —
    // so the proxy denies it even though podA may reach it.
    const fromB = await curlInPod(
      podB, `-k --resolve ${MITM_HOST}:443:${FAKE_IP_A} https://${MITM_HOST}/v1/test`,
    )
    expect(fromB.exit).not.toBe(0)
    // And the inverse: pod A may not reach session B's tunnel host.
    const fromA = await curlInPod(
      podA, `-k --resolve ${tlsHost}:443:${FAKE_IP_B} https://${tlsHost}/`,
    )
    expect(fromA.exit).not.toBe(0)
  }, 60_000)

  it.skipIf(IS_NESTED_YAAC)('forwards transparent HTTP (port 80) via the Host header', async () => {
    const r = await curlInPod(
      podA, `--resolve ${echoHost}:80:${FAKE_IP_A} "http://${echoHost}/hello?x=1"`,
    )
    expect(r.exit, r.out).toBe(0)
    const echoed = JSON.parse(r.out.slice(0, r.out.lastIndexOf('EXIT:'))) as {
      method: string; url: string; headers: Record<string, string>
    }
    expect(echoed.method).toBe('GET')
    expect(echoed.url).toBe('/hello?x=1')
    expect(echoed.headers.host).toBe(echoHost)
  }, 60_000)

  it.skipIf(IS_NESTED_YAAC)('tunnels an explicit CONNECT through the Cilium-redirected SSH sentinel', async () => {
    // `curl --proxy http://<sentinel>:<tunnel-port>` sends the same CONNECT
    // git's ncat ProxyCommand does. Cilium redirects the sentinel through
    // Envoy to the proxy tunnel listener, which reads CONNECT host:port and
    // tunnels to the (allowlisted) TLS echo. The upstream's own self-signed
    // cert reaching curl proves no MITM happened.
    const r = await curlUntilSuccess(
      podB,
      `--proxy http://${SSH_TUNNEL_SENTINEL}:${TUNNEL_INGRESS_PORT} -k https://${tlsHost}/`,
    )
    expect(r.exit, r.out).toBe(0)
    expect(r.out).toContain('TUNNEL_OK')
  }, 120_000)

  it.skipIf(IS_NESTED_YAAC)('split-horizon DNS: external → sinkhole, internal .svc → live ClusterIP', async () => {
    // External name: sinkholed. The answer is decorative — egress is port-
    // redirected and the proxy routes by SNI/Host, never by the dialed IP.
    const ext = await execInPod(podA, [
      'sh', '-c', 'getent hosts dns-stub-probe.example || true',
    ], { timeout: 20_000 })
    expect(ext.stdout).toContain('198.18.0.1')

    // Internal FQDN: the top-level proxy forwards `*.cluster.local` to cluster
    // DNS, so the pod learns the echo Service's REAL (allocator-assigned)
    // ClusterIP — this is what lets yaac stop pinning in-cluster Service VIPs.
    const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
      'get', 'service', echoName, '-n', k8sNamespace(),
    ])
    const echoClusterIp = svc?.spec?.clusterIP
    expect(echoClusterIp, 'echo Service should have a ClusterIP').toBeTruthy()
    const internal = await execInPod(podA, [
      'sh', '-c', `getent hosts ${echoName}.${k8sNamespace()}.svc.cluster.local || true`,
    ], { timeout: 20_000 })
    expect(internal.stdout).toContain(echoClusterIp)

    // Bare `.svc` is out of CoreDNS's zone, so the proxy sinkholes it rather
    // than forward it upstream (the DNS-exfil guard) — it must NOT resolve to
    // the real ClusterIP.
    const bareSvc = await execInPod(podA, [
      'sh', '-c', `getent hosts ${echoName}.${k8sNamespace()}.svc || true`,
    ], { timeout: 20_000 })
    expect(bareSvc.stdout).not.toContain(echoClusterIp)
  }, 60_000)

  it('refuses a direct dial to a transparent listener (the forgery lock)', async () => {
    // A session pod dialing the transparent HTTPS port directly would let it
    // inject a forged PROXY-protocol source. The proxy-ingress CNP restricts
    // those ports to the node Envoy, so the connect must fail.
    const r = await curlInPod(
      podA, `-k --max-time 10 https://${proxyHost}:${TRANSPARENT_HTTPS_PORT}/`,
    )
    expect(r.exit).not.toBe(0)
  }, 60_000)
})

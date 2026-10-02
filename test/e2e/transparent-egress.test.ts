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
} from '@yaac/test-utils/setup'
import { resolveTestBaseImageRef } from '@yaac/test-utils/test-pods'
import { startWorkspacePod, waitForPod } from '@yaac/test-utils/test-pods'
import { ProxyClient } from '@yaac/server/drivers/k8s/egress/proxy-client'
import {
  allowWorkspaceHost,
  applyProxyRegistration,
  deregisterWorkspaceEgress,
} from '@yaac/server/drivers/k8s/egress/proxy-registration'
import { proxyServiceClusterIp } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import {
  SSH_TUNNEL_SENTINEL,
  TRANSPARENT_HTTPS_PORT,
  TUNNEL_INGRESS_PORT,
} from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@yaac/server/drivers/k8s/substrate/kubectl'

const execFileAsync = promisify(execFile)

/**
 * The node-level egress redirect (docs/workspace-egress.md). Workspace pods
 * have no sidecars, only the `yaac.workspace-id` label and DNS pointed at
 * the proxy. netd DNATs their outbound 443/80 to the node's Envoy, which
 * forwards to the proxy with a PROXY-protocol header carrying the source
 * pod IP; the proxy maps that to a workspace and routes by SNI / Host.
 * Every target is a never-routable TEST-NET address, so reaching anything
 * proves the redirect.
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
  await waitForPod(name)
  // No self-reachability probe: a pod reaching its own Service is hairpin
  // NAT, which this kind+podman setup doesn't do. The actual tests reach the
  // echo pod-to-pod (session pod → proxy → echo) and retry via
  // curlUntilSuccess to absorb endpoint-programming races.
  return { host: `${name}.${ns}.svc` }
}

/** TLS echo with its own self-signed (not proxy-CA) cert, for the tunnel test. */
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
  await waitForPod(name)
  return { host }
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

describe('node-level transparent egress (source-IP identity)', () => {
  const client = new ProxyClient(TEST_PROXY_CONFIG)
  const suffix = crypto.randomBytes(4).toString('hex')

  const echoName = `yaac-tegress-echo-${suffix}`
  const tlsEchoName = `yaac-tegress-tls-${suffix}`
  const podA = `yaac-tegress-a-${suffix}`
  const podB = `yaac-tegress-b-${suffix}`

  const workspaceA = crypto.randomUUID()
  const workspaceB = crypto.randomUUID()

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

    // Workspace A: MITM api.anthropic.com to the HTTP echo, plus plain HTTP
    // to the echo host. Workspace B: only the TLS echo (for the tunnel test).
    await applyProxyRegistration(workspaceA, {
      rules: [],
      allowedHosts: [MITM_HOST, echoHost],
      tool: 'claude',
      projectSlug: 'egress-a',
      upstreamRedirects: { [MITM_HOST]: { host: echoHost, port: ECHO_PORT, tls: false } },
    })
    await applyProxyRegistration(workspaceB, {
      rules: [], allowedHosts: [tlsHost], tool: 'claude', projectSlug: 'egress-b',
    })

    await Promise.all([
      startWorkspacePod(podA, workspaceA, proxyHost),
      startWorkspacePod(podB, workspaceB, proxyHost),
    ])
  }, 300_000)

  afterAll(async () => {
    await Promise.all(
      [echoName, tlsEchoName, podA, podB].map((n) => deleteTestPod(n)),
    )
    await deregisterWorkspaceEgress(workspaceA)
    await deregisterWorkspaceEgress(workspaceB)
    try { await client.stop() } catch { /* ok */ }
  })

  it('reaches an allowed host through SNI MITM with the mounted CA', async () => {
    // Only the redirect can deliver the pinned IP, and --cacert shows the
    // proxy's leaf is signed by the mounted yaac CA.
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
    // Workspace B's allowlist lacks MITM_HOST, though A's has it.
    const fromB = await curlInPod(
      podB, `-k --resolve ${MITM_HOST}:443:${FAKE_IP_A} https://${MITM_HOST}/v1/test`,
    )
    expect(fromB.exit).not.toBe(0)
    // And A may not reach B's tunnel host.
    const fromA = await curlInPod(
      podA, `-k --resolve ${tlsHost}:443:${FAKE_IP_B} https://${tlsHost}/`,
    )
    expect(fromA.exit).not.toBe(0)
  }, 60_000)

  it('allowHost widens a live session so a blocked host becomes reachable', async () => {
    // B's allowlist is [tlsHost] only. A blocked plain-HTTP request gets an
    // in-band 403 (curl exits 0), so assert on the body.
    const before = await curlInPod(
      podB, `--resolve ${echoHost}:80:${FAKE_IP_A} "http://${echoHost}/before"`,
    )
    expect(before.out, before.out).toContain('Blocked by URL allowlist')

    // Widen the running workspace's allowlist in place by rewriting its
    // registration.
    await allowWorkspaceHost(
      { workspaceId: workspaceB, projectSlug: 'egress-b' }, echoHost, { fanOutToProject: false },
    )

    const after = await curlUntilSuccess(
      podB, `--resolve ${echoHost}:80:${FAKE_IP_A} "http://${echoHost}/after"`,
    )
    expect(after.exit, after.out).toBe(0)
    const echoed = JSON.parse(after.out.slice(0, after.out.lastIndexOf('EXIT:'))) as {
      url: string; headers: Record<string, string>
    }
    expect(echoed.url).toBe('/after')
    expect(echoed.headers.host).toBe(echoHost)
  }, 120_000)

  it('forwards transparent HTTP (port 80) via the Host header', async () => {
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

  it('tunnels an explicit CONNECT through the redirected SSH sentinel', async () => {
    // Sends the same CONNECT as git's ncat ProxyCommand. The proxy's tunnel
    // listener connects it to the TLS echo; seeing the echo's own cert shows
    // there was no MITM.
    const r = await curlUntilSuccess(
      podB,
      `--proxy http://${SSH_TUNNEL_SENTINEL}:${TUNNEL_INGRESS_PORT} -k https://${tlsHost}/`,
    )
    expect(r.exit, r.out).toBe(0)
    expect(r.out).toContain('TUNNEL_OK')
  }, 120_000)

  it('split-horizon DNS: external → sinkhole, internal .svc → live ClusterIP', async () => {
    // External names resolve to a sinkhole; the proxy routes by SNI/Host,
    // not by the dialed IP.
    const ext = await execInPod(podA, [
      'sh', '-c', 'getent hosts dns-stub-probe.example || true',
    ], { timeout: 20_000 })
    expect(ext.stdout).toContain('198.18.0.1')

    // `*.cluster.local` is forwarded to cluster DNS, so the pod gets the
    // echo Service's real ClusterIP.
    const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
      'get', 'service', echoName, '-n', k8sNamespace(),
    ])
    const echoClusterIp = svc?.spec?.clusterIP
    expect(echoClusterIp, 'echo Service should have a ClusterIP').toBeTruthy()
    const internal = await execInPod(podA, [
      'sh', '-c', `getent hosts ${echoName}.${k8sNamespace()}.svc.cluster.local || true`,
    ], { timeout: 20_000 })
    expect(internal.stdout).toContain(echoClusterIp)

    // Bare `.svc` is outside cluster DNS's zone, so it is sinkholed rather
    // than sent upstream (a DNS-exfiltration guard).
    const bareSvc = await execInPod(podA, [
      'sh', '-c', `getent hosts ${echoName}.${k8sNamespace()}.svc || true`,
    ], { timeout: 20_000 })
    expect(bareSvc.stdout).not.toContain(echoClusterIp)
  }, 60_000)

  it('refuses a direct dial to a transparent listener (the forgery lock)', async () => {
    // Dialing the transparent port directly would let a pod forge the
    // PROXY-protocol source. The proxy-ingress NetworkPolicy admits it only
    // from node CIDRs.
    const r = await curlInPod(
      podA, `-k --max-time 10 https://${proxyHost}:${TRANSPARENT_HTTPS_PORT}/`,
    )
    expect(r.exit).not.toBe(0)
  }, 60_000)
})

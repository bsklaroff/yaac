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
} from '@test/helpers/setup'
import {
  resolveTestBaseImageRef,
  resolveTestRedirectInitImageRef,
  resolveTestRelayImageRef,
} from '@test/helpers/mock-remotes'
import { ProxyClient } from '@/lib/container/proxy-client'
import {
  clusterIpForNamespace,
  PROXY_APP_NAME,
  RELAY_CONNECT_PORT,
  RELAY_DNS_PORT,
  RELAY_HTTP_PORT,
  RELAY_HTTPS_PORT,
  RELAY_UID,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_TUNNEL_PORT,
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
 * End-to-end coverage of the transparent egress path: session-like pods
 * carry the real redirect-init + relay sidecars and ZERO proxy env vars.
 * Outbound 443/80 is REDIRECTed in the pod netns to the per-pod relay,
 * which recovers the original destination (SO_ORIGINAL_DST) and forwards
 * to the proxy behind a PROXY-protocol-v2 header carrying the session's
 * relay credential. Identity is that per-connection token (not the source
 * IP); the proxy recovers the destination hostname from TLS SNI / the
 * Host header. Every target IP here is TEST-NET (192.0.2.0/24) via
 * `curl --resolve`, so reaching anything at all proves the redirect.
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
  return kubectlWithRetry(
    ['exec', '-n', k8sNamespace(), podName, '--', ...args],
    opts,
  )
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
      // Port 80 rides along for the transparent-HTTP test: origin-form
      // requests reconstruct the destination as Host-header host : 80.
      ports: [
        { name: 'echo', port: ECHO_PORT, targetPort: ECHO_PORT },
        { name: 'http', port: 80, targetPort: ECHO_PORT },
      ],
    },
  })
  await waitForPodRunning(name)

  // Probe through the Service path so the first proxied request can't
  // race DNS/endpoint programming.
  const host = `${name}.${ns}.svc`
  let reachable = false
  for (let i = 0; i < 40; i++) {
    try {
      const { stdout } = await execInPod(name, [
        'sh', '-c', `curl -sf http://${host}:${ECHO_PORT}/ping`,
      ], { timeout: 5000 })
      if (stdout) { reachable = true; break }
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  if (!reachable) throw new Error(`echo service not reachable at ${host}`)
  return { host }
}

/**
 * TLS echo answering a fixed HTTP response with its own (self-signed,
 * NOT proxy-CA) certificate — the peer for the tunnel pass-through test.
 * Cert/key are generated host-side and ride in via env.
 */
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
    fs.readFile(keyPath, 'utf8'),
    fs.readFile(certPath, 'utf8'),
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
        name: 'tls-echo',
        image: await resolveTestBaseImageRef(),
        imagePullPolicy: 'IfNotPresent',
        command: ['node', '-e', tlsScript],
        env: [
          { name: 'TLS_KEY', value: key },
          { name: 'TLS_CERT', value: cert },
        ],
        ports: [{ containerPort: TLS_ECHO_PORT }],
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
      // Service port 443: the proxy's tunnel path reconstructs the
      // destination as SNI-host:443.
      ports: [{ port: 443, targetPort: TLS_ECHO_PORT }],
    },
  })
  await waitForPodRunning(name)
  return { host }
}

/**
 * A session-like pod: redirect init container (real image + redirect.sh,
 * NET_ADMIN under hostUsers:false), session-id label (so the egress
 * NetworkPolicy bites), proxy-CA mount for curl --cacert — and ZERO
 * proxy env vars, the point of this suite.
 */
async function startSessionLikePod(
  name: string,
  sessionId: string,
  relayToken: string,
  proxyHost: string,
): Promise<void> {
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
      hostUsers: false,
      securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
      initContainers: [
        {
          name: 'yaac-redirect-init',
          image: await resolveTestRedirectInitImageRef(),
          imagePullPolicy: 'IfNotPresent',
          securityContext: { capabilities: { add: ['NET_ADMIN'] } },
          env: [
            { name: 'REDIRECT_HTTPS_PORT', value: String(RELAY_HTTPS_PORT) },
            { name: 'REDIRECT_HTTP_PORT', value: String(RELAY_HTTP_PORT) },
            { name: 'REDIRECT_DNS_PORT', value: String(RELAY_DNS_PORT) },
            { name: 'PROXY_CLUSTER_IP', value: proxyHost },
            { name: 'RELAY_UID', value: String(RELAY_UID) },
            { name: 'TRANSPARENT_HTTPS_PORT', value: String(TRANSPARENT_HTTPS_PORT) },
            { name: 'TRANSPARENT_HTTP_PORT', value: String(TRANSPARENT_HTTP_PORT) },
            { name: 'TRANSPARENT_TUNNEL_PORT', value: String(TRANSPARENT_TUNNEL_PORT) },
          ],
        },
        {
          name: 'yaac-relay',
          image: await resolveTestRelayImageRef(),
          imagePullPolicy: 'IfNotPresent',
          restartPolicy: 'Always', // native sidecar
          securityContext: { runAsUser: RELAY_UID, capabilities: { drop: ['ALL'] } },
          env: [
            { name: 'LISTEN_HTTPS_PORT', value: String(RELAY_HTTPS_PORT) },
            { name: 'LISTEN_HTTP_PORT', value: String(RELAY_HTTP_PORT) },
            { name: 'LISTEN_CONNECT_PORT', value: String(RELAY_CONNECT_PORT) },
            { name: 'LISTEN_DNS_PORT', value: String(RELAY_DNS_PORT) },
            { name: 'PROXY_HOST', value: proxyHost },
            { name: 'TRANSPARENT_HTTPS_PORT', value: String(TRANSPARENT_HTTPS_PORT) },
            { name: 'TRANSPARENT_HTTP_PORT', value: String(TRANSPARENT_HTTP_PORT) },
            { name: 'TRANSPARENT_TUNNEL_PORT', value: String(TRANSPARENT_TUNNEL_PORT) },
            { name: 'SESSION_ID', value: sessionId },
            { name: 'RELAY_TOKEN', value: relayToken },
          ],
          startupProbe: {
            exec: { command: ['sh', '-c', 'test -f /tmp/yaac-relay-ready'] },
            periodSeconds: 1,
            failureThreshold: 30,
          },
        },
      ],
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

const CA_PATH = '/etc/yaac/certs/proxy-ca.pem'

/**
 * Run curl in a pod, never failing the exec: emits `EXIT:<code>` last so
 * assertions can distinguish "reached + body" from "connection killed".
 */
async function curlInPod(
  pod: string,
  curlArgs: string,
): Promise<{ exit: number; out: string }> {
  const { stdout } = await execInPod(pod, [
    'sh', '-c', `curl -sS --max-time 20 ${curlArgs} 2>&1; printf '\nEXIT:%s\n' "$?"`,
  ], { timeout: 40_000 })
  const m = /EXIT:(\d+)\s*$/.exec(stdout)
  return { exit: m ? Number(m[1]) : -1, out: stdout }
}

/**
 * Retry a curl until it succeeds (first requests can race service
 * endpoint programming); returns the last attempt either way.
 */
async function curlUntilSuccess(
  pod: string,
  curlArgs: string,
  timeoutMs = 60_000,
): Promise<{ exit: number; out: string }> {
  const deadline = Date.now() + timeoutMs
  let last: { exit: number; out: string } = { exit: -1, out: '(never ran)' }
  for (;;) {
    last = await curlInPod(pod, curlArgs)
    if (last.exit === 0 || Date.now() >= deadline) return last
    await new Promise((r) => setTimeout(r, 2000))
  }
}

describe('transparent egress (no proxy env vars)', () => {
  const client = new ProxyClient(TEST_PROXY_CONFIG)
  const suffix = crypto.randomBytes(4).toString('hex')

  const echoName = `yaac-tegress-echo-${suffix}`
  const tlsEchoName = `yaac-tegress-tls-${suffix}`
  const podA = `yaac-tegress-a-${suffix}`
  const podB = `yaac-tegress-b-${suffix}`
  const podBadToken = `yaac-tegress-badtok-${suffix}`

  const sessionA = crypto.randomUUID()
  const sessionB = crypto.randomUUID()
  const sessionBadToken = crypto.randomUUID()

  let echoHost = ''
  let tlsHost = ''
  let proxyHost = ''

  beforeAll(async () => {
    await client.ensureRunning()
    // The pinned per-namespace VIP — exactly what session-create hands the
    // relay (an IP, never a DNS name; in-pod resolution is the stub's
    // dummy answer). ensureRunning() above created the Service at the pin.
    proxyHost = clusterIpForNamespace(k8sNamespace())

    const [echo, tlsEcho] = await Promise.all([
      startEchoPod(echoName),
      startTlsEchoPod(tlsEchoName),
    ])
    echoHost = echo.host
    tlsHost = tlsEcho.host

    // Session A: MITM'd host (redirected to the echo) + the echo host
    // itself (for the transparent-HTTP test). Session B: tunnel host only.
    // sessionBadToken: a permissive allowlist, but its pod's relay will
    // carry a wrong credential — so the proxy must reject it regardless.
    await client.registerSession(sessionA, {
      rules: [],
      allowedHosts: [MITM_HOST, echoHost],
      upstreamRedirects: { [MITM_HOST]: { host: echoHost, port: ECHO_PORT, tls: false } },
    })
    await client.registerSession(sessionB, {
      rules: [],
      allowedHosts: [tlsHost],
    })
    await client.registerSession(sessionBadToken, { rules: [], allowedHosts: ['*'] })

    // Identity is the per-connection relay token (derived from the proxy
    // auth secret), injected into each pod's relay sidecar. No bind step.
    await Promise.all([
      startSessionLikePod(podA, sessionA, client.relayToken(sessionA), proxyHost),
      startSessionLikePod(podB, sessionB, client.relayToken(sessionB), proxyHost),
      // Deliberately forged token: a valid-shaped HMAC for the wrong input.
      startSessionLikePod(podBadToken, sessionBadToken, '0'.repeat(64), proxyHost),
    ])
    await Promise.all([
      waitForPodRunning(podA),
      waitForPodRunning(podB),
      waitForPodRunning(podBadToken),
    ])
  }, 300_000)

  afterAll(async () => {
    for (const name of [podA, podB, podBadToken, echoName, tlsEchoName]) {
      await deleteTestPod(name)
    }
    try { await client.attachIfRunning() } catch { /* tunnel may be stale post-churn */ }
    try { await client.removeSession(sessionA) } catch { /* ok */ }
    try { await client.removeSession(sessionB) } catch { /* ok */ }
    try { await client.removeSession(sessionBadToken) } catch { /* ok */ }
    try { await client.stop() } catch { /* ok */ }
  })

  it('reaches an allowed host through SNI MITM with the relay credential and the mounted CA', async () => {
    // --resolve pins the never-routable IP: only the pod-netns REDIRECT +
    // relay can deliver this. --cacert proves the proxy MITM'd with a leaf
    // the mounted yaac CA signs for api.anthropic.com.
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
      podA,
      `-k --resolve ${BLOCKED_HOST}:443:${FAKE_IP_B} https://${BLOCKED_HOST}/`,
    )
    expect(r.exit).not.toBe(0)
  }, 60_000)

  it('judges concurrent sessions by their own relay credential', async () => {
    // Each pod's relay carries its own session token, so the proxy applies
    // each session's allowlist. Session B's allowlist has no MITM_HOST.
    const fromB = await curlInPod(
      podB,
      `-k --resolve ${MITM_HOST}:443:${FAKE_IP_A} https://${MITM_HOST}/v1/test`,
    )
    expect(fromB.exit).not.toBe(0)

    // And the inverse: pod A may not reach session B's tunnel host.
    const fromA = await curlInPod(
      podA,
      `-k --resolve ${tlsHost}:443:${FAKE_IP_B} https://${tlsHost}/`,
    )
    expect(fromA.exit).not.toBe(0)
  }, 60_000)

  it('round-trips an SNI tunnel pass-through without MITM', async () => {
    // tlsHost is allowlisted for B but not dynamically MITM'd and has no
    // rules/redirect → the proxy tunnels raw bytes to <SNI-host>:443. The
    // upstream's own self-signed cert reaching curl is itself proof that
    // no MITM happened (-k accepts it; the proxy CA would have signed a
    // different leaf).
    const r = await curlUntilSuccess(
      podB,
      `-k --resolve ${tlsHost}:443:${FAKE_IP_B} https://${tlsHost}/`,
    )
    expect(r.exit, r.out).toBe(0)
    expect(r.out).toContain('TUNNEL_OK')
  }, 120_000)

  it('forwards transparent HTTP (port 80) via the Host header', async () => {
    const r = await curlInPod(
      podA,
      `--resolve ${echoHost}:80:${FAKE_IP_A} "http://${echoHost}/hello?x=1"`,
    )
    expect(r.exit).toBe(0)
    const echoed = JSON.parse(r.out.slice(0, r.out.lastIndexOf('EXIT:'))) as {
      method: string; url: string; headers: Record<string, string>
    }
    expect(echoed.method).toBe('GET')
    expect(echoed.url).toBe('/hello?x=1')
    expect(echoed.headers.host).toBe(echoHost)
  }, 60_000)

  it('tunnels an explicit CONNECT through the relay (the SSH path) on the relay token', async () => {
    // `curl --proxy http://127.0.0.1:<relayConnect>` sends the same
    // CONNECT that git's ncat ProxyCommand does — to the pod-local relay,
    // with NO credential. The relay attaches the session's PP2 token and
    // forwards to the proxy's tunnel listener, which parses CONNECT and
    // tunnels to the (allowlisted, hostname-preserved) target. Loopback to
    // the relay is excluded from the redirect, so this is the real path.
    const r = await curlUntilSuccess(
      podB,
      `--proxy http://127.0.0.1:${RELAY_CONNECT_PORT} -k https://${tlsHost}/`,
    )
    expect(r.exit, r.out).toBe(0)
    expect(r.out).toContain('TUNNEL_OK')
  }, 120_000)

  it('fails closed for a relay-CONNECT to a host outside the allowlist', async () => {
    // Same SSH path, but a host session B is not allowlisted for: the
    // proxy rejects the CONNECT (the hostname is preserved through ncat,
    // so the allowlist still applies).
    const r = await curlInPod(
      podB,
      `--proxy http://127.0.0.1:${RELAY_CONNECT_PORT} -k https://${echoHost}:443/`,
    )
    expect(r.exit).not.toBe(0)
  }, 60_000)

  it('destroys a connection carrying an invalid relay token (fail closed)', async () => {
    // podBadToken's session is allowlisted for everything, but its relay
    // presents a forged token — so the proxy rejects at PP2 verification,
    // before any allowlist check. The credential, not the allowlist, is
    // what closes this.
    const r = await curlInPod(
      podBadToken,
      `-k --resolve ${echoHost}:443:${FAKE_IP_A} https://${echoHost}/`,
    )
    expect(r.exit).not.toBe(0)
  }, 60_000)

  it('refuses a direct dial to the transparent listener from the session container', async () => {
    // A session pod dialing the transparent HTTPS port directly bypasses
    // its relay (10256 is not REDIRECTed — only 443/80 are). Two layers
    // close this: the in-pod filter REJECTs it first (the session uid has
    // no carve-out to the transport ports), and even if it reached the
    // proxy, the bare ClientHello carries no PP2 preamble so the listener
    // would destroy it. Either way: reaching the port grants nothing.
    const r = await curlInPod(
      podA,
      `-k --max-time 10 https://${proxyHost}:${TRANSPARENT_HTTPS_PORT}/`,
    )
    expect(r.exit).not.toBe(0)
  }, 60_000)

  it('rejects non-443/80 TCP egress in-pod, fast (filter default-deny)', async () => {
    // Port 22 to a TEST-NET-3 address: no nat rule captures it, so it
    // keeps its real destination and must die on the filter's
    // REJECT-with-tcp-reset — immediately, not after the nc timeout
    // (a slow failure would mean only the NetworkPolicy DROP caught it).
    const { stdout } = await execInPod(podA, ['sh', '-c',
      'S=$(date +%s); nc -w 5 -z 203.0.113.9 22 </dev/null >/dev/null 2>&1'
      + ' && echo CONNECTED || echo "REFUSED after $(( $(date +%s) - S ))s"',
    ], { timeout: 30_000 })
    expect(stdout).not.toContain('CONNECTED')
    const m = /REFUSED after (\d+)s/.exec(stdout)
    expect(m, stdout).not.toBeNull()
    expect(Number(m![1])).toBeLessThanOrEqual(2)
  }, 60_000)

  it('intercepts DNS aimed at an external resolver (the stub answers, not 8.8.8.8)', async () => {
    // The query targets 8.8.8.8 explicitly, so a dummy answer proves
    // interception, not resolver cooperation: the udp/53 REDIRECT
    // captured it into the loopback stub, and conntrack made the reply
    // appear to come from 8.8.8.8.
    const script = 'const dns=require("node:dns");const r=new dns.Resolver();'
      + 'r.setServers(["8.8.8.8"]);'
      + 'r.resolve4("egress-probe.example.com",(e,a)=>{console.log(e?"ERR:"+e.code:a[0])})'
    const { stdout } = await execInPod(podA, ['node', '-e', script], { timeout: 30_000 })
    expect(stdout.trim()).toBe('198.18.0.1')
  }, 60_000)

  it('resolves every name to the dummy IP while real fetches ride SNI through the relay', async () => {
    // Resolution succeeds for anything — even .invalid — because the stub
    // answers it all with the decorative dummy.
    const ge = await execInPod(podA, ['getent', 'hosts', 'yaac-egress-probe.invalid'])
    expect(ge.stdout).toContain('198.18.0.1')

    // No --resolve pin this time: curl genuinely resolves the allowlisted
    // host (getting 198.18.0.1), dials it, and the REDIRECT + SNI routing
    // deliver the request anyway — the resolved IP never mattered.
    const ok = await curlUntilSuccess(
      podA,
      `--cacert ${CA_PATH} https://${MITM_HOST}/via-dns-stub`,
    )
    expect(ok.exit, ok.out).toBe(0)
    const echoed = JSON.parse(ok.out.slice(0, ok.out.lastIndexOf('EXIT:'))) as {
      url: string; headers: Record<string, string>
    }
    expect(echoed.url).toBe('/via-dns-stub')
    expect(echoed.headers.host).toBe(MITM_HOST)

    // And a non-allowlisted host now fails at the proxy (allowlist), not
    // at resolution — the lockdown must not have bypassed the allowlist.
    const blocked = await curlInPod(podA, `-k https://${BLOCKED_HOST}/`)
    expect(blocked.exit).not.toBe(0)
  }, 120_000)

  it('self-heals session egress across a proxy pod replacement with no daemon action', async () => {
    // Confirm egress works, then delete the proxy pod. The relay token is
    // derived from the proxy auth secret (reloaded into the replacement
    // from its Secret) and registrations reload from /data — so the new
    // proxy identifies and authorizes podA's traffic with the daemon doing
    // nothing. This is the reliability win over source-IP binds.
    const before = await curlUntilSuccess(
      podA,
      `--cacert ${CA_PATH} --resolve ${MITM_HOST}:443:${FAKE_IP_A} https://${MITM_HOST}/healthy`,
    )
    expect(before.exit, before.out).toBe(0)

    await kubectlWithRetry([
      'delete', 'pod', '-n', k8sNamespace(), '-l', `app=${PROXY_APP_NAME}`,
      '--wait=false', '--grace-period=1',
    ])

    const after = await curlUntilSuccess(
      podA,
      `--cacert ${CA_PATH} --resolve ${MITM_HOST}:443:${FAKE_IP_A} https://${MITM_HOST}/after-churn`,
      180_000,
    )
    expect(after.exit, after.out).toBe(0)
    const echoed = JSON.parse(after.out.slice(0, after.out.lastIndexOf('EXIT:'))) as { url: string }
    expect(echoed.url).toBe('/after-churn')
  }, 240_000)
})

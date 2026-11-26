import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requireCluster, useTestNamespace, createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { openTestPodsToProxy, requirePodman, TEST_PROXY_CONFIG } from '#support/cluster'
import { resolveTestBaseImageRef, startWorkspacePod, waitForPod } from '#support/test-pods'
import { startKubectlForward, type KubectlForward } from '@yaac/test-utils/kubectl-forward'
import { ProxyClient } from '@yaac/server/drivers/k8s/egress/proxy-client'
import {
  allowWorkspaceHost,
  applyProxyRegistration,
  deregisterWorkspaceEgress,
  type ProxyRegistration,
} from '@yaac/server/drivers/k8s/egress/proxy-registration'
import {
  NETD_APP_NAME,
  NETD_SITE_PORT,
  NETD_STREAM_PORT,
  SSH_TUNNEL_SENTINEL,
  TUNNEL_INGRESS_PORT,
  siteServiceName,
} from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import { applyObject, deleteObject, k8sNamespace, listObjects, readObject } from '@yaac/server/drivers/k8s/substrate/api'
import { readProxyAuthSecret } from '@yaac/server/drivers/k8s/substrate/stream-relay'
import { kubectl } from '@yaac/test-utils/kubectl'

const execFileAsync = promisify(execFile)

/**
 * The socket datapath (docs/workspace-egress.md). A workspace pod has no
 * network interface but loopback: netshim takes every TCP dial and DNS
 * query, and carries each connection through `egress.sock` to netd's
 * relay, which hands it to the proxy behind a header naming the sandbox.
 * The relay also carries streams and site requests in through the pod's
 * `ingress.sock`. Every dial connects, so each failure is asserted on a
 * completed request (docs/workspace-egress.md "Probe egress with real
 * requests").
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
/** Where each workspace pod serves its own name, for the site cases. */
const SITE_PORT = 8000

const MITM_HOST = 'api.anthropic.com' // always dynamically MITM'd by the proxy
const BLOCKED_HOST = 'blocked.example.com'
const CA_PATH = '/etc/yaac/certs/proxy-ca.pem'
const SINKHOLE = '198.18.0.1'

async function deleteTestObjects(name: string): Promise<void> {
  await deleteObject({ apiVersion: 'v1', kind: 'Pod', name, namespace: k8sNamespace() }, { gracePeriodSeconds: 1 })
    .catch(() => { /* ok */ })
  await deleteObject({ apiVersion: 'v1', kind: 'Service', name, namespace: k8sNamespace() }, { wait: true })
    .catch(() => { /* ok */ })
}

async function execInPod(
  podName: string,
  args: string[],
  opts: { timeout?: number; container?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return kubectl(['exec', '-n', k8sNamespace(), podName, ...(opts.container ? ['-c', opts.container] : []), '--', ...args], opts)
}

/** A plain pod with a Service in front, running `script` under node. */
async function startServicePod(name: string, script: string, port: number, servicePorts: Array<Record<string, unknown>>, env: Array<Record<string, string>> = []): Promise<string> {
  const ns = k8sNamespace()
  await applyObject({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: ns, labels: { 'app': name, 'yaac.test': 'true' } },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      containers: [{
        name: 'server', image: await resolveTestBaseImageRef(), imagePullPolicy: 'IfNotPresent',
        command: ['node', '-e', script], env, ports: [{ containerPort: port }],
      }],
    },
  })
  await applyObject({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: ns, labels: { 'yaac.test': 'true' } },
    spec: { type: 'ClusterIP', selector: { app: name }, ports: servicePorts },
  })
  await waitForPod(name)
  const svc = await readObject<{ spec?: { clusterIP?: string } }>({ apiVersion: 'v1', kind: 'Service', name, namespace: ns })
  if (!svc?.spec?.clusterIP) throw new Error(`${name} has no ClusterIP`)
  return svc.spec.clusterIP
}

/** HTTP echo (request mirror as JSON) on 8080 and 80; answers its ClusterIP. */
function startEchoPod(name: string): Promise<string> {
  const script = `
    require('http').createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
      });
    }).listen(${ECHO_PORT}, '0.0.0.0');
  `
  return startServicePod(name, script, ECHO_PORT, [
    { name: 'echo', port: ECHO_PORT, targetPort: ECHO_PORT },
    { name: 'http', port: 80, targetPort: ECHO_PORT },
  ])
}

/** TLS echo with its own self-signed (not proxy-CA) cert; answers its ClusterIP. */
async function startTlsEchoPod(name: string): Promise<string> {
  const certDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tls-echo-'))
  const keyPath = path.join(certDir, 'key.pem')
  const certPath = path.join(certDir, 'cert.pem')
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '2', '-nodes', '-subj', `/CN=${name}`,
  ])
  const [key, cert] = await Promise.all([fs.readFile(keyPath, 'utf8'), fs.readFile(certPath, 'utf8')])
  await fs.rm(certDir, { recursive: true, force: true })
  const script = `
    require('tls').createServer({ key: process.env.TLS_KEY, cert: process.env.TLS_CERT }, (sock) => {
      sock.on('error', () => {});
      sock.end('HTTP/1.1 200 OK\\r\\nContent-Length: 9\\r\\nConnection: close\\r\\n\\r\\nTUNNEL_OK');
    }).listen(${TLS_ECHO_PORT}, '0.0.0.0');
  `
  return startServicePod(name, script, TLS_ECHO_PORT, [{ port: 443, targetPort: TLS_ECHO_PORT }],
    [{ name: 'TLS_KEY', value: key }, { name: 'TLS_CERT', value: cert }])
}

/** Run curl in a pod, never failing the exec: emits `EXIT:<code>` last. */
async function curlInPod(pod: string, curlArgs: string): Promise<{ exit: number; out: string }> {
  const { stdout } = await execInPod(pod, [
    'sh', '-c', `curl -sS --max-time 20 ${curlArgs} 2>&1; printf '\nEXIT:%s\n' "$?"`,
  ], { timeout: 40_000 })
  const m = /EXIT:(\d+)\s*$/.exec(stdout)
  return { exit: m ? Number(m[1]) : -1, out: stdout }
}

/** Retry a curl until its output contains `needle`: a registration, a
 *  restart or a policy change takes a moment to apply. */
async function curlUntilOutput(
  pod: string, curlArgs: string, needle: string, timeoutMs = 90_000,
): Promise<{ exit: number; out: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const last = await curlInPod(pod, curlArgs)
    if (last.out.includes(needle) || Date.now() >= deadline) return last
    await new Promise((r) => setTimeout(r, 2000))
  }
}

function echoed(out: string): { method: string; url: string; headers: Record<string, string> } {
  return JSON.parse(out.slice(0, out.lastIndexOf('EXIT:'))) as { method: string; url: string; headers: Record<string, string> }
}

/** The pod's address (unused by anything, as its CNI gave it). */
async function podIp(name: string): Promise<string> {
  const pod = await readObject<{ status?: { podIP?: string } }>({ apiVersion: 'v1', kind: 'Pod', name, namespace: k8sNamespace() })
  if (!pod?.status?.podIP) throw new Error(`${name} has no address`)
  return pod.status.podIP
}

/** The running netd pod on the node `podName` runs on. */
async function netdPodFor(podName: string): Promise<string> {
  const pod = await readObject<{ spec?: { nodeName?: string } }>({ apiVersion: 'v1', kind: 'Pod', name: podName, namespace: k8sNamespace() })
  const netd = await listObjects<{ metadata?: { name?: string; deletionTimestamp?: string }; spec?: { nodeName?: string }; status?: { phase?: string } }>('v1', 'Pod', {
    namespace: k8sNamespace(), labelSelector: `app=${NETD_APP_NAME}`,
  })
  const name = netd.find((p) => p.spec?.nodeName === pod?.spec?.nodeName && p.status?.phase === 'Running'
    && p.metadata?.deletionTimestamp === undefined)?.metadata?.name
  if (!name) throw new Error(`no running netd on ${pod?.spec?.nodeName ?? 'its node'}`)
  return name
}

/** One exchange with a forwarded netd port: write `head`, read until the
 *  far end closes. A forward not yet accepting is retried. */
async function exchange(port: number, head: Buffer): Promise<string> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      return await exchangeOnce(port, head)
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

function exchangeOnce(port: number, head: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1')
    let out = ''
    c.setTimeout(20_000, () => { c.destroy(); resolve(`${out}<timeout>`) })
    c.on('connect', () => c.write(head))
    c.on('data', (d: Buffer) => { out += d.toString() })
    c.on('close', () => resolve(out))
    c.on('error', reject)
  })
}

/** A PROXY protocol v2 header carrying only TLV 0xE0 (`id`), as the router sends. */
function siteHeader(id: string): Buffer {
  const v = Buffer.from(id)
  const tlv = Buffer.concat([Buffer.from([0xe0, v.length >> 8, v.length & 0xff]), v])
  const addr = Buffer.from([127, 0, 0, 1, 127, 0, 0, 1, 0x9c, 0x40, 0, 80])
  const len = Buffer.alloc(2)
  len.writeUInt16BE(addr.length + tlv.length)
  return Buffer.concat([Buffer.from('0d0a0d0a000d0a515549540a2111', 'hex'), len, addr, tlv])
}

describe('socket egress', () => {
  const client = new ProxyClient(TEST_PROXY_CONFIG)
  const suffix = crypto.randomBytes(4).toString('hex')
  const echoName = `yaac-sock-echo-${suffix}`
  const tlsEchoName = `yaac-sock-tls-${suffix}`
  const podA = `yaac-sock-a-${suffix}`
  const podB = `yaac-sock-b-${suffix}`
  const workspaceA = crypto.randomUUID()
  const workspaceB = crypto.randomUUID()
  const siteId = crypto.randomUUID()

  let echoIp = ''
  let tlsIp = ''
  let registrationA: ProxyRegistration
  const forwards: KubectlForward[] = []

  beforeAll(async () => {
    await client.ensureRunning()
    await openTestPodsToProxy()
    ;[echoIp, tlsIp] = await Promise.all([startEchoPod(echoName), startTlsEchoPod(tlsEchoName)])

    // A: the MITM host redirected to the echo, and the echo's address
    // exactly (a non-public address, which only an exact entry admits).
    // B: only the TLS echo, for the tunnel.
    registrationA = {
      rules: [],
      allowedHosts: [MITM_HOST, echoIp],
      projectId: 'sock-a', owner: 'e2e',
      upstreamRedirects: { [MITM_HOST]: { host: echoIp, port: ECHO_PORT, tls: false } },
    }
    await applyProxyRegistration(workspaceA, registrationA)
    await applyProxyRegistration(workspaceB, { rules: [], allowedHosts: [tlsIp], projectId: 'sock-b', owner: 'e2e' })
    await Promise.all([startWorkspacePod(podA, workspaceA), startWorkspacePod(podB, workspaceB)])
    // Each serves its own name on SITE_PORT, for the site cases.
    for (const pod of [podA, podB]) {
      await execInPod(pod, ['sh', '-c', `nohup node -e "require('http').createServer((q, s) => s.end('${pod}')).listen(${SITE_PORT})" >/dev/null 2>&1 &`])
    }
  }, 600_000)

  afterAll(async () => {
    await Promise.all(forwards.map((f) => f.stop()))
    await deleteObject({ apiVersion: 'v1', kind: 'Service', name: siteServiceName(siteId), namespace: k8sNamespace() }).catch(() => { /* ok */ })
    await Promise.all([echoName, tlsEchoName, podA, podB].map((n) => deleteTestObjects(n)))
    await deregisterWorkspaceEgress(workspaceA)
    await deregisterWorkspaceEgress(workspaceB)
    try { await client.stop() } catch { /* ok */ }
  })

  it('shows a sandbox only loopback, the sinkhole for every name, and no socket', async () => {
    const ifaces = await execInPod(podA, ['sh', '-c', 'awk -F: \'NR > 2 { gsub(/ /, "", $1); print $1 }\' /proc/net/dev'])
    expect(ifaces.stdout.trim().split('\n')).toEqual(['lo'])
    // localhost names ::1 too, as getaddrinfo's AI_ADDRCONFIG would drop it
    // with no IPv6 address but ::1 (netshim puts a link-local one on lo).
    const localhost = await execInPod(podA, ['node', '-e',
      'const d = require("dns"); d.lookup("localhost", { all: true, hints: d.ADDRCONFIG }, (e, a) => console.log(a.map((x) => x.address).sort().join(" ")))'])
    expect(localhost.stdout.trim()).toBe('127.0.0.1 ::1')
    // Any name, an outside one or one of the install's own Services, is
    // the sinkhole: no name resolves to a real address.
    for (const name of ['anything.example', `${echoName}.${k8sNamespace()}.svc.cluster.local`, 'kubernetes.default']) {
      const r = await execInPod(podA, ['sh', '-c', `getent hosts ${name} || true`])
      expect(r.stdout, name).toContain(SINKHOLE)
    }
    // Only netshim's container mounts the socket directory.
    const socks = await execInPod(podA, ['sh', '-c', 'find / -xdev -type s 2>/dev/null; ls /run/yaac 2>&1 || true'])
    expect(socks.stdout).not.toContain('.sock')
    // Root in the workspace cannot change the network.
    const route = await execInPod(podA, ['sh', '-c', 'sudo -n ip route add 10.0.0.0/8 dev lo 2>&1; echo rc=$?'])
    expect(route.stdout).not.toContain('rc=0')
  }, 120_000)

  // The acceptance test (docs/workspace-egress.md): none of these answers,
  // each refused by the proxy on a completed request, while an allowlisted
  // host does.
  it('reaches an allowlisted host and nothing else: the server, the apiserver, a node, another sandbox, the internet', async () => {
    const ok = await curlUntilOutput(podA, `--cacert ${CA_PATH} https://${MITM_HOST}/v1/test`, '"/v1/test"')
    expect(echoed(ok.out)).toMatchObject({ method: 'GET', url: '/v1/test', headers: { host: MITM_HOST } })

    // The apiserver at one of its real endpoints: port 443 would be read as
    // TLS, which with no SNI is dropped rather than answered.
    const endpoints = await readObject<{ subsets?: Array<{ addresses?: Array<{ ip: string }>; ports?: Array<{ port: number }> }> }>({
      apiVersion: 'v1', kind: 'Endpoints', name: 'kubernetes', namespace: 'default',
    })
    const apiserverAddr = `${endpoints?.subsets?.[0]?.addresses?.[0]?.ip ?? '127.0.0.2'}:${String(endpoints?.subsets?.[0]?.ports?.[0]?.port ?? 6443)}`
    const nodes = await listObjects<{ status?: { addresses?: Array<{ type: string; address: string }> } }>('v1', 'Node')
    const nodeIp = nodes[0]?.status?.addresses?.find((a) => a.type === 'InternalIP')?.address
    const targets = [
      `http://yaac-server.${k8sNamespace()}.svc.cluster.local:8787/api/health`,
      `http://${apiserverAddr}/version`,
      `http://${nodeIp ?? '10.89.0.1'}:10250/pods`,
      `http://${await podIp(podB)}:${String(SITE_PORT)}/`,
      'http://1.1.1.1/',
    ]
    for (const url of targets) {
      const r = await curlInPod(podA, `-w '\\nHTTP:%{http_code}' '${url}'`)
      expect(r.out, url).toContain('HTTP:403')
    }
    // As root as well.
    const root = await execInPod(podA, ['sh', '-c', `sudo -n curl -sS --max-time 20 -w '\\nHTTP:%{http_code}' http://1.1.1.1/ 2>&1 || true`], { timeout: 40_000 })
    expect(root.stdout).toContain('HTTP:403')
    // TLS to a host outside the allowlist is dropped.
    const tls = await curlInPod(podA, `-k https://${BLOCKED_HOST}/`)
    expect(tls.exit).not.toBe(0)
  }, 180_000)

  it('judges each sandbox by its own registration', async () => {
    const fromB = await curlInPod(podB, `-k https://${MITM_HOST}/v1/test`)
    expect(fromB.exit).not.toBe(0)
    const fromA = await curlInPod(podA, `-w '\\nHTTP:%{http_code}' --proxy http://${SSH_TUNNEL_SENTINEL}:${String(TUNNEL_INGRESS_PORT)} -k https://${tlsIp}/`)
    expect(fromA.out).toContain('403')
  }, 60_000)

  it('forwards plain HTTP to an allowlisted address on any port, by the Host header', async () => {
    for (const port of [80, ECHO_PORT]) {
      const r = await curlInPod(podA, `"http://${echoIp}:${String(port)}/hello?x=1"`)
      expect(r.exit, r.out).toBe(0)
      expect(echoed(r.out)).toMatchObject({ url: '/hello?x=1' })
    }
  }, 60_000)

  it('tunnels a CONNECT on the SSH sentinel untouched', async () => {
    const r = await curlUntilOutput(podB, `--proxy http://${SSH_TUNNEL_SENTINEL}:${String(TUNNEL_INGRESS_PORT)} -k https://${tlsIp}/`, 'TUNNEL_OK')
    expect(r.out).toContain('TUNNEL_OK')
  }, 120_000)

  it('widens a live sandbox when a host is allowed', async () => {
    const before = await curlInPod(podB, `"http://${echoIp}/before"`)
    expect(before.out).toContain('Blocked by URL allowlist')
    await allowWorkspaceHost({ workspaceId: workspaceB, projectId: 'sock-b' }, echoIp, { fanOutToProject: false })
    const after = await curlUntilOutput(podB, `"http://${echoIp}/after"`, '"/after"')
    expect(echoed(after.out).url).toBe('/after')
  }, 120_000)

  it('refuses a stream dial without the secret, and one for a workspace not on its node', async () => {
    const netd = await netdPodFor(podA)
    const fwd = await startKubectlForward({ namespace: k8sNamespace(), target: `pod/${netd}`, remotePort: NETD_STREAM_PORT })
    forwards.push(fwd)
    const secret = await readProxyAuthSecret()
    const bad = await exchange(fwd.port, Buffer.from(`${JSON.stringify({ token: 'wrong', workspaceId: workspaceA })}\n`))
    expect(bad).toBe('')
    const unknown = await exchange(fwd.port, Buffer.from(`${JSON.stringify({ token: secret, workspaceId: crypto.randomUUID() })}\n`))
    expect(JSON.parse(unknown.trim())).toEqual({ ok: false, error: 'relay: unknown workspace' })
  }, 120_000)

  it('serves a site from its live release through the relay, and follows a flip', async () => {
    const service = (live: string): Record<string, unknown> => ({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: siteServiceName(siteId), namespace: k8sNamespace(),
        labels: { 'yaac.test': 'true' }, annotations: { 'yaac.live-workspace-id': live },
      },
      spec: { clusterIP: 'None', ports: [{ name: 'site', port: NETD_SITE_PORT, targetPort: SITE_PORT }] },
    })
    const netd = await netdPodFor(podA)
    const fwd = await startKubectlForward({ namespace: k8sNamespace(), target: `pod/${netd}`, remotePort: NETD_SITE_PORT })
    forwards.push(fwd)
    const get = (): Promise<string> => exchange(fwd.port, Buffer.concat([siteHeader(siteId), Buffer.from('GET / HTTP/1.0\r\n\r\n')]))
    const until = async (needle: string): Promise<string> => {
      const deadline = Date.now() + 60_000
      for (;;) {
        const out = await get().catch((err: unknown) => String(err))
        if (out.includes(needle) || Date.now() > deadline) return out
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    await applyObject(service(workspaceA))
    expect(await until(podA)).toContain(podA)
    await applyObject(service(workspaceB))
    expect(await until(podB)).toContain(podB)
    // A site with no live release on this node gets a close.
    await applyObject(service(''))
    expect(await until('<never>')).not.toContain('yaac-sock-')
  }, 180_000)

  it('keeps a running sandbox\'s egress across a netshim restart', async () => {
    const restarts = async (): Promise<number> => {
      const pod = await readObject<{ status?: { initContainerStatuses?: Array<{ name: string; restartCount: number }> } }>({
        apiVersion: 'v1', kind: 'Pod', name: podA, namespace: k8sNamespace(),
      })
      return pod?.status?.initContainerStatuses?.find((c) => c.name === 'netshim')?.restartCount ?? 0
    }
    const before = await restarts()
    await execInPod(podA, ['kill', '1'], { container: 'netshim' }).catch(() => { /* the exec dies with it */ })
    const deadline = Date.now() + 60_000
    while (await restarts() === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000))
    expect(await restarts()).toBeGreaterThan(before)
    const r = await curlUntilOutput(podA, `--cacert ${CA_PATH} https://${MITM_HOST}/after-netshim`, '"/after-netshim"')
    expect(echoed(r.out).url).toBe('/after-netshim')
  }, 180_000)

  // Last: it replaces the node's netd pod.
  it('keeps a running sandbox\'s egress across a relay restart, with no restart of its own', async () => {
    const old = await netdPodFor(podA)
    await deleteObject({ apiVersion: 'v1', kind: 'Pod', name: old, namespace: k8sNamespace() }, { wait: true })
    await kubectl(['rollout', 'status', `daemonset/${NETD_APP_NAME}`, '-n', k8sNamespace(), '--timeout=180s'], { timeout: 200_000 })
    expect(await netdPodFor(podA)).not.toBe(old)
    const r = await curlUntilOutput(podA, `--cacert ${CA_PATH} https://${MITM_HOST}/after-relay`, '"/after-relay"')
    expect(echoed(r.out).url).toBe('/after-relay')
  }, 300_000)
})

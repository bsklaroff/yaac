import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
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
import { e2eMkdtemp } from '@yaac/test-utils/tmp'
import { resolveTestBaseImageRef } from '@yaac/test-utils/mock-remotes'
import { ProxyClient } from '@yaac/server/drivers/k8s/egress/proxy-client'
import {
  applyWorktreeRegistration,
  deregisterWorkspaceEgress,
  type WorktreeRegistration,
} from '@yaac/server/drivers/k8s/egress/proxy-registration'
import { ensureNamespace, proxyServiceClusterIp, syncProxyCredentials } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import { runtimeClassSpec } from '@yaac/server/drivers/k8s/substrate/gvisor'
import { CA_CONFIGMAP_NAME } from '@yaac/server/drivers/k8s/substrate/pod-spec'
import { worktreeIdLabels } from '@yaac/server/drivers/k8s/substrate/pods'
import {
  PROXY_APP_NAME,
  PROXY_CA_SECRET_NAME,
  PROXY_REFRESHED_SECRET_NAME,
  PROXY_STATE_CONFIGMAP_NAME,
} from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@yaac/server/drivers/k8s/substrate/kubectl'
import { encodeOpenSshPrivateKey, generateSshKey } from '@yaac/server/lib/ssh-key'
import type { CredentialBundle } from '@yaac/server/drivers/contract'

const execFileAsync = promisify(execFile)

/**
 * End-to-end coverage of how the proxy is told and how it reports — the
 * objects (docs/worktree-egress.md "What the proxy is told, and how"),
 * driven from the host through the driver's own writers, with one echo
 * pod and one bare worktree pod shared by every case:
 *
 * - the credentials Secret is what injects (an api key, a git token), and
 *   rewriting it without a tool signs that tool out of a running worktree
 * - the ssh keys reach the agent through the same Secret
 * - a refresh a worktree drives is captured into `yaac-proxy-refreshed`
 * - a blocked host lands in `yaac-proxy-state`, and widening the
 *   registration object prunes it
 * - the pod is replaceable: delete it, and the replacement serves the same
 *   CA, the same registration and the same credentials with no server
 *   action — the case that proves the proxy is stateless.
 */

const ECHO_PORT = 8080
/** Never-routable TEST-NET-1 addresses the redirect must intercept. */
const FAKE_IP = '192.0.2.10'
const MITM_HOST = 'api.anthropic.com'
const TOKEN_HOST = 'platform.claude.com'
const GIT_HOST = 'github.com'
const BLOCKED_HOST = 'blocked.example.com'
const CA_PATH = '/etc/yaac/certs/proxy-ca.pem'
const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'
const PLACEHOLDER_ACCESS_TOKEN = 'yaac-ph-access'
const PLACEHOLDER_REFRESH_TOKEN = 'yaac-ph-refresh'

const EMPTY: CredentialBundle = { claude: null, codex: null, opencode: null, pi: null, git: [], ssh: [] }

let restoreNamespace: (() => void) | null = null
let tempDataDir: string | null = null
let keyDir: string | null = null

const client = new ProxyClient(TEST_PROXY_CONFIG)

interface TestKey {
  privateKey: string
  fingerprint: string
  knownHostsEntry: string
}

/** A client key the way the server makes one, plus a host keypair whose
 *  public half becomes the known_hosts entry for `host`. */
async function makeTestKey(dir: string, host: string, name: string): Promise<TestKey> {
  const key = generateSshKey(`yaac ${name}`)
  const publicKeyPath = path.join(dir, `${name}.pub`)
  const hostKeyPath = path.join(dir, `${name}-hostkey`)
  await fs.writeFile(publicKeyPath, `${key.publicKey}\n`)
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', hostKeyPath, '-N', '', '-q'])
  const { stdout: lint } = await execFileAsync('ssh-keygen', ['-lf', publicKeyPath])
  const fingerprint = lint.trim().split(/\s+/)[1]
  const hostPub = await fs.readFile(`${hostKeyPath}.pub`, 'utf8')
  const [keyType, keyBlob] = hostPub.trim().split(/\s+/)
  return {
    privateKey: encodeOpenSshPrivateKey(key.seed, `yaac ${name}`),
    fingerprint,
    knownHostsEntry: `${host} ${keyType} ${keyBlob}`,
  }
}

async function deleteTestPod(name: string): Promise<void> {
  await kubectlWithRetry([
    'delete', 'pod', name, '-n', k8sNamespace(),
    '--ignore-not-found', '--wait=false', '--grace-period=1',
  ]).catch(() => { /* ok */ })
  await kubectlWithRetry([
    'delete', 'service', name, '-n', k8sNamespace(), '--ignore-not-found',
  ]).catch(() => { /* ok */ })
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

/**
 * HTTP echo (request mirror as JSON) that also plays an OAuth token
 * endpoint: `/v1/oauth/token` answers a rotation. Pod + Service.
 */
async function startEchoPod(name: string): Promise<{ host: string }> {
  const echoScript = `
    const http = require('http');
    http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/v1/oauth/token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            access_token: 'rotated-access', refresh_token: 'rotated-refresh',
            expires_in: 3600, scope: 'user:inference', token_type: 'Bearer',
            echoed: JSON.parse(body),
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
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
      ports: [{ name: 'echo', port: ECHO_PORT, targetPort: ECHO_PORT }],
    },
  })
  await waitForPodRunning(name)
  return { host: `${name}.${ns}.svc` }
}

/** A bare worktree pod: the worktree label, the proxy-CA mount, and DNS
 *  pointed at the proxy. No sidecars — egress is redirected at the node. */
async function startWorktreePod(name: string, worktreeId: string, proxyHost: string): Promise<void> {
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: { ...worktreeIdLabels(worktreeId), 'yaac.test': 'true' },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...runtimeClassSpec(),
      dnsPolicy: 'None',
      dnsConfig: { nameservers: [proxyHost] },
      containers: [{
        name: 'session',
        image: await resolveTestBaseImageRef(),
        imagePullPolicy: 'IfNotPresent',
        volumeMounts: [{ name: 'proxy-ca', mountPath: '/etc/yaac/certs', readOnly: true }],
      }],
      volumes: [{ name: 'proxy-ca', configMap: { name: CA_CONFIGMAP_NAME } }],
    },
  })
}

/** Run curl in a pod, never failing the exec: emits `EXIT:<code>` last. */
async function curlInPod(pod: string, curlArgs: string): Promise<{ exit: number; out: string }> {
  const { stdout } = await kubectlWithRetry([
    'exec', '-n', k8sNamespace(), pod, '--',
    'sh', '-c', `curl -sS --max-time 20 ${curlArgs} 2>&1; printf '\\nEXIT:%s\\n' "$?"`,
  ], { timeout: 40_000 })
  const m = /EXIT:(\d+)\s*$/.exec(stdout)
  return { exit: m ? Number(m[1]) : -1, out: stdout }
}

interface Echoed { method: string; url: string; headers: Record<string, string>; body: string }

function echoedOf(out: string): Echoed {
  return JSON.parse(out.slice(0, out.lastIndexOf('EXIT:'))) as Echoed
}

/** Poll a curl until `accept` is satisfied — the objects reach the proxy
 *  within its watch latency, and a pod's first requests race endpoint
 *  programming. */
async function curlUntil(
  pod: string,
  curlArgs: string,
  accept: (r: { exit: number; out: string }) => boolean,
  timeoutMs = 60_000,
): Promise<{ exit: number; out: string }> {
  const deadline = Date.now() + timeoutMs
  let last: { exit: number; out: string } = { exit: -1, out: '(never ran)' }
  for (;;) {
    last = await curlInPod(pod, curlArgs)
    if (accept(last) || Date.now() >= deadline) return last
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** The MITM'd, redirected request every injection case sends. */
const probeArgs = (extra: string): string =>
  `--cacert ${CA_PATH} --resolve ${MITM_HOST}:443:${FAKE_IP} ${extra} https://${MITM_HOST}/v1/messages`

/** What the proxy's agent holds, read in its own pod. */
async function agentFingerprints(): Promise<string[]> {
  const { stdout } = await kubectlWithRetry([
    'exec', '-n', k8sNamespace(), `deployment/${PROXY_APP_NAME}`, '--',
    'sh', '-c', 'SSH_AUTH_SOCK=$HOME/agent.sock ssh-add -l || true',
  ], { timeout: 30_000 })
  return stdout.split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && parts[1]?.startsWith('SHA256:'))
    .map((parts) => parts[1])
}

async function pollUntil<T>(read: () => Promise<T>, accept: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    last = await read()
  }
  return last
}

interface RawObject { data?: Record<string, string> }
const readSecretKey = async (name: string, key: string): Promise<string | undefined> => {
  const obj = await kubectlGetJson<RawObject>(['get', 'secret', name, '-n', k8sNamespace()])
  const encoded = obj?.data?.[key]
  return encoded === undefined ? undefined : Buffer.from(encoded, 'base64').toString('utf8')
}
const readState = async (): Promise<{ blockedHosts: Record<string, string[]> }> => {
  const obj = await kubectlGetJson<RawObject>(['get', 'configmap', PROXY_STATE_CONFIGMAP_NAME, '-n', k8sNamespace()])
  return { blockedHosts: JSON.parse(obj?.data?.['blocked-hosts.json'] ?? '{}') as Record<string, string[]> }
}

describe('proxy credentials suite (objects in, objects out)', () => {
  const suffix = crypto.randomBytes(4).toString('hex')
  const echoName = `yaac-creds-echo-${suffix}`
  const podName = `yaac-creds-pod-${suffix}`
  const worktreeId = crypto.randomUUID()
  let echoHost = ''
  let registration: WorktreeRegistration

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
    restoreNamespace = useTestNamespace()
    tempDataDir = await createTempDataDir()
    keyDir = await e2eMkdtemp('yaac-proxy-creds-')
    // The credentials object before the proxy, so the pod boots with it —
    // and with claude signed OUT, which the first case relies on.
    await ensureNamespace()
    await syncProxyCredentials({
      ...EMPTY,
      git: [{ kind: 'https', pattern: `${GIT_HOST}/acme/*`, token: 'ghp-real-token' }],
    })
    await client.ensureRunning()
    const proxyHost = await proxyServiceClusterIp()
    const echo = await startEchoPod(echoName)
    echoHost = echo.host
    const redirect = { host: echoHost, port: ECHO_PORT, tls: false }
    registration = {
      rules: [],
      allowedHosts: [MITM_HOST, TOKEN_HOST, GIT_HOST],
      repoUrl: `https://${GIT_HOST}/acme/app.git`,
      tool: 'claude',
      projectSlug: 'creds-suite',
      upstreamRedirects: { [MITM_HOST]: redirect, [TOKEN_HOST]: redirect, [GIT_HOST]: redirect },
    }
    await applyWorktreeRegistration(worktreeId, registration)
    await startWorktreePod(podName, worktreeId, proxyHost)
    await waitForPodRunning(podName)
  }, 600_000)

  afterAll(async () => {
    await Promise.all([echoName, podName].map((n) => deleteTestPod(n)))
    await deregisterWorkspaceEgress(worktreeId)
    try { await client.stop() } catch { /* ok */ }
    restoreNamespace?.()
    restoreNamespace = null
    if (tempDataDir) await cleanupTempDir(tempDataDir)
    tempDataDir = null
    if (keyDir) await fs.rm(keyDir, { recursive: true, force: true })
    keyDir = null
  })

  it('forwards the placeholder untouched until the Secret carries a credential, then injects it', async () => {
    // Signed out: the sentinel travels as itself — the proxy never invents
    // a credential.
    const before = await curlUntil(podName, probeArgs(`-H 'x-api-key: ${PLACEHOLDER_API_KEY}'`),
      (r) => r.exit === 0)
    expect(before.exit, before.out).toBe(0)
    expect(echoedOf(before.out).headers['x-api-key']).toBe(PLACEHOLDER_API_KEY)
    // The git token was there from the start, gated on the worktree's
    // registered remote: an HTTPS request to that host carries it as Basic.
    const git = await curlInPod(podName,
      `--cacert ${CA_PATH} --resolve ${GIT_HOST}:443:${FAKE_IP} https://${GIT_HOST}/acme/app.git/info/refs?service=git-upload-pack`)
    expect(git.exit, git.out).toBe(0)
    expect(echoedOf(git.out).headers.authorization)
      .toBe('Basic ' + Buffer.from('x-access-token:ghp-real-token').toString('base64'))

    // Sign in: the object is rewritten, the proxy's informer applies it,
    // and the next request from the same pod carries the real key.
    await syncProxyCredentials({
      ...EMPTY,
      claude: { kind: 'api-key', savedAt: new Date().toISOString(), apiKey: 'sk-ant-real-key' },
      git: [{ kind: 'https', pattern: `${GIT_HOST}/acme/*`, token: 'ghp-real-token' }],
    })
    const after = await curlUntil(podName, probeArgs(`-H 'x-api-key: ${PLACEHOLDER_API_KEY}'`),
      (r) => r.exit === 0 && echoedOf(r.out).headers['x-api-key'] === 'sk-ant-real-key')
    expect(echoedOf(after.out).headers['x-api-key']).toBe('sk-ant-real-key')
    // A request that never carried the sentinel passes through unmodified.
    const own = await curlInPod(podName, probeArgs(`-H 'x-api-key: my-own-key'`))
    expect(echoedOf(own.out).headers['x-api-key']).toBe('my-own-key')
  }, 180_000)

  it('signs a running worktree out when the Secret is rewritten without the tool', async () => {
    await syncProxyCredentials({
      ...EMPTY,
      git: [{ kind: 'https', pattern: `${GIT_HOST}/acme/*`, token: 'ghp-real-token' }],
    })
    const r = await curlUntil(podName, probeArgs(`-H 'x-api-key: ${PLACEHOLDER_API_KEY}'`),
      (res) => res.exit === 0 && echoedOf(res.out).headers['x-api-key'] === PLACEHOLDER_API_KEY)
    expect(echoedOf(r.out).headers['x-api-key']).toBe(PLACEHOLDER_API_KEY)
  }, 120_000)

  it('loads the agent from the Secret’s ssh keys, and empties it with them', async () => {
    const keyA = await makeTestKey(keyDir!, 'git.a.example', 'key-a')
    const keyB = await makeTestKey(keyDir!, 'git.b.example', 'key-b')
    const withKeys = (keys: TestKey[]): CredentialBundle => ({
      ...EMPTY,
      ssh: keys.map((k, i) => ({
        pattern: `git.${i === 0 ? 'a' : 'b'}.example/*`,
        host: `git.${i === 0 ? 'a' : 'b'}.example`,
        privateKey: k.privateKey,
        knownHostsEntry: k.knownHostsEntry,
      })),
    })
    // Two hosts, so the known_hosts rewrite accumulates entries; the
    // upload is the regression case for ssh-add's `~` lookup (it must be
    // handed the file with -H, or it never finds the host key).
    await syncProxyCredentials(withKeys([keyA, keyB]))
    const loaded = await pollUntil(agentFingerprints, (f) => f.includes(keyA.fingerprint) && f.includes(keyB.fingerprint))
    expect(loaded).toEqual(expect.arrayContaining([keyA.fingerprint, keyB.fingerprint]))

    // Replace semantics: an emptied list empties the agent…
    await syncProxyCredentials(EMPTY)
    expect(await pollUntil(agentFingerprints, (f) => f.length === 0)).toEqual([])
    // …and a cleared agent accepts keys again.
    await syncProxyCredentials(withKeys([keyA]))
    expect(await pollUntil(agentFingerprints, (f) => f.includes(keyA.fingerprint))).toEqual([keyA.fingerprint])
  }, 180_000)

  it('captures a rotation a worktree drives into the refreshed Secret', async () => {
    await syncProxyCredentials({
      ...EMPTY,
      claude: {
        kind: 'oauth',
        savedAt: new Date().toISOString(),
        claudeAiOauth: {
          accessToken: 'real-access', refreshToken: 'real-refresh',
          expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'], subscriptionType: 'max',
        },
      },
    })
    // The pod holds placeholders; the proxy swaps the real refresh token
    // out, and swaps placeholders back into the response.
    const r = await curlUntil(podName,
      `--cacert ${CA_PATH} --resolve ${TOKEN_HOST}:443:${FAKE_IP} -X POST -H 'content-type: application/json' `
      + `-d '{"grant_type":"refresh_token","refresh_token":"${PLACEHOLDER_REFRESH_TOKEN}","client_id":"x"}' `
      + `https://${TOKEN_HOST}/v1/oauth/token`,
      (res) => res.exit === 0 && res.out.includes(PLACEHOLDER_ACCESS_TOKEN))
    expect(r.exit, r.out).toBe(0)
    const body = JSON.parse(r.out.slice(0, r.out.lastIndexOf('EXIT:'))) as {
      access_token: string; refresh_token: string; echoed: { refresh_token: string }
    }
    expect(body.access_token).toBe(PLACEHOLDER_ACCESS_TOKEN)
    expect(body.refresh_token).toBe(PLACEHOLDER_REFRESH_TOKEN)
    expect(body.echoed.refresh_token).toBe('real-refresh')

    // Durable the moment it was captured, in the host store's own shape.
    const captured = await pollUntil(
      () => readSecretKey(PROXY_REFRESHED_SECRET_NAME, 'claude.json'),
      (v) => v !== undefined && v.includes('rotated-access'),
    )
    expect(JSON.parse(captured!)).toMatchObject({
      kind: 'oauth',
      claudeAiOauth: { accessToken: 'rotated-access', refreshToken: 'rotated-refresh', scopes: ['user:inference'] },
    })
    // And served from here on, ahead of the bundle the server pushed.
    const next = await curlInPod(podName, probeArgs(`-H 'authorization: Bearer ${PLACEHOLDER_ACCESS_TOKEN}'`))
    expect(echoedOf(next.out).headers.authorization).toBe('Bearer rotated-access')
  }, 180_000)

  it('records a blocked host in the state ConfigMap, and widening the registration prunes it', async () => {
    const blocked = await curlInPod(podName, `-k --resolve ${BLOCKED_HOST}:443:${FAKE_IP} https://${BLOCKED_HOST}/`)
    expect(blocked.exit).not.toBe(0)
    const recorded = await pollUntil(readState, (s) => (s.blockedHosts[worktreeId] ?? []).includes(BLOCKED_HOST))
    expect(recorded.blockedHosts[worktreeId]).toContain(BLOCKED_HOST)

    // The widening is a rewrite of the registration object; the proxy
    // applies it and prunes the record, which is what clears the badge.
    registration = {
      ...registration,
      allowedHosts: [...registration.allowedHosts, BLOCKED_HOST],
      upstreamRedirects: { ...registration.upstreamRedirects, [BLOCKED_HOST]: { host: echoHost, port: ECHO_PORT, tls: false } },
    }
    await applyWorktreeRegistration(worktreeId, registration)
    const allowed = await curlUntil(podName,
      `--cacert ${CA_PATH} --resolve ${BLOCKED_HOST}:443:${FAKE_IP} https://${BLOCKED_HOST}/after`,
      (r) => r.exit === 0)
    expect(allowed.exit, allowed.out).toBe(0)
    const pruned = await pollUntil(readState, (s) => !(s.blockedHosts[worktreeId] ?? []).includes(BLOCKED_HOST))
    expect(pruned.blockedHosts[worktreeId] ?? []).not.toContain(BLOCKED_HOST)
  }, 180_000)

  // LAST: it replaces the shared proxy pod.
  it('is replaceable: a fresh pod serves the same CA, registration and credentials with no server action', async () => {
    const caBefore = await readSecretKey(PROXY_CA_SECRET_NAME, 'ca.pem')
    expect(caBefore).toContain('BEGIN CERTIFICATE')
    await syncProxyCredentials({
      ...EMPTY,
      claude: { kind: 'api-key', savedAt: new Date().toISOString(), apiKey: 'sk-ant-survives' },
    })
    await curlUntil(podName, probeArgs(`-H 'x-api-key: ${PLACEHOLDER_API_KEY}'`),
      (r) => r.exit === 0 && echoedOf(r.out).headers['x-api-key'] === 'sk-ant-survives')

    await kubectlWithRetry([
      'delete', 'pod', '-l', `app=${PROXY_APP_NAME}`, '-n', k8sNamespace(), '--wait=false',
    ])
    await kubectlWithRetry([
      'rollout', 'status', `deployment/${PROXY_APP_NAME}`, '-n', k8sNamespace(), '--timeout=180s',
    ], { timeout: 190_000 })

    // Nothing was pushed, seeded or re-registered in between: the
    // replacement read everything back from the apiserver.
    expect(await readSecretKey(PROXY_CA_SECRET_NAME, 'ca.pem')).toBe(caBefore)
    const r = await curlUntil(podName, probeArgs(`-H 'x-api-key: ${PLACEHOLDER_API_KEY}'`),
      (res) => res.exit === 0 && echoedOf(res.out).headers['x-api-key'] === 'sk-ant-survives', 120_000)
    expect(r.exit, r.out).toBe(0)
    expect(echoedOf(r.out).headers['x-api-key']).toBe('sk-ant-survives')
    // The mounted CA still verifies the replacement's leaves (--cacert
    // above), so the CA it serves is the one it read back.
  }, 300_000)
})

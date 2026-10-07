import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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
import { resolveTestBaseImageRef } from '@yaac/test-utils/test-pods'
import { startWorkspacePod, waitForPod } from '@yaac/test-utils/test-pods'
import { ProxyClient } from '@yaac/server/drivers/k8s/egress/proxy-client'
import {
  applyProxyRegistration,
  deregisterWorkspaceEgress,
  type ProxyRegistration,
} from '@yaac/server/drivers/k8s/egress/proxy-registration'
import { ensureNamespace, proxyServiceClusterIp, syncProxyCredentials } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import {
  PROXY_APP_NAME,
  PROXY_CA_SECRET_NAME,
  PROXY_REFRESHED_SECRET_NAME,
  PROXY_STATE_CONFIGMAP_NAME,
} from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import { applyObject, deleteObject, deleteObjects, k8sNamespace, readObject } from '@yaac/server/drivers/k8s/substrate/api'
import { kubectl } from '@yaac/test-utils/kubectl'
import { encodeOpenSshPrivateKey, generateSshKey } from '@yaac/server/lib/ssh-key'
import type { CredentialBundle } from '@yaac/server/drivers/contract'

const execFileAsync = promisify(execFile)

/**
 * The Kubernetes objects that configure the proxy and that it reports
 * through (docs/workspace-egress.md, "What the proxy is told, and how"),
 * written by the driver's own writers. One echo pod and one bare workspace
 * pod are shared by every case:
 *
 * - the credentials Secret drives injection (api key, git token); removing
 *   a tool from it signs that tool out, and a git token reaches only its
 *   assigned projects
 * - ssh keys reach the proxy's agent through the same Secret
 * - a workspace-driven refresh is captured into `yaac-proxy-refreshed`, and
 *   a burst of them spends the credential upstream once
 * - a blocked host lands in `yaac-proxy-state` until the registration is
 *   widened
 * - a replacement proxy pod serves the same CA, registration and
 *   credentials with no server action, so the proxy is stateless
 */

const ECHO_PORT = 8080
/** Never-routable TEST-NET-1 address the redirect must intercept. */
const FAKE_IP = '192.0.2.10'
const MITM_HOST = 'api.anthropic.com'
/** claude's claude.ai connectors send the same OAuth bearer here. */
const MCP_PROXY_HOST = 'mcp-proxy.anthropic.com'
const TOKEN_HOST = 'platform.claude.com'
const GIT_HOST = 'github.com'
const BLOCKED_HOST = 'blocked.example.com'
const CA_PATH = '/etc/yaac/certs/proxy-ca.pem'
const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'
const PLACEHOLDER_ACCESS_TOKEN = 'yaac-ph-access'
const PLACEHOLDER_REFRESH_TOKEN = 'yaac-ph-refresh'

const EMPTY: CredentialBundle = { claude: null, codex: null, opencode: null, pi: null, git: [], ssh: [] }
/** The owner the suite's workspace registers under. */
const OWNER = 'suite-owner'
/** Replace the credentials Secret with `bundle` as OWNER's, plus `others`. */
const syncCredentials = (bundle: CredentialBundle, others: Record<string, CredentialBundle> = {}): Promise<void> =>
  syncProxyCredentials({ [OWNER]: bundle, ...others })
/** The git token, assigned to the suite workspace's project. */
const GIT_TOKENS: CredentialBundle['git'] = [{ token: 'ghp-real-token', projects: ['creds-suite'] }]

let restoreNamespace: (() => void) | null = null
let tempDataDir: string | null = null
let keyDir: string | null = null

const client = new ProxyClient(TEST_PROXY_CONFIG)

interface TestKey {
  privateKey: string
  publicKey: string
  fingerprint: string
  knownHostsEntry: string
}

/**
 * A client key made the way the server makes one, plus a host keypair
 * whose public half becomes the known_hosts entry for `host`.
 */
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
    publicKey: key.publicKey,
    fingerprint,
    knownHostsEntry: `${host} ${keyType} ${keyBlob}`,
  }
}

async function deleteTestPod(name: string): Promise<void> {
  await deleteObject({ apiVersion: 'v1', kind: 'Pod', name, namespace: k8sNamespace() }, { gracePeriodSeconds: 1 })
    .catch(() => { /* ok */ })
  await deleteObject({ apiVersion: 'v1', kind: 'Service', name, namespace: k8sNamespace() }, { wait: true })
    .catch(() => { /* ok */ })
}

/**
 * HTTP echo (request mirror as JSON) that also plays an OAuth token
 * endpoint: `/v1/oauth/token` answers a rotation numbered by how many it
 * has minted, and echoes that count as `rotations`. Pod + Service.
 */
async function startEchoPod(name: string): Promise<{ host: string }> {
  const echoScript = `
    const http = require('http');
    let rotations = 0;
    http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/v1/oauth/token') {
          rotations += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            access_token: 'rotated-access-' + rotations, refresh_token: 'rotated-refresh-' + rotations,
            expires_in: 3600, scope: 'user:inference', token_type: 'Bearer',
            echoed: JSON.parse(body), rotations,
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
  await applyObject({
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
  await applyObject({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: ns, labels: { 'yaac.test': 'true' } },
    spec: {
      type: 'ClusterIP',
      selector: { app: name },
      ports: [{ name: 'echo', port: ECHO_PORT, targetPort: ECHO_PORT }],
    },
  })
  await waitForPod(name)
  return { host: `${name}.${ns}.svc` }
}

/** Run curl in a pod, never failing the exec: emits `EXIT:<code>` last. */
async function curlInPod(pod: string, curlArgs: string): Promise<{ exit: number; out: string }> {
  const { stdout } = await kubectl([
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

/**
 * Retry a curl until `accept` holds: object changes reach the proxy after
 * a watch delay, and a new pod's first requests can beat its networking.
 */
async function curlUntil(
  pod: string,
  curlArgs: string,
  accept: (r: { exit: number; out: string }) => boolean,
  timeout = 60_000,
): Promise<{ exit: number; out: string }> {
  return vi.waitFor(async () => {
    const r = await curlInPod(pod, curlArgs)
    if (!accept(r)) throw new Error(`curl not accepted yet (exit ${String(r.exit)}):\n${r.out}`)
    return r
  }, { timeout, interval: 1000 })
}

/** The MITM'd, redirected request every injection case sends. */
const probeArgs = (extra: string, host = MITM_HOST): string =>
  `--cacert ${CA_PATH} --resolve ${host}:443:${FAKE_IP} ${extra} https://${host}/v1/messages`

/** A refresh the way a workspace sends one: presenting the placeholder. */
const refreshArgs = `--cacert ${CA_PATH} --resolve ${TOKEN_HOST}:443:${FAKE_IP} -X POST `
  + `-H 'content-type: application/json' `
  + `-d '{"grant_type":"refresh_token","refresh_token":"${PLACEHOLDER_REFRESH_TOKEN}","client_id":"x"}' `
  + `https://${TOKEN_HOST}/v1/oauth/token`

interface RefreshReply {
  access_token: string
  refresh_token: string
  rotations: number
  echoed: { refresh_token: string }
}

/** An HTTPS git request to the workspace's registered remote. */
const gitProbe = `--cacert ${CA_PATH} --resolve ${GIT_HOST}:443:${FAKE_IP} https://${GIT_HOST}/acme/app.git/info/refs?service=git-upload-pack`

/** What the proxy's agent holds, read in its own pod. */
async function agentFingerprints(): Promise<string[]> {
  const { stdout } = await kubectl([
    'exec', '-n', k8sNamespace(), `deployment/${PROXY_APP_NAME}`, '--',
    'sh', '-c', 'SSH_AUTH_SOCK=$HOME/agent.sock ssh-add -l || true',
  ], { timeout: 30_000 })
  return stdout.split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && parts[1]?.startsWith('SHA256:'))
    .map((parts) => parts[1])
}


interface RawObject { data?: Record<string, string> }
const readSecretKey = async (name: string, key: string): Promise<string | undefined> => {
  const obj = await readObject<RawObject>({ apiVersion: 'v1', kind: 'Secret', name, namespace: k8sNamespace() })
  const encoded = obj?.data?.[key]
  return encoded === undefined ? undefined : Buffer.from(encoded, 'base64').toString('utf8')
}
const readState = async (): Promise<{ blockedHosts: Record<string, string[]> }> => {
  const obj = await readObject<RawObject>({
    apiVersion: 'v1', kind: 'ConfigMap', name: PROXY_STATE_CONFIGMAP_NAME, namespace: k8sNamespace(),
  })
  return { blockedHosts: JSON.parse(obj?.data?.['blocked-hosts.json'] ?? '{}') as Record<string, string[]> }
}

describe('proxy credentials suite (objects in, objects out)', () => {
  const suffix = crypto.randomBytes(4).toString('hex')
  const echoName = `yaac-creds-echo-${suffix}`
  const podName = `yaac-creds-pod-${suffix}`
  const workspaceId = crypto.randomUUID()
  let echoHost = ''
  let registration: ProxyRegistration

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
    restoreNamespace = useTestNamespace()
    tempDataDir = await createTempDataDir()
    keyDir = await e2eMkdtemp('yaac-proxy-creds-')
    // Write credentials before the proxy starts, with claude signed out
    // (the first case relies on that).
    await ensureNamespace()
    await syncCredentials({
      ...EMPTY,
      git: GIT_TOKENS,
    })
    await client.ensureRunning()
    const proxyHost = await proxyServiceClusterIp()
    const echo = await startEchoPod(echoName)
    echoHost = echo.host
    const redirect = { host: echoHost, port: ECHO_PORT, tls: false }
    registration = {
      rules: [],
      allowedHosts: [MITM_HOST, MCP_PROXY_HOST, TOKEN_HOST, GIT_HOST],
      repoUrl: `https://${GIT_HOST}/acme/app.git`,
      tool: 'claude',
      projectId: 'creds-suite',
      owner: OWNER,
      upstreamRedirects: {
        [MITM_HOST]: redirect, [MCP_PROXY_HOST]: redirect, [TOKEN_HOST]: redirect, [GIT_HOST]: redirect,
      },
    }
    await applyProxyRegistration(workspaceId, registration)
    await startWorkspacePod(podName, workspaceId, proxyHost)
  }, 600_000)

  afterAll(async () => {
    await Promise.all([echoName, podName].map((n) => deleteTestPod(n)))
    await deregisterWorkspaceEgress(workspaceId)
    try { await client.stop() } catch { /* ok */ }
    restoreNamespace?.()
    restoreNamespace = null
    if (tempDataDir) await cleanupTempDir(tempDataDir)
    tempDataDir = null
    if (keyDir) await fs.rm(keyDir, { recursive: true, force: true })
    keyDir = null
  })

  it('forwards the placeholder untouched until the Secret carries a credential, then injects it', async () => {
    // Signed out, so the placeholder passes through unchanged.
    const before = await curlUntil(podName, probeArgs(`-H 'x-api-key: ${PLACEHOLDER_API_KEY}'`),
      (r) => r.exit === 0)
    expect(before.exit, before.out).toBe(0)
    expect(echoedOf(before.out).headers['x-api-key']).toBe(PLACEHOLDER_API_KEY)
    // The git token is assigned to this project, so a request to its
    // remote carries it as Basic auth.
    const git = await curlInPod(podName, gitProbe)
    expect(git.exit, git.out).toBe(0)
    expect(echoedOf(git.out).headers.authorization)
      .toBe('Basic ' + Buffer.from('x-access-token:ghp-real-token').toString('base64'))

    // Sign in by rewriting the Secret; the same pod then gets the real key.
    await syncCredentials({
      ...EMPTY,
      claude: { kind: 'api-key', savedAt: new Date().toISOString(), apiKey: 'sk-ant-real-key' },
      git: GIT_TOKENS,
    })
    const after = await curlUntil(podName, probeArgs(`-H 'x-api-key: ${PLACEHOLDER_API_KEY}'`),
      (r) => r.exit === 0 && echoedOf(r.out).headers['x-api-key'] === 'sk-ant-real-key')
    expect(echoedOf(after.out).headers['x-api-key']).toBe('sk-ant-real-key')
    // A request without the placeholder is not modified.
    const own = await curlInPod(podName, probeArgs(`-H 'x-api-key: my-own-key'`))
    expect(echoedOf(own.out).headers['x-api-key']).toBe('my-own-key')
  }, 180_000)

  it('serves a chain a strict X.509 verifier accepts', async () => {
    // Python 3.13+ sets VERIFY_X509_STRICT by default; the image has 3.12.
    const script = [
      'import socket, ssl',
      `c = ssl.create_default_context(cafile='${CA_PATH}')`,
      'c.verify_flags |= ssl.VERIFY_X509_STRICT',
      `c.wrap_socket(socket.create_connection(('${FAKE_IP}', 443), timeout=20), server_hostname='${MITM_HOST}').close()`,
    ].join('\n')
    await kubectl(['exec', '-n', k8sNamespace(), podName, '--', 'python3', '-c', script], { timeout: 40_000 })
  }, 60_000)

  it('signs a running workspace out when the Secret is rewritten without the tool', async () => {
    await syncCredentials({
      ...EMPTY,
      git: GIT_TOKENS,
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
        privateKey: k.privateKey,
        publicKey: k.publicKey,
        projects: [{ projectId: 'creds-suite', host: `git.${i === 0 ? 'a' : 'b'}.example`, knownHostsEntry: k.knownHostsEntry }],
      })),
    })
    // Two hosts, so known_hosts has several entries. ssh-add must be given
    // the file with -H or it never finds the host key.
    await syncCredentials(withKeys([keyA, keyB]))
    const agentHolds = (expected: unknown): Promise<void> =>
      vi.waitFor(async () => expect(await agentFingerprints()).toEqual(expected), { timeout: 30_000, interval: 500 })
    await agentHolds(expect.arrayContaining([keyA.fingerprint, keyB.fingerprint]))

    // An empty list empties the agent...
    await syncCredentials(EMPTY)
    await agentHolds([])
    // ...and a cleared agent accepts keys again.
    await syncCredentials(withKeys([keyA]))
    await agentHolds([keyA.fingerprint])
  }, 180_000)

  it('captures a rotation a workspace drives, spending the credential once for a burst', async () => {
    await syncCredentials({
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
    // Wait for the credentials via a request that spends nothing.
    await curlUntil(podName, probeArgs(`-H 'authorization: Bearer ${PLACEHOLDER_ACCESS_TOKEN}'`),
      (r) => r.exit === 0 && echoedOf(r.out).headers.authorization === 'Bearer real-access')

    // Two concurrent refreshes, then a third. The proxy spends the real
    // refresh token once and hands every caller that rotation as
    // placeholders; a second spend would get invalid_grant, which makes
    // claude wipe its shared credentials file.
    const { stdout } = await kubectl([
      'exec', '-n', k8sNamespace(), podName, '--', 'sh', '-c',
      `curl -sS --max-time 20 ${refreshArgs} > /tmp/r1 & curl -sS --max-time 20 ${refreshArgs} > /tmp/r2 & wait; `
      + `curl -sS --max-time 20 ${refreshArgs} > /tmp/r3; `
      + 'cat /tmp/r1; echo; cat /tmp/r2; echo; cat /tmp/r3',
    ], { timeout: 60_000 })
    const replies = stdout.trim().split('\n').map((l) => JSON.parse(l) as RefreshReply)
    expect(replies).toHaveLength(3)
    for (const reply of replies) {
      expect(reply.access_token).toBe(PLACEHOLDER_ACCESS_TOKEN)
      expect(reply.refresh_token).toBe(PLACEHOLDER_REFRESH_TOKEN)
      expect(reply.echoed.refresh_token).toBe('real-refresh')
      expect(reply.rotations).toBe(replies[0].rotations)
    }
    const rotated = `rotated-access-${replies[0].rotations}`

    // Captured in the host store's shape.
    const captured = await vi.waitFor(async () => {
      const v = await readSecretKey(PROXY_REFRESHED_SECRET_NAME, `${OWNER}.claude.json`)
      expect(v).toContain(rotated)
      return v!
    }, { timeout: 30_000, interval: 500 })
    expect(JSON.parse(captured)).toMatchObject({
      kind: 'oauth',
      claudeAiOauth: {
        accessToken: rotated,
        refreshToken: `rotated-refresh-${replies[0].rotations}`,
        scopes: ['user:inference'],
      },
    })
    // The captured token wins over the pushed one, for inference and the
    // claude.ai connectors, so a starting claude is not forced to refresh.
    for (const host of [MITM_HOST, MCP_PROXY_HOST]) {
      const next = await curlInPod(podName, probeArgs(`-H 'authorization: Bearer ${PLACEHOLDER_ACCESS_TOKEN}'`, host))
      expect(echoedOf(next.out).headers.authorization, host).toBe(`Bearer ${rotated}`)
    }
  }, 180_000)

  it('records a blocked host in the state ConfigMap, and widening the registration prunes it', async () => {
    const blocked = await curlInPod(podName, `-k --resolve ${BLOCKED_HOST}:443:${FAKE_IP} https://${BLOCKED_HOST}/`)
    expect(blocked.exit).not.toBe(0)
    const blockedHosts = async (): Promise<string[]> => (await readState()).blockedHosts[workspaceId] ?? []
    await vi.waitFor(async () => expect(await blockedHosts()).toContain(BLOCKED_HOST), { timeout: 30_000, interval: 500 })

    // Widening the registration prunes the blocked-host record.
    registration = {
      ...registration,
      allowedHosts: [...registration.allowedHosts, BLOCKED_HOST],
      upstreamRedirects: { ...registration.upstreamRedirects, [BLOCKED_HOST]: { host: echoHost, port: ECHO_PORT, tls: false } },
    }
    await applyProxyRegistration(workspaceId, registration)
    const allowed = await curlUntil(podName,
      `--cacert ${CA_PATH} --resolve ${BLOCKED_HOST}:443:${FAKE_IP} https://${BLOCKED_HOST}/after`,
      (r) => r.exit === 0)
    expect(allowed.exit, allowed.out).toBe(0)
    await vi.waitFor(async () => expect(await blockedHosts()).not.toContain(BLOCKED_HOST), { timeout: 30_000, interval: 500 })
  }, 180_000)

  it('injects a git token only into workspaces of the projects it is assigned to', async () => {
    await syncCredentials({ ...EMPTY, git: GIT_TOKENS })
    await curlUntil(podName, gitProbe, (r) => r.exit === 0 && echoedOf(r.out).headers.authorization !== undefined)
    // Re-registered under a project the token is not assigned to.
    await applyProxyRegistration(workspaceId, { ...registration, projectId: 'creds-other' })
    try {
      const r = await curlUntil(podName, gitProbe,
        (res) => res.exit === 0 && echoedOf(res.out).headers.authorization === undefined)
      expect(r.exit, r.out).toBe(0)
      expect(echoedOf(r.out).headers.authorization).toBeUndefined()
    } finally {
      await applyProxyRegistration(workspaceId, registration)
    }
  }, 180_000)

  it('serves a workspace only its own owner\'s credentials', async () => {
    const otherKey = { ...EMPTY, claude: { kind: 'api-key' as const, savedAt: new Date().toISOString(), apiKey: 'sk-ant-other' } }
    // Another owner signed in, this one signed out: the placeholder travels
    // untouched, and the git token stays this owner's.
    await syncCredentials({ ...EMPTY, git: GIT_TOKENS }, { other: { ...otherKey, git: [{ token: 'ghp-other', projects: ['creds-suite'] }] } })
    await curlUntil(podName, gitProbe, (r) => r.exit === 0
      && echoedOf(r.out).headers.authorization === 'Basic ' + Buffer.from('x-access-token:ghp-real-token').toString('base64'))
    const mine = await curlInPod(podName, probeArgs(`-H 'x-api-key: ${PLACEHOLDER_API_KEY}'`))
    expect(echoedOf(mine.out).headers['x-api-key']).toBe(PLACEHOLDER_API_KEY)

    // Re-registered under the other owner, the same pod gets that owner's.
    await applyProxyRegistration(workspaceId, { ...registration, owner: 'other' })
    try {
      const theirs = await curlUntil(podName, probeArgs(`-H 'x-api-key: ${PLACEHOLDER_API_KEY}'`),
        (r) => r.exit === 0 && echoedOf(r.out).headers['x-api-key'] === 'sk-ant-other')
      expect(echoedOf(theirs.out).headers['x-api-key']).toBe('sk-ant-other')
      const git = await curlInPod(podName, gitProbe)
      expect(echoedOf(git.out).headers.authorization)
        .toBe('Basic ' + Buffer.from('x-access-token:ghp-other').toString('base64'))
    } finally {
      await applyProxyRegistration(workspaceId, registration)
    }
  }, 180_000)

  // These run last: they replace the shared proxy pod.
  it('is replaceable: a fresh pod serves the same CA, registration and credentials with no server action', async () => {
    const caBefore = await readSecretKey(PROXY_CA_SECRET_NAME, 'ca.pem')
    expect(caBefore).toContain('BEGIN CERTIFICATE')
    await syncCredentials({
      ...EMPTY,
      claude: { kind: 'api-key', savedAt: new Date().toISOString(), apiKey: 'sk-ant-survives' },
    })
    await curlUntil(podName, probeArgs(`-H 'x-api-key: ${PLACEHOLDER_API_KEY}'`),
      (r) => r.exit === 0 && echoedOf(r.out).headers['x-api-key'] === 'sk-ant-survives')

    await deleteObjects('v1', 'Pod', { namespace: k8sNamespace(), labelSelector: `app=${PROXY_APP_NAME}` })
    await kubectl([
      'rollout', 'status', `deployment/${PROXY_APP_NAME}`, '-n', k8sNamespace(), '--timeout=180s',
    ], { timeout: 190_000 })

    // Nothing was rewritten, so the replacement read it all back from the
    // apiserver.
    expect(await readSecretKey(PROXY_CA_SECRET_NAME, 'ca.pem')).toBe(caBefore)
    const r = await curlUntil(podName, probeArgs(`-H 'x-api-key: ${PLACEHOLDER_API_KEY}'`),
      (res) => res.exit === 0 && echoedOf(res.out).headers['x-api-key'] === 'sk-ant-survives', 120_000)
    expect(r.exit, r.out).toBe(0)
    expect(echoedOf(r.out).headers['x-api-key']).toBe('sk-ant-survives')
    // The mounted CA still verifies the replacement's leaves (--cacert
    // above), so the CA it serves is the one it read back.
  }, 300_000)
})

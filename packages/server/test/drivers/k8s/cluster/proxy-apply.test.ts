import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'

// Everything faked here is a process boundary or another feature's barrel:
// kubectl, podman (execFileAsync / the container runtime), the local
// registry's HTTP calls, and the image feature's build pipeline. Nothing
// inside features/cluster is mocked — so `ensureProxyResources` drives the
// real proxy manifests, the real policy set, the real cluster-CIDR probes,
// and the real netd (which is internal to the folder and covered only here
// and through cluster install).
vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

// netd promisifies node:child_process itself, so podman is faked at that
// boundary rather than through kubectl's execFileAsync.
vi.mock('node:child_process', () => ({
  execFile: vi.fn((...allArgs: unknown[]) => {
    const args = allArgs[1] as string[]
    const cb = allArgs[allArgs.length - 1] as (...cbArgs: unknown[]) => void
    // `podman image inspect --format {{.Architecture}}` — answer with the
    // host arch so the mirror's arch guard passes.
    const isArchProbe = args.includes('inspect') && args.some((a) => a.includes('Architecture'))
    cb(null, { stdout: isArchProbe ? hostArch() : '', stderr: '' })
  }),
}))

vi.mock('#drivers/k8s/container/registry', () => ({
  registryHasTag: vi.fn().mockResolvedValue(true),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))

vi.mock('#drivers/k8s/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(true),
}))

// netd's image is produced on the CLI machine by `yaac cluster install`;
// everything here only ever looks its content-hash tag up, so the real
// refusal (missingPrebuiltImage) is kept and only the hash is faked.
vi.mock('#drivers/k8s/image-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof imageEngineModule>()),
  contextHash: vi.fn().mockResolvedValue('deadbeefcafe1234'),
  buildImage: vi.fn().mockResolvedValue(undefined),
  registerImageBuild: vi.fn(() => 'build-1'),
  finishImageBuild: vi.fn(),
  failImageBuild: vi.fn(),
}))
import type * as imageEngineModule from '#drivers/k8s/image-engine'

import {
  ensureBuilderRoleGuard,
  ensureCaConfigMap,
  ensureNamespace,
  ensureProxyAuthSecret,
  ensureProxyResources,
  proxyServiceClusterIp,
  removeProjectSecrets,
  resetProxyClusterIpCache,
  syncProjectSecrets,
  syncProxyCredentials,
  vapAvailable,
} from '#drivers/k8s/cluster'
import { globalPath, globalRoot } from '@yaac/shared/project-paths'
import { resetClusterCidrCache } from '#drivers/k8s/cluster/cluster-cidrs'
import {
  DNS_STUB_PORT,
  EGRESS_WORLD_DENY_NAME,
  NETD_APP_NAME,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_PORT_END,
  POD_STREAM_PORT,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_INGRESS_NP_NAME,
  PROXY_PORT,
  PROXY_SA_NAME,
  RELAY_PORT,
  WORKTREE_EGRESS_NP_NAME,
  WORKTREE_INGRESS_LOCK_NP_NAME,
  SSH_AGENT_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
} from '#drivers/k8s/substrate/proxy-constants'
import { LABEL_DATA_DIR_HASH, LABEL_WORKTREE_ID } from '#drivers/k8s/substrate/pods'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#drivers/k8s/substrate/kubectl'
import { imageExists } from '#drivers/k8s/container/runtime'
import { registryHasTag } from '#drivers/k8s/container/registry'
import { buildImage, registerImageBuild } from '#drivers/k8s/image-engine'
import { serverLog } from '#log'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { execFile } from 'node:child_process'
import path from 'node:path'

vi.mock('#log', () => ({ serverLog: vi.fn() }))

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockPodman = vi.mocked(execFile)
/** podman's arch string for this host, as assertMirrorArch expects it. */
function hostArch(): string {
  return process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch
}
/** The argv of every podman invocation recorded by the child_process fake. */
const podmanArgs = (): string[][] =>
  mockPodman.mock.calls.map((c) => c[1] as string[])
const mockImageExists = vi.mocked(imageExists)
const mockHasTag = vi.mocked(registryHasTag)

const NODE_IP = '10.89.0.7'

interface Manifest {
  kind: string
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  spec?: Record<string, unknown>
  data?: Record<string, string>
  rules?: Array<{ resources: string[]; resourceNames?: string[]; verbs: string[] }>
}

const b64d = (s: string): string => Buffer.from(s, 'base64').toString('utf8')

interface Rule {
  to?: Array<Record<string, unknown>>
  from?: Array<Record<string, unknown>>
  ports?: Array<{ protocol: string; port: number; endPort?: number }>
}

let tmpDir: string

/**
 * Serve every cluster read `ensureProxyResources` makes: the node/apiserver
 * addresses cluster-cidrs resolves the policy ipBlocks from, the Calico pool
 * list netd's exclusion set comes from, and (by default) no live proxy
 * Service. Individual tests override `kubectlGetJson` after calling this.
 */
function stageClusterReads(): void {
  mockGetJson.mockImplementation((args: string[]) => {
    if (args[1] === 'nodes') {
      return Promise.resolve({
        items: [{
          status: { addresses: [{ type: 'InternalIP', address: NODE_IP }] },
          spec: { podCIDR: '10.244.0.0/24' },
        }],
      })
    }
    if (args[1] === 'endpoints') {
      return Promise.resolve({ subsets: [{ addresses: [{ ip: NODE_IP }] }] })
    }
    if (args[1]?.startsWith('ippools')) {
      return Promise.resolve({ items: [{ spec: { cidr: '192.168.0.0/16' } }] })
    }
    return Promise.resolve(null)
  })
}

const applied = (): Manifest[] => mockApply.mock.calls.map((c) => c[0] as Manifest)
const kinds = (): string[] => applied().map((m) => m.kind)
const byName = (name: string): Manifest | undefined =>
  applied().find((m) => m.metadata.name === name)
const specOf = (m: Manifest | undefined): Record<string, unknown> =>
  (m?.spec ?? {})

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  vi.clearAllMocks()
  mockApply.mockResolvedValue(undefined)
  mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockImageExists.mockResolvedValue(true)
  mockHasTag.mockResolvedValue(true)
  resetClusterCidrCache()
  resetProxyClusterIpCache()
  vi.stubEnv('YAAC_USE_TOR', '')
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
  vi.unstubAllEnvs()
})

describe('ensureNamespace', () => {
  it('applies a Namespace manifest labelled for the privileged Pod Security Standard', async () => {
    // The labels are inert on a cluster yaac builds (kind enforces no PSS)
    // and load-bearing on one it adopts, where the cluster default is often
    // baseline: netd is hostNetwork with NET_ADMIN, so under an inherited
    // restrictive default its DaemonSet creates no pod at all and no session
    // gets a redirect.
    await ensureNamespace()
    expect(mockApply).toHaveBeenCalledWith({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'test-ns',
        labels: {
          'pod-security.kubernetes.io/enforce': 'privileged',
          'pod-security.kubernetes.io/audit': 'privileged',
          'pod-security.kubernetes.io/warn': 'privileged',
        },
      },
    })
  })
})

describe('ensureProxyAuthSecret', () => {
  it('returns the decoded existing secret without re-applying', async () => {
    mockGetJson.mockResolvedValue({
      data: { secret: Buffer.from('existing-secret').toString('base64') },
    })
    await expect(ensureProxyAuthSecret()).resolves.toBe('existing-secret')
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('generates, applies, and returns a fresh secret when none exists', async () => {
    mockGetJson.mockResolvedValue(null)
    const secret = await ensureProxyAuthSecret()
    // 32 random bytes hex-encoded.
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(mockApply).toHaveBeenCalledTimes(1)
    const manifest = mockApply.mock.calls[0][0] as {
      kind: string
      metadata: { name: string; namespace: string }
      data: { secret: string }
    }
    expect(manifest.kind).toBe('Secret')
    expect(manifest.metadata).toEqual({ name: PROXY_AUTH_SECRET_NAME, namespace: 'test-ns' })
    expect(Buffer.from(manifest.data.secret, 'base64').toString('utf8')).toBe(secret)
  })
})

describe('proxyServiceClusterIp', () => {
  it('returns the live (allocator-assigned) ClusterIP of the proxy Service', async () => {
    mockGetJson.mockResolvedValue({ spec: { clusterIP: '10.96.92.236' } })
    expect(await proxyServiceClusterIp()).toBe('10.96.92.236')
  })

  it('throws if the Service has no ClusterIP yet', async () => {
    mockGetJson.mockResolvedValue({ spec: {} })
    await expect(proxyServiceClusterIp()).rejects.toThrow(/ClusterIP/)
  })

  it('caches the first read for the process (the Service is never recreated)', async () => {
    mockGetJson.mockResolvedValue({ spec: { clusterIP: '10.96.92.236' } })
    await proxyServiceClusterIp()
    mockGetJson.mockClear()

    expect(await proxyServiceClusterIp()).toBe('10.96.92.236')
    expect(mockGetJson).not.toHaveBeenCalled()
  })

  it('does not cache a failed read', async () => {
    mockGetJson.mockResolvedValueOnce({ spec: {} })
    await expect(proxyServiceClusterIp()).rejects.toThrow(/ClusterIP/)
    mockGetJson.mockResolvedValueOnce({ spec: { clusterIP: '10.96.0.7' } })
    expect(await proxyServiceClusterIp()).toBe('10.96.0.7')
  })
})

describe('resetProxyClusterIpCache', () => {
  it('forces the next call to re-read the Service', async () => {
    mockGetJson.mockResolvedValue({ spec: { clusterIP: '10.96.0.1' } })
    await proxyServiceClusterIp()

    resetProxyClusterIpCache()
    mockGetJson.mockResolvedValue({ spec: { clusterIP: '10.96.0.2' } })
    expect(await proxyServiceClusterIp()).toBe('10.96.0.2')
  })
})

describe('ensureProxyResources', () => {
  it('creates no host dir, applies the whole set in order, and waits for both rollouts', async () => {
    stageClusterReads()
    await ensureProxyResources('localhost:5000/yaac-proxy:abc')

    // Nothing on the host: the proxy mounts no directory of it.
    await expect(fs.readdir(globalRoot()).catch(() => [])).resolves.not.toContain('run')
    await expect(fs.readdir(tmpDir)).resolves.not.toContain('.credentials')

    expect(kinds()).toEqual([
      'ServiceAccount', 'Role', 'RoleBinding',
      // The proxy's three outputs, created empty so its Role can name them —
      // before the Deployment, so the pod never boots against a name it
      // cannot patch.
      'Secret', 'Secret', 'ConfigMap',
      'Deployment', 'Service',
      // Session egress, session ingress lock, proxy ingress, world-deny.
      'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy',
      // netd: SA, ClusterRole, ClusterRoleBinding, Role, RoleBinding, DaemonSet.
      'ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding',
      'DaemonSet',
    ])
    expect(byName('yaac-proxy-refreshed')?.metadata.labels).toEqual({ app: 'yaac-proxy', 'yaac.proxy-output': 'refreshed' })
    expect(byName('yaac-proxy-ca')?.metadata.labels).toEqual({ app: 'yaac-proxy', 'yaac.proxy-output': 'ca' })
    expect(byName('yaac-proxy-state')?.metadata.labels).toEqual({ app: 'yaac-proxy', 'yaac.proxy-output': 'state' })
    // The proxy Service ClusterIP is allocator-assigned and never deleted —
    // no pin migration, so ensureProxyResources issues no `delete service`.
    expect(mockRetry).not.toHaveBeenCalledWith(expect.arrayContaining(['delete', 'service']))
    expect(mockRetry).toHaveBeenCalledWith(
      ['rollout', 'status', `daemonset/${NETD_APP_NAME}`, '-n', 'test-ns', '--timeout=180s'],
      expect.objectContaining({ maxAttempts: 2 }),
    )
    expect(mockRetry).toHaveBeenCalledWith(
      ['rollout', 'status', `deployment/${PROXY_APP_NAME}`, '-n', 'test-ns', '--timeout=180s'],
      expect.objectContaining({ maxAttempts: 2 }),
    )
  })

  it('leaves the proxy’s outputs alone once they exist', async () => {
    // An apply of the empty shape onto a live object would wipe what the
    // proxy wrote into it — the CA above all.
    stageClusterReads()
    mockGetJson.mockImplementation((args: string[]) => {
      if (args[1] === 'secret' || args[1] === 'configmap') return Promise.resolve({ data: { 'ca.pem': 'x' } })
      if (args[1] === 'nodes') {
        return Promise.resolve({ items: [{ status: { addresses: [{ type: 'InternalIP', address: NODE_IP }] } }] })
      }
      if (args[1] === 'endpoints') return Promise.resolve({ subsets: [{ addresses: [{ ip: NODE_IP }] }] })
      return Promise.resolve(null)
    })
    await ensureProxyResources('img')
    expect(kinds().filter((k) => k === 'Secret' || k === 'ConfigMap')).toEqual([])
  })

  it('gives the proxy read on its inputs and write on exactly its three outputs', async () => {
    stageClusterReads()
    await ensureProxyResources('img')
    const role = applied().find((m) => m.kind === 'Role' && m.metadata.name === PROXY_SA_NAME)
    // `list`/`watch` cannot be name-scoped, so the read grant is
    // namespace-wide; `create` cannot be either, which is why the outputs
    // are pre-created and the proxy only updates and patches them.
    expect(role?.rules).toEqual([
      { apiGroups: [''], resources: ['pods', 'secrets', 'configmaps'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: [''], resources: ['secrets'], resourceNames: ['yaac-proxy-refreshed', 'yaac-proxy-ca'], verbs: ['update', 'patch'] },
      { apiGroups: [''], resources: ['configmaps'], resourceNames: ['yaac-proxy-state'], verbs: ['update', 'patch'] },
    ])
  })

  it('carries an older proxy’s CA, registrations and records into the objects, once', async () => {
    // The old proxy's hostPath, off the data dir the server mounts
    // (docs/legacy-compat-shims.md). Bare refs in a persisted registration
    // predate project scoping; the seed scopes them on the way in.
    const dir = globalPath('run', 'proxy-data')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'ca.key'), 'OLD-KEY')
    await fs.writeFile(path.join(dir, 'ca.pem'), 'OLD-CERT')
    await fs.writeFile(path.join(dir, 'worktrees.json'), JSON.stringify({
      w1: {
        rules: [{ hostPattern: 'h', pathPattern: '/*', injections: [
          { action: 'set_header', name: 'a', secretRef: 'BARE' },
          { action: 'set_header', name: 'b', secretRef: 'other/SCOPED' },
        ] }],
        allowedHosts: ['h'], tool: 'claude', projectSlug: 'demo',
      },
      broken: { rules: 'nope' },
    }))
    await fs.writeFile(path.join(dir, 'blocked-hosts.json'), JSON.stringify({ w1: ['evil'] }))
    stageClusterReads()
    await ensureProxyResources('img')

    // The empty pre-create first, then the seed's write of the old CA —
    // carrying the labels the pre-create stamped, since an apply without
    // them would delete them through the three-way merge and the server's
    // informers select on exactly those.
    const ca = applied().filter((m) => m.metadata.name === 'yaac-proxy-ca').at(-1)
    expect(ca?.kind).toBe('Secret')
    expect(ca?.metadata.labels).toEqual({ app: 'yaac-proxy', 'yaac.proxy-output': 'ca' })
    expect(b64d(ca!.data!['ca.pem'])).toBe('OLD-CERT')
    expect(b64d(ca!.data!['ca.key'])).toBe('OLD-KEY')
    const reg = byName('yaac-proxy-reg-w1')
    expect(reg?.metadata.labels).toMatchObject({ 'yaac.worktree-id': 'w1', 'yaac.project': 'demo' })
    expect(JSON.parse(reg!.data!['registration.json'])).toMatchObject({
      rules: [{ injections: [
        { secretRef: 'demo/BARE' }, { secretRef: 'other/SCOPED' },
      ] }],
    })
    expect(byName('yaac-proxy-reg-broken')).toBeUndefined()
    const state = applied().filter((m) => m.metadata.name === 'yaac-proxy-state').at(-1)
    expect(state?.metadata.labels).toEqual({ app: 'yaac-proxy', 'yaac.proxy-output': 'state' })
    expect(JSON.parse(state!.data!['blocked-hosts.json'])).toEqual({ w1: ['evil'] })
    expect(JSON.parse(state!.data!['git-auth-failures.json'])).toEqual({})
    // The CA is the seed's done-marker, so it is written last: a failure
    // before it seeds everything again next time rather than leaving a
    // live worktree out.
    const names = applied().map((m) => m.metadata.name)
    expect(names.lastIndexOf('yaac-proxy-ca')).toBeGreaterThan(names.indexOf('yaac-proxy-reg-w1'))
    expect(names.lastIndexOf('yaac-proxy-ca')).toBeGreaterThan(names.lastIndexOf('yaac-proxy-state'))
    expect(vi.mocked(serverLog)).toHaveBeenCalledWith(expect.stringContaining('seeded the proxy'))
    // The directory is left in place; the seed runs on an empty CA alone.
    await expect(fs.stat(path.join(dir, 'ca.pem'))).resolves.toBeDefined()

    vi.mocked(serverLog).mockClear()
    mockApply.mockClear()
    mockGetJson.mockImplementation((args: string[]) => {
      if (args[1] === 'secret' && args[2] === 'yaac-proxy-ca') return Promise.resolve({ data: { 'ca.pem': 'x' } })
      if (args[1] === 'secret' || args[1] === 'configmap') return Promise.resolve({})
      if (args[1] === 'nodes') {
        return Promise.resolve({ items: [{ status: { addresses: [{ type: 'InternalIP', address: NODE_IP }] } }] })
      }
      if (args[1] === 'endpoints') return Promise.resolve({ subsets: [{ addresses: [{ ip: NODE_IP }] }] })
      return Promise.resolve(null)
    })
    await ensureProxyResources('img')
    expect(byName('yaac-proxy-reg-w1')).toBeUndefined()
    expect(vi.mocked(serverLog)).not.toHaveBeenCalledWith(expect.stringContaining('seeded'))
  })

  it('runs one proxy replica on runc under Recreate, wired to its ports and auth secret', async () => {
    stageClusterReads()
    await ensureProxyResources('localhost:5000/yaac-proxy:abc')

    const dep = applied().find((m) => m.kind === 'Deployment') as unknown as {
      metadata: { name: string; namespace: string }
      spec: {
        replicas: number
        strategy: unknown
        selector: { matchLabels: Record<string, string> }
        template: {
          metadata: { labels: Record<string, string> }
          spec: {
            serviceAccountName: string
            automountServiceAccountToken: boolean
            enableServiceLinks: boolean
            runtimeClassName?: string
            priorityClassName?: string
            dnsPolicy?: string
            securityContext?: { runAsUser?: number; runAsGroup?: number; fsGroup?: number }
            volumes: Array<Record<string, unknown>>
            containers: Array<{
              image: string
              ports: Array<Record<string, unknown>>
              env: Array<Record<string, unknown>>
              volumeMounts: Array<Record<string, unknown>>
              securityContext?: { capabilities?: { add?: string[] } }
              readinessProbe: { httpGet: unknown }
            }>
          }
        }
      }
    }
    expect(dep.metadata).toMatchObject({ name: PROXY_APP_NAME, namespace: 'test-ns' })
    expect(dep.spec.replicas).toBe(1)
    // Recreate, not RollingUpdate: two proxies would share the agent socket.
    expect(dep.spec.strategy).toEqual({ type: 'Recreate' })
    expect(dep.spec.selector.matchLabels).toEqual({ app: PROXY_APP_NAME })
    // Install identity on every proxy pod; no inner-proxy role when top-level.
    expect(dep.spec.template.metadata.labels).toEqual({
      app: PROXY_APP_NAME, [LABEL_DATA_DIR_HASH]: 'ddh0123456789abc',
    })

    const pod = dep.spec.template.spec
    // Trusted infra runs on runc; DNS is the cluster default when top-level.
    expect(pod.runtimeClassName).toBeUndefined()
    expect(pod.dnsPolicy).toBeUndefined()
    // Infra tier: losing the proxy costs every session its network, so it
    // outranks sessions when a full node has to shed something.
    expect(pod.priorityClassName).toBe('yaac-infra')
    expect(pod.serviceAccountName).toBe(PROXY_SA_NAME)
    expect(pod.automountServiceAccountToken).toBe(true)
    expect(pod.enableServiceLinks).toBe(false)
    // Runs as the server host uid, with fsGroup for the emptyDirs.
    expect(pod.securityContext?.runAsUser).toBe(process.getuid?.())
    expect(pod.securityContext?.fsGroup).toBe(process.getgid?.())
    // Two emptyDirs and nothing from the host: the proxy is stateless, and a
    // replacement anywhere in the cluster restores itself from the apiserver.
    expect(pod.volumes).toEqual([
      { name: 'proxy-data', emptyDir: {} },
      { name: 'home', emptyDir: {} },
    ])
    expect(JSON.stringify(dep)).not.toContain('hostPath')

    const c = pod.containers[0]
    expect(c.image).toBe('localhost:5000/yaac-proxy:abc')
    expect(c.ports).toEqual([
      { containerPort: PROXY_PORT },
      { containerPort: TRANSPARENT_HTTPS_PORT },
      { containerPort: TRANSPARENT_HTTP_PORT },
      { containerPort: TRANSPARENT_TUNNEL_PORT },
      { containerPort: RELAY_PORT },
      { containerPort: SSH_AGENT_PORT },
      { containerPort: DNS_STUB_PORT, protocol: 'UDP' },
    ])
    // NET_BIND_SERVICE lets the non-root proxy bind udp/53 for the DNS stub.
    expect(c.securityContext?.capabilities?.add).toEqual(['NET_BIND_SERVICE'])
    expect(c.env).toContainEqual({ name: 'RELAY_PORT', value: String(RELAY_PORT) })
    expect(c.env).toContainEqual({ name: 'POD_STREAM_PORT', value: String(POD_STREAM_PORT) })
    expect(c.env).toContainEqual({
      name: 'PROXY_AUTH_SECRET',
      valueFrom: { secretKeyRef: { name: PROXY_AUTH_SECRET_NAME, key: 'secret' } },
    })
    // HOME points at the emptyDir mount so the proxy's known_hosts writer
    // works when it runs as the server uid, not the image's node user.
    expect(c.env).toContainEqual({ name: 'HOME', value: '/home/proxy' })
    expect(c.env).not.toContainEqual({ name: 'USE_TOR', value: '1' })
    expect(c.readinessProbe.httpGet).toEqual({ path: '/healthz', port: PROXY_PORT })
    expect(c.volumeMounts).toEqual([
      { name: 'proxy-data', mountPath: '/data' },
      { name: 'home', mountPath: '/home/proxy' },
    ])
  })

  it('passes tor through to the proxy container when the host enables it', async () => {
    vi.stubEnv('YAAC_USE_TOR', '1')
    stageClusterReads()
    await ensureProxyResources('img')

    const dep = applied().find((m) => m.kind === 'Deployment') as unknown as {
      spec: { template: { spec: { containers: Array<{ env: Array<Record<string, unknown>> }> } } }
    }
    expect(dep.spec.template.spec.containers[0].env)
      .toContainEqual({ name: 'USE_TOR', value: '1' })
  })

  it('locks the datapath: session egress to the node range, ingress to the proxy, world default-deny', async () => {
    stageClusterReads()
    await ensureProxyResources('img')

    // Session egress: the node's netd listener range is the only world-ward
    // path a session pod gets, which is what makes a missing redirect fail
    // closed rather than open.
    const egress = specOf(byName(WORKTREE_EGRESS_NP_NAME)) as { egress: Rule[] }
    const nodeRule = egress.egress.find((r) =>
      r.to?.some((p) => JSON.stringify(p).includes(NODE_IP)))
    expect(nodeRule).toBeDefined()
    const rangePorts = egress.egress.flatMap((r) => r.ports ?? [])
      .find((p) => p.port === NETD_LISTENER_PORT_BASE)
    expect(rangePorts?.endPort).toBe(NETD_LISTENER_PORT_END)

    // Session ingress lock: only the proxy's relay dials reach streamd.
    const lock = specOf(byName(WORKTREE_INGRESS_LOCK_NP_NAME)) as { ingress: Rule[] }
    expect(lock.ingress.flatMap((r) => (r.ports ?? []).map((p) => p.port)))
      .toContain(POD_STREAM_PORT)

    // Proxy ingress: the transparent ports are node-only, so only netd's
    // Envoy (host netns) can originate PROXY-protocol identity.
    const proxyIngress = specOf(byName(PROXY_INGRESS_NP_NAME)) as { ingress: Rule[] }
    const transparent = proxyIngress.ingress.find((r) =>
      (r.ports ?? []).some((p) => p.port === TRANSPARENT_HTTPS_PORT))
    expect(JSON.stringify(transparent?.from)).toContain(NODE_IP)

    // ssh-agent forwarding: session pods dial the proxy directly, and that
    // pod-facing port is admitted for the SESSION selector only — never
    // from the node CIDRs (which would let anything on the host in) and
    // never from anything else.
    const agentEgress = egress.egress.find((r) =>
      (r.ports ?? []).some((p) => p.port === SSH_AGENT_PORT))
    expect(JSON.stringify(agentEgress?.to)).toContain(PROXY_APP_NAME)
    const agentIngress = proxyIngress.ingress.filter((r) =>
      (r.ports ?? []).some((p) => p.port === SSH_AGENT_PORT))
    expect(agentIngress).toHaveLength(1)
    expect(JSON.stringify(agentIngress[0].from)).toContain(LABEL_WORKTREE_ID)
    expect(JSON.stringify(agentIngress[0].from)).not.toContain(NODE_IP)

    // World default-deny over everything that is not the proxy, a session,
    // or a builder.
    const worldDeny = specOf(byName(EGRESS_WORLD_DENY_NAME)) as {
      egress: unknown[]; policyTypes: string[]
    }
    expect(worldDeny.egress).toEqual([])
    expect(worldDeny.policyTypes).toEqual(['Egress'])
  })

  it('gives netd the union of Calico pools and node podCIDRs as its redirect exclusion set', async () => {
    stageClusterReads()
    await ensureProxyResources('img')

    const ds = applied().find((m) => m.kind === 'DaemonSet') as unknown as {
      metadata: { name: string; namespace: string }
      spec: { template: { spec: {
        hostNetwork?: boolean
        serviceAccountName: string
        containers: Array<{ image: string; env: Array<{ name: string; value: string }> }>
      } } }
    }
    expect(ds.metadata.name).toBe(NETD_APP_NAME)
    const pod = ds.spec.template.spec
    expect(pod.serviceAccountName).toBe(NETD_APP_NAME)
    // The exclusion set unions both sources — too narrow is the dangerous
    // direction, since an unlisted pod IP is treated as world and redirected.
    const podCidrEnv = pod.containers
      .flatMap((c) => c.env)
      .find((e) => e.value?.includes('10.244.0.0/24'))
    expect(podCidrEnv?.value).toContain('192.168.0.0/16')
    // Calico's veth naming is the default, passed explicitly rather than
    // baked into netd: an adopted CNI can name workload veths differently,
    // and netd's pod → veth resolution keys on that prefix.
    const vethEnv = pod.containers
      .flatMap((c) => c.env)
      .find((e) => e.name === 'NETD_VETH_PREFIX')
    expect(vethEnv?.value).toBe('cali')
    // Both images resolve through the local registry, never upstream.
    for (const c of pod.containers) expect(c.image).toMatch(/^localhost:5001\//)
  })

  it('adds the configured pod CIDRs and veth prefix for an adopted CNI', async () => {
    // A cluster yaac did not build may allocate pod IPs from a range that
    // appears in no IPPool and no spec.podCIDR (a VPC CNI hands out subnet
    // addresses), and name its workload veths something other than `cali*`.
    // Both are explicit configuration — and the CIDR one UNIONS with what
    // was discovered rather than replacing it, because too narrow is the
    // dangerous direction: an unlisted pod IP is treated as world and its
    // pod-to-pod 443/80 is redirected into the proxy.
    vi.stubEnv('YAAC_POD_CIDRS', '172.31.0.0/16, 10.1.0.0/16 , not-a-cidr')
    vi.stubEnv('YAAC_CNI_VETH_PREFIX', 'eni')
    resetClusterCidrCache()
    stageClusterReads()
    await ensureProxyResources('img')

    const env = (applied().find((m) => m.kind === 'DaemonSet') as unknown as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } }
    }).spec.template.spec.containers.flatMap((c) => c.env)
    const cidrs = env.find((e) => e.name === 'CLUSTER_POD_CIDRS')?.value?.split(',')
    expect(cidrs).toEqual(['10.1.0.0/16', '10.244.0.0/24', '172.31.0.0/16', '192.168.0.0/16'])
    // A malformed entry is dropped rather than reaching a nat rule that
    // iptables-restore would reject, stalling every redirect update.
    expect(cidrs).not.toContain('not-a-cidr')
    expect(env.find((e) => e.name === 'NETD_VETH_PREFIX')?.value).toBe('eni')
  })

  it('refuses with the install pointer when netd or Envoy is missing from the registry', async () => {
    // Neither image is built here any more: both are yaac-shipped, so
    // `yaac cluster install` produces them and this path is a lookup. A
    // proxy bootstrap that could build would put a container engine back
    // on the server's critical path.
    stageClusterReads()
    mockImageExists.mockResolvedValue(false)

    // Envoy mirrored, netd not: the missing one is the one named.
    mockHasTag.mockImplementation((tag: string) =>
      Promise.resolve(!tag.startsWith('yaac-netd:')))
    await expect(ensureProxyResources('img'))
      .rejects.toThrow(/netd image .* is missing.*yaac cluster install/s)

    // netd present, Envoy absent: the mirror is what fails.
    mockHasTag.mockImplementation((tag: string) =>
      Promise.resolve(tag.startsWith('yaac-netd:')))
    await expect(ensureProxyResources('img'))
      .rejects.toThrow(/Envoy image .* is missing.*yaac cluster install/s)

    // Nothing was built, pulled or pushed — that is the point.
    expect(podmanArgs().some((a) => a[0] === 'pull')).toBe(false)
    expect(vi.mocked(buildImage)).not.toHaveBeenCalled()
    expect(vi.mocked(registerImageBuild)).not.toHaveBeenCalled()
  })

  it('resolves netd\'s pod-CIDR exclusions from every source, and falls back when none answer', async () => {
    // Calico is a CRD: on a cluster without it the get fails, which is a
    // missing source and not an error — the node podCIDRs still count.
    mockGetJson.mockImplementation((args: string[]) => {
      if (args[1]?.startsWith('ippools')) return Promise.reject(new Error('no such resource'))
      if (args[1] === 'nodes') {
        return Promise.resolve({
          items: [{
            status: { addresses: [{ type: 'InternalIP', address: NODE_IP }] },
            spec: { podCIDRs: ['10.244.0.0/24'] },
          }],
        })
      }
      if (args[1] === 'endpoints') {
        return Promise.resolve({ subsets: [{ addresses: [{ ip: NODE_IP }] }] })
      }
      return Promise.resolve(null)
    })
    await ensureProxyResources('img')
    expect(JSON.stringify(applied().find((m) => m.kind === 'DaemonSet')))
      .toContain('10.244.0.0/24')

    // Nothing publishes a pod CIDR: kind's default is the last resort, since
    // an empty exclusion set would redirect pod-to-pod traffic into the proxy.
    vi.clearAllMocks()
    resetClusterCidrCache()
    mockApply.mockResolvedValue(undefined)
    mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
    mockHasTag.mockResolvedValue(true)
    mockImageExists.mockResolvedValue(true)
    mockGetJson.mockImplementation((args: string[]) => {
      if (args[1] === 'nodes') {
        return Promise.resolve({
          items: [{ status: { addresses: [{ type: 'InternalIP', address: NODE_IP }] } }],
        })
      }
      if (args[1] === 'endpoints') {
        return Promise.resolve({ subsets: [{ addresses: [{ ip: NODE_IP }] }] })
      }
      return Promise.resolve(null)
    })
    await ensureProxyResources('img')
    expect(JSON.stringify(applied().find((m) => m.kind === 'DaemonSet')))
      .toContain('10.244.0.0/16')

    // The pod-CIDR answer is cached for the process: a second ensure in the
    // same server does not re-probe.
    mockGetJson.mockClear()
    await ensureProxyResources('img')
    expect(mockGetJson.mock.calls.some((c) => (c[0])[1]?.startsWith('ippools')))
      .toBe(false)
  })

})

describe('ensureCaConfigMap', () => {
  const b64 = (s: string): string => Buffer.from(s).toString('base64')
  /** The CA Secret the proxy wrote, and the ConfigMap as it stands. */
  function stage(secret: Record<string, string> | null, configMap: Record<string, string> | null): void {
    mockGetJson.mockImplementation((args: string[]) => {
      if (args[1] === 'secret') return Promise.resolve(secret ? { data: secret } : null)
      return Promise.resolve(configMap ? { data: configMap } : null)
    })
  }

  it('skips the apply only when both the CA and the bundle already match', async () => {
    stage({ 'ca.pem': b64('PEM-CONTENT'), 'ca-bundle.pem': b64('BUNDLE') },
      { 'proxy-ca.pem': 'PEM-CONTENT', 'ca-bundle.pem': 'BUNDLE' })
    await ensureCaConfigMap()
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('applies the ConfigMap with both keys, from the proxy’s Secret, when absent or stale', async () => {
    stage({ 'ca.pem': b64('NEW-PEM'), 'ca-bundle.pem': b64('NEW-BUNDLE') }, null)
    await ensureCaConfigMap()
    expect(mockApply).toHaveBeenCalledWith({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'yaac-proxy-ca', namespace: 'test-ns' },
      data: { 'proxy-ca.pem': 'NEW-PEM', 'ca-bundle.pem': 'NEW-BUNDLE' },
    })

    mockApply.mockClear()
    stage({ 'ca.pem': b64('NEW-PEM'), 'ca-bundle.pem': b64('NEW-BUNDLE') }, { 'proxy-ca.pem': 'OLD-PEM' })
    await ensureCaConfigMap()
    expect(mockApply).toHaveBeenCalledTimes(1)
  })

  it('re-applies when the CA matches but the bundle drifted (e.g. roots refresh)', async () => {
    stage({ 'ca.pem': b64('SAME'), 'ca-bundle.pem': b64('NEW-BUNDLE') },
      { 'proxy-ca.pem': 'SAME', 'ca-bundle.pem': 'OLD-BUNDLE' })
    await ensureCaConfigMap()
    expect(mockApply).toHaveBeenCalledTimes(1)
  })

  it('waits for a freshly rolled proxy to have written its CA', async () => {
    vi.useFakeTimers()
    try {
      let reads = 0
      mockGetJson.mockImplementation((args: string[]) => {
        if (args[1] !== 'secret') return Promise.resolve(null)
        reads++
        return Promise.resolve(reads < 3 ? { data: {} } : { data: { 'ca.pem': b64('P'), 'ca-bundle.pem': b64('B') } })
      })
      const done = ensureCaConfigMap()
      await vi.advanceTimersByTimeAsync(2_000)
      await done
      expect(mockApply).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('syncProxyCredentials', () => {
  it('renders every host-store file and the ssh keys into one Secret, and logs no value', async () => {
    await syncProxyCredentials({
      claude: { kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant-secret' },
      codex: null,
      opencode: { kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'sk-or-secret' },
      pi: null,
      git: [{ token: 'ghp-secret', projects: ['acme'] }],
      ssh: [{
        privateKey: 'KEY-secret', publicKey: 'ssh-ed25519 AAAA yaac',
        projects: [{ slug: 'acme', host: 'g.example', knownHostsEntry: 'g.example ssh-ed25519 A' }],
      }],
    })
    const secret = applied()[0]
    expect(secret.kind).toBe('Secret')
    expect(secret.metadata).toEqual({
      name: 'yaac-proxy-credentials', namespace: 'test-ns',
      labels: { app: 'yaac-proxy', 'yaac.proxy-input': 'credentials' },
    })
    // A signed-out tool contributes no key: replace semantics carry absence.
    expect(Object.keys(secret.data!).sort()).toEqual(['claude.json', 'git-tokens.json', 'opencode.json', 'ssh-keys.json'])
    expect(JSON.parse(b64d(secret.data!['claude.json']))).toEqual({ kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant-secret' })
    expect(JSON.parse(b64d(secret.data!['git-tokens.json']))).toEqual([{ token: 'ghp-secret', projects: ['acme'] }])
    expect(JSON.parse(b64d(secret.data!['ssh-keys.json']))).toEqual([{
      privateKey: 'KEY-secret', publicKey: 'ssh-ed25519 AAAA yaac',
      projects: [{ slug: 'acme', host: 'g.example', knownHostsEntry: 'g.example ssh-ed25519 A' }],
    }])
    for (const [msg] of vi.mocked(serverLog).mock.calls) expect(msg).not.toContain('secret')
  })
})

describe('syncProjectSecrets', () => {
  it('names the project safely and scopes every ref, replacing the set whole', async () => {
    await syncProjectSecrets('My Project/1', { KEY: 'v1', OTHER: '' })
    const secret = applied()[0]
    expect(secret.kind).toBe('Secret')
    // Not DNS-safe as a slug; install-scoped like the registry's name.
    expect(secret.metadata.name).toMatch(/^yaac-proxy-secrets-my-project-1-[0-9a-f]{8}$/)
    expect(secret.metadata.labels).toEqual({
      app: 'yaac-proxy', 'yaac.proxy-input': 'secrets', 'yaac.project': 'My Project/1',
    })
    expect(JSON.parse(b64d(secret.data!['values.json']))).toEqual({ 'My Project/1/KEY': 'v1', 'My Project/1/OTHER': '' })

    // An emptied set is applied as such, so a deleted secret stops being injected.
    mockApply.mockClear()
    await syncProjectSecrets('My Project/1', {})
    expect(JSON.parse(b64d(applied()[0].data!['values.json']))).toEqual({})
  })
})

describe('removeProjectSecrets', () => {
  it('deletes the project’s object by its install-scoped name', async () => {
    await syncProjectSecrets('demo', { A: '1' })
    const name = applied()[0].metadata.name
    await removeProjectSecrets('demo')
    expect(mockRetry).toHaveBeenCalledWith(['delete', 'secret', name, '-n', 'test-ns', '--ignore-not-found'])
  })
})

describe('vapAvailable', () => {
  it('answers by asking the apiserver, and false is the fail-closed case', async () => {
    // `cluster check`'s vap gate and the builder guard both key on this.
    // An apiserver with no such resource type errors, and the caller must
    // read that as "no admission guard here" rather than propagating —
    // the guard is what reserves the builder label, so its absence is a
    // reportable condition, not a crash.
    stageClusterReads()
    mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(vapAvailable()).resolves.toBe(true)
    expect(mockRetry).toHaveBeenCalledWith(
      ['get', 'validatingadmissionpolicies', '-o', 'name'],
      expect.objectContaining({ maxAttempts: 1 }),
    )

    mockRetry.mockRejectedValue(new Error("the server doesn't have a resource type"))
    await expect(vapAvailable()).resolves.toBe(false)
  })
})

describe('ensureBuilderRoleGuard', () => {
  it('applies the cluster-wide guard policy and binding', async () => {
    await ensureBuilderRoleGuard()
    expect(applied().map((m) => m.kind))
      .toEqual(['ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding'])
  })

  it('throws with a setup pointer when the VAP API is missing', async () => {
    // Probed at the kubectl boundary, the way `vapAvailable` probes it: an
    // apiserver with no such resource type answers with an error.
    mockRetry.mockImplementation((args: string[]) =>
      args.includes('validatingadmissionpolicies')
        ? Promise.reject(new Error("the server doesn't have a resource type"))
        : Promise.resolve({ stdout: '', stderr: '' }))
    await expect(ensureBuilderRoleGuard()).rejects.toThrow(/yaac cluster install/)
    expect(mockApply).not.toHaveBeenCalled()
  })
})

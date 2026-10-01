import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'

// Only process boundaries and other folders' barrels are faked: kubectl,
// podman, the registry client and the image engine. Nothing in the cluster
// folder is mocked, so `ensureProxyResources` runs the real manifests,
// policies, CIDR probes and netd.
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

// podman is faked at node:child_process so a test can assert nothing was
// pulled.
vi.mock('node:child_process', () => ({
  execFile: vi.fn((...allArgs: unknown[]) => {
    const args = allArgs[1] as string[]
    const cb = allArgs[allArgs.length - 1] as (...cbArgs: unknown[]) => void
    // Answer an arch probe with the host arch so assertMirrorArch passes.
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

// `yaac cluster install` builds netd's image; this path only looks its tag
// up, so only the hash is faked and the real missing-image error is kept.
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
import { globalRoot } from '@yaac/shared/project-paths'
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
  PROXY_EGRESS_NP_NAME,
  PROXY_INGRESS_NP_NAME,
  SERVER_FRONT_PORT,
  PROXY_PORT,
  PROXY_SA_NAME,
  RELAY_PORT,
  WORKSPACE_EGRESS_NP_NAME,
  WORKSPACE_INGRESS_LOCK_NP_NAME,
  SSH_AGENT_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
} from '#drivers/k8s/substrate/proxy-constants'
import { LABEL_DATA_DIR_HASH, LABEL_WORKSPACE_ID } from '#drivers/k8s/substrate/pods'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#drivers/k8s/substrate/kubectl'
import { imageExists } from '#drivers/k8s/container/runtime'
import { registryHasTag } from '#drivers/k8s/container/registry'
import { buildImage, registerImageBuild } from '#drivers/k8s/image-engine'
import { serverLog } from '#log'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { execFile } from 'node:child_process'

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
 * Serve every cluster read `ensureProxyResources` makes: node and apiserver
 * addresses (for policy ipBlocks), the Calico pool list (netd's exclusion
 * set), and no existing proxy objects.
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
    // kind enforces no Pod Security, but an adopted cluster often defaults
    // to baseline, which would block netd (hostNetwork, NET_ADMIN) entirely.
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

    // The proxy mounts nothing from the host.
    await expect(fs.readdir(globalRoot()).catch(() => [])).resolves.not.toContain('run')
    await expect(fs.readdir(tmpDir)).resolves.not.toContain('.credentials')

    expect(kinds()).toEqual([
      'ServiceAccount', 'Role', 'RoleBinding',
      // The proxy's three outputs, created empty before the Deployment so
      // its Role can name them.
      'Secret', 'Secret', 'ConfigMap',
      'Deployment', 'Service',
      // Workspace egress, workspace ingress lock, proxy ingress and egress,
      // world-deny.
      'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy',
      // netd: SA, ClusterRole, ClusterRoleBinding, Role, RoleBinding, DaemonSet.
      'ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding',
      'DaemonSet',
    ])
    expect(byName('yaac-proxy-refreshed')?.metadata.labels).toEqual({ app: 'yaac-proxy', 'yaac.proxy-output': 'refreshed' })
    expect(byName('yaac-proxy-ca')?.metadata.labels).toEqual({ app: 'yaac-proxy', 'yaac.proxy-output': 'ca' })
    expect(byName('yaac-proxy-state')?.metadata.labels).toEqual({ app: 'yaac-proxy', 'yaac.proxy-output': 'state' })
    // The proxy Service (and so its ClusterIP) is never deleted.
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
    // Re-applying the empty object would wipe what the proxy wrote, such as
    // the CA.
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
    // `list`/`watch` and `create` cannot be scoped by name, so reads are
    // namespace-wide and the outputs are pre-created for the proxy to patch.
    expect(role?.rules).toEqual([
      { apiGroups: [''], resources: ['pods', 'secrets', 'configmaps'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: [''], resources: ['secrets'], resourceNames: ['yaac-proxy-refreshed', 'yaac-proxy-ca'], verbs: ['update', 'patch'] },
      { apiGroups: [''], resources: ['configmaps'], resourceNames: ['yaac-proxy-state'], verbs: ['update', 'patch'] },
    ])
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
    // A rolling update would briefly run two proxies on one agent socket.
    expect(dep.spec.strategy).toEqual({ type: 'Recreate' })
    expect(dep.spec.selector.matchLabels).toEqual({ app: PROXY_APP_NAME })
    // Install identity on every proxy pod.
    expect(dep.spec.template.metadata.labels).toEqual({
      app: PROXY_APP_NAME, [LABEL_DATA_DIR_HASH]: 'ddh0123456789abc',
    })

    const pod = dep.spec.template.spec
    // Trusted infra on runc, with the cluster's default DNS.
    expect(pod.runtimeClassName).toBeUndefined()
    expect(pod.dnsPolicy).toBeUndefined()
    // Losing the proxy cuts every workspace's network, so it outranks them
    // under node pressure.
    expect(pod.priorityClassName).toBe('yaac-infra')
    expect(pod.serviceAccountName).toBe(PROXY_SA_NAME)
    expect(pod.automountServiceAccountToken).toBe(true)
    expect(pod.enableServiceLinks).toBe(false)
    // Runs as the server host uid, with fsGroup for the emptyDirs.
    expect(pod.securityContext?.runAsUser).toBe(process.getuid?.())
    expect(pod.securityContext?.fsGroup).toBe(process.getgid?.())
    // Only emptyDirs: the proxy is stateless and restores itself from the
    // apiserver wherever it runs.
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
    // HOME is a writable emptyDir, since the proxy runs as the server's
    // uid and needs to write known_hosts.
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

    // Workspace egress reaches the internet only through netd's listener
    // range on the node, so a missing redirect fails closed.
    const egress = specOf(byName(WORKSPACE_EGRESS_NP_NAME)) as { egress: Rule[] }
    const nodeRule = egress.egress.find((r) =>
      r.to?.some((p) => JSON.stringify(p).includes(NODE_IP)))
    expect(nodeRule).toBeDefined()
    const rangePorts = egress.egress.flatMap((r) => r.ports ?? [])
      .find((p) => p.port === NETD_LISTENER_PORT_BASE)
    expect(rangePorts?.endPort).toBe(NETD_LISTENER_PORT_END)

    // Workspace ingress lock: only the proxy's relay reaches streamd.
    const lock = specOf(byName(WORKSPACE_INGRESS_LOCK_NP_NAME)) as { ingress: Rule[] }
    expect(lock.ingress.flatMap((r) => (r.ports ?? []).map((p) => p.port)))
      .toContain(POD_STREAM_PORT)

    // The transparent ports admit only node addresses, so only netd's Envoy
    // can send a PROXY-protocol header claiming a pod's identity.
    const proxyIngress = specOf(byName(PROXY_INGRESS_NP_NAME)) as { ingress: Rule[] }
    const transparent = proxyIngress.ingress.find((r) =>
      (r.ports ?? []).some((p) => p.port === TRANSPARENT_HTTPS_PORT))
    expect(JSON.stringify(transparent?.from)).toContain(NODE_IP)

    // ssh-agent: workspace pods dial the proxy directly, and the port
    // admits only workspace pods, never node addresses.
    const agentEgress = egress.egress.find((r) =>
      (r.ports ?? []).some((p) => p.port === SSH_AGENT_PORT))
    expect(JSON.stringify(agentEgress?.to)).toContain(PROXY_APP_NAME)
    const agentIngress = proxyIngress.ingress.filter((r) =>
      (r.ports ?? []).some((p) => p.port === SSH_AGENT_PORT))
    expect(agentIngress).toHaveLength(1)
    expect(JSON.stringify(agentIngress[0].from)).toContain(LABEL_WORKSPACE_ID)
    expect(JSON.stringify(agentIngress[0].from)).not.toContain(NODE_IP)

    // Proxy egress reaches nodes on every port except the kind fronting's,
    // where a CONNECT would reach the server as if it were the node.
    const proxyEgress = specOf(byName(PROXY_EGRESS_NP_NAME)) as { egress: Rule[] }
    const toNodes = proxyEgress.egress.find((r) => r.ports && JSON.stringify(r.to).includes(NODE_IP))
    expect(toNodes?.ports?.length).toBeGreaterThan(0)
    expect((toNodes?.ports ?? []).some((p) =>
      p.protocol === 'TCP' && p.port <= SERVER_FRONT_PORT && SERVER_FRONT_PORT <= (p.endPort ?? p.port))).toBe(false)

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
    // Both sources are merged: a pod IP missing from the set is treated as
    // external and redirected.
    const podCidrEnv = pod.containers
      .flatMap((c) => c.env)
      .find((e) => e.value?.includes('10.244.0.0/24'))
    expect(podCidrEnv?.value).toContain('192.168.0.0/16')
    // Calico's veth prefix by default, passed explicitly because another
    // CNI may name veths differently.
    const vethEnv = pod.containers
      .flatMap((c) => c.env)
      .find((e) => e.name === 'NETD_VETH_PREFIX')
    expect(vethEnv?.value).toBe('cali')
    // Both images resolve through the local registry, never upstream.
    for (const c of pod.containers) expect(c.image).toMatch(/^localhost:5001\//)
  })

  it('adds the configured pod CIDRs and veth prefix for an adopted CNI', async () => {
    // An adopted cluster may use pod IPs in no IPPool or podCIDR (e.g. a
    // VPC CNI) and non-`cali` veths. Configured CIDRs are merged with the
    // discovered ones, since a missing pod IP would be treated as external.
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
    // A malformed entry is dropped; iptables-restore would reject it and
    // stall every redirect update.
    expect(cidrs).not.toContain('not-a-cidr')
    expect(env.find((e) => e.name === 'NETD_VETH_PREFIX')?.value).toBe('eni')
  })

  it('refuses with the install pointer when netd or Envoy is missing from the registry', async () => {
    // `yaac cluster install` produces both images; the server only looks
    // them up and never needs a container engine.
    stageClusterReads()
    mockImageExists.mockResolvedValue(false)

    // Envoy mirrored, netd not: the missing one is the one named.
    mockHasTag.mockImplementation((tag: string) =>
      Promise.resolve(!tag.startsWith('yaac-netd:')))
    await expect(ensureProxyResources('img'))
      .rejects.toThrow(/netd image .* is missing.*yaac cluster install/s)

    // netd present, Envoy absent.
    mockHasTag.mockImplementation((tag: string) =>
      Promise.resolve(tag.startsWith('yaac-netd:')))
    await expect(ensureProxyResources('img'))
      .rejects.toThrow(/Envoy image .* is missing.*yaac cluster install/s)

    expect(podmanArgs().some((a) => a[0] === 'pull')).toBe(false)
    expect(vi.mocked(buildImage)).not.toHaveBeenCalled()
    expect(vi.mocked(registerImageBuild)).not.toHaveBeenCalled()
  })

  it('resolves netd\'s pod-CIDR exclusions from every source, and falls back when none answer', async () => {
    // Without Calico the ippools read fails; node podCIDRs still count.
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

    // No source answers: fall back to kind's default rather than an empty
    // set, which would redirect pod-to-pod traffic into the proxy.
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

    // The pod CIDRs are cached for the process.
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
    // A signed-out tool has no key; the Secret is replaced whole.
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
    // The slug is not DNS-safe, so it is sanitized and given a hash suffix
    // that also spans the install.
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
    // Used by `cluster check` and the builder guard. An apiserver without
    // the resource type errors, which reads as false rather than throwing.
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
    mockRetry.mockImplementation((args: string[]) =>
      args.includes('validatingadmissionpolicies')
        ? Promise.reject(new Error("the server doesn't have a resource type"))
        : Promise.resolve({ stdout: '', stderr: '' }))
    await expect(ensureBuilderRoleGuard()).rejects.toThrow(/yaac cluster install/)
    expect(mockApply).not.toHaveBeenCalled()
  })
})

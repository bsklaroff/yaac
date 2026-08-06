import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'

// Everything faked here is a process boundary or another feature's barrel:
// kubectl, podman (execFileAsync / the container runtime), the local
// registry's HTTP calls, and the image feature's build pipeline. Nothing
// inside features/cluster is mocked — so `ensureProxyResources` drives the
// real proxy manifests, the real policy set, the real cluster-CIDR probes,
// and the real netd (which is internal to the folder and covered only here
// and through cluster setup).
const mockVapAvailable = vi.hoisted(() => vi.fn())
vi.mock('#platform/k8s/kubectl', () => ({
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

vi.mock('#platform/container/registry', () => ({
  registryHasTag: vi.fn().mockResolvedValue(true),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))

vi.mock('#platform/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(true),
}))

vi.mock('#features/cluster/vcluster', () => ({ vapAvailable: mockVapAvailable }))
// netd's image is produced by the host build engine — cluster setup builds it
// before there is a cluster to build it in.
vi.mock('#features/image-engine', () => ({
  contextHash: vi.fn().mockResolvedValue('deadbeefcafe1234'),
  buildImage: vi.fn().mockResolvedValue(undefined),
  registerImageBuild: vi.fn(() => 'build-1'),
  finishImageBuild: vi.fn(),
  failImageBuild: vi.fn(),
}))

import {
  ensureBuilderRoleGuard,
  ensureCaConfigMap,
  ensureNamespace,
  ensureProxyAuthSecret,
  ensureProxyResources,
  proxyServiceClusterIp,
  resetProxyClusterIpCache,
} from '#features/cluster'
import { proxyDataHostDir } from '@yaac/shared/project-paths'
import { resetClusterCidrCache } from '#features/cluster/cluster-cidrs'
import {
  DNS_STUB_PORT,
  EGRESS_WORLD_DENY_NAME,
  LABEL_ROLE,
  NETD_APP_NAME,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_PORT_END,
  OUTER_CA_CONFIGMAP_NAME,
  POD_STREAM_PORT,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_INGRESS_NP_NAME,
  PROXY_PORT,
  PROXY_SA_NAME,
  RELAY_PORT,
  ROLE_INNER_PROXY,
  SESSION_EGRESS_NP_NAME,
  SESSION_INGRESS_LOCK_NP_NAME,
  SSH_AGENT_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
} from '#platform/k8s/proxy-constants'
import { LABEL_DATA_DIR_HASH, LABEL_SESSION_ID } from '#platform/k8s/pods'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#platform/k8s/kubectl'
import { imageExists } from '#platform/container/runtime'
import { registryHasTag } from '#platform/container/registry'
import { buildImage, failImageBuild, registerImageBuild } from '#features/image-engine'
import { CA_CERT_PATH } from '#platform/k8s/pod-spec'
import { credentialsDir } from '@yaac/shared/project-paths'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { execFile } from 'node:child_process'

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
}

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
  mockVapAvailable.mockResolvedValue(true)
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
  it('returns the live (vcluster-allocated) ClusterIP of the proxy Service', async () => {
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
  it('pre-creates host dirs, applies the whole set in order, and waits for both rollouts', async () => {
    stageClusterReads()
    await ensureProxyResources('localhost:5000/yaac-proxy:abc')

    // Host dirs exist (DirectoryOrCreate would have made them root-owned).
    await expect(fs.stat(credentialsDir())).resolves.toBeDefined()
    await expect(fs.stat(proxyDataHostDir())).resolves.toBeDefined()

    expect(kinds()).toEqual([
      'ServiceAccount', 'Role', 'RoleBinding', 'Deployment', 'Service',
      // Session egress, session ingress lock, proxy ingress, world-deny.
      'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy',
      // netd: SA, ClusterRole, ClusterRoleBinding, Role, RoleBinding, DaemonSet.
      'ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding',
      'DaemonSet',
    ])
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
    // Runs as the server host uid, with fsGroup for the emptyDir HOME.
    expect(pod.securityContext?.runAsUser).toBe(process.getuid?.())
    expect(pod.securityContext?.fsGroup).toBe(process.getgid?.())
    expect(pod.volumes).toEqual([
      { name: 'credentials', hostPath: { path: credentialsDir(), type: 'DirectoryOrCreate' } },
      { name: 'proxy-data', hostPath: { path: proxyDataHostDir(), type: 'DirectoryOrCreate' } },
      { name: 'home', emptyDir: {} },
    ])

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
      { name: 'credentials', mountPath: '/yaac-credentials' },
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
    const egress = specOf(byName(SESSION_EGRESS_NP_NAME)) as { egress: Rule[] }
    const nodeRule = egress.egress.find((r) =>
      r.to?.some((p) => JSON.stringify(p).includes(NODE_IP)))
    expect(nodeRule).toBeDefined()
    const rangePorts = egress.egress.flatMap((r) => r.ports ?? [])
      .find((p) => p.port === NETD_LISTENER_PORT_BASE)
    expect(rangePorts?.endPort).toBe(NETD_LISTENER_PORT_END)

    // Session ingress lock: only the proxy's relay dials reach streamd.
    const lock = specOf(byName(SESSION_INGRESS_LOCK_NP_NAME)) as { ingress: Rule[] }
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
    // never from vcluster-synced pods (a nested install has its own agent).
    const agentEgress = egress.egress.find((r) =>
      (r.ports ?? []).some((p) => p.port === SSH_AGENT_PORT))
    expect(JSON.stringify(agentEgress?.to)).toContain(PROXY_APP_NAME)
    const agentIngress = proxyIngress.ingress.filter((r) =>
      (r.ports ?? []).some((p) => p.port === SSH_AGENT_PORT))
    expect(agentIngress).toHaveLength(1)
    expect(JSON.stringify(agentIngress[0].from)).toContain(LABEL_SESSION_ID)
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

  it('builds the netd image when neither the registry nor podman has it', async () => {
    stageClusterReads()
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(false)

    await ensureProxyResources('img')

    expect(vi.mocked(registerImageBuild)).toHaveBeenCalledWith(
      expect.objectContaining({ layer: 'netd', action: 'build' }),
    )
    expect(vi.mocked(buildImage)).toHaveBeenCalledWith(
      expect.stringMatching(/^yaac-netd:/),
      expect.stringContaining('Dockerfile'),
      expect.any(String),
    )
    // Envoy is mirrored rather than built: pull the digest-pinned upstream,
    // verify the arch, retag into the local mirror tag.
    const argvs = podmanArgs()
    expect(argvs).toContainEqual(['pull', expect.stringContaining('envoyproxy/envoy@')])
    expect(argvs.some((a) => a[0] === 'tag')).toBe(true)
  })

  it('marks the netd build failed and rethrows when the image build dies', async () => {
    stageClusterReads()
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(false)
    vi.mocked(buildImage).mockRejectedValueOnce(new Error('podman exploded'))

    await expect(ensureProxyResources('img')).rejects.toThrow('podman exploded')
    expect(vi.mocked(failImageBuild)).toHaveBeenCalledWith('build-1', 'podman exploded')
  })

  it('fails fast on a missing netd or Envoy image when prebuilt images are required', async () => {
    stageClusterReads()
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    mockImageExists.mockResolvedValue(false)

    // Envoy mirrored, netd not: the missing build is the one named.
    mockHasTag.mockImplementation((tag: string) =>
      Promise.resolve(!tag.startsWith('yaac-netd:')))
    await expect(ensureProxyResources('img')).rejects.toThrow(/netd image .* is missing or stale/)

    // netd present, Envoy absent: the mirror is what fails.
    mockHasTag.mockImplementation((tag: string) =>
      Promise.resolve(tag.startsWith('yaac-netd:')))
    await expect(ensureProxyResources('img')).rejects.toThrow(/Envoy image .* is missing/)
    // Nothing was pulled — that is the point of the gate.
    expect(podmanArgs().some((a) => a[0] === 'pull')).toBe(false)
  })

  it('refuses an Envoy mirror built for another architecture', async () => {
    stageClusterReads()
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockImplementation((tag: string) =>
      Promise.resolve(tag.startsWith('yaac-netd:')))
    const realArch = process.arch
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    try {
      // podman reports amd64, which is what x64 means — the mirror is fine.
      mockPodman.mockImplementation(((...allArgs: unknown[]) => {
        const args = allArgs[1] as string[]
        const cb = allArgs[allArgs.length - 1] as (...cbArgs: unknown[]) => void
        const isArchProbe = args.includes('inspect') && args.some((a) => a.includes('Architecture'))
        cb(null, { stdout: isArchProbe ? 'amd64' : '', stderr: '' })
      }) as never)
      await expect(ensureProxyResources('img')).resolves.toBeUndefined()

      // A child manifest for the wrong platform must not be mirrored.
      mockPodman.mockImplementation(((...allArgs: unknown[]) => {
        const args = allArgs[1] as string[]
        const cb = allArgs[allArgs.length - 1] as (...cbArgs: unknown[]) => void
        const isArchProbe = args.includes('inspect') && args.some((a) => a.includes('Architecture'))
        cb(null, { stdout: isArchProbe ? 'arm64' : '', stderr: '' })
      }) as never)
      await expect(ensureProxyResources('img'))
        .rejects.toThrow(/is a arm64 image but this host is amd64/)
    } finally {
      Object.defineProperty(process, 'arch', { value: realArch, configurable: true })
    }
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

  it('nested: projects the outer CA, marks the pod inner-proxy, and runs netd in claim mode', async () => {
    stageClusterReads()
    // mockRestore() also clears the call record, so assert before restoring.
    const readSpy = vi.spyOn(fs, 'readFile').mockResolvedValue('OUTER-CA-PEM')
    await ensureProxyResources('img', { nested: true })

    // The outer CA is read from the inner yaac's own session-pod trust mount.
    expect(readSpy).toHaveBeenCalledWith(CA_CERT_PATH, 'utf8')
    expect(byName(OUTER_CA_CONFIGMAP_NAME)).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: OUTER_CA_CONFIGMAP_NAME, namespace: 'test-ns' },
      data: { 'proxy-ca.pem': 'OUTER-CA-PEM' },
    })
    // Applied before the Deployment so the configMap mount resolves on first
    // schedule (a missing source would keep the pod ContainerCreating).
    expect(kinds().indexOf('ConfigMap')).toBeLessThan(kinds().indexOf('Deployment'))

    const dep = applied().find((m) => m.kind === 'Deployment') as unknown as {
      spec: { template: {
        metadata: { labels: Record<string, string> }
        spec: {
          dnsPolicy?: string
          dnsConfig?: { nameservers: string[] }
          runtimeClassName?: string
          volumes: Array<Record<string, unknown>>
          containers: Array<{
            env: Array<Record<string, unknown>>
            volumeMounts: Array<Record<string, unknown>>
          }>
        }
      } }
    }
    // yaac.role=inner-proxy is what keeps netd from redirecting the inner
    // proxy into itself — its upstream dial must fall through to the outer.
    expect(dep.spec.template.metadata.labels[LABEL_ROLE]).toBe(ROLE_INNER_PROXY)
    // Still runc, and it resolves DNS via its own loopback stub rather than
    // the vcluster's CoreDNS.
    expect(dep.spec.template.spec.runtimeClassName).toBeUndefined()
    expect(dep.spec.template.spec.dnsPolicy).toBe('None')
    expect(dep.spec.template.spec.dnsConfig).toEqual({ nameservers: ['127.0.0.1'] })
    // Without the outer CA the chained upstream dial fails closed with
    // "self-signed certificate in certificate chain".
    expect(dep.spec.template.spec.containers[0].env)
      .toContainEqual({ name: 'NODE_EXTRA_CA_CERTS', value: '/etc/yaac/outer-ca/proxy-ca.pem' })
    expect(dep.spec.template.spec.volumes)
      .toContainEqual({ name: 'outer-ca', configMap: { name: OUTER_CA_CONFIGMAP_NAME } })

    // Claim-mode netd: the inner install publishes what it wants redirected
    // through a ConfigMap and the host validates and programs it. No Envoy
    // is mirrored and no pod CIDRs are read — it programs nothing itself.
    const claimCm = applied().filter((m) => m.kind === 'ConfigMap')
      .find((m) => m.metadata.name !== OUTER_CA_CONFIGMAP_NAME)
    expect(claimCm).toBeDefined()
    expect(kinds()).toContain('DaemonSet')
    expect(kinds()).not.toContain('ClusterRole')
    expect(podmanArgs().some((a) => a[0] === 'pull')).toBe(false)
    readSpy.mockRestore()
  })
})

describe('ensureCaConfigMap', () => {
  it('skips the apply only when both the CA and the bundle already match', async () => {
    mockGetJson.mockResolvedValue({
      data: { 'proxy-ca.pem': 'PEM-CONTENT', 'ca-bundle.pem': 'BUNDLE' },
    })
    await ensureCaConfigMap('PEM-CONTENT', 'BUNDLE')
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('applies the ConfigMap with both keys when absent or stale', async () => {
    mockGetJson.mockResolvedValue(null)
    await ensureCaConfigMap('NEW-PEM', 'NEW-BUNDLE')
    expect(mockApply).toHaveBeenCalledWith({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'yaac-proxy-ca', namespace: 'test-ns' },
      data: { 'proxy-ca.pem': 'NEW-PEM', 'ca-bundle.pem': 'NEW-BUNDLE' },
    })

    mockApply.mockClear()
    mockGetJson.mockResolvedValue({ data: { 'proxy-ca.pem': 'OLD-PEM' } })
    await ensureCaConfigMap('NEW-PEM', 'NEW-BUNDLE')
    expect(mockApply).toHaveBeenCalledTimes(1)
  })

  it('re-applies when the CA matches but the bundle drifted (e.g. roots refresh)', async () => {
    mockGetJson.mockResolvedValue({
      data: { 'proxy-ca.pem': 'SAME', 'ca-bundle.pem': 'OLD-BUNDLE' },
    })
    await ensureCaConfigMap('SAME', 'NEW-BUNDLE')
    expect(mockApply).toHaveBeenCalledTimes(1)
  })
})

describe('ensureBuilderRoleGuard', () => {
  it('applies the cluster-wide guard policy and binding', async () => {
    await ensureBuilderRoleGuard()
    expect(applied().map((m) => m.kind))
      .toEqual(['ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding'])
  })

  it('throws with a setup pointer when the VAP API is missing', async () => {
    mockVapAvailable.mockResolvedValue(false)
    await expect(ensureBuilderRoleGuard()).rejects.toThrow(/yaac cluster setup/)
    expect(mockApply).not.toHaveBeenCalled()
  })
})

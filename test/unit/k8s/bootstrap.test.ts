import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

vi.mock('@/lib/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('@/lib/git', async (importOriginal) => {
  const actual = await importOriginal<typeof gitModule>()
  return {
    ...actual,
    isTorEnabled: vi.fn(() => false),
  }
})

import {
  CLUSTER_SERVICE_CIDR,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_PORT,
  RELAY_DNS_PORT,
  SESSION_NETWORK_POLICY_NAME,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_TUNNEL_PORT,
  buildProxyDeploymentManifest,
  buildProxyServiceManifest,
  buildSessionNetworkPolicyManifest,
  clusterIpForNamespace,
  ensureCaConfigMap,
  ensureNamespace,
  ensureProxyAuthSecret,
  ensureProxyResources,
  proxyDataHostDir,
  sshAgentHostDir,
} from '@/lib/k8s/bootstrap'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '@/lib/k8s/kubectl'
import { isTorEnabled } from '@/lib/git'
import { credentialsDir } from '@/lib/project/paths'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import type * as gitModule from '@/lib/git'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockTor = vi.mocked(isTorEnabled)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockApply.mockReset()
  mockApply.mockResolvedValue(undefined)
  mockGetJson.mockReset()
  mockRetry.mockReset()
  mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockTor.mockReturnValue(false)
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

describe('constants', () => {
  it('expose the proxy app/secret names and in-cluster ports', () => {
    expect(PROXY_APP_NAME).toBe('yaac-proxy')
    expect(PROXY_AUTH_SECRET_NAME).toBe('yaac-proxy-auth')
    expect(PROXY_PORT).toBe(10255)
    expect(TRANSPARENT_HTTPS_PORT).toBe(10256)
    expect(TRANSPARENT_HTTP_PORT).toBe(10257)
    expect(TRANSPARENT_TUNNEL_PORT).toBe(10258)
    expect(RELAY_DNS_PORT).toBe(15004)
  })

  it('pin the VIP-pin service CIDR to the kind-config value', () => {
    expect(CLUSTER_SERVICE_CIDR).toBe('10.96.0.0/16')
  })
})

describe('clusterIpForNamespace', () => {
  it('is deterministic — Service recreation reproduces the identical VIP', () => {
    expect(clusterIpForNamespace('test-ns')).toBe(clusterIpForNamespace('test-ns'))
    expect(clusterIpForNamespace('test-ns')).toBe('10.96.40.19')
    expect(clusterIpForNamespace('yaac')).toBe('10.96.220.80')
  })

  it('stays inside the service /16, skipping the low 16 and the broadcast edge', () => {
    // offset (3rd*256 + 4th octet) must land in [16, 65519] of the /16.
    for (let i = 0; i < 2000; i++) {
      const octets = clusterIpForNamespace(`yaac-test-${i}`).split('.').map(Number)
      expect(octets.slice(0, 2)).toEqual([10, 96])
      const offset = octets[2] * 256 + octets[3]
      expect(offset).toBeGreaterThanOrEqual(16)
      expect(offset).toBeLessThanOrEqual(65519)
    }
  })

  it('can never collide with the apiserver (10.96.0.1) or kube-dns (10.96.0.10)', () => {
    // Both live in the skipped low 16, so no namespace can hash onto them.
    for (let i = 0; i < 5000; i++) {
      const ip = clusterIpForNamespace(`ns-${i}`)
      expect(ip).not.toBe('10.96.0.1')
      expect(ip).not.toBe('10.96.0.10')
    }
  })

  it('uses the wide band — distinct namespaces spread across many /24s', () => {
    const thirdOctets = new Set<number>()
    for (let i = 0; i < 500; i++) {
      thirdOctets.add(Number(clusterIpForNamespace(`ns-${i}`).split('.')[2]))
    }
    // A single-/24 band would collapse all of these to third octet 0; the
    // /16 band must spread them across well over a dozen distinct /24s.
    expect(thirdOctets.size).toBeGreaterThan(50)
    expect(clusterIpForNamespace('test-ns')).not.toBe(clusterIpForNamespace('other-ns'))
  })
})

describe('sshAgentHostDir / proxyDataHostDir', () => {
  it('live under <dataDir>/run', () => {
    expect(sshAgentHostDir()).toBe(path.join(tmpDir, 'run', 'ssh-agent'))
    expect(proxyDataHostDir()).toBe(path.join(tmpDir, 'run', 'proxy-data'))
  })
})

describe('ensureNamespace', () => {
  it('applies a Namespace manifest for the active namespace', async () => {
    await ensureNamespace()
    expect(mockApply).toHaveBeenCalledWith({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'test-ns' },
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

interface DeploymentManifest {
  kind: string
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: {
    replicas: number
    strategy: { type: string }
    selector: { matchLabels: Record<string, string> }
    template: {
      metadata: { labels: Record<string, string> }
      spec: {
        automountServiceAccountToken: boolean
        enableServiceLinks: boolean
        securityContext?: { runAsUser?: number; runAsGroup?: number; fsGroup?: number }
        containers: Array<{
          image: string
          ports: Array<{ containerPort: number }>
          env: Array<Record<string, unknown>>
          readinessProbe: { httpGet: { path: string; port: number } }
          volumeMounts: Array<{ name: string; mountPath: string }>
        }>
        volumes: Array<{ name: string; hostPath?: { path: string; type: string }; emptyDir?: object }>
      }
    }
  }
}

describe('buildProxyDeploymentManifest', () => {
  function build(): DeploymentManifest {
    return buildProxyDeploymentManifest('localhost:5000/yaac-proxy:abc') as unknown as DeploymentManifest
  }

  it('runs one replica with the Recreate strategy (no socket-sharing overlap)', () => {
    const m = build()
    expect(m.kind).toBe('Deployment')
    expect(m.metadata.name).toBe(PROXY_APP_NAME)
    expect(m.metadata.namespace).toBe('test-ns')
    expect(m.spec.replicas).toBe(1)
    expect(m.spec.strategy).toEqual({ type: 'Recreate' })
    expect(m.spec.selector.matchLabels).toEqual({ app: PROXY_APP_NAME })
  })

  it('wires the image, ports, auth secret env, and readiness probe', () => {
    const c = build().spec.template.spec.containers[0]
    expect(c.image).toBe('localhost:5000/yaac-proxy:abc')
    expect(c.ports).toEqual([
      { containerPort: PROXY_PORT },
      { containerPort: TRANSPARENT_HTTPS_PORT },
      { containerPort: TRANSPARENT_HTTP_PORT },
      { containerPort: TRANSPARENT_TUNNEL_PORT },
    ])
    expect(c.env).toContainEqual({ name: 'API_PORT', value: String(PROXY_PORT) })
    expect(c.env).toContainEqual({ name: 'TRANSPARENT_HTTPS_PORT', value: String(TRANSPARENT_HTTPS_PORT) })
    expect(c.env).toContainEqual({ name: 'TRANSPARENT_HTTP_PORT', value: String(TRANSPARENT_HTTP_PORT) })
    expect(c.env).toContainEqual({ name: 'TRANSPARENT_TUNNEL_PORT', value: String(TRANSPARENT_TUNNEL_PORT) })
    expect(c.env).toContainEqual({
      name: 'PROXY_AUTH_SECRET',
      valueFrom: { secretKeyRef: { name: PROXY_AUTH_SECRET_NAME, key: 'secret' } },
    })
    // HOME points at the emptyDir mount so ssh-add/known_hosts work when
    // the proxy runs as the daemon uid (not the image's node user).
    expect(c.env).toContainEqual({ name: 'HOME', value: '/home/proxy' })
    expect(c.readinessProbe.httpGet).toEqual({ path: '/healthz', port: PROXY_PORT })
  })

  it('mounts credentials, ssh-agent, and proxy-data hostPaths (DirectoryOrCreate)', () => {
    const spec = build().spec.template.spec
    expect(spec.automountServiceAccountToken).toBe(false)
    expect(spec.enableServiceLinks).toBe(false)
    expect(spec.volumes).toEqual([
      { name: 'credentials', hostPath: { path: credentialsDir(), type: 'DirectoryOrCreate' } },
      { name: 'ssh-agent', hostPath: { path: sshAgentHostDir(), type: 'DirectoryOrCreate' } },
      { name: 'proxy-data', hostPath: { path: proxyDataHostDir(), type: 'DirectoryOrCreate' } },
      { name: 'home', emptyDir: {} },
    ])
    expect(spec.containers[0].volumeMounts).toEqual([
      { name: 'credentials', mountPath: '/yaac-credentials' },
      { name: 'ssh-agent', mountPath: '/ssh-agent' },
      { name: 'proxy-data', mountPath: '/data' },
      { name: 'home', mountPath: '/home/proxy' },
    ])
  })

  it('runs as the daemon host uid with fsGroup for the emptyDir HOME', () => {
    const sc = build().spec.template.spec.securityContext
    expect(sc?.runAsUser).toBe(process.getuid?.())
    expect(sc?.runAsGroup).toBe(process.getgid?.())
    expect(sc?.fsGroup).toBe(process.getgid?.())
  })

  it('adds USE_TOR only when tor is enabled', () => {
    expect(build().spec.template.spec.containers[0].env)
      .not.toContainEqual({ name: 'USE_TOR', value: '1' })
    mockTor.mockReturnValue(true)
    expect(build().spec.template.spec.containers[0].env)
      .toContainEqual({ name: 'USE_TOR', value: '1' })
  })
})

describe('buildProxyServiceManifest', () => {
  it('exposes a ClusterIP service on the proxy + transparent ports (port == targetPort)', () => {
    expect(buildProxyServiceManifest()).toEqual({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: PROXY_APP_NAME,
        namespace: 'test-ns',
        labels: { app: PROXY_APP_NAME },
      },
      spec: {
        type: 'ClusterIP',
        // Pinned per namespace: session relays dial this VIP from env.
        clusterIP: clusterIpForNamespace('test-ns'),
        selector: { app: PROXY_APP_NAME },
        ports: [
          { name: 'proxy', port: PROXY_PORT, targetPort: PROXY_PORT },
          { name: 'transparent-https', port: TRANSPARENT_HTTPS_PORT, targetPort: TRANSPARENT_HTTPS_PORT },
          { name: 'transparent-http', port: TRANSPARENT_HTTP_PORT, targetPort: TRANSPARENT_HTTP_PORT },
          { name: 'transparent-tunnel', port: TRANSPARENT_TUNNEL_PORT, targetPort: TRANSPARENT_TUNNEL_PORT },
        ],
      },
    })
  })
})

describe('buildSessionNetworkPolicyManifest', () => {
  it('locks session-pod egress to the proxy transparent transport ports only', () => {
    expect(buildSessionNetworkPolicyManifest()).toEqual({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: SESSION_NETWORK_POLICY_NAME,
        namespace: 'test-ns',
        labels: { app: PROXY_APP_NAME },
      },
      spec: {
        podSelector: {
          matchExpressions: [{ key: 'yaac.session-id', operator: 'Exists' }],
        },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }],
            // Transport ports (post-DNAT), not the original 443/80.
            ports: [
              { protocol: 'TCP', port: TRANSPARENT_HTTPS_PORT },
              { protocol: 'TCP', port: TRANSPARENT_HTTP_PORT },
              { protocol: 'TCP', port: TRANSPARENT_TUNNEL_PORT },
            ],
          },
        ],
      },
    })
  })

  it('admits neither the explicit proxy port nor kube-dns', () => {
    const manifest = buildSessionNetworkPolicyManifest() as {
      spec: { egress: Array<{ ports: Array<{ port: number }> }> }
    }
    // 10255 serves only the daemon's port-forwarded control API, and DNS
    // never leaves the pod (the relay stub answers it) — neither belongs
    // in the session egress surface.
    expect(manifest.spec.egress).toHaveLength(1)
    const ports = manifest.spec.egress[0].ports.map((p) => p.port)
    expect(ports).not.toContain(PROXY_PORT)
    expect(ports).not.toContain(53)
  })
})

describe('ensureProxyResources', () => {
  it('pre-creates host dirs, applies both manifests, and waits for the rollout', async () => {
    mockGetJson.mockResolvedValue(null) // no live Service yet
    await ensureProxyResources('localhost:5000/yaac-proxy:abc')

    // Host dirs exist (DirectoryOrCreate would have made them root-owned).
    await expect(fs.stat(credentialsDir())).resolves.toBeDefined()
    await expect(fs.stat(sshAgentHostDir())).resolves.toBeDefined()
    await expect(fs.stat(proxyDataHostDir())).resolves.toBeDefined()

    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toEqual(['Deployment', 'Service', 'NetworkPolicy'])
    // A fresh cluster needs no VIP migration delete.
    expect(mockRetry).not.toHaveBeenCalledWith(
      expect.arrayContaining(['delete', 'service']),
    )
    expect(mockRetry).toHaveBeenCalledWith(
      [
        'rollout', 'status', `deployment/${PROXY_APP_NAME}`,
        '-n', 'test-ns',
        '--timeout=180s',
      ],
      expect.objectContaining({ maxAttempts: 2 }),
    )
  })

  it('leaves a Service already at the pinned VIP untouched', async () => {
    mockGetJson.mockResolvedValue({ spec: { clusterIP: clusterIpForNamespace('test-ns') } })
    await ensureProxyResources('localhost:5000/yaac-proxy:abc')
    expect(mockRetry).not.toHaveBeenCalledWith(
      expect.arrayContaining(['delete', 'service']),
    )
  })

  it('migrates a pre-pin Service: deletes it before re-applying (clusterIP is immutable)', async () => {
    mockGetJson.mockResolvedValue({ spec: { clusterIP: '10.96.123.45' } })
    await ensureProxyResources('localhost:5000/yaac-proxy:abc')

    const deleteIdx = mockRetry.mock.calls.findIndex(
      (c) => c[0][0] === 'delete' && c[0][1] === 'service',
    )
    expect(deleteIdx).toBeGreaterThanOrEqual(0)
    expect(mockRetry.mock.calls[deleteIdx][0]).toEqual([
      'delete', 'service', PROXY_APP_NAME, '-n', 'test-ns', '--ignore-not-found',
    ])
    // The delete happens before any apply, so the re-apply recreates the
    // Service at the pinned VIP instead of failing on the immutable field.
    expect(mockApply).toHaveBeenCalled()
  })
})

describe('ensureCaConfigMap', () => {
  it('skips the apply when the stored PEM already matches', async () => {
    mockGetJson.mockResolvedValue({ data: { 'proxy-ca.pem': 'PEM-CONTENT' } })
    await ensureCaConfigMap('PEM-CONTENT')
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('applies the ConfigMap when absent or stale', async () => {
    mockGetJson.mockResolvedValue(null)
    await ensureCaConfigMap('NEW-PEM')
    expect(mockApply).toHaveBeenCalledWith({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'yaac-proxy-ca', namespace: 'test-ns' },
      data: { 'proxy-ca.pem': 'NEW-PEM' },
    })

    mockApply.mockClear()
    mockGetJson.mockResolvedValue({ data: { 'proxy-ca.pem': 'OLD-PEM' } })
    await ensureCaConfigMap('NEW-PEM')
    expect(mockApply).toHaveBeenCalledTimes(1)
  })
})

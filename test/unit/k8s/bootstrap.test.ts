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
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_PORT,
  SESSION_NETWORK_POLICY_NAME,
  buildProxyDeploymentManifest,
  buildProxyServiceManifest,
  buildSessionNetworkPolicyManifest,
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
  it('expose the proxy app/secret names and in-cluster port', () => {
    expect(PROXY_APP_NAME).toBe('yaac-proxy')
    expect(PROXY_AUTH_SECRET_NAME).toBe('yaac-proxy-auth')
    expect(PROXY_PORT).toBe(10255)
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

  it('wires the image, port, auth secret env, and readiness probe', () => {
    const c = build().spec.template.spec.containers[0]
    expect(c.image).toBe('localhost:5000/yaac-proxy:abc')
    expect(c.ports).toEqual([{ containerPort: PROXY_PORT }])
    expect(c.env).toContainEqual({ name: 'PORT', value: String(PROXY_PORT) })
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
  it('exposes a ClusterIP service on the proxy port', () => {
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
        selector: { app: PROXY_APP_NAME },
        ports: [{ port: PROXY_PORT, targetPort: PROXY_PORT }],
      },
    })
  })
})

describe('buildSessionNetworkPolicyManifest', () => {
  it('locks session-pod egress to the proxy port and kube-dns only', () => {
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
            ports: [{ protocol: 'TCP', port: PROXY_PORT }],
          },
          {
            to: [{
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
              },
              podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
            }],
            ports: [
              { protocol: 'UDP', port: 53 },
              { protocol: 'TCP', port: 53 },
            ],
          },
        ],
      },
    })
  })
})

describe('ensureProxyResources', () => {
  it('pre-creates host dirs, applies both manifests, and waits for the rollout', async () => {
    await ensureProxyResources('localhost:5000/yaac-proxy:abc')

    // Host dirs exist (DirectoryOrCreate would have made them root-owned).
    await expect(fs.stat(credentialsDir())).resolves.toBeDefined()
    await expect(fs.stat(sshAgentHostDir())).resolves.toBeDefined()
    await expect(fs.stat(proxyDataHostDir())).resolves.toBeDefined()

    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toEqual(['Deployment', 'Service', 'NetworkPolicy'])
    expect(mockRetry).toHaveBeenCalledWith(
      [
        'rollout', 'status', `deployment/${PROXY_APP_NAME}`,
        '-n', 'test-ns',
        '--timeout=180s',
      ],
      expect.objectContaining({ maxAttempts: 2 }),
    )
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

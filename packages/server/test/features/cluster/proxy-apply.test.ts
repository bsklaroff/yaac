import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

vi.mock('#platform/k8s/kubectl', () => ({
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

// ensureProxyResources(nested) registers the Cilium CRDs into the vcluster;
// no test here exercises the real CRD apply, so stub it out.
vi.mock('#platform/k8s/cilium-crds', () => ({
  ensureCiliumCrds: vi.fn().mockResolvedValue(undefined),
}))

import {
  ensureCaConfigMap,
  ensureNamespace,
  ensureProxyAuthSecret,
  ensureProxyResources,
  proxyServiceClusterIp,
  proxyDataHostDir,
  sshAgentHostDir,
} from '#features/cluster/proxy-apply'
import {
  OUTER_CA_CONFIGMAP_NAME,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
} from '#features/cluster/proxy-constants'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#platform/k8s/kubectl'
import { CA_CERT_PATH } from '#platform/k8s/pod-spec'
import { credentialsDir } from '@yaac/shared/project-paths'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockApply.mockReset()
  mockApply.mockResolvedValue(undefined)
  mockGetJson.mockReset()
  mockRetry.mockReset()
  mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
  vi.stubEnv('YAAC_USE_TOR', '')
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
  vi.unstubAllEnvs()
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

describe('proxyServiceClusterIp', () => {
  it('returns the live (vcluster-allocated) ClusterIP of the proxy Service', async () => {
    mockGetJson.mockResolvedValue({ spec: { clusterIP: '10.96.92.236' } })
    expect(await proxyServiceClusterIp()).toBe('10.96.92.236')
  })

  it('throws if the Service has no ClusterIP yet', async () => {
    mockGetJson.mockResolvedValue({ spec: {} })
    await expect(proxyServiceClusterIp()).rejects.toThrow(/ClusterIP/)
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
    expect(kinds).toEqual([
      'ServiceAccount', 'Role', 'RoleBinding', 'Deployment', 'Service',
      'CiliumEnvoyConfig', 'CiliumNetworkPolicy', 'CiliumClusterwideEnvoyConfig',
      'CiliumNetworkPolicy', 'CiliumNetworkPolicy',
    ])
    // The proxy Service ClusterIP is allocator-assigned and never deleted —
    // no pin migration, so ensureProxyResources issues no `delete service`.
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

  it('nested: projects the outer CA ConfigMap (read from CA_CERT_PATH) before the Deployment', async () => {
    mockGetJson.mockResolvedValue(null)
    // mockRestore() also clears the call record, so assert before restoring.
    const readSpy = vi.spyOn(fs, 'readFile').mockResolvedValue('OUTER-CA-PEM')
    await ensureProxyResources('img', { nested: true })
    // The outer CA is read from the inner yaac's own session-pod trust mount.
    expect(readSpy).toHaveBeenCalledWith(CA_CERT_PATH, 'utf8')
    const cmCall = mockApply.mock.calls.find(
      (c) => (c[0] as { kind: string }).kind === 'ConfigMap',
    )
    expect(cmCall?.[0]).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: OUTER_CA_CONFIGMAP_NAME, namespace: 'test-ns' },
      data: { 'proxy-ca.pem': 'OUTER-CA-PEM' },
    })
    // Applied before the Deployment so the configMap mount resolves on first
    // schedule (a missing source would keep the pod ContainerCreating).
    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds.indexOf('ConfigMap')).toBeLessThan(kinds.indexOf('Deployment'))
    // The cluster-scoped fallback CCEC is HOST-ONLY: the nested vcluster has no
    // CiliumClusterwideEnvoyConfig CRD (ensureCiliumCrds installs only CEC/CNP),
    // and a nested yaac creates no vcluster sessions to reference it.
    expect(kinds).not.toContain('CiliumClusterwideEnvoyConfig')
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

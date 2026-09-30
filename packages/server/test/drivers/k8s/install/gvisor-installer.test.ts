import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('#drivers/k8s/container/registry', () => ({
  invalidateRegistryEndpoint: vi.fn(),
  registryHasTag: vi.fn().mockResolvedValue(false),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))

vi.mock('#drivers/k8s/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
}))

import { ensureGvisorRuntime } from '#drivers/k8s/install'
// Setup values, not units under test.
import {
  GVISOR_INSTALLER_APP_NAME,
  GVISOR_INSTALLER_MIRROR_TAG,
  GVISOR_INSTALLER_UPSTREAM_IMAGE,
} from '#drivers/k8s/install/gvisor-installer'
import {
  GVISOR_INSTALLER_READY_FILE,
  GVISOR_NODE_LABEL,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
} from '#drivers/k8s/substrate'
import { execFileAsync, kubectlApply, kubectlWithRetry } from '#drivers/k8s/substrate/kubectl'
import { imageExists } from '#drivers/k8s/container/runtime'
import {
  invalidateRegistryEndpoint,
  pushImageToRegistry,
  registryHasTag,
} from '#drivers/k8s/container/registry'

const mockApply = vi.mocked(kubectlApply)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockExec = vi.mocked(execFileAsync)
const mockHasTag = vi.mocked(registryHasTag)
const mockImageExists = vi.mocked(imageExists)
const mockPush = vi.mocked(pushImageToRegistry)
const mockInvalidate = vi.mocked(invalidateRegistryEndpoint)

interface Applied {
  kind: string
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  [key: string]: unknown
}

/** Every manifest this ensure applied, in order. */
function applied(): Applied[] {
  return mockApply.mock.calls.map(([m]) => m as unknown as Applied)
}

function ofKind(kind: string): Applied[] {
  return applied().filter((m) => m.kind === kind)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockHasTag.mockResolvedValue(true)
  mockImageExists.mockResolvedValue(false)
  mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ensureGvisorRuntime', () => {
  it('applies the installer DaemonSet, waits for it, then applies the RuntimeClasses', async () => {
    await ensureGvisorRuntime()

    expect(applied().map((m) => m.kind)).toEqual([
      'ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'DaemonSet',
      'RuntimeClass', 'RuntimeClass',
    ])

    const ds = ofKind('DaemonSet')[0] as unknown as {
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      spec: {
        selector: { matchLabels: Record<string, string> }
        updateStrategy: { type: string; rollingUpdate: { maxUnavailable: number } }
        template: {
          metadata: { labels: Record<string, string> }
          spec: {
            hostNetwork: boolean
            hostPID: boolean
            dnsPolicy: string
            nodeSelector?: Record<string, string>
            serviceAccountName: string
            runtimeClassName?: string
            tolerations: Array<{ operator: string }>
            priorityClassName: string
            containers: Array<{
              image: string
              command: string[]
              securityContext: { privileged: boolean; runAsUser: number }
              env: Array<{ name: string; valueFrom: { fieldRef: { fieldPath: string } } }>
              readinessProbe: { exec: { command: string[] } }
              volumeMounts: Array<{ name: string; mountPath: string }>
            }>
            volumes: Array<{ name: string; hostPath?: { path: string } }>
          }
        }
      }
    }
    expect(ds.metadata.name).toBe(GVISOR_INSTALLER_APP_NAME)
    expect(ds.metadata.namespace).toBe('test-ns')
    const pod = ds.spec.template.spec

    // Privileged + hostPID: it installs node binaries, edits containerd's
    // config and restarts containerd from PID 1's mount namespace.
    expect(pod.containers[0].securityContext).toEqual({ privileged: true, runAsUser: 0 })
    expect(pod.hostPID).toBe(true)
    // Host network and DNS, so it works before CNI/CoreDNS are up.
    expect(pod.hostNetwork).toBe(true)
    expect(pod.dnsPolicy).toBe('Default')
    // runc: it installs gVisor, so it cannot run on it.
    expect(pod.runtimeClassName).toBeUndefined()
    // Node infrastructure: runs on every node and is not evicted first.
    expect(pod.tolerations).toEqual([{ operator: 'Exists' }])
    expect(pod.priorityClassName).toBe('system-node-critical')
    // One node's containerd restart at a time.
    expect(ds.spec.updateStrategy).toEqual({
      type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 },
    })

    // Runs from the mirrored upstream image, with the node name for the
    // label patch.
    expect(pod.containers[0].image).toBe(`localhost:5001/${GVISOR_INSTALLER_MIRROR_TAG}`)
    expect(pod.containers[0].command[0]).toBe('sh')
    expect(pod.containers[0].command[2]).toContain('nsenter -t 1 -m -- systemctl restart containerd')
    // The same pass also tunes the node (docs/cluster-setup.md).
    expect(pod.containers[0].command[2]).toContain('nsenter -t 1 -m -- systemctl daemon-reexec')
    expect(pod.containers[0].env).toEqual([
      { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
    ])
    // Ready means this node's runtime is live, which the rollout waits for.
    expect(pod.containers[0].readinessProbe.exec.command)
      .toEqual(['test', '-f', GVISOR_INSTALLER_READY_FILE])
    expect(pod.volumes.filter((v) => v.hostPath).map((v) => v.hostPath!.path))
      .toEqual(['/usr/local/bin', '/etc/containerd', '/var/lib/yaac/gvisor', '/etc/systemd/system.conf.d'])

    // RBAC: only labelling nodes.
    const role = ofKind('ClusterRole')[0] as unknown as {
      metadata: { name: string; labels: Record<string, string> }
      rules: Array<{ apiGroups: string[]; resources: string[]; verbs: string[] }>
    }
    expect(role.rules).toEqual([
      { apiGroups: [''], resources: ['nodes'], verbs: ['get', 'patch'] },
    ])
    // Cluster-scoped names include the namespace so the real install and
    // e2e runs can coexist.
    expect(role.metadata.name).toBe(`${GVISOR_INSTALLER_APP_NAME}-test-ns`)
    expect(role.metadata.labels['yaac.install-namespace']).toBe('test-ns')
    const binding = ofKind('ClusterRoleBinding')[0] as unknown as {
      roleRef: { name: string }
      subjects: Array<{ name: string; namespace: string }>
    }
    expect(binding.roleRef.name).toBe(`${GVISOR_INSTALLER_APP_NAME}-test-ns`)
    expect(binding.subjects).toEqual([
      { kind: 'ServiceAccount', name: GVISOR_INSTALLER_APP_NAME, namespace: 'test-ns' },
    ])

    // RuntimeClasses select on the label the DaemonSet adds, so they are
    // applied after the rollout; otherwise gVisor pods would sit Pending.
    expect(mockRetry).toHaveBeenCalledWith(
      ['rollout', 'status', `daemonset/${GVISOR_INSTALLER_APP_NAME}`, '-n', 'test-ns', '--timeout=300s'],
      expect.objectContaining({ maxAttempts: 2 }),
    )
    const rolloutOrder = mockRetry.mock.invocationCallOrder[0]
    const classApplies = mockApply.mock.calls
      .map((c, i) => ({ kind: (c[0] as unknown as Applied).kind, order: mockApply.mock.invocationCallOrder[i] }))
    expect(classApplies.filter((c) => c.kind === 'RuntimeClass').every((c) => c.order > rolloutOrder))
      .toBe(true)
    expect(classApplies.find((c) => c.kind === 'DaemonSet')!.order).toBeLessThan(rolloutOrder)

    // Restarting containerd kills port-forwards. The registry forward is
    // dropped after the rollout so the next lookup reconnects instead of
    // reading a dead connection as a missing image.
    expect(mockInvalidate).toHaveBeenCalledTimes(1)
    expect(mockInvalidate.mock.invocationCallOrder[0]).toBeGreaterThan(rolloutOrder)

    const classes = ofKind('RuntimeClass') as unknown as Array<{
      metadata: { name: string }
      handler: string
      scheduling: { nodeSelector: Record<string, string> }
    }>
    expect(classes.map((c) => c.metadata.name))
      .toEqual([RUNTIME_CLASS_GVISOR, RUNTIME_CLASS_GVISOR_NESTED])
    expect(classes.map((c) => c.handler)).toEqual(['runsc', 'runsc-nested'])
    for (const c of classes) {
      expect(c.scheduling.nodeSelector).toEqual({ [GVISOR_NODE_LABEL]: 'true' })
    }
  })

  it('installs on every node by default, and only in a pool when one is named', async () => {
    await ensureGvisorRuntime()
    const spec = (): Record<string, unknown> =>
      ((ofKind('DaemonSet')[0].spec as { template: { spec: Record<string, unknown> } })
        .template.spec)
    // No selector field, rather than an empty one.
    expect(spec()).not.toHaveProperty('nodeSelector')

    // With a workspace node pool, only that pool gets gVisor (and a
    // containerd restart). The RuntimeClass selector follows the label.
    vi.clearAllMocks()
    mockHasTag.mockResolvedValue(true)
    await ensureGvisorRuntime({ nodeSelector: { 'yaac.node-pool': 'sessions' } })
    expect(spec().nodeSelector).toEqual({ 'yaac.node-pool': 'sessions' })
  })

  it('declares a tainted pool\'s toleration on the RuntimeClasses, not on the DaemonSet', async () => {
    const tolerations = [
      { key: 'yaac.dev/sessions', operator: 'Equal', value: 'true', effect: 'NoSchedule' },
      { key: 'yaac.dev/sessions', operator: 'Equal', value: 'true', effect: 'NoExecute' },
    ]
    await ensureGvisorRuntime({
      nodeSelector: { 'yaac.node-pool': 'sessions' },
      tolerations,
    })

    // The pool toleration goes on the RuntimeClasses: admission adds it to
    // every pod using the class, so gVisor pods reach a tainted pool without
    // knowing about it. Cluster check reads it back too.
    const classes = ofKind('RuntimeClass') as unknown as Array<{
      scheduling: { nodeSelector: Record<string, string>; tolerations?: unknown }
    }>
    expect(classes).toHaveLength(2)
    for (const c of classes) {
      expect(c.scheduling.tolerations).toEqual(tolerations)
      expect(c.scheduling.nodeSelector).toEqual({ [GVISOR_NODE_LABEL]: 'true' })
    }

    // The DaemonSet already tolerates everything.
    const pod = (ofKind('DaemonSet')[0].spec as {
      template: { spec: { tolerations: unknown; nodeSelector: Record<string, string> } }
    }).template.spec
    expect(pod.tolerations).toEqual([{ operator: 'Exists' }])
    expect(pod.nodeSelector).toEqual({ 'yaac.node-pool': 'sessions' })
  })

  it('takes the installer image from the registry, never the host engine', async () => {
    // `yaac cluster install` mirrors the digest-pinned upstream image; this
    // only looks it up, so applying the DaemonSet needs no container engine.
    await ensureGvisorRuntime()
    expect(GVISOR_INSTALLER_UPSTREAM_IMAGE).toMatch(/^docker\.io\/curlimages\/curl@sha256:[0-9a-f]{64}$/)
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockApply).toHaveBeenCalled()
  })

  it('refuses, naming the command that mirrors it, when the registry lacks the tag', async () => {
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(false)
    await expect(ensureGvisorRuntime()).rejects.toThrow(/missing.*yaac cluster install/s)
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockApply).not.toHaveBeenCalled()
  })
})

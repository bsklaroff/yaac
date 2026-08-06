import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#platform/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('#platform/container/registry', () => ({
  registryHasTag: vi.fn().mockResolvedValue(false),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))

vi.mock('#platform/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
}))

import { ensureGvisorRuntime } from '#features/cluster'
// Setup values: the object names and the image pin the assertions compare
// against.
import {
  GVISOR_INSTALLER_APP_NAME,
  GVISOR_INSTALLER_MIRROR_TAG,
  GVISOR_INSTALLER_UPSTREAM_IMAGE,
} from '#features/cluster/gvisor-installer'
import {
  GVISOR_INSTALLER_READY_FILE,
  GVISOR_NODE_LABEL,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
} from '#platform/k8s'
import { execFileAsync, kubectlApply, kubectlWithRetry } from '#platform/k8s/kubectl'
import { imageExists } from '#platform/container/runtime'
import { pushImageToRegistry, registryHasTag } from '#platform/container/registry'

const mockApply = vi.mocked(kubectlApply)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockExec = vi.mocked(execFileAsync)
const mockHasTag = vi.mocked(registryHasTag)
const mockImageExists = vi.mocked(imageExists)
const mockPush = vi.mocked(pushImageToRegistry)

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

    // Privileged + hostPID: it writes node binaries and containerd's config,
    // and restarts containerd from PID 1's mount namespace. There is no
    // unprivileged spelling of "install a container runtime".
    expect(pod.containers[0].securityContext).toEqual({ privileged: true, runAsUser: 0 })
    expect(pod.hostPID).toBe(true)
    // Node network + node DNS: it must work on a node whose CNI/CoreDNS are
    // not up yet, and reach the release bucket directly.
    expect(pod.hostNetwork).toBe(true)
    expect(pod.dnsPolicy).toBe('Default')
    // Trusted infra, and necessarily so — it is what makes the sentry tier
    // exist, so it cannot itself run on it.
    expect(pod.runtimeClassName).toBeUndefined()
    // Node infrastructure, like netd: runs everywhere, is not what gets
    // evicted when a node fills.
    expect(pod.tolerations).toEqual([{ operator: 'Exists' }])
    expect(pod.priorityClassName).toBe('system-node-critical')
    // One node's containerd restart at a time.
    expect(ds.spec.updateStrategy).toEqual({
      type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 },
    })

    // The install program runs from the mirrored upstream image, with the
    // node's identity for the label patch.
    expect(pod.containers[0].image).toBe(`localhost:5001/${GVISOR_INSTALLER_MIRROR_TAG}`)
    expect(pod.containers[0].command[0]).toBe('sh')
    expect(pod.containers[0].command[2]).toContain('nsenter -t 1 -m -- systemctl restart containerd')
    expect(pod.containers[0].env).toEqual([
      { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
    ])
    // Ready means "this node's runtime is live", which is what the rollout
    // gate below is actually waiting on.
    expect(pod.containers[0].readinessProbe.exec.command)
      .toEqual(['test', '-f', GVISOR_INSTALLER_READY_FILE])
    expect(pod.volumes.filter((v) => v.hostPath).map((v) => v.hostPath!.path))
      .toEqual(['/usr/local/bin', '/etc/containerd', '/var/lib/yaac/gvisor'])

    // RBAC: label a node, and nothing else.
    const role = ofKind('ClusterRole')[0] as unknown as {
      metadata: { name: string; labels: Record<string, string> }
      rules: Array<{ apiGroups: string[]; resources: string[]; verbs: string[] }>
    }
    expect(role.rules).toEqual([
      { apiGroups: [''], resources: ['nodes'], verbs: ['get', 'patch'] },
    ])
    // Cluster-scoped names carry the install namespace, so the real install
    // and an e2e run's coexist; the label is how a sweep tells them apart.
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

    // The RuntimeClasses land only after the rollout, because they select on
    // the label the DaemonSet stamps: applied first, every sandboxed pod
    // would sit Pending until the installer caught up.
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
    // No selector at all rather than an empty one: an empty map is the same
    // thing to the scheduler, but a field that is not there cannot be
    // mistaken for a pool that was configured and then emptied.
    expect(spec()).not.toHaveProperty('nodeSelector')

    // The blast-radius knob: a cluster with a sessions-only pool installs
    // (and restarts containerd) there only. The RuntimeClasses' SELECTOR
    // needs no change — it follows the label the installer stamps.
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

    // The RuntimeClasses are where a pool toleration has to land: admission
    // merges scheduling.tolerations into every pod naming the class, which
    // is how session pods, builder pods, synced pods and cluster check's
    // pinned probes all reach a tainted pool without any of them knowing it
    // exists. Cluster check reads the same field back to decide which nodes
    // can take a session.
    const classes = ofKind('RuntimeClass') as unknown as Array<{
      scheduling: { nodeSelector: Record<string, string>; tolerations?: unknown }
    }>
    expect(classes).toHaveLength(2)
    for (const c of classes) {
      expect(c.scheduling.tolerations).toEqual(tolerations)
      expect(c.scheduling.nodeSelector).toEqual({ [GVISOR_NODE_LABEL]: 'true' })
    }

    // The DaemonSet is untouched by it — it already tolerates everything,
    // the way node infrastructure must, so a pool taint costs it nothing.
    const pod = (ofKind('DaemonSet')[0].spec as {
      template: { spec: { tolerations: unknown; nodeSelector: Record<string, string> } }
    }).template.spec
    expect(pod.tolerations).toEqual([{ operator: 'Exists' }])
    expect(pod.nodeSelector).toEqual({ 'yaac.node-pool': 'sessions' })
  })

  it('mirrors the pinned upstream installer image, pulling only when it is absent', async () => {
    // Already in the local registry — no podman at all.
    await ensureGvisorRuntime()
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()

    // Present in podman but not pushed — push without pulling.
    vi.clearAllMocks()
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(true)
    await ensureGvisorRuntime()
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith(GVISOR_INSTALLER_MIRROR_TAG)

    // Absent everywhere — pull by the multi-arch INDEX digest (a child
    // manifest would mirror one platform's bytes onto every node), verify the
    // mirrored architecture, tag, push.
    vi.clearAllMocks()
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(false)
    mockExec.mockResolvedValue({ stdout: process.arch === 'x64' ? 'amd64' : process.arch, stderr: '' })
    await ensureGvisorRuntime()
    expect(GVISOR_INSTALLER_UPSTREAM_IMAGE).toMatch(/^docker\.io\/curlimages\/curl@sha256:[0-9a-f]{64}$/)
    expect(mockExec).toHaveBeenCalledWith(
      'podman', ['pull', GVISOR_INSTALLER_UPSTREAM_IMAGE], expect.objectContaining({ timeout: 300_000 }),
    )
    expect(mockExec).toHaveBeenCalledWith(
      'podman', ['tag', GVISOR_INSTALLER_UPSTREAM_IMAGE, GVISOR_INSTALLER_MIRROR_TAG],
    )
    expect(mockPush).toHaveBeenCalledWith(GVISOR_INSTALLER_MIRROR_TAG)
  })

  it('fails fast instead of pulling when prebuilt images are required', async () => {
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(false)
    await expect(ensureGvisorRuntime()).rejects.toThrow(/missing/)
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockApply).not.toHaveBeenCalled()
  })
})

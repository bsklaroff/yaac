import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

import {
  LABEL_DATA_DIR_HASH,
  LABEL_PREWARMED,
  LABEL_PROJECT,
  LABEL_TOOL,
  findWorkspacePod,
  isPrewarmed,
  listWorkspaceJobs,
  listWorkspacePods,
  runPodToCompletion,
  workspaceIdFromJobName,
  workspaceJobName,
  workspaceIdLabels,
  type PodInfo,
} from '#drivers/k8s/substrate'
// Internal, for fixtures only.
import { JOB_NAME_LABEL } from '#drivers/k8s/substrate/pods'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#drivers/k8s/substrate/kubectl'

const mockGetJson = vi.mocked(kubectlGetJson)

describe('workspaceJobName', () => {
  const SID = '01234567-89ab-cdef-0123-456789abcdef'

  it('builds yaac-<slug>-<workspaceId>', () => {
    expect(workspaceJobName('demo', 'abcd1234')).toBe('yaac-demo-abcd1234')
  })

  it('lowercases the project slug', () => {
    expect(workspaceJobName('MyProj', 'abcd')).toBe('yaac-myproj-abcd')
  })

  it('replaces DNS-1123-invalid characters with dashes', () => {
    expect(workspaceJobName('my_proj.x', 'abcd')).toBe('yaac-my-proj-x-abcd')
  })

  it('trims leading/trailing dashes from the slug', () => {
    expect(workspaceJobName('-foo-', 'abcd')).toBe('yaac-foo-abcd')
  })

  it('truncates the slug to 21 chars so the total stays within 63', () => {
    const longSlug = 'a'.repeat(40)
    const name = workspaceJobName(longSlug, SID)
    expect(name).toBe(`yaac-${'a'.repeat(21)}-${SID}`)
    expect(name.length).toBeLessThanOrEqual(63)
  })

  it('keeps the full yaac- prefix + UUID shape at exactly 63 chars for max slugs', () => {
    const name = workspaceJobName('exactly-twenty-one-ch', SID)
    expect(name).toHaveLength(63)
  })

  it('collapses double dashes', () => {
    expect(workspaceJobName('a--b', 'abcd')).toBe('yaac-a-b-abcd')
  })
})

describe('workspaceIdFromJobName', () => {
  const SID = '01234567-89ab-cdef-0123-456789abcdef'

  it('recovers the UUID tail for any slug shape', () => {
    for (const slug of ['demo', 'MyProj', 'my_proj.x', '-foo-', 'a'.repeat(40)]) {
      expect(workspaceIdFromJobName(workspaceJobName(slug, SID))).toBe(SID)
    }
  })

  it('rejects names too short to carry a session UUID', () => {
    expect(() => workspaceIdFromJobName('yaac-demo-abcd')).toThrow(/not a workspace job name/)
  })
})

function rawPod(overrides: {
  name?: string
  labels?: Record<string, string>
  phase?: string
  creationTimestamp?: string
  deletionTimestamp?: string
  status?: Record<string, unknown>
} = {}): Record<string, unknown> {
  return {
    metadata: {
      name: overrides.name ?? 'yaac-demo-s1-x1y2z',
      labels: overrides.labels ?? {
        [JOB_NAME_LABEL]: 'yaac-demo-s1',
        ...workspaceIdLabels('s1'),
        [LABEL_PROJECT]: 'demo',
        [LABEL_TOOL]: 'codex',
        [LABEL_DATA_DIR_HASH]: 'ddh0123456789abc',
      },
      creationTimestamp: overrides.creationTimestamp ?? '2026-06-01T00:00:00Z',
      ...(overrides.deletionTimestamp ? { deletionTimestamp: overrides.deletionTimestamp } : {}),
    },
    status: {
      phase: overrides.phase ?? 'Running',
      ...(overrides.status ?? {}),
    },
  }
}

describe('listWorkspacePods', () => {
  beforeEach(() => {
    mockGetJson.mockReset()
  })

  it('queries pods in the namespace scoped by data-dir-hash + workspace-id labels', async () => {
    mockGetJson.mockResolvedValue({ items: [] })
    await listWorkspacePods()
    expect(mockGetJson).toHaveBeenCalledWith([
      'get', 'pods', '-n', 'test-ns',
      '-l', 'yaac.data-dir-hash=ddh0123456789abc,yaac.workspace-id',
    ])
  })

  it('appends the project label to the selector when filtering', async () => {
    mockGetJson.mockResolvedValue({ items: [] })
    await listWorkspacePods('proj-a')
    expect(mockGetJson).toHaveBeenCalledWith([
      'get', 'pods', '-n', 'test-ns',
      '-l', 'yaac.data-dir-hash=ddh0123456789abc,yaac.workspace-id,yaac.project=proj-a',
    ])
  })

  it('maps raw pods into PodInfo rows', async () => {
    mockGetJson.mockResolvedValue({ items: [rawPod()] })
    const pods = await listWorkspacePods()
    expect(pods).toEqual([{
      jobName: 'yaac-demo-s1',
      podName: 'yaac-demo-s1-x1y2z',
      workspaceId: 's1',
      projectSlug: 'demo',
      tool: 'codex',
      phase: 'Running',
      running: true,
      terminating: false,
      createdAtMs: Date.parse('2026-06-01T00:00:00Z'),
      labels: expect.any(Object) as Record<string, string>,
    }])
  })

  it('throws when a pod carries no workspace-id label', async () => {
    mockGetJson.mockResolvedValue({
      items: [rawPod({
        labels: {
          [JOB_NAME_LABEL]: 'yaac-demo-s9',
          [LABEL_PROJECT]: 'demo',
          [LABEL_TOOL]: 'codex',
        },
      })],
    })
    await expect(listWorkspacePods()).rejects.toThrow(
      /malformed workspace pod list[\s\S]*yaac\.workspace-id/,
    )
  })

  it('throws when the job-name label is missing', async () => {
    mockGetJson.mockResolvedValue({
      items: [rawPod({
        labels: {
          ...workspaceIdLabels('s2'),
          [LABEL_PROJECT]: 'demo',
          [LABEL_TOOL]: 'codex',
        },
      })],
    })
    await expect(listWorkspacePods()).rejects.toThrow(
      /malformed workspace pod list[\s\S]*batch\.kubernetes\.io\/job-name/,
    )
  })

  it('throws when the tool label is missing', async () => {
    mockGetJson.mockResolvedValue({
      items: [rawPod({
        labels: {
          [JOB_NAME_LABEL]: 'yaac-demo-s2',
          ...workspaceIdLabels('s2'),
          [LABEL_PROJECT]: 'demo',
        },
      })],
    })
    await expect(listWorkspacePods()).rejects.toThrow(/yaac\.tool/)
  })

  it('marks non-Running phases and terminating pods as not running', async () => {
    mockGetJson.mockResolvedValue({
      items: [
        rawPod({ phase: 'Pending' }),
        rawPod({ deletionTimestamp: '2026-06-01T01:00:00Z' }),
      ],
    })
    const pods = await listWorkspacePods()
    expect(pods[0].running).toBe(false)
    expect(pods[0].phase).toBe('Pending')
    expect(pods[0].terminating).toBe(false)
    // Running but deleting: not running, and terminating.
    expect(pods[1].phase).toBe('Running')
    expect(pods[1].running).toBe(false)
    expect(pods[1].terminating).toBe(true)
  })

  it('captures the session container terminated state as terminal', async () => {
    mockGetJson.mockResolvedValue({
      items: [rawPod({
        phase: 'Failed',
        status: {
          containerStatuses: [{
            state: {
              terminated: {
                exitCode: 137,
                reason: 'OOMKilled',
                finishedAt: '2026-06-01T02:00:00Z',
              },
            },
          }],
        },
      })],
    })
    const pods = await listWorkspacePods()
    expect(pods[0].terminal).toEqual({
      podReason: undefined,
      podMessage: undefined,
      exitCode: 137,
      containerReason: 'OOMKilled',
      finishedAtMs: Date.parse('2026-06-01T02:00:00Z'),
    })
  })

  it('captures pod-level eviction reason/message as terminal', async () => {
    mockGetJson.mockResolvedValue({
      items: [rawPod({
        phase: 'Failed',
        status: { reason: 'Evicted', message: 'The node was low on resource: memory.' },
      })],
    })
    const pods = await listWorkspacePods()
    expect(pods[0].terminal).toEqual({
      podReason: 'Evicted',
      podMessage: 'The node was low on resource: memory.',
      exitCode: undefined,
      containerReason: undefined,
      finishedAtMs: undefined,
    })
  })

  it('leaves terminal unset on healthy pods and on non-terminated containers', async () => {
    mockGetJson.mockResolvedValue({
      items: [
        rawPod(),
        rawPod({
          phase: 'Pending',
          status: { containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] },
        }),
      ],
    })
    const pods = await listWorkspacePods()
    expect(pods[0].terminal).toBeUndefined()
    expect(pods[1].terminal).toBeUndefined()
  })

  it('throws when status.phase is missing', async () => {
    const item = rawPod() as { status?: unknown }
    delete item.status
    mockGetJson.mockResolvedValue({ items: [item] })
    await expect(listWorkspacePods()).rejects.toThrow(/items\[0\]\.status/)
  })

  it('throws when metadata.name is missing', async () => {
    const item = rawPod() as { metadata: { name?: string } }
    delete item.metadata.name
    mockGetJson.mockResolvedValue({ items: [item] })
    await expect(listWorkspacePods()).rejects.toThrow(/items\[0\]\.metadata\.name/)
  })

  it('returns [] when the list call yields null (namespace absent)', async () => {
    mockGetJson.mockResolvedValue(null)
    await expect(listWorkspacePods()).resolves.toEqual([])
  })
})

describe('findWorkspacePod', () => {
  function pod(overrides: Partial<PodInfo> = {}): PodInfo {
    return {
      jobName: 'yaac-demo-abcd1234',
      podName: 'yaac-demo-abcd1234-x7k2p',
      workspaceId: 'abcd1234',
      projectSlug: 'demo',
      tool: 'claude',
      phase: 'Running',
      running: true,
      terminating: false,
      createdAtMs: 0,
      labels: {},
      ...overrides,
    }
  }

  it('matches by exact workspace id', () => {
    expect(findWorkspacePod([pod()], 'abcd1234')).toBeDefined()
  })

  // Prefix matching happens in domain, and clients never send unit names.
  it('matches no prefix, job name or pod name', () => {
    for (const input of ['abcd', '', 'yaac-demo-abcd1234', 'yaac-demo-abcd1234-x7k2p', 'yaac-']) {
      expect(findWorkspacePod([pod()], input), input).toBeUndefined()
    }
  })

  // Unclaimed spares are returned only for teardown.
  it('skips a spare unless asked for spares', () => {
    const spare = pod({ labels: { [LABEL_PREWARMED]: 'true' } })
    expect(findWorkspacePod([spare], 'abcd1234')).toBeUndefined()
    expect(findWorkspacePod([spare], 'abcd1234', { spares: true })).toBeDefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(findWorkspacePod([pod()], 'zzz')).toBeUndefined()
  })
})

describe('listWorkspaceJobs', () => {
  beforeEach(() => {
    mockGetJson.mockReset()
  })

  it('queries jobs scoped by data-dir-hash + session-id labels and maps rows', async () => {
    mockGetJson.mockResolvedValue({
      items: [{
        metadata: {
          name: 'yaac-demo-s1',
          labels: { ...workspaceIdLabels('s1'), [LABEL_PROJECT]: 'demo' },
          creationTimestamp: '2026-06-01T00:00:00Z',
        },
      }],
    })
    const jobs = await listWorkspaceJobs()
    expect(mockGetJson).toHaveBeenCalledWith([
      'get', 'jobs', '-n', 'test-ns',
      '-l', 'yaac.data-dir-hash=ddh0123456789abc,yaac.workspace-id',
    ])
    expect(jobs).toEqual([{
      jobName: 'yaac-demo-s1',
      workspaceId: 's1',
      projectSlug: 'demo',
      createdAtMs: Date.parse('2026-06-01T00:00:00Z'),
    }])
  })

  // The orphan-Job sweep must not act on a Job with no workspace id.
  it('throws when a job carries no workspace-id label', async () => {
    mockGetJson.mockResolvedValue({
      items: [{
        metadata: {
          name: 'yaac-demo-s9',
          labels: { [LABEL_PROJECT]: 'demo' },
          creationTimestamp: '2026-06-01T00:00:00Z',
        },
      }],
    })
    await expect(listWorkspaceJobs()).rejects.toThrow(
      /malformed workspace job list[\s\S]*yaac\.workspace-id/,
    )
  })

  it('throws when a job lacks metadata.name', async () => {
    mockGetJson.mockResolvedValue({ items: [{}] })
    await expect(listWorkspaceJobs()).rejects.toThrow(/malformed workspace job list/)
  })

  it('throws when a job lacks the project label', async () => {
    mockGetJson.mockResolvedValue({
      items: [{
        metadata: {
          name: 'yaac-demo-s1',
          labels: workspaceIdLabels('s1'),
          creationTimestamp: '2026-06-01T00:00:00Z',
        },
      }],
    })
    await expect(listWorkspaceJobs()).rejects.toThrow(/yaac\.project/)
  })

  it('returns [] when the list call yields null', async () => {
    mockGetJson.mockResolvedValue(null)
    await expect(listWorkspaceJobs()).resolves.toEqual([])
  })
})

describe('isPrewarmed', () => {
  function pod(labels: Record<string, string>): PodInfo {
    return {
      jobName: 'yaac-p-s1',
      podName: 'yaac-p-s1-x',
      workspaceId: 's1',
      projectSlug: 'p',
      tool: 'claude',
      phase: 'Running',
      running: true,
      terminating: false,
      createdAtMs: 1_000,
      labels,
    }
  }

  it('is true only when the label is exactly "true"', () => {
    expect(isPrewarmed(pod({ [LABEL_PREWARMED]: 'true' }))).toBe(true)
    expect(isPrewarmed(pod({}))).toBe(false)
    expect(isPrewarmed(pod({ [LABEL_PREWARMED]: 'false' }))).toBe(false)
  })
})

describe('runPodToCompletion', () => {
  const MANIFEST = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'yaac-oneshot', namespace: 'test-ns' },
    spec: { restartPolicy: 'Never' },
  }
  const mockApply = vi.mocked(kubectlApply)
  const mockRetry = vi.mocked(kubectlWithRetry)

  beforeEach(() => {
    mockApply.mockReset()
    mockApply.mockResolvedValue(undefined)
    mockRetry.mockReset()
    mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
    mockGetJson.mockReset()
  })

  it('deletes any stray namesake, applies, polls to Succeeded, and returns the logs', async () => {
    mockGetJson.mockResolvedValue({ status: { phase: 'Succeeded' } })
    mockRetry.mockImplementation((args: string[]) =>
      Promise.resolve({ stdout: args[0] === 'logs' ? 'hello\n' : '', stderr: '' }))

    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 5_000 }))
      .resolves.toEqual({ phase: 'Succeeded', logs: 'hello\n' })

    // Stray delete before the apply, cleanup delete after the logs.
    const retryCalls = mockRetry.mock.calls.map((c) => c[0])
    expect(retryCalls[0]).toEqual(
      ['delete', 'pod', 'yaac-oneshot', '-n', 'test-ns', '--ignore-not-found'])
    expect(retryCalls.at(-2)).toEqual(['logs', 'yaac-oneshot', '-n', 'test-ns'])
    expect(retryCalls.at(-1)).toEqual(
      ['delete', 'pod', 'yaac-oneshot', '-n', 'test-ns', '--ignore-not-found'])
    expect(mockApply).toHaveBeenCalledWith(MANIFEST)
    expect(mockGetJson).toHaveBeenCalledWith(
      ['get', 'pod', 'yaac-oneshot', '-n', 'test-ns'])
  })

  it('returns Failed immediately (with logs) instead of burning the timeout', async () => {
    mockGetJson.mockResolvedValue({ status: { phase: 'Failed' } })
    mockRetry.mockImplementation((args: string[]) =>
      Promise.resolve({ stdout: args[0] === 'logs' ? 'boom\n' : '', stderr: '' }))
    const start = Date.now()
    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 60_000 }))
      .resolves.toEqual({ phase: 'Failed', logs: 'boom\n' })
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(mockGetJson).toHaveBeenCalledTimes(1)
  })

  it('fails fast with phase Deleted when the pod vanishes after apply', async () => {
    // The pod was deleted after apply, so polling stops at once.
    mockGetJson.mockResolvedValue(null)
    const start = Date.now()
    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 60_000 }))
      .resolves.toEqual({ phase: 'Deleted', logs: '' })
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(mockGetJson).toHaveBeenCalledTimes(1)
    expect(mockRetry.mock.calls.map((c) => c[0]).at(-1)).toEqual(
      ['delete', 'pod', 'yaac-oneshot', '-n', 'test-ns', '--ignore-not-found'])
  })

  it('returns the last seen phase when the deadline passes without a terminal one', async () => {
    mockGetJson.mockResolvedValue({ status: { phase: 'Pending' } })
    const { phase } = await runPodToCompletion(MANIFEST, { timeoutMs: 5, pollMs: 1 })
    expect(phase).toBe('Pending')
    expect(mockRetry.mock.calls.map((c) => c[0]).at(-1)).toEqual(
      ['delete', 'pod', 'yaac-oneshot', '-n', 'test-ns', '--ignore-not-found'])
  })

  it('routes kubectl and apply through the injected seams when provided', async () => {
    mockGetJson.mockResolvedValue({ status: { phase: 'Succeeded' } })
    const kubectl = vi.fn((args: string[]) =>
      Promise.resolve({ stdout: args[0] === 'logs' ? 'via-seam\n' : '' }))
    const apply = vi.fn().mockResolvedValue(undefined)

    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 5_000, kubectl, apply }))
      .resolves.toEqual({ phase: 'Succeeded', logs: 'via-seam\n' })
    expect(apply).toHaveBeenCalledWith(MANIFEST)
    expect(kubectl).toHaveBeenCalledWith(
      ['delete', 'pod', 'yaac-oneshot', '-n', 'test-ns', '--ignore-not-found'])
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()
  })

  it('swallows logs failures ("" logs) but still deletes the pod', async () => {
    mockGetJson.mockResolvedValue({ status: { phase: 'Succeeded' } })
    mockRetry.mockImplementation((args: string[]) =>
      args[0] === 'logs'
        ? Promise.reject(new Error('container not found'))
        : Promise.resolve({ stdout: '', stderr: '' }))
    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 5_000 }))
      .resolves.toEqual({ phase: 'Succeeded', logs: '' })
  })

  it('propagates apply failures after best-effort cleanup', async () => {
    mockApply.mockRejectedValue(new Error('admission denied'))
    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 5_000 }))
      .rejects.toThrow('admission denied')
    // Stray delete and cleanup delete around the failed apply.
    expect(mockRetry.mock.calls.filter((c) => c[0][0] === 'delete')).toHaveLength(2)
  })
})

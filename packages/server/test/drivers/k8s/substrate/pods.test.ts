import { describe, it, expect, vi } from 'vitest'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'

const mockLog = vi.hoisted(() => vi.fn())
vi.mock('#log', () => ({ serverLog: mockLog }))

import {
  LABEL_DATA_DIR_HASH,
  LABEL_PREWARMED,
  LABEL_PROJECT,
  LABEL_PROJECT_ID,
  LABEL_TOOL,
  LABEL_WORKSPACE_ID,
  findWorkspacePod,
  isPrewarmed,
  listWorkspaceJobs,
  listWorkspacePods,
  workspaceIdFromJobName,
  workspaceJobName,
  workspaceIdLabels,
  type PodInfo,
} from '#drivers/k8s/substrate'
// Internal, for fixtures only.
import { JOB_NAME_LABEL } from '#drivers/k8s/substrate/pods'
import { dataDirHash, k8sNamespace } from '#drivers/k8s/substrate'

/** Answer every list with `items`, which may be malformed on purpose. */
function serve(items: unknown[]): void {
  fakeCluster.intercept((call) => (call.verb === 'list' ? { items } : undefined))
}

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

interface RawPod {
  metadata: { name?: string; labels: Record<string, string> }
  status?: unknown
}

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
        [LABEL_PROJECT_ID]: 'id-demo',
        [LABEL_TOOL]: 'codex',
        [LABEL_DATA_DIR_HASH]: dataDirHash(),
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
  it('lists this install\'s workspace pods, optionally for one project, and maps them', async () => {
    const pod = (name: string, project: string) => {
      const raw = rawPod({ name }) as unknown as RawPod
      raw.metadata.labels[LABEL_PROJECT] = project
      return { apiVersion: 'v1', kind: 'Pod', ...raw, metadata: { ...raw.metadata, name, namespace: k8sNamespace() } }
    }
    const foreign = pod('other-install', 'demo')
    foreign.metadata.labels[LABEL_DATA_DIR_HASH] = 'someone-else'
    fakeCluster.seed(pod('a', 'demo'), pod('b', 'proj-a'), foreign)
    expect((await listWorkspacePods()).map((p) => p.podName).sort()).toEqual(['a', 'b'])
    expect((await listWorkspacePods('proj-a')).map((p) => p.podName)).toEqual(['b'])
  })

  it('maps raw pods into PodInfo rows', async () => {
    serve([rawPod()])
    const pods = await listWorkspacePods()
    expect(pods).toEqual([{
      jobName: 'yaac-demo-s1',
      podName: 'yaac-demo-s1-x1y2z',
      workspaceId: 's1',
      projectSlug: 'demo',
      projectId: 'id-demo',
      tool: 'codex',
      phase: 'Running',
      running: true,
      terminating: false,
      createdAtMs: Date.parse('2026-06-01T00:00:00Z'),
      labels: expect.any(Object) as Record<string, string>,
    }])
  })

  // The informer skips the same pods, so every reader agrees.
  it.each([
    ['the workspace-id label', (p: RawPod) => { delete p.metadata.labels[LABEL_WORKSPACE_ID] }],
    ['the job-name label', (p: RawPod) => { delete p.metadata.labels[JOB_NAME_LABEL] }],
    ['the tool label', (p: RawPod) => { delete p.metadata.labels[LABEL_TOOL] }],
    ['the project-id label', (p: RawPod) => { delete p.metadata.labels[LABEL_PROJECT_ID] }],
    ['metadata.name', (p: RawPod) => { delete p.metadata.name }],
    ['status', (p: RawPod) => { delete p.status }],
  ])('skips a pod missing %s', async (_field, strip) => {
    const bad = rawPod() as unknown as RawPod
    strip(bad)
    serve([bad, rawPod()])
    expect((await listWorkspacePods()).map((p) => p.podName)).toEqual(['yaac-demo-s1-x1y2z'])
  })

  // Its Job then reads as having no pod and is reaped, so the skip must be
  // traceable, without a line on every listing.
  it('names a skipped pod and what it lacks, once', async () => {
    const bad = rawPod({ name: 'yaac-demo-old-abcde' }) as unknown as RawPod
    delete bad.metadata.labels[LABEL_PROJECT_ID]
    serve([bad])
    mockLog.mockClear()
    await listWorkspacePods()
    await listWorkspacePods()
    expect(mockLog.mock.calls).toEqual([[
      expect.stringMatching(/yaac-demo-old-abcde: missing or invalid metadata\.labels\.yaac\.project-id/),
    ]])
  })

  it('marks non-Running phases and terminating pods as not running', async () => {
    serve([
      rawPod({ phase: 'Pending' }),
      rawPod({ deletionTimestamp: '2026-06-01T01:00:00Z' }),
    ])
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
    serve([rawPod({
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
    })])
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
    serve([rawPod({
      phase: 'Failed',
      status: { reason: 'Evicted', message: 'The node was low on resource: memory.' },
    })])
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
    serve([
      rawPod(),
      rawPod({
        phase: 'Pending',
        status: { containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] },
      }),
    ])
    const pods = await listWorkspacePods()
    expect(pods[0].terminal).toBeUndefined()
    expect(pods[1].terminal).toBeUndefined()
  })

})

describe('findWorkspacePod', () => {
  function pod(overrides: Partial<PodInfo> = {}): PodInfo {
    return {
      jobName: 'yaac-demo-abcd1234',
      podName: 'yaac-demo-abcd1234-x7k2p',
      workspaceId: 'abcd1234',
      projectSlug: 'demo',
      projectId: 'id-demo',
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
  it('queries jobs scoped by data-dir-hash + session-id labels and maps rows', async () => {
    serve([{
      metadata: {
        name: 'yaac-demo-s1',
        labels: { ...workspaceIdLabels('s1'), [LABEL_PROJECT]: 'demo' },
        creationTimestamp: '2026-06-01T00:00:00Z',
      },
    }])
    const jobs = await listWorkspaceJobs()
    expect(fakeCluster.callsOf('list', 'Job')).toEqual([expect.objectContaining({
      namespace: k8sNamespace(), labelSelector: `yaac.data-dir-hash=${dataDirHash()},yaac.workspace-id`,
    })])
    expect(jobs).toEqual([{
      jobName: 'yaac-demo-s1',
      workspaceId: 's1',
      projectSlug: 'demo',
      createdAtMs: Date.parse('2026-06-01T00:00:00Z'),
    }])
  })

  // The orphan-Job sweep must not act on a Job with no workspace id.
  it('skips a job missing its name, workspace-id or project label', async () => {
    const meta = { creationTimestamp: '2026-06-01T00:00:00Z' }
    serve([
      {},
      { metadata: { ...meta, name: 'a', labels: { [LABEL_PROJECT]: 'demo' } } },
      { metadata: { ...meta, name: 'b', labels: workspaceIdLabels('s1') } },
    ])
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
      projectId: '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c',
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


import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/k8s/kubectl', () => ({
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlGetJson: vi.fn(),
}))

import {
  JOB_NAME_LABEL,
  LABEL_DATA_DIR_HASH,
  LABEL_PROJECT,
  LABEL_SESSION_ID,
  LABEL_TOOL,
  findSessionPod,
  listSessionJobs,
  listSessionPods,
  sessionJobName,
  type SessionPod,
} from '@/lib/k8s/pods'
import { kubectlGetJson } from '@/lib/k8s/kubectl'

const mockGetJson = vi.mocked(kubectlGetJson)

describe('label constants', () => {
  it('match the wire values used by selectors and manifests', () => {
    expect(LABEL_PROJECT).toBe('yaac.project')
    expect(LABEL_SESSION_ID).toBe('yaac.session-id')
    expect(LABEL_DATA_DIR_HASH).toBe('yaac.data-dir-hash')
    expect(LABEL_TOOL).toBe('yaac.tool')
  })
})

describe('sessionJobName', () => {
  const SID = '01234567-89ab-cdef-0123-456789abcdef'

  it('builds yaac-<slug>-<sessionId>', () => {
    expect(sessionJobName('demo', 'abcd1234')).toBe('yaac-demo-abcd1234')
  })

  it('lowercases the project slug', () => {
    expect(sessionJobName('MyProj', 'abcd')).toBe('yaac-myproj-abcd')
  })

  it('replaces DNS-1123-invalid characters with dashes', () => {
    expect(sessionJobName('my_proj.x', 'abcd')).toBe('yaac-my-proj-x-abcd')
  })

  it('trims leading/trailing dashes from the slug', () => {
    expect(sessionJobName('-foo-', 'abcd')).toBe('yaac-foo-abcd')
  })

  it('truncates the slug to 21 chars so the total stays within 63', () => {
    const longSlug = 'a'.repeat(40)
    const name = sessionJobName(longSlug, SID)
    expect(name).toBe(`yaac-${'a'.repeat(21)}-${SID}`)
    expect(name.length).toBeLessThanOrEqual(63)
  })

  it('keeps the full yaac- prefix + UUID shape at exactly 63 chars for max slugs', () => {
    const name = sessionJobName('exactly-twenty-one-ch', SID)
    expect(name).toHaveLength(63)
  })

  it('collapses double dashes', () => {
    expect(sessionJobName('a--b', 'abcd')).toBe('yaac-a-b-abcd')
  })
})

function rawPod(overrides: {
  name?: string
  labels?: Record<string, string>
  phase?: string
  creationTimestamp?: string
  deletionTimestamp?: string
} = {}): Record<string, unknown> {
  return {
    metadata: {
      name: overrides.name ?? 'yaac-demo-s1-x1y2z',
      labels: overrides.labels ?? {
        [JOB_NAME_LABEL]: 'yaac-demo-s1',
        [LABEL_SESSION_ID]: 's1',
        [LABEL_PROJECT]: 'demo',
        [LABEL_TOOL]: 'codex',
        [LABEL_DATA_DIR_HASH]: 'ddh0123456789abc',
      },
      creationTimestamp: overrides.creationTimestamp ?? '2026-06-01T00:00:00Z',
      ...(overrides.deletionTimestamp ? { deletionTimestamp: overrides.deletionTimestamp } : {}),
    },
    status: overrides.phase === undefined ? { phase: 'Running' } : { phase: overrides.phase },
  }
}

describe('listSessionPods', () => {
  beforeEach(() => {
    mockGetJson.mockReset()
  })

  it('queries pods in the namespace scoped by data-dir-hash + session-id labels', async () => {
    mockGetJson.mockResolvedValue({ items: [] })
    await listSessionPods()
    expect(mockGetJson).toHaveBeenCalledWith([
      'get', 'pods', '-n', 'test-ns',
      '-l', 'yaac.data-dir-hash=ddh0123456789abc,yaac.session-id',
    ])
  })

  it('appends the project label to the selector when filtering', async () => {
    mockGetJson.mockResolvedValue({ items: [] })
    await listSessionPods('proj-a')
    expect(mockGetJson).toHaveBeenCalledWith([
      'get', 'pods', '-n', 'test-ns',
      '-l', 'yaac.data-dir-hash=ddh0123456789abc,yaac.session-id,yaac.project=proj-a',
    ])
  })

  it('maps raw pods into SessionPod rows', async () => {
    mockGetJson.mockResolvedValue({ items: [rawPod()] })
    const pods = await listSessionPods()
    expect(pods).toEqual([{
      jobName: 'yaac-demo-s1',
      podName: 'yaac-demo-s1-x1y2z',
      sessionId: 's1',
      projectSlug: 'demo',
      tool: 'codex',
      phase: 'Running',
      running: true,
      createdAtMs: Date.parse('2026-06-01T00:00:00Z'),
      labels: expect.any(Object) as Record<string, string>,
    }])
  })

  it('label constant is the canonical prefixed job-name label', () => {
    expect(JOB_NAME_LABEL).toBe('batch.kubernetes.io/job-name')
  })

  it('throws when the job-name label is missing', async () => {
    mockGetJson.mockResolvedValue({
      items: [rawPod({
        labels: {
          [LABEL_SESSION_ID]: 's2',
          [LABEL_PROJECT]: 'demo',
          [LABEL_TOOL]: 'codex',
        },
      })],
    })
    await expect(listSessionPods()).rejects.toThrow(
      /malformed session pod list[\s\S]*batch\.kubernetes\.io\/job-name/,
    )
  })

  it('throws when the tool label is missing', async () => {
    mockGetJson.mockResolvedValue({
      items: [rawPod({
        labels: {
          [JOB_NAME_LABEL]: 'yaac-demo-s2',
          [LABEL_SESSION_ID]: 's2',
          [LABEL_PROJECT]: 'demo',
        },
      })],
    })
    await expect(listSessionPods()).rejects.toThrow(/yaac\.tool/)
  })

  it('marks non-Running phases and terminating pods as not running', async () => {
    mockGetJson.mockResolvedValue({
      items: [
        rawPod({ phase: 'Pending' }),
        rawPod({ deletionTimestamp: '2026-06-01T01:00:00Z' }),
      ],
    })
    const pods = await listSessionPods()
    expect(pods[0].running).toBe(false)
    expect(pods[0].phase).toBe('Pending')
    // Running phase but terminating → not running.
    expect(pods[1].phase).toBe('Running')
    expect(pods[1].running).toBe(false)
  })

  it('throws when status.phase is missing', async () => {
    const item = rawPod() as { status?: unknown }
    delete item.status
    mockGetJson.mockResolvedValue({ items: [item] })
    await expect(listSessionPods()).rejects.toThrow(/items\[0\]\.status/)
  })

  it('throws when metadata.name is missing', async () => {
    const item = rawPod() as { metadata: { name?: string } }
    delete item.metadata.name
    mockGetJson.mockResolvedValue({ items: [item] })
    await expect(listSessionPods()).rejects.toThrow(/items\[0\]\.metadata\.name/)
  })

  it('returns [] when the list call yields null (namespace absent)', async () => {
    mockGetJson.mockResolvedValue(null)
    await expect(listSessionPods()).resolves.toEqual([])
  })
})

describe('findSessionPod', () => {
  function pod(overrides: Partial<SessionPod> = {}): SessionPod {
    return {
      jobName: 'yaac-demo-abcd1234',
      podName: 'yaac-demo-abcd1234-x7k2p',
      sessionId: 'abcd1234',
      projectSlug: 'demo',
      tool: 'claude',
      phase: 'Running',
      running: true,
      createdAtMs: 0,
      labels: {},
      ...overrides,
    }
  }

  it('matches by exact session id', () => {
    expect(findSessionPod([pod()], 'abcd1234')).toBeDefined()
  })

  it('matches by exact job name', () => {
    expect(findSessionPod([pod()], 'yaac-demo-abcd1234')).toBeDefined()
  })

  it('matches by session-id prefix', () => {
    expect(findSessionPod([pod()], 'abcd')?.sessionId).toBe('abcd1234')
  })

  it('matches by exact pod name', () => {
    expect(findSessionPod([pod({ podName: 'deadbeef-x' })], 'deadbeef-x')?.sessionId).toBe('abcd1234')
  })

  it('does not match name prefixes (every job name starts with yaac-)', () => {
    expect(findSessionPod([pod()], 'yaac')).toBeUndefined()
    expect(findSessionPod([pod()], 'yaac-')).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(findSessionPod([pod()], 'zzz')).toBeUndefined()
  })
})

describe('listSessionJobs', () => {
  beforeEach(() => {
    mockGetJson.mockReset()
  })

  it('queries jobs scoped by data-dir-hash + session-id labels and maps rows', async () => {
    mockGetJson.mockResolvedValue({
      items: [{
        metadata: {
          name: 'yaac-demo-s1',
          labels: { [LABEL_SESSION_ID]: 's1', [LABEL_PROJECT]: 'demo' },
          creationTimestamp: '2026-06-01T00:00:00Z',
        },
      }],
    })
    const jobs = await listSessionJobs()
    expect(mockGetJson).toHaveBeenCalledWith([
      'get', 'jobs', '-n', 'test-ns',
      '-l', 'yaac.data-dir-hash=ddh0123456789abc,yaac.session-id',
    ])
    expect(jobs).toEqual([{
      jobName: 'yaac-demo-s1',
      sessionId: 's1',
      projectSlug: 'demo',
      createdAtMs: Date.parse('2026-06-01T00:00:00Z'),
    }])
  })

  it('throws when a job lacks metadata.name', async () => {
    mockGetJson.mockResolvedValue({ items: [{}] })
    await expect(listSessionJobs()).rejects.toThrow(/malformed session job list/)
  })

  it('throws when a job lacks the project label', async () => {
    mockGetJson.mockResolvedValue({
      items: [{
        metadata: {
          name: 'yaac-demo-s1',
          labels: { [LABEL_SESSION_ID]: 's1' },
          creationTimestamp: '2026-06-01T00:00:00Z',
        },
      }],
    })
    await expect(listSessionJobs()).rejects.toThrow(/yaac\.project/)
  })

  it('returns [] when the list call yields null', async () => {
    mockGetJson.mockResolvedValue(null)
    await expect(listSessionJobs()).resolves.toEqual([])
  })
})

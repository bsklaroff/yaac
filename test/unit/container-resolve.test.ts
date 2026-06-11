import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn(),
  }
})

import { resolveContainer, resolveContainerAnyState } from '@/lib/container/resolve'
import { listSessionPods, type SessionPod } from '@/lib/k8s/pods'
import type * as podsModule from '@/lib/k8s/pods'

const mockListPods = vi.mocked(listSessionPods)

/**
 * Unit-level coverage for the session-resolution helpers.
 *
 * Mocks `listSessionPods` so we can drive every branch (prefix match,
 * exact match, Job name vs session-id vs pod-name, non-running phase,
 * cluster down) without a real cluster. The matching logic itself is the
 * only interesting production code path.
 */
describe('resolveContainer / resolveContainerAnyState', () => {
  beforeEach(() => {
    mockListPods.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = undefined
  })

  function pod(overrides: Partial<SessionPod> = {}): SessionPod {
    return {
      jobName: 'yaac-demo-abcd1234',
      podName: 'yaac-demo-abcd1234-x7k2p',
      sessionId: 'abcd1234',
      projectSlug: 'demo',
      tool: 'claude',
      phase: 'Running',
      running: true,
      createdAtMs: 1_700_000_000_000,
      labels: {},
      ...overrides,
    }
  }

  describe('resolveContainer (requires running)', () => {
    it('returns the job name for an exact session-id match', async () => {
      mockListPods.mockResolvedValueOnce([pod()])
      expect(await resolveContainer('abcd1234')).toBe('yaac-demo-abcd1234')
    })

    it('returns the job name for a session-id prefix match', async () => {
      mockListPods.mockResolvedValueOnce([pod()])
      expect(await resolveContainer('abcd')).toBe('yaac-demo-abcd1234')
    })

    it('returns the job name for a full job-name match', async () => {
      mockListPods.mockResolvedValueOnce([pod()])
      expect(await resolveContainer('yaac-demo-abcd1234')).toBe('yaac-demo-abcd1234')
    })

    it('returns the job name for an exact pod-name match', async () => {
      mockListPods.mockResolvedValueOnce([pod()])
      expect(await resolveContainer('yaac-demo-abcd1234-x7k2p')).toBe('yaac-demo-abcd1234')
    })

    it('does not match a project-name prefix (the project slug alone)', async () => {
      mockListPods.mockResolvedValueOnce([pod()])
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainer('demo')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })

    it('does not match the bare "yaac" name prefix shared by every job', async () => {
      mockListPods.mockResolvedValueOnce([pod()])
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainer('yaac')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })

    it('returns null and sets exitCode=1 on unknown id', async () => {
      mockListPods.mockResolvedValueOnce([])
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainer('nonexistent')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })

    it('returns null and sets exitCode=1 when the pod is not running', async () => {
      mockListPods.mockResolvedValueOnce([pod({ running: false, phase: 'Failed' })])
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainer('abcd1234')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })

    it('returns null and sets exitCode=1 when the cluster is unavailable', async () => {
      mockListPods.mockRejectedValueOnce(new Error('connection refused'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainer('abcd1234')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })
  })

  describe('resolveContainerAnyState', () => {
    it('resolves a running session with full metadata', async () => {
      mockListPods.mockResolvedValueOnce([pod()])
      expect(await resolveContainerAnyState('abcd1234')).toEqual({
        name: 'yaac-demo-abcd1234',
        sessionId: 'abcd1234',
        projectSlug: 'demo',
        state: 'running',
      })
    })

    it('resolves a non-running session and surfaces its lowercased phase', async () => {
      mockListPods.mockResolvedValueOnce([pod({ running: false, phase: 'Failed' })])
      expect(await resolveContainerAnyState('abcd1234')).toEqual({
        name: 'yaac-demo-abcd1234',
        sessionId: 'abcd1234',
        projectSlug: 'demo',
        state: 'failed',
      })
    })

    it('resolves by prefix match', async () => {
      mockListPods.mockResolvedValueOnce([pod()])
      expect((await resolveContainerAnyState('abcd'))?.name).toBe('yaac-demo-abcd1234')
    })

    it('returns null and sets exitCode=1 on unknown id', async () => {
      mockListPods.mockResolvedValueOnce([])
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainerAnyState('nonexistent')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })

    it('returns null and sets exitCode=1 when the cluster is unavailable', async () => {
      mockListPods.mockRejectedValueOnce(new Error('connection refused'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainerAnyState('abcd1234')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveContainer, resolveContainerAnyState } from '@/lib/container/resolve'
import * as runtime from '@/lib/container/runtime'
import { setDataDir } from '@/lib/project/paths'

/**
 * Unit-level coverage for the container-resolution helpers.
 *
 * Mocks `podman.listContainers` so we can drive every branch (prefix
 * match, exact match, name vs session-id vs container-id, non-running
 * state, podman down) without creating real containers. The matching
 * logic itself is the only interesting production code path; the e2e
 * version previously exercised it against real podman, which is
 * overkill for pure string matching.
 */
describe('resolveContainer / resolveContainerAnyState', () => {
  type PodmanContainerInspect = {
    Id: string
    Names?: string[]
    Labels?: Record<string, string>
    State?: string
  }

  let listSpy: ReturnType<typeof vi.fn<(opts?: unknown) => Promise<PodmanContainerInspect[]>>>

  beforeEach(() => {
    setDataDir('/tmp/unit-container-resolve')
    listSpy = vi.fn()
    vi.spyOn(runtime.podman, 'listContainers').mockImplementation(
      listSpy as unknown as typeof runtime.podman.listContainers,
    )
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  function container(overrides: Partial<PodmanContainerInspect>): PodmanContainerInspect {
    return {
      Id: 'fullcontainerid00000000000000',
      Names: ['/yaac-demo-abcd1234'],
      Labels: {
        'yaac.data-dir': '/tmp/unit-container-resolve',
        'yaac.session-id': 'abcd1234',
        'yaac.project': 'demo',
      },
      State: 'running',
      ...overrides,
    }
  }

  describe('resolveContainer (requires running)', () => {
    it('returns the container name for an exact session-id match', async () => {
      listSpy.mockResolvedValueOnce([container({})])
      expect(await resolveContainer('abcd1234')).toBe('yaac-demo-abcd1234')
    })

    it('returns the container name for a session-id prefix match', async () => {
      listSpy.mockResolvedValueOnce([container({})])
      expect(await resolveContainer('abcd')).toBe('yaac-demo-abcd1234')
    })

    it('returns the container name for a full container-name match', async () => {
      listSpy.mockResolvedValueOnce([container({})])
      expect(await resolveContainer('yaac-demo-abcd1234')).toBe('yaac-demo-abcd1234')
    })

    it('returns the container name for a container-id prefix match', async () => {
      listSpy.mockResolvedValueOnce([container({ Id: 'deadbeef00000000' })])
      expect(await resolveContainer('deadbeef')).toBe('yaac-demo-abcd1234')
    })

    it('does not match a project-name prefix (the project slug alone)', async () => {
      listSpy.mockResolvedValueOnce([container({})])
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainer('demo')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })

    it('does not match the bare "yaac" container-name prefix', async () => {
      listSpy.mockResolvedValueOnce([container({})])
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainer('yaac')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })

    it('returns null and sets exitCode=1 on unknown id', async () => {
      listSpy.mockResolvedValueOnce([])
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainer('nonexistent')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })

    it('returns null and sets exitCode=1 when the container is not running', async () => {
      listSpy.mockResolvedValueOnce([container({ State: 'exited' })])
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainer('abcd1234')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })

    it('returns null and sets exitCode=1 when podman is unavailable', async () => {
      listSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainer('abcd1234')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })
  })

  describe('resolveContainerAnyState', () => {
    it('resolves a running container with full metadata', async () => {
      listSpy.mockResolvedValueOnce([container({})])
      expect(await resolveContainerAnyState('abcd1234')).toEqual({
        name: 'yaac-demo-abcd1234',
        sessionId: 'abcd1234',
        projectSlug: 'demo',
        state: 'running',
      })
    })

    it('resolves an exited container and surfaces its state', async () => {
      listSpy.mockResolvedValueOnce([container({ State: 'exited' })])
      expect(await resolveContainerAnyState('abcd1234')).toEqual({
        name: 'yaac-demo-abcd1234',
        sessionId: 'abcd1234',
        projectSlug: 'demo',
        state: 'exited',
      })
    })

    it('resolves by prefix match', async () => {
      listSpy.mockResolvedValueOnce([container({})])
      expect((await resolveContainerAnyState('abcd'))?.name).toBe('yaac-demo-abcd1234')
    })

    it('returns null and sets exitCode=1 on unknown id', async () => {
      listSpy.mockResolvedValueOnce([])
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainerAnyState('nonexistent')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })

    it('returns null and sets exitCode=1 when podman is unavailable', async () => {
      listSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveContainerAnyState('abcd1234')).toBeNull()
      expect(process.exitCode).toBe(1)
      errSpy.mockRestore()
    })
  })
})

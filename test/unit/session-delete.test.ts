import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sessionDelete } from '@/commands/session-delete'
import { deleteSession } from '@/lib/session/delete'
import * as runtime from '@/lib/container/runtime'
import * as cleanup from '@/lib/session/cleanup'
import { setDataDir } from '@/lib/project/paths'

describe('sessionDelete', () => {
  it('is exported as a function', () => {
    expect(typeof sessionDelete).toBe('function')
  })
})

/**
 * Unit coverage for `deleteSession`: the prefix-matching logic, the
 * NOT_FOUND / PODMAN_UNAVAILABLE error shapes, and the handoff to
 * `cleanupSessionDetached` with the matched container's metadata.
 * Uses mocked podman so we don't need real containers.
 *
 * The actual reap-the-container behaviour is exercised end-to-end by
 * the e2e-cli session-delete NOT_FOUND test plus the integration-heavy
 * `test/e2e/session-delete.test.ts` running/stopped paths.
 */
describe('deleteSession', () => {
  type PodmanContainerInspect = {
    Id: string
    Names?: string[]
    Labels?: Record<string, string>
    State?: string
  }

  let listSpy: ReturnType<typeof vi.fn<(opts?: unknown) => Promise<PodmanContainerInspect[]>>>
  let cleanupSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setDataDir('/tmp/unit-session-delete')
    listSpy = vi.fn()
    cleanupSpy = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(runtime.podman, 'listContainers').mockImplementation(
      listSpy as unknown as typeof runtime.podman.listContainers,
    )
    vi.spyOn(cleanup, 'cleanupSessionDetached').mockImplementation(
      cleanupSpy as unknown as typeof cleanup.cleanupSessionDetached,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function container(overrides: Partial<PodmanContainerInspect> = {}): PodmanContainerInspect {
    return {
      Id: 'fullcontainerid0000000000000000',
      Names: ['/yaac-demo-abcd1234'],
      Labels: {
        'yaac.data-dir': '/tmp/unit-session-delete',
        'yaac.session-id': 'abcd1234',
        'yaac.project': 'demo',
      },
      State: 'running',
      ...overrides,
    }
  }

  it('resolves by exact session-id and hands the match to cleanupSessionDetached', async () => {
    listSpy.mockResolvedValueOnce([container()])
    const info = await deleteSession('abcd1234')
    expect(info).toEqual({
      containerName: 'yaac-demo-abcd1234',
      sessionId: 'abcd1234',
      projectSlug: 'demo',
    })
    expect(cleanupSpy).toHaveBeenCalledWith(info)
  })

  it('resolves by session-id prefix', async () => {
    listSpy.mockResolvedValueOnce([container()])
    const info = await deleteSession('abcd')
    expect(info.sessionId).toBe('abcd1234')
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
  })

  it('resolves by full container name', async () => {
    listSpy.mockResolvedValueOnce([container()])
    const info = await deleteSession('yaac-demo-abcd1234')
    expect(info.containerName).toBe('yaac-demo-abcd1234')
  })

  it('resolves by container-id prefix', async () => {
    listSpy.mockResolvedValueOnce([container({ Id: 'deadbeef00000000' })])
    const info = await deleteSession('deadbeef')
    expect(info.sessionId).toBe('abcd1234')
  })

  it('schedules cleanup even for an already-stopped container', async () => {
    listSpy.mockResolvedValueOnce([container({ State: 'exited' })])
    const info = await deleteSession('abcd1234')
    expect(info.sessionId).toBe('abcd1234')
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
  })

  it('throws NOT_FOUND when no container matches', async () => {
    listSpy.mockResolvedValueOnce([])
    await expect(deleteSession('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(cleanupSpy).not.toHaveBeenCalled()
  })

  it('throws PODMAN_UNAVAILABLE when the list call fails', async () => {
    listSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(deleteSession('abcd1234')).rejects.toMatchObject({
      code: 'PODMAN_UNAVAILABLE',
    })
    expect(cleanupSpy).not.toHaveBeenCalled()
  })
})

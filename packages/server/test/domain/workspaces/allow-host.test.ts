import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getProjectAllowlist } from '#domain/projects'
import { allowWorkspaceHost } from '#domain/workspaces/allow-host'
import { BUILT_IN_USER_ID, recordProject } from '#db'
import { DEMO_PROJECT_ID as PROJ } from '@yaac/test-utils/project-fixture'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const DEFAULTS = { hosts: [], defaults: true }
let tmpDir: string
const mockAllowHost = vi.fn<
  (t: { workspaceId: string; projectId: string }, h: string, o: { fanOutToProject: boolean }) => Promise<void>
>()

const HANDLE = handleFixture({
  workspaceId: 'sid-1', projectId: PROJ, jobName: 'yaac-proj-sid-1', state: 'running',
})

beforeEach(async () => {
  vi.clearAllMocks()
  tmpDir = await createTempDataDir()
  await recordProject({ id: PROJ, name: 'demo', remoteUrl: 'https://github.com/o/r', addedAt: 'now' }, BUILT_IN_USER_ID)
  mockAllowHost.mockResolvedValue()
  installFakeWorkspaceDriver({
    find: () => Promise.resolve(HANDLE),
    allowHost: mockAllowHost,
  })
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

describe('allowWorkspaceHost', () => {
  it('widens live only, leaving the project allowlist, when persist is false', async () => {
    await allowWorkspaceHost(local, 'sid-1', 'h.com', { persist: false })

    expect(await getProjectAllowlist(PROJ)).toEqual(DEFAULTS)
    expect(mockAllowHost).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'sid-1', projectId: PROJ }, 'h.com', { fanOutToProject: false },
    )
  })

  it('persists before widening, and a persisted host implies the fan-out', async () => {
    let persisted: unknown
    mockAllowHost.mockImplementation(async () => {
      persisted = await getProjectAllowlist(PROJ)
    })

    await allowWorkspaceHost(local, 'sid-1', 'h.com', { persist: true })

    // The allowlist write comes first, so a failure there leaves the live
    // allowlist unchanged too.
    expect(persisted).toEqual({ hosts: ['h.com'], defaults: true })
    expect(mockAllowHost).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'sid-1', projectId: PROJ }, 'h.com', { fanOutToProject: true },
    )
  })

  it('widens nothing when the allowlist write fails', async () => {
    await expect(allowWorkspaceHost(local, 'sid-1', 'h.com/x', { persist: true }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    expect(mockAllowHost).not.toHaveBeenCalled()
  })

  it('refuses a workspace that is not running, before touching the allowlist', async () => {
    installFakeWorkspaceDriver({
      find: () => Promise.resolve(handleFixture({ workspaceId: 'sid-1', projectId: PROJ, state: 'stopped' })),
      allowHost: mockAllowHost,
    })

    await expect(allowWorkspaceHost(local, 'sid-1', 'h.com', { persist: true }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await getProjectAllowlist(PROJ)).toEqual(DEFAULTS)
    expect(mockAllowHost).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { namedWorkflowFor } from '#test/support/workflows'

import { handleFixture, installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { dismissWorkspacePort, forwardWorkspacePort, offeredForwards, unforwardWorkspacePort } from '#domain/workspaces/forward-port'
import { ServerError } from '@yaac/shared/errors'
import type { PortMapping } from '@yaac/shared/types'
import { BUILT_IN_USER_ID, getProjectRow, insertSite, setProjectConfig, updateSite } from '#db'
import { recordTestProject, DEMO_PROJECT_ID as PROJ } from '@yaac/test-utils/project-fixture'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

/** The project's forwarded ports, as stored. */
const persisted = async (): Promise<number[]> =>
  (await getProjectRow(PROJ))?.portForwards.map((p) => p.containerPort) ?? []
const mockUnforwarded = vi.fn<(workspaceId: string) => Promise<number[]>>()
const mockForwardPort = vi.fn<
  (
    t: { workspaceId: string; projectId: string; jobName: string },
    p: number,
    o: { fanOutToProject: boolean },
  ) => Promise<PortMapping>
>()

const HANDLE = handleFixture({
  workspaceId: 'sid-1', projectId: PROJ, jobName: 'yaac-proj-sid-1', state: 'running',
})

beforeEach(async () => {
  vi.clearAllMocks()
  // The suite shares one database, so the project is recorded once.
  if (!await getProjectRow(PROJ)) await recordTestProject(PROJ, { remoteUrl: 'https://github.com/o/r' })
  await setProjectConfig(PROJ, { portForwards: [] })
  mockUnforwarded.mockResolvedValue([8090])
  mockForwardPort.mockResolvedValue({ containerPort: 8090, hostPort: 8090 })
  installFakeWorkspaceDriver({
    find: () => Promise.resolve(HANDLE),
    unforwardedPorts: mockUnforwarded,
    forwardPort: mockForwardPort,
  })
})

describe('forwardWorkspacePort', () => {
  it('forwards live only, storing nothing, when persist is false', async () => {
    const mapping = await forwardWorkspacePort(local, 'sid-1', 8090, { persist: false })

    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8090 })
    expect(await persisted()).toEqual([])
    expect(mockForwardPort).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'sid-1', projectId: PROJ, jobName: 'yaac-proj-sid-1' },
      8090,
      { fanOutToProject: false },
    )
  })

  it('persists before forwarding, once however often, and a persisted port implies the fan-out', async () => {
    let storedFirst: number[] = []
    mockForwardPort.mockImplementation(async () => {
      storedFirst = await persisted()
      return { containerPort: 8090, hostPort: 8090 }
    })

    await forwardWorkspacePort(local, 'sid-1', 8090, { persist: true })

    expect(storedFirst).toEqual([8090])
    expect((await getProjectRow(PROJ))?.portForwards).toEqual([{ containerPort: 8090, hostPortStart: 8090 }])
    expect(mockForwardPort).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'sid-1', projectId: PROJ, jobName: 'yaac-proj-sid-1' },
      8090,
      { fanOutToProject: true },
    )
    await forwardWorkspacePort(local, 'sid-1', 8090, { persist: true })
    expect(await persisted()).toEqual([8090])
  })

  it('refuses an ineligible port BEFORE writing any config', async () => {
    // A refused forward must not leave the port in the project's settings,
    // where every future workspace would inherit it.
    mockUnforwarded.mockResolvedValue([3000])

    await expect(forwardWorkspacePort(local, 'sid-1', 8090, { persist: true }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await persisted()).toEqual([])
    expect(mockForwardPort).not.toHaveBeenCalled()
  })

  it('refuses an ineligible port with persist off too', async () => {
    mockUnforwarded.mockResolvedValue([])

    await expect(forwardWorkspacePort(local, 'sid-1', 8090, { persist: false }))
      .rejects.toThrow(/not an unforwarded listener/)
    expect(mockForwardPort).not.toHaveBeenCalled()
  })

  it('forwards nothing when the project write is refused', async () => {
    await expect(forwardWorkspacePort({ kind: 'local', userId: 'someone-else' }, 'sid-1', 8090, { persist: true }))
      .rejects.toThrow()
    expect(mockForwardPort).not.toHaveBeenCalled()
  })

  it('surfaces the runtime refusing a port that left the set in between', async () => {
    // The eligibility check is not a reservation; the runtime re-checks.
    mockForwardPort.mockRejectedValue(new ServerError('CONFLICT', 'not an unforwarded listener'))

    await expect(forwardWorkspacePort(local, 'sid-1', 8090, { persist: false }))
      .rejects.toThrow(/not an unforwarded listener/)
  })
})

describe('unforwardWorkspacePort', () => {
  const mockUnforward = vi.fn<(t: { workspaceId: string; jobName: string }, port: number) => Promise<boolean>>()

  beforeEach(() => {
    mockUnforward.mockReset().mockResolvedValue(true)
    installFakeWorkspaceDriver({
      find: () => Promise.resolve(HANDLE),
      unforwardPort: mockUnforward,
    })
  })

  it('stops the resolved workspace’s forward, leaving the project\'s ports alone', async () => {
    await unforwardWorkspacePort(local, 'sid-1', 3000)

    expect(mockUnforward).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'sid-1', jobName: 'yaac-proj-sid-1' },
      3000,
    )
    expect(await persisted()).toEqual([])
  })

  it('refuses a port the workspace is not forwarding', async () => {
    mockUnforward.mockResolvedValue(false)

    await expect(unforwardWorkspacePort(local, 'sid-1', 3000)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(unforwardWorkspacePort(local, 'sid-1', 3000)).rejects.toThrow(/not forwarded/)
  })

  it('never reaches the runtime for a workspace that is not running', async () => {
    installFakeWorkspaceDriver({
      find: () => Promise.resolve(undefined),
      unforwardPort: mockUnforward,
    })

    await expect(unforwardWorkspacePort(local, 'gone', 3000)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockUnforward).not.toHaveBeenCalled()
  })
})

describe('dismissWorkspacePort', () => {
  const mockDismiss = vi.fn<(workspaceId: string, port: number) => boolean>()

  beforeEach(() => {
    mockDismiss.mockReset().mockReturnValue(true)
    installFakeWorkspaceDriver({
      find: () => Promise.resolve(HANDLE),
      dismissPort: mockDismiss,
    })
  })

  it('dismisses the resolved workspace’s port', async () => {
    await dismissWorkspacePort(local, 'sid-1', 8090)

    expect(mockDismiss).toHaveBeenCalledExactlyOnceWith('sid-1', 8090)
  })

  // Same refusal as forwardWorkspacePort: both act on one webapp row, so a
  // stale click gets the same error either way.
  it('refuses a port the runtime is not offering', async () => {
    mockDismiss.mockReturnValue(false)

    await expect(dismissWorkspacePort(local, 'sid-1', 8090))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(dismissWorkspacePort(local, 'sid-1', 8090))
      .rejects.toThrow(/not an unforwarded listener/)
  })

  it('never reaches the runtime for a workspace that is not running', async () => {
    installFakeWorkspaceDriver({
      find: () => Promise.resolve(undefined),
      dismissPort: mockDismiss,
    })

    await expect(dismissWorkspacePort(local, 'gone', 8090)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockDismiss).not.toHaveBeenCalled()
  })

  it('writes no project config — dismissal is in-memory only', async () => {
    await dismissWorkspacePort(local, 'sid-1', 8090)

    expect(await persisted()).toEqual([])
  })
})

describe('offeredForwards', () => {
  it('offers the project\'s ports, and a release only its site\'s admin port', async () => {
    const ports = [{ containerPort: 3000, hostPortStart: 3000 }]
    expect(await offeredForwards(ports, undefined)).toEqual(ports)
    expect(await offeredForwards([], undefined)).toEqual([])

    const site = await insertSite({
      projectId: PROJ, repoId: PROJ, name: 'shop', hostname: 'shop.example.com', port: 3000, adminPort: 3001, namedWorkflowId: await namedWorkflowFor(PROJ),
    })
    expect(await offeredForwards(ports, site.id)).toEqual([{ containerPort: 3001, hostPortStart: 3001 }])
    await updateSite(site.id, { adminPort: null })
    expect(await offeredForwards(ports, site.id)).toEqual([])
  })
})

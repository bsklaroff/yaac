import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver, snapshotFixture } from '#test/support/fake-driver'
import type { RuntimeHandle } from '#drivers/contract'

import { reconcileRevokedShares, removeProject, unshareProject } from '#domain/workspaces'
import { listWorkspaceRows, recordWorkspaceCreated } from '#db/workspace-store'
import { getProjectRow, listProjectRows, recordProject, setProjectShareRevoked } from '#db/project-store'
import { listProjectEnvVars, upsertProjectEnvVar } from '#db/project-env-store'
import { closeDb } from '#db/client'
import { nodeLocalProjectPath, projectDir } from '@yaac/shared/project-paths'
import { getProjectsDir } from '@yaac/shared/paths'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import { BUILT_IN_USER_ID, seeTailnetUser } from '#db'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const KEEPER = '6cc61f49-c2ae-433a-8d09-1f22d7868752'
const NOPE = '4101bef8-794f-4d98-8e95-dfb54850c68b'
const SHARE = '9c0d6b1e-2f3a-4b5c-8d7e-0f1a2b3c4d5e'

/** `DEMO_PROJECT_ID` as a hosted project of the built-in user's, shared
 *  with a tailnet user as `SHARE`. Answers that user's id. */
async function recordShared(): Promise<string> {
  await recordTestProject(DEMO_PROJECT_ID, { remoteUrl: `http://yaac.internal/api/workspace/git/${DEMO_PROJECT_ID}.git` })
  const recipient = await seeTailnetUser('ada@example.com', 'Ada')
  await fs.mkdir(projectDir(SHARE), { recursive: true })
  await recordProject({
    id: SHARE, name: 'demo', remoteUrl: `http://yaac.internal/api/workspace/git/${SHARE}.git`, addedAt: 'now', hosted: true, sharedFrom: DEMO_PROJECT_ID,
  }, recipient)
  return recipient
}

/** The projects whose substrate the purge dropped, and the rows that
 *  existed at the time, so a test can check the purge runs before the rows
 *  are deleted. */
const purged: string[] = []
let rowsAtPurge: string[] = []
/** The project's running workspaces, and the ones torn down. */
const mockList = vi.fn<(projectId?: string) => Promise<RuntimeHandle[]>>()
const mockDeregister = vi.fn<(workspaceId: string) => Promise<void>>()

let tmpDir: string

function installDriver(destroySubstrate?: () => Promise<void>): void {
  installFakeWorkspaceDriver({
    list: mockList,
    deregisterWorkspace: mockDeregister,
    destroyProjectSubstrate: async (project) => {
      purged.push(project)
      rowsAtPurge = (await listWorkspaceRows()).map((r) => r.workspaceId)
      await destroySubstrate?.()
    },
  })
}

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  purged.length = 0
  rowsAtPurge = []
  mockList.mockReset().mockResolvedValue([])
  mockDeregister.mockReset().mockResolvedValue(undefined)
  installDriver()
})

/** A running workspace of `projectId`. */
const running = (projectId: string, workspaceId: string): RuntimeHandle =>
  handleFixture({ jobName: `yaac-${workspaceId}`, workspaceId, projectId })

afterEach(async () => {
  await fs.chmod(getProjectsDir(), 0o755).catch(() => {})
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('removeProject', () => {
  it('tears its workspaces down and erases its bytes, then drops only this project’s rows', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordTestProject(KEEPER)
    for (const projectId of [DEMO_PROJECT_ID, KEEPER]) {
      await fs.mkdir(path.join(nodeLocalProjectPath(projectId), 'repo'), { recursive: true })
    }
    mockList.mockResolvedValue([running(DEMO_PROJECT_ID, 'a'), running(DEMO_PROJECT_ID, 'b')])
    // One teardown failing does not stop the rest.
    mockDeregister.mockRejectedValueOnce(new Error('exec failed'))
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'a' })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'b' })
    await recordWorkspaceCreated({ projectId: KEEPER, workspaceId: 'c' })
    await upsertProjectEnvVar(DEMO_PROJECT_ID, { name: 'MINE', value: 'x', secret: false })
    await upsertProjectEnvVar(KEEPER, { name: 'THEIRS', value: 'y', secret: false })

    await removeProject(local, DEMO_PROJECT_ID)

    // First argument only: the fake records a trailing undefined opts.
    expect(mockList.mock.calls.map(([projectId]) => projectId)).toEqual([DEMO_PROJECT_ID])
    expect(mockDeregister.mock.calls).toEqual([['a'], ['b']])
    expect(purged).toEqual([DEMO_PROJECT_ID])
    await expect(fs.access(projectDir(DEMO_PROJECT_ID))).rejects.toThrow()
    await expect(fs.access(projectDir(KEEPER))).resolves.toBeUndefined()
    // The node-local tree is the driver's to remove; it may live on another
    // machine.
    await expect(fs.access(nodeLocalProjectPath(DEMO_PROJECT_ID))).resolves.toBeUndefined()
    // Bytes go first. If rows went first and the purge then failed, the
    // leftover clone could not be listed, removed or re-added.
    expect(rowsAtPurge.sort()).toEqual(['a', 'b', 'c'])
    // Only this project's rows go.
    expect((await listWorkspaceRows()).map((r) => r.workspaceId)).toEqual(['c'])
    expect((await listProjectRows()).map((p) => p.id)).toEqual([KEEPER])
    // Its env vars go too; some are secrets, so this cannot wait for the
    // reaper.
    expect(await listProjectEnvVars(DEMO_PROJECT_ID)).toEqual([])
    expect((await listProjectEnvVars(KEEPER)).map((v) => v.name)).toEqual(['THEIRS'])
  })

  // Best effort: an unreachable runtime must not keep the directories
  // around. The orphan GCs sweep whatever is left.
  it('still erases the dirs when the runtime is unreachable', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    mockList.mockRejectedValue(new Error('connection refused'))
    installDriver(() => Promise.reject(new Error('connection refused')))

    await removeProject(local, DEMO_PROJECT_ID)

    expect(mockDeregister).not.toHaveBeenCalled()
    await expect(fs.access(projectDir(DEMO_PROJECT_ID))).rejects.toThrow()
    expect(await listProjectRows()).toEqual([])
  })

  it('throws NOT_FOUND for an unknown project, touching nothing', async () => {
    await expect(removeProject(local, NOPE)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual([])
  })

  // A failed purge keeps the rows so `project remove` can be retried.
  it('keeps the rows when the purge cannot erase the bytes', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'a' })
    // The project tree cannot be removed from a read-only parent.
    await fs.chmod(getProjectsDir(), 0o555)

    await expect(removeProject(local, DEMO_PROJECT_ID)).rejects.toThrow(/EACCES/)

    expect((await listWorkspaceRows()).map((r) => r.workspaceId)).toEqual(['a'])
    expect((await listProjectRows()).map((p) => p.id)).toEqual([DEMO_PROJECT_ID])
  })

  it('removes every share of the project with it, since they use its repository', async () => {
    await recordShared()
    await removeProject(local, DEMO_PROJECT_ID)
    expect(purged.sort()).toEqual([DEMO_PROJECT_ID, SHARE].sort())
    expect(await listProjectRows()).toEqual([])
  })

  it('is idempotent once the rows are gone', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await removeProject(local, DEMO_PROJECT_ID)
    await expect(removeProject(local, DEMO_PROJECT_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual([DEMO_PROJECT_ID])
  })
})

describe('unshareProject', () => {
  it("stops the share's workspaces and keeps its rows and checkouts, at the owner's word only", async () => {
    const recipient = await recordShared()
    await recordWorkspaceCreated({ projectId: SHARE, workspaceId: 'a' })
    mockList.mockResolvedValue([running(SHARE, 'a'), { ...running(SHARE, 'spare'), prewarmed: true }])

    const ada = { kind: 'tailnet', userId: recipient, login: 'ada@example.com', name: 'Ada' } as const
    await expect(unshareProject(ada, DEMO_PROJECT_ID, recipient)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await getProjectRow(SHARE))?.shareRevoked).toBe(false)

    await unshareProject(local, DEMO_PROJECT_ID, recipient)

    expect((await getProjectRow(SHARE))?.shareRevoked).toBe(true)
    // The spare is the prewarm pool's to reap.
    expect(mockDeregister.mock.calls).toEqual([['a']])
    await vi.waitFor(async () => expect((await listWorkspaceRows()).find((r) => r.workspaceId === 'a')?.stoppedAt).toBeTruthy())
    await expect(fs.access(projectDir(SHARE))).resolves.toBeUndefined()
    expect(purged).toEqual([])
    // The share is no longer its owner's to use, or to unshare again.
    await expect(removeProject(ada, SHARE)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(unshareProject(local, DEMO_PROJECT_ID, recipient)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('removes the share but says so when its workspaces cannot be stopped now', async () => {
    const recipient = await recordShared()
    mockList.mockRejectedValue(new Error('connection refused'))
    await expect(unshareProject(local, DEMO_PROJECT_ID, recipient)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect((await getProjectRow(SHARE))?.shareRevoked).toBe(true)

    mockList.mockResolvedValue([running(SHARE, 'a')])
    mockDeregister.mockRejectedValueOnce(new Error('exec failed'))
    await setProjectShareRevoked(SHARE, false)
    await expect(unshareProject(local, DEMO_PROJECT_ID, recipient)).rejects.toThrow(/could not be stopped yet/)
  })
})

describe('reconcileRevokedShares', () => {
  it('stops what still runs in a removed share, and nothing in an active one', async () => {
    await recordShared()
    await recordWorkspaceCreated({ projectId: SHARE, workspaceId: 'late' })
    const handles = [
      running(SHARE, 'late'),
      { ...running(SHARE, 'spare'), prewarmed: true },
      { ...running(SHARE, 'going'), terminating: true },
      running(DEMO_PROJECT_ID, 'source'),
    ]
    const snapshot = snapshotFixture(handles)

    await reconcileRevokedShares(snapshot)
    expect(mockDeregister).not.toHaveBeenCalled()

    await setProjectShareRevoked(SHARE, true)
    await reconcileRevokedShares(snapshot)
    expect(mockDeregister.mock.calls).toEqual([['late']])
  })

  it('carries on past a share whose workspace fails to stop', async () => {
    const recipient = await recordShared()
    const other = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a'
    await recordTestProject(KEEPER, { remoteUrl: `http://yaac.internal/api/workspace/git/${KEEPER}.git` })
    await recordProject({
      id: other, name: 'demo', remoteUrl: `http://yaac.internal/api/workspace/git/${other}.git`, addedAt: 'now', hosted: true, sharedFrom: KEEPER,
    }, recipient)
    await setProjectShareRevoked(SHARE, true)
    await setProjectShareRevoked(other, true)
    mockDeregister.mockImplementation((id) => id === 'stuck' ? Promise.reject(new Error('exec failed')) : Promise.resolve())

    await reconcileRevokedShares(snapshotFixture([running(SHARE, 'stuck'), running(other, 'next')]))
    expect(mockDeregister.mock.calls.map(([id]) => id).sort()).toEqual(['next', 'stuck'])
  })
})

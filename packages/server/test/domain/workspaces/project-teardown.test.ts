import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import type { RuntimeHandle } from '#drivers/contract'

import { removeProject } from '#domain/workspaces'
import { createHostedProject } from '#domain/projects'
import { listWorkspaceRows, recordWorkspaceCreated } from '#db/workspace-store'
import { getProjectRow, listProjectRows } from '#db/project-store'
import { getRepo, listRepoHolders } from '#db/repo-store'
import { listProjectEnvVars, upsertProjectEnvVar } from '#db/project-env-store'
import { closeDb } from '#db/client'
import { hostedRepoDir, nodeLocalProjectPath, projectDir, repoDir } from '@yaac/shared/project-paths'
import { getProjectsDir } from '@yaac/shared/paths'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import { BUILT_IN_USER_ID } from '#db'
import { removeAsRoot } from '#drivers/k8s/workspaces'
import { appliedRootPods, podsRunAsRoot } from '#test/support/root-pods'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const KEEPER = '6cc61f49-c2ae-433a-8d09-1f22d7868752'
const NOPE = '4101bef8-794f-4d98-8e95-dfb54850c68b'

/** The projects whose substrate the purge dropped, and the rows that
 *  existed at the time, so a test can check the purge runs before the rows
 *  are deleted. */
const purged: string[] = []
let rowsAtPurge: string[] = []
/** The project's running workspaces, and the ones torn down. */
const mockList = vi.fn<(projectId?: string) => Promise<RuntimeHandle[]>>()
const mockDeregister = vi.fn<(workspaceId: string) => Promise<void>>()
/** The workspaces destroyed outright: reaped spares. */
const mockDestroy = vi.fn<(target: { workspaceId: string }) => Promise<boolean>>()

let tmpDir: string

function installDriver(destroySubstrate?: () => Promise<void>): void {
  installFakeWorkspaceDriver({
    list: mockList,
    deregisterWorkspace: mockDeregister,
    destroy: mockDestroy,
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
  mockDestroy.mockReset().mockResolvedValue(true)
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

  it('hands a tree the server cannot remove to a root pod', async () => {
    installFakeWorkspaceDriver({ list: mockList, removeAsRoot })
    podsRunAsRoot('Succeeded')
    await recordTestProject(DEMO_PROJECT_ID)
    await recordTestProject(KEEPER)
    // As a root-owned dir a workspace left in its checkout.
    const rootDir = path.join(projectDir(DEMO_PROJECT_ID), 'workspaces', 'a', 'rootdir')
    await fs.mkdir(rootDir, { recursive: true })
    await fs.writeFile(path.join(rootDir, 'x'), 'x')
    await fs.chmod(rootDir, 0o555)

    await removeProject(local, DEMO_PROJECT_ID)

    await expect(fs.access(projectDir(DEMO_PROJECT_ID))).rejects.toThrow()
    await expect(fs.access(projectDir(KEEPER))).resolves.toBeUndefined()
    expect(appliedRootPods()).toEqual([{ subPath: 'projects', names: [DEMO_PROJECT_ID], runAsUser: 0 }])
    expect((await listProjectRows()).map((p) => p.id)).toEqual([KEEPER])
  })

  // A repo is its owner's, not a project's: removing the project it was
  // made with unlinks it and leaves it, its main clone and, for a hosted
  // one, the only copy of its code.
  it('deletes no repo, hosted or not, only its links and the checkouts of them', async () => {
    const { id } = await createHostedProject('widgets', BUILT_IN_USER_ID)
    const [{ repo }] = (await getProjectRow(id))?.repos ?? []
    await recordWorkspaceCreated({ projectId: id, workspaceId: 'a', repos: [{ repoId: repo.id, path: '' }] })

    await removeProject(local, id)

    expect(await getProjectRow(id)).toBeUndefined()
    expect(await getRepo(repo.id)).toMatchObject({ hosted: true, owner: BUILT_IN_USER_ID })
    expect(await listRepoHolders(repo.id)).toEqual([])
    await expect(fs.access(hostedRepoDir(repo.id))).resolves.toBeUndefined()
    await expect(fs.access(repoDir(repo.id))).resolves.toBeUndefined()
  })

  it('is idempotent once the rows are gone', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await removeProject(local, DEMO_PROJECT_ID)
    await expect(removeProject(local, DEMO_PROJECT_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual([DEMO_PROJECT_ID])
  })
})

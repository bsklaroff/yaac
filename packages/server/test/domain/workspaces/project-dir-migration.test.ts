import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { moveProjectDirsToIds } from '#domain/workspaces'
import { getWorkspaceRow, recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { claudeDir, projectDir, repoDir, workspaceDir } from '@yaac/shared/project-paths'
import { claudeProjectDirName } from '#runtime/agents'
import type { RuntimeHandle, TeardownTarget } from '#drivers/contract'

// The runtime is a fake driver that records what it is asked to tear down;
// the rows and the data dir are real, under a temp data dir.
const ID = '6b5a4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d'
const NAME = 'widgets'
const OTHER = '1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b'

let tmpDir: string
let listed: RuntimeHandle[]
let destroyed: TeardownTarget[]
/** Whether the workspace's row was already stopped when it was destroyed. */
let stoppedBeforeDestroy: boolean[]
/** Whether the legacy dir was still in place when the workspace was destroyed. */
let dirBeforeDestroy: boolean[]
let destroyResult: boolean
/** Teardown calls in order, as `<verb> <workspace id>`. */
let calls: string[]

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false)
}

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  listed = []
  destroyed = []
  stoppedBeforeDestroy = []
  dirBeforeDestroy = []
  destroyResult = true
  calls = []
  installFakeWorkspaceDriver({
    list: () => Promise.resolve(listed),
    deregisterWorkspace: (workspaceId) => {
      calls.push(`deregister ${workspaceId}`)
      return Promise.resolve()
    },
    destroy: async (target) => {
      calls.push(`destroy ${target.workspaceId}`)
      destroyed.push(target)
      stoppedBeforeDestroy.push((await getWorkspaceRow(ID, target.workspaceId))?.stoppedAt != null)
      dirBeforeDestroy.push(await exists(projectDir(NAME)))
      return destroyResult
    },
  })
  // A project recorded under its id whose dir is still named by its slug.
  await recordTestProject(ID, { name: NAME })
  await fs.rm(projectDir(ID), { recursive: true })
  await fs.mkdir(path.join(projectDir(NAME), 'repo'), { recursive: true })
  await fs.writeFile(path.join(projectDir(NAME), 'repo', 'README'), 'hello')
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('moveProjectDirsToIds', () => {
  it('stops the project\'s running workspaces, then moves the slug-named dir to the id', async () => {
    await recordWorkspaceCreated({ projectId: ID, workspaceId: 'a' })
    await recordWorkspaceCreated({ projectId: ID, workspaceId: 'b' })
    // A checkout borrows the main clone's objects by absolute path, and
    // claude's history link is named after the checkout's path.
    const alternates = (dir: string): string => path.join(dir, '.git', 'objects', 'info', 'alternates')
    await fs.mkdir(path.dirname(alternates(workspaceDir(NAME, 'a'))), { recursive: true })
    await fs.writeFile(alternates(workspaceDir(NAME, 'a')), `${path.join(repoDir(NAME), '.git', 'objects')}\n`)
    const link = (project: string): string =>
      path.join(claudeDir(project), 'projects', claudeProjectDirName(workspaceDir(NAME, 'a')))
    await fs.mkdir(path.dirname(link(NAME)), { recursive: true })
    await fs.symlink('../../history/a/claude', link(NAME))
    // A containerless handle reports the dir name as its project; a k8s one
    // already carries the id. Another project's workspace is left alone.
    listed = [
      handleFixture({ workspaceId: 'a', projectId: NAME, jobName: 'unit-a' }),
      handleFixture({ workspaceId: 'b', projectId: ID, jobName: 'unit-b' }),
      handleFixture({ workspaceId: 'c', projectId: OTHER, jobName: 'unit-c' }),
    ]

    await moveProjectDirsToIds()

    // Each is handed back to the runtime as it reported itself.
    expect(destroyed).toEqual([
      { projectId: NAME, workspaceId: 'a', unitName: 'unit-a' },
      { projectId: ID, workspaceId: 'b', unitName: 'unit-b' },
    ])
    expect(stoppedBeforeDestroy).toEqual([true, true])
    expect(dirBeforeDestroy).toEqual([true, true])
    // Deregistering first would make a containerless runtime forget the
    // processes its destroy waits on.
    expect(calls).toEqual(['destroy a', 'deregister a', 'destroy b', 'deregister b'])
    for (const id of ['a', 'b']) {
      expect((await getWorkspaceRow(ID, id))?.stoppedAt).toBeTruthy()
    }
    expect(await exists(projectDir(NAME))).toBe(false)
    expect(await fs.readFile(path.join(projectDir(ID), 'repo', 'README'), 'utf8')).toBe('hello')
    expect(await fs.readFile(alternates(workspaceDir(ID, 'a')), 'utf8'))
      .toBe(`${path.join(repoDir(ID), '.git', 'objects')}\n`)
    expect(await fs.lstat(link(ID)).catch(() => null)).toBeNull()
  })

  it('does nothing when no project dir is slug-named', async () => {
    await fs.rename(projectDir(NAME), projectDir(ID))
    await recordWorkspaceCreated({ projectId: ID, workspaceId: 'a' })
    listed = [handleFixture({ workspaceId: 'a', projectId: ID })]

    await moveProjectDirsToIds()

    expect(destroyed).toEqual([])
    expect((await getWorkspaceRow(ID, 'a'))?.stoppedAt).toBeFalsy()
    expect(await exists(path.join(projectDir(ID), 'repo', 'README'))).toBe(true)
  })

  it('merges into an id dir that already exists, keeping the newer of two files', async () => {
    const config = (project: string): string => path.join(projectDir(project), 'config', 'yaac-config.json')
    await fs.mkdir(path.dirname(config(NAME)), { recursive: true })
    await fs.writeFile(config(NAME), 'old')
    await fs.utimes(config(NAME), new Date(1_000), new Date(1_000))
    await fs.mkdir(path.dirname(config(ID)), { recursive: true })
    await fs.writeFile(config(ID), 'saved after the upgrade')

    await moveProjectDirsToIds()

    expect(await exists(projectDir(NAME))).toBe(false)
    expect(await fs.readFile(config(ID), 'utf8')).toBe('saved after the upgrade')
    expect(await fs.readFile(path.join(projectDir(ID), 'repo', 'README'), 'utf8')).toBe('hello')
  })

  // An agent still exiting after an earlier move can recreate the old dir;
  // nothing in it is mounted, so no workspace is stopped for it.
  it('folds a dir without a main clone into the id dir without stopping anything', async () => {
    await fs.rename(projectDir(NAME), projectDir(ID))
    const creds = (project: string): string => path.join(claudeDir(project), '.credentials.json')
    await fs.mkdir(claudeDir(NAME), { recursive: true })
    await fs.writeFile(creds(NAME), 'refreshed on exit')
    listed = [handleFixture({ workspaceId: 'a', projectId: ID })]

    await moveProjectDirsToIds()

    expect(destroyed).toEqual([])
    expect(await exists(projectDir(NAME))).toBe(false)
    expect(await fs.readFile(creds(ID), 'utf8')).toBe('refreshed on exit')
  })

  it('leaves a project whose workspaces cannot be confirmed stopped for the next start, moving the rest', async () => {
    await recordTestProject(OTHER, { name: 'gadgets', addedAt: '2026-01-02T00:00:00.000Z' })
    await fs.rm(projectDir(OTHER), { recursive: true })
    await fs.mkdir(path.join(projectDir('gadgets'), 'repo'), { recursive: true })
    await recordWorkspaceCreated({ projectId: ID, workspaceId: 'a' })
    listed = [handleFixture({ workspaceId: 'a', projectId: NAME })]
    destroyResult = false

    await moveProjectDirsToIds()

    expect(await exists(path.join(projectDir(NAME), 'repo', 'README'))).toBe(true)
    expect(await exists(projectDir(ID))).toBe(false)
    expect(await exists(path.join(projectDir(OTHER), 'repo'))).toBe(true)
  })

  it('gives a dir named after a shared name to the oldest project of that name', async () => {
    // Added after the upgrade under the same name, so its dir is its id.
    await recordTestProject(OTHER, { name: NAME, addedAt: '2026-02-01T00:00:00.000Z' })

    await moveProjectDirsToIds()

    expect(await fs.readFile(path.join(projectDir(ID), 'repo', 'README'), 'utf8')).toBe('hello')
    expect(await exists(path.join(projectDir(OTHER), 'repo'))).toBe(false)
  })
})

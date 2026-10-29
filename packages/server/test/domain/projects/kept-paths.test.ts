import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { listProjects, setKeptIgnoredPaths } from '#domain/projects'
import { BUILT_IN_USER_ID, getProjectRow, recordProject } from '#db'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const MISSING = 'ea21841d-a70e-4405-8f19-fabc4ff8bdd9'
const STRANGER = '0a0a0a0a-0000-4000-8000-0000000000aa'

const projectId = DEMO_PROJECT_ID
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  installFakeWorkspaceDriver()
  await recordProject({ id: projectId, name: 'demo', remoteUrl: 'https://example.com/foo', addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
})

afterEach(async () => {
  resetWorkspaceDriver()
  await cleanupTempDir(tmpDir)
})

describe('setKeptIgnoredPaths', () => {
  it('stores a normalized, de-duplicated list that the project summary shows, and empties it again', async () => {
    expect((await listProjects())[0].keptIgnoredPaths).toBeUndefined()
    const saved = await setKeptIgnoredPaths(local, projectId, [' .env ', 'target/release/', '.env', 'a b/[x]*'])
    expect(saved).toEqual(['.env', 'target/release', 'a b/[x]*'])
    expect((await getProjectRow(projectId))?.keptIgnoredPaths).toEqual(saved)
    expect((await listProjects())[0].keptIgnoredPaths).toEqual(saved)

    expect(await setKeptIgnoredPaths(local, projectId, [])).toEqual([])
    expect((await listProjects())[0].keptIgnoredPaths).toBeUndefined()
  })

  it('refuses a path outside the checkout, a control character, too many paths, a stranger and a missing project, keeping what was saved', async () => {
    await setKeptIgnoredPaths(local, projectId, ['.env'])
    for (const bad of ['/etc/passwd', '../up', 'a/./b', '', 'a\nb']) {
      await expect(setKeptIgnoredPaths(local, projectId, [bad])).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    await expect(setKeptIgnoredPaths(local, projectId, Array.from({ length: 101 }, (_, i) => `p${i}`)))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(setKeptIgnoredPaths({ kind: 'local', userId: STRANGER }, projectId, []))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setKeptIgnoredPaths(local, MISSING, [])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await getProjectRow(projectId))?.keptIgnoredPaths).toEqual(['.env'])
  })
})

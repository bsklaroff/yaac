/**
 * The one-shot import of the build dirs an older server kept
 * (docs/legacy-compat-shims.md "Build dirs").
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getImageDetail, getUserImage, importLegacyBuildDirs, listProjectImages, readImageFile } from '#domain/images'
import { BUILT_IN_USER_ID, getProjectRow } from '#db'
import { closeDb } from '#db/client'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import { projectConfigDir, serverLocalPath } from '@yaac/shared/project-paths'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'

const owner = { kind: 'local', userId: BUILT_IN_USER_ID } as const
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordTestProject(DEMO_PROJECT_ID)
  installFakeWorkspaceDriver()
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

describe('importLegacyBuildDirs', () => {
  it('turns a project\'s and a user\'s build dir into images, keeping each dir renamed, once', async () => {
    const projectBuild = path.join(projectConfigDir(DEMO_PROJECT_ID), 'build')
    await write(path.join(projectBuild, 'Dockerfile.yaac'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY a.txt /a\n')
    await write(path.join(projectBuild, 'a.txt'), 'a')
    // What its build never sent is not stored, and stays on disk.
    await write(path.join(projectBuild, 'big/x'), 'x')
    await write(path.join(projectBuild, '.containerignore'), 'big\n')
    const userBuild = serverLocalPath('users', BUILT_IN_USER_ID, 'build')
    await write(path.join(userBuild, 'Dockerfile.user'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n')

    await importLegacyBuildDirs()

    const images = await listProjectImages(owner, DEMO_PROJECT_ID)
    const imported = images.find((i) => i.name === 'default')!
    expect(imported).toMatchObject({ isDefault: true, currentRevision: { number: 1 } })
    expect((await getProjectRow(DEMO_PROJECT_ID))?.defaultImageId).toBe(imported.id)
    const { revision } = await getImageDetail(owner, imported.id)
    expect(Object.keys(revision!.files).sort()).toEqual(['.containerignore', 'a.txt'])
    expect((await readImageFile(owner, imported.id, revision!.id, 'a.txt')).toString()).toBe('a')
    expect(await getUserImage(owner)).toMatchObject({ name: 'Dockerfile.user', currentRevision: { number: 1 } })
    await expect(fs.access(projectBuild)).rejects.toThrow()
    expect(await fs.readFile(path.join(`${projectBuild}.imported`, 'big/x'), 'utf8')).toBe('x')
    expect(await fs.readFile(path.join(`${userBuild}.imported`, 'Dockerfile.user'), 'utf8')).toContain('BASE_IMAGE')
    // The renamed dirs are not read again.
    await importLegacyBuildDirs()
    expect(await listProjectImages(owner, DEMO_PROJECT_ID)).toHaveLength(2)
  })

  it('finishes an import that died before the rename, and leaves no trace of one the database refused', async () => {
    const projectBuild = path.join(projectConfigDir(DEMO_PROJECT_ID), 'build')
    await write(path.join(projectBuild, 'Dockerfile.yaac'), 'FROM x\n')
    await importLegacyBuildDirs()
    // The image was written, then the server died before the rename: the
    // dir is still there (and here an older `build.imported` too).
    await fs.cp(`${projectBuild}.imported`, projectBuild, { recursive: true })
    await importLegacyBuildDirs()
    expect((await listProjectImages(owner, DEMO_PROJECT_ID)).filter((i) => i.name === 'default')).toHaveLength(1)
    await expect(fs.access(projectBuild)).rejects.toThrow()
    // The earlier rename's name is taken, so this one gets the next.
    await fs.access(`${projectBuild}.imported.2`)

    // A Dockerfile Postgres refuses (a NUL byte) writes nothing, and its
    // dir stays for the next start.
    const userBuild = serverLocalPath('users', BUILT_IN_USER_ID, 'build')
    await write(path.join(userBuild, 'Dockerfile.user'), 'FROM x\n\0')
    await importLegacyBuildDirs()
    expect(await getUserImage(owner)).toBeNull()
    await fs.access(path.join(userBuild, 'Dockerfile.user'))
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { projectConfigDir } from '@yaac/shared/project-paths'
import { applyWorkspaceEvent, BUILT_IN_USER_ID, getProjectRow, getWorkspaceRow } from '#db'
import { importScratchDirsFromConfig, scratchDirSettingsPatchSchema, setScratchDirs } from '#domain/projects'

const FOO = 'acbd18db-4cc2-485c-8def-654fccc4a4d8'
const BAR = '37b51d19-4a75-43e4-8b56-f6524f2d51f2'
const OWNER = { kind: 'local' as const, userId: BUILT_IN_USER_ID }

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordTestProject(FOO)
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

const DEFAULT = { dirs: [{ path: 'node_modules' }, { path: 'target' }], ignoredTracked: [] }

describe('scratchDirSettingsPatchSchema', () => {
  const parse = (v: unknown): unknown => scratchDirSettingsPatchSchema.parse(v)

  it('strips surrounding slashes and keeps the first of a path listed twice', () => {
    expect(parse({
      dirs: [{ path: 'node_modules/' }, { path: 'target', sizeGiB: 32 }, { path: 'node_modules', sizeGiB: 2 }],
      ignoredTracked: ['target/', 'target'],
    })).toEqual({ dirs: [{ path: 'node_modules' }, { path: 'target', sizeGiB: 32 }], ignoredTracked: ['target'] })
    expect(parse({})).toEqual({})
  })

  it('refuses a path outside the checkout and a cap that is not a whole number of GiB from 1 to 1024', () => {
    const dir = (path: unknown, sizeGiB: unknown = 8): unknown => ({ dirs: [{ path, sizeGiB }] })
    expect(() => parse({ dirs: 'node_modules' })).toThrow(/array of \{path, sizeGiB\?\} objects/)
    expect(() => parse(dir(5))).toThrow(/must be a string/)
    expect(() => parse(dir('/etc/passwd'))).toThrow(/relative to \/workspace/)
    expect(() => parse(dir(''))).toThrow(/must not be empty/)
    for (const bad of ['../escape', 'a/./b', 'packages/../escape']) {
      expect(() => parse(dir(bad))).toThrow(/must not contain/)
    }
    for (const bad of [0, 1.5, 1025, '8']) expect(() => parse(dir('target', bad))).toThrow()
    expect(() => parse({ ignoredTracked: ['../up'] })).toThrow(/must not contain/)
  })
})

describe('setScratchDirs', () => {
  it('defaults to node_modules and target at the default cap, and sets each part without touching the other', async () => {
    expect((await getProjectRow(FOO))?.scratchDirs).toEqual(DEFAULT)
    await setScratchDirs(OWNER, FOO, { ignoredTracked: ['target'] })
    expect(await setScratchDirs(OWNER, FOO, { dirs: [] })).toEqual({ dirs: [], ignoredTracked: ['target'] })
    expect((await getProjectRow(FOO))?.scratchDirs).toEqual({ dirs: [], ignoredTracked: ['target'] })
  })

  it('refuses anyone but the owner', async () => {
    await expect(setScratchDirs({ kind: 'local', userId: BAR }, FOO, { dirs: [] }))
      .rejects.toThrow(/only the owner/)
    expect((await getProjectRow(FOO))?.scratchDirs).toEqual(DEFAULT)
  })
})

describe('importScratchDirsFromConfig', () => {
  const configFile = (id: string): string => path.join(projectConfigDir(id), 'yaac-config.json')
  const writeConfig = async (id: string, content: string): Promise<void> => {
    await fs.mkdir(projectConfigDir(id), { recursive: true })
    await fs.writeFile(configFile(id), content)
  }

  it('moves the key into the row and out of the file, leaving what it cannot read', async () => {
    await recordTestProject(BAR)
    // Running since before the upgrade, so started with the file's list.
    await applyWorkspaceEvent({ type: 'workspace-created', projectId: FOO, workspaceId: 'running' })
    await writeConfig(FOO, JSON.stringify({ npmCache: false, ephemeralModulesPaths: ['node_modules', 'web/node_modules/'] }))
    await writeConfig(BAR, '{ not json')

    await importScratchDirsFromConfig()

    expect((await getProjectRow(FOO))?.scratchDirs).toEqual({
      dirs: [{ path: 'node_modules' }, { path: 'web/node_modules' }],
      ignoredTracked: [],
    })
    expect(JSON.parse(await fs.readFile(configFile(FOO), 'utf8'))).toEqual({ npmCache: false })
    expect((await getWorkspaceRow(FOO, 'running'))?.scratchDirs).toEqual(['node_modules', 'web/node_modules'])
    expect((await getProjectRow(BAR))?.scratchDirs).toEqual(DEFAULT)
    expect(await fs.readFile(configFile(BAR), 'utf8')).toBe('{ not json')

    // Once imported there is nothing left to import.
    await setScratchDirs(OWNER, FOO, { dirs: [{ path: 'target', sizeGiB: 32 }] })
    await importScratchDirsFromConfig()
    expect((await getProjectRow(FOO))?.scratchDirs.dirs).toEqual([{ path: 'target', sizeGiB: 32 }])
  })
})

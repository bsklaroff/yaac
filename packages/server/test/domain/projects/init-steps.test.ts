import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { projectConfigDir } from '@yaac/shared/project-paths'
import { BUILT_IN_USER_ID, getProjectRow } from '#db'
import { importInitStepsFromConfig, setInitSteps } from '#domain/projects'

const FOO = 'acbd18db-4cc2-485c-8def-654fccc4a4d8'
const BAR = '37b51d19-4a75-43e4-8b56-f6524f2d51f2'
const BAZ = '73feffa4-b7f6-4bb6-8bd3-0e3a1d5a4c2a'
const OWNER = { kind: 'local' as const, userId: BUILT_IN_USER_ID }

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordTestProject(FOO)
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

const configFile = (id: string): string => path.join(projectConfigDir(id), 'yaac-config.json')
async function writeConfig(id: string, config: unknown): Promise<void> {
  await fs.mkdir(projectConfigDir(id), { recursive: true })
  await fs.writeFile(configFile(id), typeof config === 'string' ? config : JSON.stringify(config))
}

describe('setInitSteps', () => {
  it('stores a parsed graph and answers it, refusing a bad one or an unknown project', async () => {
    expect(await setInitSteps(OWNER, FOO, { install: { run: 'pnpm install' } })).toEqual({ install: { run: ['pnpm install'] } })
    expect((await getProjectRow(FOO))?.initSteps).toEqual({ install: { run: ['pnpm install'] } })
    await expect(setInitSteps(OWNER, FOO, { a: { run: 'x', needs: ['b'] } }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: 'init steps: step "a" needs "b", which is not a step' })
    await expect(setInitSteps(OWNER, '0a0a0a0a-0000-4000-8000-0000000000ff', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('importInitStepsFromConfig', () => {
  it('moves each form of initCommands onto the project as the steps it ran as, and drops the keys', async () => {
    await recordTestProject(BAR)
    await recordTestProject(BAZ)
    await writeConfig(FOO, { initCommands: ['pnpm install', 'pnpm build'], hideInitPane: true, npmCache: false })
    await writeConfig(BAR, { initCommands: [
      { name: 'backend', commands: ['pnpm dev:be'] },
      { name: 'frontend', commands: ['pnpm i', 'pnpm dev'], hidePane: true },
      // Names a step may not take, which the old parser allowed, are renamed.
      { name: 'claude-setup', commands: ['a'] },
      { name: 'shell', commands: ['b'] },
    ] })
    // One that cannot convert is left for the user to fix.
    await writeConfig(BAZ, { initCommands: [{ name: 'be', commands: [] }] })

    await importInitStepsFromConfig()

    expect((await getProjectRow(FOO))?.initSteps).toEqual({ init: { run: ['pnpm install', 'pnpm build'] } })
    expect(JSON.parse(await fs.readFile(configFile(FOO), 'utf8'))).toEqual({ npmCache: false })
    expect((await getProjectRow(BAR))?.initSteps).toEqual({
      backend: { run: ['pnpm dev:be'] },
      frontend: { run: ['pnpm i', 'pnpm dev'] },
      'init-claude-setup': { run: ['a'] },
      'init-shell': { run: ['b'] },
    })
    expect((await getProjectRow(BAZ))?.initSteps).toEqual({})
    expect(JSON.parse(await fs.readFile(configFile(BAZ), 'utf8'))).toHaveProperty('initCommands')

    // A project that already has init steps keeps them; the key still goes.
    await setInitSteps(OWNER, FOO, { mine: { run: 'make' } })
    await writeConfig(FOO, { initCommands: ['pnpm install'] })
    await importInitStepsFromConfig()
    expect((await getProjectRow(FOO))?.initSteps).toEqual({ mine: { run: ['make'] } })
    expect(JSON.parse(await fs.readFile(configFile(FOO), 'utf8'))).toEqual({})
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { BUILT_IN_USER_ID, getProjectRow } from '#db'
import { setInitSteps } from '#domain/projects'

const FOO = 'acbd18db-4cc2-485c-8def-654fccc4a4d8'
const OWNER = { kind: 'local' as const, userId: BUILT_IN_USER_ID }

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordTestProject(FOO)
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

describe('setInitSteps', () => {
  it('stores a parsed graph and answers it, refusing a bad one or an unknown project', async () => {
    expect(await setInitSteps(OWNER, FOO, { install: { run: 'pnpm install' } })).toEqual({ install: { run: ['pnpm install'] } })
    expect((await getProjectRow(FOO))?.initSteps).toEqual({ install: { run: ['pnpm install'] } })
    await expect(setInitSteps(OWNER, FOO, { a: { run: 'x', needs: ['b'] } }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: 'init steps: step "a" needs "b", which is not a step' })
    await expect(setInitSteps(OWNER, '0a0a0a0a-0000-4000-8000-0000000000ff', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { projectDir } from '@yaac/shared/project-paths'
import { BUILT_IN_USER_ID, closeDb, recordProject } from '#db'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { listProjectRunSecrets, removeRunSecret, setRunSecret } from '#domain/projects'

/**
 * Run secrets above the store: a value under a shell-legal name, which
 * never leaves in a listing.
 */

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

let tmpDir: string
let pushed: Array<Record<string, string>>

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await fs.mkdir(projectDir(DEMO_PROJECT_ID), { recursive: true })
  await recordProject({ id: DEMO_PROJECT_ID, name: 'demo', addedAt: 'now' }, BUILT_IN_USER_ID)
  pushed = []
  installFakeWorkspaceDriver({
    syncProjectSecrets: (_projectId, _values, runValues) => { pushed.push(runValues); return Promise.resolve() },
  })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('setRunSecret', () => {
  it('stores a value under a shell-legal name', async () => {
    expect(await setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'pem' }))
      .toMatchObject({ name: 'P8_KEY', hasValue: true })
    // The value reaches the runtime at the launch that names it, not here.
    expect(pushed).toEqual([])
    await expect(setRunSecret(local, DEMO_PROJECT_ID, { name: '1BAD', value: 'v' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(setRunSecret(local, DEMO_PROJECT_ID, { name: 'EMPTY', value: '' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('listProjectRunSecrets', () => {
  it('lists names, never a value', async () => {
    await setRunSecret(local, DEMO_PROJECT_ID, { name: 'A', value: 'sekrit' })
    const listed = await listProjectRunSecrets(DEMO_PROJECT_ID)
    expect(listed).toEqual([{ id: listed[0].id, name: 'A', hasValue: true }])
    expect(JSON.stringify(listed)).not.toContain('sekrit')
    await expect(listProjectRunSecrets(OTHER)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('removeRunSecret', () => {
  it('deletes one and takes its value off the runtime', async () => {
    const a = await setRunSecret(local, DEMO_PROJECT_ID, { name: 'A', value: '1' })
    await setRunSecret(local, DEMO_PROJECT_ID, { name: 'B', value: '2' })
    await removeRunSecret(local, DEMO_PROJECT_ID, a.id)
    expect(pushed).toEqual([{ B: '2' }])
    await expect(removeRunSecret(local, DEMO_PROJECT_ID, a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

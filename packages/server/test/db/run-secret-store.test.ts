import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { projectRunSecrets } from '#db/schema'
import { deleteProjectRunSecrets, deleteRunSecret, listRunSecrets, upsertRunSecret } from '#db'
import { forgetSecretConfig } from '#db/secret-key'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
const SITE = '0b3a8d3c-1c1e-4d65-9a43-6f0f1e7b2c11'
const ROUTINE = 'a1b2c3d4-0000-4000-8000-000000000001'

/**
 * Run secret rows: sealed like a proxied secret, so the column never holds
 * the value, and opened again on the way out.
 */

let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(async () => {
  await (await getDb()).delete(projectRunSecrets)
  forgetSecretConfig()
})

const none = { siteIds: [], routineIds: [] }

describe('upsertRunSecret', () => {
  it('seals the value, replaces it and its targets by name, and changes targets alone without one', async () => {
    const made = await upsertRunSecret(PROJ, { name: 'P8_KEY', value: '-----BEGIN PRIVATE KEY-----\nabc', siteIds: [SITE], routineIds: [] })
    expect(made).toMatchObject({ name: 'P8_KEY', value: '-----BEGIN PRIVATE KEY-----\nabc', siteIds: [SITE], routineIds: [] })
    const [stored] = await (await getDb()).select().from(projectRunSecrets).where(eq(projectRunSecrets.name, 'P8_KEY'))
    expect(stored.sealedValue).not.toContain('abc')

    const retargeted = await upsertRunSecret(PROJ, { name: 'P8_KEY', siteIds: [], routineIds: [ROUTINE] })
    expect(retargeted).toMatchObject({ id: made?.id, value: '-----BEGIN PRIVATE KEY-----\nabc', siteIds: [], routineIds: [ROUTINE] })
    expect(await upsertRunSecret(PROJ, { name: 'P8_KEY', value: 'new', ...none })).toMatchObject({ id: made?.id, value: 'new' })

    // Without a value there is nothing to create.
    expect(await upsertRunSecret(PROJ, { name: 'MISSING', ...none })).toBeUndefined()
    expect((await listRunSecrets(PROJ)).map((r) => r.name)).toEqual(['P8_KEY'])
  })
})

describe('listRunSecrets', () => {
  it('lists one project\'s in name order, reading one that will not open as having no value', async () => {
    await upsertRunSecret(PROJ, { name: 'B', value: 'b', ...none })
    await upsertRunSecret(PROJ, { name: 'A', value: 'a', ...none })
    await upsertRunSecret(OTHER, { name: 'C', value: 'c', ...none })
    expect((await listRunSecrets(PROJ)).map((r) => [r.name, r.value])).toEqual([['A', 'a'], ['B', 'b']])

    await (await getDb()).update(projectRunSecrets).set({ sealedValue: 'garbage' }).where(eq(projectRunSecrets.name, 'A'))
    expect((await listRunSecrets(PROJ))[0]).toMatchObject({ name: 'A', value: undefined })
  })
})

describe('deleteRunSecret', () => {
  it('deletes by id within the project only', async () => {
    const a = await upsertRunSecret(PROJ, { name: 'A', value: 'a', ...none })
    expect(await deleteRunSecret(OTHER, a!.id)).toBe(false)
    expect(await deleteRunSecret(PROJ, a!.id)).toBe(true)
    expect(await listRunSecrets(PROJ)).toEqual([])
  })
})

describe('deleteProjectRunSecrets', () => {
  it('deletes a project\'s run secrets only', async () => {
    await upsertRunSecret(PROJ, { name: 'A', value: 'a', ...none })
    await upsertRunSecret(OTHER, { name: 'C', value: 'c', ...none })
    await deleteProjectRunSecrets(PROJ)
    expect(await listRunSecrets(PROJ)).toEqual([])
    expect(await listRunSecrets(OTHER)).toHaveLength(1)
  })
})

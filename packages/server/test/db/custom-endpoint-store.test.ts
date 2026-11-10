import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { customEndpoints } from '#db/schema'
import {
  BUILT_IN_USER_ID,
  deleteCustomEndpoint,
  getCustomEndpoint,
  insertCustomEndpoint,
  listCustomEndpoints,
  seeTailnetUser,
  updateCustomEndpoint,
} from '#db'

/**
 * Each user's custom endpoints, their keys sealed at rest. What matters: the
 * column is not the key, names are unique per owner, and a key that will not
 * open reads as none rather than failing the caller.
 */

const ME = BUILT_IN_USER_ID
const MODELS = [{ id: 'llama', efforts: { levels: ['low' as const, 'high' as const], default: 'low' as const } }]
const entry = (owner: string, name: string, apiKey = '') => ({ owner, name, baseUrl: 'https://box/v1', apiKey, models: MODELS })

let tmpDir: string
let bob: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(async () => {
  await (await getDb()).delete(customEndpoints)
  bob = await seeTailnetUser('bob@example.com', 'Bob')
})

describe('insertCustomEndpoint', () => {
  it('seals the key, keeps an empty one empty, and refuses a name its owner already uses', async () => {
    const row = await insertCustomEndpoint(entry(ME, 'box', 'sk-box'))
    expect(row).toMatchObject({ owner: ME, name: 'box', apiKey: 'sk-box', models: MODELS })
    await insertCustomEndpoint(entry(ME, 'keyless'))
    const sealed = await (await getDb()).select().from(customEndpoints)
    expect(sealed.find((r) => r.name === 'box')?.sealedApiKey).not.toContain('sk-box')
    expect(sealed.find((r) => r.name === 'keyless')?.sealedApiKey).toBe('')
    await insertCustomEndpoint(entry(bob, 'box'))
    await expect(insertCustomEndpoint(entry(ME, 'box'))).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('listCustomEndpoints', () => {
  it('lists one owner\'s endpoints oldest first, or everyone\'s', async () => {
    await insertCustomEndpoint(entry(ME, 'first'))
    await insertCustomEndpoint(entry(bob, 'bobs'))
    await insertCustomEndpoint(entry(ME, 'second'))
    expect((await listCustomEndpoints(ME)).map((e) => e.name)).toEqual(['first', 'second'])
    expect(await listCustomEndpoints()).toHaveLength(3)
  })
})

describe('getCustomEndpoint', () => {
  it('reads an endpoint by id, and a key that will not open as none', async () => {
    const { id } = await insertCustomEndpoint(entry(ME, 'box', 'sk-box'))
    expect(await getCustomEndpoint(id)).toMatchObject({ name: 'box', apiKey: 'sk-box' })
    await (await getDb()).update(customEndpoints).set({ sealedApiKey: 'garbage' })
    expect(await getCustomEndpoint(id)).toMatchObject({ name: 'box', apiKey: '' })
    expect(await getCustomEndpoint('00000000-0000-4000-8000-000000000000')).toBeUndefined()
  })
})

describe('updateCustomEndpoint', () => {
  it('changes only the fields given, refusing a name the owner already uses', async () => {
    const { id } = await insertCustomEndpoint(entry(ME, 'box', 'sk-box'))
    await insertCustomEndpoint(entry(ME, 'other'))
    expect(await updateCustomEndpoint(id, { baseUrl: 'https://new/v1', models: [{ id: 'qwen' }] }))
      .toMatchObject({ name: 'box', baseUrl: 'https://new/v1', apiKey: 'sk-box', models: [{ id: 'qwen' }] })
    expect(await updateCustomEndpoint(id, { apiKey: '', name: 'box' })).toMatchObject({ apiKey: '' })
    await expect(updateCustomEndpoint(id, { name: 'other' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await updateCustomEndpoint('00000000-0000-4000-8000-000000000000', { name: 'x' })).toBeUndefined()
  })
})

describe('deleteCustomEndpoint', () => {
  it('removes an endpoint and says whether there was one', async () => {
    const { id } = await insertCustomEndpoint(entry(ME, 'box'))
    expect(await deleteCustomEndpoint(id)).toBe(true)
    expect(await deleteCustomEndpoint(id)).toBe(false)
  })
})

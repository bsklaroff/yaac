import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { tokenBindings, users } from '#db/schema'
import {
  BUILT_IN_USER_ID,
  deleteTokenBinding,
  findTokenBinding,
  getTokenBinding,
  insertTokenBinding,
  listTokenBindings,
  markTokenBindingUsed,
  recordRefusedSubject,
  seeTailnetUser,
  type NewTokenBinding,
} from '#db'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(async () => {
  const db = await getDb()
  await db.delete(tokenBindings)
})

const pat = (label: string, tokenHash: string, owner = BUILT_IN_USER_ID): NewTokenBinding =>
  ({ owner, kind: 'pat', label, ceiling: 'bypass', tokenHash })

describe('insertTokenBinding', () => {
  it('stores a binding, with labels unique per owner', async () => {
    const row = await insertTokenBinding(pat('ci', 'h1'))
    expect(row).toMatchObject({ label: 'ci', kind: 'pat', ceiling: 'bypass', lastUsedAt: null })
    await expect(insertTokenBinding(pat('ci', 'h2'))).rejects.toMatchObject({ code: 'CONFLICT' })
    const bo = await seeTailnetUser('bo@example.com', 'Bo')
    await expect(insertTokenBinding(pat('ci', 'h3', bo))).resolves.toMatchObject({ owner: bo })
  })
})

describe('listTokenBindings', () => {
  it('lists one owner\'s bindings, oldest first', async () => {
    await insertTokenBinding(pat('a', 'ha'))
    await insertTokenBinding(pat('b', 'hb'))
    await insertTokenBinding(pat('other', 'ho', await seeTailnetUser('cy@example.com', 'Cy')))
    expect((await listTokenBindings(BUILT_IN_USER_ID)).map((b) => b.label)).toEqual(['a', 'b'])
  })
})

describe('getTokenBinding', () => {
  it('reads one binding by id', async () => {
    const row = await insertTokenBinding(pat('a', 'ha'))
    expect((await getTokenBinding(row.id))?.label).toBe('a')
    expect(await getTokenBinding('00000000-0000-4000-8000-000000000009')).toBeUndefined()
  })
})

describe('findTokenBinding', () => {
  it('finds a binding by token hash or audience with its owner\'s login, and loses it with its owner', async () => {
    const dee = await seeTailnetUser('dee@example.com', 'Dee')
    await insertTokenBinding(pat('ci', 'hd', dee))
    await insertTokenBinding({
      owner: BUILT_IN_USER_ID, kind: 'oidc', label: 'gha', ceiling: 'plan',
      issuer: 'https://issuer.example', subject: 's', claims: { a: 'b' }, audience: 'yaac:aud',
    })
    expect(await findTokenBinding({ tokenHash: 'hd' })).toMatchObject({ login: 'dee@example.com', binding: { label: 'ci' } })
    expect(await findTokenBinding({ audience: 'yaac:aud' })).toMatchObject({ login: null, binding: { claims: { a: 'b' } } })
    expect(await findTokenBinding({ tokenHash: 'missing' })).toBeUndefined()
    const db = await getDb()
    await db.delete(users).where(eq(users.id, dee))
    expect(await findTokenBinding({ tokenHash: 'hd' })).toBeUndefined()
  })
})

describe('deleteTokenBinding', () => {
  it('deletes a binding and says whether there was one', async () => {
    const row = await insertTokenBinding(pat('a', 'ha'))
    expect(await deleteTokenBinding(row.id)).toBe(true)
    expect(await deleteTokenBinding(row.id)).toBe(false)
    expect(await getTokenBinding(row.id)).toBeUndefined()
  })
})

describe('markTokenBindingUsed', () => {
  it('notes a use at most hourly', async () => {
    const row = await insertTokenBinding(pat('used', 'hu'))
    await markTokenBindingUsed(row.id)
    const first = (await getTokenBinding(row.id))?.lastUsedAt
    expect(first).toBeInstanceOf(Date)
    await markTokenBindingUsed(row.id)
    expect((await getTokenBinding(row.id))?.lastUsedAt).toEqual(first)
    const hoursAgo = new Date((first as Date).getTime() - 2 * 60 * 60_000)
    const db = await getDb()
    await db.update(tokenBindings).set({ lastUsedAt: hoursAgo }).where(eq(tokenBindings.id, row.id))
    await markTokenBindingUsed(row.id)
    expect((await getTokenBinding(row.id))?.lastUsedAt?.getTime()).toBeGreaterThan(hoursAgo.getTime())
  })
})

describe('recordRefusedSubject', () => {
  it('records the subject a refused token carried, and when', async () => {
    const row = await insertTokenBinding({
      owner: BUILT_IN_USER_ID, kind: 'oidc', label: 'gha', ceiling: 'plan', issuer: 'https://i.example', subject: 's', audience: 'yaac:x',
    })
    await recordRefusedSubject(row.id, 'wrong')
    expect(await getTokenBinding(row.id)).toMatchObject({ refusedSubject: 'wrong', refusedAt: expect.any(Date) as Date })
  })
})

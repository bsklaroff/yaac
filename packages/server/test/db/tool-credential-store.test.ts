import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { toolCredentials } from '#db/schema'
import {
  BUILT_IN_USER_ID,
  deleteToolCredential,
  getToolCredential,
  listToolCredentials,
  seeTailnetUser,
  setToolCredential,
} from '#db'
import { forgetSecretConfig } from '#db/secret-key'
import { eq } from 'drizzle-orm'

/**
 * Each user's tool sign-ins, sealed at rest. What matters: the column is not
 * the secret, a user reads only their own, and a row that will not open
 * reads as signed out rather than failing the caller.
 */

const OAUTH = {
  kind: 'oauth' as const,
  savedAt: '2026-10-01T00:00:00.000Z',
  claudeAiOauth: { accessToken: 'sk-ant-oat01-secret', refreshToken: 'r', expiresAt: 1, scopes: [] },
}

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
  await (await getDb()).delete(toolCredentials)
  forgetSecretConfig()
  bob = await seeTailnetUser('bob@example.com', 'Bob')
})

describe('getToolCredential', () => {
  it('reads one user\'s credential for one tool, and a sealed row that will not open as none', async () => {
    await setToolCredential(BUILT_IN_USER_ID, 'claude', OAUTH)
    expect(await getToolCredential(BUILT_IN_USER_ID, 'claude')).toEqual(OAUTH)
    expect(await getToolCredential(BUILT_IN_USER_ID, 'codex')).toBeNull()
    expect(await getToolCredential(bob, 'claude')).toBeNull()

    const db = await getDb()
    await db.update(toolCredentials).set({ sealedCredential: 'garbage' })
    expect(await getToolCredential(BUILT_IN_USER_ID, 'claude')).toBeNull()
  })
})

describe('setToolCredential', () => {
  it('seals the credential and replaces the user\'s previous one', async () => {
    await setToolCredential(bob, 'opencode', { kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'sk-or-1' })
    await setToolCredential(bob, 'opencode', { kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'sk-or-2' })

    const rows = await (await getDb()).select().from(toolCredentials).where(eq(toolCredentials.owner, bob))
    expect(rows).toHaveLength(1)
    expect(rows[0].sealedCredential).not.toContain('sk-or')
    expect(await getToolCredential(bob, 'opencode')).toMatchObject({ apiKey: 'sk-or-2' })
  })
})

describe('deleteToolCredential', () => {
  it('removes only that user\'s credential and says whether there was one', async () => {
    await setToolCredential(BUILT_IN_USER_ID, 'claude', OAUTH)
    await setToolCredential(bob, 'claude', OAUTH)
    expect(await deleteToolCredential(bob, 'claude')).toBe(true)
    expect(await deleteToolCredential(bob, 'claude')).toBe(false)
    expect(await getToolCredential(BUILT_IN_USER_ID, 'claude')).toEqual(OAUTH)
  })
})

describe('listToolCredentials', () => {
  it('keys every signed-in user\'s bundle by owner', async () => {
    expect(await listToolCredentials()).toEqual({})
    await setToolCredential(BUILT_IN_USER_ID, 'claude', OAUTH)
    await setToolCredential(bob, 'pi', { kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'sk-pi' })
    expect(await listToolCredentials()).toEqual({
      [BUILT_IN_USER_ID]: { claude: OAUTH, codex: null, opencode: null, pi: null },
      [bob]: { claude: null, codex: null, opencode: null, pi: { kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'sk-pi' } },
    })
  })
})

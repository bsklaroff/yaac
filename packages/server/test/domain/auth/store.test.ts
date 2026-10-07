import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { credentialOwnerKey, loadToolAuthEntry } from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, seeTailnetUser, setToolCredential } from '#db'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('credentialOwnerKey', () => {
  it('keeps the built-in user on the key the install\'s one set was pushed under, and keys others by id', () => {
    // Registrations written before credentials were per user name `install`.
    expect(credentialOwnerKey(BUILT_IN_USER_ID)).toBe('install')
    expect(credentialOwnerKey('6f1c1c55-7a53-4bd5-9a0f-0b3a3d1b1a01')).toBe('6f1c1c55-7a53-4bd5-9a0f-0b3a3d1b1a01')
  })
})

describe('loadToolAuthEntry', () => {
  it('flattens a user\'s stored credential per tool, and reads another user\'s as none', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    await setToolCredential(BUILT_IN_USER_ID, 'claude', {
      kind: 'oauth', savedAt: 's', claudeAiOauth: { accessToken: 'sk-ant-oat', refreshToken: 'r', expiresAt: 1, scopes: [] },
    })
    await setToolCredential(BUILT_IN_USER_ID, 'codex', { kind: 'api-key', savedAt: 's', apiKey: 'sk-proj' })
    await setToolCredential(BUILT_IN_USER_ID, 'pi', { kind: 'api-key', provider: 'anthropic', savedAt: 's', apiKey: 'sk-pi' })

    expect(await loadToolAuthEntry(BUILT_IN_USER_ID, 'claude'))
      .toEqual({ tool: 'claude', kind: 'oauth', apiKey: 'sk-ant-oat', savedAt: 's' })
    expect(await loadToolAuthEntry(BUILT_IN_USER_ID, 'codex'))
      .toEqual({ tool: 'codex', kind: 'api-key', apiKey: 'sk-proj', savedAt: 's' })
    expect(await loadToolAuthEntry(BUILT_IN_USER_ID, 'pi'))
      .toEqual({ tool: 'pi', kind: 'api-key', apiKey: 'sk-pi', savedAt: 's', piProvider: 'anthropic' })
    expect(await loadToolAuthEntry(BUILT_IN_USER_ID, 'opencode')).toBeNull()
    expect(await loadToolAuthEntry(bob, 'claude')).toBeNull()
  })
})

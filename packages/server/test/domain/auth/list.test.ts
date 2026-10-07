import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { addHttpsCredential } from '#domain/projects'
import { BUILT_IN_USER_ID, closeDb } from '#db'
import { saveClaudeCredentialsFile, saveToolAuth } from '@yaac/shared/tool-auth'
import { listAuth } from '#domain/auth'

describe('listAuth', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('returns empty lists when nothing is configured', async () => {
    const result = await listAuth(BUILT_IN_USER_ID)
    expect(result).toEqual({ gitCredentials: [], toolAuth: [] })
  })

  it('lists git credentials with masked previews', async () => {
    const acme = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'acme', token: 'ghp_abcdef123456' })
    const other = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'other', token: 'ghp_fallback_xxyz' })
    const result = await listAuth(BUILT_IN_USER_ID)
    expect(result.gitCredentials).toEqual([
      { id: acme.id, name: 'acme', kind: 'https', preview: '***3456', projects: [] },
      { id: other.id, name: 'other', kind: 'https', preview: '***xxyz', projects: [] },
    ])
  })

  it('summarizes every signed-in tool in a fixed order, carrying its provider', async () => {
    await saveClaudeCredentialsFile({
      kind: 'api-key',
      savedAt: '2026-04-20T00:00:00.000Z',
      apiKey: 'sk-ant-api03-longkey-ABCDEFGH',
    })
    // A key too short to keep a tail is masked whole rather than half-shown.
    await saveToolAuth('codex', 'shrt', 'api-key')
    await saveToolAuth('opencode', 'nw-secret-key', 'api-key', 'neuralwatt')
    await saveToolAuth('pi', 'pi-secret-key', 'api-key', 'openrouter')

    const result = await listAuth(BUILT_IN_USER_ID)
    expect(result.toolAuth).toEqual([
      {
        tool: 'claude',
        kind: 'api-key',
        keyPreview: '***EFGH',
        savedAt: '2026-04-20T00:00:00.000Z',
        opencodeProvider: undefined,
        piProvider: undefined,
        models: expect.arrayContaining([{ id: 'claude-opus-5-5', name: 'Opus 5.5' }]) as unknown,
        defaultModel: 'claude-opus-5-5',
      },
      expect.objectContaining({ tool: 'codex', kind: 'api-key', keyPreview: '****' }),
      expect.objectContaining({ tool: 'opencode', kind: 'api-key', opencodeProvider: 'neuralwatt' }),
      expect.objectContaining({ tool: 'pi', kind: 'api-key', piProvider: 'openrouter' }),
    ])
    // Each provider field appears only on its own tool's entry.
    expect(result.toolAuth[2]).toMatchObject({ piProvider: undefined })
    expect(result.toolAuth[3]).toMatchObject({ opencodeProvider: undefined })
    // Models come from the credential; tools whose credential names a
    // provider get provider-qualified ids.
    expect(result.toolAuth[1].defaultModel).toBe('gpt-6-sol')
    expect(result.toolAuth[3].models.every((m) => m.id.startsWith('openrouter/'))).toBe(true)
    expect(result.toolAuth[3].defaultModel).toMatch(/^openrouter\//)
  })

  it('never leaks the raw access token', async () => {
    await saveClaudeCredentialsFile({
      kind: 'oauth',
      savedAt: '2026-04-20T00:00:00.000Z',
      claudeAiOauth: {
        accessToken: 'sk-ant-oat-SECRET-VALUE',
        refreshToken: 'refresh-SECRET',
        expiresAt: 0,
        scopes: [],
      },
    })
    const result = await listAuth(BUILT_IN_USER_ID)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('SECRET-VALUE')
    expect(serialized).not.toContain('refresh-SECRET')
    expect(result.toolAuth[0].kind).toBe('oauth')
    expect(result.toolAuth[0].keyPreview).toBe('***ALUE')
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { addEntry } from '#store/projects/credentials'
import { saveClaudeCredentialsFile, saveToolAuth } from '@yaac/shared/tool-auth'
import { listAuth } from '#domain/auth'

describe('listAuth', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('returns empty lists when nothing is configured', async () => {
    const result = await listAuth()
    expect(result).toEqual({ gitCredentials: [], toolAuth: [] })
  })

  it('lists git credentials with masked previews', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_abcdef123456' })
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_fallback_xxyz' })
    const result = await listAuth()
    expect(result.gitCredentials).toEqual([
      { kind: 'https', pattern: 'github.com/acme/*', preview: '***3456' },
      { kind: 'https', pattern: 'github.com/*', preview: '***xxyz' },
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

    const result = await listAuth()
    expect(result.toolAuth).toEqual([
      {
        tool: 'claude',
        kind: 'api-key',
        keyPreview: '***EFGH',
        savedAt: '2026-04-20T00:00:00.000Z',
        opencodeProvider: undefined,
        piProvider: undefined,
      },
      expect.objectContaining({ tool: 'codex', kind: 'api-key', keyPreview: '****' }),
      expect.objectContaining({ tool: 'opencode', kind: 'api-key', opencodeProvider: 'neuralwatt' }),
      expect.objectContaining({ tool: 'pi', kind: 'api-key', piProvider: 'openrouter' }),
    ])
    // A provider belongs to the tool that has one; it never bleeds across.
    expect(result.toolAuth[2]).toMatchObject({ piProvider: undefined })
    expect(result.toolAuth[3]).toMatchObject({ opencodeProvider: undefined })
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
    const result = await listAuth()
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('SECRET-VALUE')
    expect(serialized).not.toContain('refresh-SECRET')
    expect(result.toolAuth[0].kind).toBe('oauth')
    expect(result.toolAuth[0].keyPreview).toBe('***ALUE')
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { addEntry } from '#lib/project/credentials'
import { saveClaudeCredentialsFile, saveToolAuth } from '@yaac/shared/tool-auth'
import { listAuth } from '#lib/auth/list'

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

  it('includes Claude tool auth when configured, masking the API key', async () => {
    await saveClaudeCredentialsFile({
      kind: 'api-key',
      savedAt: '2026-04-20T00:00:00.000Z',
      apiKey: 'sk-ant-api03-longkey-ABCDEFGH',
    })
    const result = await listAuth()
    expect(result.toolAuth).toEqual([
      {
        tool: 'claude',
        kind: 'api-key',
        keyPreview: '***EFGH',
        savedAt: '2026-04-20T00:00:00.000Z',
      },
    ])
  })

  it('surfaces the opencode provider in the summary', async () => {
    await saveToolAuth('opencode', 'nw-secret-key', 'api-key', 'neuralwatt')
    const result = await listAuth()
    expect(result.toolAuth).toEqual([
      expect.objectContaining({
        tool: 'opencode',
        kind: 'api-key',
        opencodeProvider: 'neuralwatt',
      }),
    ])
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

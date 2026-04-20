import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { addToken } from '@/lib/project/credentials'
import { saveClaudeCredentialsFile } from '@/lib/project/tool-auth'
import { listAuth } from '@/lib/auth/list'

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
    expect(result).toEqual({ githubTokens: [], toolAuth: [] })
  })

  it('lists GitHub tokens with masked previews', async () => {
    await addToken('acme/*', 'ghp_abcdef123456')
    await addToken('*', 'ghp_fallback_xxyz')
    const result = await listAuth()
    expect(result.githubTokens).toEqual([
      { pattern: 'acme/*', tokenPreview: '***3456' },
      { pattern: '*', tokenPreview: '***xxyz' },
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { credentialsPath, loadCredentials, saveCredentials } from '@/lib/project/credentials'
import {
  detectAuthKind,
  loadToolAuthEntry,
  saveToolAuth,
  removeToolAuth,
} from '@/lib/project/tool-auth'

describe('tool-auth', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  describe('detectAuthKind', () => {
    it('detects Anthropic API key', () => {
      expect(detectAuthKind('claude', 'sk-ant-api03-abc123')).toBe('api-key')
    })

    it('detects Anthropic OAuth token', () => {
      expect(detectAuthKind('claude', 'sk-ant-oat01-xyz789')).toBe('oauth')
    })

    it('defaults to api-key for unknown claude prefix', () => {
      expect(detectAuthKind('claude', 'some-other-token')).toBe('api-key')
    })

    it('defaults to api-key for codex', () => {
      expect(detectAuthKind('codex', 'sk-proj-abc123')).toBe('api-key')
    })
  })

  describe('loadToolAuthEntry', () => {
    it('returns null when no credentials file exists', async () => {
      const result = await loadToolAuthEntry('claude')
      expect(result).toBeNull()
    })

    it('returns null when file has no toolAuth field', async () => {
      await saveCredentials({ tokens: [{ pattern: '*', token: 'ghp_test' }] })
      const result = await loadToolAuthEntry('claude')
      expect(result).toBeNull()
    })

    it('returns null when toolAuth is empty', async () => {
      await saveCredentials({ tokens: [], toolAuth: [] })
      const result = await loadToolAuthEntry('claude')
      expect(result).toBeNull()
    })

    it('returns entry for matching tool', async () => {
      await saveCredentials({
        tokens: [],
        toolAuth: [{
          tool: 'claude',
          kind: 'oauth',
          apiKey: 'sk-ant-oat01-test',
          savedAt: '2026-04-16T00:00:00Z',
        }],
      })
      const result = await loadToolAuthEntry('claude')
      expect(result).toEqual({
        tool: 'claude',
        kind: 'oauth',
        apiKey: 'sk-ant-oat01-test',
        savedAt: '2026-04-16T00:00:00Z',
      })
    })

    it('returns null for non-matching tool', async () => {
      await saveCredentials({
        tokens: [],
        toolAuth: [{
          tool: 'claude',
          kind: 'oauth',
          apiKey: 'sk-ant-oat01-test',
          savedAt: '2026-04-16T00:00:00Z',
        }],
      })
      const result = await loadToolAuthEntry('codex')
      expect(result).toBeNull()
    })
  })

  describe('saveToolAuth', () => {
    it('adds a new entry', async () => {
      await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')
      const creds = await loadCredentials()
      expect(creds.toolAuth).toHaveLength(1)
      expect(creds.toolAuth![0].tool).toBe('claude')
      expect(creds.toolAuth![0].kind).toBe('oauth')
      expect(creds.toolAuth![0].apiKey).toBe('sk-ant-oat01-test')
      expect(creds.toolAuth![0].savedAt).toBeTruthy()
    })

    it('preserves existing GitHub tokens', async () => {
      await saveCredentials({ tokens: [{ pattern: '*', token: 'ghp_test' }] })
      await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([{ pattern: '*', token: 'ghp_test' }])
      expect(creds.toolAuth).toHaveLength(1)
    })

    it('updates existing entry for same tool (upsert)', async () => {
      await saveToolAuth('claude', 'sk-ant-oat01-old', 'oauth')
      await saveToolAuth('claude', 'sk-ant-api03-new', 'api-key')
      const creds = await loadCredentials()
      expect(creds.toolAuth).toHaveLength(1)
      expect(creds.toolAuth![0].apiKey).toBe('sk-ant-api03-new')
      expect(creds.toolAuth![0].kind).toBe('api-key')
    })

    it('stores entries for different tools independently', async () => {
      await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')
      await saveToolAuth('codex', 'sk-proj-openai', 'api-key')
      const creds = await loadCredentials()
      expect(creds.toolAuth).toHaveLength(2)
      expect(creds.toolAuth![0].tool).toBe('claude')
      expect(creds.toolAuth![1].tool).toBe('codex')
    })
  })

  describe('removeToolAuth', () => {
    it('removes an existing entry', async () => {
      await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')
      const removed = await removeToolAuth('claude')
      expect(removed).toBe(true)
      const creds = await loadCredentials()
      expect(creds.toolAuth).toHaveLength(0)
    })

    it('returns false when tool not found', async () => {
      await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')
      const removed = await removeToolAuth('codex')
      expect(removed).toBe(false)
    })

    it('returns false when no credentials exist', async () => {
      const removed = await removeToolAuth('claude')
      expect(removed).toBe(false)
    })

    it('preserves other entries', async () => {
      await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')
      await saveToolAuth('codex', 'sk-proj-openai', 'api-key')
      await removeToolAuth('claude')
      const creds = await loadCredentials()
      expect(creds.toolAuth).toHaveLength(1)
      expect(creds.toolAuth![0].tool).toBe('codex')
    })
  })

  describe('backward compatibility', () => {
    it('handles credential files without toolAuth field', async () => {
      await fs.writeFile(
        credentialsPath(),
        JSON.stringify({ tokens: [{ pattern: '*', token: 'ghp_test' }] }),
      )
      const result = await loadToolAuthEntry('claude')
      expect(result).toBeNull()

      // Saving tool auth should preserve existing tokens
      await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([{ pattern: '*', token: 'ghp_test' }])
      expect(creds.toolAuth).toHaveLength(1)
    })

    it('handles toolAuth entries with missing fields', async () => {
      await fs.writeFile(
        credentialsPath(),
        JSON.stringify({
          tokens: [],
          toolAuth: [
            { tool: 'claude', kind: 'oauth', apiKey: 'valid', savedAt: '2026-01-01' },
            { tool: 'codex' }, // missing required fields
            { tool: 'codex', kind: 'api-key', apiKey: '', savedAt: '2026-01-01' }, // empty apiKey
          ],
        }),
      )
      const creds = await loadCredentials()
      expect(creds.toolAuth).toHaveLength(1)
      expect(creds.toolAuth![0].tool).toBe('claude')
    })
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@test/helpers/setup'
import {
  credentialsPath,
  loadCredentials,
  getGithubToken,
  resolveTokenForUrl,
  addToken,
  removeToken,
  listTokens,
  validatePattern,
  parseRepoPath,
  matchPattern,
  saveCredentials,
} from '@/lib/project/credentials'

describe('credentials', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('credentialsPath returns path inside data dir', () => {
    expect(credentialsPath()).toBe(path.join(getDataDir(), '.credentials.json'))
  })

  describe('loadCredentials', () => {
    it('returns empty tokens when file is missing', async () => {
      const result = await loadCredentials()
      expect(result).toEqual({ tokens: [], toolAuth: [] })
    })

    it('returns tokens from valid file', async () => {
      await fs.writeFile(
        credentialsPath(),
        JSON.stringify({ tokens: [{ pattern: '*', token: 'ghp_test123' }] }),
      )
      const result = await loadCredentials()
      expect(result.tokens).toEqual([{ pattern: '*', token: 'ghp_test123' }])
    })

    it('filters out entries with empty tokens', async () => {
      await fs.writeFile(
        credentialsPath(),
        JSON.stringify({ tokens: [
          { pattern: '*', token: '' },
          { pattern: 'org/*', token: 'ghp_valid' },
        ] }),
      )
      const result = await loadCredentials()
      expect(result.tokens).toEqual([{ pattern: 'org/*', token: 'ghp_valid' }])
    })

    it('returns empty tokens for invalid JSON', async () => {
      await fs.writeFile(credentialsPath(), 'not json')
      const result = await loadCredentials()
      expect(result).toEqual({ tokens: [], toolAuth: [] })
    })

    it('returns empty tokens when tokens field is not an array', async () => {
      await fs.writeFile(credentialsPath(), JSON.stringify({ tokens: 'not-array' }))
      const result = await loadCredentials()
      expect(result).toEqual({ tokens: [], toolAuth: [] })
    })

    it('preserves toolAuth field when present', async () => {
      await fs.writeFile(
        credentialsPath(),
        JSON.stringify({
          tokens: [{ pattern: '*', token: 'ghp_test' }],
          toolAuth: [{
            tool: 'claude',
            kind: 'oauth',
            apiKey: 'sk-ant-oat01-test',
            savedAt: '2026-01-01T00:00:00Z',
          }],
        }),
      )
      const result = await loadCredentials()
      expect(result.tokens).toEqual([{ pattern: '*', token: 'ghp_test' }])
      expect(result.toolAuth).toEqual([{
        tool: 'claude',
        kind: 'oauth',
        apiKey: 'sk-ant-oat01-test',
        savedAt: '2026-01-01T00:00:00Z',
      }])
    })

    it('returns empty toolAuth when field is missing', async () => {
      await fs.writeFile(
        credentialsPath(),
        JSON.stringify({ tokens: [{ pattern: '*', token: 'ghp_test' }] }),
      )
      const result = await loadCredentials()
      expect(result.toolAuth).toEqual([])
    })

    it('round-trips both tokens and toolAuth', async () => {
      const creds = {
        tokens: [{ pattern: '*', token: 'ghp_test' }],
        toolAuth: [{
          tool: 'claude' as const,
          kind: 'oauth' as const,
          apiKey: 'sk-ant-oat01-test',
          savedAt: '2026-01-01T00:00:00Z',
        }],
      }
      await saveCredentials(creds)
      const loaded = await loadCredentials()
      expect(loaded).toEqual(creds)
    })
  })

  describe('getGithubToken', () => {
    it('returns first token from file', async () => {
      await fs.writeFile(
        credentialsPath(),
        JSON.stringify({ tokens: [
          { pattern: 'org/*', token: 'ghp_first' },
          { pattern: '*', token: 'ghp_fallback' },
        ] }),
      )
      const token = await getGithubToken()
      expect(token).toBe('ghp_first')
    })

    it('returns null when file missing', async () => {
      const token = await getGithubToken()
      expect(token).toBeNull()
    })

    it('returns null when tokens array is empty', async () => {
      await fs.writeFile(credentialsPath(), JSON.stringify({ tokens: [] }))
      const token = await getGithubToken()
      expect(token).toBeNull()
    })
  })

  describe('validatePattern', () => {
    it('accepts catch-all *', () => {
      expect(validatePattern('*')).toBe(true)
    })

    it('accepts owner/*', () => {
      expect(validatePattern('acme-corp/*')).toBe(true)
    })

    it('accepts owner/repo', () => {
      expect(validatePattern('acme-corp/my-repo')).toBe(true)
    })

    it('rejects empty string', () => {
      expect(validatePattern('')).toBe(false)
    })

    it('rejects single segment without wildcard', () => {
      expect(validatePattern('acme-corp')).toBe(false)
    })

    it('rejects wildcard in owner position', () => {
      expect(validatePattern('*/repo')).toBe(false)
    })

    it('rejects partial wildcards in repo', () => {
      expect(validatePattern('owner/repo-*')).toBe(false)
    })

    it('rejects three segments', () => {
      expect(validatePattern('a/b/c')).toBe(false)
    })

    it('rejects wildcard in owner with wildcard repo', () => {
      expect(validatePattern('*/*')).toBe(false)
    })
  })

  describe('parseRepoPath', () => {
    it('parses https URL with .git suffix', () => {
      expect(parseRepoPath('https://github.com/acme/repo.git'))
        .toEqual({ owner: 'acme', repo: 'repo' })
    })

    it('parses https URL without .git suffix', () => {
      expect(parseRepoPath('https://github.com/acme/repo'))
        .toEqual({ owner: 'acme', repo: 'repo' })
    })

    it('throws for URL with no repo segment', () => {
      expect(() => parseRepoPath('https://github.com/acme')).toThrow()
    })
  })

  describe('matchPattern', () => {
    it('* matches everything', () => {
      expect(matchPattern('*', 'any-org', 'any-repo')).toBe(true)
    })

    it('owner/* matches any repo for that owner', () => {
      expect(matchPattern('acme/*', 'acme', 'repo1')).toBe(true)
      expect(matchPattern('acme/*', 'acme', 'repo2')).toBe(true)
    })

    it('owner/* does not match different owner', () => {
      expect(matchPattern('acme/*', 'other', 'repo1')).toBe(false)
    })

    it('owner/repo matches exact repo', () => {
      expect(matchPattern('acme/my-repo', 'acme', 'my-repo')).toBe(true)
    })

    it('owner/repo does not match different repo', () => {
      expect(matchPattern('acme/my-repo', 'acme', 'other-repo')).toBe(false)
    })

    it('owner/repo does not match different owner', () => {
      expect(matchPattern('acme/my-repo', 'other', 'my-repo')).toBe(false)
    })
  })

  describe('resolveTokenForUrl', () => {
    it('returns first matching token', async () => {
      await saveCredentials({ tokens: [
        { pattern: 'acme/*', token: 'ghp_acme' },
        { pattern: '*', token: 'ghp_fallback' },
      ] })
      const token = await resolveTokenForUrl('https://github.com/acme/repo.git')
      expect(token).toBe('ghp_acme')
    })

    it('falls through to catch-all', async () => {
      await saveCredentials({ tokens: [
        { pattern: 'acme/*', token: 'ghp_acme' },
        { pattern: '*', token: 'ghp_fallback' },
      ] })
      const token = await resolveTokenForUrl('https://github.com/other/repo.git')
      expect(token).toBe('ghp_fallback')
    })

    it('returns null when no match', async () => {
      await saveCredentials({ tokens: [
        { pattern: 'acme/*', token: 'ghp_acme' },
      ] })
      const token = await resolveTokenForUrl('https://github.com/other/repo.git')
      expect(token).toBeNull()
    })

    it('returns null when no tokens configured', async () => {
      const token = await resolveTokenForUrl('https://github.com/any/repo.git')
      expect(token).toBeNull()
    })

    it('specific repo match wins over owner wildcard when listed first', async () => {
      await saveCredentials({ tokens: [
        { pattern: 'acme/special', token: 'ghp_special' },
        { pattern: 'acme/*', token: 'ghp_acme' },
        { pattern: '*', token: 'ghp_fallback' },
      ] })
      const token = await resolveTokenForUrl('https://github.com/acme/special.git')
      expect(token).toBe('ghp_special')
    })
  })

  describe('addToken', () => {
    it('adds a new token', async () => {
      await addToken('acme/*', 'ghp_acme')
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([{ pattern: 'acme/*', token: 'ghp_acme' }])
    })

    it('replaces an existing token with same pattern', async () => {
      await addToken('acme/*', 'ghp_old')
      await addToken('acme/*', 'ghp_new')
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([{ pattern: 'acme/*', token: 'ghp_new' }])
    })

    it('inserts before catch-all *', async () => {
      await addToken('*', 'ghp_default')
      await addToken('acme/*', 'ghp_acme')
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([
        { pattern: 'acme/*', token: 'ghp_acme' },
        { pattern: '*', token: 'ghp_default' },
      ])
    })

    it('appends when no catch-all exists', async () => {
      await addToken('acme/*', 'ghp_acme')
      await addToken('other/*', 'ghp_other')
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([
        { pattern: 'acme/*', token: 'ghp_acme' },
        { pattern: 'other/*', token: 'ghp_other' },
      ])
    })
  })

  describe('removeToken', () => {
    it('removes an existing token', async () => {
      await addToken('acme/*', 'ghp_acme')
      await addToken('*', 'ghp_default')
      const removed = await removeToken('acme/*')
      expect(removed).toBe(true)
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([{ pattern: '*', token: 'ghp_default' }])
    })

    it('returns false when pattern not found', async () => {
      await addToken('*', 'ghp_default')
      const removed = await removeToken('nonexistent/*')
      expect(removed).toBe(false)
    })
  })

  describe('listTokens', () => {
    it('returns masked tokens', async () => {
      await addToken('acme/*', 'ghp_abcdef1234')
      await addToken('*', 'ghp_xyz')
      const list = await listTokens()
      expect(list).toEqual([
        { pattern: 'acme/*', tokenPreview: '***1234' },
        { pattern: '*', tokenPreview: '***_xyz' },
      ])
    })

    it('returns empty list when no tokens', async () => {
      const list = await listTokens()
      expect(list).toEqual([])
    })
  })
})

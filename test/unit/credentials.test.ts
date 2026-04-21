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
  removeTokenChecked,
  replaceTokens,
  listTokens,
  validatePattern,
  parseRepoPath,
  matchPattern,
  saveCredentials,
} from '@/lib/project/credentials'
import { DaemonError } from '@/daemon/errors'

describe('credentials', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('credentialsPath returns path inside data dir credentials subdirectory', () => {
    expect(credentialsPath()).toBe(path.join(getDataDir(), '.credentials', 'github.json'))
  })

  describe('loadCredentials', () => {
    it('returns empty tokens when file is missing', async () => {
      const result = await loadCredentials()
      expect(result).toEqual({ tokens: [] })
    })

    it('returns tokens from valid file', async () => {
      await saveCredentials({ tokens: [{ pattern: '*', token: 'ghp_test123' }] })
      const result = await loadCredentials()
      expect(result.tokens).toEqual([{ pattern: '*', token: 'ghp_test123' }])
    })

    it('filters out entries with empty tokens', async () => {
      await fs.mkdir(path.dirname(credentialsPath()), { recursive: true })
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
      await fs.mkdir(path.dirname(credentialsPath()), { recursive: true })
      await fs.writeFile(credentialsPath(), 'not json')
      const result = await loadCredentials()
      expect(result).toEqual({ tokens: [] })
    })

    it('returns empty tokens when tokens field is not an array', async () => {
      await fs.mkdir(path.dirname(credentialsPath()), { recursive: true })
      await fs.writeFile(credentialsPath(), JSON.stringify({ tokens: 'not-array' }))
      const result = await loadCredentials()
      expect(result).toEqual({ tokens: [] })
    })

    it('round-trips github tokens', async () => {
      const creds = { tokens: [{ pattern: '*', token: 'ghp_test' }] }
      await saveCredentials(creds)
      const loaded = await loadCredentials()
      expect(loaded).toEqual(creds)
    })
  })

  describe('getGithubToken', () => {
    it('returns first token from file', async () => {
      await fs.mkdir(path.dirname(credentialsPath()), { recursive: true })
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
      await fs.mkdir(path.dirname(credentialsPath()), { recursive: true })
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

  describe('removeTokenChecked', () => {
    it('removes an existing token', async () => {
      await addToken('acme/*', 'ghp_acme')
      await removeTokenChecked('acme/*')
      expect((await loadCredentials()).tokens).toEqual([])
    })

    it('throws NOT_FOUND when the pattern is unknown', async () => {
      await expect(removeTokenChecked('missing/*')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })
  })

  describe('replaceTokens', () => {
    it('writes the provided list verbatim', async () => {
      await addToken('old/*', 'ghp_old')
      await replaceTokens([{ pattern: 'new/*', token: 'ghp_new' }])
      expect((await loadCredentials()).tokens).toEqual([
        { pattern: 'new/*', token: 'ghp_new' },
      ])
    })

    it('accepts an empty list to clear everything', async () => {
      await addToken('*', 'ghp_x')
      await replaceTokens([])
      expect((await loadCredentials()).tokens).toEqual([])
    })

    it('rejects entries with an invalid pattern', async () => {
      await expect(replaceTokens([
        { pattern: '*/*', token: 'ghp_x' },
      ])).rejects.toBeInstanceOf(DaemonError)
    })

    it('rejects non-string entries', async () => {
      await expect(replaceTokens([
        { pattern: 'acme/*', token: 123 as unknown as string },
      ])).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })

  it('saveCredentials writes the file with 0o600 permissions', async () => {
    await addToken('*', 'ghp_secret')
    const stats = await fs.stat(credentialsPath())
    expect(stats.mode & 0o777).toBe(0o600)
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

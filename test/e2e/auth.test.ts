import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import {
  credentialsPath,
  loadCredentials,
  addToken,
  removeToken,
  listTokens,
  resolveTokenForUrl,
  saveCredentials,
} from '@/lib/credentials'

describe('yaac auth', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('auth list shows no tokens when none configured', async () => {
    const list = await listTokens()
    expect(list).toEqual([])
  })

  it('auth list shows configured tokens with masked values', async () => {
    await addToken('acme-corp/*', 'ghp_abcdef123456')
    await addToken('*', 'ghp_fallback_token')
    const list = await listTokens()
    expect(list).toHaveLength(2)
    expect(list[0].pattern).toBe('acme-corp/*')
    expect(list[0].tokenPreview).toBe('***3456')
    expect(list[1].pattern).toBe('*')
    expect(list[1].tokenPreview).toBe('***oken')
  })

  it('auth update adds a new token and reads it back', async () => {
    await addToken('my-org/*', 'ghp_test_org_token')
    const creds = await loadCredentials()
    expect(creds.tokens).toEqual([{ pattern: 'my-org/*', token: 'ghp_test_org_token' }])
  })

  it('auth update replaces token for existing pattern', async () => {
    await addToken('my-org/*', 'ghp_old')
    await addToken('my-org/*', 'ghp_new')
    const creds = await loadCredentials()
    expect(creds.tokens).toHaveLength(1)
    expect(creds.tokens[0].token).toBe('ghp_new')
  })

  it('auth clear removes specific token by pattern', async () => {
    await addToken('acme/*', 'ghp_acme')
    await addToken('*', 'ghp_default')
    const removed = await removeToken('acme/*')
    expect(removed).toBe(true)
    const creds = await loadCredentials()
    expect(creds.tokens).toHaveLength(1)
    expect(creds.tokens[0].pattern).toBe('*')
  })

  it('auth clear all removes all tokens', async () => {
    await addToken('acme/*', 'ghp_acme')
    await addToken('*', 'ghp_default')
    await saveCredentials({ tokens: [] })
    const creds = await loadCredentials()
    expect(creds.tokens).toHaveLength(0)
  })

  it('credentials file has restrictive permissions', async () => {
    await addToken('*', 'ghp_secret')
    const stats = await fs.stat(credentialsPath())
    const mode = stats.mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('resolves correct token based on remote URL pattern', async () => {
    await addToken('acme-corp/private-repo', 'ghp_specific')
    await addToken('acme-corp/*', 'ghp_org')
    await addToken('*', 'ghp_fallback')

    // Specific repo match
    expect(await resolveTokenForUrl('https://github.com/acme-corp/private-repo.git'))
      .toBe('ghp_specific')

    // Org wildcard match
    expect(await resolveTokenForUrl('https://github.com/acme-corp/other-repo.git'))
      .toBe('ghp_org')

    // Fallback
    expect(await resolveTokenForUrl('https://github.com/someone-else/repo.git'))
      .toBe('ghp_fallback')
  })
})

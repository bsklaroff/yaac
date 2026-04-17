import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { loadCredentials, addToken } from '@/lib/project/credentials'
import {
  claudeCredentialsPath,
  codexCredentialsPath,
} from '@/lib/project/paths'
import {
  loadToolAuthEntry,
  saveToolAuth,
  removeToolAuth,
  detectAuthKind,
} from '@/lib/project/tool-auth'

describe('yaac auth tool-auth e2e', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('tool credentials are not configured initially', async () => {
    const claude = await loadToolAuthEntry('claude')
    const codex = await loadToolAuthEntry('codex')
    expect(claude).toBeNull()
    expect(codex).toBeNull()
  })

  it('stores tool credentials independently from github tokens', async () => {
    await addToken('*', 'ghp_github_token')
    await saveToolAuth('claude', 'sk-ant-oat01-abc123', 'oauth')

    const creds = await loadCredentials()
    expect(creds.tokens).toHaveLength(1)
    expect(creds.tokens[0].token).toBe('ghp_github_token')

    const claudeEntry = await loadToolAuthEntry('claude')
    expect(claudeEntry?.tool).toBe('claude')
    expect(claudeEntry?.apiKey).toBe('sk-ant-oat01-abc123')
  })

  it('tool credentials survive github token modifications', async () => {
    await addToken('acme/*', 'ghp_acme')
    await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')
    await saveToolAuth('codex', 'sk-proj-test', 'api-key')

    // Add another GitHub token — this triggers a read-modify-write cycle
    await addToken('*', 'ghp_fallback')

    const creds = await loadCredentials()
    expect(creds.tokens).toHaveLength(2)

    const claudeEntry = await loadToolAuthEntry('claude')
    const codexEntry = await loadToolAuthEntry('codex')
    expect(claudeEntry?.tool).toBe('claude')
    expect(codexEntry?.tool).toBe('codex')
  })

  it('removeToolAuth removes tool credentials while preserving github tokens', async () => {
    await addToken('*', 'ghp_keep')
    await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')

    await removeToolAuth('claude')

    const creds = await loadCredentials()
    expect(creds.tokens).toHaveLength(1)
    expect(creds.tokens[0].token).toBe('ghp_keep')
    expect(await loadToolAuthEntry('claude')).toBeNull()
  })

  it('removing both tools leaves github tokens intact', async () => {
    await addToken('*', 'ghp_test')
    await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')
    await saveToolAuth('codex', 'sk-proj-test', 'api-key')

    await removeToolAuth('claude')
    await removeToolAuth('codex')

    const creds = await loadCredentials()
    expect(creds.tokens).toHaveLength(1)
    expect(await loadToolAuthEntry('claude')).toBeNull()
    expect(await loadToolAuthEntry('codex')).toBeNull()
  })

  it('credentials files have restrictive permissions after tool auth save', async () => {
    await saveToolAuth('claude', 'sk-ant-api03-secret', 'api-key')
    await saveToolAuth('codex', 'sk-proj-secret', 'api-key')
    const claudeStats = await fs.stat(claudeCredentialsPath())
    const codexStats = await fs.stat(codexCredentialsPath())
    expect(claudeStats.mode & 0o777).toBe(0o600)
    expect(codexStats.mode & 0o777).toBe(0o600)
  })

  it('detects oauth vs api-key for anthropic tokens', () => {
    expect(detectAuthKind('claude', 'sk-ant-api03-abcdef')).toBe('api-key')
    expect(detectAuthKind('claude', 'sk-ant-oat01-abcdef')).toBe('oauth')
    expect(detectAuthKind('claude', 'sk-ant-oat-abcdef')).toBe('oauth')
  })

  it('defaults to api-key for openai tokens', () => {
    expect(detectAuthKind('codex', 'sk-proj-abcdef')).toBe('api-key')
    expect(detectAuthKind('codex', 'sk-live-abcdef')).toBe('api-key')
  })
})

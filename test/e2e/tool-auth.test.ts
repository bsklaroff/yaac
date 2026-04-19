import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { loadCredentials, addToken } from '@/lib/project/credentials'
import {
  claudeCredentialsPath,
  codexCredentialsPath,
  projectClaudeCredentialsFile,
  projectCodexAuthFile,
  projectDir,
} from '@/lib/project/paths'
import {
  loadToolAuthEntry,
  saveToolAuth,
  removeToolAuth,
  detectAuthKind,
  writeProjectClaudePlaceholder,
  writeProjectCodexPlaceholder,
  cleanupProjectClaudePlaceholders,
  cleanupProjectCodexPlaceholders,
} from '@/lib/project/tool-auth'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '@/types'

const CLAUDE_BUNDLE: ClaudeOAuthBundle = {
  accessToken: 'sk-ant-oat01-real',
  refreshToken: 'sk-ant-ort01-real',
  expiresAt: 9_999_999_999_000,
  scopes: ['user:inference'],
}

const CODEX_BUNDLE: CodexOAuthBundle = {
  accessToken: 'access-real',
  refreshToken: 'refresh-real',
  idTokenRawJwt: 'h.p.s',
  expiresAt: 9_999_999_999_000,
  lastRefresh: '2026-04-10T00:00:00.000Z',
  accountId: 'acct-1',
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

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

  it('auth clear cleans up per-project Claude placeholders', async () => {
    await fs.mkdir(projectDir('alpha'), { recursive: true })
    await fs.mkdir(projectDir('beta'), { recursive: true })
    await writeProjectClaudePlaceholder('alpha', CLAUDE_BUNDLE)
    await writeProjectClaudePlaceholder('beta', CLAUDE_BUNDLE)
    expect(await exists(projectClaudeCredentialsFile('alpha'))).toBe(true)
    expect(await exists(projectClaudeCredentialsFile('beta'))).toBe(true)

    await removeToolAuth('claude')
    await cleanupProjectClaudePlaceholders()

    expect(await exists(projectClaudeCredentialsFile('alpha'))).toBe(false)
    expect(await exists(projectClaudeCredentialsFile('beta'))).toBe(false)
  })

  it('auth clear cleans up per-project Codex placeholders', async () => {
    await fs.mkdir(projectDir('alpha'), { recursive: true })
    await fs.mkdir(projectDir('beta'), { recursive: true })
    await writeProjectCodexPlaceholder('alpha', CODEX_BUNDLE)
    await writeProjectCodexPlaceholder('beta', CODEX_BUNDLE)
    expect(await exists(projectCodexAuthFile('alpha'))).toBe(true)
    expect(await exists(projectCodexAuthFile('beta'))).toBe(true)

    await removeToolAuth('codex')
    await cleanupProjectCodexPlaceholders()

    expect(await exists(projectCodexAuthFile('alpha'))).toBe(false)
    expect(await exists(projectCodexAuthFile('beta'))).toBe(false)
  })
})

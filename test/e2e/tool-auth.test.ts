import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import {
  credentialsPath,
  loadCredentials,
  saveCredentials,
  addToken,
} from '@/lib/project/credentials'
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

  it('auth list shows tool credentials as not configured initially', async () => {
    const claude = await loadToolAuthEntry('claude')
    const codex = await loadToolAuthEntry('codex')
    expect(claude).toBeNull()
    expect(codex).toBeNull()
  })

  it('saves and loads tool credentials alongside github tokens', async () => {
    await addToken('*', 'ghp_github_token')
    await saveToolAuth('claude', 'sk-ant-oat01-abc123', 'oauth')

    const creds = await loadCredentials()
    expect(creds.tokens).toHaveLength(1)
    expect(creds.tokens[0].token).toBe('ghp_github_token')
    expect(creds.toolAuth).toHaveLength(1)
    expect(creds.toolAuth![0].tool).toBe('claude')
    expect(creds.toolAuth![0].apiKey).toBe('sk-ant-oat01-abc123')
  })

  it('tool credentials survive read-write round trip with github tokens', async () => {
    await addToken('acme/*', 'ghp_acme')
    await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')
    await saveToolAuth('codex', 'sk-proj-test', 'api-key')

    // Add another GitHub token — this triggers a read-modify-write cycle
    await addToken('*', 'ghp_fallback')

    const creds = await loadCredentials()
    expect(creds.tokens).toHaveLength(2)
    expect(creds.toolAuth).toHaveLength(2)
    expect(creds.toolAuth![0].tool).toBe('claude')
    expect(creds.toolAuth![1].tool).toBe('codex')
  })

  it('auth clear removes tool credentials while preserving github tokens', async () => {
    await addToken('*', 'ghp_keep')
    await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')

    await removeToolAuth('claude')

    const creds = await loadCredentials()
    expect(creds.tokens).toHaveLength(1)
    expect(creds.tokens[0].token).toBe('ghp_keep')
    expect(creds.toolAuth).toHaveLength(0)
  })

  it('auth clear all removes everything', async () => {
    await addToken('*', 'ghp_test')
    await saveToolAuth('claude', 'sk-ant-oat01-test', 'oauth')
    await saveToolAuth('codex', 'sk-proj-test', 'api-key')

    await saveCredentials({ tokens: [], toolAuth: [] })

    const creds = await loadCredentials()
    expect(creds.tokens).toHaveLength(0)
    expect(creds.toolAuth).toHaveLength(0)
  })

  it('credentials file has restrictive permissions after tool auth save', async () => {
    await saveToolAuth('claude', 'sk-ant-oat01-secret', 'oauth')
    const stats = await fs.stat(credentialsPath())
    const mode = stats.mode & 0o777
    expect(mode).toBe(0o600)
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

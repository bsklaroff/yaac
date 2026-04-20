import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { clearAuth } from '@/lib/auth/clear'
import { addToken, loadCredentials } from '@/lib/project/credentials'
import {
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  saveClaudeOAuthBundle,
  saveCodexCredentialsFile,
  writeProjectClaudePlaceholder,
  writeProjectCodexPlaceholder,
} from '@/lib/project/tool-auth'
import {
  claudeDir,
  codexDir,
  projectClaudeCredentialsFile,
  projectCodexAuthFile,
  projectDir,
} from '@/lib/project/paths'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '@/shared/types'

const SAMPLE_CLAUDE: ClaudeOAuthBundle = {
  accessToken: 'sk-ant-oat01-real',
  refreshToken: 'sk-ant-ort01-real',
  expiresAt: 9999999999999,
  scopes: ['user:inference'],
}

const SAMPLE_CODEX: CodexOAuthBundle = {
  accessToken: 'codex-real',
  refreshToken: 'codex-refresh',
  idTokenRawJwt: 'eyJhbGciOiJub25lIn0.eyJleHAiOjE3MDB9.',
  expiresAt: 9999999999999,
  lastRefresh: '2026-04-20T00:00:00.000Z',
  accountId: 'acct_x',
}

describe('clearAuth', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('clear "all" wipes github tokens + both tool bundles + placeholders', async () => {
    await addToken('*', 'ghp_x')
    await saveClaudeOAuthBundle(SAMPLE_CLAUDE)
    await saveCodexCredentialsFile({
      kind: 'oauth',
      savedAt: '2026-04-20T00:00:00.000Z',
      codexOauth: SAMPLE_CODEX,
    })
    await fs.mkdir(projectDir('demo'), { recursive: true })
    await fs.mkdir(claudeDir('demo'), { recursive: true })
    await fs.mkdir(codexDir('demo'), { recursive: true })
    await writeProjectClaudePlaceholder('demo', SAMPLE_CLAUDE)
    await writeProjectCodexPlaceholder('demo', SAMPLE_CODEX)

    await clearAuth('all')

    expect((await loadCredentials()).tokens).toEqual([])
    expect(await loadClaudeCredentialsFile()).toBeNull()
    expect(await loadCodexCredentialsFile()).toBeNull()
    await expect(fs.access(projectClaudeCredentialsFile('demo'))).rejects.toThrow()
    await expect(fs.access(projectCodexAuthFile('demo'))).rejects.toThrow()
  })

  it('clear "claude" only touches claude bundle + placeholders', async () => {
    await addToken('*', 'ghp_x')
    await saveClaudeOAuthBundle(SAMPLE_CLAUDE)
    await saveCodexCredentialsFile({
      kind: 'oauth',
      savedAt: '2026-04-20T00:00:00.000Z',
      codexOauth: SAMPLE_CODEX,
    })
    await fs.mkdir(projectDir('demo'), { recursive: true })
    await fs.mkdir(claudeDir('demo'), { recursive: true })
    await fs.mkdir(codexDir('demo'), { recursive: true })
    await writeProjectClaudePlaceholder('demo', SAMPLE_CLAUDE)
    await writeProjectCodexPlaceholder('demo', SAMPLE_CODEX)

    await clearAuth('claude')

    expect((await loadCredentials()).tokens).toEqual([{ pattern: '*', token: 'ghp_x' }])
    expect(await loadClaudeCredentialsFile()).toBeNull()
    expect(await loadCodexCredentialsFile()).not.toBeNull()
    await expect(fs.access(projectClaudeCredentialsFile('demo'))).rejects.toThrow()
    await fs.access(projectCodexAuthFile('demo'))
  })

  it('clear "codex" only touches codex bundle + placeholders', async () => {
    await saveClaudeOAuthBundle(SAMPLE_CLAUDE)
    await saveCodexCredentialsFile({
      kind: 'oauth',
      savedAt: '2026-04-20T00:00:00.000Z',
      codexOauth: SAMPLE_CODEX,
    })
    await fs.mkdir(projectDir('demo'), { recursive: true })
    await fs.mkdir(claudeDir('demo'), { recursive: true })
    await fs.mkdir(codexDir('demo'), { recursive: true })
    await writeProjectClaudePlaceholder('demo', SAMPLE_CLAUDE)
    await writeProjectCodexPlaceholder('demo', SAMPLE_CODEX)

    await clearAuth('codex')

    expect(await loadClaudeCredentialsFile()).not.toBeNull()
    expect(await loadCodexCredentialsFile()).toBeNull()
    await fs.access(projectClaudeCredentialsFile('demo'))
    await expect(fs.access(projectCodexAuthFile('demo'))).rejects.toThrow()
  })

  it('rejects unknown targets with VALIDATION', async () => {
    await expect(
      clearAuth('mystery' as unknown as 'all'),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

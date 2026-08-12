import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { clearAuth } from '#domain/auth'
import { addEntry, loadCredentials } from '#domain/projects/credentials'
import {
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  loadToolAuthEntry,
  saveClaudeOAuthBundle,
  saveCodexCredentialsFile,
  saveToolAuth,
  writeProjectClaudePlaceholder,
  writeProjectCodexPlaceholder,
} from '@yaac/shared/tool-auth'
import {
  claudeDir,
  codexDir,
  projectClaudeCredentialsFile,
  projectCodexAuthFile,
  projectDir,
} from '@yaac/shared/project-paths'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '@yaac/shared/types'

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

/** Everything a clear could plausibly remove: a git credential, all four
 *  tool bundles, and the two per-project placeholder files. Each test seeds
 *  the lot so the assertions can say what survived as well as what went. */
async function seedEverything(): Promise<void> {
  await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_x' })
  await saveClaudeOAuthBundle(SAMPLE_CLAUDE)
  await saveCodexCredentialsFile({
    kind: 'oauth',
    savedAt: '2026-04-20T00:00:00.000Z',
    codexOauth: SAMPLE_CODEX,
  })
  await saveToolAuth('opencode', 'oc-secret-key', 'api-key', 'neuralwatt')
  await saveToolAuth('pi', 'pi-secret-key', 'api-key', 'openrouter')
  await fs.mkdir(projectDir('demo'), { recursive: true })
  await fs.mkdir(claudeDir('demo'), { recursive: true })
  await fs.mkdir(codexDir('demo'), { recursive: true })
  await writeProjectClaudePlaceholder('demo', SAMPLE_CLAUDE)
  await writeProjectCodexPlaceholder('demo', SAMPLE_CODEX)
}

describe('clearAuth', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    await seedEverything()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('clear "all" wipes git tokens, every tool bundle, and both placeholders', async () => {
    await clearAuth('all')

    expect((await loadCredentials()).tokens).toEqual([])
    expect(await loadClaudeCredentialsFile()).toBeNull()
    expect(await loadCodexCredentialsFile()).toBeNull()
    expect(await loadToolAuthEntry('opencode')).toBeNull()
    expect(await loadToolAuthEntry('pi')).toBeNull()
    await expect(fs.access(projectClaudeCredentialsFile('demo'))).rejects.toThrow()
    await expect(fs.access(projectCodexAuthFile('demo'))).rejects.toThrow()
  })

  it('clear "claude" only touches the claude bundle + its placeholders', async () => {
    await clearAuth('claude')

    expect((await loadCredentials()).tokens).toEqual([
      { kind: 'https', pattern: 'github.com/*', token: 'ghp_x' },
    ])
    expect(await loadClaudeCredentialsFile()).toBeNull()
    expect(await loadCodexCredentialsFile()).not.toBeNull()
    await expect(fs.access(projectClaudeCredentialsFile('demo'))).rejects.toThrow()
    await fs.access(projectCodexAuthFile('demo'))
  })

  it('clear "codex" only touches the codex bundle + its placeholders', async () => {
    await clearAuth('codex')

    expect(await loadClaudeCredentialsFile()).not.toBeNull()
    expect(await loadCodexCredentialsFile()).toBeNull()
    await fs.access(projectClaudeCredentialsFile('demo'))
    await expect(fs.access(projectCodexAuthFile('demo'))).rejects.toThrow()
  })

  it('clear "opencode" and "pi" take only their own bundle', async () => {
    // Neither writes a per-project placeholder — api-key auth reaches the
    // container as an env var the proxy swaps, not a bundle on disk — so the
    // bundle removal is the whole of their clear.
    await clearAuth('opencode')
    expect(await loadToolAuthEntry('opencode')).toBeNull()
    expect(await loadToolAuthEntry('pi')).not.toBeNull()

    await clearAuth('pi')
    expect(await loadToolAuthEntry('pi')).toBeNull()

    expect((await loadCredentials()).tokens).toHaveLength(1)
    expect(await loadClaudeCredentialsFile()).not.toBeNull()
    expect(await loadCodexCredentialsFile()).not.toBeNull()
    await fs.access(projectClaudeCredentialsFile('demo'))
    await fs.access(projectCodexAuthFile('demo'))
  })

  it('is idempotent — clearing what is already gone is not an error', async () => {
    await clearAuth('all')
    await clearAuth('all')
    await clearAuth('claude')
    await clearAuth('pi')
    expect(await loadClaudeCredentialsFile()).toBeNull()
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type * as childProcessModule from 'node:child_process'

// The Keychain is reached by running `security`, so that is where this is
// cut — the cleanup itself runs for real, including which service name it
// asks for, which is the part that has to be right.
const execFileSyncMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => string>())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcessModule>()),
  execFileSync: execFileSyncMock,
}))

import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { claudeKeychainService } from '#tool-auth-interactive'
import {
  claudeDir,
  codexDir,
  projectClaudeCredentialsFile,
  projectCodexAuthFile,
  projectDir,
} from '#project-paths'
import {
  cleanupProjectClaudePlaceholders,
  cleanupProjectCodexPlaceholders,
  writeProjectClaudePlaceholder,
  writeProjectCodexPlaceholder,
} from '#tool-auth'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '#types'

const CLAUDE_BUNDLE: ClaudeOAuthBundle = {
  accessToken: 'sk-ant-oat01-real',
  refreshToken: 'sk-ant-ort01-real',
  expiresAt: 9_999_999_999_000,
  scopes: ['user:inference'],
}

const CODEX_BUNDLE: CodexOAuthBundle = {
  accessToken: 'access-real',
  refreshToken: 'refresh-real',
  idTokenRawJwt: 'header.payload.sig',
  expiresAt: 9_999_999_999_000,
  lastRefresh: '2026-04-10T00:00:00.000Z',
  accountId: 'acct-123',
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

describe('cleanupProjectClaudePlaceholders', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('removes the placeholder file from every project that has one', async () => {
    await fs.mkdir(projectDir('alpha'), { recursive: true })
    await fs.mkdir(projectDir('beta'), { recursive: true })
    await writeProjectClaudePlaceholder('alpha', CLAUDE_BUNDLE)
    await writeProjectClaudePlaceholder('beta', CLAUDE_BUNDLE)

    await cleanupProjectClaudePlaceholders()

    expect(await fileExists(projectClaudeCredentialsFile('alpha'))).toBe(false)
    expect(await fileExists(projectClaudeCredentialsFile('beta'))).toBe(false)
  })

  it('clears the macOS Keychain item too, not just the file', async () => {
    // On macOS the file is only half of it. A containerless worktree runs
    // claude with CLAUDE_CONFIG_DIR set to the project's claude dir, and on
    // its first token refresh claude migrates the credential into the
    // Keychain item that dir names and deletes the file. Unlinking alone
    // would then leave a working credential behind while reporting the
    // account signed out.
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      await fs.mkdir(projectDir('alpha'), { recursive: true })
      await fs.mkdir(projectDir('beta'), { recursive: true })
      await writeProjectClaudePlaceholder('alpha', CLAUDE_BUNDLE)
      await writeProjectClaudePlaceholder('beta', CLAUDE_BUNDLE)

      await cleanupProjectClaudePlaceholders()

      const deleted = execFileSyncMock.mock.calls
        .filter((c) => (c[1] as string[])[0] === 'delete-generic-password')
        .map((c) => (c[1] as string[])[2])
      // One per project, each named after that project's own config dir.
      expect(deleted).toContain(claudeKeychainService(claudeDir('alpha')))
      expect(deleted).toContain(claudeKeychainService(claudeDir('beta')))
      // Never the un-suffixed host service — that is the user's own claude
      // install, which signing out of yaac must not touch.
      expect(deleted).not.toContain('Claude Code-credentials')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform })
    }
  })

  it('ignores projects that have no placeholder', async () => {
    await fs.mkdir(projectDir('has-one'), { recursive: true })
    await fs.mkdir(projectDir('none'), { recursive: true })
    await writeProjectClaudePlaceholder('has-one', CLAUDE_BUNDLE)

    await cleanupProjectClaudePlaceholders()
    expect(await fileExists(projectClaudeCredentialsFile('has-one'))).toBe(false)
  })

  it('ignores projects with no claude dir at all', async () => {
    // Bare project dir, no claude/ subdir.
    await fs.mkdir(projectDir('skeletal'), { recursive: true })
    await cleanupProjectClaudePlaceholders()
    // Should not have created the claude dir or file.
    expect(await fileExists(claudeDir('skeletal'))).toBe(false)
  })

  it('leaves other files in the claude dir intact', async () => {
    await fs.mkdir(claudeDir('alpha'), { recursive: true })
    await writeProjectClaudePlaceholder('alpha', CLAUDE_BUNDLE)
    await fs.writeFile(`${claudeDir('alpha')}/other.json`, '{}')

    await cleanupProjectClaudePlaceholders()
    expect(await fileExists(projectClaudeCredentialsFile('alpha'))).toBe(false)
    expect(await fileExists(`${claudeDir('alpha')}/other.json`)).toBe(true)
  })

  it('is a no-op when the projects dir is missing', async () => {
    // Remove the projects dir created by createTempDataDir.
    await fs.rm(`${tmpDir}/projects`, { recursive: true, force: true })
    await cleanupProjectClaudePlaceholders()
    // should not throw
  })
})

describe('cleanupProjectCodexPlaceholders', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('removes the auth.json placeholder from every project that has one', async () => {
    await fs.mkdir(projectDir('alpha'), { recursive: true })
    await fs.mkdir(projectDir('beta'), { recursive: true })
    await writeProjectCodexPlaceholder('alpha', CODEX_BUNDLE)
    await writeProjectCodexPlaceholder('beta', CODEX_BUNDLE)

    await cleanupProjectCodexPlaceholders()

    expect(await fileExists(projectCodexAuthFile('alpha'))).toBe(false)
    expect(await fileExists(projectCodexAuthFile('beta'))).toBe(false)
  })

  it('ignores projects that have no placeholder', async () => {
    await fs.mkdir(projectDir('has-one'), { recursive: true })
    await fs.mkdir(projectDir('none'), { recursive: true })
    await writeProjectCodexPlaceholder('has-one', CODEX_BUNDLE)

    await cleanupProjectCodexPlaceholders()
    expect(await fileExists(projectCodexAuthFile('has-one'))).toBe(false)
  })

  it('ignores projects with no codex dir at all', async () => {
    await fs.mkdir(projectDir('skeletal'), { recursive: true })
    await cleanupProjectCodexPlaceholders()
    expect(await fileExists(codexDir('skeletal'))).toBe(false)
  })

  it('leaves other files in the codex dir intact', async () => {
    await fs.mkdir(codexDir('alpha'), { recursive: true })
    await writeProjectCodexPlaceholder('alpha', CODEX_BUNDLE)
    // Simulate hooks / config.toml / rollouts sitting alongside auth.json.
    await fs.writeFile(`${codexDir('alpha')}/config.toml`, '# keep\n')
    await fs.mkdir(`${codexDir('alpha')}/sessions`, { recursive: true })
    await fs.writeFile(`${codexDir('alpha')}/sessions/rollout.jsonl`, 'keep\n')

    await cleanupProjectCodexPlaceholders()
    expect(await fileExists(projectCodexAuthFile('alpha'))).toBe(false)
    expect(await fileExists(`${codexDir('alpha')}/config.toml`)).toBe(true)
    expect(await fileExists(`${codexDir('alpha')}/sessions/rollout.jsonl`)).toBe(true)
  })

  it('is a no-op when the projects dir is missing', async () => {
    await fs.rm(`${tmpDir}/projects`, { recursive: true, force: true })
    await cleanupProjectCodexPlaceholders()
  })
})

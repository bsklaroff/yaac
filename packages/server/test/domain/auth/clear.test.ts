import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type * as childProcessModule from 'node:child_process'

// Only the `security` process (the macOS Keychain) is mocked; the clear runs
// for real, including the service names it asks for.
const execFileSyncMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => string>())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcessModule>()),
  execFileSync: execFileSyncMock,
}))

import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { clearAuth, loadToolAuthEntry } from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, getToolCredential, recordProject, seeTailnetUser, setToolCredential } from '#db'
import { getDb } from '#db/client'
import { gitCredentials, projects, toolCredentials } from '#db/schema'
import { addHttpsCredential, listCredentialSummaries } from '#domain/projects'
import { writeProjectClaudePlaceholder, writeProjectCodexPlaceholder } from '@yaac/shared/tool-auth'
import { claudeKeychainService } from '@yaac/shared/tool-auth-interactive'
import {
  claudeDir,
  getProjectsDir,
  projectClaudeCredentialsFile,
  projectCodexAuthFile,
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

const ME = BUILT_IN_USER_ID
const DEMO = '00000000-0000-4000-8000-00000000de30'
const BOBS = '00000000-0000-4000-8000-00000000b0b0'
let bob: string

/** Everything a clear might remove (a user's four tool bundles and their
 *  projects' two placeholder files) for two users, plus a git credential it
 *  must not. Each test seeds all of it so assertions cover what survived. */
async function seedEverything(): Promise<void> {
  const db = await getDb()
  await db.delete(toolCredentials)
  await db.delete(projects)
  await db.delete(gitCredentials)
  await fs.rm(getProjectsDir(), { recursive: true, force: true })
  bob = await seeTailnetUser('bob@example.com', 'Bob')
  await addHttpsCredential(ME, { name: 'gh', token: 'ghp_x' })
  for (const [owner, project] of [[ME, DEMO], [bob, BOBS]]) {
    await recordProject({ id: project, name: 'demo', remoteUrl: `https://github.com/acme/${project}`, addedAt: 'x' }, owner)
    await setToolCredential(owner, 'claude', { kind: 'oauth', savedAt: 'x', claudeAiOauth: SAMPLE_CLAUDE })
    await setToolCredential(owner, 'codex', { kind: 'oauth', savedAt: 'x', codexOauth: SAMPLE_CODEX })
    await setToolCredential(owner, 'opencode', { kind: 'api-key', provider: 'neuralwatt', savedAt: 'x', apiKey: 'oc-key' })
    await setToolCredential(owner, 'pi', { kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'pi-key' })
    await writeProjectClaudePlaceholder(project, SAMPLE_CLAUDE)
    await writeProjectCodexPlaceholder(project, SAMPLE_CODEX)
  }
}

/** Bob's bundles and project files, all of which every clear of mine keeps. */
async function expectBobUntouched(): Promise<void> {
  for (const tool of ['claude', 'codex', 'opencode', 'pi'] as const) {
    expect(await getToolCredential(bob, tool)).not.toBeNull()
  }
  await fs.access(projectClaudeCredentialsFile(BOBS))
  await fs.access(projectCodexAuthFile(BOBS))
}

describe('clearAuth', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await createTempDataDir()
  })

  beforeEach(async () => {
    execFileSyncMock.mockReset()
    await seedEverything()
  })

  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('clear "all" wipes the caller\'s every tool bundle and placeholder, but no git credential and nothing of another user\'s', async () => {
    // A git credential is not a tool sign-in: projects are assigned it, and
    // it goes only when deleted on its own, once none does.
    await clearAuth(ME, 'all')

    expect((await listCredentialSummaries(ME)).map((c) => c.name)).toEqual(['gh'])
    for (const tool of ['claude', 'codex', 'opencode', 'pi'] as const) {
      expect(await loadToolAuthEntry(ME, tool)).toBeNull()
    }
    await expect(fs.access(projectClaudeCredentialsFile(DEMO))).rejects.toThrow()
    await expect(fs.access(projectCodexAuthFile(DEMO))).rejects.toThrow()
    await expectBobUntouched()
  })

  it('clear of one tool touches only that bundle and its placeholders', async () => {
    await clearAuth(ME, 'claude')
    expect(await getToolCredential(ME, 'claude')).toBeNull()
    expect(await getToolCredential(ME, 'codex')).not.toBeNull()
    await expect(fs.access(projectClaudeCredentialsFile(DEMO))).rejects.toThrow()
    await fs.access(projectCodexAuthFile(DEMO))

    await clearAuth(ME, 'codex')
    await expect(fs.access(projectCodexAuthFile(DEMO))).rejects.toThrow()

    // opencode and pi reach a workspace as an env var, not a file, so the
    // bundle is the whole of their clear.
    await clearAuth(ME, 'opencode')
    expect(await loadToolAuthEntry(ME, 'opencode')).toBeNull()
    expect(await loadToolAuthEntry(ME, 'pi')).not.toBeNull()
    await expectBobUntouched()

    // Clearing what is already gone is not an error.
    await clearAuth(ME, 'all')
    await clearAuth(ME, 'all')
  })

  it('clears the macOS Keychain item of each of the caller\'s projects, never the user\'s own', async () => {
    // A containerless workspace runs claude with CLAUDE_CONFIG_DIR set to
    // the project's claude dir. On macOS, claude's first token refresh moves
    // the credential into a Keychain item named for that dir and deletes the
    // file, so deleting the file alone would leave a working credential.
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      await clearAuth(ME, 'claude')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform })
    }
    const deleted = execFileSyncMock.mock.calls
      .filter((c) => (c[1] as string[])[0] === 'delete-generic-password')
      .map((c) => (c[1] as string[])[2])
    expect(deleted).toEqual([claudeKeychainService(claudeDir(DEMO))])
  })
})

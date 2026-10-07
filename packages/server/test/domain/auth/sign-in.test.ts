import fs from 'node:fs/promises'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { workspaceDriver } from '#drivers/driver'
import { loadToolAuthEntry, signInTool } from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, getToolCredential, recordProject, seeTailnetUser } from '#db'
import { getDb } from '#db/client'
import { projects, toolCredentials } from '#db/schema'
import { getProjectsDir } from '@yaac/shared/project-paths'
import {
  PLACEHOLDER_ACCESS_TOKEN,
  readProjectClaudeBundle,
  readProjectCodexBundle,
  writeProjectClaudeCredentials,
  writeProjectCodexPlaceholder,
} from '@yaac/shared/tool-auth'
import type { ServerError } from '@yaac/shared/errors'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '@yaac/shared/types'

/**
 * A sign-in stored for its user and handed to their projects' tool homes
 * and the runtime. The database and tool homes are real; the runtime is the
 * fake driver, whose `syncCredentials` records what it was handed.
 */

const ME = BUILT_IN_USER_ID
const ALPHA = '00000000-0000-4000-8000-0000000000a1'
const BETA = '00000000-0000-4000-8000-0000000000b2'
const BOBS = '00000000-0000-4000-8000-0000000000c3'
let bob: string

const claudeBundle = (accessToken: string, expiresAt = 4102444800000): ClaudeOAuthBundle =>
  ({ accessToken, refreshToken: `${accessToken}-refresh`, expiresAt, scopes: ['user:inference'] })
const codexBundle = (accessToken: string): CodexOAuthBundle => ({
  accessToken,
  refreshToken: 'codex-refresh',
  idTokenRawJwt: 'header.payload.sig',
  expiresAt: 4102444800000,
  lastRefresh: '2026-07-09T00:00:00.000Z',
  accountId: 'acct-1',
})

/** Capture a rejection so assertions can read `code` and `message`. */
async function rejection(p: Promise<unknown>): Promise<ServerError> {
  try {
    await p
  } catch (err) {
    return err as ServerError
  }
  throw new Error('expected a rejection, got success')
}

let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(async () => {
  installFakeWorkspaceDriver({ kind: 'containerless' })
  const db = await getDb()
  await db.delete(toolCredentials)
  await db.delete(projects)
  await fs.rm(getProjectsDir(), { recursive: true, force: true })
  bob = await seeTailnetUser('bob@example.com', 'Bob')
  for (const [id, owner] of [[ALPHA, ME], [BETA, ME], [BOBS, bob]]) {
    await recordProject({ id, name: 'p', remoteUrl: `https://github.com/acme/${id}`, addedAt: 'x' }, owner)
  }
})

describe('signInTool', () => {
  it('stores the bundle and pushes the real one to each of the user\'s projects, overriding a newer one, where egress is unmediated', async () => {
    // The old account's bundle expires later, but newest-wins must not
    // block the user switching accounts.
    await writeProjectClaudeCredentials(ALPHA, claudeBundle('old-account', 4102444800000 + 10 * 3600_000))
    await writeProjectClaudeCredentials(BETA, claudeBundle('old-account'))
    await writeProjectClaudeCredentials(BOBS, claudeBundle('bobs-own'))

    await signInTool(ME, 'claude', { kind: 'oauth', bundle: claudeBundle('new-account') })

    expect(await getToolCredential(ME, 'claude')).toMatchObject({ kind: 'oauth', claudeAiOauth: { accessToken: 'new-account' } })
    for (const projectId of [ALPHA, BETA]) {
      expect(await readProjectClaudeBundle(projectId)).toMatchObject({ accessToken: 'new-account' })
    }
    // Another user's project keeps their own sign-in.
    expect(await readProjectClaudeBundle(BOBS)).toMatchObject({ accessToken: 'bobs-own' })
  })

  it('writes sentinels where egress is mediated and hands the runtime each user\'s set under its own key', async () => {
    installFakeWorkspaceDriver({ kind: 'k8s' })
    const synced: unknown[] = []
    workspaceDriver().syncCredentials = (bundles) => { synced.push(bundles); return Promise.resolve() }

    await signInTool(bob, 'codex', { kind: 'oauth', bundle: codexBundle('bob-codex') })
    await signInTool(ME, 'claude', { kind: 'oauth', bundle: claudeBundle('my-claude') })

    expect(await readProjectClaudeBundle(ALPHA)).toMatchObject({ accessToken: PLACEHOLDER_ACCESS_TOKEN })
    expect(await readProjectCodexBundle(BOBS)).toMatchObject({ accessToken: PLACEHOLDER_ACCESS_TOKEN })
    expect(await readProjectCodexBundle(ALPHA)).toBeNull()
    expect(synced.at(-1)).toEqual({
      install: expect.objectContaining({ claude: expect.objectContaining({ kind: 'oauth' }) as unknown, codex: null }) as unknown,
      [bob]: expect.objectContaining({ claude: null, codex: expect.objectContaining({ kind: 'oauth' }) as unknown }) as unknown,
    })
  })

  it('fans a Codex login out independently of Claude, and writes no project file for an api-key tool', async () => {
    await writeProjectCodexPlaceholder(ALPHA, codexBundle('stale'))
    await signInTool(ME, 'codex', { kind: 'oauth', bundle: codexBundle('codex-new') })
    expect(await readProjectCodexBundle(ALPHA)).toMatchObject({ accessToken: 'codex-new', accountId: 'acct-1' })
    expect(await readProjectClaudeBundle(ALPHA)).toBeNull()

    await signInTool(ME, 'opencode', { kind: 'api-key', apiKey: 'sk-or', provider: 'neuralwatt' })
    expect(await loadToolAuthEntry(ME, 'opencode')).toMatchObject({ apiKey: 'sk-or', opencodeProvider: 'neuralwatt' })
    // An api key for an OAuth-capable tool is stored as one.
    await signInTool(ME, 'claude', { kind: 'api-key', apiKey: 'sk-ant-api' })
    expect(await getToolCredential(ME, 'claude')).toMatchObject({ kind: 'api-key', apiKey: 'sk-ant-api' })
  })

  it('refuses a payload that does not fit the tool, storing nothing', async () => {
    expect((await rejection(signInTool(ME, 'codex', { kind: 'oauth', bundle: claudeBundle('x') }))).code).toBe('VALIDATION')
    expect((await rejection(signInTool(ME, 'opencode', { kind: 'oauth', bundle: claudeBundle('x') }))).message)
      .toMatch(/only supports api-key/)
    // The provider decides where the key is sent, so it is never guessed.
    expect((await rejection(signInTool(ME, 'pi', { kind: 'api-key', apiKey: 'k' }))).message)
      .toMatch(/require a provider.*yaac auth update pi/)
    // A rejected provider is echoed truncated, in case a key was pasted there.
    const err = await rejection(signInTool(ME, 'opencode', { kind: 'api-key', apiKey: 'k', provider: 'sk-or-v1-0123456789abcdef' }))
    expect(err.message).toContain('"sk-or-v1-0123456…"')
    for (const tool of ['codex', 'opencode', 'pi'] as const) expect(await getToolCredential(ME, tool)).toBeNull()
  })
})

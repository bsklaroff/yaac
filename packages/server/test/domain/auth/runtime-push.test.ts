import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'


import { INSTALL_CREDENTIAL_OWNER, adoptRefreshedToolCredentials, pushCredentialsToRuntime } from '#domain/auth'
import { addHttpsCredential, assignProjectCredential } from '#domain/projects'
import { BUILT_IN_USER_ID, closeDb, openDb, recordProject } from '#db'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { setDataDir } from '@yaac/shared/project-paths'
import {
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_REFRESH_TOKEN,
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  saveClaudeCredentialsFile,
  saveClaudeOAuthBundle,
  saveCodexOAuthBundle,
  saveOpencodeCredentialsFile,
} from '@yaac/shared/tool-auth'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '@yaac/shared/types'
import type { CredentialBundle } from '#drivers/contract'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const WEB = '2567a5ec-9705-4b7a-82c9-84033e06189d'

/**
 * Pushing the host credential store to the runtime. The credential files and
 * git credential rows are real, in a temp data dir; only the driver that
 * receives the bundle is faked.
 */

const BASE_EXPIRY = 4102444800000 // 2100-01-01

function claudeBundle(overrides: Partial<ClaudeOAuthBundle> = {}): ClaudeOAuthBundle {
  return {
    accessToken: 'claude-access-host', refreshToken: 'claude-refresh-host',
    expiresAt: BASE_EXPIRY, scopes: ['user:inference'], subscriptionType: 'max', ...overrides,
  }
}

function codexBundle(overrides: Partial<CodexOAuthBundle> = {}): CodexOAuthBundle {
  return {
    accessToken: 'codex-access-host', refreshToken: 'codex-refresh-host',
    idTokenRawJwt: 'h.p.s', expiresAt: BASE_EXPIRY,
    lastRefresh: '2026-07-09T00:00:00.000Z', accountId: 'acct-1', ...overrides,
  }
}

let dataDir: string
let synced: CredentialBundle[]
const OWNER = INSTALL_CREDENTIAL_OWNER

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-runtime-push-'))
  setDataDir(dataDir)
  await openDb()
  synced = []
  installFakeWorkspaceDriver({
    syncCredentials: (bundles) => { synced.push(bundles[OWNER]); return Promise.resolve() },
  })
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe('pushCredentialsToRuntime', () => {
  it('composes the bundle from all three stores and hands it over whole', async () => {
    await saveClaudeCredentialsFile({ kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant' })
    await saveCodexOAuthBundle(codexBundle())
    await saveOpencodeCredentialsFile({ kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'sk-or' })
    // Only credentials a project uses are sent, each with its projects.
    // runtimeGitCredentials' tests cover ssh keys.
    await recordProject({ id: WEB, name: 'demo', remoteUrl: 'https://github.com/acme/web', addedAt: 'x' }, BUILT_IN_USER_ID)
    await assignProjectCredential(local, WEB, (await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp' })).id)
    await addHttpsCredential(BUILT_IN_USER_ID, { name: 'unused', token: 'ghp_unused' })

    await pushCredentialsToRuntime()

    expect(synced).toHaveLength(1)
    const [bundle] = synced
    expect(bundle.claude).toEqual({ kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant' })
    expect(bundle.codex).toMatchObject({ kind: 'oauth', codexOauth: codexBundle() })
    expect(bundle.opencode).toMatchObject({ provider: 'openrouter', apiKey: 'sk-or' })
    // Signed out is sent as null; the runtime replaces its whole set, so it
    // must learn about absences too.
    expect(bundle.pi).toBeNull()
    expect(bundle.git).toEqual([{ token: 'ghp', projects: [WEB] }])
    expect(bundle.ssh).toEqual([])
  })

  it('coalesces overlapping pushes so the runtime ends on the store’s latest state', async () => {
    // One push runs at a time. Requests made meanwhile collapse into one
    // follow-up push, which reads the store after their writes.
    const gate: Array<() => void> = []
    installFakeWorkspaceDriver({
      syncCredentials: (bundles) => new Promise<void>((resolve) => {
        synced.push(bundles[OWNER])
        gate.push(resolve)
      }),
    })
    await saveClaudeCredentialsFile({ kind: 'api-key', savedAt: 'x', apiKey: 'first' })
    const first = pushCredentialsToRuntime()
    await vi.waitFor(() => expect(gate).toHaveLength(1))
    await saveClaudeCredentialsFile({ kind: 'api-key', savedAt: 'x', apiKey: 'second' })
    const second = pushCredentialsToRuntime()
    const third = pushCredentialsToRuntime()
    gate[0]()
    await vi.waitFor(() => expect(gate).toHaveLength(2))
    gate[1]()
    await Promise.all([first, second, third])
    expect(synced.map((b) => (b.claude as { apiKey: string }).apiKey)).toEqual(['first', 'second'])
  })

  it('never rejects on a runtime that refuses, but reports the failure to a caller that asks', async () => {
    // The store write already succeeded, but a delete or replace needs to
    // know the runtime still holds the old secret.
    installFakeWorkspaceDriver({ syncCredentials: () => Promise.reject(new Error('no cluster')) })
    await expect(pushCredentialsToRuntime()).resolves.toMatchObject({ message: 'no cluster' })
    installFakeWorkspaceDriver({ syncCredentials: () => Promise.resolve() })
    await expect(pushCredentialsToRuntime()).resolves.toBeUndefined()
  })
})

describe('adoptRefreshedToolCredentials', () => {
  it('takes a newer bundle into the store and pushes it back out', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    await saveCodexOAuthBundle(codexBundle())
    const rotatedClaude = claudeBundle({ accessToken: 'claude-rotated', expiresAt: BASE_EXPIRY + 1 })
    const rotatedCodex = codexBundle({ accessToken: 'codex-rotated', lastRefresh: '2026-07-10T00:00:00.000Z' })

    await adoptRefreshedToolCredentials({ [OWNER]: { claude: rotatedClaude, codex: rotatedCodex } })

    expect(await loadClaudeCredentialsFile()).toMatchObject({ kind: 'oauth', claudeAiOauth: rotatedClaude })
    expect(await loadCodexCredentialsFile()).toMatchObject({ kind: 'oauth', codexOauth: rotatedCodex })
    // Pushed back so the runtime stops preferring its own captured copy.
    expect(synced).toHaveLength(1)
    expect(synced[0].claude).toMatchObject({ claudeAiOauth: rotatedClaude })
  })

  it('refuses an older bundle, the same one, a sentinel, and an api-key or signed-out store', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    await adoptRefreshedToolCredentials({ [OWNER]: {
      claude: claudeBundle({ accessToken: 'older', expiresAt: BASE_EXPIRY - 1 }),
    } })
    await adoptRefreshedToolCredentials({ [OWNER]: { claude: claudeBundle() } })
    await adoptRefreshedToolCredentials({ [OWNER]: {
      claude: claudeBundle({
        accessToken: PLACEHOLDER_ACCESS_TOKEN, refreshToken: PLACEHOLDER_REFRESH_TOKEN, expiresAt: BASE_EXPIRY + 5,
      }),
    } })
    expect((await loadClaudeCredentialsFile())).toMatchObject({ claudeAiOauth: claudeBundle() })

    // An api-key store has no bundle to rotate, and a signed-out store must
    // not be signed back in by a stale capture.
    await saveClaudeCredentialsFile({ kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant' })
    await adoptRefreshedToolCredentials({ [OWNER]: { claude: claudeBundle({ accessToken: 'new', expiresAt: BASE_EXPIRY + 9 }) } })
    expect(await loadClaudeCredentialsFile()).toMatchObject({ kind: 'api-key' })
    await adoptRefreshedToolCredentials({ [OWNER]: { codex: codexBundle() } })
    expect(await loadCodexCredentialsFile()).toBeNull()

    expect(synced).toEqual([])
  })

  it('takes only the install owner\'s captures, and those of a proxy older than owner keys', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    await adoptRefreshedToolCredentials({
      someone: { claude: claudeBundle({ accessToken: 'theirs', expiresAt: BASE_EXPIRY + 1 }) },
    })
    expect(await loadClaudeCredentialsFile()).toMatchObject({ claudeAiOauth: claudeBundle() })

    const legacy = claudeBundle({ accessToken: 'legacy', expiresAt: BASE_EXPIRY + 2 })
    await adoptRefreshedToolCredentials({ '': { claude: legacy } })
    expect(await loadClaudeCredentialsFile()).toMatchObject({ claudeAiOauth: legacy })
  })
})

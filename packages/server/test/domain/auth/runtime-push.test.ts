import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('#log', () => ({ serverLog: vi.fn() }))

import { adoptRefreshedToolCredentials, pushCredentialsToRuntime } from '#domain/auth'
import { addHttpsCredential, assignProjectCredential } from '#domain/projects'
import { closeDb, openDb, recordProject } from '#db'
import { installFakeWorktreeDriver, resetWorktreeDriver } from '@yaac/test-utils/fake-driver'
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

/**
 * The host store's link with the runtime, run for real against a temp data
 * dir: the credential files and the git credential rows are the actual store, and the
 * only stand-in is the driver, which is the thing being handed the bundle.
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

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-runtime-push-'))
  setDataDir(dataDir)
  await openDb()
  synced = []
  installFakeWorktreeDriver({
    syncCredentials: (bundle) => { synced.push(bundle); return Promise.resolve() },
  })
})

afterEach(async () => {
  resetWorktreeDriver()
  await closeDb()
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe('pushCredentialsToRuntime', () => {
  it('composes the bundle from all three stores and hands it over whole', async () => {
    await saveClaudeCredentialsFile({ kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant' })
    await saveCodexOAuthBundle(codexBundle())
    await saveOpencodeCredentialsFile({ kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'sk-or' })
    // Only a credential a project uses is handed over, with the projects
    // that may use it (runtimeGitCredentials' own tests cover the ssh half).
    await recordProject({ slug: 'web', remoteUrl: 'https://github.com/acme/web', addedAt: 'x' })
    await assignProjectCredential('web', (await addHttpsCredential({ name: 'gh', token: 'ghp' })).id)
    await addHttpsCredential({ name: 'unused', token: 'ghp_unused' })

    await pushCredentialsToRuntime()

    expect(synced).toHaveLength(1)
    const [bundle] = synced
    expect(bundle.claude).toEqual({ kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant' })
    expect(bundle.codex).toMatchObject({ kind: 'oauth', codexOauth: codexBundle() })
    expect(bundle.opencode).toMatchObject({ provider: 'openrouter', apiKey: 'sk-or' })
    // Signed out is carried as such: a runtime replacing its set whole must
    // learn an absence too.
    expect(bundle.pi).toBeNull()
    expect(bundle.git).toEqual([{ token: 'ghp', projects: ['web'] }])
    expect(bundle.ssh).toEqual([])
  })

  it('coalesces overlapping pushes so the runtime ends on the store’s latest state', async () => {
    // Two writers whose pushes overlap must not land out of order. One push
    // runs at a time, and one more follows for whoever asked meanwhile —
    // reading the store after the write that asked.
    const gate: Array<() => void> = []
    installFakeWorktreeDriver({
      syncCredentials: (bundle) => new Promise<void>((resolve) => {
        synced.push(bundle)
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
    // The write it followed already succeeded; a delete or replace still
    // needs to know the runtime holds the old secret.
    installFakeWorktreeDriver({ syncCredentials: () => Promise.reject(new Error('no cluster')) })
    await expect(pushCredentialsToRuntime()).resolves.toMatchObject({ message: 'no cluster' })
    installFakeWorktreeDriver({ syncCredentials: () => Promise.resolve() })
    await expect(pushCredentialsToRuntime()).resolves.toBeUndefined()
  })
})

describe('adoptRefreshedToolCredentials', () => {
  it('takes a newer bundle into the store and pushes it back out', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    await saveCodexOAuthBundle(codexBundle())
    const rotatedClaude = claudeBundle({ accessToken: 'claude-rotated', expiresAt: BASE_EXPIRY + 1 })
    const rotatedCodex = codexBundle({ accessToken: 'codex-rotated', lastRefresh: '2026-07-10T00:00:00.000Z' })

    await adoptRefreshedToolCredentials({ claude: rotatedClaude, codex: rotatedCodex })

    expect(await loadClaudeCredentialsFile()).toMatchObject({ kind: 'oauth', claudeAiOauth: rotatedClaude })
    expect(await loadCodexCredentialsFile()).toMatchObject({ kind: 'oauth', codexOauth: rotatedCodex })
    // Echoed back, so the runtime stops preferring its own capture.
    expect(synced).toHaveLength(1)
    expect(synced[0].claude).toMatchObject({ claudeAiOauth: rotatedClaude })
  })

  it('refuses an older bundle, the same one, a sentinel, and an api-key or signed-out store', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    await adoptRefreshedToolCredentials({
      claude: claudeBundle({ accessToken: 'older', expiresAt: BASE_EXPIRY - 1 }),
    })
    await adoptRefreshedToolCredentials({ claude: claudeBundle() })
    await adoptRefreshedToolCredentials({
      claude: claudeBundle({
        accessToken: PLACEHOLDER_ACCESS_TOKEN, refreshToken: PLACEHOLDER_REFRESH_TOKEN, expiresAt: BASE_EXPIRY + 5,
      }),
    })
    expect((await loadClaudeCredentialsFile())).toMatchObject({ claudeAiOauth: claudeBundle() })

    // An api-key store has no bundle a rotation could supersede, and a
    // signed-out one must not be signed back in by a stale capture.
    await saveClaudeCredentialsFile({ kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant' })
    await adoptRefreshedToolCredentials({ claude: claudeBundle({ accessToken: 'new', expiresAt: BASE_EXPIRY + 9 }) })
    expect(await loadClaudeCredentialsFile()).toMatchObject({ kind: 'api-key' })
    await adoptRefreshedToolCredentials({ codex: codexBundle() })
    expect(await loadCodexCredentialsFile()).toBeNull()

    // Nothing was adopted, so nothing was pushed.
    expect(synced).toEqual([])
  })
})

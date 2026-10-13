import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'


import { addHttpsCredential, adoptRefreshedToolCredentials, generateSshCredential, pushCredentialsToRuntime } from '#domain/auth'
import { assignProjectCredential } from '#domain/projects'
import { BUILT_IN_USER_ID, closeDb, getToolCredential, openDb, recordProject, seeTailnetUser, setToolCredential } from '#db'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { setDataDir } from '@yaac/shared/project-paths'
import { PLACEHOLDER_ACCESS_TOKEN, PLACEHOLDER_REFRESH_TOKEN } from '@yaac/shared/tool-auth'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '@yaac/shared/types'
import type { CredentialBundle } from '#drivers/contract'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const WEB = '2567a5ec-9705-4b7a-82c9-84033e06189d'

/**
 * Pushing every user's credentials to the runtime. The tool and git
 * credential rows are real, in a temp data dir; only the driver that
 * receives the bundles is faked.
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
/** The built-in user, and the owner key its credentials are pushed under. */
const ME = BUILT_IN_USER_ID
const OWNER = 'install'

const saveClaude = (b: ClaudeOAuthBundle, owner = ME) =>
  setToolCredential(owner, 'claude', { kind: 'oauth', savedAt: 'x', claudeAiOauth: b })
const storedClaude = (owner = ME) => getToolCredential(owner, 'claude')

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
  it('composes each user\'s bundle from their stores and hands every one over whole, under its own key', async () => {
    await setToolCredential(ME, 'claude', { kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant' })
    await setToolCredential(ME, 'codex', { kind: 'oauth', savedAt: 'x', codexOauth: codexBundle() })
    await setToolCredential(ME, 'opencode', { kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'sk-or' })
    // Only credentials a project uses are sent, each with its projects.
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

    // A second user gets a bundle of their own: their sign-in and the git
    // credential of their project, and nothing of the first user's.
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    const BOBS = '2567a5ec-9705-4b7a-82c9-84033e0618b0'
    await setToolCredential(bob, 'pi', { kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'sk-bob' })
    await recordProject({ id: BOBS, name: 'b', remoteUrl: 'https://github.com/bob/b', addedAt: 'x' }, bob)
    const bobs = { kind: 'tailnet', userId: bob, login: 'bob@example.com', name: 'Bob' } as const
    await assignProjectCredential(bobs, BOBS, (await addHttpsCredential(bob, { name: 'gh', token: 'ghp_bob' })).id)
    let all: Record<string, CredentialBundle> = {}
    installFakeWorkspaceDriver({ syncCredentials: (bundles) => { all = bundles; return Promise.resolve() } })

    await pushCredentialsToRuntime()

    expect(Object.keys(all).sort()).toEqual([bob, OWNER].sort())
    expect(all[bob]).toMatchObject({ claude: null, pi: { apiKey: 'sk-bob' }, git: [{ token: 'ghp_bob', projects: [BOBS] }] })
    expect(all[OWNER].git).toEqual([{ token: 'ghp', projects: [WEB] }])
  })

  it('hands an ssh key over in the form ssh-add reads, with each project\'s host and trusted host key', async () => {
    const SVC = '961e38b5-146c-4b07-8078-f53dec9b699a'
    const HOST_KEY = 'git.example.com ssh-ed25519 AAAAHOST'
    const key = await generateSshCredential(ME, { name: 'deploy' })
    await recordProject(
      { id: SVC, name: 'svc', remoteUrl: 'git@git.example.com:acme/svc.git', addedAt: 'x' }, ME,
      { id: key.id, knownHostsEntry: HOST_KEY },
    )

    await pushCredentialsToRuntime()

    expect(synced[0].ssh).toEqual([{
      privateKey: expect.stringContaining('BEGIN OPENSSH PRIVATE KEY') as string,
      publicKey: key.publicKey,
      projects: [{ projectId: SVC, host: 'git.example.com', knownHostsEntry: HOST_KEY }],
    }])
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
    await setToolCredential(ME, 'claude', { kind: 'api-key', savedAt: 'x', apiKey: 'first' })
    const first = pushCredentialsToRuntime()
    await vi.waitFor(() => expect(gate).toHaveLength(1))
    await setToolCredential(ME, 'claude', { kind: 'api-key', savedAt: 'x', apiKey: 'second' })
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
    await saveClaude(claudeBundle())
    await setToolCredential(ME, 'codex', { kind: 'oauth', savedAt: 'x', codexOauth: codexBundle() })
    const rotatedClaude = claudeBundle({ accessToken: 'claude-rotated', expiresAt: BASE_EXPIRY + 1 })
    const rotatedCodex = codexBundle({ accessToken: 'codex-rotated', lastRefresh: '2026-07-10T00:00:00.000Z' })

    await adoptRefreshedToolCredentials({ [OWNER]: { claude: rotatedClaude, codex: rotatedCodex } })

    expect(await storedClaude()).toMatchObject({ kind: 'oauth', claudeAiOauth: rotatedClaude })
    expect(await getToolCredential(ME, 'codex')).toMatchObject({ kind: 'oauth', codexOauth: rotatedCodex })
    // Pushed back so the runtime stops preferring its own captured copy.
    expect(synced).toHaveLength(1)
    expect(synced[0].claude).toMatchObject({ claudeAiOauth: rotatedClaude })
  })

  it('refuses an older bundle, the same one, a sentinel, and an api-key or signed-out store', async () => {
    await saveClaude(claudeBundle())
    await adoptRefreshedToolCredentials({ [OWNER]: {
      claude: claudeBundle({ accessToken: 'older', expiresAt: BASE_EXPIRY - 1 }),
    } })
    await adoptRefreshedToolCredentials({ [OWNER]: { claude: claudeBundle() } })
    await adoptRefreshedToolCredentials({ [OWNER]: {
      claude: claudeBundle({
        accessToken: PLACEHOLDER_ACCESS_TOKEN, refreshToken: PLACEHOLDER_REFRESH_TOKEN, expiresAt: BASE_EXPIRY + 5,
      }),
    } })
    expect(await storedClaude()).toMatchObject({ claudeAiOauth: claudeBundle() })

    // An api-key store has no bundle to rotate, and a signed-out store must
    // not be signed back in by a stale capture.
    await setToolCredential(ME, 'claude', { kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant' })
    await adoptRefreshedToolCredentials({ [OWNER]: { claude: claudeBundle({ accessToken: 'new', expiresAt: BASE_EXPIRY + 9 }) } })
    expect(await storedClaude()).toMatchObject({ kind: 'api-key' })
    await adoptRefreshedToolCredentials({ [OWNER]: { codex: codexBundle() } })
    expect(await getToolCredential(ME, 'codex')).toBeNull()

    expect(synced).toEqual([])
  })

  it('takes each owner key\'s captures into that user\'s store', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    await saveClaude(claudeBundle())
    await saveClaude(claudeBundle({ accessToken: 'bob' }), bob)
    const bobs = claudeBundle({ accessToken: 'bob-rotated', expiresAt: BASE_EXPIRY + 1 })
    await adoptRefreshedToolCredentials({
      [bob]: { claude: bobs },
      // A key naming no user with a stored bundle adopts nothing.
      '2567a5ec-9705-4b7a-82c9-000000000000': { claude: claudeBundle({ accessToken: 'nobody', expiresAt: BASE_EXPIRY + 3 }) },
    })
    expect(await storedClaude(bob)).toMatchObject({ claudeAiOauth: bobs })
    expect(await storedClaude()).toMatchObject({ claudeAiOauth: claudeBundle() })

    const mine = claudeBundle({ accessToken: 'mine', expiresAt: BASE_EXPIRY + 2 })
    await adoptRefreshedToolCredentials({ install: { claude: mine } })
    expect(await storedClaude()).toMatchObject({ claudeAiOauth: mine })
  })
})

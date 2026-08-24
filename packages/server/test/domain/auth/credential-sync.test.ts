import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// serverLog writes files — silence it.
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  fanOutToolCredentials,
  harvestToolCredentials,
  runtimeMediatesEgress,
  seedProjectToolHome,
  syncToolCredentialsThrottled,
} from '#domain/auth'
import { _resetCredentialSyncThrottleForTests } from '#domain/auth/credential-sync'
import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { setDataDir } from '@yaac/shared/project-paths'
import {
  PLACEHOLDER_ACCESS_TOKEN,
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  readProjectClaudeBundle,
  readProjectCodexBundle,
  saveClaudeCredentialsFile,
  saveClaudeOAuthBundle,
  saveCodexOAuthBundle,
  writeProjectClaudeCredentials,
  writeProjectClaudePlaceholder,
  writeProjectCodexAuth,
  writeProjectCodexPlaceholder,
} from '@yaac/shared/tool-auth'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '@yaac/shared/types'

/**
 * These tests run the feature for real against a temp data dir: the host
 * store and every project tool home are the actual files, written and read
 * by the same `@yaac/shared/tool-auth` calls production uses. The only
 * stand-in is the runtime, because the ONE thing convergence turns on is
 * whether it mediates egress.
 *
 * The macOS Keychain half is not stubbed. Off darwin the scoped read and
 * delete are no-ops by contract, so the file is the whole story here; on
 * darwin they address a per-project service that these fixtures never
 * create, so the reads miss and fall through to the same file. Either way
 * the case under test is the one being asserted.
 */

const HOUR = 60 * 60 * 1000
const BASE_EXPIRY = 4102444800000 // 2100-01-01, unambiguously unexpired

function claudeBundle(overrides: Partial<ClaudeOAuthBundle> = {}): ClaudeOAuthBundle {
  return {
    accessToken: 'claude-access-host',
    refreshToken: 'claude-refresh-host',
    expiresAt: BASE_EXPIRY,
    scopes: ['user:inference'],
    subscriptionType: 'max',
    ...overrides,
  }
}

function codexBundle(overrides: Partial<CodexOAuthBundle> = {}): CodexOAuthBundle {
  return {
    accessToken: 'codex-access-host',
    refreshToken: 'codex-refresh-host',
    idTokenRawJwt: 'header.payload.sig',
    expiresAt: BASE_EXPIRY,
    lastRefresh: '2026-07-09T00:00:00.000Z',
    accountId: 'acct-1',
    ...overrides,
  }
}

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-credsync-'))
  setDataDir(dataDir)
  _resetCredentialSyncThrottleForTests()
  installFakeWorktreeDriver({ kind: 'containerless' })
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

/** Put a project on disk by giving it a claude tool home. */
async function seedProject(slug: string, bundle: ClaudeOAuthBundle): Promise<void> {
  await writeProjectClaudeCredentials(slug, bundle)
}

describe('runtimeMediatesEgress', () => {
  it('is false only for the containerless runtime, and true with none registered', () => {
    const fake = installFakeWorktreeDriver({ kind: 'containerless' })
    expect(runtimeMediatesEgress()).toBe(false)

    fake.override({ kind: 'k8s' })
    expect(runtimeMediatesEgress()).toBe(true)
  })
})

describe('harvestToolCredentials', () => {
  it('adopts a worktree-refreshed bundle for both tools, and leaves the store alone when nothing is newer', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    await saveCodexOAuthBundle(codexBundle())

    // What an agent refreshing in its worktree leaves behind: a rotated pair
    // with a later expiry (claude) / a later stamp (codex).
    await writeProjectClaudeCredentials('alpha', claudeBundle({
      accessToken: 'claude-access-fresh',
      refreshToken: 'claude-refresh-fresh',
      expiresAt: BASE_EXPIRY + HOUR,
    }))
    await writeProjectCodexAuth('alpha', codexBundle({
      accessToken: 'codex-access-fresh',
      refreshToken: 'codex-refresh-fresh',
      lastRefresh: '2026-07-10T00:00:00.000Z',
    }))

    await harvestToolCredentials()

    const claude = await loadClaudeCredentialsFile()
    expect(claude).toMatchObject({
      kind: 'oauth',
      claudeAiOauth: { accessToken: 'claude-access-fresh', refreshToken: 'claude-refresh-fresh' },
    })
    const codex = await loadCodexCredentialsFile()
    expect(codex).toMatchObject({
      kind: 'oauth',
      codexOauth: { accessToken: 'codex-access-fresh', refreshToken: 'codex-refresh-fresh' },
    })

    // Re-harvesting is idempotent: the store now holds what the project does.
    await harvestToolCredentials()
    expect((await loadClaudeCredentialsFile())).toMatchObject({
      claudeAiOauth: { accessToken: 'claude-access-fresh' },
    })
  })

  it('refuses sentinels, older bundles, and a project whose file is unreadable', async () => {
    await saveClaudeOAuthBundle(claudeBundle())

    // A sentinel — a mediated project, a data dir flipped from k8s, or a
    // chained yaac-in-yaac install. Adopting one would break every worktree.
    await writeProjectClaudePlaceholder('sentinel-project', claudeBundle({ expiresAt: BASE_EXPIRY + HOUR }))
    // Older than the host's: a project that has not caught up.
    await writeProjectClaudeCredentials('stale-project', claudeBundle({
      accessToken: 'claude-access-old',
      expiresAt: BASE_EXPIRY - HOUR,
    }))
    // Present but garbage — must be skipped, not fail the sweep.
    await writeProjectClaudeCredentials('broken-project', claudeBundle())
    await fs.writeFile(path.join(dataDir, 'projects', 'broken-project', 'claude', '.credentials.json'), '{ not json')

    await harvestToolCredentials()

    expect(await loadClaudeCredentialsFile()).toMatchObject({
      claudeAiOauth: { accessToken: 'claude-access-host' },
    })
  })

  it('does not sign a signed-out or api-key install back in from a leftover project file', async () => {
    await writeProjectClaudeCredentials('alpha', claudeBundle({ accessToken: 'claude-access-leftover' }))

    // Signed out entirely: no host store at all.
    await harvestToolCredentials()
    expect(await loadClaudeCredentialsFile()).toBeNull()

    // Signed in with an api key, which has no refresh to harvest.
    await saveClaudeCredentialsFile({ kind: 'api-key', savedAt: '2026-07-09T00:00:00.000Z', apiKey: 'sk-ant-key' })
    await harvestToolCredentials()
    expect(await loadClaudeCredentialsFile()).toMatchObject({ kind: 'api-key', apiKey: 'sk-ant-key' })
  })

  it('sweeps one project when given a slug, and every project otherwise', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    await seedProject('alpha', claudeBundle({ accessToken: 'a-fresh', expiresAt: BASE_EXPIRY + HOUR }))
    await seedProject('beta', claudeBundle({ accessToken: 'b-fresher', expiresAt: BASE_EXPIRY + 2 * HOUR }))

    await harvestToolCredentials({ slug: 'alpha' })
    expect(await loadClaudeCredentialsFile()).toMatchObject({ claudeAiOauth: { accessToken: 'a-fresh' } })

    // The full sweep takes the newest anywhere, not merely the first it sees.
    await harvestToolCredentials()
    expect(await loadClaudeCredentialsFile()).toMatchObject({ claudeAiOauth: { accessToken: 'b-fresher' } })
  })

  it('sweeps only the tool it is given, so a usage cycle does not read every project twice', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    await saveCodexOAuthBundle(codexBundle())
    await writeProjectClaudeCredentials('alpha', claudeBundle({
      accessToken: 'claude-fresh', expiresAt: BASE_EXPIRY + HOUR,
    }))
    await writeProjectCodexAuth('alpha', codexBundle({
      accessToken: 'codex-fresh', lastRefresh: '2026-07-10T00:00:00.000Z',
    }))

    await harvestToolCredentials({ tool: 'claude' })
    expect(await loadClaudeCredentialsFile()).toMatchObject({ claudeAiOauth: { accessToken: 'claude-fresh' } })
    expect(await loadCodexCredentialsFile()).toMatchObject({ codexOauth: { accessToken: 'codex-access-host' } })

    await harvestToolCredentials({ tool: 'codex' })
    expect(await loadCodexCredentialsFile()).toMatchObject({ codexOauth: { accessToken: 'codex-fresh' } })
  })

  it('refuses a Codex file carrying no refresh stamp, however new its synthesized one looks', async () => {
    // The stamp is the clock, so a file without one must rank oldest rather
    // than take the extractor's "now" and outrank the live credential on
    // every read. Neither codex nor yaac writes this shape — it is the guard
    // that makes the comparator safe rather than merely unreached.
    await saveCodexOAuthBundle(codexBundle())
    const stampless = {
      OPENAI_API_KEY: null,
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'header.payload.sig',
        access_token: 'codex-access-stampless',
        refresh_token: 'codex-refresh-stampless',
        account_id: 'acct-1',
      },
    }
    await writeProjectCodexAuth('alpha', codexBundle())
    await fs.writeFile(
      path.join(dataDir, 'projects', 'alpha', 'codex', 'auth.json'),
      JSON.stringify(stampless, null, 2),
    )

    await harvestToolCredentials({ tool: 'codex' })

    expect(await loadCodexCredentialsFile()).toMatchObject({
      codexOauth: { accessToken: 'codex-access-host' },
    })
  })
})

describe('seedProjectToolHome', () => {
  it('writes sentinels unconditionally where egress is mediated', async () => {
    installFakeWorktreeDriver({ kind: 'k8s' })
    await saveClaudeOAuthBundle(claudeBundle())
    await saveCodexOAuthBundle(codexBundle())
    // Even over a real bundle a previous containerless run left behind.
    await writeProjectClaudeCredentials('alpha', claudeBundle({
      accessToken: 'claude-access-real',
      expiresAt: BASE_EXPIRY + HOUR,
    }))

    await seedProjectToolHome('alpha', { mediatedEgress: true })

    const claude = await readProjectClaudeBundle('alpha')
    expect(claude?.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
    const codex = await readProjectCodexBundle('alpha')
    expect(codex?.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
  })

  it('never overwrites a credential a running worktree refreshed, and harvests it instead', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    await saveCodexOAuthBundle(codexBundle())
    const refreshedClaude = claudeBundle({
      accessToken: 'claude-access-fresh',
      refreshToken: 'claude-refresh-fresh',
      expiresAt: BASE_EXPIRY + HOUR,
    })
    await writeProjectClaudeCredentials('alpha', refreshedClaude)
    await writeProjectCodexAuth('alpha', codexBundle({
      accessToken: 'codex-access-fresh',
      lastRefresh: '2026-07-10T00:00:00.000Z',
    }))

    // This is the create path: it used to stamp the stale host copy over the
    // live credential and spend the worktree's rotation.
    await seedProjectToolHome('alpha', { mediatedEgress: false })

    expect(await readProjectClaudeBundle('alpha')).toMatchObject({ accessToken: 'claude-access-fresh' })
    expect(await readProjectCodexBundle('alpha')).toMatchObject({ accessToken: 'codex-access-fresh' })
    // …and the host store caught up rather than being left behind.
    expect(await loadClaudeCredentialsFile()).toMatchObject({
      claudeAiOauth: { accessToken: 'claude-access-fresh' },
    })
    expect(await loadCodexCredentialsFile()).toMatchObject({
      codexOauth: { accessToken: 'codex-access-fresh' },
    })
  })

  it('seeds a project that has nothing, and one holding only a sentinel', async () => {
    await saveClaudeOAuthBundle(claudeBundle())

    await seedProjectToolHome('fresh-project', { mediatedEgress: false })
    expect(await readProjectClaudeBundle('fresh-project')).toMatchObject({
      accessToken: 'claude-access-host',
      refreshToken: 'claude-refresh-host',
    })

    // A data dir flipped k8s → containerless: the sentinel must give way to
    // the real bundle, or the agent authenticates with `yaac-ph-access`.
    await writeProjectClaudePlaceholder('flipped', claudeBundle())
    await seedProjectToolHome('flipped', { mediatedEgress: false })
    expect(await readProjectClaudeBundle('flipped')).toMatchObject({ accessToken: 'claude-access-host' })
  })

  it('keeps a chained install seeded with the sentinel its outer proxy swaps', async () => {
    // yaac-in-yaac: the inner install's "real" credential IS the outer
    // proxy's sentinel, and a worktree still needs it on disk to send.
    await saveClaudeOAuthBundle(claudeBundle({
      accessToken: PLACEHOLDER_ACCESS_TOKEN,
      refreshToken: 'yaac-ph-refresh',
    }))

    await seedProjectToolHome('chained', { mediatedEgress: false })

    expect(await readProjectClaudeBundle('chained')).toMatchObject({
      accessToken: PLACEHOLDER_ACCESS_TOKEN,
    })
  })
})

describe('syncToolCredentialsThrottled', () => {
  it('heals a project left behind by another project rotating the shared credential', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    // `winner` refreshed; `loser` still holds the superseded pair, whose next
    // refresh would fail because the token has already been rotated.
    await seedProject('winner', claudeBundle({
      accessToken: 'claude-access-fresh',
      refreshToken: 'claude-refresh-fresh',
      expiresAt: BASE_EXPIRY + HOUR,
    }))
    await seedProject('loser', claudeBundle())

    await syncToolCredentialsThrottled()

    expect(await loadClaudeCredentialsFile()).toMatchObject({
      claudeAiOauth: { accessToken: 'claude-access-fresh' },
    })
    expect(await readProjectClaudeBundle('loser')).toMatchObject({
      accessToken: 'claude-access-fresh',
      refreshToken: 'claude-refresh-fresh',
    })
    // The winner is untouched — it already had it.
    expect(await readProjectClaudeBundle('winner')).toMatchObject({ accessToken: 'claude-access-fresh' })
  })

  it('leaves every project home alone where egress is mediated', async () => {
    installFakeWorktreeDriver({ kind: 'k8s' })
    await saveClaudeOAuthBundle(claudeBundle())
    await writeProjectClaudePlaceholder('alpha', claudeBundle())

    await syncToolCredentialsThrottled()

    // Still the sentinel: pushing the real bundle into a pod-mounted file is
    // exactly what the mediated path exists to avoid.
    expect(await readProjectClaudeBundle('alpha')).toMatchObject({
      accessToken: PLACEHOLDER_ACCESS_TOKEN,
    })
  })

  it('runs once, then holds off until the floor elapses', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    await seedProject('alpha', claudeBundle({ accessToken: 'fresh-1', expiresAt: BASE_EXPIRY + HOUR }))

    await syncToolCredentialsThrottled()
    expect(await loadClaudeCredentialsFile()).toMatchObject({ claudeAiOauth: { accessToken: 'fresh-1' } })

    // A second refresh lands, but the floor has not elapsed — the sweep is
    // skipped, which is what keeps a 60s resync off `security` on macOS.
    await seedProject('alpha', claudeBundle({ accessToken: 'fresh-2', expiresAt: BASE_EXPIRY + 2 * HOUR }))
    await syncToolCredentialsThrottled()
    expect(await loadClaudeCredentialsFile()).toMatchObject({ claudeAiOauth: { accessToken: 'fresh-1' } })

    // Past the floor, the sweep runs again and picks the newer one up.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000)
    try {
      await syncToolCredentialsThrottled()
      expect(await loadClaudeCredentialsFile()).toMatchObject({ claudeAiOauth: { accessToken: 'fresh-2' } })
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('fanOutToolCredentials', () => {
  it('pushes the real bundle to every project, overriding a newer one, where egress is unmediated', async () => {
    await saveClaudeOAuthBundle(claudeBundle({ accessToken: 'claude-access-new-account' }))
    // A different account's credential, freshly signed in — newest-wins must
    // not veto the user explicitly switching accounts.
    await seedProject('alpha', claudeBundle({
      accessToken: 'claude-access-old-account',
      expiresAt: BASE_EXPIRY + 10 * HOUR,
    }))
    await seedProject('beta', claudeBundle({ accessToken: 'claude-access-old-account' }))

    await fanOutToolCredentials('claude', { mediatedEgress: false })

    for (const slug of ['alpha', 'beta']) {
      expect(await readProjectClaudeBundle(slug)).toMatchObject({
        accessToken: 'claude-access-new-account',
      })
    }
  })

  it('writes sentinels where egress is mediated, and does nothing for tools with no bundle on disk', async () => {
    installFakeWorktreeDriver({ kind: 'k8s' })
    await saveClaudeOAuthBundle(claudeBundle())
    await saveCodexOAuthBundle(codexBundle())
    await seedProject('alpha', claudeBundle())

    await fanOutToolCredentials('claude', { mediatedEgress: true })
    expect(await readProjectClaudeBundle('alpha')).toMatchObject({ accessToken: PLACEHOLDER_ACCESS_TOKEN })

    // opencode/pi authenticate by env var, so they have no project file at
    // all and the fan-out must not invent one.
    await fanOutToolCredentials('opencode', { mediatedEgress: true })
    await fanOutToolCredentials('pi', { mediatedEgress: false })
    expect(await readProjectCodexBundle('alpha')).toBeNull()
  })

  it('fans a Codex login out to every project independently of Claude', async () => {
    await saveCodexOAuthBundle(codexBundle({ accessToken: 'codex-access-new' }))
    await writeProjectCodexPlaceholder('alpha', codexBundle())

    await fanOutToolCredentials('codex', { mediatedEgress: false })

    expect(await readProjectCodexBundle('alpha')).toMatchObject({
      accessToken: 'codex-access-new',
      accountId: 'acct-1',
    })
  })
})

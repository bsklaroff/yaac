import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  fanOutToolCredentials,
  harvestToolCredentials,
  runtimeMediatesEgress,
  seedProjectToolHome,
  syncToolCredentials,
} from '#domain/auth'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
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
 * Runs against a temp data dir: the host store and project tool homes are
 * real files, read and written through `@yaac/shared/tool-auth`. Only the
 * runtime is faked, since convergence depends only on whether it mediates
 * egress.
 *
 * The macOS Keychain is not stubbed. Off darwin its scoped read and delete
 * are no-ops; on darwin they target a per-project service these fixtures
 * never create, so reads fall through to the same file.
 */

const HOUR = 60 * 60 * 1000
const BASE_EXPIRY = 4102444800000 // 2100-01-01

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
  installFakeWorkspaceDriver({ kind: 'containerless' })
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

/** Put a project on disk by giving it a claude tool home. */
async function seedProject(projectId: string, bundle: ClaudeOAuthBundle): Promise<void> {
  await writeProjectClaudeCredentials(projectId, bundle)
}

describe('runtimeMediatesEgress', () => {
  it('is false only for the containerless runtime, and true with none registered', () => {
    expect(runtimeMediatesEgress()).toBe(false)

    installFakeWorkspaceDriver({ kind: 'k8s' })
    expect(runtimeMediatesEgress()).toBe(true)
  })
})

describe('harvestToolCredentials', () => {
  it('adopts a workspace-refreshed bundle for both tools, and leaves the store alone when nothing is newer', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    await saveCodexOAuthBundle(codexBundle())

    // An agent that refreshed in its workspace leaves a rotated pair with a
    // later expiry (claude) or timestamp (codex).
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

    // Re-harvesting is idempotent.
    await harvestToolCredentials()
    expect((await loadClaudeCredentialsFile())).toMatchObject({
      claudeAiOauth: { accessToken: 'claude-access-fresh' },
    })
  })

  it('adopts nothing a sandbox wrote where egress is mediated', async () => {
    installFakeWorkspaceDriver({ kind: 'k8s' })
    await saveClaudeOAuthBundle(claudeBundle())
    await saveCodexOAuthBundle(codexBundle())
    // A newer bundle in a pod's tool home can only have been planted, since
    // the proxy is the only refresh writer there.
    await writeProjectClaudeCredentials('alpha', claudeBundle({
      accessToken: 'claude-access-planted', expiresAt: BASE_EXPIRY + HOUR,
    }))
    await writeProjectCodexAuth('alpha', codexBundle({
      accessToken: 'codex-access-planted', lastRefresh: '2026-07-10T00:00:00.000Z',
    }))

    await harvestToolCredentials()
    await syncToolCredentials()

    expect(await loadClaudeCredentialsFile()).toMatchObject({ claudeAiOauth: { accessToken: 'claude-access-host' } })
    expect(await loadCodexCredentialsFile()).toMatchObject({ codexOauth: { accessToken: 'codex-access-host' } })
  })

  it('refuses sentinels, older bundles, and a project whose file is unreadable', async () => {
    await saveClaudeOAuthBundle(claudeBundle())

    // A placeholder (from a mediated project, a data dir switched from k8s,
    // or yaac-in-yaac). Adopting it would break every workspace.
    await writeProjectClaudePlaceholder('sentinel-project', claudeBundle({ expiresAt: BASE_EXPIRY + HOUR }))
    // Older than the host's copy.
    await writeProjectClaudeCredentials('stale-project', claudeBundle({
      accessToken: 'claude-access-old',
      expiresAt: BASE_EXPIRY - HOUR,
    }))
    // Garbage is skipped rather than failing the sweep.
    await writeProjectClaudeCredentials('broken-project', claudeBundle())
    await fs.writeFile(path.join(dataDir, 'global', 'projects', 'broken-project', 'claude', '.credentials.json'), '{ not json')

    await harvestToolCredentials()

    expect(await loadClaudeCredentialsFile()).toMatchObject({
      claudeAiOauth: { accessToken: 'claude-access-host' },
    })
  })

  it('does not sign a signed-out or api-key install back in from a leftover project file', async () => {
    await writeProjectClaudeCredentials('alpha', claudeBundle({ accessToken: 'claude-access-leftover' }))

    // Signed out: no host store.
    await harvestToolCredentials()
    expect(await loadClaudeCredentialsFile()).toBeNull()

    // Signed in with an api key, which has no refresh to harvest.
    await saveClaudeCredentialsFile({ kind: 'api-key', savedAt: '2026-07-09T00:00:00.000Z', apiKey: 'sk-ant-key' })
    await harvestToolCredentials()
    expect(await loadClaudeCredentialsFile()).toMatchObject({ kind: 'api-key', apiKey: 'sk-ant-key' })
  })

  it('sweeps one project when given a projectId, and every project otherwise', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    await seedProject('alpha', claudeBundle({ accessToken: 'a-fresh', expiresAt: BASE_EXPIRY + HOUR }))
    await seedProject('beta', claudeBundle({ accessToken: 'b-fresher', expiresAt: BASE_EXPIRY + 2 * HOUR }))

    await harvestToolCredentials({ projectId: 'alpha' })
    expect(await loadClaudeCredentialsFile()).toMatchObject({ claudeAiOauth: { accessToken: 'a-fresh' } })

    // The sweep takes the newest bundle, not the first it sees.
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
    // A file with no timestamp must rank oldest, not default to "now" and
    // outrank the live credential. Neither codex nor yaac writes this shape;
    // the test guards the comparator.
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
      path.join(dataDir, 'global', 'projects', 'alpha', 'codex', 'auth.json'),
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
    installFakeWorkspaceDriver({ kind: 'k8s' })
    await saveClaudeOAuthBundle(claudeBundle())
    await saveCodexOAuthBundle(codexBundle())
    // Even over a real bundle left by an earlier containerless run.
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

  it('never overwrites a credential a running workspace refreshed, and harvests it instead', async () => {
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

    // On create, a stale host copy must not overwrite the project's newer
    // credential.
    await seedProjectToolHome('alpha', { mediatedEgress: false })

    expect(await readProjectClaudeBundle('alpha')).toMatchObject({ accessToken: 'claude-access-fresh' })
    expect(await readProjectCodexBundle('alpha')).toMatchObject({ accessToken: 'codex-access-fresh' })
    // The host store catches up too.
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

    // A data dir switched from k8s to containerless: the placeholder must be
    // replaced, or the agent authenticates with `yaac-ph-access`.
    await writeProjectClaudePlaceholder('flipped', claudeBundle())
    await seedProjectToolHome('flipped', { mediatedEgress: false })
    expect(await readProjectClaudeBundle('flipped')).toMatchObject({ accessToken: 'claude-access-host' })
  })

  it('keeps a chained install seeded with the sentinel its outer proxy swaps', async () => {
    // In yaac-in-yaac, the inner install's credential is the outer proxy's
    // placeholder, and a workspace still needs it on disk.
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

describe('syncToolCredentials', () => {
  it('heals a project left behind by another project rotating the shared credential', async () => {
    await saveClaudeOAuthBundle(claudeBundle())
    // `winner` refreshed; `loser` holds the old pair, whose next refresh
    // would fail because the token was already rotated.
    await seedProject('winner', claudeBundle({
      accessToken: 'claude-access-fresh',
      refreshToken: 'claude-refresh-fresh',
      expiresAt: BASE_EXPIRY + HOUR,
    }))
    await seedProject('loser', claudeBundle())

    await syncToolCredentials()

    expect(await loadClaudeCredentialsFile()).toMatchObject({
      claudeAiOauth: { accessToken: 'claude-access-fresh' },
    })
    expect(await readProjectClaudeBundle('loser')).toMatchObject({
      accessToken: 'claude-access-fresh',
      refreshToken: 'claude-refresh-fresh',
    })
    expect(await readProjectClaudeBundle('winner')).toMatchObject({ accessToken: 'claude-access-fresh' })
  })

  it('leaves every project home alone where egress is mediated', async () => {
    installFakeWorkspaceDriver({ kind: 'k8s' })
    await saveClaudeOAuthBundle(claudeBundle())
    await writeProjectClaudePlaceholder('alpha', claudeBundle())

    await syncToolCredentials()

    // Still the placeholder: mediated egress exists to keep the real bundle
    // out of pod-mounted files.
    expect(await readProjectClaudeBundle('alpha')).toMatchObject({
      accessToken: PLACEHOLDER_ACCESS_TOKEN,
    })
  })
})

describe('fanOutToolCredentials', () => {
  it('pushes the real bundle to every project, overriding a newer one, where egress is unmediated', async () => {
    await saveClaudeOAuthBundle(claudeBundle({ accessToken: 'claude-access-new-account' }))
    // The old account's bundle expires later, but newest-wins must not
    // block the user switching accounts.
    await seedProject('alpha', claudeBundle({
      accessToken: 'claude-access-old-account',
      expiresAt: BASE_EXPIRY + 10 * HOUR,
    }))
    await seedProject('beta', claudeBundle({ accessToken: 'claude-access-old-account' }))

    await fanOutToolCredentials('claude', { mediatedEgress: false })

    for (const projectId of ['alpha', 'beta']) {
      expect(await readProjectClaudeBundle(projectId)).toMatchObject({
        accessToken: 'claude-access-new-account',
      })
    }
  })

  it('writes sentinels where egress is mediated, and does nothing for tools with no bundle on disk', async () => {
    installFakeWorkspaceDriver({ kind: 'k8s' })
    await saveClaudeOAuthBundle(claudeBundle())
    await saveCodexOAuthBundle(codexBundle())
    await seedProject('alpha', claudeBundle())

    await fanOutToolCredentials('claude', { mediatedEgress: true })
    expect(await readProjectClaudeBundle('alpha')).toMatchObject({ accessToken: PLACEHOLDER_ACCESS_TOKEN })

    // opencode and pi authenticate by env var, so no project file is written.
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

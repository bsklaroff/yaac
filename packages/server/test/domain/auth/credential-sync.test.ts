import fs from 'node:fs/promises'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'

import {
  harvestToolCredentials,
  reseedPlaceholderToolHomes,
  runtimeMediatesEgress,
  seedProjectToolHome,
  syncToolCredentials,
} from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, getToolCredential, recordProject, seeTailnetUser, setToolCredential } from '#db'
import { getDb } from '#db/client'
import { projects, toolCredentials } from '#db/schema'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getProjectsDir, projectClaudeCredentialsFile, projectCodexAuthFile } from '@yaac/shared/project-paths'
import {
  PLACEHOLDER_ACCESS_TOKEN,
  readProjectClaudeBundle,
  readProjectCodexBundle,
  writeProjectClaudeCredentials,
  writeProjectClaudePlaceholder,
  writeProjectCodexAuth,
} from '@yaac/shared/tool-auth'
import type { ClaudeCredentialsFile, ClaudeOAuthBundle, CodexOAuthBundle } from '@yaac/shared/types'

/**
 * Runs against a temp data dir: each user's store is the real database and
 * project tool homes are real files. Only the runtime is faked, since
 * convergence depends only on whether it mediates egress. Every project
 * below is the built-in user's unless a test says otherwise.
 *
 * The macOS Keychain is not stubbed. Off darwin its scoped read and delete
 * are no-ops; on darwin they target a per-project service these fixtures
 * never create, so reads fall through to the same file.
 */

const OWNER = BUILT_IN_USER_ID

/** The projects the tests use, by name; each is recorded for `OWNER`. */
const P = Object.fromEntries([
  'alpha', 'beta', 'winner', 'loser', 'sentinel-project', 'stale-project',
  'broken-project', 'fresh-project', 'flipped', 'chained',
].map((name, i) => [name, `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]))

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

beforeAll(async () => {
  dataDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(dataDir)
})

beforeEach(async () => {
  installFakeWorkspaceDriver({ kind: 'containerless' })
  const db = await getDb()
  await db.delete(toolCredentials)
  await db.delete(projects)
  await fs.rm(getProjectsDir(), { recursive: true, force: true })
  for (const [name, id] of Object.entries(P)) {
    await recordProject({ id, name, remoteUrl: `https://github.com/acme/${name}`, addedAt: 'x' }, OWNER)
  }
})

const storeClaude = (bundle: ClaudeOAuthBundle, owner = OWNER): Promise<void> =>
  setToolCredential(owner, 'claude', { kind: 'oauth', savedAt: 'x', claudeAiOauth: bundle })
const storeCodex = (bundle: CodexOAuthBundle): Promise<void> =>
  setToolCredential(OWNER, 'codex', { kind: 'oauth', savedAt: 'x', codexOauth: bundle })
const storedClaude = (owner = OWNER): Promise<ClaudeCredentialsFile | null> => getToolCredential(owner, 'claude')
const storedCodex = () => getToolCredential(OWNER, 'codex')

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
    await storeClaude(claudeBundle())
    await storeCodex(codexBundle())

    // An agent that refreshed in its workspace leaves a rotated pair with a
    // later expiry (claude) or timestamp (codex).
    await writeProjectClaudeCredentials(P.alpha, claudeBundle({
      accessToken: 'claude-access-fresh',
      refreshToken: 'claude-refresh-fresh',
      expiresAt: BASE_EXPIRY + HOUR,
    }))
    await writeProjectCodexAuth(P.alpha, codexBundle({
      accessToken: 'codex-access-fresh',
      refreshToken: 'codex-refresh-fresh',
      lastRefresh: '2026-07-10T00:00:00.000Z',
    }))

    await harvestToolCredentials(OWNER)

    const claude = await storedClaude()
    expect(claude).toMatchObject({
      kind: 'oauth',
      claudeAiOauth: { accessToken: 'claude-access-fresh', refreshToken: 'claude-refresh-fresh' },
    })
    const codex = await storedCodex()
    expect(codex).toMatchObject({
      kind: 'oauth',
      codexOauth: { accessToken: 'codex-access-fresh', refreshToken: 'codex-refresh-fresh' },
    })

    // Re-harvesting is idempotent.
    await harvestToolCredentials(OWNER)
    expect((await storedClaude())).toMatchObject({
      claudeAiOauth: { accessToken: 'claude-access-fresh' },
    })
  })

  it('adopts nothing a sandbox wrote where egress is mediated', async () => {
    installFakeWorkspaceDriver({ kind: 'k8s' })
    await storeClaude(claudeBundle())
    await storeCodex(codexBundle())
    // A newer bundle in a pod's tool home can only have been planted, since
    // the proxy is the only refresh writer there.
    await writeProjectClaudeCredentials(P.alpha, claudeBundle({
      accessToken: 'claude-access-planted', expiresAt: BASE_EXPIRY + HOUR,
    }))
    await writeProjectCodexAuth(P.alpha, codexBundle({
      accessToken: 'codex-access-planted', lastRefresh: '2026-07-10T00:00:00.000Z',
    }))

    await harvestToolCredentials(OWNER)
    await syncToolCredentials()

    expect(await storedClaude()).toMatchObject({ claudeAiOauth: { accessToken: 'claude-access-host' } })
    expect(await storedCodex()).toMatchObject({ codexOauth: { accessToken: 'codex-access-host' } })
  })

  it('refuses sentinels, older bundles, and a project whose file is unreadable', async () => {
    await storeClaude(claudeBundle())

    // A placeholder (from a mediated project, a data dir switched from k8s,
    // or yaac-in-yaac). Adopting it would break every workspace.
    await writeProjectClaudePlaceholder(P['sentinel-project'], claudeBundle({ expiresAt: BASE_EXPIRY + HOUR }))
    // Older than the host's copy.
    await writeProjectClaudeCredentials(P['stale-project'], claudeBundle({
      accessToken: 'claude-access-old',
      expiresAt: BASE_EXPIRY - HOUR,
    }))
    // Garbage is skipped rather than failing the sweep.
    await writeProjectClaudeCredentials(P['broken-project'], claudeBundle())
    await fs.writeFile(projectClaudeCredentialsFile(P['broken-project']), '{ not json')

    await harvestToolCredentials(OWNER)

    expect(await storedClaude()).toMatchObject({
      claudeAiOauth: { accessToken: 'claude-access-host' },
    })
  })

  it('does not sign a signed-out or api-key install back in from a leftover project file', async () => {
    await writeProjectClaudeCredentials(P.alpha, claudeBundle({ accessToken: 'claude-access-leftover' }))

    // Signed out: no host store.
    await harvestToolCredentials(OWNER)
    expect(await storedClaude()).toBeNull()

    // Signed in with an api key, which has no refresh to harvest.
    await setToolCredential(OWNER, 'claude', { kind: 'api-key', savedAt: '2026-07-09T00:00:00.000Z', apiKey: 'sk-ant-key' })
    await harvestToolCredentials(OWNER)
    expect(await storedClaude()).toMatchObject({ kind: 'api-key', apiKey: 'sk-ant-key' })
  })

  it('sweeps one project when given a projectId, and every project otherwise', async () => {
    await storeClaude(claudeBundle())
    await seedProject(P.alpha, claudeBundle({ accessToken: 'a-fresh', expiresAt: BASE_EXPIRY + HOUR }))
    await seedProject(P.beta, claudeBundle({ accessToken: 'b-fresher', expiresAt: BASE_EXPIRY + 2 * HOUR }))

    await harvestToolCredentials(OWNER, { projectId: P.alpha })
    expect(await storedClaude()).toMatchObject({ claudeAiOauth: { accessToken: 'a-fresh' } })

    // The sweep takes the newest bundle, not the first it sees.
    await harvestToolCredentials(OWNER)
    expect(await storedClaude()).toMatchObject({ claudeAiOauth: { accessToken: 'b-fresher' } })
  })

  it('sweeps only the tool it is given, so a usage cycle does not read every project twice', async () => {
    await storeClaude(claudeBundle())
    await storeCodex(codexBundle())
    await writeProjectClaudeCredentials(P.alpha, claudeBundle({
      accessToken: 'claude-fresh', expiresAt: BASE_EXPIRY + HOUR,
    }))
    await writeProjectCodexAuth(P.alpha, codexBundle({
      accessToken: 'codex-fresh', lastRefresh: '2026-07-10T00:00:00.000Z',
    }))

    await harvestToolCredentials(OWNER, { tool: 'claude' })
    expect(await storedClaude()).toMatchObject({ claudeAiOauth: { accessToken: 'claude-fresh' } })
    expect(await storedCodex()).toMatchObject({ codexOauth: { accessToken: 'codex-access-host' } })

    await harvestToolCredentials(OWNER, { tool: 'codex' })
    expect(await storedCodex()).toMatchObject({ codexOauth: { accessToken: 'codex-fresh' } })
  })

  it('refuses a Codex file carrying no refresh stamp, however new its synthesized one looks', async () => {
    // A file with no timestamp must rank oldest, not default to "now" and
    // outrank the live credential. Neither codex nor yaac writes this shape;
    // the test guards the comparator.
    await storeCodex(codexBundle())
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
    await writeProjectCodexAuth(P.alpha, codexBundle())
    await fs.writeFile(
      projectCodexAuthFile(P.alpha),
      JSON.stringify(stampless, null, 2),
    )

    await harvestToolCredentials(OWNER, { tool: 'codex' })

    expect(await storedCodex()).toMatchObject({
      codexOauth: { accessToken: 'codex-access-host' },
    })
  })
})

describe('seedProjectToolHome', () => {
  it('writes sentinels unconditionally where egress is mediated', async () => {
    installFakeWorkspaceDriver({ kind: 'k8s' })
    await storeClaude(claudeBundle())
    await storeCodex(codexBundle())
    // Even over a real bundle left by an earlier containerless run.
    await writeProjectClaudeCredentials(P.alpha, claudeBundle({
      accessToken: 'claude-access-real',
      expiresAt: BASE_EXPIRY + HOUR,
    }))

    await seedProjectToolHome(P.alpha, OWNER, { mediatedEgress: true })

    const claude = await readProjectClaudeBundle(P.alpha)
    expect(claude?.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
    const codex = await readProjectCodexBundle(P.alpha)
    expect(codex?.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
  })

  it('never overwrites a credential a running workspace refreshed, and harvests it instead', async () => {
    await storeClaude(claudeBundle())
    await storeCodex(codexBundle())
    const refreshedClaude = claudeBundle({
      accessToken: 'claude-access-fresh',
      refreshToken: 'claude-refresh-fresh',
      expiresAt: BASE_EXPIRY + HOUR,
    })
    await writeProjectClaudeCredentials(P.alpha, refreshedClaude)
    await writeProjectCodexAuth(P.alpha, codexBundle({
      accessToken: 'codex-access-fresh',
      lastRefresh: '2026-07-10T00:00:00.000Z',
    }))

    // On create, a stale host copy must not overwrite the project's newer
    // credential.
    await seedProjectToolHome(P.alpha, OWNER, { mediatedEgress: false })

    expect(await readProjectClaudeBundle(P.alpha)).toMatchObject({ accessToken: 'claude-access-fresh' })
    expect(await readProjectCodexBundle(P.alpha)).toMatchObject({ accessToken: 'codex-access-fresh' })
    // The host store catches up too.
    expect(await storedClaude()).toMatchObject({
      claudeAiOauth: { accessToken: 'claude-access-fresh' },
    })
    expect(await storedCodex()).toMatchObject({
      codexOauth: { accessToken: 'codex-access-fresh' },
    })
  })

  it('seeds a project that has nothing, and one holding only a sentinel', async () => {
    await storeClaude(claudeBundle())

    await seedProjectToolHome(P['fresh-project'], OWNER, { mediatedEgress: false })
    expect(await readProjectClaudeBundle(P['fresh-project'])).toMatchObject({
      accessToken: 'claude-access-host',
      refreshToken: 'claude-refresh-host',
    })

    // A data dir switched from k8s to containerless: the placeholder must be
    // replaced, or the agent authenticates with `yaac-ph-access`.
    await writeProjectClaudePlaceholder(P.flipped, claudeBundle())
    await seedProjectToolHome(P.flipped, OWNER, { mediatedEgress: false })
    expect(await readProjectClaudeBundle(P.flipped)).toMatchObject({ accessToken: 'claude-access-host' })
  })

  it('keeps a chained install seeded with the sentinel its outer proxy swaps', async () => {
    // In yaac-in-yaac, the inner install's credential is the outer proxy's
    // placeholder, and a workspace still needs it on disk.
    await storeClaude(claudeBundle({
      accessToken: PLACEHOLDER_ACCESS_TOKEN,
      refreshToken: 'yaac-ph-refresh',
    }))

    await seedProjectToolHome(P.chained, OWNER, { mediatedEgress: false })

    expect(await readProjectClaudeBundle(P.chained)).toMatchObject({
      accessToken: PLACEHOLDER_ACCESS_TOKEN,
    })
  })
})

describe('syncToolCredentials', () => {
  it('heals a project left behind by another project rotating the shared credential', async () => {
    await storeClaude(claudeBundle())
    // `winner` refreshed; `loser` holds the old pair, whose next refresh
    // would fail because the token was already rotated.
    await seedProject(P.winner, claudeBundle({
      accessToken: 'claude-access-fresh',
      refreshToken: 'claude-refresh-fresh',
      expiresAt: BASE_EXPIRY + HOUR,
    }))
    await seedProject(P.loser, claudeBundle())

    await syncToolCredentials()

    expect(await storedClaude()).toMatchObject({
      claudeAiOauth: { accessToken: 'claude-access-fresh' },
    })
    expect(await readProjectClaudeBundle(P.loser)).toMatchObject({
      accessToken: 'claude-access-fresh',
      refreshToken: 'claude-refresh-fresh',
    })
    expect(await readProjectClaudeBundle(P.winner)).toMatchObject({ accessToken: 'claude-access-fresh' })
  })

  it('converges each owner\'s projects on that owner\'s credential only', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    const BOB_PROJECT = '00000000-0000-4000-8000-0000000000b0'
    await recordProject({ id: BOB_PROJECT, name: 'bob', remoteUrl: 'https://github.com/bob/x', addedAt: 'x' }, bob)
    await storeClaude(claudeBundle())
    await storeClaude(claudeBundle({ accessToken: 'bob-access' }), bob)
    // Bob's workspace refreshed his own token, later than the built-in
    // user's; it must not become theirs, nor theirs reach his project.
    await seedProject(BOB_PROJECT, claudeBundle({ accessToken: 'bob-fresh', expiresAt: BASE_EXPIRY + HOUR }))
    await seedProject(P.alpha, claudeBundle())

    await syncToolCredentials()

    expect(await storedClaude()).toMatchObject({ claudeAiOauth: { accessToken: 'claude-access-host' } })
    expect(await storedClaude(bob)).toMatchObject({ claudeAiOauth: { accessToken: 'bob-fresh' } })
    expect(await readProjectClaudeBundle(BOB_PROJECT)).toMatchObject({ accessToken: 'bob-fresh' })
    expect(await readProjectClaudeBundle(P.alpha)).toMatchObject({ accessToken: 'claude-access-host' })
  })

  it('leaves every project home alone where egress is mediated', async () => {
    installFakeWorkspaceDriver({ kind: 'k8s' })
    await storeClaude(claudeBundle())
    await writeProjectClaudePlaceholder(P.alpha, claudeBundle())

    await syncToolCredentials()

    // Still the placeholder: mediated egress exists to keep the real bundle
    // out of pod-mounted files.
    expect(await readProjectClaudeBundle(P.alpha)).toMatchObject({
      accessToken: PLACEHOLDER_ACCESS_TOKEN,
    })
  })
})

describe('reseedPlaceholderToolHomes', () => {
  it('replaces real bundles with each owner\'s sentinels where egress is mediated, and is a no-op otherwise', async () => {
    await storeClaude(claudeBundle())
    // A data dir once served containerless holds real tokens in the files a
    // pod would mount.
    await seedProject(P.alpha, claudeBundle())

    await reseedPlaceholderToolHomes()
    expect(await readProjectClaudeBundle(P.alpha)).toMatchObject({ accessToken: 'claude-access-host' })

    installFakeWorkspaceDriver({ kind: 'k8s' })
    await reseedPlaceholderToolHomes()
    expect(await readProjectClaudeBundle(P.alpha)).toMatchObject({
      accessToken: PLACEHOLDER_ACCESS_TOKEN,
      expiresAt: BASE_EXPIRY,
    })
  })
})

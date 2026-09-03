import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import pathMod from 'node:path'
import { credentialsDir } from '@yaac/shared/project-paths'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { ProxyClient } from '#drivers/k8s/egress/proxy-client'

vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  configureProxyCredentials,
  resetProxyCredentials,
} from '#drivers/k8s/egress/credential-providers'

// The composition root's job in production; installed here directly, which
// is the same seam rather than a stand-in for it.
const mockListSshEntries = vi.fn()
const mockListProxySecrets = vi.fn<() => Promise<Array<{
  projectSlug: string
  secrets: Record<string, string>
}>>>()
const mockImportPending = vi.fn<() => Promise<boolean>>()

/** A ProxyClient with its private `running` flag forced for the test. */
function client(running: boolean): ProxyClient {
  const c = new ProxyClient({ image: 'yaac-test-proxy' })
  ;(c as unknown as { running: boolean }).running = running
  return c
}

const sshEntry = {
  pattern: 'github.com/*',
  host: 'github.com',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
  knownHostsEntry: 'github.com ssh-ed25519 AAAA',
}

describe('ProxyClient.reconcileSshKeys', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListProxySecrets.mockResolvedValue([])
    mockImportPending.mockResolvedValue(false)
    configureProxyCredentials({
      listSshEntries: mockListSshEntries,
      listProxySecrets: mockListProxySecrets,
      legacySecretImportPending: mockImportPending,
    })
  })

  afterEach(() => {
    resetProxyCredentials()
  })

  it('no-ops before the client has attached to a proxy', async () => {
    const c = client(false)
    const list = vi.spyOn(c, 'listAgentKeys')
    await c.reconcileSshKeys()
    expect(mockListSshEntries).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })

  it('no-ops when no SSH credentials are configured', async () => {
    const c = client(true)
    mockListSshEntries.mockResolvedValueOnce([])
    const list = vi.spyOn(c, 'listAgentKeys')
    await c.reconcileSshKeys()
    expect(list).not.toHaveBeenCalled()
  })

  it('no-ops when the agent already holds identities', async () => {
    const c = client(true)
    mockListSshEntries.mockResolvedValueOnce([sshEntry])
    vi.spyOn(c, 'listAgentKeys').mockResolvedValueOnce([
      { fingerprint: 'SHA256:abc', comment: 'github.com' },
    ])
    const sync = vi.spyOn(c, 'syncSshKeysFromCredentials')
    await c.reconcileSshKeys()
    expect(sync).not.toHaveBeenCalled()
  })

  it('re-syncs when credentials expect keys but the agent is empty (pod replaced)', async () => {
    const c = client(true)
    mockListSshEntries.mockResolvedValueOnce([sshEntry])
    vi.spyOn(c, 'listAgentKeys').mockResolvedValueOnce([])
    const sync = vi.spyOn(c, 'syncSshKeysFromCredentials').mockResolvedValueOnce(undefined)
    await c.reconcileSshKeys()
    expect(sync).toHaveBeenCalledOnce()
  })
})

describe('ProxyClient.syncSshKeysFromCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListProxySecrets.mockResolvedValue([])
    mockImportPending.mockResolvedValue(false)
    configureProxyCredentials({
      listSshEntries: mockListSshEntries,
      listProxySecrets: mockListProxySecrets,
      legacySecretImportPending: mockImportPending,
    })
  })

  afterEach(() => {
    resetProxyCredentials()
  })

  it('clears then reloads what the source reports', async () => {
    const c = client(true)
    mockListSshEntries.mockResolvedValueOnce([sshEntry])
    const clear = vi.spyOn(c, 'clearSshKeys').mockResolvedValue(undefined)
    const upload = vi.spyOn(c, 'uploadSshKey').mockResolvedValue(undefined)

    await c.syncSshKeysFromCredentials()

    expect(clear).toHaveBeenCalledOnce()
    // The key material itself, not a path: it lives sealed in the database,
    // and the agent holds the only other copy — in memory.
    expect(upload).toHaveBeenCalledExactlyOnceWith(
      'github.com', sshEntry.privateKey, 'github.com ssh-ed25519 AAAA',
    )
  })

  it('clears when the source reports no remotes — that is an answer', async () => {
    const c = client(true)
    mockListSshEntries.mockResolvedValueOnce([])
    const clear = vi.spyOn(c, 'clearSshKeys').mockResolvedValue(undefined)
    const upload = vi.spyOn(c, 'uploadSshKey').mockResolvedValue(undefined)

    await c.syncSshKeysFromCredentials()

    expect(clear).toHaveBeenCalledOnce()
    expect(upload).not.toHaveBeenCalled()
  })

  it('touches NOTHING when no source is registered', async () => {
    // The unwired path must be degraded, not destructive: an entrypoint that
    // composed a runtime without wiring the reader has no opinion about the
    // agent, and clearing on its behalf wipes identities a live proxy is
    // using. Reachable since the wiring moved to the composition root.
    resetProxyCredentials()
    const c = client(true)
    const clear = vi.spyOn(c, 'clearSshKeys').mockResolvedValue(undefined)
    const upload = vi.spyOn(c, 'uploadSshKey').mockResolvedValue(undefined)

    await c.syncSshKeysFromCredentials()

    expect(clear).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })
})

/**
 * The secret values a proxy pod replacement loses.
 *
 * Same shape of loss as the ssh identities beside them and healed on the same
 * tick: memory-only by design, so a replaced pod comes back holding none and
 * every RUNNING worktree's injections stop resolving until this puts them
 * back. The `attachIfRunning` path can reach a fresh pod without the
 * bootstrap running, which is why a background step owns this at all.
 */
describe('ProxyClient.reconcileProxySecrets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListProxySecrets.mockResolvedValue([])
    mockImportPending.mockResolvedValue(false)
    configureProxyCredentials({
      listSshEntries: mockListSshEntries,
      listProxySecrets: mockListProxySecrets,
      legacySecretImportPending: mockImportPending,
    })
  })

  afterEach(() => {
    resetProxyCredentials()
    vi.restoreAllMocks()
  })

  it('no-ops before the client has attached to a proxy', async () => {
    const c = client(false)
    const put = vi.spyOn(c, 'putSecrets')
    await c.reconcileProxySecrets()
    expect(mockListProxySecrets).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it('pushes every project’s values, scoped by project', async () => {
    mockListProxySecrets.mockResolvedValue([
      { projectSlug: 'demo', secrets: { A: '1' } },
      { projectSlug: 'other', secrets: { B: '2' } },
    ])
    const c = client(true)
    const put = vi.spyOn(c, 'putSecrets').mockResolvedValue(undefined)
    vi.spyOn(c, 'listSecretNames').mockResolvedValue([])

    await c.reconcileProxySecrets()

    expect(put).toHaveBeenCalledExactlyOnceWith({ 'demo/A': '1', 'other/B': '2' })
  })

  it('forgets a ref the server cannot account for', async () => {
    // Pushes MERGE, so nothing else ever removes one — a proxy left holding
    // a deleted credential would go on injecting it indefinitely.
    mockListProxySecrets.mockResolvedValue([{ projectSlug: 'demo', secrets: { KEPT: '1' } }])
    const c = client(true)
    vi.spyOn(c, 'putSecrets').mockResolvedValue(undefined)
    vi.spyOn(c, 'listSecretNames').mockResolvedValue(['demo/KEPT', 'demo/GONE', 'stale/X'])
    const del = vi.spyOn(c, 'deleteSecret').mockResolvedValue(undefined)

    await c.reconcileProxySecrets()

    expect(del.mock.calls.map(([ref]) => ref).sort()).toEqual(['demo/GONE', 'stale/X'])
  })

  it('changes NOTHING when no source is registered', async () => {
    // An unwired entrypoint is saying it has no opinion, not that this
    // install has no secrets — deleting on the strength of that would wipe
    // what a live proxy is using.
    resetProxyCredentials()
    const c = client(true)
    const put = vi.spyOn(c, 'putSecrets')
    const del = vi.spyOn(c, 'deleteSecret')

    await c.reconcileProxySecrets()

    expect(put).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('removes the file an older proxy read values from, once one answers', async () => {
    // Nothing rolls the proxy when a server starts, so for a while after an
    // upgrade the pod serving live worktrees is the OLD one, resolving every
    // injection out of exactly that file — which is why the delete waits for
    // a proxy that has answered these routes rather than happening at
    // startup (docs/legacy-compat-shims.md).
    const dir = await createTempDataDir()
    try {
      await fsp.mkdir(credentialsDir(), { recursive: true })
      const stale = pathMod.join(credentialsDir(), 'proxy-secrets.json')
      await fsp.writeFile(stale, JSON.stringify({ secrets: { A: 'old' } }))

      mockListProxySecrets.mockResolvedValue([{ projectSlug: 'demo', secrets: { A: '1' } }])
      const c = client(true)
      vi.spyOn(c, 'putSecrets').mockResolvedValue(undefined)
      vi.spyOn(c, 'listSecretNames').mockResolvedValue([])

      await c.reconcileProxySecrets()

      await expect(fsp.access(stale)).rejects.toThrow()
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('keeps the file while any overlay still has secrets to import', async () => {
    // An overlay too broken to parse is SKIPPED by the importer, so a start
    // can complete having moved nothing out of it — and the file is where
    // the values its names refer to still live. Waiting costs one restart;
    // not waiting costs a secret nobody can recover.
    const dir = await createTempDataDir()
    try {
      await fsp.mkdir(credentialsDir(), { recursive: true })
      const stale = pathMod.join(credentialsDir(), 'proxy-secrets.json')
      await fsp.writeFile(stale, JSON.stringify({ secrets: { A: 'old' } }))
      mockImportPending.mockResolvedValue(true)

      mockListProxySecrets.mockResolvedValue([])
      const c = client(true)
      vi.spyOn(c, 'listSecretNames').mockResolvedValue([])

      await c.reconcileProxySecrets()

      await fsp.access(stale)
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('pushes nothing but still prunes when this install has no secrets', async () => {
    // `[]` IS an answer, unlike the absent source above: a proxy holding
    // refs for secrets that no longer exist must be told.
    mockListProxySecrets.mockResolvedValue([])
    const c = client(true)
    const put = vi.spyOn(c, 'putSecrets')
    vi.spyOn(c, 'listSecretNames').mockResolvedValue(['demo/GONE'])
    const del = vi.spyOn(c, 'deleteSecret').mockResolvedValue(undefined)

    await c.reconcileProxySecrets()

    expect(put).not.toHaveBeenCalled()
    expect(del).toHaveBeenCalledExactlyOnceWith('demo/GONE')
  })
})

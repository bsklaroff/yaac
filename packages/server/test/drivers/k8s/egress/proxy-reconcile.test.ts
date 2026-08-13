import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ProxyClient } from '#drivers/k8s/egress/proxy-client'

vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  configureProxyCredentials,
  resetProxyCredentials,
} from '#drivers/k8s/egress/credential-providers'

// The composition root's job in production; installed here directly, which
// is the same seam rather than a stand-in for it.
const mockListSshEntries = vi.fn()

/** A ProxyClient with its private `running` flag forced for the test. */
function client(running: boolean): ProxyClient {
  const c = new ProxyClient({ image: 'yaac-test-proxy' })
  ;(c as unknown as { running: boolean }).running = running
  return c
}

const sshEntry = {
  host: 'github.com',
  privateKeyPath: '/keys/id_ed25519',
  knownHostsEntry: 'github.com ssh-ed25519 AAAA',
}

describe('ProxyClient.reconcileSshKeys', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configureProxyCredentials({ listSshEntries: mockListSshEntries })
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
    configureProxyCredentials({ listSshEntries: mockListSshEntries })
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
    expect(upload).toHaveBeenCalledExactlyOnceWith(
      'github.com', '/keys/id_ed25519', 'github.com ssh-ed25519 AAAA',
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

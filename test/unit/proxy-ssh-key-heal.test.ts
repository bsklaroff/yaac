import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ProxyClient } from '@/lib/container/proxy-client'

const mockListSshEntries = vi.hoisted(() => vi.fn())
vi.mock('@/lib/project/credentials', () => ({
  listSshEntries: mockListSshEntries,
}))

vi.mock('@/server/log', () => ({ serverLog: vi.fn() }))

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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { pushProxySecrets, syncProjectProxySecrets } from '#drivers/k8s/egress/proxy-secrets'
import { proxyClient } from '#drivers/k8s/egress/proxy-client'
import { configureProxyCredentials, resetProxyCredentials } from '#drivers/k8s/egress/credential-providers'

/**
 * Secret VALUES reach the proxy over its control API and live only in that
 * process's memory — never in a file under the mounted credentials dir,
 * which would be a durable plaintext copy of every secret the install
 * proxies. So the boundary these tests mock is the control API, and what
 * they pin is what crosses it.
 */

const putSecrets = vi.fn<(secrets: Record<string, string>) => Promise<void>>()
const deleteSecret = vi.fn<(ref: string) => Promise<void>>()
const listSecretNames = vi.fn<() => Promise<string[]>>()

const attachIfRunning = vi.fn<() => Promise<boolean>>()

beforeEach(() => {
  putSecrets.mockReset().mockResolvedValue(undefined)
  deleteSecret.mockReset().mockResolvedValue(undefined)
  listSecretNames.mockReset().mockResolvedValue([])
  attachIfRunning.mockReset().mockResolvedValue(true)
  vi.spyOn(proxyClient, 'putSecrets').mockImplementation(putSecrets)
  vi.spyOn(proxyClient, 'deleteSecret').mockImplementation(deleteSecret)
  vi.spyOn(proxyClient, 'listSecretNames').mockImplementation(listSecretNames)
  vi.spyOn(proxyClient, 'attachIfRunning').mockImplementation(attachIfRunning)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetProxyCredentials()
})

describe('pushProxySecrets', () => {
  it('scopes every ref by project, so one project cannot resolve another’s', async () => {
    await pushProxySecrets('demo', { MY_KEY: 'sekrit', OTHER: 'x' })
    expect(putSecrets).toHaveBeenCalledWith({ 'demo/MY_KEY': 'sekrit', 'demo/OTHER': 'x' })
  })

  it('says nothing at all for a project that proxies none', async () => {
    await pushProxySecrets('demo', {})
    expect(putSecrets).not.toHaveBeenCalled()
  })
})

describe('syncProjectProxySecrets', () => {
  it('pushes what the server holds and forgets what it no longer does', async () => {
    configureProxyCredentials({
      listSshEntries: () => Promise.resolve([]),
      legacySecretImportPending: () => Promise.resolve(false),
      listProxySecrets: () => Promise.resolve([
        { projectSlug: 'demo', secrets: { KEPT: 'v1' } as Record<string, string> },
        { projectSlug: 'other', secrets: { THEIRS: 'v2' } as Record<string, string> },
      ]),
    })
    // What the proxy is holding: one this project still has, one it dropped,
    // and one belonging to a different project that must be left alone.
    listSecretNames.mockResolvedValue(['demo/KEPT', 'demo/DROPPED', 'other/THEIRS'])

    await syncProjectProxySecrets('demo')

    expect(putSecrets).toHaveBeenCalledWith({ 'demo/KEPT': 'v1' })
    expect(deleteSecret).toHaveBeenCalledExactlyOnceWith('demo/DROPPED')
  })

  it('forgets a project’s last secret, rather than leaving it injected', async () => {
    configureProxyCredentials({
      listSshEntries: () => Promise.resolve([]),
      legacySecretImportPending: () => Promise.resolve(false),
      listProxySecrets: () => Promise.resolve([]),
    })
    listSecretNames.mockResolvedValue(['demo/GONE'])

    await syncProjectProxySecrets('demo')

    expect(putSecrets).not.toHaveBeenCalled()
    expect(deleteSecret).toHaveBeenCalledExactlyOnceWith('demo/GONE')
  })

  it('changes nothing when no source is registered', async () => {
    // An entrypoint that composed a runtime without wiring the reader is
    // saying it has no opinion, not that there are no secrets — deleting on
    // the strength of that would wipe what a live proxy is using.
    await syncProjectProxySecrets('demo')
    expect(putSecrets).not.toHaveBeenCalled()
    expect(deleteSecret).not.toHaveBeenCalled()
  })

  it('reports a proxy that will not answer rather than swallowing it', async () => {
    // The row is written either way, so the temptation is to swallow — but a
    // failed DELETE leaves the proxy injecting a credential the user has
    // just revoked while being told it is gone. The caller turns this into
    // an answer that says the running worktrees have not caught up.
    configureProxyCredentials({
      listSshEntries: () => Promise.resolve([]),
      legacySecretImportPending: () => Promise.resolve(false),
      listProxySecrets: () => Promise.resolve([{ projectSlug: 'demo', secrets: { A: '1' } }]),
    })
    putSecrets.mockRejectedValue(new Error('proxy is down'))

    await expect(syncProjectProxySecrets('demo')).rejects.toThrow('proxy is down')
  })

  it('does nothing when no proxy is attached — there is nothing live to update', async () => {
    configureProxyCredentials({
      listSshEntries: () => Promise.resolve([]),
      legacySecretImportPending: () => Promise.resolve(false),
      listProxySecrets: () => Promise.resolve([{ projectSlug: 'demo', secrets: { A: '1' } }]),
    })
    attachIfRunning.mockResolvedValue(false)

    await expect(syncProjectProxySecrets('demo')).resolves.toBeUndefined()
    expect(putSecrets).not.toHaveBeenCalled()
    expect(deleteSecret).not.toHaveBeenCalled()
  })
})

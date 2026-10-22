import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { BUILT_IN_USER_ID, closeDb, getProjectRow, recordProject, seeTailnetUser, setProjectCloudIdentity } from '#db'
import { assignProjectCloudIdentity, cloudIdentityInfo, startCloudIdentity } from '#domain/cloud-identity'
import { resetCloudIdentityForTests } from '#domain/cloud-identity/identity'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import type { ServerError } from '@yaac/shared/errors'
import type { CloudCredential } from '#drivers/contract'

/**
 * Lending projects a cloud identity, against a fake GCE metadata server and
 * IAM Credentials API at the network boundary (`fetch`). Project rows are
 * real; only the driver that receives the tokens is faked.
 */

const VM = 'vm@demo.iam.gserviceaccount.com'
const AGENTS = 'agents@demo.iam.gserviceaccount.com'
const A = '0a0a0a0a-0000-4000-8000-00000000000a'
const B = '0a0a0a0a-0000-4000-8000-00000000000b'
const C = '0a0a0a0a-0000-4000-8000-00000000000c'
const owner = { kind: 'local', userId: BUILT_IN_USER_ID } as const

/** Whether the fake metadata server answers, and the accounts the VM may
 *  impersonate. */
let onGce: boolean
let impersonable: Set<string>
let minted: number
let synced: Array<Record<string, CloudCredential>>
let tmpDir: string
let stop: AbortController

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : input.toString()
  if (url.startsWith('http://169.254.169.254/')) {
    if (!onGce) return Promise.reject(new TypeError('fetch failed'))
    const path = url.slice('http://169.254.169.254/computeMetadata/v1/'.length)
    const answer = (body: string): Promise<Response> =>
      Promise.resolve(new Response(body, { headers: { 'Metadata-Flavor': 'Google' } }))
    if (path === 'instance/service-accounts/default/email') return answer(VM)
    if (path === 'project/project-id') return answer('demo')
    if (path === 'project/numeric-project-id') return answer('4242')
    if (path === 'instance/service-accounts/default/token') {
      return answer(JSON.stringify({ access_token: `ya29.vm-${String(++minted)}`, expires_in: 3600 }))
    }
  }
  const iam = /serviceAccounts\/([^:]+):generateAccessToken$/.exec(url)
  if (iam && init?.method === 'POST') {
    const email = decodeURIComponent(iam[1])
    if (!impersonable.has(email)) {
      return Promise.resolve(Response.json({ error: { message: 'Permission iam.serviceAccounts.getAccessToken denied' } }, { status: 403 }))
    }
    return Promise.resolve(Response.json({
      accessToken: `ya29.${email}-${String(++minted)}`,
      expireTime: new Date(Date.now() + 3_600_000).toISOString(),
    }))
  }
  return Promise.reject(new Error(`unexpected fetch ${url}`))
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(() => undefined, (err: unknown) => (err as ServerError).code)
}

const project = (id: string): Promise<void> =>
  recordProject({ id, name: id.slice(-1), remoteUrl: `https://x/${id}.git`, addedAt: '2026-01-01' }, BUILT_IN_USER_ID)

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  onGce = true
  impersonable = new Set([AGENTS])
  minted = 0
  synced = []
  stop = new AbortController()
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  installFakeWorkspaceDriver({
    syncCloudCredentials: (byProject) => { synced.push(byProject); return Promise.resolve() },
  })
  await project(A)
  await project(B)
  await project(C)
})

afterEach(async () => {
  stop.abort()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetCloudIdentityForTests()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('startCloudIdentity', () => {
  it('pushes a token for each project with an identity and re-mints it before it expires', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    await setProjectCloudIdentity(A, 'host')
    await setProjectCloudIdentity(B, AGENTS)
    await startCloudIdentity(stop.signal)

    const first = synced.at(-1)!
    expect(Object.keys(first).sort()).toEqual([A, B])
    expect(first[A]).toMatchObject({ provider: 'gcp', identity: VM, hostProject: { id: 'demo', number: '4242' } })
    expect(first[A].accessToken).toMatch(/^ya29\.vm-/)
    expect(first[B]).toMatchObject({ identity: AGENTS })
    expect(first[B].accessToken).toMatch(/^ya29\.agents@/)

    // Nothing is re-sent while the tokens are fresh.
    const pushes = synced.length
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(synced).toHaveLength(pushes)

    // Inside ten minutes of expiry both are re-minted.
    await vi.advanceTimersByTimeAsync(46 * 60_000)
    expect(synced.at(-1)![A].accessToken).not.toBe(first[A].accessToken)
    expect(synced.at(-1)![B].accessToken).not.toBe(first[B].accessToken)

    // A cleared identity drops out of the next push.
    await setProjectCloudIdentity(B, null)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(Object.keys(synced.at(-1)!)).toEqual([A])
  })

  it('pushes an empty set off a cloud, and does nothing on a host server', async () => {
    onGce = false
    await setProjectCloudIdentity(A, 'host')
    await startCloudIdentity(stop.signal)
    expect(synced).toEqual([{}])
    expect(cloudIdentityInfo(owner).provider).toBeNull()

    resetCloudIdentityForTests()
    synced = []
    const fetchCalls = vi.mocked(fetch).mock.calls.length
    installFakeWorkspaceDriver({ kind: 'containerless', syncCloudCredentials: () => { throw new Error('unreachable') } })
    await startCloudIdentity(stop.signal)
    expect(synced).toEqual([])
    expect(vi.mocked(fetch).mock.calls).toHaveLength(fetchCalls)
  })
})

describe('cloudIdentityInfo', () => {
  it('names the cloud and the server\'s identity, and lets only the install owner set one', async () => {
    expect(cloudIdentityInfo(owner)).toEqual({ provider: null, hostIdentity: null, canSet: true })
    await startCloudIdentity(stop.signal)
    expect(cloudIdentityInfo(owner)).toEqual({ provider: 'gcp', hostIdentity: VM, canSet: true })
    const teammate = await seeTailnetUser('teammate@example.com', 'Teammate')
    expect(cloudIdentityInfo({ kind: 'tailnet', userId: teammate, login: 'teammate@example.com', name: 'T' }).canSet)
      .toBe(false)
  })
})

describe('assignProjectCloudIdentity', () => {
  it('saves an identity the server can mint for, pushes it at once, and clears it', async () => {
    await startCloudIdentity(stop.signal)
    expect(await assignProjectCloudIdentity(owner, A, 'host')).toEqual({ identity: VM })
    expect(await assignProjectCloudIdentity(owner, B, AGENTS)).toEqual({ identity: AGENTS })
    expect((await getProjectRow(A))?.cloudIdentity).toBe('host')
    expect(Object.keys(synced.at(-1)!).sort()).toEqual([A, B])

    expect(await assignProjectCloudIdentity(owner, B, null)).toEqual({ identity: null })
    expect((await getProjectRow(B))?.cloudIdentity).toBeUndefined()
    expect(Object.keys(synced.at(-1)!)).toEqual([A])
  })

  it('refuses, saving nothing, what the server cannot act as', async () => {
    await startCloudIdentity(stop.signal)
    const denied = await assignProjectCloudIdentity(owner, C, 'other@demo.iam.gserviceaccount.com')
      .then(() => undefined, (e: unknown) => e as ServerError)
    expect(denied).toMatchObject({ code: 'VALIDATION' })
    expect(denied?.message).toMatch(/cannot impersonate other@demo.*getAccessToken denied/)
    expect(await codeOf(assignProjectCloudIdentity(owner, C, 'not-an-email'))).toBe('VALIDATION')
    expect((await getProjectRow(C))?.cloudIdentity).toBeUndefined()

    expect(await codeOf(assignProjectCloudIdentity(owner, '0a0a0a0a-0000-4000-8000-0000000000ff', 'host'))).toBe('NOT_FOUND')
    const teammate = await seeTailnetUser('teammate@example.com', 'Teammate')
    expect(await codeOf(assignProjectCloudIdentity({ kind: 'tailnet', userId: teammate, login: 't', name: 'T' }, C, 'host')))
      .toBe('FORBIDDEN')
    expect(await codeOf(assignProjectCloudIdentity({ kind: 'workspace', workspaceId: 'w', userId: BUILT_IN_USER_ID }, C, 'host')))
      .toBe('FORBIDDEN')
  })

  it('is NOT_SUPPORTED off a cloud, and says so when the proxy cannot be told', async () => {
    onGce = false
    await startCloudIdentity(stop.signal)
    expect(await codeOf(assignProjectCloudIdentity(owner, A, 'host'))).toBe('NOT_SUPPORTED')

    resetCloudIdentityForTests()
    onGce = true
    await startCloudIdentity(stop.signal)
    installFakeWorkspaceDriver({ syncCloudCredentials: () => Promise.reject(new Error('apiserver down')) })
    expect(await codeOf(assignProjectCloudIdentity(owner, A, 'host'))).toBe('RUNTIME_UNAVAILABLE')
    // Saved anyway; the next refresh pushes it.
    expect((await getProjectRow(A))?.cloudIdentity).toBe('host')
  })
})

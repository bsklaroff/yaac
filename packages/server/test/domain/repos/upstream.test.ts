import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'

// The push probe reaches the remote, so it is the one git call mocked.
vi.mock('#domain/git', async (importOriginal) => ({
  ...(await importOriginal<typeof gitModule>()),
  probePushAccess: vi.fn(() => Promise.resolve(null)),
}))

import type * as gitModule from '#domain/git'
import { cloneRepo, probePushAccess } from '#domain/git'
import { recordRemoteRepo, setRepoUpstream, suggestUpstream, usableUpstream } from '#domain/repos'
import { addHttpsCredential } from '#domain/auth'
import { addRepoShare, BUILT_IN_USER_ID, closeDb, getRepo, insertRepo, listRepos, seeTailnetUser } from '#db'
import { repoDir } from '@yaac/shared/project-paths'

const mockProbe = vi.mocked(probePushAccess)
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const FORK = '6a1e0c2a-9b8d-4e7f-a6c5-0d1e2f3a4b01'
const UPSTREAM = '6a1e0c2a-9b8d-4e7f-a6c5-0d1e2f3a4b02'
const ORIGINAL = '6a1e0c2a-9b8d-4e7f-a6c5-0d1e2f3a4b03'

let tmp: string
let token: string
/** Local repositories standing in for the fork's and the upstream's
 *  remotes. */
let forkRemote: string
let upstreamRemote: string

const tip = async (repo: string, ref: string): Promise<string> => (await git(repo, ['rev-parse', ref])).trim()

async function initRemote(name: string, branch: string): Promise<string> {
  const dir = path.join(tmp, name)
  await fs.mkdir(dir)
  await git(dir, ['init', '-q', '-b', branch])
  await git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', name])
  return dir
}

beforeEach(async () => {
  tmp = await createTempDataDir()
  token = (await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_x' })).id
  mockProbe.mockReset()
  mockProbe.mockResolvedValue(null)
  forkRemote = await initRemote('fork', 'main')
  upstreamRemote = await initRemote('upstream', 'main')
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await closeDb()
  await cleanupTempDir(tmp)
})

describe('recordRemoteRepo', () => {
  it('records a remote without a clone, read-only unless its credential can push, and reuses one its owner has', async () => {
    mockProbe.mockResolvedValueOnce('yes')
    const writable = await recordRemoteRepo(BUILT_IN_USER_ID, 'https://github.com/acme/a.git', token)
    expect(writable.repo).toMatchObject({ readOnly: false, pushAccess: 'yes', gitCredentialId: token })
    mockProbe.mockResolvedValueOnce('no')
    expect((await recordRemoteRepo(BUILT_IN_USER_ID, 'https://github.com/acme/b.git', token)).repo)
      .toMatchObject({ readOnly: true, pushAccess: 'no' })

    // With no credential nothing is probed, and only https can be read.
    mockProbe.mockClear()
    const anonymous = await recordRemoteRepo(BUILT_IN_USER_ID, 'https://github.com/acme/c.git')
    expect(anonymous.repo).toMatchObject({ readOnly: true, pushAccess: null, gitCredentialId: null })
    expect(mockProbe).not.toHaveBeenCalled()
    await expect(recordRemoteRepo(BUILT_IN_USER_ID, 'git@github.com:acme/d.git')).rejects.toMatchObject({ code: 'VALIDATION' })

    // The repo its owner has is answered, taking a credential if it has none.
    const again = await recordRemoteRepo(BUILT_IN_USER_ID, 'https://github.com/acme/c.git', token)
    expect(again.repo).toMatchObject({ id: anonymous.repo.id, gitCredentialId: token })
    expect(await listRepos()).toHaveLength(3)
    await expect(fs.access(repoDir(writable.repo.id))).rejects.toThrow()
  })
})

describe('setRepoUpstream', () => {
  it('fetches the upstream into the fork\'s clone, refuses cycles and repos the owner cannot use, and drops the refs on removal', async () => {
    await insertRepo({ id: FORK, owner: BUILT_IN_USER_ID, remoteUrl: forkRemote })
    await cloneRepo(forkRemote, repoDir(FORK), null)
    await insertRepo({ id: UPSTREAM, owner: BUILT_IN_USER_ID, remoteUrl: upstreamRemote, readOnly: true })

    const set = await setRepoUpstream(local, FORK, { repoId: UPSTREAM })
    expect(set.upstream?.id).toBe(UPSTREAM)
    expect((await getRepo(FORK))?.upstreamRepoId).toBe(UPSTREAM)
    await vi.waitFor(async () => {
      expect(await tip(repoDir(FORK), 'refs/remotes/upstream/main')).toBe(await tip(upstreamRemote, 'main'))
    }, { timeout: 10_000, interval: 50 })

    // A chain is fine; a cycle, or the repo itself, is not.
    await insertRepo({ id: ORIGINAL, owner: BUILT_IN_USER_ID, remoteUrl: path.join(tmp, 'nowhere'), readOnly: true })
    await setRepoUpstream(local, UPSTREAM, { repoId: ORIGINAL })
    await expect(setRepoUpstream(local, ORIGINAL, { repoId: FORK })).rejects.toThrow(/already a fork of/)
    await expect(setRepoUpstream(local, FORK, { repoId: FORK })).rejects.toThrow(/its own upstream/)
    // Only the owner sets it, to a repo they may use.
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    const asAda = { kind: 'tailnet', userId: ada, login: 'ada@example.com', name: 'Ada' } as const
    await expect(setRepoUpstream(asAda, FORK, null)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const hers = await insertRepo({ id: '6a1e0c2a-9b8d-4e7f-a6c5-0d1e2f3a4b04', owner: ada, remoteUrl: upstreamRemote })
    await expect(setRepoUpstream(local, FORK, { repoId: hers.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await setRepoUpstream(local, FORK, null)
    expect((await getRepo(FORK))?.upstreamRepoId).toBeNull()
    expect(await git(repoDir(FORK), ['for-each-ref', 'refs/remotes/upstream'])).toBe('')
  })
})

describe('usableUpstream', () => {
  it("answers a fork's upstream to its owner alone", async () => {
    await insertRepo({ id: UPSTREAM, owner: BUILT_IN_USER_ID, remoteUrl: upstreamRemote })
    const fork = await insertRepo({ id: FORK, owner: BUILT_IN_USER_ID, remoteUrl: forkRemote, hosted: true, upstreamRepoId: UPSTREAM })
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    await addRepoShare(FORK, ada)

    expect((await usableUpstream(fork, BUILT_IN_USER_ID))?.id).toBe(UPSTREAM)
    expect(await usableUpstream(fork, ada)).toBeUndefined()
    expect(await usableUpstream({ ...fork, upstreamRepoId: null }, BUILT_IN_USER_ID)).toBeUndefined()
  })
})

describe('suggestUpstream', () => {
  it("answers GitHub's parent of a github.com repo read with a token, and nothing when GitHub cannot say", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      parent: { clone_url: 'https://github.com/upstream/tool.git' },
    }))))
    vi.stubGlobal('fetch', fetchMock)
    const repo = await insertRepo({ id: FORK, owner: BUILT_IN_USER_ID, remoteUrl: 'https://github.com/me/tool.git' }, { id: token, knownHostsEntry: null })

    expect(await suggestUpstream(repo)).toBe('https://github.com/upstream/tool.git')
    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/me/tool', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer ghp_x' }) as unknown,
    }))
    fetchMock.mockResolvedValueOnce(new Response('{}'))
    expect(await suggestUpstream(repo)).toBeUndefined()
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(await suggestUpstream(repo)).toBeUndefined()

    // Not asked for a repo with an upstream, or one off github.com.
    fetchMock.mockClear()
    expect(await suggestUpstream({ ...repo, upstreamRepoId: UPSTREAM })).toBeUndefined()
    expect(await suggestUpstream({ ...repo, remoteUrl: 'https://gitlab.com/me/tool.git' })).toBeUndefined()
    // Nor with Tor on, which the lookup would not go through.
    vi.stubEnv('YAAC_USE_TOR', '1')
    expect(await suggestUpstream(repo)).toBeUndefined()
    vi.unstubAllEnvs()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

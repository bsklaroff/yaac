import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, snapshotFixture } from '#test/support/fake-driver'
import { git } from '@yaac/test-utils/git'
import { hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { closeDb } from '#db/client'
import { applyWorkspaceEvent, BUILT_IN_USER_ID, insertRepo, markRepoDeleted } from '#db'
import { cloneRepo, hostedDefaultBranch, initHostedRepo } from '#domain/git'
import { fetchRepoCommit, fetchRepoOrigin, freshenOrigin, onOriginFetched, refreshRepoOrigins, seedRepoOrigin } from '#domain/repos'

/**
 * Fixture: a repo whose remote is a local repository, with a main clone,
 * and one running workspace recorded as holding a checkout of it.
 */

let tmp: string
let source: string
const PROJECT_ID = '3f1e0c2a-9b8d-4e7f-a6c5-0d1e2f3a4b5c'
const REPO_ID = '3f1e0c2a-9b8d-4e7f-a6c5-0d1e2f3a4b5d'
const IDLE_REPO = '3f1e0c2a-9b8d-4e7f-a6c5-0d1e2f3a4b5e'
const MISSING = '4101bef8-794f-4d98-8e95-dfb54850c68b'
const WT = 'wt-1'
const running = handleFixture({ workspaceId: WT, projectId: PROJECT_ID, jobName: WT })

const tip = async (repo: string, ref: string): Promise<string> => (await git(repo, ['rev-parse', ref])).trim()
const commit = (msg: string): Promise<string> =>
  git(source, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', msg])

beforeAll(async () => {
  tmp = await createTempDataDir()
  source = path.join(tmp, 'source')
  await fs.mkdir(source)
  await git(source, ['init', '-q', '-b', 'main'])
  await commit('initial')
  for (const id of [REPO_ID, IDLE_REPO]) {
    await insertRepo({ id, owner: BUILT_IN_USER_ID, remoteUrl: source })
    await cloneRepo(source, repoDir(id), null)
  }
  await applyWorkspaceEvent({
    type: 'workspace-created', projectId: PROJECT_ID, workspaceId: WT, repos: [{ repoId: REPO_ID, path: '' }], cwd: '',
  })
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmp)
})

describe('refreshRepoOrigins', () => {
  it('fetches a repo a running workspace holds a checkout of, once per interval, and no other', async () => {
    await commit('timed')

    await refreshRepoOrigins(snapshotFixture([running]))
    await vi.waitFor(async () => {
      expect(await tip(repoDir(REPO_ID), 'origin/main')).toBe(await tip(source, 'main'))
    }, { timeout: 10_000, interval: 50 })
    // No running workspace has the other repo.
    expect(await tip(repoDir(IDLE_REPO), 'origin/main')).not.toBe(await tip(source, 'main'))

    // Fetched moments ago, so the next pass skips it. A spare's checkouts
    // are not rows, so a spare alone fetches nothing either.
    await commit('too soon')
    await refreshRepoOrigins(snapshotFixture([running]))
    await refreshRepoOrigins(snapshotFixture([handleFixture({ workspaceId: 'spare', projectId: PROJECT_ID, prewarmed: true })]))
    await new Promise((r) => setTimeout(r, 300))
    expect(await tip(repoDir(REPO_ID), 'origin/main')).not.toBe(await tip(source, 'main'))
  })
})

describe('fetchRepoOrigin', () => {
  it('brings the main clone up to the row\'s remote, unless one ran that recently', async () => {
    await commit('fetched')
    await fetchRepoOrigin(REPO_ID, { unlessWithinMs: 60_000 })
    expect(await tip(repoDir(REPO_ID), 'origin/main')).not.toBe(await tip(source, 'main'))

    await Promise.all([fetchRepoOrigin(REPO_ID), fetchRepoOrigin(REPO_ID), fetchRepoOrigin(REPO_ID)])
    expect(await tip(repoDir(REPO_ID), 'origin/main')).toBe(await tip(source, 'main'))
  })

  it('refuses a repo that does not exist or that its owner deleted', async () => {
    await expect(fetchRepoOrigin(MISSING)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const deleted = '4a2f1d3b-0c9e-4f8a-b7d6-1e2f3a4b5c6d'
    await insertRepo({ id: deleted, owner: BUILT_IN_USER_ID, remoteUrl: source })
    await cloneRepo(source, repoDir(deleted), null)
    await markRepoDeleted(deleted)
    await expect(fetchRepoOrigin(deleted)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('freshenOrigin', () => {
  it('answers whether a fetch started since a time landed, else fetches in the background and tells the listeners', async () => {
    const fetched = vi.fn()
    onOriginFetched(fetched)
    const before = Date.now()
    await fetchRepoOrigin(IDLE_REPO)
    expect(freshenOrigin(IDLE_REPO, before)).toBe(true)
    await commit('moved')
    // Nothing fetched since now: a fetch starts, and lands for the listeners.
    fetched.mockClear()
    const since = Date.now() + 1
    await new Promise((r) => setTimeout(r, 5))
    expect(freshenOrigin(IDLE_REPO, since)).toBe(false)
    // Under way, it is still not fresh.
    expect(freshenOrigin(IDLE_REPO, since)).toBe(false)
    await vi.waitFor(() => expect(fetched).toHaveBeenCalledWith(IDLE_REPO))
    expect(await tip(repoDir(IDLE_REPO), 'origin/main')).toBe(await tip(source, 'main'))
    // However long that fetch took, it started after `since`.
    expect(freshenOrigin(IDLE_REPO, since)).toBe(true)
  })
})

describe('fetchRepoCommit', () => {
  it('brings in a commit the main clone lacks, by id', async () => {
    await git(source, ['checkout', '-q', '-b', 'side'])
    await commit('only on side')
    const sha = await tip(source, 'HEAD')
    await git(source, ['checkout', '-q', 'main'])
    await expect(git(repoDir(IDLE_REPO), ['cat-file', '-e', sha])).rejects.toThrow()

    await fetchRepoCommit(IDLE_REPO, sha)
    await git(repoDir(IDLE_REPO), ['cat-file', '-e', sha])
    await expect(fetchRepoCommit(MISSING, sha)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('seedRepoOrigin', () => {
  it('gives a new hosted repo its default branch, by the author it is given, from the repository on disk', async () => {
    const hosted = '5b3e2f4c-1d0a-4b9e-8c7f-2a3b4c5d6e7f'
    await insertRepo({ id: hosted, owner: BUILT_IN_USER_ID, remoteUrl: 'http://yaac.internal/x.git', hosted: true })
    await fs.mkdir(path.dirname(hostedRepoDir(hosted)), { recursive: true })
    await initHostedRepo(hostedRepoDir(hosted))
    await cloneRepo(hostedRepoDir(hosted), repoDir(hosted), { kind: 'hosted' })

    await seedRepoOrigin(hosted, { name: 'Owner', email: 'owner@example.com' })
    expect(await hostedDefaultBranch(hostedRepoDir(hosted))).toBe('main')
    expect((await git(hostedRepoDir(hosted), ['log', '-1', '--format=%an %s', 'main'])).trim()).toBe('Owner Initial commit')
    expect(await tip(repoDir(hosted), 'origin/main')).toBe(await tip(hostedRepoDir(hosted), 'main'))
  })
})

describe('onOriginFetched', () => {
  it('tells every listener which repo a fetch landed in, and nothing for one that fails', async () => {
    const first = vi.fn()
    const second = vi.fn()
    onOriginFetched(first)
    onOriginFetched(second)
    await commit('watched')
    await fetchRepoOrigin(REPO_ID)
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1))
    expect(first).toHaveBeenCalledWith(REPO_ID)
    expect(second).toHaveBeenCalledWith(REPO_ID)

    const unreachable = '5b3e2f4c-1d0a-4b9c-8e7f-2a3b4c5d6e7f'
    await insertRepo({ id: unreachable, owner: BUILT_IN_USER_ID, remoteUrl: path.join(tmp, 'missing') })
    await cloneRepo(source, repoDir(unreachable), null)
    await expect(fetchRepoOrigin(unreachable)).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 100))
    expect(first).toHaveBeenCalledTimes(1)
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import type { CredentialBundle, RuntimeHandle } from '#drivers/contract'

/** Where a git call to the upstream's GitHub URL goes instead: a local
 *  bare repository the case makes. */
const GITHUB = 'https://github.com/acme/tool.git'
const redirect = { to: '' }

// git is the process boundary. Every call to GITHUB runs for real against
// the local repository standing in for it, with no credential; the push
// probe answers what a case sets.
vi.mock('#domain/git', async (importOriginal) => {
  const actual = await importOriginal<typeof gitModule>()
  const local = (url: string): string => (url === GITHUB ? redirect.to : url)
  return {
    ...actual,
    fetchOrigin: vi.fn((repo: string, url: string, cred: unknown) =>
      actual.fetchOrigin(repo, local(url), url === GITHUB ? null : cred as never)),
    fetchUpstream: vi.fn((repo: string, url: string, cred: unknown) =>
      actual.fetchUpstream(repo, local(url), url === GITHUB ? null : cred as never)),
    pushMainBranches: vi.fn((repo: string, url: string, _cred: unknown, branches: Array<{ from: string; to: string }>) =>
      actual.pushMainBranches(repo, local(url), { kind: 'hosted' }, branches)),
    probePushAccess: vi.fn(() => Promise.resolve('yes')),
  }
})

import type * as gitModule from '#domain/git'
import { probePushAccess } from '#domain/git'
import { moveRepoToUpstream, moveRepoToYaac, previewRepoHost, previewUpstreamMove } from '#domain/workspaces'
import { createHostedProject } from '#domain/projects'
import { fetchRepoOrigin, fetchRepoUpstream, shareRepo } from '#domain/repos'
import { addHttpsCredential } from '#domain/auth'
import {
  BUILT_IN_USER_ID, getProjectRow, getRepo, insertRepo, linkProjectRepo, listRepos, listRepoShares, seeTailnetUser, setRepoRemote,
  unlinkProjectRepo, updateRepoSettings, type RepoRow,
} from '#db'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { hostedRemoteUrl } from '@yaac/shared/hosted-git'
import { hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { git } from '@yaac/test-utils/git'
import { recordTestProject } from '@yaac/test-utils/project-fixture'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const PROJECT = '7d1e0c2a-9b8d-4e7f-a6c5-0d1e2f3a4b01'
const REPO = '7d1e0c2a-9b8d-4e7f-a6c5-0d1e2f3a4b02'
const UPSTREAM = '7d1e0c2a-9b8d-4e7f-a6c5-0d1e2f3a4b03'
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }

const mockList = vi.fn<(projectId?: string) => Promise<RuntimeHandle[]>>()
const mockDeregister = vi.fn<(workspaceId: string) => Promise<void>>()
const mockSync = vi.fn<(bundles: Record<string, CredentialBundle>) => Promise<void>>()

let tmpDir: string
/** The local repository standing in for GITHUB, with `main` and
 *  `release`. */
let github: string
let token: string

const run = (dir: string, args: string[]): Promise<string> => git(dir, args, { env: ENV })
const tip = async (repo: string, ref: string): Promise<string> => (await run(repo, ['rev-parse', ref])).trim()
const refsOf = async (repo: string): Promise<string> => run(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads'])

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockList.mockReset().mockResolvedValue([])
  mockDeregister.mockReset().mockResolvedValue(undefined)
  mockSync.mockReset().mockResolvedValue(undefined)
  vi.mocked(probePushAccess).mockReset().mockResolvedValue('yes')
  installFakeWorkspaceDriver({ list: mockList, deregisterWorkspace: mockDeregister, syncCredentials: mockSync })
  github = path.join(tmpDir, 'github.git')
  redirect.to = github
  await run(tmpDir, ['init', '-q', '--bare', '-b', 'main', github])
  const seed = path.join(tmpDir, 'seed')
  await run(tmpDir, ['clone', '-q', github, seed])
  await run(seed, ['commit', '-q', '--allow-empty', '-m', 'u1'])
  await run(seed, ['push', '-q', 'origin', 'HEAD:main', 'HEAD:release'])
  token = (await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_x' })).id
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** A repo on GitHub, cloned, linked into a project with one running
 *  workspace holding a checkout of it. */
async function linkedRepo(): Promise<RepoRow> {
  const repo = await insertRepo({ id: REPO, owner: BUILT_IN_USER_ID, remoteUrl: GITHUB, pushAccess: 'no' }, { id: token, knownHostsEntry: null })
  await cloneMainClone(REPO)
  await recordTestProject(PROJECT, { repo: false })
  await linkProjectRepo(PROJECT, REPO, 'tool')
  await recordWorkspaceCreated({ projectId: PROJECT, workspaceId: 'w1', repos: [{ repoId: REPO, path: '' }] })
  mockList.mockResolvedValue([handleFixture({ jobName: 'yaac-w1', workspaceId: 'w1', projectId: PROJECT })])
  return repo
}

/** Clone the stand-in for GITHUB as a repo's main clone. */
async function cloneMainClone(repoId: string): Promise<void> {
  await run(tmpDir, ['clone', '-q', '--no-checkout', github, repoDir(repoId)])
}

describe('previewRepoHost', () => {
  it('names the running workspaces a move onto yaac would stop, by project, for the owner', async () => {
    await linkedRepo()
    const { name } = (await getProjectRow(PROJECT)) ?? { name: '' }
    expect(await previewRepoHost(local, REPO)).toEqual({ projects: [{ id: PROJECT, name, workspaces: ['w1'] }] })
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    await expect(previewRepoHost({ kind: 'tailnet', userId: ada, login: 'ada@example.com', name: 'Ada' }, REPO))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('moveRepoToYaac', () => {
  it('stops its workspaces, hosts the repo filled from its main clone, and makes the remote it leaves its upstream', async () => {
    await linkedRepo()
    // Its origin must be fetched first, or it stays where it was.
    const real = github
    redirect.to = path.join(tmpDir, 'gone.git')
    await expect(moveRepoToYaac(local, REPO)).rejects.toThrow(/fetching .* failed[\s\S]*stays where it was/)
    expect((await getRepo(REPO))?.hosted).toBe(false)
    redirect.to = real
    // The credential is probed first; it cannot push.
    vi.mocked(probePushAccess).mockResolvedValue('no')

    await moveRepoToYaac(local, REPO)
    expect(mockDeregister.mock.calls).toContainEqual(['w1'])
    const moved = await getRepo(REPO)
    expect(moved).toMatchObject({
      hosted: true, remoteUrl: hostedRemoteUrl(REPO), gitCredentialId: null, readOnly: false, guardAllowsCatchUp: true,
    })
    // The remote it left is a repo of its own now, read-only since its
    // credential could not push, keeping the credential.
    const upstream = await getRepo(moved?.upstreamRepoId ?? '')
    expect(upstream).toMatchObject({ remoteUrl: GITHUB, gitCredentialId: token, readOnly: true, pushAccess: 'no', hosted: false })
    expect(await refsOf(hostedRepoDir(REPO))).toBe('refs/heads/main\nrefs/heads/release\n')
    expect(await tip(repoDir(REPO), 'refs/remotes/upstream/main')).toBe(await tip(github, 'main'))
    // The project still links the same row, and the runtime was handed the
    // credentials again.
    expect((await getProjectRow(PROJECT))?.repos.map((l) => l.repo.id)).toEqual([REPO])
    expect(mockSync).toHaveBeenCalled()

    // A repo yaac hosts has nowhere to move.
    await expect(moveRepoToYaac(local, REPO)).rejects.toThrow(/hosted by yaac already/)
    // Nor does one whose old hosted repository yaac still keeps.
    const kept = await insertRepo({ id: UPSTREAM, owner: BUILT_IN_USER_ID, remoteUrl: 'https://github.com/acme/kept.git' })
    await setRepoRemote(kept.id, 'https://github.com/acme/kept.git', { id: token, knownHostsEntry: null })
    await expect(moveRepoToYaac(local, kept.id)).rejects.toThrow(/still keeps the repository/)
  })
})

/**
 * A hosted fork of GITHUB, shared with Ada: its `main` is GITHUB's with a
 * commit on top, it alone has `feature`, its `release` has diverged, and
 * GITHUB alone has `theirs`. A running workspace holds a checkout of it.
 */
async function hostedFork(): Promise<{ fork: RepoRow; ada: string }> {
  await insertRepo({ id: UPSTREAM, owner: BUILT_IN_USER_ID, remoteUrl: GITHUB, readOnly: true }, { id: token, knownHostsEntry: null })
  const { id: project } = await createHostedProject('tool', BUILT_IN_USER_ID)
  const [{ repo }] = (await getProjectRow(project))?.repos ?? []
  await updateRepoSettings(repo.id, { upstreamRepoId: UPSTREAM })
  const work = path.join(tmpDir, 'fork-work')
  await run(tmpDir, ['clone', '-q', github, work])
  await run(work, ['commit', '-q', '--allow-empty', '-m', 'the fork adds'])
  await run(work, ['push', '-q', hostedRepoDir(repo.id), 'HEAD:main', 'HEAD:feature'])
  await run(work, ['checkout', '-q', '-b', 'r', 'origin/release'])
  await run(work, ['commit', '-q', '--allow-empty', '-m', 'fork release'])
  await run(work, ['push', '-q', hostedRepoDir(repo.id), 'HEAD:release'])
  const seed = path.join(tmpDir, 'seed')
  await run(seed, ['commit', '-q', '--allow-empty', '-m', 'upstream release'])
  await run(seed, ['push', '-q', 'origin', 'HEAD:release', 'HEAD~1:refs/heads/theirs'])
  await fetchRepoOrigin(repo.id)
  await fetchRepoUpstream(repo.id)
  const ada = await seeTailnetUser('ada@example.com', 'Ada')
  await shareRepo(local, repo.id, ada)
  await recordWorkspaceCreated({ projectId: project, workspaceId: 'w2', repos: [{ repoId: repo.id, path: '', baseBranch: 'feature' }] })
  mockList.mockResolvedValue([handleFixture({ jobName: 'yaac-w2', workspaceId: 'w2', projectId: project })])
  return { fork: (await getRepo(repo.id)) as RepoRow, ada }
}

describe('previewUpstreamMove', () => {
  it('answers every branch of either remote by how the fork stands, with what stops', async () => {
    const { fork } = await hostedFork()
    const preview = await previewUpstreamMove(local, fork.id)
    expect(preview).toMatchObject({ runningWorkspaces: 1, sharedWith: ['ada@example.com'] })
    expect(preview.toUpstream?.remoteUrl).toBe(GITHUB)
    expect(preview.toUpstream?.branches.map((b) => [b.branch, b.state])).toEqual([
      ['feature', 'fork-only'], ['main', 'ahead'], ['release', 'diverged'], ['theirs', 'upstream-only'],
    ])

    // The upstream's credential must push there.
    vi.mocked(probePushAccess).mockResolvedValue('no')
    await expect(previewUpstreamMove(local, fork.id)).rejects.toThrow(/cannot push/)
  })
})

describe('moveRepoToUpstream', () => {
  it('pushes the branches picked, takes the upstream\'s remote, and leaves the rest where the fork was', async () => {
    const { fork } = await hostedFork()
    // Every branch that needs one must have a choice, and a diverged one
    // can only be left.
    await expect(moveRepoToUpstream(local, fork.id, { push: [{ branch: 'main' }], leave: [] })).rejects.toThrow(/choose whether/)
    await expect(moveRepoToUpstream(local, fork.id, { push: [{ branch: 'main' }, { branch: 'feature' }, { branch: 'release' }], leave: [] }))
      .rejects.toThrow(/diverged/)
    // Not while a project links the upstream itself.
    await recordTestProject(PROJECT, { repo: false })
    await linkProjectRepo(PROJECT, UPSTREAM, 'upstream')
    const choices = { push: [{ branch: 'main' }, { branch: 'feature', as: 'from-fork' }], leave: ['release'] }
    await expect(moveRepoToUpstream(local, fork.id, choices)).rejects.toMatchObject({ code: 'CONFLICT' })
    await unlinkProjectRepo(UPSTREAM)
    // Linked once, the upstream has a main clone, which the move removes.
    await run(tmpDir, ['clone', '-q', '--no-checkout', github, repoDir(UPSTREAM)])
    const releaseBefore = await tip(github, 'release')

    expect(await moveRepoToUpstream(local, fork.id, choices)).toEqual({})
    expect(mockDeregister.mock.calls).toEqual([['w2']])
    expect(await tip(github, 'main')).toBe(await tip(hostedRepoDir(fork.id), 'main'))
    expect(await tip(github, 'from-fork')).toBe(await tip(hostedRepoDir(fork.id), 'feature'))
    expect(await tip(github, 'release')).toBe(releaseBefore)
    // The repo keeps its id and takes the upstream's remote and credential;
    // the upstream's row goes, its shares end, and yaac keeps the fork's
    // repository read-only.
    expect(await getRepo(fork.id)).toMatchObject({
      remoteUrl: GITHUB, hosted: false, keepsHostedRepo: true, gitCredentialId: token, upstreamRepoId: null, readOnly: false,
    })
    expect(await getRepo(UPSTREAM)).toBeUndefined()
    await expect(fs.access(repoDir(UPSTREAM))).rejects.toThrow()
    expect((await listRepoShares()).filter((s) => s.repoId === fork.id)).toEqual([])
    expect(await run(repoDir(fork.id), ['for-each-ref', 'refs/remotes/upstream'])).toBe('')
    expect((await listRepos()).map((r) => r.id)).not.toContain(UPSTREAM)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  addRepoShare,
  clearRepoKeepsHostedRepo,
  deleteRepoRow,
  findOwnerRepo,
  getRepo,
  insertRepo,
  linkProjectRepo,
  listAllProjectRepos,
  listProjectRepos,
  listReleasedDeletedRepos,
  listRepoHolders,
  listRepos,
  listRepoShares,
  listWorkspaceRepos,
  listWorkspaceReposFor,
  markRepoDeleted,
  removeRepoShares,
  repointProjectRepos,
  setProjectRepoOrder,
  setRepoDefaultBranchGuard,
  setRepoGitCredential,
  setRepoRemote,
  unlinkProjectRepo,
  updateProjectRepo,
} from '#db/repo-store'
import { getProjectRow, recordProject, recordProjectCreate } from '#db/project-store'
import { insertGitCredential } from '#db/git-credential-store'
import { deleteWorkspaceRecords, recordWorkspaceCreated } from '#db/workspace-store'
import { getQueuedWorkspaceRow, insertQueuedWorkspace } from '#db/queued-workspace-store'
import { getRoutineRow, insertRoutine } from '#db/routine-store'
import { insertDraftWorkspace, listDraftWorkspaceRows } from '#db/draft-workspace-store'
import { getSiteRow, insertSite, updateSite } from '#db/site-store'
import { findNamedWorkflow, getWorkflow, insertNamedWorkflow, storeWorkflow } from '#db/workflow-store'
import { BUILT_IN_USER_ID, seeTailnetUser } from '#db/user-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#lib/notify'

/*
 * Repos, and the three rows that name one: a project's link, a user's share
 * and a workspace's checkout. What matters here is which rows each write
 * reaches, since a repo outlives the projects that link it and a checkout
 * outlives the link.
 */

const API = '0b0b0b0b-0000-4000-8000-000000000001'
const WEB = '0b0b0b0b-0000-4000-8000-000000000002'
const P = '0b0b0b0b-0000-4000-8000-0000000000a1'
const Q = '0b0b0b0b-0000-4000-8000-0000000000a2'
const NO_REPO = '0b0b0b0b-0000-4000-8000-0000000000ff'

let tmpDir: string

beforeEach(async () => { tmpDir = await createTempDataDir() })
afterEach(async () => {
  _resetWorkspaceListChangedForTests()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const project = (id: string, owner = BUILT_IN_USER_ID): Promise<void> =>
  recordProject({ id, name: id.slice(-2), addedAt: '2026-01-01' }, owner)
const repo = (id: string, owner = BUILT_IN_USER_ID, remoteUrl = `https://x/${id}.git`) => insertRepo({ id, owner, remoteUrl })

describe('insertRepo', () => {
  it('records a repo with the credential it was added with, and pushes a fresh snapshot', async () => {
    const cred = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'k', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 AAAA yaac k' })
    let pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })

    const row = await insertRepo({ id: API, owner: BUILT_IN_USER_ID, remoteUrl: 'git@x:api.git' }, { id: cred.id, knownHostsEntry: 'x ssh-ed25519 HOST' })
    expect(row).toEqual({
      id: API,
      owner: BUILT_IN_USER_ID,
      remoteUrl: 'git@x:api.git',
      addedAt: expect.any(String) as string,
      gitCredentialId: cred.id,
      knownHostsEntry: 'x ssh-ed25519 HOST',
      hosted: false,
      guardDefaultBranch: true,
      keepsHostedRepo: false,
    })
    expect(await insertRepo({ id: WEB, owner: BUILT_IN_USER_ID, remoteUrl: 'http://yaac.internal/w.git', hosted: true }))
      .toMatchObject({ hosted: true, gitCredentialId: null, knownHostsEntry: null })
    expect(pushes).toBe(2)
  })
})

describe('getRepo', () => {
  it('reads one repo, or undefined for none', async () => {
    await repo(API)
    expect((await getRepo(API))?.remoteUrl).toBe(`https://x/${API}.git`)
    expect(await getRepo(NO_REPO)).toBeUndefined()
  })
})

describe('listRepos', () => {
  it('lists every repo, any owner\'s, deleted ones included', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'bob')
    await repo(API)
    await repo(WEB, bob)
    await markRepoDeleted(WEB)
    expect((await listRepos()).map((r) => [r.id, r.owner, r.deletedAt !== undefined]).sort())
      .toEqual([[API, BUILT_IN_USER_ID, false], [WEB, bob, true]])
  })
})

describe('findOwnerRepo', () => {
  it('finds the owner\'s oldest live repo for a remote, never another user\'s or a deleted one', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'bob')
    const url = 'https://github.com/acme/app.git'
    expect(await findOwnerRepo(BUILT_IN_USER_ID, url)).toBeUndefined()
    await repo(WEB, bob, url)
    expect(await findOwnerRepo(BUILT_IN_USER_ID, url)).toBeUndefined()
    await repo(API, BUILT_IN_USER_ID, url)
    expect((await findOwnerRepo(BUILT_IN_USER_ID, url))?.id).toBe(API)
    await markRepoDeleted(API)
    expect(await findOwnerRepo(BUILT_IN_USER_ID, url)).toBeUndefined()
  })
})

describe('setRepoGitCredential', () => {
  it('assigns the credential with its host key, replacing both, and reports an unknown repo', async () => {
    const a = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'a', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 AAAA yaac a' })
    const b = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'b', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 BBBB yaac b' })
    await repo(API)

    expect(await setRepoGitCredential(API, a.id, 'x ssh-ed25519 ONE')).toBe(true)
    expect(await setRepoGitCredential(API, b.id, 'x ssh-ed25519 TWO')).toBe(true)
    expect(await getRepo(API)).toMatchObject({ gitCredentialId: b.id, knownHostsEntry: 'x ssh-ed25519 TWO' })
    expect(await setRepoGitCredential(NO_REPO, a.id, null)).toBe(false)
  })
})

describe('setRepoRemote', () => {
  it('points a hosted repo at a remote, with its credential and the repository it keeps, and reports an unknown repo', async () => {
    const cred = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'gh', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 AAAA yaac gh' })
    await insertRepo({ id: API, owner: BUILT_IN_USER_ID, remoteUrl: 'http://yaac.internal/a.git', hosted: true })

    const remote = 'git@github.com:acme/app.git'
    expect(await setRepoRemote(API, remote, { id: cred.id, knownHostsEntry: 'github.com ssh-ed25519 KEY' })).toBe(true)
    expect(await getRepo(API)).toMatchObject({
      remoteUrl: remote, hosted: false, keepsHostedRepo: true, gitCredentialId: cred.id, knownHostsEntry: 'github.com ssh-ed25519 KEY',
    })
    expect(await setRepoRemote(NO_REPO, remote, { id: cred.id, knownHostsEntry: null })).toBe(false)
  })
})

describe('clearRepoKeepsHostedRepo', () => {
  it('records that a moved repo keeps no old repository, and reports an unknown repo', async () => {
    const cred = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'gh', kind: 'https', secret: 'ghp_x' })
    await insertRepo({ id: API, owner: BUILT_IN_USER_ID, remoteUrl: 'http://yaac.internal/a.git', hosted: true })
    await setRepoRemote(API, 'https://github.com/acme/app.git', { id: cred.id, knownHostsEntry: null })

    expect(await clearRepoKeepsHostedRepo(API)).toBe(true)
    expect(await getRepo(API)).toMatchObject({ keepsHostedRepo: false, remoteUrl: 'https://github.com/acme/app.git' })
    expect(await clearRepoKeepsHostedRepo(NO_REPO)).toBe(false)
  })
})

describe('setRepoDefaultBranchGuard', () => {
  it('toggles the guard a repo starts with on, and reports an unknown repo', async () => {
    await insertRepo({ id: API, owner: BUILT_IN_USER_ID, remoteUrl: 'http://yaac.internal/a.git', hosted: true })
    expect(await setRepoDefaultBranchGuard(API, false)).toBe(true)
    expect(await getRepo(API)).toMatchObject({ guardDefaultBranch: false })
    expect(await setRepoDefaultBranchGuard(NO_REPO, true)).toBe(false)
  })
})

describe('markRepoDeleted', () => {
  it('marks the repo deleted and drops its credential, and reports an unknown repo', async () => {
    const cred = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'gh', kind: 'https', secret: 'ghp_x' })
    await insertRepo({ id: API, owner: BUILT_IN_USER_ID, remoteUrl: 'https://x/a.git' }, { id: cred.id, knownHostsEntry: null })

    expect(await markRepoDeleted(API)).toBe(true)
    const row = await getRepo(API)
    expect(row?.deletedAt).toBeInstanceOf(Date)
    expect(row?.gitCredentialId).toBeNull()
    expect(await markRepoDeleted(NO_REPO)).toBe(false)
  })
})

describe('deleteRepoRow', () => {
  it('deletes the repo with its shares', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'bob')
    await repo(API)
    await addRepoShare(API, bob)
    await deleteRepoRow(API)
    expect(await getRepo(API)).toBeUndefined()
    expect(await listRepoShares()).toEqual([])
  })
})

describe('addRepoShare', () => {
  it('shares a repo with a user, once', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'bob')
    await repo(API)
    await addRepoShare(API, bob)
    await addRepoShare(API, bob)
    expect(await listRepoShares()).toEqual([{ repoId: API, userId: bob }])
  })
})

describe('removeRepoShares', () => {
  it('ends one user\'s share, or with no user every share of the repo, and no other repo\'s', async () => {
    const [ada, bob] = await Promise.all([seeTailnetUser('ada@example.com', 'ada'), seeTailnetUser('bob@example.com', 'bob')])
    await repo(API)
    await repo(WEB)
    for (const [id, user] of [[API, ada], [API, bob], [WEB, ada]]) await addRepoShare(id, user)

    await removeRepoShares(API, ada)
    expect((await listRepoShares()).map((s) => `${s.repoId}/${s.userId}`).sort()).toEqual([`${API}/${bob}`, `${WEB}/${ada}`].sort())
    await removeRepoShares(API)
    expect(await listRepoShares()).toEqual([{ repoId: WEB, userId: ada }])
  })
})

describe('listRepoShares', () => {
  it('is empty until a repo is shared', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'bob')
    expect(await listRepoShares()).toEqual([])
    await repo(API)
    await addRepoShare(API, bob)
    expect(await listRepoShares()).toEqual([{ repoId: API, userId: bob }])
  })
})

describe('linkProjectRepo', () => {
  it('links a repo under its folder, after the ones the project has, and refuses a folder twice', async () => {
    await project(P)
    await repo(API)
    await repo(WEB)
    await linkProjectRepo(P, WEB, 'web')
    await linkProjectRepo(P, API, 'api')

    expect(await listProjectRepos(P)).toEqual([
      { projectId: P, dir: 'web', readOnly: false, ghToken: true, lastIncluded: true, repo: await getRepo(WEB) },
      { projectId: P, dir: 'api', readOnly: false, ghToken: true, lastIncluded: true, repo: await getRepo(API) },
    ])
    await project(Q)
    await expect(linkProjectRepo(Q, API, 'api')).resolves.toBeUndefined()
    await repo(NO_REPO)
    await expect(linkProjectRepo(P, NO_REPO, 'api')).rejects.toThrow()
  })
})

describe('listProjectRepos', () => {
  it('lists one project\'s links, none for a project with no repos', async () => {
    await project(P)
    await project(Q)
    await repo(API)
    await linkProjectRepo(P, API, 'api')
    expect((await listProjectRepos(P)).map((l) => l.dir)).toEqual(['api'])
    expect(await listProjectRepos(Q)).toEqual([])
  })
})

describe('listAllProjectRepos', () => {
  it('groups links by project, for every project or the named ones', async () => {
    await project(P)
    await project(Q)
    await repo(API)
    await linkProjectRepo(P, API, 'api')
    await linkProjectRepo(Q, API, 'backend')

    const all = await listAllProjectRepos()
    expect([...all.keys()].sort()).toEqual([P, Q])
    expect(all.get(Q)?.[0]).toMatchObject({ dir: 'backend', repo: { id: API } })
    expect([...(await listAllProjectRepos([P])).keys()]).toEqual([P])
  })
})

describe('unlinkProjectRepo', () => {
  it('unlinks a repo from one project, or from every one, answering which, and keeps the repo', async () => {
    await project(P)
    await project(Q)
    await repo(API)
    await repo(WEB)
    for (const p of [P, Q]) {
      await linkProjectRepo(p, API, 'api')
      await linkProjectRepo(p, WEB, 'web')
    }

    expect(await unlinkProjectRepo(API, P)).toEqual([P])
    expect((await listProjectRepos(P)).map((l) => l.dir)).toEqual(['web'])
    expect((await unlinkProjectRepo(WEB)).sort()).toEqual([P, Q])
    expect((await listProjectRepos(Q)).map((l) => l.dir)).toEqual(['api'])
    expect(await unlinkProjectRepo(WEB)).toEqual([])
    expect(await getRepo(WEB)).toBeDefined()
  })
})

describe('updateProjectRepo', () => {
  it('changes one link\'s folder and flags, leaving the same repo\'s link elsewhere, and reports no link', async () => {
    await project(P)
    await project(Q)
    await repo(API)
    await linkProjectRepo(P, API, 'api')
    await linkProjectRepo(Q, API, 'api')

    expect(await updateProjectRepo(P, API, { dir: 'backend', readOnly: true })).toBe(true)
    expect(await updateProjectRepo(P, API, { ghToken: false })).toBe(true)
    expect((await listProjectRepos(P))[0]).toMatchObject({ dir: 'backend', readOnly: true, ghToken: false })
    expect((await listProjectRepos(Q))[0]).toMatchObject({ dir: 'api', readOnly: false, ghToken: true })
    expect(await updateProjectRepo(P, WEB, { readOnly: true })).toBe(false)
  })
})

describe('setProjectRepoOrder', () => {
  it('lists the named repos first in the order given, the rest after', async () => {
    await project(P)
    const DOCS = '0b0b0b0b-0000-4000-8000-000000000003'
    for (const [id, dir] of [[API, 'api'], [WEB, 'web'], [DOCS, 'docs']]) {
      await repo(id)
      await linkProjectRepo(P, id, dir)
    }
    await setProjectRepoOrder(P, [DOCS, API])
    expect((await listProjectRepos(P)).map((l) => l.dir)).toEqual(['docs', 'api', 'web'])
  })
})

describe('repointProjectRepos', () => {
  // A hosted repo that moved to a git host: each other user gets a repo of
  // their own, which everything of theirs that named the old one must name,
  // while the owner's rows keep naming the old one.
  it('points everything in one owner\'s projects that names a repo at another, and nobody else\'s', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'bob')
    await project(P)
    await project(Q, bob)
    await repo(API)
    await repo(WEB, bob)
    const settings = { prompt: 'p', tool: 'claude', mode: 'tui', permissionMode: 'manual', model: 'm' } as const
    const start = { repos: [{ repo: API, branch: 'main' }], nested: false, cwd: API }
    const made: Record<string, { queued: string; routine: string }> = {}
    for (const p of [P, Q]) {
      await linkProjectRepo(p, API, 'api')
      await updateProjectRepo(p, API, { readOnly: true })
      await recordWorkspaceCreated({ projectId: p, workspaceId: `wt-${p}`, repos: [{ repoId: API, path: '', baseBranch: 'main' }] })
      await recordProjectCreate(p, 'claude', {}, { repos: [{ repoId: API }], nested: false, cwd: API })
      const queued = await insertQueuedWorkspace(p, { parentWorkspaceId: `wt-${p}` }, { ...settings, ...start })
      const routine = await insertRoutine(p, { ...settings, ...start, name: 'n', cron: '@daily', timeZone: 'UTC' }, null)
      await insertDraftWorkspace(p, { ...settings, repos: start.repos, cwd: API })
      made[p] = { queued: queued.id, routine: routine.id }
    }
    const workflow = await storeWorkflow(Q, { steps: {}, secrets: [] })
    await insertNamedWorkflow(Q, 'site', workflow.id)
    const site = await insertSite({ projectId: Q, repos: [{ repo: API, branch: 'main' }], follow: false, name: 's', hostname: 's.example.com', port: 80, namedWorkflowId: (await findNamedWorkflow(Q, 'site'))!.id })
    await updateSite(site.id, { releaseCommits: { [API]: 'a'.repeat(40) }, failedCommits: { [API]: 'b'.repeat(40) } })
    // A workflow's repos move with their hash; where the project already
    // holds the moved content, its name points there.
    const runs = await storeWorkflow(Q, { steps: { t: { run: ['make'] } }, secrets: [], repos: [API] })
    await insertNamedWorkflow(Q, 'ci', runs.id)
    const held = await storeWorkflow(Q, { steps: {}, secrets: [], repos: [WEB] })
    await insertNamedWorkflow(Q, 'clash', (await storeWorkflow(Q, { steps: {}, secrets: [], repos: [API] })).id)

    await repointProjectRepos(bob, API, WEB)

    const named = async (p: string) => ({
      link: (await listProjectRepos(p)).map((l) => [l.repo.id, l.dir, l.readOnly]),
      checkout: (await listWorkspaceRepos(`wt-${p}`)).map((c) => [c.repoId, c.baseBranch]),
      queued: (await getQueuedWorkspaceRow(made[p].queued))?.repos,
      routine: (await getRoutineRow(made[p].routine))?.repos,
      draft: (await listDraftWorkspaceRows()).find((d) => d.projectId === p)?.repos,
      cwd: (await getProjectRow(p))?.lastCwd,
    })
    const naming = (id: string) => ({
      link: [[id, 'api', true]],
      checkout: [[id, 'main']],
      queued: [{ repo: id, branch: 'main' }],
      routine: [{ repo: id, branch: 'main' }],
      draft: [{ repo: id, branch: 'main' }],
      cwd: id,
    })
    expect(await named(Q)).toEqual(naming(WEB))
    expect(await named(P)).toEqual(naming(API))
    expect(await getSiteRow(site.id)).toMatchObject({
      repos: [{ repo: WEB, branch: 'main' }], releaseCommits: { [WEB]: 'a'.repeat(40) }, failedCommits: { [WEB]: 'b'.repeat(40) },
    })
    expect(await getWorkflow(runs.id)).toMatchObject({ repos: [WEB] })
    expect((await storeWorkflow(Q, { steps: { t: { run: ['make'] } }, secrets: [], repos: [WEB] })).id).toBe(runs.id)
    expect((await findNamedWorkflow(Q, 'clash'))?.workflow.id).toBe(held.id)
  })
})

describe('listWorkspaceRepos', () => {
  it('lists a workspace\'s checkouts by path, the root\'s first, and none for a workspace with no repos', async () => {
    await recordWorkspaceCreated({ projectId: P, workspaceId: 'wt-1', repos: [{ repoId: WEB, path: 'web' }, { repoId: API, path: 'api', baseBranch: 'main' }] })
    await recordWorkspaceCreated({ projectId: P, workspaceId: 'wt-2' })
    expect(await listWorkspaceRepos('wt-1')).toEqual([
      { workspaceId: 'wt-1', repoId: API, path: 'api', baseBranch: 'main' },
      { workspaceId: 'wt-1', repoId: WEB, path: 'web' },
    ])
    expect(await listWorkspaceRepos('wt-2')).toEqual([])
  })
})

describe('listWorkspaceReposFor', () => {
  it('groups the named workspaces\' checkouts by workspace', async () => {
    await recordWorkspaceCreated({ projectId: P, workspaceId: 'wt-1', repos: [{ repoId: API, path: '' }] })
    await recordWorkspaceCreated({ projectId: P, workspaceId: 'wt-2', repos: [{ repoId: API, path: 'api' }] })
    await recordWorkspaceCreated({ projectId: P, workspaceId: 'wt-3', repos: [{ repoId: WEB, path: '' }] })

    const found = await listWorkspaceReposFor(['wt-1', 'wt-2', 'wt-none'])
    expect([...found.keys()].sort()).toEqual(['wt-1', 'wt-2'])
    expect(found.get('wt-2')).toEqual([{ workspaceId: 'wt-2', repoId: API, path: 'api' }])
    expect(await listWorkspaceReposFor([])).toEqual(new Map())
  })
})

describe('listRepoHolders', () => {
  it('lists the workspaces holding a checkout of a repo, with their projects, until each is deleted', async () => {
    await recordWorkspaceCreated({ projectId: P, workspaceId: 'wt-1', repos: [{ repoId: API, path: '' }] })
    await recordWorkspaceCreated({ projectId: Q, workspaceId: 'wt-2', repos: [{ repoId: API, path: 'api' }, { repoId: WEB, path: 'web' }] })

    expect((await listRepoHolders(API)).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))).toEqual([
      { workspaceId: 'wt-1', projectId: P, path: '' },
      { workspaceId: 'wt-2', projectId: Q, path: 'api' },
    ])
    await deleteWorkspaceRecords(Q, 'wt-2')
    expect((await listRepoHolders(API)).map((h) => h.workspaceId)).toEqual(['wt-1'])
    expect(await listRepoHolders(WEB)).toEqual([])
  })
})

describe('listReleasedDeletedRepos', () => {
  it('lists a deleted repo only once no workspace holds a checkout of it', async () => {
    await repo(API)
    await repo(WEB)
    await recordWorkspaceCreated({ projectId: P, workspaceId: 'wt-1', repos: [{ repoId: API, path: '' }] })
    await markRepoDeleted(API)
    expect(await listReleasedDeletedRepos()).toEqual([])

    await deleteWorkspaceRecords(P, 'wt-1')
    expect((await listReleasedDeletedRepos()).map((r) => r.id)).toEqual([API])
  })
})

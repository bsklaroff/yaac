import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver, snapshotFixture } from '#test/support/fake-driver'
import type { CredentialBundle, RuntimeHandle } from '#drivers/contract'

// git is the process boundary. A move's check and push run for real,
// redirected to a local bare repository, and the fetch from the new remote
// is only recorded.
vi.mock('#domain/git', async (importOriginal) => {
  const actual = await importOriginal<typeof gitModule>()
  return {
    ...actual,
    checkMoveTarget: vi.fn(actual.checkMoveTarget),
    pushHostedRepo: vi.fn(actual.pushHostedRepo),
    fetchOrigin: vi.fn(() => Promise.resolve()),
  }
})

import { checkMoveTarget, fetchOrigin, pushHostedRepo } from '#domain/git'
import type * as gitModule from '#domain/git'
import { authorizeProject, isProjectHeld, systemPrincipal } from '#domain/access'
import {
  collectDeletedRepos,
  deleteRepo,
  moveRepoToRemote,
  previewRepoDelete,
  previewRepoMove,
  reconcileRevokedShares,
  unshareRepo,
} from '#domain/workspaces'
import { createHostedProject } from '#domain/projects'
import { resolveRepoCredential, shareRepo } from '#domain/repos'
import { addHttpsCredential, credentialOwnerKey } from '#domain/auth'
import { deleteWorkspaceRecords, listWorkspaceRows, recordWorkspaceCreated } from '#db/workspace-store'
import { clearAllProvisioningForTests, listProvisioning, provision } from '#domain/workspaces/provisioning'
import { getProjectRow } from '#db/project-store'
import { getRepo, linkProjectRepo, listRepoShares, listWorkspaceRepos, type RepoRow } from '#db/repo-store'
import { closeDb } from '#db/client'
import { hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { git } from '@yaac/test-utils/git'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { BUILT_IN_USER_ID, deleteSiteRow, findNamedWorkflow, insertNamedWorkflow, insertSite, seeTailnetUser, storeWorkflow } from '#db'

/** The caller of every user-caused write here: the repos' owner. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const ADA_PROJECT = '9c0d6b1e-2f3a-4b5c-8d7e-0f1a2b3c4d5e'
const KEEPER = '6cc61f49-c2ae-433a-8d09-1f22d7868752'

const mockList = vi.fn<(projectId?: string) => Promise<RuntimeHandle[]>>()
const mockDeregister = vi.fn<(workspaceId: string) => Promise<void>>()
/** The workspaces destroyed outright: reaped spares. */
const mockDestroy = vi.fn<(target: { workspaceId: string }) => Promise<boolean>>()
/** What the runtime was last handed to inject, by owner key. */
const mockSync = vi.fn<(bundles: Record<string, CredentialBundle>) => Promise<void>>()

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockList.mockReset().mockResolvedValue([])
  mockDeregister.mockReset().mockResolvedValue(undefined)
  mockDestroy.mockReset().mockResolvedValue(true)
  mockSync.mockReset().mockResolvedValue(undefined)
  clearAllProvisioningForTests()
  installFakeWorkspaceDriver({ list: mockList, deregisterWorkspace: mockDeregister, destroy: mockDestroy, syncCredentials: mockSync })
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** A running workspace of `projectId`. */
const running = (projectId: string, workspaceId: string): RuntimeHandle =>
  handleFixture({ jobName: `yaac-${workspaceId}`, workspaceId, projectId })

/** A workspace row holding a checkout of `repoId` at its root. */
const holding = (projectId: string, workspaceId: string, repoId: string): Promise<void> =>
  recordWorkspaceCreated({ projectId, workspaceId, repos: [{ repoId, path: '' }] })

const stoppedIds = async (): Promise<string[]> =>
  (await listWorkspaceRows()).filter((r) => r.stoppedAt !== undefined).map((r) => r.workspaceId).sort()

/**
 * A hosted repo of the built-in user's, in the project made with it, shared
 * with Ada, who links it into a project of her own. Answers the repo, both
 * project ids and Ada.
 */
async function sharedRepo(): Promise<{ repo: RepoRow; project: string; ada: string; adaActor: { kind: 'tailnet'; userId: string; login: string; name: string } }> {
  const { id: project } = await createHostedProject('widgets', BUILT_IN_USER_ID)
  const [{ repo }] = (await getProjectRow(project))?.repos ?? []
  const ada = await seeTailnetUser('ada@example.com', 'Ada')
  await shareRepo(local, repo.id, ada)
  await recordTestProject(ADA_PROJECT, { repo: false, owner: ada })
  await linkProjectRepo(ADA_PROJECT, repo.id, 'widgets')
  return { repo, project, ada, adaActor: { kind: 'tailnet', userId: ada, login: 'ada@example.com', name: 'Ada' } }
}

describe('unshareRepo', () => {
  it("ends the share and stops that user's workspaces holding the repo, keeping their rows and links, at the owner's word only", async () => {
    const { repo, project, ada, adaActor } = await sharedRepo()
    await holding(ADA_PROJECT, 'hers', repo.id)
    await recordWorkspaceCreated({ projectId: ADA_PROJECT, workspaceId: 'empty' })
    await holding(project, 'mine', repo.id)
    mockList.mockResolvedValue([
      running(ADA_PROJECT, 'hers'), running(ADA_PROJECT, 'empty'), running(project, 'mine'),
      { ...running(ADA_PROJECT, 'spare'), prewarmed: true },
    ])

    await expect(unshareRepo(adaActor, repo.id, ada)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await listRepoShares()).toEqual([{ repoId: repo.id, userId: ada }])

    await unshareRepo(local, repo.id, ada)

    expect(await listRepoShares()).toEqual([])
    // Only her workspace with a checkout of it: not the one without, not
    // the owner's, and the spare is the prewarm pool's to reap.
    expect(mockDeregister.mock.calls).toEqual([['hers']])
    await vi.waitFor(async () => expect(await stoppedIds()).toEqual(['hers']))
    // Her link and checkout stay, to work again if it is shared again.
    expect((await getProjectRow(ADA_PROJECT))?.repos.map((l) => l.repo.id)).toEqual([repo.id])
    expect(await listWorkspaceRepos('hers')).toHaveLength(1)
    await expect(unshareRepo(local, repo.id, ada)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('ends the share but says so when its workspaces cannot be stopped now', async () => {
    const { repo, ada } = await sharedRepo()
    await holding(ADA_PROJECT, 'hers', repo.id)
    mockList.mockRejectedValue(new Error('connection refused'))
    await expect(unshareRepo(local, repo.id, ada)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(await listRepoShares()).toEqual([])

    await shareRepo(local, repo.id, ada)
    mockList.mockResolvedValue([running(ADA_PROJECT, 'hers')])
    mockDeregister.mockRejectedValueOnce(new Error('exec failed'))
    await expect(unshareRepo(local, repo.id, ada)).rejects.toThrow(/could not be stopped yet/)
  })
})

describe('reconcileRevokedShares', () => {
  it('stops what still runs with a repo its project\'s owner may not use, and nothing else', async () => {
    const { repo, project, ada } = await sharedRepo()
    await holding(ADA_PROJECT, 'late', repo.id)
    await holding(ADA_PROJECT, 'stuck', repo.id)
    await holding(project, 'source', repo.id)
    const snapshot = snapshotFixture([
      running(ADA_PROJECT, 'late'),
      running(ADA_PROJECT, 'stuck'),
      { ...running(ADA_PROJECT, 'spare'), prewarmed: true },
      { ...running(ADA_PROJECT, 'going'), terminating: true },
      running(project, 'source'),
    ])

    await reconcileRevokedShares(snapshot)
    expect(mockDeregister).not.toHaveBeenCalled()

    // One failing to stop does not hold up the next.
    await unshareRepo(local, repo.id, ada).catch(() => {})
    mockDeregister.mockReset().mockImplementation((id) => id === 'stuck' ? Promise.reject(new Error('exec failed')) : Promise.resolve())
    await reconcileRevokedShares(snapshot)
    expect(mockDeregister.mock.calls.map(([id]) => id).sort()).toEqual(['late', 'stuck'])
  })

  // A deleted repo's checkouts keep running, with no remote.
  it('leaves a workspace holding a deleted repo running', async () => {
    const { repo } = await sharedRepo()
    await holding(ADA_PROJECT, 'hers', repo.id)
    await deleteRepo(local, repo.id)
    await reconcileRevokedShares(snapshotFixture([running(ADA_PROJECT, 'hers')]))
    expect(mockDeregister).not.toHaveBeenCalled()
  })
})

describe('moveRepoToRemote', () => {
  const GITHUB = 'https://github.com/acme/widgets.git'
  const ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }
  const actual = vi.importActual<typeof gitModule>('#domain/git')
  let remote: string
  let work: string
  let token: string
  /** What the move did, in order: git steps and workspace stops. */
  let events: string[]

  /** Push `main`, `feature` and tag `v1` to a hosted repo. */
  async function pushHistory(repoId: string): Promise<void> {
    await git(tmpDir, ['clone', '-q', hostedRepoDir(repoId), work])
    await git(work, ['commit', '-q', '--allow-empty', '-m', 'one'], { env: ENV })
    await git(work, ['tag', 'v1'])
    await git(work, ['push', '-q', 'origin', 'HEAD:main', 'HEAD:feature', 'v1'])
  }

  beforeEach(async () => {
    remote = path.join(tmpDir, 'github.git')
    work = path.join(tmpDir, 'work')
    events = []
    await git(tmpDir, ['init', '-q', '--bare', remote])
    token = (await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_move' })).id
    vi.mocked(checkMoveTarget).mockReset().mockImplementation(async (repo) => {
      events.push('check')
      await (await actual).checkMoveTarget(repo, remote, { kind: 'hosted' })
    })
    vi.mocked(pushHostedRepo).mockReset().mockImplementation(async (repo) => {
      events.push('push')
      await (await actual).pushHostedRepo(repo, remote, { kind: 'hosted' })
    })
    vi.mocked(fetchOrigin).mockClear()
    mockDeregister.mockImplementation((id) => { events.push(`stop ${id}`); return Promise.resolve() })
  })

  it('stops every workspace holding the repo, every user\'s, then pushes and moves it, ends its shares and gives each other user a repo of their own', async () => {
    const { repo, project, ada } = await sharedRepo()
    await pushHistory(repo.id)
    await holding(project, 'a', repo.id)
    await holding(ADA_PROJECT, 'b', repo.id)
    await recordWorkspaceCreated({ projectId: project, workspaceId: 'elsewhere' })
    const handles = [
      running(project, 'a'), running(ADA_PROJECT, 'b'), running(project, 'elsewhere'),
      { ...running(project, 'spare'), prewarmed: true },
    ]
    mockList.mockImplementation(() => Promise.resolve(handles))
    // A create in Ada's project starting with the repo, past its last
    // checkpoint, that comes up only once the move has stopped it.
    const late = provision({
      workspaceId: 'late', projectId: ADA_PROJECT, tool: 'claude', kind: 'create',
      selection: { repos: [{ repo: repo.id }], nested: false, cwd: repo.id },
    }, async () => {
      await vi.waitFor(() => expect(listProvisioning().find((e) => e.workspaceId === 'late')?.message).toBe('Stopping…'))
      await holding(ADA_PROJECT, 'late', repo.id)
      handles.push(running(ADA_PROJECT, 'late'))
      return { workspaceId: 'late' }
    })()
    // Held while it pushes: nothing starts in a project that links it, the
    // server's own launches included.
    vi.mocked(pushHostedRepo).mockImplementationOnce(async (dir) => {
      events.push('push')
      expect([isProjectHeld(project), isProjectHeld(ADA_PROJECT)]).toEqual([true, true])
      await expect(authorizeProject(systemPrincipal, ADA_PROJECT)).rejects.toMatchObject({ code: 'CONFLICT' })
      await (await actual).pushHostedRepo(dir, remote, { kind: 'hosted' })
    })

    expect(await moveRepoToRemote(local, repo.id, GITHUB, token)).toEqual({ knownHostsEntry: null })

    await late
    // The workspace with no checkout of it runs on.
    expect(events).toEqual(['check', 'stop a', 'stop b', 'stop late', 'push'])
    expect(await git(remote, ['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/feature\nrefs/heads/main\nrefs/tags/v1\n')
    const credential = { kind: 'https', token: 'ghp_move' }
    expect(vi.mocked(pushHostedRepo).mock.calls).toEqual([[hostedRepoDir(repo.id), GITHUB, credential]])
    const moved = await getRepo(repo.id)
    // yaac keeps its repository until the owner has checked the remote.
    expect(moved).toMatchObject({ remoteUrl: GITHUB, hosted: false, gitCredentialId: token, keepsHostedRepo: true })
    expect(await resolveRepoCredential(moved as RepoRow)).toEqual(credential)
    await expect(fs.access(hostedRepoDir(repo.id))).resolves.toBeUndefined()
    // The egress proxy is handed the repo's credential, so a restarted
    // workspace can push.
    expect(mockSync.mock.calls.at(-1)?.[0][credentialOwnerKey(BUILT_IN_USER_ID)].git).toMatchObject([{ token: 'ghp_move' }])
    // Ada's share is over, and what she had of the repo is a repo of her
    // own now: same remote, her own main clone, and no credential yet.
    expect(await listRepoShares()).toEqual([])
    const [hers] = (await getProjectRow(ADA_PROJECT))?.repos ?? []
    expect(hers).toMatchObject({ dir: 'widgets', repo: { owner: ada, remoteUrl: GITHUB, hosted: false, gitCredentialId: null } })
    expect(hers.repo.id).not.toBe(repo.id)
    await expect(fs.access(path.join(repoDir(hers.repo.id), '.git'))).resolves.toBeUndefined()
    expect((await listWorkspaceRepos('b')).map((c) => c.repoId)).toEqual([hers.repo.id])
    expect((await listWorkspaceRepos('a')).map((c) => c.repoId)).toEqual([repo.id])
    expect((await getProjectRow(project))?.repos.map((l) => l.repo.id)).toEqual([repo.id])
    await vi.waitFor(() => expect(fetchOrigin).toHaveBeenCalledWith(repoDir(repo.id), GITHUB, credential))
    // The workspaces stop with their checkouts kept; the spare is reaped.
    await vi.waitFor(async () => expect(await stoppedIds()).toEqual(['a', 'b', 'late']))
    await vi.waitFor(() => expect([...new Set(mockDestroy.mock.calls.map(([t]) => t.workspaceId))]).toEqual(['spare']))
    // The hold is lifted, and it has moved.
    await expect(authorizeProject(local, project)).resolves.toBeUndefined()
    await expect(moveRepoToRemote(local, repo.id, GITHUB, token)).rejects.toThrow(/is not hosted by yaac/)
  })

  it("is the owner's alone, and stays on yaac, stopping nothing, unless the remote is empty, until everything is pushed", async () => {
    const { repo, project, adaActor } = await sharedRepo()
    await pushHistory(repo.id)
    await expect(moveRepoToRemote(adaActor, repo.id, GITHUB, token)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(moveRepoToRemote(local, repo.id, 'git@github.com:acme/widgets.git', token))
      .rejects.toThrow(/needs an SSH key, not a token/)
    await recordTestProject(KEEPER)
    await expect(moveRepoToRemote(local, KEEPER, GITHUB, token)).rejects.toThrow(/is not hosted by yaac/)
    await holding(project, 'a', repo.id)
    mockList.mockResolvedValue([running(project, 'a')])
    const stillHosted = async (): Promise<void> => {
      expect(await getRepo(repo.id)).toMatchObject({ hosted: true })
      await expect(fs.access(hostedRepoDir(repo.id))).resolves.toBeUndefined()
      await expect(authorizeProject(local, project)).resolves.toBeUndefined()
      expect(await listRepoShares()).toHaveLength(1)
    }

    // A host the owner's project's workspaces may not reach, until it is
    // allowed.
    await expect(moveRepoToRemote(local, repo.id, 'https://git.example.test/acme/widgets.git', token))
      .rejects.toThrow(/"git.example.test" is not in the egress allowlist of "widgets"/)
    expect(events).toEqual([])
    await stillHosted()

    // A repository the host started with a README: refused before
    // anything stops.
    const readme = path.join(tmpDir, 'readme')
    await git(tmpDir, ['init', '-q', '-b', 'main', readme])
    await git(readme, ['commit', '-q', '--allow-empty', '-m', 'README'], { env: ENV })
    await git(readme, ['push', '-q', remote, 'HEAD:main'])
    await expect(moveRepoToRemote(local, repo.id, GITHUB, token)).rejects.toThrow(/did not move: .*its refs\/heads\/main has commits/)
    expect(events).toEqual(['check'])
    await stillHosted()
    await git(remote, ['update-ref', '-d', 'refs/heads/main'])

    // A workspace that will not stop: nothing is pushed.
    events = []
    mockDeregister.mockRejectedValueOnce(new Error('exec failed'))
    await expect(moveRepoToRemote(local, repo.id, GITHUB, token)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(events).toEqual(['check'])
    await stillHosted()

    // A push that fails partway: still on yaac, and a retry finishes it.
    events = []
    vi.mocked(pushHostedRepo).mockImplementationOnce(async (dir) => {
      events.push('push')
      await git(dir, ['push', '-q', remote, 'refs/heads/main:refs/heads/main'])
      throw new Error('remote: Permission to acme/widgets.git denied to bot.')
    })
    await expect(moveRepoToRemote(local, repo.id, GITHUB, token)).rejects.toThrow(/did not move: git authentication failed/)
    expect(events).toEqual(['check', 'stop a', 'push'])
    await stillHosted()
    // Work goes on before the retry.
    await git(work, ['commit', '-q', '--allow-empty', '-m', 'two'], { env: ENV })
    await git(work, ['push', '-q', 'origin', 'HEAD:main'])
    await moveRepoToRemote(local, repo.id, GITHUB, token)
    expect((await git(remote, ['rev-parse', 'main'])).trim()).toBe((await git(work, ['rev-parse', 'HEAD'])).trim())
    expect(await getRepo(repo.id)).toMatchObject({ hosted: false, remoteUrl: GITHUB })
  })
})

describe('previewRepoMove', () => {
  it('counts the running workspaces holding the repo, and names whom it is shared with, for its owner', async () => {
    const { repo, project, adaActor } = await sharedRepo()
    await holding(project, 'a', repo.id)
    await holding(ADA_PROJECT, 'b', repo.id)
    await recordWorkspaceCreated({ projectId: project, workspaceId: 'elsewhere' })
    await recordTestProject(KEEPER)
    mockList.mockResolvedValue([
      running(project, 'a'),
      running(ADA_PROJECT, 'b'),
      running(project, 'elsewhere'),
      { ...running(project, 'spare'), prewarmed: true },
      { ...running(project, 'going'), terminating: true },
    ])

    expect(await previewRepoMove(local, repo.id)).toEqual({ runningWorkspaces: 2, sharedWith: ['ada@example.com'] })
    await expect(previewRepoMove(adaActor, repo.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(previewRepoMove(local, KEEPER)).rejects.toThrow(/is not hosted by yaac/)
  })
})

describe('previewRepoDelete', () => {
  it('says what a delete would reach: the projects linking it and the workspaces holding it, any user\'s', async () => {
    const { repo, project, ada, adaActor } = await sharedRepo()
    await holding(ADA_PROJECT, 'hers', repo.id)

    expect(await previewRepoDelete(local, repo.id)).toEqual({
      hosted: true,
      projects: [
        { id: ADA_PROJECT, name: 'demo', owner: ada },
        { id: project, name: 'widgets', owner: BUILT_IN_USER_ID },
      ],
      heldBy: [{ workspaceId: 'hers', projectId: ADA_PROJECT, projectName: 'demo', owner: ada }],
    })
    await expect(previewRepoDelete(adaActor, repo.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('deleteRepo', () => {
  it('unlinks it everywhere, ends its shares and deletes the hosted repository, keeping the main clone while a workspace holds a checkout', async () => {
    const { repo, project, ada, adaActor } = await sharedRepo()
    await holding(ADA_PROJECT, 'hers', repo.id)
    mockList.mockResolvedValue([running(ADA_PROJECT, 'hers')])

    await expect(deleteRepo(adaActor, repo.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // A site built from it keeps it: its next release would have no repo.
    await insertNamedWorkflow(project, 'serve', (await storeWorkflow(project, { steps: {}, secrets: [] })).id)
    const site = await insertSite({
      projectId: project, name: 'www', hostname: 'www.example.com', port: 80, repoId: repo.id,
      namedWorkflowId: (await findNamedWorkflow(project, 'serve'))?.id ?? '',
    })
    await expect(deleteRepo(local, repo.id)).rejects.toMatchObject({ code: 'CONFLICT', message: /site "www"/ })
    await deleteSiteRow(site.id)
    // A create in flight that starts with it is stopped, rather than left to
    // fetch a repo that is gone.
    const starting = provision({
      workspaceId: 'starting', projectId: project, tool: 'claude', kind: 'create',
      selection: { repos: [{ repo: repo.id }], nested: false, cwd: repo.id },
    }, async () => {
      await vi.waitFor(() => expect(listProvisioning().find((e) => e.workspaceId === 'starting')?.message).toBe('Stopping…'))
      throw new Error('stopped')
    })()
    starting.catch(() => { /* asserted below */ })
    expect(await deleteRepo(local, repo.id)).toEqual({
      heldBy: [{ workspaceId: 'hers', projectId: ADA_PROJECT, projectName: 'demo', owner: ada }],
    })

    await expect(starting).rejects.toThrow()

    // Both projects stay, with no link to it, and no workspace is stopped
    // or deleted.
    expect((await getProjectRow(project))?.repos).toEqual([])
    expect((await getProjectRow(ADA_PROJECT))?.repos).toEqual([])
    expect(await listRepoShares()).toEqual([])
    expect(mockDeregister).not.toHaveBeenCalled()
    expect(await listWorkspaceRepos('hers')).toHaveLength(1)
    await expect(fs.access(hostedRepoDir(repo.id))).rejects.toThrow()
    // Her checkout borrows its objects, so the clone and the row wait.
    await expect(fs.access(repoDir(repo.id))).resolves.toBeUndefined()
    expect((await getRepo(repo.id))?.deletedAt).toBeInstanceOf(Date)
  })

  it('removes the main clone and the row at once when no workspace holds a checkout', async () => {
    const { repo } = await sharedRepo()
    expect(await deleteRepo(local, repo.id)).toEqual({ heldBy: [] })
    expect(await getRepo(repo.id)).toBeUndefined()
    await expect(fs.access(repoDir(repo.id))).rejects.toThrow()
    await expect(deleteRepo(local, repo.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('collectDeletedRepos', () => {
  it('removes a deleted repo\'s main clone and row once the last workspace holding it is deleted', async () => {
    const { repo } = await sharedRepo()
    await holding(ADA_PROJECT, 'hers', repo.id)
    await deleteRepo(local, repo.id)

    await collectDeletedRepos()
    expect(await getRepo(repo.id)).toBeDefined()

    await deleteWorkspaceRecords(ADA_PROJECT, 'hers')
    await collectDeletedRepos()
    expect(await getRepo(repo.id)).toBeUndefined()
    await expect(fs.access(repoDir(repo.id))).rejects.toThrow()
  })
})

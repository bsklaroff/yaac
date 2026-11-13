import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'

// Only the clone (a process boundary) is mocked; a hosted repo's is real.
vi.mock('#domain/git', async (importOriginal) => ({
  ...(await importOriginal<typeof gitModule>()),
  cloneRepo: vi.fn(),
}))

import { cloneRepo } from '#domain/git'
import type * as gitModule from '#domain/git'
import {
  addProjectRepo,
  createWorkflow,
  deleteWorkflow,
  projectRepo,
  removeProjectRepo,
  reorderProjectRepos,
  repoOfProject,
  resolveWorkflow,
  updateProjectRepoLink,
} from '#domain/projects'
import { addHttpsCredential } from '#domain/auth'
import {
  addRepoShare,
  applyWorkspaceEvent,
  BUILT_IN_USER_ID,
  closeDb,
  deleteSiteRow,
  getProjectRow,
  getRepo,
  insertRepo,
  insertSite,
  listProjectSites,
  listRepos,
  listWorkspaceRepos,
  markRepoDeleted,
  seeTailnetUser,
  updateSite,
  type ProjectRow,
} from '#db'
import { MAX_PROJECT_REPOS } from '@yaac/shared/types'
import { hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { recordTestProject } from '@yaac/test-utils/project-fixture'

const mockClone = vi.mocked(cloneRepo)
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

/** A project that links one repo of its own id, under `api`; and one with
 *  no repos. */
const PROJECT = '0a0a0a0a-0000-4000-8000-000000000001'
const EMPTY = '0a0a0a0a-0000-4000-8000-000000000002'
const MISSING = '0a0a0a0a-0000-4000-8000-0000000000ee'

let tmpDir: string
let token: string

const project = async (id = PROJECT): Promise<ProjectRow> => (await getProjectRow(id)) as ProjectRow
const dirs = async (id = PROJECT): Promise<string[]> => (await project(id)).repos.map((l) => l.dir)

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  installFakeWorkspaceDriver()
  token = (await addHttpsCredential(BUILT_IN_USER_ID, { name: 'default', token: 'ghp_default' })).id
  mockClone.mockReset()
  mockClone.mockImplementation(async (_url, dest) => {
    await fs.mkdir(path.join(dest, '.git'), { recursive: true })
  })
  await recordTestProject(PROJECT, { remoteUrl: 'https://github.com/acme/api.git', name: 'api' })
  await recordTestProject(EMPTY, { repo: false, name: 'empty' })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('addProjectRepo', () => {
  it('links a remote by URL, cloning it unless its owner has it, under a folder named for the repo', async () => {
    const added = await addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/acme/Web-App.git', credentialId: token })

    expect(added).toMatchObject({ dir: 'web-app', knownHostsEntry: null })
    expect(mockClone).toHaveBeenCalledWith('https://github.com/acme/Web-App.git', repoDir(added.repoId), { kind: 'https', token: 'ghp_default' }, undefined)
    expect(await dirs()).toEqual(['api', 'web-app'])
    expect((await project()).repos[1]).toMatchObject({
      readOnly: false, ghToken: true, lastIncluded: true, repo: { id: added.repoId, gitCredentialId: token },
    })

    // The same remote in another project is the same repo, not a second clone.
    const again = await addProjectRepo(local, EMPTY, { remoteUrl: 'https://github.com/acme/Web-App.git', credentialId: token })
    expect(again.repoId).toBe(added.repoId)
    expect(mockClone).toHaveBeenCalledTimes(1)
    // A project links a repo once.
    await expect(addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/acme/Web-App.git', credentialId: token }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a folder or a repo another link took while it cloned, rather than failing on the insert', async () => {
    // Two links into one project, each holding its clone open until let go.
    const finish = new Map<string, () => void>()
    mockClone.mockImplementation(async (url, dest) => {
      await fs.mkdir(path.join(dest, '.git'), { recursive: true })
      await new Promise<void>((resolve) => { finish.set(url, resolve) })
    })
    const web = addProjectRepo(local, EMPTY, { remoteUrl: 'https://github.com/acme/web.git', credentialId: token }, 'app')
    const lib = addProjectRepo(local, EMPTY, { remoteUrl: 'https://github.com/acme/lib.git', credentialId: token }, 'app')
    await vi.waitFor(() => expect(finish.size).toBe(2))
    // The same remote again shares the first clone, so it waits for it.
    const webAgain = addProjectRepo(local, EMPTY, { remoteUrl: 'https://github.com/acme/web.git', credentialId: token })
    finish.get('https://github.com/acme/web.git')?.()
    expect(await web).toMatchObject({ dir: 'app' })
    finish.get('https://github.com/acme/lib.git')?.()
    await expect(lib).rejects.toThrow(/already has a repo in "app"/)
    await expect(webAgain).rejects.toThrow(/already links that repo/)
    expect(await dirs(EMPTY)).toEqual(['app'])
    expect(mockClone).toHaveBeenCalledTimes(2)

    // Either refusal comes before any clone when the project already shows it.
    await expect(addProjectRepo(local, EMPTY, { remoteUrl: 'https://github.com/acme/docs.git', credentialId: token }, 'app'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(addProjectRepo(local, EMPTY, { remoteUrl: 'https://github.com/acme/web.git', credentialId: token }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mockClone).toHaveBeenCalledTimes(2)
  })

  it('adds a repo\'s host to the allowlist when the list leaves it out, and only behind an egress proxy', async () => {
    const allowlist = async (id: string) => (await project(id)).egressAllowlist
    // github.com is a default host.
    expect(await addProjectRepo(local, EMPTY, { remoteUrl: 'https://github.com/acme/web.git', credentialId: token }))
      .toMatchObject({ allowedHost: null })
    expect(await addProjectRepo(local, EMPTY, { remoteUrl: 'https://Git.Example.com/acme/lib.git', credentialId: token }))
      .toMatchObject({ allowedHost: 'git.example.com' })
    expect(await addProjectRepo(local, EMPTY, { remoteUrl: 'https://git.example.com/acme/docs.git', credentialId: token }))
      .toMatchObject({ allowedHost: null })
    expect(await addProjectRepo(local, EMPTY, { hosted: true })).toMatchObject({ allowedHost: null })
    expect(await allowlist(EMPTY)).toEqual({ hosts: ['git.example.com'], defaults: true })

    installFakeWorkspaceDriver({ kind: 'containerless' })
    expect(await addProjectRepo(local, PROJECT, { remoteUrl: 'https://other.example.com/acme/x.git', credentialId: token }))
      .toMatchObject({ allowedHost: null })
    expect(await allowlist(PROJECT)).toEqual({ hosts: [], defaults: true })
  })

  it('names the folder as asked, else free of the ones taken, and refuses a name that is no folder or is in use', async () => {
    // A second repo whose name is taken gets a suffix.
    const other = await addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/other/api.git', credentialId: token })
    expect(other.dir).toBe('api-2')
    const named = await addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/acme/docs.git', credentialId: token }, 'Docs_v2.x')
    expect(named.dir).toBe('Docs_v2.x')

    const before = (await listRepos()).length
    for (const bad of ['', '.', '..', 'a/b', 'with space', 'x'.repeat(101)]) {
      await expect(addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/acme/more.git', credentialId: token }, bad))
        .rejects.toMatchObject({ code: 'VALIDATION' })
    }
    await expect(addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/acme/more.git', credentialId: token }, 'api'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    // Refused before anything is cloned.
    expect(await listRepos()).toHaveLength(before)
    expect(await dirs()).toEqual(['api', 'api-2', 'Docs_v2.x'])
  })

  it('links a repo by id that the project\'s owner may use: their own, or one shared with them', async () => {
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    const mine = await insertRepo({ id: '0a0a0a0a-0000-4000-8000-00000000000a', owner: BUILT_IN_USER_ID, remoteUrl: 'git@git.example.com:acme/lib.git' })
    const hers = await insertRepo({ id: '0a0a0a0a-0000-4000-8000-00000000000b', owner: ada, remoteUrl: 'http://yaac.internal/api/workspace/git/x.git', hosted: true })

    expect(await addProjectRepo(local, PROJECT, { repoId: mine.id }))
      .toEqual({ repoId: mine.id, dir: 'lib', knownHostsEntry: null, allowedHost: 'git.example.com' })
    await expect(addProjectRepo(local, PROJECT, { repoId: hers.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await addRepoShare(hers.id, BUILT_IN_USER_ID)
    // A hosted repo has no name of its own, so it takes the project's.
    expect(await addProjectRepo(local, EMPTY, { repoId: hers.id })).toMatchObject({ repoId: hers.id, dir: 'empty' })
    expect(await addProjectRepo(local, PROJECT, { repoId: hers.id })).toMatchObject({ dir: 'api-2' })

    await expect(addProjectRepo(local, PROJECT, { repoId: MISSING })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(addProjectRepo(local, PROJECT, { repoId: 'lib' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await markRepoDeleted(mine.id)
    await expect(addProjectRepo(local, EMPTY, { repoId: mine.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mockClone).not.toHaveBeenCalled()
  })

  it('links a new repo yaac hosts', async () => {
    const real = await vi.importActual<typeof gitModule>('#domain/git')
    mockClone.mockImplementation(real.cloneRepo)

    const added = await addProjectRepo(local, EMPTY, { hosted: true })

    expect(added).toMatchObject({ dir: 'empty', knownHostsEntry: null })
    expect(await getRepo(added.repoId)).toMatchObject({ hosted: true, owner: BUILT_IN_USER_ID })
    await expect(fs.access(hostedRepoDir(added.repoId))).resolves.toBeUndefined()
    expect(await dirs(EMPTY)).toEqual(['empty'])
  })

  it('is the project owner\'s alone, up to the most repos a project links', async () => {
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    await expect(addProjectRepo({ kind: 'local', userId: ada }, PROJECT, { hosted: true })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(addProjectRepo(local, MISSING, { hosted: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    for (let n = 1; n < MAX_PROJECT_REPOS; n++) {
      await addProjectRepo(local, PROJECT, { remoteUrl: `https://github.com/acme/r${n}.git`, credentialId: token })
    }
    await expect(addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/acme/one-more.git', credentialId: token }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/at most/) as string })
  })
})

describe('removeProjectRepo', () => {
  it('unlinks the repo, by folder or id, leaving the repo and every checkout of it', async () => {
    const { repoId } = await addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/acme/web.git', credentialId: token })
    await applyWorkspaceEvent({
      type: 'workspace-created', projectId: PROJECT, workspaceId: 'w1', repos: [{ repoId: PROJECT, path: 'api' }, { repoId, path: 'web' }], cwd: '',
    })

    // A site built from the repo keeps it linked: its next release would
    // have nothing to start with.
    await createWorkflow(local, PROJECT, { name: 'serve', steps: {} })
    const site = await insertSite({
      projectId: PROJECT, name: 'www', hostname: 'www.example.com', port: 80, repos: [{ repo: repoId, branch: 'main' }], follow: false,
      namedWorkflowId: (await resolveWorkflow(PROJECT, 'serve')).id,
    })
    await expect(removeProjectRepo(local, PROJECT, 'web')).rejects.toMatchObject({ code: 'CONFLICT', message: /site "www"/ })
    await deleteSiteRow(site.id)
    // So does a named workflow that runs in it: every later launch of it
    // would be refused, an init workflow's skipped.
    await createWorkflow(local, PROJECT, { name: 'web-init', steps: {}, repos: ['web'], init: true })
    await expect(removeProjectRepo(local, PROJECT, 'web')).rejects.toMatchObject({ code: 'CONFLICT', message: /workflow "web-init"/ })
    await deleteWorkflow(local, PROJECT, 'web-init')

    await removeProjectRepo(local, PROJECT, 'web')
    await removeProjectRepo(local, PROJECT, PROJECT)

    expect(await dirs()).toEqual([])
    expect((await listRepos()).map((r) => r.id).sort()).toEqual([PROJECT, repoId].sort())
    expect(await listWorkspaceRepos('w1')).toHaveLength(2)
    await expect(removeProjectRepo(local, PROJECT, 'web')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    await expect(removeProjectRepo({ kind: 'local', userId: ada }, EMPTY, 'x')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('updateProjectRepoLink', () => {
  it('renames a link\'s folder and sets its flags, which a containerless install has none of', async () => {
    await addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/acme/web.git', credentialId: token })

    await updateProjectRepoLink(local, PROJECT, 'web', { dir: 'frontend', readOnly: true, ghToken: false })
    expect((await project()).repos[1]).toMatchObject({ dir: 'frontend', readOnly: true, ghToken: false })
    // Renaming to itself is no clash; to a taken or unusable name is.
    await updateProjectRepoLink(local, PROJECT, 'frontend', { dir: 'frontend', readOnly: false })
    expect((await project()).repos[1]).toMatchObject({ dir: 'frontend', readOnly: false, ghToken: false })
    await expect(updateProjectRepoLink(local, PROJECT, 'frontend', { dir: 'api' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(updateProjectRepoLink(local, PROJECT, 'frontend', { dir: '../up' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(updateProjectRepoLink(local, PROJECT, 'gone', { dir: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    await expect(updateProjectRepoLink({ kind: 'local', userId: ada }, PROJECT, 'api', { readOnly: true }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })

    // Without a sandbox a workspace holds every credential, so neither flag
    // could promise anything; the folder name still changes.
    installFakeWorkspaceDriver({ kind: 'containerless' })
    for (const flags of [{ readOnly: true }, { ghToken: true }]) {
      await expect(updateProjectRepoLink(local, PROJECT, 'api', flags)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    }
    await updateProjectRepoLink(local, PROJECT, 'api', { dir: 'backend' })
    expect((await project()).repos[0]).toMatchObject({ dir: 'backend', readOnly: false, ghToken: true })

    // A site of several repos keeps each in its folder, which its steps
    // name, so the folder is not renamed under it.
    await createWorkflow(local, PROJECT, { name: 'serve', steps: {} })
    await insertSite({
      projectId: PROJECT, name: 'www', hostname: 'www.example.com', port: 80, follow: false,
      repos: [{ repo: PROJECT, branch: 'main' }, { repo: (await project()).repos[1].repo.id, branch: 'main' }],
      namedWorkflowId: (await resolveWorkflow(PROJECT, 'serve')).id,
    })
    await expect(updateProjectRepoLink(local, PROJECT, 'backend', { dir: 'server' })).rejects.toMatchObject({ code: 'CONFLICT', message: /site "www"/ })
    // Edited down to one repo, its last release still nests the repo, which
    // a replacement repeats.
    const www = (await listProjectSites(PROJECT))[0]
    await updateSite(www.id, {
      repos: [{ repo: PROJECT, branch: 'main' }],
      releaseCommits: { [PROJECT]: 'a'.repeat(40), [(await project()).repos[1].repo.id]: 'b'.repeat(40) },
    })
    await expect(updateProjectRepoLink(local, PROJECT, 'backend', { dir: 'server' })).rejects.toMatchObject({ code: 'CONFLICT', message: /site "www"/ })
    await updateSite(www.id, { releaseCommits: { [PROJECT]: 'a'.repeat(40) } })
    await updateProjectRepoLink(local, PROJECT, 'backend', { dir: 'server' })
  })
})

describe('reorderProjectRepos', () => {
  it('lists the project\'s repos in the order named, by folder or id, any left out following', async () => {
    const web = await addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/acme/web.git', credentialId: token })
    await addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/acme/docs.git', credentialId: token })
    expect(await dirs()).toEqual(['api', 'web', 'docs'])

    await reorderProjectRepos(local, PROJECT, ['docs', web.repoId, 'api'])
    expect(await dirs()).toEqual(['docs', 'web', 'api'])
    await reorderProjectRepos(local, PROJECT, ['api'])
    expect((await dirs())[0]).toBe('api')

    await expect(reorderProjectRepos(local, PROJECT, ['api', 'nope'])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    await expect(reorderProjectRepos({ kind: 'local', userId: ada }, PROJECT, ['api'])).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('projectRepo', () => {
  it('finds a link by its folder, then by its repo\'s id', async () => {
    const { repoId } = await addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/acme/web.git', credentialId: token })
    // A folder may be named as another repo's id is; the folder wins.
    await updateProjectRepoLink(local, PROJECT, 'api', { dir: repoId })
    const row = await project()

    expect(projectRepo(row, 'web').repo.id).toBe(repoId)
    expect(projectRepo(row, PROJECT).dir).toBe(repoId)
    expect(projectRepo(row, repoId).repo.id).toBe(PROJECT)
    expect(() => projectRepo(row, 'nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }) as Error)
  })
})

describe('repoOfProject', () => {
  it('means the named repo, or a project\'s only one, and asks which when there are several or none', async () => {
    expect(repoOfProject(await project()).dir).toBe('api')
    const empty = await project(EMPTY)
    expect(() => repoOfProject(empty)).toThrow(/has no repos/)

    await addProjectRepo(local, PROJECT, { remoteUrl: 'https://github.com/acme/web.git', credentialId: token })
    const row = await project()
    expect(repoOfProject(row, 'web').dir).toBe('web')
    expect(() => repoOfProject(row)).toThrow(expect.objectContaining({
      code: 'VALIDATION', message: expect.stringMatching(/several repos; name one of: api, web/) as string,
    }) as Error)
    expect(() => repoOfProject(row, 'nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }) as Error)
  })
})

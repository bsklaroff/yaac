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
import { moveProjectToRemote, previewProjectMove, reconcileRevokedShares, removeProject, unshareProject } from '#domain/workspaces'
import { createHostedProject, resolveProjectCredential, shareProject } from '#domain/projects'
import { addHttpsCredential, credentialOwnerKey } from '#domain/auth'
import { listWorkspaceRows, recordWorkspaceCreated } from '#db/workspace-store'
import { clearAllProvisioningForTests, listProvisioning, provision } from '#domain/workspaces/provisioning'
import { getProjectRow, listProjectRows, recordProject, setProjectShareRevoked } from '#db/project-store'
import { listProjectEnvVars, upsertProjectEnvVar } from '#db/project-env-store'
import { closeDb } from '#db/client'
import { hostedRepoDir, nodeLocalProjectPath, projectDir, repoDir } from '@yaac/shared/project-paths'
import { git } from '@yaac/test-utils/git'
import { getProjectsDir } from '@yaac/shared/paths'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import { BUILT_IN_USER_ID, seeTailnetUser } from '#db'
import { removeAsRoot } from '#drivers/k8s/workspaces'
import { appliedRootPods, podsRunAsRoot } from '#test/support/root-pods'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const KEEPER = '6cc61f49-c2ae-433a-8d09-1f22d7868752'
const NOPE = '4101bef8-794f-4d98-8e95-dfb54850c68b'
const SHARE = '9c0d6b1e-2f3a-4b5c-8d7e-0f1a2b3c4d5e'

/** `DEMO_PROJECT_ID` as a hosted project of the built-in user's, shared
 *  with a tailnet user as `SHARE`. Answers that user's id. */
async function recordShared(): Promise<string> {
  await recordTestProject(DEMO_PROJECT_ID, { remoteUrl: `http://yaac.internal/api/workspace/git/${DEMO_PROJECT_ID}.git` })
  const recipient = await seeTailnetUser('ada@example.com', 'Ada')
  await fs.mkdir(projectDir(SHARE), { recursive: true })
  await recordProject({
    id: SHARE, name: 'demo', remoteUrl: `http://yaac.internal/api/workspace/git/${SHARE}.git`, addedAt: 'now', hosted: true, sharedFrom: DEMO_PROJECT_ID,
  }, recipient)
  return recipient
}

/** The projects whose substrate the purge dropped, and the rows that
 *  existed at the time, so a test can check the purge runs before the rows
 *  are deleted. */
const purged: string[] = []
let rowsAtPurge: string[] = []
/** The project's running workspaces, and the ones torn down. */
const mockList = vi.fn<(projectId?: string) => Promise<RuntimeHandle[]>>()
const mockDeregister = vi.fn<(workspaceId: string) => Promise<void>>()
/** The workspaces destroyed outright: reaped spares. */
const mockDestroy = vi.fn<(target: { workspaceId: string }) => Promise<boolean>>()
/** What the runtime was last handed to inject, by owner key. */
const mockSync = vi.fn<(bundles: Record<string, CredentialBundle>) => Promise<void>>()

let tmpDir: string

function installDriver(destroySubstrate?: () => Promise<void>): void {
  installFakeWorkspaceDriver({
    list: mockList,
    deregisterWorkspace: mockDeregister,
    destroy: mockDestroy,
    syncCredentials: mockSync,
    destroyProjectSubstrate: async (project) => {
      purged.push(project)
      rowsAtPurge = (await listWorkspaceRows()).map((r) => r.workspaceId)
      await destroySubstrate?.()
    },
  })
}

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  purged.length = 0
  rowsAtPurge = []
  mockList.mockReset().mockResolvedValue([])
  mockDeregister.mockReset().mockResolvedValue(undefined)
  mockDestroy.mockReset().mockResolvedValue(true)
  mockSync.mockReset().mockResolvedValue(undefined)
  installDriver()
})

/** A running workspace of `projectId`. */
const running = (projectId: string, workspaceId: string): RuntimeHandle =>
  handleFixture({ jobName: `yaac-${workspaceId}`, workspaceId, projectId })

afterEach(async () => {
  await fs.chmod(getProjectsDir(), 0o755).catch(() => {})
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('removeProject', () => {
  it('tears its workspaces down and erases its bytes, then drops only this project’s rows', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordTestProject(KEEPER)
    for (const projectId of [DEMO_PROJECT_ID, KEEPER]) {
      await fs.mkdir(path.join(nodeLocalProjectPath(projectId), 'repo'), { recursive: true })
    }
    mockList.mockResolvedValue([running(DEMO_PROJECT_ID, 'a'), running(DEMO_PROJECT_ID, 'b')])
    // One teardown failing does not stop the rest.
    mockDeregister.mockRejectedValueOnce(new Error('exec failed'))
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'a' })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'b' })
    await recordWorkspaceCreated({ projectId: KEEPER, workspaceId: 'c' })
    await upsertProjectEnvVar(DEMO_PROJECT_ID, { name: 'MINE', value: 'x', secret: false })
    await upsertProjectEnvVar(KEEPER, { name: 'THEIRS', value: 'y', secret: false })

    await removeProject(local, DEMO_PROJECT_ID)

    // First argument only: the fake records a trailing undefined opts.
    expect(mockList.mock.calls.map(([projectId]) => projectId)).toEqual([DEMO_PROJECT_ID])
    expect(mockDeregister.mock.calls).toEqual([['a'], ['b']])
    expect(purged).toEqual([DEMO_PROJECT_ID])
    await expect(fs.access(projectDir(DEMO_PROJECT_ID))).rejects.toThrow()
    await expect(fs.access(projectDir(KEEPER))).resolves.toBeUndefined()
    // The node-local tree is the driver's to remove; it may live on another
    // machine.
    await expect(fs.access(nodeLocalProjectPath(DEMO_PROJECT_ID))).resolves.toBeUndefined()
    // Bytes go first. If rows went first and the purge then failed, the
    // leftover clone could not be listed, removed or re-added.
    expect(rowsAtPurge.sort()).toEqual(['a', 'b', 'c'])
    // Only this project's rows go.
    expect((await listWorkspaceRows()).map((r) => r.workspaceId)).toEqual(['c'])
    expect((await listProjectRows()).map((p) => p.id)).toEqual([KEEPER])
    // Its env vars go too; some are secrets, so this cannot wait for the
    // reaper.
    expect(await listProjectEnvVars(DEMO_PROJECT_ID)).toEqual([])
    expect((await listProjectEnvVars(KEEPER)).map((v) => v.name)).toEqual(['THEIRS'])
  })

  // Best effort: an unreachable runtime must not keep the directories
  // around. The orphan GCs sweep whatever is left.
  it('still erases the dirs when the runtime is unreachable', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    mockList.mockRejectedValue(new Error('connection refused'))
    installDriver(() => Promise.reject(new Error('connection refused')))

    await removeProject(local, DEMO_PROJECT_ID)

    expect(mockDeregister).not.toHaveBeenCalled()
    await expect(fs.access(projectDir(DEMO_PROJECT_ID))).rejects.toThrow()
    expect(await listProjectRows()).toEqual([])
  })

  it('throws NOT_FOUND for an unknown project, touching nothing', async () => {
    await expect(removeProject(local, NOPE)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual([])
  })

  // A failed purge keeps the rows so `project remove` can be retried.
  it('keeps the rows when the purge cannot erase the bytes', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'a' })
    // The project tree cannot be removed from a read-only parent.
    await fs.chmod(getProjectsDir(), 0o555)

    await expect(removeProject(local, DEMO_PROJECT_ID)).rejects.toThrow(/EACCES/)

    expect((await listWorkspaceRows()).map((r) => r.workspaceId)).toEqual(['a'])
    expect((await listProjectRows()).map((p) => p.id)).toEqual([DEMO_PROJECT_ID])
  })

  it('hands a tree the server cannot remove to a root pod', async () => {
    installFakeWorkspaceDriver({ list: mockList, removeAsRoot })
    podsRunAsRoot('Succeeded')
    await recordTestProject(DEMO_PROJECT_ID)
    await recordTestProject(KEEPER)
    // As a root-owned dir a workspace left in its checkout.
    const rootDir = path.join(projectDir(DEMO_PROJECT_ID), 'workspaces', 'a', 'rootdir')
    await fs.mkdir(rootDir, { recursive: true })
    await fs.writeFile(path.join(rootDir, 'x'), 'x')
    await fs.chmod(rootDir, 0o555)

    await removeProject(local, DEMO_PROJECT_ID)

    await expect(fs.access(projectDir(DEMO_PROJECT_ID))).rejects.toThrow()
    await expect(fs.access(projectDir(KEEPER))).resolves.toBeUndefined()
    expect(appliedRootPods()).toEqual([{ subPath: 'projects', names: [DEMO_PROJECT_ID], runAsUser: 0 }])
    expect((await listProjectRows()).map((p) => p.id)).toEqual([KEEPER])
  })

  it('removes every share of the project with it, since they use its repository', async () => {
    await recordShared()
    await removeProject(local, DEMO_PROJECT_ID)
    expect(purged.sort()).toEqual([DEMO_PROJECT_ID, SHARE].sort())
    expect(await listProjectRows()).toEqual([])
  })

  it('is idempotent once the rows are gone', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await removeProject(local, DEMO_PROJECT_ID)
    await expect(removeProject(local, DEMO_PROJECT_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual([DEMO_PROJECT_ID])
  })
})

describe('unshareProject', () => {
  it("stops the share's workspaces and keeps its rows and checkouts, at the owner's word only", async () => {
    const recipient = await recordShared()
    await recordWorkspaceCreated({ projectId: SHARE, workspaceId: 'a' })
    mockList.mockResolvedValue([running(SHARE, 'a'), { ...running(SHARE, 'spare'), prewarmed: true }])

    const ada = { kind: 'tailnet', userId: recipient, login: 'ada@example.com', name: 'Ada' } as const
    await expect(unshareProject(ada, DEMO_PROJECT_ID, recipient)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await getProjectRow(SHARE))?.shareRevoked).toBe(false)

    await unshareProject(local, DEMO_PROJECT_ID, recipient)

    expect((await getProjectRow(SHARE))?.shareRevoked).toBe(true)
    // The spare is the prewarm pool's to reap.
    expect(mockDeregister.mock.calls).toEqual([['a']])
    await vi.waitFor(async () => expect((await listWorkspaceRows()).find((r) => r.workspaceId === 'a')?.stoppedAt).toBeTruthy())
    await expect(fs.access(projectDir(SHARE))).resolves.toBeUndefined()
    expect(purged).toEqual([])
    // The share is no longer its owner's to use, or to unshare again.
    await expect(removeProject(ada, SHARE)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(unshareProject(local, DEMO_PROJECT_ID, recipient)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('removes the share but says so when its workspaces cannot be stopped now', async () => {
    const recipient = await recordShared()
    mockList.mockRejectedValue(new Error('connection refused'))
    await expect(unshareProject(local, DEMO_PROJECT_ID, recipient)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect((await getProjectRow(SHARE))?.shareRevoked).toBe(true)

    mockList.mockResolvedValue([running(SHARE, 'a')])
    mockDeregister.mockRejectedValueOnce(new Error('exec failed'))
    await setProjectShareRevoked(SHARE, false)
    await expect(unshareProject(local, DEMO_PROJECT_ID, recipient)).rejects.toThrow(/could not be stopped yet/)
  })
})

describe('reconcileRevokedShares', () => {
  it('stops what still runs in a removed share, and nothing in an active one', async () => {
    await recordShared()
    await recordWorkspaceCreated({ projectId: SHARE, workspaceId: 'late' })
    const handles = [
      running(SHARE, 'late'),
      { ...running(SHARE, 'spare'), prewarmed: true },
      { ...running(SHARE, 'going'), terminating: true },
      running(DEMO_PROJECT_ID, 'source'),
    ]
    const snapshot = snapshotFixture(handles)

    await reconcileRevokedShares(snapshot)
    expect(mockDeregister).not.toHaveBeenCalled()

    await setProjectShareRevoked(SHARE, true)
    await reconcileRevokedShares(snapshot)
    expect(mockDeregister.mock.calls).toEqual([['late']])
  })

  it('carries on past a share whose workspace fails to stop', async () => {
    const recipient = await recordShared()
    const other = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a'
    await recordTestProject(KEEPER, { remoteUrl: `http://yaac.internal/api/workspace/git/${KEEPER}.git` })
    await recordProject({
      id: other, name: 'demo', remoteUrl: `http://yaac.internal/api/workspace/git/${other}.git`, addedAt: 'now', hosted: true, sharedFrom: KEEPER,
    }, recipient)
    await setProjectShareRevoked(SHARE, true)
    await setProjectShareRevoked(other, true)
    mockDeregister.mockImplementation((id) => id === 'stuck' ? Promise.reject(new Error('exec failed')) : Promise.resolve())

    await reconcileRevokedShares(snapshotFixture([running(SHARE, 'stuck'), running(other, 'next')]))
    expect(mockDeregister.mock.calls.map(([id]) => id).sort()).toEqual(['next', 'stuck'])
  })
})

describe('moveProjectToRemote', () => {
  const GITHUB = 'https://github.com/acme/widgets.git'
  const ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }
  const actual = vi.importActual<typeof gitModule>('#domain/git')
  let remote: string
  let work: string
  let token: string
  /** What the move did, in order: git steps and workspace stops. */
  let events: string[]

  /** A hosted project with `main`, `feature` and tag `v1` pushed to it. */
  async function hostedWithHistory(): Promise<string> {
    const { id } = await createHostedProject('widgets', BUILT_IN_USER_ID)
    await git(tmpDir, ['clone', '-q', hostedRepoDir(id), work])
    await git(work, ['commit', '-q', '--allow-empty', '-m', 'one'], { env: ENV })
    await git(work, ['tag', 'v1'])
    await git(work, ['push', '-q', 'origin', 'HEAD:main', 'HEAD:feature', 'v1'])
    return id
  }

  /** Workspaces the driver lists, each only under its own project. */
  function listing(handles: RuntimeHandle[]): void {
    mockList.mockImplementation((projectId) => Promise.resolve(handles.filter((h) => projectId === undefined || h.projectId === projectId)))
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
    clearAllProvisioningForTests()
    mockDeregister.mockImplementation((id) => { events.push(`stop ${id}`); return Promise.resolve() })
  })

  it('stops every workspace on the repository, every user\'s, then pushes, and moves the project and its shares there, keeping yaac\'s copy', async () => {
    const id = await hostedWithHistory()
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    const share = await shareProject(local, id, ada)
    const removed = await shareProject(local, id, bob)
    await setProjectShareRevoked(removed.id, true)
    await recordWorkspaceCreated({ projectId: id, workspaceId: 'a' })
    await recordWorkspaceCreated({ projectId: share.id, workspaceId: 'b' })
    const handles = [running(id, 'a'), running(share.id, 'b'), { ...running(id, 'spare'), prewarmed: true }]
    listing(handles)
    // A create in Ada's copy, past its last checkpoint, that comes up only
    // once the move has stopped it.
    const late = provision({ workspaceId: 'late', projectId: share.id, tool: 'claude', kind: 'create' }, async () => {
      await vi.waitFor(() => expect(listProvisioning().find((e) => e.workspaceId === 'late')?.message).toBe('Stopping…'))
      await recordWorkspaceCreated({ projectId: share.id, workspaceId: 'late' })
      handles.push(running(share.id, 'late'))
      return { workspaceId: 'late' }
    })()
    // Held while it pushes: nothing starts in either, the server's own
    // launches included.
    vi.mocked(pushHostedRepo).mockImplementationOnce(async (repo) => {
      events.push('push')
      expect([isProjectHeld(id), isProjectHeld(share.id)]).toEqual([true, true])
      await expect(authorizeProject(systemPrincipal, share.id)).rejects.toMatchObject({ code: 'CONFLICT' })
      await (await actual).pushHostedRepo(repo, remote, { kind: 'hosted' })
    })

    expect(await moveProjectToRemote(local, id, GITHUB, token)).toEqual({ knownHostsEntry: null })

    await late
    expect(events).toEqual(['check', 'stop a', 'stop b', 'stop late', 'push'])
    expect(await git(remote, ['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/feature\nrefs/heads/main\nrefs/tags/v1\n')
    const credential = { kind: 'https', token: 'ghp_move' }
    expect(vi.mocked(pushHostedRepo).mock.calls).toEqual([[hostedRepoDir(id), GITHUB, credential]])
    expect(await getProjectRow(id)).toMatchObject({ remoteUrl: GITHUB, hosted: false, gitCredentialId: token })
    expect(await resolveProjectCredential(id)).toEqual(credential)
    // The egress proxy is handed the project's credential, so a restarted
    // workspace can push.
    expect(mockSync.mock.calls.at(-1)?.[0][credentialOwnerKey(BUILT_IN_USER_ID)].git).toEqual([{ token: 'ghp_move', projects: [id] }])
    // Ada's copy is hers alone now, and needs her own credential.
    expect(await getProjectRow(share.id)).toMatchObject({ remoteUrl: GITHUB, hosted: false, gitCredentialId: null })
    expect((await getProjectRow(share.id))?.sharedFrom).toBeUndefined()
    expect(await resolveProjectCredential(share.id)).toBeNull()
    expect(await getProjectRow(removed.id)).toMatchObject({ remoteUrl: GITHUB, sharedFrom: id, shareRevoked: true })
    // yaac keeps its repository until the owner has checked the remote.
    expect(await getProjectRow(id)).toMatchObject({ keepsHostedRepo: true })
    await expect(fs.access(hostedRepoDir(id))).resolves.toBeUndefined()
    await vi.waitFor(() => expect(fetchOrigin).toHaveBeenCalledWith(repoDir(id), GITHUB, credential))
    expect(vi.mocked(fetchOrigin).mock.calls.map(([repo]) => repo)).toEqual([repoDir(id)])
    // The workspaces stop with their checkouts kept; the spare is reaped.
    await vi.waitFor(async () => expect((await listWorkspaceRows()).filter((r) => r.stoppedAt !== undefined).map((r) => r.workspaceId).sort())
      .toEqual(['a', 'b', 'late']))
    await vi.waitFor(() => expect([...new Set(mockDestroy.mock.calls.map(([t]) => t.workspaceId))]).toEqual(['spare']))
    // The hold is lifted, and it has moved.
    await expect(authorizeProject(local, id)).resolves.toBeUndefined()
    await expect(moveProjectToRemote(local, id, GITHUB, token)).rejects.toThrow(/is not hosted by yaac/)
  })

  it("is the owner's alone, and stays on yaac, stopping nothing, unless the remote is empty, until everything is pushed", async () => {
    const id = await hostedWithHistory()
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    const adaActor = { kind: 'tailnet', userId: ada, login: 'ada@example.com', name: 'Ada' } as const
    await expect(moveProjectToRemote(adaActor, id, GITHUB, token)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(moveProjectToRemote(local, id, 'git@github.com:acme/widgets.git', token))
      .rejects.toThrow(/needs an SSH key, not a token/)
    await recordTestProject(KEEPER)
    await expect(moveProjectToRemote(local, KEEPER, GITHUB, token)).rejects.toThrow(/is not hosted by yaac/)
    const share = await shareProject(local, id, ada)
    await expect(moveProjectToRemote(adaActor, share.id, GITHUB, token)).rejects.toThrow(/only its owner can move it/)
    listing([running(id, 'a')])
    const stillHosted = async (): Promise<void> => {
      expect(await getProjectRow(id)).toMatchObject({ hosted: true })
      await expect(fs.access(hostedRepoDir(id))).resolves.toBeUndefined()
      await expect(authorizeProject(local, id)).resolves.toBeUndefined()
    }

    // A host the project's workspaces may not reach, until it is allowed.
    await expect(moveProjectToRemote(local, id, 'https://git.example.test/acme/widgets.git', token))
      .rejects.toThrow(/"git.example.test" is not in the egress allowlist of "widgets"/)
    expect(events).toEqual([])
    await stillHosted()

    // A repository the host started with a README: refused before
    // anything stops.
    const readme = path.join(tmpDir, 'readme')
    await git(tmpDir, ['init', '-q', '-b', 'main', readme])
    await git(readme, ['commit', '-q', '--allow-empty', '-m', 'README'], { env: ENV })
    await git(readme, ['push', '-q', remote, 'HEAD:main'])
    await expect(moveProjectToRemote(local, id, GITHUB, token)).rejects.toThrow(/did not move: .*its refs\/heads\/main has commits this project's does not/)
    expect(events).toEqual(['check'])
    await stillHosted()
    await git(remote, ['update-ref', '-d', 'refs/heads/main'])

    // A workspace that will not stop: nothing is pushed.
    events = []
    mockDeregister.mockRejectedValueOnce(new Error('exec failed'))
    await expect(moveProjectToRemote(local, id, GITHUB, token)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(events).toEqual(['check'])
    await stillHosted()

    // A push that fails partway: still on yaac, and a retry finishes it.
    events = []
    vi.mocked(pushHostedRepo).mockImplementationOnce(async (repo) => {
      events.push('push')
      await git(repo, ['push', '-q', remote, 'refs/heads/main:refs/heads/main'])
      throw new Error('remote: Permission to acme/widgets.git denied to bot.')
    })
    await expect(moveProjectToRemote(local, id, GITHUB, token)).rejects.toThrow(/did not move: git authentication failed/)
    expect(events).toEqual(['check', 'stop a', 'push'])
    await stillHosted()
    // Work goes on before the retry.
    await git(work, ['commit', '-q', '--allow-empty', '-m', 'two'], { env: ENV })
    await git(work, ['push', '-q', 'origin', 'HEAD:main'])
    await moveProjectToRemote(local, id, GITHUB, token)
    expect((await git(remote, ['rev-parse', 'main'])).trim()).toBe((await git(work, ['rev-parse', 'HEAD'])).trim())
    expect(await git(remote, ['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/feature\nrefs/heads/main\nrefs/tags/v1\n')
    expect(await getProjectRow(id)).toMatchObject({ hosted: false, remoteUrl: GITHUB })
  })
})

describe('previewProjectMove', () => {
  it('counts the running workspaces on the project and its shares, and names whom it is shared with, for its owner', async () => {
    const { id } = await createHostedProject('widgets', BUILT_IN_USER_ID)
    const ada = await seeTailnetUser('ada@example.com', 'Ada')
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    const share = await shareProject(local, id, ada)
    const removed = await shareProject(local, id, bob)
    await setProjectShareRevoked(removed.id, true)
    await recordTestProject(KEEPER)
    mockList.mockResolvedValue([
      running(id, 'a'),
      running(share.id, 'b'),
      { ...running(id, 'spare'), prewarmed: true },
      { ...running(id, 'going'), terminating: true },
      running(KEEPER, 'other'),
    ])

    expect(await previewProjectMove(local, id)).toEqual({ runningWorkspaces: 2, sharedWith: ['ada@example.com'] })
    const adaActor = { kind: 'tailnet', userId: ada, login: 'ada@example.com', name: 'Ada' } as const
    await expect(previewProjectMove(adaActor, id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(previewProjectMove(local, KEEPER)).rejects.toThrow(/is not hosted by yaac/)
  })
})

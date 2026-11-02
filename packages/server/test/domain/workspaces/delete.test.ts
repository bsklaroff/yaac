import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { deleteWorkspace, listProvisioning, prepareRestart, queueWorkspace } from '#domain/workspaces'
import { clearAllProvisioningForTests, failProvisioning, registerProvisioning } from '#domain/workspaces/provisioning'
import { getWorkspaceRow, listWorkspaceConversations, BUILT_IN_USER_ID } from '#db'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { recordConversations } from '#db/conversation-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'
import { acpLogDir, agentHistoryDir, workspaceDir } from '@yaac/shared/project-paths'
import { globalRoot } from '@yaac/shared/paths'
import { removeAsRoot } from '#drivers/k8s/workspaces'
import { appliedRootPods, podsRunAsRoot } from '#test/support/root-pods'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

let tmpDir: string
/** Ids the fake runtime still holds a unit for. */
let units: Set<string>
/** Holds the first `findForTeardown` call, which a delete makes under its
 *  claim, until resolved; unset, calls answer at once. */
let gate: Promise<void> | undefined

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject(PROJ)
  clearAllProvisioningForTests()
  units = new Set()
  gate = undefined
  installFakeWorkspaceDriver({
    findForTeardown: async (id) => {
      const held = gate
      gate = undefined
      await held
      return units.has(id) ? { workspaceId: id, projectId: PROJ, unitName: `yaac-proj-${id}` } : undefined
    },
  })
})

afterEach(async () => {
  vi.useRealTimers()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** A stopped workspace with a conversation and files in each of its dirs. */
async function stoppedWorkspace(id: string): Promise<string[]> {
  await recordWorkspaceCreated({ projectId: PROJ, workspaceId: id })
  await recordConversations(PROJ, id, [{ tool: 'claude', conversationId: `conv-${id}`, firstPrompt: 'hi' }])
  await recordWorkspaceStopped(PROJ, id)
  const dirs = [workspaceDir(PROJ, id), agentHistoryDir(PROJ, id), acpLogDir(PROJ, id)]
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'f'), 'x')
  }
  return dirs
}

const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false)

describe('deleteWorkspace', () => {
  it('removes a stopped workspace\'s files and rows, leaving its siblings', async () => {
    const dirs = await stoppedWorkspace('wt-doomed')
    const siblingDirs = await stoppedWorkspace('wt-kept')
    // A failed restart's entry goes with the workspace.
    registerProvisioning({ workspaceId: 'wt-doomed', projectId: PROJ, tool: 'claude', kind: 'restart' })
    failProvisioning('wt-doomed', 'boom')

    expect(await deleteWorkspace(local, 'wt-d')).toBe('wt-doomed')

    for (const dir of dirs) expect(await exists(dir), dir).toBe(false)
    expect(await getWorkspaceRow(PROJ, 'wt-doomed')).toBeUndefined()
    expect(await listWorkspaceConversations(PROJ, 'wt-doomed')).toEqual([])
    expect(listProvisioning()).toEqual([])
    for (const dir of siblingDirs) expect(await exists(dir), dir).toBe(true)
    expect(await getWorkspaceRow(PROJ, 'wt-kept')).toBeDefined()
  })

  it('refuses, keeping everything, unless the workspace is stopped, settled and has nothing queued after it', async () => {
    const teammate = { kind: 'tailnet', login: 'bob@example.com', name: 'bob', userId: 'b0b0b0b0-0000-4000-8000-000000000000' } as const
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-running' })
    await stoppedWorkspace('wt-stopping')
    units.add('wt-stopping')
    await stoppedWorkspace('wt-restarting')
    registerProvisioning({ workspaceId: 'wt-restarting', projectId: PROJ, tool: 'claude', kind: 'restart' })
    await stoppedWorkspace('wt-parent')
    await queueWorkspace(local, PROJ, { parent: 'wt-parent', prompt: 'next', tool: 'claude' }, 'user')
    await stoppedWorkspace('wt-mine')

    await expect(deleteWorkspace(local, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(deleteWorkspace(teammate, 'wt-mine')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(deleteWorkspace(local, 'wt-running')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(deleteWorkspace(local, 'wt-stopping')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(deleteWorkspace(local, 'wt-restarting')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(deleteWorkspace(local, 'wt-parent')).rejects.toMatchObject({ code: 'CONFLICT', message: /1 queued/ })

    for (const id of ['wt-running', 'wt-stopping', 'wt-restarting', 'wt-parent', 'wt-mine']) {
      expect(await getWorkspaceRow(PROJ, id), id).toBeDefined()
    }
    expect(await exists(workspaceDir(PROJ, 'wt-mine'))).toBe(true)
  })

  it('hands what the server cannot remove to a root pod, a .git whole and last, keeping everything when that fails', async () => {
    installFakeWorkspaceDriver({ findForTeardown: () => Promise.resolve(undefined), removeAsRoot })
    const [checkout, history] = await stoppedWorkspace('wt-stuck')
    const git = path.join(checkout, '.git')
    // As root-owned files a workspace left answer the server: one beside
    // .git, one inside it, as `sudo git commit` leaves.
    for (const dir of [path.join(checkout, 'rootdir'), path.join(git, 'objects')]) {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'x'), 'x')
      await fs.chmod(dir, 0o555)
    }
    await fs.writeFile(path.join(git, 'HEAD'), 'ref: refs/heads/main')
    const kept = async (): Promise<void> => {
      await expect(deleteWorkspace(local, 'wt-stuck')).rejects.toMatchObject({ code: 'INTERNAL', message: /can be retried/ })
      // The server never starts on a .git it cannot finish.
      for (const p of [path.join(git, 'HEAD'), path.join(git, 'objects', 'x'), history]) expect(await exists(p), p).toBe(true)
      expect(await getWorkspaceRow(PROJ, 'wt-stuck')).toBeDefined()
    }

    podsRunAsRoot('Failed')
    await kept()
    expect(await exists(path.join(checkout, 'rootdir', 'x'))).toBe(true)
    expect(await exists(path.join(checkout, 'f'))).toBe(false)

    fakeCluster.reset()
    podsRunAsRoot('Succeeded', 'Failed')
    await kept()
    expect(await exists(path.join(checkout, 'rootdir'))).toBe(false)

    fakeCluster.reset()
    podsRunAsRoot('Succeeded')
    expect(await deleteWorkspace(local, 'wt-stuck')).toBe('wt-stuck')
    for (const dir of [checkout, history]) expect(await exists(dir), dir).toBe(false)
    // Each pod mounts no more than the checkout.
    expect(appliedRootPods()).toEqual([{ subPath: path.relative(globalRoot(), checkout), names: ['.git'], runAsUser: 0 }])
  })

  it('refuses the workspace a sibling-resumed conversation started in, but not the one that resumed it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await stoppedWorkspace('wt-a')
    vi.setSystemTime(Date.now() + 60_000)
    await stoppedWorkspace('wt-b')
    await recordConversations(PROJ, 'wt-b', [{ tool: 'claude', conversationId: 'conv-wt-a' }])
    await expect(deleteWorkspace(local, 'wt-a')).rejects.toMatchObject({ code: 'CONFLICT', message: /resumed in workspace wt-b/ })
    expect(await exists(agentHistoryDir(PROJ, 'wt-a'))).toBe(true)

    expect(await deleteWorkspace(local, 'wt-b')).toBe('wt-b')
    // Its link gone, the conversation's own workspace can go too.
    expect(await deleteWorkspace(local, 'wt-a')).toBe('wt-a')
  })

  it('unlinks a checkout that is a link, leaving what it points at', async () => {
    await stoppedWorkspace('wt-linked')
    const target = path.join(tmpDir, 'elsewhere')
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'keep'), 'x')
    await fs.rm(workspaceDir(PROJ, 'wt-linked'), { recursive: true })
    await fs.symlink(target, workspaceDir(PROJ, 'wt-linked'))

    expect(await deleteWorkspace(local, 'wt-linked')).toBe('wt-linked')
    expect(await exists(workspaceDir(PROJ, 'wt-linked'))).toBe(false)
    expect(await exists(path.join(target, 'keep'))).toBe(true)
  })

  it('holds the id while it runs, refusing a restart or queued child rather than starting either', async () => {
    await stoppedWorkspace('wt-doomed')
    let open: () => void = () => undefined
    gate = new Promise((resolve) => { open = resolve })
    const deleting = deleteWorkspace(local, 'wt-doomed')
    await vi.waitFor(() => expect(gate).toBeUndefined())

    await expect(prepareRestart(local, 'wt-doomed')).rejects.toMatchObject({ code: 'CONFLICT', message: /being deleted/ })
    await expect(queueWorkspace(local, PROJ, { parent: 'wt-doomed', prompt: 'next', tool: 'claude' }, 'user'))
      .rejects.toMatchObject({ code: 'CONFLICT', message: /being deleted/ })
    expect(listProvisioning()).toEqual([])

    open()
    expect(await deleting).toBe('wt-doomed')
    expect(await getWorkspaceRow(PROJ, 'wt-doomed')).toBeUndefined()
    // Released: a second delete is a plain not-found.
    await expect(deleteWorkspace(local, 'wt-doomed')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

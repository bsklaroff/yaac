import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { deleteWorkspace, listProvisioning, prepareRestart, queueWorkspace, reconcileWorkspaceRetention } from '#domain/workspaces'
import { clearAllProvisioningForTests, failProvisioning, registerProvisioning } from '#domain/workspaces/provisioning'
import { getWorkspaceRow, listWorkspaceAgentSessions, BUILT_IN_USER_ID } from '#db'
import { recordWorkspaceCreated, recordWorkspaceLife, recordWorkspaceStopped } from '#db/workspace-store'
import { recordAgentSessions } from '#db/agent-session-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { recordTestProject, seedProject } from '@yaac/test-utils/project-fixture'
import { acpLogDir, agentHistoryDir, projectConfigDir, workspaceDir } from '@yaac/shared/project-paths'

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
  vi.unstubAllEnvs()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** A stopped workspace with a conversation and files in each of its dirs. */
async function stoppedWorkspace(id: string): Promise<string[]> {
  await recordWorkspaceCreated({ projectId: PROJ, workspaceId: id })
  await recordAgentSessions(PROJ, id, [{ tool: 'claude', agentSessionId: `conv-${id}`, firstPrompt: 'hi' }])
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
    expect(await listWorkspaceAgentSessions(PROJ, 'wt-doomed')).toEqual([])
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

  it('keeps .git, the history and the row when part of the checkout cannot be removed', async () => {
    const [checkout, history] = await stoppedWorkspace('wt-stuck')
    await fs.mkdir(path.join(checkout, '.git'))
    await fs.writeFile(path.join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main')
    await fs.mkdir(path.join(checkout, 'rootdir'))
    // As a root-owned file left by the workspace answers the server.
    const realRm = fs.rm
    const rm = vi.spyOn(fs, 'rm').mockImplementation((p, opts) => String(p).endsWith('rootdir')
      ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      : realRm(p, opts))

    await expect(deleteWorkspace(local, 'wt-stuck')).rejects.toMatchObject({ code: 'INTERNAL', message: /can be retried/ })
    expect(await exists(path.join(checkout, '.git', 'HEAD'))).toBe(true)
    expect(await exists(path.join(checkout, 'f'))).toBe(false)
    expect(await exists(history)).toBe(true)
    expect(await getWorkspaceRow(PROJ, 'wt-stuck')).toBeDefined()

    rm.mockRestore()
    expect(await deleteWorkspace(local, 'wt-stuck')).toBe('wt-stuck')
    expect(await exists(checkout)).toBe(false)
  })

  it('refuses the workspace a sibling-resumed conversation started in, but not the one that resumed it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await stoppedWorkspace('wt-a')
    vi.setSystemTime(Date.now() + 60_000)
    await stoppedWorkspace('wt-b')
    await recordAgentSessions(PROJ, 'wt-b', [{ tool: 'claude', agentSessionId: 'conv-wt-a' }])
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

describe('reconcileWorkspaceRetention', () => {
  const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
  const DAY_MS = 24 * 60 * 60_000
  const running = new AbortController().signal

  async function setConfig(projectId: string, config: object): Promise<void> {
    await fs.mkdir(projectConfigDir(projectId), { recursive: true })
    await fs.writeFile(path.join(projectConfigDir(projectId), 'yaac-config.json'), JSON.stringify(config))
  }

  const kept = async (projectId: string, ids: string[]): Promise<string[]> => {
    const out: string[] = []
    for (const id of ids) if (await getWorkspaceRow(projectId, id)) out.push(id)
    return out
  }

  it('deletes only workspaces stopped past their project\'s retention, else the server\'s', async () => {
    await recordTestProject(OTHER)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() - 10 * DAY_MS)
    await stoppedWorkspace('wt-old')
    await stoppedWorkspace('wt-old-parent')
    await queueWorkspace(local, PROJ, { parent: 'wt-old-parent', prompt: 'next', tool: 'claude' }, 'user')
    // Its stop stands from 10 days ago, but it ran again since (a restart
    // whose clear of the stop was lost).
    await stoppedWorkspace('wt-ran-since')
    await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'wt-other-old' })
    await recordWorkspaceStopped(OTHER, 'wt-other-old')
    vi.setSystemTime(Date.now() + 8 * DAY_MS)
    await stoppedWorkspace('wt-recent')
    await recordWorkspaceLife(PROJ, 'wt-ran-since')
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-running' })
    vi.setSystemTime(Date.now() + 2 * DAY_MS)
    const all = ['wt-old', 'wt-old-parent', 'wt-ran-since', 'wt-recent', 'wt-running']

    // Off by default.
    await reconcileWorkspaceRetention(running)
    expect(await kept(PROJ, all)).toEqual(all)

    // A shutdown stops the pass before it deletes anything.
    vi.stubEnv('YAAC_WORKSPACE_RETENTION_DAYS', '5')
    await reconcileWorkspaceRetention(AbortSignal.abort())
    expect(await kept(PROJ, all)).toEqual(all)

    // The server's 5 days. OTHER's config is invalid, so it keeps
    // everything rather than falling back to the server's. The parent with
    // a queued entry is refused and kept for a later pass.
    await setConfig(OTHER, { stoppedWorkspaceRetentionDays: '7' })
    await reconcileWorkspaceRetention(running)
    expect(await kept(PROJ, all)).toEqual(['wt-old-parent', 'wt-ran-since', 'wt-recent', 'wt-running'])
    expect(await exists(workspaceDir(PROJ, 'wt-old'))).toBe(false)
    expect(await kept(OTHER, ['wt-other-old'])).toEqual(['wt-other-old'])

    // A project's own retention wins over the server's, either way: OTHER
    // opts out with 0, PROJ shortens it to 1 day.
    await setConfig(OTHER, { stoppedWorkspaceRetentionDays: 0 })
    await setConfig(PROJ, { stoppedWorkspaceRetentionDays: 1 })
    await reconcileWorkspaceRetention(running)
    expect(await kept(PROJ, all)).toEqual(['wt-old-parent', 'wt-running'])
    expect(await kept(OTHER, ['wt-other-old'])).toEqual(['wt-other-old'])
  })
})

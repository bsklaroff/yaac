import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  listDraftWorkspaces,
  listProvisioning,
  queueWorkspace,
  registerProvisioning,
  restartWorkspace,
  runProvisioned,
  startWorkspace,
  stopWorkspace,
} from '#domain/workspaces'
import { clearQueuedLaunchesForTests } from '#domain/workspaces/queued-workspaces'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import { getQueuedWorkspaceRow } from '#db/queued-workspace-store'
import { getWorkspaceRow, listWorkspaceAgentSessions } from '#db'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'
import { WorkspaceExecError } from '#drivers/contract'

// A stop runs the (fake) driver's teardown, then creates whatever was queued
// after the stopped workspace. Both run for real, over a real project.
let tmpDir: string
/** Workspaces the driver tore down, and the ones it launched. */
let deregistered: string[]
let launched: string[]

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject('proj')
  clearAllProvisioningForTests()
  clearQueuedLaunchesForTests()
  deregistered = []
  launched = []
  installFakeWorkspaceDriver({
    findForTeardown: (id) => Promise.resolve(id === 'parent'
      ? { workspaceId: 'parent', projectSlug: 'proj', unitName: 'yaac-proj-parent' }
      : undefined),
    deregisterWorkspace: (id) => { deregistered.push(id); return Promise.resolve() },
    launch: (spec) => {
      launched.push(spec.workspaceId)
      return Promise.resolve(handleFixture({ workspaceId: spec.workspaceId, projectSlug: 'proj' }))
    },
  })
  await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'parent', baseBranch: 'dev', permissionMode: 'auto', mode: 'tui' })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** The workspace whose first conversation began with `prompt`. */
async function launchedWith(prompt: string): Promise<string | undefined> {
  for (const id of launched) {
    if ((await listWorkspaceAgentSessions('proj', id))[0]?.firstPrompt === prompt) return id
  }
  return undefined
}

describe('stopWorkspace', () => {
  // A stop never asks the driver for spares, so even a spare's exact id is
  // not found.
  it('does not stop an unclaimed spare, even by its exact id', async () => {
    const asked: Array<{ spares?: boolean } | undefined> = []
    installFakeWorkspaceDriver({
      findForTeardown: (id, opts) => {
        asked.push(opts)
        return Promise.resolve(id === 'spare1' && opts?.spares === true
          ? { workspaceId: 'spare1', projectSlug: 'proj', unitName: 'yaac-proj-spare1' }
          : undefined)
      },
    })
    await expect(stopWorkspace('spare1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(asked).toEqual([undefined])
    expect(deregistered).toEqual([])
  })

  it('tears the workspace down, then starts what was queued after it — only the top of a chain', async () => {
    const child = await queueWorkspace('proj', { parent: 'parent', prompt: 'child', tool: 'claude' }, 'user')
    const sibling = await queueWorkspace('proj', { parent: 'parent', prompt: 'sibling', tool: 'claude' }, 'user')
    const grandchild = await queueWorkspace('proj', { parent: child.id, prompt: 'grandchild' }, 'user')

    // Addressed by a prefix, which the rows expand.
    expect(await stopWorkspace('par')).toMatchObject({ workspaceId: 'parent', projectSlug: 'proj' })
    expect(deregistered).toEqual(['parent'])

    // Both direct children start from their stored settings: the parent's
    // branch, posture and UI mode.
    await vi.waitFor(async () => {
      expect(await getQueuedWorkspaceRow(child.id)).toBeUndefined()
      expect(await getQueuedWorkspaceRow(sibling.id)).toBeUndefined()
    }, { timeout: 60_000 })
    expect(launched).toHaveLength(2)
    const becameId = await launchedWith('child')
    expect(await launchedWith('sibling')).toBeDefined()
    expect(await getWorkspaceRow('proj', becameId!)).toMatchObject({ baseBranch: 'dev', permissionMode: 'auto', mode: 'tui' })
    // The grandchild now waits for the child's new workspace to stop.
    const waiting = await getQueuedWorkspaceRow(grandchild.id)
    expect(waiting).toMatchObject({ parentWorkspaceId: becameId })
    expect(waiting?.releasedAt).toBeUndefined()
  })

  describe('a workspace still being created', () => {
    /** Start creating workspace `new` (or restarting `parent`) the way the
     *  routes do, with the driver's `assertCanLaunch`, `awaitReady` and `exec`
     *  as given, recording what it tears down. */
    function startCreate(driver: {
      assertCanLaunch?: () => Promise<void>
      prepareImage?: () => Promise<string>
      awaitReady?: () => Promise<void>
      exec?: (cmd: string) => Promise<void>
    }, kind: 'create' | 'restart' = 'create'): {
      create: Promise<unknown>
      destroyed: string[]
      deregistered: string[]
    } {
      const id = kind === 'create' ? 'new' : 'parent'
      const destroyed: string[] = []
      const deregistered: string[] = []
      installFakeWorkspaceDriver({
        deregisterWorkspace: (id) => { deregistered.push(id); return Promise.resolve() },
        ...(driver.assertCanLaunch !== undefined ? { assertCanLaunch: driver.assertCanLaunch } : {}),
        ...(driver.prepareImage !== undefined ? { prepareImage: driver.prepareImage } : {}),
        launch: (spec) => {
          launched.push(spec.workspaceId)
          return Promise.resolve(handleFixture({ workspaceId: id, projectSlug: 'proj', jobName: `yaac-proj-${id}` }))
        },
        ...(driver.awaitReady !== undefined ? { awaitReady: driver.awaitReady } : {}),
        exec: async (_job, cmd) => {
          await driver.exec?.(cmd)
          return { stdout: '', stderr: '' }
        },
        findForTeardown: (asked) => Promise.resolve(asked === id
          ? { workspaceId: id, projectSlug: 'proj', unitName: `yaac-proj-${id}` }
          : undefined),
        destroy: (target) => {
          destroyed.push(target.unitName)
          return Promise.resolve(true)
        },
      })
      registerProvisioning({ workspaceId: id, projectSlug: 'proj', tool: 'claude', kind })
      const create = kind === 'restart'
        ? runProvisioned(id, (onProgress) => restartWorkspace(id, { onProgress }))
        : runProvisioned(id, (onProgress) => startWorkspace({
          projectSlug: 'proj',
          workspaceId: 'new',
          tool: 'claude',
          mode: 'tui',
          permissionMode: 'plan',
          prompt: 'build it',
          title: 'Build',
          rememberDefaults: false,
          claimSpare: false,
          draftOnStop: {},
        }, onProgress))
      create.catch(() => { /* asserted by the test */ })
      return { create, destroyed, deregistered }
    }

    // Stopped while its pod boots: the agent never starts, the create rolls
    // back, and the prompt survives as a draft with the create's settings.
    it('rolls it back before its agent starts and keeps its prompt as a draft', async () => {
      let boot!: () => void
      const booted = new Promise<void>((resolve) => { boot = resolve })
      const execs: string[] = []
      const { create, destroyed } = startCreate({
        awaitReady: () => booted,
        exec: (cmd) => { execs.push(cmd); return Promise.resolve() },
      })
      await vi.waitFor(() => expect(launched).toEqual(['new']), { timeout: 30_000 })

      expect(await stopWorkspace('new')).toEqual({ workspaceId: 'new', projectSlug: 'proj', provisioning: true })
      expect(listProvisioning()).toEqual([
        expect.objectContaining({ workspaceId: 'new', stopping: true, message: 'Stopping…' }),
      ])
      boot()

      await expect(create).rejects.toThrow('kept as a draft')
      expect(execs.some((cmd) => cmd.includes('respawn-window'))).toBe(false)
      expect(destroyed).toEqual(['yaac-proj-new'])
      // Dropped, not left as a failed row.
      expect(listProvisioning()).toEqual([])
      await vi.waitFor(async () => expect(await getWorkspaceRow('proj', 'new')).toBeUndefined())
      expect(await listDraftWorkspaces()).toEqual([expect.objectContaining({
        projectSlug: 'proj', prompt: 'build it', title: 'Build', tool: 'claude', mode: 'tui', permissionMode: 'plan',
      })])
    })

    // Stopped before its row exists, by a prefix: nothing was made, so only
    // the draft is left.
    it('finds it by prefix before its row exists', async () => {
      let allow!: () => void
      const allowed = new Promise<void>((resolve) => { allow = resolve })
      let asked!: () => void
      const checking = new Promise<void>((resolve) => { asked = resolve })
      const { create } = startCreate({ assertCanLaunch: () => { asked(); return allowed } })
      await checking
      expect(await getWorkspaceRow('proj', 'new')).toBeUndefined()

      expect(await stopWorkspace('ne')).toEqual({ workspaceId: 'new', projectSlug: 'proj', provisioning: true })
      allow()

      await expect(create).rejects.toThrow('kept as a draft')
      expect(launched).toEqual([])
      expect(await getWorkspaceRow('proj', 'new')).toBeUndefined()
      expect(await listDraftWorkspaces()).toEqual([expect.objectContaining({ prompt: 'build it' })])
    })

    // Stopped during an image build that then fails: the build's error is
    // the outcome, not a rollback, so no draft joins whatever it left.
    it('keeps the failure, and makes no draft, when the create fails on its own', async () => {
      let fail!: (err: Error) => void
      let building!: () => void
      const started = new Promise<void>((resolve) => { building = resolve })
      const { create } = startCreate({
        prepareImage: () => new Promise((_, reject) => { fail = reject; building() }),
      })
      await started

      expect(await stopWorkspace('new')).toMatchObject({ provisioning: true })
      fail(new Error('image build failed'))

      await expect(create).rejects.toThrow('image build failed')
      expect(launched).toEqual([])
      expect(listProvisioning()).toEqual([])
      expect(await listDraftWorkspaces()).toEqual([])
    })

    // Stopped (twice) once its agent is starting: too late to roll back, so
    // the create or restart finishes and is then stopped, once, like any
    // running workspace. The agent-alive probe then finds the agent gone,
    // which is the stop's doing and not a failed launch.
    it.each(['create', 'restart'] as const)('stops a %s past its last checkpoint once it is up', async (kind) => {
      const id = kind === 'create' ? 'new' : 'parent'
      /** Teardowns before the stop's own (a restart tears down first). */
      let before = 0
      let agentStarting!: () => void
      const starting = new Promise<void>((resolve) => { agentStarting = resolve })
      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      let probed!: () => void
      const probeFailed = new Promise<void>((resolve) => { probed = resolve })
      const { create, destroyed, deregistered } = startCreate({
        exec: async (cmd) => {
          if (cmd.includes('list-windows -t =yaac')) {
            await vi.waitFor(() => expect(deregistered.length).toBeGreaterThan(before), { timeout: 30_000 })
            probed()
            throw new WorkspaceExecError('probe', 1, '', 'no server running')
          }
          if (!cmd.includes('respawn-window')) return
          before = deregistered.length
          agentStarting()
          await released
        },
      }, kind)
      await starting

      expect(await stopWorkspace(id)).toMatchObject({ provisioning: true })
      expect(await stopWorkspace(id)).toMatchObject({ provisioning: true })
      release()

      await expect(create).resolves.toMatchObject({ workspaceId: id })
      await probeFailed
      await vi.waitFor(async () => expect((await getWorkspaceRow('proj', id))?.stoppedAt).toBeDefined())
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(listProvisioning()).toEqual([])
      expect(deregistered.slice(before)).toEqual([id])
      expect(destroyed).toEqual([])
      expect(await listDraftWorkspaces()).toEqual([])
    })
  })

  it('refuses a workspace with nothing running', async () => {
    await expect(stopWorkspace('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

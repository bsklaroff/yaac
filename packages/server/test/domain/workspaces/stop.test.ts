import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  listDraftWorkspaces,
  listProvisioning,
  queueWorkspace,
  registerProvisioning,
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
  await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'parent', baseBranch: 'dev', permissionMode: 'auto' })
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
    // branch and posture.
    await vi.waitFor(async () => {
      expect(await getQueuedWorkspaceRow(child.id)).toBeUndefined()
      expect(await getQueuedWorkspaceRow(sibling.id)).toBeUndefined()
    }, { timeout: 60_000 })
    expect(launched).toHaveLength(2)
    const becameId = await launchedWith('child')
    expect(await launchedWith('sibling')).toBeDefined()
    expect(await getWorkspaceRow('proj', becameId!)).toMatchObject({ baseBranch: 'dev', permissionMode: 'auto' })
    // The grandchild now waits for the child's new workspace to stop.
    const waiting = await getQueuedWorkspaceRow(grandchild.id)
    expect(waiting).toMatchObject({ parentWorkspaceId: becameId })
    expect(waiting?.releasedAt).toBeUndefined()
  })

  describe('a workspace still being created', () => {
    /** Start creating workspace `new` the way the create route does, with the
     *  driver's `awaitReady` and `exec` as given, recording what it tears
     *  down. */
    function startCreate(driver: {
      awaitReady?: () => Promise<void>
      exec?: (cmd: string) => Promise<void>
    }): { create: Promise<unknown>; destroyed: string[] } {
      const destroyed: string[] = []
      installFakeWorkspaceDriver({
        launch: (spec) => {
          launched.push(spec.workspaceId)
          return Promise.resolve(handleFixture({ workspaceId: 'new', projectSlug: 'proj', jobName: 'yaac-proj-new' }))
        },
        ...(driver.awaitReady !== undefined ? { awaitReady: driver.awaitReady } : {}),
        exec: async (_job, cmd) => {
          await driver.exec?.(cmd)
          return { stdout: '', stderr: '' }
        },
        findForTeardown: (id) => Promise.resolve(id === 'new'
          ? { workspaceId: 'new', projectSlug: 'proj', unitName: 'yaac-proj-new' }
          : undefined),
        destroy: (target) => {
          destroyed.push(target.unitName)
          return Promise.resolve(true)
        },
      })
      registerProvisioning({ workspaceId: 'new', projectSlug: 'proj', tool: 'claude', kind: 'create' })
      const create = runProvisioned('new', (onProgress) => startWorkspace({
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
      return { create, destroyed }
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

    // Stopped once its agent is starting: too late to roll back, so the
    // create finishes and is then stopped like any running workspace.
    it('stops it as a running workspace once a create past its last checkpoint is up', async () => {
      let agentStarting!: () => void
      const starting = new Promise<void>((resolve) => { agentStarting = resolve })
      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      const { create, destroyed } = startCreate({
        exec: (cmd) => {
          if (!cmd.includes('respawn-window')) return Promise.resolve()
          agentStarting()
          return released
        },
      })
      await starting

      expect(await stopWorkspace('new')).toMatchObject({ provisioning: true })
      release()

      await expect(create).resolves.toMatchObject({ workspaceId: 'new' })
      await vi.waitFor(async () => expect((await getWorkspaceRow('proj', 'new'))?.stoppedAt).toBeDefined())
      expect(destroyed).toEqual([])
      expect(await listDraftWorkspaces()).toEqual([])
    })
  })

  it('refuses a workspace with nothing running', async () => {
    await expect(stopWorkspace('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type * as ChildProcessModule from 'node:child_process'
import type * as dbModule from '#db'

/** The children running a stop's detached teardown script, which a case
 *  ends by emitting `exit`. */
const teardowns = vi.hoisted(() => ({ children: [] as EventEmitter[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: ChildProcessModule.SpawnOptions) => {
      if (cmd !== 'sh') return actual.spawn(cmd, args, opts)
      const child = Object.assign(new EventEmitter(), { unref: () => { /* detached */ } })
      teardowns.children.push(child)
      return child
    },
  }
})

// Real, but a case can make a read or the stop's clearing fail.
vi.mock('#db', async (importOriginal) => {
  const actual = await importOriginal<typeof dbModule>()
  return {
    ...actual,
    clearWorkspaceStopped: vi.fn(actual.clearWorkspaceStopped),
    findWorkspaceRow: vi.fn(actual.findWorkspaceRow),
    listActiveAgentSessions: vi.fn(actual.listActiveAgentSessions),
  }
})
import { listProvisioning, prepareRestart, prepareStart, stopWorkspace } from '#domain/workspaces'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import {
  applyWorkspaceEvent,
  clearWorkspaceStopped,
  createWorkspaceGroup,
  findWorkspaceRow,
  listActiveAgentSessions,
  getWorkspaceRow,
} from '#db'
import { closeDb } from '#db/client'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { workspaceDir, workspaceStateDir } from '@yaac/shared/project-paths'
import { projectConfigDir } from '@yaac/shared/paths'
import { isWorkspaceTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'
import { _clearTmuxAliveCacheForTests, probeTmuxLiveness } from '#runtime/status/liveness'
import type { RuntimeHandle, WorkspaceDriver } from '#drivers/contract'
import type { AgentTool, PermissionMode } from '@yaac/shared/types'
import { BUILT_IN_USER_ID } from '#db'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

/**
 * A restart resolves its target, tears down the old unit, creates under the
 * same id, and only then clears the stop record. Create and teardown run for
 * real against the fake driver, over a real project.
 */
let tmpDir: string
/** The unit the driver reports running, if any. */
let live: RuntimeHandle | undefined
/** What the driver saw, in order. */
let calls: string[]
/** Each teardown's `unitOnly`: true keeps the prepared substrate. */
let destroys: boolean[]
let deregistered: string[]

function installDriver(overrides: Partial<WorkspaceDriver> = {}): void {
  installFakeWorkspaceDriver({
    find: (id) => Promise.resolve(live?.workspaceId === id ? live : undefined),
    findForTeardown: (id) => Promise.resolve(live?.workspaceId === id
      ? { workspaceId: id, projectId: live.projectId, unitName: live.jobName }
      : undefined),
    destroy: (target, opts) => {
      calls.push(`destroy ${target.unitName}`)
      destroys.push(opts?.unitOnly === true)
      if (live?.jobName === target.unitName) live = undefined
      return Promise.resolve(true)
    },
    deregisterWorkspace: (id) => { deregistered.push(id); return Promise.resolve() },
    launch: (spec) => {
      calls.push(`launch ${spec.workspaceId}`)
      return Promise.resolve(handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: spec.workspaceId, jobName: `yaac-${spec.workspaceId}` }))
    },
    exec: (_jobName, cmd) => {
      calls.push(cmd)
      return Promise.resolve({ stdout: '', stderr: '' })
    },
    ...overrides,
  })
}

/** A workspace created as the create route makes one. */
async function created(
  workspaceId: string,
  over: { tool?: AgentTool; permissionMode?: PermissionMode; model?: string; effort?: string } = {},
): Promise<void> {
  const run = await prepareStart(local, {
    projectId: DEMO_PROJECT_ID, workspaceId, mode: 'tui', rememberDefaults: false, claimSpare: false, ...over,
  })
  await run()
}

/** A workspace created and then stopped, with its unit gone. */
async function stoppedWorkspace(workspaceId: string, over: Parameters<typeof created>[1] = {}): Promise<void> {
  await created(workspaceId, over)
  await applyWorkspaceEvent({ type: 'workspace-stopped', projectId: DEMO_PROJECT_ID, workspaceId })
  calls = []
  destroys = []
  deregistered = []
}

/** Restart as the route does: checked first, then run. */
async function restart(idOrPrefix: string, onProgress?: (message: string) => void): Promise<{ workspaceId: string; tool: AgentTool }> {
  return await (await prepareRestart(local, idOrPrefix))(onProgress)
}

const respawn = (): string | undefined => calls.find((c) => c.includes('respawn-window'))

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject()
  clearAllProvisioningForTests()
  _clearTerminatingForTests()
  teardowns.children = []
  live = undefined
  calls = []
  destroys = []
  deregistered = []
  installDriver()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  // A restart that stops before create returns leaves its mark behind.
  clearAllProvisioningForTests()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('prepareRestart', () => {
  it('tears down the live unit while marked in flight, resumes every active conversation, and clears the stop', async () => {
    await stoppedWorkspace('wt-1', { tool: 'codex' })
    const sessions = [
      { tool: 'codex' as const, agentSessionId: 'wt-1', mode: 'tui' as const },
      { tool: 'claude' as const, agentSessionId: 'conv-2', mode: 'tui' as const },
    ]
    await applyWorkspaceEvent({ type: 'sessions-launched', projectId: DEMO_PROJECT_ID, workspaceId: 'wt-1', sessions })
    live = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-1', jobName: 'yaac-wt-1', tool: 'codex' })
    let rowAtTeardown: ReturnType<typeof listProvisioning>[number] | undefined
    installDriver({
      destroy: (target) => {
        rowAtTeardown = listProvisioning()[0]
        calls.push(`destroy ${target.unitName}`)
        live = undefined
        return Promise.resolve(true)
      },
    })
    const progress: string[] = []

    // Addressed by prefix, as the CLI usually does.
    const result = await restart('wt', (m) => progress.push(m))

    expect(result).toMatchObject({ workspaceId: 'wt-1', tool: 'codex' })
    // The row is what keeps the stale reaper from deleting the dirs the
    // create is about to mount.
    expect(calls[0]).toBe('destroy yaac-wt-1')
    expect(rowAtTeardown).toMatchObject({ workspaceId: 'wt-1', kind: 'restart', tool: 'codex' })
    expect(calls).toContain('launch wt-1')
    // Each conversation comes back in its own window, in order. No codex
    // conversation has the workspace-id pin, so `codex resume wt-1` would
    // find nothing and kill the window: it starts fresh. claude finds a
    // conversation by its id. The codex one keeps the model it launched on.
    const windows = respawn()!
    expect(windows).toMatch(new RegExp(`respawn-window -k -t yaac:codex 'codex -C /workspace [^']* --yolo --model ${FALLBACK_MODELS.codex}'`))
    expect(windows).not.toContain('resume wt-1')
    expect(windows).toMatch(/new-window -d -t yaac -n claude-2 -c \/workspace '[^']* --resume conv-2'/)
    expect(progress).toEqual(expect.arrayContaining([
      'Stopping session job yaac-wt-1...',
      'Restoring 2 agent sessions...',
      `Reusing existing workspace at ${workspaceDir(DEMO_PROJECT_ID, 'wt-1')}`,
    ]))
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-1'))?.stoppedAt).toBeUndefined()
    // `buildSnapshot` hides a workspace that still has a row, so a leftover
    // would show "Starting…" forever.
    expect(listProvisioning()).toEqual([])
  })

  // The workspace is running by then, so a lost clear must not report it
  // as failed.
  it('succeeds when clearing the stop record fails', async () => {
    await stoppedWorkspace('wt-clear')
    vi.mocked(clearWorkspaceStopped).mockRejectedValueOnce(new Error('db write failed'))
    expect(await restart('wt-clear')).toMatchObject({ workspaceId: 'wt-clear' })
    expect(listProvisioning()).toEqual([])
  })

  it('relaunches a stopped workspace with no unit to tear down, in its recorded posture and effort', async () => {
    await stoppedWorkspace('wt-2', { permissionMode: 'plan', model: 'claude-opus-4-7', effort: 'max' })
    // The agent moved itself since; the restart follows it.
    await applyWorkspaceEvent({ type: 'effort-changed', projectId: DEMO_PROJECT_ID, workspaceId: 'wt-2', effort: 'low' })

    await restart('wt-2')

    expect(calls.some((c) => c.startsWith('destroy'))).toBe(false)
    expect(respawn()).toContain('--permission-mode plan')
    expect(respawn()).toContain('--effort low')
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-2'))?.stoppedAt).toBeUndefined()
  })

  // A launch naming no model would take whatever the shared tool home holds.
  // Each conversation resumes on its own model, at the row's effort where
  // that model has it.
  it('relaunches each conversation on the model it last reported', async () => {
    await stoppedWorkspace('wt-6', { model: 'claude-opus-4-7', effort: 'max' })
    // The first switched with `/model` to a 1M context; the third never
    // reported.
    await applyWorkspaceEvent({
      type: 'sessions-launched',
      projectId: DEMO_PROJECT_ID,
      workspaceId: 'wt-6',
      sessions: [
        { tool: 'claude', agentSessionId: 'wt-6', mode: 'tui', model: 'claude-opus-5-5[1m]' },
        { tool: 'codex', agentSessionId: 'conv-2', mode: 'tui', model: 'gpt-5.5' },
        { tool: 'claude', agentSessionId: 'conv-3', mode: 'tui' },
      ],
    })

    await restart('wt-6')

    const windows = respawn()!
    // Quoted, since a bare `[1m]` is a shell glob.
    expect(windows).toMatch(/respawn-window -k -t yaac:claude '[^']* --model "claude-opus-5-5\[1m\]" --effort max --resume wt-6'/)
    // gpt-5.5 has no `max`, so it takes its own default.
    expect(windows).toMatch(/-n codex-2 [^']*'[^']*model_reasoning_effort=medium[^']* --model gpt-5\.5'/)
    expect(windows).toMatch(/-n claude-3 [^']*'(?:(?!--model)[^'])* --effort max --resume conv-3'/)
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-6'))?.model).toBe('claude-opus-5-5[1m]')
  })

  // Anything in the workspace can set the pane option a model is reported
  // through, so a value a launch could not carry bare is never relaunched.
  it('refuses a reported model a launch could not carry, falling back to the row only for the founding tool', async () => {
    await stoppedWorkspace('wt-7', { model: 'claude-opus-4-7' })
    const hostile = ['--foo; touch /tmp/pwned', '-cx', 'a b', 'opus\n--x', 'x[1m][1m]']
    await applyWorkspaceEvent({
      type: 'sessions-launched',
      projectId: DEMO_PROJECT_ID,
      workspaceId: 'wt-7',
      sessions: hostile.map((model, i) => ({
        tool: 'claude' as const, agentSessionId: i === 0 ? 'wt-7' : `conv-${String(i)}`, mode: 'tui' as const, model,
      })),
    })

    await restart('wt-7')

    const windows = respawn()!
    expect(windows).toMatch(/respawn-window -k -t yaac:claude '[^']* --model claude-opus-4-7 [^']*--resume wt-7'/)
    expect(windows.match(/--model/g)).toHaveLength(1)
    for (const fragment of ['--foo', 'pwned', '-cx', 'a b', '--x', '[1m]']) expect(windows).not.toContain(fragment)
  })

  // The row's model is the founding conversation's. Once that one has
  // closed, the first active conversation may be another tool's, which must
  // not launch on a claude model, nor put its own on the row for a later
  // claude conversation to fall back to.
  it("keeps the row's model and a first conversation on another tool apart", async () => {
    await stoppedWorkspace('wt-8', { model: 'claude-opus-4-7', effort: 'max' })
    await applyWorkspaceEvent({
      type: 'sessions-launched',
      projectId: DEMO_PROJECT_ID,
      workspaceId: 'wt-8',
      sessions: [
        { tool: 'codex', agentSessionId: 'conv-cx', mode: 'tui' },
        { tool: 'codex', agentSessionId: 'conv-2', mode: 'tui', model: 'gpt-5.5' },
      ],
    })

    await restart('wt-8')

    const windows = respawn()!
    expect(windows).toMatch(/respawn-window -k -t yaac:claude 'codex (?:(?!--model)[^'])* resume conv-cx'/)
    expect(windows).toMatch(/-n codex-2 [^']*'[^']* --model gpt-5\.5'/)
    expect(windows).not.toContain('claude-opus-4-7')
    expect(windows).not.toContain('model_reasoning_effort=max')
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-8'))?.model).toBe('claude-opus-4-7')
  })

  // Relaunching without the recorded posture would take the driver's
  // default, `bypass` in a container: a `plan` workspace must never come
  // back looser. Running, so the runtime alone names it and the row is read
  // only for what the relaunch takes from it.
  it('refuses rather than relaunch when the recorded posture cannot be read', async () => {
    await stoppedWorkspace('wt-plan', { permissionMode: 'plan' })
    live = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-plan', jobName: 'yaac-wt-plan' })
    // The first read expands the id; the second is the row the relaunch
    // takes its posture from.
    const read = vi.mocked(findWorkspaceRow)
    read.mockImplementationOnce(read.getMockImplementation()!).mockRejectedValueOnce(new Error('db read failed'))

    await expect(restart('wt-plan')).rejects.toThrow('db read failed')

    expect(calls).toEqual([])
    expect(listProvisioning()).toEqual([])
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-plan'))?.stoppedAt).toBeInstanceOf(Date)
  })

  // Starting fresh would drop every conversation the workspace had open.
  it('refuses rather than relaunch fresh when its conversations cannot be read', async () => {
    await stoppedWorkspace('wt-convs')
    vi.mocked(listActiveAgentSessions).mockRejectedValueOnce(new Error('db read failed'))

    await expect(restart('wt-convs')).rejects.toThrow('db read failed')

    expect(calls.filter((c) => c.startsWith('launch'))).toEqual([])
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-convs'))?.stoppedAt).toBeInstanceOf(Date)
  })

  // A row with no effort (a model without one, since switched by the agent
  // to one with levels) still names one: the model's default, since naming
  // none would take whatever the shared tool home holds.
  it("relaunches a row with no effort at its model's default", async () => {
    await stoppedWorkspace('wt-5', { model: 'claude-opus-4-5' })
    await applyWorkspaceEvent({
      type: 'sessions-discovered',
      projectId: DEMO_PROJECT_ID,
      workspaceId: 'wt-5',
      sessions: [{ tool: 'claude', agentSessionId: 'wt-5', model: 'claude-opus-4-7' }],
    })

    await restart('wt-5')

    expect(respawn()).toContain('--effort xhigh')
  })

  // A restart reuses the row's posture, which another build may have
  // written. Refusing it would strand a checkout, and the driver default
  // could be looser (bypass), so it launches in the nearest mode the tool
  // has that is no looser, else the tool's strictest.
  it('launches a recorded posture the tool lacks in the nearest stricter one', async () => {
    const resumedAs = async (tool: AgentTool, permissionMode: PermissionMode): Promise<string | undefined> => {
      const id = `wt-${tool}-${permissionMode}`
      await stoppedWorkspace(id, { tool })
      await applyWorkspaceEvent({ type: 'permission-mode-changed', projectId: DEMO_PROJECT_ID, workspaceId: id, permissionMode })
      await restart(id)
      return (await getWorkspaceRow(DEMO_PROJECT_ID, id))?.permissionMode
    }
    expect(await resumedAs('claude', 'manual')).toBe('manual')
    expect(await resumedAs('codex', 'plan')).toBe('read-only')
    expect(await resumedAs('claude', 'read-only')).toBe('plan')
    // pi has nothing but bypass.
    expect(await resumedAs('pi', 'plan')).toBe('bypass')
    // A mode this build does not know gets the strictest, never bypass.
    expect(await resumedAs('codex', 'dontAsk' as PermissionMode)).toBe('read-only')
  })

  it('recreates a missing checkout', async () => {
    await stoppedWorkspace('wt-gone')
    await fs.rm(workspaceDir(DEMO_PROJECT_ID, 'wt-gone'), { recursive: true })

    await restart('wt-gone')

    expect(await git(workspaceDir(DEMO_PROJECT_ID, 'wt-gone'), ['rev-parse', '--abbrev-ref', 'HEAD']))
      .toBe('agent/wt-gone\n')
  })

  // The user came back for this workspace, so a failed restart must not
  // erase it.
  it('keeps the stop record, the checkout and a failed provisioning row when the relaunch fails', async () => {
    await stoppedWorkspace('wt-3')
    installDriver({ awaitReady: () => Promise.reject(new Error('image pull failed')) })

    await expect(restart('wt-3')).rejects.toThrow('image pull failed')

    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-3'))?.stoppedAt).toBeInstanceOf(Date)
    await expect(fs.access(workspaceDir(DEMO_PROJECT_ID, 'wt-3'))).resolves.toBeUndefined()
    // Its row survives, so the teardown keeps the substrate for the
    // runtime's own sweeps.
    expect(destroys).toEqual([true])
    expect(deregistered).toEqual(['wt-3'])
    expect(listProvisioning()).toEqual([expect.objectContaining({ workspaceId: 'wt-3', error: 'image pull failed' })])
  })

  // The snapshot hides the workspace while it restarts, so the provisioning
  // row must carry its sidebar group. Read mid-flight, since success removes
  // the row.
  it('registers itself under the resolved project and the row\'s group, refusing a second restart', async () => {
    await stoppedWorkspace('wt-4')
    const group = await createWorkspaceGroup(DEMO_PROJECT_ID, 'Reviews', 'wt-4')

    const run = await prepareRestart(local, 'wt-4')

    expect(listProvisioning()).toEqual([expect.objectContaining({
      workspaceId: 'wt-4', projectId: DEMO_PROJECT_ID, tool: 'claude', kind: 'restart', groupId: group.groupId,
    })])
    await expect(prepareRestart(local, 'wt-4')).rejects.toMatchObject({ code: 'CONFLICT' })
    await run()
    expect(listProvisioning()).toEqual([])
  })

  it('expands a unique prefix before asking the runtime, and refuses an ambiguous or unknown one', async () => {
    await stoppedWorkspace('sid-1')
    await stoppedWorkspace('sid-2')
    await expect(prepareRestart(local, 'sid')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(prepareRestart(local, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(calls).toEqual([])
    expect(listProvisioning()).toEqual([])
  })

  it('refuses a caller who does not own the workspace', async () => {
    await stoppedWorkspace('wt-mine')
    const teammate = { kind: 'tailnet', login: 'bob@example.com', name: 'bob', userId: 'b0b0b0b0-0000-4000-8000-000000000000' } as const
    await expect(prepareRestart(teammate, 'wt-mine')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(listProvisioning()).toEqual([])
  })

  // The unit's mount sources go only once it is confirmed gone, and a
  // checkout path reached through a link is never followed out of it.
  it('removes the old unit\'s ephemeral dirs only once it is gone, leaving what a link points at', async () => {
    await stoppedWorkspace('wt-dirs')
    const checkout = workspaceDir(DEMO_PROJECT_ID, 'wt-dirs')
    const outside = path.join(tmpDir, 'outside')
    await fs.mkdir(path.join(outside, 'node_modules', 'kept'), { recursive: true })
    await fs.mkdir(path.join(checkout, 'node_modules', 'left-pad'), { recursive: true })
    await fs.symlink(outside, path.join(checkout, 'web'))
    // A listed path that is itself a link.
    await fs.symlink(path.join(outside, 'node_modules'), path.join(checkout, 'vendor'))
    await fs.mkdir(path.join(workspaceStateDir(DEMO_PROJECT_ID, 'wt-dirs'), 'scratch'), { recursive: true })
    await fs.mkdir(projectConfigDir(DEMO_PROJECT_ID), { recursive: true })
    await fs.writeFile(path.join(projectConfigDir(DEMO_PROJECT_ID), 'yaac-config.json'), JSON.stringify({
      ephemeralModulesPaths: ['node_modules', 'web/node_modules', 'vendor'],
    }))
    live = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-dirs', jobName: 'yaac-wt-dirs' })
    let presentAtDestroy: boolean | undefined
    installDriver({
      destroy: async () => {
        presentAtDestroy = await fs.access(path.join(checkout, 'node_modules', 'left-pad')).then(() => true, () => false)
        live = undefined
        return true
      },
    })

    // The relaunch then refuses the link, which only the teardown may skip.
    await expect(restart('wt-dirs')).rejects.toThrow(/web\/node_modules points outside its root/)

    expect(presentAtDestroy).toBe(true)
    await expect(fs.access(path.join(checkout, 'node_modules', 'left-pad'))).rejects.toThrow()
    await expect(fs.access(path.join(workspaceStateDir(DEMO_PROJECT_ID, 'wt-dirs'), 'scratch'))).rejects.toThrow()
    await expect(fs.access(path.join(outside, 'node_modules', 'kept'))).resolves.toBeUndefined()
    expect((await fs.lstat(path.join(checkout, 'vendor'))).isSymbolicLink()).toBe(true)
  })

  // A unit still shutting down may write to its checkout, so its dirs stay.
  it('keeps the old unit\'s dirs when its teardown is not confirmed, relaunching once it is gone', async () => {
    await stoppedWorkspace('wt-slow')
    const leftPad = path.join(workspaceDir(DEMO_PROJECT_ID, 'wt-slow'), 'node_modules', 'left-pad')
    await fs.mkdir(leftPad, { recursive: true })
    live = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-slow', jobName: 'yaac-wt-slow' })
    let asked = 0
    installDriver({
      destroy: () => Promise.resolve(false),
      findForTeardown: () => Promise.resolve(asked++ < 1
        ? { workspaceId: 'wt-slow', projectId: DEMO_PROJECT_ID, unitName: 'yaac-wt-slow' }
        : undefined),
      find: (id) => Promise.resolve(asked === 0 && id === 'wt-slow' ? live : undefined),
    })

    await restart('wt-slow')

    await expect(fs.access(leftPad)).resolves.toBeUndefined()
    expect(isWorkspaceTerminating('wt-slow')).toBe(false)
  })

  // A pod's preStop can hold its unit for its whole grace period.
  // Relaunching onto one that never goes would fail obscurely, so that
  // restart is refused and the workspace still reads as stopping.
  it('refuses to relaunch onto an old unit that never goes away', async () => {
    await stoppedWorkspace('wt-stuck')
    live = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-stuck', jobName: 'yaac-wt-stuck' })
    installDriver({ destroy: () => Promise.resolve(false) })
    const run = await prepareRestart(local, 'wt-stuck')

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const refused = expect(run()).rejects.toThrow('still shutting down')
      await vi.advanceTimersByTimeAsync(100_000)
      await refused
    } finally {
      vi.useRealTimers()
    }
    expect(isWorkspaceTerminating('wt-stuck')).toBe(true)
    expect(calls.some((c) => c.startsWith('launch'))).toBe(false)
  })

  // A stop returns while its detached script still runs, and under
  // containerless the runtime has already forgotten the workspace. A quick
  // restart would relaunch into a checkout the script is still cleaning.
  it('waits for a stop\'s detached teardown to exit, and clears its stopping mark', async () => {
    await created('wt-race')
    live = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-race', jobName: 'yaac-wt-race' })
    await stopWorkspace(local, 'wt-race')
    await vi.waitFor(() => { expect(teardowns.children).toHaveLength(1) })
    live = undefined
    calls = []

    let settled = false
    const restarting = restart('wt-race').then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 100))
    expect(settled).toBe(false)
    expect(calls).toEqual([])

    teardowns.children[0].emit('exit', 0)
    await restarting
    expect(calls).toContain('launch wt-race')
    expect(isWorkspaceTerminating('wt-race')).toBe(false)
  })

  // Liveness is cached per workspace id, so a relaunch under the same id
  // must not read its predecessor's verdict.
  it('forgets the old unit\'s cached liveness', async () => {
    await stoppedWorkspace('wt-live')
    _clearTmuxAliveCacheForTests()
    live = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-live', jobName: 'yaac-wt-live' })
    const target = { projectId: DEMO_PROJECT_ID, workspaceId: 'wt-live', jobName: 'yaac-wt-live' }
    expect(await probeTmuxLiveness(target)).toBe('alive')
    const probes = (): number => calls.filter((c) => c.includes('has-session')).length
    expect(probes()).toBe(1)

    await restart('wt-live')
    expect(await probeTmuxLiveness(target)).toBe('alive')
    expect(probes()).toBe(2)
  })

  // Without the runtime there is no telling whether the old unit still
  // runs, and relaunching beside it would collide.
  it('refuses when the runtime cannot be asked', async () => {
    await stoppedWorkspace('wt-x')
    installDriver({ find: () => Promise.reject(new Error('connection refused')) })
    await expect(prepareRestart(local, 'wt-x')).rejects.toThrow('connection refused')
    expect(listProvisioning()).toEqual([])
  })
})

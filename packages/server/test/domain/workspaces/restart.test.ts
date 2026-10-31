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
    listActiveConversations: vi.fn(actual.listActiveConversations),
  }
})
import { keepScratchDirsInCheckout, listProvisioning, prepareRestart, prepareStart, stopWorkspace } from '#domain/workspaces'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import {
  applyWorkspaceEvent,
  clearWorkspaceStopped,
  createWorkspaceGroup,
  findWorkspaceRow,
  getSessionRow,
  insertSession,
  listActiveConversations,
  listWorkspaceConversations,
  listWorkspaceSessions,
  getWorkspaceRow,
  type SessionRow,
  setProjectScratchDirs,
  setWorkspaceGroup,
  setWorkspaceGroupLimit,
} from '#db'
import { eq } from 'drizzle-orm'
import { closeDb, getDb } from '#db/client'
import { recordConversations } from '#db/conversation-store'
import { workspaces } from '#db/schema'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { CLAUDE_POD_CWD, projectDir, repoDir, workspaceDir, workspaceStateDir } from '@yaac/shared/project-paths'
import { isWorkspaceTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'
import { _clearTmuxAliveCacheForTests, probeTmuxLiveness } from '#runtime/status/liveness'
import type { RuntimeHandle, WorkspaceDriver } from '#drivers/contract'
import { _resetAcpRegistryForTests } from '#runtime/agents/acp-registry'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'
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
  over: {
    tool?: AgentTool; permissionMode?: PermissionMode; model?: string; effort?: string; mode?: AgentMode
    prompt?: string; branch?: string
  } = {},
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

/** A conversation's history where its tool keeps it, recorded as the
 *  registry would once it saw the file. Returns the file. */
async function history(workspaceId: string, tool: 'claude' | 'codex', conversationId: string): Promise<string> {
  const rel = tool === 'claude'
    ? path.join('history', workspaceId, 'claude', CLAUDE_POD_CWD, `${conversationId}.jsonl`)
    : path.join('history', workspaceId, 'codex', '2026', '10', '03', `rollout-2026-10-03T12-00-00-${conversationId}.jsonl`)
  const file = path.join(projectDir(DEMO_PROJECT_ID), rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, '{}\n')
  await applyWorkspaceEvent({
    type: 'conversations-discovered',
    projectId: DEMO_PROJECT_ID,
    workspaceId,
    sessions: [{ tool, conversationId, transcriptPath: rel }],
  })
  return file
}

/** Restart as the route does: checked first, then run. */
async function restart(idOrPrefix: string, onProgress?: (message: string) => void): Promise<{ workspaceId: string }> {
  return await (await prepareRestart(local, idOrPrefix))(onProgress)
}

/** The command that opened the relaunch's session windows. */
const windowsExec = (): string | undefined => calls.find((c) => c.includes('new-window -d -t yaac -n '))

/** The workspace's first session, which its create opened. */
const lead = async (workspaceId: string): Promise<SessionRow> => (await listWorkspaceSessions(workspaceId))[0]

/** Another session of the workspace, as one opened beside the first. */
const beside = (workspaceId: string, over: Partial<Parameters<typeof insertSession>[2]> = {}): Promise<SessionRow> =>
  insertSession(DEMO_PROJECT_ID, workspaceId, { tool: 'claude', mode: 'tui', permissionMode: 'bypass', ...over })

/** What a session's agent reported, as the registry records it. */
const reported = async (s: SessionRow, report: { conversationId?: string; model?: string; permissionMode?: PermissionMode; effort?: string }): Promise<void> => {
  await applyWorkspaceEvent({ type: 'session-reported', projectId: DEMO_PROJECT_ID, workspaceId: s.workspaceId, sessionId: s.id, ...report })
}

/** A session's window in the relaunch command, up to the end of its
 *  command. */
const windowOf = (s: SessionRow): string => windowsExec()?.match(new RegExp(`-n ${s.window} [^']*'[^']*'`))?.[0] ?? ''

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject()
  clearAllProvisioningForTests()
  _clearTerminatingForTests()
  teardowns.children = []
  _resetAcpRegistryForTests()
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
  it('tears down the live unit while marked in flight, relaunches every open session, and clears the stop', async () => {
    await stoppedWorkspace('wt-1', { tool: 'codex' })
    await history('wt-1', 'claude', 'conv-2')
    const claude = await beside('wt-1', { conversationId: 'conv-2' })
    const codex = await lead('wt-1')
    live = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-1', jobName: 'yaac-wt-1' })
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

    expect(result).toMatchObject({ workspaceId: 'wt-1' })
    // The row is what keeps the stale reaper from deleting the dirs the
    // create is about to mount.
    expect(calls[0]).toBe('destroy yaac-wt-1')
    expect(rowAtTeardown).toMatchObject({ workspaceId: 'wt-1', kind: 'restart', tool: 'codex' })
    expect(calls).toContain('launch wt-1')
    // Each session comes back in its own window, in order. The codex one
    // never named a conversation, so it starts fresh on the model it
    // launched on; claude resumes the one it holds.
    expect(windowsExec()!.indexOf(codex.window)).toBeLessThan(windowsExec()!.indexOf(claude.window))
    expect(windowOf(codex)).toMatch(new RegExp(`exec codex -C /workspace [^']* --yolo --model ${FALLBACK_MODELS.codex}'$`))
    expect(windowOf(codex)).not.toContain('resume')
    expect(windowOf(claude)).toMatch(/--resume conv-2'$/)
    expect(progress).toEqual(expect.arrayContaining([
      'Stopping session job yaac-wt-1...',
      'Restoring 2 sessions...',
      `Reusing existing workspace at ${workspaceDir(DEMO_PROJECT_ID, 'wt-1')}`,
    ]))
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-1'))?.stoppedAt).toBeUndefined()
    // `buildSnapshot` hides a workspace that still has a row, so a leftover
    // would show "Starting…" forever.
    expect(listProvisioning()).toEqual([])
  })

  // A chat session whose agent never connected holds its prompt and names no
  // conversation. The restart has none to load, so it starts a fresh one,
  // and the prompt stays held for the sweep to send it once that one is up.
  it('starts a chat session that never named a conversation afresh, keeping its held prompt', async () => {
    await stoppedWorkspace('wt-chat', { mode: 'acp', prompt: 'add shared projects' })
    const chat = await lead('wt-chat')
    expect(chat.pendingPrompt).toBe('add shared projects')

    await restart('wt-chat')

    expect(await listWorkspaceConversations(DEMO_PROJECT_ID, 'wt-chat')).toEqual([])
    expect((await getSessionRow(chat.id))?.pendingPrompt).toBe('add shared projects')
  })

  // A claude session's conversation is the session's own id from launch,
  // which the agent may have written to before the registry first saw it.
  // Launching it fresh under that id would be refused as in use.
  it("resumes a session that never reported its conversation under the session's own id", async () => {
    await stoppedWorkspace('wt-empty')
    const session = await lead('wt-empty')
    await history('wt-empty', 'claude', session.id)

    await restart('wt-empty')

    expect(windowOf(session)).toMatch(new RegExp(`--resume ${session.id}'$`))
  })

  // A spare has no row until claimed, so it cannot be restarted. A claim
  // opens the create's session on it; if that agent never wrote history,
  // nothing is lost and it starts fresh.
  it('refuses an unclaimed spare, and restarts a claimed one that never got a conversation', async () => {
    await expect(prepareRestart(local, 'wt-spare')).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await applyWorkspaceEvent({ type: 'workspace-created', projectId: DEMO_PROJECT_ID, workspaceId: 'wt-spare', resume: false })
    const session = await beside('wt-spare', { prompt: 'fix the bug' })
    await applyWorkspaceEvent({ type: 'workspace-stopped', projectId: DEMO_PROJECT_ID, workspaceId: 'wt-spare' })

    await restart('wt-spare')

    expect(windowOf(session)).toMatch(new RegExp(`--session-id ${session.id}'$`))
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-spare'))?.stoppedAt).toBeUndefined()
  })

  // A chat conversation that connected but was never sent anything has no
  // history to load. The session is relaunched on a fresh one, and the
  // create's prompt stays held for that one.
  it('replaces a never-prompted chat conversation with a fresh one, keeping the held prompt', async () => {
    await stoppedWorkspace('wt-quiet', { mode: 'acp', prompt: 'add shared projects' })
    const chat = await lead('wt-quiet')
    await reported(chat, { conversationId: 'acp-quiet' })

    await restart('wt-quiet')

    expect(windowOf(chat)).not.toContain('acp-quiet')
    expect((await getSessionRow(chat.id))?.pendingPrompt).toBe('add shared projects')
  })

  // The workspace is running by then, so a lost clear must not report it
  // as failed.
  it('succeeds when clearing the stop record fails', async () => {
    await stoppedWorkspace('wt-clear')
    vi.mocked(clearWorkspaceStopped).mockRejectedValueOnce(new Error('db write failed'))
    expect(await restart('wt-clear')).toMatchObject({ workspaceId: 'wt-clear' })
    expect(listProvisioning()).toEqual([])
  })

  it('relaunches a stopped workspace with no unit to tear down, each session in its recorded posture and effort', async () => {
    await stoppedWorkspace('wt-2', { permissionMode: 'plan', model: 'claude-opus-4-7', effort: 'max' })
    // The agent moved itself since; the restart follows it.
    await reported(await lead('wt-2'), { effort: 'low' })

    await restart('wt-2')

    expect(calls.some((c) => c.startsWith('destroy'))).toBe(false)
    // The checkout predates this launch, so the command that starts the
    // agent first relinks it to the main clone and brings `origin/*` up.
    expect(windowsExec()).toMatch(/^printf .*\/\.git\/objects\/info\/alternates && \{ git -C \S+ fetch /)
    expect(windowsExec()).toContain('--permission-mode plan')
    expect(windowsExec()).toContain('--effort low')
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-2'))?.stoppedAt).toBeUndefined()
  })

  // A launch naming no model would take whatever the shared tool home holds.
  // Each session resumes on its own model, at its effort where that model
  // has it.
  it('relaunches each session on the model it last reported', async () => {
    await stoppedWorkspace('wt-6', { model: 'claude-opus-4-7', effort: 'max' })
    // The first switched with `/model` to a 1M context; the third never
    // reported one.
    const first = await lead('wt-6')
    await reported(first, { model: 'claude-opus-5-5[1m]' })
    await history('wt-6', 'codex', 'conv-2')
    const codex = await beside('wt-6', { tool: 'codex', conversationId: 'conv-2', model: 'gpt-5.5', effort: 'max' })
    const third = await beside('wt-6', { effort: 'max' })

    await restart('wt-6')

    // Quoted, since a bare `[1m]` is a shell glob.
    expect(windowOf(first)).toMatch(/ --model "claude-opus-5-5\[1m\]" --effort max --session-id /)
    // gpt-5.5 has no `max`, so it takes its own default.
    expect(windowOf(codex)).toMatch(/model_reasoning_effort=medium[^']* resume conv-2 --model gpt-5\.5'$/)
    expect(windowOf(third)).not.toContain('--model')
    expect(windowOf(third)).toContain('--effort max')
    expect((await getSessionRow(first.id))?.model).toBe('claude-opus-5-5[1m]')
  })

  // Anything in the workspace can set the pane option a model is reported
  // through, so a value a launch could not carry bare is never relaunched.
  it('refuses a recorded model a launch could not carry', async () => {
    await stoppedWorkspace('wt-7', { model: 'claude-opus-4-7' })
    const hostile = ['--foo; touch /tmp/pwned', '-cx', 'a b', 'opus\n--x', 'x[1m][1m]']
    for (const model of hostile) await beside('wt-7', { model })

    await restart('wt-7')

    const windows = windowsExec()!
    expect(windowOf(await lead('wt-7'))).toContain('--model claude-opus-4-7 ')
    expect(windows.match(/--model/g)).toHaveLength(1)
    for (const fragment of ['--foo', 'pwned', '-cx', 'a b', '--x', '[1m]']) expect(windows).not.toContain(fragment)
  })

  // Relaunching without the recorded posture would take the driver's
  // default, `bypass` in a container: a `plan` workspace must never come
  // back looser. Running, so the runtime alone names it and the row is read
  // only for what the relaunch takes from it.
  it('refuses rather than relaunch when its row cannot be read', async () => {
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

  // Starting without them would drop every conversation an agent ran in a
  // terminal.
  it('refuses rather than relaunch when its conversations cannot be read', async () => {
    await stoppedWorkspace('wt-convs')
    vi.mocked(listActiveConversations).mockRejectedValueOnce(new Error('db read failed'))

    await expect(restart('wt-convs')).rejects.toThrow('db read failed')

    expect(calls.filter((c) => c.startsWith('launch'))).toEqual([])
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-convs'))?.stoppedAt).toBeInstanceOf(Date)
  })

  // An agent ran by hand in a terminal has no session of its own, so the
  // restart opens one for it, in the posture of the workspace's first
  // session, on the model it last reported.
  it('brings back a conversation an agent ran in a terminal as a session of its own', async () => {
    await stoppedWorkspace('wt-term', { permissionMode: 'plan' })
    await recordConversations(DEMO_PROJECT_ID, 'wt-term', [{ tool: 'claude', conversationId: 'conv-t', model: 'claude-opus-4-7' }])
    await history('wt-term', 'claude', 'conv-t')

    await restart('wt-term')

    const adopted = (await listWorkspaceSessions('wt-term'))[1]
    expect(adopted).toMatchObject({ tool: 'claude', mode: 'tui', permissionMode: 'plan', conversationId: 'conv-t', model: 'claude-opus-4-7' })
    expect(windowOf(adopted)).toMatch(/--permission-mode plan [^']*--resume conv-t'$/)
    expect((await listWorkspaceConversations(DEMO_PROJECT_ID, 'wt-term'))[0]?.sessionId).toBe(adopted.id)
  })

  // A session with no effort (a model without one, since switched by the
  // agent to one with levels) still names one: the model's default, since
  // naming none would take whatever the shared tool home holds.
  it("relaunches a session with no effort at its model's default", async () => {
    await stoppedWorkspace('wt-5', { model: 'claude-opus-4-5' })
    await reported(await lead('wt-5'), { model: 'claude-opus-4-7' })

    await restart('wt-5')

    expect(windowsExec()).toContain('--effort xhigh')
  })

  // A session's posture may have been written by another build. Refusing it
  // would strand a checkout, and the driver default could be looser
  // (bypass), so it launches in the nearest mode the tool has that is no
  // looser, else the tool's strictest.
  it('launches a recorded posture the tool lacks in the nearest stricter one', async () => {
    await stoppedWorkspace('wt-posture')
    const sessions = await Promise.all([
      beside('wt-posture', { permissionMode: 'manual' }),
      beside('wt-posture', { tool: 'codex', permissionMode: 'plan' }),
      // A mode this build does not know gets the strictest, never bypass.
      beside('wt-posture', { tool: 'codex', permissionMode: 'dontAsk' as PermissionMode }),
    ])

    await restart('wt-posture')

    const [manual, codexPlan, unknown] = sessions.map(windowOf)
    expect(manual).toContain('--permission-mode manual')
    expect(codexPlan).toContain('--sandbox read-only')
    expect(unknown).toContain('--sandbox read-only')
    expect(unknown).not.toContain('--yolo')
  })

  // The empty scratch dir an earlier attempt left is not the user's work.
  it('recreates a missing checkout from its base branch, or the default once origin lost that', async () => {
    const repo = repoDir(DEMO_PROJECT_ID)
    const ref = async (name: string): Promise<string> => (await git(repo, ['rev-parse', name])).trim()
    const dev = (await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'dev'])).trim()
    await git(repo, ['update-ref', 'refs/remotes/origin/dev', dev])
    await stoppedWorkspace('wt-gone', { branch: 'dev' })
    const checkout = workspaceDir(DEMO_PROJECT_ID, 'wt-gone')
    const lose = async (): Promise<void> => {
      await fs.rm(checkout, { recursive: true })
      await fs.mkdir(path.join(checkout, 'node_modules'), { recursive: true })
    }

    await lose()
    await restart('wt-gone')

    expect(await git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('agent/wt-gone\n')
    // A checkout the launch made is linked and current already.
    expect(windowsExec()).not.toContain('objects/info/alternates')
    expect((await git(checkout, ['rev-parse', 'HEAD'])).trim()).toBe(dev)

    await applyWorkspaceEvent({ type: 'workspace-stopped', projectId: DEMO_PROJECT_ID, workspaceId: 'wt-gone' })
    await lose()
    await git(repo, ['update-ref', '-d', 'refs/remotes/origin/dev'])
    await restart('wt-gone')

    expect((await git(checkout, ['rev-parse', 'HEAD'])).trim()).toBe(await ref('origin/main'))
  })

  // A crash or partial restore can lose `.git` but keep the work. Checking
  // out the base branch over it would overwrite every tracked file, so any
  // file, however deep, refuses; a dir it cannot read fails without one.
  it('refuses to check out over a checkout that has files but no .git, keeping it stopped', async () => {
    await stoppedWorkspace('wt-nogit')
    const checkout = workspaceDir(DEMO_PROJECT_ID, 'wt-nogit')
    const [tracked] = (await git(checkout, ['ls-files'])).split('\n')
    await fs.rm(path.join(checkout, '.git'), { recursive: true })
    await fs.writeFile(path.join(checkout, tracked), 'restored work\n')

    await expect(restart('wt-nogit')).rejects.toThrow(`${checkout} holds files but no .git`)

    expect(await fs.readFile(path.join(checkout, tracked), 'utf8')).toBe('restored work\n')
    await expect(fs.access(path.join(checkout, '.git'))).rejects.toThrow()
    expect(calls.some((c) => c.startsWith('launch'))).toBe(false)
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-nogit'))?.stoppedAt).toBeInstanceOf(Date)
    expect(listProvisioning()).toEqual([expect.objectContaining({
      workspaceId: 'wt-nogit', error: expect.stringContaining('no .git') as unknown,
    })])

    const nested = path.join(checkout, 'notes', 'deeper', 'work.md')
    await fs.rm(checkout, { recursive: true })
    await fs.mkdir(path.dirname(nested), { recursive: true })
    await fs.writeFile(nested, 'deep work\n')
    clearAllProvisioningForTests()
    await expect(restart('wt-nogit')).rejects.toThrow('holds files but no .git')
    expect(await fs.readFile(nested, 'utf8')).toBe('deep work\n')

    // Root reads a mode-0 dir anyway.
    if (process.getuid?.() === 0) return
    await fs.rm(path.join(checkout, 'notes'), { recursive: true })
    await fs.mkdir(path.join(checkout, 'locked'), { mode: 0 })
    clearAllProvisioningForTests()
    try {
      await expect(restart('wt-nogit')).rejects.toThrow('EACCES')
    } finally {
      await fs.chmod(path.join(checkout, 'locked'), 0o700)
    }
    await expect(fs.access(path.join(checkout, '.git'))).rejects.toThrow()
    expect(calls.some((c) => c.startsWith('launch'))).toBe(false)
  })

  // History on disk is resumed, recorded or not (a pod can die before the
  // registry's first look). A conversation whose agent never wrote anything
  // (stopped before its first prompt, or by a crash mid-create) starts as a
  // create's would. One that wrote history and lost it is corruption:
  // resuming it would kill its agent and starting over would drop the work,
  // so the restart fails, naming each, before anything launches.
  it('resumes what is on disk, starts a never-written conversation fresh, and refuses one that lost its history', async () => {
    await stoppedWorkspace('wt-lost', { prompt: 'never delivered' })
    const fresh = await lead('wt-lost')
    const written = [await history('wt-lost', 'codex', 'conv-cx'), await history('wt-lost', 'claude', 'conv-3')]
    const codex = await beside('wt-lost', { tool: 'codex', conversationId: 'conv-cx' })
    const claude = await beside('wt-lost', { conversationId: 'conv-3' })
    const unrecorded = await beside('wt-lost', { conversationId: 'conv-4' })
    await fs.writeFile(path.join(projectDir(DEMO_PROJECT_ID), 'history', 'wt-lost', 'claude', CLAUDE_POD_CWD, 'conv-4.jsonl'), '{}\n')

    await restart('wt-lost')

    expect(windowOf(fresh)).toMatch(new RegExp(`--session-id ${fresh.id}'$`))
    expect(windowOf(codex)).toMatch(/ resume conv-cx'$/)
    expect(windowOf(claude)).toMatch(/--resume conv-3'$/)
    expect(windowOf(unrecorded)).toMatch(/--resume conv-4'$/)
    // A resumed session's opening message is not typed in again.
    expect(calls.some((c) => c.includes('.yaac-prompt-'))).toBe(false)

    await applyWorkspaceEvent({ type: 'workspace-stopped', projectId: DEMO_PROJECT_ID, workspaceId: 'wt-lost' })
    for (const file of written) await fs.rm(file)
    calls = []
    await expect(restart('wt-lost')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/history of Codex conversation conv-cx, Claude Code conversation conv-3 is gone/) as unknown,
    })
    expect(calls.some((c) => c.startsWith('launch'))).toBe(false)
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-lost'))?.stoppedAt).toBeInstanceOf(Date)

    // Under acp the record shows a message was sent, so a transcript was
    // written.
    await stoppedWorkspace('wt-acp', { mode: 'acp' })
    await recordConversations(DEMO_PROJECT_ID, 'wt-acp', [{ tool: 'claude', conversationId: 'acp-1', mode: 'acp', firstPrompt: 'hello' }])
    await reported(await lead('wt-acp'), { conversationId: 'acp-1' })
    await expect(restart('wt-acp')).rejects.toThrow('history of Claude Code conversation acp-1 is gone')
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

  // docs/workspace-groups.md
  it('refuses a stopped workspace into its group at its workspace limit, but not a running member', async () => {
    await stoppedWorkspace('wt-cap')
    await created('wt-busy')
    const group = await createWorkspaceGroup(DEMO_PROJECT_ID, 'Workers', 'wt-cap')
    await setWorkspaceGroup(DEMO_PROJECT_ID, 'wt-busy', group.groupId)
    await setWorkspaceGroupLimit(DEMO_PROJECT_ID, group.groupId, 1)
    const busy = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-busy', jobName: 'yaac-wt-busy' })
    installDriver({ list: () => Promise.resolve([busy]) })

    await expect(prepareRestart(local, 'wt-cap')).rejects.toMatchObject({
      code: 'CONFLICT', message: expect.stringMatching(/group "Workers" is at its workspace limit of 1 \(running or starting\);/) as string,
    })
    expect(listProvisioning()).toEqual([])

    // A running member already holds its slot.
    live = busy
    await expect(restart('wt-busy')).resolves.toMatchObject({ workspaceId: 'wt-busy' })
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
  it('removes the old unit\'s scratch dirs only once it is gone, leaving what a link points at', async () => {
    await setProjectScratchDirs(DEMO_PROJECT_ID, { dirs: [{ path: 'node_modules', sizeGiB: 8 }, { path: 'web/node_modules', sizeGiB: 8 }, { path: 'vendor', sizeGiB: 8 }] })
    await stoppedWorkspace('wt-dirs')
    const checkout = workspaceDir(DEMO_PROJECT_ID, 'wt-dirs')
    const outside = path.join(tmpDir, 'outside')
    await fs.mkdir(path.join(outside, 'node_modules', 'kept'), { recursive: true })
    await fs.mkdir(path.join(checkout, 'node_modules', 'left-pad'), { recursive: true })
    // The start made both as dirs; a link is put in each one's place.
    await fs.rm(path.join(checkout, 'web'), { recursive: true })
    await fs.rm(path.join(checkout, 'vendor'), { recursive: true })
    await fs.symlink(outside, path.join(checkout, 'web'))
    // A listed path that is itself a link.
    await fs.symlink(path.join(outside, 'node_modules'), path.join(checkout, 'vendor'))
    await fs.mkdir(path.join(workspaceStateDir(DEMO_PROJECT_ID, 'wt-dirs'), 'scratch'), { recursive: true })
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

  // A dir the project lists only since the workspace started is real
  // content in its checkout, so it stays.
  it('removes the scratch dirs the old unit was started with, not ones the project lists since', async () => {
    await stoppedWorkspace('wt-listed')
    const checkout = workspaceDir(DEMO_PROJECT_ID, 'wt-listed')
    await fs.mkdir(path.join(checkout, 'node_modules', 'left-pad'), { recursive: true })
    await fs.mkdir(path.join(checkout, 'vendor'), { recursive: true })
    await fs.writeFile(path.join(checkout, 'vendor', 'kept.txt'), 'mine\n')
    await setProjectScratchDirs(DEMO_PROJECT_ID, { dirs: [{ path: 'node_modules', sizeGiB: 8 }, { path: 'vendor', sizeGiB: 8 }] })
    live = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-listed', jobName: 'yaac-wt-listed' })
    installDriver({ destroy: () => { live = undefined; return Promise.resolve(true) } })

    await restart('wt-listed')

    await expect(fs.access(path.join(checkout, 'node_modules', 'left-pad'))).rejects.toThrow()
    expect(await fs.readFile(path.join(checkout, 'vendor', 'kept.txt'), 'utf8')).toBe('mine\n')
    // The restart is started with the project's list as it is now.
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-listed'))?.scratchDirs).toEqual(['node_modules', 'vendor'])
  })

  // A scratch dir is emptied at stop even where git tracks files in it: they
  // stay in its history. "Keep in the checkout and restart" first takes the
  // dir off the workspace's own list, so that restart's stop keeps it.
  it('empties a scratch dir git tracks, unless it was kept in the checkout first', async () => {
    const tracked = async (workspaceId: string): Promise<string> => {
      await stoppedWorkspace(workspaceId)
      await applyWorkspaceEvent({ type: 'tracked-scratch-dirs-found', projectId: DEMO_PROJECT_ID, workspaceId, paths: ['target'] })
      const checkout = workspaceDir(DEMO_PROJECT_ID, workspaceId)
      await fs.mkdir(path.join(checkout, 'node_modules', 'left-pad'), { recursive: true })
      await fs.writeFile(path.join(checkout, 'target', 'out.bin'), 'tracked\n')
      live = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId, jobName: `yaac-${workspaceId}` })
      installDriver({ destroy: () => { live = undefined; return Promise.resolve(true) } })
      return checkout
    }

    const emptied = await tracked('wt-tracked')
    await restart('wt-tracked')
    await expect(fs.access(path.join(emptied, 'target', 'out.bin'))).rejects.toThrow()

    const kept = await tracked('wt-kept')
    await keepScratchDirsInCheckout(local, 'wt-kept', ['target'])
    await restart('wt-kept')
    await expect(fs.access(path.join(kept, 'node_modules', 'left-pad'))).rejects.toThrow()
    expect(await fs.readFile(path.join(kept, 'target', 'out.bin'), 'utf8')).toBe('tracked\n')
  })

  // One started before its list was recorded, by a release whose default
  // was node_modules alone: its `target/` is real content.
  it('removes only node_modules for an old unit started before scratch dirs were recorded', async () => {
    await stoppedWorkspace('wt-legacy')
    await (await getDb()).update(workspaces).set({ scratchDirs: null })
      .where(eq(workspaces.workspaceId, 'wt-legacy'))
    const checkout = workspaceDir(DEMO_PROJECT_ID, 'wt-legacy')
    await fs.mkdir(path.join(checkout, 'node_modules', 'left-pad'), { recursive: true })
    await fs.writeFile(path.join(checkout, 'target', 'out.bin'), 'built\n')
    live = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-legacy', jobName: 'yaac-wt-legacy' })
    installDriver({ destroy: () => { live = undefined; return Promise.resolve(true) } })

    await restart('wt-legacy')

    await expect(fs.access(path.join(checkout, 'node_modules', 'left-pad'))).rejects.toThrow()
    expect(await fs.readFile(path.join(checkout, 'target', 'out.bin'), 'utf8')).toBe('built\n')
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
    // The create's own window check may still land; nothing is relaunched.
    expect(calls.filter((c) => /^(launch|destroy) /.test(c))).toEqual([])

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

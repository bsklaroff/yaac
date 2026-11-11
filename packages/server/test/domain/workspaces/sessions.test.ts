import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  changeSessionAgentOptions,
  closeSession,
  openSession,
  reconcileSessions,
  renameSession,
  resumeSession,
} from '#domain/workspaces/sessions'
import { clearAllProvisioningForTests, registerProvisioning } from '#domain/workspaces/provisioning'
import {
  BUILT_IN_USER_ID,
  applyWorkspaceEvent,
  getSessionRow,
  insertSession,
  listWorkspaceSessions,
  markSessionsLaunched,
} from '#db'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { recordConversations } from '#db/conversation-store'
import { closeDb } from '#db/client'
import { setWorkspaceWindows, _resetWorkspaceStatusStoreForTests } from '#runtime/status/status-store'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { KEEPER_STARTING, KEEPER_WINDOW, type RuntimeHandle, type RuntimeSnapshot, type WorkspaceWindow } from '#drivers/contract'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const WS = 'w1'
const unit: RuntimeHandle = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: WS, jobName: `yaac-${WS}` })

let tmpDir: string
/** Every command the workspace ran, in order. */
let execs: string[]
/** Fail the next exec, as a launch into a broken tmux would. */
let failExec: boolean

const view: RuntimeSnapshot = {
  resync: false,
  takenAtMs: 0,
  workspaces: () => Promise.resolve([unit]),
  strayUnits: () => Promise.resolve([]),
}

/** The windows the workspace's watcher lists. */
function listed(...names: string[]): void {
  const windows: WorkspaceWindow[] = names.map((name, i) => ({ id: `@${String(i)}`, name, dead: false }))
  setWorkspaceWindows(DEMO_PROJECT_ID, WS, windows)
}

/** The session windows the workspace has been asked to open. */
const opened = (): string[] => execs.flatMap((c) => [...c.matchAll(/new-window -d -t yaac -n (\S+)/g)].map((m) => m[1]))

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  _resetWorkspaceStatusStoreForTests()
  clearAllProvisioningForTests()
  execs = []
  failExec = false
  installFakeWorkspaceDriver({
    find: (id) => Promise.resolve(id === WS ? unit : undefined),
    exec: (_job, cmd) => {
      if (failExec && cmd.includes('new-window')) return Promise.reject(new Error('no server running'))
      execs.push(cmd)
      return Promise.resolve({ stdout: '', stderr: '' })
    },
  })
  await seedProject()
  await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: WS })
  await applyWorkspaceEvent({ type: 'workspace-life-started', projectId: DEMO_PROJECT_ID, workspaceId: WS, at: new Date(), startSteps: {} })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('openSession', () => {
  it('opens a session beside the others, resolving its settings as a create does, and launches its window', async () => {
    const first = await openSession(local, WS, { tool: 'claude', mode: 'tui', prompt: 'port the lexer' })
    const second = await openSession(local, WS, { tool: 'claude', mode: 'acp', permissionMode: 'plan', title: 'Reviewer' })

    expect(first).toMatchObject({ tool: 'claude', mode: 'tui', ordinal: 0, firstPrompt: 'port the lexer' })
    expect(second).toMatchObject({ mode: 'acp', permissionMode: 'plan', title: 'Reviewer' })
    expect(opened()).toEqual([first.window, second.window])
    // Its agent's commands learn which session they run in.
    expect(execs.join('\n')).toContain(`export YAAC_SESSION_ID=${first.id}; `)
    expect((await getSessionRow(first.id))?.launchedAt).toBeInstanceOf(Date)
    // A tui session's agent is launched with its opening message, left for
    // it before its window opens.
    const opening = `/tmp/.yaac-opening-${first.window}`
    const write = execs.findIndex((c) => c.startsWith(`cat > ${opening} `))
    expect(write).toBeGreaterThanOrEqual(0)
    expect(write).toBeLessThan(execs.findIndex((c) => c.includes(`-n ${first.window} `)))
    expect(execs.join('\n')).toContain(`-- "$(cat ${opening}; rm -f ${opening}) "'`)
  })

  it('opens each session with every agent option its tool has, a named one remembered as the project\'s next', async () => {
    const claude = await openSession(local, WS, { tool: 'claude', mode: 'tui', agentOptions: { idleCompaction: true }, rememberDefaults: true })
    expect(claude.agentOptions).toEqual({ idleCompaction: true })
    const launch = execs.join('\n')
    // Every agent finds its options on its window; claude's terminal UI also
    // takes its own as a flag.
    expect(launch).toContain(`set-option -wq -t "=yaac:=${claude.window}" @yaac-idle-compaction on; `)
    expect(launch).toContain('--settings "{\\"idleCompaction\\":true}"')

    expect((await openSession(local, WS, { tool: 'claude', mode: 'acp' })).agentOptions).toEqual({ idleCompaction: true })
    // Another tool's are its own, off until picked.
    expect((await openSession(local, WS, { tool: 'pi', mode: 'tui' })).agentOptions).toEqual({ idleCacheWarming: false })
    expect((await openSession(local, WS, { tool: 'codex', mode: 'tui' })).agentOptions).toEqual({})
    await expect(openSession(local, WS, { tool: 'codex', agentOptions: { idleCompaction: true } }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('opens a session on one of the workspace\'s conversations, in its own tool and mode, and refuses one it does not hold', async () => {
    await recordConversations(DEMO_PROJECT_ID, WS, [{ tool: 'claude', conversationId: 'conv-1', mode: 'acp' }])
    await expect(openSession(local, WS, { resume: 'conv-nope' })).rejects.toMatchObject({ code: 'VALIDATION' })
    const session = await openSession(local, WS, { tool: 'codex', mode: 'tui', resume: 'conv-1' })
    expect(session).toMatchObject({ tool: 'claude', mode: 'acp', conversationId: 'conv-1' })
  })

  // A conversation whose agent wrote history that is gone would be killed by
  // a resume that cannot load it, so the open fails and leaves no session.
  it('refuses a conversation whose history is gone, leaving no session behind', async () => {
    await recordConversations(DEMO_PROJECT_ID, WS, [{ tool: 'codex', conversationId: 'thread-1', mode: 'tui' }])
    await expect(openSession(local, WS, { resume: 'thread-1' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await listWorkspaceSessions(WS)).toEqual([])
  })

  it('closes the session again when its window cannot be launched', async () => {
    failExec = true
    await expect(openSession(local, WS, { tool: 'claude', mode: 'tui' })).rejects.toThrow('no server running')
    expect(await listWorkspaceSessions(WS)).toEqual([])
  })

  it('refuses a workspace that is not running', async () => {
    await expect(openSession(local, 'gone', { tool: 'claude' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('closeSession', () => {
  it('closes the session and kills its window, leaving the workspace running', async () => {
    const session = await openSession(local, WS, { tool: 'claude', mode: 'tui' })
    await closeSession(local, session.id)
    expect(execs.at(-1)).toContain(`kill-window -t =yaac:=${session.window}`)
    expect((await getSessionRow(session.id))?.closedAt).toBeInstanceOf(Date)
    expect(execs.some((c) => c.includes('kill-server') || c.includes('kill-session'))).toBe(false)
    await expect(closeSession(local, session.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('resumeSession', () => {
  // An exited agent keeps its window, which the resume relaunches in place;
  // one whose window is gone gets a new one.
  it('relaunches an exited agent in the window it kept, or a new one', async () => {
    const session = await openSession(local, WS, { tool: 'claude', mode: 'tui' })
    listed(KEEPER_WINDOW, session.window)
    execs = []
    await resumeSession(local, session.id)
    expect(execs.join('\n')).toContain(`respawn-window -k -t =yaac:=${session.window}`)

    listed(KEEPER_WINDOW)
    execs = []
    await resumeSession(local, session.id)
    expect(opened()).toEqual([session.window])
  })
})

describe('changeSessionAgentOptions', () => {
  it('records a running session\'s change and sets it on its window, refusing an option its tool lacks or its mode fixes', async () => {
    const pi = await openSession(local, WS, { tool: 'pi', mode: 'tui' })
    execs = []
    await changeSessionAgentOptions(local, pi.id, { idleCacheWarming: true })
    expect((await getSessionRow(pi.id))?.agentOptions).toEqual({ idleCacheWarming: true })
    expect(execs).toHaveLength(1)
    expect(execs[0]).toMatch(new RegExp(`set-option -wq -t "=yaac:=${pi.window}" @yaac-idle-cache-warming on$`))

    await expect(changeSessionAgentOptions(local, pi.id, { idleCompaction: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    // claude's terminal UI reads its option only at launch.
    const claude = await openSession(local, WS, { tool: 'claude', mode: 'tui' })
    await expect(changeSessionAgentOptions(local, claude.id, { idleCompaction: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await getSessionRow(claude.id))?.agentOptions).toEqual({ idleCompaction: false })
  })
})

describe('renameSession', () => {
  it('names a session, and clears the name on a blank one', async () => {
    const session = await openSession(local, WS, { tool: 'claude', mode: 'tui' })
    await renameSession(local, session.id, 'Lead')
    expect((await getSessionRow(session.id))?.title).toBe('Lead')
    await renameSession(local, session.id, '')
    expect((await getSessionRow(session.id))?.title).toBeUndefined()
  })
})

describe('reconcileSessions', () => {
  const claude = { tool: 'claude', mode: 'tui', permissionMode: 'bypass' } as const

  // One opened while the workspace was stopped, or whose launch a server
  // restart cut off, has no window in this life.
  it('launches an open session with no window in this life', async () => {
    const session = await insertSession(DEMO_PROJECT_ID, WS, claude)
    listed(KEEPER_WINDOW)
    await reconcileSessions(view)
    expect(opened()).toEqual([session.window])
    // Launched now, so the next pass waits for the watcher to list it.
    execs = []
    await reconcileSessions(view)
    expect(opened()).toEqual([])
  })

  it('closes a session whose window was seen and then went away', async () => {
    const session = await insertSession(DEMO_PROJECT_ID, WS, claude)
    await markSessionsLaunched([session.id])
    listed(KEEPER_WINDOW, session.window)
    await reconcileSessions(view)
    listed(KEEPER_WINDOW)
    await reconcileSessions(view)
    expect((await getSessionRow(session.id))?.closedAt).toBeInstanceOf(Date)
    expect(opened()).toEqual([])
  })

  // A runtime started before sessions has no keeper, and an agent that
  // quits there takes its window with it, which is no close by the user.
  it('leaves alone a runtime with no keeper', async () => {
    const session = await insertSession(DEMO_PROJECT_ID, WS, claude)
    listed(session.window, 'shell')
    await reconcileSessions(view)
    listed('shell')
    await reconcileSessions(view)
    expect((await getSessionRow(session.id))?.closedAt).toBeUndefined()
    expect(opened()).toEqual([])
  })

  // A restart that could not clear the stop record leaves it older than the
  // life; one newer than the life is a stop.
  it('reconciles a workspace whose stop record predates its life, and not one stopped since', async () => {
    const session = await insertSession(DEMO_PROJECT_ID, WS, claude)
    listed(KEEPER_WINDOW)
    await recordWorkspaceStopped(DEMO_PROJECT_ID, WS)
    await reconcileSessions(view)
    expect(opened()).toEqual([])
    // Past the stop's millisecond, so the life is strictly newer.
    await new Promise((resolve) => setTimeout(resolve, 2))
    await applyWorkspaceEvent({ type: 'workspace-life-started', projectId: DEMO_PROJECT_ID, workspaceId: WS, at: new Date(), startSteps: {} })
    await reconcileSessions(view)
    expect(opened()).toEqual([session.window])
  })

  it('waits while the workspace is still being set up, or its windows are not listed yet', async () => {
    await insertSession(DEMO_PROJECT_ID, WS, claude)
    await reconcileSessions(view)
    listed(KEEPER_STARTING)
    await reconcileSessions(view)
    listed(KEEPER_WINDOW)
    registerProvisioning({ workspaceId: WS, projectId: DEMO_PROJECT_ID, kind: 'restart' })
    await reconcileSessions(view)
    expect(opened()).toEqual([])
  })
})

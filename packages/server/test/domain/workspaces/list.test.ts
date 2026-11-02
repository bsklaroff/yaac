import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver } from '#test/support/fake-driver'
// Only the runtime is faked; the listing joins real rows with real status
// observation.
import { markWorkspaceTerminating, isWorkspaceTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'
import {
  setAgentStatus,
  setLiveAgents,
  setWorkspaceStreamHealth,
  setWorkspaceWindows,
  _resetWorkspaceStatusStoreForTests,
} from '#runtime/status/status-store'
import { closeDb } from '#db/client'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#lib/notify'
import { recordWorkspaceCreated, setWorkspaceTitle } from '#db/workspace-store'
import { insertSession } from '#db/session-store'
import { recordConversations } from '#db/conversation-store'
import {
  listActiveWorkspaces,
  _clearListActiveInflightForTests,
} from '#domain/workspaces/list'
import { HELD_PROMPT_GRACE_MS } from '#domain/workspaces/conversation-registry'
import type { RuntimeHandle, WorkspaceDriver } from '#drivers/contract'
import type { WorkspaceListEntry } from '@yaac/shared/types'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'

const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
const VALID = '9f7d0ee8-2b6a-4ca7-8dea-e841f3253059'

/** Install a runtime listing `handles`. */
function running(handles: RuntimeHandle[], overrides: Partial<WorkspaceDriver> = {}): void {
  installFakeWorkspaceDriver({ list: () => Promise.resolve(handles), ...overrides })
}

/** A running workspace of project demo. */
const live = (workspaceId: string, over: Partial<RuntimeHandle> = {}): RuntimeHandle =>
  handleFixture({ workspaceId, projectId: DEMO_PROJECT_ID, jobName: `yaac-${workspaceId}`, ...over })

describe('listActiveWorkspaces', () => {
  let tmpDir: string

  beforeEach(async () => {
    running([])
    tmpDir = await createTempDataDir()
    _clearListActiveInflightForTests()
    _clearTerminatingForTests()
    _resetWorkspaceStatusStoreForTests()
  })

  afterEach(async () => {
    vi.useRealTimers()
    _clearTerminatingForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('filters by a recorded project, and refuses an unknown one', async () => {
    await recordTestProject(VALID)
    expect((await listActiveWorkspaces(VALID)).workspaces).toEqual([])
    await expect(listActiveWorkspaces('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('renders a stopping pod as a non-interactive stopping row, not stale', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'dying' })
    await insertSession(DEMO_PROJECT_ID, 'dying', { tool: 'claude', mode: 'tui', permissionMode: 'bypass', model: 'claude-sonnet-5' })
    running([live('dying', { running: false, terminating: true })])
    const result = await listActiveWorkspaces()
    expect(result.stale).toEqual([])
    expect(result.workspaces).toHaveLength(1)
    const row = result.workspaces[0]
    expect(row.workspaceId).toBe('dying')
    expect(row.stopping).toBe(true)
    // Forced 'running' with no waiting stamp, so no attention badge fires.
    expect(row.status).toBe('running')
    expect(row.waitingSinceMs).toBeUndefined()
    // Its sessions stay listed, so the row keeps naming its model, but
    // carry no live status of their own.
    expect(row.sessions).toHaveLength(1)
    expect(row.sessions[0]).toMatchObject({ model: 'claude-sonnet-5' })
    expect(row.sessions[0].status).toBeUndefined()
  })

  it('prunes a stopping mark once its pod is gone', async () => {
    markWorkspaceTerminating('ghost')
    // Its unit is already torn down.
    await listActiveWorkspaces()
    expect(isWorkspaceTerminating('ghost')).toBe(false)
  })

  it('returns empty arrays with no session pods', async () => {
    const result = await listActiveWorkspaces()
    expect(result.workspaces).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('hides prewarmed spares from the active session list', async () => {
    running([live('spare1', { prewarmed: true })])
    const result = await listActiveWorkspaces()
    // Filtered out before classify, so it never reaches the status probes.
    expect(result.workspaces).toEqual([])
    expect(result.stale).toEqual([])
  })

  it("titles a workspace the user has not named with its agent's own title, else its generated one", async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'generated', generatedTitle: 'From the draft' })
    await recordConversations(DEMO_PROJECT_ID, 'generated', [
      { tool: 'pi', conversationId: 'generated', firstPrompt: 'the parser drops tokens' },
    ])
    for (const workspaceId of ['agent-titled', 'renamed']) {
      await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId, generatedTitle: 'From the draft' })
      await recordConversations(DEMO_PROJECT_ID, workspaceId, [
        { tool: 'claude', conversationId: workspaceId, firstPrompt: 'the parser drops tokens', title: 'Parser token loss' },
      ])
    }
    await setWorkspaceTitle(DEMO_PROJECT_ID, 'renamed', 'Mine')
    running([live('agent-titled'), live('renamed'), live('generated')])
    const titles = (await listActiveWorkspaces(DEMO_PROJECT_ID)).workspaces.map((w) => [w.workspaceId, w.title, w.prompt])
    expect(titles).toEqual(expect.arrayContaining([
      ['agent-titled', 'Parser token loss', 'the parser drops tokens'],
      ['renamed', 'Mine', 'the parser drops tokens'],
      ['generated', 'From the draft', 'the parser drops tokens'],
    ]))
  })

  // A chat session's opening message is held for its conversation, so until
  // the agent records one the session's own stands in. Its agent is starting
  // on that message, so the session and its workspace list as working rather
  // than as an unread wait, booting or connected idle, until a start that
  // has outlasted the hand-over's waits shows as the wait it is. That grace
  // runs from the latest of the session's opening, the runtime's creation
  // and the wait's start, so neither a slow build and boot nor a spare
  // attached long before its claim uses it up. An ask still shows.
  it('lists each open session in its mode, and a chat holding its opening message as working while it starts', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const created = 1_000_000
    const booted = created + 10 * HELD_PROMPT_GRACE_MS
    vi.setSystemTime(created)
    await recordTestProject(DEMO_PROJECT_ID)
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'held' })
    const held = await insertSession(DEMO_PROJECT_ID, 'held', { tool: 'claude', mode: 'acp', permissionMode: 'bypass', prompt: 'fix the lexer' })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'term' })
    await insertSession(DEMO_PROJECT_ID, 'term', { tool: 'claude', mode: 'tui', permissionMode: 'bypass' })
    await recordConversations(DEMO_PROJECT_ID, 'term', [{ tool: 'claude', conversationId: 'term', firstPrompt: 'port the parser' }])
    // A spare warmed and attached now, and claimed once 'held' is up.
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'claimed' })
    setWorkspaceStreamHealth(DEMO_PROJECT_ID, 'claimed', true)
    running([live('held', { createdAtMs: booted }), live('term'), live('claimed', { createdAtMs: created })])
    vi.setSystemTime(booted)
    await insertSession(DEMO_PROJECT_ID, 'claimed', { tool: 'claude', mode: 'acp', permissionMode: 'bypass', prompt: 'tidy the docs' })
    const list = async (): Promise<unknown[][]> => {
      _clearListActiveInflightForTests()
      return (await listActiveWorkspaces(DEMO_PROJECT_ID)).workspaces.map((w) => [
        w.workspaceId, w.sessions.map((s) => s.mode), w.prompt, w.status, w.waitingSinceMs, w.asking,
        w.sessions.map((s) => [s.status, s.waitingSinceMs]),
      ])
    }
    const unclassified = [[undefined, undefined]]
    expect(await list()).toEqual(expect.arrayContaining([
      ['held', ['acp'], 'fix the lexer', 'running', undefined, undefined, unclassified],
      ['claimed', ['acp'], 'tidy the docs', 'running', undefined, undefined, unclassified],
      ['term', ['tui'], 'port the parser', 'waiting', undefined, undefined, unclassified],
    ]))
    // A start that changes nothing else is republished when its grace ends.
    const republished = vi.fn()
    onWorkspaceListChanged(republished)
    vi.advanceTimersByTime(HELD_PROMPT_GRACE_MS - 1)
    expect(republished).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(republished).toHaveBeenCalledOnce()
    _resetWorkspaceListChangedForTests()
    expect(await list()).toEqual(expect.arrayContaining([
      ['held', ['acp'], 'fix the lexer', 'waiting', undefined, undefined, unclassified],
      ['claimed', ['acp'], 'tidy the docs', 'waiting', created, undefined, unclassified],
    ]))

    // The agent attaches long after its runtime came up, then connects idle
    // before the prompt is sent.
    const attached = booted + 10 * HELD_PROMPT_GRACE_MS
    vi.setSystemTime(attached)
    setWorkspaceStreamHealth(DEMO_PROJECT_ID, 'held', true)
    expect(await list()).toContainEqual(['held', ['acp'], 'fix the lexer', 'running', undefined, undefined, unclassified])
    setLiveAgents(DEMO_PROJECT_ID, 'held', [{ handle: held.window, tool: 'claude', conversationId: 'conv' }])
    setAgentStatus(DEMO_PROJECT_ID, 'held', held.window, 'waiting')
    expect(await list()).toContainEqual(['held', ['acp'], 'fix the lexer', 'running', undefined, undefined, [['running', undefined]]])

    vi.setSystemTime(attached + HELD_PROMPT_GRACE_MS)
    expect(await list()).toContainEqual(
      ['held', ['acp'], 'fix the lexer', 'waiting', attached, undefined, [['waiting', attached]]],
    )

    vi.setSystemTime(attached)
    setAgentStatus(DEMO_PROJECT_ID, 'held', held.window, 'asking')
    expect(await list()).toContainEqual(
      ['held', ['acp'], 'fix the lexer', 'waiting', attached, true, [['waiting', attached]]],
    )
  })

  // Status comes from each session's window. A dead pane is an exited
  // session, waiting on the user to resume or close it since its agent was
  // first seen dead, which makes its workspace wait too; a workspace with no
  // session is idle. Terminals are the windows that are neither a session's
  // nor the keeper.
  it("joins each session's status by its window, and lists the other windows as terminals", async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'w1' })
    const a = await insertSession(DEMO_PROJECT_ID, 'w1', { tool: 'claude', mode: 'tui', permissionMode: 'bypass' })
    const b = await insertSession(DEMO_PROJECT_ID, 'w1', { tool: 'codex', mode: 'acp', permissionMode: 'bypass' })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'empty' })
    setLiveAgents(DEMO_PROJECT_ID, 'w1', [{ handle: a.window, tool: 'claude' }])
    setAgentStatus(DEMO_PROJECT_ID, 'w1', a.window, 'running')
    setWorkspaceWindows(DEMO_PROJECT_ID, 'w1', [
      { id: '@0', name: '_yaac', dead: false },
      { id: '@1', name: a.window, dead: false },
      { id: '@2', name: b.window, dead: true },
      { id: '@3', name: 'shell', dead: false },
    ])
    running([live('w1'), live('empty')])
    const list = async (): Promise<Map<string, WorkspaceListEntry>> => {
      _clearListActiveInflightForTests()
      return new Map((await listActiveWorkspaces(DEMO_PROJECT_ID)).workspaces.map((w) => [w.workspaceId, w]))
    }
    const byId = await list()
    const w1 = byId.get('w1')!
    const died = w1.sessions[1].waitingSinceMs
    expect(died).toEqual(expect.any(Number))
    expect(w1).toMatchObject({ status: 'waiting', waitingSinceMs: died })
    expect(w1.sessions.map((s) => [s.sessionId, s.status, s.exited])).toEqual([[a.id, 'running', undefined], [b.id, 'waiting', true]])
    expect(w1.terminals).toEqual([{ target: 'window:@3', name: 'shell' }])
    expect(byId.get('empty')?.status).toBe('idle')

    // An open ask outranks the exit; a resumed agent is live again.
    setAgentStatus(DEMO_PROJECT_ID, 'w1', a.window, 'asking')
    expect((await list()).get('w1')).toMatchObject({ status: 'waiting', asking: true })
    setAgentStatus(DEMO_PROJECT_ID, 'w1', a.window, 'running')
    setWorkspaceWindows(DEMO_PROJECT_ID, 'w1', [
      { id: '@0', name: '_yaac', dead: false },
      { id: '@1', name: a.window, dead: false },
      { id: '@2', name: b.window, dead: false },
    ])
    expect((await list()).get('w1')).toMatchObject({ status: 'running' })
  })

  it('surfaces the base branch recorded at create time', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordWorkspaceCreated({
      projectId: DEMO_PROJECT_ID, workspaceId: 'tracked', baseBranch: 'release/2.x',
    })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'norecord' })

    running([live('tracked'), live('norecord')])
    const result = await listActiveWorkspaces(DEMO_PROJECT_ID)
    const bySession = new Map(result.workspaces.map((s) => [s.workspaceId, s]))
    expect(bySession.get('tracked')?.baseBranch).toBe('release/2.x')
    expect(bySession.get('norecord')?.baseBranch).toBeUndefined()
  })

  it('carries each workspace\'s forwarded ports', async () => {
    running([live('withports'), live('noports')], {
      forwardedPorts: (id) => Promise.resolve(id === 'withports' ? [{ containerPort: 8787, hostPort: 9787 }] : []),
    })
    const result = await listActiveWorkspaces()
    const bySession = new Map(result.workspaces.map((s) => [s.workspaceId, s]))
    expect(bySession.get('withports')?.forwardedPorts).toEqual([{ containerPort: 8787, hostPort: 9787 }])
    expect(bySession.get('noports')?.forwardedPorts).toEqual([])
  })

  // The status store's spell, projected into the entry: stamped when a wait
  // begins and stable across listings.
  it('stamps a waiting workspace with when its wait began', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 's1' })
    const { window } = await insertSession(DEMO_PROJECT_ID, 's1', { tool: 'claude', mode: 'tui', permissionMode: 'bypass' })
    running([live('s1')])
    /** The entry's status and stamp, with the single-flight slot cleared so
     *  the listing sees the store as it is now. */
    const stamp = async (): Promise<[string | undefined, number | undefined]> => {
      _clearListActiveInflightForTests()
      const [w] = (await listActiveWorkspaces()).workspaces
      return [w?.status, w?.waitingSinceMs]
    }
    // A booting workspace (no store entry) lists as waiting, unstamped.
    expect(await stamp()).toEqual(['waiting', undefined])

    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setAgentStatus(DEMO_PROJECT_ID, 's1', window, 'waiting')
    vi.setSystemTime(60_000)
    expect(await stamp()).toEqual(['waiting', 1_000])

    // Running is unstamped; a fresh wait restamps.
    setAgentStatus(DEMO_PROJECT_ID, 's1', window, 'running')
    expect(await stamp()).toEqual(['running', undefined])
    vi.setSystemTime(2_000)
    setAgentStatus(DEMO_PROJECT_ID, 's1', window, 'waiting')
    expect(await stamp()).toEqual(['waiting', 2_000])

    // An ask lists as waiting with a flag, so a client that predates the
    // flag still alerts on it; background lists as itself.
    setAgentStatus(DEMO_PROJECT_ID, 's1', window, 'running')
    vi.setSystemTime(3_000)
    setAgentStatus(DEMO_PROJECT_ID, 's1', window, 'asking')
    _clearListActiveInflightForTests()
    expect((await listActiveWorkspaces()).workspaces[0]).toMatchObject({ status: 'waiting', asking: true, waitingSinceMs: 3_000 })
    setAgentStatus(DEMO_PROJECT_ID, 's1', window, 'background')
    _clearListActiveInflightForTests()
    const [quiet] = (await listActiveWorkspaces()).workspaces
    expect(quiet.status).toBe('background')
    expect(quiet.asking).toBeUndefined()
  })

  it('shares one listing between overlapping calls with the same filter, and only those', async () => {
    await recordTestProject(OTHER)
    const pending: Array<(handles: RuntimeHandle[]) => void> = []
    running([], { list: () => new Promise((resolve) => { pending.push(resolve) }) })

    const [a, b, other] = [listActiveWorkspaces(), listActiveWorkspaces(), listActiveWorkspaces(OTHER)]
    // The filtered call checks its project first.
    await vi.waitFor(() => { expect(pending).toHaveLength(2) })
    for (const finish of pending) finish([])
    expect(await a).toBe(await b)
    expect(await other).not.toBe(await a)

    // A settled call frees the slot, even when it rejected.
    let lists = 0
    running([], { list: () => { lists++; return Promise.reject(new Error('cluster down')) } })
    await expect(listActiveWorkspaces()).rejects.toThrow('cluster down')
    await expect(listActiveWorkspaces()).rejects.toThrow('cluster down')
    expect(lists).toBe(2)
  })
})

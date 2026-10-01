import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// Only the unreachable-cluster case runs without a snapshot.
vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => ({
  ...await importOriginal<typeof podsModule>(),
  listWorkspacePods: vi.fn().mockResolvedValue([]),
}))
import { closeDb } from '#db/client'
import { acpLogDir, claudeDir, codexDir } from '@yaac/shared/project-paths'
import { _resetReportedModesForTests, reconcileAgentSessions } from '#domain/workspaces/agent-session-registry'
import { listWorkspaceAgentSessions, recordAgentSessions } from '#db/agent-session-store'
import { applyWorkspaceEvent } from '#db'
import { _resetPromptCaptureForTests } from '#domain/workspaces/prompt-capture'
import { getWorkspaceRow, recordWorkspaceCreated, recordWorkspaceLife, setWorkspacePermissionMode } from '#db/workspace-store'
import { _resetCodexPosturesForTests } from '#runtime/agents/codex'
import { handleFixture, installFakeWorkspaceDriver, snapshotFixture } from '@yaac/test-utils/fake-driver'
import type { RuntimeHandle, WorkspaceDriver } from '#drivers/contract'
import type { LiveAgent } from '#runtime/agents'
import { listWorkspacePods } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'
import {
  setLiveAgents,
  setWorkspaceStreamHealth,
  _resetWorkspaceStatusStoreForTests,
} from '#runtime/status/status-store'

/**
 * Each pane (or acpd socket) names the conversation it holds. Every named
 * conversation is recorded as active; other conversations of the workspace
 * are inactive history. Only `active` survives teardown to drive a restart.
 *
 * The live set is injected directly (how panes report is tested with the
 * tui driver and reporter script), and the real `applyWorkspaceEvent` writes
 * the rows the assertions read.
 */
describe('reconcileAgentSessions', () => {
  let tmpDir: string
  const podExec = vi.fn<WorkspaceDriver['exec']>()

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    podExec.mockReset()
    installFakeWorkspaceDriver({ exec: podExec })
    _resetWorkspaceStatusStoreForTests()
    _resetPromptCaptureForTests()
    _resetReportedModesForTests()
    _resetCodexPosturesForTests()
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'wt-1' })
    await recordWorkspaceLife('demo', 'wt-1')
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
    vi.restoreAllMocks()
  })

  /** Run one pass over the workspace, running on a pod. */
  const sweep = (pod: Partial<RuntimeHandle> = {}): Promise<void> => reconcileAgentSessions(snapshotFixture([
    handleFixture({ workspaceId: 'wt-1', projectSlug: 'demo', jobName: 'yaac-demo-wt-1', ...pod }),
  ]))

  /** Set the agents the status watcher sees, over a healthy stream. */
  const live = (agents: LiveAgent[]): void => {
    setWorkspaceStreamHealth('demo', 'wt-1', true)
    setLiveAgents('demo', 'wt-1', agents)
  }

  /** Write a claude transcript opening with `firstMessage`; return a pane
   *  naming it. */
  async function claudeOn(handle: string, id: string, firstMessage?: string): Promise<LiveAgent> {
    const rel = path.join('claude', 'projects', '-workspace', `${id}.jsonl`)
    const file = path.join(claudeDir('demo'), 'projects', '-workspace', `${id}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, firstMessage === undefined ? '{"type":"summary"}\n' : `${JSON.stringify({
      type: 'user', message: { role: 'user', content: firstMessage },
    })}\n`)
    return { handle, tool: 'claude', agentSessionId: id, transcriptPath: rel }
  }

  const rows = async (): Promise<Array<[string, boolean, string | undefined]>> =>
    (await listWorkspaceAgentSessions('demo', 'wt-1')).map((l) => [l.agentSessionId, l.active, l.paneId])
  const row = async (id: string) =>
    (await listWorkspaceAgentSessions('demo', 'wt-1')).find((l) => l.agentSessionId === id)
  const posture = async (): Promise<string | undefined> =>
    (await getWorkspaceRow('demo', 'wt-1'))?.permissionMode

  it('records every conversation a pane names, and exactly those are active', async () => {
    // The agent window's conversation, one started by hand in another pane,
    // and a codex pane that has not named a conversation yet.
    live([
      { ...await claudeOn('%0', 'conv-a', 'refactor the parser'), model: 'claude-opus-5' },
      await claudeOn('%4', 'conv-s', 'a side question'),
      { handle: '%1', tool: 'codex' },
    ])
    await sweep()

    expect(await rows()).toEqual([['conv-a', true, '%0'], ['conv-s', true, '%4']])
    expect(await row('conv-a')).toMatchObject({
      mode: 'tui',
      transcriptPath: path.join('claude', 'projects', '-workspace', 'conv-a.jsonl'),
      firstPrompt: 'refactor the parser',
      model: 'claude-opus-5',
    })
    expect((await row('conv-s'))?.firstPrompt).toBe('a side question')

    // The shell pane closed; conv-a's pane runs on.
    live([await claudeOn('%0', 'conv-a', 'refactor the parser'), { handle: '%1', tool: 'codex' }])
    await sweep()
    expect(await rows()).toEqual([['conv-a', true, '%0'], ['conv-s', false, '%4']])
  })

  it('keeps a pane\'s earlier conversation as history once a /clear moves it on', async () => {
    live([await claudeOn('%0', 'conv-a', 'the original ask')])
    await sweep()

    // After `/clear` the pane names conv-b. conv-a keeps its first prompt
    // and first ordinal, so a restart's windows do not reshuffle.
    live([await claudeOn('%0', 'conv-b')])
    await sweep()
    await sweep()
    const links = await listWorkspaceAgentSessions('demo', 'wt-1')
    expect(links.map((l) => [l.agentSessionId, l.active, l.ordinal, l.firstPrompt]))
      .toEqual([['conv-a', false, 0, 'the original ask'], ['conv-b', true, 1, undefined]])

    // conv-b's first prompt is picked up once it exists.
    live([await claudeOn('%0', 'conv-b', 'something else entirely')])
    await sweep()
    expect((await row('conv-b'))?.firstPrompt).toBe('something else entirely')
  })

  it('cannot overwrite the create-time prompt with what the transcript now opens with', async () => {
    await recordAgentSessions('demo', 'wt-1', [
      { tool: 'claude', agentSessionId: 'conv-a', firstPrompt: 'already captured' },
    ])
    live([await claudeOn('%0', 'conv-a', 'a compacted first message')])
    await sweep()
    expect((await row('conv-a'))?.firstPrompt).toBe('already captured')
  })

  it('leaves the rows alone until a live set arrives, and for a prewarmed spare', async () => {
    await recordAgentSessions('demo', 'wt-1', [{ tool: 'claude', agentSessionId: 'conv-a' }])
    // A stream gap must never read as "every agent exited".
    await sweep()
    expect(await rows()).toEqual([['conv-a', true, undefined]])

    // A spare's agent is not recorded until the spare is claimed.
    live([await claudeOn('%0', 'conv-warm')])
    await sweep({ prewarmed: true })
    expect(await rows()).toEqual([['conv-a', true, undefined]])
  })

  it('probes an opencode conversation\'s opening message in the pod', async () => {
    // opencode leaves no host transcript, so it is read in the pod by job
    // name.
    podExec.mockResolvedValue({
      stdout: JSON.stringify({ data: { id: 'ses_1', title: 'build a thing', time: { updated: 1 } } }),
      stderr: '',
    })
    live([{ handle: '%0', tool: 'opencode', agentSessionId: 'ses_1', model: 'opencode/big-pickle' }])
    await sweep()

    expect(await row('ses_1')).toMatchObject({ active: true, firstPrompt: 'build a thing', model: 'opencode/big-pickle' })
    expect(podExec.mock.calls[0]?.[0]).toBe('yaac-demo-wt-1')
    expect(podExec.mock.calls[0]?.[1]).toBe('opencode api --standalone session.get --param sessionID=ses_1')

    // Read once; the row keeps the answer.
    await sweep()
    expect(podExec).toHaveBeenCalledTimes(1)
  })

  it('hands the create\'s pin to the first conversation a codex or opencode pane names', async () => {
    // A tui create records a placeholder conversation under the workspace
    // id: for opencode with the `--prompt` text and model, for codex (in a
    // second workspace) with neither. Neither tool actually uses that id.
    const launch = (workspaceId: string, session: { tool: 'codex' | 'opencode'; firstPrompt?: string; model?: string }) =>
      applyWorkspaceEvent({
        type: 'sessions-launched',
        projectSlug: 'demo',
        workspaceId,
        sessions: [{ agentSessionId: workspaceId, mode: 'tui', ...session }],
      })
    await launch('wt-1', { tool: 'opencode', firstPrompt: 'build a thing', model: 'opencode/big-pickle' })
    const [pin] = await listWorkspaceAgentSessions('demo', 'wt-1')

    // The session opencode created replaces the placeholder: first in window
    // order, with the user's prompt rather than opencode's title.
    podExec.mockResolvedValue({ stdout: JSON.stringify({ data: { id: 'ses_1', title: 'Thing builder' } }), stderr: '' })
    live([{ handle: '%0', tool: 'opencode', agentSessionId: 'ses_1' }])
    await sweep()
    const summary = async (workspaceId: string) => (await listWorkspaceAgentSessions('demo', workspaceId))
      .map((l) => [l.agentSessionId, l.ordinal, l.active, l.firstPrompt, l.model])
    expect(await summary('wt-1')).toEqual([['ses_1', 0, true, 'build a thing', 'opencode/big-pickle']])
    expect((await row('ses_1'))?.createdAt).toEqual(pin?.createdAt)

    // Only the first; a later `/new` is a separate conversation.
    live([{ handle: '%0', tool: 'opencode', agentSessionId: 'ses_2' }])
    await sweep()
    expect(await summary('wt-1')).toEqual([
      ['ses_1', 0, false, 'build a thing', 'opencode/big-pickle'],
      ['ses_2', 1, true, 'Thing builder', undefined],
    ])

    // With no prompt on the placeholder, the conversation's own first
    // message is used.
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'wt-2' })
    await launch('wt-2', { tool: 'codex' })
    const rel = path.join('codex', 'sessions', 'rollout-conv-c.jsonl')
    await fs.mkdir(path.join(codexDir('demo'), 'sessions'), { recursive: true })
    await fs.writeFile(path.join(codexDir('demo'), rel.slice('codex/'.length)), `${JSON.stringify({
      type: 'event_msg', payload: { type: 'user_message', message: 'fix the login bug' },
    })}\n`)
    setWorkspaceStreamHealth('demo', 'wt-2', true)
    setLiveAgents('demo', 'wt-2', [{ handle: '%0', tool: 'codex', agentSessionId: 'conv-c', transcriptPath: rel }])
    await reconcileAgentSessions(snapshotFixture([
      handleFixture({ workspaceId: 'wt-2', projectSlug: 'demo', jobName: 'yaac-demo-wt-2' }),
    ]))
    expect(await summary('wt-2')).toEqual([['conv-c', 0, true, 'fix the login bug', undefined]])
  })

  it('keeps claude\'s pin, which is the conversation it runs', async () => {
    await applyWorkspaceEvent({
      type: 'sessions-launched',
      projectSlug: 'demo',
      workspaceId: 'wt-1',
      sessions: [{ tool: 'claude', agentSessionId: 'wt-1', mode: 'tui', firstPrompt: 'the original ask' }],
    })
    live([await claudeOn('%0', 'wt-1', 'the original ask')])
    await sweep()
    // A `/clear` names a new conversation, as for any other tool.
    live([await claudeOn('%0', 'conv-b')])
    await sweep()
    const links = await listWorkspaceAgentSessions('demo', 'wt-1')
    expect(links.map((l) => [l.agentSessionId, l.ordinal, l.active, l.firstPrompt]))
      .toEqual([['wt-1', 0, false, 'the original ask'], ['conv-b', 1, true, undefined]])
  })

  it('records the model a pane reports, and keeps it while the pane says nothing', async () => {
    live([{ ...await claudeOn('%0', 'conv-a'), model: 'claude-opus-5' }])
    await sweep()
    live([{ ...await claudeOn('%0', 'conv-a'), model: 'claude-fable-5' }])
    await sweep()
    expect((await row('conv-a'))?.model).toBe('claude-fable-5')

    // A pane that has not re-reported since a reconnect leaves the row alone.
    live([await claudeOn('%0', 'conv-a')])
    await sweep()
    expect((await row('conv-a'))?.model).toBe('claude-fable-5')
  })

  it('records an acp conversation off the live set, reading acpd\'s record for the rest', async () => {
    await fs.mkdir(acpLogDir('demo', 'wt-1'), { recursive: true })
    await fs.writeFile(path.join(acpLogDir('demo', 'wt-1'), 'acp-1.jsonl'), [
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'acp-1' } }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/prompt',
        params: { prompt: [{ type: 'text', text: 'ship the thing' }] },
      }),
      '',
    ].join('\n'))
    // claude's adapter reports its picker's model name; the row stores the
    // matching catalog id. A second conversation has no id yet and is not
    // recorded.
    live([
      { handle: 'claude', tool: 'claude', agentSessionId: 'acp-1', model: 'opus[1m]', modelName: 'Opus 5.5' },
      { handle: 'claude-2', tool: 'claude' },
    ])
    await sweep({ mode: 'acp' })

    // The handle is the acpd window a restart uses to find the conversation.
    expect(await rows()).toEqual([['acp-1', true, 'claude']])
    const link = await row('acp-1')
    expect(link).toMatchObject({ mode: 'acp', firstPrompt: 'ship the thing', model: 'claude-opus-5-5' })
    expect(link?.transcriptPath).toBeUndefined()
    expect(link?.lastActiveAt).toBeInstanceOf(Date)
  })

  it('survives an unreachable cluster without reporting anything', async () => {
    vi.mocked(listWorkspacePods).mockRejectedValue(new Error('cluster down'))
    await expect(reconcileAgentSessions()).resolves.toBeUndefined()
    expect(await rows()).toEqual([])
  })

  /**
   * The row changes only when a mode actually changes. claude pushes its
   * mode; codex's is read from its rollout. An unchanged codex reading must
   * not undo a mode claude just pushed.
   */
  it('follows each agent\'s moves, never a reading that has not moved', async () => {
    const rel = path.join('codex', 'sessions', 'rollout-conv-x.jsonl')
    const rollout = path.join(codexDir('demo'), rel.slice('codex/'.length))
    await fs.mkdir(path.dirname(rollout), { recursive: true })
    const settings = (s: Record<string, unknown>): string => `${JSON.stringify({
      timestamp: new Date(Date.now() + 1000).toISOString(),
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: s },
    })}\n`
    await fs.writeFile(rollout, settings({ approval_policy: 'never', permission_profile: { type: 'disabled' } }))
    const panes = async (claudeMode?: string): Promise<void> => live([
      { ...await claudeOn('%0', 'conv-a'), ...(claudeMode !== undefined ? { reportedMode: claudeMode } : {}) },
      { handle: '%1', tool: 'codex', agentSessionId: 'conv-x', transcriptPath: rel },
    ])

    // codex's first reading is from this process, so it counts.
    await panes()
    await sweep()
    expect(await posture()).toBe('bypass')

    // A Shift+Tab in claude, reported with the next prompt.
    await panes('plan')
    await sweep()
    expect(await posture()).toBe('plan')
    // codex still says bypass, which is not a change.
    await sweep()
    expect(await posture()).toBe('plan')

    // A `/permissions` pick in codex is a change.
    await fs.appendFile(rollout, settings({
      approval_policy: 'on-request',
      approvals_reviewer: 'user',
      permission_profile: { type: 'managed', file_system: { entries: [{ access: 'write' }] } },
    }))
    await sweep()
    expect(await posture()).toBe('accept-edits')
  })

  // After a restart, the rollout's newest entry is from the old process and
  // is not a change.
  it('ignores a codex rollout entry written before this life', async () => {
    await setWorkspacePermissionMode('demo', 'wt-1', 'accept-edits')
    const rel = path.join('codex', 'sessions', 'rollout-conv-y.jsonl')
    const rollout = path.join(codexDir('demo'), 'sessions', 'rollout-conv-y.jsonl')
    await fs.mkdir(path.dirname(rollout), { recursive: true })
    await fs.writeFile(rollout, `${JSON.stringify({
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      type: 'turn_context',
      payload: {
        approval_policy: 'on-request',
        permission_profile: { type: 'managed', file_system: { entries: [{ access: 'read' }] } },
      },
    })}\n`)
    live([{ handle: '%0', tool: 'codex', agentSessionId: 'conv-y', transcriptPath: rel }])
    await sweep()
    expect(await posture()).toBe('accept-edits')
  })

  // A resumed codex pane reports no rollout until its next turn, so the
  // row's recorded rollout is read instead.
  it('follows a resumed codex pane through the rollout its row recorded', async () => {
    await setWorkspacePermissionMode('demo', 'wt-1', 'accept-edits')
    const rel = path.join('codex', 'sessions', 'rollout-conv-z.jsonl')
    await recordAgentSessions('demo', 'wt-1', [{ tool: 'codex', agentSessionId: 'conv-z', transcriptPath: rel }])
    const rollout = path.join(codexDir('demo'), 'sessions', 'rollout-conv-z.jsonl')
    await fs.mkdir(path.dirname(rollout), { recursive: true })
    await fs.writeFile(rollout, `${JSON.stringify({
      timestamp: new Date(Date.now() + 1000).toISOString(),
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: { approval_policy: 'never', permission_profile: { type: 'disabled' } } },
    })}\n`)
    live([{ handle: '%0', tool: 'codex', agentSessionId: 'conv-z' }])
    await sweep()
    expect(await posture()).toBe('bypass')
    expect((await row('conv-z'))?.transcriptPath).toBe(rel)
  })

  // Modes are recorded in either direction. tmux keeps a pane's option while
  // no server watches, so a new server's first report also counts.
  it('records reported modes up or down, including one made while no server watched', async () => {
    await setWorkspacePermissionMode('demo', 'wt-1', 'accept-edits')
    const acp = (reportedMode: string): void => live([
      { handle: 'claude', tool: 'claude', agentSessionId: 'acp-1', reportedMode },
    ])
    acp('bypassPermissions')
    await sweep({ mode: 'acp' })
    expect(await posture()).toBe('bypass')
    acp('plan')
    await sweep({ mode: 'acp' })
    expect(await posture()).toBe('plan')

    live([{ handle: '%0', tool: 'claude', reportedMode: 'acceptEdits' }])
    await sweep()
    expect(await posture()).toBe('accept-edits')
    // While the server is down, claude moves to plan.
    _resetReportedModesForTests()
    _resetWorkspaceStatusStoreForTests()
    live([{ handle: '%0', tool: 'claude', reportedMode: 'plan' }])
    await sweep()
    expect(await posture()).toBe('plan')
  })
})

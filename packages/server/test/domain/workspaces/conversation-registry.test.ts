import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

import { closeDb } from '#db/client'
import { acpLogDir, claudeDir, codexDir } from '@yaac/shared/project-paths'
import {
  reconcileConversations,
  reconcileStoppedConversations,
} from '#domain/workspaces/conversation-registry'
import { listWorkspaceConversations, recordConversations } from '#db/conversation-store'
import { applyWorkspaceEvent, getSessionRow, holdSessionPrompt, insertSession, type SessionRow } from '#db'
import { _resetPromptCaptureForTests } from '#domain/workspaces/prompt-capture'
import { _resetTitleCaptureForTests } from '#domain/workspaces/title-capture'
import { claiming } from '#domain/workspaces/prewarm'
import { recordWorkspaceCreated, recordWorkspaceLife } from '#db/workspace-store'
import { _resetCodexRolloutReadsForTests } from '#runtime/agents/codex'
import { _resetAcpRegistryForTests, registerAcpConversation } from '#runtime/agents/acp-registry'
import { PromptNotRunError, type AcpConversation } from '#runtime/agents/acp-client'
import { handleFixture, installFakeWorkspaceDriver, snapshotFixture } from '#test/support/fake-driver'
import type { RuntimeHandle, WorkspaceDriver } from '#drivers/contract'
import type { LiveAgent } from '#runtime/agents'
import {
  setLiveAgents,
  setWorkspaceStreamHealth,
  _resetWorkspaceStatusStoreForTests,
} from '#runtime/status/status-store'

/**
 * Each pane (or acpd socket) names the conversation it holds. Every named
 * conversation is recorded as active; other conversations of the workspace
 * are inactive history. A session's agent, matched by its window, also
 * moves its session's row: its conversation, model, posture and effort.
 *
 * The live set is injected directly (how panes report is tested with the
 * tui driver and reporter script), and the real `applyWorkspaceEvent` writes
 * the rows the assertions read.
 */
describe('reconcileConversations', () => {
  let tmpDir: string
  const podExec = vi.fn<WorkspaceDriver['exec']>()

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    podExec.mockReset()
    installFakeWorkspaceDriver({ exec: podExec })
    _resetWorkspaceStatusStoreForTests()
    _resetPromptCaptureForTests()
    _resetTitleCaptureForTests()
    _resetCodexRolloutReadsForTests()
    _resetAcpRegistryForTests()
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'wt-1' })
    await recordWorkspaceLife(DEMO_PROJECT_ID, 'wt-1')
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
    vi.restoreAllMocks()
  })

  /** Run one pass over the workspace, running on a pod. */
  const sweep = (pod: Partial<RuntimeHandle> = {}): Promise<void> => reconcileConversations(snapshotFixture([
    handleFixture({ workspaceId: 'wt-1', projectId: DEMO_PROJECT_ID, jobName: 'yaac-demo-wt-1', ...pod }),
  ]))

  /** Set the agents the status watcher sees, over a healthy stream. */
  const live = (agents: LiveAgent[]): void => {
    setWorkspaceStreamHealth(DEMO_PROJECT_ID, 'wt-1', true)
    setLiveAgents(DEMO_PROJECT_ID, 'wt-1', agents)
  }

  /** Mark an acp conversation's stream as connected, as its driver does. */
  const connected = (handle: string, conversationId: string): void => {
    registerAcpConversation(DEMO_PROJECT_ID, 'wt-1', { handle, conversationId }, {} as AcpConversation)
  }

  /** An open session of the workspace. */
  const opened = (over: Partial<Parameters<typeof insertSession>[2]> = {}): Promise<SessionRow> =>
    insertSession(DEMO_PROJECT_ID, 'wt-1', { tool: 'claude', mode: 'tui', permissionMode: 'accept-edits', ...over })

  /** Write a claude transcript opening with `firstMessage`; return a pane
   *  naming it. */
  async function claudeOn(handle: string, id: string, firstMessage?: string): Promise<LiveAgent> {
    const rel = path.join('claude', 'projects', '-workspace', `${id}.jsonl`)
    const file = path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace', `${id}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, firstMessage === undefined ? '{"type":"summary"}\n' : `${JSON.stringify({
      type: 'user', message: { role: 'user', content: firstMessage },
    })}\n`)
    return { handle, tool: 'claude', conversationId: id, transcriptPath: rel }
  }

  const rows = async (): Promise<Array<[string, boolean, string | undefined]>> =>
    (await listWorkspaceConversations(DEMO_PROJECT_ID, 'wt-1')).map((l) => [l.conversationId, l.active, l.sessionId])
  const row = async (id: string) =>
    (await listWorkspaceConversations(DEMO_PROJECT_ID, 'wt-1')).find((l) => l.conversationId === id)
  const posture = async (s: SessionRow): Promise<string | undefined> => (await getSessionRow(s.id))?.permissionMode

  it('records every conversation a pane names, linked to its session, and exactly those are active', async () => {
    // A session's agent, one started by hand in a terminal, and a codex
    // session that has not named a conversation yet.
    const lead = await opened()
    const codex = await opened({ tool: 'codex' })
    const convA = await claudeOn(lead.window, 'conv-a', 'refactor the parser')
    await fs.utimes(path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace', 'conv-a.jsonl'),
      new Date('2026-01-02'), new Date('2026-01-02'))
    live([
      { ...convA, model: 'claude-opus-5' },
      await claudeOn('%4', 'conv-s', 'a side question'),
      { handle: codex.window, tool: 'codex' },
    ])
    await sweep()

    expect(await rows()).toEqual([['conv-a', true, lead.id], ['conv-s', true, undefined]])
    // Last activity is the transcript's mtime, for the stopped listing.
    expect(await row('conv-a')).toMatchObject({
      mode: 'tui',
      transcriptPath: path.join('claude', 'projects', '-workspace', 'conv-a.jsonl'),
      firstPrompt: 'refactor the parser',
      model: 'claude-opus-5',
      lastActiveAt: new Date('2026-01-02'),
    })
    expect((await row('conv-s'))?.firstPrompt).toBe('a side question')
    // The session follows its agent's conversation and model.
    expect(await getSessionRow(lead.id)).toMatchObject({ conversationId: 'conv-a', model: 'claude-opus-5' })

    // The terminal's agent quit; the session's runs on.
    live([await claudeOn(lead.window, 'conv-a', 'refactor the parser'), { handle: codex.window, tool: 'codex' }])
    await sweep()
    expect(await rows()).toEqual([['conv-a', true, lead.id], ['conv-s', false, undefined]])
  })

  it("keeps a session's earlier conversation as history once a /clear moves it on", async () => {
    const lead = await opened()
    live([await claudeOn(lead.window, 'conv-a', 'the original ask')])
    await sweep()

    // After `/clear` the pane names conv-b, which the session now holds.
    // conv-a keeps its first prompt and ordinal.
    live([await claudeOn(lead.window, 'conv-b')])
    await sweep()
    await sweep()
    const links = await listWorkspaceConversations(DEMO_PROJECT_ID, 'wt-1')
    expect(links.map((l) => [l.conversationId, l.active, l.ordinal, l.firstPrompt, l.sessionId]))
      .toEqual([['conv-a', false, 0, 'the original ask', lead.id], ['conv-b', true, 1, undefined, lead.id]])
    expect((await getSessionRow(lead.id))?.conversationId).toBe('conv-b')

    // conv-b's first prompt is picked up once it exists.
    live([await claudeOn(lead.window, 'conv-b', 'something else entirely')])
    await sweep()
    expect((await row('conv-b'))?.firstPrompt).toBe('something else entirely')
  })

  it('cannot overwrite a recorded opening message with what the transcript now opens with', async () => {
    await recordConversations(DEMO_PROJECT_ID, 'wt-1', [
      { tool: 'claude', conversationId: 'conv-a', firstPrompt: 'already captured' },
    ])
    live([await claudeOn('%0', 'conv-a', 'a compacted first message')])
    await sweep()
    expect((await row('conv-a'))?.firstPrompt).toBe('already captured')
  })

  it('leaves the rows alone until a live set arrives, and for a prewarmed spare', async () => {
    await recordConversations(DEMO_PROJECT_ID, 'wt-1', [{ tool: 'claude', conversationId: 'conv-a' }])
    // A stream gap must never read as "every agent exited".
    await sweep()
    expect(await rows()).toEqual([['conv-a', true, undefined]])

    live([await claudeOn('%0', 'conv-warm')])
    await sweep({ prewarmed: true })
    expect(await rows()).toEqual([['conv-a', true, undefined]])
  })

  it("records each conversation's own title, following the agent's changes to it", async () => {
    const t0 = Date.now()
    const at = (minutes: number) => vi.spyOn(Date, 'now').mockReturnValue(t0 + minutes * 60_000)
    const transcript = path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace', 'conv-a.jsonl')
    const append = (entry: object) => fs.appendFile(transcript, `${JSON.stringify(entry)}\n`)
    live([await claudeOn('%0', 'conv-a', 'refactor the parser')])
    await sweep()
    expect((await row('conv-a'))?.title).toBeUndefined()

    // claude titles it after its first turn, and a rename inside claude
    // replaces that. Each is picked up on a later pass.
    await append({ type: 'ai-title', aiTitle: 'Parser   refactor', sessionId: 'conv-a' })
    at(6)
    await sweep()
    expect((await row('conv-a'))?.title).toBe('Parser refactor')
    await append({ type: 'custom-title', customTitle: 'Mine', sessionId: 'conv-a' })
    at(12)
    await sweep()
    expect(await row('conv-a')).toMatchObject({ title: 'Mine', firstPrompt: 'refactor the parser' })
  })

  it("reads an opencode conversation's title in the pod until it has one, ever less often", async () => {
    // opencode leaves no host transcript, so it is read in the pod by job
    // name. It is called by a placeholder until it titles the session.
    const t0 = Date.now()
    const at = (minutes: number) => vi.spyOn(Date, 'now').mockReturnValue(t0 + minutes * 60_000)
    const titled = (title: string) => ({ stdout: JSON.stringify({ data: { id: 'ses_1', title } }), stderr: '' })
    podExec.mockResolvedValue(titled('New session - 2026-10-20T11:22:33.456Z'))
    live([{ handle: '%0', tool: 'opencode', conversationId: 'ses_1', model: 'opencode/big-pickle' }])
    await sweep()
    expect(podExec.mock.calls[0]?.[0]).toBe('yaac-demo-wt-1')
    expect(podExec.mock.calls[0]?.[1]).toBe('opencode api --standalone session.get --param sessionID=ses_1')
    expect((await row('ses_1'))?.title).toBeUndefined()

    // Each lookup starts a server in the pod, so the wait between them
    // doubles from 2 minutes while the session stays untitled.
    await sweep()
    expect(podExec).toHaveBeenCalledTimes(1)
    at(3)
    await sweep()
    expect(podExec).toHaveBeenCalledTimes(2)
    at(6)
    await sweep()
    expect(podExec).toHaveBeenCalledTimes(2)
    // A later one finds the title, which is then kept, also across a server
    // restart, since the row holds it.
    podExec.mockResolvedValue(titled('Build a thing'))
    at(8)
    await sweep()
    expect(await row('ses_1')).toMatchObject({ active: true, title: 'Build a thing', model: 'opencode/big-pickle' })
    expect((await row('ses_1'))?.firstPrompt).toBeUndefined()
    _resetTitleCaptureForTests()
    at(60)
    await sweep()
    expect(podExec).toHaveBeenCalledTimes(3)
    expect((await row('ses_1'))?.title).toBe('Build a thing')
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

  it("records an acp session's conversation off the live set, reading acpd's record for the rest", async () => {
    await fs.mkdir(acpLogDir(DEMO_PROJECT_ID, 'wt-1'), { recursive: true })
    await fs.writeFile(path.join(acpLogDir(DEMO_PROJECT_ID, 'wt-1'), 'acp-1.jsonl'), [
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
    // claude writes its generated title to its transcript under acp too;
    // with no recorded path, the transcript is found by the conversation's id.
    const transcript = path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace', 'acp-1.jsonl')
    await fs.mkdir(path.dirname(transcript), { recursive: true })
    await fs.writeFile(transcript, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Ship it', sessionId: 'acp-1' })}\n`)
    const [a, b, c] = [await opened({ mode: 'acp' }), await opened({ mode: 'acp' }), await opened({ mode: 'acp' })]
    // claude's adapter reports its picker's model name; the row stores the
    // matching catalog id. A second session has no conversation yet, and a
    // third still names one though its stream is gone: neither is recorded.
    live([
      { handle: a.window, tool: 'claude', conversationId: 'acp-1', model: 'opus[1m]', modelName: 'Opus 5.5' },
      { handle: b.window, tool: 'claude' },
      { handle: c.window, tool: 'claude', conversationId: 'acp-ended' },
    ])
    // Nor is acp-1 while its stream is down (a reconnect, or a server
    // restart before the reattach); it is recorded once the stream attaches.
    await sweep()
    expect(await rows()).toEqual([])
    connected(a.window, 'acp-1')
    await sweep()

    expect(await rows()).toEqual([['acp-1', true, a.id]])
    const link = await row('acp-1')
    expect(link).toMatchObject({ mode: 'acp', firstPrompt: 'ship the thing', title: 'Ship it', model: 'claude-opus-5-5' })
    expect(link?.transcriptPath).toBeUndefined()
    expect(link?.lastActiveAt).toBeInstanceOf(Date)

    // A recorded conversation whose stream drops stays active until the
    // live set stops naming it.
    _resetAcpRegistryForTests()
    await sweep()
    expect(await rows()).toEqual([['acp-1', true, a.id]])
  })

  /** A conversation registered on `handle`, whose sends are recorded. */
  const conversationOn = (handle: string, conversationId: string, failure?: Error) => {
    const prompt = vi.fn(() => (failure === undefined ? Promise.resolve() : Promise.reject(failure)))
    registerAcpConversation(DEMO_PROJECT_ID, 'wt-1', { handle, conversationId }, {
      whenReady: () => Promise.resolve(),
      prompt,
    } as unknown as AcpConversation)
    return prompt
  }

  // An acp session holds its opening message until its own conversation is
  // up, which then gets it once.
  it("sends each session's held opening message to its own conversation, once", async () => {
    const asked = await opened({ mode: 'acp', prompt: 'add shared projects' })
    const other = await opened({ mode: 'acp' })

    // Only the other session is up; its conversation is not the one asked.
    live([{ handle: other.window, tool: 'claude', conversationId: 'acp-side' }])
    const side = conversationOn(other.window, 'acp-side')
    await sweep()
    expect(side).not.toHaveBeenCalled()
    expect((await getSessionRow(asked.id))?.pendingPrompt).toBe('add shared projects')

    live([
      { handle: asked.window, tool: 'claude', conversationId: 'acp-1' },
      { handle: other.window, tool: 'claude', conversationId: 'acp-side' },
    ])
    const first = conversationOn(asked.window, 'acp-1')
    await Promise.all([sweep(), sweep()])
    await vi.waitFor(() => expect(first).toHaveBeenCalledWith('add shared projects'))
    expect((await getSessionRow(asked.id))?.pendingPrompt).toBeUndefined()
    await sweep()
    expect(first).toHaveBeenCalledTimes(1)
    expect(side).not.toHaveBeenCalled()
  })

  // Taken before it is sent, the prompt goes back only for a send no pane
  // saw fail. A refusal is shown in the chat pane, where the user may retry
  // by hand, so a reattach of that session must not send it again.
  it('holds again only a prompt that was never sent, never one the agent refused', async () => {
    const session = await opened({ mode: 'acp', prompt: 'add shared projects' })
    const held = async (): Promise<string | undefined> => (await getSessionRow(session.id))?.pendingPrompt
    const conversation = (conversationId: string, failure?: Error) => {
      live([{ handle: session.window, tool: 'claude', conversationId }])
      return conversationOn(session.window, conversationId, failure)
    }
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50))

    const refusing = conversation('acp-1', new Error('Session not found (code -32603)'))
    await sweep()
    await vi.waitFor(() => expect(refusing).toHaveBeenCalledWith('add shared projects'))
    await settle()
    expect(await held()).toBeUndefined()
    // The user retries in the pane; then the stream drops and the same
    // session reattaches as a new conversation.
    const reattached = conversation('acp-1')
    await sweep()
    await settle()
    expect(reattached).not.toHaveBeenCalled()

    // A send the conversation closed on before routing it was never seen.
    await holdSessionPrompt(session.id, 'add shared projects')
    const closing = conversation('acp-2', new PromptNotRunError('conversation is closed'))
    await sweep()
    await vi.waitFor(() => expect(closing).toHaveBeenCalledWith('add shared projects'))
    await vi.waitFor(async () => expect(await held()).toBe('add shared projects'))
    // That conversation is not asked again; the next one gets it.
    await sweep()
    await settle()
    expect(closing).toHaveBeenCalledTimes(1)
    const next = conversation('acp-3')
    await sweep()
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith('add shared projects'))
    await settle()
    expect(await held()).toBeUndefined()
  })

  // A claim launches its session itself, so the sweep leaves it alone.
  it('records nothing for a spare mid-claim', async () => {
    live([{ handle: 'claude', tool: 'claude', conversationId: 'acp-warm' }])
    connected('claude', 'acp-warm')
    claiming.add('yaac-demo-wt-1')
    try {
      await sweep()
    } finally {
      claiming.delete('yaac-demo-wt-1')
    }
    expect(await rows()).toEqual([])
  })

  it('fails the step without reporting anything when the cluster is unreachable', async () => {
    const view = { ...snapshotFixture(), workspaces: () => Promise.reject(new Error('cluster down')) }
    await expect(reconcileConversations(view)).rejects.toThrow('cluster down')
    expect(await rows()).toEqual([])
  })

  /**
   * Each session follows its own agent's posture: claude pushes its mode,
   * codex's is read from its rollout, and one never moves the other.
   */
  it("follows each session's own agent's moves", async () => {
    const lead = await opened()
    const codex = await opened({ tool: 'codex' })
    const rel = path.join('codex', 'sessions', 'rollout-conv-x.jsonl')
    const rollout = path.join(codexDir(DEMO_PROJECT_ID), rel.slice('codex/'.length))
    await fs.mkdir(path.dirname(rollout), { recursive: true })
    const settings = (s: Record<string, unknown>): string => `${JSON.stringify({
      timestamp: new Date(Date.now() + 1000).toISOString(),
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: s },
    })}\n`
    await fs.writeFile(rollout, settings({ approval_policy: 'never', permission_profile: { type: 'disabled' } }))
    const panes = async (claudeMode?: string): Promise<void> => live([
      { ...await claudeOn(lead.window, 'conv-a'), ...(claudeMode !== undefined ? { reportedMode: claudeMode } : {}) },
      { handle: codex.window, tool: 'codex', conversationId: 'conv-x', transcriptPath: rel },
    ])

    await panes()
    await sweep()
    expect([await posture(lead), await posture(codex)]).toEqual(['accept-edits', 'bypass'])

    // A Shift+Tab in claude, reported with the next prompt.
    await panes('plan')
    await sweep()
    expect([await posture(lead), await posture(codex)]).toEqual(['plan', 'bypass'])

    // A `/permissions` pick in codex.
    await fs.appendFile(rollout, settings({
      approval_policy: 'on-request',
      approvals_reviewer: 'user',
      permission_profile: { type: 'managed', file_system: { entries: [{ access: 'write' }] } },
    }))
    await sweep()
    expect([await posture(lead), await posture(codex)]).toEqual(['plan', 'accept-edits'])
  })

  // Efforts are followed like modes (docs/effort-levels.md): a claude pane's
  // reported level, then codex's from its rollout. A report that is not a
  // level's shape is dropped, since anything in the workspace can set it.
  it("follows each session's effort, codex's from its rollout", async () => {
    const lead = await opened()
    const codex = await opened({ tool: 'codex' })
    const effort = async (s: SessionRow): Promise<string | undefined> => (await getSessionRow(s.id))?.effort
    const rel = path.join('codex', 'sessions', 'rollout-conv-e.jsonl')
    const rollout = path.join(codexDir(DEMO_PROJECT_ID), 'sessions', 'rollout-conv-e.jsonl')
    await fs.mkdir(path.dirname(rollout), { recursive: true })

    live([{ ...await claudeOn(lead.window, 'conv-a'), reportedEffort: 'xhigh' }])
    await sweep()
    expect(await effort(lead)).toBe('xhigh')
    live([{ ...await claudeOn(lead.window, 'conv-a'), reportedEffort: 'x"y' }])
    await sweep()
    expect(await effort(lead)).toBe('xhigh')
    // A word the model has no level for is dropped too; `default` is kept,
    // since claude's ACP adapter offers it.
    live([{ ...await claudeOn(lead.window, 'conv-a'), model: 'claude-opus-4-6', reportedEffort: 'dangerously' }])
    await sweep()
    expect(await effort(lead)).toBe('xhigh')
    live([{ ...await claudeOn(lead.window, 'conv-a'), model: 'claude-opus-4-6', reportedEffort: 'default' }])
    await sweep()
    expect(await effort(lead)).toBe('default')

    await fs.writeFile(rollout, `${JSON.stringify({
      timestamp: new Date(Date.now() + 1000).toISOString(),
      type: 'turn_context',
      payload: { approval_policy: 'never', permission_profile: { type: 'disabled' }, effort: 'ultra' },
    })}\n`)
    live([{ handle: codex.window, tool: 'codex', conversationId: 'conv-e', transcriptPath: rel }])
    await sweep()
    expect([await effort(codex), await effort(lead)]).toEqual(['ultra', 'default'])
  })

  // After a restart, the rollout's newest entry is from the old process and
  // is not a report.
  it('ignores a codex rollout entry written before this life', async () => {
    const codex = await opened({ tool: 'codex' })
    const rel = path.join('codex', 'sessions', 'rollout-conv-y.jsonl')
    const rollout = path.join(codexDir(DEMO_PROJECT_ID), 'sessions', 'rollout-conv-y.jsonl')
    await fs.mkdir(path.dirname(rollout), { recursive: true })
    await fs.writeFile(rollout, `${JSON.stringify({
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      type: 'turn_context',
      payload: {
        approval_policy: 'on-request',
        permission_profile: { type: 'managed', file_system: { entries: [{ access: 'read' }] } },
      },
    })}\n`)
    live([{ handle: codex.window, tool: 'codex', conversationId: 'conv-y', transcriptPath: rel }])
    await sweep()
    expect(await posture(codex)).toBe('accept-edits')
  })

  // A resumed codex pane reports no rollout until its next turn, so the
  // conversation's recorded rollout is read instead.
  it('follows a resumed codex session through the rollout its conversation recorded', async () => {
    const codex = await opened({ tool: 'codex' })
    const rel = path.join('codex', 'sessions', 'rollout-conv-z.jsonl')
    await recordConversations(DEMO_PROJECT_ID, 'wt-1', [{ tool: 'codex', conversationId: 'conv-z', transcriptPath: rel }])
    const rollout = path.join(codexDir(DEMO_PROJECT_ID), 'sessions', 'rollout-conv-z.jsonl')
    await fs.mkdir(path.dirname(rollout), { recursive: true })
    await fs.writeFile(rollout, `${JSON.stringify({
      timestamp: new Date(Date.now() + 1000).toISOString(),
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: { approval_policy: 'never', permission_profile: { type: 'disabled' } } },
    })}\n`)
    live([{ handle: codex.window, tool: 'codex', conversationId: 'conv-z' }])
    await sweep()
    expect(await posture(codex)).toBe('bypass')
    expect((await row('conv-z'))?.transcriptPath).toBe(rel)
  })

  // Modes are recorded in either direction, under either protocol. tmux and
  // acpd keep what an agent reported while no server watched, so a new
  // server's first report counts too.
  it('records reported modes up or down, including one made while no server watched', async () => {
    const chat = await opened({ mode: 'acp' })
    const term = await opened()
    const acp = (reportedMode: string): void => live([
      { handle: chat.window, tool: 'claude', conversationId: 'acp-1', reportedMode },
    ])
    acp('bypassPermissions')
    await sweep()
    expect(await posture(chat)).toBe('bypass')
    acp('plan')
    await sweep()
    expect(await posture(chat)).toBe('plan')

    live([{ handle: term.window, tool: 'claude', reportedMode: 'default' }])
    await sweep()
    expect(await posture(term)).toBe('manual')
    // While the server is down, claude moves to plan.
    _resetWorkspaceStatusStoreForTests()
    live([{ handle: term.window, tool: 'claude', reportedMode: 'plan' }])
    await sweep()
    expect(await posture(term)).toBe('plan')
  })
})

/**
 * Stopped workspaces' conversations no running pass finished with, read
 * once from what they left on the host. The real `applyWorkspaceEvent`
 * writes the rows the assertions read.
 */
describe('reconcileStoppedConversations', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    installFakeWorkspaceDriver()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const MTIME = new Date('2026-01-02')

  /** Record a workspace with one conversation, stopped unless `running`. */
  async function seed(
    workspaceId: string,
    session: { tool: 'claude' | 'opencode'; conversationId: string; mode?: 'tui' | 'acp'; firstPrompt?: string },
    opts: { running?: boolean } = {},
  ): Promise<void> {
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId })
    await recordConversations(DEMO_PROJECT_ID, workspaceId, [session])
    if (!opts.running) await applyWorkspaceEvent({ type: 'workspace-stopped', projectId: DEMO_PROJECT_ID, workspaceId })
  }

  /** Write `lines` to `file`, last modified at `MTIME`. */
  async function writeAt(file: string, lines: unknown[]): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
    await fs.utimes(file, MTIME, MTIME)
  }

  const link = async (workspaceId: string) => (await listWorkspaceConversations(DEMO_PROJECT_ID, workspaceId))[0]

  it('fills each stopped conversation once from its files, and leaves running ones to the live pass', async () => {
    // A tui conversation that died before any pass recorded its path: its
    // transcript is found where claude writes it.
    await seed('wt-early', { tool: 'claude', conversationId: 'conv-early' })
    await writeAt(path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace', 'conv-early.jsonl'),
      [{ type: 'user', message: { role: 'user', content: 'port the lexer' } }])
    // An acp conversation, read from acpd's record. Its captured prompt is
    // kept over the record's.
    await seed('wt-acp', { tool: 'claude', conversationId: 'acp-1', mode: 'acp', firstPrompt: 'the real ask' })
    await writeAt(path.join(acpLogDir(DEMO_PROJECT_ID, 'wt-acp'), 'acp-1.jsonl'), [
      { jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'later text' }] } },
    ])
    // opencode leaves no host file, so it gets its creation time.
    await seed('wt-oc', { tool: 'opencode', conversationId: 'oc-1' })
    await seed('wt-live', { tool: 'claude', conversationId: 'conv-live' }, { running: true })
    await writeAt(path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace', 'conv-live.jsonl'),
      [{ type: 'user', message: { role: 'user', content: 'still going' } }])

    await reconcileStoppedConversations()

    expect(await link('wt-early')).toMatchObject({ firstPrompt: 'port the lexer', lastActiveAt: MTIME })
    expect(await link('wt-acp')).toMatchObject({ firstPrompt: 'the real ask', lastActiveAt: MTIME })
    const oc = await link('wt-oc')
    expect(oc?.lastActiveAt).toEqual(oc?.createdAt)
    expect(oc?.firstPrompt).toBeUndefined()
    const running = await link('wt-live')
    expect([running?.firstPrompt, running?.lastActiveAt]).toEqual([undefined, undefined])

    // Read once: a later change on disk is not picked up.
    await writeAt(path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace', 'conv-early.jsonl'),
      [{ type: 'user', message: { role: 'user', content: 'rewritten' } }])
    await fs.utimes(path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace', 'conv-early.jsonl'),
      new Date('2026-02-01'), new Date('2026-02-01'))
    await reconcileStoppedConversations()
    expect(await link('wt-early')).toMatchObject({ firstPrompt: 'port the lexer', lastActiveAt: MTIME })
  })

  it('drains a backlog larger than one batch in a single pass', async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `wt-${i}`)
    for (const id of ids) await seed(id, { tool: 'opencode', conversationId: `oc-${id}` })

    await reconcileStoppedConversations()

    for (const id of ids) expect((await link(id))?.lastActiveAt).toBeInstanceOf(Date)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { recordConversations } from '#db/conversation-store'
import { closeDb } from '#db/client'
import { acpLogDir, agentHistoryDir, claudeDir, opencodeCheckpointDir } from '@yaac/shared/project-paths'
import { getAcpStoredImage, getConversationTranscript, recordOrigin } from '#domain/workspaces/transcript'
import type { AgentMode, AgentTool } from '@yaac/shared/types'
import type { AcpEvent } from '@yaac/shared/acp'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'

// Workspaces sandboxed, as under k8s; a test wanting containerless
// installs its own.
beforeEach(() => { installFakeWorkspaceDriver() })

/**
 * Which file a conversation's history is read from. The readers run for
 * real against files on disk, since the feature exists to read a
 * conversation with no pod.
 */

const PROJECT = '7d4e2a1c-5b3f-4e8a-9c6d-1f2e3a4b5c6d'
const WORKSPACE = 'wt-1'
/** claude conversation ids are UUIDs; the first one is the workspace's id. */
const ACP_SESSION = '11111111-1111-1111-1111-111111111111'
const TUI_SESSION = '22222222-2222-2222-2222-222222222222'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordWorkspaceCreated({ projectId: PROJECT, workspaceId: WORKSPACE })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

async function seedSession(
  conversationId: string,
  opts: { tool?: AgentTool; mode?: AgentMode } = {},
): Promise<void> {
  await recordConversations(PROJECT, WORKSPACE, [
    { tool: opts.tool ?? 'claude', conversationId, mode: opts.mode ?? 'tui' },
  ])
}

/** Write the record acpd keeps of an `acp` conversation. */
async function writeAcpRecord(conversationId: string, lines: unknown[]): Promise<void> {
  const dir = acpLogDir(PROJECT, WORKSPACE)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${conversationId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
}

/** Write claude's own transcript at its conventional path, used for a `tui`
 *  conversation with no recorded path. */
async function writeClaudeTranscript(conversationId: string, at?: string): Promise<string> {
  const file = at ?? path.join(claudeDir(PROJECT), 'projects', '-workspace', `${conversationId}.jsonl`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, [
    {
      type: 'user', uuid: 'u1', parentUuid: null, sessionId: conversationId, cwd: '/workspace',
      timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'what changed?' },
    },
    {
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: conversationId, cwd: '/workspace',
      timestamp: '2026-01-01T00:00:01Z',
      message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'the router' }] },
    },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

describe('getConversationTranscript', () => {
  it('replays an acp conversation from the record acpd wrote', async () => {
    await seedSession(ACP_SESSION, { mode: 'acp' })
    await writeAcpRecord(ACP_SESSION, [
      { jsonrpc: '2.0', method: '_acpd/life', params: { id: 'life-1' } },
      {
        jsonrpc: '2.0', id: 1, method: 'session/prompt',
        params: { sessionId: ACP_SESSION, prompt: [{ type: 'text', text: 'ship it' }] },
      },
      {
        jsonrpc: '2.0', method: 'session/update',
        params: {
          sessionId: ACP_SESSION,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'shipped' } },
        },
      },
    ])

    const { events } = await getConversationTranscript(PROJECT, WORKSPACE, ACP_SESSION)

    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
    expect(events[0].type === 'user' && events[0].content).toEqual([{ type: 'text', text: 'ship it' }])
  })

  it('replays a tui claude conversation from claude\'s own transcript', async () => {
    await seedSession(TUI_SESSION)
    await writeClaudeTranscript(TUI_SESSION)

    const { events } = await getConversationTranscript(PROJECT, WORKSPACE, TUI_SESSION)

    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
    expect(events[1].type === 'agent' && events[1].content).toEqual([{ type: 'text', text: 'the router' }])
  })

  it('pages a tui claude conversation at each compaction, opening the page after with the summary claude kept', async () => {
    await seedSession(TUI_SESSION)
    const file = path.join(claudeDir(PROJECT), 'projects', '-workspace', `${TUI_SESSION}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const entry = (fields: Record<string, unknown>): Record<string, unknown> => ({
      sessionId: TUI_SESSION, cwd: '/workspace', timestamp: '2026-01-01T00:00:00Z', ...fields,
    })
    const say = (uuid: string, parentUuid: string | null, role: 'user' | 'assistant', text: string): Record<string, unknown> => entry({
      type: role, uuid, parentUuid,
      message: role === 'user' ? { role, content: text } : { role, model: 'claude-fable-5', content: [{ type: 'text', text }] },
    })
    await fs.writeFile(file, [
      say('u1', null, 'user', 'build it'),
      say('a1', 'u1', 'assistant', 'built'),
      entry({
        type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'a1',
        content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 900, postTokens: 60 },
      }),
      entry({
        type: 'user', uuid: 's1', parentUuid: 'b1', isCompactSummary: true, isVisibleInTranscriptOnly: true,
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation that ran out of context. '
            + 'The summary below covers the earlier portion of the conversation.\n\nSummary:\nWe built it.',
        },
      }),
      say('u2', 's1', 'user', 'now ship it'),
      say('a2', 'u2', 'assistant', 'shipped'),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')

    const last = await getConversationTranscript(PROJECT, WORKSPACE, TUI_SESSION)
    expect(last.page).toBe(1)
    expect(last.events.map((e) => e.type)).toEqual(['compaction', 'user', 'agent'])
    expect(last.events[0]).toMatchObject({
      compaction: { id: 'b1', status: 'completed', trigger: 'auto', tokensBefore: 900, tokensAfter: 60, summary: expect.stringContaining('We built it.') as string },
    })
    const first = await getConversationTranscript(PROJECT, WORKSPACE, TUI_SESSION, 0)
    expect(first.events.map((e) => (e.type === 'user' || e.type === 'agent' ? e.content : e.type))).toEqual([
      [{ type: 'text', text: 'build it' }], [{ type: 'text', text: 'built' }],
    ])
  })

  it('reads an acp conversation\'s earlier lives from the tool\'s own history, and its current one from the record', async () => {
    const restart = '2026-01-02T00:00:00.000Z'
    const before = '2026-01-01T00:00:00.000Z'
    const after = '2026-01-02T00:00:05.000Z'
    const update = (u: unknown): unknown => ({ jsonrpc: '2.0', method: 'session/update', params: { update: u } })
    const chunk = (kind: string, text: string): unknown => update({ sessionUpdate: kind, content: { type: 'text', text } })
    // This life replays the one before, then carries on.
    const thisLife = [
      { jsonrpc: '2.0', method: '_acpd/life', params: { id: 'life-2', startedAt: restart } },
      { jsonrpc: '2.0', id: 1, method: 'session/load', params: {} },
      chunk('user_message_chunk', 'first ask'), chunk('agent_message_chunk', 'first answer'),
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'second ask' }] } },
      chunk('agent_message_chunk', 'second answer'),
    ]
    const said = (events: AcpEvent[]): string[] =>
      events.flatMap((e) => (e.type === 'user' || e.type === 'agent' ? e.content.map((c) => (c.type === 'text' ? c.text : '')) : []))

    // claude names the conversation by the ACP session's id.
    await seedSession(ACP_SESSION, { mode: 'acp' })
    const claude = path.join(claudeDir(PROJECT), 'projects', '-workspace', `${ACP_SESSION}.jsonl`)
    await fs.mkdir(path.dirname(claude), { recursive: true })
    const say = (uuid: string, parentUuid: string | null, role: string, text: string, timestamp: string): unknown => ({
      type: role, uuid, parentUuid, sessionId: ACP_SESSION, cwd: '/workspace', timestamp,
      message: role === 'user' ? { role, content: text } : { role, model: 'claude-fable-5', content: [{ type: 'text', text }] },
    })
    // The life before ends with a subagent and a background command still
    // running.
    const entry = (uuid: string, parentUuid: string, role: string, content: unknown[]): unknown => ({
      type: role, uuid, parentUuid, sessionId: ACP_SESSION, cwd: '/workspace', timestamp: before,
      message: { role, content, ...(role === 'assistant' ? { model: 'claude-fable-5' } : {}) },
    })
    const spawn = [
      entry('a1t', 'a1', 'assistant', [
        { type: 'tool_use', id: 'toolu_look', name: 'Agent', input: { description: 'look around', prompt: 'Look around' } },
        { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'sleep 900', description: 'wait', run_in_background: true } },
      ]),
      entry('u1t', 'a1t', 'user', [{
        type: 'tool_result', tool_use_id: 'toolu_bash',
        content: 'Command running in background with ID: b1. Output is being written to: /t/tasks/b1.output.',
      }]),
    ]
    await fs.writeFile(claude, [
      say('u1', null, 'user', 'first ask', before), say('a1', 'u1', 'assistant', 'first answer', before), ...spawn,
      say('u2', 'u1t', 'user', 'second ask', after), say('a2', 'u2', 'assistant', 'second answer', after),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    // The life running now takes the file past the transcript cap, which the
    // history before it is read without: reading stops where the life began.
    await fs.truncate(claude, 65 * 1024 * 1024)
    await writeAcpRecord(ACP_SESSION, thisLife)

    // pi-acp names a conversation by pi's own session id.
    const PI = '01a1110b-f851-758d-ba08-45c4ee75613f'
    await seedSession(PI, { tool: 'pi', mode: 'acp' })
    const logName = `2026-01-01T00-00-00-000Z_${PI}.jsonl`
    await fs.mkdir(agentHistoryDir(PROJECT, WORKSPACE, 'pi'), { recursive: true })
    await fs.writeFile(path.join(agentHistoryDir(PROJECT, WORKSPACE, 'pi'), logName), [
      { type: 'session', version: 3, id: PI, cwd: '/workspace', timestamp: before },
      { type: 'message', id: 'm1', parentId: null, timestamp: before, message: { role: 'user', content: [{ type: 'text', text: 'first ask' }] } },
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: before, message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
      { type: 'message', id: 'm3', parentId: 'm2', timestamp: after, message: { role: 'user', content: [{ type: 'text', text: 'second ask' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    await writeAcpRecord(PI, thisLife)

    // codex names a conversation by its thread; this one's first turn leaves
    // a subagent working, and only what it wrote before the life is read.
    const CODEX = '01a1111c-de75-7ce3-8999-3257b2615db0'
    await seedSession(CODEX, { tool: 'codex', mode: 'acp' })
    const codexLine = (timestamp: string, payload: unknown): unknown => ({ timestamp, type: 'event_msg', payload })
    const codexItem = (timestamp: string, item: unknown): unknown => codexLine(timestamp, {
      type: 'item_completed', thread_id: CODEX, turn_id: 't1', item,
      started_at_ms: Date.parse(timestamp), completed_at_ms: Date.parse(timestamp),
    })
    const rollouts = path.join(agentHistoryDir(PROJECT, WORKSPACE, 'codex'), '2026', '01', '01')
    await fs.mkdir(rollouts, { recursive: true })
    await fs.writeFile(path.join(rollouts, `rollout-2026-01-01T00-00-00-${CODEX}.jsonl`), [
      { timestamp: before, type: 'session_meta', payload: { id: CODEX, cwd: '/workspace' } },
      codexLine(before, { type: 'task_started', turn_id: 't1' }),
      codexItem(before, { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'first ask' }] }),
      codexItem(before, { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'first answer' }] }),
      codexItem(before, { type: 'SubAgentActivity', id: 'call_1', kind: 'started', agent_thread_id: 'child', agent_path: '/root/helper' }),
      codexItem(after, { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: 'second ask' }] }),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    await writeAcpRecord(CODEX, thisLife)

    // opencode's replay holds its whole conversation, so its own history,
    // here an export of rows from before the life, does not stand in for it.
    const OPENCODE = 'ses_eeef51727ffedBWQdWdy0dzOE2'
    await seedSession(OPENCODE, { tool: 'opencode', mode: 'acp' })
    const exported = path.join(opencodeCheckpointDir(PROJECT, WORKSPACE), 'yaac-transcripts')
    await fs.mkdir(exported, { recursive: true })
    await fs.writeFile(path.join(exported, `${OPENCODE}.jsonl`), [
      { session: OPENCODE, type: 'session', parent: null, directory: '/workspace' },
      { session: OPENCODE, type: 'user', seq: 1, data: { text: 'first ask', files: [], time: { created: Date.parse(before) } } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    await writeAcpRecord(OPENCODE, thisLife)

    for (const id of [ACP_SESSION, CODEX, PI]) {
      const last = await getConversationTranscript(PROJECT, WORKSPACE, id)
      expect([last.page, last.life, said(last.events)], id).toEqual([1, 'life-2', ['second ask', 'second answer']])
      const first = await getConversationTranscript(PROJECT, WORKSPACE, id, 0)
      expect([first.page, first.life, said(first.events)], id).toEqual([0, 'life-2', ['first ask', 'first answer']])
      expect(await recordOrigin(PROJECT, WORKSPACE, id, { id: 'life-2', startedAt: restart }), id)
        .toMatchObject({ firstPage: 1, skipReplay: true })
    }
    // The record dates what the history started as the history did, so a
    // subagent this life resumes keeps its first start.
    const starts = async (id: string): Promise<number[]> =>
      [...(await recordOrigin(PROJECT, WORKSPACE, id, { id: 'life-2', startedAt: restart })).starts?.values() ?? []]
    expect(await starts(ACP_SESSION)).toEqual([Date.parse(before), Date.parse(before)])
    expect(await starts(CODEX)).toEqual([Date.parse(before)])
    expect(await starts(PI)).toEqual([])
    // What the life before left running died with it, so the history does
    // not show it going.
    const ended = async (id: string): Promise<string[]> => (await getConversationTranscript(PROJECT, WORKSPACE, id, 0)).events
      .flatMap((e) => (e.type === 'subagent' ? [`subagent ${e.subagent.state}`] : e.type === 'task' ? [`task ${e.task.state}`] : []))
    expect(await ended(ACP_SESSION)).toEqual(['subagent running', 'task running', 'subagent cancelled', 'task stopped'])
    expect(await ended(CODEX)).toEqual(['subagent running', 'subagent cancelled'])
    const replayed = await getConversationTranscript(PROJECT, WORKSPACE, OPENCODE)
    expect([replayed.page, said(replayed.events)]).toEqual([0, ['first ask', 'first answer', 'second ask', 'second answer']])
  })

  it('fills in a subagent\'s thread that the conversation left out from claude\'s transcript of it', async () => {
    // A transcript's companion dir holds each subagent's own conversation.
    const withSubagent = async (conversationId: string, toolUseId: string): Promise<void> => {
      const dir = path.join(claudeDir(PROJECT), 'projects', '-workspace', conversationId, 'subagents')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'agent-x1.meta.json'), JSON.stringify({ toolUseId }))
      const entry = (uuid: string, parentUuid: string | null, role: string, content: unknown): unknown => ({
        type: role, uuid, parentUuid, isSidechain: true, agentId: 'x1', sessionId: conversationId, cwd: '/workspace',
        timestamp: '2026-01-01T00:00:00Z', message: { role, content, ...(role === 'assistant' ? { model: 'claude-fable-5' } : {}) },
      })
      await fs.writeFile(path.join(dir, 'agent-x1.jsonl'), [
        entry('s1', null, 'user', 'Look around'),
        entry('s2', 's1', 'assistant', [{ type: 'text', text: 'All clear.' }]),
      ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    }
    // An acp conversation a `session/load` replayed: the Agent call, none of
    // its thread.
    await seedSession(ACP_SESSION, { mode: 'acp' })
    await writeAcpRecord(ACP_SESSION, [{ jsonrpc: '2.0', id: 1, method: 'session/load', params: { sessionId: ACP_SESSION } }, {
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: ACP_SESSION,
        update: {
          sessionUpdate: 'tool_call', toolCallId: 'toolu_look', title: 'look around', kind: 'think', status: 'pending',
          rawInput: { prompt: 'Look around' }, _meta: { claudeCode: { toolName: 'Agent' } },
        },
      },
    }])
    await writeClaudeTranscript(ACP_SESSION)
    await withSubagent(ACP_SESSION, 'toolu_look')

    const { events } = await getConversationTranscript(PROJECT, WORKSPACE, ACP_SESSION)

    expect(events.map((e) => [e.type, 'thread' in e ? e.thread : undefined])).toEqual([
      ['tool', undefined], ['subagent', undefined], ['agent', 'toolu_look'],
    ])
    expect(events.at(-1)).toMatchObject({ seq: 2, content: [{ type: 'text', text: 'All clear.' }] })
  })

  it('finds a conversation with no recorded path in the workspace\'s own history', async () => {
    // Finding it needs both the conversation id and the workspace id.
    await seedSession(TUI_SESSION)
    await writeClaudeTranscript(
      TUI_SESSION,
      path.join(agentHistoryDir(PROJECT, WORKSPACE, 'claude'), '-workspace', `${TUI_SESSION}.jsonl`),
    )

    const { events } = await getConversationTranscript(PROJECT, WORKSPACE, TUI_SESSION)

    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
  })

  it('prefers a recorded transcript path over the one the layout implies', async () => {
    // codex's rollout filename cannot be derived, and a `/clear`ed claude
    // conversation can be anywhere, so a recorded path wins.
    await seedSession(TUI_SESSION)
    const elsewhere = path.join(claudeDir(PROJECT), 'projects', '-elsewhere', 'moved.jsonl')
    await writeClaudeTranscript(TUI_SESSION, elsewhere)
    await recordConversations(PROJECT, WORKSPACE, [{
      tool: 'claude',
      conversationId: TUI_SESSION,
      transcriptPath: path.relative(path.dirname(claudeDir(PROJECT)), elsewhere),
    }])

    expect((await getConversationTranscript(PROJECT, WORKSPACE, TUI_SESSION)).events.map((e) => e.type))
      .toEqual(['user', 'agent'])
  })

  it('answers empty for a conversation whose file was never written', async () => {
    // An agent that never spoke has an empty history, as with acp.
    await seedSession(TUI_SESSION)
    expect(await getConversationTranscript(PROJECT, WORKSPACE, TUI_SESSION)).toEqual({ page: 0, events: [] })

    await seedSession(ACP_SESSION, { mode: 'acp' })
    expect(await getConversationTranscript(PROJECT, WORKSPACE, ACP_SESSION)).toEqual({ page: 0, events: [] })
  })

  it('translates a tui conversation of every other tool from its own history', async () => {
    // Each tool keeps its history in its own format and place: codex a
    // rollout named for its thread, pi a log named for its session, and
    // opencode (sandboxed, as with no driver) the export its checkpoint
    // writes. Each comes back as the same events.
    const line = (o: unknown): string => JSON.stringify(o)
    const CODEX = '01a1111c-de75-7ce3-8999-3257b2615db0'
    const codexItem = (item: unknown, ms: number): string => line({
      timestamp: new Date(ms).toISOString(), type: 'event_msg',
      payload: { type: 'item_completed', thread_id: CODEX, turn_id: 't1', item, started_at_ms: ms, completed_at_ms: ms },
    })
    const rollouts = path.join(agentHistoryDir(PROJECT, WORKSPACE, 'codex'), '2026', '10', '06')
    await fs.mkdir(rollouts, { recursive: true })
    await fs.writeFile(path.join(rollouts, `rollout-2026-10-06T12-07-47-${CODEX}.jsonl`), [
      line({ timestamp: '2026-10-06T12:07:47.000Z', type: 'session_meta', payload: { id: CODEX, cwd: '/workspace' } }),
      line({ timestamp: '2026-10-06T12:07:47.001Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
      codexItem({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'what changed?' }] }, 1791288467002),
      codexItem({ type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'the router' }] }, 1791288467003),
    ].join('\n') + '\n')

    const PI = '01a1110b-f851-758d-ba08-45c4ee75613f'
    const pi = agentHistoryDir(PROJECT, WORKSPACE, 'pi')
    await fs.mkdir(pi, { recursive: true })
    await fs.writeFile(path.join(pi, `2026-10-06T11-49-19-571Z_${PI}.jsonl`), [
      line({ type: 'session', version: 3, id: PI, cwd: '/workspace' }),
      line({ type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'what changed?' }] } }),
      line({ type: 'message', id: 'm2', parentId: 'm1', message: { role: 'assistant', content: [{ type: 'text', text: 'the router' }] } }),
    ].join('\n') + '\n')

    const OPENCODE = 'ses_eeef51727ffedBWQdWdy0dzOE2'
    const exported = path.join(opencodeCheckpointDir(PROJECT, WORKSPACE), 'yaac-transcripts')
    await fs.mkdir(exported, { recursive: true })
    await fs.writeFile(path.join(exported, `${OPENCODE}.jsonl`), [
      line({ session: OPENCODE, type: 'session', parent: null, directory: '/workspace' }),
      line({ session: OPENCODE, type: 'user', seq: 1, data: { text: 'what changed?', files: [] } }),
      line({ session: OPENCODE, type: 'assistant', seq: 2, data: { content: [{ type: 'text', text: 'the router' }] } }),
    ].join('\n') + '\n')

    for (const [tool, id] of [['codex', CODEX], ['pi', PI], ['opencode', OPENCODE]] as const) {
      await seedSession(id, { tool })
      const said = (await getConversationTranscript(PROJECT, WORKSPACE, id)).events
        .flatMap((e) => (e.type === 'user' || e.type === 'agent' ? [`${e.type}: ${JSON.stringify(e.content)}`] : []))
      expect(said, tool).toEqual([
        'user: [{"type":"text","text":"what changed?"}]',
        'agent: [{"type":"text","text":"the router"}]',
      ])
    }
  })

  it('finds a claude transcript filed under a cwd that is not the pod\'s', async () => {
    // A containerless workspace runs claude in the host checkout, not
    // `/workspace`, so claude files the conversation under a directory named
    // for that path.
    await seedSession(TUI_SESSION)
    await writeClaudeTranscript(TUI_SESSION, path.join(
      claudeDir(PROJECT), 'projects', `-home-yaac--yaac-projects-${PROJECT}-workspaces-wt-1`,
      `${TUI_SESSION}.jsonl`,
    ))

    expect((await getConversationTranscript(PROJECT, WORKSPACE, TUI_SESSION)).events.map((e) => e.type))
      .toEqual(['user', 'agent'])
  })

  it('refuses a conversation too large to answer with, rather than reading it', async () => {
    // The whole file is read into one JSON body, so a huge one would stall
    // the server. Truncating would look like a conversation that started
    // later, so it is refused.
    await seedSession(TUI_SESSION)
    const file = path.join(claudeDir(PROJECT), 'projects', '-workspace', `${TUI_SESSION}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    // Sparse, so the file uses no real disk.
    const handle = await fs.open(file, 'w')
    await handle.truncate(65 * 1024 * 1024)
    await handle.close()

    await expect(getConversationTranscript(PROJECT, WORKSPACE, TUI_SESSION))
      .rejects.toMatchObject({ code: 'TOO_LARGE' })
  })

  it('reads nothing through a link or a FIFO planted where a transcript belongs', async () => {
    // Both files are written from inside the sandbox. A symlink could expose
    // another project's conversation; a FIFO would block a server fs thread.
    await seedSession(TUI_SESSION)
    await seedSession(ACP_SESSION, { mode: 'acp' })
    const elsewhere = await writeClaudeTranscript(TUI_SESSION, path.join(tmpDir, 'elsewhere', 't.jsonl'))
    const file = path.join(claudeDir(PROJECT), 'projects', '-workspace', `${TUI_SESSION}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.symlink(elsewhere, file)
    expect(await getConversationTranscript(PROJECT, WORKSPACE, TUI_SESSION)).toEqual({ page: 0, events: [] })

    await fs.rm(file)
    await promisify(execFile)('mkfifo', [file])
    await fs.mkdir(acpLogDir(PROJECT, WORKSPACE), { recursive: true })
    await promisify(execFile)('mkfifo', [path.join(acpLogDir(PROJECT, WORKSPACE), `${ACP_SESSION}.jsonl`)])
    expect(await getConversationTranscript(PROJECT, WORKSPACE, TUI_SESSION)).toEqual({ page: 0, events: [] })
    expect(await getConversationTranscript(PROJECT, WORKSPACE, ACP_SESSION)).toEqual({ page: 0, events: [] })
  })

  it('refuses a conversation the workspace never had', async () => {
    await seedSession(TUI_SESSION)
    await expect(getConversationTranscript(PROJECT, WORKSPACE, 'never-happened'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reads an acp conversation by its mode, whatever tool it ran', async () => {
    // The mode picks the file, not the tool: an acp conversation always has
    // an acpd record.
    await seedSession(ACP_SESSION, { tool: 'opencode', mode: 'acp' })
    await writeAcpRecord(ACP_SESSION, [
      {
        jsonrpc: '2.0', method: 'session/update',
        params: {
          sessionId: ACP_SESSION,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
        },
      },
    ])

    expect((await getConversationTranscript(PROJECT, WORKSPACE, ACP_SESSION)).events.map((e) => e.type))
      .toEqual(['agent'])
  })
})

describe('getAcpStoredImage', () => {
  it('serves an image a record names by hash, typed from its bytes, and nothing else from beside it', async () => {
    const dir = path.join(acpLogDir(PROJECT, WORKSPACE), 'images')
    await fs.mkdir(dir, { recursive: true })
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)])
    const hash = createHash('sha256').update(png).digest('hex')
    await fs.writeFile(path.join(dir, hash), png)
    // The workspace can write here, so a planted page must not be served.
    const page = 'cd'.repeat(32)
    await fs.writeFile(path.join(dir, page), '<script>alert(1)</script>')
    await fs.writeFile(path.join(acpLogDir(PROJECT, WORKSPACE), 'x.jsonl'), '{}\n')

    const image = await getAcpStoredImage(PROJECT, WORKSPACE, hash)
    expect(image.mimeType).toBe('image/png')
    expect(image.bytes.equals(png)).toBe(true)
    for (const bad of [page, 'ef'.repeat(32), '../x.jsonl', hash.toUpperCase()]) {
      await expect(getAcpStoredImage(PROJECT, WORKSPACE, bad)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
  })
})
